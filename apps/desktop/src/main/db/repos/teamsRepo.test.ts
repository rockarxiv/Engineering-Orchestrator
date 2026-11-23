import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StepTeamSchema, TEAM_NAME_MAX, TeamDefinitionSchema, type TeamDefinition, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { agentOfKind, openMigratedTestDb } from "../testHelpers.js";
import { createPipeline, createStep } from "./pipelineStepsRepo.js";
import { createProject, deleteProject } from "./projectsRepo.js";
import { changeTeam, claimTrialTeam, createTeam, getTeam, listTeamVersions, listTeams, restoreTeamVersion, setTeamLocked, stepsNamingTeam, teamIdForInlineTeam, trialTeams } from "./teamsRepo.js";

/**
 * A declared team's versions and its lock (EO-881): every change is a new
 * version recorded with who made it, a person can restore any earlier one
 * — which is itself a new version — and a locked team refuses every change
 * but unlocking.
 */
let handle: DbHandle;
let projectId: Uuid;
let first: TeamDefinition;

beforeEach(() => {
  handle = openMigratedTestDb();
  projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
  first = TeamDefinitionSchema.parse({
    name: "Review leads",
    coordination: "leader",
    leader: { agentId: agentOfKind(handle.db, "reviewer"), instructions: "Split the review by risk." },
    members: [{ agentId: agentOfKind(handle.db, "implementer") }],
    limits: { maxRounds: 1 },
  });
});

afterEach(() => handle.close());

/** Writes a trial's copies as its save does: each created or changed, and claimed as the trial's. */
function saveCopies(trialId: string, round: ReturnType<typeof trialTeams>): void {
  for (const team of round.teams) {
    const saved = getTeam(handle.db, team.id) === undefined ? createTeam(handle.db, { id: team.id, projectId, definition: team.definition, author: { kind: "assistant" } }) : changeTeam(handle.db, team.id, { definition: team.definition, author: { kind: "assistant" } });
    if (!saved.ok) throw new Error(saved.reason);
    const source = round.sources[team.id];
    if (source !== undefined) claimTrialTeam(handle.db, team.id, trialId, source);
  }
}

const rounds = (definition: TeamDefinition, maxRounds: number): TeamDefinition => (definition.coordination === "leader" ? { ...definition, limits: { ...definition.limits, maxRounds } } : definition);

