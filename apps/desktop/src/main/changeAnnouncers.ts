import type { RunStatus } from "@eo/core";
import { coalesceLatestPerKey, coalescePerKey } from "./coalesce.js";
import { emitPush } from "./ipc/push.js";

/**
 * How long one item's or one run's pushes are collapsed for. The same
 * window comments have always had (EO-557): long enough to fold an
 * agent's burst of writes into one refetch, short enough that the
 * trailing sweep — the push carrying the final state — is not something
 * a person waits for.
 */
export const CHANGE_PUSH_WINDOW_MS = 150;

/**
 * What the engine says when an item or a run changed (EO-557).
 *
 * Every `items:changed` the engine sends used to go out as it happened,
 * except the ones a comment caused. A run's end alone announces itself
 * three or four times in a few milliseconds — the run, the item, the
 * comment it posted, the item again from the route it took — and each
 * of those cost every window ~12 queries and cost main `listInbox`
 * through `onDomainChange`.
 *
 * - **One coalescer per item, whatever the cause.** A comment, a run
 *   ending and a module creating an item all say the same thing —
 *   "this item changed, ask again" — so they share one window. Two
 *   coalescers would let a comment and a run's end on the same item
 *   each send their own push in the same instant.
 * - **One per run for `runs:changed`**, and the sweep carries the
 *   newest status (`coalesceLatestPerKey`).
 * - **Leading edge**, like `announceComment` always was: the first
 *   change of a burst is the one somebody is waiting to see.
 *
 * `onDomainChange` is called with each push that goes out. It is not
 * coalesced here: the notifier it reaches coalesces itself, across
 * every item and run at once (`createInboxNotifier`'s `scheduleRefresh`).
 */
export function createChangeAnnouncers(onDomainChange?: () => void, windowMs = CHANGE_PUSH_WINDOW_MS) {
  const announceItem = coalescePerKey(windowMs, (itemId: string) => {
    emitPush("items:changed", { itemId });
    onDomainChange?.();
  });

  const announceRun = coalesceLatestPerKey(windowMs, (runId: string, change: { itemId: string; status: RunStatus }) => {
    emitPush("runs:changed", { runId, itemId: change.itemId, status: change.status });
    onDomainChange?.();
  });

  return {
    announceItem,
    announceRun: (runId: string, itemId: string, status: RunStatus) => announceRun(runId, { itemId, status }),
  };
}
