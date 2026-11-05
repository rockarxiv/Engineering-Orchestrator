import { proposedActionDraft, type ConfigureOutput, type PipelineDraft } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createRoute, createStep, listRoutesForPipeline, listStepsForPipeline } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { renderDraft, validateDraft } from "./architect.js";

/**
 * What the assistant's pipeline drafts are built on: the card a person
 * reads and the validator it is judged by.
 *
 * These were the Architecture panel's tests, written against a
 * `configure` turn posting its draft into the panel's conversation. The
 * panel and its conversations went in EO-526; `renderDraft` and
 * `validateDraft` are what is left, and the assistant's own card goes
 * through both (`assist.test.ts`, `draftActions.test.ts`).
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/**
 * The shipped pipeline as a draft — the baseline every case edits.
 *
 * Read from the database rather than written out here, so "identical to
 * what is already there" means exactly that. A hand-copied graph that
 * drifts from the seed by one route would make every case below test a
 * change nobody intended to make.
 */
function currentGraph(): PipelineDraft {
  const steps = listStepsForPipeline(handle.db, "default").filter((step) => !step.offBoard);
  return {
    rationale: "No change.",
    entryStepId: "worktree",
    // Nothing is dropped, so nothing is declared (EO-209).
    removes: [],
    steps: steps.map((step) => ({
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
    routes: listRoutesForPipeline(handle.db, "default").map((route) => ({
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
  };
}

/** A reply as these tests write one: `actions` (EO-426) is left out by every turn that proposes none. */
type Reply = Omit<ConfigureOutput, "actions"> & Partial<Pick<ConfigureOutput, "actions">>;

/**
 * Renders one reply's draft against the shipped pipeline: the card a
 * person would be offered, or the rejection carrying why there is none.
 */
function render(output: Reply): { card: string | undefined; rejection: string | undefined } {
  const rendered = renderDraft(handle.db, "default", { ...output, actions: (output.actions ?? []).map(proposedActionDraft) });
  return rendered.ok ? { card: rendered.body, rejection: undefined } : { card: undefined, rejection: rendered.reason };
}

describe("rendering a draft", () => {
  it("renders a valid draft as a card naming what changed", () => {
    const draft = currentGraph();
    const { card } = render({
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [], modules: [],
      draft: {
        ...draft,
        rationale: "A QA gate before review.",
        steps: [
          ...draft.steps,
          { id: "qa", position: 7, name: "QA", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false, planMode: false },
        ],
        routes: [
          ...draft.routes.filter((route) => !(route.fromStepId === "todo" && route.resultKey === "done")),
          { fromStepId: "todo", resultKey: "done", label: "Implemented", tone: "success", target: "qa", position: 0 },
          { fromStepId: "qa", resultKey: "approved", label: "Passed", tone: "success", target: "review", position: 0 },
          { fromStepId: "qa", resultKey: "changes_requested", label: "Failed", tone: "warning", target: "todo", position: 1 },
          // Every result `review` declares, or the draft is refused (EO-423).
          { fromStepId: "qa", resultKey: "needs_user_input", label: "Needs a person", tone: "info", target: "user_attention", position: 2 },
        ],
      },
    });

    expect(card).toBeDefined();
    const body = card!;
    expect(body).toContain("A QA gate before review.");
    expect(body).toContain("**Added**");
    expect(body).toContain("QA");
    expect(body).toContain("**Routing**");
  });

  /**
   * Invariant #8: nothing is dropped silently. A graph that cannot be
   * published comes back as a rejection carrying the reason, so the next
   * turn can fix it rather than proposing the same thing again.
   */
  it("renders an unpublishable draft as a rejection carrying the reason", () => {
    const draft = currentGraph();
    const { card, rejection } = render({
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [], modules: [],
      // An agent step that is also terminal — nothing runs on a terminal
      // step, so it would never be dispatched.
      draft: { ...draft, steps: draft.steps.map((step) => (step.id === "review" ? { ...step, isTerminal: true } : step)) },
    });

    expect(card).toBeUndefined();
    expect(rejection).toContain("cannot be published");
    expect(rejection).toContain("terminal");
  });

  /**
   * A rename changes nothing about who acts, so comparing rendered
   * descriptions reported it as no change and offered "nothing to apply"
   * for a draft that plainly did something.
   */
  it("reports a rename, which changes no behaviour", () => {
    const draft = currentGraph();
    const { card } = render({
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [], modules: [],
      draft: {
        ...draft,
        rationale: "Clearer name.",
        steps: draft.steps.map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step)),
      },
    });

    expect(card).toBeDefined();
    const body = card!;
    expect(body).toContain("**Changed**");
    expect(body).toContain("renamed to **Shipped**");
  });

  it("refuses a draft identical to what is already there", () => {
    const { card, rejection } = render({ message: "No change needed.", questions: [], agents: [], runtimes: [], modules: [], draft: currentGraph() });

    expect(card).toBeUndefined();
    expect(rejection).toContain("nothing to apply");
  });

  it("names the agents and runtimes a draft needs", () => {
    const draft = currentGraph();
    const { card } = render({
      message: "Here it is.",
      questions: [],
      agents: [{ name: "Vega", role: "tester", provider: "codex", model: null, instructions: "Runs the suite and reports failures." }],
      runtimes: [{ id: "codex", why: "Vega runs on it and it is not installed." }],
      modules: [],
      draft: { ...draft, rationale: "Rename the last step.", steps: draft.steps.map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step)) },
    });

    const body = card!;
    expect(body).toContain("Vega");
    // The summary comes from the proposed instructions, via the same
    // helper the Agents card renders.
    expect(body).toContain("Runs the suite and reports failures.");
    expect(body).toContain("Needs runtime");
  });
});

/**
 * What a draft says it removes (EO-209).
 *
 * The residual surface after four other guards: a step holding no
 * items that no other pipeline hands work to. The read gate passes it,
 * `validateDraft` has nothing to object to, and the only trace is a line
 * under **Removed** on a card somebody is approving for a different
 * reason — which is the failure mode people are worst at catching,
 * because noticing something *absent* from a list is not what every
 * other guard here is doing.
 */
describe("what a draft says it removes", () => {
  /**
   * The shipped graph with the Index step gone: the edge that fed it
   * re-pointed at the implementer, its own edges dropped.
   *
   * Index rather than any other column because it is exactly the case
   * these cases are about — a step holding nothing, that nothing outside
   * this pipeline routes to, whose removal leaves a graph the validator
   * is perfectly happy with.
   */
  function dropIndex(removes: string[]): PipelineDraft {
    const draft = currentGraph();
    return {
      ...draft,
      rationale: "The index step is not worth a column here.",
      removes,
      steps: draft.steps.filter((step) => step.id !== "repository_index"),
      routes: draft.routes
        .filter((route) => route.fromStepId !== "repository_index")
        .map((route) => (route.target === "repository_index" ? { ...route, target: "todo" } : route)),
    };
  }

  function proposes(draft: PipelineDraft): Reply {
    return { message: "Here it is.", questions: [], agents: [], runtimes: [], modules: [], draft };
  }

  it("refuses a draft that drops a step without declaring it, even one holding nothing", () => {
    const { card, rejection } = render(proposes(dropIndex([])));

    // No card, so nothing with a button on it: refused where it is
    // rendered rather than where it is pressed.
    expect(card).toBeUndefined();
    expect(rejection).toContain("Dropped without being declared: **Index**, holding nothing");
    // And what to do about it, which is what lets the next turn fix the
    // graph rather than propose the same one again (invariant #8).
    expect(rejection).toContain("`removes`");
    // The pipeline is untouched either way — a draft changes nothing —
    // but the step it would have deleted is still there to put back.
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "repository_index")).toBe(true);
  });

  it("posts the same removal as a card once it is declared, with the step under Removed", () => {
    const { card, rejection } = render(proposes(dropIndex(["repository_index"])));

    expect(card).toBeDefined();
    const body = card!;
    expect(body).toContain("**Removed**");
    expect(body).toContain("Index");
    // The fix is a gate, not a refusal of every removal: declaring one
    // renders exactly as it did before this story.
    expect(rejection).toBeUndefined();
  });

  /**
   * Declaring a removal says what you meant, not what you are allowed to
   * do. `validateDraft`'s rules are unchanged, and this is the one that
   * would hurt most if declaring quietly bypassed it.
   */
  it("still refuses a declared removal of a step that holds items", () => {
    createTestItem(handle.db, { type: "story", title: "Being indexed", stepId: "repository_index" });

    const { card, rejection } = render(proposes(dropIndex(["repository_index"])));

    expect(card).toBeUndefined();
    expect(rejection).toContain("has 1 item on it");
  });

  it("still refuses a declared removal of a step another pipeline hands work to", () => {
    const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
    createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "repository_index" });

    const { card, rejection } = render(proposes(dropIndex(["repository_index"])));

    expect(card).toBeUndefined();
    // Named by the pipeline that declares the route, because that is
    // where somebody has to go to change it (EO-167).
    expect(rejection).toContain("Delivery · Shipped");
  });

  /**
   * "I remove Index" alongside Index in `steps` is not a graph anybody
   * meant, and there is no safe reading to guess at: publishing keeps a
   * step the rationale says is gone, honouring the declaration deletes
   * one the graph keeps.
   */
  it("refuses a draft that names a step in `removes` and lists it in `steps`", () => {
    const draft = currentGraph();

    const { card, rejection } = render(
      proposes({
        ...draft,
        rationale: "Clearer name for the last step.",
        removes: ["repository_index"],
        steps: draft.steps.map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step)),
      }),
    );

    expect(card).toBeUndefined();
    expect(rejection).toContain("Kept and removed at once: **Index**");
  });

  it("adds no ceremony to a draft that removes nothing and declares nothing", () => {
    const draft = currentGraph();

    const { card, rejection } = render(
      proposes({
        ...draft,
        rationale: "Clearer name for the last step.",
        steps: draft.steps.map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step)),
      }),
    );

    expect(card).toBeDefined();
    expect(rejection).toBeUndefined();
    const body = card!;
    expect(body).not.toContain("**Removed**");
  });
});

