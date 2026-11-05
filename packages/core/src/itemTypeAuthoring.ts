import { z } from "zod";
import { specFields, type SpecFieldKind, type SpecProperty, type SpecShape } from "./schemas/specShape.js";

/**
 * Making an item type without writing code (ARCHITECTURE.md, "An item type is data", KAN-164).
 *
 * A type is three things — labels, a container flag and a spec shape
 * (ARCHITECTURE.md, "An item type is data") — and none of them is code, so the configure screen may
 * create
 * one. What a person types there is a handful of fields with a kind
 * each; what the table stores is a JSON Schema. This module is the
 * translation between the two, plus the words a refusal is written in,
 * kept in `core` for the reason every wire shape is: the renderer draws
 * the form, the main process writes the row, and a compiler that
 * disagreed with the editor about what "required" means would produce a
 * type whose own screen cannot round-trip it.
 *
 * Action overrides are not here. A hand-made leaf type carries none and
 * inherits the leaf defaults through `actionOverrideFor`, which is
 * exactly what the design asks for and needs no field on the form; editing
 * them is out of this story's scope.
 */

/**
 * The pack slug a type nobody shipped is filed under.
 *
 * A type still needs a namespace: `item_types` is unique on
 * `(scope, pack_slug, slug)` and the registry is keyed by
 * `qualifiedItemType`, so a hand-made `case` and a support pack's `case`
 * have to be tellable apart — and they are, as `local:case` and
 * `support:case`. It is also the whole of how the editor knows what it
 * may change: a pack's type is editable in label only, because its
 * container flag and its fields are what the pack's code was written
 * against, and a person who moves them has changed a contract they
 * cannot see the other end of.
 *
 * Reserved, therefore: a pack calling itself `local` would claim every
 * hand-made type on the installation. Nothing enforces that today
 * because nothing but the developer pack ships types; a pack loader
 * that grows a slug check is where it belongs.
 */
export const LOCAL_PACK = "local";

/** Whether a pack shipped this type, rather than somebody here making it. */
export function isPackShipped(type: { packSlug: string }): boolean {
  return type.packSlug !== LOCAL_PACK;
}

/** The four kinds a person may pick, in the order the editor offers them. */
export const SPEC_FIELD_KINDS: readonly SpecFieldKind[] = ["string", "number", "boolean", "string list"];

/**
 * One field as the form holds it: a name, a kind and whether creation
 * demands it.
 *
 * Deliberately smaller than `SpecField`. That one is what a *shape*
 * says, annotations and all — a title, a description, which field holds
 * the acceptance criteria — and a pack may write any of it by hand. This
 * is the subset the editor offers, which is the subset the design names.
 */
export const SpecFieldDraftSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["string", "number", "boolean", "string list"]),
  required: z.boolean(),
});

export type SpecFieldDraft = z.infer<typeof SpecFieldDraftSchema>;

/**
 * `Customer name` → `customer_name`.
 *
 * The same normalisation for a field's name and for a type's slug,
 * because both are words an agent answers with and both end up as JSON
 * keys. Empty when the input had nothing in it a key can be made of,
 * which is a refusal rather than a value — see `itemTypeDraftProblem`.
 */
export function toSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * What a required field of this kind demands, beyond being present.
 *
 * `required` in JSON Schema means the key is there, and a key holding
 * `""` is there. Every shape the developer pack ships says so with
 * `minLength` and `minItems`, and `missingSpecFields` is written to read
 * them back — so a hand-made type gets the same treatment, or "required"
 * would mean something weaker on a person's type than on a pack's.
 *
 * An optional field demands nothing at all, including nothing about
 * being non-empty: somebody clearing a field they never had to fill in
 * is not an error.
 */
function propertyFor(field: SpecFieldDraft): SpecProperty {
  switch (field.kind) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string list":
      return field.required ? { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 } : { type: "array", items: { type: "string" } };
    case "string":
      return field.required ? { type: "string", minLength: 1 } : { type: "string" };
  }
}

/**
 * The form's fields as the JSON Schema the row stores.
 *
 * Declaration order is kept, because that is the order the detail's spec
 * editor draws and the order the composed intake schema offers — the
 * person who put the customer above the channel decided it.
 */
export function specShapeFromFields(fields: readonly SpecFieldDraft[]): SpecShape {
  const properties: Record<string, SpecProperty> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = propertyFor(field);
    if (field.required) required.push(field.name);
  }
  return { type: "object", properties, required };
}

