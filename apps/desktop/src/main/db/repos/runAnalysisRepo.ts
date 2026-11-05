import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { centsOfMicrocents, MEMORY_DELIVERED_EVENT, MEMORY_USED_EVENT, MICROCENTS_PER_CENT, type RunFilters, type RunRecord } from "@eo/core";
import type { Db } from "../client.js";
import { items, runEvents, runs, sideCalls } from "../schema.js";

/**
 * Runs across items, for timing and spend (EO-541).
 *
 * Every filter is a term of the statement that reads the rows, so a call
 * narrowed to one item or one week reads that item's or that week's runs
 * and not the installation's. Side calls are read by a second statement
 * under the same filters and listed beside the runs as the action
 * `side_call:<purpose>`, so what they cost is in the same answer as what
 * the runs cost (EO-477).
 *
 * Runs and side calls about a preview are left out, for the reason every
 * spend reader in `runsRepo.ts` leaves them out (EO-313): a rehearsal is
 * not work and spent nothing real.
 */

/** The action a side call is listed under. */
export const SIDE_CALL_ACTION_PREFIX = "side_call:";

/**
 * A review's verdict, out of the half of `runs.result` the engine acted
 * on — `{ raw, parsed }` since A-02, so `$.parsed.verdict` — or out of the
 * result itself on a row written before then, which held only the parsed
 * value. The same rule `parsedResultOf` reads a result by, asked in the
 * statement so a result is not read whole to keep one string of it.
 * Guarded by `json_valid`, so a row that is not JSON answers null rather
 * than failing the read.
 */
const verdictOf = sql<string | null>`case when json_valid(${runs.result}) then (
  case when json_type(${runs.result}, '$.parsed') is not null
    then (case when json_type(${runs.result}, '$.parsed.verdict') = 'text' then json_extract(${runs.result}, '$.parsed.verdict') end)
    else (case when json_type(${runs.result}, '$.verdict') = 'text' then json_extract(${runs.result}, '$.verdict') end)
  end) end`;

/**
 * The model the run was answered by, in its own log's words (EO-392):
 * the newest `thread_started` or `usage` row that names one. A
 * `thread_started` names the model the backend opened or resumed the
 * thread on; a `usage` the one a turn was spent on, which a backend may
 * have moved the turn to since. Never the agent's configured model, which
 * is today's setting and not what a finished run ran on — so a run whose
 * log names none is null, not a guess.
 *
 * The `type IN (...)` is a literal, spelled as migration 0133's partial
 * index spells it, because SQLite uses a partial index only when the
 * statement says what the index says. `run_events` is append-only, so
 * what this reads never changes once written.
 */
const modelOf = sql<string | null>`(select json_extract(${runEvents.payload}, '$.model') from ${runEvents}
  where ${runEvents.runId} = ${runs.id} and ${runEvents.type} IN ('thread_started', 'usage')
    and json_valid(${runEvents.payload}) and json_type(${runEvents.payload}, '$.model') = 'text'
  order by ${runEvents.seq} desc limit 1)`;

/**
 * The backend that ran it, as the run recorded when it was dispatched
 * (A-07) — never its agent's, which can change after. Null where EO ran
 * the step itself (`builtin`, `module`), and on a row that never named
 * one: a guard's placeholder, or a run written before the column.
 */
const backendOf = sql<string | null>`case when ${runs.provider} in ('builtin', 'module') then null else ${runs.provider} end`;

/**
 * How many distinct memory entries one kind of the run's own events names
 * (EO-597): `memory_delivered` for what it was given, `memory_used` for
 * what its answer said it relied on of that. Read by the run's id, which
 * is the leading half of the table's key, so each run reads its own
 * events and no other's.
 */
const memoryCountOf = (type: string) =>
  sql<number>`(select count(distinct given.value) from ${runEvents} e
    join json_each(e.payload, '$.entryIds') given
    where e.run_id = ${runs.id} and e.type = ${sql.raw(`'${type}'`)})`;

function runTerms(filters: RunFilters): SQL[] {
  const terms: SQL[] = [isNull(items.previewAt)];
  if (filters.itemId !== undefined) terms.push(eq(runs.itemId, filters.itemId));
  if (filters.projectId !== undefined) terms.push(eq(items.projectId, filters.projectId));
  if (filters.action !== undefined) terms.push(eq(runs.action, filters.action));
  if (filters.backend !== undefined) terms.push(sql`${backendOf} = ${filters.backend}`);
  if (filters.status !== undefined) terms.push(eq(runs.status, filters.status));
  if (filters.threadId !== undefined) terms.push(eq(runs.threadId, filters.threadId));
  if (filters.startedSince !== undefined) terms.push(sql`${runs.startedAt} >= ${filters.startedSince}`);
  if (filters.startedUntil !== undefined) terms.push(sql`${runs.startedAt} < ${filters.startedUntil}`);
  return terms;
}

