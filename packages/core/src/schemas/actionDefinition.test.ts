import { describe, expect, it } from "vitest";
import { developerRegistry } from "../registry/developer.js";
import { packActionInForce, roleShipsAction, type DefinedAction, type Registry } from "../registry/index.js";
import {
  actionAnswerDocument,
  actionAnswerSummary,
  actionDefinitionOutputSchema,
  actionShapeFromSchema,
  fieldsFromList,
  keptDefinitionsNote,
  proposedActionChange,
  proposedActionDraft,
  readActionDefinitionDraft,
  renderActionDefinitionTask,
  UNDISPATCHED_ACTIONS,
  type ActionDefinition,
} from "./actionDefinition.js";
import { actionDefinitionProviderSchema, outputSchemaFor, resultSchemaFor, validateActionResult } from "./index.js";

const ALIGNMENT = {
  role: "qa",
  action: "alignment",
  description: "Check the work against what was asked for.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
  ],
  fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" } } } },
};

function definition(draft: Parameters<typeof readActionDefinitionDraft>[0]): ActionDefinition {
  const read = readActionDefinitionDraft(draft);
  if (!read.ok) throw new Error(read.problems.join(" "));
  return { id: `${read.role}:${read.action}`, role: read.role, action: read.action, description: read.description, results: read.results, fields: read.fields, createdAt: 1, updatedAt: 1 };
}

/** The developer pack's registry, plus these definitions — what `registryForProject` hands the supervisor. */
function registryWith(...definitions: ActionDefinition[]): Registry {
  const byRole = new Map<string, Map<string, DefinedAction>>();
  for (const entry of definitions) {
    const ofRole = byRole.get(entry.role) ?? new Map<string, DefinedAction>();
    ofRole.set(entry.action, { definition: entry, schema: actionDefinitionOutputSchema(entry) });
    byRole.set(entry.role, ofRole);
  }
  return { ...developerRegistry(), actionDefinitions: byRole };
}

/** The action's own branch of the provider wrapper: the one that is not the clarification. */
function answerBranch(provider: Record<string, unknown> | undefined): Record<string, unknown> {
  const outcome = (provider?.["properties"] as { outcome: { anyOf: Record<string, unknown>[] } }).outcome;
  return outcome.anyOf[1]!;
}

describe("what a save is held to", () => {
  it("takes a well-formed draft, and fills in a label nobody wrote from the key", () => {
    const read = readActionDefinitionDraft({ role: "qa", action: "alignment", results: [{ key: "gaps_found" }] });

    expect(read).toEqual({ ok: true, role: "qa", action: "alignment", description: "", results: [{ key: "gaps_found", label: "Gaps found", meaning: "" }], fields: {} });
  });

  it("refuses an action or a result key that is not lowercase letters, digits and underscores", () => {
    const read = readActionDefinitionDraft({ ...ALIGNMENT, action: "Check-Alignment", results: [{ key: "Gaps Found" }] });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problems.join("\n")).toContain('"Check-Alignment"');
    expect(!read.ok && read.problems.join("\n")).toContain('"Gaps Found"');
  });

  it("refuses a definition with no results", () => {
    const read = readActionDefinitionDraft({ ...ALIGNMENT, results: [] });

    expect(read).toEqual({ ok: false, problems: [expect.stringContaining("at least one result")] });
  });

  it("refuses duplicate result keys, naming the key", () => {
    const read = readActionDefinitionDraft({ ...ALIGNMENT, results: [{ key: "aligned" }, { key: "aligned" }] });

    expect(read).toEqual({ ok: false, problems: [expect.stringContaining('"aligned" is declared more than once')] });
  });

  it.each(["result", "summary"])("refuses a field named %s, whether it is a property or only required", (name) => {
    const asProperty = readActionDefinitionDraft({ ...ALIGNMENT, fields: { properties: { [name]: { type: "string" } } } });
    const asRequired = readActionDefinitionDraft({ ...ALIGNMENT, fields: { required: [name] } });

    expect(asProperty).toEqual({ ok: false, problems: [expect.stringContaining(`may not be named "${name}"`)] });
    expect(asRequired).toEqual({ ok: false, problems: [expect.stringContaining(`may not be named "${name}"`)] });
  });

  it("refuses fields ajv cannot compile, with ajv's own reason", () => {
    const read = readActionDefinitionDraft({ ...ALIGNMENT, fields: { type: "object", properties: { gaps: { type: "aray" } } } });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problems.join("\n")).toContain("not a JSON Schema EO can read");
  });

  it("refuses fields that describe something other than an object", () => {
    const read = readActionDefinitionDraft({ ...ALIGNMENT, fields: { type: "string" } });

    expect(read).toEqual({ ok: false, problems: [expect.stringContaining("must describe an object")] });
  });

  it("reports every problem at once", () => {
    const read = readActionDefinitionDraft({ role: " ", action: "ok", results: [], fields: { properties: { result: {} } } });

    expect(!read.ok && read.problems).toHaveLength(3);
  });
});

