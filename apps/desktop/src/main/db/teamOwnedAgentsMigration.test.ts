import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { uuidv7, type StepTeam } from "@eo/core";
import { openDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";
import { getAgent, listAgents } from "./repos/agentsRepo.js";
import { createPipeline, listStepsForPipeline } from "./repos/pipelineStepsRepo.js";
import { createProject } from "./repos/projectsRepo.js";
import { agentToolSurfaces, getTeam, listTeamVersions } from "./repos/teamsRepo.js";

/**
 * Migration 0187 (EO-897): a team's members are the team's own agents.
 *
 * Every agent a declared team names — leader and members — is copied as an
 * agent the team owns, with the same instructions, runtime, model,
 * reasoning and tool surface; the team names its copies in a new version
 * by EO; the ordinary agents, and the steps naming them, are left exactly
 * as they were.
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
  const dir = mkdtempSync(join(tmpdir(), "eo-team-owned-"));
  tempDirs.push(dir);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith(prefix)));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
  return dir;
}

/** An agent row as a launch before 0187 wrote it. */
function agent(handle: DbHandle, input: { name: string; role: string; provider: string; model: string | null; config?: Record<string, unknown>; projectId?: string | null }): string {
  const id = uuidv7();
  handle.db.run(sql`
    INSERT INTO agents (id, name, role, provider, model, instructions, prompt_hash, config, enabled, project_id, updated_at, revision)
    VALUES (${id}, ${input.name}, ${input.role}, ${input.provider}, ${input.model}, ${`Be ${input.name}.`}, 'shipped-hash', ${JSON.stringify(input.config ?? {})}, 1, ${input.projectId ?? null}, 1, 3)
  `);
  return id;
}

/** Gives an agent an MCP server, a skill and a CLI tool. */
function tools(handle: DbHandle, agentId: string, given: { server: string; skill: string; cli: string }): void {
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

/** An agent step as a launch before 0185 wrote it, its team inline and staffed by role, or none. */
function oldStep(handle: DbHandle, input: { id: string; pipelineId: string; name: string; agentId: string; entryAction: string; team: StepTeam | null; position: number }): void {
  handle.db.run(sql`
    INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, agent_id, entry_action, is_terminal, team)
    VALUES (${input.id}, ${input.pipelineId}, ${input.position}, ${input.name}, 'agent', ${input.agentId}, ${input.entryAction}, 0, ${input.team === null ? null : JSON.stringify(input.team)})
  `);
}

const LEADER_TEAM: StepTeam = {
  coordination: "leader",
  members: "report_only",
  leader: { role: "lead", instructions: "Split the review into passes." },
  roles: ["tests"],
  outcomes: [],
  limits: { maxParticipants: 4, maxParallel: 2, maxRounds: 2, maxRetries: 1 },
};

const INDEPENDENT_TEAM: StepTeam = {
  coordination: "independent",
  members: "report_only",
  participants: [{ key: "tests", role: "tests", instructions: "Check the tests.", required: true }],
  outcomes: [{ key: "clear", label: "Clear", meaning: "" }],
  completion: { rules: [], fallback: "approved" },
  limits: { maxParticipants: 4, maxParallel: 1, maxRetries: 1 },
};

describe("migration 0187: a team's members are the team's own agents (EO-897)", () => {
  it("copies every agent a team names as the team's own, the team names the copies in a version by EO, and the ordinary agents and their steps are left as they were", () => {
    const handle = openDb(":memory:");
    handles.push(handle);
    runMigrations(handle.db, migrationsBefore("0185_"));
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const lead = agent(handle, { name: "Lead", role: "lead", provider: "codex", model: "gpt-5", config: { reasoningEffort: "high" } });
    const tess = agent(handle, { name: "Tess", role: "tests", provider: "claude", model: "claude-opus-5", config: { effort: "low", maxTurns: 5 } });
    tools(handle, tess, { server: "repo", skill: "write-tests", cli: "gh" });
    const pipeline = createPipeline(handle.db, { projectId: project.id, name: "Delivery" });
    // Two teams naming Tess, and Tess and Lead running ordinary steps of their own.
    oldStep(handle, { id: "t-review", pipelineId: pipeline.id, name: "Review", agentId: lead, entryAction: "review", team: LEADER_TEAM, position: 0 });
    oldStep(handle, { id: "t-check", pipelineId: pipeline.id, name: "Check", agentId: tess, entryAction: "check", team: INDEPENDENT_TEAM, position: 1 });
    oldStep(handle, { id: "s-tests", pipelineId: pipeline.id, name: "Write tests", agentId: tess, entryAction: "test", team: null, position: 2 });
    oldStep(handle, { id: "s-lead", pipelineId: pipeline.id, name: "Lead", agentId: lead, entryAction: "review", team: null, position: 3 });
    runMigrations(handle.db, migrationsBefore("0187_"));

    const ordinaryBefore = handle.db.all(sql`SELECT * FROM agents WHERE id IN (${lead}, ${tess}) ORDER BY id`);
    const stepsBefore = handle.db.all(sql`SELECT id, agent_id, team_id FROM pipeline_steps WHERE pipeline_id = ${pipeline.id} ORDER BY id`);
    const reviewId = (stepsBefore as { id: string; team_id: string | null }[]).find((step) => step.id === "t-review")!.team_id!;
    const checkId = (stepsBefore as { id: string; team_id: string | null }[]).find((step) => step.id === "t-check")!.team_id!;
    expect(getTeam(handle.db, reviewId)?.version).toBe(1);

    runMigrations(handle.db, MIGRATIONS);

    // The ordinary agents, their tools and every step are as they were.
    expect(handle.db.all(sql`SELECT id, name, role, provider, model, instructions, prompt_hash, config, enabled, archived_at, deleted_at, project_id, updated_at, revision, record_stamp FROM agents WHERE id IN (${lead}, ${tess}) ORDER BY id`)).toEqual(ordinaryBefore);
    expect([getAgent(handle.db, lead)?.teamId, getAgent(handle.db, tess)?.teamId]).toEqual([null, null]);
    expect(agentToolSurfaces(handle.db, [tess])[tess]).toEqual({ cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] });
    expect(handle.db.all(sql`SELECT id, agent_id, team_id FROM pipeline_steps WHERE pipeline_id = ${pipeline.id} ORDER BY id`)).toEqual(stepsBefore);

    // Each team names copies of its own.
    const review = getTeam(handle.db, reviewId)!;
    const check = getTeam(handle.db, checkId)!;
    if (review.definition?.coordination !== "leader" || check.definition?.coordination !== "independent") throw new Error("A team did not read back.");
    const reviewLead = review.definition.leader.agentId;
    const reviewTess = review.definition.members[0]!.agentId;
    const checkTess = check.definition.members[0]!.agentId;
    expect(new Set([reviewLead, reviewTess, checkTess, lead, tess]).size).toBe(5);
    expect(review.version).toBe(2);
    expect(getAgent(handle.db, reviewLead as never)).toMatchObject({ name: "Lead", role: "lead", provider: "codex", model: "gpt-5", instructions: "Be Lead.", config: { reasoningEffort: "high" }, teamId: reviewId, projectId: project.id, promptHash: null, enabled: true });
    for (const [copy, teamId] of [
      [reviewTess, reviewId],
      [checkTess, checkId],
    ] as const) {
      expect(getAgent(handle.db, copy as never)).toMatchObject({ name: "Tess", role: "tests", provider: "claude", model: "claude-opus-5", instructions: "Be Tess.", config: { effort: "low", maxTurns: 5 }, teamId, projectId: project.id, promptHash: null });
      expect(agentToolSurfaces(handle.db, [copy])[copy]).toEqual({ cliTools: ["gh"], mcpServers: ["repo"], skills: ["write-tests"] });
    }
    // The rest of the team is as it was.
    expect({ ...review.definition, leader: { ...review.definition.leader, agentId: lead }, members: [{ agentId: tess }] }).toEqual(listTeamVersions(handle.db, reviewId)[0]?.definition);

    // One version per team, by EO, recording each copy's runtime, model and reasoning.
    const versions = listTeamVersions(handle.db, reviewId);
    expect(versions.map(({ number, author }) => ({ number, author }))).toEqual([
      { number: 1, author: { kind: "eo" } },
      { number: 2, author: { kind: "eo" } },
    ]);
    expect(versions[1]?.definition).toEqual(review.definition);
    expect(versions[1]?.memberSettings).toEqual({
      [reviewLead]: { provider: "codex", model: "gpt-5", reasoning: "high" },
      [reviewTess]: { provider: "claude", model: "claude-opus-5", reasoning: "low" },
    });
    expect(listTeamVersions(handle.db, checkId).map((one) => one.number)).toEqual([1, 2]);

    // Nothing else is copied, and no key is left dangling.
    expect(listAgents(handle.db).filter((one) => one.teamId !== null)).toHaveLength(3);
    expect(listStepsForPipeline(handle.db, pipeline.id).find((step) => step.id === "s-tests")?.agentId).toBe(tess);
    expect(handle.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});
