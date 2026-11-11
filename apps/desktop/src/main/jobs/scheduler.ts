import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getProject, listAllJobs } from "../db/repos/index.js";
import { isProjectReplica } from "../db/recordRole.js";
import { startInterval } from "../schedule/interval.js";
import { catchUpEntryVerdicts, catchUpJob, jobsWithModuleRules, type CatchUpDeps } from "./catchUp.js";
import { releaseHeldWebhookEvents, type WebhookDeps } from "./webhook.js";

/**
 * The job scheduler (EO-304, `ARCHITECTURE.md`, "Trigger kinds";
 * EO-306, `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * The third caller of the one interval loop EO-303 extracted, and the
 * reason it was extracted: a tick, a non-overlap flag, an unref'd timer
 * and a tick at launch were about to be written a third time.
 *
 * Every minute, because a schedule's finest grain is a minute and
 * checking more often buys nothing. A tick fires the `schedule` jobs
 * that have come round; `manual` waits for a person to press Run now and
 * `from-discussion` waits for a person to press Create, so a tick does
 * nothing at all for either, which is deliberate rather than an
 * omission. A kind EO does not know — one written by a newer version —
 * is passed over the same way, rather than fired wrongly or crashing the
 * sweep.
 *
 * A `webhook` job is not fired by a tick either, and for a sharper
 * reason than the other two: its events arrive at the server, which
 * files them as they come (EO-332, ARCHITECTURE.md, "Controls"). What the tick does for one is
 * the second half of that — **releasing what a burst left waiting**,
 * oldest first, as the job's items-per-hour makes room. That is
 * `releaseHeldWebhookEvents`, and it is here rather than in a loop of
 * its own because "the record owns item state and runs the only
 * scheduler" is one sentence and this is the scheduler.
 */

const MINUTE_MS = 60 * 1000;

export interface JobSchedulerOptions {
  intervalMs?: number;
  onTick?: (result: JobTickResult) => void;
  /**
   * What a released webhook event needs that the sweep does not have
   * (EO-332): somewhere to keep the payload as a file. Handed in by the
   * composition root, because attachment storage is a directory on this
   * machine and this module has none.
   */
  webhooks?: WebhookDeps;
}

export interface JobTickResult {
  /** How many jobs the tick looked at. */
  considered: number;
  /** The occurrences it fired, as `jobId` per item created. */
  fired: string[];
  /** The occurrences it decided not to fire, and told the person about. */
  skipped: string[];
}

/**
 * One sweep over every job.
 *
 * Returned rather than logged so it can be asserted on: a loop whose
 * only evidence is a console line is a loop nobody tests.
 *
 * Each job is caught up in its own try, so a job whose pipeline was
 * deleted out from under it is a guard about one job rather than the
 * reason none of the others ran this minute.
 */
export function runJobTick(db: Db, deps: CatchUpDeps = {}): JobTickResult {
  /**
   * Only the jobs this installation is the writer for (EO-325).
   *
   * A job fires by *creating an item* and writing an occurrence, and
   * both are the record's to write. After a project is moved, its jobs
   * exist in two databases — the organisation's and the replica's — and
   * a scheduler in each would fire the same due occurrence twice, each
   * filing an item the other has never heard of. The desktop's copy
   * would not even reach the record: a created item is not one of the
   * commands the outbound queue carries.
   *
   * So a device passes over a moved project's jobs and the record fires
   * them, which is the same sentence the pinned decision writes for
   * dispatches — "the record owns item state and runs the only
   * scheduler". Where the *work* then happens is unchanged and is
   * the design's: the record leases the dispatch to a device, which runs it
   * on somebody's machine with their files and their logins.
   *
   * Asked of the job's project through `isProjectReplica`, which is
   * `isReplica` — the question every other writer in this process asks —
   * asked before there is an item, because asking it a second way is how
   * two answers come to differ. A solo desktop, a
   * server, and every test that has not registered a record answer
   * false and this reads as it always did.
   */
  const jobs = listAllJobs(db).filter(
    (job) =>
      // …and never one whose project is half way between two
      // databases. `fireJob` refuses it at the door either way; the
      // tick passes over it so that it does not write a `skipped` row
      // about an occurrence nobody was going to run. A transfer takes
      // seconds, and the occurrence is still due on the other side of
      // it.
      !isProjectReplica(db, job.projectId as Uuid | null) && !(job.projectId !== null && getProject(db, job.projectId as Uuid)?.adoptingAt != null),
  );
  const result: JobTickResult = { considered: jobs.length, fired: [], skipped: [] };
  // One `now` for the whole sweep, so two jobs due at the same minute
  // are decided against the same clock rather than against whichever
  // moment their turn came round.
  const at: CatchUpDeps = { ...deps, now: deps.now ?? Date.now() };
  for (const job of jobs) {
    try {
      const caught = catchUpJob(db, job, at);
      for (const occurrence of caught.fired) result.fired.push(occurrence.jobId);
      for (const occurrence of caught.skipped) result.skipped.push(occurrence.jobId);
    } catch (error) {
      console.error(`[eo] the job "${job.name}" could not be caught up:`, error);
    }
  }
  return result;
}

/**
 * Ticks every minute, and at launch.
 *
 * **At launch is what makes the catch-up work at all.** A laptop opened
 * at 09:10 fires the 08:00 occurrence within seconds of the window
 * appearing, rather than at the top of the next minute and rather than
 * never — which is `startArchiveSweep`'s reason and the design's: a desktop
 * app closed every evening would otherwise never reach a daily tick.
 *
 * Returns a stop function. The shared loop's own catch is what keeps a
 * job that throws from being the reason the app falls over.
 */
export function startJobScheduler(db: Db, options: JobSchedulerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? MINUTE_MS;
  const loop = startInterval({
    name: "job scheduler",
    tick: async () => {
      // The sweep first and the callback after, on two lines and not one.
      // `options.onTick?.(runJobTick(db))` reads as the same thing and is
      // not: optional call short-circuits its *arguments*, so with no
      // `onTick` — which is how the app itself starts this — the tick
      // never ran at all.
      // A pipeline's module entry rules first (EO-736): the sweep files
      // synchronously, so what they say of each item it could file is
      // asked beforehand, against the same clock.
      // Waited for only where a job's pipeline has one, so every other
      // sweep runs in the same turn it always did.
      const now = Date.now();
      const jobs = listAllJobs(db);
      const entryVerdicts = jobsWithModuleRules(db, jobs) ? await catchUpEntryVerdicts(db, jobs, now) : undefined;
      const result = runJobTick(db, { now, ...(entryVerdicts === undefined ? {} : { entryVerdicts }) });
      options.onTick?.(result);
      // …and then what a webhook burst left waiting (EO-332, ARCHITECTURE.md, "Controls").
      // After the schedules and inside the same non-overlap flag, so a
      // slow release delays the next sweep rather than running beside
      // it — the loop holds the flag until this promise settles.
      await releaseHeldWebhookEvents(db, options.webhooks ?? {});
    },
    readIntervalMs: () => intervalMs,
  });
  return loop.stop;
}
