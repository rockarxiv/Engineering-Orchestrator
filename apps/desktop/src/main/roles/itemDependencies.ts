import type { Comment, Item, Uuid } from "@eo/core";
import { detectCycle, formatCyclePath } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  addDependency,
  finishedItemIds,
  getItem,
  getItemByKey,
  listAllDependencies,
  listDependencies,
  listItemsByIds,
  postComment,
  removeDependency,
  updateItem,
} from "../db/repos/index.js";
import { refuseIfUntouchable } from "./itemGuards.js";

/**
 * Changing what an existing item waits for (EO-600, ARCHITECTURE.md,
 * "One work entity").
 *
 * Two doors open onto this act: the assistant chat's reorder card, which
 * a person approves, and `items:update` — the item screen, `item_update`
 * and its deprecated twin. Two doors onto one act want one rule between
 * them, not a second one written to resemble the first, for the reason
 * `itemGuards.ts` gives about content. So both call this, and a reorder
 * card and an `item_update` call cannot disagree about which changes are
 * allowed or how a refusal reads.
 *
 * **The whole change is judged before anything is written.** The reorder
 * card used to remove its edges one by one and only then look at the
 * ones it was adding, so a refused addition answered "nothing was done"
 * over removals that had already landed — rescued only by the approval
 * door's transaction, which the next door would not have had. Here every
 * refusal is settled first, against the live graph *with the removals
 * taken out and the additions merged in*, and then everything is written
 * in one transaction — every removal and addition, or none.
 *
 * One engine comment on the item says what changed and who asked
 * (invariant 4), because whoever picks the item up next reads its
 * thread, and an item that suddenly waits — or suddenly does not — with
 * nothing in its thread saying why is worse than one that never moved.
 */

/** What a caller asks to change. Each entry names an item by key (`EO-42`) or by id. */
export interface DependencyChangeRequest {
  add: readonly string[];
  remove: readonly string[];
}

/** A change judged to be allowed, holding the items it names. */
export interface DependencyChangePlan {
  item: Item;
  add: Item[];
  remove: Item[];
}

/** A change written: what it did, and the comment that says so. */
export interface DependencyChangeApplied {
  item: Item;
  added: Item[];
  removed: Item[];
  /** What the item still waits for that has not finished, after the change. */
  open: Item[];
  /**
   * This change is what freed it: it waited for something open, and now
   * waits for nothing open. The scheduler offers it on its next tick.
   */
  freed: boolean;
  comment: Comment;
}

export type DependencyChangeOutcome = { ok: true; applied: DependencyChangeApplied | null } | { ok: false; reason: string };

/** A UUID, which is what every item id is — anything else is read as a key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a request asks for anything at all. */
export function asksForDependencyChange(request: Partial<DependencyChangeRequest>): boolean {
  return (request.add?.length ?? 0) > 0 || (request.remove?.length ?? 0) > 0;
}

/**
 * The item a caller named — by key or by id, as everywhere an item's id
 * is asked for — or undefined. A key is upper-cased first, because a
 * prefix is stored that way and a person typing `eo-42` meant `EO-42`.
 */
function itemNamed(db: Db, reference: string): Item | undefined {
  const wanted = reference.trim();
  if (UUID.test(wanted)) return getItem(db, wanted as Uuid);
  return getItemByKey(db, wanted.toUpperCase());
}

/**
 * Whether this change may be made, judged without writing anything.
 *
 * Refuses, naming the items by key: an item that may not change
 * (`refuseIfUntouchable`, the rule an amendment is held to), a reference
 * naming nothing, the item itself, an item on another project, an item
 * named both to add and to remove, an edge to add that is already there
 * or one to remove that is not, and an addition that would close a cycle
 * once the whole change is merged into the live graph.
 *
 * A request asking for nothing is allowed and plans nothing — no guard
 * runs, because nothing would change.
 */
