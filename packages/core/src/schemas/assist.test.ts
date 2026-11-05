import { describe, expect, it } from "vitest";
import { AssistOutputSchema } from "./assist.js";
import { ConfigureOutputSchema, PROPOSED_MODULE_NEEDS_TESTS } from "./configure.js";
import { DiscussionOutputSchema } from "./discussion.js";
import { resultSchemaFor, validateActionResult, zodOutputSchema } from "./index.js";
import { developerRegistry } from "../registry/developer.js";

// The registry as EO ships it (KAN-124): every lookup here is asked about
// the developer pack, which is the one whose schemas these tests are about.
const registry = developerRegistry();

/** A minimal valid graph, the same shape `configure.test.ts` uses. */
function graph() {
  return {
    rationale: "A QA gate before review.",
    entryStepId: "implement",
    steps: [
      { id: "implement", position: 0, name: "Implementer", type: "agent" as const, ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false },
      { id: "done", position: 1, name: "Done", type: "user" as const, ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
    ],
    routes: [{ fromStepId: "implement", resultKey: "done", label: "Done", tone: "success" as const, target: "done", position: 0 }],
  };
}

const question = { question: "Which pipeline?", why: "It decides where the work lands.", options: ["Default", "Hotfix"] };

describe("AssistOutputSchema", () => {
  it("accepts an ordinary turn that only talks", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "That ticket is on Review, waiting for you." });

    expect(parsed.success).toBe(true);
    // Both collections default rather than being required: a turn that
    // answers a question and proposes nothing is the normal case, not a
    // run that did nothing.
    expect(parsed.success && parsed.data.questions).toEqual([]);
    expect(parsed.success && parsed.data.proposals).toEqual([]);
    expect(parsed.success && parsed.data.draft).toBeUndefined();
  });

  /**
   * The same draft, reached through the other room's schema (EO-209).
   *
   * `PipelineDraftSchema` is imported rather than restated for exactly
   * this: a rule that held in the Architecture panel and not in the
   * widget would be a draft judged by where it was raised, and an agent
   * would learn which room to raise a removal in.
   */
  it("reaches `removes` identically to the architect's room", () => {
    const quiet = AssistOutputSchema.safeParse({ message: "Here is the graph.", draft: graph() });
    expect(quiet.success && quiet.data.draft?.removes).toEqual([]);

    const declared = AssistOutputSchema.safeParse({ message: "Dropping it.", draft: { ...graph(), removes: ["done"] } });
    const throughConfigure = ConfigureOutputSchema.safeParse({ message: "Dropping it.", draft: { ...graph(), removes: ["done"] } });
    expect(declared.success && declared.data.draft).toEqual(throughConfigure.success ? throughConfigure.data.draft : null);
  });

  it("carries a pipeline draft and a decomposition — the parity the room exists for", () => {
    // The point of the third room: you are on a page, and what you want
    // to say is about it. Being able to propose only one of the two would
    // send somebody to another screen mid-sentence.
    expect(AssistOutputSchema.safeParse({ message: "Here is the graph.", draft: graph() }).success).toBe(true);
    expect(
      AssistOutputSchema.safeParse({
        message: "I would file that as a bug.",
        proposals: [
          {
            action: "new_bug",
            title: "Board scrolls to the top on every push",
            body: "Watching the board, any push resets the scroll position.",
            steps_to_reproduce: "Scroll the board right, wait for a run to finish.",
            expected: "The scroll position is kept.",
            actual: "It jumps back to the left.",
            environment: "macOS 15, EO 0.4.",
          },
        ],
      }).success,
    ).toBe(true);
  });

  /**
   * The refinement both other rooms carry, and it matters here for the
   * same reason: a card offered on top of questions nobody has answered
   * is a guess with a button on it.
   */
  it("refuses a turn that both asks and proposes", () => {
    expect(AssistOutputSchema.safeParse({ message: "Here it is.", questions: [question], draft: graph() }).success).toBe(false);
    expect(
      AssistOutputSchema.safeParse({
        message: "Here it is.",
        questions: [question],
        proposals: [{ action: "amend", item: "EO-42", why: "The title is wrong.", title: "A better title" }],
      }).success,
    ).toBe(false);
  });

  it("refuses a turn that says nothing", () => {
    // `message` is what the person reads. A turn with a card and no
    // sentence is a card with no reason attached to it.
    expect(AssistOutputSchema.safeParse({ draft: graph() }).success).toBe(false);
    expect(AssistOutputSchema.safeParse({ message: "" }).success).toBe(false);
  });

  /**
   * Composed rather than redeclared.
   *
   * Asserted by feeding each borrowed piece a value its own schema
   * refuses: if any of the three had been restated here, one of these
   * would pass and the drift would only show up as a card that cannot be
   * applied.
   */
  it("borrows the discussion's question, the discussion's proposals and the architect's draft", () => {
    // A question with one option is not a choice — `DiscussionQuestionSchema` demands two.
    expect(AssistOutputSchema.safeParse({ message: "Hm.", questions: [{ ...question, options: ["Default"] }] }).success).toBe(false);
    // A story with no acceptance criteria is refused by the discussion's union.
    expect(
      AssistOutputSchema.safeParse({
        message: "Hm.",
        proposals: [{ action: "new_story", title: "Do the thing", body: "…", acceptance_criteria: [] }],
      }).success,
    ).toBe(false);
    // A draft with no rationale is refused by `PipelineDraftSchema`.
    expect(AssistOutputSchema.safeParse({ message: "Hm.", draft: { ...graph(), rationale: "" } }).success).toBe(false);

    // And each of those values is refused by the room it came from, so
    // the assertions above are about composition rather than about
    // three coincidences.
    expect(DiscussionOutputSchema.safeParse({ message: "Hm.", questions: [{ ...question, options: ["Default"] }] }).success).toBe(false);
    expect(ConfigureOutputSchema.safeParse({ message: "Hm.", draft: { ...graph(), rationale: "" } }).success).toBe(false);
  });
});

