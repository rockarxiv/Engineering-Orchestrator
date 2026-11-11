import {
  isPackShipped,
  specFieldDrafts,
  toSlug,
  type AssistCard,
  type AssistCardDetail,
  type IpcPayload,
  type ItemTypeCardShape,
  type SpecFieldDraft,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getItemType, getProject } from "../db/repos/index.js";
import type { ItemType } from "../db/repos/itemTypesRepo.js";
import { createItemTypeProblem, deleteItemTypeProblem, updateItemTypeProblem } from "../ipc/itemTypeCommands.js";

/**
 * The assistant's cards for a project's item types (EO-523): adding one,
 * changing one, removing one.
 *
 * The editor's Types section goes with the editor (EO-517), so these are
 * where a type is now made and changed: the agent names the type as it
 * would be, and the person presses the card's button, which calls
 * `itemTypes:create`, `update` or `delete` — the channels that section
 * called, with the same refusals.
 *
 * What the card shows is EO's read of the row, never the agent's word:
 * the type as it is, the type as pressing the card would leave it, and
 * what the channel would refuse the press with now, asked through the
 * very checks the command runs (`createItemTypeProblem` and its two
 * neighbours). A pack's type takes a new label and plural, as it did in
 * the editor; a card that reshapes what the pack owns is drawn with
 * that refusal on it and no button. A pack's type also takes optional
 * fields of the project's own beside the pack's (EO-735), as the
 * project's item-type settings offer.
 */

type ItemTypeCard = Extract<AssistCard, { kind: "itemTypeCreate" | "itemTypeUpdate" | "itemTypeDelete" }>;

/** Whether a card is one of the three for item types. */
export function isItemTypeCard(card: AssistCard): card is ItemTypeCard {
  return card.kind === "itemTypeCreate" || card.kind === "itemTypeUpdate" || card.kind === "itemTypeDelete";
}

/** Fields as the row would hold them: named the way `itemTypes:create` and `update` name them. */
function normalisedFields(fields: readonly SpecFieldDraft[]): ItemTypeCardShape["fields"] {
  return fields.map((field) => ({ name: toSlug(field.name), kind: field.kind, required: field.required }));
}

/** A type as it is, in the card's terms. */
export function itemTypeShape(type: ItemType): ItemTypeCardShape {
  return { label: type.label, plural: type.plural, slug: type.slug, container: type.container, fields: specFieldDrafts(type.specShape) };
}

function sameFields(a: readonly { name: string; kind: string; required: boolean }[], b: readonly { name: string; kind: string; required: boolean }[]): boolean {
  return a.length === b.length && a.every((field, index) => field.name === b[index]!.name && field.kind === b[index]!.kind && field.required === b[index]!.required);
}

/**
 * What an update card asks `itemTypes:update` for: only what it would
 * actually change.
 *
 * A value the card repeats — the container flag the type already has,
 * the field list it already carries — is left out rather than sent. Sent,
 * it would read as a reshape, and a pack's type, whose label alone may
 * move, would be refused a rename because the agent restated what it
 * already was.
 */
export function itemTypeUpdatePayload(existing: ItemType, card: Extract<AssistCard, { kind: "itemTypeUpdate" }>): IpcPayload<"itemTypes:update"> {
  const label = card.label === null || card.label.trim() === existing.label ? undefined : card.label;
  const plural = card.plural === null || card.plural.trim() === existing.plural ? undefined : card.plural;
  const container = card.container === null || card.container === existing.container ? undefined : card.container;
  const fields = card.fields === null || sameFields(normalisedFields(card.fields), specFieldDrafts(existing.specShape)) ? undefined : card.fields;
  return {
    id: existing.id,
    ...(label === undefined ? {} : { label }),
    ...(plural === undefined ? {} : { plural }),
    ...(container === undefined ? {} : { container }),
    ...(fields === undefined ? {} : { fields }),
  };
}

/** Whether an update asks for anything at all. */
function changesSomething(payload: IpcPayload<"itemTypes:update">): boolean {
  return payload.label !== undefined || payload.plural !== undefined || payload.container !== undefined || payload.fields !== undefined;
}

/** The type as an update would leave it. */
function shapeAfter(existing: ItemType, payload: IpcPayload<"itemTypes:update">): ItemTypeCardShape {
  return {
    label: payload.label?.trim() ?? existing.label,
    plural: payload.plural?.trim() ?? existing.plural,
    // A rename leaves the word items are filed under as it was.
    slug: existing.slug,
    container: payload.container ?? existing.container,
    fields: payload.fields === undefined ? specFieldDrafts(existing.specShape) : normalisedFields(payload.fields),
  };
}

/** The project a type is scoped to, by name — null for the installation's own. */
function projectNameOf(db: Db, projectId: string | null): string | null {
  return projectId === null ? null : (getProject(db, projectId as Uuid)?.name ?? null);
}

