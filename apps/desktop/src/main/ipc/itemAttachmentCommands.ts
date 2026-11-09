import type { AttachmentView, IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { addItemAttachments, getAttachment, getItem, removeItemAttachment, type AttachmentRecord } from "../db/repos/index.js";
import { refusedEditOnReplica, refusedOnGroupStep } from "./domainCommands.js";
import { emitPush } from "./push.js";

/**
 * An item's own files, put on it and taken off it from the item page
 * (EO-702, ARCHITECTURE.md, "Attachments").
 *
 * Part of what the item is, as its description is — so they are changed
 * on the description's terms: on a step that waits on a group, only by
 * the person holding the item. Not something said, so no comment is
 * written and no agent is woken (invariant 4 is untouched).
 *
 * The files arrive as staged drafts, exactly as a comment's do: the
 * renderer hands over ids, and the name, MIME type and size are the
 * ones main worked out when it staged them. `prepare` holds the limits
 * — eight in one go, twenty megabytes each — in the sentences a comment
 * is refused with.
 */

function asView(attachment: AttachmentRecord): AttachmentView {
  return {
    id: attachment.id,
    itemId: attachment.itemId,
    commentId: null,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    syncStatus: "local",
    syncError: null,
  };
}

export async function addItemAttachmentsCommand(
  db: Db,
  storage: AttachmentStorage,
  input: IpcPayload<"items:addAttachments">,
): Promise<IpcResponse<"items:addAttachments">> {
  const item = getItem(db, input.itemId as Uuid);
  if (!item) return { attachments: [], problem: "That item no longer exists." };
  const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "edit") ?? refusedEditOnReplica(db, item);
  if (notTheirs !== null) return { attachments: [], problem: notTheirs };

  let prepared: Awaited<ReturnType<AttachmentStorage["prepare"]>>;
  try {
    prepared = await storage.prepare(input.attachmentIds);
  } catch (error) {
    // Said rather than thrown: nine files or a file that is no longer
    // staged is a refusal the person reads, not a programmer's error.
    return { attachments: [], problem: error instanceof Error ? error.message : String(error) };
  }
  let added: AttachmentRecord[];
  try {
    added = addItemAttachments(db, item.id, prepared);
  } catch (error) {
    await storage.rollback(prepared);
    throw error;
  }
  await storage.finish(prepared).catch((error: unknown) => console.error("[eo] could not clear staged item attachments:", error));
  emitPush("items:changed", { itemId: item.id });
  return { attachments: added.map(asView), problem: null };
}

export async function removeItemAttachmentCommand(
  db: Db,
  storage: AttachmentStorage,
  input: IpcPayload<"items:removeAttachment">,
): Promise<IpcResponse<"items:removeAttachment">> {
  const existing = getAttachment(db, input.attachmentId as Uuid);
  if (!existing) return { removed: false, problem: null };
  if (existing.commentId !== null) {
    return { removed: false, problem: `${existing.name} is on a comment, and goes only with that comment.` };
  }
  const item = getItem(db, existing.itemId);
  if (item) {
    const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "edit") ?? refusedEditOnReplica(db, item);
    if (notTheirs !== null) return { removed: false, problem: notTheirs };
  }
  const removed = removeItemAttachment(db, existing.id);
  if (!removed) return { removed: false, problem: null };
  // After the row, never before: bytes removed for a delete that then
  // failed would be a file on the item pointing at nothing.
  await storage.removeManaged(removed);
  emitPush("items:changed", { itemId: removed.itemId });
  return { removed: true, problem: null };
}
