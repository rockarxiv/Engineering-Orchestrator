import type { Db } from "./client.js";
import type { SideCallRow } from "./repos/sideCallsRepo.js";

export type SideCallListener = (call: SideCallRow) => void;

/**
 * Who wants to know that this machine made a side call (EO-514).
 *
 * `watchEvents.ts`'s arrangement, and for its reason: a desktop signed in
 * to an organisation has to tell the record what each side call about a
 * record-held item cost, because the record's per-person budget sums its
 * own `side_calls` rows. The place that knows a call was made is
 * `recordSideCall`, and nothing else writes one for this machine. A row
 * the record wrote from a device's report is not announced, which is
 * what keeps it from being sent anywhere again.
 *
 * Keyed on the `Db` instance, as the comment and move listeners are.
 */
const listeners = new WeakMap<Db, Set<SideCallListener>>();

export function onSideCallRecorded(db: Db, listener: SideCallListener): () => void {
  const existing = listeners.get(db) ?? new Set<SideCallListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

/** Announces a side call this machine made. A listener that throws is logged and skipped. */
export function notifySideCallRecorded(db: Db, call: SideCallRow): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(call);
    } catch (error) {
      console.error("[eo] a side call listener threw:", error);
    }
  }
}
