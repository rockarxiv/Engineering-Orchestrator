import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { generatedTeamName, uuidv7, type Agent, type StepTeam, type Uuid } from "@eo/core";
import { openDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createAgent, updateAgent } from "./repos/agentsRepo.js";
import { createPipeline, listStepsForPipeline } from "./repos/pipelineStepsRepo.js";
import { versionGraph } from "./repos/pipelineVersionsRepo.js";
import { createProject } from "./repos/projectsRepo.js";
import { getTeam, listTeamVersions, listTeams, teamByName } from "./repos/teamsRepo.js";

/**
 * Migration 0185 (EO-881): a declared team is its own entity, and a step
 * names it.
 *
 * Every inline step team becomes a declared team named after its pipeline
 * and step, its roles bound to the agents EO-874 bound a step's role to,
 * its tool pool every tool its members have and its model range their
 * runtimes, models and reasoning; the step names it; and what runs on the
 * step does not change — it reads back as the very team it carried. A
 * saved version keeps the team it froze and is told which declared team
 * its step is.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

let handles: DbHandle[] = [];
let tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles) handle.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  handles = [];
  tempDirs = [];
});

/** The migrations before the one whose tag starts with `prefix`, in a directory of their own. */
function migrationsBefore(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), "eo-declared-team-"));
  tempDirs.push(dir);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith(prefix)));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
  return dir;
}

/** A database as it stood on the launch before 0185. */
function beforeTheMigration(): DbHandle {
  const handle = openDb(":memory:");
  handles.push(handle);
  runMigrations(handle.db, migrationsBefore("0185_"));
  return handle;
}

/**
 * The migrations up to 0187, as the next launch after 0185 ran them:
 * 0187 makes every team's agents its own (EO-897), and has a test of its
 * own (teamOwnedAgentsMigration.test.ts).
 */
function migrate(handle: DbHandle): void {
  runMigrations(handle.db, migrationsBefore("0187_"));
  // The column 0188 adds, which today's team reads select: no team is archived.
  handle.db.run(sql`ALTER TABLE teams ADD archived_at integer`);
  // And the one 0190 adds, which today's version reads select: no version says why EO made it.
  handle.db.run(sql`ALTER TABLE team_versions ADD note text`);
}

/**
 * Today's `createAgent` and `updateAgent` on a database from before
 * 0187, which write the column it adds: added for the call, then dropped.
 */
function withTeamColumn<T>(handle: DbHandle, write: () => T): T {
  handle.db.run(sql`ALTER TABLE agents ADD team_id text`);
  try {
    return write();
  } finally {
    handle.db.run(sql`ALTER TABLE agents DROP COLUMN team_id`);
  }
}

function agent(handle: DbHandle, name: string, role: string, extra: { projectId?: Uuid | null; provider?: string; model?: string | null; config?: Record<string, unknown> } = {}): Agent {
  return withTeamColumn(handle, () => {
    const made = createAgent(handle.db, { name, role, provider: extra.provider ?? "claude", instructions: `Be ${name}.`, projectId: extra.projectId ?? null, config: extra.config ?? {} });
    if (extra.model !== undefined) updateAgent(handle.db, made.id, { model: extra.model });
    return made;
  });
}

/** An agent step as a launch before 0185 wrote it: its team inline, staffed by role. */
function oldStep(handle: DbHandle, input: { id: string; pipelineId: string; name: string; agentId: string; entryAction: string; team: StepTeam; position?: number }): void {
  handle.db.run(sql`
    INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, agent_id, entry_action, is_terminal, team)
    VALUES (${input.id}, ${input.pipelineId}, ${input.position ?? 0}, ${input.name}, 'agent', ${input.agentId}, ${input.entryAction}, 0, ${JSON.stringify(input.team)})
  `);
}

