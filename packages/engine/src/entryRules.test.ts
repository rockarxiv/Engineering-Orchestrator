import { describe, expect, it } from "vitest";
import { coreRegistry, developerRegistry, EMPTY_SPEC_SHAPE, entryRuleWords, SpecShapeSchema, type EntryRule } from "@eo/core";
import { entryRefusal, entryRuleProblems, unmetEntryRules, type EntryFacts } from "./entryRules.js";
import { validatePipeline } from "./pipelineValidation.js";

const kinds = developerRegistry().entryRuleKinds;

function facts(overrides: Partial<EntryFacts> = {}): EntryFacts {
  return { itemType: "developer:story", body: "Written down.", spec: { customer: "Acme" }, hasWorkspace: true, declaredFields: ["customer"], extensions: { jira: { key: "EO-1" } }, ...overrides };
}

const unmet = (rule: EntryRule, overrides: Partial<EntryFacts> = {}) => unmetEntryRules([rule], facts(overrides), kinds);

describe("what counts as missing", () => {
  it.each([[null], [undefined], [""], ["   \n"], [[]]])("%j is missing from a field", (value) => {
    expect(unmet({ kind: "field", field: "customer" }, { spec: { customer: value } })).toHaveLength(1);
  });

  it.each([[0], [false], ["x"], [["x"]], [{ a: 1 }]])("%j is present in a field", (value) => {
    expect(unmet({ kind: "field", field: "customer" }, { spec: { customer: value } })).toEqual([]);
  });

  it("is missing where the spec is absent, or the key is", () => {
    expect(unmet({ kind: "field", field: "customer" }, { spec: null })).toHaveLength(1);
    expect(unmet({ kind: "field", field: "customer" }, { spec: {} })).toHaveLength(1);
  });

  it("holds an item's body and a workspace to the same reading", () => {
    expect(unmet({ kind: "description" })).toEqual([]);
    expect(unmet({ kind: "description" }, { body: null })).toHaveLength(1);
    expect(unmet({ kind: "description" }, { body: "  " })).toHaveLength(1);
    expect(unmet({ kind: "workspace" })).toEqual([]);
    expect(unmet({ kind: "workspace" }, { hasWorkspace: false })).toHaveLength(1);
  });
});

describe("a kind a pack contributes", () => {
  it("reads where the pack said the value is", () => {
    expect(unmet({ kind: "jira_key" })).toEqual([]);
    expect(unmet({ kind: "jira_key" }, { extensions: {} })).toHaveLength(1);
    expect(unmet({ kind: "jira_key" }, { extensions: { jira: { key: null } } })).toHaveLength(1);
    expect(unmet({ kind: "jira_key" }, { extensions: { jira: "not a slot" } })).toHaveLength(1);
  });

  it("stays shut, naming the rule, when nothing installed can answer it", () => {
    expect(unmetEntryRules([{ kind: "jira_key" }], facts(), new Map())).toHaveLength(1);
    expect(entryRefusal("Delivery", [{ kind: "jira_key" }], facts(), new Map())).toBe('"Delivery" needs these before work can enter it: "jira_key".');
  });
});

describe("which items a rule applies to", () => {
  it("applies only to the types it lists", () => {
    const rule: EntryRule = { kind: "description", types: ["developer:bug"] };
    expect(unmet(rule, { body: null })).toEqual([]);
    expect(unmet(rule, { body: null, itemType: "developer:bug" })).toHaveLength(1);
  });

  it("fails a field rule on an item whose type has no such field, whatever its spec says", () => {
    expect(unmet({ kind: "field", field: "customer" }, { declaredFields: [] })).toHaveLength(1);
  });

  it("is spared by `types` where that type has no such field", () => {
    expect(unmet({ kind: "field", field: "customer", types: ["local:case"] }, { declaredFields: [] })).toEqual([]);
  });
});

