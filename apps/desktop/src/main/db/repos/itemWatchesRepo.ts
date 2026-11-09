import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { uuidv7, type RecordCursor, type RecordWatch, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { items, itemWatches } from "../schema.js";
import { notifyWatchWritten } from "../watchEvents.js";
import { onProject } from "./projectScope.js";
import { listTransitionsForItem } from "./transitionsRepo.js";

/**
 * An item's watch on a step that keeps checking (EO-456, ARCHITECTURE.md,
 * "A step").
 *
 * The row is the wait. Nothing about a watch lives in a process, so a
 * closed app or a sleeping machine loses nothing: the next check is a
 * time written here, and the scheduler reads it.
 */
export interface ItemWatch {
  id: Uuid;
  itemId: Uuid;
  stepId: string;
  /** The move that brought the item onto the step; a different one is a different watch. */
  initiationId: string | null;
  startedAt: number;
  lastCheckedAt: number | null;
  nextCheckAt: number;
  checks: number;
  consecutiveFailures: number;
  lastError: string | null;
  postedNewsIds: string[];
  /** When this database last changed the row; the record's stamp on a replica. */
  updatedAt: number;
}

function toDomain(row: typeof itemWatches.$inferSelect): ItemWatch {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    stepId: row.stepId,
    initiationId: row.initiationId,
    startedAt: row.startedAt,
    lastCheckedAt: row.lastCheckedAt,
    nextCheckAt: row.nextCheckAt,
    checks: row.checks,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    // A JSON column somebody could have written by hand: anything that
    // is not a list of strings reads as nothing posted, which at worst
    // posts a piece of news twice rather than never.
    postedNewsIds: Array.isArray(row.postedNewsIds) ? row.postedNewsIds.filter((id): id is string => typeof id === "string") : [],
    updatedAt: row.updatedAt,
  };
}

/** The watch for this item on this step, or undefined if it has never been checked there. */
export function getItemWatch(db: Db, itemId: Uuid, stepId: string): ItemWatch | undefined {
  const row = db
    .select()
    .from(itemWatches)
    .where(and(eq(itemWatches.itemId, itemId), eq(itemWatches.stepId, stepId)))
    .get();
  return row === undefined ? undefined : toDomain(row);
}

/** Every watch there is. Read once a tick, so the scheduler can hold the items whose next check is not due. */
export function listItemWatches(db: Db): ItemWatch[] {
  return db.select().from(itemWatches).all().map(toDomain);
}

/**
 * The watches of these items on the steps they stand on now, in one
 * query (EO-699): the board's cards. A row for a step an item has left is
 * not read. Whether a row belongs to the item's current *stay* on that
 * step is the caller's question (`watchStayOf`).
 */
export function listItemWatchesOnCurrentSteps(db: Db, itemIds: readonly string[]): ItemWatch[] {
  if (itemIds.length === 0) return [];
  return db
    .select({ watch: itemWatches })
    .from(itemWatches)
    .innerJoin(items, and(eq(items.id, itemWatches.itemId), eq(items.stepId, itemWatches.stepId)))
    .where(inArray(itemWatches.itemId, [...itemIds]))
    .all()
    .map((row) => toDomain(row.watch));
}

/**
 * Starts the watch for this item on this step, or starts it again.
 *
 * One row per item and step, so an item that comes back to a step it
 * was watched on before gets its row reset rather than a second one: a
 * new clock, no failures, no news posted. What it watched last time
 * was a different wait.
 */
export function startItemWatch(db: Db, input: { itemId: Uuid; stepId: string; initiationId: string | null; startedAt: number }, now: number = input.startedAt): ItemWatch {
  const fresh = {
    initiationId: input.initiationId,
    startedAt: input.startedAt,
    lastCheckedAt: null,
    nextCheckAt: input.startedAt,
    checks: 0,
    consecutiveFailures: 0,
    lastError: null,
    postedNewsIds: [] as string[],
    updatedAt: now,
  };
  const row = db
    .insert(itemWatches)
    .values({ id: uuidv7(), itemId: input.itemId, stepId: input.stepId, ...fresh })
    .onConflictDoUpdate({ target: [itemWatches.itemId, itemWatches.stepId], set: fresh })
    .returning()
    .get();
  const watch = toDomain(row);
  notifyWatchWritten(db, watch);
  return watch;
}

/** What a check changes on its watch. */
export type ItemWatchPatch = Partial<Pick<ItemWatch, "lastCheckedAt" | "nextCheckAt" | "checks" | "consecutiveFailures" | "lastError" | "postedNewsIds" | "startedAt">>;

/**
 * Changes a watch, stamps it, and says so — which on a desktop signed in
 * to an organisation is what sends it to the record (`outbound.ts`).
 */
export function updateItemWatch(db: Db, id: Uuid, patch: ItemWatchPatch, now: number = Date.now()): ItemWatch | undefined {
  const row = db
    .update(itemWatches)
    .set({ ...patch, updatedAt: now })
    .where(eq(itemWatches.id, id))
    .returning()
    .get();
  if (row === undefined) return undefined;
  const watch = toDomain(row);
  notifyWatchWritten(db, watch);
  return watch;
}

