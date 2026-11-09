import type { ItemSummary } from "@eo/core";
import type { StatusTone } from "@eo/ui";
import { runStatusOf } from "../../shared/items/status";

/**
 * What stands on a step, by the state of its work (EO-686): the load
 * strip along a graph step's bottom edge. Owner on structure, state on
 * work — the strip is the work, so it is drawn in the state colours.
 *
 * The state is the board card's own: `runStatusOf` on the item's latest
 * run, so a strip and the cards it counts never disagree. That mapping
 * has no "in review" of its own today; a `reviewing` tone, should it
 * ever give one, lands in its segment rather than being lost. A run
 * that finished, or none at all, is idle: the item is standing there.
 */
export type LoadState = "failed" | "waiting" | "reviewing" | "running" | "idle";

/** Left to right along the strip: what wants looking at first. */
export const LOAD_STATES: readonly LoadState[] = ["failed", "waiting", "reviewing", "running", "idle"];

export const LOAD_WORD: Readonly<Record<LoadState, string>> = {
  failed: "failed",
  waiting: "waiting",
  reviewing: "in review",
  running: "running",
  idle: "idle",
};

const BY_TONE: Readonly<Record<StatusTone, LoadState>> = {
  danger: "failed",
  paused: "waiting",
  warning: "waiting",
  reviewing: "reviewing",
  running: "running",
  success: "idle",
  idle: "idle",
};

/** How many items on a step are in each state. A state none is in is absent. */
export type StepLoad = Partial<Record<LoadState, number>>;

export function loadStateOf(item: Pick<ItemSummary, "latestRunStatus">): LoadState {
  return BY_TONE[runStatusOf(item.latestRunStatus).tone];
}

/** Everything on a step, whatever its state. */
export function loadTotal(load: StepLoad | undefined): number {
  return load === undefined ? 0 : LOAD_STATES.reduce((sum, state) => sum + (load[state] ?? 0), 0);
}

/**
 * What stands on each of a pipeline's steps now, by step id. Held work is
 * parked, not in play, and is not counted — the same items "N here" has
 * always counted.
 */
export function stepLoads(items: readonly ItemSummary[], pipelineId: string): Map<string, StepLoad> {
  const loads = new Map<string, StepLoad>();
  for (const item of items) {
    if (item.pipelineId !== pipelineId || item.heldAt !== null || item.stepId === null) continue;
    const load = loads.get(item.stepId) ?? {};
    const state = loadStateOf(item);
    load[state] = (load[state] ?? 0) + 1;
    loads.set(item.stepId, load);
  }
  return loads;
}
