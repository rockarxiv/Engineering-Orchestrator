import {
  isPackShipped,
  itemTypeDraftProblem,
  itemTypeHoldsItemsMessage,
  LOCAL_PACK,
  packItemTypeEditRefusal,
  packItemTypeRefusal,
  specShapeFromFields,
  toSlug,
  type IpcPayload,
  type IpcResponse,
  type ItemTypeView,
  type SpecFieldDraft,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import type { ItemType } from "../db/repos/itemTypesRepo.js";
import {
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
 * Renaming any type, and reshaping only the ones nobody shipped.
 *
 * The design allows renaming what a pack ships and creating your own. The
 * container flag and the fields are the pack's: its prompts, its
 * posters and its routing were written against them, and a story that
 * quietly stops demanding acceptance criteria breaks the review the same
 * pack ships, one run later and somewhere else. So the two are refused
 * rather than dropped — a caller told "saved" about a change that did
 * not happen is worse than one told no.
 */
export function updateItemTypeCommand(db: Db, input: IpcPayload<"itemTypes:update">): IpcResponse<"itemTypes:update"> {
  const existing = getItemType(db, input.id as Uuid);
  if (existing === undefined) return { type: null, problem: "That item type is not here any more." };

  const problem = updateItemTypeProblem(existing, input);
  if (problem !== null) return { type: null, problem };

  const updated = updateItemType(db, existing.id, {
    label: input.label?.trim() ?? existing.label,
    plural: input.plural?.trim() ?? existing.plural,
    ...(input.container === undefined ? {} : { container: input.container }),
    ...(input.fields === undefined ? {} : { specShape: specShapeFromFields(normalised(input.fields)) }),
  });
  if (updated === undefined) return { type: null, problem: "That item type is not here any more." };
  return { type: toView(db, updated), problem: null };
}

/**
 * Why `itemTypes:update` would refuse this change to a type that is
 * here, or null — asked by the command and by the assistant's card
 * (EO-523), for the reason `createItemTypeProblem` is shared.
 */
export function updateItemTypeProblem(
  existing: ItemType,
  input: { label?: string | undefined; plural?: string | undefined; container?: boolean | undefined; fields?: readonly SpecFieldDraft[] | undefined },
): string | null {
  const label = input.label?.trim() ?? existing.label;
  const plural = input.plural?.trim() ?? existing.plural;
  const reshaping = input.container !== undefined || input.fields !== undefined;
  if (reshaping && isPackShipped(existing)) return packItemTypeEditRefusal(existing);
  return itemTypeDraftProblem({ label, plural, fields: input.fields ?? [] });
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
