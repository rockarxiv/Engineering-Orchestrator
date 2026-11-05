import type { Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, createRun, listAgents, projectForWorkspace, recordSideCall, updateRun } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { resolveItemKey } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { listRuns, summariseRuns } from "../ipc/runAnalysis.js";
import { TOOLS, type ToolSpec } from "./catalog.js";
import { guideNamed } from "./guides.js";
import { RESOLVE_KEY_CHANNEL } from "./itemKeys.js";
import { NARROWING_KEYS } from "./narrow.js";
import { answerToolCall } from "./server.js";

/**
 * `runs_list` and `runs_summary` (EO-541), through the door every
 * client's call comes in by: read-only tools over their own IPC
 * channels, taking an item's key, the shared narrowing parameters, and
 * side calls as their own action.
 */

let handle: DbHandle;
let itemId: string;
let otherId: string;
const T0 = 1_760_000_000_000;
const MINUTE = 60_000;

beforeEach(() => {
  handle = openMigratedTestDb();
  const opts = { exposeErrorDetails: true };
  registerHandler("runs:list", (payload) => listRuns(handle.db, payload), opts);
  registerHandler("runs:summary", (payload) => summariseRuns(handle.db, payload), opts);
  registerHandler("items:resolveKey", (payload) => resolveItemKey(handle.db, payload), opts);

  const workspace = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" });
  const projectId = projectForWorkspace(handle.db, workspace.id)!.id as Uuid;
  itemId = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo", projectId, workspaceId: workspace.id }).id;
  otherId = createTestItem(handle.db, { type: "story", title: "Retry the export", stepId: "todo", projectId, workspaceId: workspace.id }).id;
  const agents = listAgents(handle.db);
  const implementer = agents.find((agent) => agent.role === "implementer")!.id as Uuid;
  const reviewer = agents.find((agent) => agent.role === "reviewer")!.id as Uuid;

  const run = (item: string, agentId: Uuid, action: string, start: number, minutes: number, costCents: number, result?: Record<string, unknown>) => {
    const created = createRun(handle.db, { itemId: item as Uuid, agentId, action, provider: "claude" });
    // As the supervisor persists a result (A-02): the agent's words, and what the engine parsed.
    updateRun(handle.db, created.id, { status: "succeeded", startedAt: start, endedAt: start + minutes * MINUTE, tokensIn: 100, tokensOut: 10, costCents, ...(result ? { result: { raw: { text: JSON.stringify(result) }, parsed: result } } : {}) });
    // And the model, as the adapter records the thread it opened (EO-392).
    appendRunEvent(handle.db, created.id, "thread_started", { type: "thread_started", threadId: `thread-${created.id}`, model: action === "review" ? "claude-sonnet-4" : "claude-opus-4" });
  };
  run(itemId, implementer, "implement", T0, 10, 100);
  run(itemId, reviewer, "review", T0 + 20 * MINUTE, 5, 20, { verdict: "reject" });
  run(itemId, implementer, "implement", T0 + 30 * MINUTE, 4, 40);
  run(itemId, reviewer, "review", T0 + 40 * MINUTE, 3, 10, { verdict: "approve" });
  run(otherId, implementer, "implement", T0 + 60 * MINUTE, 6, 60);
  recordSideCall(handle.db, {
    purpose: "memory_extract",
    projectId,
    itemId: itemId as Uuid,
    runId: null,
    backend: "claude",
    model: "haiku",
    tokensIn: 50,
    tokensOut: 5,
    costMicrocents: 2_500_000,
    startedAt: T0 + 15 * MINUTE,
    durationMs: 1500,
    outcome: "succeeded",
    reason: null,
  });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
});