/** Gives an agent an MCP server, a skill and a CLI tool, by name, slug and command. */
function tools(handle: DbHandle, agentId: string, given: { server?: string; skill?: string; cli?: string }): void {
  const now = Date.now();
  if (given.server !== undefined) {
    const id = uuidv7();
    handle.db.run(sql`INSERT INTO mcp_servers (id, name, transport, command, created_at, updated_at) VALUES (${id}, ${given.server}, 'stdio', 'run', ${now}, ${now})`);
    handle.db.run(sql`INSERT INTO agent_mcp_servers (agent_id, server_id, created_at) VALUES (${agentId}, ${id}, ${now})`);
  }
  if (given.skill !== undefined) {
    const id = uuidv7();
    handle.db.run(sql`INSERT INTO skills (id, slug, name, description, body, created_at, updated_at) VALUES (${id}, ${given.skill}, ${given.skill}, 'A skill.', 'Do it.', ${now}, ${now})`);
    handle.db.run(sql`INSERT INTO agent_skills (agent_id, skill_id, created_at) VALUES (${agentId}, ${id}, ${now})`);
  }
  if (given.cli !== undefined) {
    const id = uuidv7();
    handle.db.run(sql`INSERT INTO cli_tools (id, name, command, created_at, updated_at) VALUES (${id}, ${given.cli}, ${given.cli}, ${now}, ${now})`);
    handle.db.run(sql`INSERT INTO agent_cli_tools (agent_id, cli_tool_id, created_at) VALUES (${agentId}, ${id}, ${now})`);
  }
}

const LEADER_ISOLATED: StepTeam = {
  coordination: "leader",
  members: "isolated",
  leader: { role: "lead", instructions: "Split the review into passes, and answer from their reports." },
  roles: ["security", "tests"],
  outcomes: [{ key: "blocking", label: "Blocking", meaning: "Stops it.", rulesOut: ["approved"] }],
  limits: { maxParticipants: 4, maxParallel: 2, maxRounds: 3, maxRetries: 1, budgetCents: 500 },
};

const INDEPENDENT_REPORT_ONLY: StepTeam = {
  coordination: "independent",
  members: "report_only",
  participants: [
    { key: "security", role: "security", instructions: "Look for ways around authentication.", required: true },
    { key: "tests", role: "tests", instructions: "Check the tests cover the change.", required: false },
  ],
  outcomes: [
    { key: "clear", label: "Clear", meaning: "" },
    { key: "concerns", label: "Concerns", meaning: "Something should change first." },
  ],
  completion: { rules: [{ when: "any", outcomes: ["concerns"], result: "changes_requested" }], fallback: "approved" },
  limits: { maxParticipants: 4, maxParallel: 1, maxRetries: 1 },
};

