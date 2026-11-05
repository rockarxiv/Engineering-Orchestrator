import { useSyncExternalStore } from "react";

/**
 * One clock for every "how long ago" on screen, ticking once a minute
 * (EO-570).
 *
 * `useNow` gives each caller an interval of its own, which is right for
 * the one run header watching a turn and wrong for a board: a thousand
 * cards would be a thousand intervals waking the renderer to redraw
 * labels that change once a minute. This is one interval, started by the
 * first label that mounts and stopped when the last one goes, and every
 * subscriber hears the same tick.
 */
const MINUTE = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let tick = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      tick += 1;
      for (const notify of listeners) notify();
    }, MINUTE);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return tick;
}

/**
 * Re-renders the caller once a minute, on the shared clock.
 *
 * The value is a tick count, not a time: a label mounted between two
 * ticks has to read the wall clock when it draws, or it would start out
 * as stale as the last tick. So a caller reads `Date.now()` itself, and
 * this is only what makes it read it again.
 */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
