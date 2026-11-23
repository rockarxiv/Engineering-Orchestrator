import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTeam } from "../db/repos/teamsRepo.js";
import { ipcContract, RecordPipelineSchema, RecordProjectSchema, StepTeamSchema, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createPerson, createPipeline, createProject, createStep, getProject, listStepsForPipeline, setEntryStep } from "../db/repos/index.js";
import { listPipelinesUpdatedSince, readProjectItems, readProjectItemTypes, readProjectPipelines, upsertReplicaPipeline, writeAdoptedPage, writeAdoptedProject } from "../db/repos/projectMoveRepo.js";
import { openMigratedTestDb, agentOfKind } from "../db/testHelpers.js";

/**
 * The organisation record's copy of a step's team (EO-843).
 *
 * A team is what the step does, staffed by role, so it travels with the
 * graph both ways: up to the record when a desktop's project moves there,
 * and down to every desktop that replicates the record's pipelines. Sent
 * the way the record sends it: through JSON and the receiving side's
 * schema.
 */

const TEAM = StepTeamSchema.parse({
  coordination: "leader",
  leader: { role: "reviewer", instructions: "Split the review by concern." },
  roles: ["implementer", "reviewer"],
  outcomes: [{ key: "concerns", label: "Concerns" }],
  limits: { maxParticipants: 3, maxRounds: 1, timeoutMs: 600_000, budgetCents: 200 },
});

let recordDb: DbHandle;
let desktopDb: DbHandle;

beforeEach(() => {
  recordDb = openMigratedTestDb();
  desktopDb = openMigratedTestDb();
});

afterEach(() => {
  recordDb.close();
  desktopDb.close();
});

/** A pipeline whose one agent step runs as `TEAM`, on `db`. */
function teamPipeline(db: DbHandle, projectId: Uuid | null = null): string {
  const pipeline = createPipeline(db.db, { projectId, name: "Reviews" });
  createStep(db.db, { id: "team-review", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: agentOfKind(db.db, "reviewer"), entryAction: "review", team: TEAM });
  createStep(db.db, { id: "team-done", pipelineId: pipeline.id, position: 1, name: "Done", type: "user", isTerminal: true });
  setEntryStep(db.db, pipeline.id, "team-review");
  return pipeline.id;
}

const teamIdOn = (db: DbHandle, pipelineId: string, stepId = "team-review") => listStepsForPipeline(db.db, pipelineId as Uuid).find((step) => step.id === stepId)?.teamId ?? null;
const teamOn = (db: DbHandle, pipelineId: string, stepId = "team-review") => listStepsForPipeline(db.db, pipelineId as Uuid).find((step) => step.id === stepId)?.team;

describe("a step's team on the organisation's record", () => {
  it("reaches a desktop as the record has it, and a step without one stays one agent", () => {
    const pipelineId = teamPipeline(recordDb);
    const sent = listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 100).find((pipeline) => pipeline.id === pipelineId)!;
    expect(sent.steps.find((step) => step.id === "team-review")?.team).toEqual(TEAM);

    for (const pipeline of listPipelinesUpdatedSince(recordDb.db, { ts: 0, id: "" }, 100)) {
      upsertReplicaPipeline(desktopDb.db, RecordPipelineSchema.parse(JSON.parse(JSON.stringify(pipeline))));
    }

    expect(teamOn(desktopDb, pipelineId)).toEqual(TEAM);
    expect(teamOn(desktopDb, pipelineId, "team-done")).toBeNull();
    // The declared team it names (EO-881), declared on the desktop under the record's id.
    const teamId = teamIdOn(recordDb, pipelineId);
    expect(teamId).not.toBeNull();
    expect(teamIdOn(desktopDb, pipelineId)).toBe(teamId);
    expect(getTeam(desktopDb.db, teamId!)?.definition?.coordination).toBe("leader");
  });

  it("goes up to the record with a project moved there", () => {
    const project = createProject(desktopDb.db, { name: "Shop", keyPrefix: "SHOP" });
    const pipelineId = teamPipeline(desktopDb, project.id as Uuid);
    const owner = createPerson(recordDb.db, { name: "Anna", email: "anna@example.com" });
    const held = getProject(desktopDb.db, project.id as Uuid)!;
    const wire = RecordProjectSchema.parse({ id: held.id, name: held.name, keyPrefix: held.keyPrefix, createdAt: held.createdAt, updatedAt: held.updatedAt });
    expect(writeAdoptedProject(recordDb.db, wire, owner.id as Uuid, 1).ok).toBe(true);
    const page = ipcContract["record:adopt"].request.parse({
      deviceId: "d",
      project: wire,
      keyNextValue: 0,
      page: JSON.parse(
        JSON.stringify({
          itemTypes: readProjectItemTypes(desktopDb.db, project.id as Uuid),
          pipelines: readProjectPipelines(desktopDb.db, project.id as Uuid),
          items: readProjectItems(desktopDb.db, project.id as Uuid),
        }),
      ) as unknown,
    }).page;

    writeAdoptedPage(recordDb.db, wire, page, "d");

    expect(teamOn(recordDb, pipelineId)).toEqual(TEAM);
    // Declared on the record under the desktop's id, on the moved project (EO-881).
    expect(teamIdOn(recordDb, pipelineId)).toBe(teamIdOn(desktopDb, pipelineId));
    expect(getTeam(recordDb.db, teamIdOn(recordDb, pipelineId)!)?.projectId).toBe(project.id);
  });
});
