import { eq } from "drizzle-orm";
import type { Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { jobWatchStates } from "../schema.js";

/**
 * Where each watch job's checks stand (EO-753, migration 0169): one row
 * per job, updated in place, and none before its first check.
 */

export interface JobWatchStateRow {
  jobId: string;
  lastCheckedAt: number | null;
  lastAnswer: string | null;
  nextCheckAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  waitingForItemId: string | null;
}

export function getJobWatchState(db: Db, jobId: Uuid): JobWatchStateRow | undefined {
  return db.select().from(jobWatchStates).where(eq(jobWatchStates.jobId, jobId)).get();
}

/** Writes what the patch names, making the row where there is none. */
export function saveJobWatchState(db: Db, jobId: Uuid, patch: Partial<Omit<JobWatchStateRow, "jobId">>): JobWatchStateRow {
  const before = getJobWatchState(db, jobId);
  const next: JobWatchStateRow = {
    jobId,
    lastCheckedAt: null,
    lastAnswer: null,
    nextCheckAt: null,
    consecutiveFailures: 0,
    lastError: null,
    waitingForItemId: null,
    ...before,
    ...patch,
  };
  const columns = {
    lastCheckedAt: next.lastCheckedAt,
    lastAnswer: next.lastAnswer,
    nextCheckAt: next.nextCheckAt,
    consecutiveFailures: next.consecutiveFailures,
    lastError: next.lastError,
    waitingForItemId: next.waitingForItemId,
  };
  db.insert(jobWatchStates).values(next).onConflictDoUpdate({ target: jobWatchStates.jobId, set: columns }).run();
  return next;
}
