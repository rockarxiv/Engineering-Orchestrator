import { Ajv, type ErrorObject } from "ajv/dist/ajv.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";

/**
 * The dialect every schema handed to a provider declares at its root.
 * It is what `z.toJSONSchema` emits, and the one the ajv instance below
 * is built for — the two have to agree, or a schema that validated here
 * is refused over there.
 */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * A whole JSON Schema document, which the specification allows to be a
 * boolean as well as an object: `true` accepts every value and `false`
 * accepts none. They are not a curiosity — `false` is what a generated
 * or composed schema collapses to when it forbids everything, and a
 * document that says "no result is acceptable here" must keep saying it
 * all the way to the provider rather than becoming an empty object that
 * accepts anything.
 *
 * `JsonSchema` stays object-only: it is what a provider is handed, and
 * the provider wrapper is always an object. This is the wider type, for
 * a document on its way in.
 */
export type JsonSchemaDocument = JsonSchema | boolean;

/**
 * The same thing as a schema, for a document crossing a boundary
 * (EO-314).
 *
 * A pack carries its roles' output schemas as JSON Schema, so one
 * arrives as parsed JSON and has to be checked before it is treated as
 * a document. Deliberately shallow: what a *valid* JSON Schema is, is
 * ajv's question and it asks it at compile time with the document's own
 * declared dialect in hand (`jsonSchemaOutputSchema`). Narrowing it
 * here would be this file holding a second, weaker opinion about the
 * specification — and refusing a keyword some conforming validator
 * understands.
 *
 * Both halves of `JsonSchemaDocument`, `true` and `false` included, for
 * the reason the type has them: `false` says "no result is acceptable
 * here" and has to keep saying it.
 */
export const JsonSchemaDocumentSchema: z.ZodType<JsonSchemaDocument> = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

/**
 * The dialects a loaded document may declare, and the ajv each is read
 * with.
 *
 * A pack author writes JSON Schema, not EO's preferred edition of it,
 * and the edition is a property of the document rather than of us: a
 * validator built for one dialect does not merely misread another, it
 * refuses the document outright — ajv 2020-12 cannot resolve draft-07's
 * meta-schema and throws at load. Worse would be reading it anyway,
 * because the dialects disagree about real things: draft-07 spells a
 * tuple `items: [...]` where 2020-12 spells it `prefixItems`, and
 * ignores keywords beside a `$ref` that 2020-12 applies.
 *
 * Keys are the canonical dialect URIs with any trailing `#` removed,
 * which is the form a declared dialect is matched in: draft-07 is
 * conventionally written with the empty fragment and 2020-12 without,
 * and either spelling of either names the same edition.
 *
 * Draft-06 and earlier are absent, and deliberately: ajv 8 reads none of
 * them without either a further dependency (draft-04) or a meta-schema
 * registered by hand (draft-06), and an edition EO does not test is an
 * edition EO does not support. A document declaring one is refused by
 * name below, which is a thing a pack author can act on, rather than
 * left to surface as an ajv internal about an unresolvable reference.
 */
const DIALECTS: ReadonlyMap<string, new (options: { allErrors: boolean; strict: boolean }) => Ajv> = new Map([
  ["https://json-schema.org/draft/2020-12/schema", Ajv2020],
  ["https://json-schema.org/draft/2019-09/schema", Ajv2019],
  ["http://json-schema.org/draft-07/schema", Ajv],
]);

/**
 * The dialect a document declares, exactly as it declared it, or 2020-12
 * where it declares none.
 *
 * A document with no `$schema` is read as 2020-12 because that is what
 * zod emits and what EO's own schemas are, and because a document
 * written against an older draft that says so is the case this exists
 * to catch — one that says nothing is being read on trust either way.
 *
 * Verbatim rather than normalised, because this is also what the
 * provider wrapper declares when it adopts the dialect of the document
 * it carries, and a document's own spelling is the one to echo there.
 * Matching against the table normalises; see `validatorFor`.
 *
 * Exported because the wrapper has to declare the same dialect as the
 * document inside it: a compound document is meta-validated as a whole,
 * so a draft-07 branch under a 2020-12 root is rejected before any
 * result is ever looked at.
 */
