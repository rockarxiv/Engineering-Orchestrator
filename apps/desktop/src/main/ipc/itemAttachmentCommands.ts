import type { AttachmentView, IpcPayload, IpcResponse, Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { addItemAttachments, getAttachment, getItem, removeItemAttachment, type AttachmentRecord } from "../db/repos/index.js";
import { checkItemUploads, rollbackItemUploads, storeItemUploads } from "../attachments/itemUploads.js";
import { isReplica } from "../db/recordRole.js";
import type { ItemRecord } from "../record/record.js";
import { asksForDependencyChange } from "../roles/itemDependencies.js";
import { refusedEditOnReplica, refusedOnGroupStep, updateItemFields, updateItemText } from "./domainCommands.js";
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

/** Carries `updateItemText`'s refusal out of the transaction it has to roll back. */
class TextRefused extends Error {
  constructor(readonly answer: IpcResponse<"items:update">) {
    super(answer.problem ?? "refused");
  }
}

/**
 * Why an item file named for removal cannot be taken off this item, or
 * null where it can. A comment's file goes only with its comment, in
 * the sentence the item page's remove gives.
 */
function removalRefusal(db: Db, itemId: Uuid, itemKey: string, attachmentId: string): string | null {
  const existing = getAttachment(db, attachmentId as Uuid);
  if (!existing || existing.itemId !== itemId) return `There is no file ${attachmentId} on ${itemKey}.`;
  if (existing.commentId !== null) return `${existing.name} (${attachmentId}) is on a comment, and goes only with that comment.`;
  return null;
}

/**
 * `items:update` as the channel answers it, with item files added by
 * path and removed by id (EO-704).
 *
 * A call that names no file is `updateItemFields`, exactly as before. So
 * is one that changes what a record-held item waits for: the record makes
 * that change, apart from anything else, and `updateItemFields` refuses
 * it beside any other field, files included.
 *
 * Otherwise the whole call is judged before anything is written — who
 * may edit the item, each id to remove (one of this item's own files,
 * never a comment's), each path under the grant the door stamped — and
 * every reason is answered at once. The files named by path are then
 * stored, and the text edit, the new files and the removals are written
 * in one transaction: a text edit `updateItemText` refuses takes the
 * stored files back and leaves the item's files as they were. The bytes
 * of a removed file go after the row, as on the item page.
 */
export async function updateItemCommand(
  db: Db,
  record: Pick<ItemRecord, "changeDependencies">,
  input: IpcPayload<"items:update">,
  storage: AttachmentStorage | undefined,
): Promise<IpcResponse<"items:update">> {
  const { paths: sentPaths, removeAttachmentIds, pathsFrom, ...text } = input;
  const paths = sentPaths ?? [];
  const removals = [...new Set(removeAttachmentIds ?? [])];
  const itemId = input.itemId as Uuid;
  const recordMakesIt = asksForDependencyChange({ add: input.addDependsOn ?? [], remove: input.removeDependsOn ?? [] }) && isReplica(db, itemId);
  if ((paths.length === 0 && removals.length === 0) || recordMakesIt) return updateItemFields(db, record, input);

  const item = getItem(db, itemId);
  if (!item) return { updated: false, problem: "That ticket no longer exists." };
  const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "edit") ?? refusedEditOnReplica(db, item);
  if (notTheirs !== null) return { updated: false, problem: notTheirs };
  if (!storage) return { updated: false, problem: "This installation has nowhere to keep a file." };

  const problems = removals.map((id) => removalRefusal(db, item.id, item.key, id)).filter((problem): problem is string => problem !== null);
  const granted = paths.length > 0 ? await checkItemUploads(pathsFrom, [paths], storage) : null;
  if (granted !== null && !granted.ok) problems.push(granted.problem);
  if (problems.length > 0) return { updated: false, problem: problems.join(" ") };

  const stored = granted?.ok ? await storeItemUploads(granted, [paths]) : { ok: true as const, records: [[]] };
  if (!stored.ok) return { updated: false, problem: stored.problem };
  const files = stored.records[0] ?? [];

  const removed: AttachmentRecord[] = [];
  let answer: IpcResponse<"items:update">;
  try {
    answer = db.transaction(() => {
      const edited = updateItemText(db, text);
      if (edited.problem !== null) throw new TextRefused(edited);
      addItemAttachments(db, item.id, files);
      for (const id of removals) {
        const gone = removeItemAttachment(db, id as Uuid, { itemId: item.id });
        if (gone) removed.push(gone);
      }
      return { ...edited, updated: true };
    });
  } catch (error) {
    await rollbackItemUploads(storage, stored.records);
    if (error instanceof TextRefused) return error.answer;
    throw error;
  }
  for (const gone of removed) {
    await storage.removeManaged(gone).catch((error: unknown) => console.error("[eo] could not remove an item file's stored bytes:", error));
  }
  emitPush("items:changed", { itemId: item.id });
  return answer;
}
