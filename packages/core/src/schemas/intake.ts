import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";
import { jsonSchemaOutputSchema, type OutputSchema } from "./outputSchema.js";
import { narrowEnvelopeField, withoutEoKeywords, type ComposableItemType, type SpecShape } from "./specShape.js";

/** The action this file is the shape of. Named, because `resultSchemaFor` composes this one. */
export const INTAKE_ACTION = "intake";

/**
 * Something the human settled during intake (KAN-32).
 *
 * `system-agent.md` has always asked for these to be recorded as
 * pinned comments, and they never were: the comment tool has no
 * `pinned` field, so an agent could not pin anything even when it did
 * exactly as it was told. Every decision reached in intake was an
 * ordinary comment, and therefore first in line to be dropped when the
 * thread outgrew the context window.
 *
 * Returning them instead of writing them is what fixes that — the
 * engine pins what it posts, and the agent cannot get it wrong.
 */
export const SettledDecisionSchema = z.object({
  /** What the decision is about, short enough to scan: "Rate limit scope". */
  topic: z.string().min(1),
  /** What was settled, in the human's terms: "Per API key, not per account." */
  decision: z.string().min(1),
});

export type SettledDecision = z.infer<typeof SettledDecisionSchema>;

/**
 * What `intake` returns, composed from the project's item types
 * (KAN-147).
 *
 * It used to be a discriminated union over `feature`, `story` and `bug`:
 * three branches written out in this file, which is three types a pack
 * could not add to and three words core should never have known. What it
 * is instead is one branch per type the project *has* — a classification
 * into one of them, plus the fields that type's spec shape demands.
 *
 * The two branch shapes are not per-type facts; they are what `intake`
 * means either side of the container flag (KAN-146):
 *
 * - **A container** is being understood before it is decomposed, so it
 *   answers with an `understanding` to pin and whatever was `decisions`
 *   settled along the way. `refine` reads the first of those instead of
 *   replaying the conversation that produced it.
 * - **A leaf** arrived already written and is being classified, so it
 *   answers with a title, a body and its own spec fields — the same bar
 *   a decomposed child is held to, because a leaf reaching this shape
 *   skips `refine` entirely and nothing downstream fills in what the
 *   product owner left out.
 *
 * `ready` is a literal `true` in both, exactly as in
 * `ClarifyOutputSchema` and for the same reason: there is no way to
 * return "not yet". A product owner that still has questions asks them,
 * and asking is its own result shape (`ClarificationRequired`) that
 * parks the item. One parking mechanism, not two.
 *
 * **A document rather than zod**, because the branches are data now and
 * zod cannot be composed from a JSON Schema — which is exactly the seam
 * `OutputSchema` was added for (KAN-125, EO-217). Everything reading a
 * validated result goes on reading it the same way.
 *
 * The back-compatibility that used to live here is gone with the union:
 * a result carrying no `type` was stamped as the feature it must have
 * been, for payloads written before KAN-4 gave intake more than one
 * answer. Two phases later there are none in flight, and a shape
 * composed from the project's types has no "the one it must have been"
 * to fall back on.
 */

/** One item type, as the composer needs it. `ItemTypeEntry` is one of these. */
export type IntakeItemType = ComposableItemType;

/** Byte-identical to what zod emitted for `SettledDecisionSchema`, so the shape a provider sees is unchanged. */
const DECISION_DOCUMENT: JsonSchema = {
  type: "object",
  properties: {
    topic: { type: "string", minLength: 1 },
    decision: { type: "string", minLength: 1 },
  },
  required: ["topic", "decision"],
};

function branchFor(type: IntakeItemType): JsonSchema {
  const properties: Record<string, unknown> = {
    type: { type: "string", const: type.slug },
    ready: { type: "boolean", const: true },
  };
  const required = ["type", "ready"];

  if (type.container) {
    properties["understanding"] = { type: "string", minLength: 1 };
    // Defaulted rather than required, as it always was: a container
    // described clearly enough the first time genuinely settles nothing,
    // and demanding an invented decision would be worse than recording
    // none.
    properties["decisions"] = { default: [], type: "array", items: DECISION_DOCUMENT };
    required.push("understanding");
  } else {
    properties["title"] = { type: "string", minLength: 1 };
    properties["body"] = { type: "string" };
    required.push("title", "body");
  }

  // The type's own fields, whichever kind of type it is — minus EO's
  // private keywords, which a model has no use for and a strict provider
  // would refuse (invariant 12).
  //
  // **A container's shape counts too.** The two branches differ in what
  // EO itself asks of them — a container is understood before it is
  // decomposed, a leaf arrives already written — and not in whether the
  // *type* may declare fields. A pack whose container carries a quarter
  // and an owner would otherwise have a type that demands them at
  // creation and a classification that neither asks for them nor could
  // store them: an item intake itself could not produce validly.
  //
  // A field the branch already carries is *narrowed* by a type that
  // names it, not replaced and not ignored — see `narrowEnvelopeField`,
  // which the decomposition composes the same way. So a container
  // demanding fifty characters of understanding gets that asked for, and
  // one calling an understanding a number does not get the kind changed
  // under `postIntakeSummary`, which pins it as prose.
  for (const [name, property] of Object.entries(type.specShape.properties)) {
    const declared = withoutEoKeywords(property);
    const envelope = properties[name];
    properties[name] = envelope === undefined ? declared : narrowEnvelopeField(envelope as Record<string, unknown>, declared);
  }
  required.push(...type.specShape.required.filter((name) => !required.includes(name)));

  return { type: "object", properties, required };
}

