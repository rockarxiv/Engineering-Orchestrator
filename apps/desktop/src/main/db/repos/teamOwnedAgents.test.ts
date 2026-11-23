import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staffingAgents, TeamDefinitionSchema, uuidv7, type TeamDefinition, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { agentOfKind, createTestItem, giveSeededDelivery, openMigratedTestDb } from "../testHelpers.js";
import { agentForKind, agentNamed, kindCandidates } from "../../stepAgents.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agentsRepo.js";
import { listAgentViews } from "../../ipc/domainQueries.js";
import { listAgentDetails } from "../../ipc/configCommands.js";
import { createRun, getRun } from "./runsRepo.js";
import { createPipeline, createStep } from "./pipelineStepsRepo.js";
import { createProject, deleteProject } from "./projectsRepo.js";
import { agentToolSurfaces, archiveTeamMembers, changeTeam, createTeam, deleteTeamMembers, getTeam, listTeamVersions, restoreTeamVersion, teamOwnedAgents } from "./teamsRepo.js";
import { teams } from "../schema.js";
import { eq } from "drizzle-orm";

/**
 * A team's members are the team's own agents (EO-897): every write of a
 * team names only agents it owns, an ordinary agent it is given becoming
 * a copy the team owns, and a team's own agent is offered nowhere an
 * ordinary agent is.
 */
let handle: DbHandle;
let projectId: Uuid;
let lead: Uuid;
let member: Uuid;
let definition: TeamDefinition;

beforeEach(() => {
  handle = openMigratedTestDb();
  projectId = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id as Uuid;
  lead = createAgent(handle.db, { name: "Lead", role: "reviewer", provider: "codex", model: "gpt-5", instructions: "Lead the review.", config: { reasoningEffort: "high" } }).id;
  member = createAgent(handle.db, { name: "Tess", role: "implementer", provider: "claude", model: "claude-opus-5", instructions: "Write the missing tests.", config: { effort: "low", maxTurns: 5 } }).id;
  tools(member, { server: "repo", skill: "write-tests", cli: "gh" });
  definition = TeamDefinitionSchema.parse({
    name: "Review leads",
    coordination: "leader",
    leader: { agentId: lead, instructions: "Split the review by risk." },
    members: [{ agentId: member }],
    toolPool: { cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] },
    modelRange: { runtimes: ["claude", "codex"], models: ["claude-opus-5", "gpt-5"], reasoning: ["low", "high"] },
  });
});

afterEach(() => handle.close());

/** Gives an agent an MCP server, a skill and a CLI tool, by name, slug and command. */
function tools(agentId: string, given: { server: string; skill: string; cli: string }): void {
  const now = Date.now();
  const server = uuidv7();
  handle.db.run(sql`INSERT INTO mcp_servers (id, name, transport, command, created_at, updated_at) VALUES (${server}, ${given.server}, 'stdio', 'run', ${now}, ${now})`);
  handle.db.run(sql`INSERT INTO agent_mcp_servers (agent_id, server_id, created_at) VALUES (${agentId}, ${server}, ${now})`);
  const skill = uuidv7();
  handle.db.run(sql`INSERT INTO skills (id, slug, name, description, body, created_at, updated_at) VALUES (${skill}, ${given.skill}, ${given.skill}, 'A skill.', 'Do it.', ${now}, ${now})`);
  handle.db.run(sql`INSERT INTO agent_skills (agent_id, skill_id, created_at) VALUES (${agentId}, ${skill}, ${now})`);
  const cli = uuidv7();
  handle.db.run(sql`INSERT INTO cli_tools (id, name, command, created_at, updated_at) VALUES (${cli}, ${given.cli}, ${given.cli}, ${now}, ${now})`);
  handle.db.run(sql`INSERT INTO agent_cli_tools (agent_id, cli_tool_id, created_at) VALUES (${agentId}, ${cli}, ${now})`);
}

function declared(): { id: string; lead: Uuid; member: Uuid } {
  const made = createTeam(handle.db, { projectId, definition, author: { kind: "assistant" } });
  if (!made.ok) throw new Error(made.reason);
  const stored = made.team.definition;
  if (stored === null || stored.coordination !== "leader") throw new Error("The team did not read back.");
  return { id: made.team.id, lead: stored.leader.agentId as Uuid, member: stored.members[0]!.agentId as Uuid };
}

