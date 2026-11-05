import { and, desc, eq, gte, sql } from "drizzle-orm";
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
export function startConsolidation(db: Db, input: { scope: MemoryScope; trigger: MemoryConsolidationTrigger; now: number; id?: Uuid }): MemoryConsolidationView {
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

/** The caps a scope was settled under: a change to them is a reason to look at the scope again. */
export interface SettledCaps {
  maxEntries: number;
  maxChars: number;
}

/** A scope over a cap with nothing a consolidation may rewrite — people's entries alone — said once, as its own row. */
export function recordSkippedConsolidation(
  db: Db,
  input: { scope: MemoryScope; trigger: MemoryConsolidationTrigger; note: string; now: number; caps: SettledCaps },
): MemoryConsolidationView {
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
export function skipConsolidation(db: Db, id: string, input: { note: string; now: number; caps: SettledCaps }): void {
  db.update(memoryConsolidations)
    .set({ status: "skipped", finishedAt: input.now, note: input.note, capsEntries: input.caps.maxEntries, capsChars: input.caps.maxChars })
    .where(eq(memoryConsolidations.id, id))
    .run();
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
   * The last time the scope's size was settled — a consolidation (as of
   * the moment it read the entries it was given), a skip, or a restore —
   * with the caps in force then; null if never.
   */
  settled: { at: number; caps: SettledCaps | null } | null;
  /**
   * Whether anything in the scope was written since it was settled — an
   * entry added, edited, retired or restored by anyone — other than what
   * the settling consolidation or restore itself wrote, as it wrote it
   * (the same rows written again later are a change). True when it was
   * never settled. Unchanged and under the same caps, a scope left over a
   * cap (by a restore, or by people's entries alone) is not taken up
   * again.
   */
  changedSinceSettled: boolean;
  /**
   * Failures since the last row that was not one, newest first: each one's
   * row, when it finished, its reason and note, and whether the note
   * saying the scope is stuck was posted at it (EO-577).
   */
  failuresSince: { id: string; finishedAt: number; reason: string | null; note: string | null; stuckNoticed: boolean }[];
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

export function consolidationState(db: Db, scope: MemoryScope): ScopeConsolidationState {
  const rows = db
    .select()
    .from(memoryConsolidations)
    .where(inScope(scope))
    .orderBy(desc(memoryConsolidations.startedAt), desc(memoryConsolidations.id))
    .limit(200)
    .all();
  let lastConsolidatedAt: number | null = null;
  let settling: Row | null = null;
  for (const row of rows) {
    if (row.status === "succeeded" || row.status === "restored") {
      const at = Math.max(row.finishedAt ?? row.startedAt, row.restoredAt ?? 0);
      lastConsolidatedAt = lastConsolidatedAt === null ? at : Math.max(lastConsolidatedAt, at);
    }
    const at = settledAt(row);
    if (at !== null && (settling === null || at > settledAt(settling)!)) settling = row;
  }
  let changedSinceSettled = true;
  if (settling !== null) {
    // What the settlement itself wrote is not a change since it: the rows
    // it retired, wrote or put back, as it left them — stamped at the
    // moment it wrote them. The same rows written again later (a person
    // restoring one by hand, editing one, retiring one) are a change.
    //
    // A scope consolidated in batches (EO-574) is settled by every row of
    // the run together: each starts at the moment the run read its
    // entries, so what any of them wrote is the settlement's own, and
    // what anybody else wrote while the run went on is a change.
    const at = settledAt(settling)!;
    const own = new Set(
      rows
        .filter((row) => settledAt(row) === at && writtenAt(row) !== null)
        .flatMap((row) => [...row.retiredIds, ...row.writtenIds].map((id) => `${id}@${writtenAt(row)}`)),
    );
    changedSinceSettled = db
      .select({ id: memories.id, updatedAt: memories.updatedAt })
      .from(memories)
      .where(and(eq(memories.scopeKind, scope.kind), eq(memories.scopeId, scope.id), gte(memories.updatedAt, at)))
      .all()
      .some((row) => !own.has(`${row.id}@${row.updatedAt}`));
  }
  const failuresSince: ScopeConsolidationState["failuresSince"] = [];
  for (const row of rows.filter((candidate) => candidate.status !== "running")) {
    if (row.status !== "failed") break;
    failuresSince.push({ id: row.id, finishedAt: row.finishedAt ?? row.startedAt, reason: row.failureReason, note: row.note, stuckNoticed: row.stuckNoticedAt !== null });
  }
  return {
    lastConsolidatedAt,
    settled:
      settling === null
        ? null
        : {
            at: settledAt(settling)!,
            caps: settling.capsEntries === null || settling.capsChars === null ? null : { maxEntries: settling.capsEntries, maxChars: settling.capsChars },
          },
    changedSinceSettled,
    failuresSince,
    running: rows.some((row) => row.status === "running"),
  };
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
  /** Said on the row, for a person — e.g. that people's entries alone exceed a cap. */
  note: string | null;
  /** The caps it was asked to bring the scope under. */
  caps: SettledCaps;
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
        capsEntries: input.caps.maxEntries,
        capsChars: input.caps.maxChars,
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
export function restoreConsolidation(db: Db, id: string, input: { caps: SettledCaps; now?: number }): RestoreConsolidationResult {
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
    // Settles the scope as the person left it, under the caps in force
    // now: unchanged, it is not folded straight back by the next look.
    tx.update(memoryConsolidations)
      .set({ status: "restored", restoredAt: now, capsEntries: input.caps.maxEntries, capsChars: input.caps.maxChars })
      .where(eq(memoryConsolidations.id, id))
      .run();
    return { ok: true as const, consolidation: getConsolidation(tx as unknown as Db, id)!, restored, retired, changedIds };
  });
}
