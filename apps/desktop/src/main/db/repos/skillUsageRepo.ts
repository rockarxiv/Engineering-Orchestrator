import { sql } from "drizzle-orm";
import { NO_SKILL_USAGE, SKILL_LOADED_EVENT, SKILLS_DELIVERED_EVENT, type SkillUsage } from "@eo/core";
import type { Db } from "../client.js";
import { runEvents } from "../schema.js";

/**
 * How each skill has been used (EO-715): the runs given it, the runs that
 * loaded it, when it was last loaded, and how many runs have been given
 * it since. Derived from the `skills_delivered` and `skill_loaded` run
 * events every time it is asked, as memory's deliveries and uses are
 * (`memoryUseRepo.ts`) — no count is stored anywhere. Read-only, like
 * every reader of `run_events` (invariant 3).
 *
 * Every skill either event has ever named; a skill not in the map was
 * never delivered and never loaded (`usageOfSkill`).
 */
export function skillUsageById(db: Db): Map<string, SkillUsage> {
  const usage = new Map<string, SkillUsage>();
  for (const row of db.all<{ id: string; runs: number; at: number }>(skillLoadsQuery())) {
    usage.set(row.id, { ...NO_SKILL_USAGE, runsLoaded: row.runs, lastLoadedAt: row.at });
  }
  for (const row of db.all<{ id: string; runs: number; since: number }>(skillDeliveriesQuery())) {
    const entry = usage.get(row.id) ?? { ...NO_SKILL_USAGE };
    usage.set(row.id, { ...entry, runsDelivered: row.runs, deliveriesSinceLoad: row.since });
  }
  return usage;
}

/** One skill's usage out of the map, none where it has never been counted. */
export function usageOfSkill(usage: ReadonlyMap<string, SkillUsage>, id: string): SkillUsage {
  return usage.get(id) ?? NO_SKILL_USAGE;
}

/**
 * The runs that loaded each skill, and the newest load. `type` is a
 * literal so SQLite reads `idx_run_events_skill_loaded` (migration 0161)
 * rather than every line of every transcript; exported for the test that
 * holds it to the index.
 */
export function skillLoadsQuery() {
  return sql`
    with loads as materialized (
      select run_id, ts, payload from ${runEvents} where type = ${sql.raw(`'${SKILL_LOADED_EVENT}'`)}
    )
    select json_extract(payload, '$.skillId') as "id", count(distinct run_id) as "runs", max(ts) as "at"
    from loads
    group by 1
  `;
}

/**
 * The runs given each skill, and how many of them were given it after
 * its newest load — all of them, for a skill never loaded. Both kinds of
 * row are read through their partial indexes, for the reason
 * `skillLoadsQuery` gives.
 */
export function skillDeliveriesQuery() {
  return sql`
    with deliveries as materialized (
      select run_id, ts, payload from ${runEvents} where type = ${sql.raw(`'${SKILLS_DELIVERED_EVENT}'`)}
    ),
    loads as materialized (
      select ts, payload from ${runEvents} where type = ${sql.raw(`'${SKILL_LOADED_EVENT}'`)}
    ),
    newest as (
      select json_extract(payload, '$.skillId') as id, max(ts) as at from loads group by 1
    )
    select given.value as "id",
      count(distinct d.run_id) as "runs",
      count(distinct case when newest.at is null or d.ts > newest.at then d.run_id end) as "since"
    from deliveries d
    join json_each(d.payload, '$.skillIds') given
    left join newest on newest.id = given.value
    group by given.value
  `;
}

/**
 * The skills one run loaded (EO-718), by id, in the order it first loaded
 * them: what the learning review is told it should patch first.
 */
export function skillsLoadedByRun(db: Db, runId: string): string[] {
  const rows = db.all<{ id: string | null }>(sql`
    select json_extract(payload, '$.skillId') as "id" from ${runEvents}
    where type = ${sql.raw(`'${SKILL_LOADED_EVENT}'`)} and run_id = ${runId}
    order by seq
  `);
  return [...new Set(rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])))];
}
