import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";
import { jsonSchemaOutputSchema, type SchemaIssue } from "./outputSchema.js";

/**
 * What an item type's structured fields are, as data (ARCHITECTURE.md, "An item type is data",
 * KAN-147).
 *
 * The third of the three things a type is. It was six branches on the
 * word: a story must carry acceptance criteria, a bug its four
 * reproduction fields, and the intake schema was a union over the three
 * types EO happens to ship. A pack shipping a `Case` with a customer and
 * a channel had nowhere to say so.
 *
 * **A JSON Schema for the item's `spec` object**, because `spec` is
 * already an open JSON bag and JSON Schema is what describes one —
 * `required` names what creation demands, and the validator it is read
 * with is the one KAN-125 already put in core for a pack that ships its
 * output schemas as documents. So this is not a second schema language
 * for EO to grow: it is the one already here, pointed at a different
 * value.
 *
 * Four field kinds, which is what the design's editor offers and what the
 * intake and decomposition schemas compose from. Anything richer is out
 * of scope:
 *
 * | kind        | written as                                   |
 * |-------------|----------------------------------------------|
 * | string      | `{"type":"string"}`                          |
 * | number      | `{"type":"number"}`                          |
 * | boolean     | `{"type":"boolean"}`                         |
 * | string list | `{"type":"array","items":{"type":"string"}}` |
 *
 * A string field with `enum` is still a string: the values are what a
 * picker offers, not a fifth kind.
 *
 * Everything else JSON Schema allows travels through untouched —
 * `minLength`, `minItems`, `description` — because this is a document
 * rather than a form description, and the validator is the whole
 * authority on what a valid spec is. The readers below are for the two
 * things a document cannot answer: what to call a field to a person, and
 * which field holds the acceptance criteria.
 */

/**
 * Which property holds the item's acceptance criteria.
 *
 * A keyword rather than the name `acceptance_criteria` by convention,
 * because the point of a shape is that a pack names its own fields: a
 * `Case` type whose bar is a `resolution` says so here, and the review
 * refusal, the coverage check and the Jira description all read the
 * right field without learning the word.
 *
 * `x-` prefixed, which is the convention for a keyword outside the
 * specification, and stripped before any document reaches a provider —
 * see `withoutEoKeywords`.
 */
export const CRITERIA_KEYWORD = "x-eo-criteria";

/**
 * A property whose value may be *offered* to a person as a criterion,
 * without EO adopting it.
 *
 * One field needs this today and the distinction is EO-200's: a bug's
 * `expected` reads exactly like a definition of done, and turning it
 * into one would be EO inventing a criterion nobody wrote. So the
 * refusal quotes it and asks (`missingCriteriaRefusal`), and the type
 * says which of its fields is worth quoting rather than the code
 * knowing that a bug has an `expected`.
 */
export const CRITERIA_OFFER_KEYWORD = "x-eo-criteria-offer";

/** The keywords EO reads and no provider should be shown. */
const EO_KEYWORDS = [CRITERIA_KEYWORD, CRITERIA_OFFER_KEYWORD];

/** One property of a spec shape. Loose, because a document may say more than EO reads. */
export const SpecPropertySchema = z.looseObject({
  type: z.enum(["string", "number", "boolean", "array"]),
  /** Present for a list. `{"type":"string"}` is the only element kind in scope. */
  items: z.looseObject({ type: z.string() }).optional(),
  /** A string field's allowed values — what a picker offers. */
  enum: z.array(z.string()).min(1).optional(),
  /**
   * A phrase for prose, when the field's own name does not read as one.
   *
   * Used where a refusal names the field mid-sentence. Labels are *not*
   * taken from here — see `fieldLabel`, which derives them from the name
   * so that every type's card reads the same way whether or not its
   * author wrote a title.
   */
  title: z.string().min(1).optional(),
  /** Why the field is asked for. Reaches the agent: it is in the composed schema. */
  description: z.string().min(1).optional(),
  [CRITERIA_KEYWORD]: z.boolean().optional(),
  [CRITERIA_OFFER_KEYWORD]: z.boolean().optional(),
});

export type SpecProperty = z.infer<typeof SpecPropertySchema>;

/**
 * A type's spec shape, wherever one crosses a boundary.
 *
 * Three of them: `registry:get`, the `item_types.spec_shape` JSON column
 * — an open bag a person can edit with a SQLite browser as much as any
 * config column is — and, since KAN-147, the composed intake schema.
 * One schema, so none of the three can disagree about what a field is.
 *
 * Loose at both levels, and deliberately: an unknown keyword is
 * something the specification says to ignore, not something to reject,
 * and a shape narrowed on the way in would quietly weaken the
 * validation it is *for*. What comes out of here is still the document
 * that went in.
 */
export const SpecShapeSchema = z.looseObject({
  type: z.literal("object").default("object"),
  properties: z.record(z.string().min(1), SpecPropertySchema).default({}),
  required: z.array(z.string().min(1)).default([]),
});

export type SpecShape = z.infer<typeof SpecShapeSchema>;

