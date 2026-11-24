import type { Uuid } from "@eo/core";
import type { Db } from "./client.js";
import { eventsHeld } from "./heldEvents.js";

export type TeamSessionListener = (written: { sessionId: Uuid; itemId: Uuid }) => void;

/**
 * Who wants to know that this machine changed a team session (EO-844).
 *
 * `sideCallEvents.ts`'s arrangement, for its reason: a desktop signed in to
 * an organisation reports each session it runs on a record-held item, and
 * the place that knows a session changed is `teamSessionsRepo`. A row the
 * record wrote from a device's report, or a replica mirrored from the
 * record, is not announced — that is what keeps it from being sent again.
 *
 * Keyed on the `Db` instance, as the comment and move listeners are.
 */
const listeners = new WeakMap<Db, Set<TeamSessionListener>>();

export function onTeamSessionWritten(db: Db, listener: TeamSessionListener): () => void {
  const existing = listeners.get(db) ?? new Set<TeamSessionListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

/** Announces a session this machine changed. A listener that throws is logged and skipped. */
export function notifyTeamSessionWritten(db: Db, written: { sessionId: Uuid; itemId: Uuid }): void {
  if (eventsHeld(db)) return;
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(written);
    } catch (error) {
      console.error("[eo] a team session listener threw:", error);
    }
  }
}
