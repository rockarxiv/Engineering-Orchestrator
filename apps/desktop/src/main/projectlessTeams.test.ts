import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_PERSON_ID, type Uuid } from "@eo/core";
import type { DbHandle } from "./db/client.js";
import { getPipeline, listRoutesForPipeline, listStepsForPipeline } from "./db/repos/pipelineStepsRepo.js";
import { listOpenMessages } from "./db/repos/messagesRepo.js";
import { createProject, getProject } from "./db/repos/projectsRepo.js";
import { listAgents } from "./db/repos/agentsRepo.js";
import { getTeam, listTeamVersions, teamOwnedAgents, type StoredTeam } from "./db/repos/teamsRepo.js";
import { pipelines, pipelineSteps } from "./db/schema.js";
import { openMigratedTestDb } from "./db/testHelpers.js";
import { loadTemplateHistory } from "./gallery/history.js";
import { backfillPipelineOrigins } from "./gallery/origins.js";
import { applyTemplateUpdates } from "./gallery/templateUpdates.js";
import { storedGraphProblems } from "./ipc/configCommands.js";
import { useGalleryCommand } from "./ipc/galleryCommands.js";
import { importPipeline, parseExport } from "./modules/pipelineTransfer.js";
import { settleProjectlessTeamsAtStart, SHARED_PROJECTLESS_TEAM_SOURCE } from "./projectlessTeams.js";

/**
 * A step's declared team belongs to the project that owns its pipeline
 * (EO-899): a step may run only as a team of its own pipeline's project,
 * so a team made on no project for a pipeline a project then adopts must
 * go with it, and one EO already left on no project is moved at start.
 */

const GALLERY_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "gallery");
const SOFTWARE = "software-feature-to-merge";
const NO_SECRETS = {
  directory: join(tmpdir(), "eo-gallery-no-secrets"),
  store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" },
};
const TEAM_PROJECT_PROBLEM = /belongs to another project/;

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** The seeded Delivery as a fresh installation's first launch leaves it: on no project, brought up to the template, Review's team made. */
function firstLaunch(): void {
  const history = loadTemplateHistory(GALLERY_DIRECTORY);
  backfillPipelineOrigins(handle.db, history);
  applyTemplateUpdates(handle.db, history, { isTheRecord: false });
}

function reviewTeamOf(pipelineId: string): StoredTeam {
  const teamId = listStepsForPipeline(handle.db, pipelineId).find((step) => step.name === "Review")?.teamId;
  if (teamId === null || teamId === undefined) throw new Error(`${pipelineId}'s Review runs as no team`);
  return getTeam(handle.db, teamId)!;
}

function teamProblems(pipelineId: string): string[] {
  const steps = listStepsForPipeline(handle.db, pipelineId);
  return storedGraphProblems(handle.db, pipelineId, steps, listRoutesForPipeline(handle.db, pipelineId), getPipeline(handle.db, pipelineId)!.entryStepId)
    .map((problem) => problem.message)
    .filter((message) => TEAM_PROJECT_PROBLEM.test(message));
}

/** Every agent the team owns is on `projectId`, and still the team's (EO-897). */
function expectOwnAgentsOn(team: StoredTeam, projectId: string | null): void {
  const own = teamOwnedAgents(handle.db, team.id);
  expect(own.length).toBeGreaterThan(1);
  for (const agent of own) expect(agent, agent.name).toMatchObject({ teamId: team.id, projectId });
}

function bundledDocument() {
  const parsed = parseExport(readFileSync(join(GALLERY_DIRECTORY, `${SOFTWARE}.json`), "utf8"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document;
}

describe("a fresh install from the bundled template", () => {
  it("gives Review's team, made while Delivery was on no project, to the project Use this makes, with its members, and Delivery validates with no team-project problem", async () => {
    firstLaunch();
    // Before any project, Delivery and its team are on none, and agree.
    expect(reviewTeamOf("default").projectId).toBeNull();
    expect(teamProblems("default")).toEqual([]);

    const answer = await useGalleryCommand(handle.db, { directory: GALLERY_DIRECTORY, moduleSecrets: NO_SECRETS, signedInBackends: [] }, { slug: SOFTWARE, answers: { keyPrefix: "ACME" }, roleSlots: {} });
    expect(answer.problem).toBeNull();
    expect(answer.pipelineId).toBe("default");
    const projectId = answer.projectId!;

    const team = reviewTeamOf("default");
    expect(team).toMatchObject({ name: "Reviewers", projectId });
    expectOwnAgentsOn(team, projectId);
    expect(teamProblems("default")).toEqual([]);
    // Said as a version of the team by EO.
    const latest = listTeamVersions(handle.db, team.id).at(-1)!;
    expect(latest.author).toEqual({ kind: "eo" });
    expect(latest.note).toBe(
      `EO moved this team into the project "${getProject(handle.db, projectId as Uuid)!.name}", which the pipeline "Delivery" that runs as it belongs to: it belonged to no project, and a step may run only as a team of its own pipeline's project.`,
    );
  });
});

describe("importing a pipeline into a project", () => {
  it("makes the step's team in that project, never on none, its members the team's own", () => {
    const project = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });
    const imported = importPipeline(handle.db, { document: bundledDocument(), projectId: project.id, signedInBackends: ["claude", "codex"] });
    if (!imported.ok) throw new Error(imported.reason);
    const pipelineId = imported.pipelineId;
    expect(getPipeline(handle.db, pipelineId)?.projectId).toBe(project.id);

    const team = reviewTeamOf(pipelineId);
    expect(team.projectId).toBe(project.id);
    expectOwnAgentsOn(team, project.id);
    expect(teamProblems(pipelineId)).toEqual([]);
    // Made there in the first place: one version, nothing moved.
    expect(listTeamVersions(handle.db, team.id).map((version) => version.note)).toEqual([null]);
  });
});

