import {
  dependencyOnItem,
  gateInWords,
  type Comment,
  type DependencyGateRequest,
  type DependencyOnItem,
  type DependencyWait,
  type Item,
  type ItemDep,
  type Uuid,
} from "@eo/core";
import { detectCycle, formatCyclePath, type Edge } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  addDependency,
  finishedItemIds,
  gateArrivals,
  getItem,
  getItemByKey,
  getStep,
  listAllDependencies,
  listDependencies,
  listItemsByIds,
  listStepsForPipeline,
  postComment,
  removeDependency,
  setDependencyGate,
  updateItem,
  type DependencyGate,
} from "../db/repos/index.js";
import { reachedGateWarning } from "../packs/developer/workspace/stackGateWarning.js";
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

/**
 * What a caller asks to change. Each entry names an item by key (`EO-42`)
 * or by id; an addition may be the object form `{ item, wait, step? }`,
 * which sets its rule (EO-777), and `update` gives an edge that already
 * exists a new one. A bare key is `finished`.
 */
export interface DependencyChangeRequest {
  add: readonly DependencyOnItem[];
  remove: readonly string[];
  update?: readonly DependencyOnItem[];
}

/** One edge a change writes: the item at its other end, and the rule it waits by. */
export interface GatedDependency {
  item: Item;
  gate: DependencyGate;
}

/** An edge whose rule a change replaces, with the rule it had. */
export interface ChangedDependency extends GatedDependency {
  before: DependencyGate;
}

/** A change judged to be allowed, holding the items it names. */
export interface DependencyChangePlan {
  item: Item;
  add: GatedDependency[];
  remove: Item[];
  update: ChangedDependency[];
}

/** A change written: what it did, and the comment that says so. */
export interface DependencyChangeApplied {
  item: Item;
  added: GatedDependency[];
  removed: Item[];
  updated: ChangedDependency[];
  /** What the item still waits for that has not finished, after the change. */
  open: Item[];
  /**
   * This change is what freed it: it waited for something open, and now
   * waits for nothing open. The scheduler offers it on its next tick.
   */
  freed: boolean;
  /**
   * What the change was written despite (EO-780): a `reached` rule on a
   * step its dependency can arrive at before anything is implemented, in
   * a repository where that releases the item onto an empty branch. Said
   * in the comment and in the answer; never a refusal.
   */
  warnings: string[];
  comment: Comment;
}

export type DependencyChangeOutcome = { ok: true; applied: DependencyChangeApplied | null } | { ok: false; reason: string };

/** A UUID, which is what every item id is — anything else is read as a key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a request asks for anything at all. */
export function asksForDependencyChange(request: Partial<DependencyChangeRequest>): boolean {
  return (request.add?.length ?? 0) > 0 || (request.remove?.length ?? 0) > 0 || (request.update?.length ?? 0) > 0;
}

/** The step name a gate waits for, or null where it waits for none or its step is gone. */
export function gateStepName(db: Db, gate: Pick<ItemDep, "wait" | "waitStepId">): string | null {
  return gate.wait === "reached" && gate.waitStepId !== null ? (getStep(db, gate.waitStepId)?.name ?? null) : null;
}

/** An edge's rule as the store reads it, in the shape a change writes it. */
function gateOfEdge(edge: Pick<ItemDep, "wait" | "waitStepId">): DependencyGate {
  if (edge.wait === "reached" && edge.waitStepId !== null) return { wait: "reached", stepId: edge.waitStepId };
  return edge.wait === "none" ? { wait: "none" } : { wait: "finished" };
}

function sameGate(a: DependencyGate, b: DependencyGate): boolean {
  return a.wait === b.wait && (a.wait !== "reached" || (b.wait === "reached" && a.stepId === b.stepId));
}

/**
 * The rule one edge asks for, with its step resolved against the
 * dependency's pipeline, or the sentence refusing it (EO-777).
 *
 * The one place the rule is judged, for every door that writes an edge:
 * `items:update` and the reorder card through `judgeDependencyChange`, a
 * new item's `dependsOn` and a module's creation through
 * `resolveDependsOn`, and a plan's stories through `applyRefine`.
 *
 * - `step` goes with `reached` and nothing else — a blank one included.
 * - `reached` needs a step, on the dependency's *current* pipeline, that
 *   is not terminal: arriving at a terminal step is finishing, which is
 *   what `finished` says. A name is matched as written and then without
 *   regard to case; a step's id is taken too.
 * - Every refusal names the dependency (`label`, its key or a story's
 *   place in a plan) and, for a step it cannot use, lists the steps it
 *   can.
 */
