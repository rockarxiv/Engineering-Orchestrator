/**
 * One interval loop, for everything in the main process that wants to do
 * something now and then (EO-303).
 *
 * The Jira pull and the archive sweep each grew their own copy of the
 * same six lines — a non-overlap flag, an unref'd timer, a tick at
 * launch, a way to be asked to look now — and the job scheduler that
 * arrives later in this phase would have made a third. What differences
 * there were between the two copies were accidents rather than
 * decisions, which is the usual reason to have one of a thing.
 */

export interface IntervalLoopOptions {
  /**
   * What to do on each tick.
   *
   * May be synchronous or return a promise; the loop holds its
   * non-overlap flag until the promise settles, so a tick that takes
   * longer than the interval delays the next one rather than running
   * beside itself. A tick that throws — or rejects — is logged under
   * `name` and the loop carries on: a timer is never the reason the app
   * falls over.
   */
  readonly tick: () => void | Promise<void>;
  /**
   * How long until the next tick, asked again after every tick rather
   * than captured once.
   *
   * So a setting changed at 10:00 takes effect on the next tick instead
   * of the next launch. Callers with a fixed cadence return a constant
   * and lose nothing.
   */
  readonly readIntervalMs: () => number;
  /**
   * Tick once at launch as well as on the timer. Defaults to `true`.
   *
   * A desktop app closed every evening would otherwise never reach a
   * daily tick — the reason both original copies did this, and the
   * reason the original design's "a missed
   * occurrence is skipped" was overruled in review.
   */
  readonly runAtLaunch?: boolean;
  /** What this loop is called in a log line, e.g. `"archive sweep"`. */
  readonly name: string;
}

export interface IntervalLoop {
  /**
   * Tick now rather than on the next timer expiry.
   *
   * Dropped when a tick is already in flight — the same rule the timer
   * is held to, because a kick is an optimisation and never the only
   * thing carrying the work. The timer keeps its own rhythm either way:
   * a kick does not reset it.
   */
  readonly kick: () => void;
  /** Stop the timer. Idempotent, and a tick already in flight is left to finish. */
  readonly stop: () => void;
}

export function startInterval(options: IntervalLoopOptions): IntervalLoop {
  const { tick, readIntervalMs, name } = options;
  const runAtLaunch = options.runAtLaunch ?? true;

  /** The non-overlap flag. One tick at a time, whoever asked for it. */
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const failed = (error: unknown): void => {
    // Worth seeing, never worth crashing on. A network that is down now
    // will be up later, and a sweep that throws is a bug in the sweep.
    console.error(`[eo] ${name} failed:`, error);
  };

  const run = (): void => {
    if (stopped || running) return;
    running = true;
    let result: void | Promise<void>;
    try {
      result = tick();
    } catch (error) {
      // A synchronous tick is kept synchronous: the flag is down again
      // before this call returns, so a caller may kick twice in a turn.
      running = false;
      failed(error);
      return;
    }
    if (!(result instanceof Promise)) {
      running = false;
      return;
    }
    void result.catch(failed).finally(() => {
      running = false;
    });
  };

  const arm = (): void => {
    if (stopped) return;
    // A re-armed `setTimeout` rather than `setInterval`, because the
    // interval is read again each time round. Negative or NaN would arm
    // a timer Node fires immediately, and forever.
    const ms = readIntervalMs();
    timer = setTimeout(() => {
      timer = null;
      // Re-armed from the start of the tick rather than its end, so the
      // cadence is the timer's and not the tick's duration — which is
      // what `setInterval` gave the two original copies.
      run();
      arm();
    }, Number.isFinite(ms) && ms > 0 ? ms : 0);
    // Never the reason the process stays alive.
    timer.unref?.();
  };

  if (runAtLaunch) run();
  arm();

  return {
    kick: run,
    stop: (): void => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
