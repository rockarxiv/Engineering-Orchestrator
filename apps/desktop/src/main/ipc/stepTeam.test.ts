import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, type IpcChannel, type IpcPayload, type PipelineStep, type StepTeam, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { copyPipeline } from "../db/repos/pipelineCopyRepo.js";
import { createPipeline, createProject, createRoute, createStep, currentVersion, listStepsForPipeline, setEntryStep, versionSnapshot } from "../db/repos/index.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { exportPipeline, importPipeline } from "../modules/pipelineTransfer.js";
import { savePipeline } from "./configCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";

/**
 * A report-only team on an agent step (EO-843) as part of the graph:
 * stored on the step and read back, kept by a save that leaves it out,
 * frozen in versions and restored with one, carried by a copy and by an
 * export and import that re-mint every id, and never offered to an agent
 * through `pipeline_save`.
 */
let handle: DbHandle;
let pipelineId: Uuid;
let projectId: Uuid;
let check: PipelineStep;
let done: PipelineStep;

const TEAM: StepTeam = StepTeamSchema.parse({
  coordination: "independent",
  participants: [
    { key: "security", role: "reviewer", instructions: "Look for auth gaps." },
    { key: "tests", role: "implementer", instructions: "Check the tests cover the criteria.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear" },
    { key: "concerns", label: "Concerns" },
  ],
  completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  limits: { maxParallel: 1 },
});

