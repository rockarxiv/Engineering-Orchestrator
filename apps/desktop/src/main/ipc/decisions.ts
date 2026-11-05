import { TERMINAL_TARGET, USER_ATTENTION_TARGET, type Item, type PipelineStep, type StepDecision, type StepResult, type StepRoute } from "@eo/core";
import { resolveRoute, type RouteOutcome } from "@eo/engine";
import type { Db } from "../db/client.js";
import { boundGraphForItem, getStep, graphForItem, listStepsElsewhere } from "../db/repos/index.js";

/**
 * Where one of a human step's results would send this item (EO-310).
 *
 * The same `resolveRoute` an agent's verdict takes, given the same
 * three things — this pipeline's steps, its routes, and the steps its
 * routes may hand work to (EO-58). That is the whole point of the
 * story: a person's answer is a *result*, resolved by the routing table
 * rather than by the person naming a column, so approving cannot mean
 * one thing on the board and another in the graph.
 *
 * The lookups are here rather than in the engine because the engine is
 * pure (invariant #2) and cannot read a pipeline; and they are in one
 * function rather than two because the button on the item detail and
 * the transition it causes must resolve identically. A button reading
 * "Approve → Post to Slack" over a route that actually goes somewhere
 * else is the failure this exists to prevent.
 */
export function resolveDecisionRoute(db: Db, item: Item, step: PipelineStep, resultKey: string): RouteOutcome {
  // The item's own version's graph (EO-327, ARCHITECTURE.md, "Publish, lock and versions"), for the
  // reason
  // `routeResult` reads one: a person's Approve on an item that entered
  // on v6 goes where v6 said it goes, and the button above it says the
  // same thing because `destinationName` asks this same function.
  const graph = graphForItem(db, item);
  return resolveRoute({ step, steps: graph.steps, routes: graph.routes, result: resultKey, stepsElsewhere: handOffTargets(db, item, step, graph.routes) });
}

/**
 * The steps of other pipelines this decision may land on (EO-58,
 * EO-327).
 *
 * `listStepsElsewhere` for everything on the current version, which is
 * every item until somebody edits a pipeline: the steps another pipeline
 * *has*, which is what a route may be drawn to and what the validator
 * judged this graph against.
 *
 * And, for an item on an older version, the steps that version's own
 * routes name and the destination has since retired. That case is
 * narrow and entirely real: pipeline B removed a step while it was
 * empty, which it was entitled to do, and an older version of pipeline A
 * still hands work to it. The supervisor's path already resolves it —
 * `routeResult` is given `listPipelineSteps`, which keeps retired rows —
 * so without this a person's Approve was refused where an agent's
 * identical verdict went through, and the item sat on a human step with
 * a button that could not be pressed.
 *
 * Deliberately not a widening of ordinary routing. Nothing is added for
 * an item on the current version, and what is added for an older one is
 * only what *that version's routes already name* — a step is reachable
 * here because this item's own graph points at it, not because it
 * exists. `transitionItem` then binds the arrival to a version of the
 * destination that has the step (`versionForArrival`), so the item lands
 * somewhere it can be dispatched from and routed out of.
 */
function handOffTargets(db: Db, item: Item, step: PipelineStep, routes: StepRoute[]): PipelineStep[] {
  const current = listStepsElsewhere(db, step.pipelineId, item.projectId);
  const bound = boundGraphForItem(db, item);
  if (bound === null) return current;

  const known = new Set([...current.map((candidate) => candidate.id), ...bound.steps.map((candidate) => candidate.id)]);
  const retired = routes.flatMap((route) => {
    // A sentinel names no step, and one already offered needs no second
    // entry; `resolveRoute` searches this pipeline's own steps first
    // either way.
    if (known.has(route.target) || route.target === TERMINAL_TARGET || route.target === USER_ATTENTION_TARGET) return [];
    known.add(route.target);
    const target = getStep(db, route.target);
    // Only another pipeline's. A retired step of *this* pipeline is in
    // `bound.steps` already — the version that routes to it has it.
    return target && target.pipelineId !== step.pipelineId ? [target] : [];
  });

  return [...current, ...retired];
}

/**
 * What the item detail offers as buttons (ARCHITECTURE.md, "The item").
 *
 * Every result the step declares, each carrying the name of where it
 * goes so the button can read "Approve → Post to Slack" without the
 * screen loading the graph. Resolved through the function above, so what
 * a person is promised and what pressing it does are one answer.
 *
 * Empty for an item on no step, on a step nobody decides on, or on a
 * human step that only ever waits — which is every human step a
 * developer's board has apart from the one the pack gives a decision to.
 */
export function decisionsFor(db: Db, item: Item, step: PipelineStep | undefined): StepDecision[] {
  if (step === undefined || step.type !== "user") return [];
  return step.results.map((result) => ({ ...result, targetName: destinationName(db, item, step, result) }));
}

/**
 * The name of where a result lands, or null when there is nothing to
 * name: a result routed to a person's attention, which is where the item
 * already is, or one whose route is missing — which `validatePipeline`
 * refuses to save and a hand-edited graph can still hold.
 */
function destinationName(db: Db, item: Item, step: PipelineStep, result: StepResult): string | null {
  const outcome = resolveDecisionRoute(db, item, step, result.key);
  if (outcome.kind !== "step") return null;
  // The item's version again, not the pipeline's: the button has to name
  // the step the press will actually reach, which on an older version can
  // be one the current graph has retired (EO-327).
  const graph = graphForItem(db, item);
  const steps = [...graph.steps, ...handOffTargets(db, item, step, graph.routes)];
  return steps.find((candidate) => candidate.id === outcome.stepId)?.name ?? null;
}
