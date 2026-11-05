import { copyFile, readFile } from "node:fs/promises";
import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { deleteAttachment, getAttachment } from "../db/repos/index.js";
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
  const attachment = deleteAttachment(db, input.attachmentId as Uuid);
  if (!attachment) return { deleted: false };
  await storage.removeManaged(attachment);
  emitPush("items:changed", { itemId: attachment.itemId });
  return { deleted: true };
}
