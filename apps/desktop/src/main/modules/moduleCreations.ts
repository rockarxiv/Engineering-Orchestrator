import {
  MAX_ITEM_GENERATION,
  MAX_MODULE_CREATIONS_PER_RUN,
  MODULE_CREATION_WAITS,
  type Item,
  type ItemDep,
  type ModuleCreation,
  type ModuleCreationAnswer,
  type ModuleCreationWait,
  type Uuid,
} from "@eo/core";
import { detectCycle, formatCyclePath } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  createdItemFor,
  getItem,
  itemGeneration,
  itemsCreatedByRun,
  listAllDependencies,
  listDependencies,
  postComment,
  recordItemOrigin,
  resolveItemType,
  updateItem,
} from "../db/repos/index.js";
import { addEdge, applyNewItem, circularRefusal, resolveDependsOn } from "../roles/discussion.js";
import type { ModuleCommentContext } from "./moduleComments.js";
import { creationCapRefusal, creationWaitRefusal } from "./runModule.js";

/**
 * Creating the item a module asked for (EO-433).
 *
 * The host cannot do this for the reason it cannot post a comment
 * (`moduleComments.ts`): its handle is read-only, and an item is more
 * than a row — a key minted from the project's counter, a pipeline
 * version bound on entry, an assignee on arrival. So `ctx.createItem` is
 * an event on fd 3, `runModule` checks and redacts it, and this is what
 * turns it into an item.
 *
 * **It goes through `applyNewItem`**, the door `work_submit_ticket`
 * uses, so a module's item is held to the bar any item handed over
 * complete is held to: a type the project has, not a container, a spec
 * its type's own shape accepts, a parent that holds work and is on this
 * project, a pipeline that exists. None of those rules is restated here
 * and no type's word is written here — which types hold work is the
 * container flag's answer, and which fields one needs is its shape's.
 *
 * What this adds is what a module needs and a person does not: the
 * creation is repeatable, the chain is bounded, and both items say what
 * happened.
 *
 * **And either side can wait for the other (EO-434).** `wait` and
 * `dependsOn` are dependency edges and nothing more — the scheduler
 * already holds an item at a step it would dispatch while something it
 * depends on is unfinished, so nothing here holds anything. What this
 * file owes is that the item and its edges are *one write*: an edge
 * that cannot be added leaves no item behind.
 */

/**
 * A refusal found after something was written, thrown so the
 * transaction takes it all back.
 *
 * `applyNewItem` answers `{ ok: false }` rather than throwing, and by
 * the time it refuses an edge the item is already inserted — which is
 * harmless where its caller owns no transaction and wrong here, where
 * returning normally would commit an item the module was just told does
 * not exist.
 */
class CreationRefused extends Error {}

/** Stands for the item not yet created while the graph is asked whether it would be circular. */
const NEW_ITEM = "the new item" as Uuid;

/**
 * Whether the edges a creation asks for would be circular, asked before
 * the item exists.
 *
 * Before, and not by creating it and seeing which edge is refused: the
 * refusal names items by key, and an item that is about to be taken
 * back has a key that the next creation will be given. So the item
 * stands in the graph under a placeholder and is called what it is.
 *
 * Only `this_waits` can close a loop — a new item has nothing waiting
 * for it until the originating item does — but the whole graph is asked
 * rather than that one case reasoned out here.
 */
