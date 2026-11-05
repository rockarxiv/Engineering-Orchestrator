import { and, asc, eq, isNull } from "drizzle-orm";
import { uuidv7, type RepositoryIndex, type RepositoryIndexStatus, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { repositoryIndexes } from "../schema.js";

/**
 * Reads and writes for `repository_indexes` (EO-145).
 *
 * Rows only. Nothing here builds, syncs or deletes an index on disk,
 * and nothing here decides whether a status change is allowed — that
 * belongs to `main/repositoryIntelligence/service.ts`, which is the
 * only caller that should be writing a status at all. The split is the
 * same one `transitionsRepo` and the engine have: the repository knows
 * how to write a row, the layer above knows which writes are legal.
 *
 * Every function takes the target as (workspaceId, itemId) rather
 * than as an id, because that is what callers have. A worktree is
 * created for an item and an index is asked for by pointing at it; the
 * row's own id is an implementation detail nobody upstream holds.
 */

function toDomain(row: typeof repositoryIndexes.$inferSelect): RepositoryIndex {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    itemId: row.itemId,
    provider: row.provider,
    indexPath: row.indexPath,
    status: row.status as RepositoryIndexStatus,
    indexedCommitSha: row.indexedCommitSha,
    indexedAt: row.indexedAt,
    updatedAt: row.updatedAt,
    providerVersion: row.providerVersion,
    errorMessage: row.errorMessage,
    lastSyncDurationMs: row.lastSyncDurationMs,
    lastSyncChangedFiles: row.lastSyncChangedFiles,
    lastIndexDurationMs: row.lastIndexDurationMs,
    indexSizeBytes: row.indexSizeBytes,
  };
}

/**
 * Which row a caller means.
 *
 * `itemId: null` is the repository's own baseline, which nothing
 * writes in this version. It is spelled out rather than optional so
 * that "the baseline" and "I forgot to pass an item" cannot be the
 * same call.
 */
export interface RepositoryIndexKey {
  workspaceId: string;
  itemId: string | null;
}

/**
 * The comparison that finds one row.
 *
 * `isNull` and not `eq(column, null)`: SQL's `= NULL` is never true, so
 * the second spelling silently returns nothing for every baseline row.
 * That is precisely the bug the nullable column invites, so it is
 * written once here and nowhere else.
 */
function matches(key: RepositoryIndexKey) {
  return and(
    eq(repositoryIndexes.workspaceId, key.workspaceId),
    key.itemId === null ? isNull(repositoryIndexes.itemId) : eq(repositoryIndexes.itemId, key.itemId),
  );
}

export function getRepositoryIndex(db: Db, key: RepositoryIndexKey): RepositoryIndex | undefined {
  const row = db.select().from(repositoryIndexes).where(matches(key)).get();
  return row ? toDomain(row) : undefined;
}

