import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_POLICY, TeamDefinitionSchema, type TeamDefinition, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { agentOfKind, createTestItem, giveSeededDelivery, openMigratedTestDb } from "../db/testHelpers.js";
import { archiveAgent, createAgent, getAgent, updateAgent } from "../db/repos/agentsRepo.js";
import { createPerson } from "../db/repos/peopleRepo.js";
import { createPipeline, createStep, listStepsForPipeline } from "../db/repos/pipelineStepsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { changeTeam, claimTrialTeam, createTeam, getTeam, listTeamVersions } from "../db/repos/teamsRepo.js";
import { writePolicy } from "../policy/policy.js";
import { publishSection } from "../db/repos/index.js";
import { markReplica } from "../db/recordRole.js";
import { teams } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sectionLockFor } from "../managed/locks.js";
import { listTeamsCommand, restoreTeamCommand, setTeamLockedCommand, setTeamMemberSettingsCommand, setTeamMembersSettingsCommand } from "./declaredTeamCommands.js";

/**
 * The Teams tab's main half (EO-884): every declared team read whole —
 * its leader and members as the agents they are, who added each, the
 * steps naming it and its versions — and a person restoring a version or
 * locking the team.
 */
let handle: DbHandle;
let projectId: Uuid;
/** The team's leader and member: after `made()`, the team's own agents (EO-897), copied from the ordinary agents of those kinds. */
let reviewer: Uuid;
let implementer: Uuid;
/** The ordinary agents of those kinds, which steps name. */
let ordinaryReviewer: Uuid;
let ordinaryImplementer: Uuid;
let definition: TeamDefinition;

beforeEach(() => {
  handle = openMigratedTestDb();
  projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
  reviewer = agentOfKind(handle.db, "reviewer");
  implementer = agentOfKind(handle.db, "implementer");
  updateAgent(handle.db, reviewer, { provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
  ordinaryReviewer = reviewer;
  ordinaryImplementer = implementer;
  definition = TeamDefinitionSchema.parse({
    name: "Review leads",
    coordination: "leader",
    memberMode: "isolated",
    leader: { agentId: reviewer, instructions: "Split the review by risk." },
    members: [{ agentId: implementer }],
    toolPool: { cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] },
    modelRange: { runtimes: ["claude", "codex"], models: ["sonnet"], reasoning: ["low", "high"] },
    memberCap: 5,
    limits: { maxRounds: 1 },
  });
});

afterEach(() => handle.close());

/**
 * Declares the team. Its leader and member are made its own agents
 * (EO-897), so `reviewer`, `implementer` and `definition` name those from
 * here on.
 */
function made(): string {
  const result = createTeam(handle.db, { projectId, definition, author: { kind: "eo" } });
  if (!result.ok) throw new Error(result.reason);
  const stored = result.team.definition;
  if (stored === null || stored.coordination !== "leader") throw new Error("The team did not read back.");
  definition = stored;
  reviewer = stored.leader.agentId as Uuid;
  implementer = stored.members[0]!.agentId as Uuid;
  return result.team.id;
}

describe("teams:list (EO-884)", () => {
  it("reads a team whole: its leader and members as the agents they are, its pool, range, limits, cap, steps and versions", () => {
    const teamId = made();
    const pipeline = createPipeline(handle.db, { projectId, name: "Delivery" });
    createStep(handle.db, { id: "team-review", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: ordinaryReviewer, entryAction: "review", teamId });

    const [team] = listTeamsCommand(handle.db).teams;
    expect(team).toMatchObject({
      id: teamId,
      projectId,
      projectName: "Shop",
      name: "Review leads",
      locked: false,
      version: 1,
      coordination: "leader",
      memberMode: "isolated",
      memberCap: 5,
      toolPool: { cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] },
      modelRange: { runtimes: ["claude", "codex"], models: ["sonnet"], reasoning: ["low", "high"] },
      limits: { maxRounds: 1 },
      leader: { agentId: reviewer, kind: "reviewer", provider: "codex", model: "gpt-5", reasoning: "high", teamInstructions: "Split the review by risk.", addedBy: { kind: "eo" } },
      members: [{ agentId: implementer, kind: "implementer", teamInstructions: null, addedBy: { kind: "eo" } }],
      steps: [{ stepId: "team-review", stepName: "Review", pipelineId: pipeline.id, pipelineName: "Delivery" }],
      versions: [{ number: 1, author: { kind: "eo" }, restoredFrom: null }],
    });
    expect(team?.leader?.instructions.length).toBeGreaterThan(0);
  });

  it("says who added each member — a person, or a leader on an item, by its key — and who made each version, newest first", () => {
    const teamId = made();
    giveSeededDelivery(handle.db, projectId);
    const item = createTestItem(handle.db, { type: "story", title: "Checkout", projectId, stepId: "todo" });
    const anna = createPerson(handle.db, { name: "Anna" });
    const tester = createAgent(handle.db, { name: "Tess", role: "reviewer", provider: "claude", model: null, instructions: "Write the tests that are missing." });
    const withTester = { ...definition, members: [...definition.members, { agentId: tester.id }] } as TeamDefinition;
    expect(changeTeam(handle.db, teamId, { definition: withTester, author: { kind: "leader", agentId: reviewer, itemId: item.id } }).ok).toBe(true);
    expect(changeTeam(handle.db, teamId, { definition: { ...withTester, memberCap: 6 }, author: { kind: "person", personId: anna.id } }).ok).toBe(true);

    const [team] = listTeamsCommand(handle.db).teams;
    expect(team?.members.map((member) => [member.name, member.addedBy])).toEqual([
      [expect.any(String), { kind: "eo" }],
      ["Tess", { kind: "leader", itemId: item.id, itemKey: item.key }],
    ]);
    expect(team?.versions.map(({ number, author, authorName, itemKey }) => ({ number, kind: author.kind, authorName, itemKey }))).toEqual([
      { number: 3, kind: "person", authorName: "Anna", itemKey: null },
      { number: 2, kind: "leader", authorName: expect.any(String), itemKey: item.key },
      { number: 1, kind: "eo", authorName: null, itemKey: null },
    ]);
  });

  it("leaves out a trial's own copy of a draft's team", () => {
    made();
    const trial = createPipeline(handle.db, { projectId, name: "Delivery (trial)" });
    const copy = createTeam(handle.db, { projectId, definition: { ...definition, name: "Review leads (trial)" }, author: { kind: "assistant" } });
    if (!copy.ok) throw new Error(copy.reason);
    claimTrialTeam(handle.db, copy.team.id, trial.id, "review leads");
    expect(listTeamsCommand(handle.db).teams.map((team) => team.name)).toEqual(["Review leads"]);
  });
});

