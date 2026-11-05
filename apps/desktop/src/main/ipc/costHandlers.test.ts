import type { Agent, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createRun, updateRun } from "../db/repos/runsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { formatDateKey, startOfDayForKey } from "../dateUtils.js";
import { getDailyCost, getItemCost } from "./costHandlers.js";

describe("cost IPC handlers", () => {
  let handle: DbHandle;
  let itemA: Item;
  let itemB: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    itemA = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    itemB = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  it("bounds a day by midnight rather than by 24 hours, so a clock change cannot double-count", () => {
    // The day the clocks go forward is 23 hours long. Ending the window
    // a fixed 24 hours after midnight reaches an hour into the next day,
    // so a run that happened on the 30th was billed to both dates.
    // Restored by deleting rather than by assigning back: `process.env`
    // coerces its values, so writing an absent original back returns the
    // literal string "undefined" — not a zone. Every test after this one
    // would then resolve to UTC, and the local-day assertions below would
    // stop testing anything on a machine that is not already there.
    const original = process.env["TZ"];
    process.env["TZ"] = "Europe/London";
    try {
      const springForward = startOfDayForKey("2026-03-29");
      costedRun(itemA.id, 500, springForward + 23.5 * 60 * 60 * 1000); // already the 30th, locally

      expect(getDailyCost(handle.db, { date: "2026-03-29" }).costCents).toBe(0);
      expect(getDailyCost(handle.db, { date: "2026-03-30" }).costCents).toBe(500);
    } finally {
      if (original === undefined) delete process.env["TZ"];
      else process.env["TZ"] = original;
    }
  });

  function costedRun(itemId: Uuid, costCents: number, startedAt: number): void {
    const run = createRun(handle.db, { itemId, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, run.id, { costCents, startedAt, endedAt: startedAt });
  }

  it("costs:getForItem sums cost_cents across every run for that item only", () => {
    costedRun(itemA.id, 100, Date.now());
    costedRun(itemA.id, 250, Date.now());
    costedRun(itemB.id, 999, Date.now()); // a different item — must not leak into A's total

    expect(getItemCost(handle.db, { itemId: itemA.id })).toEqual({ itemId: itemA.id, costCents: 350, sideCalls: [] });
  });

  it("costs:getForItem is 0 for an item with no runs", () => {
    expect(getItemCost(handle.db, { itemId: itemA.id })).toEqual({ itemId: itemA.id, costCents: 0, sideCalls: [] });
  });

  it("costs:getDaily sums across all items for today by default", () => {
    costedRun(itemA.id, 100, Date.now());
    costedRun(itemB.id, 200, Date.now());

    const result = getDailyCost(handle.db, {});
    expect(result.date).toBe(formatDateKey(Date.now()));
    expect(result.costCents).toBe(300);
  });

  it("costs:getDaily for an explicit past date excludes today's spend", () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    costedRun(itemA.id, 500, yesterday);
    costedRun(itemB.id, 100, Date.now()); // today — must not leak into yesterday's total

    const result = getDailyCost(handle.db, { date: formatDateKey(yesterday) });
    expect(result.costCents).toBe(500);
  });
});
