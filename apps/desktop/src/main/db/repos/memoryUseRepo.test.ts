import { MEMORY_DELIVERED_EVENT, MEMORY_USED_EVENT } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { memoryUsageByEntry, memoryUsageQuery } from "./memoryUseRepo.js";
import { appendRunEvent, createRun } from "./index.js";

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