describe("validateDraft", () => {
  // The same function and inputs `savePipeline` uses. Judged by anything
  // softer and a card would be offered that Publish then refuses.
  it("agrees with the publish path about a step that still holds items", () => {
    createTestItem(handle.db, { type: "story", title: "In flight", stepId: "review" });
    const draft = currentGraph();

    const problems = validateDraft(handle.db, "default", {
      ...draft,
      steps: draft.steps.filter((step) => step.id !== "review"),
      routes: draft.routes.filter((route) => route.fromStepId !== "review" && route.target !== "review"),
    });

    expect(problems.some((problem) => problem.severity === "error" && problem.message.includes("Review"))).toBe(true);
  });

  it("agrees with it about a step another pipeline hands work to", () => {
    // Judged by anything softer here and the assistant offers a card that
    // Publish then refuses, which is worse than no card (EO-167).
    const delivery = createPipeline(handle.db, { projectId: null, name: "Delivery" });
    const ship = createStep(handle.db, { pipelineId: delivery.id, position: 0, name: "Ship", type: "user" });
    createRoute(handle.db, { pipelineId: delivery.id, fromStepId: ship.id, resultKey: "shipped", label: "Shipped", target: "review" });
    const draft = currentGraph();

    const problems = validateDraft(handle.db, "default", {
      ...draft,
      steps: draft.steps.filter((step) => step.id !== "review"),
      routes: draft.routes.filter((route) => route.fromStepId !== "review" && route.target !== "review"),
    });

    expect(problems.some((problem) => problem.severity === "error" && problem.message.includes("Delivery · Shipped"))).toBe(true);
  });

  it("warns about a role nobody staffs rather than blocking it", () => {
    const draft = currentGraph();
    const problems = validateDraft(handle.db, "default", {
      ...draft,
      steps: draft.steps.map((step) => (step.id === "todo" ? { ...step, ownerRole: "tester" } : step)),
    });

    expect(problems.some((problem) => problem.severity === "warning" && problem.message.includes("tester"))).toBe(true);
    expect(problems.some((problem) => problem.severity === "error")).toBe(false);
  });

  // A draft says nothing about keep checking, and publishing one carries
  // each step's own across — so it is judged with it (EO-505).
  it("judges a step that keeps checking with its own mode, and refuses a step the draft adds that waits but runs once", () => {
    const draft = currentGraph();
    expect(validateDraft(handle.db, "default", draft).filter((problem) => problem.severity === "error")).toEqual([]);

    const watch = draft.steps.find((step) => step.id === "pull_request_watch")!;
    const problems = validateDraft(handle.db, "default", {
      ...draft,
      steps: [...draft.steps, { ...watch, id: "second_watch", name: "Watching again", position: watch.position + 0.5 }],
      routes: [
        ...draft.routes,
        ...draft.routes.filter((route) => route.fromStepId === "pull_request_watch").map((route) => ({ ...route, fromStepId: "second_watch" })),
      ],
    });
    expect(problems.filter((problem) => problem.severity === "error").map((problem) => problem.message)).toContain(
      `"Watching again" runs "watch_pull_request", which answers "waiting" until it has a result, but "Watching again" runs once — nothing would ever ask it again, and every item would park on its first run. Turn keep checking on for "Watching again".`,
    );
  });
});
