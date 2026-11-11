import { and, asc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { onProject } from "./projectScope.js";
import type { AgentAttachment, RecordCursor, Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { attachmentRemovals, attachments, comments, jiraAttachmentLinks, outbox, items, retiredAttachmentFiles } from "../schema.js";
import { notifyItemAttachmentsAdded, notifyItemAttachmentRemoved } from "../itemAttachmentEvents.js";
import { isReplica } from "../recordRole.js";
import { jiraStateFor } from "./itemsRepo.js";
import { enqueueOutbox } from "./outboxRepo.js";

/**
 * The attachment read, joined to its Jira link (KAN-148).
 *
 * `attachments.jira_attachment_id` is a row in `jira_attachment_links`
 * now — a dedupe key with a unique index, which is exactly what a JSON
 * extension slot cannot carry. The projection keeps every reader below
 * reading the field it always read.
 */
const attachmentColumns = { ...getTableColumns(attachments), jiraAttachmentId: jiraAttachmentLinks.jiraAttachmentId };

type AttachmentRow = typeof attachments.$inferSelect & { jiraAttachmentId: string | null };

/** Every attachment read starts here, so none of them can lose the link. */
function selectAttachments(db: Db) {
  return db.select(attachmentColumns).from(attachments).leftJoin(jiraAttachmentLinks, eq(jiraAttachmentLinks.attachmentId, attachments.id));
}

export interface AttachmentRecord extends AgentAttachment {
  id: Uuid;
  itemId: Uuid;
  /** Null for one of the item's own files rather than a comment's (EO-702). */
  commentId: Uuid | null;
  path: string;
  managed: boolean;
  jiraAttachmentId: string | null;
  jiraSyncError: string | null;
  createdAt: number;
}

export interface CreateAttachmentRecord {
  id: Uuid;
  itemId: Uuid;
  /** Null for one of the item's own files (EO-702). */
  commentId: Uuid | null;
  storagePath: string;
  name: string;
  mimeType: string;
  size: number;
  managed?: boolean;
  jiraAttachmentId?: string | null;
  jiraSyncError?: string | null;
  createdAt?: number;
}

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    commentId: row.commentId as Uuid | null,
    path: row.storagePath,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    kind: row.mimeType.startsWith("image/") ? "image" : "file",
    origin: row.managed ? "eo" : "legacy",
    synchronizationState: "local",
    managed: row.managed,
    jiraAttachmentId: row.jiraAttachmentId,
    jiraSyncError: row.jiraSyncError,
    createdAt: row.createdAt,
  };
}

export function insertAttachments(db: Db, records: CreateAttachmentRecord[]): void {
  if (records.length === 0) return;
  db.transaction((tx) => {
    tx.insert(attachments)
      .values(records.map((record) => ({
        id: record.id,
        itemId: record.itemId,
        commentId: record.commentId,
        storagePath: record.storagePath,
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
        managed: record.managed ?? true,
        jiraSyncError: record.jiraSyncError ?? null,
        createdAt: record.createdAt ?? Date.now(),
      })))
      .run();

    // A file arriving from Jira knows which Jira attachment it is, and
    // that is a row of its own since KAN-148. In the same transaction as
    // the file: a link without its attachment is a dangling dedupe key,
    // and an imported file without its link would be imported again on
    // the next pull.
    const linked = records.filter((record) => record.jiraAttachmentId != null);
    if (linked.length > 0) {
      tx.insert(jiraAttachmentLinks)
        .values(linked.map((record) => ({ attachmentId: record.id, jiraAttachmentId: record.jiraAttachmentId! })))
        .run();
    }
  });
}

/**
 * Files added to the record after a point, oldest first (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * A change stream of its own, and the race it closes is small and
 * permanent. A device queues a comment and then the file hanging off
 * it, and the record takes them in that order — two writes with a gap
 * between them. A second desktop that pulls *inside* that gap sees the
 * comment, advances its cursor past it, and never looks at it again:
 * the file lands a moment later and that machine is the one desktop in
 * the organisation that does not know it exists, for ever.
 *
 * Carrying the metadata on the comment is still worth doing — it is how
 * a thread says "Anna attached report.pdf" the moment the comment
 * arrives — but it cannot be the only path, because a comment is
 * immutable and is never paged twice. This is the path that does not
 * depend on when the two writes happened to land.
 *
 * Paged on `(created_at, id)` for `RecordCursor`'s reason: several
 * files attached to one comment share a millisecond.
 */
/**
 * `within` scopes the page to one project (EO-325, review).
 *
 * The move does not restamp what it transfers — a comment written in
 * March is a comment written in March — so a desktop whose cursors had
 * already run past March saw the project row arrive and none of its
 * history behind it. It asks for that history here, on cursors of its
 * own, and the keyset is the same one: the scope narrows, nothing else
 * about the paging changes.
 */
