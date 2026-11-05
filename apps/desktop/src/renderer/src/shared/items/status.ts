import type { StatusTone } from "@eo/ui";
import { RUN_STATUS_LABELS, runStatusKeyOf, type RunStatusKey } from "@eo/core";

/**
 * What an item's latest run means, in one place.
 *
 * The dashboard card and the item list answer the same question — is
 * anything happening on this item — and two copies of the mapping is how
 * `awaiting_input` ends up called "Paused" on one screen and "Idle" on the
 * other. `key` is what a filter matches on; `label` and `tone` are display.
 *
 * The key half moved to `@eo/core` with EO-192: it is a filter as well as
 * a badge, and the main process has to answer "what is this list showing"
 * with the same words. The labels and the tones stay here, where the
 * screens are.
 */
export type { RunStatusKey };

export interface RunStatus {
  key: RunStatusKey;
  tone: StatusTone;
  label: string;
}

/** Every status the list offers as a filter, in the order it offers them. */
const TONES: Readonly<Record<RunStatusKey, StatusTone>> = {
  running: "running",
  paused: "paused",
  failed: "danger",
  done: "success",
  idle: "idle",
};

// The words come from `@eo/core` because the item list can be ordered
// by status, and an ordering is alphabetical over them — so the handler
// reproducing that order has to sort by the same strings (EO-192). Only
// the colours are this side's.
export const RUN_STATUSES: RunStatus[] = (["running", "paused", "failed", "done", "idle"] as const).map((key) => ({
  key,
  tone: TONES[key],
  label: RUN_STATUS_LABELS[key],
}));

const BY_KEY = new Map(RUN_STATUSES.map((status) => [status.key, status]));

/** `runs.status` as a person reads it — the shared key, with this screen's word and colour on it. */
export function runStatusOf(latestRunStatus: string | null): RunStatus {
  return BY_KEY.get(runStatusKeyOf(latestRunStatus))!;
}

/** How long ago, coarsely. Anything older than a day is only interesting in days. */
export function elapsed(ts: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