/** A type that demands nothing and offers nothing — a container's, and an unparseable row's. */
export const EMPTY_SPEC_SHAPE: SpecShape = { type: "object", properties: {}, required: [] };

/**
 * One item type, as a schema composer needs it: its word, whether it
 * holds work rather than being work, and its fields.
 *
 * The three facts both composed schemas read — `intakeOutputSchemaFor`
 * to offer a classification into each type, `refineOutputSchemaFor` to
 * offer a child of each *work* type. `ItemTypeEntry` is one of these, so
 * a registry's values pass straight in; the narrower shape is what lets
 * a test compose a document without building a registry entry.
 */
export interface ComposableItemType {
  slug: string;
  container: boolean;
  specShape: SpecShape;
}

/** The four kinds, as a person picks one (ARCHITECTURE.md, "An item type is data"). */
export type SpecFieldKind = "string" | "number" | "boolean" | "string list";

/** One field of a spec, as everything but the validator wants it. */
export interface SpecField {
  name: string;
  /** What a card or an editor calls it. Derived from the name unless the shape says otherwise. */
  label: string;
  /** The same field named mid-sentence: the shape's `title`, else its label lowercased. */
  phrase: string;
  kind: SpecFieldKind;
  required: boolean;
  /** A string field's allowed values, when it has them. */
  values?: readonly string[];
  description?: string;
  /** Whether this field holds the item's acceptance criteria. */
  criteria: boolean;
  /** Whether this field may be quoted to a person as a candidate criterion. */
  offer: boolean;
}

function kindOf(property: SpecProperty): SpecFieldKind {
  if (property.type === "array") return "string list";
  return property.type;
}

/**
 * `steps_to_reproduce` → "Steps to reproduce".
 *
 * Derived rather than read from `title`, so that a type nobody wrote
 * labels for still reads like one that has them — and so that the four
 * bug fields keep the exact headings they had when the card was written
 * out by hand. A pack that wants a different label renames the field,
 * which is the honest way round: the name is what an agent answers with.
 */
export function fieldLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The shape's fields, in the order the document declares them.
 *
 * Order matters: it is the order a card renders and an editor lists, and
 * JSON preserves it, so the pack decides it rather than an alphabetical
 * accident.
 */
export function specFields(shape: SpecShape): SpecField[] {
  return Object.entries(shape.properties).map(([name, property]) => {
    const label = fieldLabel(name);
    return {
      name,
      label,
      phrase: property.title ?? label.toLowerCase(),
      kind: kindOf(property),
      required: shape.required.includes(name),
      ...(property.enum ? { values: property.enum } : {}),
      ...(property.description === undefined ? {} : { description: property.description }),
      criteria: property[CRITERIA_KEYWORD] === true,
      offer: property[CRITERIA_OFFER_KEYWORD] === true,
    };
  });
}

/** The field holding the acceptance criteria, if this type has one. */
export function criteriaField(shape: SpecShape): SpecField | undefined {
  return specFields(shape).find((field) => field.criteria);
}

/** The field this type offers as a candidate criterion, if it has one. */
export function criteriaOfferField(shape: SpecShape): SpecField | undefined {
  return specFields(shape).find((field) => field.offer);
}

/**
 * The shape as a provider may see it: EO's own keywords removed.
 *
 * `x-eo-criteria` means nothing to a model, and a provider validating
 * its input schema strictly refuses a keyword it does not know — which
 * would be one backend's intake failing where the other's worked, on a
 * capability EO believes it provided (invariant 12). Standard
 * annotations stay: `description` is *for* the agent, and dropping it
 * would throw away the one place a pack can say what a field is for.
 */
export function withoutEoKeywords(property: SpecProperty): JsonSchema {
  const copy: Record<string, unknown> = { ...property };
  for (const keyword of EO_KEYWORDS) delete copy[keyword];
  return copy;
}

/**
 * ajv compiles a document once; a shape is read back from its row on
 * every validation, so the cache is keyed on the document rather than on
 * the object holding it.
 *
 * Bounded by the number of distinct shapes an installation has, which is
 * the number of item types it has.
 */
const compiled = new Map<string, ReturnType<typeof jsonSchemaOutputSchema>>();

function validatorFor(shape: SpecShape): ReturnType<typeof jsonSchemaOutputSchema> {
  const key = JSON.stringify(shape);
  const found = compiled.get(key);
  if (found) return found;
  const made = jsonSchemaOutputSchema(shape as JsonSchema);
  compiled.set(key, made);
  return made;
}

/**
 * What is wrong with this spec, judged against its type's shape — the
 * check that replaced the hand-written per-type ones (KAN-147).
 *
 * Empty means nothing is wrong. A null spec is validated as `{}` rather
 * than skipped: an item with no spec at all is exactly the case a
 * required field is about.
 *
 * The document is validated as written, not as `specFields` reads it, so
 * a shape using a keyword these readers know nothing about still
 * enforces it.
 */
export function specIssues(shape: SpecShape, spec: Record<string, unknown> | null | undefined): SchemaIssue[] {
  const parsed = validatorFor(shape).parse(typeOwnedSpec(shape, spec));
  return parsed.ok ? [] : parsed.issues;
}