export function listAttachmentsSince(db: Db, cursor: RecordCursor, limit: number, within?: string): AttachmentRecord[] {
  return selectAttachments(db)
    .where(
      and(
        sql`(${attachments.createdAt} > ${cursor.ts} or (${attachments.createdAt} = ${cursor.ts} and ${attachments.id} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(attachments.itemId, within),
      ),
    )
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .limit(limit)
    .all()
    .map(toRecord);
}

export function getAttachment(db: Db, id: Uuid): AttachmentRecord | undefined {
  const row = selectAttachments(db).where(eq(attachments.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export function listAttachmentsForComment(db: Db, commentId: Uuid): AttachmentRecord[] {
  return selectAttachments(db).where(eq(attachments.commentId, commentId)).orderBy(attachments.createdAt, attachments.id).all().map(toRecord);
}

export function listAttachmentsForComments(db: Db, commentIds: Uuid[]): AttachmentRecord[] {
  if (commentIds.length === 0) return [];
  return selectAttachments(db).where(inArray(attachments.commentId, commentIds)).orderBy(attachments.createdAt, attachments.id).all().map(toRecord);
}

export function listAttachmentsForItem(db: Db, itemId: Uuid): AttachmentRecord[] {
  return selectAttachments(db).where(eq(attachments.itemId, itemId)).orderBy(attachments.createdAt, attachments.id).all().map(toRecord);
}

/**
 * The item's own files, oldest first (EO-702) — the ones no comment
 * owns. `listAttachmentsForItem` is every file on the item, its
 * comments' included.
 */
export function listItemAttachments(db: Db, itemId: Uuid): AttachmentRecord[] {
  return selectAttachments(db)
    .where(and(eq(attachments.itemId, itemId), isNull(attachments.commentId)))
    .orderBy(attachments.createdAt, attachments.id)
    .all()
    .map(toRecord);
}

/**
 * Puts stored files on the item itself (EO-702), and announces them so
 * the organisation record hears (`record/outbound.ts`). What a replica
 * writes when a file arrives *from* the record goes through
 * `insertAttachments` instead, which announces nothing: telling the
 * record about its own file would be an echo.
 *
 * A mirrored item's files are the Jira issue's files (EO-705), so each
 * is queued for upload in the same transaction, on the terms a comment's
 * file is: not on a replica, whose files reach the tracker from the
 * record, and not for a file that came from Jira — it carries its Jira
 * id, and `queueAttachmentUpload` skips a linked file.
 */
export function addItemAttachments(db: Db, itemId: Uuid, records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): AttachmentRecord[] {
  if (records.length === 0) return [];
  const ours = !isReplica(db, itemId);
  db.transaction((tx) => {
    insertAttachments(tx as unknown as Db, records.map((record) => ({ ...record, itemId, commentId: null })));
    if (ours) for (const record of records) queueAttachmentUpload(tx as unknown as Db, record.id);
  });
  const added = records.map((record) => getAttachment(db, record.id)).filter((record): record is AttachmentRecord => record !== undefined);
  notifyItemAttachmentsAdded(db, itemId, added);
  return added;
}

/**
 * Takes one of the item's own files off it (EO-702): the row, and a
 * removal the record pages to every replica. Undefined for a file that
 * is not there or that a comment owns — a comment's file goes only with
 * its comment. The stored bytes are the caller's to remove, after.
 *
 * `announce` is false where the removal came *from* the record, so it
 * is not sent back to it.
 *
 * The removal also goes to Jira (EO-705): the pending `attachment_delete`
 * is the tombstone that keeps a pull, landing before the outbox drains,
 * from bringing the file back. Told by whoever owns the item's tracker —
 * a solo desktop, or the record when it accepts a device's removal — so
 * never from a replica, whose removal reaches Jira from the record
 * (`recordRole.ts`). `tellJira: false` where nothing should go: a
 * removal that came *from* Jira, which would be an echo, and one a
 * replica applies on the record's word.
 */
export function removeItemAttachment(db: Db, id: Uuid, options: { announce?: boolean; now?: number; itemId?: Uuid; tellJira?: boolean } = {}): AttachmentRecord | undefined {
  const removed = db.transaction((tx) => {
    const row = selectAttachments(tx as unknown as Db).where(eq(attachments.id, id)).get();
    if (!row || row.commentId !== null) return undefined;
    // Named by item as well as by id, where the caller was told which
    // item: a removal for one item never takes another item's file.
    if (options.itemId !== undefined && row.itemId !== options.itemId) return undefined;
    // Asked of `db`, not `tx`: the replica mark is kept against the
    // database object, and a transaction handle is a different one.
    if (options.tellJira !== false && !isReplica(db, row.itemId as Uuid)) queueAttachmentDeletion(tx as unknown as Db, row);
    tx.delete(attachments).where(eq(attachments.id, id)).run();
    noteAttachmentRemoved(tx as unknown as Db, id, row.itemId as Uuid, options.now ?? Date.now());
    return toRecord(row);
  });
  if (removed !== undefined && options.announce !== false) notifyItemAttachmentRemoved(db, removed);
  return removed;
}

/**
 * Remembers that an item file went, once. Also written on a replica and
 * on a solo desktop — one small row per removal — so the record's
 * paging and a desktop's own bookkeeping are the same code.
 */
export function noteAttachmentRemoved(db: Db, attachmentId: Uuid, itemId: Uuid, removedAt: number): void {
  db.insert(attachmentRemovals).values({ attachmentId, itemId, removedAt }).onConflictDoNothing().run();
}

/**
 * Takes back the note that a file was removed (EO-702): what a device
 * does when the record refused the removal, so the file can be fetched
 * back rather than skipped as gone.
 */
export function forgetAttachmentRemoval(db: Db, attachmentId: Uuid): void {
  db.delete(attachmentRemovals).where(eq(attachmentRemovals.attachmentId, attachmentId)).run();
}

/** Whether this file was removed from its item here (EO-702) — so a late copy of it is not taken back in. */
export function attachmentWasRemoved(db: Db, attachmentId: Uuid): boolean {
  return db.select({ id: attachmentRemovals.attachmentId }).from(attachmentRemovals).where(eq(attachmentRemovals.attachmentId, attachmentId)).get() !== undefined;
}

/** Item files removed after a point, oldest first — the record's page of them (EO-702). */
export function listAttachmentRemovalsSince(
  db: Db,
  cursor: RecordCursor,
  limit: number,
  within?: string,
): { attachmentId: string; itemId: string; ts: number }[] {
  return db
    .select()
    .from(attachmentRemovals)
    .where(
      and(
        sql`(${attachmentRemovals.removedAt} > ${cursor.ts} or (${attachmentRemovals.removedAt} = ${cursor.ts} and ${attachmentRemovals.attachmentId} > ${cursor.id}))`,
        within === undefined ? undefined : onProject(attachmentRemovals.itemId, within),
      ),
    )
    .orderBy(asc(attachmentRemovals.removedAt), asc(attachmentRemovals.attachmentId))
    .limit(limit)
    .all()
    .map((row) => ({ attachmentId: row.attachmentId, itemId: row.itemId, ts: row.removedAt }));
}

/**
 * How many files hang off comments written during one run (EO-412).
 *
 * What the per-run cap on `attachment_add` is counted against. Read off
 * the rows rather than kept in memory, so a corrective turn — the same
 * run, a newly spawned backend — is counted with the turns before it,
 * and so the `eo` server, which can only read, arrives at the same
 * number from the same place.
 */
export function countAttachmentsForRun(db: Db, runId: Uuid): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(attachments)
    .innerJoin(comments, eq(comments.id, attachments.commentId))
    .where(eq(comments.runId, runId))
    .get();
  return Number(row?.n ?? 0);
}

export function findAttachmentByJiraId(db: Db, itemId: Uuid, jiraAttachmentId: string): AttachmentRecord | undefined {
  const row = selectAttachments(db)
    .where(and(eq(attachments.itemId, itemId), eq(jiraAttachmentLinks.jiraAttachmentId, jiraAttachmentId)))
    .get();
  return row ? toRecord(row) : undefined;
}

export function setJiraAttachmentId(db: Db, id: Uuid, jiraAttachmentId: string): void {
  db.transaction((tx) => {
    tx.insert(jiraAttachmentLinks)
      .values({ attachmentId: id, jiraAttachmentId })
      .onConflictDoUpdate({ target: jiraAttachmentLinks.attachmentId, set: { jiraAttachmentId } })
      .run();
    tx.update(attachments).set({ jiraSyncError: null }).where(eq(attachments.id, id)).run();
  });
}

export function setAttachmentJiraError(db: Db, id: Uuid, error: string | null): void {
  db.update(attachments).set({ jiraSyncError: error }).where(eq(attachments.id, id)).run();
}

function hasPendingAttachmentOperation(db: Db, itemId: Uuid, kind: "attachment_upload" | "attachment_delete", field: string, value: string): boolean {
  return Boolean(db.select({ id: outbox.id }).from(outbox)
    .where(and(eq(outbox.itemId, itemId), eq(outbox.channel, "jira"), eq(outbox.kind, kind), eq(sql`json_extract(${outbox.payload}, ${`$.${field}`})`, value)))
    .get());
}

/** Queue one local file once. Safe to call again after linking or after a create response. */
export function queueAttachmentUpload(db: Db, id: Uuid): boolean {
  return db.transaction((tx) => {
    const attachment = selectAttachments(tx as unknown as Db).where(eq(attachments.id, id)).get();
    if (!attachment || attachment.jiraAttachmentId !== null) return false;
    const item = tx.select().from(items).where(eq(items.id, attachment.itemId)).get();
    // `sync` too (EO-122). Nothing is lost by not queueing: the
    // file is stored locally either way, and `queueUnsyncedAttachments-
    // ForItem` is what picks it up if sync is switched back on.
    const jira = jiraStateFor(tx as unknown as Db, attachment.itemId);
    if (!jira.key || !item?.workspaceId || !jira.sync) return false;
    if (hasPendingAttachmentOperation(tx as unknown as Db, attachment.itemId as Uuid, "attachment_upload", "attachmentId", id)) return false;
    enqueueOutbox(tx as unknown as Db, {
      itemId: attachment.itemId as Uuid,
      workspaceId: item.workspaceId as Uuid,
      channel: "jira",
      kind: "attachment_upload",
      payload: { attachmentId: id },
    });
    return true;
  });
}