export function dialectOf(document: JsonSchemaDocument): string {
  if (typeof document === "boolean") return JSON_SCHEMA_DIALECT;
  const declared = document["$schema"];
  return typeof declared === "string" ? declared : JSON_SCHEMA_DIALECT;
}

/** The ajv that reads a document's declared edition, or an error naming the editions EO has. */
function validatorFor(document: JsonSchemaDocument): new (options: { allErrors: boolean; strict: boolean }) => Ajv {
  const declared = dialectOf(document);
  // An empty fragment names the same resource as none, so `draft-07/schema#`
  // and `draft-07/schema` are one dialect written two conventional ways.
  const Validator = DIALECTS.get(declared.endsWith("#") ? declared.slice(0, -1) : declared);
  if (!Validator) {
    throw new Error(`This JSON Schema document declares the dialect "${declared}", which EO cannot read. Supported: ${[...DIALECTS.keys()].join(", ")}.`);
  }
  return Validator;
}

/** One thing wrong with a result: where, and what. */
export interface SchemaIssue {
  /** Property names and array indices from the root down; empty when the root itself is wrong. */
  path: ReadonlyArray<string | number>;
  message: string;
}

export type OutputParseResult<T> = { ok: true; data: T } | { ok: false; issues: SchemaIssue[] };

/**
 * What an action's result must satisfy, whichever way the schema was
 * written (EO-217).
 *
 * Every output schema used to be zod, resolved by action. That works
 * while every schema is code, and stops working the moment one arrives
 * as data: a pack ships its roles with output schemas in a file
 * (ARCHITECTURE.md, "Two kinds of pack, two trust classes", "One document"), and zod can emit JSON
 * Schema but
 * cannot consume it. This is the seam both kinds sit behind, so the
 * validation path, the re-prompt text and the provider-facing schema
 * are the same code whichever kind an action happens to have.
 *
 * Two constructors below; nothing else should need to know which one
 * produced a given value.
 */
export interface OutputSchema<T = unknown> {
  parse(input: unknown): OutputParseResult<T>;
  /**
   * The document this schema validates against, as JSON Schema. Carries
   * the dialect at its root when it is an object.
   *
   * Not what a provider is handed directly: `providerSchemaFor` places
   * it under `outcome` beside the clarification branch, which is where
   * a boolean or a document with references is made to keep its meaning.
   */
  toJsonSchema(): JsonSchemaDocument;
  /**
   * Whether the value may be missing altogether once this schema sits
   * as a property of a larger document — which `providerSchemaFor`
   * makes it, under `outcome`.
   *
   * This is what zod's emitter concludes about a schema whose input may
   * be missing — a `.optional()` or a `.default()` at the root; before
   * zod 4.6 a root `z.preprocess` too — and records by leaving the
   * property out of `required`. No action EO ships has one today. The
   * bare document does not say it, so the wrapper cannot recover it,
   * and the provider must keep receiving what it received. A JSON
   * Schema document never says it either: it describes a value, and a
   * value described is a value expected. Optional so that only a kind
   * with something to say says it.
   */
  readonly mayBeAbsent?: boolean;
}

/**
 * A zod schema behind the interface.
 *
 * `io: "input"` matters: the JSON Schema describes what the model must
 * *produce*, so a field with a zod default is optional rather than
 * required. Asking a model for a value we would have defaulted anyway is
 * a needless way to fail. It is also why `parse` hands back zod's
 * output rather than the input — defaults applied, unknown keys
 * stripped — exactly as it did before this interface existed.
 */
export function zodOutputSchema<T>(schema: z.ZodType<T>): OutputSchema<T> {
  return {
    parse(input) {
      const parsed = schema.safeParse(input);
      if (parsed.success) return { ok: true, data: parsed.data };
      return { ok: false, issues: parsed.error.issues.map(issueFromZod) };
    },
    toJsonSchema() {
      return spellTypeUnionsAsAnyOf(z.toJSONSchema(schema, { io: "input" })) as JsonSchema;
    },
    get mayBeAbsent() {
      // Asked of zod the way the old union asked it — by placing the
      // schema as a property and reading whether it came back required —
      // rather than read off an internal flag that is not public API.
      const asProperty = z.toJSONSchema(z.object({ value: schema }), { io: "input" });
      const required = Array.isArray(asProperty.required) ? asProperty.required : [];
      return !required.includes("value");
    },
  };
}