/**
 * And back, so the editor can open a type it did not just make.
 *
 * Lossy on purpose, and only in the direction that is safe: a pack's
 * `title`, `description` and `x-eo-criteria` are not offered by the form
 * and do not survive a round-trip through it — which is one of the
 * reasons a pack's type is editable in label only, rather than the
 * editor quietly rewriting a shape it can only see part of.
 */
export function specFieldDrafts(shape: SpecShape): SpecFieldDraft[] {
  return specFields(shape).map((field) => ({ name: field.name, kind: field.kind, required: field.required }));
}

/** A type as somebody typed it, before anything has been written. */
export interface ItemTypeDraft {
  label: string;
  plural: string;
  fields: readonly SpecFieldDraft[];
}

/**
 * What is wrong with the draft, in the words the person reads, or null.
 *
 * One function for both doors, for the reason `specIssues` is one: the
 * form checks before it asks and the command checks before it writes,
 * and two implementations would be two definitions of a valid type with
 * the lenient one deciding what is in the table.
 */
export function itemTypeDraftProblem(draft: ItemTypeDraft): string | null {
  if (draft.label.trim() === "") return "A type needs a name — “Case”, say.";
  if (draft.plural.trim() === "") return "A type needs a plural name — “Cases”, say.";
  if (toSlug(draft.label) === "") return `“${draft.label.trim()}” has no letters or digits in it, so there is no word to file items under.`;

  const seen = new Set<string>();
  for (const field of draft.fields) {
    if (field.name.trim() === "") return "Every field needs a name.";
    if (toSlug(field.name) === "") return `“${field.name.trim()}” has no letters or digits in it, so it cannot be a field name.`;
    const name = toSlug(field.name);
    if (seen.has(name)) return `Two fields are called “${name}”. Each field needs its own name.`;
    seen.add(name);
  }
  return null;
}

/**
 * Why this type cannot be deleted, naming how many items are of it
 * (the design's rule for a step, applied to a type).
 *
 * The count is the point. "It is in use" sends somebody looking; "has 3
 * items" tells them what they are looking for, and the plural label is
 * what the board calls them. Null when there are none, which is the
 * whole of the permission to delete.
 */
export function itemTypeHoldsItemsMessage(type: { label: string; plural: string }, count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return `“${type.label}” has 1 item of it. Change its type or delete it before removing the type.`;
  return `“${type.label}” has ${count} ${type.plural.toLowerCase()}. Change their type or delete them before removing the type.`;
}

/**
 * Why a pack's type cannot be removed here.
 *
 * Not a policy about who is allowed to do what: `syncItemTypes` inserts
 * whatever an installed pack ships on every start, so a deletion would
 * be undone at the next launch and the person would be told it worked.
 * Refusing says the true thing.
 */
export function packItemTypeRefusal(type: { label: string; packSlug: string }): string {
  return `The ${type.packSlug} pack ships “${type.label}”, so EO would create it again at the next start. Uninstall the pack to be rid of it.`;
}

/**
 * Why a pack's type cannot have its shape or its container flag changed.
 *
 * The design: a person may *create* a type, and rename what a pack ships. The
 * flag and the fields are what that pack's prompts, posters and routing
 * were written against — a pack's story that stops demanding acceptance
 * criteria breaks the review it ships, silently and one run later.
 */
export function packItemTypeEditRefusal(type: { label: string; packSlug: string }): string {
  return `“${type.label}” comes from the ${type.packSlug} pack. You can rename it; its fields and whether it holds other items are the pack's.`;
}

/**
 * What a picker calls a type: its label, and the pack's name too where
 * another type here answers to the same one.
 *
 * The design asks for the project's types to be offered by label rather than
 * by slug, which is what `ItemTypeEntry` has always said the picker
 * should do — "Case (support)" is the example written there, and it is
 * the case a bare label cannot survive: two packs may ship a `case`
 * (ARCHITECTURE.md, "An item type is data"), and two options reading "Case" are a choice nobody can
 * make.
 * Qualified only when it has to be, because "Story (developer)" on an
 * installation with one pack is noise.
 */
export function itemTypeOptionLabel(type: { label: string; packSlug: string }, among: readonly { label: string }[]): string {
  const shared = among.filter((other) => other.label === type.label).length > 1;
  return shared ? `${type.label} (${type.packSlug})` : type.label;
}
