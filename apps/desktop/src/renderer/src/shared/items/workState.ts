import { REVIEW_ACTION, runStatusKeyOf, type ItemSummary } from "@eo/core";

/**
 * How an item's work is going, as the colour its card and its step's
 * load strip wear (EO-687): owner on structure, state on work.
 *
 * Five states rather than the run status's five keys, because the board
 * asks a different question — not "what did the last run do" but "does
 * this need looking at, and by whom":
 *
 * - `danger` — failed: its last run failed or was orphaned.
 * - `paused` — waiting: its run is waiting for input, or it is waiting on
 *   you (`needsAttention`). Amber means only "this lands with a person".
 * - `reviewing` — in review: it stands on a step that runs the review
 *   action. The action is the key, not the step's name or its owner,
 *   for the reason the amendment guard gives (`itemGuards.ts`): a `qa`
 *   step that reviews is still a review.
 * - `running` — its run is running or queued.
 * - `idle` — none of those.
 *
 * Earlier in that list wins, so a failed review reads failed.
 */
export type WorkState = "danger" | "paused" | "reviewing" | "running" | "idle";

/** The order a load strip and its summary read in: what needs looking at first. */
export const WORK_STATES: readonly WorkState[] = ["danger", "paused", "reviewing", "running", "idle"];

/** What each state is called in a column's summary: "1 failed", "2 waiting". */
export const WORK_STATE_WORDS: Readonly<Record<WorkState, string>> = {
  danger: "failed",
  paused: "waiting",
  reviewing: "in review",
  running: "running",
  idle: "idle",
};

/** A state's colour as a fill, written out whole so Tailwind finds each. */
export const WORK_STATE_FILL: Readonly<Record<WorkState, string>> = {
  danger: "bg-danger",
  paused: "bg-paused",
  reviewing: "bg-reviewing",
  running: "bg-running",
  idle: "bg-idle",
};

/** The step an item stands on, as far as its state needs to know. */
export interface WorkStep {
  entryAction: string | null;
}

export function workStateOf(item: Pick<ItemSummary, "latestRunStatus" | "needsAttention">, step: WorkStep | null): WorkState {
  const run = runStatusKeyOf(item.latestRunStatus);
  if (run === "failed") return "danger";
  if (run === "paused" || item.needsAttention) return "paused";
  if (step?.entryAction === REVIEW_ACTION) return "reviewing";
  if (run === "running") return "running";
  return "idle";
}

/** How many of a column's items are in each state, in strip order; states with none are left out. */
export function workLoad(states: readonly WorkState[]): { state: WorkState; count: number }[] {
  return WORK_STATES.map((state) => ({ state, count: states.filter((each) => each === state).length })).filter(({ count }) => count > 0);
}
