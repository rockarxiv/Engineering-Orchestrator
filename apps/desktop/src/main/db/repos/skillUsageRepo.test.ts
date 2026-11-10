import { SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { skillDeliveriesQuery, skillLoadsQuery, skillUsageById, usageOfSkill } from "./skillUsageRepo.js";
import { appendRunEvent, createRun } from "./index.js";

/** How each skill was given to runs and loaded by them, counted from run_events (EO-715). */
describe("skill usage by id", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    handle.close();
  });

  const delivered = (skillIds: string[]) => ({ type: SKILLS_DELIVERED_EVENT, skillIds, slugs: skillIds.map((id) => `slug-${id}`) });
  const loaded = (skillId: string) => ({ type: SKILL_LOADED_EVENT, skillId, slug: `slug-${skillId}` });
  const newRun = () => {
    const item = createTestItem(handle.db, { type: "story", title: "T", stepId: "todo" });
    return createRun(handle.db, { itemId: item.id, agentId: null, action: "implement", status: "succeeded" }).id;
  };
  const at = (ms: number, runId: Uuid, type: string, payload: unknown) => {
    vi.setSystemTime(ms);
    appendRunEvent(handle.db, runId, type, payload);
  };

  it("counts runs given a skill, runs that loaded it, its last load and the deliveries since", () => {
    const [one, two, three, four] = [newRun(), newRun(), newRun(), newRun()];
    at(1_000, one, SKILLS_DELIVERED_EVENT, delivered(["a", "b"]));
    at(1_100, one, SKILL_LOADED_EVENT, loaded("a"));
    // Loaded twice in one run is one loaded run.
    at(1_200, one, SKILL_LOADED_EVENT, loaded("a"));
    at(2_000, two, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_500, two, SKILL_LOADED_EVENT, loaded("a"));
    at(3_000, three, SKILLS_DELIVERED_EVENT, delivered(["a", "b"]));
    at(4_000, four, SKILLS_DELIVERED_EVENT, delivered(["a", "b"]));

    const usage = skillUsageById(handle.db);
    expect(usageOfSkill(usage, "a")).toEqual({ runsDelivered: 4, runsLoaded: 2, lastLoadedAt: 2_500, deliveriesSinceLoad: 2 });
    // Never loaded: every run given it is in the stretch.
    expect(usageOfSkill(usage, "b")).toEqual({ runsDelivered: 3, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 3 });
    expect(usageOfSkill(usage, "never")).toEqual({ runsDelivered: 0, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 0 });
  });

  it("starts the stretch again when a skill is loaded", () => {
    const [one, two] = [newRun(), newRun()];
    at(1_000, one, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_000, two, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_100, two, SKILL_LOADED_EVENT, loaded("a"));
    expect(usageOfSkill(skillUsageById(handle.db), "a").deliveriesSinceLoad).toBe(0);
  });

  it("stores no count: the skills table has no usage column", () => {
    const columns = handle.db.all<{ name: string }>(sql`select name from pragma_table_info('skills')`).map((row) => row.name);
    expect(columns.filter((name) => /deliver|load|usage|count/i.test(name))).toEqual([]);
  });

  it.each([
    ["loads", skillLoadsQuery, ["idx_run_events_skill_loaded"]],
    ["deliveries", skillDeliveriesQuery, ["idx_run_events_skills_delivered", "idx_run_events_skill_loaded"]],
  ])("reads the %s through their partial indexes, not every transcript", (_, query, indexes) => {
    const plan = handle.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${query()}`)
      .map((row) => row.detail)
      .join("\n");
    for (const index of indexes) expect(plan).toContain(index);
  });
});
