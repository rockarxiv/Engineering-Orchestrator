import { copyFile, readFile } from "node:fs/promises";
import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import { MAX_ATTACHMENT_COUNT, type AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { deleteAttachment, getAttachment } from "../db/repos/index.js";
import { removeItemAttachmentCommand } from "./itemAttachmentCommands.js";
import { emitPush } from "./push.js";

export function attachmentPath(db: Db, attachmentId: string): string {
  const attachment = getAttachment(db, attachmentId as Uuid);
  if (!attachment) throw new Error("That attachment no longer exists.");
  return attachment.path;
}

export async function attachmentPreview(db: Db, input: IpcPayload<"attachments:preview">): Promise<IpcResponse<"attachments:preview">> {
  const attachment = getAttachment(db, input.attachmentId as Uuid);
  if (!attachment) throw new Error("That attachment no longer exists.");
  if (attachment.kind !== "image") return { dataUrl: null };
  return { dataUrl: `data:${attachment.mimeType};base64,${(await readFile(attachment.path)).toString("base64")}` };
}

export async function saveAttachmentTo(db: Db, attachmentId: string, destination: string): Promise<void> {
  await copyFile(attachmentPath(db, attachmentId), destination);
}

export async function deleteAttachmentCommand(
  db: Db,
  storage: AttachmentStorage,
  input: IpcPayload<"attachments:delete">,
): Promise<IpcResponse<"attachments:delete">> {
  // One of the item's own files (EO-702) goes the one way the item page
  // removes one: only by somebody who may edit the item, and told to the
  // organisation record. This channel is not a way round either.
  if (getAttachment(db, input.attachmentId as Uuid)?.commentId === null) {
    const answer = await removeItemAttachmentCommand(db, storage, input);
    return { deleted: answer.removed, problem: answer.problem };
  }
  const attachment = deleteAttachment(db, input.attachmentId as Uuid);
  if (!attachment) return { deleted: false, problem: null };
  await storage.removeManaged(attachment);
  emitPush("items:changed", { itemId: attachment.itemId });
  return { deleted: true, problem: null };
}

/**
 * The native picker's files, staged (`attachments:pick`).
 *
 * Sliced rather than refused past eight: eight of twelve is nearer to
 * what somebody meant than none of twelve. What the slice used to cost
 * was silence — the composer had no way to know it had happened, so four
 * files vanished between the dialog and the chips (EO-194). The count
 * travels back, and the composer says so.
 *
 * A file that cannot be staged — over 20 MB, not a file, unreadable —
 * stages none of them and comes back as `problem` (EO-702). Thrown, it
 * reached a packaged build's renderer as "Internal error", which names
 * neither the file nor the limit.
 */
export async function pickAttachmentsCommand(
  pickFile: () => Promise<string[]>,
  storage: Pick<AttachmentStorage, "stagePaths">,
): Promise<IpcResponse<"attachments:pick">> {
  const chosen = await pickFile();
  const omitted = Math.max(0, chosen.length - MAX_ATTACHMENT_COUNT);
  try {
    return { attachments: await storage.stagePaths(chosen.slice(0, MAX_ATTACHMENT_COUNT)), omitted, problem: null };
  } catch (error) {
    return { attachments: [], omitted: 0, problem: error instanceof Error ? error.message : String(error) };
  }
}
