import type { Item, Job, JobOccurrence, JobSkipReason, ScheduleTrigger, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, latestOccurrence, latestOccurrenceWithStatus, recordOccurrence, stepForItem } from "../db/repos/index.js";
import { compileSchedule, nextOccurrenceAfter, type CronFields } from "../schedule/cron.js";
import { formatZonedClock, zonedPartsOf } from "../schedule/timeZone.js";
import { SKIP_OFFER_OPTIONS } from "./answer.js";
import { fireJob } from "./fire.js";
import { postToJobThread } from "./thread.js";

/**
 * Catching a schedule up (EO-306, `ARCHITECTURE.md`,
 * "Schedules, and a machine that was off").
 *
 * **A missed occurrence is caught up within a grace window, then skipped
 * out loud.** The first draft of the design said a missed occurrence is
 * simply skipped, and EO's own code disagreed with it before the review
 * did: `jira/pullSchedule.ts` ticks at launch because a desktop closed
 * every evening would otherwise never reach a five-minute interval. A
 * marketing manager whose lid was shut at 08:00 and opened at 09:10
 * wants the Monday report — not a grey row on a page they have no reason
 * to open.
 *
 * So every tick asks the same question of every schedule: which
 * occurrences have come round since the last one EO decided about, and
 * for each, is it still worth running? The answers are: run it, the job
 * is paused (EO-307), the item it filed last time is still open, and it
 * was missed beyond the grace. Every one that is not "run it" is said
 * out loud on the job's thread, because a guard ends in a comment
 * (invariant #8) on the one channel there is (invariant #4) — a pause
 * once rather than hourly, which `skip` says why.
 */

/** What a caller has to provide to be interrupted, and what it gets. */
export interface JobGuardNotification {
  title: string;
  body: string;
  /** The thread the guard was posted on — what clicking the notification should open. */
  itemId: string;
}

export interface CatchUpDeps {
  /** The moment the sweep is for. Injected so a test can drive the clock rather than wait for it. */
  now?: number;
  /**
   * Shows an OS notification. Absent in tests and in any main without a
   * desktop: a skip is still recorded and still said on the thread, and
   * the interruption is the part that needs a machine.
   */
  notify?: (notification: JobGuardNotification) => void;
}

export interface JobCatchUpResult {
  /** The occurrences that ran. Items were created for each. */
  fired: JobOccurrence[];
  /** The occurrences that did not, each carrying which of the three reasons it was. */
  skipped: JobOccurrence[];
}

/**
 * How many occurrences one tick will decide about.
 *
 * A laptop opened after a year holds a year of hourly occurrences, and
 * writing nine thousand rows inside one tick is how a sweep becomes the
 * reason the app is unresponsive. Nothing is lost by stopping: the next
 * occurrence is found from the newest row, so the tick a minute later
 * picks up exactly where this one left off and a long absence catches up
 * over a few minutes rather than in one breath.
 */
const MAX_OCCURRENCES_PER_TICK = 500;

/**
 * Decides every occurrence this job has been due since EO last looked.
 *
 * Returns rather than logs, for `runJobTick`'s reason: a sweep whose only
 * evidence is a console line is a sweep nobody tests.
 */
export function catchUpJob(db: Db, job: Job, deps: CatchUpDeps = {}): JobCatchUpResult {
  const result: JobCatchUpResult = { fired: [], skipped: [] };
  if (job.trigger.kind !== "schedule") return result;
  const trigger = job.trigger;
  const now = deps.now ?? Date.now();

  const compiled = compileSchedule(trigger.schedule);
  if (!compiled.ok) {
    // `createJob` refuses a schedule that does not parse, so reaching
    // here means the row was written by something else — an older
    // version, a hand-edited database. Said once rather than every
    // minute: the guard is worth a comment, and sixty of them a day is
    // worth nothing.
    reportUnreadable(db, job, compiled.problem, now);
    return result;
  }

  for (const dueAt of dueSince(compiled.fields, trigger, startingFrom(db, job), now)) {
    // A paused job fires nothing (EO-307). The occurrence is still
    // decided about and still written down: a gap in the history is
    // indistinguishable from a job nobody looked at, and the row is what
    // makes "this did not run, and here is why" true of a pause as it is
    // of a missed morning. It is also what stops a resumed job from
    // catching up a week of them — the sweep starts after the newest
    // row, whatever its status.
    if (job.pausedAt !== null) {
      result.skipped.push(skip(db, job, trigger, dueAt, "paused", now, null, deps));
      continue;
    }
    // Asked again each time round the loop rather than once before it,
    // because firing an occurrence is what makes the next one's previous
    // item open.
    const open = previousItemStillOpen(db, job);
    if (open) {
      result.skipped.push(skip(db, job, trigger, dueAt, "previous still open", now, open, deps));
      continue;
    }
    if (beyondGrace(trigger, dueAt, now)) {
      result.skipped.push(skip(db, job, trigger, dueAt, "offline beyond grace", now, null, deps));
      continue;
    }
    const fired = fireJob(db, job, { dueAt });
    // A `failed` occurrence has already posted its own guard (`fire.ts`)
    // and belongs in neither list: nothing ran, and nothing was skipped
    // either.
    // …and `occurrence` is null only where nothing was written at all,
    // which the tick's own filter means this never reaches (EO-325).
    if (fired.item !== null && fired.occurrence !== null) result.fired.push(fired.occurrence);
  }

  return result;
}

