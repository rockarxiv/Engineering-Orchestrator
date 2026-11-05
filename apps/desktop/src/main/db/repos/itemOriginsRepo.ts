import { and, eq, ne, sql } from "drizzle-orm";
import type { RecordItemOrigin, Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { itemOrigins, items } from "../schema.js";

/**
 * Where an item a module created came from (EO-433).
 *
 * Three questions, and the table exists to answer them after the run
 * that wrote it has ended: has this originating item already created
 * something under this key, how far down a chain of creations is this
 * item, and what made it.
 */
export interface ItemOrigin {
  itemId: Uuid;
  /** Null once the originating item has been deleted. */
  originItemId: Uuid | null;
  runId: Uuid | null;
  moduleId: Uuid;
  idempotencyKey: string;
  generation: number;
  createdAt: number;
}

function toDomain(row: typeof itemOrigins.$inferSelect): ItemOrigin {
  return {
    itemId: row.itemId as Uuid,
    originItemId: row.originItemId as Uuid | null,
    runId: row.runId as Uuid | null,
    moduleId: row.moduleId as Uuid,
    idempotencyKey: row.idempotencyKey,
    generation: row.generation,
    createdAt: row.createdAt,
  };
}

/** What made this item, or undefined for one no module created. */
export function getItemOrigin(db: Db, itemId: Uuid): ItemOrigin | undefined {
  const row = db.select().from(itemOrigins).where(eq(itemOrigins.itemId, itemId)).get();
  return row === undefined ? undefined : toDomain(row);
}

/**
 * How many creations stand between this item and one a person filed.
 *
 * Zero for an item with no row, which is every item no module created.
 */
export function itemGeneration(db: Db, itemId: Uuid): number {
  return getItemOrigin(db, itemId)?.generation ?? 0;
}

/**
 * The item this originating item already created under this key, if it
 * is still there.
 *
 * Archived counts: archiving removes no row. Deleted does not: the row
 * went with the item, by the cascade the schema declares.
 */
export function createdItemFor(db: Db, originItemId: Uuid, idempotencyKey: string): ItemOrigin | undefined {
  const row = db
    .select()
    .from(itemOrigins)
    .where(and(eq(itemOrigins.originItemId, originItemId), eq(itemOrigins.idempotencyKey, idempotencyKey)))
    .get();
  return row === undefined ? undefined : toDomain(row);
}

/**
 * Records what made an item. Throws on a second row for one
 * (originating item, key) pair — the unique index is the last word on
 * "created once", whatever the caller looked up first.
 */
export function recordItemOrigin(db: Db, origin: Omit<ItemOrigin, "createdAt">): ItemOrigin {
  const row = db
    .insert(itemOrigins)
    .values({ ...origin, createdAt: Date.now() })
    .returning()
    .get();
  return toDomain(row);
}

/**
 * How many items this run is recorded as having created.
 *
 * The cap on a run's creations, read from what was written rather than
 * from what the process running the module remembers — which on an
 * organisation's record is somebody else's process.
 */
export function itemsCreatedByRun(db: Db, runId: Uuid): number {
  return db.select({ n: sql<number>`count(*)` }).from(itemOrigins).where(eq(itemOrigins.runId, runId)).get()?.n ?? 0;
}

/**
 * Writes an origin that arrived with its item from another database —
 * a project being handed to a record, or a record's item reaching a
 * replica (EO-433).
 *
 * The same facts under the same item id, written over whatever is
 * there: the sender is the one that holds the item, and a page can be
 * sent twice.
 *
 * `originItemId` is kept only where this database has that item — it
 * is a foreign key — and where no *other* item already holds the pair,
 * which the unique index would refuse. Either way the row is still
 * written, with the originating item blank: the generation is what
 * stops a chain, and it must not be lost because a link could not be
 * drawn.
 */
export function upsertItemOrigin(db: Db, origin: ItemOrigin, hasItem: (id: Uuid) => boolean): void {
  let originItemId = origin.originItemId !== null && hasItem(origin.originItemId) ? origin.originItemId : null;
  if (originItemId !== null) {
    const taken = db
      .select({ itemId: itemOrigins.itemId })
      .from(itemOrigins)
      .where(and(eq(itemOrigins.originItemId, originItemId), eq(itemOrigins.idempotencyKey, origin.idempotencyKey), ne(itemOrigins.itemId, origin.itemId)))
      .get();
    if (taken !== undefined) originItemId = null;
  }
  const values = {
    originItemId,
    runId: origin.runId,
    moduleId: origin.moduleId,
    idempotencyKey: origin.idempotencyKey,
    generation: origin.generation,
    createdAt: origin.createdAt,
  };
  db.insert(itemOrigins)
    .values({ itemId: origin.itemId, ...values })
    .onConflictDoUpdate({ target: itemOrigins.itemId, set: values })
    .run();
}

/** An item's origin as it travels, or null for one no module created (EO-433). */
export function originForWire(db: Db, itemId: Uuid): RecordItemOrigin | null {
  const origin = getItemOrigin(db, itemId);
  if (origin === undefined) return null;
  return {
    originItemId: origin.originItemId,
    runId: origin.runId,
    moduleId: origin.moduleId,
    idempotencyKey: origin.idempotencyKey,
    generation: origin.generation,
    createdAt: origin.createdAt,
  };
}

/**
 * Writes the origin an item arrived with (EO-433). Nothing for an item
 * that came with none — an origin is never taken away by a sender that
 * did not say one, which is what a page from an older build is.
 */
export function keepArrivedOrigin(db: Db, itemId: string, origin: RecordItemOrigin | null | undefined): void {
  if (origin === null || origin === undefined) return;
  upsertItemOrigin(
    db,
    {
      itemId: itemId as Uuid,
      originItemId: origin.originItemId as Uuid | null,
      runId: origin.runId as Uuid | null,
      moduleId: origin.moduleId as Uuid,
      idempotencyKey: origin.idempotencyKey,
      generation: origin.generation,
      createdAt: origin.createdAt,
    },
    (id) => db.select({ id: items.id }).from(items).where(eq(items.id, id)).get() !== undefined,
  );
}
