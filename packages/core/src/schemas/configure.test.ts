import { describe, expect, it } from "vitest";
import { summarizeInstructions } from "../domain.js";
import { ConfigureOutputSchema } from "./configure.js";
import { providerSchemaFor, resultSchemaFor, validateResultAgainst, zodOutputSchema } from "./index.js";
import { developerRegistry } from "../registry/developer.js";

// The registry as EO ships it (KAN-124): every lookup here is asked about
// the developer pack, which is the one whose schemas these tests are about.
const registry = developerRegistry();

/**
 * The shape a pipeline draft is answered in, as a result is held to it.
 *
 * Asked for directly rather than through the registry by action name:
 * `configure` was the Architecture panel's action and went with it
 * (EO-526). The shape is what the assistant's drafts are built from.
 */
const CONFIGURE = zodOutputSchema(ConfigureOutputSchema);

/** A minimal valid graph: one agent step, one terminal, one edge between them. */
function graph() {
  return {
    rationale: "A QA gate before review.",
    entryStepId: "implement",
    steps: [
      { id: "implement", position: 0, name: "Implementer", type: "agent" as const, ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false },
      { id: "done", position: 1, name: "Done", type: "user" as const, ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
    ],
    routes: [
      { fromStepId: "implement", resultKey: "done", label: "Done", tone: "success" as const, target: "done", position: 0 },
    ],
  };
}

/** The draft's own object inside the JSON Schema handed to the provider, wherever `z.toJSONSchema` inlined it. */
function draftSchemaIn(schema: unknown): { properties: Record<string, unknown>; required: string[] } {
  const found = find(schema);
  if (!found) throw new Error("no draft object in the generated schema");
  return found;

  function find(node: unknown): { properties: Record<string, unknown>; required: string[] } | undefined {
    if (Array.isArray(node)) return node.map(find).find((entry) => entry !== undefined);
    if (typeof node !== "object" || node === null) return undefined;
    const entry = node as { properties?: Record<string, unknown>; required?: string[] };
    if (entry.properties && "entryStepId" in entry.properties) return { properties: entry.properties, required: entry.required ?? [] };
    return Object.values(node).map(find).find((candidate) => candidate !== undefined);
  }
}

describe("ConfigureOutputSchema", () => {
  it("accepts an ordinary conversational turn that proposes nothing", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "What should QA check?" });
    expect(parsed.success).toBe(true);
    // The three collections default rather than being required: a turn
    // that only talks is the normal case, not a run that did nothing.
    expect(parsed.success && parsed.data.questions).toEqual([]);
    expect(parsed.success && parsed.data.agents).toEqual([]);
    expect(parsed.success && parsed.data.runtimes).toEqual([]);
  });

  it("accepts a draft", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here it is.", draft: graph() });
    expect(parsed.success).toBe(true);
  });

  /**
   * What a draft says it removes (EO-209).
   *
   * Defaulted rather than required, because the ordinary draft removes
   * nothing and a field a model must restate every turn is a field it can
   * get wrong. Empty is therefore the answer to "what does this delete?"
   * and not the absence of one — which is what lets the engine treat an
   * undeclared omission as a mistake rather than as a silence it has to
   * interpret.
   */
  it("defaults `removes` to empty, and carries the ids a draft means to drop", () => {
    const quiet = ConfigureOutputSchema.safeParse({ message: "Here it is.", draft: graph() });
    expect(quiet.success && quiet.data.draft?.removes).toEqual([]);

    const declared = ConfigureOutputSchema.safeParse({
      message: "Dropping the review step.",
      draft: { ...graph(), removes: ["review"] },
    });
    expect(declared.success && declared.data.draft?.removes).toEqual(["review"]);
  });

  /**
   * The ordinary draft adds no ceremony.
   *
   * `io: "input"` makes a defaulted field optional in what the model is
   * asked to produce, so a turn that removes nothing simply does not
   * mention `removes` — and the engine reads the empty default as "this
   * draft deletes nothing", which is the truth.
   */
  it("offers `removes` to the model without requiring it", () => {
    const draft = draftSchemaIn(providerSchemaFor(CONFIGURE));
    expect(Object.keys(draft.properties)).toContain("removes");
    expect(draft.required).not.toContain("removes");
  });

  // The refinement that matters most: a pipeline is published whole and
  // dispatches real work, so a graph resting on questions nobody answered
  // is a guess with a Publish button on it.
  it("refuses a turn that both asks and proposes", () => {
    const parsed = ConfigureOutputSchema.safeParse({
      message: "Here it is.",
      questions: [{ question: "Who owns QA?", why: "It decides the role.", options: ["A tester", "The implementer"] }],
      draft: graph(),
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses agents or runtimes with no draft to staff", () => {
    const parsed = ConfigureOutputSchema.safeParse({
      message: "You'll need a tester.",
      agents: [{ name: "Vega", role: "tester", provider: "codex", instructions: "Run the suite." }],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a role that is not a slug", () => {
    const parsed = ConfigureOutputSchema.safeParse({
      message: "Here it is.",
      draft: graph(),
      agents: [{ name: "Vega", role: "QA Tester", provider: "codex", instructions: "Run the suite." }],
    });
    expect(parsed.success).toBe(false);
  });

  // A runtime EO does not ship can never be installed, so an architect
  // able to name one would spend turns offering something impossible.
  it("refuses a runtime outside the shipped pair", () => {
    const parsed = ConfigureOutputSchema.safeParse({
      message: "Here it is.",
      draft: graph(),
      runtimes: [{ id: "gemini", why: "It is what I know." }],
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a draft with no steps", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), steps: [] } });
    expect(parsed.success).toBe(false);
  });

  // pipelineId is a constant of the whole draft the caller already knows,
  // and route ids are regenerated on save — so neither is asked for.
  it("does not ask for pipelineId on a step or an id on a route", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph() });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.draft?.steps[0]).not.toHaveProperty("pipelineId");
    expect(parsed.success && parsed.data.draft?.routes[0]).not.toHaveProperty("id");
  });
});

