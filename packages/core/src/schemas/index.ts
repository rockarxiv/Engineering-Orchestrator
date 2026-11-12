import type { JsonSchema } from "../agent-provider.js";
import { actionSchemaName, definedActionFor, schemaByAction, type ActionSubject, type Registry } from "../registry/index.js";
import { actionAnswerDocument, type ActionDefinition } from "./actionDefinition.js";
import { ClarificationRequiredSchema, parseIfFenced, unwrapOutcome } from "./clarification.js";
import { INTAKE_ACTION, intakeOutputSchemaFor } from "./intake.js";
import { REFINE_ACTION, refineOutputSchemaFor } from "./refine.js";
import { dialectOf, formatIssues, zodOutputSchema, type JsonSchemaDocument, type OutputSchema } from "./outputSchema.js";

export * from "./actionDefinition.js";
export * from "./agentAttachments.js";
export * from "./assist.js";
export * from "./assistCard.js";
export * from "./assistTrial.js";
export * from "./clarification.js";
export * from "./clarify.js";
export * from "./commentOptions.js";
export * from "./configure.js";
export * from "./connectorBindings.js";
export * from "./connectors.js";
export * from "./commentPlan.js";
export * from "./discussion.js";
export * from "./environmentVariables.js";
export * from "./gallery.js";
export * from "./httpUrl.js";
export * from "./implement.js";
export * from "./intake.js";
export * from "./jobs.js";
export * from "./interpret.js";
export * from "./mcpServers.js";
export * from "./modules.js";
export * from "./moduleChange.js";
export * from "./outputSchema.js";
export * from "./pageDescriptor.js";
export * from "./pipelineExport.js";
export * from "./pipelines.js";
export * from "./priority.js";
export * from "./proposalSummary.js";
export * from "./refine.js";
export * from "./repositoryIntelligence.js";
export * from "./respond.js";
export * from "./review.js";
export * from "./scenario.js";
export * from "./skills.js";
export * from "./specShape.js";
export * from "./verification.js";
export * from "./viewSnapshot.js";
export * from "./workspaces.js";

/**
 * The request-to-be-told-something every action's answer is unioned with
 * (KAN-29). Wrapped once, here, rather than on every lookup.
 */
const CLARIFICATION_REQUIRED = zodOutputSchema(ClarificationRequiredSchema);

/**
 * The validator for an action's result, or undefined if no role in the
 * registry declares one.
 *
 * The registry is a parameter rather than a module-level map (KAN-124):
 * which schemas exist is a property of which packs are installed, and a
 * lookup that read a constant of its own could only ever answer for the
 * developer pack. By action across every role — see
 * `RoleEntry.schemasByAction` for why the role is not part of the
 * question.
 *
 * Every schema a role carries is zod today, wrapped as an `OutputSchema`
 * (EO-217) so that one arriving as data — a JSON Schema document in a
 * pack file, phase 6 — takes the same path through validation and the
 * provider without this lookup, or anything reading what it returns,
 * knowing which kind it was handed. The wrapping is done where the
 * registry is built, which is what keeps it once-per-registry rather
 * than once-per-lookup.
 *
 * The item's **type** is the one exception to "keyed by action alone"
 * (KAN-19, KAN-163). `refine` on a container decomposes it into the work
 * under it; `refine` on a leaf — anything that arrived already written —
 * asks a different question and so has a different answer. Same pipeline
 * stage, same role, different shape, which is why this is a second key
 * here rather than a second workflow state everyone's project would grow
 * a column for.
 *
 * Which of the two is the type's own business and arrives as data: the
 * `refine` entry in its `actionOverrides` names the schema, and a type
 * that overrides nothing inherits the default the role that ships the
 * action declared for its kind (`actionSchemaName`). No word and no flag
 * is compared here — a pack whose container is an Epic gets the
 * decomposition shape, a hand-made leaf gets the clarify one, and a pack
 * whose leaf answers in a third shape entirely gets that, all without
 * this lookup learning a single type's name.
 *
 * Omitting the type keeps the by-action answer, so a caller with no item
 * in hand is never silently given the wrong schema.
 *
 * `intake` is the other exception, and a different kind of one (KAN-147).
 * Its answer classifies an item into one of the project's types and
 * carries that type's own fields, so its shape is composed from
 * `registry.itemTypes` rather than looked up: a registry scoped to a
 * project (`registryForProject`) offers the types that project has, which
 * is how a type somebody added in the configure screen becomes something
 * intake can classify into. The pack still declares the action — that is
 * what makes it the pack's — and declares it composed from the types it
 * ships; this recomposes the same document for the types in hand.
 *
 * And the dispatched **role** comes before all of it (EO-421). A role
 * that defines this action for itself is held to the schema generated
 * from that definition, whatever a type or a pack says the action name
 * means; a role that does not is answered exactly as above. Omitting the
 * role keeps the by-action answer, so a caller with no agent in hand —
 * an editor drawing a pack's shape — is never handed one role's
 * definition as though it were the action's.
 */
