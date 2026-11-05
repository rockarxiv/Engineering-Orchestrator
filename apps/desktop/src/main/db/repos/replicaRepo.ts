import { eq } from "drizzle-orm";
import type { RecordItem, Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { items, itemTypes, people, pipelineSteps, pipelineVersions, projects, workspaces } from "../schema.js";
import { getItem } from "./itemsRepo.js";
import { keepArrivedWaits } from "./itemDepsRepo.js";
import { keepArrivedOrigin } from "./itemOriginsRepo.js";
import { ensurePerson } from "./peopleRepo.js";
import { resolveItemType } from "./itemTypesRepo.js";

/**
 * Writing what the record says, into the device's replica (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * A device signed in to an organisation keeps a copy of the record so
 * that it can be read — by the renderer, by an agent's context, by the
 * scheduler input the record ignores but the device still needs — and
 * so that it can be read with the record unreachable (the original design: "managed
 * mode never stops a person from working"). This is the one place that
 * writes rows on the strength of somebody else having decided them.
 *
 * ### What it will not write, and why that is the whole design
 *
 * **Never `stepId` on an item that already exists.** Where an item sits
 * is invariant #1's subject, and the only function allowed to write it
 * is `transitionItem`. A replica learns about a move the same way its
 * own device does: as a transition, applied through the record's
 * `applyTransition`. So this file updates titles, bodies, assignees and
 * marks, and the board position arrives beside it as an audit row. The
 * architectural test reads this source and would fail on the other
 * arrangement, which is exactly what it is for.
 *
 * An *insert* does carry the step, because a first arrival is not a
 * move: there is no prior position to transition from, and `createItem`
 * has always inserted a row at the step it starts on.
 *
 * ### Foreign keys this replica may not have
 *
 * A record can name a project, a workspace, a parent or an item type
 * that this device has never heard of. Three of those are nulled rather
 * than refused — an item with no project shown is worse than no item,
 * but not much worse, and the next pull repairs it once the row
 * arrives. The two that cannot be nulled are the type, which every item
 * must have, and the step, which is where it sits; an item naming
 * either of those unknown is left out of the replica entirely and said
 * so, because a card drawn in no column is a card a person cannot act
 * on.
 *
 * That a step id resolves at all across two installations is true today
 * for the reason `identityCommands.ts` already writes down: pipelines
 * are published by an admin in 7c, and until then the steps both ends
 * draw are the ones EO seeds, whose ids are literals in the seed
 * migration. A pipeline somebody made here has ids the server has never
 * seen, and its items are the ones this skips. That is a limitation of
 * this phase and not of this file.
 */

export type ReplicaWrite = "inserted" | "updated" | "skipped";

/**
 * Which local type row an incoming item is one of.
 *
 * By id where this installation happens to have it, which is the
 * ordinary case for anything a pack seeded: `item_types` ids are
 * literals in the seed migration, so two installations that both
 * installed the developer pack agree about them.
 *
 * By slug otherwise, **within the item's own project's scope**, and the
 * scope is the part that took a bug to learn. `item_types` rows are
 * per-project as well as per-installation — attaching a workspace
 * copies the installation's types into the new project (see
 * `copyItemTypesToProject`) — so a replica with one project has *two*
 * rows slugged `story`, and a bare slug lookup finds both and can
 * choose neither. Every item on that replica was then silently skipped,
 * which looks exactly like a board that does not sync.
 *
 * `resolveItemType` is the function that already knows what a scope is
 * and already refuses rather than guesses when two packs ship one word
 * (ARCHITECTURE.md, "An item type is data"). Asking it means this file has no second opinion about
 * either.
 */
function typeIdFor(db: Db, item: RecordItem, projectId: string | null): string | null {
  const byId = db.select({ id: itemTypes.id }).from(itemTypes).where(eq(itemTypes.id, item.typeId)).get();
  if (byId !== undefined) return byId.id;
  const resolved = resolveItemType(db, projectId as Uuid | null, item.typeSlug);
  return resolved.ok ? resolved.type.id : null;
}

function knows(db: Db, table: typeof projects | typeof workspaces | typeof people | typeof items, id: string | null): string | null {
  if (id === null) return null;
  const row = db.select({ id: table.id }).from(table).where(eq(table.id, id)).get();
  return row === undefined ? null : id;
}

function knowsStep(db: Db, id: string | null): boolean {
  if (id === null) return true;
  return db.select({ id: pipelineSteps.id }).from(pipelineSteps).where(eq(pipelineSteps.id, id)).get() !== undefined;
}

/**
 * One item from the record, into this replica.
 *
 * Idempotent, because a pull re-sends its own cursor boundary and a
 * reconnect re-sends more than that. `updatedAt` is the guard against
 * writing an older copy over a newer one: the record is the authority
 * on what the item *says*, and a pull that arrived out of order must
 * not undo an edit this device has since made and queued.
 */
export function upsertReplicaItem(db: Db, item: RecordItem): ReplicaWrite {
  const existing = getItem(db, item.id as Uuid);
  // The project first, because the type is resolved *in its scope* —
  // see `typeIdFor`. An item whose project this replica does not have
  // resolves its type against the installation's own rows, which is
  // what an item belonging to no project does anyway.
  const projectId = knows(db, projects, item.projectId) ?? existing?.projectId ?? null;
  const typeId = typeIdFor(db, item, projectId);
  if (typeId === null) return "skipped";
  if (!knowsStep(db, item.stepId)) return "skipped";

  const workspaceId = knows(db, workspaces, item.workspaceId);
  const parentId = knows(db, items, item.parentId);
  // Who holds it, as a row this replica can point at (EO-367). The
  // organisation's people are not copied down wholesale, so the record
  // sends the name with the id and the row is written here under the
  // record's own id — without it a colleague's claim arrived as nobody,
  // and the card read Unclaimed on every machine but the record. An
  // assignee sent with no name (a build that predates it) is still held
  // as nobody rather than as a dangling id.
  if (item.assigneeId !== null && item.assigneeName !== null) ensurePerson(db, item.assigneeId as Uuid, item.assigneeName);
  const assigneeId = knows(db, people, item.assigneeId);

  if (existing === undefined) {
    db.insert(items)
      .values({
        id: item.id,
        key: item.key,
        typeId,
        // A parent that has not arrived yet is dropped rather than
        // waited for. The next pull carries the item again — the cursor
        // is `updatedAt` and the parent link is part of it — and by then
        // the container is usually here.
        parentId,
        projectId,
        workspaceId,
        title: item.title,
        body: item.body,
        pipelineId: item.pipelineId,
        // An insert, not an update: a first arrival has no prior
        // position, so this is not a move and invariant #1 is not in
        // play. See the file comment.
        stepId: item.stepId,
        priority: item.priority,
        archivedAt: item.archivedAt,
        heldAt: item.heldAt,
        previewAt: item.previewAt,
        // The trial mark (EO-582): a trial item arrives as one.
        trialAt: item.trialAt,
        assigneeId,
        // The graph it is being routed by (EO-329). Kept only where
        // this replica holds that version document — a binding it
        // cannot resolve would read as "on the current version" and
        // route by the live rows, which is exactly what carrying it is
        // meant to prevent. A published pipeline brings its versions
        // with it, and the next pull sets this once the document is
        // here.
        pipelineVersionId: knowsVersion(db, item.pipelineVersionId),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
      .onConflictDoNothing()
      .run();
    keepArrivedOrigin(db, item.id, item.origin);
    // What it waits for and what waits for it (EO-434), once the row
    // those edges point at is here.
    keepArrivedWaits(db, item.id, item.waits);
    return "inserted";
  }

  // What made it (EO-433), whichever copy is newer: an origin is
  // written once on the record and never edited, so there is no older
  // version of it to protect — and an item whose originating item had
  // not arrived on the first pull gets its link on a later one.
  keepArrivedOrigin(db, item.id, item.origin);

  if (existing.updatedAt > item.updatedAt) return "skipped";

  // Everything except where it sits. `stepId` and `pipelineId` are
  // deliberately absent and their absence is checked by
  // `architecturalInvariants.test.ts`, which reads this `.set({...})`
  // as source text.
  db.update(items)
    .set({
      key: item.key,
      typeId,
      parentId,
      projectId,
      workspaceId,
      assigneeId,
      title: item.title,
      body: item.body,
      priority: item.priority,
      archivedAt: item.archivedAt,
      heldAt: item.heldAt,
      previewAt: item.previewAt,
      trialAt: item.trialAt,
      // See the insert above. A binding this replica cannot resolve
      // leaves the one it already has rather than writing null: null
      // means "on the current version", which is a different claim from
      // "the document has not arrived yet".
      //
      // Written as a value rather than a conditional spread on purpose:
      // the invariant test above reads this payload as source text, and
      // a spread is a payload a reviewer cannot check by eye. Every key
      // written here is visible here, and none of them is where the
      // item sits.
      pipelineVersionId: knowsVersion(db, item.pipelineVersionId) ?? existing.pipelineVersionId,
      updatedAt: item.updatedAt,
    })
    .where(eq(items.id, item.id))
    .run();
  // After the guard above, unlike the origin: edges change, so an older
  // copy of the item is an older account of them too.
  keepArrivedWaits(db, item.id, item.waits);
  return "updated";
}

/**
 * Who holds an item, on this replica, without saying the record said so
 * (EO-367).
 *
 * Three writers, and all are about an item whose holder is the record's
 * to decide: a claim or assignment this device has just asked for, shown
 * at once while it waits; the holder the record answered with when it
 * dropped a claim from here; and the holder it answered with when it
 * refused one outright. Null is nobody.
 *
 * `updated_at` is deliberately left alone, and that is the reason this
 * is not `setItemAssignee`. On a replica that column is the record's
 * stamp, and `upsertReplicaItem` declines anything older than it. A
 * provisional write that took this machine's clock would make the
 * record's own answer look stale on the next pull — so a dropped claim
 * would stay on the loser's card, and an edit somebody made on the
 * record in between would never arrive.
 */
export function setReplicaAssignee(db: Db, itemId: Uuid, person: { id: string; name: string } | null): void {
  if (person !== null) ensurePerson(db, person.id as Uuid, person.name);
  db.update(items)
    .set({ assigneeId: person === null ? null : person.id })
    .where(eq(items.id, itemId))
    .run();
}

/** The version document this replica holds, or null for one it has not been sent. */
function knowsVersion(db: Db, versionId: string | null): string | null {
  if (versionId === null) return null;
  return db.select({ id: pipelineVersions.id }).from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get() === undefined
    ? null
    : versionId;
}

/** Whether the replica already holds this item, so a caller can tell an arrival from an update. */
export function replicaHasItem(db: Db, itemId: string): boolean {
  return db.select({ id: items.id }).from(items).where(eq(items.id, itemId)).get() !== undefined;
}
