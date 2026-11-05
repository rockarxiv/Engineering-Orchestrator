import type { Transition } from "@eo/core";
import type { Db } from "./client.js";

/**
 * A move, as written (EO-324, `ARCHITECTURE.md`,
 * "The record").
 *
 * The audit row plus the one thing it deliberately has no column for.
 * A step belongs to exactly one pipeline, so from-step and to-step
 * already say where the item left and where it arrived — but a command
 * travelling to a record has to *name* the destination pipeline, because
 * the record checks the pair rather than believing it (EO-57). So the
 * caller's `toPipelineId` is carried here beside the row.
 */
export interface AppliedTransition extends Transition {
  toPipelineId: string | null;
  /**
   * The declared result the move was made on, where the caller knew it
   * (EO-586, `TransitionItemInput.resultKey`). Never written and never
   * sent to the record: it is for this machine's listeners, which could
   * not otherwise tell which of two routes to the same step was taken.
   */
  resultKey?: string | null;
}

export type TransitionListener = (transition: AppliedTransition) => void;

/**
 * Who wants to know that an item moved.
 *
 * `commentEvents.ts`'s arrangement, for `commentEvents.ts`'s reason,
 * and the doc comment there is worth reading beside this one: *"hand-
 * placed announcements are exactly the bug class being fixed here, so
 * this is one subscription covering every writer, present and future."*
 *
 * The same argument settles this story's version of it. A desktop signed
 * in to an organisation has to send every move it makes to the record as
 * a command — a drag, a decision on a human step, the route an agent's
 * result took at the end of a run. Threading a record object through all
 * of those would work until somebody added the next one, and what a
 * missed call site produces is the worst failure this phase has: a
 * person's move that looks applied, is never sent, and is silently not
 * what the organisation's board says.
 *
 * So it is hooked at the write instead. `transitionItem` is the only
 * function in the codebase that may move an item — invariant #1, proved
 * by `architecturalInvariants.test.ts` rather than trusted — which makes
 * it the one place where "a move happened" is knowable, and makes
 * bypassing this structurally impossible rather than merely unlikely.
 *
 * Keyed on the `Db` instance rather than module-global, exactly as the
 * comment listeners are: one test's in-memory database must not fire
 * another's, and a `WeakMap` lets a database and its listeners be
 * collected together.
 */
const listeners = new WeakMap<Db, Set<TransitionListener>>();

export function onTransitionApplied(db: Db, listener: TransitionListener): () => void {
  const existing = listeners.get(db) ?? new Set<TransitionListener>();
  existing.add(listener);
  listeners.set(db, existing);

  return () => {
    existing.delete(listener);
  };
}

/**
 * Announces a move. Called by `transitionItem`, and nowhere else.
 *
 * After its transaction, never inside it: a listener queues a command
 * for the record, and a command queued for a move that then rolled back
 * would be this device telling the organisation about something that
 * did not happen.
 *
 * A listener that throws is logged and skipped. Telling the record about
 * a move must never be able to take down the thing that made it — the
 * move is already durable, and the next drain finds the queue either
 * way.
 */
export function notifyTransitionApplied(db: Db, transition: AppliedTransition): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(transition);
    } catch (error) {
      console.error("[eo] a transition listener threw:", error);
    }
  }
}