/**
 * Where the sweep starts from.
 *
 * The newest occurrence of *any* status, not the newest firing: a
 * skipped row is a decision EO has already taken and told the person
 * about, and starting before it would re-offer the same skip every
 * minute for ever. Before there is any history, the job's own creation —
 * a job made on Monday afternoon has not missed Monday morning.
 */
function startingFrom(db: Db, job: Job): number {
  return latestOccurrence(db, job.id as Uuid)?.dueAt ?? job.createdAt;
}

/** Every occurrence strictly after `since` and no later than `now`, oldest first. */
function dueSince(fields: CronFields, trigger: ScheduleTrigger, since: number, now: number): number[] {
  const due: number[] = [];
  let cursor = since;
  while (due.length < MAX_OCCURRENCES_PER_TICK) {
    const next = nextOccurrenceAfter(fields, cursor, trigger.timeZone);
    if (next === null || next > now) break;
    due.push(next);
    cursor = next;
  }
  return due;
}

function beyondGrace(trigger: ScheduleTrigger, dueAt: number, now: number): boolean {
  return now - dueAt > trigger.catchUpWithinMinutes * 60_000;
}

/**
 * The item the last firing filed, if it has not finished.
 *
 * "Open" is the board's own answer and not a second one: an item is
 * finished when it is on a terminal step, which is what `isFinished`
 * asks for a dependency and what the archive sweep asks before it
 * archives anything. An archived item is finished by definition, and an
 * item somebody deleted is nothing to collide with.
 *
 * An item with no step at all is treated as open. That is a container,
 * whose state is its children's, and the honest answer to "has this
 * finished" without reading them is "not as far as anything here knows".
 */
function previousItemStillOpen(db: Db, job: Job): Item | null {
  const previous = latestOccurrenceWithStatus(db, job.id as Uuid, "fired");
  if (!previous || previous.itemId === null) return null;
  const item = getItem(db, previous.itemId as Uuid);
  if (!item || item.archivedAt !== null) return null;
  if (item.stepId === null) return item;
  // By the item's own version (EO-327): whether the work a job filed is
  // finished is a question about the graph it entered on, and a save
  // that made a later step terminal did not finish it.
  return stepForItem(db, item)?.isTerminal === true ? null : item;
}

/**
 * Writes the skipped row, says so on the thread, and interrupts.
 *
 * The row carries the phrase and the comment carries the sentence, and
 * both come from here so they cannot end up describing the event
 * differently — `fire.ts` makes the same move for a `failed` row.
 *
 * **The comment is posted before the row and named on it.** That order
 * is what lets an occurrence record which offer was made for it while
 * `job_occurrences` stays append-only: the row is complete the first and
 * only time it is written. Both happen inside one transaction, so a
 * thread never carries an offer for an occurrence that was not recorded,
 * and an occurrence never names a comment that does not exist.
 *
 * `postComment` taking a transaction of its own inside this one is the
 * shape `jira/import.ts` already has: better-sqlite3 nests through
 * savepoints, and the only consequence is that the comment's push fires
 * before the outer commit — which costs a wasted refetch on a rollback
 * and nothing else. That caveat is written down where `postComment`
 * announces.
 */
