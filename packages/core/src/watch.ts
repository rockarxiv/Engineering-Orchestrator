import { z } from "zod";

/**
 * Keep checking: a `builtin` or `module` step that waits on something
 * outside EO by asking about it on an interval (EO-456, ARCHITECTURE.md,
 * "A step", "Modules: a step that is a script", "Guardrails").
 *
 * A *mode* of those two step types and not a fifth type, because a step
 * type says who has the item and a watch does not change that: it is
 * still EO doing this, or a script doing this. What changes is how often.
 * Instead of one invocation whose result routes, the step runs a short
 * check every `everyMinutes`, and each check answers either with the
 * reserved outcome `waiting` — nothing to do yet, perhaps with news — or
 * with a result key, which routes through `step_routes` like any other.
 *
 * Nothing here knows what is being waited on. A pull request, a
 * signature, a date: each is a check somebody ships, and this file is the
 * shape every one of them shares.
 */

/** The outcome a check reports while what it waits on has not happened yet. Never a route key. */
export const WAITING_RESULT = "waiting";

/** How long a watch keeps checking before it gives up, unless the step says otherwise: a week. */
export const DEFAULT_WATCH_GIVE_UP_HOURS = 168;

/** The shortest interval a step may check on. Anything faster is polling somebody else's system for the sake of it. */
export const MIN_WATCH_INTERVAL_MINUTES = 1;

/**
 * A step's keep-checking settings. Null on the step means it runs once,
 * which is every step that existed before this.
 *
 * Numbers, not integers, at this boundary: an interval of half a minute
 * is a mistake `validatePipeline` refuses with a sentence naming the step,
 * and a schema that refused it first would refuse it with a parse error
 * naming a path.
 *
 * **Never giving up (EO-571)** is a flag beside the hours rather than a
 * word or a null in their place. A pull request can wait months for a
 * person, and a very large number of hours is still a deadline somebody
 * reaches. The flag has to be said, so a watch that leaves
 * `giveUpAfterHours` out still gives up after a week, and every pipeline,
 * export and draft written before it keeps its meaning. It is a key of its
 * own because of who else reads this shape. A build that predates it
 * strips a key it does not know and parses the rest, so it refuses the
 * export on its format number with "Update EO and try again"
 * (`PIPELINE_EXPORT_VERSION` 10). A string where it reads a number would
 * instead fail as a damaged file. `Infinity` does not survive JSON, and
 * null already means "runs once" on the step and in its columns.
 *
 * With the flag set, `giveUpAfterHours` is not read. The validator still
 * holds it above nought, because it is what a device that predates the
 * flag reads the step as.
 */
export const StepWatchSchema = z.object({
  /** Check every this many minutes. At least `MIN_WATCH_INTERVAL_MINUTES`, which the validator holds. */
  everyMinutes: z.number().finite(),
  /** Give up this many hours after the watch started. Not read when `neverGivesUp` is set. */
  giveUpAfterHours: z.number().finite().default(DEFAULT_WATCH_GIVE_UP_HOURS),
  /** True keeps checking until a check has a result, however long that takes (EO-571). Absent or false gives up after `giveUpAfterHours`. */
  neverGivesUp: z.boolean().optional(),
});
export type StepWatch = z.infer<typeof StepWatchSchema>;

/** Whether this watch keeps checking with no deadline at all (EO-571). */
export function watchNeverGivesUp(watch: Pick<StepWatch, "neverGivesUp">): boolean {
  return watch.neverGivesUp === true;
}

/**
 * The watch as a step stores it (EO-571): `neverGivesUp` only when it is
 * set. A `false` says what its absence says, and is read back from the
 * step's columns as absent, so anything comparing a watch somebody wrote
 * with one EO stored compares this rather than what was written.
 */
export function settledWatch(watch: StepWatch): StepWatch {
  const { neverGivesUp, ...rest } = watch;
  return neverGivesUp === true ? { ...rest, neverGivesUp } : rest;
}

