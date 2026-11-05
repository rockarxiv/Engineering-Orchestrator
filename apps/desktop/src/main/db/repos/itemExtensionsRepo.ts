import { and, eq, inArray } from "drizzle-orm";
import { NO_ITEM_EXTENSIONS, type ItemExtensions, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { itemExtensions } from "../schema.js";

/**
 * The `item_extensions` rows, as the map an `Item` carries (KAN-148).
 *
 * Domain-neutral on purpose: this knows that a pack may have state on an
 * item and nothing whatever about what any pack keeps there. The typed
 * reads are the extensions' own — `jiraStateOf` in `@eo/core` for the
 * one extension that exists today — and they all start from what this
 * returns.
 */

/** Every extension's state for one item. `{}` when no pack has said anything. */
export function extensionsForItem(db: Db, itemId: Uuid | string): ItemExtensions {
  const rows = db.select().from(itemExtensions).where(eq(itemExtensions.itemId, itemId)).all();
  return rows.length === 0 ? NO_ITEM_EXTENSIONS : Object.fromEntries(rows.map((row) => [row.extension, row.data]));
}

/**
 * The same for a page of items.
 *
 * Every list read goes through here — the project, the archive, the
 * scheduler's tick — so a list costs one extra query rather than one per
 * item. Items with no rows are simply absent from the map, and the
 * caller gives them `{}`.
 *
 * In chunks because `in (...)` is one bound parameter per id and SQLite
 * stops at 32,766 of them. Nobody has a project that size today and the
 * chunk costs one statement per 500 items when they do, which is a
 * better trade than a query that works until the day it throws.
 */
const ID_CHUNK = 500;

export function extensionsForItems(db: Db, itemIds: readonly string[]): Map<string, ItemExtensions> {
  const byItem = new Map<string, Record<string, unknown>>();
  for (let from = 0; from < itemIds.length; from += ID_CHUNK) {
    const rows = db
      .select()
      .from(itemExtensions)
      .where(inArray(itemExtensions.itemId, itemIds.slice(from, from + ID_CHUNK) as string[]))
      .all();
    for (const row of rows) {
      const held = byItem.get(row.itemId) ?? {};
      held[row.extension] = row.data;
      byItem.set(row.itemId, held);
    }
  }
  return byItem;
}

/**
 * Writes one extension's state, or removes it.
 *
 * `null` deletes the row, and that is not a convenience: the absence of
 * a row is what an extension's defaults mean, so an extension that has
 * gone back to saying nothing must leave nothing behind. Storing an
 * all-defaults payload instead would make "never bound" and "unbound
 * again" two different rows saying the same thing, and every future
 * `item_extensions` reader would have to know they are the same.
 */
export function setItemExtension(db: Db, itemId: Uuid | string, extension: string, data: unknown | null): void {
  if (data === null) {
    db.delete(itemExtensions).where(and(eq(itemExtensions.itemId, itemId), eq(itemExtensions.extension, extension))).run();
    return;
  }
  const updatedAt = Date.now();
  db.insert(itemExtensions)
    .values({ itemId, extension, data, updatedAt })
    .onConflictDoUpdate({
      target: [itemExtensions.itemId, itemExtensions.extension],
      set: { data, updatedAt },
    })
    .run();
}