describe("the generated schema", () => {
  it("is result as an enum of the declared keys, a required summary, then the fields", () => {
    const document = actionAnswerDocument(definition({ ...ALIGNMENT, fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" } } }, required: ["gaps"], additionalProperties: false } }));

    expect(document).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        result: { type: "string", enum: ["aligned", "gaps_found"] },
        summary: { type: "string" },
        gaps: { type: "array", items: { type: "string" } },
      },
      required: ["result", "summary", "gaps"],
      additionalProperties: false,
    });
    expect(Object.keys(document["properties"] as object)).toEqual(["result", "summary", "gaps"]);
  });

  it("accepts an answer in a declared key and refuses one outside the enum or without a summary", () => {
    const schema = actionDefinitionOutputSchema(definition(ALIGNMENT));

    expect(schema.parse({ result: "gaps_found", summary: "Two criteria are unmet.", gaps: ["a", "b"] }).ok).toBe(true);
    expect(schema.parse({ result: "fine", summary: "Looks good." }).ok).toBe(false);
    expect(schema.parse({ result: "aligned" }).ok).toBe(false);
    expect(schema.parse({ result: "aligned", summary: "Yes.", gaps: "none" }).ok).toBe(false);
  });
});

describe("resolution: the dispatched role's own definition, then the lookup there always was", () => {
  const qa = definition(ALIGNMENT);

  it("hands a provider a schema whose result is exactly the declared keys and which requires summary", () => {
    const branch = answerBranch(outputSchemaFor(registryWith(qa), "alignment", undefined, "qa"));

    expect((branch["properties"] as { result: { enum: string[] } }).result.enum).toEqual(["aligned", "gaps_found"]);
    expect(branch["required"]).toContain("summary");
  });

  it("draws, from the definition alone, the very document a dispatch hands the provider", () => {
    // What the agent screen shows (EO-427). Built without compiling, and
    // equal to the dispatch's own answer key for key and in order.
    expect(JSON.stringify(actionDefinitionProviderSchema(qa))).toEqual(JSON.stringify(outputSchemaFor(registryWith(qa), "alignment", undefined, "qa")));
  });

  it("gives two roles defining one action name each their own schema", () => {
    const editor = definition({ role: "editor", action: "alignment", results: [{ key: "on_brief" }, { key: "off_brief" }] });
    const registry = registryWith(qa, editor);

    expect((answerBranch(outputSchemaFor(registry, "alignment", undefined, "qa"))["properties"] as { result: { enum: string[] } }).result.enum).toEqual(["aligned", "gaps_found"]);
    expect((answerBranch(outputSchemaFor(registry, "alignment", undefined, "editor"))["properties"] as { result: { enum: string[] } }).result.enum).toEqual(["on_brief", "off_brief"]);
  });

  it("never applies a definition to another role, or to a caller with no role", () => {
    const registry = registryWith(qa);

    expect(resultSchemaFor(registry, "alignment", undefined, "editor")).toBeUndefined();
    expect(resultSchemaFor(registry, "alignment")).toBeUndefined();
    expect(outputSchemaFor(registry, "alignment", undefined, null)).toBeUndefined();
    // And an answer from such a role is passed through unvalidated, as a
    // custom action with no schema always was.
    expect(validateActionResult(registry, "alignment", { result: "anything" }, undefined, "editor")).toEqual({ ok: true, value: { result: "anything" } });
  });

  it("still holds a custom role with no definition of its own to the pack's implement shape", () => {
    const registry = registryWith(qa);

    expect(JSON.stringify(outputSchemaFor(registry, "implement", undefined, "qa"))).toEqual(JSON.stringify(outputSchemaFor(developerRegistry(), "implement")));
    expect(validateActionResult(registry, "implement", { result: "aligned", summary: "Done." }, undefined, "qa").ok).toBe(false);
  });

  it("lets a role's own definition of a pack's action name win for that role alone", () => {
    const review = definition({ role: "qa", action: "review", results: [{ key: "passed" }, { key: "failed" }] });
    const registry = registryWith(review);

    expect(validateActionResult(registry, "review", { result: "passed", summary: "All good." }, undefined, "qa").ok).toBe(true);
    expect(validateActionResult(registry, "review", { result: "passed", summary: "All good." }, undefined, "reviewer").ok).toBe(false);
  });

  it("re-prompts an answer outside the enum with the issue, naming the action", () => {
    const refused = validateActionResult(registryWith(qa), "alignment", { result: "fine", summary: "Looks good." }, undefined, "qa");

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('"alignment"');
    expect(!refused.ok && refused.error).toContain("result");
  });
});

