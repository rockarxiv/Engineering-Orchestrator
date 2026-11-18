import type { Db } from "./client.js";

/**
 * Databases whose write announcements are being held back (EO-833),
 * counted so a hold inside a hold ends with the outer one.
 */
const holds = new WeakMap<Db, number>();

/**
 * Runs `work` with every write announcement on `db` dropped — comments,
 * moves, pins, mentions, assignments, side calls, attachments, version
 * moves and watches: everything in `db/*Events.ts`.
 *
 * For work done inside a transaction that is always rolled back, to ask
 * what a write would do (`designTrialProblem`). Every one of those
 * announcements is about a row that will never exist, and a listener
 * told of one acts on it at once — the engine announces the item to the
 * renderer, the trial loop wakes the assistant and tells the engine there
 * is work, the record's queue enqueues a command. So nobody is told.
 *
 * Synchronous only: the hold ends when `work` returns or throws.
 */
export function withEventsHeld<T>(db: Db, work: () => T): T {
  holds.set(db, (holds.get(db) ?? 0) + 1);
  try {
    return work();
  } finally {
    const left = (holds.get(db) ?? 1) - 1;
    if (left === 0) holds.delete(db);
    else holds.set(db, left);
  }
}

/** Whether announcements on `db` are being dropped. Asked by every `notify…` in `db/*Events.ts`. */
export function eventsHeld(db: Db): boolean {
  return holds.has(db);
}
