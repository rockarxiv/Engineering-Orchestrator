import { and, desc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  MEMORY_DELIVERED_EVENT,
  uuidv7,
  type MemoryConsolidationCursor,
  type MemoryConsolidationOperations,
  type MemoryConsolidationStatus,
  type MemoryConsolidationTrigger,
  type MemoryConsolidationView,
  type MemoryEntryView,
  type MemoryScope,
  type MemoryScopeKind,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { memories, memoryConsolidations, runEvents } from "../schema.js";
import { addMemory, getMemory, memoryEntryProjectId, restoreMemory, retireMemory } from "./memoriesRepo.js";

/**
 * Memory consolidations (EO-480, ARCHITECTURE.md, "What an agent is
 * given").
 *
 * The one module that writes `memory_consolidations`, and the only one
 * that retires entries as `consolidated`. Nothing here deletes: a
 * consolidation retires what it replaced and writes what it returned, and
 * a restore reactivates the first and retires the second.
 */

type Row = typeof memoryConsolidations.$inferSelect;

function toView(row: Row): MemoryConsolidationView {
  return {
    id: row.id,
    scope: { kind: row.scopeKind as MemoryScopeKind, id: row.scopeId },
    trigger: row.trigger as MemoryConsolidationTrigger,
    status: row.status as MemoryConsolidationStatus,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    restoredAt: row.restoredAt,
    retiredIds: row.retiredIds,
    writtenIds: row.writtenIds,
    note: row.note,
  };
}

function inScope(scope: MemoryScope) {
  return and(eq(memoryConsolidations.scopeKind, scope.kind), eq(memoryConsolidations.scopeId, scope.id))!;
}

export function getConsolidation(db: Db, id: string): MemoryConsolidationView | undefined {
  const row = db.select().from(memoryConsolidations).where(eq(memoryConsolidations.id, id)).get();
  return row ? toView(row) : undefined;
}

/**
 * A scope's consolidations, newest first — every one of them, or a page:
 * at most `limit`, strictly older than `before` (EO-545). Ordered on when
 * each started and then its id, which is what a cursor names, so pages
 * neither overlap nor skip one started in the same millisecond.
 */
export function listConsolidations(db: Db, scope: MemoryScope, page: { before?: MemoryConsolidationCursor; limit?: number } = {}): MemoryConsolidationView[] {
  const { before, limit } = page;
  const query = db
    .select()
    .from(memoryConsolidations)
    .where(
      and(
        inScope(scope),
        before === undefined
          ? undefined
          : sql`(${memoryConsolidations.startedAt} < ${before.startedAt} or (${memoryConsolidations.startedAt} = ${before.startedAt} and ${memoryConsolidations.id} < ${before.id}))`,
      ),
    )
    .orderBy(desc(memoryConsolidations.startedAt), desc(memoryConsolidations.id));
  return (limit === undefined ? query.all() : query.limit(limit).all()).map(toView);
}

/** A consolidation begun: its row, `running`, whose id the entries it touches will carry. */
export function startConsolidation(
  db: Db,
  input: {
    scope: MemoryScope;
    trigger: MemoryConsolidationTrigger;
    now: number;
    id?: Uuid;
    /** The `started_at` of the run this row's retry goes on with (EO-913); absent for a run's own rows. */
    continuesRun?: number;
  },
): MemoryConsolidationView {
  const row: Row = {
    id: input.id ?? (uuidv7() as Uuid),
    scopeKind: input.scope.kind,
    scopeId: input.scope.id,
    trigger: input.trigger,
    status: "running",
    startedAt: input.now,
    finishedAt: null,
    restoredAt: null,
    retiredIds: [],
    writtenIds: [],
    failureReason: null,
    note: null,
    capsEntries: null,
    capsChars: null,
    // Counted from nothing: a consolidation that makes no side call held no slot (EO-577).
    slotHeldMs: 0,
    stuckNoticedAt: null,
    endsRun: false,
    continuesRun: input.continuesRun ?? null,
  };
  db.insert(memoryConsolidations).values(row).run();
  return toView(row);
}

/**
 * Adds the time one of its side calls held a global slot to a
 * consolidation's (EO-577): a batch's call, either of the cross-batch
 * pass's, or the skill proposal call posted under it.
 */
export function addConsolidationSlotTime(db: Db, id: string, ms: number): void {
  if (!(ms > 0)) return;
  db.update(memoryConsolidations)
    .set({ slotHeldMs: sql`coalesce(${memoryConsolidations.slotHeldMs}, 0) + ${Math.round(ms)}` })
    .where(eq(memoryConsolidations.id, id))
    .run();
}

/** How long a consolidation's side calls held a global slot, or null for one recorded before that was counted (EO-577). */
export function consolidationSlotTime(db: Db, id: string): number | null {
  return db.select({ ms: memoryConsolidations.slotHeldMs }).from(memoryConsolidations).where(eq(memoryConsolidations.id, id)).get()?.ms ?? null;
}

/**
 * Marks a consolidation as the last row of a run that finished (EO-913):
 * what moves the point a scheduled consolidation's new entries are
 * counted from. Asked once every batch of the run, and its cross-batch
 * pass where it had one, has applied — so a run EO quit part-way through
 * never is, whatever its rows say.
 */
export function markConsolidationRunFinished(db: Db, id: string): void {
  db.update(memoryConsolidations).set({ endsRun: true }).where(eq(memoryConsolidations.id, id)).run();
}

/** Marks the failure EO said its scope is stuck at (EO-577), so the same run of failures is not said again. */
export function markConsolidationStuckNoticed(db: Db, id: string, now: number): void {
  db.update(memoryConsolidations).set({ stuckNoticedAt: now }).where(eq(memoryConsolidations.id, id)).run();
}

/** A consolidation that changed nothing, and why. `reason` is the side call's failure reason, or `changed`/`error` for EO's own. */
export function failConsolidation(db: Db, id: string, input: { reason: string; note: string; now: number }): void {
  db.update(memoryConsolidations)
    .set({ status: "failed", finishedAt: input.now, failureReason: input.reason, note: input.note })
    .where(eq(memoryConsolidations.id, id))
    .run();
}

/**
 * Adds a sentence to a consolidation's note, after it finished — what
 * became of the skills it proposed, where one could not be posted
 * (EO-483). The row's status and lists are left as they are.
 */
export function appendConsolidationNote(db: Db, id: string, note: string): void {
  const current = getConsolidation(db, id);
  if (!current) return;
  db.update(memoryConsolidations)
    .set({ note: current.note === null ? note : `${current.note} ${note}` })
    .where(eq(memoryConsolidations.id, id))
    .run();
}

/** A consolidation that changed nothing on purpose, said once, as its own row: a `container_done` whose container's work was reopened before it started (EO-596). */
export function recordSkippedConsolidation(db: Db, input: { scope: MemoryScope; trigger: MemoryConsolidationTrigger; note: string; now: number }): MemoryConsolidationView {
  const started = startConsolidation(db, input);
  skipConsolidation(db, started.id, input);
  return getConsolidation(db, started.id)!;
}

/**
 * Closes a consolidation already begun as one that changed nothing on
 * purpose, rather than failed: a `container_done` whose container's work
 * was reopened before its answer could be applied (EO-596). Settles the
 * scope as it is, and backs nothing off.
 */
export function skipConsolidation(db: Db, id: string, input: { note: string; now: number }): void {
  // A skip settles the scope, but never finishes a run (EO-913): it
  // changed nothing, so the entries it, or the batches it stopped, would
  // have been given were never looked at.
  db.update(memoryConsolidations).set({ status: "skipped", finishedAt: input.now, note: input.note }).where(eq(memoryConsolidations.id, id)).run();
}

/**
 * Closes as failed every consolidation still `running` — what a process
 * that stopped mid-call leaves. Asked at start, before any new one, so a
 * scope is never stuck waiting on a call nobody is making.
 */
export function closeAbandonedConsolidations(db: Db, now: number): number {
  return db
    .update(memoryConsolidations)
    .set({ status: "failed", finishedAt: now, failureReason: "error", note: "EO stopped while this consolidation was running, so it changed nothing." })
    .where(eq(memoryConsolidations.status, "running"))
    .run().changes;
}

/** What the scheduler needs to know about a scope's consolidations. */
export interface ScopeConsolidationState {
  /** The last time the scope was consolidated, or a person restored a consolidation; null if never. */
  lastConsolidatedAt: number | null;
  /**
   * The last time the scope was settled — a consolidation (as of the
   * moment it read the entries it was given), a skip, or a restore; null
   * if never.
   */
  settled: { at: number } | null;
  /**
   * Failures since the last row that was not one, newest first: each one's
   * row, what it was queued for, when it finished, its reason and note,
   * and whether the note saying the scope is stuck was posted at it
   * (EO-577).
   */
  failuresSince: {
    id: string;
    trigger: MemoryConsolidationTrigger;
    finishedAt: number;
    reason: string | null;
    note: string | null;
    stuckNoticed: boolean;
    /**
     * Whether a consolidation of the same run — a batch, or the fold of
     * exact duplicates, under the same trigger and started at the same
     * moment or by a retry that went on with it (`continues_run`) — was
     * applied before it failed (EO-913): a run that stopped part-way,
     * rather than one that failed before it changed anything.
     */
    afterApplied: boolean;
    /** The run it is a row of: the `started_at` of the run's first attempt (`continues_run`, or its own). */
    run: number;
  }[];
  running: boolean;
}

/**
 * When a settling row wrote the entries it lists: a consolidation when it
 * finished, a restore when it was made. A skip writes none.
 */
function writtenAt(row: Row): number | null {
  if (row.status === "succeeded") return row.finishedAt;
  if (row.status === "restored") return row.restoredAt;
  return null;
}

/**
 * When a row settled its scope, or null for one that did not: a
 * consolidation as of when it read its entries — anything written after
 * that, even while it ran, is a change it did not see — a restore when it
 * was made, a skip when it was recorded.
 */
function settledAt(row: Row): number | null {
  if (row.status === "succeeded") return row.startedAt;
  if (row.status === "restored") return row.restoredAt;
  if (row.status === "skipped") return row.finishedAt;
  return null;
}

/**
 * A scope's newest consolidation rows, newest first: what its failures
 * in a row and whether one is running are read from — enough for the
 * backoff, and for nothing that looks further back. When the scope was
 * last consolidated or settled, and whether a run applied anything, are
 * looked up over every row (`consolidationState`), so however many
 * failed, paused or deferred rows came since, they are found.
 */
function recentRows(db: Db, scope: MemoryScope): Row[] {
  return db
    .select()
    .from(memoryConsolidations)
    .where(inScope(scope))
    .orderBy(desc(memoryConsolidations.startedAt), desc(memoryConsolidations.id))
    .limit(200)
    .all();
}

export function consolidationState(db: Db, scope: MemoryScope): ScopeConsolidationState {
  const rows = recentRows(db, scope);
  // Over every row of the scope, not only the newest: a run that applied
  // a batch and then stopped, deferred or paused hundreds of times since,
  // still settled the scope then.
  const times = db.get<{ consolidated: number | null; settled: number | null }>(sql`
    select
      max(case when status in ('succeeded', 'restored') then max(coalesce(finished_at, started_at), coalesce(restored_at, 0)) end) as "consolidated",
      max(case status when 'succeeded' then started_at when 'restored' then restored_at when 'skipped' then finished_at end) as "settled"
    from ${memoryConsolidations}
    where scope_kind = ${scope.kind} and scope_id = ${scope.id}
  `);
  const failed: Row[] = [];
  for (const row of rows.filter((candidate) => candidate.status !== "running")) {
    if (row.status !== "failed") break;
    failed.push(row);
  }
  // A run is the rows started at one moment under one trigger, with the
  // rows of the retries that went on with it (`continues_run`). Whether
  // one of them applied is asked of every row, however old.
  const runOf = (row: Row) => row.continuesRun ?? row.startedAt;
  const applied = new Map<string, boolean>();
  const appliedRun = (row: Row) => {
    const key = `${runOf(row)}:${row.trigger}`;
    if (!applied.has(key)) applied.set(key, runApplied(db, scope, runOf(row), row.trigger as MemoryConsolidationTrigger));
    return applied.get(key)!;
  };
  return {
    lastConsolidatedAt: times?.consolidated ?? null,
    settled: times?.settled === null || times?.settled === undefined ? null : { at: times.settled },
    failuresSince: failed.map((row) => ({
      id: row.id,
      trigger: row.trigger as MemoryConsolidationTrigger,
      finishedAt: row.finishedAt ?? row.startedAt,
      reason: row.failureReason,
      note: row.note,
      stuckNoticed: row.stuckNoticedAt !== null,
      afterApplied: appliedRun(row),
      run: runOf(row),
    })),
    running: rows.some((row) => row.status === "running"),
  };
}

/**
 * Whether a row of a run — the rows started at `run` under `trigger`, and
 * those of the retries that went on with it (`continues_run`) — applied
 * (EO-913), over every row of the scope.
 */
function runApplied(db: Db, scope: MemoryScope, run: number, trigger: MemoryConsolidationTrigger): boolean {
  return (
    db.get<{ found: number }>(sql`
      select 1 as "found" from ${memoryConsolidations}
      where scope_kind = ${scope.kind} and scope_id = ${scope.id} and "trigger" = ${trigger}
        and status = 'succeeded' and coalesce(continues_run, started_at) = ${run}
      limit 1
    `) !== undefined
  );
}

/**
 * The scope's active agent-written entries written or changed since its
 * last consolidation (EO-913): what a `schedule` consolidation is given,
 * each with its nearest neighbours, so its cost follows new notes and
 * not the size of memory. Ids, oldest first.
 *
 * "Since its last consolidation" is since the last one that finished:
 * every row of one run starts at the moment it read its entries
 * (EO-574), and the newest run whose last row says it finished
 * (`ends_run`, `markConsolidationRunFinished`) is the point counted from.
 * A run that stopped part-way never says so — a batch failed, EO was
 * paused, or EO quit between two batches and left no row at all for the
 * rest — so the entries its unfinished batches were to be given are
 * still new when it is taken up again, after a restart as well. Rows from
 * before that was recorded say nothing, and their run counts as finished
 * where it applied something and none of them failed or was skipped
 * (`lastFinishedRunAt`). A skip is never a point — a `container_done`
 * whose work reopened, or one of the old cap trigger's that left agents'
 * entries as they were because people's alone were over it, changed
 * nothing — and nor is a person's restore: it says what it put back is
 * to stay, not that everything else was tidied.
 *
 * What a consolidation or a restore itself wrote, as it wrote it, is not
 * new: what a run merged or rewrote, and what a restore put back — the
 * entries it lists, and those a skill had taken (`moved_to_skill`), which
 * keep its id — which a person keeping is not a reason to fold again. A
 * later edit or restore of one by hand is new. With `until`, only what
 * was last written by then: what a run that read its entries then had
 * to give, which is what its retry goes on with. Anything else is, whoever
 * wrote it — an agent's note, an edit — including what was written while
 * a run was going. A scope never consolidated is new through and through.
 */
export function entriesNewSinceConsolidated(db: Db, scope: MemoryScope, options: { until?: number } = {}): string[] {
  const since = lastFinishedRunAt(db, scope);
  // Every row that settled the scope since, however many there are: what
  // they wrote is theirs, not new.
  const later =
    since === null
      ? []
      : db
          .select()
          .from(memoryConsolidations)
          .where(and(inScope(scope), or(gte(memoryConsolidations.startedAt, since), gte(memoryConsolidations.restoredAt, since))))
          .all()
          .filter((row) => (settledAt(row) ?? row.startedAt) >= since && writtenAt(row) !== null);
  const own = new Set(later.flatMap((row) => [...row.retiredIds, ...row.writtenIds].map((id) => `${id}@${writtenAt(row)}`)));
  // A restore puts back, at its moment, what a skill took from it too:
  // those keep its id, and are named on no list of it.
  const restoredBy = new Map(later.filter((row) => row.status === "restored").map((row) => [row.id, row.restoredAt]));
  return db
    .select({ id: memories.id, updatedAt: memories.updatedAt, consolidationId: memories.consolidationId })
    .from(memories)
    .where(
      and(
        eq(memories.scopeKind, scope.kind),
        eq(memories.scopeId, scope.id),
        isNull(memories.retiredAt),
        ne(memories.sourceKind, "person"),
        ...(since === null ? [] : [gte(memories.updatedAt, since)]),
        ...(options.until === undefined ? [] : [lte(memories.updatedAt, options.until)]),
      ),
    )
    .orderBy(memories.createdAt, memories.id)
    .all()
    .filter((row) => !own.has(`${row.id}@${row.updatedAt}`) && !(row.consolidationId !== null && restoredBy.get(row.consolidationId) === row.updatedAt))
    .map((row) => row.id);
}

/**
 * When the scope's newest finished run read its entries, or null where
 * none has finished (EO-913) — looked up on its own, so however many
 * failed or unfinished rows came after it, the run that finished is
 * found. A run is the rows started at one moment under one trigger, with
 * those of the retries that went on with it, and it read its entries when
 * its first attempt did (`continues_run`): what a retry was not given —
 * an entry written after that, which a scheduled retry leaves to the
 * schedule — is still new once it finishes. It
 * finished where one of its rows says so (`ends_run`); a run from before
 * that was recorded (every row null) where it applied something and none
 * of its rows failed, was still running or was skipped. A skip alone
 * never finishes one: it changed nothing, so nothing was looked at.
 */
export function lastFinishedRunAt(db: Db, scope: MemoryScope): number | null {
  const recorded =
    db
      .select({ at: sql<number | null>`max(coalesce(${memoryConsolidations.continuesRun}, ${memoryConsolidations.startedAt}))` })
      .from(memoryConsolidations)
      .where(and(inScope(scope), eq(memoryConsolidations.endsRun, true)))
      .get()?.at ?? null;
  const legacy =
    db.get<{ at: number | null }>(sql`
      select max(run.started_at) as "at"
      from ${memoryConsolidations} run
      where run.scope_kind = ${scope.kind} and run.scope_id = ${scope.id}
        and run.ends_run is null and run.status in ('succeeded', 'restored')
        and not exists (
          select 1 from ${memoryConsolidations} other
          where other.scope_kind = run.scope_kind and other.scope_id = run.scope_id
            and other.started_at = run.started_at and other."trigger" = run."trigger"
            and (other.ends_run is not null or other.status not in ('succeeded', 'restored'))
        )
    `)?.at ?? null;
  if (recorded === null) return legacy;
  return legacy === null ? recorded : Math.max(recorded, legacy);
}

/**
 * When a person last restored one of the scope's consolidations made for
 * this trigger, or null where none has been (EO-596): a restored
 * `container_done` is a person keeping a finished container's memory.
 */
export function lastRestoredAt(db: Db, scope: MemoryScope, trigger: MemoryConsolidationTrigger): number | null {
  return (
    db
      .select({ at: sql<number | null>`max(${memoryConsolidations.restoredAt})` })
      .from(memoryConsolidations)
      .where(and(inScope(scope), eq(memoryConsolidations.trigger, trigger), eq(memoryConsolidations.status, "restored")))
      .get()?.at ?? null
  );
}

/** Every scope that holds an active entry, with what it holds — split by who wrote it, since only agents' entries are rewritten. */
export interface ScopeTally {
  scope: MemoryScope;
  agentEntries: number;
  agentChars: number;
  personEntries: number;
  personChars: number;
  /** The oldest agent-written entry's creation time, or null when there is none. */
  oldestAgentAt: number | null;
}

export function scopeTallies(db: Db): ScopeTally[] {
  const rows = db.all<{ scopeKind: string; scopeId: string; sourceKind: string; entries: number; chars: number; oldest: number }>(sql`
    select scope_kind as "scopeKind", scope_id as "scopeId", source_kind as "sourceKind",
           count(*) as "entries", coalesce(sum(length(body)), 0) as "chars",
           min(created_at) as "oldest"
    from ${memories}
    where retired_at is null
    group by scope_kind, scope_id, source_kind
  `);
  const byScope = new Map<string, ScopeTally>();
  for (const row of rows) {
    const key = `${row.scopeKind}:${row.scopeId}`;
    const tally = byScope.get(key) ?? {
      scope: { kind: row.scopeKind as MemoryScopeKind, id: row.scopeId },
      agentEntries: 0,
      agentChars: 0,
      personEntries: 0,
      personChars: 0,
      oldestAgentAt: null,
    };
    if (row.sourceKind === "person") {
      tally.personEntries += row.entries;
      tally.personChars += row.chars;
    } else {
      tally.agentEntries += row.entries;
      tally.agentChars += row.chars;
      tally.oldestAgentAt = Math.min(tally.oldestAgentAt ?? row.oldest, row.oldest);
    }
    byScope.set(key, tally);
  }
  return [...byScope.values()];
}

/**
 * How many runs were given at least one entry of `scope` after `since`,
 * by when their `memory_delivered` events were written (EO-478) — not by
 * when the run was made: a run started before the last consolidation and
 * given memory after it counts. Runs, not deliveries: a reply resuming a
 * run's thread is a new run, and counts as one.
 *
 * `type` is a literal so SQLite uses `idx_run_events_memory_delivered`,
 * the partial index over those rows by time (migration 0127), rather than
 * reading every line of every transcript.
 */
export function runsDeliveredFromScopeSince(db: Db, scope: MemoryScope, since: number): number {
  return db.get<{ count: number }>(runsDeliveredFromScopeQuery(scope, since))?.count ?? 0;
}

/**
 * The query behind it, exported for the test that holds it to the index.
 * Materialised first, because without it SQLite walks `run_events` by its
 * primary key to answer `count(distinct run_id)`.
 */
export function runsDeliveredFromScopeQuery(scope: MemoryScope, since: number) {
  return sql`
    with delivered as materialized (
      select run_id, payload from ${runEvents}
      where type = ${sql.raw(`'${MEMORY_DELIVERED_EVENT}'`)} and ts > ${since}
    )
    select count(distinct e.run_id) as "count"
    from delivered e
    join json_each(e.payload, '$.entryIds') given
    join ${memories} m on m.id = given.value
    where m.scope_kind = ${scope.kind}
      and m.scope_id = ${scope.id}
  `;
}

/** What a consolidation's answer is applied as, once it has passed its schema. */
export interface ApplyConsolidationInput {
  id: string;
  /** Exactly the entries the side call was given. */
  sent: readonly MemoryEntryView[];
  /** Its operations (EO-573): what to retire, merge and rewrite. An entry they do not name is left as it is. */
  answer: MemoryConsolidationOperations;
  /** Said on the row, for a person — e.g. that word-for-word duplicates were folded without a model. */
  note: string | null;
  now: number;
  /**
   * Where what it writes goes, where that is not the scope of the entries
   * it replaces: the project, for a container's `container_done`
   * consolidation (EO-596), which moves what still holds out of a scope
   * that is ending. A rewrite then always writes, its wording unchanged
   * or not, because the entry is moving. Absent, each is written in the
   * scope of what it replaces.
   */
  writeTo?: MemoryScope;
}

export type ApplyConsolidationResult =
  | {
      ok: true;
      consolidation: MemoryConsolidationView;
      /** Each entry it wrote, with the given entries it replaces — how a skill proposal's evidence is followed into what replaced it (EO-483). */
      written: { id: string; from: string[] }[];
    }
  | { ok: false; problem: string };

/**
 * Applies an answer's operations, all of them or none of them, as one
 * consolidation (EO-573).
 *
 * Refused, changing nothing, if any entry it was given has since been
 * edited or retired: the answer is about entries that are no longer what
 * it read, and folding them would undo what a person just did.
 *
 * - A retired entry is retired as `consolidated`.
 * - A merge retires every entry it names as `consolidated` and writes one
 *   new entry with the source and age of the newest of them.
 * - A rewrite retires its entry as `consolidated` and writes the new
 *   wording with that entry's source and age — unless it is the entry
 *   word for word with the same flag, which leaves the entry as it is.
 *
 * Every entry it retires or writes carries the consolidation's id; an
 * entry no operation names is not touched. With `writeTo` (EO-596), what
 * it writes is written there instead, keeping its source and age, and a
 * restore retires it there as it puts the given entries back. An answer that names nothing
 * still succeeds, having changed nothing, which settles the scope.
 */
export function applyConsolidation(db: Db, input: ApplyConsolidationInput): ApplyConsolidationResult {
  return db.transaction((tx) => {
    const sentById = new Map(input.sent.map((entry) => [entry.id, entry]));
    for (const entry of input.sent) {
      const current = getMemory(tx as unknown as Db, entry.id);
      if (!current || current.retiredAt !== null || current.body !== entry.body || current.updatedAt !== entry.updatedAt) {
        return { ok: false as const, problem: "An entry it was given was edited or retired while it ran, so nothing was changed." };
      }
    }
    const given = (id: string): MemoryEntryView => {
      const entry = sentById.get(id);
      if (!entry) throw new Error(`A consolidation names an entry it was not given: ${id}.`); // the schema holds this
      return entry;
    };
    const retiredIds: string[] = [];
    const retire = (entry: MemoryEntryView) => {
      const retired = retireMemory(tx as unknown as Db, entry.id, { reason: "consolidated", consolidationId: input.id, now: input.now });
      if (!retired.ok) throw new Error(retired.problem); // checked above, in this transaction; the schema names each once
      retiredIds.push(entry.id);
    };
    const writtenIds: string[] = [];
    const writtenFrom: { id: string; from: string[] }[] = [];
    const write = (replaces: readonly MemoryEntryView[], body: string, contradicts: boolean) => {
      const newest = [...replaces].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!newest) throw new Error("A consolidation entry replaces no entry it was given."); // the schema holds this
      // The project of what it replaces (EO-482): on a record, a
      // workspace's entries are held without the workspace's row. One
      // written elsewhere (EO-596) is of the scope it is written to.
      const projectId = input.writeTo === undefined ? (memoryEntryProjectId(tx as unknown as Db, newest.id) ?? undefined) : undefined;
      const written = addMemory(tx as unknown as Db, {
        ...(projectId === undefined ? {} : { projectId }),
        scope: input.writeTo ?? newest.scope,
        body,
        source: newest.source,
        now: input.now,
        createdAt: newest.createdAt,
        consolidationId: input.id,
        contradictsRepositoryFile: contradicts,
      });
      if (!written.ok) throw new Error(written.problem);
      writtenIds.push(written.entry.id);
      writtenFrom.push({ id: written.entry.id, from: replaces.map((entry) => entry.id) });
    };

    for (const operation of input.answer.retire) retire(given(operation.id));
    for (const merge of input.answer.merge) {
      const replaces = merge.from.map(given);
      for (const entry of replaces) retire(entry);
      write(replaces, merge.body, merge.contradictsRepositoryFile);
    }
    for (const rewrite of input.answer.rewrite) {
      const entry = given(rewrite.id);
      if (input.writeTo === undefined && entry.body === rewrite.body.trim() && entry.contradictsRepositoryFile === rewrite.contradictsRepositoryFile) continue;
      retire(entry);
      write([entry], rewrite.body, rewrite.contradictsRepositoryFile);
    }
    tx.update(memoryConsolidations)
      .set({
        status: "succeeded",
        finishedAt: input.now,
        retiredIds,
        writtenIds,
        note: input.note,
        failureReason: null,
      })
      .where(eq(memoryConsolidations.id, input.id))
      .run();
    return { ok: true as const, consolidation: getConsolidation(tx as unknown as Db, input.id)!, written: writtenFrom };
  });
}