export function judgeGate(
  db: Db,
  dependency: { label: string; pipelineId: string | null },
  request: DependencyGateRequest,
): { ok: true; gate: DependencyGate } | { ok: false; reason: string } {
  const step = request.step?.trim() ?? "";
  if (request.wait !== "reached") {
    // Any step supplied at all, blank or not: a caller who wrote one
    // meant something by it, and leaving it unread would be deciding
    // for them what it meant.
    if (request.step !== null && request.step !== undefined) {
      return {
        ok: false,
        reason: `A step goes only with wait: "reached", and the rule for ${dependency.label} is wait: "${request.wait}". Leave step out, or use wait: "reached" to wait for ${dependency.label} to reach it.`,
      };
    }
    return { ok: true, gate: request.wait === "none" ? { wait: "none" } : { wait: "finished" } };
  }

  const steps = dependency.pipelineId === null ? [] : listStepsForPipeline(db, dependency.pipelineId);
  const usable = steps.filter((candidate) => !candidate.isTerminal);
  const listed = usable.length === 0 ? "it has none that are not where it finishes" : `its steps are ${usable.map((candidate) => `"${candidate.name}"`).join(", ")}`;
  if (dependency.pipelineId === null || steps.length === 0) {
    return { ok: false, reason: `${dependency.label} is on no pipeline, so there is no step for it to reach. Use wait: "finished" or wait: "none" for it.` };
  }
  if (step === "") {
    return { ok: false, reason: `wait: "reached" needs the step of ${dependency.label}'s pipeline to wait for, and ${listed}.` };
  }
  const named =
    steps.find((candidate) => candidate.id === step) ??
    steps.find((candidate) => candidate.name === step) ??
    steps.find((candidate) => candidate.name.toLowerCase() === step.toLowerCase());
  if (named === undefined) {
    return { ok: false, reason: `${dependency.label}'s pipeline has no step "${step}": ${listed}.` };
  }
  if (named.isTerminal) {
    return {
      ok: false,
      reason: `"${named.name}" is where ${dependency.label}'s pipeline finishes, so reaching it is finishing — use wait: "finished" (or leave wait out) to wait for ${dependency.label} to finish.`,
    };
  }
  return { ok: true, gate: { wait: "reached", stepId: named.id } };
}

/**
 * The words a gate is said in on an item's thread (EO-777): "waits for
 * EO-14 (Title) to reach Watch merge request".
 */
