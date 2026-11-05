import type { Job, JobOccurrenceRow, JobSummary, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, latestOccurrence, latestOccurrenceWithStatus, listOccurrences, listRunsForItem, sumCostCentsForItem } from "../db/repos/index.js";
import { compileSchedule, nextOccurrenceAfter } from "../schedule/cron.js";

/**
 * What the Jobs list and the Job page read off a job (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * Every field here is derived, and every one of them is derived *here*
 * rather than on the screen that shows it. The next run needs the cron
 * parser the scheduler computes with, the last run needs the
 * occurrences, and the history's costs and durations need the runs —
 * none of which the renderer has. A screen that worked any of them out
 * for itself would be a second opinion about when a job fires, which is
 * the one thing a schedule cannot have two of.
 *
 * What is *not* here is the pause chip. Which act stopped a job is
 * recorded on the row when it happens (`jobs.paused_reason`, migration
 * 0081) rather than worked out afterwards, because the spend a
 * derivation would read is identical whether a budget guard or a person
 * stopped it.
 */

/**
 * When this job next comes round, in absolute time.
 *
 * Null for `manual` and `from-discussion`, which have no calendar at
 * all, and null for a schedule that does not parse — `createJob` and
 * `updateJob` both refuse one, so reaching that means a row written by
 * something else, and a list saying nothing it cannot stand behind is
 * better than a list showing a date it guessed.
 *
 * Computed from `now` and not from the last occurrence, deliberately.
 * "When does this next fire" is a question about the future: a job that
 * has been asleep for a week has a backlog the catch-up will decide
 * about, and answering with the oldest of those would show a person a
 * date in the past as the next run. The backlog is visible where it
 * belongs — in the history, one row per occurrence.
 *
 * Computed while paused, too. A paused job's next occurrence is a real
 * moment that will come and be written down as a skip, and blanking it
 * would hide what resuming would do.
 */
export function nextRunAt(job: Job, now: number = Date.now()): number | null {
  if (job.trigger.kind !== "schedule") return null;
  const compiled = compileSchedule(job.trigger.schedule);
  if (!compiled.ok) return null;
  return nextOccurrenceAfter(compiled.fields, now, job.trigger.timeZone);
}

/**
 * The job with the two computed things the list scans for hung on it
 * (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The chip is not among them: which act stopped a job is `pausedAt` and
 * `pausedReason` on the row, recorded when it happened, because the
 * spend a derivation would read is the same whether a guard or a person
 * stopped it.
 */
export function jobSummary(db: Db, job: Job, now: number = Date.now()): JobSummary {
  const latest = latestOccurrence(db, job.id as Uuid);
  const lastFired = latestOccurrenceWithStatus(db, job.id as Uuid, "fired");
  return {
    ...job,
    nextRunAt: nextRunAt(job, now),
    // The last time it *ran*, not the last time it was considered: a
    // week of skips is a week in which this job last ran before them,
    // and `lastStatus` beside it is what says the week happened.
    lastRunAt: lastFired?.firedAt ?? null,
    lastStatus: latest?.status ?? null,
  };
}

/**
 * The job's history, newest first — including every skipped row (ARCHITECTURE.md, "The inbox, the
 * archive and jobs").
 *
 * The item is resolved here rather than left as an id, because the
 * occurrence outlives it: `job_occurrences.item_id` carries no foreign
 * key precisely so that deleting an item does not erase the record of
 * the firing, and this is where that becomes a blank cell instead of a
 * broken link.
 */
export function occurrenceRows(db: Db, jobId: Uuid): JobOccurrenceRow[] {
  return listOccurrences(db, jobId).map((occurrence) => {
    const item = occurrence.itemId === null ? undefined : getItem(db, occurrence.itemId as Uuid);
    return {
      ...occurrence,
      itemKey: item?.key ?? null,
      itemTitle: item?.title ?? null,
      costCents: item === undefined ? 0 : sumCostCentsForItem(db, item.id),
      durationMs: item === undefined ? null : runDurationMs(db, item.id),
    };
  });
}

/**
 * How long an occurrence's work took: the time its item spent running.
 *
 * The runs summed rather than the wall clock from firing to finishing.
 * An item filed at 08:00 that waits on a person until Thursday did not
 * take three days of work, and a duration column that said so would be
 * measuring the person rather than the job. A run still going
 * contributes nothing yet — null until something has finished is what
 * "we do not know" looks like in a table of numbers.
 */
function runDurationMs(db: Db, itemId: Uuid): number | null {
  let total = 0;
  let any = false;
  for (const run of listRunsForItem(db, itemId)) {
    if (run.startedAt === null || run.endedAt === null) continue;
    total += Math.max(0, run.endedAt - run.startedAt);
    any = true;
  }
  return any ? total : null;
}