describe("a carried output schema as a definition", () => {
  it("takes a top-level string result enum as the keys and the remaining properties as the fields", () => {
    const shape = actionShapeFromSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { result: { type: "string", enum: ["urgent", "routine"] }, summary: { type: "string" }, severity: { type: "string" } },
      required: ["result", "summary", "severity"],
    });

    expect(shape.results).toEqual([
      { key: "urgent", label: "Urgent", meaning: "" },
      { key: "routine", label: "Routine", meaning: "" },
    ]);
    expect(shape.fields).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { severity: { type: "string" } },
      required: ["severity"],
    });
  });

  it("gives a schema with no result enum the single key done", () => {
    const shape = actionShapeFromSchema({ type: "object", properties: { severity: { type: "string" }, result: { type: "string" } }, required: ["severity"] });

    expect(shape.results).toEqual([{ key: "done", label: "Done", meaning: "" }]);
    expect(shape.fields).toEqual({ type: "object", properties: { severity: { type: "string" } }, required: ["severity"] });
  });

  it.each([true, false, { type: "string" }])("gives a document that describes no object (%j) done and no fields", (document) => {
    expect(actionShapeFromSchema(document)).toEqual({ results: [{ key: "done", label: "Done", meaning: "" }], fields: {} });
  });

  it("round-trips through the generated schema: keys and fields come back as they went", () => {
    const original = definition(ALIGNMENT);
    const shape = actionShapeFromSchema(actionAnswerDocument(original));

    expect(shape.results.map((result) => result.key)).toEqual(["aligned", "gaps_found"]);
    expect(actionAnswerDocument({ results: shape.results, fields: shape.fields })).toEqual(actionAnswerDocument(original));
  });

  it("always maps to something the save accepts or refuses for its keys alone", () => {
    const shape = actionShapeFromSchema({ type: "object", properties: { result: { enum: ["Needs-Work"] } } });

    const read = readActionDefinitionDraft({ role: "qa", action: "check", ...shape });
    expect(read).toEqual({ ok: false, problems: [expect.stringContaining('"Needs-Work"')] });
  });
});

describe("what the task section says", () => {
  it("lists the description and each result key with its meaning", () => {
    const text = renderActionDefinitionTask(definition(ALIGNMENT));

    expect(text).toContain("Check the work against what was asked for.");
    expect(text).toContain("- `aligned` — Everything asked for is there.");
    expect(text).toContain("- `gaps_found` — Something asked for is missing.");
    expect(text).toContain("`summary`");
  });

  it("falls back to the label for a result nobody gave a meaning", () => {
    expect(renderActionDefinitionTask(definition({ role: "qa", action: "check", results: [{ key: "gaps_found" }] }))).toContain("- `gaps_found` — Gaps found");
  });
});

describe("the answer's summary", () => {
  it("is the string, and nothing for an answer without one worth posting", () => {
    expect(actionAnswerSummary({ result: "aligned", summary: "All there." })).toBe("All there.");
    expect(actionAnswerSummary({ result: "aligned", summary: "  " })).toBeNull();
    expect(actionAnswerSummary({ result: "aligned" })).toBeNull();
    expect(actionAnswerSummary("All there.")).toBeNull();
  });
});

/**
 * Whose action a name is (EO-422): the pack's, unless the dispatched
 * role defined it for itself.
 */
describe("whether a pack's meaning of an action is in force", () => {
  const review = definition({ role: "qa", action: "review", results: [{ key: "passed" }, { key: "failed" }] });
  const registry = registryWith(review);

  it("is not, for the role that defined the action", () => {
    expect(packActionInForce(registry, "qa", "review")).toBe(false);
  });

  it("is, for every other role on that action name — the shipped one and a custom one with no definition alike", () => {
    expect(packActionInForce(registry, "reviewer", "review")).toBe(true);
    expect(packActionInForce(registry, "auditor", "review")).toBe(true);
  });

  it("is, for the defining role's other actions and for a caller with no role", () => {
    expect(packActionInForce(registry, "qa", "implement")).toBe(true);
    expect(packActionInForce(registry, null, "review")).toBe(true);
    expect(packActionInForce(registry, undefined, "review")).toBe(true);
  });

  it("is, in a registry with no definitions at all", () => {
    expect(packActionInForce(developerRegistry(), "qa", "review")).toBe(true);
  });
});