function skip(
  db: Db,
  job: Job,
  trigger: ScheduleTrigger,
  dueAt: number,
  reason: JobSkipReason,
  now: number,
  blocker: Item | null,
  deps: CatchUpDeps,
): JobOccurrence {
  // There is something to offer only when running it now is the right
  // thing to do. A skip made because the previous item is still open
  // gets a `note`: offering to run it would be offering the duplicate
  // the skip existed to prevent, and a question nobody can answer is a
  // mention that never closes.
  const offered = reason === "offline beyond grace";
  const body = sentenceFor(job, trigger, dueAt, reason, now, blocker);
  // A pause is said once and then left alone (EO-307), which is
  // `reportUnreadable`'s rule below and for its reason: the state does
  // not change until a person changes it, and an hourly job would
  // otherwise post a comment an hour about a decision they took
  // deliberately. A thread nobody can bear to read is invariant #8
  // switched off by whoever is tired of reading it. The rows are still
  // written, every one of them, so nothing about the history is
  // shortened — only the telling.
  const speak = reason !== "paused" || !alreadySaidPaused(db, job);

  const occurrence = db.transaction(() => {
    // A question rather than a note, because the inbox and the item
    // thread both draw a question's options as buttons — which is how
    // "Run it now" reaches a person before the Jobs page exists.
    const comment = speak ? postToJobThread(db, job, body, offered ? { kind: "question", options: SKIP_OFFER_OPTIONS } : {}) : null;
    return recordOccurrence(db, {
      jobId: job.id as Uuid,
      dueAt,
      status: "skipped",
      // Null, deliberately: the absence of a `firedAt` is what makes a
      // skipped row a skipped row (ARCHITECTURE.md, "What a job records").
      firedAt: null,
      reason,
      // Which question a person is answering when they answer. Null
      // where no question was asked.
      offerCommentId: offered && comment !== null ? comment.id : null,
    });
  });

  // And not interrupted about, for the same reason: an OS notification
  // for a job the person paused is EO telling them what they already
  // decided.
  if (speak && reason !== "paused") deps.notify?.({ title: `${job.name} was skipped`, body, itemId: job.threadItemId });

  return occurrence;
}

/**
 * What the person is told — the same sentence on the thread and in the
 * notification.
 *
 * Two sentences and no more. The first says what did not happen and why,
 * the second says what to do about it; a skip is read on a phone lock
 * screen as often as anywhere else.
 */
function sentenceFor(
  job: Job,
  trigger: ScheduleTrigger,
  dueAt: number,
  reason: JobSkipReason,
  now: number,
  blocker: Item | null,
): string {
  const when = describeDue(dueAt, now, trigger.timeZone);
  if (reason === "paused") {
    return `"${job.name}" is paused, so nothing was filed for ${when}. Occurrences are recorded while it is paused and not run; resume it and the next one runs as usual.`;
  }
  if (reason === "previous still open") {
    const still = blocker === null ? "the item it filed last time" : `${blocker.key}, which it filed last time,`;
    return `"${job.name}" was skipped: ${still} is still open, so nothing new was filed for ${when}. Finish it and the next occurrence runs as usual.`;
  }
  const grace = trigger.catchUpWithinMinutes;
  // Zero grace is "only if EO is open at the minute", and "within 0
  // minutes of 08:00" is not how anybody would say that.
  const missed = grace === 0 ? `EO was not open at ${when}.` : `EO was not open within ${describeGrace(grace)} of ${when}.`;
  return `"${job.name}" was skipped: ${missed} Run it now?`;
}

/**
 * "08:00", or "08:00 on 2026-09-07" when it was not today.
 *
 * In the job's zone rather than the machine's, which is the point of
 * storing one: a person reading "08:00" wants the 08:00 they asked for.
 * The date format is `formatDateKey`'s, so EO's dates read the same way
 * wherever they are shown.
 */
function describeDue(dueAt: number, now: number, timeZone: string): string {
  const clock = formatZonedClock(dueAt, timeZone);
  const due = zonedPartsOf(dueAt, timeZone);
  const today = zonedPartsOf(now, timeZone);
  if (due.year === today.year && due.month === today.month && due.day === today.day) return clock;
  const date = `${String(due.year).padStart(4, "0")}-${String(due.month).padStart(2, "0")}-${String(due.day).padStart(2, "0")}`;
  return `${clock} on ${date}`;
}

/** "3 hours", "90 minutes" — whichever reads as the number the person set. */
function describeGrace(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * Whether the pause has already been said on this thread (EO-307).
 *
 * The newest occurrence, not a search of the history: the rows are
 * written in order and a pause holds until a person lifts it, so the row
 * before this one being a paused skip means the comment for this run of
 * pausing has been posted. Pausing again after a resume says it again,
 * which is right — it is a new decision, and the occurrences in between
 * ran.
 */
function alreadySaidPaused(db: Db, job: Job): boolean {
  const latest = latestOccurrence(db, job.id as Uuid);
  return latest?.status === "skipped" && latest.reason === "paused";
}

/**
 * A schedule EO cannot read, said once.
 *
 * A `failed` row rather than a `skipped` one: nothing about the calendar
 * was missed, the calendar itself is unreadable, and the two belong in
 * different columns of the job's history. Quiet on every tick after the
 * first, because the fault does not change until somebody edits the job
 * — and an unreadable schedule that posted a comment a minute would bury
 * the thread it was trying to be seen on.
 */
function reportUnreadable(db: Db, job: Job, problem: string, now: number): void {
  const latest = latestOccurrence(db, job.id as Uuid);
  if (latest?.status === "failed" && latest.reason === problem) return;
  recordOccurrence(db, { jobId: job.id as Uuid, dueAt: now, status: "failed", firedAt: now, reason: problem });
  postToJobThread(db, job, `"${job.name}" has a schedule EO cannot read, so nothing is being filed for it. ${problem}`);
}