describe("the configure shape, held to as a result", () => {
  it("is no longer an action the registry dispatches (EO-526)", () => {
    expect(resultSchemaFor(registry, "configure")).toBeUndefined();
  });

  it("validates a real result through the shared path", () => {
    const result = validateResultAgainst(CONFIGURE, "configure", { message: "Here it is.", draft: graph() });
    expect(result.ok).toBe(true);
  });

  it("reports why an invalid one failed, so the re-prompt can say so", () => {
    const result = validateResultAgainst(CONFIGURE, "configure", { draft: graph() });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("configure");
  });
});

describe("summarizeInstructions", () => {
  it("takes the first real sentence", () => {
    expect(summarizeInstructions("Implements scoped changes.\nMore detail here.")).toBe("Implements scoped changes.");
  });

  // Both are addressed to EO rather than to whoever is reading, which is
  // the whole reason this is not just `split("\n")[0]`.
  it("skips headings, version markers and blank lines", () => {
    expect(summarizeInstructions("<!-- v4 -->\n\n# Reviewer\n\nReviews code and ensures quality.")).toBe(
      "Reviews code and ensures quality.",
    );
  });

  it("is null when there is nothing to say", () => {
    expect(summarizeInstructions("")).toBeNull();
    expect(summarizeInstructions("# Only a heading")).toBeNull();
  });
});

/** `qa` defines `alignment`, as an agent writes it in a reply (EO-426). */
const alignment = {
  role: "qa",
  action: "alignment",
  description: "Check the work against what was asked for.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
  ],
};

describe("the action definitions a draft carries (EO-426)", () => {
  it("accepts a definition beside a draft, and fills in what the agent left out", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph(), actions: [{ role: "qa", action: "alignment", results: [{ key: "aligned" }] }] });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.actions).toEqual([{ role: "qa", action: "alignment", description: "", results: [{ key: "aligned", label: "", meaning: "" }], fields: [] }]);
  });

  it("proposes none on an ordinary turn", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph() });
    expect(parsed.success && parsed.data.actions).toEqual([]);
  });

  it("refuses a reply that asks questions and also carries actions", () => {
    const question = { id: "qa_owner", question: "Which role owns QA?", why: "It decides who the step dispatches.", options: ["qa", "reviewer"] };
    // A reply that only asks is fine, so what is refused below is the pairing.
    expect(ConfigureOutputSchema.safeParse({ message: "One thing first.", questions: [question] }).success).toBe(true);
    expect(ConfigureOutputSchema.safeParse({ message: "One thing first.", questions: [question], actions: [alignment] }).success).toBe(false);
  });

  it("refuses actions with no draft to publish them with", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here is a definition.", actions: [alignment] });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("actions are proposed in support of a draft");
  });

  it("sends a definition the save rules refuse back with the save's own reasons", () => {
    const validated = validateResultAgainst(CONFIGURE, "configure", {
      message: "Here.",
      draft: graph(),
      actions: [{ role: "qa", action: "respond", results: [{ key: "Gaps Found" }, { key: "aligned" }, { key: "aligned" }], fields: [{ name: "summary", type: "string" }] }],
    });

    expect(validated.ok).toBe(false);
    const said = validated.ok ? "" : validated.error;
    expect(said).toContain('The action "respond" cannot be defined');
    expect(said).toContain('The result key "Gaps Found" must be lowercase letters, digits and underscores only.');
    expect(said).toContain('The result key "aligned" is declared more than once');
    expect(said).toContain('A field may not be named "summary"');
  });

  it("refuses a definition with no results, and one whose field is listed twice", () => {
    const none = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph(), actions: [{ role: "qa", action: "alignment", results: [] }] });
    expect(!none.success && none.error.issues.map((issue) => issue.message).join(" ")).toContain("An action needs at least one result");

    const twice = ConfigureOutputSchema.safeParse({
      message: "Here.",
      draft: graph(),
      actions: [{ ...alignment, fields: [{ name: "gaps", type: "string_list" }, { name: "gaps", type: "string" }] }],
    });
    expect(!twice.success && twice.error.issues.map((issue) => issue.message).join(" ")).toContain('The field "gaps" is listed more than once');
  });

  it("refuses the same role and action proposed twice in one draft", () => {
    const parsed = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph(), actions: [alignment, { ...alignment, description: "Again." }] });
    expect(!parsed.success && parsed.error.issues.map((issue) => issue.message).join(" ")).toContain(`The qa role's "alignment" action is proposed more than once`);
  });
});