export function resultSchemaFor(registry: Registry, action: string, type?: ActionSubject, role?: string | null): OutputSchema | undefined {
  const defined = definedActionFor(registry, role, action);
  if (defined !== undefined) return defined.schema;
  // Which shape this run is held to, before which document that shape
  // is: the override's name where the type has an opinion, the action's
  // own name where it has none.
  const named = actionSchemaName(registry, action, type);
  if (named === INTAKE_ACTION && schemaByAction(registry, named) !== undefined) return intakeOutputSchemaFor(registry.itemTypes.values());
  // And `refine` is the second, for the same reason as `intake`: what a
  // decomposition answers with is children *of the project's types*,
  // each carrying that type's own fields, so the document is composed
  // from `registry.itemTypes` rather than looked up (KAN-147). A leaf
  // never reaches it, because its override named another shape.
  if (named === REFINE_ACTION && schemaByAction(registry, named) !== undefined) return refineOutputSchemaFor(registry.itemTypes.values());
  return schemaByAction(registry, named);
}

/**
 * The JSON Schema handed to the provider so it can constrain generation
 * natively — the original design's "demand structured output, never parse prose".
 *
 * A lookup by action in front of `providerSchemaFor`, which is where
 * the shape is decided.
 */
export function outputSchemaFor(registry: Registry, action: string, type?: ActionSubject, role?: string | null): JsonSchema | undefined {
  const schema = resultSchemaFor(registry, action, type, role);
  if (!schema) return undefined;
  return providerSchemaFor(schema);
}

/**
 * What a provider is handed for one `OutputSchema`, whichever kind it
 * is. The wrapper is assembled by hand rather than by unioning zod
 * schemas, because one of the two branches may no longer be zod; the
 * snapshot in providerSchema.test.ts holds it byte-identical to what the
 * zod union used to emit.
 */
export function providerSchemaFor(schema: Pick<OutputSchema, "toJsonSchema" | "mayBeAbsent">): JsonSchema {
  // Either the action's own answer, or a request to be told something
  // first (KAN-29). Offered as a union so the constrained-generation
  // path can produce a clarification natively — an agent left to invent
  // the shape of "I am blocked" writes prose, and prose is what the design
  // exists to avoid.
  //
  // Clarification first: a real result never matches it, but a
  // clarification could partially satisfy a loose action schema, and
  // the order is what stops that.
  //
  // Wrapped in `outcome` rather than offered at the root, because the
  // API refuses a root union outright — "input_schema does not support
  // oneOf, allOf, or anyOf at the top level". Probed against the real
  // SDK rather than assumed: a root union returns HTTP 400 on every
  // dispatch while every unit test stays green, which is exactly how
  // the `$schema` dialect bug got into production once already.
  //
  // One level down the restriction lifts, and nesting keeps what a flat
  // object would have cost: each branch keeps its own required fields,
  // so `branch` and `summary` are still guaranteed by generation rather
  // than merely asked for.
  //
  // The dialect belongs at the root and nowhere else: a nested `$schema`
  // is what each branch carries on its own, and what it must lose when
  // it becomes part of a larger document — which it can lose safely
  // only because the root has just adopted it. What else a branch must
  // lose, keep or take with it is `placeBranch`'s subject.
  //
  // `required` is left off when the schema says its value may be absent
  // — see `OutputSchema.mayBeAbsent` for why a document alone cannot
  // say so and why the provider must keep seeing what it saw.
  const defs: Record<string, unknown> = {};
  const document = schema.toJsonSchema();
  const branches = [CLARIFICATION_REQUIRED.toJsonSchema(), document].map((branch, index) => placeBranch(branch, index, defs));
  return {
    // The wrapper is written in the dialect of the document it carries,
    // not in EO's. A compound document is meta-validated whole, so a
    // draft-07 branch under a 2020-12 root is refused before any result
    // is looked at — and if it were not, it would be read as 2020-12,
    // where `items: [...]` is no longer a tuple and a keyword beside a
    // `$ref` is no longer ignored. Every schema EO defines is 2020-12,
    // so for all of them this is the constant it always was.
    $schema: dialectOf(document),
    type: "object",
    properties: { outcome: { anyOf: branches } },
    ...(schema.mayBeAbsent ? {} : { required: ["outcome"] }),
    // Only when a branch needed embedding: zod emits no reference of any
    // kind, so every schema EO defines is placed inline and the snapshot
    // holds the root's keys where they have always been.
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };
}