function circularBeforeCreating(db: Db, origin: Item, wait: ModuleCreation["wait"], waitedFor: readonly Item[]): string | null {
  const proposed: ItemDep[] = waitedFor.map((other) => ({ itemId: NEW_ITEM, dependsOnId: other.id as Uuid }));
  if (wait === "this_waits") proposed.push({ itemId: origin.id as Uuid, dependsOnId: NEW_ITEM });
  if (wait === "created_waits") proposed.push({ itemId: NEW_ITEM, dependsOnId: origin.id as Uuid });
  const cycle = detectCycle([...listAllDependencies(db), ...proposed]);
  if (cycle === null) return null;
  // Told from the originating item round to itself, whichever node the
  // search happened to enter the loop at: it is the item the module was
  // run on, so it is where a reader starts.
  const loop = cycle.slice(0, -1);
  const from = Math.max(loop.indexOf(origin.id as Uuid), 0);
  const told = [...loop.slice(from), ...loop.slice(0, from)];
  const path = formatCyclePath([...told, told[0]!].map((id) => (id === NEW_ITEM ? NEW_ITEM : (getItem(db, id)?.key ?? id))) as Uuid[]);
  return wait === "this_waits" ? circularRefusal(origin.key, NEW_ITEM, path) : circularRefusal(NEW_ITEM, waitedFor.map((other) => other.key).join(", "), path);
}

function isWait(value: unknown): value is ModuleCreationWait {
  return (MODULE_CREATION_WAITS as readonly unknown[]).includes(value);
}

/** Adds the edge unless it is already there. An edge is a fact, and a repeat states it again rather than twice. */
function ensureEdge(db: Db, item: Item, dependsOn: Item): string | null {
  if (listDependencies(db, item.id as Uuid).some((edge) => edge.dependsOnId === dependsOn.id)) return null;
  return addEdge(db, item, dependsOn);
}

/** The edge `wait` names between the two items, if it names one. */
function ensureWaitEdge(db: Db, origin: Item, created: Item, wait: ModuleCreation["wait"]): string | null {
  if (wait === "this_waits") return ensureEdge(db, origin, created);
  if (wait === "created_waits") return ensureEdge(db, created, origin);
  return null;
}

/** Re-exported from `@eo/core`, where the record reads it too. */
export { MAX_ITEM_GENERATION };

/** Why a module running on a trial item may not create one (EO-582). */
export function trialCreationRefusal(key: string): string {
  return `${key} is a trial item, filed to test a pipeline draft, and an item created from it would be live work that outlives the trial — so nothing was created.`;
}

export interface ModuleCreationOptions {
  /**
   * The process that ran the module says this run has created its ten.
   *
   * Applied here, after the lookup for an item this key already made,
   * because that order is the whole point: a repeat is answered at the
   * cap and only a *new* item is refused. This function also counts for
   * itself — the items this run is recorded as having created — so the
   * cap holds where nobody upstream is counting, and on the record,
   * where the device's count is a claim.
   */
  atCap?: boolean;
  /** Told the new item's id once it exists, so whoever wired this can tell open windows. */
  onCreated?: (itemId: Uuid) => void;
}

/**
 * Creates one item, or says why it did not. Never throws: the answer
 * goes back to a module that is usually still running, and `runModule`
 * writes a refusal to the transcript (invariant #8).
 *
 * `creation` arrives already checked for shape and already redacted.
 *
 * Run against whichever database owns the originating item: this
 * installation's own, or — for a project an organisation holds — the
 * record's, where `serveCreateItem` calls it with what a device sent.
 * One function for both, so a creation is held to one set of guards
 * wherever it is performed.
 */
