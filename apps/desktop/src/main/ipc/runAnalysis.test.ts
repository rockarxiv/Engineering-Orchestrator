import { ipcContract, type Item, type RunFilters, type RunRecord, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, createRun, listAgents, projectForWorkspace, recordSideCall, updateAgent, updateRun, type UpdateRunInput } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listRuns, summariseRuns } from "./runAnalysis.js";

/**
 * Runs across items (EO-541): `runs:list` filters in its query and
 * returns every figure a timing or spend question needs, side calls
 * among them; `runs:summary` adds the same rows up.
 *
 * One fixture, laid out by hand so the summary's figures below can be
 * checked against arithmetic rather than against the code that made them.
 *
 * Day one, 10:00 local (T0), on APP-1:
 *   r1 implement  claude  thread t-1  10:00–10:10  1000/100  cache 800/50  120¢  5 turns (turn)  log: opus-4
 *   r2 review     codex               10:15–10:20   500/50                  30¢  verdict reject  log: gpt-5, then gpt-5-mini
 *   s1 side_call:memory_select claude 10:21 for 2s  300/20                  0.4¢
 *   r3 implement  claude  thread t-1  10:25–10:31  2000/200 cache 1500/0   80¢  attempt 2 (session)  log: opus-4
 *   r4 review     codex               10:35–10:38   400/40                  20¢  verdict approve  log: no model
 * Day two, 09:00 local (T1):
 *   r5 implement  claude  APP-2  failed   09:00–09:12  3000/300  200¢
 *   r6 implement  claude  OPS-1  running  10:00–       (nothing yet)
 *   s2 side_call:memory_consolidate codex, no item, APP's project, 11:00 for 4s  100/10  0.4¢
 * And a preview on APP, whose run and side call are left out of everything.
 *
 * Results are written as the supervisor writes them, `{ raw, parsed }`
 * (`PersistedRunResult`), and each run's model is in its own log as the
 * adapters record it — never read off the agent, which is configured
 * here with a model none of the runs ran on.
 */

/** A result as the supervisor persists it: what the agent said, and what the engine parsed out of it (A-02). */
function persisted(parsed: Record<string, unknown>): Record<string, unknown> {
  return { raw: { type: "result", text: JSON.stringify(parsed) }, parsed };
}

let handle: DbHandle;
let appItem: Item;
let appOther: Item;
let opsItem: Item;
let appProject: Uuid;
let opsProject: Uuid;
const ids: Record<string, string> = {};

const MINUTE = 60_000;
const T0 = new Date(2026, 9, 19, 10, 0).getTime();
const T1 = new Date(2026, 9, 20, 9, 0).getTime();