/**
 * One thing that changed since EO last looked — a failed job, a new
 * comment, a reply.
 *
 * `id` is the check's own and must be stable: EO posts an entry once per
 * watch, and the id is how it knows it already has. `text` came from
 * outside EO and is quoted as such wherever it is shown.
 */
export const WatchNewsSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});
export type WatchNews = z.infer<typeof WatchNewsSchema>;

/** The most findings one intake check may report (EO-752). A check finding more reports the rest next time. */
export const MAX_WATCH_FINDINGS = 100;

/** The longest key a finding may have (EO-752). It is stored once per item filed, and read as an identifier, not prose. */
export const MAX_WATCH_FINDING_KEY_CHARS = 200;

/**
 * One thing a watch module found while it ran as a pipeline's intake
 * (EO-752): a check of a module declaring `watch: true` made for a job,
 * with no item.
 *
 * The module does not file anything. It answers `waiting` with what it
 * found, and EO files each finding as one item on the job's pipeline,
 * from the job's template, with `title`, `body` and `spec` in place of
 * the template's (EO-753).
 *
 * `key` is the module's own stable name for the thing it found —
 * `dependabot:owner/repo#123` — and how EO files each thing once: a key
 * that has already made an item for the job is not filed again, however
 * many checks report it. `existingBranch` names a branch that already
 * exists, to work on instead of cutting one, as `ctx.createItem`'s does.
 *
 * Mirrored by `findingProblem` in `moduleHost.mjs`, which cannot import
 * this; the parent parses what the host sends with this schema again.
 */
export const WatchFindingSchema = z.object({
  key: z.string().trim().min(1).max(MAX_WATCH_FINDING_KEY_CHARS),
  title: z.string().trim().min(1),
  body: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  existingBranch: z.string().trim().min(1).optional(),
});
export type WatchFinding = z.infer<typeof WatchFindingSchema>;

/**
 * Why a list of findings cannot be filed, or null where it can (EO-752):
 * more than `MAX_WATCH_FINDINGS`, a finding `WatchFindingSchema` refuses
 * (named by its index), or two with one key (named). One problem is
 * enough to keep all of them: a check that half-reports what it found is
 * a check whose author never hears what was lost.
 */
export function watchFindingsProblem(findings: readonly unknown[]): string | null {
  if (findings.length > MAX_WATCH_FINDINGS) {
    return `An intake check may report at most ${MAX_WATCH_FINDINGS} findings, and this one reported ${findings.length}.`;
  }
  const seen = new Map<string, number>();
  for (const [index, entry] of findings.entries()) {
    const parsed = WatchFindingSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue === undefined || issue.path.length === 0 ? "" : ` (${issue.path.join(".")})`;
      return `findings[${index}] is not a finding EO can file${path}: ${issue?.message ?? "it does not have the shape of one"}.`;
    }
    const before = seen.get(parsed.data.key);
    if (before !== undefined) return `findings[${before}] and findings[${index}] both have the key "${parsed.data.key}". Each finding needs a key of its own.`;
    seen.set(parsed.data.key, index);
  }
  return null;
}

/**
 * An item's watch as the item page shows it (EO-456).
 *
 * The `item_watches` row for the step the item stands on, with the moment
 * it gives up worked out — the page says when the last check ran and when
 * the next is due, and a person deciding whether to wait wants to know
 * how long EO will. Null `giveUpAt` is a watch that never gives up
 * (EO-571).
 */
