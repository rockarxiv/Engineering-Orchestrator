import type { Db } from "../db/client.js";
import { emitPush } from "../ipc/push.js";
import { startInterval } from "../schedule/interval.js";
import { sweepArchive, type SweepResult } from "./sweep.js";

/**
 * Once a day. The thing being measured is two weeks long, so checking
 * more often buys nothing, and an item that qualifies at 3am can wait
 * until someone is awake to not see it.
 */
const DAILY_MS = 24 * 60 * 60 * 1000;

export interface ArchiveScheduleOptions {
  intervalMs?: number;
  onSwept?: (result: SweepResult) => void;
}

/**
 * What the running app does with a sweep's result: says so in the log,
 * and tells every open window its items have changed (EO-384).
 *
 * The push is the part that matters. A swept item leaves `items:list`,
 * and nothing else about a sweep reaches a renderer — no transition, no
 * comment — so without it the chat rail went on counting finished work
 * the archive had already taken until something unrelated refetched.
 * Only when something was archived: the sweep runs at every launch, and
 * a refetch for a sweep that moved nothing is noise.
 *
 * Here rather than inline in `startMain`, so the sweep and the push are
 * tested as the one path they are.
 */
export function announceSweep(result: SweepResult): void {
  if (result.archived === 0) return;
  console.log(`[eo] archived ${result.archived} finished ticket(s)`);
  emitPush("items:changed", {});
}

/**
 * Sweeps at launch and then daily (KAN-33).
 *
 * At launch as well as on the timer, because a desktop app that is
 * closed every evening would otherwise never reach the timer at all —
 * the same reason `releaseStaleWorktrees` runs at boot.
 *
 * Returns a stop function. The timer is unref'd, so it never holds the
 * process open on its own.
 */
export function startArchiveSweep(db: Db, options: ArchiveScheduleOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DAILY_MS;
  // The loop itself is `schedule/interval.ts` (EO-303): the launch tick,
  // the non-overlap flag, the unref and the stop are all there, and what
  // is left here is what a sweep is. Tidying must never be the reason
  // the app fails to start, and the shared loop's own catch is what
  // holds that — a sweep that throws is logged as `archive sweep failed`
  // and the timer carries on.
  const loop = startInterval({
    name: "archive sweep",
    tick: () => {
      options.onSwept?.(sweepArchive(db));
    },
    readIntervalMs: () => intervalMs,
  });
  return loop.stop;
}
