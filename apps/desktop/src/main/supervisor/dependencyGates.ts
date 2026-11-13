import type { Transition, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  getItem,
  getStep,
  isFinishedOnItsVersion,
  listDependents,
  listTransitionsForItem,
  postComment,
} from "../db/repos/index.js";
import { isReplica } from "../db/recordRole.js";
import { onTransitionApplied } from "../db/transitionEvents.js";

/**
 * Says so on the waiting items when a dependency that released them goes
 * back (EO-776, EO-775).
 *
 * A `reached` edge latches: once the dependency has arrived at the step
 * the edge waits for, the waiting item is released for good, and the
 * dependency later being sent back — a reviewer returning it to
 * Implement — holds nothing again. That is the decision, and it leaves a
 * person with an item carrying on from work that is being redone. So EO
 * posts one comment on each released dependent that has not finished,
 * naming the dependency and the step it went back to. No needs-attention
 * marker, no hold: the comment is the whole of it.
 *
 * "Went back" is narrow on purpose: a move, after the dependency first
 * reached the gate step, into a step it had stood on *before* first
 * reaching it. A move on to a later step is the dependency carrying on,
 * and a move into a step it first saw after the gate is no return to
 * anything.
 *
 * Hooked at the write (`onTransitionApplied`), for the reason the record's
 * outbound queue is: every move goes through `transitionItem`, so no
 * caller can be missed. A move mirrored from the record is not announced
 * there, and a dependent this machine only mirrors is left to the record,
 * which says it once for everybody when it applies the same move.
 */
export function watchDependencyRegressions(db: Db): () => void {
  return onTransitionApplied(db, (transition) => noteDependencyRegression(db, transition));
}

/** One move of a dependency, checked against every `reached` edge waiting on it. */
export function noteDependencyRegression(db: Db, transition: Transition): void {
  const gated = listDependents(db, transition.itemId as Uuid).filter((edge) => edge.wait === "reached" && edge.waitStepId !== null);
  if (gated.length === 0) return;

  const history = listTransitionsForItem(db, transition.itemId as Uuid);
  const now = history.findIndex((row) => row.id === transition.id);
  if (now < 0) return;
  const dependency = getItem(db, transition.itemId as Uuid);
  if (!dependency) return;

  for (const edge of gated) {
    const gate = edge.waitStepId!;
    if (transition.toStepId === gate) continue;
    // Where it stood before it first reached the gate: where it started,
    // and every step it moved into on the way. Created on the gate
    // itself, it stood nowhere before it, so nothing is a return.
    const visited = new Set<string>();
    let reachedAt = -1;
    if (history[0]?.fromStepId === gate) continue;
    if (history[0]?.fromStepId) visited.add(history[0].fromStepId);
    for (let index = 0; index < history.length; index++) {
      if (history[index]!.toStepId === gate) {
        reachedAt = index;
        break;
      }
      visited.add(history[index]!.toStepId);
    }
    // Not released by an arrival before this move, or not a return.
    if (reachedAt < 0 || reachedAt >= now || !visited.has(transition.toStepId)) continue;

    const dependent = getItem(db, edge.itemId);
    if (!dependent || isFinishedOnItsVersion(db, dependent) || isReplica(db, dependent.id)) continue;
    const gateName = getStep(db, gate)?.name ?? "the step it was waiting for";
    const stepName = getStep(db, transition.toStepId)?.name ?? transition.toStepId;
    postComment(db, {
      itemId: dependent.id,
      author: { type: "engine" },
      body:
        `${dependency.key} has gone back to "${stepName}", a step it was on before it first reached "${gateName}". ` +
        `This ticket stopped waiting for ${dependency.key} when it reached "${gateName}", so it carries on and is not held again — ` +
        `but what it builds on from ${dependency.key} may still change.`,
    });
  }
}
