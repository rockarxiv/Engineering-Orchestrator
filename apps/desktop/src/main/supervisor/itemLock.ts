/**
 * One run at a time per item (EO-132).
 *
 * An item's worktree is a single checkout on disk, and two processes
 * editing it is not a clean failure — it is a diff nobody wrote. Six
 * places in EO create a run, and until this existed each of them held
 * that rule up on its own: `tick()` skipped an item with an active run,
 * `findPendingResponses` read `listActiveRuns` for itself, and
 * `resumeItem` and `dryRunModule` asked nothing at all. Every one of
 * those checks is also a read with an `await` between it and the write
 * it guards, so even where one was present it was advisory.
 *
 * So the rule is one object instead: whoever wants to work on an item
 * claims it, and a claim is a synchronous test-and-set that no await can
 * interleave with. An in-memory mutex owned by the supervisor rather
 * than a partial unique index on `runs(item_id)` — the exclusion has
 * to cover the *process*, and a row can be written long before and long
 * after the subprocess that matters exists.
 *
 * In memory means it does not survive a restart, which is why
 * `reconcile()` seeds it at boot: a run this process adopts or resumes
 * holds the item from the moment it is adopted, or the first tick
 * after boot dispatches on top of a live process.
 *
 * Deliberately *not* a queue. An acquirer that loses refuses
 * immediately and is told so; it never waits. A scheduler that could not
 * claim an item has lost nothing — the item has not moved and the
 * next tick offers it again — and a person's action that loses gets told
 * why, in `blockedByActiveRunRefusal` below, rather than silently
 * blocking on a run that may take half an hour.
 *
 * Nothing here knows what `queued` or `running` mean: the lock covers
 * exactly the span of work its holder wraps. An `awaiting_input` run is
 * a zero-work park waiting on a person, so it holds nothing — locking on
 * one would hold an item forever, and the scheduler already skips those.
 */

/**
 * Gives the item back.
 *
 * Idempotent, and it can only ever release the claim it was handed: a
 * hold called twice does not evict whoever claimed the item in
 * between.
 */
export type ItemHold = () => void;

/** What `run()` answers with: the body's value, or the fact that it never ran. */
export type ItemLockOutcome<T> =
  | { claimed: true; value: T }
  | { claimed: false };

export interface ItemLock {
  /**
   * Claim the item, or refuse. Returns the hold to release it with,
   * and `null` when somebody else has it.
   *
   * Synchronous by contract — the whole point is that no `await` can sit
   * between the test and the set.
   */
  acquire: (itemId: string) => ItemHold | null;
  /** Is anything working on this item right now? */
  isHeld: (itemId: string) => boolean;
  /**
   * Claim, run, release — releasing whatever the body does, including
   * throwing. `{ claimed: false }` means the body was never called.
   */
  run: <T>(itemId: string, body: () => Promise<T>) => Promise<ItemLockOutcome<T>>;
}

export function createItemLock(): ItemLock {
  /**
   * Item id to the token of whoever holds it. The token is what makes
   * a stale hold harmless: releasing compares before it deletes, so a
   * hold released twice — or released late, after its item has been
   * claimed by the next dispatch — cannot take the lock away from
   * somebody else.
   */
  const held = new Map<string, symbol>();

  function acquire(itemId: string): ItemHold | null {
    if (held.has(itemId)) return null;
    const token = Symbol("item hold");
    held.set(itemId, token);
    return () => {
      if (held.get(itemId) === token) held.delete(itemId);
    };
  }

  function isHeld(itemId: string): boolean {
    return held.has(itemId);
  }

  async function run<T>(itemId: string, body: () => Promise<T>): Promise<ItemLockOutcome<T>> {
    const hold = acquire(itemId);
    if (!hold) return { claimed: false };
    try {
      return { claimed: true, value: await body() };
    } finally {
      // A `finally`, so a body that throws still gives the item back.
      // Without it one failed dispatch would strand an item for the
      // lifetime of the process — the failure mode a lock with no
      // timeout has to be built not to have.
      hold();
    }
  }

  return { acquire, isHeld, run };
}

/** The condition itself, said once: what "blocked by an active run" means in words. */
export const ITEM_BUSY_REASON = "an agent is working on it right now";

/**
 * The one refusal EO gives when something is already working on an item.
 *
 * This is the `blockedByActiveRun` wording that `ticket_move`,
 * `ticket_hold` and `ticket_resume` have always answered with, lifted
 * here so that every refusal from the same condition is the same
 * sentence rather than a family resemblance. `activeRunRefusal` in the
 * MCP catalog is now a call to this, and produces exactly the string it
 * produced before.
 *
 * The shape is fixed and load-bearing, in four parts:
 *
 *   EO did not <action>: <the condition>. <what to do>. Nothing has changed.
 *
 * `action` names what was refused *and its subject*, so the sentence
 * always says which thing did not happen to the item — "move the
 * item", "run this module against this item". A refusal that left
 * the subject out would read as though EO had declined something else.
 *
 * `interrupt` is the only thing that varies, and it is an affordance
 * rather than a difference of meaning: an MCP tool can be called again
 * with `cancelActiveRun: true`, and a caller with no such option is told
 * to wait instead. Both close on "Nothing has changed", which is the
 * part a model reading this has to be able to rely on.
 */
export function blockedByActiveRunRefusal(action: string, interrupt?: { tool: string }): string {
  const remedy = interrupt
    ? `Call ${interrupt.tool} again with cancelActiveRun: true to interrupt that agent and discard what it has ` +
      "not finished, or wait for the run to end and try again."
    : "Wait for the run to end and try again.";
  return `EO did not ${action}: ${ITEM_BUSY_REASON}. ${remedy} Nothing has changed.`;
}