/** Keywords whose value is data rather than a schema, so a `type` inside it is not the keyword. */
const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);

/** Keywords whose value is a table of schemas by name: a property called `default` is a property. */
const SCHEMA_TABLE_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * zod's emission, with every `type` array spelled as the `anyOf` of bare
 * types it was before zod 4.6 (EO-671).
 *
 * From 4.6, `z.toJSONSchema` compacts `anyOf: [{ type: "string" }, { type:
 * "null" }]` into `type: ["string", "null"]`, after any `override` has run,
 * so no option reaches it. The two mean the same thing, but providers do
 * not document the same support for both: both take the nullable pair,
 * and neither says whether strict mode takes several non-null types, which
 * a `z.record` of primitives emits. The provider snapshot in
 * providerSchema.test.ts holds what every agent is asked to produce, and a
 * dependency bump is not the place to change it, so it is put back.
 */
function spellTypeUnionsAsAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(spellTypeUnionsAsAnyOf);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_TABLE_KEYWORDS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, spellTypeUnionsAsAnyOf(schema)]));
    } else {
      out[key] = SCHEMA_DATA_KEYWORDS.has(key) ? value : spellTypeUnionsAsAnyOf(value);
    }
  }
  const type = out["type"];
  if (Array.isArray(type) && type.every((member) => typeof member === "string")) {
    delete out["type"];
    out["anyOf"] = type.map((member) => ({ type: member }));
  }
  return out;
}

function issueFromZod(issue: z.core.$ZodIssue): SchemaIssue {
  return {
    // Symbols cannot be joined into a path a person reads; nothing EO
    // defines keys a result by one, so this is completeness, not a case.
    path: issue.path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
    message: issue.message,
  };
}

/**
 * A JSON Schema document behind the interface: the shape a pack file
 * carries.
 *
 * Compiled once, here. A document that does not compile is a malformed
 * schema rather than a malformed result, so it throws now rather than
 * failing every result later — whoever loads the document is the one
 * who can say where it came from.
 *
 * ajv is deliberately not strict. Strict mode is ajv's opinion about
 * how a schema should be written (no unknown keywords, no union types
 * without a flag); the specification's is that unknown keywords are
 * ignored, and a document written for any conforming validator should
 * validate the same here. `allErrors` for the same reason zod reports
 * every issue: the agent is re-prompted with the whole list and fixes
 * it in one turn rather than one field at a time.
 *
 * Successful `parse` returns the input untouched. zod strips unknown
 * keys and applies defaults; a JSON Schema validator does neither
 * unless told to, and telling it to would mutate the raw result the
 * supervisor persists beside the validated one (ARCHITECTURE.md, "A run"). A pack schema
 * that wants a field defaulted lists it as optional and reads it as
 * such.
 */
export function jsonSchemaOutputSchema(document: JsonSchemaDocument): OutputSchema<unknown> {
  // One instance per document: ajv keys its cache by `$id`, and two
  // packs are free to pick the same one.
  const ajv = new (validatorFor(document))({ allErrors: true, strict: false });
  const validate = ajv.compile(document);
  return {
    parse(input) {
      if (validate(input)) return { ok: true, data: input };
      return { ok: false, issues: (validate.errors ?? []).map(issueFromAjv) };
    },
    toJsonSchema() {
      return document;
    },
  };
}

function issueFromAjv(error: ErrorObject): SchemaIssue {
  const path = pointerSegments(error.instancePath);
  // ajv reports a missing property at its parent; zod reports it at the
  // property. The agent reading the re-prompt wants the latter — "title
  // is required" at `stories.0.title`, not at `stories.0`.
  if (error.keyword === "required" && typeof error.params["missingProperty"] === "string") {
    path.push(error.params["missingProperty"]);
  }
  return { path, message: error.message ?? error.keyword };
}

/** `/stories/0/title` → `["stories", "0", "title"]`, with JSON Pointer's `~1` and `~0` unescaped. */
function pointerSegments(pointer: string): (string | number)[] {
  if (pointer === "") return [];
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Issues as an agent can act on them — path plus message, one per line.
 * Fed back verbatim on the re-prompt, so the wording is part of what an
 * agent has learned to fix.
 */
export function formatIssues(issues: ReadonlyArray<SchemaIssue>): string {
  return issues.map((issue) => `- ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("\n");
}
