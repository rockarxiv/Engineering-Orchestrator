import type { Item, PipelineStep, StepRoute, Uuid } from "@eo/core";
import type { RouteLimitHold } from "@eo/engine";
import type { Db } from "../db/client.js";
import { getStep, graphForItem, lastHumanCommentAt, latestResultArrivals, listRouteTraversals } from "../db/repos/index.js";

/**
 * Route traversal limits, the host's half (EO-921, ARCHITECTURE.md,
 * "Guardrails").
 *
 * A route may say how many times it may be taken since a person last
 * commented on the item. The count is derived, never stored: the item's
 * moves whose from-step and result key are the route's, after its newest
 * comment from a person — the rule `watchRoundTrips` counts a watch's
 * moves by. The move past the limit still happens, so whatever the step
 * said lands where it always would; the item is then held on the step it
 * arrived at (`route_limit`, in the engine's scheduler) until a person
 * says something, which starts the count again.
 *
 * Routes, not reviews: nothing here knows what the step that sent the
 * item back was. What a pack has to add about its own routes it adds
 * through `RouteLimitNote`.
 */

/** A route taken past its limit, with what the comment about it needs. */
export interface RouteOverrun {
  hold: RouteLimitHold;
  route: StepRoute;
  /** The moves counted, oldest first: the last is the one that brought the item here. */
  traversals: readonly { id: Uuid; runId: Uuid | null; ts: number }[];
}

/**
 * What a pack adds to the comment that holds an item, for a route of its
 * own (EO-921): a paragraph, or null to add nothing. The core comment is
 * complete without one.
 */
export type RouteLimitNote = (db: Db, item: Item, overrun: RouteOverrun) => string | null;

type Graph = { steps: PipelineStep[]; routes: StepRoute[] };

/**
 * Every unarchived item held by a route's traversal limit, by item id:
 * what `buildEligibilityInput` hands the scheduler.
 *
 * Only items whose newest move was made on a declared result can be held,
 * so most of a board costs one lookup and nothing more. Each graph is read
 * once per tick.
 *
 * The route is the one the move took, so it is looked up in the graph of
 * the pipeline the item left. Within one pipeline that is the item's own
 * version's, as it routes by: a move within a pipeline keeps the version.
 * A move into another pipeline rebinds the item to the destination's
 * version, whose graph has no route out of the step the item left, so
 * there the route is read from the pipeline its from-step belongs to.
 * A move does not record the version it left, so that is the source
 * pipeline's current graph — the one new work on it routes by.
 */
export function routeOverruns(db: Db, items: readonly Item[]): Map<string, RouteOverrun> {
  const held = new Map<string, RouteOverrun>();
  const candidates = new Map(items.map((item) => [item.id as string, item]));
  const graphs = new Map<string, Graph>();
  const graphOf = (bound: { pipelineId: string; pipelineVersionId: string | null }): Graph => {
    const key = `${bound.pipelineId}\u0000${bound.pipelineVersionId ?? ""}`;
    let graph = graphs.get(key);
    if (graph === undefined) graphs.set(key, (graph = graphForItem(db, bound)));
    return graph;
  };
  for (const arrival of latestResultArrivals(db)) {
    const item = candidates.get(arrival.itemId);
    if (item === undefined || item.pipelineId === null) continue;
    let graph = graphOf({ pipelineId: item.pipelineId, pipelineVersionId: item.pipelineVersionId });
    if (!graph.steps.some((step) => step.id === arrival.fromStepId)) {
      const source = getStep(db, arrival.fromStepId)?.pipelineId;
      if (source === undefined || source === item.pipelineId) continue;
      graph = graphOf({ pipelineId: source, pipelineVersionId: null });
    }
    const overrun = overrunOf(db, item, arrival, graph);
    if (overrun !== null) held.set(item.id, overrun);
  }
  return held;
}

/** The same question of one item: whether it stands where a route past its limit left it. */
export function routeOverrunFor(db: Db, item: Item): RouteOverrun | null {
  return routeOverruns(db, [item]).get(item.id) ?? null;
}

function overrunOf(db: Db, item: Item, arrival: { fromStepId: string; resultKey: string }, graph: Graph): RouteOverrun | null {
  const route = graph.routes.find((candidate) => candidate.fromStepId === arrival.fromStepId && candidate.resultKey === arrival.resultKey);
  if (route === undefined || route.traversalLimit === null) return null;
  const since = lastHumanCommentAt(db, item.id);
  const traversals = listRouteTraversals(db, item.id, route.fromStepId, route.resultKey, since);
  if (traversals.length <= route.traversalLimit) return null;
  return {
    hold: {
      fromStepId: route.fromStepId,
      fromStepName: graph.steps.find((step) => step.id === route.fromStepId)?.name ?? route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      count: traversals.length,
      limit: route.traversalLimit,
      since,
    },
    route,
    traversals,
  };
}

/**
 * The comment that holds the item (EO-921, invariant 8): which route, how
 * many times and since when, the limit, and that a reply lets it carry
 * on. Each pack's paragraph about the route follows, where it has one.
 *
 * `runs` is whether anything would be dispatched on the step it arrived
 * at. A person's step or a terminal one runs nothing by itself, so there
 * the comment does not say a run is held — only that the route went past
 * its limit and somebody should look.
 */
export function routeLimitComment(step: { name: string; runs: boolean }, overrun: RouteOverrun, packLines: readonly string[]): string {
  const { hold } = overrun;
  const since = hold.since === null ? "since this ticket was filed" : `since a person last commented, at ${new Date(hold.since).toLocaleString()}`;
  const taken = `the route "${hold.fromStepName}" → ${hold.label} has been taken ${hold.count} times ${since}, and its limit is ${hold.limit}.`;
  const said = `The move it just made has happened, so what "${hold.fromStepName}" said is above where it always is`;
  return [
    step.runs
      ? `Held before "${step.name}" runs: ${taken} ${said}; nothing runs here until somebody answers.`
      : `Held before it goes on from "${step.name}": ${taken} ${said}, and nothing runs on "${step.name}" by itself.`,
    ...packLines,
    "Reply here and it carries on from your reply, with the count starting again. Narrowing what the ticket asks for, or saying it should go on as it is, both count — or move it yourself.",
  ].join("\n\n");
}

/** The marker the hold's comment carries, so one hold is said once (`routeLimitComment`'s first words). */
export const ROUTE_LIMIT_COMMENT_PREFIX = "Held before ";