function tool(name: string): ToolSpec {
  const found = TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

function call(name: string, args: Record<string, unknown>) {
  return answerToolCall({ name, arguments: args }, "admin", true);
}

function textOf(result: Awaited<ReturnType<typeof call>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("the two run tools in the catalogue", () => {
  it.each(["runs_list", "runs_summary"])("%s is a read, over its own IPC channel, with every shared parameter", (name) => {
    const spec = tool(name);
    expect(spec.kind).toBe("read");
    expect(spec.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    expect(spec.channels).toEqual([name === "runs_list" ? "runs:list" : "runs:summary", RESOLVE_KEY_CHANNEL]);
    const properties = Object.keys((spec.inputSchema["properties"] ?? {}) as Record<string, unknown>);
    for (const key of NARROWING_KEYS) expect(properties, key).toContain(key);
    for (const filter of ["itemId", "projectId", "action", "backend", "status", "threadId", "startedSince", "startedUntil"]) expect(properties, filter).toContain(filter);
    // EO's own word for the item it filters on: a tool added now has no
    // client registered against `ticketId` to keep working.
    expect(properties).not.toContain("ticketId");
  });

  it("asks runs_summary what to group by, and offers the four groupings", () => {
    const groupBy = ((tool("runs_summary").inputSchema["properties"] ?? {}) as Record<string, { enum?: string[] }>)["groupBy"];
    expect(groupBy?.enum).toEqual(["item", "action", "backend", "day"]);
    expect(tool("runs_summary").inputSchema["required"]).toEqual(["groupBy"]);
  });
});

describe("runs_list", () => {
  it("takes an item's key, and answers its runs and side calls in the boundary's spelling", async () => {
    const result = await call("runs_list", { itemId: "APP-1" });
    expect(result.isError).toBe(false);
    const runs = (result.structuredContent as { runs: Record<string, unknown>[] }).runs;
    expect(runs.map((run) => run["action"])).toEqual(["review", "implement", "review", "side_call:memory_extract", "implement"]);
    expect(runs.every((run) => run["ticketKey"] === "APP-1" && run["ticketId"] === itemId)).toBe(true);
    expect(textOf(result)).toContain("APP-1 review · claude/claude-sonnet-4 · succeeded");
    expect(runs.filter((run) => run["action"] === "review").map((run) => run["verdict"])).toEqual(["approve", "reject"]);
    expect(textOf(result)).toContain("verdict reject");
    expect(textOf(result)).toContain("APP-1 side_call:memory_extract · claude/haiku");
  });

  it("narrows with fields and where like every other list tool", async () => {
    const result = await call("runs_list", { where: [{ path: "verdict", op: "eq", value: "reject" }], fields: ["runs.ticketKey", "runs.action", "runs.verdict", "runs.durationMs"] });
    expect(result.structuredContent).toEqual({ runs: [{ ticketKey: "APP-1", action: "review", verdict: "reject", durationMs: 5 * MINUTE }], total: 1, returned: 1, nextOffset: null });
    expect(textOf(result).split("\n")[0]).toMatch(/^1 .* matched; 1 returned, and there are no more\.$/);
  });

  it("sorts and pages", async () => {
    const first = await call("runs_list", { sort: { path: "costMicrocents", direction: "desc" }, limit: 2, fields: ["runs.costCents"] });
    expect(first.structuredContent).toEqual({ runs: [{ costCents: 100 }, { costCents: 60 }], total: 6, returned: 2, nextOffset: 2 });
  });

  it("refuses a key naming nothing, and reads nothing", async () => {
    const result = await call("runs_list", { itemId: "APP-99" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("APP-99");
    expect(textOf(result)).toMatch(/Nothing was read\.$/);
  });
});

describe("runs_summary", () => {
  it("adds an item's runs up by action, its side call among them", async () => {
    const result = await call("runs_summary", { itemId: "APP-1", groupBy: "action" });
    const data = result.structuredContent as { groups: Record<string, unknown>[]; overall: Record<string, unknown> };
    expect(data.groups.map((group) => [group["key"], group["count"], group["activeMinutes"], group["costCents"], group["rejections"]])).toEqual([
      ["implement", 2, 14, 140, 0],
      ["review", 2, 8, 30, 1],
      ["side_call:memory_extract", 1, 0.03, 3, 0],
    ]);
    // 170¢ of runs and a 2.5¢ side call, summed before they are rounded.
    expect(data.overall).toMatchObject({ count: 5, costCents: 173, reviews: 2, rejections: 1, elapsedMinutes: 43 });
    expect(textOf(result)).toContain("By action.");
    expect(textOf(result)).toContain("- review: 2 run(s) · 8 min active · 23 min elapsed");
    expect(textOf(result)).toContain("1 of 2 review(s) rejected");
  });

  it("narrows its groups with where", async () => {
    const result = await call("runs_summary", { groupBy: "item", where: [{ path: "key", op: "eq", value: "APP-2" }] });
    const data = result.structuredContent as { groups: Record<string, unknown>[]; overall: Record<string, unknown>; total: number };
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0]).toMatchObject({ key: "APP-2", ticketId: otherId, count: 1, activeMinutes: 6, costCents: 60 });
    expect(data.total).toBe(1);
    // Every run the filters matched, whatever `where` did to the groups.
    expect(data.overall["count"]).toBe(6);
  });

  it("refuses a call that names no grouping, and reads nothing", async () => {
    const result = await call("runs_summary", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("runs_summary");
  });
});

describe("both are read-only", () => {
  it("leave every run and side call exactly as they were", async () => {
    const snapshot = () => handle.db.all(sql`select (select group_concat(id || ':' || updated_at || ':' || status) from runs) as runs, (select count(*) from side_calls) as calls, (select count(*) from run_events) as events`);
    const before = snapshot();
    await call("runs_list", { itemId: "APP-1" });
    await call("runs_summary", { groupBy: "day" });
    await call("runs_summary", { groupBy: "backend", fields: ["groups.key"] });
    expect(snapshot()).toEqual(before);
  });
});

describe("the eo_orient guide", () => {
  it("names both run tools, what they filter by, how they group, and side calls as their own action", () => {
    const flat = (guideNamed("eo_orient")?.body ?? "").replace(/\s+/g, " ");
    expect(flat).toContain("`runs_list`");
    expect(flat).toContain("`runs_summary`");
    for (const term of ["itemId", "projectId", "action", "backend", "status", "threadId", "startedSince", "startedUntil", "groupBy", "item", "day", "side_call:<purpose>", "activeMinutes", "elapsedMinutes", "rejections", "verdict"]) {
      expect(flat, term).toContain(`\`${term}\``);
    }
  });
});