describe("teams:restore and teams:setLocked (EO-884)", () => {
  it("restores an earlier version as the person asking, itself a new version", () => {
    const teamId = made();
    changeTeam(handle.db, teamId, { definition: { ...definition, memberCap: 7 }, author: { kind: "assistant" } });
    expect(restoreTeamCommand(handle.db, { teamId, version: 1 })).toEqual({ restored: true, problem: null });
    expect(getTeam(handle.db, teamId)).toMatchObject({ version: 3, definition });
    expect(listTeamVersions(handle.db, teamId).at(-1)).toMatchObject({ number: 3, author: { kind: "person" }, restoredFrom: 1 });
    expect(restoreTeamCommand(handle.db, { teamId, version: 9 })).toEqual({ restored: false, problem: "That team has no version 9." });
    expect(restoreTeamCommand(handle.db, { teamId: "gone", version: 1 })).toEqual({ restored: false, problem: "That team no longer exists." });
  });

  it("locks a team, which then refuses a restore until it is unlocked", () => {
    const teamId = made();
    changeTeam(handle.db, teamId, { definition: { ...definition, memberCap: 7 }, author: { kind: "assistant" } });
    expect(setTeamLockedCommand(handle.db, { teamId, locked: true })).toEqual({ changed: true, problem: null });
    expect(listTeamsCommand(handle.db).teams[0]?.locked).toBe(true);
    expect(restoreTeamCommand(handle.db, { teamId, version: 1 })).toEqual({ restored: false, problem: 'The team "Review leads" is locked: a person must unlock it before it can change.' });
    expect(setTeamLockedCommand(handle.db, { teamId, locked: false })).toEqual({ changed: true, problem: null });
    expect(restoreTeamCommand(handle.db, { teamId, version: 1 }).restored).toBe(true);
  });
});

