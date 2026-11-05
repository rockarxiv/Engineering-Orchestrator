import type { PipelineStep, StepRoute, Uuid } from "@eo/core";
import { TERMINAL_TARGET, USER_ATTENTION_TARGET } from "@eo/core";

/**
 * Where a step's result sends an item (KAN-54).
 *
 * `stay` is not "nothing happened" — it is "this result has nowhere to go",
 * which the caller must turn into a question for the human rather than an
 * item quietly sitting still (invariant #8, and KAN-55 does exactly that).
 *
 * A `step` outcome names the pipeline the destination belongs to as well
 * as the step, because since EO-58 that is not always the pipeline the
 * item is on. The caller needs both to perform the move: writing the
 * step without the pipeline is precisely the half-moved item the
 * scheduler cannot see, since it resolves a step as
 * `stepsByPipeline.get(item.pipelineId)?.get(item.stepId)` and gets
 * nothing back.
 */
export type RouteOutcome =
  | { kind: "step"; stepId: string; pipelineId: Uuid }
  | { kind: "user_attention"; label: string | null }
  | { kind: "stay"; reason: "no_route" | "no_terminal" };

export interface ResolveRouteInput {
  /** The step the item is on — the one whose result we are routing. */
  step: PipelineStep;
  /** Every step of that step's pipeline, so `terminal` and position fallback resolve. */
  steps: PipelineStep[];
  /** Every route of that pipeline. Only those leaving `step` are discussioned. */
  routes: StepRoute[];
  /** What the agent returned. Null when the step declares nothing to choose between. */
  result: string | null;
  /**
   * The steps of the other pipelines this one may hand work to (EO-58).
   *
   * Data rather than a lookup, because `packages/engine` is pure
   * (invariant #2) — routing cannot go and read which pipeline a target
   * belongs to, so it is told. Optional and empty by default: a caller
   * that hands work to nobody resolves exactly as it always did, and a
   * caller that was not given the steps elsewhere leaves such a route
   * unresolved rather than moving an item somewhere it cannot describe.
   */
  stepsElsewhere?: PipelineStep[];
}

/**
 * Resolves one step result to its target.
 *
 * Pure, and deliberately so (invariant #2): given the steps, the routes and
 * a result key it returns where to go, with no DB and no knowledge of what
 * any particular role means. This is what replaced `resolveNextState`'s
 * chain of role-specific branches over two positional helpers plus the
 * literals `ready_to_merge`, `todo` and `pending_approval` — those assumed
 * the one shipped pipeline's slugs, so a second pipeline would have routed
 * items into states that did not exist in it.
 */
export function resolveRoute(input: ResolveRouteInput): RouteOutcome {
  const { step, steps, routes, result, stepsElsewhere = [] } = input;

  const outgoing = routes.filter((route) => route.fromStepId === step.id).sort((a, b) => a.position - b.position);

  // A step that declares no results has nothing to choose between — the
  // `source` step that prepares a workspace is the shipped example. It
  // walks to the next step by position, which is the old generic rule kept
  // for exactly the case it was always right for.
  if (outgoing.length === 0) return nextByPosition(step, steps);

  // One declared result and no answer: the step had nothing to ask, so
  // take its only way out rather than demanding the agent echo it back.
  const matched = result === null ? (outgoing.length === 1 ? outgoing[0] : undefined) : outgoing.find((route) => route.resultKey === result);

  // An unmatched key is a configuration gap, not a routing decision.
  // Guessing here — falling through to the next position, say — is how a
  // rejected review would silently look like an approved one.
  if (!matched) return { kind: "stay", reason: "no_route" };

  if (matched.target === USER_ATTENTION_TARGET) return { kind: "user_attention", label: matched.label };

  if (matched.target === TERMINAL_TARGET) {
    // Deliberately `steps` alone, never `stepsElsewhere`: `terminal` means
    // "finished here", so it resolves against the pipeline the item is
    // on, not one a sibling route happens to hand work to.
    const terminal = steps.filter((candidate) => candidate.isTerminal).sort((a, b) => a.position - b.position)[0];
    return terminal ? arriveAt(terminal) : { kind: "stay", reason: "no_terminal" };
  }

  // A target is a step of this pipeline or — since EO-58 — a step of
  // another, which is how one pipeline hands work to the next: a story
  // finishes Delivery with a pull request open and merging belongs to a
  // pipeline of its own. This pipeline is searched first, so a caller
  // that passes more steps than it needs to cannot change where a route
  // that already resolved goes.
  //
  // A target naming no step it was given is still a stay.
  // `validatePipeline` refuses one that resolves nowhere at save time;
  // reaching it at runtime means the graph was edited around that check,
  // and stopping beats moving an item to a step nothing can dispatch.
  const target = steps.find((candidate) => candidate.id === matched.target) ?? stepsElsewhere.find((candidate) => candidate.id === matched.target);
  return target ? arriveAt(target) : { kind: "stay", reason: "no_route" };
}

/** Both halves of a destination, since the step alone no longer says where it is. */
function arriveAt(step: PipelineStep): RouteOutcome {
  return { kind: "step", stepId: step.id, pipelineId: step.pipelineId };
}

function nextByPosition(step: PipelineStep, steps: PipelineStep[]): RouteOutcome {
  const next = steps.filter((candidate) => candidate.position > step.position).sort((a, b) => a.position - b.position)[0];
  return next ? arriveAt(next) : { kind: "stay", reason: "no_route" };
}

/** The result keys a step declares, in the order the configuration screen shows them. */
export function declaredResults(stepId: string, routes: StepRoute[]): StepRoute[] {
  return routes.filter((route) => route.fromStepId === stepId).sort((a, b) => a.position - b.position);
}
