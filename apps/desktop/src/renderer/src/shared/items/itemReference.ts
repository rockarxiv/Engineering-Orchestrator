import type { ItemSummary } from "@eo/core";

/**
 * Each project's catalog has its own cache entry. That keeps a key from the
 * project viewed previously from resolving while the next project's catalog
 * is loading.
 */
export const itemReferencesKey = (projectId: string | null) => ["item-references", projectId] as const;

/**
 * What a reference needs of an item: where it leads and what it is called.
 * Only that — so a catalog has no field that could go stale when a refetch
 * that changed none of these keeps the catalog it already had (EO-561).
 */
export type ItemReference = Pick<ItemSummary, "id" | "key" | "title">;

/** The keys EO holds for one project, each to what it references. */
export type ItemCatalog = ReadonlyMap<string, ItemReference>;

/**
 * Whether two catalogs would draw every reference the same: the same keys,
 * each to the same item under the same title. A Map has no structural
 * sharing in the query cache, so this is what keeps an unchanged catalog's
 * identity — and with it every `Markdown` on screen from re-rendering.
 */
export function sameItemCatalog(left: ItemCatalog, right: ItemCatalog): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, reference] of left) {
    const other = right.get(key);
    if (other === undefined || other.id !== reference.id || other.title !== reference.title) return false;
  }
  return true;
}