/**
 * What a provider is handed for a role-defined action, from the
 * definition alone (EO-427).
 *
 * The same document a dispatch arrives at — `actionAnswerDocument`
 * under `providerSchemaFor`'s wrapper — without compiling it on the way,
 * so the agent screen can draw it: the renderer's content security
 * policy forbids the code generation ajv compiles with, and a preview
 * validates nothing. One function rather than the two calls made
 * wherever it is drawn, so what a person is shown and what
 * `outputSchemaFor` answers cannot come apart; the test beside this
 * holds them equal.
 */
export function actionDefinitionProviderSchema(definition: Pick<ActionDefinition, "results" | "fields">): JsonSchema {
  const document = actionAnswerDocument(definition);
  return providerSchemaFor({ toJsonSchema: () => document });
}

/**
 * The keys of the wrapper's `$defs` under which an embedded branch is
 * put. Indexed by branch so two can never collide, and stable so the
 * same document always produces the same provider schema.
 */
const EMBEDDED_BRANCH_PREFIX = "outcome_";

/**
 * The identity given to an embedded branch that declares none. Any
 * absolute URI would do; this one is a URN so it can never be fetched,
 * and names what it is so a schema read off the wire explains itself.
 */
const EMBEDDED_BRANCH_ID = "urn:eo:output-schema:";

/**
 * One branch of the wrapper, put somewhere it goes on meaning what it
 * meant.
 *
 * A document that refers to itself does so from its own root — `$ref:
 * "#/$defs/step"`, or `"https://example.test/plan#/$defs/step"` against
 * its own `$id`, or `"#step"` for an anchor. Nesting the document's
 * *contents* under `outcome` moves that root, and every one of those
 * references then means something else or nothing at all: a document ajv
 * compiled becomes a provider schema nothing can resolve.
 *
 * An earlier cut of this rewrote the references instead. That is the
 * wrong shape of answer, and it was wrong three ways: it could not
 * follow a reference resolved through the document's `$id`, it rewrote
 * `$ref`-shaped *data* sitting in a `const`, and it had to know which
 * keywords hold subschemas to do either — a list that grows with the
 * specification. Rewriting a document is a promise to understand all of
 * it.
 *
 * So nothing is rewritten. A document that carries any reference
 * machinery is *embedded* whole under the wrapper's `$defs`, keeping its
 * own `$id` — or given one if it has none — which makes it a schema
 * resource in its own right, exactly as the specification's bundling
 * (§9.3.1, compound schema documents) provides for. Every reference
 * inside it resolves against that `$id` and so still means what its
 * author meant, whether relative, absolute or an anchor, and whatever
 * keyword it sits under. The branch itself becomes `$ref:
 * "#/$defs/outcome_N"` — the one reference form both backends document.
 *
 * A document carrying no such machinery — which is every schema zod
 * emits, and so every action EO ships — is placed inline as before, so
 * the provider schema is byte-identical to the one the zod union built.
 *
 * `true` and `false` are documents too (§4.3.2): `true` accepts
 * anything, which is what `{}` says as an object, and `false` accepts
 * nothing, which is what `{ not: {} }` says. Spreading `false` into an
 * object would have turned "no result is acceptable" into "every result
 * is" at the one moment a schema was trying hardest to say no.
 *
 * The `$schema` a branch declares is dropped because the wrapper has
 * adopted it: there is one document branch, so the root's dialect is
 * always that branch's, and repeating it inside would be noise rather
 * than information. `$defs` is used for the embedding whatever the
 * dialect, including draft-07 where the spelling is `definitions`: an
 * unknown keyword is ignored rather than rejected, and the reference
 * that reaches into it is a JSON pointer, which resolves on position
 * rather than on the name of the keyword it passes through.
 */
function placeBranch(document: JsonSchemaDocument, index: number, defs: Record<string, unknown>): JsonSchema {
  if (typeof document === "boolean") return document ? {} : { not: {} };

  const copy = { ...document };
  delete copy["$schema"];
  if (!carriesReferences(copy)) return copy;

  if (typeof copy["$id"] !== "string") copy["$id"] = `${EMBEDDED_BRANCH_ID}${index}`;
  defs[`${EMBEDDED_BRANCH_PREFIX}${index}`] = copy;
  return { $ref: `#/$defs/${EMBEDDED_BRANCH_PREFIX}${index}` };
}

/**
 * Whether a document contains anything that would be read relative to
 * its own root, and so anything that embedding has to protect.
 *
 * Deliberately blunt: every key anywhere in the document is considered,
 * including inside a `const` or an `enum` where a `$ref` is a literal
 * value rather than a reference. A false positive costs an embedding
 * that was not needed and changes nothing about what the schema means —
 * where guessing the other way, and inlining a document that did have a
 * reference, is the bug this exists to prevent. It is the one question
 * that can be answered without knowing which keywords hold subschemas.
 */