/**
 * The keys EO keeps in an item's `spec` that belong to no type.
 *
 * One today. `touches` is the repository-relative paths the overlap
 * check serialises colliding work against (E-01): a property of the
 * *work* rather than of its type, with no column of its own, living in
 * the one open bag an item has. Every type's items may carry it and no
 * type declares it.
 */
export const SYSTEM_SPEC_FIELDS: readonly string[] = ["touches"];

/**
 * The part of a spec its type's shape is the authority on (KAN-147).
 *
 * A shape is a JSON Schema and the validator is the whole authority on
 * what a valid spec is — but only over what the *type* owns. EO's own
 * keys are not that: a shape closed with `additionalProperties: false`
 * would otherwise refuse a perfectly ordinary hand-over for carrying
 * `touches`, which EO put there, and a decomposition would store a child
 * that fails its own type's shape for the same reason. Neither is a
 * statement about the type; both are EO judging a pack by a key EO
 * added.
 *
 * **Unless the type declares it.** A pack that puts `touches` in its own
 * shape has said it owns that field — its rules then apply to it, and
 * the value is read, rendered and demanded like any other. So this drops
 * a system key only where the shape is silent about it, which is what
 * lets both readings be true at once.
 *
 * One function rather than a rule each caller remembers, and inside
 * `specIssues` rather than beside it, so that every door — the hand-over,
 * the conversation approval, the detail's editor — is consistent by
 * construction.
 */
export function typeOwnedSpec(shape: SpecShape, spec: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const owned: Record<string, unknown> = { ...(spec ?? {}) };
  for (const name of SYSTEM_SPEC_FIELDS) {
    if (!(name in shape.properties)) delete owned[name];
  }
  return owned;
}

/**
 * The spec with whatever its shape defaults filled in.
 *
 * JSON Schema's `default` is an annotation rather than a rule — a
 * validator neither applies it nor is allowed to — so applying it is the
 * business of whoever is *building* a spec. Which is here, once, for both
 * doors: a bug filed with no acceptance criteria holds an empty list
 * rather than nothing at all, exactly as it did when a zod default said
 * so, and a type that declares a default gets it without its door
 * knowing which field or which type.
 *
 * Only for a field the spec does not already have. A caller that said
 * something, including something empty, has said it.
 */
export function withShapeDefaults(shape: SpecShape, spec: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...spec };
  for (const [name, property] of Object.entries(shape.properties)) {
    const fallback = property["default"];
    if (fallback !== undefined && filled[name] === undefined) filled[name] = fallback;
  }
  return filled;
}

/**
 * The fields a spec is missing outright, as their names.
 *
 * Separate from `specIssues` because a refusal a person reads is a list
 * of what to supply, while an issue list is for an agent re-prompted
 * with it. A field present but empty — `""`, or a list with nothing in
 * it — counts as missing, which is what `minLength` and `minItems` are
 * doing on the shapes and what "arrive complete" has always meant here.
 */
export function missingSpecFields(shape: SpecShape, spec: Record<string, unknown> | null | undefined): SpecField[] {
  const issues = specIssues(shape, spec);
  if (issues.length === 0) return [];
  const named = new Set(issues.map((issue) => String(issue.path[0] ?? "")));
  return specFields(shape).filter((field) => named.has(field.name));
}

/**
 * What EO says about a field it owns and will not let a type change.
 *
 * The kind, and what a list holds.
 */
const STRUCTURAL_KEYWORDS = ["type", "items"];

/**
 * One field a type declares that EO already has: narrowed, not
 * redefined (KAN-147).
 *
 * Both composed schemas put fields of their own beside a type's — a
 * classification's `understanding` and `decisions`, a child's
 * `depends_on` and `touches`, and the item's own `title` and `body` in
 * both — and a type may name one of them. Naming it is narrowing the
 * field that is already there rather than adding a second beside it, so
 * what the type says is taken: a `minLength` on an understanding, a
 * `minItems` on a list, a `description` of what this type means by it.
 * Dropping those is how a type demands something the document never asks
 * for.
 *
 * **Except what the field *is*.** The kind of the value, and what a list
 * holds, are EO's: an understanding is prose to pin, `depends_on` is
 * indices into a plan, and everything that reads them is written to
 * that. A type calling one of them something else is not narrowing, it
 * is claiming a word whose meaning belongs to the machinery — and
 * composing that would produce a document whose valid answers EO cannot
 * use. So the redefinition is ignored here, and the type's own shape
 * refuses the item when the answer is stored, which says out loud what
 * the declaration costs rather than writing something invalid.
 */
export function narrowEnvelopeField(envelope: Record<string, unknown>, declared: Record<string, unknown>): JsonSchema {
  const merged: Record<string, unknown> = { ...envelope, ...declared };
  for (const keyword of STRUCTURAL_KEYWORDS) {
    if (keyword in envelope) merged[keyword] = envelope[keyword];
    else delete merged[keyword];
  }
  return merged as JsonSchema;
}
