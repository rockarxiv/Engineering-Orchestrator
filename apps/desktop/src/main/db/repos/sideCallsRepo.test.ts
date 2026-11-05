import { MICROCENTS_PER_CENT, type Agent, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { listAgents } from "./agentsRepo.js";
import { deleteItem } from "./itemsRepo.js";
import { createPerson } from "./peopleRepo.js";
import { createProject, markProjectOnTheRecord } from "./projectsRepo.js";
import {
  costCentsByOwnerSince,
  costCentsByProject,
  createRun,
  personCostCentsSince,
  sumCostCentsBetween,
  sumCostCentsForItem,
  sumCostCentsForItems,
  sumCostCentsSince,
  updateRun,
} from "./runsRepo.js";
import { listSideCalls, recordSideCall, sideCallLinesBetween, sideCallLinesForItem, type RecordSideCallInput } from "./sideCallsRepo.js";
import { formatDateKey } from "../../dateUtils.js";
import { getDailyCost, getItemCost } from "../../ipc/costHandlers.js";
import { renderSpend } from "../../mcpHost/render.js";

/**
 * Every spend reader counts side calls wherever it counts runs (EO-477):
 * the per-item and daily budgets' sums, the project and person totals, a
 * job's spend, and what `costs:*` — the spend screens and `spend_read` —
 * answer, with the side calls also listed as their own line.
 */
describe("side calls in the spend readers", () => {
  let handle: DbHandle;
  let item: Item;
  let other: Item;
  let implementer: Agent;
  const now = Date.now();

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A", stepId: "todo" });
    other = createTestItem(handle.db, { type: "story", title: "B", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  function run(itemId: string, costCents: number, startedAt = now) {
    const created = createRun(handle.db, { itemId: itemId as Uuid, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, created.id, { costCents, startedAt, endedAt: startedAt });
    return created;
  }

  /** A side call, its cost given in whole cents for the tests that think in them. */
  function sideCall({ costCents = 0, ...overrides }: Partial<RecordSideCallInput> & { costCents?: number }) {
    return recordSideCall(handle.db, {
      purpose: "memory_select",
      projectId: (item.projectId as Uuid | null) ?? null,
      itemId: null,
      runId: null,
      backend: "claude",
      model: "claude-haiku-5-5",
      tokensIn: 100,
      tokensOut: 10,
      costMicrocents: costCents * MICROCENTS_PER_CENT,
      startedAt: now,
      durationMs: 400,
      outcome: "succeeded",
      reason: null,
      ...overrides,
    });
  }

  it("the per-item budget's figure: an item's runs and the side calls about it, and nobody else's", () => {
    run(item.id, 100);
    sideCall({ itemId: item.id as Uuid, costCents: 7 });
    sideCall({ itemId: other.id as Uuid, costCents: 900 });
    sideCall({ itemId: null, costCents: 50 });

    expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(107);
  });

  it("the daily budget's figure: every run and every side call since midnight, on an item or on none", () => {
    run(item.id, 100);
    sideCall({ itemId: item.id as Uuid, costCents: 7 });
    sideCall({ itemId: null, purpose: "memory_consolidate", costCents: 20 });
    sideCall({ itemId: null, costCents: 1_000, startedAt: now - 3 * 24 * 60 * 60 * 1000 }); // another day

    expect(sumCostCentsSince(handle.db, now - 60_000)).toBe(127);
    expect(sumCostCentsBetween(handle.db, now - 60_000, now + 60_000)).toBe(127);
  });

  it("leaves a preview's side calls out, as a preview's runs are", () => {
    const preview = createTestItem(handle.db, { type: "story", title: "Rehearsal", stepId: "todo", previewAt: now });
    sideCall({ itemId: preview.id as Uuid, costCents: 40 });

    expect(sumCostCentsForItem(handle.db, preview.id as Uuid)).toBe(0);
    expect(sumCostCentsSince(handle.db, now - 60_000)).toBe(0);
    expect(sideCallLinesForItem(handle.db, preview.id as Uuid)).toEqual([]);
  });

  it("a job's spend, the project switcher's totals and a person's day", () => {
    const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    markProjectOnTheRecord(handle.db, project.id, anna.id);
    const onProject = createTestItem(handle.db, { type: "story", title: "Support work", stepId: "todo", projectId: project.id });
    run(onProject.id, 100);
    sideCall({ projectId: project.id, itemId: onProject.id as Uuid, costCents: 7 });
    sideCall({ projectId: project.id, itemId: null, purpose: "memory_consolidate", costCents: 3 });

    expect(sumCostCentsForItems(handle.db, [onProject.id as Uuid, other.id as Uuid])).toBe(107);
    expect(costCentsByProject(handle.db).get(project.id)).toBe(110);
    expect(costCentsByOwnerSince(handle.db, now - 60_000).get(anna.id)).toBe(110);
    expect(personCostCentsSince(handle.db, anna.id, now - 60_000)).toBe(110);
  });

  it("lists side calls by spend line — one Memory upkeep line for the three memory purposes, none when nothing was spent", () => {
    sideCall({ purpose: "memory_select", itemId: item.id as Uuid, costCents: 2 });
    sideCall({ purpose: "memory_extract", itemId: item.id as Uuid, costCents: 3 });
    sideCall({ purpose: "memory_consolidate", costCents: 5 });

    expect(sideCallLinesBetween(handle.db, now - 60_000, now + 60_000)).toEqual([{ group: "memory_upkeep", label: "Memory upkeep", costCents: 10 }]);
    expect(sideCallLinesForItem(handle.db, item.id as Uuid)).toEqual([{ group: "memory_upkeep", label: "Memory upkeep", costCents: 5 }]);
    expect(sideCallLinesForItem(handle.db, other.id as Uuid)).toEqual([]);
  });

  it("costs:getDaily and costs:getForItem — the spend screens' and spend_read's figures — include them and list them", () => {
    run(item.id, 100);
    sideCall({ itemId: item.id as Uuid, costCents: 7 });

    expect(getDailyCost(handle.db, { date: formatDateKey(now) })).toEqual({
      date: formatDateKey(now),
      costCents: 107,
      sideCalls: [{ group: "memory_upkeep", label: "Memory upkeep", costCents: 7 }],
      trialCostCents: 0,
    });
    expect(getItemCost(handle.db, { itemId: item.id })).toEqual({ itemId: item.id, costCents: 107, sideCalls: [{ group: "memory_upkeep", label: "Memory upkeep", costCents: 7 }] });
  });

  it("spend_read says which share of a figure was EO's own side calls", () => {
    const text = renderSpend({
      date: "2026-10-19",
      dailyCostCents: 107,
      dailySideCalls: [{ group: "memory_upkeep", label: "Memory upkeep", costCents: 7 }],
      dailyTrialCostCents: 0,
      item: { itemId: item.id, costCents: 107, sideCalls: [{ group: "memory_upkeep", label: "Memory upkeep", costCents: 7 }] },
    });
    // Once for the day and once for the item.
    expect(text.split("\n").filter((line) => line.includes("$1.07 (of which Memory upkeep: $0.07)"))).toHaveLength(2);
  });

  describe("to the micro-cent (EO-510)", () => {
    /** Half a cent: roughly what one memory selection on Haiku costs. */
    const halfACent = MICROCENTS_PER_CENT / 2;

    function halfCentCalls(count: number, overrides: Partial<RecordSideCallInput> = {}): void {
      for (let i = 0; i < count; i++) sideCall({ costMicrocents: halfACent, ...overrides });
    }

    it("keeps what one call cost below a cent, rather than rounding it to nothing", () => {
      sideCall({ itemId: item.id as Uuid, costMicrocents: 400_000 });

      expect(listSideCalls(handle.db)[0]?.costMicrocents).toBe(400_000);
    });

    it("200 calls at half a cent are a dollar — to the per-item budget, the daily budget, a job, a project and a person", () => {
      const anna = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
      const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
      markProjectOnTheRecord(handle.db, project.id, anna.id);
      const onProject = createTestItem(handle.db, { type: "story", title: "Support work", stepId: "todo", projectId: project.id });
      halfCentCalls(200, { projectId: project.id, itemId: onProject.id as Uuid });

      expect(sumCostCentsForItem(handle.db, onProject.id as Uuid)).toBe(100);
      expect(sumCostCentsForItems(handle.db, [onProject.id as Uuid])).toBe(100);
      expect(sumCostCentsSince(handle.db, now - 60_000)).toBe(100);
      expect(sumCostCentsBetween(handle.db, now - 60_000, now + 60_000)).toBe(100);
      expect(costCentsByProject(handle.db).get(project.id)).toBe(100);
      expect(costCentsByOwnerSince(handle.db, now - 60_000).get(anna.id)).toBe(100);
      expect(personCostCentsSince(handle.db, anna.id, now - 60_000)).toBe(100);
    });

    it("and to costs:getDaily and costs:getForItem — the spend screens' and spend_read's figures — beside a run's whole cents", () => {
      run(item.id, 100);
      halfCentCalls(200, { itemId: item.id as Uuid });
      const line = { group: "memory_upkeep", label: "Memory upkeep", costCents: 100 };

      expect(getDailyCost(handle.db, { date: formatDateKey(now) })).toEqual({ date: formatDateKey(now), costCents: 200, sideCalls: [line], trialCostCents: 0 });
      expect(getItemCost(handle.db, { itemId: item.id })).toEqual({ itemId: item.id, costCents: 200, sideCalls: [line] });
    });

    it("rounds the sum once, not each call: three calls at 0.4¢ are a cent, and one is no spend line", () => {
      sideCall({ itemId: item.id as Uuid, costMicrocents: 400_000 });
      expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(0);
      expect(sideCallLinesForItem(handle.db, item.id as Uuid)).toEqual([]);

      sideCall({ itemId: item.id as Uuid, costMicrocents: 400_000 });
      sideCall({ itemId: item.id as Uuid, costMicrocents: 400_000 });
      expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(1);
      expect(sideCallLinesForItem(handle.db, item.id as Uuid)).toEqual([{ group: "memory_upkeep", label: "Memory upkeep", costCents: 1 }]);
    });
  });

  it("goes with its item when the item is deleted, inside a run or not", () => {
    const inside = run(item.id, 1);
    sideCall({ itemId: item.id as Uuid, runId: inside.id, costCents: 2 });
    sideCall({ itemId: item.id as Uuid, costCents: 2 });
    const kept = sideCall({ itemId: null, purpose: "memory_consolidate", costCents: 2 });

    deleteItem(handle.db, item.id as Uuid);

    expect(listSideCalls(handle.db).map((row) => row.id)).toEqual([kept.id]);
  });
});
