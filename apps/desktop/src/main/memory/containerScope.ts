import { containerScopeName, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { finishedItemIds, getItem, listChildItemsIncludingArchived, stepEntryTimes } from "../db/repos/index.js";
import type { MemoryScopeInfo } from "./selection.js";

/**
 * A container's memory scope (EO-596, ARCHITECTURE.md §7.5): what is true
 * only while the work filed under one container item is in progress.
 *
 * Asked of the item type's container flag and the item's parent, never of
 * a type's word — a pack may call its container anything (invariant 13).
 */

/**
 * The container scope a run on this item is given, where its parent is a
 * container item on a project, and null otherwise: an item filed under
 * nothing, under an item that is not a container, or under a container on
 * no project, which has no project to hand its lasting facts to at the end.
 */
export function containerScopeOf(db: Db, item: Pick<Item, "parentId">): MemoryScopeInfo | null {
  if (item.parentId === null) return null;
  const parent = getItem(db, item.parentId);
  if (parent === undefined || !parent.container || parent.projectId === null) return null;
  return { scope: { kind: "container", id: parent.id }, name: containerScopeName(parent) };
}

/**
 * When the work filed under a container finished: the moment the last of
 * its items arrived on the terminal step it stands on, each judged by its
 * own pipeline version (`finishedItemIds`). Null while any item under it
 * is not finished, and for a container with nothing filed under it, which
 * has not started rather than ended. An item that finished without ever
 * moving — none does, but a row can be written that way — counts from its
 * last change.
 */
export function containerWorkFinishedAt(db: Db, containerId: string): number | null {
  const children = listChildItemsIncludingArchived(db, containerId);
  if (children.length === 0) return null;
  const finished = finishedItemIds(db, children);
  if (children.some((child) => !finished.has(child.id))) return null;
  const entered = stepEntryTimes(db, children.map((child) => child.id));
  return Math.max(...children.map((child) => entered.get(child.id) ?? child.updatedAt));
}

/** The container item a container scope names, where it is one. */
export function containerOfScope(db: Db, containerId: string): Item | null {
  const item = getItem(db, containerId as Uuid);
  return item !== undefined && item.container ? item : null;
}
