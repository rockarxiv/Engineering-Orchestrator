import { and, desc, eq, lt, or } from "drizzle-orm";
import { uuidv7, type JobWatchCheck, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { jobWatchChecks } from "../schema.js";

/**
 * Every check a watch job ran (EO-800, migration 0173).
 *
 * **Append-only.** There is deliberately no update and no delete here,
 * as `jobEventsRepo` has none, and `db/architecturalInvariants.test.ts`
 * holds the whole tree to it. A row goes only when its job's row does,
 * by the schema's cascade.
 */

export type RecordWatchCheckInput = Omit<JobWatchCheck, "id">;

/** Appends one check. The only write this table has. */
export function recordWatchCheck(db: Db, input: RecordWatchCheckInput): JobWatchCheck {
  const row = { id: uuidv7(), ...input };
  db.insert(jobWatchChecks).values(row).run();
  return row;
}

/**
 * A job's checks, newest first: at most `limit`, and only those after
 * `before` in that order when it names one of the job's checks.
 */
export function listWatchChecks(db: Db, jobId: Uuid, limit: number, before?: string): JobWatchCheck[] {
  const cursor =
    before === undefined
      ? undefined
      : db
          .select({ id: jobWatchChecks.id, startedAt: jobWatchChecks.startedAt })
          .from(jobWatchChecks)
          .where(and(eq(jobWatchChecks.jobId, jobId), eq(jobWatchChecks.id, before)))
          .get();
  if (before !== undefined && cursor === undefined) return [];
  const after =
    cursor === undefined
      ? undefined
      : or(lt(jobWatchChecks.startedAt, cursor.startedAt), and(eq(jobWatchChecks.startedAt, cursor.startedAt), lt(jobWatchChecks.id, cursor.id)));
  return db
    .select()
    .from(jobWatchChecks)
    .where(after === undefined ? eq(jobWatchChecks.jobId, jobId) : and(eq(jobWatchChecks.jobId, jobId), after))
    .orderBy(desc(jobWatchChecks.startedAt), desc(jobWatchChecks.id))
    .limit(limit)
    .all();
}