export function queueUnsyncedAttachmentsForItem(db: Db, itemId: Uuid): number {
  let queued = 0;
  for (const attachment of listAttachmentsForItem(db, itemId)) {
    if (queueAttachmentUpload(db, attachment.id)) queued += 1;
  }
  return queued;
}

function discardPendingUpload(db: Db, attachmentId: Uuid): void {
  db.delete(outbox).where(and(
    eq(outbox.channel, "jira"),
    eq(outbox.kind, "attachment_upload"),
    eq(sql`json_extract(${outbox.payload}, '$.attachmentId')`, attachmentId),
  )).run();
}

function queueAttachmentDeletion(db: Db, row: AttachmentRow): void {
  discardPendingUpload(db, row.id as Uuid);
  if (!row.jiraAttachmentId) return;
  const item = db.select().from(items).where(eq(items.id, row.itemId)).get();
  // Symmetric with the upload gate (EO-122): an item that never
  // pushed the file has nothing in Jira to delete.
  const jira = jiraStateFor(db, row.itemId);
  if (!jira.key || !item?.workspaceId || !jira.sync) return;
  if (hasPendingAttachmentOperation(db, row.itemId as Uuid, "attachment_delete", "jiraAttachmentId", row.jiraAttachmentId)) return;
  enqueueOutbox(db, {
    itemId: row.itemId as Uuid,
    workspaceId: item.workspaceId as Uuid,
    channel: "jira",
    kind: "attachment_delete",
    payload: { attachmentId: row.id, jiraAttachmentId: row.jiraAttachmentId },
  });
}

