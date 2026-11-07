import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { JsonSchema } from "../agent-provider.js";
import { ImplementOutputSchema } from "./implement.js";
import { InterpretOutputSchema } from "./interpret.js";
import { developerRegistry } from "../registry/developer.js";
import { providerSchemaFor, resultSchemaFor, validateActionResult, validateResultAgainst } from "./index.js";
import { dialectOf, formatIssues, JSON_SCHEMA_DIALECT, jsonSchemaOutputSchema, zodOutputSchema, type JsonSchemaDocument, type OutputSchema } from "./outputSchema.js";
import { RespondOutputSchema } from "./respond.js";
import { ReviewOutputSchema } from "./review.js";

/** The same schema twice: as zod, and as the JSON Schema that zod emits for it, read back through the validator. */
function bothKinds(schema: z.ZodType): { viaZod: OutputSchema; viaJsonSchema: OutputSchema } {
  const viaZod = zodOutputSchema(schema);
  return { viaZod, viaJsonSchema: jsonSchemaOutputSchema(viaZod.toJsonSchema()) };
}

/**
 * The round trip the item asks for (EO-217): a zod schema exported to
 * JSON Schema, loaded back through ajv, accepts and rejects the same
 * fixtures. Every action schema a provider is handed today, minus the
 * one with a root `preprocess` — that one has its own test below,
 * because it is where the two genuinely differ.
 */
describe("a zod schema round-tripped through JSON Schema", () => {
  const cases: Array<{ name: string; schema: z.ZodType; accepts: unknown[]; rejects: unknown[] }> = [
    {
      name: "implement",
      schema: ImplementOutputSchema,
      accepts: [
        { branch: "eo/EO-1", summary: "done", handoff: "Nothing surprising." },
        { branch: "eo/EO-1", summary: "", handoff: "x", files_changed: ["a.ts"], tests_run: true },
      ],
      rejects: [
        { summary: "no branch", handoff: "x" },
        { branch: "", summary: "done", handoff: "x" },
        { branch: "eo/EO-1", summary: "done" },
        { branch: "eo/EO-1", summary: "done", handoff: "x", tests_run: "yes" },
        "a string",
        null,
        [],
      ],
    },
    {
      name: "review",
      schema: ReviewOutputSchema,
      accepts: [
        { verdict: "approve", feedback: "LGTM" },
        { verdict: "needs_user_input", feedback: "Which way?" },
        { verdict: "reject", feedback: "no", criteria_coverage: [], blocking_issues: ["fix it"] },
        // Accepted by both: a key the schema does not name is not an error
        // in either dialect. What each hands back differs — see below.
        { verdict: "needs_user_input", feedback: "Which way?", blocking_issues: ["a thing"] },
      ],
      rejects: [
        { verdict: "maybe", feedback: "hmm" },
        { verdict: "reject", feedback: "no", criteria_coverage: [], blocking_issues: [] },
        { verdict: "reject", feedback: "no", blocking_issues: ["fix it"] },
        { feedback: "no verdict" },
      ],
    },
    {
      name: "respond",
      schema: RespondOutputSchema,
      accepts: [{ message: "Rebased and force-pushed." }],
      rejects: [{ message: "" }, { branch: "eo/EO-1", summary: "done", handoff: "x" }, {}],
    },
    {
      name: "interpret",
      schema: InterpretOutputSchema,
      accepts: [
        { status: "answered", answer: "EO-3" },
        { status: "acted", summary: "Deleted the stale branch.", retry: true },
        { status: "unusable", problem: "it names a person" },
      ],
      rejects: [
        { status: "answered", answer: "" },
        { status: "acted", summary: "Did it." },
        { status: "answered", summary: "Did it.", retry: true },
        { status: "shrugged" },
      ],
    },
  ];

  it.each(cases)("agrees on every fixture for $name", ({ schema, accepts, rejects }) => {
    const { viaZod, viaJsonSchema } = bothKinds(schema);
    for (const fixture of accepts) {
      expect(viaZod.parse(fixture).ok, JSON.stringify(fixture)).toBe(true);
      expect(viaJsonSchema.parse(fixture).ok, JSON.stringify(fixture)).toBe(true);
    }
    for (const fixture of rejects) {
      expect(viaZod.parse(fixture).ok, JSON.stringify(fixture)).toBe(false);
      expect(viaJsonSchema.parse(fixture).ok, JSON.stringify(fixture)).toBe(false);
    }
  });

  it("hands the loaded document back unchanged as its JSON Schema", () => {
    const { viaZod, viaJsonSchema } = bothKinds(ImplementOutputSchema);
    expect(viaJsonSchema.toJsonSchema()).toEqual(viaZod.toJsonSchema());
    expect(viaJsonSchema.toJsonSchema()).toMatchObject({ $schema: JSON_SCHEMA_DIALECT });
  });

  it("differs on what comes back: zod applies defaults and strips unknown keys, the validator returns the input as it was", () => {
    // Documented rather than papered over. Filling defaults or removing
    // keys would mean mutating the raw result the supervisor keeps
    // beside the validated one; a pack schema that wants a default reads
    // its field as optional instead, and one that wants unknown keys
    // refused says `additionalProperties: false`.
    const { viaZod, viaJsonSchema } = bothKinds(ImplementOutputSchema);
    const input = { branch: "eo/EO-1", summary: "done", handoff: "x", extra: true };

    expect(viaZod.parse(input)).toEqual({ ok: true, data: { branch: "eo/EO-1", summary: "done", handoff: "x", files_changed: [], tests_run: false } });
    expect(viaJsonSchema.parse(input)).toEqual({ ok: true, data: input });
  });

  it("differs where zod does something no document can describe: a root preprocess", () => {
    // A step that runs *before* validation has no JSON Schema
    // equivalent, so a schema with one accepts an input the document it
    // emits rejects. `IntakeOutputSchema` was the one real case — it
    // stamped a missing `type` as the feature it must have been, for
    // results written before intake had more than one answer — and
    // KAN-147 removed it along with the union. The asymmetry is still
    // the kind's, so it is pinned on a schema of this test's own rather
    // than deleted with the case that used to show it.
    const stamped = z.preprocess(
      (value) => (typeof value === "object" && value !== null && !("kind" in value) ? { ...value, kind: "note" } : value),
      z.object({ kind: z.literal("note"), body: z.string().min(1) }),
    );
    const { viaZod, viaJsonSchema } = bothKinds(stamped);
    const untyped = { body: "Cap anonymous callers." };

    expect(viaZod.parse(untyped).ok).toBe(true);
    expect(viaJsonSchema.parse(untyped).ok).toBe(false);
    expect(viaJsonSchema.parse({ ...untyped, kind: "note" }).ok).toBe(true);
  });
});

