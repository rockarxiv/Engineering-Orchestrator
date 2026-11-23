import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { TeamDefinitionSchema, uuidv7, type IpcChannel, type IpcPayload, type PipelineStep, type TeamDefinition, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { agentOfKind, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { saveActionDefinition } from "../db/repos/actionDefinitionsRepo.js";
import { createPipeline, createProject, createRoute, createStep, listAgents, listStepsForPipeline, setEntryStep, updateAgent } from "../db/repos/index.js";
import { getAgent } from "../db/repos/agentsRepo.js";
import { setItemArchived } from "../db/repos/itemsRepo.js";
import { createRun, getRun } from "../db/repos/runsRepo.js";
import { getTeam, listTeamVersions, listTeams, restoreTeamVersion, setTeamLocked, teamOwnedAgents } from "../db/repos/teamsRepo.js";
import { pipelineSteps } from "../db/schema.js";
import { publishSection } from "../db/repos/index.js";
import { markReplica } from "../db/recordRole.js";
import { sectionLockFor } from "../managed/locks.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { savePipeline, validatePipelineCommand } from "./configCommands.js";
import { archiveTeamCommand, deleteTeamCommand, listTeamsCommand } from "./declaredTeamCommands.js";
import { listPipelineStepViews } from "./domainQueries.js";

/**
 * Archiving and deleting one declared team (EO-897): refused while a step
 * names it — in its pipeline's current graph or an older version items
 * still run on — and while it is locked; asked unconfirmed first; and its
 * own agents always go with it, so none is left without its team.
 */
let handle: DbHandle;
let projectId: Uuid;
let pipelineId: Uuid;
let check: PipelineStep;
let ordinaryReviewer: Uuid;
let ordinaryImplementer: Uuid;
let teamId: string;
let definition: TeamDefinition;

beforeEach(() => {
  handle = openMigratedTestDb();
  // Report-only members need a backend EO can hold to it (EO-845).
  for (const agent of listAgents(handle.db)) updateAgent(handle.db, agent.id, { provider: "claude" });
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
  ordinaryReviewer = agentOfKind(handle.db, "reviewer");
  ordinaryImplementer = agentOfKind(handle.db, "implementer");
  check = createStep(handle.db, { pipelineId, position: 0, name: "Check", type: "agent", agentId: ordinaryReviewer, entryAction: "check" });
  const done = createStep(handle.db, { pipelineId, position: 1, name: "Done", type: "user", isTerminal: true });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "approved", label: "Approved", tone: "success", target: done.id, position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: check.id, resultKey: "changes_requested", label: "Changes", tone: "warning", target: done.id, position: 1 });
  setEntryStep(handle.db, pipelineId, check.id);
  teamId = uuidv7();
  definition = TeamDefinitionSchema.parse({
    name: "Security pass",
    coordination: "independent",
    members: [
      { key: "security", agentId: ordinaryReviewer, instructions: "Look for auth gaps." },
      { key: "tests", agentId: ordinaryImplementer, instructions: "Check the tests cover the criteria.", required: false },
    ],
    outcomes: [
      { key: "clear", label: "Clear" },
      { key: "concerns", label: "Concerns" },
    ],
    completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
    limits: { maxParallel: 1 },
  });
});

afterEach(() => handle.close());

/** The graph as a save sends it, Check running as the team (`true`), as none (`false`), or the team declared beside it either way. */
function graph(named: boolean, declared = true): IpcPayload<"pipeline:save"> {
  const read = listPipelineStepViews(handle.db, { pipelineId });
  const steps = read.steps.map((step): IpcPayload<"pipeline:save">["steps"][number] => {
    const withoutTeam = (({ team: _team, teamId: _teamId, ...rest }: typeof step) => rest)(step);
    return step.id === check.id ? { ...withoutTeam, teamId: named ? teamId : null } : withoutTeam;
  });
  return { pipelineId, steps, routes: read.routes, entryStepId: read.entryStepId, ...(declared ? { teams: [{ id: teamId, definition }] } : {}) };
}

function save(named: boolean, declared = true) {
  return savePipeline(handle.db, { notifyStateChange: () => {} }, graph(named, declared));
}

