import type { PipelineStep, Item } from "@eo/core";
import { resolveRoute } from "@eo/engine";
import type { Db } from "../db/client.js";
import { boundGraphForItem, itemEntryRefusal, listRoutesForPipeline, postComment } from "../db/repos/index.js";
import type { NextStep } from "./runSupervisor.js";

/**
 * Where a result key sends its item, and what is said when it sends it
 * nowhere (KAN-144).
 *
 * Lifted out of `roles/wiring.ts` when that file became the developer
 * pack's (ARCHITECTURE.md, "Where the seams are"). Everything here is generic — a lookup in
 * `step_routes`, a walk to a terminal, an escalation when a result has
 * no route — and none of it knows what `review` or `refine` means. What
 * the pack kept is the half that does: deriving *which* result key a
 * run produced. Both halves used to sit in one function, which is why
 * the core could not route a result without the pack's opinion about
 * what the result was.
 *
 * Null means "do not move" *and let the run finish* — a conversation
 * turn, which is not stuck and has nothing to ask about. A result no
 * route declares is the opposite: a configuration gap rather than a
 * decision, so it both comments and parks. Invariant #8 says nothing
 * drops work on the floor silently, and a question nobody has answered
 * yet has to stop the item rather than be asked again every tick.
 */
export function routeResult(
  db: Db,
  currentStep: PipelineStep,
  steps: PipelineStep[],
  result: string | null,
  item: Item,
): NextStep {
  // This pipeline's steps and routes, and — since EO-58 — the steps
  // its routes may hand work to. Both halves are still needed
  // separately: `own` is what position fallback and `terminal` walk,
  // so a step over there can only ever be reached by a route that
  // names it, never by falling off the end of this pipeline.
  //
  // Both read off the item's own version (EO-327, the original design). "An item binds
  // to the version it entered on and finishes there" is enforced here
  // more than anywhere else: this is the function that decides where a
  // result sends it, and a save published mid-flight must not be able to
  // answer that question differently from the graph the item started on.
  // For an item on the current version — which is nearly all of them —
  // `graphForItem` answers with the live rows, so nothing changes.
  const bound = boundGraphForItem(db, item);
  const own = (bound?.steps ?? steps).filter((step) => step.pipelineId === currentStep.pipelineId);
  const elsewhere = steps.filter((step) => step.pipelineId !== currentStep.pipelineId);
  const routes = bound?.routes ?? listRoutesForPipeline(db, currentStep.pipelineId);

  const outcome = resolveRoute({ step: currentStep, steps: own, routes, result, stepsElsewhere: elsewhere });

  // Both halves of the destination, because since EO-58 the pipeline
  // is not necessarily the one the item is on — and the supervisor
  // needs both to perform the move as one write.
  // And the result it was sent on, where a route of this step named it
  // (EO-586): a step that declares none falls through by position, and
  // that is no result of its own.
  if (outcome.kind === "step") {
    const refused = handOffRefusal(db, item, outcome);
    if (refused !== null) return { park: refused };
    const named = result !== null && routes.some((route) => route.fromStepId === currentStep.id && route.resultKey === result);
    return { stepId: outcome.stepId, pipelineId: outcome.pipelineId, ...(named ? { resultKey: result } : {}) };
  }

  if (outcome.kind === "user_attention") {
    const reason = `${outcome.label ?? "This step"} — the pipeline routes this result to you.`;
    askTheHuman(db, item, reason);
    // Parked, not merely unmoved: the item keeps its step (flagged in
    // place, ARCHITECTURE.md, "Needs-attention is derived") but the run ends `awaiting_input`,
    // which is what stops
    // the scheduler picking it straight back up on the next tick.
    return { park: reason };
  }

  if (outcome.kind === "stay" && outcome.reason === "no_route" && result !== null) {
    // The agent answered with something this step does not declare, so
    // there is nowhere to send it. Silence is the failure mode
    // invariant #8 exists to prevent: the item would sit still,
    // looking exactly like an agent thinking hard.
    const reason =
      `"${currentStep.name}" returned the result "${result}", which has no route configured, so the ticket has not moved. ` +
      "Ask the assistant to add a route for it, or move the ticket yourself.";
    askTheHuman(db, item, reason);
    // Parked, not merely commented on. Asking and then letting the run
    // succeed leaves the item on the very step the scheduler looks at
    // next, so the following tick dispatches it again, gets the same
    // unroutable result and asks again — a loop of runs piling
    // duplicate escalations behind a question nobody has answered yet.
    // The builtin half of this stop already parks for exactly that
    // reason; this is the agent half agreeing with it.
    return { park: reason };
  }

  return null;
}

/**
 * A route into another pipeline whose entry rules this item fails
 * (EO-610, ARCHITECTURE.md, "Entry rules"), asked with the person told.
 *
 * Answers with the reason, for the caller to park on: the item keeps its
 * step and the run ends `awaiting_input`, as a `user_attention` route
 * does. Moving on regardless would put it where it was refused, and
 * letting the run succeed would dispatch it again on the next tick.
 */
export function handOffRefusal(db: Db, item: Item, destination: { stepId: string; pipelineId: string }): string | null {
  const refused = itemEntryRefusal(db, item, destination.pipelineId, destination.stepId);
  if (refused === null) return null;
  const reason = `${refused} The item has stayed where it is. Add what is missing, then move it across.`;
  askTheHuman(db, item, reason);
  return reason;
}

/**
 * The result a run reported, when nobody has an opinion about what it
 * means (KAN-144).
 *
 * The supervisor's default, used when no installed pack's wiring claims
 * the action. It is already what the pack's own wiring does for a
 * builtin and for a module: EO ran the function itself, so the key it
 * reported is not a claim needing checking. `done` is the fallback for
 * an agent run that reported nothing in particular, which is what the
 * shipped pipeline's agent steps route on.
 *
 * This replaced a walk to the next step by position. That walk is still
 * reached — `resolveRoute` takes it for a step that declares no results
 * — but only as the routing table's own answer, rather than as a
 * separate rule that ignored the table.
 */
export function reportedResultKey(parsedResult: unknown): string {
  const reported = (parsedResult as { result?: unknown } | null)?.result;
  return typeof reported === "string" ? reported : "done";
}

/**
 * The engine's own escalation: a comment that mentions the human (ARCHITECTURE.md, "Escalation ends
 * the run").
 *
 * Posted as `engine` rather than as the agent, because the agent did not
 * ask this — the pipeline's configuration did, or the lack of it did.
 */
function askTheHuman(db: Db, item: Item, body: string): void {
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body,
    mentions: [{ type: "human" }],
  });
}