describe("a declared team's versions (EO-881)", () => {
  it("records every change as a new version with who made it, and writes none for a change to nothing", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    expect(made.team).toMatchObject({ projectId, name: "Review leads", version: 1, locked: false, definition: first });

    expect(changeTeam(handle.db, made.team.id, { definition: rounds(first, 2), author: { kind: "person", personId: "anna" } })).toMatchObject({ ok: true, changed: true });
    const leaderItem = "01a00000-0000-7000-8000-000000000001";
    expect(changeTeam(handle.db, made.team.id, { definition: rounds(first, 3), author: { kind: "leader", agentId: agentOfKind(handle.db, "reviewer"), itemId: leaderItem } })).toMatchObject({ ok: true });
    // The same definition again changes nothing, and files nothing.
    expect(changeTeam(handle.db, made.team.id, { definition: rounds(first, 3), author: { kind: "assistant" } })).toMatchObject({ ok: true, changed: false });

    expect(getTeam(handle.db, made.team.id)).toMatchObject({ version: 3, definition: rounds(first, 3) });
    expect(listTeamVersions(handle.db, made.team.id).map(({ number, author, restoredFrom }) => ({ number, author, restoredFrom }))).toEqual([
      { number: 1, author: { kind: "assistant" }, restoredFrom: null },
      { number: 2, author: { kind: "person", personId: "anna" }, restoredFrom: null },
      { number: 3, author: { kind: "leader", agentId: agentOfKind(handle.db, "reviewer"), itemId: leaderItem }, restoredFrom: null },
    ]);
  });

  it("restores any earlier version as a person, the restore itself a new version", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    changeTeam(handle.db, made.team.id, { definition: rounds(first, 2), author: { kind: "assistant" } });
    changeTeam(handle.db, made.team.id, { definition: { ...rounds(first, 3), name: "Renamed leads" }, author: { kind: "assistant" } });

    const restored = restoreTeamVersion(handle.db, made.team.id, 1, { personId: "anna" });
    expect(restored).toMatchObject({ ok: true, team: { version: 4, name: "Review leads", definition: first } });
    expect(listTeamVersions(handle.db, made.team.id).at(-1)).toMatchObject({ number: 4, author: { kind: "person", personId: "anna" }, restoredFrom: 1, definition: first });
    // Restoring the version it now matches is still a version: it says so.
    expect(restoreTeamVersion(handle.db, made.team.id, 4, { personId: "anna" })).toMatchObject({ ok: true, team: { version: 5 } });
    expect(restoreTeamVersion(handle.db, made.team.id, 9, { personId: "anna" })).toEqual({ ok: false, reason: "That team has no version 9." });
  });

  it("refuses every change to a locked team, a restore and a leader's included, until a person unlocks it", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    changeTeam(handle.db, made.team.id, { definition: rounds(first, 2), author: { kind: "assistant" } });
    expect(setTeamLocked(handle.db, made.team.id, true)).toMatchObject({ ok: true, team: { locked: true, version: 2 } });

    const locked = 'The team "Review leads" is locked: a person must unlock it before it can change.';
    expect(changeTeam(handle.db, made.team.id, { definition: rounds(first, 3), author: { kind: "assistant" } })).toEqual({ ok: false, reason: locked });
    expect(changeTeam(handle.db, made.team.id, { definition: rounds(first, 3), author: { kind: "leader", agentId: "a", itemId: "i" } })).toEqual({ ok: false, reason: locked });
    expect(restoreTeamVersion(handle.db, made.team.id, 1, { personId: "anna" })).toEqual({ ok: false, reason: locked });
    expect(getTeam(handle.db, made.team.id)).toMatchObject({ version: 2, definition: rounds(first, 2) });
    expect(listTeamVersions(handle.db, made.team.id)).toHaveLength(2);

    // Unlocking is the one change a locked team takes; locking writes no version.
    expect(setTeamLocked(handle.db, made.team.id, false)).toMatchObject({ ok: true, team: { locked: false, version: 2 } });
    expect(restoreTeamVersion(handle.db, made.team.id, 1, { personId: "anna" })).toMatchObject({ ok: true, team: { version: 3 } });
  });

  it("refuses a name another team of its project has, and moves forward the pipelines naming a team it changes", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    expect(createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } })).toEqual({ ok: false, reason: 'This project already has a team called "Review leads".' });
    // Another project may have a team of that name.
    const other = createProject(handle.db, { name: "Other", keyPrefix: "OTH" }).id as Uuid;
    expect(createTeam(handle.db, { projectId: other, definition: first, author: { kind: "assistant" } }).ok).toBe(true);

    const pipeline = createPipeline(handle.db, { projectId, name: "Delivery" });
    createStep(handle.db, { id: "named", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "review", teamId: made.team.id });
    expect(stepsNamingTeam(handle.db, made.team.id)).toEqual([{ stepId: "named", stepName: "Review", pipelineId: pipeline.id, pipelineName: "Delivery" }]);
    handle.db.run(sql`update pipelines set updated_at = 1 where id = ${pipeline.id}`);
    changeTeam(handle.db, made.team.id, { definition: rounds(first, 2), author: { kind: "assistant" } });
    expect(handle.db.get<{ at: number }>(sql`select updated_at as at from pipelines where id = ${pipeline.id}`)?.at).toBeGreaterThan(1);
  });

  it("goes with its project, the steps naming it let go of first", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    const pipeline = createPipeline(handle.db, { projectId, name: "Delivery" });
    createStep(handle.db, { id: "named", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "review", teamId: made.team.id });
    deleteProject(handle.db, projectId);
    expect(listTeams(handle.db, projectId)).toEqual([]);
    expect(getTeam(handle.db, made.team.id)).toBeUndefined();
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it("gives a trial its own copy of each team a draft writes, the same one every round, and leaves the live team alone", () => {
    const made = createTeam(handle.db, { projectId, definition: first, author: { kind: "assistant" } });
    if (!made.ok) throw new Error(made.reason);
    const trial = createPipeline(handle.db, { projectId, name: "Delivery (trial)" });
    const draft = [{ id: made.team.id, definition: rounds(first, 3) }];
    const round1 = trialTeams(handle.db, trial, draft);
    expect(round1.teams).toEqual([{ id: expect.any(String), definition: { ...rounds(first, 3), name: "Review leads (Delivery (trial))" } }]);
    expect(round1.teamIdOf(made.team.id)).toBe(round1.teams[0]!.id);
    expect(round1.teamIdOf(null)).toBeNull();
    expect(round1.teamIdOf("another")).toBe("another");
    expect(round1.sources).toEqual({ [round1.teams[0]!.id]: "review leads" });
    saveCopies(trial.id, round1);
    // A later round names the same copy, by what it belongs to.
    expect(trialTeams(handle.db, trial, draft).teams[0]!.id).toBe(round1.teams[0]!.id);
    expect(getTeam(handle.db, made.team.id)).toMatchObject({ version: 1, definition: first });
    // Another trial's copy is its own.
    const other = createPipeline(handle.db, { projectId, name: "Delivery (trial)" });
    expect(trialTeams(handle.db, other, draft).teams[0]!.id).not.toBe(round1.teams[0]!.id);
  });

  it("never takes a live team for a trial's copy when the name it would get, cut within the limit, is the live team's", () => {
    const longName = `${"P".repeat(54)}${"Q".repeat(40)}`;
    // A live team whose name is exactly what the copy's name is cut to.
    const live = createTeam(handle.db, { projectId, definition: { ...first, name: `${"P".repeat(54)}…` }, author: { kind: "assistant" } });
    if (!live.ok) throw new Error(live.reason);
    const trial = createPipeline(handle.db, { projectId, name: `A trial with a long name ${"t".repeat(30)}` });
    const round = trialTeams(handle.db, trial, [{ id: "draft", definition: { ...first, name: longName } }]);
    const copy = round.teams[0]!;
    expect(copy.id).not.toBe(live.team.id);
    expect(copy.definition.name).toBe(`${"P".repeat(54)}… (2)`);
    saveCopies(trial.id, round);
    expect(getTeam(handle.db, live.team.id)).toMatchObject({ version: 1, name: `${"P".repeat(54)}…` });
    expect(trialTeams(handle.db, trial, [{ id: "draft", definition: { ...first, name: longName } }]).teams[0]).toEqual(copy);
  });

  it("names two draft teams whose long names cut alike apart, each its own copy every round", () => {
    const trial = createPipeline(handle.db, { projectId, name: "A trial" });
    const draft = ["A", "B"].map((letter) => ({ id: `draft-${letter}`, definition: { ...first, name: `${"P".repeat(60)}${letter.repeat(50)}` } }));
    const round1 = trialTeams(handle.db, trial, draft);
    expect(new Set(round1.teams.map((team) => team.id)).size).toBe(2);
    expect(round1.teams.map((team) => team.definition.name)).toEqual([`${"P".repeat(54)}…`, `${"P".repeat(54)}… (2)`]);
    saveCopies(trial.id, round1);
    const round2 = trialTeams(handle.db, trial, [...draft].reverse());
    expect(round2.teamIdOf("draft-A")).toBe(round1.teamIdOf("draft-A"));
    expect(round2.teamIdOf("draft-B")).toBe(round1.teamIdOf("draft-B"));
    expect(new Set(round2.teams.map((team) => team.definition.name.toLowerCase())).size).toBe(2);
    saveCopies(trial.id, round2);
  });

  it("declares a team for a long pipeline and step name, and a long trial copy, under a name within the limit, numbered apart, that EO can read", () => {
    const pipeline = createPipeline(handle.db, { projectId, name: "P".repeat(100) });
    const team = StepTeamSchema.parse({ coordination: "leader", leader: { role: "reviewer", instructions: "Lead." }, roles: ["implementer"] });
    const ids = ["a", "b"].map((letter) => teamIdForInlineTeam(handle.db, { pipelineId: pipeline.id, stepName: `Review ${letter.repeat(23)}`, team, current: null }));
    const stored = ids.map((id) => getTeam(handle.db, id!)!);
    expect(stored.map((one) => one.name)).toEqual([`${"P".repeat(54)}…`, `${"P".repeat(54)}… (2)`]);
    for (const one of stored) expect(one.definition).not.toBeNull();

    const long = { ...first, name: "L".repeat(TEAM_NAME_MAX) };
    const copy = trialTeams(handle.db, { id: pipeline.id, name: "A trial" }, [{ id: "draft", definition: long }]).teams[0]!;
    expect(copy.definition.name.length).toBeLessThanOrEqual(TEAM_NAME_MAX);
    expect(createTeam(handle.db, { id: copy.id, projectId, definition: copy.definition, author: { kind: "assistant" } }).ok).toBe(true);
  });
});
