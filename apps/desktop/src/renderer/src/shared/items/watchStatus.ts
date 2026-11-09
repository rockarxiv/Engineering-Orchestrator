import { itemWatchLines, runStatusKeyOf, type ItemSummary } from "@eo/core";

/**
 * What a card's status line says about an item on a step that keeps
 * checking (EO-699), in place of the run status.
 *
 * A watching item spends nearly all its time between checks, and a check
 * that comes back `waiting` ends as a succeeded run, so the run status
 * alone reads "Done" on work that is still going on. This reads the watch
 * instead: when it checks next, when it last checked, and whether checks
 * are failing.
 *
 * - `waiting` — between checks: a clock, "Next check in 4h".
 * - `checking` — a check is in flight, or one is due and EO is about to
 *   run it: the running dot, "Checking now". A check only has a run of its
 *   own once it has something to record, so a due check is read as one in
 *   flight rather than as a negative countdown.
 * - `failing` — the last check failed: the amber dot, "Check failed ·
 *   retrying in 5m".
 *
 * `label` and `detail` are each one line; `title` carries the full times.
 */
export interface WatchStatus {
  kind: "waiting" | "checking" | "failing";
  label: string;
  detail: string;
  title: string;
}

const MINUTE = 60_000;

/**
 * Null where the card keeps its run status: an item not watching, one
 * somebody has held, and one whose run waits on a person — a watch that
 * gave up parks the item and asks, and that is what its card should say.
 */
export function watchStatusOf(item: Pick<ItemSummary, "watch" | "latestRunStatus" | "heldAt">, now: number): WatchStatus | null {
  const watch = item.watch;
  if (watch == null || item.heldAt !== null) return null;
  const run = runStatusKeyOf(item.latestRunStatus);
  if (run === "paused") return null;

  const title = itemWatchLines(watch).join("\n");
  const failures = watch.consecutiveFailures;
  const lastCheck =
    watch.lastCheckedAt === null ? "Not checked yet" : `Last check ${agoWords(now - watch.lastCheckedAt)} · ${failures > 0 ? "failed" : "OK"}`;
  const due = watch.nextCheckAt <= now;

  if (run === "running" || (due && failures === 0)) return { kind: "checking", label: "Checking now", detail: lastCheck, title };
  if (failures > 0) {
    return {
      kind: "failing",
      label: `Check failed · retrying ${due ? "now" : `in ${untilWords(watch.nextCheckAt - now)}`}`,
      detail: `${failures === 1 ? "Failed once" : `${failures} in a row`}${watch.lastError === null ? "" : ` · ${watch.lastError}`}`,
      title,
    };
  }
  return { kind: "waiting", label: `Next check in ${untilWords(watch.nextCheckAt - now)}`, detail: lastCheck, title };
}

/**
 * How long until, in the card's coarse units — `3m`, `4h`, `2d`. Minutes
 * round up, so a check 30 seconds away reads "1m" rather than "0m".
 */
export function untilWords(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How long ago, in the same units as the card's corner time: "20h ago", or "just now" inside a minute. */
function agoWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`} ago`;
}
