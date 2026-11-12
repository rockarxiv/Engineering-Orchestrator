import type { JobSummary, ModuleView, WatchTrigger } from "@eo/core";
import { blankWatch, type JobDraft } from "../../../shared/jobs/draft";
import { whenOf } from "../../../shared/jobs/format";
import { useModules } from "../../../query/hooks";
import { Field, Select, Switch, TextInput } from "../../kit";
import { ItemKeyLink } from "../inbox/references";

/**
 * A watch job's own surface (EO-754, ARCHITECTURE.md §9.1): the fields
 * that set one up on the Job form, and the lines on the Job page that
 * say how its checks are going. What it filed and what was refused is
 * the webhook's Events tab (`JobEvents`), not a list of its own.
 */

/**
 * The modules a watch job may name: approved, and declaring `watch: true`
 * — the two of `watchTriggerProblem`'s refusals a picker can avoid
 * offering. Archived ones are not in `modules:list` at all.
 */
export function watchModules(modules: ModuleView[]): ModuleView[] {
  return modules.filter((module) => module.approvedAt !== null && module.manifest.watch === true);
}

/**
 * The module, one field per input it declares, the interval and the
 * switch. Part of the form: nothing changes until Save.
 *
 * An input a person has not touched is left out of the trigger rather
 * than written as its default, so the module's own default applies and a
 * job opened and saved unchanged writes back exactly what it was.
 */
export function WatchFields({ draft, onChange }: { draft: JobDraft; onChange: (next: JobDraft) => void }) {
  const modules = useModules();
  const watch = draft.watch ?? blankWatch();
  const offered = watchModules(modules.data?.modules ?? []);
  const chosen = (modules.data?.modules ?? []).find((module) => module.id === watch.moduleId);
  const setWatch = (next: WatchTrigger) => onChange({ ...draft, watch: next });
  const setInput = (name: string, value: string | number | boolean | undefined) => {
    const inputs = { ...watch.inputs };
    if (value === undefined) delete inputs[name];
    else inputs[name] = value;
    setWatch({ ...watch, inputs });
  };

  return (
    <>
      <Field
        label="Module"
        hint={
          offered.length === 0 && !modules.isLoading
            ? "No approved module declares watch: true yet. Approve one under Settings → Modules."
            : "Approved modules that declare watch: true. It runs on this machine while EO is open."
        }
      >
        <Select value={watch.moduleId} onChange={(event) => setWatch({ ...watch, moduleId: event.target.value, inputs: {} })}>
          <option value="">Pick one</option>
          {offered.map((module) => (
            <option key={module.id} value={module.id}>
              {module.name}
            </option>
          ))}
          {/* The job's own module, when it is no longer one the picker would offer: shown as it is rather than as a blank. */}
          {watch.moduleId === "" || offered.some((module) => module.id === watch.moduleId) ? null : (
            <option value={watch.moduleId}>{chosen === undefined ? `${watch.moduleId} (not installed)` : `${chosen.name} (cannot watch)`}</option>
          )}
        </Select>
      </Field>

      {chosen === undefined
        ? null
        : Object.entries(chosen.manifest.inputs).map(([name, declared]) => {
            const value = watch.inputs[name];
            const fallback = declared.default ?? null;
            const hint = [declared.description, fallback === null ? "No default." : `Default: ${String(fallback)}.`].filter(Boolean).join(" ");
            if (declared.type === "boolean") {
              return (
                <Switch
                  key={name}
                  label={name}
                  description={hint}
                  checked={typeof value === "boolean" ? value : fallback === true}
                  onChange={(next) => setInput(name, next)}
                />
              );
            }
            return (
              <Field key={name} label={name} hint={hint}>
                <TextInput
                  type={declared.type === "number" ? "number" : "text"}
                  placeholder={fallback === null ? undefined : String(fallback)}
                  value={value === undefined || value === null ? "" : String(value)}
                  onChange={(event) => {
                    const text = event.target.value;
                    if (text === "") setInput(name, undefined);
                    else setInput(name, declared.type === "number" ? Number(text) : text);
                  }}
                />
              </Field>
            );
          })}

      <Field label="Check every (minutes)" hint="Counted from the end of its last check.">
        <TextInput type="number" min={1} value={watch.everyMinutes} onChange={(event) => setWatch({ ...watch, everyMinutes: Number(event.target.value) })} />
      </Field>

      <Switch
        label="Wait while an item it filed is still open"
        description="No check runs until the last item it filed has finished or been archived."
        checked={watch.waitWhileOpen}
        onChange={(next) => setWatch({ ...watch, waitWhileOpen: next })}
      />
    </>
  );
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