/**
 * What a project with no item types at all can still be held to.
 *
 * Reachable two ways: a lookup with no project in hand, and an
 * installation with no pack installed — which the core is required to
 * build and run without (invariant 13). A classification is all there is
 * to check, so it is all this asks for; the alternative is a `oneOf`
 * with no branches, which is a document that accepts nothing and would
 * fail every intake run rather than saying why.
 */
const ANY_CLASSIFICATION: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", minLength: 1 },
    ready: { type: "boolean", const: true },
  },
  required: ["type", "ready"],
};

/** ajv compiles a document once; the composer is called per dispatch. */
const composed = new Map<string, OutputSchema>();

/**
 * The intake schema for these types, memoized on the document it
 * composes to.
 *
 * Keyed on the document rather than on the types it came from, because
 * two projects with the same types are the same question — and a type
 * renamed in the editor (ARCHITECTURE.md, "An item type is data") composes to a different document
 * and so
 * gets a different answer, without anything having to remember to
 * invalidate a cache.
 *
 * **`anyOf`, where zod's discriminated union emitted `oneOf`.** Two packs
 * may ship the same slug (ARCHITECTURE.md, "An item type is data") and an answer carries the bare
 * word, so a
 * result saying `bug` on a project with a `developer:bug` and a
 * `support:bug` matches two branches. Under `oneOf` that is a *malformed
 * result*, which it is not: it is an ambiguous classification, and
 * `resolveItemType` is what answers it — by name, with both spellings.
 * Re-prompting the agent for a word that was never the problem would be
 * the wrong half of EO apologising. `anyOf` is also the kinder document
 * for a provider: it is in every strict structured-output subset EO has
 * met, and `oneOf` is not in all of them (invariant 12).
 */
export function intakeOutputSchemaFor(types: Iterable<IntakeItemType>): OutputSchema {
  const branches = [...types].map(branchFor);
  const document: JsonSchema = branches.length === 0 ? ANY_CLASSIFICATION : { anyOf: branches };
  const key = JSON.stringify(document);
  const found = composed.get(key);
  if (found) return found;
  const made = jsonSchemaOutputSchema(document);
  composed.set(key, made);
  return made;
}

/**
 * What every intake answer carries, whatever it classified into.
 *
 * A reader, not the contract: the composed document above is what an
 * agent is held to, and this is how EO picks the classification out of
 * an answer that already passed it. Loose for that reason — the fields
 * a branch added are not this schema's business, and rejecting them
 * here would be a second, stricter contract nobody agreed to.
 *
 * Kept in this file beside the composer so the two cannot drift: every
 * field named here is one every branch above declares.
 */
export const IntakeAnswerSchema = z.looseObject({
  /** An item type's slug, which the composed document restricted to the project's. */
  type: z.string().min(1),
  ready: z.literal(true),
});

/** A container's answer: what to pin, and what was settled. */
export const ContainerIntakeSchema = IntakeAnswerSchema.extend({
  understanding: z.string().min(1),
  decisions: z.array(SettledDecisionSchema).default([]),
});

/** A leaf's answer: what it is, plus whatever its type's shape asked for, flat. */
export const LeafIntakeSchema = IntakeAnswerSchema.extend({
  title: z.string().min(1),
  body: z.string(),
});

export type IntakeAnswer = z.infer<typeof IntakeAnswerSchema>;
export type ContainerIntake = z.infer<typeof ContainerIntakeSchema>;
export type LeafIntake = z.infer<typeof LeafIntakeSchema>;

/**
 * The spec a leaf answer is carrying, read by the shape that asked for
 * it.
 *
 * The fields are flat in the answer — a nested object renders as a
 * second level in a tool's JSON Schema, which models handle worse, and
 * it is how the three hand-written branches did it — so this is where
 * flat becomes the `spec` the item stores. Only what the shape declares
 * is taken: an agent that answered with something nobody asked for has
 * said something the type has no place to keep, and inventing a place
 * for it is how a spec becomes an open bag with no shape at all.
 */
export function specFromAnswer(shape: SpecShape, answer: Record<string, unknown>): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const name of Object.keys(shape.properties)) {
    if (answer[name] !== undefined) spec[name] = answer[name];
  }
  return spec;
}
