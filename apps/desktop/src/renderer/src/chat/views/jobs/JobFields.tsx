import { JOB_TEMPLATE_BLANKS, WEEKDAY_NAMES, describeJobTrigger, qualifiedItemType } from "@eo/core";
import { blankWatch, type JobDraft } from "../../../shared/jobs/draft";
import { usePipelines, useRegistry } from "../../../query/hooks";
import { Field, Select, TextArea, TextInput } from "../../kit";
import { WatchFields } from "./Watch";

/**
 * The editable half of a job, shared by the new-job form and the job's
 * own view (EO-308, `ARCHITECTURE.md`, "The inbox, the archive and jobs"): the thing a person
 * sets up and the thing they come back to change are one set of fields.
 *
 * A webhook job states its trigger rather than offering to change it
 * (EO-333): moving to a webhook needs a path and a secret this form has
 * no business minting, and moving away from one would quietly discard an
 * address somebody's helpdesk is already configured with.
 *
 * A watch job is a kind the select offers (EO-754): its module, inputs,
 * interval and switch are all things a person sets here.
 */
export function JobFields({ draft, projectId, onChange }: { draft: JobDraft; projectId: string | null; onChange: (next: JobDraft) => void }) {
  const { pipelines } = usePipelines(projectId);
  const { registry } = useRegistry();
  const set = <K extends keyof JobDraft>(key: K, value: JobDraft[K]) => onChange({ ...draft, [key]: value });

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Field label="Name" hint="What the Jobs list shows, and what {{job}} expands to.">
        <TextInput value={draft.name} onChange={(event) => set("name", event.target.value)} />
      </Field>

      {draft.triggerKind === "webhook" && draft.webhook !== null ? (
        <Field label="Trigger" hint="Its address and its secret are above. To file work on a schedule instead, make a second job.">
          <span className="text-[13px] text-ink-muted">{describeJobTrigger(draft.webhook)}</span>
        </Field>
      ) : (
        <Field label="Trigger">
          <Select
            value={draft.triggerKind}
            onChange={(event) => {
              const kind = event.target.value as JobDraft["triggerKind"];
              // A watch draft is made the first time it is picked and kept after, as the schedule's fields are.
              onChange({ ...draft, triggerKind: kind, watch: kind === "watch" ? (draft.watch ?? blankWatch()) : draft.watch });
            }}
          >
            <option value="schedule">On a schedule</option>
            <option value="manual">Only when you run it</option>
            <option value="watch">When a module finds something</option>
          </Select>
        </Field>
      )}

      {draft.triggerKind === "watch" ? <WatchFields draft={draft} onChange={onChange} /> : null}

      {draft.triggerKind === "schedule" ? (
        <>
          <Field label="Schedule">
            <Select value={draft.scheduleKind} onChange={(event) => set("scheduleKind", event.target.value as JobDraft["scheduleKind"])}>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="cron">An expression</option>
            </Select>
          </Field>

          {draft.scheduleKind === "cron" ? (
            <Field label="Expression" hint="Five fields — minute, hour, day of month, month, day of week.">
              <TextInput className="font-mono" value={draft.expression} onChange={(event) => set("expression", event.target.value)} />
            </Field>
          ) : (
            <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-3">
              {draft.scheduleKind === "weekly" ? (
                <Field label="Day">
                  <Select value={String(draft.weekday)} onChange={(event) => set("weekday", Number(event.target.value))}>
                    {WEEKDAY_NAMES.map((name, index) => (
                      <option key={name} value={index}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label="Hour">
                <TextInput type="number" min={0} max={23} value={draft.hour} onChange={(event) => set("hour", Number(event.target.value))} />
              </Field>
              <Field label="Minute">
                <TextInput type="number" min={0} max={59} value={draft.minute} onChange={(event) => set("minute", Number(event.target.value))} />
              </Field>
            </div>
          )}

          {/* An IANA name, typed: the answer is almost always the
              machine's own, which a new job starts with, and the field is
              for the person who means another and knows its name. */}
          <Field label="Time zone" hint="An IANA name — Europe/Berlin, America/New_York. The job's zone governs, not the machine's.">
            <TextInput value={draft.timeZone} onChange={(event) => set("timeZone", event.target.value)} />
          </Field>

          <Field label="Catch up within (minutes)" hint="How long after a missed occurrence EO will still run it. 0 means only if EO is open at the minute.">
            <TextInput type="number" min={0} value={draft.catchUpWithinMinutes} onChange={(event) => set("catchUpWithinMinutes", Number(event.target.value))} />
          </Field>
        </>
      ) : null}

      <Field label="Pipeline" hint="Where the work it files starts.">
        <Select value={draft.pipelineId} onChange={(event) => set("pipelineId", event.target.value)}>
          <option value="">Pick one</option>
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>
              {pipeline.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Type" hint="What each occurrence files.">
        <Select value={draft.type} onChange={(event) => set("type", event.target.value)}>
          <option value="">Pick one</option>
          {[...registry.itemTypes.values()].map((type) => (
            <option key={qualifiedItemType(type)} value={qualifiedItemType(type)}>
              {type.label}
            </option>
          ))}
        </Select>
      </Field>

      {/* Listed from the constant the substitution reads, so the help and what expands cannot drift. */}
      <Field label="Title" hint={`Blanks you can use: ${JOB_TEMPLATE_BLANKS.map((blank) => `{{${blank}}}`).join(", ")}.`}>
        <TextInput value={draft.title} onChange={(event) => set("title", event.target.value)} />
      </Field>

      <Field label="Body">
        <TextArea rows={4} value={draft.body} onChange={(event) => set("body", event.target.value)} />
      </Field>

      <Field label="Budget per occurrence (cents)" hint="Reaching it parks the item and pauses the job. Leave empty for no budget.">
        <TextInput type="number" min={0} value={draft.budgetPerOccurrenceCents} onChange={(event) => set("budgetPerOccurrenceCents", event.target.value)} />
      </Field>
    </div>
  );
}
