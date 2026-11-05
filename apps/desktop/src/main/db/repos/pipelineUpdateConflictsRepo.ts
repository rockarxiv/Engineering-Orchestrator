import { and, asc, eq, isNull } from "drizzle-orm";
import { uuidv7, type Uuid } from "@eo/core";
import type { KeyChange } from "@eo/engine";
import type { Db } from "../client.js";
import { pipelineUpdateConflicts } from "../schema.js";
import { dismissOpenMentionsForComment } from "./commentsRepo.js";

/**
 * Template updates a pipeline could not take (EO-532, ARCHITECTURE.md,
 * "Template versions and origins").
 *
 * One row per held update: the template version, the base it was
 * compared with, and each conflicting key with its three values. The
 * pipeline is untouched while it is open. What happens next — a notice
 * in the person's inbox, the assistant proposing merged drafts, and the
 * resolution that moves the base — reads these rows.
 */
export interface PipelineUpdateConflict {
  id: string;
  pipelineId: string;
  templateSlug: string;
  fromVersion: string;
  toVersion: string;
  /** The base, a `template_versions.id`. */
  baseId: string;
  /** The version that was held, a `template_versions.id`. */
  templateId: string;
  notes: string;
  /** Each conflicting key with its base, current and template values, in the pipeline's own step ids. */
  conflicts: KeyChange[];
  /** Why the merge would not validate, where that is what held it. */
  problems: string[];
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
  /**
   * The comments the conflict notice was posted as (EO-533): one per
   * project thread it went to. Empty where nobody could be told — a
   * pipeline with no project and no work on any.
   */
  noticeCommentIds: string[];
  /** The assistant chat Fix with assistant opened for it, or null before the first press (EO-533). */
  chatId: string | null;
  /** On the record, the device the chat's first turn was handed to; null before then and on a desktop (EO-533). */
  chatTurnDeviceId: string | null;
}

export type RecordUpdateConflictInput = Omit<PipelineUpdateConflict, "id" | "createdAt" | "resolvedAt" | "resolution" | "noticeCommentIds" | "chatId" | "chatTurnDeviceId"> & {
  noticeCommentIds?: string[];
};

function toConflict(row: typeof pipelineUpdateConflicts.$inferSelect): PipelineUpdateConflict {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    templateSlug: row.templateSlug,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    baseId: row.baseId,
    templateId: row.templateId,
    notes: row.notes,
    conflicts: Array.isArray(row.conflicts) ? (row.conflicts as KeyChange[]) : [],
    problems: Array.isArray(row.problems) ? (row.problems as unknown[]).filter((problem): problem is string => typeof problem === "string") : [],
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
    noticeCommentIds: Array.isArray(row.noticeCommentIds) ? (row.noticeCommentIds as unknown[]).filter((id): id is string => typeof id === "string") : [],
    chatId: row.chatId,
    chatTurnDeviceId: row.chatTurnDeviceId,
  };
}

/** Records an open update conflict. The caller closes any older open one first (`resolveUpdateConflict`). */
export function recordUpdateConflict(db: Db, input: RecordUpdateConflictInput, at: number = Date.now(), id: string = uuidv7()): PipelineUpdateConflict {
  const recorded = { id, ...input, noticeCommentIds: input.noticeCommentIds ?? [], chatId: null, chatTurnDeviceId: null, createdAt: at, resolvedAt: null, resolution: null };
  db.insert(pipelineUpdateConflicts).values(recorded).run();
  return recorded;
}

/** One update conflict, open or resolved, or undefined where this installation holds none by that id. */
export function getUpdateConflict(db: Db, id: string): PipelineUpdateConflict | undefined {
  const row = db.select().from(pipelineUpdateConflicts).where(eq(pipelineUpdateConflicts.id, id)).get();
  return row === undefined ? undefined : toConflict(row);
}

/**
 * Whether this pipeline's update to a template version has already been
 * announced as a conflict (EO-533), resolved since or not.
 *
 * What keeps the notice to one per version: whatever happens to the first
 * — resolved, superseded, left open — a later comparison against the same
 * version is never told again.
 */