/**
 * Why an item-type card cannot be offered at all, or null when it can —
 * asked when the reply is posted (see `assistCardRefusal`).
 *
 * Only what makes the card about nothing: a project or a type that is not
 * here, or a change that changes nothing. What the channel would refuse —
 * a pack's type reshaped or removed, items filed under a type, a name
 * already taken — is not refused here. The card is posted, and shows that
 * refusal in place of its button, because it is what the person asked
 * about and it can change: a type whose items are moved off it may go.
 */
export function itemTypeCardRefusal(db: Db, card: ItemTypeCard): string | null {
  if (card.kind === "itemTypeCreate") {
    const project = getProject(db, card.projectId as Uuid);
    if (project === undefined || project.archivedAt !== null) {
      return (
        `No card was offered: there is no project with the ID "${card.projectId}"${project === undefined ? "" : " that has not been archived"}. ` +
        "Read the projects with `projects_list` and name one by the ID it gives."
      );
    }
    return null;
  }
  const existing = getItemType(db, card.itemTypeId as Uuid);
  if (existing === undefined) {
    return (
      `No card was offered: there is no item type with the ID "${card.itemTypeId}". ` +
      "Read a project's types with `item_types_list` and name one by the ID it gives."
    );
  }
  if (card.kind === "itemTypeUpdate" && !changesSomething(itemTypeUpdatePayload(existing, card))) {
    return `No card was offered: “${existing.label}” already is what the card says, so there is nothing to change.`;
  }
  return null;
}

/**
 * What an item-type card shows, read now (EO-523), or the sentence for a
 * card whose project or type has gone since.
 */
export function itemTypeCardDetail(db: Db, card: ItemTypeCard): { detail: AssistCardDetail } | { problem: string } {
  if (card.kind === "itemTypeCreate") {
    const project = getProject(db, card.projectId as Uuid);
    if (project === undefined) return { problem: "The project this card was about no longer exists." };
    const label = card.label.trim();
    return {
      detail: {
        kind: card.kind,
        projectId: project.id,
        projectName: project.name,
        type: { label, plural: card.plural.trim(), slug: toSlug(label), container: card.container, fields: normalisedFields(card.fields) },
        problem: createItemTypeProblem(db, project.id, card),
      },
    };
  }

  const existing = getItemType(db, card.itemTypeId as Uuid);
  if (existing === undefined) return { problem: "The item type this card was about is not here any more." };
  const common = { itemTypeId: existing.id, projectName: projectNameOf(db, existing.projectId), packSlug: existing.packSlug };
  if (card.kind === "itemTypeDelete") {
    const { itemCount, problem } = deleteItemTypeProblem(db, existing);
    return { detail: { kind: card.kind, ...common, itemCount, problem, type: itemTypeShape(existing) } };
  }
  const payload = itemTypeUpdatePayload(existing, card);
  const { itemCount } = deleteItemTypeProblem(db, existing);
  return {
    detail: {
      kind: card.kind,
      ...common,
      itemCount,
      problem: changesSomething(payload) ? updateItemTypeProblem(db, existing, payload) : `“${existing.label}” already is what the card says, so there is nothing to change.`,
      before: itemTypeShape(existing),
      after: shapeAfter(existing, payload),
    },
  };
}

/** A type in one line: "Case" (Cases), filed as `case`, is the work, with its fields. */
function describe(shape: ItemTypeCardShape): string {
  const fields =
    shape.fields.length === 0
      ? "no fields"
      : `fields ${shape.fields.map((field) => `\`${field.name}\` (${field.kind}${field.required ? ", required" : ""})`).join(", ")}`;
  return `“${shape.label}” (${shape.plural}), filed as \`${shape.slug}\`, ${shape.container ? "holds other items" : "is the work"}, ${fields}`;
}

/**
 * What an item-type card says in prose — what a later turn reads back.
 * The type as it would be, and the refusal the press would meet, if any.
 */
export function itemTypeCardBody(db: Db, card: ItemTypeCard): string {
  const read = itemTypeCardDetail(db, card);
  if ("problem" in read) return read.problem;
  const { detail } = read;
  const refused = (problem: string | null) => (problem === null ? "" : ` It would be refused as things are: ${problem}`);
  switch (detail.kind) {
    case "itemTypeCreate":
      return `**Add** the item type ${describe(detail.type)}, to ${detail.projectName}. Nothing is added until Add type is pressed on the card.${refused(detail.problem)}`;
    case "itemTypeUpdate": {
      const pack = isPackShipped({ packSlug: detail.packSlug })
        ? ` The ${detail.packSlug} pack ships it, so its name and plural can change and optional fields can be added beside the pack's; the pack's own fields and whether it holds other items stay as they are.`
        : "";
      return `**Change** the item type “${detail.before.label}” to ${describe(detail.after)}.${pack} Nothing changes until Save type is pressed on the card.${refused(detail.problem)}`;
    }
    case "itemTypeDelete":
      return `**Delete** the item type ${describe(detail.type)}. Nothing is removed until Delete type is pressed on the card.${refused(detail.problem)}`;
    default:
      return "";
  }
}