/**
 * The side calls' terms, or null where the filters leave none of them in:
 * an action that is not a side call's, or a thread, which none has.
 */
function sideCallTerms(filters: RunFilters): SQL[] | null {
  if (filters.threadId !== undefined) return null;
  if (filters.action !== undefined && !filters.action.startsWith(SIDE_CALL_ACTION_PREFIX)) return null;
  const terms: SQL[] = [or(isNull(sideCalls.itemId), isNull(items.previewAt))!];
  if (filters.itemId !== undefined) terms.push(eq(sideCalls.itemId, filters.itemId));
  if (filters.projectId !== undefined) terms.push(eq(sideCalls.projectId, filters.projectId));
  if (filters.action !== undefined) terms.push(eq(sideCalls.purpose, filters.action.slice(SIDE_CALL_ACTION_PREFIX.length)));
  if (filters.backend !== undefined) terms.push(eq(sideCalls.backend, filters.backend));
  if (filters.status !== undefined) terms.push(eq(sideCalls.outcome, filters.status));
  if (filters.startedSince !== undefined) terms.push(sql`${sideCalls.startedAt} >= ${filters.startedSince}`);
  if (filters.startedUntil !== undefined) terms.push(sql`${sideCalls.startedAt} < ${filters.startedUntil}`);
  return terms;
}

function runRecords(db: Db, filters: RunFilters): RunRecord[] {
  return db
    .select({
      id: runs.id,
      itemId: runs.itemId,
      itemKey: items.key,
      projectId: items.projectId,
      action: runs.action,
      backend: backendOf,
      model: modelOf,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      costCents: runs.costCents,
      turns: runs.turns,
      turnsScope: runs.turnsScope,
      attempt: runs.attempt,
      threadId: runs.threadId,
      interruption: runs.interruption,
      verdict: verdictOf,
      memoryDelivered: memoryCountOf(MEMORY_DELIVERED_EVENT),
      memoryUsed: memoryCountOf(MEMORY_USED_EVENT),
    })
    .from(runs)
    .innerJoin(items, eq(items.id, runs.itemId))
    .where(and(...runTerms(filters)))
    .all()
    .map((row) => ({
      ...row,
      kind: "run" as const,
      durationMs: durationOf(row.startedAt, row.endedAt),
      costMicrocents: row.costCents === null ? null : row.costCents * MICROCENTS_PER_CENT,
      turnsScope: row.turnsScope === "turn" || row.turnsScope === "session" ? row.turnsScope : null,
      model: typeof row.model === "string" ? row.model : null,
      verdict: typeof row.verdict === "string" ? row.verdict : null,
      memoryDelivered: Number(row.memoryDelivered ?? 0),
      memoryUsed: Number(row.memoryUsed ?? 0),
    }));
}

function sideCallRecords(db: Db, filters: RunFilters): RunRecord[] {
  const terms = sideCallTerms(filters);
  if (terms === null) return [];
  return db
    .select({
      id: sideCalls.id,
      itemId: sideCalls.itemId,
      itemKey: items.key,
      projectId: sideCalls.projectId,
      purpose: sideCalls.purpose,
      backend: sideCalls.backend,
      model: sideCalls.model,
      outcome: sideCalls.outcome,
      startedAt: sideCalls.startedAt,
      durationMs: sideCalls.durationMs,
      tokensIn: sideCalls.tokensIn,
      tokensOut: sideCalls.tokensOut,
      costMicrocents: sideCalls.costMicrocents,
    })
    .from(sideCalls)
    .leftJoin(items, eq(items.id, sideCalls.itemId))
    .where(and(...terms))
    .all()
    .map((row) => ({
      id: row.id,
      kind: "side_call" as const,
      itemId: row.itemId,
      itemKey: row.itemKey,
      projectId: row.projectId,
      action: `${SIDE_CALL_ACTION_PREFIX}${row.purpose}`,
      backend: row.backend,
      model: row.model,
      status: row.outcome,
      startedAt: row.startedAt,
      endedAt: row.startedAt + row.durationMs,
      durationMs: row.durationMs,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      // A side call records no cache figures, turns or thread: one
      // question, one answer, on no conversation.
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costCents: centsOfMicrocents(row.costMicrocents),
      costMicrocents: row.costMicrocents,
      turns: null,
      turnsScope: null,
      attempt: null,
      threadId: null,
      interruption: null,
      verdict: null,
      memoryDelivered: null,
      memoryUsed: null,
    }));
}

function durationOf(startedAt: number | null, endedAt: number | null): number | null {
  return startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt);
}

/**
 * Every run and side call the filters match, newest first — a run not yet
 * started last, since it has no moment to be placed at — and by id within
 * one millisecond, so the order is the same on every read.
 */
export function listRunRecords(db: Db, filters: RunFilters): RunRecord[] {
  return [...runRecords(db, filters), ...sideCallRecords(db, filters)].sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      if (a.startedAt === null) return 1;
      if (b.startedAt === null) return -1;
      return b.startedAt - a.startedAt;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
