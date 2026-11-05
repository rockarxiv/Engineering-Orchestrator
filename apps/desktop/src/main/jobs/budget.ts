import type { Item, Job, JobOccurrence, JobPauseReason, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getJob, listOccurrences, occurrenceForItem, setJobPaused, sumCostCentsForItem, sumCostCentsForItems } from "../db/repos/index.js";
import { postToJobThread } from "./thread.js";

/**
 * Per-job budgets, and pause (EO-307,
 * `ARCHITECTURE.md`, "Controls").
 *
 * The only budgets EO had were per item and per day, installation-wide
 * (the design's guardrails). A job that fires every hour is a cost runaway with
 * nothing between it and the daily cap — and the daily cap is the wrong
 * thing to hit, because it stops *everything* on the machine rather than
 * the one job that ran away. So a job carries a budget for what one
 * occurrence may spend, and reaching it pauses the job.
 *
 * **A budget trip is a park, not a route.** It happens before a dispatch
 * rather than after a result, so there is no result to route on: the run
 * that would have started never does, the item is left awaiting a person
 * (invariant #8), and the job's thread is told which budget it was and
 * what it had spent. Routing it would mean inventing an outcome for work
 * that never ran.
 *
 * **And pausing is the other half of the same sentence.** Parking one
 * item stops one item; the job that filed it is due again in an hour.
 * Pausing is what makes the guard about the thing that ran away rather
 * than about its newest victim, and it is a state a person can see and
 * undo, which is what `tickets.heldAt` is for an item (EO-45).
 */

/** A job that has spent what one occurrence was allowed, with the numbers the sentence needs. */
export interface JobBudgetTrip {
  job: Job;
  /** The occurrence whose item did the spending. */
  occurrence: JobOccurrence;
  budgetCents: number;
  spentCents: number;
}

/**
 * Whether this item has spent its occurrence's budget.
 *
 * Null for almost every item there is — most were filed by a person, and
 * a job without a budget is the default. The cost of asking is one
 * indexed lookup on `job_occurrences`, which is what a dispatch can
 * afford.
 *
 * **The item's own runs, and not its children's.** An occurrence files
 * one item and the budget is stated per occurrence, so what it bounds is
 * that item's sequence of runs — the loop a runaway job actually is. A
 * decomposition's children are items in their own right, on the board,
 * subject to the per-item and daily guards like any other work; folding
 * their spend in here would make one job's budget the reason an
 * unrelated item stopped.
 */
export function occurrenceOverBudget(db: Db, itemId: Uuid): JobBudgetTrip | null {
  const occurrence = occurrenceForItem(db, itemId);
  if (occurrence === undefined) return null;
  const job = getJob(db, occurrence.jobId as Uuid);
  if (job === undefined || job.budgetPerOccurrenceCents === null) return null;
  // A deleted job's budget guards nothing (EO-308). Its row survives as
  // a tombstone so the items it filed can still name it, and those
  // items may well be work a person chose to *keep* — parking one would
  // stop work somebody deliberately kept, on the authority of a job
  // they deliberately deleted, and would say so on a thread that has
  // been archived. The per-item and daily guards still apply to them,
  // like any other item on the board.
  if (job.deletedAt !== null) return null;
  const spentCents = sumCostCentsForItem(db, itemId);
  if (spentCents < job.budgetPerOccurrenceCents) return null;
  return { job, occurrence, budgetCents: job.budgetPerOccurrenceCents, spentCents };
}

/**
 * What the item's thread is told — the sentence the park carries.
 *
 * It names the budget, what was spent and the job, because all three are
 * what a person needs to decide between raising the budget, resuming the
 * job and leaving it paused. "Reply to authorize more" is deliberately
 * not offered: the per-item guard can be answered on the item because
 * the item is the thing it stopped, and this one stopped a job.
 */
export function budgetRefusal(trip: JobBudgetTrip): string {
  return (
    `"${trip.job.name}" allows ${trip.budgetCents}¢ for one occurrence and the runs on this item have reached it ` +
    `(spent ${trip.spentCents}¢). Nothing more was dispatched for it, and the job is paused so the next occurrence ` +
    `does not spend the same again. Resume the job once you have raised the budget or decided the spend was worth it.`
  );
}

/**
 * Stops the job, and says so where a person will see it.
 *
 * Quiet if the job is already paused: a second item of a second
 * occurrence can trip the same budget, and two comments about one state
 * is EO reporting its own timing rather than anything to act on.
 *
 * The comment mentions the owner, which is what a job's thread is for
 * (ARCHITECTURE.md, "What a job records"): the guard fires where no item of the *job's* own exists,
 * so
 * the thread is the channel it ends in (invariants #4 and #8).
 */
export function pauseForBudget(db: Db, trip: JobBudgetTrip, item: Item): void {
  if (trip.job.pausedAt !== null) return;
  // Said here, where it is known (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs"). The
  // chip on the Jobs
  // list is drawn from it, and nothing downstream can work it out: a
  // job a person paused after an expensive occurrence has exactly the
  // same spend as this one.
  pauseJob(db, trip.job.id as Uuid, Date.now(), "budget");
  postToJobThread(
    db,
    trip.job,
    `"${trip.job.name}" is paused: ${item.key} has spent ${trip.spentCents}¢ of the ${trip.budgetCents}¢ this job ` +
      `allows one occurrence, so nothing more was dispatched for it. Resume the job when you have decided what to ` +
      `do about the budget.`,
  );
}

/**
 * Pausing a job, and starting it again.
 *
 * A paused job fires nothing — `fireJob` refuses one whichever door it
 * is reached through, and the tick records a `skipped` row with `paused`
 * for each occurrence that came round while it was off, so the history
 * says what did not happen rather than showing a silent gap.
 *
 * Resuming does not catch the missed occurrences up. Each one was
 * decided about and written down, so the sweep starts after the newest
 * of them: a job resumed on Friday files Friday's work, not Monday's
 * through Thursday's as well.
 *
 * `reason` defaults to "by hand" because that is what every caller but
 * the guard above is: a default of "budget" would be a guess, and a
 * required argument would make the ordinary case say the obvious thing
 * at every call site.
 */
export function pauseJob(db: Db, id: Uuid, at: number = Date.now(), reason: JobPauseReason = "by hand"): Job | undefined {
  return setJobPaused(db, id, at, reason);
}

export function resumeJob(db: Db, id: Uuid): Job | undefined {
  return setJobPaused(db, id, null);
}

/**
 * What this job has cost: every run of every item its occurrences filed
 * (ARCHITECTURE.md, "Jobs").
 *
 * Summed over the occurrences rather than stored on the job, for
 * `ItemOrigin`'s reason — the occurrence already records which item a
 * firing produced, and a running total on `jobs` would be the same fact
 * written twice with nothing keeping the two honest.
 *
 * Deduplicated, because an item may be named by more than one
 * occurrence: a conversation that creates a container and its children
 * writes one occurrence each, and a person pressing Run now on an offer
 * fires the occurrence it was made for. A job's cost is what its work
 * cost, not how many rows point at it.
 */
export function jobCostCents(db: Db, jobId: Uuid): number {
  const itemIds = new Set<string>();
  for (const occurrence of listOccurrences(db, jobId)) {
    if (occurrence.itemId !== null) itemIds.add(occurrence.itemId);
  }
  return sumCostCentsForItems(db, [...itemIds] as Uuid[]);
}
