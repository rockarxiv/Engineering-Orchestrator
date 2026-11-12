import { z } from "zod";
import { DEFAULT_JOB_RUNS_ON, JobRunsOnSchema } from "../placement.js";
import { WebhookTriggerSchema } from "../webhook.js";
import { MIN_WATCH_INTERVAL_MINUTES } from "../watch.js";

/**
 * A job: the recurring definition that stamps work out (EO-304,
 * `ARCHITECTURE.md`, "Jobs").
 *
 * The line the design draws, and the one this file exists to hold: a
 * scheduled run and a webhook are not a different *kind of work item*,
 * they are a different way of *creating* one. So there is no `job`
 * supertype over `items`; what a job produces is an ordinary item on an
 * ordinary step, and everything recurring about it — the trigger, the
 * pipeline, the template, the owner — lives here instead.
 */

/**
 * What makes an occurrence happen.
 *
 * Five kinds now that EO-753 has added `watch` and EO-332 `webhook`, which waited for the
 * server that has a public address (ARCHITECTURE.md, "Trigger kinds") — that is what a
 * discriminated
 * union rather than an open string is for: a kind EO cannot fire is a
 * kind a person could configure and then watch do nothing, and the union
 * is what refuses to write one down until the thing that fires it
 * exists.
 *
 * `webhook` is the one kind EO does not fire on *this* machine at all:
 * the event arrives at the organisation server, which verifies it,
 * records it and creates the item, and the job's machine dispatches that
 * item as it dispatches any other (ARCHITECTURE.md, "Webhooks"). Its own shape is in
 * `core/webhook.ts`, beside the path, the headers and the pointers
 * that only make sense together.
 */
export const ManualTriggerSchema = z.object({
  kind: z.literal("manual"),
});

/**
 * An item created by pressing Create in a conversation, shown on the
 * item as "From: conversation …" (ARCHITECTURE.md, "Trigger kinds").
 *
 * A job rather than a flag on the item, because otherwise a
 * conversation would be the one way of creating work that is not a
 * trigger — and the item's provenance would be two mechanisms where
 * every other route has one. The job is made on the first approval in
 * that conversation, and a second approval there finds it again by the
 * conversation's id.
 */
export const FromDiscussionTriggerSchema = z.object({
  kind: z.literal("from-discussion"),
  /** The conversation item: what finds this job again (`jobForConversation`). */
  conversationId: z.string().min(1),
});

/**
 * When a schedule comes round: a simple form, or a cron expression
 * (EO-306, `ARCHITECTURE.md`, "Trigger kinds").
 *
 * Both, and not one or the other. "Daily at 08:00" and "Mondays at
 * 08:00" are what almost every job actually wants, and asking a
 * marketing manager to write `0 8 * * 1` for it is asking them to learn
 * a notation to say something the form already says. The expression is
 * there for the rest — the first of the month, every four hours — and
 * because a schedule nobody can express is a job somebody files by hand
 * forever.
 *
 * Deliberately not a free-text "every other Tuesday" parser. What a
 * schedule means has to be the same sentence a person reads back off
 * the Job page and the same one the scheduler computes from, and a
 * natural-language guess is neither.
 */