describe("issues", () => {
  it("are formatted the way the zod error always was, so the re-prompt text is unchanged", () => {
    const parsed = zodOutputSchema(ImplementOutputSchema).parse({ branch: "eo/EO-1", summary: "done" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const before = ImplementOutputSchema.safeParse({ branch: "eo/EO-1", summary: "done" });
    const legacy = !before.success ? before.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`).join("\n") : "";

    expect(formatIssues(parsed.issues)).toBe(legacy);
    expect(formatIssues(parsed.issues)).toBe("- handoff: Invalid input: expected string, received undefined");
  });

  it("name the root when nothing narrower can be pointed at", () => {
    const parsed = zodOutputSchema(ImplementOutputSchema).parse("prose");
    expect(!parsed.ok && formatIssues(parsed.issues)).toMatch(/^- \(root\): /);

    const loaded = jsonSchemaOutputSchema({ type: "object" }).parse("prose");
    expect(!loaded.ok && formatIssues(loaded.issues)).toBe("- (root): must be object");
  });

  it("from the validator point at the missing property, not its parent, as zod's do", () => {
    const document: JsonSchema = {
      type: "object",
      properties: { stories: { type: "array", items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } },
      required: ["stories"],
    };
    const parsed = jsonSchemaOutputSchema(document).parse({ stories: [{ title: "ok" }, {}] });

    expect(parsed).toEqual({ ok: false, issues: [{ path: ["stories", "1", "title"], message: "must have required property 'title'" }] });
  });

  it("from the validator list everything wrong at once, so one re-prompt can fix it all", () => {
    const parsed = jsonSchemaOutputSchema(zodOutputSchema(ImplementOutputSchema).toJsonSchema()).parse({ summary: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const where = parsed.issues.map((issue) => issue.path.join("."));
    expect(where).toEqual(expect.arrayContaining(["branch", "handoff", "summary"]));
  });

  it("unescape JSON Pointer segments in a path", () => {
    const document: JsonSchema = { type: "object", properties: { "a/b": { type: "number" }, "c~d": { type: "number" } } };
    const parsed = jsonSchemaOutputSchema(document).parse({ "a/b": "x", "c~d": "y" });

    expect(!parsed.ok && parsed.issues.map((issue) => issue.path)).toEqual([["a/b"], ["c~d"]]);
  });
});

describe("a JSON Schema document loaded at runtime", () => {
  // What a pack file will carry (phase 6): the shape of a result this
  // core has never had a zod schema for.
  const document: JsonSchema = {
    $schema: JSON_SCHEMA_DIALECT,
    type: "object",
    properties: { note: { type: "string", minLength: 1 }, done: { type: "boolean" } },
    required: ["note", "done"],
  };

  it("validates a result through the same path as a zod schema: fence, outcome wrapper, tag bleed and all", () => {
    const schema = jsonSchemaOutputSchema(document);
    // Fenced, as Claude's text fallback and Codex's bare parse both hand
    // it over; wrapped in `outcome`, as constrained generation returns
    // it; and with the model's own scaffolding bleeding into a field
    // (KAN-23). Each of these was fixed once, for every schema, on this
    // path — a document must not have to earn them again.
    const raw = '```json\n{ "outcome": { "note": "Filed it.</note></invoke>", "done": true } }\n```';

    expect(validateResultAgainst(schema, "file_note", raw)).toEqual({ ok: true, value: { note: "Filed it.", done: true } });
  });

  it("re-prompts with the same wording a zod-backed schema produces", () => {
    const loaded = validateResultAgainst(jsonSchemaOutputSchema(document), "file_note", { note: "Filed it." });
    const zodBacked = validateActionResult(developerRegistry(), "implement", { branch: "eo/EO-1", summary: "done" });

    expect(loaded).toEqual({ ok: false, error: 'The result did not match the required schema for "file_note":\n- done: must have required property \'done\'' });
    expect(!zodBacked.ok && zodBacked.error).toBe('The result did not match the required schema for "implement":\n- handoff: Invalid input: expected string, received undefined');
  });

  it("is handed to a provider in the same wrapper as a zod schema: clarification first, under `outcome`, dialect at the root only", () => {
    const provided = providerSchemaFor(jsonSchemaOutputSchema(document));
    const zodBacked = providerSchemaFor(resultSchemaFor(developerRegistry(), "implement")!);

    expect(Object.keys(provided)).toEqual(Object.keys(zodBacked));
    expect(provided["$schema"]).toBe(JSON_SCHEMA_DIALECT);
    expect(provided["required"]).toEqual(["outcome"]);

    const outcome = (provided["properties"] as { outcome: { anyOf: JsonSchema[] } }).outcome;
    const zodOutcome = (zodBacked["properties"] as { outcome: { anyOf: JsonSchema[] } }).outcome;
    expect(outcome.anyOf[0]).toEqual(zodOutcome.anyOf[0]);
    const bare = { ...document };
    delete bare["$schema"];
    expect(outcome.anyOf[1]).toEqual(bare);
    expect(JSON.stringify(provided).split(JSON_SCHEMA_DIALECT)).toHaveLength(2);
  });

  /**
   * A document keeps its meaning by being embedded whole, as the
   * specification's bundling provides for, rather than by having its
   * references rewritten. Each test below compiles the provider wrapper
   * back through ajv and checks it constrains exactly what the loaded
   * document constrained — which is the only question that matters, and
   * one no amount of inspecting the shape answers.
   */
  describe("carrying references, as any hand-written document may", () => {
    /** Every way a document can point at itself: by pointer, through its own `$id`, and by anchor. */
    const withDefs: JsonSchema = {
      $schema: JSON_SCHEMA_DIALECT,
      $id: "https://example.test/schemas/plan",
      type: "object",
      properties: {
        steps: { type: "array", minItems: 1, items: { $ref: "#/$defs/step" } },
        next: { $ref: "https://example.test/schemas/plan#/$defs/step" },
        first: { $ref: "#step" },
      },
      required: ["steps"],
      $defs: {
        step: {
          $anchor: "step",
          type: "object",
          properties: { title: { type: "string", minLength: 1 }, sub: { type: "array", items: { $ref: "#/$defs/step" } } },
          required: ["title"],
        },
      },
    };
    const valid = { steps: [{ title: "Write it", sub: [{ title: "Test it" }] }], next: { title: "Ship it" }, first: { title: "Read it" } };

    /** What a provider is handed, read back through the validator — the wrapper as a whole, compiled. */
    function compiledWrapper(document: JsonSchemaDocument) {
      return jsonSchemaOutputSchema(providerSchemaFor(jsonSchemaOutputSchema(document)));
    }

    it("still validates results directly, as any validator would", () => {
      const schema = jsonSchemaOutputSchema(withDefs);
      expect(schema.parse(valid).ok).toBe(true);
      expect(schema.parse({ steps: [{ title: "" }] }).ok).toBe(false);
    });

    it("reaches the provider embedded whole, with its identity and definitions intact and nothing rewritten", () => {
      const provided = providerSchemaFor(jsonSchemaOutputSchema(withDefs));

      const branch = (provided["properties"] as { outcome: { anyOf: JsonSchema[] } }).outcome.anyOf[1]!;
      expect(branch).toEqual({ $ref: "#/$defs/outcome_1" });
      // Byte for byte what was loaded, minus only the dialect the
      // wrapper now declares at its root.
      const rest = { ...withDefs };
      delete rest["$schema"];
      expect((provided["$defs"] as Record<string, unknown>)["outcome_1"]).toEqual(rest);
      // The wrapper's own keys stay where the snapshot has them.
      expect(Object.keys(provided)).toEqual(["$schema", "type", "properties", "required", "$defs"]);
    });

    it("produces a provider schema that compiles and constrains exactly what the document did", () => {
      const wrapper = compiledWrapper(withDefs);

      expect(wrapper.parse({ outcome: valid }).ok).toBe(true);
      expect(wrapper.parse({ outcome: { steps: [] } }).ok).toBe(false);
      expect(wrapper.parse({ outcome: { steps: [{ title: "ok", sub: [{ title: "" }] }] } }).ok).toBe(false);
      // Reached through the document's own `$id`, and through its anchor.
      expect(wrapper.parse({ outcome: { steps: [{ title: "ok" }], next: { sub: [] } } }).ok).toBe(false);
      expect(wrapper.parse({ outcome: { steps: [{ title: "ok" }], first: { title: "" } } }).ok).toBe(false);
      // The clarification branch is still the other way out.
      expect(wrapper.parse({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Ambiguous." }] } }).ok).toBe(true);
    });

    it("keeps a pointer into its own body meaning what it meant, and needs no `$id` of its own to do it", () => {
      const selfReferencing: JsonSchema = {
        type: "object",
        properties: { first: { type: "string", minLength: 1 }, second: { $ref: "#/properties/first" }, whole: { type: "array", items: { $ref: "#" } } },
        required: ["first"],
      };
      const provided = providerSchemaFor(jsonSchemaOutputSchema(selfReferencing));
      const embedded = (provided["$defs"] as Record<string, JsonSchema>)["outcome_1"]!;

      // Given an identity, since it had none and `#` has to go on
      // meaning the document rather than the wrapper around it.
      expect(embedded["$id"]).toBe("urn:eo:output-schema:1");
      expect(embedded["properties"]).toEqual(selfReferencing["properties"]);

      const wrapper = compiledWrapper(selfReferencing);
      expect(wrapper.parse({ outcome: { first: "a", second: "b", whole: [{ first: "c" }] } }).ok).toBe(true);
      expect(wrapper.parse({ outcome: { first: "a", second: "" } }).ok).toBe(false);
      expect(wrapper.parse({ outcome: { first: "a", whole: [{ first: "" }] } }).ok).toBe(false);
    });

    it("leaves a `$ref`-shaped literal in a `const` or an `enum` alone: it is data, not a reference", () => {
      // The reason nothing is rewritten. A rewriter has to know that
      // `const` holds an instance rather than a subschema — and that
      // list of keywords grows with the specification — where embedding
      // never has to ask.
      const literals: JsonSchema = {
        type: "object",
        properties: {
          pinned: { const: { $ref: "#/literal" } },
          choice: { enum: [{ $ref: "#/one" }, "plain"] },
          real: { $ref: "#/$defs/text" },
        },
        required: ["pinned"],
        $defs: { text: { type: "string" } },
      };
      const wrapper = compiledWrapper(literals);

      // Accepted by the loaded document, so accepted through the wrapper.
      expect(jsonSchemaOutputSchema(literals).parse({ pinned: { $ref: "#/literal" }, choice: { $ref: "#/one" } }).ok).toBe(true);
      expect(wrapper.parse({ outcome: { pinned: { $ref: "#/literal" }, choice: { $ref: "#/one" } } }).ok).toBe(true);
      expect(wrapper.parse({ outcome: { pinned: { $ref: "#/rewritten" } } }).ok).toBe(false);
      expect(wrapper.parse({ outcome: { pinned: { $ref: "#/literal" }, real: 7 } }).ok).toBe(false);
    });
  });

  describe("that is a boolean, which the specification allows a whole document to be", () => {
    it("keeps `false` saying no result is acceptable, rather than becoming an empty object that accepts every one", () => {
      const loaded = jsonSchemaOutputSchema(false);
      expect(loaded.parse({ anything: true }).ok).toBe(false);

      const provided = providerSchemaFor(loaded);
      const branch = (provided["properties"] as { outcome: { anyOf: JsonSchema[] } }).outcome.anyOf[1]!;
      expect(branch).toEqual({ not: {} });

      const wrapper = jsonSchemaOutputSchema(provided);
      expect(wrapper.parse({ outcome: { anything: true } }).ok).toBe(false);
      // A clarification is still reachable: that branch is the wrapper's,
      // not the document's, and an agent may always say it is blocked.
      expect(wrapper.parse({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Ambiguous." }] } }).ok).toBe(true);
    });

    it("keeps `true` accepting anything", () => {
      const provided = providerSchemaFor(jsonSchemaOutputSchema(true));
      const branch = (provided["properties"] as { outcome: { anyOf: JsonSchema[] } }).outcome.anyOf[1]!;
      expect(branch).toEqual({});

      const wrapper = jsonSchemaOutputSchema(provided);
      expect(wrapper.parse({ outcome: { anything: true } }).ok).toBe(true);
      expect(wrapper.parse({ nothing: true }).ok).toBe(false);
    });

    it("validates a result through the same path as any other schema", () => {
      expect(validateResultAgainst(jsonSchemaOutputSchema(true), "anything_goes", '```json\n{ "outcome": { "note": "done</note>" } }\n```')).toEqual({
        ok: true,
        value: { note: "done" },
      });
      const refused = validateResultAgainst(jsonSchemaOutputSchema(false), "nothing_goes", { note: "done" });
      expect(refused).toEqual({ ok: false, error: 'The result did not match the required schema for "nothing_goes":\n- (root): boolean schema is false' });
    });
  });

  describe("declaring a dialect older than the one EO writes", () => {
    /**
     * Draft-07, and written so the dialect is load-bearing rather than
     * decorative: `items` as an array is a tuple here and is not a
     * tuple in 2020-12, and `definitions` is where a draft-07 document
     * keeps what it refers to. Read with the wrong validator this
     * document does not merely behave differently — ajv 2020-12 cannot
     * resolve its meta-schema and refuses it at load.
     */
    const draft07: JsonSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { pair: { items: [{ type: "string" }, { type: "number" }] }, name: { $ref: "#/definitions/text" } },
      required: ["name"],
      definitions: { text: { type: "string", minLength: 2 } },
    };

    it("loads and validates, where before it threw at load", () => {
      const schema = jsonSchemaOutputSchema(draft07);

      expect(schema.parse({ name: "ok", pair: ["a", 1] }).ok).toBe(true);
      expect(schema.parse({ name: "x" }).ok).toBe(false);
      expect(schema.parse({}).ok).toBe(false);
      // Tuple positions, which only the draft-07 reading enforces.
      expect(schema.parse({ name: "ok", pair: [1, "a"] }).ok).toBe(false);
    });

    it("validates a result through the same path as every other schema", () => {
      const raw = '```json\n{ "outcome": { "name": "Filed it.</name>" } }\n```';
      expect(validateResultAgainst(jsonSchemaOutputSchema(draft07), "file_note", raw)).toEqual({ ok: true, value: { name: "Filed it." } });

      const bad = validateResultAgainst(jsonSchemaOutputSchema(draft07), "file_note", { name: "x" });
      expect(bad).toEqual({ ok: false, error: 'The result did not match the required schema for "file_note":\n- name: must NOT have fewer than 2 characters' });
    });

    it("reaches the provider in a wrapper written in its own dialect, which is the only way the wrapper compiles at all", () => {
      const provided = providerSchemaFor(jsonSchemaOutputSchema(draft07));

      // Not EO's dialect. A 2020-12 root would be meta-validated against
      // 2020-12, where `items: [...]` is not a schema and the whole
      // compound document is refused before a result is ever looked at.
      expect(provided["$schema"]).toBe("http://json-schema.org/draft-07/schema#");

      const wrapper = jsonSchemaOutputSchema(provided);
      expect(wrapper.parse({ outcome: { name: "ok", pair: ["a", 1] } }).ok).toBe(true);
      expect(wrapper.parse({ outcome: { name: "x" } }).ok).toBe(false);
      expect(wrapper.parse({ outcome: { name: "ok", pair: [1, "a"] } }).ok).toBe(false);
      // And the clarification branch still reads, in that dialect too.
      expect(wrapper.parse({ outcome: { status: "clarification_required", questions: [{ id: "q", question: "Which?", why: "Ambiguous." }] } }).ok).toBe(true);
    });

    it("reads 2019-09 as well, since the edition is the document's to declare", () => {
      const draft2019: JsonSchema = {
        $schema: "https://json-schema.org/draft/2019-09/schema",
        type: "object",
        properties: { count: { $ref: "#/$defs/positive" } },
        required: ["count"],
        $defs: { positive: { type: "integer", minimum: 1 } },
      };
      const schema = jsonSchemaOutputSchema(draft2019);

      expect(schema.parse({ count: 2 }).ok).toBe(true);
      expect(schema.parse({ count: 0 }).ok).toBe(false);
      expect(providerSchemaFor(schema)["$schema"]).toBe("https://json-schema.org/draft/2019-09/schema");
    });

    it("reads a dialect written with or without the trailing fragment as the same dialect", () => {
      // 2020-12 is conventionally written bare and draft-07 with a `#`;
      // either spelling of either names the same edition, and both load.
      expect(jsonSchemaOutputSchema({ $schema: "http://json-schema.org/draft-07/schema", type: "string", minLength: 2 }).parse("x").ok).toBe(false);
      expect(jsonSchemaOutputSchema({ $schema: "https://json-schema.org/draft/2020-12/schema#", type: "string", minLength: 2 }).parse("xy").ok).toBe(true);
    });

    it("echoes the author's own spelling of the dialect rather than a normalised one", () => {
      // What the document said is what the wrapper says. Normalising is
      // for matching the edition, not for rewriting the document.
      expect(dialectOf({ $schema: "http://json-schema.org/draft-07/schema#" })).toBe("http://json-schema.org/draft-07/schema#");
      expect(providerSchemaFor(jsonSchemaOutputSchema(draft07))["$schema"]).toBe("http://json-schema.org/draft-07/schema#");
    });

    it("takes a document that declares nothing as the dialect EO writes", () => {
      expect(dialectOf({ type: "string" })).toBe(JSON_SCHEMA_DIALECT);
      expect(dialectOf(true)).toBe(JSON_SCHEMA_DIALECT);
    });

    it("refuses an edition it cannot read by name, rather than as an ajv internal about a missing reference", () => {
      const draft04 = { $schema: "http://json-schema.org/draft-04/schema#", type: "object" };

      expect(() => jsonSchemaOutputSchema(draft04)).toThrow(
        'This JSON Schema document declares the dialect "http://json-schema.org/draft-04/schema#", which EO cannot read. Supported: https://json-schema.org/draft/2020-12/schema, https://json-schema.org/draft/2019-09/schema, http://json-schema.org/draft-07/schema.',
      );
    });
  });

  it("is refused at load when it does not compile, not on every result after", () => {
    expect(() => jsonSchemaOutputSchema({ type: "object", required: "note" })).toThrow();
  });

  it("never claims its value may be absent; only zod's emitter has that to say, and only for a root that may be missing", () => {
    expect(jsonSchemaOutputSchema(document).mayBeAbsent).toBeUndefined();
    expect(zodOutputSchema(ImplementOutputSchema).mayBeAbsent).toBe(false);
    // A root `.optional()` is what zod's emitter leaves out of `required`.
    expect(zodOutputSchema(z.object({ body: z.string() }).optional()).mayBeAbsent).toBe(true);
    // A root preprocess was, until zod 4.6 learnt to type its input side.
    expect(zodOutputSchema(z.preprocess((value) => value, z.object({ body: z.string() }))).mayBeAbsent).toBe(false);
  });

  it("hands a provider an `anyOf` of bare types where zod 4.6 compacts it into a `type` array (EO-671)", () => {
    const schema = zodOutputSchema(
      z.object({
        note: z.string().nullable(),
        default: z.union([z.string(), z.number(), z.boolean()]),
        settings: z.record(z.string(), z.union([z.string(), z.number()])),
        tag: z.literal("x").default("x"),
      }),
    ).toJsonSchema() as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;

    expect(properties["note"]).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(properties["default"]).toEqual({ anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] });
    expect(properties["settings"]?.["additionalProperties"]).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    // Data is left as written: a default is a value, not a schema.
    expect(properties["tag"]?.["default"]).toBe("x");
    expect(JSON.stringify(schema)).not.toMatch(/"type":\[/);
  });
});
