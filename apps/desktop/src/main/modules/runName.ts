import type { Run } from "@eo/core";
import type { Db } from "../db/client.js";
import { getModule, getStep, listPipelineSteps } from "../db/repos/index.js";

/** What naming a run reads off it: enough to tell a module's from anything else's. */
type NamedRun = Pick<Run, "agentId" | "action" | "stepId" | "provider">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `run.action` is a module's id.
 *
 * `provider` alone does not say: a refusal's placeholder and a row older
 * than the column carry none. The id's shape covers those, because
 * builtin actions are fixed names and module ids are UUIDv7.
 */
function isModuleRun(run: NamedRun): boolean {
  return run.agentId === null && (run.provider === "module" || (run.provider === null && UUID.test(run.action)));
}

/**
 * The step a module run ran on. `stepId` is null on a row older than the
 * column, and the step that names the module answers for those.
 */
function moduleStepName(db: Db, run: NamedRun): string | undefined {
  const step = run.stepId === null ? undefined : getStep(db, run.stepId);
  return (step ?? listPipelineSteps(db).find((each) => each.entryAction === run.action))?.name;
}

/**
 * A run's action as a screen shows it (EO-619): a module's name where
 * `run.action` is its id, and that action unchanged for anything else.
 * `getModule` finds an archived module too.
 */
export function runActionName(db: Db, run: NamedRun): string {
  if (!isModuleRun(run)) return run.action;
  return getModule(db, run.action)?.name ?? moduleStepName(db, run) ?? "a module";
}

/** The same run as the subject of a sentence EO writes about it, quotes included. */
export function runSubject(db: Db, run: NamedRun): string {
  if (!isModuleRun(run)) return `"${run.action}"`;
  const module = getModule(db, run.action);
  if (module !== undefined) return `"${module.name}"`;
  const stepName = moduleStepName(db, run);
  return stepName === undefined ? "A module" : `The module on "${stepName}"`;
}