/** Publishes the team on Check, then points Check away from it: what a person does before archiving one. */
function publishedThenLetGo(): void {
  expect(save(true)).toMatchObject({ saved: true });
  expect(save(false, false)).toMatchObject({ saved: true });
}

const ownAgents = () => teamOwnedAgents(handle.db, teamId);

describe("archiving or deleting a team that a step names (EO-897)", () => {
  it("is refused, confirmed or not, while a step of its pipeline's current version names it, naming the step", () => {
    expect(save(true)).toMatchObject({ saved: true });
    for (const confirm of [false, true]) {
      const archived = archiveTeamCommand(handle.db, { teamId, confirm });
      const deleted = deleteTeamCommand(handle.db, { teamId, confirm });
      expect(archived.archived).toBe(false);
      expect(deleted.deleted).toBe(false);
      expect(archived.problem).toBe('The team "Security pass" cannot be archived while "Check" on Checks names it. Have "Check" on Checks run as another team, or as none first, then archive it.');
      expect(deleted.problem).toBe('The team "Security pass" cannot be deleted while "Check" on Checks names it. Have "Check" on Checks run as another team, or as none first, then delete it.');
    }
    expect(getTeam(handle.db, teamId)).toMatchObject({ archivedAt: null });
    expect(ownAgents().every((agent) => agent.archivedAt === null && agent.deletedAt === null)).toBe(true);
  });

  it("is refused while an older version unfinished items still run on names it, naming the step and the version", () => {
    expect(save(true)).toMatchObject({ saved: true });
    // An item enters while Check runs as the team, so it finishes on that version.
    const item = createTestItem(handle.db, { type: "story", title: "Under check", projectId, stepId: check.id });
    expect(save(false, false)).toMatchObject({ saved: true });
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === check.id)?.teamId ?? null).toBeNull();

    for (const confirm of [false, true]) {
      for (const problem of [archiveTeamCommand(handle.db, { teamId, confirm }).problem, deleteTeamCommand(handle.db, { teamId, confirm }).problem]) {
        expect(problem).toContain('"Check" on Checks\'s v');
        expect(problem).toContain("Let the items still on that older version finish, or move them to the current version first");
      }
    }
    expect(getTeam(handle.db, teamId)?.archivedAt).toBeNull();

    // Once no unfinished item runs on that version, it may go.
    setItemArchived(handle.db, item.id as Uuid, Date.now());
    expect(archiveTeamCommand(handle.db, { teamId, confirm: false })).toMatchObject({ archived: false, problem: null });
  });

  it("is refused for a locked team until a person unlocks it", () => {
    publishedThenLetGo();
    expect(setTeamLocked(handle.db, teamId, true).ok).toBe(true);
    expect(archiveTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ archived: false, problem: 'The team "Security pass" is locked: a person must unlock it before it can be archived.' });
    expect(deleteTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ deleted: false, problem: 'The team "Security pass" is locked: a person must unlock it before it can be deleted.' });
    expect(getTeam(handle.db, teamId)).toMatchObject({ archivedAt: null, locked: true });

    expect(setTeamLocked(handle.db, teamId, false).ok).toBe(true);
    expect(archiveTeamCommand(handle.db, { teamId, confirm: true }).archived).toBe(true);
  });
});