describe("teams:setMemberSettings (EO-884)", () => {
  const settingsOf = (agentId: Uuid) => {
    const agent = getAgent(handle.db, agentId);
    return { provider: agent?.provider, model: agent?.model, config: agent?.config };
  };

  it("changes a member's runtime, model and reasoning, the leader's included, each as a new version recording every member", () => {
    const teamId = made();
    updateAgent(handle.db, implementer, { provider: "claude", model: "claude-opus-5", config: { effort: "low", maxTurns: 5 } });

    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" })).toEqual({ saved: true, problem: null });
    // The reasoning under the new backend's own key; the old backend's dropped, the rest of the agent kept.
    expect(settingsOf(implementer)).toEqual({ provider: "codex", model: "gpt-5.1-codex", config: { reasoningEffort: "xhigh", maxTurns: 5 } });
    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: reviewer, provider: "claude", model: null, reasoning: "high" })).toEqual({ saved: true, problem: null });
    expect(settingsOf(reviewer)).toMatchObject({ provider: "claude", model: null, config: { effort: "high" } });

    const versions = listTeamVersions(handle.db, teamId);
    expect(versions.map(({ number, author, memberSettings }) => ({ number, author: author.kind, memberSettings }))).toEqual([
      { number: 1, author: "eo", memberSettings: { [reviewer]: { provider: "codex", model: "gpt-5", reasoning: "high" }, [implementer]: expect.any(Object) } },
      {
        number: 2,
        author: "person",
        memberSettings: { [reviewer]: { provider: "codex", model: "gpt-5", reasoning: "high" }, [implementer]: { provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" } },
      },
      {
        number: 3,
        author: "person",
        memberSettings: { [reviewer]: { provider: "claude", model: null, reasoning: "high" }, [implementer]: { provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" } },
      },
    ]);
    expect(getTeam(handle.db, teamId)).toMatchObject({ version: 3, definition });
    // The same settings again write nothing.
    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: reviewer, provider: "claude", model: null, reasoning: "high" })).toEqual({ saved: false, problem: null });
    expect(getTeam(handle.db, teamId)?.version).toBe(3);
  });

  it("restoring a version puts its members' runtime, model and reasoning back on them", () => {
    const teamId = made();
    setTeamMemberSettingsCommand(handle.db, { teamId, agentId: reviewer, provider: "claude", model: "claude-opus-5", reasoning: "low" });
    expect(restoreTeamCommand(handle.db, { teamId, version: 1 })).toEqual({ restored: true, problem: null });
    expect(settingsOf(reviewer)).toEqual({ provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
    expect(listTeamVersions(handle.db, teamId).at(-1)).toMatchObject({ number: 3, restoredFrom: 1, memberSettings: { [reviewer]: { provider: "codex", model: "gpt-5", reasoning: "high" } } });
  });

  it("refuses a locked team, an agent not on it, and a backend the organisation does not allow, changing nothing", () => {
    const teamId = made();
    const before = settingsOf(implementer);
    const stranger = createAgent(handle.db, { name: "Stranger", role: "reviewer", provider: "claude", model: null, instructions: "" });
    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: stranger.id, provider: "codex", model: null, reasoning: null })).toEqual({ saved: false, problem: 'That agent is not on the team "Review leads".' });

    setTeamLockedCommand(handle.db, { teamId, locked: true });
    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: "codex", model: null, reasoning: null })).toEqual({
      saved: false,
      problem: 'The team "Review leads" is locked: a person must unlock it before it can change.',
    });
    setTeamLockedCommand(handle.db, { teamId, locked: false });

    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: [before.provider as string], publishedAt: 1 });
    const other = before.provider === "codex" ? "claude" : "codex";
    const refused = setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: other, model: null, reasoning: null });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain(`The "${other}" backend is`);
    expect(settingsOf(implementer)).toEqual(before);
    expect(getTeam(handle.db, teamId)?.version).toBe(1);
  });
});

