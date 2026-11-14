import type { Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getGitWorkspace, getPipeline, getStep, listRoutesForPipeline, listStepsForPipeline } from "../../../db/repos/index.js";

/** The action whose step writes a dependency's branch, in the developer pack's pipelines. */
const IMPLEMENT_ACTION = "implement";

/**
 * A warning, not a refusal, for a `reached` edge whose step a dependency
 * can arrive at before anything has been implemented (EO-780).
 *
 * In a git repository an item released by a `reached` edge is cut from
 * its dependency's branch (`stacksOn`). Releasing it at a step the
 * dependency can reach from its pipeline's entry without passing a step
 * that implements — its first column, or the implement step itself —
 * releases it while that branch holds nothing, so it is cut from what is
 * effectively the base and stacked on work that has not been written.
 * That can be what a person wants, so the edge is still written; the
 * warning says what it will mean, in the answer and on the item.
 *
 * Null where it does not apply: an item not in a git repository, a
 * dependency in another one (no stacking across repositories), or a step
 * that cannot be reached without implementing first.
 */
export function reachedGateWarning(db: Db, item: Item, dependency: Item, stepId: string): string | null {
  if (item.workspaceId === null || dependency.workspaceId !== item.workspaceId) return null;
  if (getGitWorkspace(db, item.workspaceId) === undefined) return null;
  if (dependency.pipelineId === null) return null;
  const entry = getPipeline(db, dependency.pipelineId)?.entryStepId ?? null;
  if (entry === null || !reachableWithoutImplementing(db, dependency.pipelineId, entry, stepId)) return null;

  const step = getStep(db, stepId)?.name ?? stepId;
  return (
    `${dependency.key} can reach "${step}" without passing a step that implements, so ${item.key} may be released before ${dependency.key} ` +
    `has written anything on its branch. ${item.key} would then be cut from ${dependency.key}'s branch as it stands, and restacked onto it as it grows. ` +
    `If ${item.key} needs ${dependency.key}'s code, wait for a step after its implementation instead.`
  );
}

/**
 * Whether `target` is reachable along the pipeline's routes from `entry`
 * without leaving a step whose action is `implement`. Arriving at the
 * implement step counts as reaching it — nothing has been implemented on
 * arrival — but its routes are not followed.
 */
function reachableWithoutImplementing(db: Db, pipelineId: string, entry: string, target: string): boolean {
  const steps = new Map(listStepsForPipeline(db, pipelineId).map((step) => [step.id, step]));
  const routes = listRoutesForPipeline(db, pipelineId);
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === target) return true;
    if (steps.get(at)?.entryAction === IMPLEMENT_ACTION) continue;
    for (const route of routes) {
      if (route.fromStepId !== at || !steps.has(route.target) || seen.has(route.target)) continue;
      seen.add(route.target);
      queue.push(route.target);
    }
  }
  return false;
}