describe("archiving a team (EO-897)", () => {
  it("unconfirmed, archives nothing and names the agents that would go with it", () => {
    publishedThenLetGo();
    const asked = archiveTeamCommand(handle.db, { teamId, confirm: false });
    expect(asked).toEqual({ archived: false, problem: null, members: ownAgents().map((agent) => agent.name) });
    expect(asked.members).toHaveLength(2);
    expect(getTeam(handle.db, teamId)?.archivedAt).toBeNull();
  });

  it("archives its own agents with it, leaves the Teams tab, and can no longer be named by a step or changed", () => {
    publishedThenLetGo();
    const ordinary = [getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)];

    expect(archiveTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ archived: true, problem: null });

    expect(getTeam(handle.db, teamId)?.archivedAt).not.toBeNull();
    expect(ownAgents()).toHaveLength(2);
    for (const agent of ownAgents()) expect(agent).toMatchObject({ teamId, deletedAt: null, archivedAt: expect.any(Number) });
    // The ordinary agents it was copied from are left exactly as they were.
    expect([getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)]).toEqual(ordinary);
    // Its versions stay with its row.
    expect(listTeamVersions(handle.db, teamId).length).toBeGreaterThan(0);

    // It leaves the Teams tab, and the project's teams.
    expect(listTeamsCommand(handle.db).teams.map((team) => team.id)).not.toContain(teamId);
    expect(listTeams(handle.db, projectId).map((team) => team.id)).not.toContain(teamId);

    // No step may name it: the editor's check and Publish both say why.
    const naming = graph(true, false);
    const said = '"Check" runs as the team "Security pass", which is archived: an archived team runs nowhere, so have the step run as another team, or as none.';
    expect(validatePipelineCommand(handle.db, naming).problems.map((problem) => problem.message)).toContain(said);
    const published = savePipeline(handle.db, { notifyStateChange: () => {} }, naming);
    expect(published.saved).toBe(false);
    expect(published.problems.map((problem) => problem.message)).toContain(said);
    // Nor may a draft change it.
    const changing = savePipeline(handle.db, { notifyStateChange: () => {} }, graph(false, true));
    expect(changing.saved).toBe(false);
    expect(changing.problems.map((problem) => problem.message)).toContain('The team "Security pass" is archived: an archived team does not change, and is not brought back. Declare a new team instead.');

    // Nothing brings it back: not a restore, nor a lock.
    expect(restoreTeamVersion(handle.db, teamId, 1, { personId: null })).toMatchObject({ ok: false, reason: expect.stringContaining("is archived") });
    expect(setTeamLocked(handle.db, teamId, true)).toMatchObject({ ok: false, reason: expect.stringContaining("is archived") });
    // Asking again changes nothing and says it is archived.
    expect(archiveTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ archived: true, problem: null });
  });

  it("frees its name for a new team of the project", () => {
    publishedThenLetGo();
    expect(archiveTeamCommand(handle.db, { teamId, confirm: true }).archived).toBe(true);
    const archivedId = teamId;
    teamId = uuidv7();
    expect(save(true)).toMatchObject({ saved: true });
    expect(getTeam(handle.db, teamId)).toMatchObject({ name: "Security pass", archivedAt: null });
    expect(getTeam(handle.db, archivedId)).toMatchObject({ name: "Security pass", archivedAt: expect.any(Number) });
  });
});

describe("deleting a team (EO-897)", () => {
  it("unconfirmed, deletes nothing and names the agents that would go with it", () => {
    publishedThenLetGo();
    const asked = deleteTeamCommand(handle.db, { teamId, confirm: false });
    expect(asked).toEqual({ deleted: false, problem: null, members: ownAgents().map((agent) => agent.name) });
    expect(getTeam(handle.db, teamId)).toBeDefined();
  });

  it("deletes the team and its versions, leaving its own agents as tombstones its runs still name", () => {
    publishedThenLetGo();
    const own = ownAgents();
    const item = createTestItem(handle.db, { type: "story", title: "Checked", projectId, stepId: check.id });
    const run = createRun(handle.db, { itemId: item.id, agentId: own[0]!.id, action: "check", stepId: null });
    setItemArchived(handle.db, item.id as Uuid, Date.now());
    const ordinary = [getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)];

    expect(deleteTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ deleted: true, problem: null });

    expect(getTeam(handle.db, teamId)).toBeUndefined();
    expect(listTeamVersions(handle.db, teamId)).toEqual([]);
    for (const agent of own) {
      expect(getAgent(handle.db, agent.id)).toMatchObject({ name: agent.name, role: agent.role, teamId, enabled: false, deletedAt: expect.any(Number) });
    }
    expect(getRun(handle.db, run.id)?.agentId).toBe(own[0]!.id);
    expect([getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)]).toEqual(ordinary);
    // No step row — a retired one included — is left naming a team that is gone.
    expect(handle.db.select().from(pipelineSteps).all().some((step) => step.teamId === teamId)).toBe(false);
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect(deleteTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ deleted: false, problem: "That team no longer exists." });
  });

  it("deletes an archived team, and its archived agents with it", () => {
    publishedThenLetGo();
    expect(archiveTeamCommand(handle.db, { teamId, confirm: true }).archived).toBe(true);
    const own = ownAgents();
    expect(deleteTeamCommand(handle.db, { teamId, confirm: true })).toMatchObject({ deleted: true });
    expect(getTeam(handle.db, teamId)).toBeUndefined();
    for (const agent of own) expect(getAgent(handle.db, agent.id)?.deletedAt).not.toBeNull();
  });
});