describe("the sentence", () => {
  it("names everything missing at once, in the order the pipeline lists them", () => {
    const rules: EntryRule[] = [{ kind: "description" }, { kind: "field", field: "customer" }];
    expect(entryRefusal("Delivery", rules, facts({ body: "", spec: {} }), kinds)).toBe('"Delivery" needs these before work can enter it: a description, a Customer.');
  });

  it("uses a rule's own words where it has them, and an article that fits", () => {
    const rules: EntryRule[] = [{ kind: "workspace", message: "somewhere to work" }, { kind: "field", field: "email_address" }, { kind: "jira_key" }];
    expect(entryRefusal("Delivery", rules, facts({ hasWorkspace: false, spec: {}, extensions: {} }), kinds)).toBe(
      '"Delivery" needs these before work can enter it: somewhere to work, an Email address, a Jira key.',
    );
  });

  it("is null when nothing is missing, and with no rules at all", () => {
    expect(entryRefusal("Delivery", [{ kind: "description" }], facts(), kinds)).toBeNull();
    expect(entryRefusal("Delivery", [], facts({ body: null }), kinds)).toBeNull();
  });

  it("treats a blank message as no message", () => {
    expect(entryRuleWords({ kind: "description", message: "  " }, kinds)).toBe("a description");
  });
});

describe("what a set of rules is refused for", () => {
  const types = new Map([
    ["developer:story", { specShape: SpecShapeSchema.parse({ type: "object", properties: { customer: { type: "string" } } }) }],
    ["developer:bug", { specShape: EMPTY_SPEC_SHAPE }],
  ]);

  it("passes what the project can answer", () => {
    expect(entryRuleProblems([{ kind: "description" }, { kind: "workspace" }, { kind: "jira_key" }, { kind: "field", field: "customer" }, { kind: "field", field: "customer", types: ["developer:story"] }], types, kinds)).toEqual([]);
  });

  it("refuses a field no applicable type declares, naming the rule", () => {
    const [problem] = entryRuleProblems([{ kind: "field", field: "customer", types: ["developer:bug"] }], types, kinds);
    expect(problem).toContain("a Customer");
    expect(problem).toContain('"customer"');
    expect(entryRuleProblems([{ kind: "field", field: "nobody_has_this" }], types, kinds)).toHaveLength(1);
  });

  it("refuses a type the project does not have, and a kind nothing contributed", () => {
    expect(entryRuleProblems([{ kind: "description", types: ["support:case"] }], types, kinds)[0]).toContain('"support:case"');
    expect(entryRuleProblems([{ kind: "telepathy" }], types, kinds)[0]).toContain('"telepathy"');
    expect(entryRuleProblems([{ kind: "jira_key" }], types, new Map())[0]).toContain('"jira_key"');
  });

  it("refuses a field rule that names no field", () => {
    expect(entryRuleProblems([{ kind: "field" }], types, kinds)).toHaveLength(1);
  });

  it("is what validatePipeline says, and only about rules it was handed", () => {
    const input = { steps: [], routes: [], entryStepId: null, staffedRoles: [], itemCountByStep: {}, existingSteps: [], registry: developerRegistry() };
    const step = { id: "a", pipelineId: "p", position: 0, name: "A", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false, offBoard: false, results: [], inputs: {}, timeoutMs: null, watch: null, workspaceMode: "isolated", workspaceId: null, ownerPersonId: null, ownerGroupId: null } as never;
    const judged = (entryRules?: EntryRule[]) => validatePipeline({ ...input, steps: [step], entryStepId: "a", ...(entryRules === undefined ? {} : { entryRules }) }).map((problem) => problem.message);

    expect(judged().join()).not.toContain("entry rule");
    expect(judged([{ kind: "telepathy" }]).join()).toContain('"telepathy"');
    expect(validatePipeline({ ...input, registry: coreRegistry(), steps: [step], entryStepId: "a", entryRules: [{ kind: "jira_key" }] }).some((problem) => problem.severity === "error" && problem.message.includes("jira_key"))).toBe(true);
  });
});