describe("a member is the team's own agent (EO-897)", () => {
  it("changes only that member: no ordinary agent and no step outside the team changes", () => {
    const pipeline = createPipeline(handle.db, { projectId, name: "Delivery" });
    createStep(handle.db, { id: "solo-review", pipelineId: pipeline.id, position: 0, name: "Solo review", type: "agent", agentId: ordinaryReviewer, entryAction: "review" });
    createStep(handle.db, { id: "build", pipelineId: pipeline.id, position: 1, name: "Build", type: "agent", agentId: ordinaryImplementer, entryAction: "implement" });
    const teamId = made();
    createStep(handle.db, { id: "team-review", pipelineId: pipeline.id, position: 2, name: "Team review", type: "agent", agentId: ordinaryReviewer, entryAction: "review", teamId });
    // Its agents are its own: copies, owned by the team, of the ordinary ones.
    expect([reviewer, implementer]).not.toContain(ordinaryReviewer);
    expect([reviewer, implementer]).not.toContain(ordinaryImplementer);
    expect([getAgent(handle.db, reviewer)?.teamId, getAgent(handle.db, implementer)?.teamId]).toEqual([teamId, teamId]);
    const ordinaryBefore = [getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)];
    const stepsBefore = listStepsForPipeline(handle.db, pipeline.id);

    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: reviewer, provider: "claude", model: "claude-opus-5", reasoning: "low" })).toEqual({ saved: true, problem: null });
    expect(setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" })).toEqual({ saved: true, problem: null });

    expect(getAgent(handle.db, reviewer)).toMatchObject({ provider: "claude", model: "claude-opus-5", config: { effort: "low" } });
    expect(getAgent(handle.db, implementer)).toMatchObject({ provider: "codex", model: "gpt-5.1-codex", config: { reasoningEffort: "xhigh" } });
    expect([getAgent(handle.db, ordinaryReviewer), getAgent(handle.db, ordinaryImplementer)]).toEqual(ordinaryBefore);
    expect(listStepsForPipeline(handle.db, pipeline.id)).toEqual(stepsBefore);
  });

  it("refuses an ordinary agent named by its id, which no team owns", () => {
    const teamId = made();
    // Written past the save, which would have made it the team's own.
    const stored = getTeam(handle.db, teamId)?.definition;
    if (stored?.coordination !== "leader") throw new Error("The team did not read back.");
    handle.db.update(teams).set({ definition: { ...stored, members: [{ agentId: ordinaryImplementer }] } }).where(eq(teams.id, teamId)).run();
    const before = getAgent(handle.db, ordinaryImplementer);
    const refused = setTeamMemberSettingsCommand(handle.db, { teamId, agentId: ordinaryImplementer, provider: "codex", model: null, reasoning: null });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain("is not the team");
    expect(getAgent(handle.db, ordinaryImplementer)).toEqual(before);
  });
});

describe("teams:setMemberSettings refusals that leave the agent as it was (EO-884)", () => {
  it("refuses an archived member's agent, as agents:setBinding does", () => {
    const teamId = made();
    archiveAgent(handle.db, implementer);
    const before = getAgent(handle.db, implementer);
    const refused = setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: "codex", model: null, reasoning: null });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain("is archived");
    expect(getAgent(handle.db, implementer)).toEqual(before);
    expect(getTeam(handle.db, teamId)?.version).toBe(1);
  });

  it("rolls the member's new settings back when its version is refused", () => {
    // Another team of the project, older, ends up with the same name by a
    // write that bypassed the check: the version is refused for the name.
    const other = createTeam(handle.db, { projectId, definition: { ...definition, name: "Other" }, author: { kind: "eo" } });
    if (!other.ok) throw new Error(other.reason);
    const teamId = made();
    handle.db.update(teams).set({ name: definition.name }).where(eq(teams.id, other.team.id)).run();
    const before = getAgent(handle.db, implementer);
    const refused = setTeamMemberSettingsCommand(handle.db, { teamId, agentId: implementer, provider: "codex", model: "gpt-5.1-codex", reasoning: "low" });
    expect(refused).toEqual({ saved: false, problem: 'This project already has a team called "Review leads".' });
    expect(getAgent(handle.db, implementer)).toEqual(before);
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(1);
  });
});