/** A watch as it travels between a device and its record (EO-456). */
export function asRecordWatch(watch: ItemWatch): RecordWatch {
  return {
    itemId: watch.itemId,
    stepId: watch.stepId,
    initiationId: watch.initiationId,
    startedAt: watch.startedAt,
    lastCheckedAt: watch.lastCheckedAt,
    nextCheckAt: watch.nextCheckAt,
    checks: watch.checks,
    consecutiveFailures: watch.consecutiveFailures,
    lastError: watch.lastError,
    postedNewsIds: watch.postedNewsIds,
    updatedAt: watch.updatedAt,
  };
}

/**
 * The stay a watch belongs to: the move that brought the item onto the
 * step it stands on — the id of the latest transition into it — or a
 * stable name for an item that has stood there since it was created
 * (EO-456).
 *
 * A watch row is the watch only for the stay it names; an item that
 * leaves and comes back is watched afresh.
 */
export function watchStayOf(db: Db, item: { id: string; stepId: string | null }): string {
  const entry = listTransitionsForItem(db, item.id as Uuid)
    .filter((transition) => transition.toStepId === item.stepId)
    .at(-1);
  return entry?.id ?? `initial:${item.id}:${item.stepId}`;
}

/**
 * Whether a device's report about a watch is one the record must leave
 * out (EO-456).
 *
 * Two ways a report can be behind, and both are a machine that queued it
 * and went quiet while another carried on:
 *
 * - **It is about a stay that is over.** The item left the step and came
 *   back, or has moved on, and `current` — the record's own account of
 *   where the item stands and which move put it there — names a
 *   different stay. A report about an earlier stay is never the newer
 *   one, whatever its counts say: taking it would put the old watch in
 *   place of the current one, which every reader then rejects as
 *   belonging to the wrong stay and starts afresh — a deadline, a
 *   failure streak and the news already posted, all gone.
 * - **It is about this stay and shows fewer checks than the record has.**
 *   Within one stay a watch only counts up, so it was queued before
 *   checks another device has since reported.
 *
 * Decided from the record's transitions and the watch's own progress,
 * never from timestamps, because the stamps come from two machines'
 * clocks.
 */
export function isStaleWatchReport(existing: ItemWatch | undefined, incoming: RecordWatch, current: { stepId: string | null; stay: string }): boolean {
  if (incoming.stepId !== current.stepId || incoming.initiationId !== current.stay) return true;
  if (existing === undefined) return false;
  return existing.initiationId === incoming.initiationId && incoming.checks < existing.checks;
}

/**
 * Writes a watch that arrived from elsewhere, by item and step (EO-456).
 *
 * Two callers. The record taking a device's report stamps it with its
 * own clock (`stampedAt`), because that is the clock the other devices
 * page on, and leaves out a report older than what it holds
 * (`isStaleWatchReport`). A replica taking the record's keeps the
 * record's stamp; whether to take it at all is the caller's question
 * (`hasQueuedWatch`). Neither announces: a row that came from the other
 * side is not news to send back to it.
 *
 * Answers whether it wrote.
 */
export function mirrorItemWatch(db: Db, incoming: RecordWatch, stampedAt?: number): boolean {
  const updatedAt = stampedAt ?? incoming.updatedAt;
  const existing = getItemWatch(db, incoming.itemId as Uuid, incoming.stepId);
  if (stampedAt !== undefined) {
    const item = db.select({ stepId: items.stepId }).from(items).where(eq(items.id, incoming.itemId)).get();
    if (item === undefined) return false;
    if (isStaleWatchReport(existing, incoming, { stepId: item.stepId, stay: watchStayOf(db, { id: incoming.itemId, stepId: item.stepId }) })) return false;
  }
  const values = {
    initiationId: incoming.initiationId,
    startedAt: incoming.startedAt,
    lastCheckedAt: incoming.lastCheckedAt,
    nextCheckAt: incoming.nextCheckAt,
    checks: incoming.checks,
    consecutiveFailures: incoming.consecutiveFailures,
    lastError: incoming.lastError,
    postedNewsIds: incoming.postedNewsIds,
    updatedAt,
  };
  db.insert(itemWatches)
    .values({ id: uuidv7(), itemId: incoming.itemId, stepId: incoming.stepId, ...values })
    .onConflictDoUpdate({ target: [itemWatches.itemId, itemWatches.stepId], set: values })
    .run();
  return true;
}

/** Watches changed after a cursor, oldest first — the record's watch feed (EO-456). `within` scopes it to one project. */
export function listItemWatchesUpdatedSince(db: Db, cursor: RecordCursor, limit: number, within?: string): ItemWatch[] {
  return db
    .select()
    .from(itemWatches)
    .where(
      and(
        sql`(${itemWatches.updatedAt} > ${cursor.ts} or (${itemWatches.updatedAt} = ${cursor.ts} and ${itemWatches.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(itemWatches.itemId, within),
      ),
    )
    .orderBy(asc(itemWatches.updatedAt), asc(itemWatches.id))
    .limit(limit)
    .all()
    .map(toDomain);
}