export const DailyScheduleSchema = z.object({
  kind: z.literal("daily"),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

/** `weekday` is 0–6 with Sunday 0 — cron's own numbering, so the two forms agree. */
export const WeeklyScheduleSchema = z.object({
  kind: z.literal("weekly"),
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

/**
 * Five fields — minute, hour, day of month, month, day of week.
 *
 * Only the shape is checked here; whether the fields parse is checked
 * where a job is created, by the parser that will later have to compute
 * from it. Two answers to "is this a valid expression" is one more than
 * there should be.
 */
export const CronScheduleSchema = z.object({
  kind: z.literal("cron"),
  expression: z.string().min(1),
});

export const JobScheduleSchema = z.discriminatedUnion("kind", [DailyScheduleSchema, WeeklyScheduleSchema, CronScheduleSchema]);
export type JobSchedule = z.infer<typeof JobScheduleSchema>;

/**
 * How long after a missed occurrence EO will still run it, in minutes.
 *
 * Three hours, and on by default. The design first said a missed
 * occurrence is simply skipped; the review overruled it against EO's own
 * precedent — the Jira pull ticks at launch precisely because a desktop
 * closed every evening would otherwise never reach its interval
 * (`ARCHITECTURE.md`, "Where a job runs"). A lid closed at 08:00 and
 * opened at 09:10 should produce the Monday report, not a grey row on a
 * page nobody opens.
 *
 * Zero is allowed and means "only if EO is open at the minute", which is
 * the old behaviour for anyone who wants it.
 */
export const DEFAULT_CATCH_UP_MINUTES = 180;

/**
 * A schedule: a calendar, the zone it is stated in, and a grace (ARCHITECTURE.md, "Trigger kinds",
 * "Schedules, and a machine that was off").
 *
 * **The zone is stored with the job**, and that is the whole point of
 * the field. A person who sets the Monday report for 08:00 in
 * `Europe/Berlin` means 08:00 in Berlin, and flying to New York does not
 * move their report to 02:00; nor does the machine's zone changing under
 * a laptop that never left the desk. The alternative — the machine's
 * current zone — makes the schedule a fact about where the computer is
 * rather than about when the work is wanted.
 */
export const ScheduleTriggerSchema = z.object({
  kind: z.literal("schedule"),
  schedule: JobScheduleSchema,
  /** An IANA name — `Europe/Berlin`. Checked against the machine's zone table where a job is created. */
  timeZone: z.string().min(1),
  catchUpWithinMinutes: z.number().int().min(0).default(DEFAULT_CATCH_UP_MINUTES),
});

/**
 * A watch module as the job's intake (EO-753, ARCHITECTURE.md §9.1).
 *
 * While EO is open, the module — approved, and declaring `watch: true` —
 * is run every `everyMinutes` with no item, as an intake check (EO-752).
 * It answers `waiting` with what it found, and EO files each finding
 * whose key has not yet made an item for this job, through the job's own
 * door. The module files nothing itself.
 *
 * `inputs` are the module's declared inputs, as a module step's are.
 * `waitWhileOpen` holds every check while an item this job filed is
 * unfinished. Runs on this machine only, and never on a project an
 * organisation's record holds: `createJob` refuses both.
 */
export const WatchTriggerSchema = z.object({
  kind: z.literal("watch"),
  moduleId: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  everyMinutes: z.number().int().min(MIN_WATCH_INTERVAL_MINUTES),
  waitWhileOpen: z.boolean().default(false),
});

export const JobTriggerSchema = z.discriminatedUnion("kind", [
  ManualTriggerSchema,
  ScheduleTriggerSchema,
  FromDiscussionTriggerSchema,
  WebhookTriggerSchema,
  WatchTriggerSchema,
]);
export type JobTrigger = z.infer<typeof JobTriggerSchema>;
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
export type WatchTrigger = z.infer<typeof WatchTriggerSchema>;

/**
 * The three ways an occurrence that was due did not run (ARCHITECTURE.md, "Schedules, and a machine
 * that was off", "Jobs").
 *
 * A closed set rather than a sentence, unlike a `failed` row's `reason`.
 * A failure is whatever went wrong and can only be prose; a skip has a
 * fixed set of causes, and the Job page groups its history by them. The
 * sentence the person reads is derived from the phrase in one place
 * (`jobs/catchUp.ts`), so the row and the comment cannot come to say
 * two different things about one event.
 *
 * `paused` is EO-307's: a paused job fires nothing, and its occurrences
 * still come round. Writing the row is what keeps the history honest —
 * a gap in the list is indistinguishable from a job nobody looked at,
 * and "paused" is the difference between work that was dropped and work
 * a person chose to stop.
 */
export const JobSkipReasonSchema = z.enum(["offline beyond grace", "previous still open", "paused"]);
export type JobSkipReason = z.infer<typeof JobSkipReasonSchema>;

/**
 * The kinds spelled as an enum, for the readers that carry the kind
 * without the rest of the trigger — the detail rail asks "job or
 * conversation", not "which conversation".
 *
 * Kept in step with the union by `JobTriggerKind` below: the alias is
 * the union's own `kind`, so a third kind added to the union and not
 * here stops compiling at every use.
 */
export const JobTriggerKindSchema = z.enum(["manual", "schedule", "from-discussion", "webhook", "watch"]);
export type JobTriggerKind = JobTrigger["kind"];

/**
 * The blanks `{{date}}` and `{{job}}` fill in a template.
 *
 * Written down here rather than spelled at the substitution site so the
 * Job page's help text and the substitution cannot drift: the sixth
 * story draws the list from this constant.
 */
export const JOB_TEMPLATE_BLANKS = ["date", "job"] as const;

/**
 * What the job stamps out: a type, a title and a body (ARCHITECTURE.md, "Jobs").
 *
 * The type is qualified — `developer:story` — for `resolveItemType`'s
 * reason: two packs may ship a `case`, and a bare slug with two answers
 * would file the occurrence's item as somebody else's shape. Where the
 * item goes is the job's `pipelineId` and not part of the template,
 * because the pipeline is what the job *is* for and a template that
 * could name another one would be a second answer to that.
 */
export const JobTemplateSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().nullable().default(null),
});
export type JobTemplate = z.infer<typeof JobTemplateSchema>;

/** fired, or one of the two ways it did not (ARCHITECTURE.md, "What a job records"). */
export const JobOccurrenceStatusSchema = z.enum(["fired", "skipped", "failed"]);
export type JobOccurrenceStatus = z.infer<typeof JobOccurrenceStatusSchema>;

/**
 * One occurrence, as it crosses a boundary.
 *
 * An append-only record, the way a transition is — never a channel
 * (ARCHITECTURE.md, "What a job records"). What a person is *told* about a skip is a
 * message to the job's owner; this is what the app reads back.
 */
export const JobOccurrenceViewSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  /** The moment it was for. For a manual run, the moment somebody pressed. */
  dueAt: z.number(),
  /** Null on a `skipped` row: that is the difference between skipped and fired. */
  firedAt: z.number().nullable(),
  status: JobOccurrenceStatusSchema,
  reason: z.string().nullable(),
  /** What it created, if it created anything. The item may since have been deleted. */
  itemId: z.string().nullable(),
  /**
   * The message that offered to run this one (EO-306; a comment on
   * the job's thread before EO-729, whose id 0168 gave the message).
   *
   * Set only on a skip beyond the grace — the one kind of skip there is
   * anything to offer about. It is what binds a person's reply to *this*
   * occurrence rather than to whichever skip happens to be newest, and
   * it is null on almost every row.
   */
  offerCommentId: z.string().nullable().default(null),
});
/**
 * The row and the view are the same shape, so they are the same type.
 * A job carries nothing the app is not allowed to see.
 */
