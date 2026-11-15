import type { ReactNode } from "react";
import type { JobSummary, ModuleView, WatchTrigger } from "@eo/core";
import { whenOf } from "../../../shared/jobs/format";
import { ItemKeyLink } from "../inbox/references";

/**
 * A watch job's own surface (EO-754, ARCHITECTURE.md §9.1): what it was
 * set up with, and the lines on the Job page that say how its checks are
 * going. What it filed and what was refused is the webhook's Events tab
 * (`JobEvents`), not a list of its own.
 *
 * Read-only (EO-787): a watch job is set up and changed by the
 * assistant's cards or an outside agent's tools.
 */

/**
 * The module, each input the trigger sets, and Wait while open, as the
 * Job page's definition lists them. An input the trigger leaves out is
 * not listed: the module's own default applies.
 */
export function watchFacts(trigger: WatchTrigger, modules: readonly ModuleView[]): { term: string; value: ReactNode }[] {
  const chosen = modules.find((module) => module.id === trigger.moduleId);
  const inputs = Object.entries(trigger.inputs);
  return [
    { term: "Module", value: chosen === undefined ? `${trigger.moduleId} (not installed)` : chosen.name },
    ...(inputs.length === 0
      ? []
      : [
          {
            term: "Inputs",
            value: (
              <span className="flex flex-col">
                {inputs.map(([name, value]) => (
                  <span key={name}>
                    {name}: <code className="font-mono text-[12px]">{typeof value === "string" ? value : JSON.stringify(value)}</code>
                  </span>
                ))}
              </span>
            ),
          },
        ]),
    { term: "Wait while open", value: trigger.waitWhileOpen ? "Yes: no check runs while an item it filed is still open." : "No" },
  ];
}

/**
 * How a watch job's checks stand (EO-753's `JobWatchState`): when it
 * last checked and what it answered, when it checks next, the failures
 * and the last error while there are any, and the item it waits for.
 */
export function WatchStatus({ job }: { job: JobSummary }) {
  const state = job.watch;
  const paused = job.pausedAt !== null;
  return (
    <div aria-label="Checks" className="flex flex-col gap-1 text-[12.5px] text-ink-muted">
      <span>
        {state === null || state.lastCheckedAt === null
          ? "It has not checked yet."
          : `Last checked ${whenOf(state.lastCheckedAt)}, and answered ${state.lastAnswer ?? "nothing"}.`}
      </span>
      <span>
        {paused
          ? "Paused: it does not check again until you resume it."
          : state?.waitingForItemId
            ? "Next check once that item is finished."
            : state === null || state.nextCheckAt === null
              ? "Next check as soon as EO gets to it."
              : `Next check ${whenOf(state.nextCheckAt)}.`}
      </span>
      {state === null || state.consecutiveFailures === 0 ? null : (
        <span className="text-danger">
          {state.consecutiveFailures === 1 ? "1 failed check" : `${state.consecutiveFailures} failed checks`} in a row.
          {state.lastError === null ? "" : ` Last error: ${state.lastError}`}
        </span>
      )}
      {state?.waitingForItemId ? (
        <span>
          Waiting for{" "}
          {state.waitingForItemKey === null ? "an item it filed" : <ItemKeyLink itemKey={state.waitingForItemKey} itemId={state.waitingForItemId} />} to finish
          before it checks again.
        </span>
      ) : null}
    </div>
  );
}
