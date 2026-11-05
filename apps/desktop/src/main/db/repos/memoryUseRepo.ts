import { and, eq, inArray, sql } from "drizzle-orm";
import { MEMORY_DELIVERED_EVENT, MEMORY_USED_EVENT, MemoryDeliveredEventSchema, type MemoryUsage, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { runEvents, runs } from "../schema.js";

/**
 * Whether the memory a run was given was used (EO-597, ARCHITECTURE.md
 * §7.5): what a run was delivered, for holding its `memoryUsed` to, and
 * how often each entry was delivered and used, for the Memory section and
 * `memories_search`. Read-only, like every reader of `run_events`
 * (invariant 3).
 */

/**
 * Every entry a run was given: its own `memory_delivered` events, and
 * those of the earlier runs on its item that share its thread.
 *
 * The thread's as well as the run's own, because a run carrying a thread
 * on — a continuation after an interruption, which chooses no memory
 * again — answers from a conversation that already holds what the run
 * before it was given. Its item's runs only, so a thread id two backends
 * happened to share would not lend one item's memory to another.
 */
export function memoryDeliveredToRun(db: Db, runId: Uuid, itemId: Uuid, threadId: string | null): Set<string> {
  const runIds = new Set<string>([runId]);
  if (threadId !== null) {
    for (const row of db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.itemId, itemId), eq(runs.threadId, threadId)))
      .all())
      runIds.add(row.id);
  }
  const delivered = new Set<string>();
  const rows = db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(inArray(runEvents.runId, [...runIds]), eq(runEvents.type, MEMORY_DELIVERED_EVENT)))
    .all();
  for (const row of rows) {
    const parsed = MemoryDeliveredEventSchema.safeParse(row.payload);
    if (parsed.success) for (const id of parsed.data.entryIds) delivered.add(id);
  }
  return delivered;
}

/**
 * How many runs were given each entry, and how many said they relied on
 * it — every entry either has ever been counted for. An entry not in the
 * map was never delivered and never used.
 *
 * `type` is a literal in each statement so SQLite reads the partial
 * indexes over those rows (`idx_run_events_memory_delivered`, migration
 * 0127; `idx_run_events_memory_used`, 0151) rather than every line of
 * every transcript.
 */
export function memoryUsageByEntry(db: Db): Map<string, MemoryUsage> {
  const usage = new Map<string, MemoryUsage>();
  const tally = (type: string, field: keyof MemoryUsage) => {
    const rows = db.all<{ id: string; runs: number }>(memoryUsageQuery(type));
    for (const row of rows) {
      const entry = usage.get(row.id) ?? { deliveries: 0, uses: 0 };
      entry[field] = row.runs;
      usage.set(row.id, entry);
    }
  };
  tally(MEMORY_DELIVERED_EVENT, "deliveries");
  tally(MEMORY_USED_EVENT, "uses");
  return usage;
}

/**
 * The statement behind it for one kind of event, exported for the test
 * that holds it to the partial index. Materialised first, as
 * `runsDeliveredFromScopeQuery` is, so the events are read once through
 * the index before their ids are unpacked.
 */
export function memoryUsageQuery(type: string) {
  return sql`
    with events as materialized (
      select run_id, payload from ${runEvents} where type = ${sql.raw(`'${type}'`)}
    )
    select given.value as "id", count(distinct e.run_id) as "runs"
    from events e
    join json_each(e.payload, '$.entryIds') given
    group by given.value
  `;
}

/** One entry's usage out of the map, none where it has never been counted. */
export function usageOf(usage: ReadonlyMap<string, MemoryUsage>, id: string): MemoryUsage {
  return usage.get(id) ?? { deliveries: 0, uses: 0 };
}