export type JobOccurrence = z.infer<typeof JobOccurrenceViewSchema>;

/**
 * Which act stopped a job (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * Recorded when the job is paused, not worked out afterwards. It began
 * derived — a job counted as budget-paused when its newest firing's
 * item had reached what one occurrence is allowed, which is the
 * question `occurrenceOverBudget` asks at dispatch — on the reading
 * that a second column about a pause would be the same fact twice
 * (invariant #6).
 *
 * That was wrong in the ordinary case: a person who looks at an
 * expensive occurrence and then pauses the job *by hand* would be told
 * a budget did it, because the spend is identical either way. "What
 * this job has spent" and "why this job is stopped" are two facts, and
 * no amount of reading the first recovers the second.
 */
/**
 * `watch` (EO-753): a watch job's checks failed six times in a row, or a
 * check answered one of its module's declared results.
 */
export const JobPauseReasonSchema = z.enum(["budget", "by hand", "watch"]);
export type JobPauseReason = z.infer<typeof JobPauseReasonSchema>;

/** A job as the app reads it. */
export const JobViewSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  trigger: JobTriggerSchema,
  pipelineId: z.string().nullable(),
  template: JobTemplateSchema.nullable(),
  ownerId: z.string(),
  pausedAt: z.number().nullable(),
  /**
   * Which act stopped it, for the chip the design puts on a paused job.
   *
   * Null while it runs, and null on a row paused before the column
   * existed — which the chip reads as "by hand", the honest default for
   * a pause EO cannot attribute to a guard of its own.
   */
  pausedReason: JobPauseReasonSchema.nullable().default(null),
  budgetPerOccurrenceCents: z.number().nullable(),
  maxItemsPerHour: z.number().nullable(),
  /**
   * Which machine runs it: the person's, or the organisation's server
   * (EO-330, `ARCHITECTURE.md`, "Where a job runs").
   *
   * One setting rather than a set of capabilities, because that is the
   * question a person can actually answer — "where does this run" — and
   * everything EO knows about *whether* they may answer it that way is
   * worked out from the pipeline instead (`placement.ts`). Which is why
   * there is nothing else on this row about placement: the reasons are
   * derived (invariant 6) and stop being true the moment an agent is
   * re-bound or a secret is set.
   *
   * Defaulted to `device` by the schema as well as by the column, so a
   * job read out of a record a version behind this one is a job that
   * runs where it has always run rather than one that fails to parse.
   */
  runsOn: JobRunsOnSchema.default(DEFAULT_JOB_RUNS_ON),
  /**
   * When a person deleted it — a tombstone rather than a gone row
   * (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
   *
   * EO-304 removed the row and let the cascade take its occurrences,
   * on the reading that a person asking for a job to be gone is
   * invariant #3's own exception. This story is where that reading runs
   * out: deleting a job offers "archive its items" *or* "keep them",
   * and an item a person chose to keep has to go on saying where it
   * came from. Its provenance is the occurrence (`ItemOrigin`), and the
   * occurrence dies with the job — so "keep them" would leave work on
   * the board that could no longer name what filed it.
   *
   * So the row stays and says it is gone. It is out of every list, out
   * of the scheduler, out of the conversation reuse path and out of Run
   * now. What survives is exactly what
   * invariant #3 protects everywhere else — the record of what happened
   * while it existed — and nothing about that record is rewritten.
   */
  deletedAt: z.number().nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
});
/** The row and the view are the same shape — see `JobOccurrence`. */
export type Job = z.infer<typeof JobViewSchema>;