export function judgeDependencyChange(db: Db, item: Item, request: DependencyChangeRequest): { ok: true; plan: DependencyChangePlan } | { ok: false; reason: string } {
  if (!asksForDependencyChange(request)) return { ok: true, plan: { item, add: [], remove: [] } };

  const refusal = refuseIfUntouchable(db, item, "content");
  if (refusal) return { ok: false, reason: refusal };

  const resolve = (references: readonly string[]): { ok: true; items: Item[] } | { ok: false; reason: string } => {
    const found = new Map<string, Item>();
    for (const reference of references) {
      const other = itemNamed(db, reference);
      if (!other) return { ok: false, reason: `There is no ticket ${reference.trim()}.` };
      if (other.id === item.id) return { ok: false, reason: `${item.key} cannot depend on itself.` };
      if (other.projectId !== item.projectId) return { ok: false, reason: `${other.key} is on a different project from ${item.key}.` };
      // The same item named twice is one edge, asked for twice.
      found.set(other.id, other);
    }
    return { ok: true, items: [...found.values()] };
  };

  const remove = resolve(request.remove);
  if (!remove.ok) return remove;
  const add = resolve(request.add);
  if (!add.ok) return add;

  const both = add.items.find((other) => remove.items.some((candidate) => candidate.id === other.id));
  if (both) return { ok: false, reason: `${both.key} is named both to add and to remove, so it is not clear whether ${item.key} should wait for it.` };

  const existing = new Set(listDependencies(db, item.id).map((edge) => edge.dependsOnId as string));
  const absent = remove.items.find((other) => !existing.has(other.id));
  if (absent) return { ok: false, reason: `${item.key} does not wait for ${absent.key}, so there is nothing to remove.` };
  const already = add.items.find((other) => existing.has(other.id));
  if (already) return { ok: false, reason: `${item.key} already waits for ${already.key}.` };

  // The live graph with this change's removals taken out, and its
  // additions merged in one at a time, so the one that closes a loop is
  // the one named.
  const removed = new Set(remove.items.map((other) => other.id as string));
  const graph = listAllDependencies(db).filter((edge) => !(edge.itemId === item.id && removed.has(edge.dependsOnId)));
  for (const other of add.items) {
    graph.push({ itemId: item.id, dependsOnId: other.id });
    const cycle = detectCycle(graph);
    if (cycle) {
      const readable = formatCyclePath(cycle.map((id) => getItem(db, id)?.key ?? id) as Uuid[]);
      return { ok: false, reason: circularRefusal(item.key, other.key, readable) };
    }
  }

  return { ok: true, plan: { item, add: add.items, remove: remove.items } };
}

/**
 * Writes a change `judgeDependencyChange` allowed, in one transaction,
 * with the one comment that says so.
 *
 * `header` is the comment's first line, and is where who asked goes: the
 * conversation a reorder card was approved from, or the person behind an
 * `items:update`.
 *
 * Nested inside a caller's transaction — the approval door's — this is a
 * savepoint, and a throw from inside it rolls back with the caller.
 */
export function applyDependencyChange(db: Db, plan: DependencyChangePlan, header: string): DependencyChangeApplied {
  const { item } = plan;
  return db.transaction((tx) => {
    const writer = tx as unknown as Db;
    const before = openDependencies(writer, item.id);

    for (const other of plan.remove) removeDependency(writer, item.id, other.id);
    // `addDependency` checks for a cycle again and throws if it finds one.
    // The judgement above already ruled that out against this same graph,
    // so a throw here is a bug, and it rolls the whole change back.
    for (const other of plan.add) addDependency(writer, item.id, other.id);

    // The edges travel with the item to every replica (EO-434), and a
    // replica takes an item only when it is newer than its copy — so an
    // item whose edges changed has changed.
    updateItem(writer, item.id, {});

    const open = openDependencies(writer, item.id);
    const freed = plan.remove.length > 0 && before.length > 0 && open.length === 0;
    const lines = dependencyChangeLines(item, plan, freed);
    const comment = postComment(writer, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "decision",
      parseBodyMentions: false,
      body: [header, "", ...lines].join("\n"),
    });

    return { item: getItem(writer, item.id) ?? item, added: plan.add, removed: plan.remove, open, freed, comment };
  });
}

