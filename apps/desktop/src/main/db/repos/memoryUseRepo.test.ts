import { MEMORY_DELIVERED_EVENT, MEMORY_USED_EVENT } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { lastDeliveredAt, lastDeliveredQuery, memoryUsageByEntry, memoryUsageQuery } from "./memoryUseRepo.js";
import { appendRunEvent, appendRunEventAt, createRun } from "./index.js";

/** How often each memory entry was given to a run and said to be used (EO-597). */
describe("memory usage by entry", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });
  afterEach(() => handle.close());

  const delivered = (entryIds: string[]) => ({ type: MEMORY_DELIVERED_EVENT, entryIds, candidateCount: entryIds.length, mode: "all", selectionRan: false, reason: null });

  it("counts runs, not events: a run given an entry twice was given it once", () => {
    const item = createTestItem(handle.db, { type: "story", title: "T", stepId: "todo" });
    const one = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const two = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", status: "succeeded" });
    appendRunEvent(handle.db, one.id, MEMORY_DELIVERED_EVENT, delivered(["a", "b"]));
    appendRunEvent(handle.db, one.id, MEMORY_DELIVERED_EVENT, delivered(["a"]));
    appendRunEvent(handle.db, two.id, MEMORY_DELIVERED_EVENT, delivered(["a"]));
    appendRunEvent(handle.db, one.id, MEMORY_USED_EVENT, { type: MEMORY_USED_EVENT, entryIds: ["a"], droppedIds: ["z"] });

    expect(Object.fromEntries(memoryUsageByEntry(handle.db))).toEqual({ a: { deliveries: 2, uses: 1 }, b: { deliveries: 1, uses: 0 } });
  });

  it.each([
    [MEMORY_DELIVERED_EVENT, "idx_run_events_memory_delivered"],
    [MEMORY_USED_EVENT, "idx_run_events_memory_used"],
  ])("reads %s rows through their partial index, not every transcript", (type, index) => {
    const plan = handle.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${memoryUsageQuery(type)}`)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain(index);
  });
});

/** When each entry was last given to an earlier run, for a fallback's order (EO-914). */
describe("when entries were last delivered", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });
  afterEach(() => handle.close());

  const delivered = (entryIds: string[]) => ({ type: MEMORY_DELIVERED_EVENT, entryIds, candidateCount: entryIds.length, mode: "selected", selectionRan: true, reason: null });

  it("is the newest memory_delivered event naming each, leaving out the run asking, other events and ids not asked about", () => {
    const item = createTestItem(handle.db, { type: "story", title: "T", stepId: "todo" });
    const one = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" });
    const two = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", status: "succeeded" });
    const asking = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "running" });
    appendRunEventAt(handle.db, one.id, { seq: 0, ts: 100 }, MEMORY_DELIVERED_EVENT, delivered(["a", "b"]));
    appendRunEventAt(handle.db, two.id, { seq: 0, ts: 300 }, MEMORY_DELIVERED_EVENT, delivered(["a"]));
    appendRunEventAt(handle.db, one.id, { seq: 1, ts: 200 }, MEMORY_DELIVERED_EVENT, delivered(["b", "z"]));
    appendRunEventAt(handle.db, asking.id, { seq: 0, ts: 900 }, MEMORY_DELIVERED_EVENT, delivered(["a", "c"]));
    // Used, not delivered: not a delivery.
    appendRunEventAt(handle.db, two.id, { seq: 1, ts: 950 }, MEMORY_USED_EVENT, { type: MEMORY_USED_EVENT, entryIds: ["c"], droppedIds: [] });

    expect(Object.fromEntries(lastDeliveredAt(handle.db, ["a", "b", "c", "never"], asking.id))).toEqual({ a: 300, b: 200 });
    expect(lastDeliveredAt(handle.db, [], asking.id).size).toBe(0);
  });

  it("reads memory_delivered rows through their partial index, not every transcript", () => {
    const plan = handle.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${lastDeliveredQuery(["a"], "019a0000-0000-7000-8000-000000000914" as never)}`)
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_run_events_memory_delivered");
  });
});