describe("teams:setMembersSettings (EO-901)", () => {
  // The Teams tab's bulk change: EO-900's channel, its members named by agent. This machine's runtimes are not asked here.
  const bulk = (input: { teamId: string; agentIds: string[]; members?: string[]; provider: string; model: string | null; reasoning: string | null }) =>
    setTeamMembersSettingsCommand(handle.db, { members: [], ...input }, async () => null);
  const settingsOf = (agentId: Uuid) => {
    const agent = getAgent(handle.db, agentId);
    return { provider: agent?.provider, model: agent?.model, config: agent?.config };
  };

  it("puts one runtime, model and reasoning on every chosen member, the leader's included, as one version a restore undoes", async () => {
    const teamId = made();
    updateAgent(handle.db, implementer, { provider: "claude", model: "claude-opus-5", config: { effort: "low", maxTurns: 5 } });
    const before = { reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) };
    const rest = (agentId: Uuid) => {
      const agent = getAgent(handle.db, agentId);
      return { name: agent?.name, role: agent?.role, instructions: agent?.instructions, teamId: agent?.teamId };
    };
    const restBefore = [rest(reviewer), rest(implementer)];

    expect(await bulk({ teamId, agentIds: [reviewer, implementer], provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" })).toMatchObject({ saved: true, problem: null });
    // Only the three settings: the rest of each agent is kept.
    expect(settingsOf(reviewer)).toEqual({ provider: "codex", model: "gpt-5.1-codex", config: { reasoningEffort: "xhigh" } });
    expect(settingsOf(implementer)).toEqual({ provider: "codex", model: "gpt-5.1-codex", config: { reasoningEffort: "xhigh", maxTurns: 5 } });
    expect([rest(reviewer), rest(implementer)]).toEqual(restBefore);
    const versions = listTeamVersions(handle.db, teamId);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      number: 2,
      author: { kind: "person" },
      memberSettings: { [reviewer]: { provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" }, [implementer]: { provider: "codex", model: "gpt-5.1-codex", reasoning: "xhigh" } },
    });
    expect(getTeam(handle.db, teamId)).toMatchObject({ version: 2, definition });

    // One restore undoes all of it — the implementer's settings as version 1 recorded them.
    const recorded = listTeamVersions(handle.db, teamId)[0]?.memberSettings?.[implementer];
    expect(restoreTeamCommand(handle.db, { teamId, version: 1 })).toEqual({ restored: true, problem: null });
    expect(settingsOf(reviewer)).toEqual(before.reviewer);
    expect(settingsOf(implementer)).toMatchObject({ provider: recorded?.provider, model: recorded?.model });
  });

  it("changes only the chosen members, and writes nothing where every one already has the settings", async () => {
    const teamId = made();
    const leaderBefore = settingsOf(reviewer);
    expect(await bulk({ teamId, agentIds: [implementer], provider: "claude", model: null, reasoning: "high" })).toMatchObject({ saved: true, problem: null });
    expect(settingsOf(reviewer)).toEqual(leaderBefore);
    expect(settingsOf(implementer)).toMatchObject({ provider: "claude", model: null, config: { effort: "high" } });
    expect(await bulk({ teamId, agentIds: [implementer], provider: "claude", model: null, reasoning: "high" })).toMatchObject({ saved: true, changed: [], problem: null });
    expect(getTeam(handle.db, teamId)?.version).toBe(2);
  });

  it("refuses the whole change, applying nothing, for a locked team, an agent not on it, an archived member and a backend the organisation does not allow", async () => {
    const teamId = made();
    const before = { reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) };
    const unchanged = () => {
      expect({ reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) }).toEqual(before);
      expect(getTeam(handle.db, teamId)?.version).toBe(1);
    };

    setTeamLockedCommand(handle.db, { teamId, locked: true });
    expect(await bulk({ teamId, agentIds: [reviewer, implementer], provider: "claude", model: null, reasoning: null })).toMatchObject({
      saved: false,
      problem: 'The team "Review leads" is locked: a person must unlock it before it can change.',
    });
    unchanged();
    setTeamLockedCommand(handle.db, { teamId, locked: false });

    const stranger = createAgent(handle.db, { name: "Stranger", role: "reviewer", provider: "claude", model: null, instructions: "" });
    expect(await bulk({ teamId, agentIds: [reviewer, stranger.id], provider: "claude", model: null, reasoning: null })).toMatchObject({
      saved: false,
      problem: 'That agent is not on the team "Review leads".',
    });
    unchanged();

    // The reviewer is first, and would be changed by itself; the archived implementer refuses both.
    archiveAgent(handle.db, implementer);
    const archived = await bulk({ teamId, agentIds: [reviewer, implementer], provider: "claude", model: null, reasoning: null });
    expect(archived.saved).toBe(false);
    expect(archived.problem).toContain("is archived");
    expect(settingsOf(reviewer)).toEqual(before.reviewer);
    expect(getTeam(handle.db, teamId)?.version).toBe(1);
  });

  it("refuses a backend the organisation does not allow, naming it, for a member it would move", async () => {
    const teamId = made();
    const before = { reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) };
    // The reviewer is on codex; the implementer on whatever the seed gave it.
    const other = before.implementer.provider === "codex" ? "claude" : "codex";
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: [before.implementer.provider as string], publishedAt: 1 });
    const refused = await bulk({ teamId, agentIds: [reviewer, implementer], provider: other, model: null, reasoning: null });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain(`The "${other}" backend is`);
    expect({ reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) }).toEqual(before);
    expect(getTeam(handle.db, teamId)?.version).toBe(1);
  });

  it("refuses a change naming no member, or naming them both by name and by agent, applying nothing", async () => {
    const teamId = made();
    const before = { reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) };
    expect(await bulk({ teamId, agentIds: [], provider: "claude", model: null, reasoning: null })).toMatchObject({ saved: false, problem: "Choose at least one member to apply the settings to. Nothing has changed." });
    const leaderName = getAgent(handle.db, reviewer)?.name ?? "";
    expect(await bulk({ teamId, agentIds: [implementer], members: [leaderName], provider: "claude", model: null, reasoning: null })).toMatchObject({
      saved: false,
      problem: "Name the members by name or by agent, not both. Nothing has changed.",
    });
    expect({ reviewer: settingsOf(reviewer), implementer: settingsOf(implementer) }).toEqual(before);
    expect(getTeam(handle.db, teamId)?.version).toBe(1);
  });

  it("is a member's runtime choice, which the organisation's published pipelines do not hold", async () => {
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    const stop = markReplica(handle.db, () => true);
    try {
      expect(sectionLockFor(handle.db, "teams:setMembersSettings", { teamId: "t", agentIds: ["a"], provider: "claude" })).toBeNull();
    } finally {
      stop();
    }
  });

  it("rolls every member's new settings back when its version is refused", async () => {
    const other = createTeam(handle.db, { projectId, definition: { ...definition, name: "Other" }, author: { kind: "eo" } });
    if (!other.ok) throw new Error(other.reason);
    const teamId = made();
    handle.db.update(teams).set({ name: definition.name }).where(eq(teams.id, other.team.id)).run();
    const before = [getAgent(handle.db, reviewer), getAgent(handle.db, implementer)];
    const refused = await bulk({ teamId, agentIds: [reviewer, implementer], provider: "claude", model: "claude-opus-5", reasoning: "low" });
    expect(refused).toMatchObject({ saved: false, problem: 'This project already has a team called "Review leads".' });
    expect([getAgent(handle.db, reviewer), getAgent(handle.db, implementer)]).toEqual(before);
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(1);
  });
});

describe("the section lock on a team (EO-884)", () => {
  it("holds a restore and a lock to the published pipelines, as any write of the graph is, and leaves a member's runtime the person's", () => {
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    const stop = markReplica(handle.db, () => true);
    try {
      expect(sectionLockFor(handle.db, "teams:restore", { teamId: "t", version: 1 })).toMatchObject({ locked: true, section: "pipelines" });
      expect(sectionLockFor(handle.db, "teams:setLocked", { teamId: "t", locked: false })).toMatchObject({ locked: true, section: "pipelines" });
      expect(sectionLockFor(handle.db, "teams:setMemberSettings", { teamId: "t", agentId: "a", provider: "claude" })).toBeNull();
    } finally {
      stop();
    }
  });
});
