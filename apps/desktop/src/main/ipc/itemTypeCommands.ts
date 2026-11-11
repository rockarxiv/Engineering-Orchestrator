import {
  addedFieldCollisionMessage,
  fieldHoldsValuesMessage,
  isPackShipped,
  itemTypeActionOverridesRefusal,
  itemTypeDraftProblem,
  itemTypeHoldsItemsMessage,
  LOCAL_PACK,
  packItemTypeEditRefusal,
  packItemTypeFieldsProblem,
  packItemTypeRefusal,
  specFields,
  specShapeFromFields,
  toSlug,
  withAddedFields,
  type IpcPayload,
  type IpcResponse,
  type ItemTypeView,
  type SpecFieldDraft,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import type { AddedFieldCollision, ItemType } from "../db/repos/itemTypesRepo.js";
import { getProject } from "../db/repos/projectsRepo.js";
import { hasMessageAbout } from "../db/repos/messagesRepo.js";
import { sendMessageHere } from "../messages/messages.js";
import {
  countItemsHoldingField,
  countItemsOfType,
  createItemType,
  deleteItemType,
  getItemType,
  listItemTypes,
  updateItemType,
} from "../db/repos/itemTypesRepo.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * The configure screen's Types section, behind the four
 * `itemTypes:*` channels (ARCHITECTURE.md, "An item type is data", KAN-164).
 *
 * A type is labels, a container flag and a spec shape, so making one is
 * data entry rather than code and a person may do it here. What this
 * file adds on top of the repository is the judgement: which of them a
 * person may change, what a duplicate word is, and why a type with work
 * filed under it stays.
 *
 * Every write answers with a `problem` sentence rather than throwing,
 * the shape `resolveItemType` set: none of these failures is a
 * programmer error, and the screen has somewhere to put a sentence.
 */

/** Which scope the caller means: the one it named, else whichever project the window is on. */
function scopeOf(db: Db, projectId: string | null | undefined): Uuid | null {
  return projectId === undefined ? activeProjectId(db) : (projectId as Uuid | null);
}

function toView(db: Db, type: ItemType): ItemTypeView {
  return {
    id: type.id,
    projectId: type.projectId,
    packSlug: type.packSlug,
    slug: type.slug,
    label: type.label,
    plural: type.plural,
    container: type.container,
    specShape: type.specShape,
    itemCount: countItemsOfType(db, type.id),
  };
}

/** One type as `itemTypes:*` answer with it, by id, or null when it is not here. */
export function itemTypeViewOf(db: Db, id: Uuid): ItemTypeView | null {
  const type = getItemType(db, id);
  return type === undefined ? null : toView(db, type);
}

export function listItemTypesCommand(db: Db, input: IpcPayload<"itemTypes:list">): IpcResponse<"itemTypes:list"> {
  const scope = scopeOf(db, input.projectId);
  return { types: listItemTypes(db, scope).map((type) => toView(db, type)) };
}

/**
 * The fields as the row will hold them: names normalised the way the
 * type's own slug is.
 *
 * `Customer name` typed into the form becomes `customer_name`, because
 * a field name is a JSON key an agent answers with and a space in one is
 * a key nothing can spell. Done once, here, so that the duplicate check
 * below compares what will actually be written rather than what was
 * typed — `Customer` and `customer` are one field, and finding that out
 * at the INSERT is finding it out too late.
 */
function normalised(fields: readonly SpecFieldDraft[]): SpecFieldDraft[] {
  return fields.map((field) => ({ ...field, name: toSlug(field.name) }));
}

/**
 * Why `itemTypes:create` would refuse this type in this scope, or null.
 *
 * The command asks it before it writes, and the assistant's card for a
 * new type asks it before there is a button (EO-523) — one definition of
 * a type that may be made, so the card cannot offer what the press
 * would then refuse, or refuse what the press would make.
 */
export function createItemTypeProblem(db: Db, scope: Uuid | null, draft: { label: string; plural: string; fields: readonly SpecFieldDraft[] }): string | null {
  const label = draft.label.trim();
  const plural = draft.plural.trim();

  const problem = itemTypeDraftProblem({ label, plural, fields: draft.fields });
  if (problem !== null) return problem;

  const slug = toSlug(label);
  // Against the whole scope, not only what is `local`: the word is what
  // an agent answers with and what `resolveItemType` looks up, and a
  // second `case` beside the support pack's would make every mention of
  // the word ambiguous — a refusal the person would then meet on every
  // classification instead of once, here.
  const taken = listItemTypes(db, scope).find((existing) => existing.slug === slug);
  if (taken !== undefined) return `This project already has a “${taken.label}” filed under the word “${slug}”. Pick another name.`;
  return null;
}

export function createItemTypeCommand(db: Db, input: IpcPayload<"itemTypes:create">): IpcResponse<"itemTypes:create"> {
  const scope = scopeOf(db, input.projectId);
  const problem = createItemTypeProblem(db, scope, input);
  if (problem !== null) return { type: null, problem };

  const label = input.label.trim();
  const created = createItemType(db, {
    projectId: scope,
    packSlug: LOCAL_PACK,
    slug: toSlug(label),
    label,
    plural: input.plural.trim(),
    container: input.container,
    specShape: specShapeFromFields(normalised(input.fields)),
  });
  return { type: toView(db, created), problem: null };
}

/**
 * Renaming any type, reshaping the ones nobody shipped, and adding
 * optional fields to the ones a pack did (EO-735).
 *
 * The design allows renaming what a pack ships, adding optional fields of
 * this project's own beside the pack's, and creating your own. The
 * container flag, the pack's own fields, which of them are required and
 * the action overrides are the pack's: its prompts, its posters and its
 * routing were written against them, and a story that quietly stops
 * demanding acceptance criteria breaks the review the same pack ships,
 * one run later and somewhere else. So those are refused rather than
 * dropped — a caller told "saved" about a change that did not happen is
 * worse than one told no.
 *
 * A pack's type keeps the pack's document as it is and has this
 * project's fields laid beside it (`withAddedFields`), each marked as
 * added, so the form, the hand-over doors and `ctx.item()` read them
 * from the one shape and the editor can still tell them apart.
 */
export function updateItemTypeCommand(db: Db, input: IpcPayload<"itemTypes:update">): IpcResponse<"itemTypes:update"> {
  const existing = getItemType(db, input.id as Uuid);
  if (existing === undefined) return { type: null, problem: "That item type is not here any more." };

  const problem = updateItemTypeProblem(db, existing, input);
  if (problem !== null) return { type: null, problem };

  const updated = updateItemType(db, existing.id, {
    label: input.label?.trim() ?? existing.label,
    plural: input.plural?.trim() ?? existing.plural,
    ...(input.container === undefined ? {} : { container: input.container }),
    ...(input.fields === undefined ? {} : { specShape: shapeFor(existing, normalised(input.fields)) }),
  });
  if (updated === undefined) return { type: null, problem: "That item type is not here any more." };
  return { type: toView(db, updated), problem: null };
}

/** The shape a field list leaves the type with: the pack's document with these beside it, or the list itself on a type made here. */
function shapeFor(existing: ItemType, fields: readonly SpecFieldDraft[]): ItemType["specShape"] {
  if (!isPackShipped(existing)) return specShapeFromFields(fields);
  const packFields = new Set(specFields(existing.specShape).filter((field) => !field.added).map((field) => field.name));
  return withAddedFields(
    existing.specShape,
    fields.filter((field) => !packFields.has(field.name)),
  );
}

/**
 * Why `itemTypes:update` would refuse this change to a type that is
 * here, or null — asked by the command and by the assistant's card
 * (EO-523), for the reason `createItemTypeProblem` is shared.
 *
 * In order: what is the pack's on a pack's type — the container flag,
 * the action overrides, its own fields and which are required — then
 * the draft's own sense, then a field items hold values for that the
 * list would remove, rename or give another kind, with how many hold
 * one. The last applies to every type: a field taken out from under
 * stored values leaves them under a name nothing declares.
 */
export function updateItemTypeProblem(
  db: Db,
  existing: ItemType,
  input: {
    label?: string | undefined;
    plural?: string | undefined;
    container?: boolean | undefined;
    fields?: readonly SpecFieldDraft[] | undefined;
    actionOverrides?: unknown;
  },
): string | null {
  const label = input.label?.trim() ?? existing.label;
  const plural = input.plural?.trim() ?? existing.plural;
  if (input.container !== undefined && isPackShipped(existing)) return packItemTypeEditRefusal(existing);
  if (input.actionOverrides !== undefined) return itemTypeActionOverridesRefusal(existing);

  // The pack's fields first, so a field of the project's own named like
  // one is told it is the pack's rather than that two fields share a name.
  const fields = input.fields === undefined ? undefined : normalised(input.fields);
  if (fields !== undefined && isPackShipped(existing)) {
    const packProblem = packItemTypeFieldsProblem(existing, fields);
    if (packProblem !== null) return packProblem;
  }

  const drafted = itemTypeDraftProblem({ label, plural, fields: input.fields ?? [] });
  if (drafted !== null) return drafted;
  if (fields === undefined) return null;

  const asked = new Map(fields.map((field) => [field.name, field]));
  for (const field of specFields(existing.specShape)) {
    // A pack's own fields were judged above; only what this project can move is counted.
    if (isPackShipped(existing) && !field.added) continue;
    if (asked.get(field.name)?.kind === field.kind) continue;
    const held = fieldHoldsValuesMessage(existing, field.name, countItemsHoldingField(db, existing.id, field.name));
    if (held !== null) return held;
  }
  return null;
}

/**
 * Removing a type nothing is filed under.
 *
 * Two refusals, and neither is a preference. `items.type_id` is a
 * foreign key, so a type with work under it cannot be dropped at all —
 * the count is what the person has to go and deal with, so the sentence
 * names it (the design's rule for a step, applied here). And a pack's type
 * would be written back by `syncItemTypes` at the next start, so
 * deleting one would report a success that the next launch undoes.
 *
 * No archiving, unlike `pipelines:delete`. There is no history in a type
 * nothing points at, and the items that would carry it are exactly the
 * ones whose existence forbids the deletion.
 */
export function deleteItemTypeCommand(db: Db, input: IpcPayload<"itemTypes:delete">): IpcResponse<"itemTypes:delete"> {
  const existing = getItemType(db, input.id as Uuid);
  if (existing === undefined) return { deleted: false, itemCount: 0, problem: "That item type is not here any more." };

  const { itemCount, problem } = deleteItemTypeProblem(db, existing);
  if (problem !== null) return { deleted: false, itemCount, problem };

  deleteItemType(db, existing.id);
  return { deleted: true, itemCount: 0, problem: null };
}

/**
 * Why `itemTypes:delete` would refuse to remove a type that is here, or
 * null, with how many items are of it — asked by the command and by the
 * assistant's card (EO-523).
 */
export function deleteItemTypeProblem(db: Db, existing: ItemType): { itemCount: number; problem: string | null } {
  const itemCount = countItemsOfType(db, existing.id);
  const held = itemTypeHoldsItemsMessage(existing, itemCount);
  if (held !== null) return { itemCount, problem: held };
  if (isPackShipped(existing)) return { itemCount, problem: packItemTypeRefusal(existing) };
  return { itemCount, problem: null };
}

/** The `messages.source` of a pack field refused for sharing an added field's name (EO-735). */
export const ADDED_FIELD_COLLISION_SOURCE = "item_type_field_conflict";

/**
 * Tells the person about each pack field the seed refused because a
 * project had already added a field of that name to the type (EO-735,
 * invariant 8): a message naming both, sent once per type and field —
 * the seed runs on every launch, and a message handled or still open
 * is not sent again. Answers how many were sent.
 */
export function announceAddedFieldCollisions(db: Db, collisions: readonly AddedFieldCollision[], isTheRecord: boolean): number {
  let sent = 0;
  for (const { type, field } of collisions) {
    const subject = `${type.id}:${field}`;
    if (hasMessageAbout(db, ADDED_FIELD_COLLISION_SOURCE, subject)) continue;
    const where = type.projectId === null ? null : (getProject(db, type.projectId)?.name ?? null);
    sendMessageHere(db, { projectId: type.projectId, source: ADDED_FIELD_COLLISION_SOURCE, subject, body: addedFieldCollisionMessage(type, field, where) }, isTheRecord);
    sent += 1;
  }
  return sent;
}