export type RestoreConsolidationResult =
  | { ok: true; consolidation: MemoryConsolidationView; restored: number; retired: number; changedIds: string[] }
  | { ok: false; problem: string };

/**
 * Puts back the set from before one consolidation, in one transaction:
 * every entry it retired that is still retired as `consolidated` is
 * active again, and every entry it wrote that is still active is retired
 * as a person's retirement. An entry somebody has since dealt with — one
 * it retired that was put back by hand, one it wrote that was edited — is
 * left as that person left it.
 *
 * Entries moved into a skill it proposed (EO-483) come back too: Save
 * retires them as `moved_to_skill` tagged with this consolidation's id,
 * so the set from before it is the set before the skill took them. The
 * skill itself stays; it is a person's to archive.
 */
export function restoreConsolidation(db: Db, id: string, input: { now?: number } = {}): RestoreConsolidationResult {
  const now = input.now ?? Date.now();
  return db.transaction((tx) => {
    const consolidation = getConsolidation(tx as unknown as Db, id);
    if (!consolidation) return { ok: false as const, problem: `No consolidation has the id "${id}".` };
    if (consolidation.status === "restored") return { ok: false as const, problem: "That consolidation has already been restored." };
    if (consolidation.status !== "succeeded") return { ok: false as const, problem: "That consolidation changed nothing, so there is nothing to restore." };
    let restored = 0;
    // Every entry changed, in the order changed: what a caller reads back,
    // and what a record sends the device that asked (EO-546).
    const changedIds: string[] = [];
    for (const entryId of consolidation.retiredIds) {
      const entry = getMemory(tx as unknown as Db, entryId);
      if (entry?.retiredAt === null || entry?.retiredReason !== "consolidated") continue;
      if (restoreMemory(tx as unknown as Db, entryId, now).ok) {
        restored += 1;
        changedIds.push(entryId);
      }
    }
    const moved = tx
      .select({ id: memories.id })
      .from(memories)
      .where(and(eq(memories.consolidationId, id), eq(memories.retiredReason, "moved_to_skill")))
      .all();
    // Not one it wrote: those go back to being retired, as below.
    const wrote = new Set(consolidation.writtenIds);
    for (const entry of moved) {
      if (wrote.has(entry.id)) continue;
      if (restoreMemory(tx as unknown as Db, entry.id, now).ok) {
        restored += 1;
        changedIds.push(entry.id);
      }
    }
    let retired = 0;
    for (const entryId of consolidation.writtenIds) {
      const entry = getMemory(tx as unknown as Db, entryId);
      if (!entry || entry.retiredAt !== null) continue;
      if (retireMemory(tx as unknown as Db, entryId, { reason: "retired", now }).ok) {
        retired += 1;
        changedIds.push(entryId);
      }
    }
    // Settles the scope as the person left it: what it put back is not new
    // to the next scheduled consolidation, and is not folded straight back.
    tx.update(memoryConsolidations)
      .set({ status: "restored", restoredAt: now })
      .where(eq(memoryConsolidations.id, id))
      .run();
    return { ok: true as const, consolidation: getConsolidation(tx as unknown as Db, id)!, restored, retired, changedIds };
  });
}