/**
 * Judges and writes a change, or says why not and writes nothing.
 *
 * `applied` is null for a request that asked for nothing: there is
 * nothing to say on the item about a change that did not happen.
 */
export function changeItemDependencies(db: Db, item: Item, request: DependencyChangeRequest, header: string): DependencyChangeOutcome {
  const judged = judgeDependencyChange(db, item, request);
  if (!judged.ok) return judged;
  if (judged.plan.add.length === 0 && judged.plan.remove.length === 0) return { ok: true, applied: null };
  return { ok: true, applied: applyDependencyChange(db, judged.plan, header) };
}

/** What an item waits for that has not finished — the same "finished" the board and the scheduler read. */
function openDependencies(db: Db, itemId: Uuid): Item[] {
  const dependencies = listItemsByIds(
    db,
    listDependencies(db, itemId).map((edge) => edge.dependsOnId),
  );
  const finished = finishedItemIds(db, dependencies);
  return dependencies.filter((dependency) => !finished.has(dependency.id));
}

/** The comment's lines after its header: what it now waits for, what it no longer waits for, and whether that freed it. */
function dependencyChangeLines(item: Item, plan: DependencyChangePlan, freed: boolean): string[] {
  const named = (items: readonly Item[]): string => items.map((other) => `${other.key} (${other.title})`).join(", ");
  const lines: string[] = [];
  if (plan.add.length > 0) lines.push(`Now waits for: ${named(plan.add)}`);
  if (plan.remove.length > 0) lines.push(`No longer waits for: ${named(plan.remove)}`);
  if (freed) lines.push("", freedSentence(item.key));
  return lines;
}

/**
 * The sentence a circular edge is refused with, for whoever refuses one.
 *
 * Shared with the creation doors (a new item's `dependsOn`, a module's
 * creation, EO-434) so that every refusal of a loop says it in the same
 * words.
 */
export function circularRefusal(waiting: string, waitedFor: string, path: string): string {
  return `${waiting} cannot wait for ${waitedFor} — that would make the dependencies circular: ${path}.`;
}

/** The sentence an `items:update` answer and a tool add when a change freed the item. */
export function freedSentence(itemKey: string): string {
  return `Nothing ${itemKey} waits for is still open, so it can be picked up on the next tick.`;
}

/**
 * The first line of the comment a change posts on the item: who asked —
 * and, for a reorder card approved in a conversation, why.
 */
export function dependencyChangeHeader(itemKey: string, by: string, why: string | null = null): string {
  return why === null ? `What ${itemKey} waits for was changed by ${by}.` : `Reordered from a conversation by ${by}: ${why}`;
}

/** What a written change did, by key, as `items:update` and `record:changeDependencies` answer it. */
export interface DependencyChangeSummary {
  added: string[];
  removed: string[];
  stillWaitsFor: string[];
  freed: boolean;
}

export function summariseDependencyChange(applied: DependencyChangeApplied): DependencyChangeSummary {
  return {
    added: applied.added.map((other) => other.key),
    removed: applied.removed.map((other) => other.key),
    stillWaitsFor: applied.open.map((other) => other.key),
    freed: applied.freed,
  };
}

/**
 * A change asked for by an item's id and a person's name — what a record
 * does when it is asked (`ItemRecord.changeDependencies`), on this
 * database or on the organisation's server.
 */
export function changeDependenciesOf(db: Db, itemId: Uuid, request: DependencyChangeRequest, by: string, why: string | null = null): DependencyChangeOutcome {
  const item = getItem(db, itemId);
  if (!item) return { ok: false, reason: "That ticket no longer exists." };
  return changeItemDependencies(db, item, request, dependencyChangeHeader(item.key, by, why));
}