describe("the `assist` action", () => {
  it("is registered, so a turn is generated against a schema rather than parsed out of prose", () => {
    expect(resultSchemaFor(registry, "assist")?.toJsonSchema()).toEqual(zodOutputSchema(AssistOutputSchema).toJsonSchema());
  });

  it("validates a turn's result, and says which field is wrong when it does not", () => {
    const ok = validateActionResult(registry, "assist", { message: "That is on Review." });
    expect(ok.ok).toBe(true);
    // `change` is null rather than absent on a turn that carries none (EO-418), and so are `card` (EO-521) and `trial` (EO-587).
    expect(ok.ok && ok.value).toEqual({ message: "That is on Review.", questions: [], proposals: [], change: null, card: null, trial: null });

    const bad = validateActionResult(registry, "assist", { message: "Here.", questions: [{ ...question, options: [] }] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("questions.0.options");
  });
});

/**
 * An assist turn proposing a module alongside its draft (EO-381).
 *
 * It used to be refused outright (EO-355): nothing in the room saved a
 * module, so one proposed here would have gone nowhere. The room saves
 * them now, in the Architecture panel's shape — so what is held to the
 * schema is what that panel holds a module to: test cases. A draft for
 * the module to be in is no longer asked for (EO-398).
 */
describe("an assist result proposing a module", () => {
  const module = {
    name: "Deploy",
    slug: "deploy",
    description: "Deploys.",
    code: "export default async () => ({ ok: true, result: 'deployed' });",
    manifest: { name: "Deploy", description: "Deploys.", results: ["deployed"] },
    why: "It would have been a script.",
  };
  const tests = [{ description: "deploys", source: "export default async function (h) { await h.run(); }" }];

  it("accepts a module with its tests beside a draft, in the Architecture panel's shape", () => {
    const validated = validateActionResult(registry, "assist", { message: "Here is the graph.", draft: graph(), modules: [{ ...module, tests }] });
    expect(validated.ok).toBe(true);

    const throughConfigure = ConfigureOutputSchema.parse({ message: "Here.", draft: graph(), modules: [{ ...module, tests }] });
    expect(validated.ok && (validated.value as { modules: unknown }).modules).toEqual(throughConfigure.modules);
  });

  it("is refused without test cases, telling the agent what to write", () => {
    const validated = validateActionResult(registry, "assist", { message: "Here is a module.", draft: graph(), modules: [module] });
    expect(validated.ok).toBe(false);
    expect(!validated.ok && validated.error).toContain(PROPOSED_MODULE_NEEDS_TESTS);
  });

  // A module asked for on its own is a proposal like any other (EO-398).
  // It used to be refused here, which sent the assistant to `module_save`
  // and left the chat with nothing to approve from.
  it("is accepted without a draft, as a proposal in its own right", () => {
    const validated = validateActionResult(registry, "assist", { message: "Here is a module.", modules: [{ ...module, tests }] });
    expect(validated.ok).toBe(true);
    expect(validated.ok && (validated.value as { modules: { slug: string; tests: unknown[] }[] }).modules).toMatchObject([{ slug: "deploy", tests }]);
  });

  it("is still refused without test cases when it comes on its own", () => {
    const validated = validateActionResult(registry, "assist", { message: "Here is a module.", modules: [module] });
    expect(validated.ok).toBe(false);
    expect(!validated.ok && validated.error).toContain(PROPOSED_MODULE_NEEDS_TESTS);
  });

  it("is refused beside questions, like every other proposal", () => {
    expect(AssistOutputSchema.safeParse({ message: "Here.", questions: [question], modules: [{ ...module, tests }] }).success).toBe(false);
  });

  it("accepts an empty modules list without a draft, which proposes nothing", () => {
    expect(validateActionResult(registry, "assist", { message: "Nothing to add.", modules: [] }).ok).toBe(true);
  });

  it("hands the provider the JSON Schema AssistOutputSchema says, modules included", () => {
    const schema = resultSchemaFor(registry, "assist")!.toJsonSchema();
    expect(schema).toEqual(zodOutputSchema(AssistOutputSchema).toJsonSchema());
    expect(JSON.stringify(schema)).toContain('"modules"');
  });
});

/** Which pipeline a draft is for, and the limits a new step may carry (EO-381). */
describe("an assist draft's target and new-step limits", () => {
  it("names an existing pipeline by id, or a new one by name", () => {
    const existing = AssistOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), target: { pipelineId: "p-1" } } });
    expect(existing.success && existing.data.draft?.target).toEqual({ pipelineId: "p-1" });

    const created = AssistOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), target: { newPipeline: "  Release " } } });
    expect(created.success && created.data.draft?.target).toEqual({ newPipeline: "Release" });
  });

  it("names exactly one of the two", () => {
    expect(AssistOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), target: { pipelineId: "p-1", newPipeline: "Release" } } }).success).toBe(false);
    expect(AssistOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), target: {} } }).success).toBe(false);
  });

  it("leaves a draft with no target exactly as it was", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft: graph() });
    expect(parsed.success && parsed.data.draft?.target).toBeUndefined();
  });

  it("carries a step's time limit and inputs, which the Architecture panel's draft does not", () => {
    const step = { id: "ship", position: 2, name: "Ship", type: "module" as const, ownerRole: null, entryAction: "deploy", instructionsSummary: null, isTerminal: false, planMode: false };
    const draft = { ...graph(), steps: [...graph().steps, { ...step, timeoutMs: 58 * 60_000, inputs: { ciWaitSeconds: 2400 } }] };

    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft });
    expect(parsed.success && parsed.data.draft?.steps.at(-1)).toMatchObject({ timeoutMs: 58 * 60_000, inputs: { ciWaitSeconds: 2400 } });

    // The other room still strips them: there an editor carries each
    // step's own values across, and nothing new was decided about it.
    const configure = ConfigureOutputSchema.safeParse({ message: "Here.", draft });
    expect(configure.success && configure.data.draft?.steps.at(-1)).not.toHaveProperty("timeoutMs");
  });

  it("carries a step's keep checking, with the give-up time defaulted, which the Architecture panel's draft does not (EO-516)", () => {
    const step = { id: "watch", position: 2, name: "Watch", type: "builtin" as const, ownerRole: null, entryAction: "watch_pull_request", instructionsSummary: null, isTerminal: false, planMode: false };
    const draft = { ...graph(), steps: [...graph().steps, { ...step, watch: { everyMinutes: 5 }, inputs: { reportReady: true } }] };

    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft });
    expect(parsed.success && parsed.data.draft?.steps.at(-1)).toMatchObject({ watch: { everyMinutes: 5, giveUpAfterHours: 168 }, inputs: { reportReady: true } });

    const configure = ConfigureOutputSchema.safeParse({ message: "Here.", draft });
    expect(configure.success && configure.data.draft?.steps.at(-1)).not.toHaveProperty("watch");
  });
});

