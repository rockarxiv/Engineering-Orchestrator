import type { Db } from "./client.js";
import type { ItemWatch } from "./repos/itemWatchesRepo.js";

export type WatchListener = (watch: ItemWatch) => void;

/**
 * Who wants to know that a watch changed (EO-456).
 *
 * `transitionEvents.ts`'s arrangement, and for its reason: a desktop
 * signed in to an organisation has to tell the record where every watch
 * it checks now stands, and the place that knows a watch changed is the
 * repository that wrote it — `startItemWatch` and `updateItemWatch`,
 * and nothing else. A row mirrored *from* the record is not announced,
 * which is what keeps the record's own row from being sent back to it.
 *
 * Keyed on the `Db` instance, as the comment and move listeners are.
 */
const listeners = new WeakMap<Db, Set<WatchListener>>();

export function onWatchWritten(db: Db, listener: WatchListener): () => void {
  const existing = listeners.get(db) ?? new Set<WatchListener>();
  existing.add(listener);
  listeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

/** Announces a watch this database changed. A listener that throws is logged and skipped. */
export function notifyWatchWritten(db: Db, watch: ItemWatch): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(watch);
    } catch (error) {
      console.error("[eo] a watch listener threw:", error);
    }
  }
}
