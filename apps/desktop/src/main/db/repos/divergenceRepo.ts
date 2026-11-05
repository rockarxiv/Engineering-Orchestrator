import { eq, isNotNull } from "drizzle-orm";
import type { Db } from "../client.js";
import { pipelines } from "../schema.js";

/**
 * Which pipelines this machine has edited out from under its
 * organisation (EO-331, `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Two columns and four questions. Writing one is what *Suggest a
 * change* does before it exports anything — the original design's "opens an editable
 * copy" — and clearing one is what *Discard my edits* does after the
 * published graph is back.
 *
 * Nothing here decides whether a pipeline is *editable*: that is the
 * lock, it is derived in `managed/locks.ts`, and this is one of the
 * facts it reads. Kept apart from `publishedSectionsRepo` for the same
 * reason the lock is kept apart from the rows behind it — a publish is
 * the organisation's act and a divergence is a person's, and one file
 * that wrote both would be one place to confuse them.
 */

export interface Divergence {
  /** The published version the local copy was made from. */
  versionId: string;
  /** When it was made. */
  at: number;
}

/**
 * Marks this machine's copy of a pipeline as the person's own.
 *
 * Idempotent, and that matters more than it looks: *Suggest a change*
 * is pressed on a pipeline that may already be diverged, and a second
 * mark would move "based on v6" forward to whatever is published now —
 * rewriting what the person's edits were made against, which is the one
 * thing the row exists to remember. So an already-diverged pipeline is
 * left exactly as it is, and the answer says which happened.
 */
export function markDiverged(db: Db, pipelineId: string, versionId: string | null, at: number): "marked" | "already" {
  if (divergence(db, pipelineId) !== undefined) return "already";
  db.update(pipelines).set({ divergedFromVersionId: versionId, divergedAt: at, updatedAt: at }).where(eq(pipelines.id, pipelineId)).run();
  return "marked";
}

/**
 * Takes the mark off, which is what discarding local edits ends with.
 *
 * The caller restores the published graph first. The order is
 * load-bearing in one direction only — a graph restored while the row
 * still says diverged is a correct graph nobody has told the screens
 * about yet, where a mark cleared before the restore would leave a
 * window in which a publish could land on edits still in the database.
 */
export function clearDivergence(db: Db, pipelineId: string, at: number): void {
  db.update(pipelines).set({ divergedFromVersionId: null, divergedAt: null, updatedAt: at }).where(eq(pipelines.id, pipelineId)).run();
}

/** What this pipeline diverged from, or nothing where it has not. */
export function divergence(db: Db, pipelineId: string): Divergence | undefined {
  const row = db
    .select({ versionId: pipelines.divergedFromVersionId, at: pipelines.divergedAt })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .get();
  if (row === undefined || row.at === null) return undefined;
  return { versionId: row.versionId ?? "", at: row.at };
}

/**
 * Whether a publish arriving from the record may write over this
 * pipeline.
 *
 * Asked by `upsertReplicaPipeline` and by the lock. One function rather
 * than each reading the column, because "diverged" is a word two
 * subsystems say about the same row and a second reading of it is a
 * second answer.
 */
export function isDiverged(db: Db, pipelineId: string): boolean {
  return divergence(db, pipelineId) !== undefined;
}

/** Every pipeline on this machine the organisation's publishes no longer reach. */
export function divergedPipelineIds(db: Db): Set<string> {
  return new Set(db.select({ id: pipelines.id }).from(pipelines).where(isNotNull(pipelines.divergedAt)).all().map((row) => row.id));
}