function gateWords(db: Db, dependency: Item, gate: DependencyGate): string {
  const stepName = gate.wait === "reached" ? (getStep(db, gate.stepId)?.name ?? null) : null;
  return gateInWords(`${dependency.key} (${dependency.title})`, gate.wait as DependencyWait, stepName);
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
 * once the whole change is merged into the live graph. And for a rule
 * (EO-777): a rule `judgeGate` refuses, a rule to change on an edge that
 * is not there, one item named twice with two rules, and one named both
 * to change and to add or remove. A new rule equal to the edge's own is
 * dropped from the plan, so it writes and says nothing.
 *
 * A request asking for nothing is allowed and plans nothing — no guard
 * runs, because nothing would change.
 */
export function judgeDependencyChange(db: Db, item: Item, request: DependencyChangeRequest): { ok: true; plan: DependencyChangePlan } | { ok: false; reason: string } {
  if (!asksForDependencyChange(request)) return { ok: true, plan: { item, add: [], remove: [], update: [] } };

  const refusal = refuseIfUntouchable(db, item, "content");
  if (refusal) return { ok: false, reason: refusal };

  const named = (reference: string): { ok: true; item: Item } | { ok: false; reason: string } => {
    const other = itemNamed(db, reference);
    if (!other) return { ok: false, reason: `There is no ticket ${reference.trim()}.` };
    if (other.id === item.id) return { ok: false, reason: `${item.key} cannot depend on itself.` };
    if (other.projectId !== item.projectId) return { ok: false, reason: `${other.key} is on a different project from ${item.key}.` };
    return { ok: true, item: other };
  };

  const removed = new Map<string, Item>();
  for (const reference of request.remove) {
    const other = named(reference);
    if (!other.ok) return other;
    // The same item named twice is one edge, asked for twice.
    removed.set(other.item.id, other.item);
  }

  // Each addition and each new rule with its step resolved against the
  // dependency's pipeline. The same item named twice is one edge asked
  // for twice — unless the two ask for different rules, which is not
  // clear enough to write.
  const gated = (entries: readonly DependencyOnItem[]): { ok: true; edges: GatedDependency[] } | { ok: false; reason: string } => {
    const found = new Map<string, GatedDependency>();
    for (const entry of entries) {
      const { reference, gate } = dependencyOnItem(entry);
      const other = named(reference);
      if (!other.ok) return other;
      const judged = judgeGate(db, { label: other.item.key, pipelineId: other.item.stepId === null ? null : other.item.pipelineId }, gate);
      if (!judged.ok) return judged;
      const earlier = found.get(other.item.id);
      if (earlier !== undefined && !sameGate(earlier.gate, judged.gate)) {
        return { ok: false, reason: `${other.item.key} is named twice with two different rules, so it is not clear what ${item.key} should wait for.` };
      }
      found.set(other.item.id, { item: other.item, gate: judged.gate });
    }
    return { ok: true, edges: [...found.values()] };
  };
  const add = gated(request.add);
  if (!add.ok) return add;
  const update = gated(request.update ?? []);
  if (!update.ok) return update;

  const both = add.edges.find((edge) => removed.has(edge.item.id));
  if (both) return { ok: false, reason: `${both.item.key} is named both to add and to remove, so it is not clear whether ${item.key} should wait for it.` };
  const changedAndRemoved = update.edges.find((edge) => removed.has(edge.item.id));
  if (changedAndRemoved) {
    return { ok: false, reason: `${changedAndRemoved.item.key} is named both to change and to remove, so it is not clear whether ${item.key} should wait for it.` };
  }
  const changedAndAdded = update.edges.find((edge) => add.edges.some((candidate) => candidate.item.id === edge.item.id));
  if (changedAndAdded) {
    return { ok: false, reason: `${changedAndAdded.item.key} is named both to add and to change; name it once — to add if ${item.key} does not wait for it yet, to change if it does.` };
  }

  const existing = new Map(listDependencies(db, item.id).map((edge) => [edge.dependsOnId as string, edge]));
  const absent = [...removed.values()].find((other) => !existing.has(other.id));
  if (absent) return { ok: false, reason: `${item.key} does not wait for ${absent.key}, so there is nothing to remove.` };
  const already = add.edges.find((edge) => existing.has(edge.item.id));
  if (already) {
    return {
      ok: false,
      reason: `${item.key} already waits for ${already.item.key}. To change the rule it waits by, name it in updateDependsOn instead.`,
    };
  }
  const notThere = update.edges.find((edge) => !existing.has(edge.item.id));
  if (notThere) {
    return { ok: false, reason: `${item.key} does not wait for ${notThere.item.key}, so there is no rule to change. Add it with addDependsOn instead.` };
  }
  // A new rule that is the rule the edge already has changes nothing,
  // and is said nowhere.
  const changed: ChangedDependency[] = update.edges
    .map((edge) => ({ ...edge, before: gateOfEdge(existing.get(edge.item.id)!) }))
    .filter((edge) => !sameGate(edge.before, edge.gate));

  // The live graph with this change's removals taken out, and its
  // additions merged in one at a time, so the one that closes a loop is
  // the one named. A new rule on an edge already there adds no edge, and
  // every rule, `none` included, counts as an edge here.
  const graph: Edge[] = listAllDependencies(db).filter((edge) => !(edge.itemId === item.id && removed.has(edge.dependsOnId)));
  for (const { item: other } of add.edges) {
    graph.push({ itemId: item.id, dependsOnId: other.id });
    const cycle = detectCycle(graph);
    if (cycle) {
      const readable = formatCyclePath(cycle.map((id) => getItem(db, id)?.key ?? id) as Uuid[]);
      return { ok: false, reason: circularRefusal(item.key, other.key, readable) };
    }
  }

  return { ok: true, plan: { item, add: add.edges, remove: [...removed.values()], update: changed } };
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
    for (const edge of plan.add) addDependency(writer, item.id, edge.item.id, edge.gate);
    for (const edge of plan.update) setDependencyGate(writer, item.id, edge.item.id, edge.gate);

    // The edges travel with the item to every replica (EO-434), and a
    // replica takes an item only when it is newer than its copy — so an
    // item whose edges changed has changed.
    updateItem(writer, item.id, {});

    const open = openDependencies(writer, item.id);
    const freed = (plan.remove.length > 0 || plan.update.length > 0) && before.length > 0 && open.length === 0;
    const lines = dependencyChangeLines(writer, item, plan, freed);
    const warnings = [...plan.add, ...plan.update].flatMap((edge) =>
      edge.gate.wait === "reached" ? (reachedGateWarning(writer, item, edge.item, edge.gate.stepId) ?? []) : [],
    );
    const comment = postComment(writer, {
      itemId: item.id,
      author: { type: "engine" },
      kind: "decision",
      parseBodyMentions: false,
      body: [header, "", ...lines, ...(warnings.length === 0 ? [] : ["", ...warnings.map((warning) => `Warning: ${warning}`)])].join("\n"),
    });

    return { item: getItem(writer, item.id) ?? item, added: plan.add, removed: plan.remove, updated: plan.update, open, freed, warnings, comment };
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
  if (judged.plan.add.length === 0 && judged.plan.remove.length === 0 && judged.plan.update.length === 0) return { ok: true, applied: null };
  return { ok: true, applied: applyDependencyChange(db, judged.plan, header) };
}

/**
 * What an item still waits for — the same rule the board and the
 * scheduler read (EO-776): an edge holds while its dependency has not
 * finished, unless its rule is `none`, or `reached` and the dependency
 * has arrived at its step.
 */
function openDependencies(db: Db, itemId: Uuid): Item[] {
  const edges = listDependencies(db, itemId);
  const dependencies = listItemsByIds(
    db,
    edges.map((edge) => edge.dependsOnId),
  );
  const finished = finishedItemIds(db, dependencies);
  const arrivals = gateArrivals(db, edges);
  const holding = new Set(
    edges
      .filter((edge) => edge.wait !== "none")
      .filter((edge) => !(edge.wait === "reached" && edge.waitStepId !== null && arrivals.get(edge.dependsOnId)?.has(edge.waitStepId)))
      .map((edge) => edge.dependsOnId as string),
  );
  return dependencies.filter((dependency) => !finished.has(dependency.id) && holding.has(dependency.id));
}

/**
 * The comment's lines after its header: what it now waits for, what it
 * no longer waits for, each rule it set or changed in words (EO-777),
 * and whether that freed it.
 *
 * Additions that wait for their dependency to finish are listed on one
 * line, as every addition was before rules existed; one with any other
 * rule, and every changed rule, gets a line of its own saying it.
 */
function dependencyChangeLines(db: Db, item: Item, plan: DependencyChangePlan, freed: boolean): string[] {
  const named = (items: readonly Item[]): string => items.map((other) => `${other.key} (${other.title})`).join(", ");
  const lines: string[] = [];
  const finishing = plan.add.filter((edge) => edge.gate.wait === "finished").map((edge) => edge.item);
  if (finishing.length > 0) lines.push(`Now waits for: ${named(finishing)}`);
  for (const edge of plan.add.filter((candidate) => candidate.gate.wait !== "finished")) lines.push(`Now ${gateWords(db, edge.item, edge.gate)}.`);
  for (const edge of plan.update) lines.push(`Now ${gateWords(db, edge.item, edge.gate)} — before, it ${gateWords(db, edge.item, edge.before)}.`);
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
  /** The edges whose rule changed (EO-777). Left out where none did, so an answer written before rules reads the same. */
  updated?: string[];
  stillWaitsFor: string[];
  freed: boolean;
  /** What the change was written despite (EO-780). Left out where there is nothing to warn of. */
  warnings?: string[] | undefined;
}

export function summariseDependencyChange(applied: DependencyChangeApplied): DependencyChangeSummary {
  return {
    added: applied.added.map((edge) => edge.item.key),
    removed: applied.removed.map((other) => other.key),
    ...(applied.updated.length === 0 ? {} : { updated: applied.updated.map((edge) => edge.item.key) }),
    stillWaitsFor: applied.open.map((other) => other.key),
    freed: applied.freed,
    ...(applied.warnings.length === 0 ? {} : { warnings: applied.warnings }),
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