function carriesReferences(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesReferences);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => REFERENCE_KEYWORDS.has(key) || carriesReferences(child));
}

/**
 * The keywords whose meaning depends on which resource they sit in.
 * `definitions` is draft-07's spelling of `$defs`, kept because a
 * hand-written document may still use it and an unknown keyword is
 * carried along rather than rejected.
 */
const REFERENCE_KEYWORDS = new Set(["$ref", "$id", "$anchor", "$defs", "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor", "definitions"]);

export interface ValidationFailure {
  ok: false;
  /** Fed back to the agent verbatim on the re-prompt, so it can see exactly what to fix. */
  error: string;
}

export type ValidationResult<T> = { ok: true; value: T } | ValidationFailure;

/**
 * The scaffolding a model sometimes leaves inside its own answer
 * (KAN-23).
 *
 * A real `refine` result once ended with `</understanding></invoke>` —
 * *inside* the JSON string. Nothing catches it: a string is a string, so
 * it validated, and the text went on to a human's comment thread and to
 * the next agent's context.
 *
 * Deliberately not a general sanitiser. Stripping trailing pseudo-markup
 * from every string would mangle legitimate content: a reviewer quoting
 * HTML, or a story about templating, ends in `</div>` for good reasons.
 *
 * What makes this safe is the tag name. Only a closing tag named after
 * **the field's own key** is removed, and only at the very end. A model
 * filling `understanding` has no legitimate reason to close a tag called
 * `understanding` — that name exists only in the schema it was handed,
 * so its appearance is proof of the artifact rather than evidence about
 * the content. `</invoke>` is taken with it when it trails, since it is
 * the same emission leaking one level further out.
 *
 * Observed once in 38 string fields across four real runs. Rare, silent,
 * and cheap to remove exactly.
 */
export function stripFieldTagBleed(key: string, value: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`\\s*</${escaped}>\\s*(?:</invoke>\\s*)?$`), "");
}

/** Applies the above to a result's own top-level string fields, which is where the schema's key names are. */
function stripBleed(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const entries = Object.entries(value as Record<string, unknown>).map(([key, field]) =>
    typeof field === "string" ? [key, stripFieldTagBleed(key, field)] : [key, field],
  );
  return Object.fromEntries(entries);
}

/**
 * Validates a raw agent result against its action's schema. An action
 * with no registered schema passes through unvalidated rather than
 * failing — the alternative would make adding a workflow state require
 * a code change, which invariant #7 forbids.
 *
 * The tag-bleed strip (KAN-23) happens on the way *out*, so only the
 * validated half is cleaned. The raw half is persisted beside it (ARCHITECTURE.md, "A run")
 * and stays exactly as the agent said it — which is the point of keeping
 * both, and what you want when something turns out to be wrong later.
 */
export function validateActionResult(registry: Registry, action: string, rawInput: unknown, type?: ActionSubject, role?: string | null): ValidationResult<unknown> {
  const schema = resultSchemaFor(registry, action, type, role);
  // The `outcome` wrapper is how one provider's constrained generation
  // is made to offer a union at all; nothing downstream should know it
  // existed.
  if (!schema) return { ok: true, value: stripBleed(unwrapOutcome(rawInput)) };
  return validateResultAgainst(schema, action, rawInput);
}

/**
 * The validation path itself, for a schema already in hand. What
 * `validateActionResult` runs once it has looked its schema up, and what
 * a schema that never sat in the map — a pack's, loaded from a file —
 * runs directly. There is one path on purpose: the unfencing, the
 * `outcome` unwrap, the re-prompt wording and the tag-bleed strip are
 * things every result needs, not things a zod schema happens to get.
 *
 * `action` names the schema in the re-prompt and nothing more.
 */
export function validateResultAgainst(schema: OutputSchema, action: string, rawInput: unknown): ValidationResult<unknown> {
  // Asking for a schema is not the same as getting one. Claude falls back
  // to `message.result` — the model's own text — whenever the SDK reports
  // no `structured_output`, and Codex's parse of its final message is a
  // bare `JSON.parse` that a fence defeats. Either way a perfectly
  // well-formed answer arrives as a string wrapped in ```json, and
  // matching a string against an object schema rejects it: two correction
  // turns are spent and the run escalates over a result that was right
  // all along.
  //
  // `asClarification` already unfences the very same value before looking
  // at it — this is the same net under the answer, not a new one. Only
  // where a schema exists, so an action without one still passes its text
  // through untouched.
  const raw = unwrapOutcome(parseIfFenced(rawInput));

  const parsed = schema.parse(raw);
  if (!parsed.ok) {
    return { ok: false, error: `The result did not match the required schema for "${action}":\n${formatIssues(parsed.issues)}` };
  }
  return { ok: true, value: stripBleed(parsed.data) };
}