describe("migration 0185: a declared team is its own entity, and a step names it (EO-881)", () => {
  it("declares a leader-led isolated team and an independent report-only one, each named after its pipeline and step, and points each step at its own", () => {
    const handle = beforeTheMigration();
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const lead = agent(handle, "Lead", "lead", { provider: "claude", model: "claude-opus", config: { effort: "high" } });
    const security = agent(handle, "Sec", "security", { provider: "codex", model: "gpt-5", config: { reasoningEffort: "medium" } });
    const tests = agent(handle, "Tess", "tests", { provider: "claude", model: null });
    // A project's own agent of a role is the one bound, over a global one (0181's rule).
    const ownTests = agent(handle, "Shop tests", "tests", { projectId: project.id as Uuid, provider: "claude", model: "claude-sonnet" });
    tools(handle, security.id, { server: "github", skill: "triage" });
    tools(handle, ownTests.id, { cli: "gh" });
    // The leader's own tools are not the members' pool.
    tools(handle, lead.id, { server: "slack" });

    const pipeline = createPipeline(handle.db, { projectId: project.id as Uuid, name: "Delivery" });
    oldStep(handle, { id: "t-review", pipelineId: pipeline.id, name: "Review", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    oldStep(handle, { id: "t-check", pipelineId: pipeline.id, name: "Check", agentId: lead.id, entryAction: "check", team: INDEPENDENT_REPORT_ONLY, position: 1 });
    oldStep(handle, { id: "t-plain", pipelineId: pipeline.id, name: "Plain", agentId: lead.id, entryAction: "check", team: INDEPENDENT_REPORT_ONLY, position: 2 });
    handle.db.run(sql`UPDATE pipeline_steps SET team = NULL WHERE id = 't-plain'`);

    migrate(handle);

    const steps = new Map(listStepsForPipeline(handle.db, pipeline.id).map((step) => [step.id, step]));
    // What runs does not change: each step reads back as the very team it carried.
    expect(steps.get("t-review")?.team).toEqual(LEADER_ISOLATED);
    expect(steps.get("t-check")?.team).toEqual(INDEPENDENT_REPORT_ONLY);
    expect(steps.get("t-plain")).toMatchObject({ team: null, teamId: null });

    const teams = listTeams(handle.db, project.id);
    expect(teams.map((team) => team.name).sort()).toEqual(["Delivery · Check", "Delivery · Review"]);
    const review = getTeam(handle.db, steps.get("t-review")!.teamId!)!;
    expect(review).toMatchObject({ projectId: project.id, name: "Delivery · Review", locked: false, version: 1 });
    expect(review.definition).toEqual({
      coordination: "leader",
      name: "Delivery · Review",
      memberMode: "isolated",
      leader: { agentId: lead.id, instructions: LEADER_ISOLATED.coordination === "leader" ? LEADER_ISOLATED.leader.instructions : "" },
      members: [{ agentId: security.id }, { agentId: ownTests.id }],
      outcomes: LEADER_ISOLATED.outcomes,
      limits: LEADER_ISOLATED.limits,
      toolPool: { cliTools: ["gh"], mcpServers: ["github"], skills: ["triage"] },
      modelRange: { runtimes: ["claude", "codex"], models: ["claude-sonnet", "gpt-5"], reasoning: ["medium"] },
      memberCap: 8,
    });

    const check = getTeam(handle.db, steps.get("t-check")!.teamId!)!;
    expect(check.definition).toEqual({
      coordination: "independent",
      name: "Delivery · Check",
      memberMode: "report_only",
      members: [
        { key: "security", agentId: security.id, instructions: "Look for ways around authentication.", required: true },
        { key: "tests", agentId: ownTests.id, instructions: "Check the tests cover the change.", required: false },
      ],
      outcomes: INDEPENDENT_REPORT_ONLY.outcomes,
      completion: INDEPENDENT_REPORT_ONLY.coordination === "independent" ? INDEPENDENT_REPORT_ONLY.completion : null,
      limits: INDEPENDENT_REPORT_ONLY.limits,
      toolPool: { cliTools: ["gh"], mcpServers: ["github"], skills: ["triage"] },
      modelRange: { runtimes: ["claude", "codex"], models: ["claude-sonnet", "gpt-5"], reasoning: ["medium"] },
      memberCap: 8,
    });
    // Its first version, made by EO.
    expect(listTeamVersions(handle.db, check.id).map((version) => ({ number: version.number, author: version.author, restoredFrom: version.restoredFrom }))).toEqual([
      { number: 1, author: { kind: "eo" }, restoredFrom: null },
    ]);
    // The global tests agent is not a member: the project's own one was bound.
    expect(JSON.stringify(review.definition)).not.toContain(tests.id);

    // The step's old column is gone.
    const columns = handle.db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('pipeline_steps')`).map((column) => column.name);
    expect(columns).toContain("team_id");
    expect(columns).not.toContain("team");
  });

  it("names, in each saved version, the declared team its step is now, and keeps the team the version froze", () => {
    const handle = beforeTheMigration();
    const lead = agent(handle, "Lead", "lead");
    agent(handle, "Sec", "security");
    agent(handle, "Tess", "tests");
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Reviews" });
    oldStep(handle, { id: "t-review", pipelineId: pipeline.id, name: "Review", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    const versionId = uuidv7();
    const frozen = { ...LEADER_ISOLATED, limits: { ...LEADER_ISOLATED.limits, maxRounds: 1 } };
    const step = { id: "t-review", pipelineId: pipeline.id, position: 0, name: "Review", type: "agent", agentId: lead.id, entryAction: "review", instructionsSummary: null, isTerminal: false, planMode: false, workspaceMode: "isolated", workspaceId: null, inputs: {}, timeoutMs: null, results: [], team: frozen };
    handle.db.run(sql`INSERT INTO pipeline_versions (id, pipeline_id, number, steps, routes, entry_step_id, created_at) VALUES (${versionId}, ${pipeline.id}, 1, ${JSON.stringify([step])}, '[]', 't-review', 1)`);

    migrate(handle);

    const teamId = listStepsForPipeline(handle.db, pipeline.id).find((one) => one.id === "t-review")!.teamId;
    expect(teamId).not.toBeNull();
    // A pipeline on no project declares a team on no project.
    expect(getTeam(handle.db, teamId!)?.projectId).toBeNull();
    const graph = versionGraph(handle.db, versionId)!;
    expect(graph.steps.find((one) => one.id === "t-review")).toMatchObject({ teamId, team: frozen });
  });

  it("keeps a long pipeline and step name's team runnable: its name is cut within the limit, and two cut alike are numbered apart", () => {
    const handle = beforeTheMigration();
    const lead = agent(handle, "Lead", "lead");
    agent(handle, "Sec", "security");
    agent(handle, "Tess", "tests");
    // A valid 100-character pipeline name and 30-character step names:
    // "<pipeline> · <step>" is 133 characters, past a team name's 120.
    const pipeline = createPipeline(handle.db, { projectId: null, name: "P".repeat(100) });
    oldStep(handle, { id: "t-one", pipelineId: pipeline.id, name: `Review ${"a".repeat(23)}`, agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    oldStep(handle, { id: "t-two", pipelineId: pipeline.id, name: `Review ${"b".repeat(23)}`, agentId: lead.id, entryAction: "check", team: INDEPENDENT_REPORT_ONLY, position: 1 });

    migrate(handle);

    const steps = new Map(listStepsForPipeline(handle.db, pipeline.id).map((step) => [step.id, step]));
    // Each still runs the team it carried, rather than reading as one agent.
    expect(steps.get("t-one")?.team).toEqual(LEADER_ISOLATED);
    expect(steps.get("t-two")?.team).toEqual(INDEPENDENT_REPORT_ONLY);
    const names = [getTeam(handle.db, steps.get("t-one")!.teamId!)!, getTeam(handle.db, steps.get("t-two")!.teamId!)!].map((team) => {
      expect(team.definition).not.toBeNull();
      return team.name;
    });
    const cut = `${"P".repeat(54)}…`;
    expect(names.sort()).toEqual([cut, `${cut} (2)`]);
    // The rule is packages/core's own, so a team EO declares later is named alike.
    expect(generatedTeamName(`${"P".repeat(100)} · Review ${"a".repeat(23)}`)).toBe(cut);
  });

  it("gives every migrated team a name no other team of its project has, as a draft reads names (trimmed, any case), so a draft naming one names exactly one", () => {
    const handle = beforeTheMigration();
    const lead = agent(handle, "Lead", "lead");
    agent(handle, "Sec", "security");
    agent(handle, "Tess", "tests");
    // Two pipelines called Delivery with a step X, one with a step literally
    // called "X (2)", and one whose name differs only in case.
    const first = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const second = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const shouting = createPipeline(handle.db, { projectId: null, name: "DELIVERY" });
    oldStep(handle, { id: "t-1", pipelineId: first.id, name: "X", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    oldStep(handle, { id: "t-2", pipelineId: second.id, name: "X", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    oldStep(handle, { id: "t-3", pipelineId: first.id, name: "X (2)", agentId: lead.id, entryAction: "check", team: INDEPENDENT_REPORT_ONLY, position: 1 });
    oldStep(handle, { id: "t-4", pipelineId: shouting.id, name: "x", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });

    migrate(handle);

    const stepIds = ["t-1", "t-2", "t-3", "t-4"];
    const steps = new Map([first, second, shouting].flatMap((pipeline) => listStepsForPipeline(handle.db, pipeline.id)).map((step) => [step.id, step]));
    const teams = stepIds.map((id) => getTeam(handle.db, steps.get(id)!.teamId!)!);
    // The step called "X (2)" keeps its own name, and nobody else is given it.
    expect(teams[2]!.name).toBe("Delivery · X (2)");
    expect(teams[0]!.name).toBe("Delivery · X");
    const folded = teams.map((team) => team.name.trim().toLowerCase());
    expect(new Set(folded).size).toBe(4);
    // Each name finds its own team, and so each step's team stays the one it ran.
    for (const team of teams) expect(teamByName(handle.db, null, team.name)?.id).toBe(team.id);
    expect(steps.get("t-1")?.team).toEqual(LEADER_ISOLATED);
    expect(steps.get("t-3")?.team).toEqual(INDEPENDENT_REPORT_ONLY);
  });

  it("rewrites no run, run event or transition, and leaves every foreign key whole", () => {
    const handle = beforeTheMigration();
    const lead = agent(handle, "Lead", "lead");
    agent(handle, "Sec", "security");
    agent(handle, "Tess", "tests");
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Reviews" });
    oldStep(handle, { id: "t-review", pipelineId: pipeline.id, name: "Review", agentId: lead.id, entryAction: "review", team: LEADER_ISOLATED });
    const before = {
      runs: handle.db.all(sql`SELECT * FROM runs ORDER BY rowid`),
      events: handle.db.all(sql`SELECT * FROM run_events ORDER BY rowid`),
      transitions: handle.db.all(sql`SELECT * FROM transitions ORDER BY rowid`),
    };
    migrate(handle);
    expect(handle.db.all(sql`SELECT * FROM runs ORDER BY rowid`)).toEqual(before.runs);
    expect(handle.db.all(sql`SELECT * FROM run_events ORDER BY rowid`)).toEqual(before.events);
    expect(handle.db.all(sql`SELECT * FROM transitions ORDER BY rowid`)).toEqual(before.transitions);
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