describe("a team's members are its own agents (EO-897)", () => {
  it("makes an ordinary agent a team is given into a copy the team owns, with the same instructions, runtime, model, reasoning and tools, and leaves the ordinary agent as it was", () => {
    const before = [getAgent(handle.db, lead), getAgent(handle.db, member)];
    const team = declared();

    expect([team.lead, team.member]).not.toContain(lead);
    expect([team.lead, team.member]).not.toContain(member);
    expect(getAgent(handle.db, team.member)).toMatchObject({
      name: "Tess",
      role: "implementer",
      provider: "claude",
      model: "claude-opus-5",
      instructions: "Write the missing tests.",
      config: { effort: "low", maxTurns: 5 },
      projectId,
      teamId: team.id,
      promptHash: null,
    });
    expect(getAgent(handle.db, team.lead)).toMatchObject({ name: "Lead", provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" }, teamId: team.id });
    expect(agentToolSurfaces(handle.db, [team.member])[team.member]).toEqual({ cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] });
    expect([getAgent(handle.db, lead), getAgent(handle.db, member)]).toEqual(before);
    expect(teamOwnedAgents(handle.db, team.id).map((agent) => agent.id).sort()).toEqual([team.lead, team.member].sort());
    // Its first version names its own agents, recording each one's settings.
    expect(listTeamVersions(handle.db, team.id)[0]?.memberSettings).toEqual({
      [team.lead]: { provider: "codex", model: "gpt-5", reasoning: "high" },
      [team.member]: { provider: "claude", model: "claude-opus-5", reasoning: "low" },
    });
  });

  it("cannot make an ordinary agent a member: adding one makes a new agent the team owns, and naming it again names that one", () => {
    const team = declared();
    const extra = createAgent(handle.db, { name: "Sec", role: "implementer", provider: "codex", model: "gpt-5", instructions: "Look for holes." });
    const stored = getTeam(handle.db, team.id)!.definition!;
    const withExtra = { ...stored, members: [...stored.members, { agentId: extra.id }] } as TeamDefinition;

    const written = changeTeam(handle.db, team.id, { definition: withExtra, author: { kind: "assistant" } });
    if (!written.ok) throw new Error(written.reason);
    const added = written.team.definition!.members.at(-1)!.agentId as Uuid;
    expect(added).not.toBe(extra.id);
    expect(getAgent(handle.db, added)).toMatchObject({ name: "Sec", teamId: team.id });
    expect(getAgent(handle.db, extra.id)?.teamId).toBeNull();

    // The same draft again — naming the ordinary agents — is no change, and makes nothing.
    const count = listAgents(handle.db).length;
    expect(changeTeam(handle.db, team.id, { definition: withExtra, author: { kind: "assistant" } })).toMatchObject({ ok: true, changed: false });
    expect(listAgents(handle.db)).toHaveLength(count);
  });

  it("restores a version that named ordinary agents as the team's own, putting what it recorded on the team's agents and never on the ordinary ones", () => {
    const team = declared();
    // A version written as 0185 wrote them, naming the ordinary agents, with their settings.
    const stored = getTeam(handle.db, team.id)!;
    handle.db.run(sql`INSERT INTO team_versions (id, team_id, number, definition, author_kind, created_at, member_settings) VALUES (
      ${uuidv7()}, ${team.id}, 2, ${JSON.stringify(definition)}, 'eo', ${Date.now()},
      ${JSON.stringify({ [lead]: { provider: "claude", model: "claude-sonnet", reasoning: "medium" }, [member]: { provider: "codex", model: "gpt-5", reasoning: "high" } })})`);
    handle.db.update(teams).set({ version: 2 }).where(eq(teams.id, stored.id)).run();
    const ordinary = [getAgent(handle.db, lead), getAgent(handle.db, member)];

    const restored = restoreTeamVersion(handle.db, team.id, 2, { personId: null });
    if (!restored.ok) throw new Error(restored.reason);
    const now = restored.team.definition;
    expect(now?.coordination === "leader" ? [now.leader.agentId, now.members[0]?.agentId] : []).toEqual([team.lead, team.member]);
    expect(getAgent(handle.db, team.lead)).toMatchObject({ provider: "claude", model: "claude-sonnet", config: { effort: "medium" } });
    expect(getAgent(handle.db, team.member)).toMatchObject({ provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
    expect([getAgent(handle.db, lead), getAgent(handle.db, member)]).toEqual(ordinary);
  });

  it("is offered nowhere an ordinary agent is: not on the Agents screen, not bound to a kind, not by a step's name, and refused by the Agents commands", async () => {
    const team = declared();
    const all = listAgents(handle.db);
    const owned = (ids: readonly string[]) => ids.filter((id) => id === team.lead || id === team.member);

    expect(owned(listAgentDetails(handle.db).agents.map((agent) => agent.id))).toEqual([]);
    // Still on the listing that names who ran something, saying whose it is.
    expect(listAgentViews(handle.db).agents.find((agent) => agent.id === team.member)?.teamId).toBe(team.id);
    expect(owned(staffingAgents(all, "implementer", { previewAt: null, projectId }).map((agent) => agent.id))).toEqual([]);
    expect(owned(kindCandidates(all, "implementer", projectId).map((agent) => agent.id))).toEqual([]);
    // With only the team's own agents of a kind left, nothing is bound.
    const onlyOwned = all.filter((agent) => agent.role !== "implementer" || agent.teamId === team.id);
    expect(agentForKind(onlyOwned, "implementer", projectId)).toBeUndefined();
    // A name an ordinary agent has names it; a name only the team's has names that, for the validator to refuse.
    expect(agentNamed(all, "Tess", projectId)).toBe(member);
    updateAgent(handle.db, member, { name: "Tessa" });
    expect(agentNamed(listAgents(handle.db), "Tess", projectId)).toBe(team.member);

    const { saveAgent, setAgentBinding, archiveAgentCommand, deleteAgentCommand } = await import("../../ipc/configCommands.js");
    const before = getAgent(handle.db, team.member);
    expect(setAgentBinding(handle.db, { agentId: team.member, provider: "codex", model: null })).toMatchObject({ bound: false, problem: expect.stringContaining("team's own agent") });
    expect(saveAgent(handle.db, { id: team.member, name: "Tess", role: "implementer", provider: "claude", model: null, instructions: "Something else.", enabled: true })).toMatchObject({ saved: false, problem: expect.stringContaining("team's own agent") });
    expect(archiveAgentCommand(handle.db, { id: team.member, confirm: true })).toMatchObject({ archived: false, problem: expect.stringContaining("team's own agent") });
    expect(deleteAgentCommand(handle.db, { id: team.member, confirm: true })).toMatchObject({ deleted: false, problem: expect.stringContaining("team's own agent") });
    expect(getAgent(handle.db, team.member)).toEqual(before);
  });
});

describe("a team's own agents go with it (EO-897)", () => {
  it("archives every agent the team owns, keeping each row and its name", () => {
    const team = declared();
    archiveTeamMembers(handle.db, team.id, 1234);
    for (const id of [team.lead, team.member]) expect(getAgent(handle.db, id)).toMatchObject({ archivedAt: 1234, deletedAt: null, teamId: team.id });
    expect(getAgent(handle.db, lead)?.archivedAt).toBeNull();
    expect(getAgent(handle.db, member)?.archivedAt).toBeNull();
  });

  it("deletes every agent the team owns as tombstones, which the runs, reports and comments naming them still name", () => {
    const team = declared();
    giveSeededDelivery(handle.db, projectId);
    const item = createTestItem(handle.db, { type: "story", title: "Checkout", projectId, stepId: "todo" });
    const run = createRun(handle.db, { itemId: item.id, agentId: team.member, action: "review", stepId: null });

    deleteTeamMembers(handle.db, team.id, 99);

    for (const id of [team.lead, team.member]) expect(getAgent(handle.db, id)).toMatchObject({ teamId: team.id, enabled: false, instructions: "", deletedAt: 99 });
    expect(getRun(handle.db, run.id)?.agentId).toBe(team.member);
    expect(getAgent(handle.db, team.member)).toMatchObject({ name: "Tess", role: "implementer" });
    expect(getAgent(handle.db, member)).toMatchObject({ deletedAt: null, instructions: "Write the missing tests." });
  });

  it("deletes them when the team goes with its project, its steps let go of first, and leaves the ordinary agents alone", () => {
    const team = declared();
    const pipeline = createPipeline(handle.db, { projectId, name: "Delivery" });
    createStep(handle.db, { id: "team-review", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "review", teamId: team.id });

    deleteProject(handle.db, projectId);

    expect(getTeam(handle.db, team.id)).toBeUndefined();
    for (const id of [team.lead, team.member]) {
      const agent = getAgent(handle.db, id);
      expect(agent).toMatchObject({ teamId: team.id, enabled: false });
      expect(agent?.deletedAt).not.toBeNull();
    }
    expect(getAgent(handle.db, member)).toMatchObject({ deletedAt: null, archivedAt: null, instructions: "Write the missing tests." });
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