/** The settings, route flag and pipeline fields the editor used to be the only way to change (EO-520). */
describe("an assist draft that tunes what exists", () => {
  const ship = { id: "ship", position: 2, name: "Ship", type: "module" as const, ownerRole: null, entryAction: "deploy", instructionsSummary: null, isTerminal: false, planMode: false };

  it("carries Works on, repository mode and the words for a default, running once and the item's own", () => {
    const draft = { ...graph(), steps: [...graph().steps, { ...ship, timeoutMs: "default", watch: "off", workspaceId: "item", workspaceMode: "read" }] };

    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft });
    expect(parsed.success && parsed.data.draft?.steps.at(-1)).toMatchObject({ timeoutMs: "default", watch: "off", workspaceId: "item", workspaceMode: "read" });

    const configure = ConfigureOutputSchema.safeParse({ message: "Here.", draft });
    expect(configure.success && configure.data.draft?.steps.at(-1)).not.toHaveProperty("workspaceMode");
  });

  it("takes no null for any of them, which a Codex agent writes for a field it leaves out", () => {
    for (const field of ["timeoutMs", "watch", "workspaceId", "workspaceMode"]) {
      const draft = { ...graph(), steps: [...graph().steps, { ...ship, [field]: null }] };
      expect(AssistOutputSchema.safeParse({ message: "Here.", draft }).success, field).toBe(false);
    }
  });

  it("carries Needs a reason on a route, and the pipeline's icon and restored version", () => {
    const base = graph();
    const draft = { ...base, routes: base.routes.map((route) => ({ ...route, requiresComment: false })), icon: "boxes", restoredFrom: 3 };

    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft });
    expect(parsed.success && parsed.data.draft).toMatchObject({ icon: "boxes", restoredFrom: 3 });
    expect(parsed.success && parsed.data.draft?.routes.every((route) => route.requiresComment === false)).toBe(true);
  });

  it("refuses an icon the rail cannot draw", () => {
    expect(AssistOutputSchema.safeParse({ message: "Here.", draft: { ...graph(), icon: "rocket" } }).success).toBe(false);
  });
});