describe("at start, a team EO already left on no project", () => {
  /** What adopting Delivery did before EO-899: its pipeline given to the project, its team left on none. */
  function adoptedTheOldWay(projectId: string): void {
    handle.db.update(pipelines).set({ projectId }).where(eq(pipelines.id, "default")).run();
  }

  it("moves into the one project whose pipeline runs as it, with its members, as a version by EO saying so", () => {
    firstLaunch();
    const project = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });
    adoptedTheOldWay(project.id);
    const before = reviewTeamOf("default");
    expect(before.projectId).toBeNull();
    expect(teamProblems("default")).toEqual([expect.stringContaining('"Reviewers", which belongs to another project')]);

    const settled = settleProjectlessTeamsAtStart(handle.db, false);

    expect(settled).toEqual({ moved: [{ teamId: before.id, projectId: project.id }], shared: [] });
    const after = reviewTeamOf("default");
    expect(after).toMatchObject({ id: before.id, name: "Reviewers", projectId: project.id, version: before.version + 1, definition: before.definition });
    expectOwnAgentsOn(after, project.id);
    const versions = listTeamVersions(handle.db, after.id);
    expect(versions.at(-1)).toMatchObject({ number: before.version + 1, author: { kind: "eo" }, definition: before.definition });
    expect(versions.at(-1)!.note).toBe(
      'EO moved this team into the project "Acme", which the pipeline "Delivery" that runs as it belongs to: it belonged to no project, and a step may run only as a team of its own pipeline\'s project.',
    );
    expect(teamProblems("default")).toEqual([]);
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === SHARED_PROJECTLESS_TEAM_SOURCE)).toEqual([]);

    // Settled: the next start does nothing.
    expect(settleProjectlessTeamsAtStart(handle.db, false)).toEqual({ moved: [], shared: [] });
    expect(listTeamVersions(handle.db, after.id)).toHaveLength(versions.length);
  });

  it("stays as it is where steps of more than one project run as it, and the person is told once, naming the team and the pipelines", () => {
    firstLaunch();
    const acme = createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });
    adoptedTheOldWay(acme.id);
    const shared = reviewTeamOf("default");
    // A second project whose own pipeline's Review was pointed at the same team.
    const beta = createProject(handle.db, { name: "Beta", keyPrefix: "BETA" });
    const imported = importPipeline(handle.db, { document: bundledDocument(), projectId: beta.id, signedInBackends: ["claude", "codex"] });
    if (!imported.ok) throw new Error(imported.reason);
    handle.db.update(pipelines).set({ name: "Beta delivery" }).where(eq(pipelines.id, imported.pipelineId)).run();
    const betaReview = listStepsForPipeline(handle.db, imported.pipelineId).find((step) => step.name === "Review")!;
    handle.db.update(pipelineSteps).set({ teamId: shared.id }).where(eq(pipelineSteps.id, betaReview.id)).run();
    const agentsBefore = teamOwnedAgents(handle.db, shared.id);

    const settled = settleProjectlessTeamsAtStart(handle.db, false);

    expect(settled.moved).toEqual([]);
    expect(settled.shared.map((team) => [team.teamId, team.pipelines.map((pipeline) => [pipeline.pipelineName, pipeline.projectId])])).toEqual([
      [
        shared.id,
        [
          ["Beta delivery", beta.id],
          ["Delivery", acme.id],
        ],
      ],
    ]);
    // Left exactly as it was.
    expect(getTeam(handle.db, shared.id)).toEqual(shared);
    expect(teamOwnedAgents(handle.db, shared.id)).toEqual(agentsBefore);
    expect(listAgents(handle.db).filter((agent) => agent.teamId === shared.id).every((agent) => agent.projectId === null)).toBe(true);

    const told = listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === SHARED_PROJECTLESS_TEAM_SOURCE);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toBe(
      'The team "Reviewers" belongs to no project, and steps of pipelines in more than one project run as it: "Beta delivery" (project "Beta"), "Delivery" (project "Acme"). ' +
        "A step may run only as a team of its own pipeline's project, so none of those steps can run as it, and EO left it as it is rather than give it to one project. " +
        "Have each pipeline's step run as a team of its own project.",
    );

    // A later start says it no more.
    settleProjectlessTeamsAtStart(handle.db, false);
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === SHARED_PROJECTLESS_TEAM_SOURCE)).toHaveLength(1);
    expect(getTeam(handle.db, shared.id)?.projectId).toBeNull();
  });
});
