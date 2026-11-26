import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchBlocker } from "@eo/engine";
import { LOCAL_PERSON_ID, PREVIEW_AGENT_KEY, uuidv7, type Agent, type Uuid } from "@eo/core";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { openDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";
import { createAgent, listAgents } from "./repos/agentsRepo.js";
import { listCommentsForItem } from "./repos/commentsRepo.js";
import { listOpenMessages } from "./repos/messagesRepo.js";
import { createPipeline, getStep, listStepsForPipeline } from "./repos/pipelineStepsRepo.js";
import { versionGraph } from "./repos/pipelineVersionsRepo.js";
import { createProject } from "./repos/projectsRepo.js";
import { appendRunEvent, createRun, transitionItem } from "./repos/index.js";
import { createTestItem } from "./testHelpers.js";

/**
 * Migration 0181 (EO-875): a step names its agent.
 *
 * Every `agent` step is given the agent today's staffing would have
 * dispatched for a real item on its pipeline's project — the project's
 * own dispatchable agent of the step's role if it has one, else a global
 * one, the first in staffing order — so nothing changes in what runs. A
 * step that had several candidates is said to the person in a message;
 * one with none names nobody, and an item that reaches it is told so.
 * `owner_role` goes.
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

/** A database as it stood on the launch before 0181. */
function beforeTheMigration(): DbHandle {
  const handle = openDb(":memory:");
  handles.push(handle);
  const dir = mkdtempSync(join(tmpdir(), "eo-step-agent-"));
  tempDirs.push(dir);
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith("0181_")));
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const entry of kept) writeFileSync(join(dir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
  runMigrations(handle.db, dir);
  return handle;
}

/** An agent step as a launch before 0181 wrote it: naming a role. */
function oldStep(handle: DbHandle, input: { id: string; pipelineId: string; name: string; role: string; position?: number }): void {
  handle.db.run(sql`
    INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, is_terminal)
    VALUES (${input.id}, ${input.pipelineId}, ${input.position ?? 0}, ${input.name}, 'agent', ${input.role}, 'implement', 0)
  `);
}

function agent(handle: DbHandle, name: string, role: string, extra: { projectId?: Uuid | null; enabled?: boolean; preview?: boolean } = {}): Agent {
  return createAgent(handle.db, {
    name,
    role,
    provider: "fake",
    instructions: `Be ${name}.`,
    enabled: extra.enabled ?? true,
    projectId: extra.projectId ?? null,
    config: extra.preview === true ? { [PREVIEW_AGENT_KEY]: true } : {},
  });
}

/**
 * A step is read back through today's code once the migration has run;
 * before it, `pipeline_steps` has no `agent_id`, so the repository calls
 * that read steps run with the column added for the moment and taken off
 * again (the way migrate.test.ts reaches older schemas).
 */
function withTodaysStepColumn<T>(handle: DbHandle, act: () => T): T {
  handle.db.run(sql`ALTER TABLE pipeline_steps ADD agent_id text`);
  // And the one 0184 adds to runs (EO-912), which today's `createRun` writes.
  handle.db.run(sql`ALTER TABLE runs ADD dispatched_in text`);
  try {
    return act();
  } finally {
    handle.db.run(sql`ALTER TABLE pipeline_steps DROP COLUMN agent_id`);
    handle.db.run(sql`ALTER TABLE runs DROP COLUMN dispatched_in`);
  }
}

function migrate(handle: DbHandle): void {
  runMigrations(handle.db, MIGRATIONS);
}

describe("migration 0181: a step names its agent (EO-875)", () => {
  it("gives a step with one candidate that candidate, and says nothing", () => {
    const handle = beforeTheMigration();
    const reviewer = listAgents(handle.db).find((candidate) => candidate.role === "reviewer")!;

    migrate(handle);

    // The seeded Delivery pipeline is on no project, and its review step
    // had exactly one reviewer to go to.
    expect(getStep(handle.db, "review")?.agentId).toBe(reviewer.id);
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === "step_agent_chosen")).toEqual([]);
    expect(handle.db.all(sql`SELECT name FROM pragma_table_info('pipeline_steps') WHERE name = 'owner_role'`)).toEqual([]);
  });

  it("chooses a project's own agent over a global one, on that project's pipeline only", () => {
    const handle = beforeTheMigration();
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" }).id;
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" }).id;
    const global = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
    const shopsOwn = agent(handle, "Shop implementer", "implementer", { projectId: shop });
    const shopBoard = createPipeline(handle.db, { name: "Shop board", projectId: shop, position: 1 });
    const supportBoard = createPipeline(handle.db, { name: "Support board", projectId: support, position: 2 });
    oldStep(handle, { id: "shop-build", pipelineId: shopBoard.id, name: "Build", role: "implementer" });
    oldStep(handle, { id: "support-build", pipelineId: supportBoard.id, name: "Build", role: "implementer" });

    migrate(handle);

    // Shop's own outranked the global one on Shop's pipeline — one
    // candidate there, so no message — and never reaches Support's.
    expect(getStep(handle.db, "shop-build")?.agentId).toBe(shopsOwn.id);
    expect(getStep(handle.db, "support-build")?.agentId).toBe(global.id);
    // The seeded pipeline is on no project: a project's own agent is never a candidate there.
    expect(getStep(handle.db, "todo")?.agentId).toBe(global.id);
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === "step_agent_chosen")).toEqual([]);
  });

  it("chooses the first of several candidates in staffing order, and tells the person which", () => {
    const handle = beforeTheMigration();
    // Neither of these is a candidate: one is switched off, one is a preview's own.
    agent(handle, "Retired writer", "writer", { enabled: false });
    agent(handle, "Writer (preview)", "writer", { preview: true });
    const first = agent(handle, "Writer on Claude", "writer");
    agent(handle, "Writer on Codex", "writer");
    const docs = createPipeline(handle.db, { name: "Docs", position: 1 });
    oldStep(handle, { id: "docs-draft", pipelineId: docs.id, name: "Draft", role: "writer" });

    migrate(handle);

    expect(getStep(handle.db, "docs-draft")?.agentId).toBe(first.id);
    const said = listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === "step_agent_chosen");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ recipientId: LOCAL_PERSON_ID, projectId: null, handledAt: null });
    // About the step, so it can be resolved once the step names somebody else.
    expect(handle.db.all(sql`SELECT subject FROM messages WHERE source = 'step_agent_chosen'`)).toEqual([{ subject: "docs-draft" }]);
    // Names the pipeline, the step and the agent chosen.
    expect(said[0]!.body).toContain('"Draft" on the "Docs" pipeline now runs **Writer on Claude**');
    expect(said[0]!.body).toContain('2 enabled "writer" agents could have run its work');
    expect(said[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves a step with no candidate naming nobody, and an item that reaches it is told nobody can run it", async () => {
    const handle = beforeTheMigration();
    agent(handle, "Auditor", "auditor", { enabled: false });
    const audits = createPipeline(handle.db, { name: "Audits", position: 1 });
    oldStep(handle, { id: "audit", pipelineId: audits.id, name: "Audit", role: "auditor" });
    handle.db.run(sql`
      INSERT INTO pipeline_steps (id, pipeline_id, position, name, type, owner_role, entry_action, is_terminal)
      VALUES ('audited', ${audits.id}, 1, 'Audited', 'user', NULL, NULL, 1)
    `);
    handle.db.run(sql`UPDATE pipelines SET entry_step_id = 'audit' WHERE id = ${audits.id}`);

    migrate(handle);

    expect(getStep(handle.db, "audit")?.agentId).toBeNull();
    expect(listOpenMessages(handle.db, [LOCAL_PERSON_ID]).filter((message) => message.source === "step_agent_chosen")).toEqual([]);

    // The blocker every door reads, and the comment the item gets.
    const item = createTestItem(handle.db, { type: "story", title: "Audit the books", stepId: "audit" });
    expect(dispatchBlocker(buildEligibilityInput(handle.db, false), item.id)).toEqual({ kind: "no_agent" });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 },
    });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
    // (The installation's first tick also notes the daily budget it applied, which is not this.)
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.body.startsWith("Nothing will run")).map((comment) => comment.body)).toEqual([
      'Nothing will run "Audit" for this ticket: this step names no agent, so nobody can run it. Choose an agent for the step. It is not handed to another agent of the same kind.',
    ]);
  });

  it("binds every saved version's agent steps the same way, so an item finishing on an old version keeps its agent", () => {
    const handle = beforeTheMigration();
    const first = agent(handle, "Writer on Claude", "writer");
    agent(handle, "Writer on Codex", "writer");
    const docs = createPipeline(handle.db, { name: "Docs", position: 1 });
    oldStep(handle, { id: "docs-draft", pipelineId: docs.id, name: "Draft", role: "writer" });
    const versionId = uuidv7();
    const steps = [
      { id: "docs-draft", pipelineId: docs.id, position: 0, name: "Draft", type: "agent", ownerRole: "writer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false, results: [] },
      { id: "docs-done", pipelineId: docs.id, position: 1, name: "Done", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false, results: [] },
    ];
    handle.db.run(sql`
      INSERT INTO pipeline_versions (id, pipeline_id, number, steps, routes, entry_step_id, entry_rules, created_at)
      VALUES (${versionId}, ${docs.id}, 1, ${JSON.stringify(steps)}, '[]', 'docs-draft', '[]', 1)
    `);

    migrate(handle);

    const graph = versionGraph(handle.db, versionId);
    expect(graph?.steps.map((step) => [step.id, step.agentId])).toEqual([
      ["docs-draft", first.id],
      ["docs-done", null],
    ]);
  });

  it("rewrites no run, run event or transition written before it", () => {
    const handle = beforeTheMigration();
    const implementer = listAgents(handle.db).find((candidate) => candidate.role === "implementer")!;
    withTodaysStepColumn(handle, () => {
      const item = createTestItem(handle.db, { type: "story", title: "Something built before", stepId: "todo" });
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      appendRunEvent(handle.db, run.id, "output", { text: "Built it." });
      appendRunEvent(handle.db, run.id, "result", { result: "done" });
      // The move that run's result made, as the engine writes it.
      transitionItem(handle.db, { itemId: item.id, toStepId: "review", toPipelineId: "default" as Uuid, actor: implementer.id, runId: run.id, reason: "result:done" });
    });
    const read = () => ({
      runs: handle.db.all(sql`SELECT * FROM runs ORDER BY id`),
      events: handle.db.all(sql`SELECT * FROM run_events ORDER BY run_id, seq`),
      transitions: handle.db.all(sql`SELECT * FROM transitions ORDER BY id`),
    });
    const before = read();

    migrate(handle);

    // The same rows, with the column a later migration (0184) adds to runs, empty.
    expect(read()).toEqual({ ...before, runs: before.runs.map((run) => ({ ...(run as object), dispatched_in: null })) });
    expect(before.events).toHaveLength(2);
    // Something to compare: the transition is there, whole, before and after.
    expect(before.transitions).toEqual([expect.objectContaining({ from_step_id: "todo", to_step_id: "review", actor: implementer.id, reason: "result:done" })]);
    // And the step those runs were made on runs the same agent they did.
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "todo")?.agentId).toBe(implementer.id);
  });
});