describe("the action definitions an assist draft carries (EO-426)", () => {
  const alignment = { role: "qa", action: "alignment", results: [{ key: "aligned" }, { key: "gaps_found" }] };

  it("accepts a definition beside a draft, in configure's own shape", () => {
    const here = AssistOutputSchema.safeParse({ message: "Here.", draft: graph(), actions: [alignment] });
    const there = ConfigureOutputSchema.safeParse({ message: "Here.", draft: graph(), actions: [alignment] });

    expect(here.success && there.success).toBe(true);
    expect(here.success && here.data.actions).toEqual(there.success && there.data.actions);
  });

  it("leaves an ordinary turn's result exactly as it was", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Nothing to change." });
    expect(parsed.success && "actions" in parsed.data).toBe(false);
  });

  it("refuses a reply that asks questions and also carries actions", () => {
    // A whole question, so the only thing wrong with the reply is that it does both.
    const asked = { id: "pipeline", ...question };
    expect(AssistOutputSchema.safeParse({ message: "One thing first.", questions: [asked] }).success).toBe(true);
    const parsed = AssistOutputSchema.safeParse({ message: "One thing first.", questions: [asked], actions: [alignment] });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("a turn either asks or proposes");
  });

  it("refuses actions with no draft, and says where a definition on its own goes", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Here is a definition.", actions: [alignment] });
    expect(parsed.success).toBe(false);
    expect(!parsed.success && parsed.error.issues.map((issue) => issue.message).join(" ")).toContain("without a draft there is nothing to publish them with");
  });

  it("accepts an empty list without a draft, which proposes nothing", () => {
    // What a Codex agent writes on every turn: the strict schema makes it say something.
    expect(validateActionResult(registry, "assist", { message: "Nothing to add.", actions: [] }).ok).toBe(true);
  });

  it("sends a definition the save rules refuse back with the reason", () => {
    const validated = validateActionResult(registry, "assist", { message: "Here.", draft: graph(), actions: [{ role: "qa", action: "scenario", results: [{ key: "done" }] }] });
    expect(validated.ok).toBe(false);
    expect(!validated.ok && validated.error).toContain('The action "scenario" cannot be defined');
  });
});

