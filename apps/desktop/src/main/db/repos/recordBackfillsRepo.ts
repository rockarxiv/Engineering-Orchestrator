import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { RecordCursors, Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { recordBackfills } from "../schema.js";

/**
 * The history a desktop owes a project it has only just heard of
 * (EO-325, review).
 *
 * `record:changes` pages forwards on when each row was written, so a
 * project *moved* to the record — arriving with the dates its work
 * actually happened on — is invisible to any desktop whose cursors have
 * already run past them. It gets the project row and none of the items,
 * threads or escalations behind it, which is both cross-desktop
 * acceptance criteria failing quietly on the machine that was already
 * in use.
 *
 * So the arrival of a project is recorded here as a debt, and the drain
 * pays it off with project-scoped pulls on cursors of their own. See
 * `0097_project_backfill.sql`.
 */
export interface Backfill {
  projectId: Uuid;
  cursors: RecordCursors;
}

/**
 * Notes that this project's history has not been read yet.
 *
 * Idempotent, and deliberately does *not* reopen a finished one: a
 * project row pages again every time somebody renames it, and re-reading
 * years of history on a rename would be a spike of work for a word.
 */
export function wantBackfill(db: Db, projectId: Uuid, cursors: RecordCursors, now: number): void {
  db.insert(recordBackfills)
    .values({ projectId, cursors, createdAt: now, doneAt: null })
    .onConflictDoNothing()
    .run();
}

/** The debts still outstanding, oldest first. */
export function backfillsOutstanding(db: Db, limit = 20): Backfill[] {
  return db
    .select()
    .from(recordBackfills)
    .where(isNull(recordBackfills.doneAt))
    .orderBy(asc(recordBackfills.createdAt), asc(recordBackfills.projectId))
    .limit(limit)
    .all()
    .map((row) => ({ projectId: row.projectId as Uuid, cursors: row.cursors as RecordCursors }));
}

/**
 * How far the scoped pull has got.
 *
 * Written after each page is applied, exactly as the shared cursor is:
 * every apply is idempotent, so a crash between the two costs one page
 * read twice, where the other order costs a page nobody ever reads.
 */
export function rememberBackfill(db: Db, projectId: Uuid, cursors: RecordCursors): void {
  db.update(recordBackfills).set({ cursors }).where(eq(recordBackfills.projectId, projectId)).run();
}

/** Paid off: a scoped page came back saying there was no more. */
export function backfillDone(db: Db, projectId: Uuid, now: number): void {
  db.update(recordBackfills)
    .set({ doneAt: now })
    .where(and(eq(recordBackfills.projectId, projectId), isNull(recordBackfills.doneAt)))
    .run();
}

/** Whether this desktop still owes anything — for a test, and for a log line. */
export function backfillsOwed(db: Db): number {
  return db.get<{ n: number }>(sql`select count(*) as n from record_backfills where done_at is null`)?.n ?? 0;
}