export function deleteAttachment(db: Db, id: Uuid): AttachmentRecord | undefined {
  return db.transaction((tx) => {
    const row = selectAttachments(tx as unknown as Db).where(eq(attachments.id, id)).get();
    if (!row) return undefined;
    queueAttachmentDeletion(tx as unknown as Db, row);
    tx.delete(attachments).where(eq(attachments.id, id)).run();
    return toRecord(row);
  });
}

/** Inbound Jira deletion: remove only EO's copy and do not echo a delete back. */
export function deleteAttachmentLocally(db: Db, id: Uuid): AttachmentRecord | undefined {
  const row = selectAttachments(db).where(eq(attachments.id, id)).get();
  if (!row) return undefined;
  db.delete(attachments).where(eq(attachments.id, id)).run();
  return toRecord(row);
}

export function deleteAttachmentsForComments(db: Db, commentIds: Uuid[]): AttachmentRecord[] {
  if (commentIds.length === 0) return [];
  const rows = listAttachmentsForComments(db, commentIds);
  for (const row of rows) {
    const raw = selectAttachments(db).where(eq(attachments.id, row.id)).get();
    if (raw) queueAttachmentDeletion(db, raw);
  }
  db.delete(attachments).where(inArray(attachments.commentId, commentIds)).run();
  return rows;
}

/** The stored files whose rows migration 0168 deleted with the project and job threads (EO-730), still to remove. */
export function listRetiredAttachmentFiles(db: Db): string[] {
  return db.select({ path: retiredAttachmentFiles.path }).from(retiredAttachmentFiles).all().map((row) => row.path);
}

/** Forgets a retired file once its bytes are gone. */
export function forgetRetiredAttachmentFile(db: Db, path: string): void {
  db.delete(retiredAttachmentFiles).where(eq(retiredAttachmentFiles.path, path)).run();
}