export const ItemWatchViewSchema = z.object({
  stepId: z.string(),
  startedAt: z.number(),
  lastCheckedAt: z.number().nullable(),
  nextCheckAt: z.number(),
  giveUpAt: z.number().nullable(),
  checks: z.number(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  /**
   * A check is running right now on this device (EO-699). The row alone
   * cannot say so: a check moves `nextCheckAt` an interval on before it
   * runs, and one that comes back waiting with nothing new never makes a
   * run of its own. Absent from a server older than this field.
   */
  checking: z.boolean().optional(),
});
export type ItemWatchView = z.infer<typeof ItemWatchViewSchema>;

/** A number of units as a person reads it: "1 minute", "5 minutes", "1.5 hours". */
function count(value: number, one: string, many: string): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? one : many}`;
}

/**
 * How long, in the unit that reads naturally — minutes under an hour,
 * hours under two days, days from there: "30 minutes", "36 hours",
 * "7 days". Used for the give-up time on a column head and for how long a
 * watch ran before it gave up, which is a little over its limit and
 * should still read as "7 days".
 */
export function watchDurationWords(ms: number): string {
  const minutes = Math.max(ms, 0) / 60_000;
  if (minutes < 60) return count(Math.round(minutes), "minute", "minutes");
  const hours = minutes / 60;
  if (hours < 48) return count(hours, "hour", "hours");
  return count(hours / 24, "day", "days");
}

/**
 * The column head line for a step that keeps checking, or null for one
 * that does not: "Checks every 5 minutes · gives up after 7 days", or
 * "Checks every 5 minutes · never gives up" (EO-571).
 */
export function watchLine(step: { watch?: StepWatch | null | undefined }): string | null {
  // Absent as well as null: the renderer does not parse what a channel
  // answers, and a server older than this field sends a step without it.
  if (step.watch == null) return null;
  return `Checks every ${watchIntervalWords(step.watch.everyMinutes)} · ${watchGiveUpWords(step.watch)}`;
}

/**
 * How often a watch checks, as the end of "Checks every …", in the unit
 * that reads naturally (EO-699): "day", "6 hours", "hour", "5 minutes",
 * "minute". A whole number of days reads in days, of hours in hours, and
 * anything else in minutes — so 90 minutes stays "90 minutes" rather than
 * becoming "1.5 hours", and 1440 is "day" rather than "1440 minutes".
 */
export function watchIntervalWords(everyMinutes: number): string {
  const every = (value: number, one: string, many: string) => (value === 1 ? one : `${Math.round(value * 10) / 10} ${many}`);
  if (everyMinutes >= 1440 && everyMinutes % 1440 === 0) return every(everyMinutes / 1440, "day", "days");
  if (everyMinutes >= 60 && everyMinutes % 60 === 0) return every(everyMinutes / 60, "hour", "hours");
  return every(everyMinutes, "minute", "minutes");
}

/** When a step's watch gives up, as the end of a sentence: "gives up after 7 days", or "never gives up" (EO-571). */
export function watchGiveUpWords(watch: StepWatch): string {
  return watchNeverGivesUp(watch) ? "never gives up" : `gives up after ${watchDurationWords(watch.giveUpAfterHours * 3_600_000)}`;
}

/**
 * What the item page says about its watch, a sentence a line (EO-456):
 * when the last check ran, when the next is due, when EO gives up — or that
 * it never does (EO-571) — and —
 * only while checks are failing — how many in a row and with what.
 *
 * `at` turns a moment into words; the renderer passes the person's own
 * clock format, and a test passes something it can read.
 */
export function itemWatchLines(watch: ItemWatchView, at: (ms: number) => string = (ms) => new Date(ms).toLocaleString()): string[] {
  const lines = [
    watch.lastCheckedAt === null ? "Not checked yet" : `Last checked ${at(watch.lastCheckedAt)}`,
    `Next check ${at(watch.nextCheckAt)}`,
    watch.giveUpAt === null ? "Never gives up" : `Gives up ${at(watch.giveUpAt)}`,
  ];
  if (watch.consecutiveFailures > 0) {
    lines.push(
      `The last ${watch.consecutiveFailures === 1 ? "check" : `${watch.consecutiveFailures} checks`} failed${watch.lastError === null ? "" : `: ${watch.lastError}`}`,
    );
  }
  return lines;
}
