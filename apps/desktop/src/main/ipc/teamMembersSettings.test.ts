import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_POLICY, TeamDefinitionSchema, type IpcChannel, type IpcPayload, type RuntimeStatusView, type TeamDefinition, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { agentOfKind, openMigratedTestDb } from "../db/testHelpers.js";
import { getAgent, listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { agentToolSurfaces, createTeam, getTeam, listTeamVersions, restoreTeamVersion, setTeamLocked } from "../db/repos/teamsRepo.js";
import { publishSection } from "../db/repos/index.js";
import { markReplica } from "../db/recordRole.js";
import { sectionLockFor } from "../managed/locks.js";
import { writePolicy } from "../policy/policy.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { answerToolCall } from "../mcpHost/server.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { listTeamsCommand, runtimeReadinessNote, setTeamMembersSettingsCommand, type RuntimeReadiness } from "./declaredTeamCommands.js";

/**
 * EO's tools setting a declared team's members' runtime, model and
 * reasoning (EO-900): `teams:setMembersSettings` and the
 * `team_member_settings_set` tool over it — members by name, the leader's
 * included, one version filed as whoever asked, nothing else of a member
 * or the team changed, and every Teams-tab rule held.
 */
let handle: DbHandle;
let teamId: string;
let leaderName: string;
let memberName: string;
let leaderId: Uuid;
let memberId: Uuid;
let definition: TeamDefinition;

/** A runtime as `runtime:status` answers for one installed and signed in, changed by `over`. */
function runtime(over: Partial<RuntimeStatusView> & { signedIn?: "signed_in" | "signed_out" | "unknown" } = {}): RuntimeStatusView {
  const { signedIn = "signed_in", ...rest } = over;
  return {
    id: "codex",
    label: "Codex",
    publisher: "OpenAI",
    termsUrl: "https://example.com",
    source: "cache",
    path: "/opt/eo/runtimes/codex/bin/codex",
    version: "1.0.0",
    packageName: null,
    packageVersion: null,
    auth: { state: signedIn, method: null, kind: "unknown" } as RuntimeStatusView["auth"],
    ...rest,
  };
}

/** Every runtime installed and signed in, unless a test says otherwise. */
let readiness: RuntimeReadiness;

function setMembers(input: Partial<IpcPayload<"teams:setMembersSettings">>) {
  return setTeamMembersSettingsCommand(handle.db, { teamId, members: [memberName], provider: "claude", model: "sonnet", reasoning: "high", ...input }, readiness);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  readiness = async (provider) => runtime({ id: provider, label: provider });
  const projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id;
  const reviewer = agentOfKind(handle.db, "reviewer");
  const implementer = agentOfKind(handle.db, "implementer");
  updateAgent(handle.db, reviewer, { provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
  const made = createTeam(handle.db, {
    projectId,
    definition: TeamDefinitionSchema.parse({
      name: "Reviewers",
      coordination: "leader",
      memberMode: "isolated",
      leader: { agentId: reviewer, instructions: "Split the review by risk." },
      members: [{ agentId: implementer }],
      toolPool: { cliTools: ["gh"], mcpServers: [], skills: [] },
      modelRange: { runtimes: ["claude", "codex"], models: ["sonnet", "opus", "gpt-5"], reasoning: ["low", "high"] },
      memberCap: 5,
      limits: { maxRounds: 1 },
    }),
    author: { kind: "eo" },
  });
  if (!made.ok) throw new Error(made.reason);
  teamId = made.team.id;
  const stored = made.team.definition;
  if (stored === null || stored.coordination !== "leader") throw new Error("The team did not read back.");
  definition = stored;
  leaderId = stored.leader.agentId as Uuid;
  memberId = stored.members[0]!.agentId as Uuid;
  leaderName = getAgent(handle.db, leaderId)!.name;
  memberName = getAgent(handle.db, memberId)!.name;
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

describe("teams:setMembersSettings (EO-900)", () => {
  it("sets the leader and a member, by name in any case, to one runtime, model and reasoning, as one version that one restore undoes", async () => {
    const before = { leader: getAgent(handle.db, leaderId), member: getAgent(handle.db, memberId), tools: agentToolSurfaces(handle.db, [leaderId, memberId]) };
    const result = await setMembers({ members: [leaderName.toUpperCase(), ` ${memberName} `], provider: "claude", model: "opus", reasoning: "high" });
    expect(result).toEqual({ saved: true, changed: [leaderName, memberName], version: 2, problem: null, note: null });

    expect(getAgent(handle.db, leaderId)).toMatchObject({ provider: "claude", model: "opus", config: { effort: "high" } });
    expect(getAgent(handle.db, memberId)).toMatchObject({ provider: "claude", model: "opus", config: { effort: "high" } });
    // Nothing but the three settings: instructions, kind, tools and membership stay.
    for (const [id, was] of [
      [leaderId, before.leader],
      [memberId, before.member],
    ] as const) {
      const now = getAgent(handle.db, id)!;
      expect({ name: now.name, role: now.role, instructions: now.instructions, teamId: now.teamId, enabled: now.enabled }).toEqual({ name: was!.name, role: was!.role, instructions: was!.instructions, teamId: was!.teamId, enabled: was!.enabled });
    }
    expect(agentToolSurfaces(handle.db, [leaderId, memberId])).toEqual(before.tools);
    expect(getTeam(handle.db, teamId)?.definition).toEqual(definition);

    const versions = listTeamVersions(handle.db, teamId);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ number: 2, author: { kind: "person" }, memberSettings: { [leaderId]: { provider: "claude", model: "opus", reasoning: "high" }, [memberId]: { provider: "claude", model: "opus", reasoning: "high" } } });

    // Settings it already has file nothing.
    expect(await setMembers({ members: [memberName], provider: "claude", model: "opus", reasoning: "high" })).toEqual({ saved: true, changed: [], version: 2, problem: null, note: null });
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(2);

    // Restoring version 1 puts both back.
    expect(restoreTeamVersion(handle.db, teamId, 1, { personId: null }).ok).toBe(true);
    expect(getAgent(handle.db, leaderId)).toMatchObject({ provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
    expect(getAgent(handle.db, memberId)).toMatchObject({ provider: before.member!.provider, model: before.member!.model });
  });

  it("files the version as the system agent, an outside client, or the person, by who the door says is asking", async () => {
    const system = agentOfKind(handle.db, "system");
    await setMembers({ provider: "claude", model: "opus", actingAgentId: system });
    await setMembers({ provider: "codex", model: "gpt-5", throughClient: true });
    await setMembers({ provider: "claude", model: "sonnet" });
    expect(listTeamVersions(handle.db, teamId).map((version) => version.author.kind)).toEqual(["eo", "system", "client", "person"]);
    expect(listTeamVersions(handle.db, teamId)[1]?.author).toEqual({ kind: "system", agentId: system });
    // The Teams tab names the system agent that made its version.
    const [team] = listTeamsCommand(handle.db).teams;
    expect(team?.versions.map((version) => version.author.kind)).toEqual(["person", "client", "system", "eo"]);
    expect(team?.versions[2]?.authorName).toBe(getAgent(handle.db, system)!.name);
  });

  it("refuses a locked team, saying so, and changes nothing", async () => {
    setTeamLocked(handle.db, teamId, true);
    const before = getAgent(handle.db, memberId);
    expect(await setMembers({})).toEqual({ saved: false, changed: [], version: 1, problem: 'The team "Reviewers" is locked: a person must unlock it before it can change.', note: null });
    expect(getAgent(handle.db, memberId)).toEqual(before);
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(1);
  });

  it("refuses a name that is not on the team, naming who is, and changes no one", async () => {
    const before = [getAgent(handle.db, leaderId), getAgent(handle.db, memberId)];
    const refused = await setMembers({ members: [leaderName, "Nobody"] });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain('"Nobody" is not on the team "Reviewers"');
    expect(refused.problem).toContain(`"${leaderName}"`);
    expect(refused.problem).toContain(`"${memberName}"`);
    expect([getAgent(handle.db, leaderId), getAgent(handle.db, memberId)]).toEqual(before);
  });

  it.each([
    { what: "a runtime", input: { provider: "fake", model: "opus", reasoning: "low" } },
    { what: "a model", input: { model: "haiku" } },
    { what: "the runtime's default model", input: { model: null } },
    { what: "a reasoning level", input: { reasoning: "xhigh" } },
  ])("saves $what outside the team's model range, which bounds only the members a leader adds, as the Teams tab never asks it", async ({ input }) => {
    const set = await setMembers(input);
    expect(set).toMatchObject({ saved: true, changed: [memberName], problem: null });
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(2);
  });

  it("refuses a runtime EO has none of", async () => {
    expect((await setMembers({ provider: "gemini" })).problem).toContain('EO has no runtime called "gemini"');
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(1);
  });

  it.each([
    { what: "not installed", status: { source: "absent" as const, path: null }, says: "Claude Code is not installed on this machine, so this member cannot run here until somebody installs it on the Runtimes tab." },
    { what: "turned off", status: { path: null }, says: "Claude Code is turned off on this machine, so this member cannot run here until somebody turns it on on the Runtimes tab." },
    { what: "signed out", status: { signedIn: "signed_out" as const }, says: "This machine is not signed in to Claude Code, so this member cannot run here until somebody signs in on the Runtimes tab." },
  ])("saves a runtime this machine has $what, and says so in its answer as the Teams tab says it", async ({ status, says }) => {
    readiness = async () => runtime({ id: "claude", label: "Claude Code", ...status });
    const set = await setMembers({});
    expect(set).toMatchObject({ saved: true, changed: [memberName], problem: null, note: says });
    expect(getAgent(handle.db, memberId)).toMatchObject({ provider: "claude", model: "sonnet" });
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(2);
  });

  it("says nothing of a runtime this machine can run, one with no CLI of its own, or one whose sign-in nobody could ask", async () => {
    expect((await setMembers({})).note).toBeNull();
    expect(runtimeReadinessNote(null, 1)).toBeNull();
    expect(runtimeReadinessNote(runtime({ signedIn: "unknown" }), 1)).toBeNull();
    expect(runtimeReadinessNote(runtime({ label: "Codex", signedIn: "signed_out" }), 2)).toBe("This machine is not signed in to Codex, so these members cannot run here until somebody signs in on the Runtimes tab.");
  });

  it("refuses a backend the organisation does not allow, for a member it would move", async () => {
    writePolicy(handle.db, { ...NO_POLICY, allowedBackends: ["codex"] });
    const refused = await setMembers({ provider: "claude" });
    expect(refused.saved).toBe(false);
    expect(refused.problem).toContain("claude");
    // A member already on an allowed backend stays changeable.
    expect(await setMembers({ members: [leaderName], provider: "codex", model: "gpt-5", reasoning: "low" })).toMatchObject({ saved: true, changed: [leaderName] });
  });

  it("is a runtime and model choice, so a published pipelines section does not lock it", () => {
    publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    const stop = markReplica(handle.db, () => true);
    try {
      expect(sectionLockFor(handle.db, "teams:setMembersSettings", { teamId: "t", members: ["a"], provider: "claude" })).toBeNull();
    } finally {
      stop();
    }
  });
});

describe("team_member_settings_set and teams_list (EO-900)", () => {
  const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
  const tool = (name: string) => {
    const found = TOOLS.find((spec) => spec.name === name);
    if (found === undefined) throw new Error(`No tool ${name}.`);
    return found;
  };

  beforeEach(() => {
    registerHandler("teams:list", () => listTeamsCommand(handle.db), { exposeErrorDetails: true });
    registerHandler("teams:setMembersSettings", (payload) => setTeamMembersSettingsCommand(handle.db, payload, readiness), { exposeErrorDetails: true });
  });

  it("teams_list says what each member runs on, and the team's model range, before anything changes", async () => {
    const listed = await tool("teams_list").run(dispatch, {});
    if (!listed.ok) throw new Error(listed.message);
    expect(listed.text).toContain('model range: runtimes claude, codex; models sonnet, opus, gpt-5; reasoning low, high');
    expect(listed.text).toContain(`- leader ${leaderName}: runtime codex, model gpt-5, reasoning high`);
    const member = getAgent(handle.db, memberId)!;
    expect(listed.text).toContain(`- member ${memberName}: runtime ${member.provider}, model ${member.model ?? "the runtime's default"}`);
  });

  it("on EO's outside listener, sets the members and files the version as the client's", async () => {
    const answer = await answerToolCall({ name: "team_member_settings_set", arguments: { teamId, members: [leaderName, memberName], provider: "claude", model: "opus", reasoning: "low" } }, "external", false);
    expect(answer.isError).toBe(false);
    expect(JSON.stringify(answer.content)).toContain(`Set ${leaderName}, ${memberName} to claude, model opus, reasoning low, as version 2 of the team`);
    expect(listTeamVersions(handle.db, teamId).at(-1)?.author).toEqual({ kind: "client" });
    expect(getAgent(handle.db, leaderId)).toMatchObject({ provider: "claude", model: "opus", config: { effort: "low" } });
  });

  it("on eo_admin, files the version as the system agent whose turn the credential was minted for — never as a client, whatever it sends", async () => {
    const system = agentOfKind(handle.db, "system");
    const answer = await answerToolCall({ name: "team_member_settings_set", arguments: { teamId, members: [memberName], provider: "codex", model: "gpt-5", reasoning: "high", throughClient: true, actingAgentId: "someone" } }, "admin", true, undefined, undefined, system);
    expect(answer.isError).toBe(false);
    expect(listTeamVersions(handle.db, teamId).at(-1)?.author).toEqual({ kind: "system", agentId: system });
  });

  it("from outside, can never claim to be a system agent", async () => {
    await answerToolCall({ name: "team_member_settings_set", arguments: { teamId, members: [memberName], provider: "codex", model: "gpt-5", reasoning: "high", actingAgentId: agentOfKind(handle.db, "system") } }, "external", false);
    expect(listTeamVersions(handle.db, teamId).at(-1)?.author).toEqual({ kind: "client" });
  });

  it("passes on what this machine says of the runtime, having saved", async () => {
    readiness = async () => runtime({ id: "claude", label: "Claude Code", signedIn: "signed_out" });
    const outcome = await tool("team_member_settings_set").run(dispatch, { teamId, members: [memberName], provider: "claude", model: "opus", reasoning: "low" }, { audience: "external" });
    expect(outcome).toMatchObject({ ok: true, refused: false });
    if (outcome.ok) expect(outcome.text).toContain(`as version 2 of the team, which a person can restore. Each runs on it from its next turn. This machine is not signed in to Claude Code, so this member cannot run here`);
  });

  it("answers a refusal as a refusal, with nothing changed", async () => {
    setTeamLocked(handle.db, teamId, true);
    const outcome = await tool("team_member_settings_set").run(dispatch, { teamId, members: [memberName], provider: "claude", model: "opus", reasoning: "low" }, { audience: "external" });
    expect(outcome).toMatchObject({ ok: true, refused: true });
    if (outcome.ok) expect(outcome.text).toBe('Nothing was changed: The team "Reviewers" is locked: a person must unlock it before it can change.');
    expect(listTeamVersions(handle.db, teamId)).toHaveLength(1);
  });

  it("is served on both listeners and needs no switch turned on", () => {
    const spec = tool("team_member_settings_set");
    expect(spec).toMatchObject({ kind: "write", annotations: { destructiveHint: false } });
    expect(spec.adminOnly ?? false).toBe(false);
    expect(spec.externalOnly ?? false).toBe(false);
    expect(spec.personOnly ?? false).toBe(false);
    // Not a way to anything but a team's own agents.
    expect(listAgents(handle.db).filter((agent) => agent.teamId === teamId).map((agent) => agent.id).sort()).toEqual([leaderId, memberId].sort());
  });
});
