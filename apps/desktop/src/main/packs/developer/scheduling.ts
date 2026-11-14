import { acceptanceCriteriaOf, gitStateOf, REVIEW_ACTION, type PipelineStep, type Item, type Uuid } from "@eo/core";
import type { DispatchGate } from "@eo/engine";
import type { Db } from "../../db/client.js";
import { finishedItemIds, getItem, getItemType } from "../../db/repos/index.js";
import type { GateRefusal } from "../../supervisor/dispatchBlockers.js";

/** The builtin that opens an item's pull request; the action the second rule is keyed on. */
const OPEN_PULL_REQUEST_ACTION = "open_pull_request";

/**
 * What the developer pack requires of a step before it will run
 * (EO-213, KAN-161).
 *
 * The first rule: a step that judges an item needs something to judge it
 * against. EO-204 is what it cost unsaid — eleven rejections and
 * thirteen implementation runs on an item that declared no criteria,
 * because a review dispatched with nothing to check reads the thread and
 * invents a list, and EO-200's coverage check then has nothing to hold
 * that list to.
 *
 * Keyed on the *action*, like `refuseIfUntouchable` and for its reasons:
 * a step id is a slug that stops matching the moment a second pipeline
 * exists, an owner role misses the architect's own `qa`-step example,
 * and any step that runs `review` is judging the item against its
 * criteria whatever it is called and whoever owns it.
 *
 * A pack's rule rather than the engine's because "acceptance criteria"
 * is this pack's shape for what a result is judged against, and a pack
 * about weekly reports has a different one or none.
 *
 * **Built with the database**, because *which field* holds them is the
 * item type's to say since KAN-147. Without the shape this asks every
 * item for an `acceptance_criteria`, which a type whose bar is called
 * something else has never had — so it would turn away every review of
 * one, for good, while the refusal `missingCriteriaRefusal` posts reads
 * the field the type actually declares. The two have to agree or a
 * person does exactly what the thread asks and watches nothing happen.
 *
 * The second rule (EO-781): an item whose branch is stacked on a
 * dependency's (`stackedOn`, EO-780) does not open its pull request
 * before that dependency has one. A `reached` edge releases the child
 * while the dependency is still being worked on, so the child can get to
 * `open_pull_request` first — and a pull request opened against a branch
 * the remote may not have yet, or with nothing of the dependency's
 * reviewed in front of it, is the wrong pull request. It lifts on the
 * first tick after the dependency's pull request is recorded, or once
 * the dependency finishes, whichever is first: a finished dependency
 * releases everything, as every edge does (EO-776).
 *
 * Both rules read the database and nothing else, synchronously: the gate
 * is asked on every tick, and for every card the board draws.
 */
export function createDispatchGate(db: Db): DispatchGate<GateRefusal> {
  return (item: Item, step: PipelineStep) => {
    if (step.entryAction === OPEN_PULL_REQUEST_ACTION) return pullRequestHold(db, item);
    if (step.entryAction !== REVIEW_ACTION) return null;
    const shape = getItemType(db, item.typeId)?.specShape;
    return acceptanceCriteriaOf(item, shape).length === 0 ? { kind: "no_acceptance_criteria" } : null;
  };
}

/**
 * The dependency this item's branch is stacked on, while it is not
 * finished and has no pull request recorded; null otherwise — including
 * for a dependency that has since been deleted, which nothing will ever
 * give a pull request.
 */
function pullRequestHold(db: Db, item: Item): GateRefusal | null {
  const { stackedOn } = gitStateOf(item);
  if (stackedOn === null) return null;
  const dependency = getItem(db, stackedOn.itemId as Uuid);
  if (dependency === undefined) return null;
  if (gitStateOf(dependency).pullRequest !== null) return null;
  if (finishedItemIds(db, [dependency]).has(dependency.id)) return null;
  return { kind: "dependency_pull_request_pending", dependencyKey: dependency.key };
}