describe("a card for something only a person may do (EO-521)", () => {
  const card = { kind: "pipelineDelete" as const, pipelineId: "default" };

  it("is null on an ordinary turn, so a reply from before it read back exactly as it did", () => {
    const parsed = AssistOutputSchema.parse({ message: "Nothing to press." });

    expect(parsed.card).toBeNull();
  });

  it("accepts each kind on its own, naming only what it is about", () => {
    for (const offered of [
      { kind: "pipelineExport", pipelineId: "default" },
      { kind: "pipelineImport", attachmentId: "019a0000-0000-7000-8000-000000000521" },
      { kind: "pipelineDelete", pipelineId: "default" },
      { kind: "pipelineDiscardEdits", pipelineId: "default" },
    ]) {
      expect(AssistOutputSchema.safeParse({ message: "The card does it.", card: offered }).success).toBe(true);
    }
  });

  it("refuses a kind it does not know and a card missing what it is about", () => {
    expect(AssistOutputSchema.safeParse({ message: "x", card: { kind: "pipelineRename", pipelineId: "default" } }).success).toBe(false);
    expect(AssistOutputSchema.safeParse({ message: "x", card: { kind: "pipelineImport", pipelineId: "default" } }).success).toBe(false);
  });

  it("comes on its own: not beside a draft, a change, modules or work proposals", () => {
    const beside = AssistOutputSchema.safeParse({ message: "x", card, draft: graph() });

    expect(beside.success).toBe(false);
    expect(beside.success ? [] : beside.error.issues.map((issue) => issue.path.join("."))).toContain("card");
    const proposals = [{ action: "amend", item: "EO-42", why: "The title is wrong.", title: "A better title" }];
    expect(AssistOutputSchema.safeParse({ message: "x", proposals }).success).toBe(true);
    const withProposals = AssistOutputSchema.safeParse({ message: "x", card, proposals });
    expect(withProposals.success ? [] : withProposals.error.issues.map((issue) => issue.path.join("."))).toContain("card");
  });

  it("is not offered by a turn that asks", () => {
    expect(AssistOutputSchema.safeParse({ message: "x", card, questions: [question] }).success).toBe(false);
  });
});

describe("the cards for settings that are a person's (EO-522)", () => {
  it("accepts a webhook card and a step's own secret or variable, naming the step and the variable", () => {
    for (const offered of [
      { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: true },
      { kind: "pipelineWebhookUnattended", pipelineId: "default", unattended: false },
      { kind: "stepSecret", stepId: "deploy", name: "DEPLOY_TOKEN", action: "set" },
      { kind: "stepSecret", stepId: "deploy", name: "DEPLOY_TOKEN", action: "clear" },
      { kind: "stepVariable", stepId: "deploy", name: "REGION", action: "set" },
    ]) {
      expect(AssistOutputSchema.safeParse({ message: "The card does it.", card: offered }).success).toBe(true);
    }
  });

  it("has no place for a value: one the agent writes is dropped, so it never reaches the card", () => {
    const parsed = AssistOutputSchema.parse({
      message: "The card does it.",
      card: { kind: "stepSecret", stepId: "deploy", name: "DEPLOY_TOKEN", action: "set", value: "hunter2" },
    });

    expect(parsed.card).toEqual({ kind: "stepSecret", stepId: "deploy", name: "DEPLOY_TOKEN", action: "set" });
    expect(JSON.stringify(parsed)).not.toContain("hunter2");
  });

  it("refuses a webhook card that does not say which way, and a step card that does not say set or clear", () => {
    expect(AssistOutputSchema.safeParse({ message: "x", card: { kind: "pipelineWebhookUnattended", pipelineId: "default" } }).success).toBe(false);
    expect(AssistOutputSchema.safeParse({ message: "x", card: { kind: "stepVariable", stepId: "deploy", name: "REGION", action: "reveal" } }).success).toBe(false);
  });
});

