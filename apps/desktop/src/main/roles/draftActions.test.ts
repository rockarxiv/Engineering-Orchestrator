import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigureOutputSchema, proposedActionDraft, type ConfigureOutput, type ParsedActionDefinitionDraft, type PipelineDraft } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import {
  createPipeline,
  createStep,
  getActionDefinition,
  listActionDefinitions,
  listRoutesForPipeline,
  listStepsForPipeline,
  publishSection,
  saveActionDefinition,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { savePipeline, validatePipelineCommand } from "../ipc/configCommands.js";
import { listPipelineStepViews } from "../ipc/domainQueries.js";
import { renderDraft, validateDraft } from "./architect.js";
import { sourcePromptsDir } from "./prompts.js";

/**
 * A pipeline draft that brings the action definitions it needs (EO-426).
 *
 * The shared half: the card a draft becomes, and the publish that writes
 * the definitions with the graph. The assistant's own half — its turn,
 * its card and its Publish button — is in `ipc/assistCommands.test.ts`,
 * beside the rest of that room. (This was the Architecture panel's half
 * until EO-526 removed the panel.)
 */

let handle: DbHandle;
let stopBeingAReplica: (() => void) | null = null;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  stopBeingAReplica?.();
  stopBeingAReplica = null;
  handle.close();
});