/**
 * Where a watch job's checks stand (EO-753, ARCHITECTURE.md §9.1), kept
 * in `job_watch_states` and returned with the job.
 *
 * `lastAnswer` is `waiting`, the declared result a check answered, or
 * `failed`. `waitingForItemId` is the item a `waitWhileOpen` job holds
 * its checks for, while it is unfinished.
 */
export const JobWatchStateSchema = z.object({
  lastCheckedAt: z.number().nullable(),
  lastAnswer: z.string().nullable(),
  nextCheckAt: z.number().nullable(),
  consecutiveFailures: z.number().int(),
  lastError: z.string().nullable(),
  waitingForItemId: z.string().nullable(),
  /** The key of `waitingForItemId`, for a screen to name it. Null when it waits for nothing, or the item is gone. */
  waitingForItemKey: z.string().nullable().default(null),
});
export type JobWatchState = z.infer<typeof JobWatchStateSchema>;


/**
 * A job as the Jobs list draws it: the row, and the four things a
 * person scans for (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The derived fields travel with the job rather than in a parallel
 * array, because every one of them is about *this* job and a list that
 * zipped two answers together would eventually zip them wrongly.
 * Neither is stored: the next run is computed from the schedule and the
 * last run is the newest firing. The chip is not among them — it is
 * `pausedAt` and `pausedReason` on the row, because which act stopped a
 * job is something that happened rather than something to work out.
 */
