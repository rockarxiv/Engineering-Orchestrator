import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, getItem, setSetting } from "../db/repos/index.js";

/**
 * A run somebody stopped, and the initiation that stop ended (EO-175).
 *
 * Cancelling used to be a hiccup the scheduler recovered from: the row
 * went to `cancelled`, the item had not moved, was not held and was
 * not awaiting an answer, so the very next tick offered the same step
 * again — in the same initiation — and kept offering it until the
 * attempt limit stopped it three runs later. The principle was already
 * written down one layer in, where `forcedCancellationRunIds` discards a
 * late result because whoever cancelled has been told the run stopped
 * and moving the item on what it returned would silently undo their
 * decision. This is that same reasoning surviving as far as the next
 * dispatch.
 *
 * The initiation is what it is keyed on, and that is the whole of why
 * moving an item needs nothing added here: one entry into a step is one
 * initiation (`workflowInitiationId`), so an item that is moved — by a
 * person or by a route — is an item whose next dispatch belongs to an
 * initiation this stop has never heard of. What is left is the case
 * where the item does not move: a mention names its own initiation and
 * so is never stopped either, and a resume clears the stop outright,
 * which leaves exactly the thing the story asks for — the scheduler, and
 * only the scheduler, does not pick the step up again by itself.
 */
interface Stop {
  itemId: string;
  /**
   * The initiation the cancelled run belonged to, read the same way
   * `dispatchHeld` reads its own — so "which initiation was stopped" and
   * "which initiation is this dispatch" cannot answer differently.
   */
  initiationId: string;
}

/**
 * In settings rather than in memory, because the decision outlives the
 * process that took it. A person who stops a run and quits for the day
 * has not asked EO to start it again on the next launch, and an
 * in-memory set would do exactly that.
 */
const STOPS_KEY = "engine.stopped-by-hand";

function stops(db: Db): Stop[] {
  return getSetting<Stop[]>(db, STOPS_KEY, []);
}

function write(db: Db, remaining: Stop[]): void {
  if (remaining.length === 0) clearSetting(db, STOPS_KEY);
  else setSetting(db, STOPS_KEY, remaining);
}

/**
 * Records that this item's current initiation was stopped by hand.
 *
 * One stop per item — a second cancellation on the same item is the
 * same instruction said again, not a second thing to remember — and
 * entries for items that no longer exist are dropped on the way past,
 * which is what keeps this list the size of the board rather than the
 * size of its history.
 */
export function recordStop(db: Db, itemId: Uuid, initiationId: string): void {
  const remaining = stops(db).filter(
    (stop) => stop.itemId !== itemId && getItem(db, stop.itemId as Uuid) !== undefined,
  );
  write(db, [...remaining, { itemId, initiationId }]);
}

/**
 * Is the scheduler still standing off this item?
 *
 * Asked with the initiation the dispatch would run under. A stop that
 * names a different one has been overtaken — the item moved, and the
 * initiation it was about is over — so it is dropped here rather than
 * left to accumulate: this is the moment EO learns the answer, and an
 * item that returns to the same step later returns on a *new*
 * transition, so a record kept beyond this point could only ever be
 * wrong.
 */
export function stopStands(db: Db, itemId: Uuid, initiationId: string): boolean {
  const existing = stops(db);
  const stop = existing.find((candidate) => candidate.itemId === itemId);
  if (!stop) return false;
  if (stop.initiationId === initiationId) return true;
  write(db, existing.filter((candidate) => candidate.itemId !== itemId));
  return false;
}

/**
 * A person putting the item back in the scheduler's hands.
 *
 * Resuming a hold is the one re-authorisation that leaves the item
 * exactly where it was — same step, same initiation — so it is the one
 * that has to clear the stop explicitly. A move re-authorises by being a
 * move, and a mention runs under an initiation of its own.
 */
export function clearStop(db: Db, itemId: Uuid): void {
  const existing = stops(db);
  if (!existing.some((stop) => stop.itemId === itemId)) return;
  write(db, existing.filter((stop) => stop.itemId !== itemId));
}