function run(name: string, item: Item, agentId: Uuid | null, action: string, provider: string | null, patch: UpdateRunInput, attempt = 1): void {
  const created = createRun(handle.db, { itemId: item.id as Uuid, agentId, action, provider, attempt });
  updateRun(handle.db, created.id, patch);
  ids[name] = created.id;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  const app = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" });
  const ops = attachWorkspace(handle.db, { name: "ops", keyPrefix: "OPS", repoPath: "/tmp/ops" });
  appProject = projectForWorkspace(handle.db, app.id)!.id as Uuid;
  opsProject = projectForWorkspace(handle.db, ops.id)!.id as Uuid;
  appItem = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo", projectId: appProject, workspaceId: app.id });
  appOther = createTestItem(handle.db, { type: "story", title: "Retry the export", stepId: "todo", projectId: appProject, workspaceId: app.id });
  opsItem = createTestItem(handle.db, { type: "story", title: "Rotate the keys", stepId: "todo", projectId: opsProject, workspaceId: ops.id });
  const preview = createTestItem(handle.db, { type: "story", title: "Rehearsal", stepId: "todo", projectId: appProject, workspaceId: app.id, previewAt: T0 });

  const agents = listAgents(handle.db);
  const implementer = agents.find((agent) => agent.role === "implementer")!;
  const reviewer = agents.find((agent) => agent.role === "reviewer")!;
  updateAgent(handle.db, implementer.id as Uuid, { provider: "claude", model: "configured-implementer-model" });
  updateAgent(handle.db, reviewer.id as Uuid, { provider: "codex", model: "configured-reviewer-model" });
  const imp = implementer.id as Uuid;
  const rev = reviewer.id as Uuid;

  run("r1", appItem, imp, "implement", "claude", {
    status: "succeeded",
    threadId: "t-1",
    startedAt: T0,
    endedAt: T0 + 10 * MINUTE,
    tokensIn: 1000,
    tokensOut: 100,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    costCents: 120,
    turns: 5,
    turnsScope: "turn",
  });
  run("r2", appItem, rev, "review", "codex", {
    status: "succeeded",
    startedAt: T0 + 15 * MINUTE,
    endedAt: T0 + 20 * MINUTE,
    tokensIn: 500,
    tokensOut: 50,
    costCents: 30,
    result: persisted({ verdict: "reject", blocking_issues: ["No test for the 429."] }),
  });
  run(
    "r3",
    appItem,
    imp,
    "implement",
    "claude",
    { status: "succeeded", threadId: "t-1", startedAt: T0 + 25 * MINUTE, endedAt: T0 + 31 * MINUTE, tokensIn: 2000, tokensOut: 200, cacheReadTokens: 1500, cacheWriteTokens: 0, costCents: 80, turnsScope: "session" },
    2,
  );
  run("r4", appItem, rev, "review", "codex", {
    status: "succeeded",
    startedAt: T0 + 35 * MINUTE,
    endedAt: T0 + 38 * MINUTE,
    tokensIn: 400,
    tokensOut: 40,
    costCents: 20,
    result: persisted({ verdict: "approve" }),
  });
  run("r5", appOther, imp, "implement", "claude", { status: "failed", startedAt: T1, endedAt: T1 + 12 * MINUTE, tokensIn: 3000, tokensOut: 300, costCents: 200 });
  run("r6", opsItem, imp, "implement", "claude", { status: "running", startedAt: T1 + 60 * MINUTE });
  run("preview", preview, imp, "implement", "claude", { status: "succeeded", startedAt: T0, endedAt: T0 + MINUTE, costCents: 999 });

  // What the adapters record (EO-392): the model the backend opened or
  // resumed the thread on, and — Codex — the one a turn was spent on,
  // which a reroute can have changed. Claude's usage names no model.
  appendRunEvent(handle.db, ids["r1"] as Uuid, "thread_started", { type: "thread_started", threadId: "t-1", model: "claude-opus-4" });
  appendRunEvent(handle.db, ids["r1"] as Uuid, "usage", { type: "usage", tokensIn: 1000, tokensOut: 100 });
  appendRunEvent(handle.db, ids["r2"] as Uuid, "thread_started", { type: "thread_started", threadId: "t-2", model: "gpt-5" });
  appendRunEvent(handle.db, ids["r2"] as Uuid, "output", { type: "output", text: "Reviewing.", model: "not-a-model-event" });
  appendRunEvent(handle.db, ids["r2"] as Uuid, "usage", { type: "usage", tokensIn: 500, tokensOut: 50, model: "gpt-5-mini" });
  appendRunEvent(handle.db, ids["r3"] as Uuid, "thread_started", { type: "thread_started", threadId: "t-1", model: "claude-opus-4" });
  appendRunEvent(handle.db, ids["r4"] as Uuid, "thread_started", { type: "thread_started", threadId: "t-4" });

  ids["s1"] = recordSideCall(handle.db, {
    purpose: "memory_select",
    projectId: appProject,
    itemId: appItem.id as Uuid,
    runId: null,
    backend: "claude",
    model: "haiku",
    tokensIn: 300,
    tokensOut: 20,
    costMicrocents: 400_000,
    startedAt: T0 + 21 * MINUTE,
    durationMs: 2000,
    outcome: "succeeded",
    reason: null,
  }).id;
  ids["s2"] = recordSideCall(handle.db, {
    purpose: "memory_consolidate",
    projectId: appProject,
    itemId: null,
    runId: null,
    backend: "codex",
    model: null,
    tokensIn: 100,
    tokensOut: 10,
    costMicrocents: 400_000,
    startedAt: T1 + 120 * MINUTE,
    durationMs: 4000,
    outcome: "succeeded",
    reason: null,
  }).id;
  recordSideCall(handle.db, {
    purpose: "memory_select",
    projectId: appProject,
    itemId: preview.id as Uuid,
    runId: null,
    backend: "claude",
    model: null,
    tokensIn: 1,
    tokensOut: 1,
    costMicrocents: 9_000_000,
    startedAt: T0,
    durationMs: 1,
    outcome: "succeeded",
    reason: null,
  });
});

