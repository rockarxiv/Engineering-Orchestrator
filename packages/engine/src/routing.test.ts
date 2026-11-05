import type { PipelineStep, StepRoute, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { resolveRoute } from "./routing.js";

function step(id: string, position: number, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    pipelineId: "p1" as Uuid,
    position,
    name: id,
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated" as const,
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    results: [],
    ...overrides,
  };
}

function route(fromStepId: string, resultKey: string, target: string, position = 0): StepRoute {
  return {
    id: `${fromStepId}:${resultKey}` as StepRoute["id"],
    pipelineId: "p1" as StepRoute["pipelineId"],
    fromStepId,
    resultKey,
    label: resultKey,
    tone: "info",
    target,
    position,
  };
}

const IMPLEMENT = step("implement", 1);
const REVIEW = step("review", 2, { ownerRole: "reviewer", entryAction: "review" });
const MERGE = step("merge", 3, { type: "builtin", ownerRole: null, entryAction: null, isTerminal: true });
const STEPS = [IMPLEMENT, REVIEW, MERGE];

const ROUTES = [
  route("implement", "done", "review"),
  route("review", "approved", "merge", 0),
  route("review", "changes_requested", "implement", 1),
  route("review", "needs_user_input", "user_attention", 2),
];

/** A second pipeline, the one a finished story is handed to (EO-58). */
const MERGE_PIPELINE = [
  step("queue", 0, { pipelineId: "p2" as Uuid, ownerRole: null, entryAction: null, type: "user" }),
  step("merged", 1, { pipelineId: "p2" as Uuid, ownerRole: null, entryAction: null, type: "user", isTerminal: true }),
];

describe("resolveRoute", () => {
  it("sends a matched result to the step its route names", () => {
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "approved" })).toEqual({
      kind: "step",
      stepId: "merge",
      pipelineId: "p1",
    });
  });

  it("sends a rejection back to the step the route names, not one position back", () => {
    // The review loop, and the whole point of the graph: `changes_requested`
    // goes several positions backwards, which "one position down" could
    // never express.
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "changes_requested" })).toEqual({
      kind: "step",
      stepId: "implement",
      pipelineId: "p1",
    });
  });

  it("parks the item when the route targets the human", () => {
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "needs_user_input" })).toEqual({
      kind: "user_attention",
      label: "needs_user_input",
    });
  });

  it("stays put on a result no route declares, rather than guessing", () => {
    // Guessing — walking one position down, say — is how a rejected review
    // would silently look like an approved one. KAN-55 turns this into a
    // question for the human.
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "exploded" })).toEqual({ kind: "stay", reason: "no_route" });
  });

  it("resolves the terminal sentinel to the pipeline's terminal step", () => {
    const routes = [route("review", "approved", "terminal")];
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes, result: "approved" })).toEqual({
      kind: "step",
      stepId: "merge",
      pipelineId: "p1",
    });
  });

  it("stays put when a terminal is asked for and the pipeline has none", () => {
    const routes = [route("review", "approved", "terminal")];
    const noTerminal = [IMPLEMENT, REVIEW];
    expect(resolveRoute({ step: REVIEW, steps: noTerminal, routes, result: "approved" })).toEqual({ kind: "stay", reason: "no_terminal" });
  });

  it("walks to the next step by position when the step declares no results", () => {
    // The `source` step that scaffolds a worktree has nothing to choose
    // between, so it keeps the old generic rule.
    const source = step("worktree", 0, { type: "builtin" });
    expect(resolveRoute({ step: source, steps: [source, ...STEPS], routes: ROUTES, result: null })).toEqual({
      kind: "step",
      stepId: "implement",
      pipelineId: "p1",
    });
  });

  it("takes the only way out when one result is declared and none was returned", () => {
    expect(resolveRoute({ step: IMPLEMENT, steps: STEPS, routes: ROUTES, result: null })).toEqual({
      kind: "step",
      stepId: "review",
      pipelineId: "p1",
    });
  });

  it("refuses a target naming a step it was given nowhere", () => {
    // The validator rejects this at save time; reaching it at runtime means
    // the graph was edited around that check, and moving an item to a step
    // nothing can dispatch is worse than not moving it.
    const routes = [route("review", "approved", "a-step-that-is-in-no-pipeline")];
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes, result: "approved" })).toEqual({ kind: "stay", reason: "no_route" });
  });

  // ── Handing work to another pipeline (EO-58) ────────────────

  it("sends an item to a step in another pipeline, and says which pipeline that is", () => {
    // The case this exists for: a story finishes Delivery with a pull
    // request open, and merging belongs to a pipeline of its own. The
    // caller cannot perform the move on the step id alone — a step id
    // paired with the wrong pipeline is an item the scheduler cannot see.
    const routes = [route("review", "approved", "queue")];
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes, result: "approved", stepsElsewhere: MERGE_PIPELINE })).toEqual({
      kind: "step",
      stepId: "queue",
      pipelineId: "p2",
    });
  });

  it("stays put when the pipeline a target belongs to was not among the steps it was given", () => {
    // Same graph as above with nothing handed in: routing will not invent
    // a destination it cannot describe.
    const routes = [route("review", "approved", "queue")];
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes, result: "approved" })).toEqual({ kind: "stay", reason: "no_route" });
  });

  it("resolves terminal against the pipeline the item is on, not the one it could be sent to", () => {
    // `terminal` means "finished here". The merge pipeline has a terminal
    // step of its own and it must not win.
    const routes = [route("review", "approved", "terminal")];
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes, result: "approved", stepsElsewhere: MERGE_PIPELINE })).toEqual({
      kind: "step",
      stepId: "merge",
      pipelineId: "p1",
    });
  });

  it("still parks an item the human is asked about, whatever else is in view", () => {
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "needs_user_input", stepsElsewhere: MERGE_PIPELINE })).toEqual({
      kind: "user_attention",
      label: "needs_user_input",
    });
  });

  it("prefers its own pipeline's step to one of the same id elsewhere", () => {
    // A caller handing in everything it has must not change where a route
    // that already resolved goes.
    const shadow = step("merge", 0, { pipelineId: "p2" as Uuid });
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "approved", stepsElsewhere: [shadow] })).toEqual({
      kind: "step",
      stepId: "merge",
      pipelineId: "p1",
    });
  });

  it("discussions only the routes leaving the step being resolved", () => {
    // `implement` also declares `done`; resolving `review`'s `done` must not
    // borrow it.
    expect(resolveRoute({ step: REVIEW, steps: STEPS, routes: ROUTES, result: "done" })).toEqual({ kind: "stay", reason: "no_route" });
  });
});
