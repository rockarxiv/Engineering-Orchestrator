import { acceptanceCriteriaOf, REVIEW_ACTION, type PipelineStep, type Item } from "@eo/core";
import type { DispatchGate } from "@eo/engine";
import type { Db } from "../../db/client.js";
import { getItemType } from "../../db/repos/index.js";
import type { GateRefusal } from "../../supervisor/dispatchBlockers.js";

/**
 * What the developer pack requires of a step before it will run
 * (EO-213, KAN-161).
 *
 * One rule: a step that judges an item needs something to judge it
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
 */
export function createDispatchGate(db: Db): DispatchGate<GateRefusal> {
  return (item: Item, step: PipelineStep) => {
    if (step.entryAction !== REVIEW_ACTION) return null;
    const shape = getItemType(db, item.typeId)?.specShape;
    return acceptanceCriteriaOf(item, shape).length === 0 ? { kind: "no_acceptance_criteria" } : null;
  };
}
