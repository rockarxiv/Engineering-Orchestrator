import { gitStateOf, jiraStateOf, type Item, type ItemExtensions } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getItem } from "../../../db/repos/index.js";
import { branchPrefix } from "./branchPrefix.js";
import { branchNameFor } from "./worktrees.js";

/**
 * What names an item's work in its branch and pull request (EO-638).
 *
 * First match wins: the item's own Reference, then its own Jira key,
 * then its parent feature's Reference, then its EO key. A feature's Jira
 * link does not flow down — only one item may hold a Jira key, so a
 * story presenting itself under its feature's would claim an issue it
 * does not mirror.
 *
 * `kind` is what the readers branch on: a Reference keeps the EO key in
 * the branch (siblings share a Reference and must not share a branch)
 * and keeps both EO and Jira keys out of the description; the other two
 * name the work exactly as before the Reference existed.
 */
export type WorkName = { kind: "reference" | "jira" | "key"; value: string };

interface Named {
  readonly key: string;
  readonly extensions: ItemExtensions;
}

/** The precedence, pure. `parent` is the item's container, or null for one with none. */
export function workNameOf(item: Named, parent: Named | null | undefined): WorkName {
  const own = gitStateOf(item).reference;
  if (own !== null) return { kind: "reference", value: own };
  const jira = jiraStateOf(item).key;
  if (jira !== null) return { kind: "jira", value: jira };
  const inherited = parent ? gitStateOf(parent).reference : null;
  if (inherited !== null) return { kind: "reference", value: inherited };
  return { kind: "key", value: item.key };
}

/** The same answer for a stored item, reading its parent fresh. */
export function workNameFor(db: Db, item: Item): WorkName {
  const parent = item.parentId === null ? null : getItem(db, item.parentId);
  return workNameOf(item, parent);
}

/**
 * The branch `item` works on: the one stored on it, or else the one
 * dispatch would cut for it now — `branchNameFor` from what names its
 * work and the configured prefix (EO-638).
 *
 * Every reader that needs an item's branch before it may have been cut
 * — the implementation check, and the stack target for a dependency not
 * yet dispatched — asks this, so none of them goes looking for a
 * different name than the one dispatch cuts. Dispatch itself names the
 * branch from the same two parts, through `BranchNaming`. A stored
 * branch always wins, so nothing already cut is renamed.
 */
export async function itemBranchName(db: Db, item: Item): Promise<string> {
  return gitStateOf(item).branch ?? branchNameFor(item.key, workNameFor(db, item), await branchPrefix(db));
}
