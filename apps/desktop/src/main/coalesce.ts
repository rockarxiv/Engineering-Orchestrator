/**
 * Runs `run(key)` at most once per `windowMs` per key — leading edge,
 * with a trailing sweep.
 *
 * Leading, because the first event of a burst is the one somebody is
 * waiting to see: a purely trailing debounce would add latency to
 * exactly the case this exists to make fast. Trailing, because
 * otherwise the last event of a burst is the one that gets dropped, and
 * that is the one carrying the final state.
 *
 * A sweep opens a window of its own (EO-557). Closing the window and
 * then sweeping let a call that arrived at the boundary — the sweep of
 * another coalescer feeding this one, typically — run straight away as
 * a fresh leading edge, so the same key ran twice in one instant. Now a
 * key runs at most once per `windowMs`, and a window with nothing
 * arriving in it is the only one that closes.
 *
 * The burst that motivates it: one `items:changed` push invalidates
 * the project, the inbox, the archive *and* the repository list — and the
 * repository list stats a credentials file per repo. An import writing
 * fifty comments inside one transaction must not fire fifty of those.
 */
export function coalescePerKey<K extends string>(windowMs: number, run: (key: K) => void): (key: K) => void {
  const coalesced = coalesceLatestPerKey<K, undefined>(windowMs, (key) => run(key));
  return (key: K): void => coalesced(key, undefined);
}

/**
 * `coalescePerKey` for a call that carries something beside its key
 * (EO-557): the trailing sweep runs with the **last** value that
 * arrived during the window, not the first.
 *
 * The case that needs it is `runs:changed`, which says what status a
 * run is in. A run that starts and fails inside one window is announced
 * "running" on the leading edge and must be announced "failed" by the
 * sweep — the renderer lets go of a run's live drafts only on a status
 * that has ended, so a sweep repeating "running" would leave them on
 * screen for good.
 */
export function coalesceLatestPerKey<K extends string, V>(
  windowMs: number,
  run: (key: K, value: V) => void,
): (key: K, value: V) => void {
  /** Keys with a window currently open, and what arrived during it, if anything did. */
  const open = new Map<K, { pending: { value: V } | null }>();

  return (key: K, value: V): void => {
    const window = open.get(key);
    if (window) {
      window.pending = { value }; // sweep it up when the window closes
      return;
    }

    run(key, value);
    const state: { pending: { value: V } | null } = { pending: null };
    open.set(key, state);
    openWindow(key, state);
  };

  function openWindow(key: K, state: { pending: { value: V } | null }): void {
    const timer = setTimeout(() => {
      const swept = state.pending;
      if (swept === null) {
        open.delete(key);
        return;
      }
      // Reopened before the sweep runs, so a call it causes — or one
      // that lands in the same instant — waits for the next sweep rather
      // than running beside this one. And if `run` throws, the key is
      // still in a window that will close, not stuck open.
      state.pending = null;
      openWindow(key, state);
      run(key, swept.value);
    }, windowMs);
    // Never a reason to keep the process alive; matches the run-event
    // buffer's timer in runSupervisor.
    timer.unref?.();
  }
}