describe("the two actions-not-shapes a save refuses", () => {
  const RESULTS = [{ key: "done" }];
  const ships = { shipsAction: (role: string, action: string) => roleShipsAction(developerRegistry(), role, action) };

  it.each([...UNDISPATCHED_ACTIONS])("refuses %s, which no pipeline step dispatches, and names it", (action) => {
    const read = readActionDefinitionDraft({ role: "qa", action, results: RESULTS });

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.problems.join(" ")).toContain(`The action "${action}" cannot be defined`);
  });

  it("lists exactly the five", () => {
    // `discuss` and `configure` went with Discussions and the
    // Architecture panel (EO-526).
    expect([...UNDISPATCHED_ACTIONS].sort()).toEqual(["assist", "clarify", "interpret", "respond", "scenario"]);
  });

  it.each([
    ["reviewer", "review"],
    ["implementer", "implement"],
    ["system", "refine"],
  ])("refuses the %s role redefining its own shipped %s, naming the role and the action", (role, action) => {
    const read = readActionDefinitionDraft({ role, action, results: RESULTS }, ships);

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.problems.join(" ")).toContain(`The ${role} role's "${action}" action cannot be redefined`);
  });

  it("asks about the pair: a custom role may define review, and so may the implementer", () => {
    expect(readActionDefinitionDraft({ role: "qa", action: "review", results: RESULTS }, ships).ok).toBe(true);
    expect(readActionDefinitionDraft({ role: "implementer", action: "review", results: RESULTS }, ships).ok).toBe(true);
  });

  it("says which roles ship which actions", () => {
    const registry = developerRegistry();
    expect(roleShipsAction(registry, "reviewer", "review")).toBe(true);
    expect(roleShipsAction(registry, "reviewer", "implement")).toBe(false);
    expect(roleShipsAction(registry, "qa", "review")).toBe(false);
  });
});

describe("what an import says about the definitions it kept", () => {
  it("says nothing where nothing was kept", () => {
    expect(keptDefinitionsNote([])).toBe("");
  });

  it("names the role and the action of each one", () => {
    expect(keptDefinitionsNote([{ role: "qa", action: "alignment" }])).toBe(
      `This installation already defines qa's "alignment" differently; its own definition was kept and the file's was not applied.`,
    );

    const several = keptDefinitionsNote([
      { role: "qa", action: "alignment" },
      { role: "writer", action: "outline" },
    ]);
    expect(several).toContain(`qa's "alignment"`);
    expect(several).toContain(`writer's "outline"`);
  });
});

describe("a definition proposed in an answer (EO-426)", () => {
  it("turns a field list into the JSON Schema a definition holds", () => {
    expect(fieldsFromList([])).toEqual({});
    expect(
      fieldsFromList([
        { name: "gaps", type: "string_list", required: true, description: "Each thing that is missing." },
        { name: "score", type: "integer", required: false, description: "" },
      ]),
    ).toEqual({
      type: "object",
      properties: { gaps: { type: "array", items: { type: "string" }, description: "Each thing that is missing." }, score: { type: "integer" } },
      required: ["gaps"],
    });
  });

  it("becomes a draft the save accepts, with a schema that holds an answer to its fields", () => {
    const draft = proposedActionDraft({
      role: "qa",
      action: "alignment",
      description: "",
      results: [{ key: "aligned", label: "", meaning: "" }],
      fields: [{ name: "gaps", type: "string_list", required: true, description: "" }],
    });
    const read = readActionDefinitionDraft(draft);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const schema = actionDefinitionOutputSchema(read);
    expect(schema.parse({ result: "aligned", summary: "All there.", gaps: [] }).ok).toBe(true);
    expect(schema.parse({ result: "aligned", summary: "All there." }).ok).toBe(false);
  });

  it("says a definition is new, the same, or changed with the keys it adds and removes", () => {
    const saved = { description: "Check it.", results: [{ key: "aligned", label: "Aligned", meaning: "" }, { key: "gaps_found", label: "Gaps found", meaning: "" }], fields: {} };

    expect(proposedActionChange(undefined, saved)).toEqual({ kind: "new" });
    expect(proposedActionChange(saved, saved)).toEqual({ kind: "same" });
    expect(
      proposedActionChange(saved, { ...saved, results: [{ key: "aligned", label: "Aligned", meaning: "" }, { key: "blocked", label: "Blocked", meaning: "" }] }),
    ).toEqual({ kind: "changed", added: ["blocked"], removed: ["gaps_found"] });
    // A reworded description is a change that touches no key.
    expect(proposedActionChange(saved, { ...saved, description: "Check it twice." })).toEqual({ kind: "changed", added: [], removed: [] });
  });
});