/** `qa` defines `alignment`, as an agent writes it beside a draft. */
const ALIGNMENT = {
  role: "qa",
  action: "alignment",
  description: "Check the work against what was asked for.",
  results: [
    { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
    { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
  ],
  fields: [{ name: "gaps", type: "string_list" as const, required: false, description: "Each thing that is missing." }],
};

/**
 * The shipped pipeline with a `qa` step on `alignment` put between
 * review's approval and wherever approval used to go.
 *
 * `second` is the other key the step routes: `gaps_found` for the
 * definition above, and whatever a changed definition calls it.
 */
function withQaStep(second = "gaps_found"): PipelineDraft {
  const steps = listStepsForPipeline(handle.db, "default").filter((step) => !step.offBoard);
  const routes = listRoutesForPipeline(handle.db, "default");
  const approved = routes.find((route) => route.resultKey === "approved")!;

  return {
    rationale: "A QA gate after review.",
    entryStepId: "worktree",
    removes: [],
    steps: [
      ...steps.map((step) => ({
        id: step.id,
        position: step.position,
        name: step.name,
        type: step.type,
        ownerRole: step.ownerRole,
        entryAction: step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
      })),
      { id: "qa_check", position: steps.length, name: "QA", type: "agent", ownerRole: "qa", entryAction: "alignment", instructionsSummary: null, isTerminal: false, planMode: false },
    ],
    routes: [
      ...routes.map((route) => ({
        fromStepId: route.fromStepId,
        resultKey: route.resultKey,
        label: route.label,
        tone: route.tone,
        target: route.id === approved.id ? "qa_check" : route.target,
        position: route.position,
      })),
      { fromStepId: "qa_check", resultKey: "aligned", label: "Aligned", tone: "success", target: approved.target, position: 0 },
      { fromStepId: "qa_check", resultKey: second, label: "Not aligned", tone: "danger", target: "user_attention", position: 1 },
    ],
  };
}

type Reply = Omit<ConfigureOutput, "actions"> & { actions?: unknown[] };

function reply(draft: PipelineDraft, actions: unknown[] = []): Reply {
  return { message: "Here it is.", questions: [], agents: [], runtimes: [], modules: [], draft, actions };
}

/**
 * The definitions as a reply says them, as the save takes them: parsed
 * with the reply's own schema, so every default is filled in, and turned
 * from the list an answer writes into the shape a definition is saved in.
 */
function definitionsOf(output: Reply): ParsedActionDefinitionDraft[] {
  return ConfigureOutputSchema.parse(output).actions.map(proposedActionDraft);
}

/** The card a reply's draft renders as, or the rejection there is instead. */
function render(output: Reply): { card: string | undefined; rejections: string[] } {
  const rendered = renderDraft(handle.db, "default", { ...output, actions: definitionsOf(output) });
  return rendered.ok ? { card: rendered.body, rejections: [] } : { card: undefined, rejections: [rendered.reason] };
}

/** The graph Publish would send for a draft: its steps and routes, stamped with the pipeline, each step keeping what it had. */
function asPublished(draft: PipelineDraft) {
  const current = new Map(listPipelineStepViews(handle.db, { pipelineId: "default" }).steps.map((step) => [step.id, step]));
  return {
    pipelineId: "default",
    steps: draft.steps.map((step) => ({
      ...step,
      pipelineId: "default",
      inputs: current.get(step.id)?.inputs ?? {},
      timeoutMs: current.get(step.id)?.timeoutMs ?? null,
      workspaceMode: current.get(step.id)?.workspaceMode ?? ("isolated" as const),
      workspaceId: current.get(step.id)?.workspaceId ?? null,
      results: current.get(step.id)?.results ?? [],
      watch: current.get(step.id)?.watch ?? null,
      moduleVersion: current.get(step.id)?.moduleVersion ?? null,
    })),
    routes: draft.routes.map((route, index) => ({ ...route, id: `draft-route-${index}`, pipelineId: "default" })),
    entryStepId: draft.entryStepId,
  };
}

const UNDEFINED_ACTION = 'its answer is not validated and will route as "done"';

describe("validating a draft with the definitions it proposes", () => {
  it("validates a step on (qa, alignment) when the draft brings the definition", () => {
    const problems = validateDraft(handle.db, "default", withQaStep(), [], { actions: [{ ...ALIGNMENT, fields: {} }] });

    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
    expect(problems.map((problem) => problem.message).join("\n")).not.toContain(UNDEFINED_ACTION);
    // Judged, and nothing written by judging it.
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("reports the same draft without the definition with the undefined-action warning", () => {
    const problems = validateDraft(handle.db, "default", withQaStep());
    const about = problems.filter((problem) => problem.stateId === "qa_check" && problem.message.includes(UNDEFINED_ACTION));

    expect(about).toHaveLength(1);
    expect(about[0]!.severity).toBe("warning");
  });

  it("holds the step to the proposed keys: a route on a key the definition does not declare is an error", () => {
    const problems = validateDraft(handle.db, "default", withQaStep("blocked"), [], { actions: [{ ...ALIGNMENT, fields: {} }] });
    const errors = problems.filter((problem) => problem.severity === "error").map((problem) => problem.message).join("\n");

    expect(errors).toContain("blocked");
    expect(errors).toContain("gaps_found");
  });
});

describe("the draft card", () => {
  it("lists each proposed definition with its result keys", () => {
    const { card, rejections } = render(reply(withQaStep(), [ALIGNMENT]));

    expect(rejections).toEqual([]);
    expect(card).toContain("**New action** qa / alignment — Check the work against what was asked for.");
    expect(card).toContain("Returns: `aligned` (Aligned), `gaps_found` (Gaps found)");
    expect(card).toContain("Extra answer fields: `gaps`");
    // On the card, and nowhere else yet: Publish is what writes it.
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("marks a definition that changes an existing one, with the keys it adds and removes", () => {
    saveActionDefinition(handle.db, { ...ALIGNMENT, fields: {} });

    const { card } = render(
      reply(withQaStep("blocked"), [
        { ...ALIGNMENT, fields: [], results: [ALIGNMENT.results[0], { key: "blocked", label: "Blocked", meaning: "It cannot be checked yet." }] },
      ]),
    );

    expect(card).toContain("**Changed action** qa / alignment");
    expect(card).toContain("Changes a definition this role already has.");
    expect(card).toContain("Returns: `aligned` (Aligned), `blocked` (Blocked)");
    expect(card).toContain("Adds: `blocked` · Removes: `gaps_found`");
    expect(card).not.toContain("**New action**");
    // Still the saved one until somebody publishes.
    expect(getActionDefinition(handle.db, "qa", "alignment")!.results.map((result) => result.key)).toEqual(["aligned", "gaps_found"]);
  });

  it("names the steps of other pipelines that a changed definition also holds", () => {
    saveActionDefinition(handle.db, { ...ALIGNMENT, fields: {} });
    // Another pipeline already dispatches the action this card redraws.
    const quality = createPipeline(handle.db, { name: "Quality" });
    createStep(handle.db, { pipelineId: quality.id, position: 0, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment" });

    const { card } = render(
      reply(withQaStep("blocked"), [{ ...ALIGNMENT, fields: [], results: [ALIGNMENT.results[0], { key: "blocked", label: "Blocked", meaning: "" }] }]),
    );

    expect(card).toContain("Adds: `blocked` · Removes: `gaps_found`");
    expect(card).toContain('Also used by: "Check" (Quality)');
  });

  it("says so when a proposed definition is the one already saved", () => {
    saveActionDefinition(handle.db, { ...ALIGNMENT, fields: {} });

    const { card } = render(reply(withQaStep(), [{ ...ALIGNMENT, fields: [] }]));

    expect(card).toContain("**Action** qa / alignment");
    expect(card).toContain("Already defined exactly this way");
    expect(card).not.toContain("**Changed action**");
  });

  it("refuses a definition the save rules refuse, with the reason, and posts no card", () => {
    // The one rule the schema cannot ask: a pack's own role redefining the action that pack ships for it.
    const { card, rejections } = render(reply(withQaStep(), [ALIGNMENT, { role: "reviewer", action: "review", results: [{ key: "passed", label: "Passed", meaning: "" }], fields: [] }]));

    expect(card).toBeUndefined();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain(`The reviewer role's "review" action cannot be redefined`);
    expect(rejections[0]).toContain("Nothing was written");
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });
});

describe("publishing a draft that carries definitions", () => {
  /** A draft whose card was offered, with its definitions as Publish sends them. */
  function applied(output: Reply) {
    expect(render(output).rejections).toEqual([]);
    return { draft: output.draft, actions: definitionsOf(output) };
  }

  it("hands Publish the definitions as the save takes them, having saved nothing", () => {
    const read = applied(reply(withQaStep(), [ALIGNMENT]));

    expect(read.actions).toEqual([
      {
        role: "qa",
        action: "alignment",
        description: ALIGNMENT.description,
        results: ALIGNMENT.results,
        fields: { type: "object", properties: { gaps: { type: "array", items: { type: "string" }, description: "Each thing that is missing." } } },
      },
    ]);
    expect(listActionDefinitions(handle.db)).toEqual([]);
  });

  it("checks the unsaved graph with them, as Publish will judge it", () => {
    const read = applied(reply(withQaStep(), [ALIGNMENT]));
    const graph = asPublished(read.draft!);

    const withThem = validatePipelineCommand(handle.db, { ...graph, actions: read.actions }).problems.map((problem) => problem.message).join("\n");
    const without = validatePipelineCommand(handle.db, graph).problems.map((problem) => problem.message).join("\n");

    expect(withThem).not.toContain(UNDEFINED_ACTION);
    expect(without).toContain(UNDEFINED_ACTION);
  });

  it("writes every proposed definition and the pipeline together", () => {
    const read = applied(reply(withQaStep(), [ALIGNMENT]));

    const saved = savePipeline(handle.db, undefined, { ...asPublished(read.draft!), actions: read.actions });

    expect(saved.saved).toBe(true);
    expect(getActionDefinition(handle.db, "qa", "alignment")).toMatchObject({ description: ALIGNMENT.description, results: ALIGNMENT.results });
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "qa_check")).toMatchObject({ ownerRole: "qa", entryAction: "alignment" });
  });

  it("replaces a definition the role already has when the draft changes it", () => {
    saveActionDefinition(handle.db, { ...ALIGNMENT, fields: {} });
    const read = applied(
      reply(withQaStep("blocked"), [{ ...ALIGNMENT, fields: [], results: [ALIGNMENT.results[0], { key: "blocked", label: "Blocked", meaning: "" }] }]),
    );

    expect(savePipeline(handle.db, undefined, { ...asPublished(read.draft!), actions: read.actions }).saved).toBe(true);
    expect(getActionDefinition(handle.db, "qa", "alignment")!.results.map((result) => result.key)).toEqual(["aligned", "blocked"]);
  });

  it("writes no definition when the pipeline is refused", () => {
    const read = applied(reply(withQaStep(), [ALIGNMENT]));
    const graph = asPublished(read.draft!);
    // A route to a step that is not there: the validator refuses the graph.
    const broken = { ...graph, routes: graph.routes.map((route) => (route.fromStepId === "qa_check" && route.resultKey === "aligned" ? { ...route, target: "nowhere" } : route)) };

    const saved = savePipeline(handle.db, undefined, { ...broken, actions: read.actions });

    expect(saved.saved).toBe(false);
    expect(listActionDefinitions(handle.db)).toEqual([]);
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "qa_check")).toBe(false);
  });

  it("writes neither when one of several definitions is refused", () => {
    // A definition the save refuses, arriving at Publish beside one it
    // accepts: nothing of the accepted one stays behind, and the graph
    // is not touched.
    const read = applied(reply(withQaStep(), [ALIGNMENT]));
    const saved = savePipeline(handle.db, undefined, {
      ...asPublished(read.draft!),
      actions: [...read.actions, { role: "reviewer", action: "review", description: "", results: [{ key: "passed", label: "", meaning: "" }], fields: {} }],
    });

    expect(saved.saved).toBe(false);
    expect(saved.problems.map((problem) => problem.message).join("\n")).toContain(`The reviewer role's "review" action cannot be redefined`);
    expect(listActionDefinitions(handle.db)).toEqual([]);
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "qa_check")).toBe(false);
  });

  it("takes the definitions back when the graph fails to write after them", () => {
    // Past the validator and into the transaction: a step id another
    // pipeline already holds is something only the database refuses, and
    // it refuses it after the definitions have been written.
    const quality = createPipeline(handle.db, { name: "Quality" });
    createStep(handle.db, { id: "qa_check", pipelineId: quality.id, position: 0, name: "Check", type: "user" });
    const graph = asPublished(withQaStep());

    let outcome: "saved" | "refused" | "threw";
    try {
      outcome = savePipeline(handle.db, undefined, { ...graph, actions: [{ ...ALIGNMENT, fields: {} }] }).saved ? "saved" : "refused";
    } catch {
      outcome = "threw";
    }

    expect(outcome).not.toBe("saved");
    expect(listActionDefinitions(handle.db)).toEqual([]);
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "qa_check")).toBe(false);
  });

  it("is refused naming the agents section where that section is managed, and writes nothing", () => {
    const read = applied(reply(withQaStep(), [ALIGNMENT]));
    stopBeingAReplica = markReplica(handle.db, () => true);
    publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

    const saved = savePipeline(handle.db, undefined, { ...asPublished(read.draft!), actions: read.actions });

    expect(saved.saved).toBe(false);
    expect(saved.problems).toHaveLength(1);
    expect(saved.problems[0]!.message).toContain("The agents section is managed by your organisation. Dana published it.");
    expect(saved.problems[0]!.message).toContain(`qa's "alignment"`);
    expect(listActionDefinitions(handle.db)).toEqual([]);
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "qa_check")).toBe(false);
  });

  it("still publishes a graph that carries no definitions on that installation: the lock is about the definitions", () => {
    stopBeingAReplica = markReplica(handle.db, () => true);
    publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
    const graph = listPipelineStepViews(handle.db, { pipelineId: "default" });

    expect(savePipeline(handle.db, undefined, { pipelineId: "default", steps: graph.steps, routes: graph.routes, entryStepId: graph.entryStepId }).saved).toBe(true);
  });
});

