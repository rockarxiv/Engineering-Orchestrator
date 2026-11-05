/**
 * The global concurrency slots a side call made on its own has to wait
 * for (EO-477, invariant 10).
 *
 * A side call inside a run's dispatch or settle uses that run's slot and
 * never comes here. One made on its own — consolidation, which belongs to
 * a scope and not to any run — is a model call nothing else is
 * accounting for, so it starts only when the global limit has a slot
 * free, and holds that slot until it ends: while it does, the scheduler
 * sees one slot fewer (`reserved`, which `capacityFor` and the tick's
 * `reservedSlots` subtract).
 *
 * **A waiting call is counted as well as a holding one.** With the
 * default limit of 1 and a busy board, the slot a finishing run frees
 * would otherwise go to whichever of the tick and this gate looked first,
 * and the tick runs on every state change. Counting the waiter means the
 * freed slot is the side call's, and the next run waits for it to end —
 * which is the order things asked in.
 *
 * In-process and synchronous at the moment of the decision: a slot is
 * granted by comparing two counts and incrementing one in the same turn
 * of the event loop, so no tick can slip between the check and the take.
 */
export interface SideCallSlots {
  /**
   * Waits for a free slot and takes it. Resolves with the function that
   * gives it back, or null when `signal` ended the wait first.
   */
  acquire: (signal: AbortSignal) => Promise<(() => void) | null>;
  /** Slots side calls hold, or are queued for — what a dispatch must leave free. */
  reserved: () => number;
  held: () => number;
  waiting: () => number;
  /** Something may have freed a slot (a run ended): look now rather than at the next poll. */
  poke: () => void;
}

export interface SideCallSlotsOptions {
  /** The global concurrency limit, read on every decision so a settings change applies at once. */
  limit: () => number;
  /**
   * Slots runs are using: every run queued or running, leased or not, as
   * the scheduler counts them (EO-508), and any still finishing.
   */
  busy: () => number;
  /** How often a waiting call looks again for a slot a run gave back. */
  pollMs?: number;
  /** A side call gave its slot back: what waited for it — the tick — may go now. */
  onRelease?: () => void;
}

const DEFAULT_POLL_MS = 500;

export function createSideCallSlots(options: SideCallSlotsOptions): SideCallSlots {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let held = 0;
  const queue: { grant: (release: () => void) => void }[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;

  const free = (): boolean => options.busy() + held < options.limit();

  function releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held -= 1;
      grantWaiting();
      options.onRelease?.();
    };
  }

  function grantWaiting(): void {
    while (queue.length > 0 && free()) {
      const next = queue.shift()!;
      held += 1;
      next.grant(releaser());
    }
    if (queue.length === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(null);
      // Behind anybody already waiting, so a call that arrived later
      // cannot take the slot an earlier one was owed.
      if (queue.length === 0 && free()) {
        held += 1;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve) => {
        const waiter = {
          grant: (release: () => void) => {
            signal.removeEventListener("abort", onAbort);
            resolve(release);
          },
        };
        const onAbort = () => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
          // A waiter leaving is a slot the tick may have again.
          options.onRelease?.();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
        if (timer === undefined) {
          timer = setInterval(grantWaiting, pollMs);
          timer.unref?.();
        }
      });
    },
    reserved: () => held + queue.length,
    held: () => held,
    waiting: () => queue.length,
    poke: grantWaiting,
  };
}