export function postModuleCreation(db: Db, context: ModuleCommentContext, creation: ModuleCreation, options: ModuleCreationOptions = {}): ModuleCreationAnswer {
  // Read again rather than taken from the context: the item can have
  // been deleted since the run started, and everything below hangs off
  // its row.
  const origin = getItem(db, context.item.id as Uuid);
  if (!origin) return { created: false, reason: `${context.item.key} no longer exists, so nothing can be created from it.` };
  // Not from a trial item (EO-582, ARCHITECTURE.md, "Trial pipelines").
  // The door below places work on the pipelines a person can see — the
  // one named, or the project's only one — and a trial is never one of
  // them, so whatever it filed would be unmarked live work: on the board
  // the trial's draft would replace, and still there after the trial is
  // discarded. Refused before anything is written, and said to the module
  // in words it can report.
  if (origin.trialAt !== null) {
    return { created: false, reason: trialCreationRefusal(origin.key) };
  }

  // Checked by whoever ran the module, and again here: on a managed
  // project this is the record, and what reached it is what a device
  // sent. A `wait` read as `none` would let a module that asked to be
  // held run on.
  // Only leaving it out means `none` — a `null` is refused with the rest.
  const wait: unknown = creation.wait === undefined ? "none" : creation.wait;
  if (!isWait(wait)) return { created: false, reason: creationWaitRefusal() };
  const dependsOnKeys = [...new Set(creation.dependsOn ?? [])];

  let made: Item;
  try {
    const outcome = db.transaction((): ModuleCreationAnswer | { item: Item } => {
      // Running twice. Before every other check, because a repeat is
      // answered with what the first call made whatever has changed
      // since — a type removed, a pipeline renamed — and creates nothing.
      // Archived still answers; a deleted item's row went with it.
      const before = createdItemFor(db, origin.id as Uuid, creation.idempotencyKey);
      if (before) {
        const existing = getItem(db, before.itemId);
        if (existing) {
          // A repeat creates nothing and says nothing, and it still
          // means what it says about waiting (EO-434): each edge it
          // names is there afterwards, once. One the first call already
          // added is left alone; one that is missing — the first call
          // named no `wait`, or somebody removed it — is added, because
          // a step that reruns and asks to be held must be. One that
          // cannot be added refuses the call and adds none of them.
          const waitedFor = resolveDependsOn(db, origin.projectId, dependsOnKeys);
          if (!waitedFor.ok) return { created: false, reason: waitedFor.reason };
          const edgesBefore = listAllDependencies(db).length;
          for (const other of waitedFor.items) {
            const problem = ensureEdge(db, existing, other);
            if (problem) throw new CreationRefused(problem);
          }
          const problem = ensureWaitEdge(db, origin, existing, wait);
          if (problem) throw new CreationRefused(problem);
          // An edge has no stamp of its own and reaches a replica with
          // the items at its ends (`RecordItemWaitsSchema`). A new item
          // is sent because it is new; one that only gained an edge has
          // to be marked changed, or no desktop hears of it.
          if (listAllDependencies(db).length !== edgesBefore) updateItem(db, existing.id as Uuid, {});
          return { created: true, key: existing.key, existing: true };
        }
      }

      // The cap, after the repeat and never before it: a run that has
      // made its ten is still told about an item an earlier call made,
      // and is refused only an eleventh. Both counts, either enough.
      const madeByThisRun = context.runId === null ? 0 : itemsCreatedByRun(db, context.runId);
      if (options.atCap === true || madeByThisRun >= MAX_MODULE_CREATIONS_PER_RUN) return { created: false, reason: creationCapRefusal() };

      const generation = itemGeneration(db, origin.id as Uuid);
      if (generation >= MAX_ITEM_GENERATION) {
        return {
          created: false,
          reason:
            `${origin.key} is generation ${generation} — it is ${generation} creations away from an item a person filed — ` +
            `and a run on a generation ${MAX_ITEM_GENERATION} item cannot create another.`,
        };
      }

      const projectId = origin.projectId;
      // Found here as `submitItem` finds it, so what is handed to the
      // door is the row by its pack and its word rather than a bare slug
      // two packs might both ship.
      const type = resolveItemType(db, projectId, creation.type);
      if (!type.ok) return { created: false, reason: type.problem };

      // What it waits for, and whether saying so would be circular —
      // settled before the item exists, so a refusal has nothing to
      // take back and names nothing that is about to disappear.
      const waitedFor = resolveDependsOn(db, projectId, dependsOnKeys);
      if (!waitedFor.ok) return { created: false, reason: waitedFor.reason };
      const circular = circularBeforeCreating(db, origin, wait, waitedFor.items);
      if (circular !== null) return { created: false, reason: circular };

      const applied = applyNewItem(
        db,
        projectId,
        {
          type: { packSlug: type.type.packSlug, slug: type.type.slug },
          title: creation.title,
          body: creation.body,
          spec: creation.spec,
          // The other items it waits for (EO-434). The edge between
          // it and the originating item is added below: that one has an
          // end the door cannot be told about before the item exists.
          // The originating item itself is left out where `created_waits`
          // already says it, so the edge is written once.
          // By the items the keys resolved to rather than by the keys
          // as written, so two spellings of one item are one edge.
          depends_on: [...new Set(waitedFor.items.filter((other) => !(wait === "created_waits" && other.id === origin.id)).map((other) => other.key))],
          ...(creation.parent === undefined ? {} : { parent: creation.parent }),
          // The pipeline the module named, or none — and with none the
          // door's own rule applies: the project's only pipeline, or a
          // refusal listing them. Never the originating item's own,
          // which for a finished item is wherever it came to rest.
          ...(creation.pipeline === undefined ? {} : { pipeline: creation.pipeline }),
          ...(creation.repository === undefined ? {} : { repository: creation.repository }),
          fallbackWorkspaceId: origin.workspaceId,
          // Whoever filed the item this came from. A module is nobody,
          // and the local person on whichever machine ran it is not who
          // asked for this work.
          createdBy: origin.createdBy,
        },
        null,
      );
      // Thrown, not returned: the door can refuse after it has inserted
      // (an edge it could not add), and returning would commit that.
      if (!applied.ok) throw new CreationRefused(applied.reason);
      const item = applied.created[0];
      if (!item) throw new CreationRefused("nothing was created.");

      // Who waits for whom. In the same transaction as the item, so an
      // edge that cannot be added leaves no item: a module told it is
      // held behind work that was filed without the edge would not be.
      const unheld = ensureWaitEdge(db, origin, item, wait);
      if (unheld) throw new CreationRefused(unheld);

      // In the same transaction as the item: an item that exists with
      // no origin row would be created again by the next run.
      recordItemOrigin(db, {
        itemId: item.id as Uuid,
        originItemId: origin.id as Uuid,
        runId: context.runId,
        moduleId: context.module.id as Uuid,
        idempotencyKey: creation.idempotencyKey,
        generation: generation + 1,
      });
      // One note on each, from EO, so neither thread leaves a person to
      // work out where an item came from or what a step left behind.
      // Neither is the module's own comment — they count against
      // nothing — and neither summons anyone: a title is a module's
      // text, and an `@name` in it stays visible and mentions nobody.
      //
      // Inside the transaction, so there is no item without its record:
      // a note that cannot be written takes the creation back with it,
      // and the module is told nothing was created rather than handed a
      // key for an item neither thread mentions.
      postComment(db, {
        itemId: origin.id as Uuid,
        author: { type: "engine" },
        // And that this item is now held behind it, where it is: a
        // person finding it stopped at a step reads why in its thread.
        body:
          `**${context.module.name}** (module) created ${item.key}: ${item.title}` +
          (wait === "this_waits" ? `\n\n${origin.key} now waits for ${item.key}.` : ""),
        runId: context.runId,
        parseBodyMentions: false,
      });
      postComment(db, {
        itemId: item.id as Uuid,
        author: { type: "engine" },
        body:
          `Created by **${context.module.name}** (module) from its run on ${origin.key}.` +
          (wait === "created_waits" ? ` It waits for ${origin.key}.` : ""),
        // The run on the *originating* item, so this thread links to
        // the transcript of what made it.
        runId: context.runId,
        parseBodyMentions: false,
      });
      return { item };
    });
    if (!("item" in outcome)) return outcome;
    made = outcome.item;
  } catch (error) {
    if (error instanceof CreationRefused) return { created: false, reason: error.message };
    return { created: false, reason: `the item could not be written: ${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    options.onCreated?.(made.id as Uuid);
  } catch {
    // A window that could not be told refetches on its next change.
  }
  return { created: true, key: made.key, existing: false };
}