describe("what the system agent is told about a draft's actions", () => {
  const prompt = readFileSync(join(sourcePromptsDir(), "system-agent.md"), "utf8");
  const start = prompt.indexOf("### Action definitions a draft needs");
  const section = prompt.slice(start, prompt.indexOf("### Step ids", start));

  it("documents `actions` beside `draft`, with the shape and what Publish does with them", () => {
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain("`actions` is a list beside `draft`");
    expect(section).toContain('"role": "qa"');
    expect(section).toContain('"action": "alignment"');
    expect(section).toContain("Nothing is saved until Publish");
    expect(section).toContain("written together or not at all");
    // Every type a field may be, as the schema lists them.
    for (const type of ["string", "number", "integer", "boolean", "string_list"]) expect(section).toContain(`\`${type}\``);
  });

  it("says what is refused: a broken definition, actions with questions or no draft, and a managed agents section", () => {
    expect(section).toContain("sent back to you with the reason and no");
    expect(section).toContain("`actions` without `draft` is refused");
    expect(section).toContain("`actions` in a turn that asks `questions`");
    expect(section).toContain("agents section is managed");
  });

  it("documents it where the assistant's drafts and `modules` are documented, and in the list of routes", () => {
    const widget = prompt.slice(prompt.indexOf("### Drafts from the assistant's chat"), prompt.indexOf("### A module on its own"));
    expect(widget).toContain("**`modules` proposes the modules the draft needs**");
    expect(widget).toContain("**`actions` proposes the action definitions the draft needs**");

    const routes = prompt.slice(prompt.indexOf("## How you change anything"), prompt.indexOf("### A section the organisation manages"));
    expect(routes).toContain("in `actions`");
  });

  // Invariant 12: no backend's spelling of a tool id.
  it("names no tool with one backend's punctuation", () => {
    expect(section).not.toMatch(/mcp__/);
    expect(section).not.toMatch(/\b(claude|codex)\b/i);
  });

  it("carries a newer prompt-version than the one that had no `actions`", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(18);
  });
});