export const JobSummarySchema = JobViewSchema.extend({
  /**
   * When it next comes round, in absolute time.
   *
   * Null for `manual` and `from-discussion`, which have no calendar, and
   * null for a schedule EO cannot read — a job whose expression was
   * hand-edited into the database still lists, saying nothing it cannot
   * stand behind rather than a date it guessed.
   *
   * Computed even while the job is paused. A paused job's next
   * occurrence is a real moment that will come and be written down as a
   * skip; blanking it would hide what resuming would do.
   */
  nextRunAt: z.number().nullable(),
  /** When it last fired. Null before it ever has. */
  lastRunAt: z.number().nullable(),
  /** What the newest occurrence of any kind did — so a run of skips is visible in the list. */
  lastStatus: JobOccurrenceStatusSchema.nullable(),
  /** A watch job's checks (EO-753). Null for every other kind, and for a watch job not yet checked. */
  watch: JobWatchStateSchema.nullable().default(null),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/**
 * One row of the Job page's history (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The occurrence, plus what a person reads it by: which item it filed,
 * what that item cost and how long it ran. Resolved here rather than by
 * the page, because the item may since have been deleted — the
 * occurrence keeps the id (ARCHITECTURE.md, "Jobs") and this is where "the item is gone"
 * becomes a blank cell instead of a broken link.
 */
export const JobOccurrenceRowSchema = JobOccurrenceViewSchema.extend({
  /** Null when nothing was filed, and when what was filed has been deleted. */
  itemKey: z.string().nullable(),
  itemTitle: z.string().nullable(),
  /** What the item's runs cost. Nought for a skip, which ran nothing. */
  costCents: z.number(),
  /** How long its runs took, in milliseconds. Null when nothing has finished. */
  durationMs: z.number().nullable(),
});
export type JobOccurrenceRow = z.infer<typeof JobOccurrenceRowSchema>;

/**
 * The trigger as one line of prose (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * In `@eo/core` rather than in the list that shows it, because the Job
 * page's summary line and the Jobs list's second column are the same
 * sentence about the same job, and two spellings of it would drift the
 * first time a schedule kind is added. Deliberately without the zone:
 * the page states the zone beside the form it is edited in, and a list
 * row that carried it would be a column of "Europe/Berlin" repeated.
 */
export function describeJobTrigger(trigger: JobTrigger): string {
  if (trigger.kind === "manual") return "When you run it";
  if (trigger.kind === "from-discussion") return "When you press Create in its conversation";
  // Deliberately without the path, for the reason the schedule is
  // written without its zone: the address is a long string a person
  // copies from the Job page, and a list column repeating it would say
  // the same thing fifty times and fit none of them.
  if (trigger.kind === "webhook") return "When an event arrives at its webhook";
  if (trigger.kind === "watch") return `When its module finds something, checking every ${trigger.everyMinutes === 1 ? "minute" : `${trigger.everyMinutes} minutes`}`;
  return describeJobSchedule(trigger.schedule);
}

/**
 * The word an item's provenance is named by — "job", "conversation" or
 * "webhook" (EO-308, EO-333, ARCHITECTURE.md, "Trigger kinds", "What a job records").
 *
 * In `@eo/core` for `describeJobTrigger`'s reason, and with a sharper
 * edge to it: the detail rail reads "From: job 'Monday report'" and the
 * card's hover reads "From job 'Monday report' · 12¢", three inches
 * apart, about the same item. They were two spellings of one word until
 * a third kind arrived and only one of them learned it — which is what
 * a shared function is for.
 *
 * "webhook" rather than "job", though a webhook job is a job: what a
 * person wants to know about an item that appeared on its own is *how*
 * it appeared, and "job" for something a helpdesk filed says the least
 * useful true thing available. A schedule and a manual run are both
 * "job" because both are the standing thing the Jobs page shows.
 */
export function describeItemOriginKind(trigger: JobTriggerKind): string {
  if (trigger === "from-discussion") return "conversation";
  if (trigger === "webhook") return "webhook";
  if (trigger === "watch") return "watch";
  return "job";
}

/** Sunday first, cron's own numbering — see `WeeklyScheduleSchema`. */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Daily at 08:00", "Mondays at 08:00", or the expression itself. */
export function describeJobSchedule(schedule: JobSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${clockOf(schedule.hour, schedule.minute)}`;
  if (schedule.kind === "weekly") return `${WEEKDAY_NAMES[schedule.weekday] ?? "Sunday"}s at ${clockOf(schedule.hour, schedule.minute)}`;
  return `Whenever "${schedule.expression}" comes round`;
}

function clockOf(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Where an item came from, for the detail rail (ARCHITECTURE.md, "What a job records").
 *
 * Resolved through the occurrence that created it rather than stored on
 * the item, because the occurrence is already the record of the firing
 * and a column on `items` would be the same fact written twice. Null
 * for an item a person filed themselves, which is most of them.
 */
export const ItemOriginSchema = z.object({
  jobId: z.string(),
  /** What the job is called — for a from-discussion job, the conversation. */
  jobName: z.string(),
  /** Which way this item was created — what the rail's sentence turns on. */
  trigger: JobTriggerKindSchema,
  occurrenceId: z.string(),
  firedAt: z.number().nullable(),
  /**
   * What this occurrence's item has cost, in cents (EO-308, ARCHITECTURE.md, "The inbox, the
   * archive and jobs").
   *
   * On the origin rather than fetched beside it, because the two places
   * that show a provenance both want the number: the card's hover reads
   * "Monday report · 12¢" and the rail's From row says the same thing
   * in full. A second query per card to answer it would be fifty
   * queries on a board of fifty.
   *
   * The *item's* runs, not the job's total — `jobs:cost` is the job's,
   * and an occurrence that spent nothing is a zero rather than a blank.
   */
  costCents: z.number(),
  /**
   * The key of the finding a watch job filed this item for (EO-753).
   * Null for an item any other trigger filed.
   */
  findingKey: z.string().nullable().default(null),
});
export type ItemOrigin = z.infer<typeof ItemOriginSchema>;