afterEach(() => {
  handle.close();
});

function names(records: readonly RunRecord[]): string[] {
  const byId = new Map(Object.entries(ids).map(([name, id]) => [id, name]));
  return records.map((record) => byId.get(record.id) ?? record.id);
}

function listed(filters: RunFilters): string[] {
  return names(listRuns(handle.db, ipcContract["runs:list"].request.parse(filters)).runs);
}

describe("runs:list", () => {
  it("lists every run and side call, newest first, and no preview's", () => {
    expect(listed({})).toEqual(["s2", "r6", "r5", "r4", "r3", "s1", "r2", "r1"]);
  });

  it("answers in the contract's shape", () => {
    expect(() => ipcContract["runs:list"].response.parse(listRuns(handle.db, {}))).not.toThrow();
  });

  it("filters by item", () => {
    expect(listed({ itemId: appItem.id })).toEqual(["r4", "r3", "s1", "r2", "r1"]);
    expect(listed({ itemId: opsItem.id })).toEqual(["r6"]);
  });

  it("filters by project, side calls by their own project", () => {
    expect(listed({ projectId: appProject })).toEqual(["s2", "r5", "r4", "r3", "s1", "r2", "r1"]);
    expect(listed({ projectId: opsProject })).toEqual(["r6"]);
  });

  it("filters by action, a side call's being side_call:<purpose>", () => {
    expect(listed({ action: "review" })).toEqual(["r4", "r2"]);
    expect(listed({ action: "implement" })).toEqual(["r6", "r5", "r3", "r1"]);
    expect(listed({ action: "side_call:memory_select" })).toEqual(["s1"]);
    expect(listed({ action: "side_call:nothing" })).toEqual([]);
  });

  it("filters by backend — a run's thread's, or its agent's before it has one", () => {
    expect(listed({ backend: "codex" })).toEqual(["s2", "r4", "r2"]);
    expect(listed({ backend: "claude" })).toEqual(["r6", "r5", "r3", "s1", "r1"]);
  });

  it("filters by status, a side call's being its outcome", () => {
    expect(listed({ status: "failed" })).toEqual(["r5"]);
    expect(listed({ status: "running" })).toEqual(["r6"]);
    expect(listed({ status: "succeeded" })).toEqual(["s2", "r4", "r3", "s1", "r2", "r1"]);
  });

  it("filters by thread, which no side call has", () => {
    expect(listed({ threadId: "t-1" })).toEqual(["r3", "r1"]);
  });

  it("filters by when a run started, since inclusive and until exclusive", () => {
    expect(listed({ startedSince: T1 })).toEqual(["s2", "r6", "r5"]);
    expect(listed({ startedUntil: T1 })).toEqual(["r4", "r3", "s1", "r2", "r1"]);
    expect(listed({ startedSince: T0 + 15 * MINUTE, startedUntil: T0 + 25 * MINUTE })).toEqual(["s1", "r2"]);
  });

  it("combines filters with AND", () => {
    expect(listed({ projectId: appProject, action: "implement", backend: "claude", startedUntil: T1 })).toEqual(["r3", "r1"]);
  });

  it("returns every field the story names, the review verdict among them", () => {
    const runs = listRuns(handle.db, {}).runs;
    const r1 = runs.find((record) => record.id === ids["r1"]);
    expect(r1).toEqual({
      id: ids["r1"],
      kind: "run",
      itemId: appItem.id,
      itemKey: "APP-1",
      projectId: appProject,
      action: "implement",
      backend: "claude",
      model: "claude-opus-4",
      status: "succeeded",
      startedAt: T0,
      endedAt: T0 + 10 * MINUTE,
      durationMs: 10 * MINUTE,
      tokensIn: 1000,
      tokensOut: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      costCents: 120,
      costMicrocents: 120_000_000,
      turns: 5,
      turnsScope: "turn",
      attempt: 1,
      threadId: "t-1",
      interruption: null,
      verdict: null,
      memoryDelivered: 0,
      memoryUsed: 0,
    });
    // The model a reroute moved the turn to, over the one the thread opened on.
    expect(runs.find((record) => record.id === ids["r2"])).toMatchObject({ verdict: "reject", backend: "codex", model: "gpt-5-mini" });
    expect(runs.find((record) => record.id === ids["r3"])).toMatchObject({ attempt: 2, turnsScope: "session", model: "claude-opus-4" });
    // Its log names no model, so none is reported — not the agent's.
    expect(runs.find((record) => record.id === ids["r4"])).toMatchObject({ verdict: "approve", model: null });
    expect(runs.find((record) => record.id === ids["r6"])).toMatchObject({ endedAt: null, durationMs: null, tokensIn: null, costCents: null });
  });

  it("lists a side call as its own action, with its tokens and its exact cost", () => {
    const s1 = listRuns(handle.db, {}).runs.find((record) => record.id === ids["s1"]);
    expect(s1).toEqual({
      id: ids["s1"],
      kind: "side_call",
      itemId: appItem.id,
      itemKey: "APP-1",
      projectId: appProject,
      action: "side_call:memory_select",
      backend: "claude",
      model: "haiku",
      status: "succeeded",
      startedAt: T0 + 21 * MINUTE,
      endedAt: T0 + 21 * MINUTE + 2000,
      durationMs: 2000,
      tokensIn: 300,
      tokensOut: 20,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costCents: 0,
      costMicrocents: 400_000,
      turns: null,
      turnsScope: null,
      attempt: null,
      threadId: null,
      interruption: null,
      verdict: null,
      memoryDelivered: null,
      memoryUsed: null,
    });
    expect(listRuns(handle.db, {}).runs.find((record) => record.id === ids["s2"])).toMatchObject({ itemId: null, itemKey: null, action: "side_call:memory_consolidate" });
  });

  it("lists a run not yet started after every run that has", () => {
    run("queued", appOther, null, "create_worktree", null, {});
    expect(listed({}).at(-1)).toBe("queued");
    expect(listRuns(handle.db, {}).runs.at(-1)).toMatchObject({ backend: null, model: null, startedAt: null, status: "queued" });
  });

  it("reads the verdict from the half of the result the engine acted on, not the agent's raw words", () => {
    run("halves", appOther, null, "review", "codex", { status: "succeeded", startedAt: T1, result: { raw: { verdict: "approve" }, parsed: { verdict: "reject" } } });
    expect(listRuns(handle.db, { action: "review" }).runs.find((record) => record.id === ids["halves"])?.verdict).toBe("reject");
  });

  it("reads a verdict written before results had two halves", () => {
    // `parsedResultOf`'s rule: a row with no `parsed` is the parsed value itself.
    run("legacy", appOther, null, "review", "codex", { status: "succeeded", startedAt: T1, result: { verdict: "reject" } });
    expect(listRuns(handle.db, { action: "review" }).runs.find((record) => record.id === ids["legacy"])?.verdict).toBe("reject");
  });

  it("reads no verdict out of a result that holds none", () => {
    // What the supervisor writes for a failed or waiting run, a verdict that is not text, and nothing at all.
    run("failed", appOther, null, "review", "codex", { status: "failed", startedAt: T1, result: { raw: { error: "boom" }, parsed: { result: "failed" } } });
    run("odd", appOther, null, "review", "codex", { status: "succeeded", startedAt: T1, result: { raw: null, parsed: { verdict: { nested: true } } } });
    run("flatOdd", appOther, null, "review", "codex", { status: "succeeded", startedAt: T1, result: { verdict: { nested: true } } });
    run("none", appOther, null, "review", "codex", { status: "running", startedAt: T1 });
    const runs = listRuns(handle.db, { action: "review" }).runs;
    for (const name of ["failed", "odd", "flatOdd", "none"]) expect(runs.find((record) => record.id === ids[name])?.verdict, name).toBeNull();
  });

  it("reports a finished run's backend and model as it ran, after its agent is moved to another", () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    updateAgent(handle.db, implementer.id as Uuid, { provider: "codex", model: "gpt-5" });

    const r1 = listRuns(handle.db, {}).runs.find((record) => record.id === ids["r1"]);
    expect(r1).toMatchObject({ backend: "claude", model: "claude-opus-4" });
    expect(listed({ backend: "codex" })).toEqual(["s2", "r4", "r2"]);
  });

  it("names no backend for a step EO ran itself, or a run that never recorded one", () => {
    run("builtin", appOther, null, "create_worktree", "builtin", { status: "succeeded", startedAt: T1, endedAt: T1 + 1000 });
    run("module", appOther, null, "lint", "module", { status: "succeeded", startedAt: T1, endedAt: T1 + 1000 });
    // A guard's placeholder: an agent's, never sent to any backend.
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!.id as Uuid;
    run("guard", appOther, implementer, "implement", null, { status: "awaiting_input", startedAt: T1, endedAt: T1 });
    const runs = listRuns(handle.db, { itemId: appOther.id }).runs;
    for (const name of ["builtin", "module", "guard"]) expect(runs.find((record) => record.id === ids[name]), name).toMatchObject({ backend: null, model: null });
    expect(listed({ backend: "builtin" })).toEqual([]);
  });

  it("reads each run's model through the partial index over its model rows, not its whole log", () => {
    // The statement `runs:list` actually prepares, caught at the
    // connection drizzle prepares on — the seam itemSections.test.ts
    // watches. Asked with no filter, it binds nothing, so it can be
    // explained as it is.
    const client = (handle.db as unknown as { $client: { prepare: (source: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    const seen: string[] = [];
    client.prepare = (source: string) => {
      seen.push(source);
      return prepare(source);
    };
    try {
      listRuns(handle.db, {});
    } finally {
      client.prepare = prepare;
    }
    const statement = seen.find((source) => source.includes("from \"runs\""));
    expect(statement).toBeDefined();
    expect(statement).toContain("IN ('thread_started', 'usage')");
    const plan = handle.db
      .all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${statement!}`))
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_run_events_model");
    // And the index is what the migration says it is: those rows only.
    expect(handle.db.get<{ sql: string }>(sql`select sql from sqlite_master where name = 'idx_run_events_model'`)?.sql).toMatch(/WHERE `type` IN \('thread_started', 'usage'\)/);
  });
});

describe("runs:summary", () => {
  function summary(groupBy: "item" | "action" | "backend" | "day", filters: RunFilters = {}) {
    const answer = summariseRuns(handle.db, ipcContract["runs:summary"].request.parse({ ...filters, groupBy }));
    expect(() => ipcContract["runs:summary"].response.parse(answer)).not.toThrow();
    return answer;
  }

  it("groups by item, matching the fixture worked by hand", () => {
    const answer = summary("item");
    expect(answer.groupBy).toBe("item");
    expect(answer.groups).toEqual([
      {
        key: "APP-1",
        itemId: appItem.id,
        count: 5,
        // 10 + 5 + 6 + 3 minutes, and s1's two seconds.
        activeMinutes: 24.03,
        // 10:00 to 10:38.
        elapsedMinutes: 38,
        tokensIn: 4200,
        tokensOut: 410,
        cacheReadTokens: 2300,
        cacheWriteTokens: 50,
        // 120 + 30 + 80 + 20, and 0.4¢.
        costCents: 250,
        reviews: 2,
        rejections: 1,
      },
      {
        key: "APP-2",
        itemId: appOther.id,
        count: 1,
        activeMinutes: 12,
        elapsedMinutes: 12,
        tokensIn: 3000,
        tokensOut: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 200,
        reviews: 0,
        rejections: 0,
      },
      {
        key: "OPS-1",
        itemId: opsItem.id,
        count: 1,
        // Running: it has started and not ended.
        activeMinutes: 0,
        elapsedMinutes: null,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 0,
        reviews: 0,
        rejections: 0,
      },
      {
        // The consolidation, which is about no item.
        key: null,
        itemId: null,
        count: 1,
        activeMinutes: 0.07,
        elapsedMinutes: 0.07,
        tokensIn: 100,
        tokensOut: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costCents: 0,
        reviews: 0,
        rejections: 0,
      },
    ]);
  });

  it("adds every run up in overall, the side calls' fractions summed before they are rounded", () => {
    expect(summary("item").overall).toEqual({
      count: 8,
      // 36 minutes of runs, and six seconds of side calls.
      activeMinutes: 36.1,
      // T0 to s2's end, the last to end: a day less an hour, two hours, and four seconds.
      elapsedMinutes: 1500.07,
      tokensIn: 7300,
      tokensOut: 720,
      cacheReadTokens: 2300,
      cacheWriteTokens: 50,
      // 450¢ of runs, and two 0.4¢ side calls: 450.8, which is 451 — not
      // the 450 that rounding each call first would make it.
      costCents: 451,
      reviews: 2,
      rejections: 1,
    });
  });

  it("groups by action, side calls under their own", () => {
    const answer = summary("action");
    expect(answer.groups.map((group) => [group.key, group.count, group.costCents])).toEqual([
      ["implement", 4, 400],
      ["review", 2, 50],
      ["side_call:memory_consolidate", 1, 0],
      ["side_call:memory_select", 1, 0],
    ]);
    expect(answer.groups.find((group) => group.key === "review")).toMatchObject({ activeMinutes: 8, elapsedMinutes: 23, tokensIn: 900, tokensOut: 90, reviews: 2, rejections: 1, itemId: null });
    expect(answer.groups.find((group) => group.key === "implement")).toMatchObject({ activeMinutes: 28, elapsedMinutes: 23 * 60 + 12, tokensIn: 6000, tokensOut: 600 });
  });

  it("groups by backend", () => {
    expect(summary("backend").groups.map((group) => [group.key, group.count, group.tokensIn, group.costCents])).toEqual([
      ["claude", 5, 6300, 400],
      ["codex", 3, 1000, 50],
    ]);
  });

  it("groups by the local day each run started", () => {
    expect(summary("day").groups.map((group) => [group.key, group.count, group.activeMinutes, group.costCents])).toEqual([
      ["2026-10-19", 5, 24.03, 250],
      ["2026-10-20", 3, 12.07, 200],
    ]);
  });

  it("adds up only the runs the filters let through", () => {
    const answer = summary("item", { action: "review" });
    expect(answer.groups.map((group) => [group.key, group.count, group.rejections])).toEqual([["APP-1", 2, 1]]);
    expect(answer.overall.count).toBe(2);
    expect(summary("backend", { projectId: opsProject }).groups.map((group) => group.key)).toEqual(["claude"]);
  });

  it("answers nothing matched with no groups and zeroes", () => {
    const answer = summary("day", { threadId: "nobody" });
    expect(answer.groups).toEqual([]);
    expect(answer.overall).toMatchObject({ count: 0, activeMinutes: 0, elapsedMinutes: null, costCents: 0 });
  });

  it("refuses a grouping it does not have", () => {
    expect(ipcContract["runs:summary"].request.safeParse({ groupBy: "week" }).success).toBe(false);
    expect(ipcContract["runs:summary"].request.safeParse({}).success).toBe(false);
  });
});