describe("the cards for a project's item types (EO-523)", () => {
  const create = { kind: "itemTypeCreate", projectId: "p", label: "Case", plural: "Cases", container: false, fields: [{ name: "customer", kind: "string", required: true }] };

  it("accepts adding, changing and removing a type", () => {
    for (const offered of [
      create,
      { kind: "itemTypeUpdate", itemTypeId: "t", label: "Request", plural: "Requests", container: null, fields: null },
      { kind: "itemTypeUpdate", itemTypeId: "t", label: null, plural: null, container: true, fields: [] },
      { kind: "itemTypeDelete", itemTypeId: "t" },
    ]) {
      expect(AssistOutputSchema.safeParse({ message: "The card does it.", card: offered }).success).toBe(true);
    }
  });

  it("refuses a change that leaves out what it keeps rather than saying null, so both backends write one document", () => {
    expect(AssistOutputSchema.safeParse({ message: "x", card: { kind: "itemTypeUpdate", itemTypeId: "t", label: "Request" } }).success).toBe(false);
  });

  it("refuses a field of a kind the editor never offered", () => {
    const odd = { ...create, fields: [{ name: "when", kind: "date", required: false }] };
    expect(AssistOutputSchema.safeParse({ message: "x", card: odd }).success).toBe(false);
  });
});

describe("alternative drafts and keeping one's own pipeline (EO-534)", () => {
  const target = { pipelineId: "default" };
  const draft = (rationale: string) => ({ ...graph(), rationale, target });
  const keep = { kind: "pipelineKeepMine" as const, pipelineId: "default" };
  const paths = (result: ReturnType<typeof AssistOutputSchema.safeParse>) => (result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")));

  it("reads an ordinary turn back with no alternatives, exactly as it did", () => {
    expect(AssistOutputSchema.parse({ message: "Nothing to offer." })).not.toHaveProperty("alternatives");
  });

  it("carries up to two alternatives beside the recommended draft, and a Keep my pipeline card with them", () => {
    const parsed = AssistOutputSchema.parse({ message: "Three ways.", draft: draft("Merge both."), alternatives: [draft("Take the template.")], card: keep });

    expect(parsed.alternatives?.map((alternative) => alternative.rationale)).toEqual(["Take the template."]);
    expect(parsed.card).toEqual(keep);
    expect(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), alternatives: [draft("b"), draft("c")] }).success).toBe(true);
  });

  it("refuses a third alternative: three options at most", () => {
    expect(paths(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), alternatives: [draft("b"), draft("c"), draft("d")] }))).toContain("alternatives");
  });

  it("refuses alternatives without a draft to be alternatives to", () => {
    expect(paths(AssistOutputSchema.safeParse({ message: "x", alternatives: [draft("b")] }))).toContain("alternatives");
  });

  it("refuses an alternative for another pipeline than the draft's", () => {
    const elsewhere = { ...draft("b"), target: { pipelineId: "release" } };
    expect(paths(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), alternatives: [elsewhere] }))).toContain("alternatives");
  });

  it("refuses modules or actions beside alternatives, which one draft's Publish saves", () => {
    const actions = [{ role: "qa", action: "check", results: [{ key: "ok" }], fields: [] }];
    expect(paths(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), alternatives: [draft("b")], actions }))).toContain("alternatives");
  });

  it("lets only Keep my pipeline come beside a draft: every other card still comes on its own", () => {
    expect(AssistOutputSchema.safeParse({ message: "x", card: keep }).success).toBe(true);
    expect(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), card: keep }).success).toBe(true);
    expect(paths(AssistOutputSchema.safeParse({ message: "x", draft: draft("a"), card: { kind: "pipelineDelete", pipelineId: "default" } }))).toContain("card");
    expect(paths(AssistOutputSchema.safeParse({ message: "x", card: keep, proposals: [{ action: "amend", item: "EO-42", why: "Wrong.", title: "Better" }] }))).toContain("card");
  });
});
