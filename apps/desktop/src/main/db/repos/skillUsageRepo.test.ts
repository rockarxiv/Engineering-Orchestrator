import { SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, SKILLS_SETTLED_EVENT, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { ownRunsToSettle, skillDeliveriesQuery, skillLoadsQuery, skillsGivenToRunsInFlight, skillsLoadedByRun, skillUsageById, usageOfSkill } from "./skillUsageRepo.js";
import { appendRunEvent, appendSyncedRunEvents, archiveSkill, createRun, listSkillVersions, restoreSkillVersion, saveSkill } from "./index.js";

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
  /** The runs end, each having made every load it will (EO-720). */
  const settle = (ms: number, ...runIds: Uuid[]) => {
    for (const runId of runIds) at(ms, runId, SKILLS_SETTLED_EVENT, { type: SKILLS_SETTLED_EVENT });
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
    settle(5_000, one, two, three, four);

    const usage = skillUsageById(handle.db);
    expect(usageOfSkill(usage, "a")).toEqual({ runsDelivered: 4, runsLoaded: 2, lastLoadedAt: 2_500, deliveriesSinceLoad: 2 });
    // Never loaded: every run given it is in the stretch.
    expect(usageOfSkill(usage, "b")).toEqual({ runsDelivered: 3, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 3 });
    expect(usageOfSkill(usage, "never")).toEqual({ runsDelivered: 0, runsLoaded: 0, lastLoadedAt: null, deliveriesSinceLoad: 0 });
  });

  it("names the skills one run loaded, each once, in the order it first loaded them (EO-718)", () => {
    const [one, two] = [newRun(), newRun()];
    at(1_000, one, SKILL_LOADED_EVENT, loaded("b"));
    at(1_100, one, SKILL_LOADED_EVENT, loaded("a"));
    at(1_200, one, SKILL_LOADED_EVENT, loaded("b"));
    at(1_300, two, SKILL_LOADED_EVENT, loaded("c"));
    expect(skillsLoadedByRun(handle.db, one)).toEqual(["b", "a"]);
    expect(skillsLoadedByRun(handle.db, newRun())).toEqual([]);
  });

  it("starts the stretch again when a skill is loaded", () => {
    const [one, two] = [newRun(), newRun()];
    at(1_000, one, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_000, two, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_100, two, SKILL_LOADED_EVENT, loaded("a"));
    expect(usageOfSkill(skillUsageById(handle.db), "a").deliveriesSinceLoad).toBe(0);
  });

  it("starts the stretch again when a skill is restored (EO-720)", () => {
    const skill = saveSkill(handle.db, { slug: "a-skill", name: "A", description: "A.", body: "A.", files: [] }, 500);
    if (!skill.ok) throw new Error(skill.problems.join(" "));
    const id = skill.skill.id;
    const [one, two, three] = [newRun(), newRun(), newRun()];
    at(1_000, one, SKILLS_DELIVERED_EVENT, delivered([id]));
    at(2_000, two, SKILLS_DELIVERED_EVENT, delivered([id]));
    settle(2_200, one, two);
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(2);
    archiveSkill(handle.db, id, 2_500);
    const created = listSkillVersions(handle.db, id).find((version) => version.action === "create")!;
    restoreSkillVersion(handle.db, id, created.id, 3_000);
    expect(usageOfSkill(skillUsageById(handle.db), id).deliveriesSinceLoad).toBe(0);
    at(4_000, three, SKILLS_DELIVERED_EVENT, delivered([id]));
    settle(4_500, three);
    expect(usageOfSkill(skillUsageById(handle.db), id)).toMatchObject({ runsDelivered: 3, deliveriesSinceLoad: 1 });
  });

  it("counts a run in the stretch only once it has settled, and holds back the skills of an unsettled run however old (EO-720)", () => {
    const [one, two] = [newRun(), newRun()];
    at(1_000, one, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(2_000, two, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    settle(2_500, one);
    expect(usageOfSkill(skillUsageById(handle.db), "a")).toMatchObject({ runsDelivered: 2, deliveriesSinceLoad: 1 });
    // Finished long ago and never settled: still held back, since nothing says its transcript is all here.
    handle.db.run(sql`update runs set ended_at = 1 where id = ${two}`);
    expect([...skillsGivenToRunsInFlight(handle.db)]).toEqual(["a"]);
    settle(3_000, two);
    expect(usageOfSkill(skillUsageById(handle.db), "a").deliveriesSinceLoad).toBe(2);
    expect([...skillsGivenToRunsInFlight(handle.db)]).toEqual([]);
  });

  it("names this installation's own finished runs that have not settled, and never a run still going or one mirrored from another machine (EO-720)", () => {
    const [legacy, going, settled, mirrored] = [newRun(), newRun(), newRun(), newRun()];
    at(1_000, legacy, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(1_100, legacy, SKILL_LOADED_EVENT, loaded("a"));
    handle.db.run(sql`update runs set status = 'running' where id = ${going}`);
    at(1_200, going, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    at(1_300, settled, SKILLS_DELIVERED_EVENT, delivered(["a"]));
    settle(1_400, settled);
    appendSyncedRunEvents(handle.db, mirrored, "laptop", [{ seq: 0, ts: 1_500, type: SKILLS_DELIVERED_EVENT, payload: delivered(["a"]) }]);
    expect(ownRunsToSettle(handle.db)).toEqual([legacy]);
  });

  it("stores no count: the skills table has no usage column", () => {
    const columns = handle.db.all<{ name: string }>(sql`select name from pragma_table_info('skills')`).map((row) => row.name);
    expect(columns.filter((name) => /deliver|load|usage|count/i.test(name))).toEqual([]);
  });

  it.each([
    ["loads", skillLoadsQuery, ["idx_run_events_skill_loaded"]],
    ["deliveries", skillDeliveriesQuery, ["idx_run_events_skills_delivered", "idx_run_events_skill_loaded", "idx_run_events_skills_settled"]],
  ])("reads the %s through their partial indexes, not every transcript", (_, query, indexes) => {
    const plan = handle.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${query()}`)
      .map((row) => row.detail)
      .join("\n");
    for (const index of indexes) expect(plan).toContain(index);
  });
});
