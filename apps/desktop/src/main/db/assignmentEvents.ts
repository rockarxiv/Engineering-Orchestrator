import type { Uuid } from "@eo/core";
import type { Db } from "./client.js";

/**
 * A claim, an assignment or a takeover asked of the record, announced
 * (EO-367, EO-368).
 *
 * `transitionEvents.ts`' sibling, and for the same reason: the queue
 * lives in `record/outbound.ts`, and the code that writes the
 * provisional assignee should not have to know there is a queue at all.
 * The writer says "this was asked for"; whoever keeps the record's queue
 * on this machine hears it and decides whether there is anything to send.
 *
 * Announced only for an item whose record is elsewhere. A solo desktop
 * decides a claim itself and has nothing to tell anybody, so nothing on
 * that path fires this.
 */
export type AssignmentAsked =
  | { how: "claim"; itemId: Uuid; commentId: Uuid }
  | { how: "assign"; itemId: Uuid; personId: Uuid; commentId: Uuid }
  /** A takeover (EO-368), carrying the holder the person was warned about. */
  | { how: "takeover"; itemId: Uuid; fromPersonId: Uuid; commentId: Uuid };

export type AssignmentListener = (asked: AssignmentAsked) => void;

const listeners = new WeakMap<Db, Set<AssignmentListener>>();

export function onAssignmentAsked(db: Db, listener: AssignmentListener): () => void {
  const existing = listeners.get(db) ?? new Set<AssignmentListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

export function notifyAssignmentAsked(db: Db, asked: AssignmentAsked): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(asked);
    } catch (error) {
      console.error("[eo] an assignment listener threw:", error);
    }
  }
}