export function getRepositoryIndexById(db: Db, id: string): RepositoryIndex | undefined {
  const row = db.select().from(repositoryIndexes).where(eq(repositoryIndexes.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/** Every index EO has a note about, or every one for a single repository. */
export function listRepositoryIndexes(db: Db, workspaceId?: string): RepositoryIndex[] {
  const query = db.select().from(repositoryIndexes).orderBy(asc(repositoryIndexes.id));
  const rows = workspaceId === undefined ? query.all() : query.where(eq(repositoryIndexes.workspaceId, workspaceId)).all();
  return rows.map(toDomain);
}

export interface RecordRepositoryIndexInput extends RepositoryIndexKey {
  provider: string;
  indexPath: string;
  status: RepositoryIndexStatus;
  providerVersion?: string | null;
}

/**
 * Writes the note for a target, creating it or replacing what it says.
 *
 * Upsert rather than insert, and the reason is the missing UNIQUE
 * index. The rule is one row per (repository, item), and SQLite
 * cannot express it for the baseline rows this table is shaped to
 * accept later — NULLs are distinct in a unique index. So this is the
 * enforcement: a second `recordRepositoryIndex` for a target EO already
 * has a note about rewrites that note rather than growing a duplicate
 * nothing could then choose between.
 *
 * Rewriting is also the right behaviour on its own terms. A worktree
 * that is indexed again — a different provider, a different path, a
 * fresh build after the directory was thrown away — is the same target,
 * and its history is not something this table is keeping.
 */
export function recordRepositoryIndex(db: Db, input: RecordRepositoryIndexInput, now = Date.now()): RepositoryIndex {
  const existing = getRepositoryIndex(db, input);
  const values = {
    provider: input.provider,
    indexPath: input.indexPath,
    status: input.status,
    providerVersion: input.providerVersion ?? null,
    updatedAt: now,
  };

  if (existing) {
    db.update(repositoryIndexes).set(values).where(eq(repositoryIndexes.id, existing.id)).run();
    return getRepositoryIndexById(db, existing.id) as RepositoryIndex;
  }

  const id = uuidv7() as Uuid;
  db.insert(repositoryIndexes)
    .values({
      id,
      workspaceId: input.workspaceId,
      itemId: input.itemId,
      indexedCommitSha: null,
      indexedAt: null,
      errorMessage: null,
      lastSyncDurationMs: null,
      lastSyncChangedFiles: null,
      lastIndexDurationMs: null,
      indexSizeBytes: null,
      ...values,
    })
    .run();
  return getRepositoryIndexById(db, id) as RepositoryIndex;
}

/**
 * What a status change may carry with it.
 *
 * All optional, because the fields belong to different moves: a
 * successful build sets the commit and the version and clears the
 * error, a failure sets the error and touches neither of the others,
 * and a move into an in-flight status sets none of them.
 */
export interface RepositoryIndexPatch {
  status: RepositoryIndexStatus;
  /**
   * Which implementation the row now describes.
   *
   * Written on a successful build, because whoever just built the index
   * is what the directory now holds. A row that kept naming the
   * implementation it was *previously* built by would be read as
   * somebody else's index forever, and re-marked stale on every
   * resolution no matter how many times it was rebuilt.
   */
  provider?: string;
  indexPath?: string;
  indexedCommitSha?: string | null;
  indexedAt?: number | null;
  providerVersion?: string | null;
  errorMessage?: string | null;
  /**
   * What the sync that is finishing cost (EO-153).
   *
   * Optional like everything else here, and for the sharper version of
   * the same reason: only one move writes them. A build from nothing has
   * no changed-file count to report and an update that fell over has no
   * cost worth recording, so a patch that left them out must leave the
   * last successful sync's numbers standing rather than blank them.
   */
  lastSyncDurationMs?: number | null;
  lastSyncChangedFiles?: number | null;
  /**
   * What the build that is finishing cost, and how big the index it left
   * behind is (EO-155).
   *
   * Optional for the same reason and with the same consequence: a sync
   * reports a size and no build duration, so a patch that left the
   * duration out must leave the last real build's standing rather than
   * blank it.
   */
  lastIndexDurationMs?: number | null;
  indexSizeBytes?: number | null;
}

/**
 * Writes a status and whatever travels with it.
 *
 * Unconditional: legality is the service's question, and a repository
 * that also answered it would give the service a second way to be
 * bypassed. What this does guarantee is that `updated_at` moves on
 * every write, so "when did EO last look at this" is answerable
 * without a second column nobody would remember to set.
 */
export function setRepositoryIndexStatus(db: Db, id: string, patch: RepositoryIndexPatch, now = Date.now()): RepositoryIndex | undefined {
  const existing = getRepositoryIndexById(db, id);
  if (!existing) return undefined;

  db.update(repositoryIndexes)
    .set({
      status: patch.status,
      ...(patch.provider === undefined ? {} : { provider: patch.provider }),
      ...(patch.indexPath === undefined ? {} : { indexPath: patch.indexPath }),
      ...(patch.indexedCommitSha === undefined ? {} : { indexedCommitSha: patch.indexedCommitSha }),
      ...(patch.indexedAt === undefined ? {} : { indexedAt: patch.indexedAt }),
      ...(patch.providerVersion === undefined ? {} : { providerVersion: patch.providerVersion }),
      ...(patch.errorMessage === undefined ? {} : { errorMessage: patch.errorMessage }),
      ...(patch.lastSyncDurationMs === undefined ? {} : { lastSyncDurationMs: patch.lastSyncDurationMs }),
      ...(patch.lastSyncChangedFiles === undefined ? {} : { lastSyncChangedFiles: patch.lastSyncChangedFiles }),
      ...(patch.lastIndexDurationMs === undefined ? {} : { lastIndexDurationMs: patch.lastIndexDurationMs }),
      ...(patch.indexSizeBytes === undefined ? {} : { indexSizeBytes: patch.indexSizeBytes }),
      updatedAt: now,
    })
    .where(eq(repositoryIndexes.id, id))
    .run();

  return getRepositoryIndexById(db, id);
}

/**
 * Forgets the note.
 *
 * A deletion here is not a rewrite of history in the sense invariant #3
 * protects. `run_events` is the durability substrate and records what
 * happened; this table records the state of a cache, and a note about a
 * directory that has been deleted is worse than no note at all — it is
 * an index a later reader would try to use.
 */
export function deleteRepositoryIndex(db: Db, id: string): void {
  db.delete(repositoryIndexes).where(eq(repositoryIndexes.id, id)).run();
}

/**
 * Forgets every note EO holds about one item's checkout, answering
 * with how many there were.
 *
 * The plural is not a hedge about an item belonging to two
 * repositories — it belongs to one, so this is at most a single row.
 * It is that the one-row-per-target rule is enforced by
 * `recordRepositoryIndex` above rather than by SQLite, and "delete the
 * row" and "delete the rows" are the same statement while only one of
 * them stays true if that ever slips.
 *
 * The count is what a caller reports, so a sweep can say what it
 * removed rather than that it ran.
 */
export function deleteRepositoryIndexesForItem(db: Db, itemId: string): number {
  // Counted by reading first rather than from the statement's own
  // `changes`, so the number is the rows this call is about and not
  // whatever the driver last touched.
  const doomed = db.select().from(repositoryIndexes).where(eq(repositoryIndexes.itemId, itemId)).all();
  if (doomed.length === 0) return 0;
  db.delete(repositoryIndexes).where(eq(repositoryIndexes.itemId, itemId)).run();
  return doomed.length;
}