describe("team_archive, team_delete and teams_list (EO-897)", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((spec) => spec.name === name);
    if (found === undefined) throw new Error(`No tool ${name}.`);
    return found;
  };

  beforeEach(() => {
    registerHandler("teams:list", () => listTeamsCommand(handle.db), { exposeErrorDetails: true });
    registerHandler("teams:archive", (payload) => archiveTeamCommand(handle.db, payload), { exposeErrorDetails: true });
    registerHandler("teams:delete", (payload) => deleteTeamCommand(handle.db, payload), { exposeErrorDetails: true });
  });

  afterEach(() => clearHandlerRegistry());

  it("lists each team with its id, and archives one: refused while a step names it, asked unconfirmed, then done", async () => {
    expect(tool("team_archive").kind).toBe("write");
    expect(save(true)).toMatchObject({ saved: true });
    const listed = await tool("teams_list").run(dispatch, {});
    expect(listed).toMatchObject({ ok: true, text: expect.stringContaining(`Security pass (id: ${teamId}, project Workbench, version`) });

    const refused = await tool("team_archive").run(dispatch, { teamId, confirm: true });
    expect(refused).toMatchObject({ ok: true, refused: true, text: expect.stringContaining('Nothing was archived: The team "Security pass" cannot be archived while "Check" on Checks names it.') });
    expect(getTeam(handle.db, teamId)?.archivedAt).toBeNull();

    expect(save(false, false)).toMatchObject({ saved: true });
    const asked = await tool("team_archive").run(dispatch, { teamId });
    expect(asked).toMatchObject({ ok: true, refused: true, text: expect.stringContaining("Its own agents go with it: ") });
    expect(getTeam(handle.db, teamId)?.archivedAt).toBeNull();

    expect(await tool("team_archive").run(dispatch, { teamId, confirm: true })).toMatchObject({ ok: true, refused: false });
    expect(getTeam(handle.db, teamId)?.archivedAt).not.toBeNull();
    expect(ownAgents().every((agent) => agent.archivedAt !== null)).toBe(true);
    expect(await tool("teams_list").run(dispatch, {})).toMatchObject({ ok: true, text: expect.not.stringContaining("Security pass") });
  });

  it("deletes one, gated as a destructive tool, refused while it is locked", async () => {
    expect(tool("team_delete").kind).toBe("dangerous");
    publishedThenLetGo();
    setTeamLocked(handle.db, teamId, true);
    expect(await tool("team_delete").run(dispatch, { teamId, confirm: true })).toMatchObject({ ok: true, refused: true, text: expect.stringContaining("is locked: a person must unlock it before it can be deleted") });
    setTeamLocked(handle.db, teamId, false);
    expect(await tool("team_delete").run(dispatch, { teamId, confirm: true })).toMatchObject({ ok: true, refused: false });
    expect(getTeam(handle.db, teamId)).toBeUndefined();
    expect(ownAgents().every((agent) => agent.deletedAt !== null)).toBe(true);
  });
});

describe("the section lock on archiving or deleting a team (EO-897)", () => {
  it("holds both to the published pipelines, as any write of the graph is", () => {
    publishSection(handle.db, { section: "pipelines", publishedAt: 1, publishedBy: null, publishedByName: "Ada" });
    const stop = markReplica(handle.db, () => true);
    try {
      expect(sectionLockFor(handle.db, "teams:archive", { teamId, confirm: true })).toMatchObject({ locked: true, section: "pipelines" });
      expect(sectionLockFor(handle.db, "teams:delete", { teamId, confirm: true })).toMatchObject({ locked: true, section: "pipelines" });
    } finally {
      stop();
    }
  });
});
