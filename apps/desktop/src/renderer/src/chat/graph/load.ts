import type { ItemSummary } from "@eo/core";
import { workStateOf, WORK_STATES, type WorkState, type WorkStep } from "../../shared/items/workState";

/**
 * What stands on a step, by the state of its work (EO-686): the load
 * strip along a graph step's bottom edge. Owner on structure, state on
 * work — the strip is the work, so it is drawn in the state colours.
 *
 * The state is the board's own (`workStateOf`, EO-687), so a graph step's
 * strip and its board column's strip never disagree about the same items.
 */
export type StepLoad = Partial<Record<WorkState, number>>;

/** Everything on a step, whatever its state. */
export function loadTotal(load: StepLoad | undefined): number {
  return load === undefined ? 0 : WORK_STATES.reduce((sum, state) => sum + (load[state] ?? 0), 0);
}

/**
 * What stands on each of a pipeline's steps now, by step id. Held work is
 * parked, not in play, and is not counted — the same items "N here" has
 * always counted.
 */
export function stepLoads(items: readonly ItemSummary[], pipelineId: string, steps: readonly (WorkStep & { id: string })[]): Map<string, StepLoad> {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const loads = new Map<string, StepLoad>();
  for (const item of items) {
    if (item.pipelineId !== pipelineId || item.heldAt !== null || item.stepId === null) continue;
    const load = loads.get(item.stepId) ?? {};
    const state = workStateOf(item, byId.get(item.stepId) ?? null);
    load[state] = (load[state] ?? 0) + 1;
    loads.set(item.stepId, load);
  }
  return loads;
}