export function updateConflictNoticed(db: Db, pipelineId: string, toVersion: string): boolean {
  return db
    .select()
    .from(pipelineUpdateConflicts)
    .where(and(eq(pipelineUpdateConflicts.pipelineId, pipelineId), eq(pipelineUpdateConflicts.toVersion, toVersion)))
    .all()
    .some((row) => toConflict(row).noticeCommentIds.length > 0);
}

/** Records the comments a conflict's notice was posted as, where it is announced after it was held (EO-533). */
export function setUpdateConflictNotices(db: Db, id: string, commentIds: readonly string[]): void {
  db.update(pipelineUpdateConflicts).set({ noticeCommentIds: [...commentIds] }).where(eq(pipelineUpdateConflicts.id, id)).run();
}

/**
 * Records the chat Fix with assistant opened for a conflict, so a second
 * press shows that one (EO-533). A new chat's first turn is nobody's yet.
 */
export function setUpdateConflictChat(db: Db, id: string, chatId: string): void {
  db.update(pipelineUpdateConflicts).set({ chatId, chatTurnDeviceId: null }).where(eq(pipelineUpdateConflicts.id, id)).run();
}

/**
 * Hands the first turn of a conflict's chat to one device, on the record
 * (EO-533): the first device to ask is handed it, and keeps it. Answers
 * whether this device holds it — true for the device it was handed to,
 * every time it asks, so an answer lost on the way is not a turn lost;
 * false for every other.
 *
 * One conditional write, so two devices asking at once are one winner.
 */
export function handUpdateConflictTurn(db: Db, id: string, deviceId: string): boolean {
  db.update(pipelineUpdateConflicts)
    .set({ chatTurnDeviceId: deviceId })
    .where(and(eq(pipelineUpdateConflicts.id, id), isNull(pipelineUpdateConflicts.chatTurnDeviceId)))
    .run();
  return getUpdateConflict(db, id)?.chatTurnDeviceId === deviceId;
}

/** The open conflict whose Fix with assistant chat this is, or undefined. */
export function openUpdateConflictForChat(db: Db, chatId: string): PipelineUpdateConflict | undefined {
  const row = db
    .select()
    .from(pipelineUpdateConflicts)
    .where(and(eq(pipelineUpdateConflicts.chatId, chatId), isNull(pipelineUpdateConflicts.resolvedAt)))
    .get();
  return row === undefined ? undefined : toConflict(row);
}

/** This pipeline's open update conflict, or undefined where it has none. */
export function openUpdateConflict(db: Db, pipelineId: string): PipelineUpdateConflict | undefined {
  const row = db
    .select()
    .from(pipelineUpdateConflicts)
    .where(and(eq(pipelineUpdateConflicts.pipelineId, pipelineId), isNull(pipelineUpdateConflicts.resolvedAt)))
    .orderBy(asc(pipelineUpdateConflicts.createdAt))
    .get();
  return row === undefined ? undefined : toConflict(row);
}

/** Every update conflict this pipeline has had, oldest first, resolved ones included. */
export function listUpdateConflicts(db: Db, pipelineId: string): PipelineUpdateConflict[] {
  return db.select().from(pipelineUpdateConflicts).where(eq(pipelineUpdateConflicts.pipelineId, pipelineId)).orderBy(asc(pipelineUpdateConflicts.createdAt)).all().map(toConflict);
}

/**
 * Closes an open update conflict, saying how. A closed one is never
 * reopened.
 *
 * Its notice closes with it (EO-533): every mention the notice put in
 * somebody's inbox is dismissed in the same write, however the conflict
 * was resolved — a draft published from its chat, the person keeping
 * their own version, or a newer template version superseding it. A
 * notice asking for something already settled would be a `!` with
 * nothing behind it.
 */
export function resolveUpdateConflict(db: Db, id: string, resolution: string, at: number = Date.now()): void {
  db.transaction(() => {
    const closed = db
      .update(pipelineUpdateConflicts)
      .set({ resolvedAt: at, resolution })
      .where(and(eq(pipelineUpdateConflicts.id, id), isNull(pipelineUpdateConflicts.resolvedAt)))
      .returning()
      .all();
    for (const row of closed) {
      for (const commentId of toConflict(row).noticeCommentIds) dismissOpenMentionsForComment(db, commentId as Uuid);
    }
  });
}
