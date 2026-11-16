import { useState, type ReactNode } from "react";
import { WAITING_RESULT, type JobSummary, type JobWatchCheckRow, type ModuleView, type WatchTrigger } from "@eo/core";
import { NOTHING, durationOf, whenOf } from "../../../shared/jobs/format";
import { Button, EmptyState } from "../../kit";
import { ItemKeyLink } from "../inbox/references";

/**
 * A watch job's own surface (EO-754, ARCHITECTURE.md §9.1): what it was
 * set up with, the lines on the Job page that say how its checks are
 * going, and the Checks tab listing every check it ran (EO-800). What it
 * filed and what was refused is the webhook's Events tab (`JobEvents`),
 * not a list of its own.
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

/** What the failed answer is called, as `job_watch_checks.answer` stores it. */
const FAILED_ANSWER = "failed";

/**
 * Every check the job ran, newest first (EO-800): when, how long, what
 * it answered, its detail or error, how many findings it reported and
 * the items it filed. A row opens to show the module's output.
 */
export function WatchChecks({
  checks,
  timeZone,
  hasOlder,
  loadingOlder,
  onOlder,
}: {
  checks: readonly JobWatchCheckRow[];
  timeZone?: string | undefined;
  hasOlder: boolean;
  loadingOlder: boolean;
  onOlder: () => void;
}) {
  return (
    <section aria-label="Check history" className="flex min-w-0 flex-col gap-2">
      {checks.length === 0 ? (
        <EmptyState title="It has not checked yet." />
      ) : (
        <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
          {checks.map((check) => (
            <WatchCheckRow key={check.id} check={check} timeZone={timeZone} />
          ))}
        </ul>
      )}
      {hasOlder ? (
        <div>
          <Button size="sm" variant="ghost" onClick={onOlder} disabled={loadingOlder}>
            Older checks
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function answerLine(check: JobWatchCheckRow): string {
  if (check.answer === WAITING_RESULT) return "Waiting";
  if (check.answer === FAILED_ANSWER) return "Failed";
  return `Answered ${check.answer}`;
}

function WatchCheckRow({ check, timeZone }: { check: JobWatchCheckRow; timeZone?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const detail = check.detail.trim();
  const failed = check.answer === FAILED_ANSWER;
  return (
    <li aria-label={`Check at ${whenOf(check.startedAt, timeZone)}`} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={failed ? "text-[13px] text-danger" : "text-[13px] text-ink"}>{answerLine(check)}</span>
          {detail === "" ? null : <span className="whitespace-pre-wrap text-[12px] leading-snug text-ink-muted">{detail}</span>}
          <span className="text-[11px] text-ink-subtle">{whenOf(check.startedAt, timeZone)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-ink-subtle">
          <span title="Findings">{check.findingCount === 1 ? "1 finding" : `${check.findingCount} findings`}</span>
          {check.filedItems.length === 0 ? (
            <span title="Filed">{NOTHING}</span>
          ) : (
            check.filedItems.map((item) =>
              item.key === null ? (
                <span key={item.id} title="Filed, since deleted">
                  deleted
                </span>
              ) : (
                <ItemKeyLink key={item.id} itemKey={item.key} itemId={item.id} />
              ),
            )
          )}
          <span title="Duration">{durationOf(check.endedAt - check.startedAt)}</span>
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
            Output
          </Button>
        </div>
      </div>
      {open ? (
        check.output === "" ? (
          <p className="text-[12px] text-ink-subtle">The module wrote no output.</p>
        ) : (
          <pre aria-label="Output" className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-canvas-raised p-2 font-mono text-[11.5px] text-ink">
            {check.output}
          </pre>
        )
      ) : null}
    </li>
  );
}
