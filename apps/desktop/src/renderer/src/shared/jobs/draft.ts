import { DEFAULT_CATCH_UP_MINUTES, EMPTY_WEBHOOK_MAPPING, type Job, type JobTemplate, type JobTrigger, type WebhookTrigger } from "@eo/core";

/**
 * The Job page's form, as fields rather than as a job (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * A flat draft and not a `JobTrigger` held in state, because a form and
 * a discriminated union want opposite things. A person switching from
 * "daily at 08:00" to "weekly" and back should find 08:00 still there;
 * a union would have thrown the hour away at the first switch and
 * invented one on the way back. So every field the three schedule forms
 * can want is kept side by side, and which of them *counts* is decided
 * on the way out, in `triggerOf`.
 *
 * `from-discussion` is deliberately absent. Such a job is made by
 * pressing Create in a conversation and has neither pipeline nor
 * template by design (ARCHITECTURE.md, "Trigger kinds"); offering it here would be a control that
 * could not work (invariant 12).
 *
 * `webhook` is present and is **not** a kind the form offers to switch
 * to (EO-333). It is here because a draft that could not hold one was a
 * draft that threw one away: `draftOf` fell back to the schedule
 * defaults for a webhook job, so opening its page and pressing Save
 * turned an address a helpdesk was already configured with into "daily
 * at 08:00". Carrying the trigger through untouched is what stops that;
 * what a person may edit of it is the mapping, and the path and the
 * secret are the webhook panel's rather than the form's.
 */
export interface JobDraft {
  name: string;
  triggerKind: "manual" | "schedule" | "webhook";
  scheduleKind: "daily" | "weekly" | "cron";
  hour: number;
  minute: number;
  weekday: number;
  expression: string;
  timeZone: string;
  catchUpWithinMinutes: number;
  pipelineId: string;
  type: string;
  title: string;
  body: string;
  /** Text rather than a number, so "no budget" is an empty box rather than a nought that means something. */
  budgetPerOccurrenceCents: string;
  /**
   * The webhook trigger as it stands, for a job that has one (EO-333).
   *
   * Null for every other kind, and never invented: a form that could
   * mint a path and a secret would be the renderer choosing a key the
   * half of the app that verifies with it never saw
   * (`mintWebhookSecret`). The mapping inside it is the one part this
   * form edits, which is why the whole trigger rides in the draft
   * rather than only the pointers.
   */
  webhook: WebhookTrigger | null;
}

/** A new job, with the machine's own zone offered as the one a person most likely means. */
export function blankDraft(): JobDraft {
  return {
    name: "",
    triggerKind: "schedule",
    scheduleKind: "daily",
    hour: 8,
    minute: 0,
    weekday: 1,
    expression: "0 8 * * 1",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    catchUpWithinMinutes: DEFAULT_CATCH_UP_MINUTES,
    pipelineId: "",
    type: "",
    title: "",
    body: "",
    budgetPerOccurrenceCents: "",
    webhook: null,
  };
}

/** An existing job read back into the form. Fields its trigger does not use keep their defaults. */
export function draftOf(job: Job): JobDraft {
  const draft = blankDraft();
  draft.name = job.name;
  draft.pipelineId = job.pipelineId ?? "";
  draft.type = job.template?.type ?? "";
  draft.title = job.template?.title ?? "";
  draft.body = job.template?.body ?? "";
  draft.budgetPerOccurrenceCents = job.budgetPerOccurrenceCents === null ? "" : String(job.budgetPerOccurrenceCents);
  if (job.trigger.kind === "manual") draft.triggerKind = "manual";
  if (job.trigger.kind === "webhook") {
    draft.triggerKind = "webhook";
    // Copied rather than referenced, so editing a pointer in the form
    // does not edit the job the query cache is still holding.
    const mapping = job.trigger.mapping ?? EMPTY_WEBHOOK_MAPPING;
    draft.webhook = { ...job.trigger, mapping: { ...mapping, spec: { ...mapping.spec } } };
  }
  if (job.trigger.kind === "schedule") {
    draft.triggerKind = "schedule";
    draft.timeZone = job.trigger.timeZone;
    draft.catchUpWithinMinutes = job.trigger.catchUpWithinMinutes;
    draft.scheduleKind = job.trigger.schedule.kind;
    if (job.trigger.schedule.kind === "cron") draft.expression = job.trigger.schedule.expression;
    else {
      draft.hour = job.trigger.schedule.hour;
      draft.minute = job.trigger.schedule.minute;
      if (job.trigger.schedule.kind === "weekly") draft.weekday = job.trigger.schedule.weekday;
    }
  }
  return draft;
}

/** What the draft means, for the command. Whether EO can compute from it is the main process's answer. */
export function triggerOf(draft: JobDraft): JobTrigger {
  if (draft.triggerKind === "manual") return { kind: "manual" };
  // The trigger it arrived with, with whatever the mapping table has
  // been changed to. A webhook job whose draft somehow carries no
  // trigger falls through to the schedule below rather than being
  // fabricated — but `draftOf` is the only way to reach that kind, and
  // it always fills this in.
  if (draft.triggerKind === "webhook" && draft.webhook !== null) return draft.webhook;
  return {
    kind: "schedule",
    schedule:
      draft.scheduleKind === "cron"
        ? { kind: "cron", expression: draft.expression }
        : draft.scheduleKind === "weekly"
          ? { kind: "weekly", weekday: draft.weekday, hour: draft.hour, minute: draft.minute }
          : { kind: "daily", hour: draft.hour, minute: draft.minute },
    timeZone: draft.timeZone,
    catchUpWithinMinutes: draft.catchUpWithinMinutes,
  };
}

export function templateOf(draft: JobDraft): JobTemplate {
  return { type: draft.type, title: draft.title, body: draft.body.trim() === "" ? null : draft.body };
}

/** The budget as the command takes it: null for an empty box, and null for anything that is not a number. */
export function budgetOf(draft: JobDraft): number | null {
  const text = draft.budgetPerOccurrenceCents.trim();
  if (text === "") return null;
  const cents = Number(text);
  return Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : null;
}