beforeEach(() => {
  handle = openMigratedTestDb();
  // An action of result and summary alone, which an independent team can answer.
  const defined = saveActionDefinition(handle.db, {
    role: "reviewer",
    action: "check",
    results: [
      { key: "approved", meaning: "Nothing to change." },
      { key: "changes_requested", meaning: "Something to change." },
    ],
  });
  if (!defined.ok) throw new Error(JSON.stringify(defined));
  projectId = createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" }).id as Uuid;
  pipelineId = createPipeline(handle.db, { projectId, name: "Checks" }).id as Uuid;
  check = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", ownerRole: "reviewer", entryAction: "check" });
  done = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approved", tone: "success", target: done.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "changes_requested", label: "Changes", tone: "warning", target: done.id, position: 1 });
  setEntryStep(handle.db, pipelineId, check.id);
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

/** The graph as the editor sends it, with Check's team as given; `undefined` leaves the key out. */
function graph(team: StepTeam | null | undefined): IpcPayload<"pipeline:save"> {
  const read = listPipelineStepViews(handle.db, { pipelineId });
  const steps = read.steps.map((step): IpcPayload<"pipeline:save">["steps"][number] => {
    const view: IpcPayload<"pipeline:save">["steps"][number] = { ...step };
    // Left out unless given, so a save can be told nothing about it.
    delete view.team;
    return step.id === check.id && team !== undefined ? { ...view, team } : view;
  });
  return { pipelineId, steps, routes: read.routes, entryStepId: read.entryStepId };
}

const save = (team: StepTeam | null | undefined) => savePipeline(handle.db, { notifyStateChange: () => {} }, graph(team));
const teamOf = (id: string = check.id, pipeline: string = pipelineId) => listStepsForPipeline(handle.db, pipeline as Uuid).find((step) => step.id === id)?.team;

describe("a step's team, as part of the graph (EO-843)", () => {
  it("leaves every step of a pipeline without one as one agent, read and exported as before", () => {
    expect(listStepsForPipeline(handle.db, "default").every((step) => step.team === null)).toBe(true);
    const exported = exportPipeline(handle.db, "default");
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.steps.some((step) => "team" in step)).toBe(false);
  });

  it("is stored on the step and read back, kept by a save that leaves it out, and removed by null", () => {
    expect(teamOf()).toBeNull();
    const saved = save(TEAM);
    expect(saved.saved).toBe(true);
    expect(saved.problems).toContainEqual(expect.objectContaining({ severity: "warning", stateId: check.id, message: expect.stringContaining("runs as one agent") }));
    expect(teamOf()).toEqual(TEAM);
    expect(listPipelineStepViews(handle.db, { pipelineId }).steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);

    expect(save(undefined).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    expect(teamOf()).toBeNull();
  });

  it("refuses a team this project cannot staff, or on a step no agent does, and writes nothing", () => {
    const unstaffed = StepTeamSchema.parse({ ...TEAM, participants: [{ key: "legal", role: "lawyer", instructions: "Read the licence." }] });
    const refused = save(unstaffed);
    expect(refused.saved).toBe(false);
    expect(refused.problems).toContainEqual(expect.objectContaining({ severity: "error", stateId: check.id, message: 'The team on "Check" needs a "lawyer" agent, and this project has none enabled.' }));
    expect(teamOf()).toBeNull();

    const onPerson = graph(undefined);
    onPerson.steps = onPerson.steps.map((step) => (step.id === done.id ? { ...step, team: TEAM } : step));
    const refusedOnPerson = savePipeline(handle.db, { notifyStateChange: () => {} }, onPerson);
    expect(refusedOnPerson.saved).toBe(false);
    expect(refusedOnPerson.problems).toContainEqual(expect.objectContaining({ severity: "error", message: '"Done" has a team, but only a step an agent does can run as one.' }));
  });

  it("is frozen in the version a save files, reported by the diff, and comes back with a restore", () => {
    expect(save(TEAM).saved).toBe(true);
    const withTeam = currentVersion(handle.db, pipelineId)!;
    expect(versionSnapshot(handle.db, withTeam.id)?.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    const without = currentVersion(handle.db, pipelineId)!;
    const diff = pipelineVersionsCommand(handle.db, { pipelineId, from: withTeam.number, to: without.number }).diff;
    expect(diff?.steps).toEqual([expect.objectContaining({ stepId: check.id, change: "changed", fields: [expect.objectContaining({ field: "team", after: "one agent" })] })]);

    const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: withTeam.number }).graph!;
    expect(draft.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);
    expect(savePipeline(handle.db, { notifyStateChange: () => {} }, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId }).saved).toBe(true);
    expect(teamOf()).toEqual(TEAM);
  });

  it("goes with a copy of the pipeline, on the copy's own step and in its versions", () => {
    expect(save(TEAM).saved).toBe(true);
    const copy = copyPipeline(handle.db, pipelineId, projectId);
    const copied = copy.stepIds.get(check.id)!;
    expect(copied).not.toBe(check.id);
    expect(teamOf(copied, copy.pipelineId)).toEqual(TEAM);
    const version = currentVersion(handle.db, copy.pipelineId)!;
    expect(versionSnapshot(handle.db, version.id)?.steps.find((step) => step.id === copied)?.team).toEqual(TEAM);
  });

  it("travels in an export, written only where configured, and comes back on import on the step's new id", () => {
    expect(save(TEAM).saved).toBe(true);
    const exported = exportPipeline(handle.db, pipelineId);
    if (!exported.ok) throw new Error(exported.reason);
    expect(exported.document.steps.find((step) => step.id === check.id)?.team).toEqual(TEAM);
    expect(exported.document.steps.find((step) => step.id === done.id)).not.toHaveProperty("team");
    // Roles and its own keys only: nothing in it names this installation.
    expect(JSON.stringify(exported.document.steps.find((step) => step.id === check.id)?.team)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    const imported = importPipeline(handle.db, { document: JSON.parse(JSON.stringify(exported.document)) as typeof exported.document, projectId });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    const newCheck = imported.stepIds[check.id]!;
    expect(newCheck).not.toBe(check.id);
    expect(teamOf(newCheck, imported.pipelineId)).toEqual(TEAM);
    expect(teamOf(imported.stepIds[done.id]!, imported.pipelineId)).toBeNull();
  });
});

describe("a step's team through pipeline_save (EO-843)", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  };

  beforeEach(() => {
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), { exposeErrorDetails: true });
  });

  it("is not offered to an agent, which can neither set nor clear one, and keeps the team a step has", async () => {
    for (const name of ["pipeline_save", "pipeline_validate"]) {
      const advertised = JSON.stringify(tool(name).inputSchema);
      // A step's other settings are offered; its team is not.
      expect(advertised, name).toContain('"watch"');
      expect(advertised, name).not.toContain('"team"');
    }

    expect(save(TEAM).saved).toBe(true);
    const cleared = await tool("pipeline_save").run(dispatch, graph(null));
    expect(cleared.ok).toBe(true);
    expect(teamOf()).toEqual(TEAM);

    expect(save(null).saved).toBe(true);
    const set = await tool("pipeline_save").run(dispatch, graph(TEAM));
    expect(set.ok).toBe(true);
    expect(teamOf()).toBeNull();
  });
});
