import { jiraStateOf, type Item } from "@eo/core";
import type { AttachmentStorage } from "../../../attachments/storage.js";
import { MAX_ATTACHMENT_BYTES } from "../../../attachments/storage.js";
import type { Db } from "../../../db/client.js";
import {
  addItemAttachments,
  deleteAttachmentLocally,
  findAttachmentByJiraId,
  listAttachmentsForItem,
  pendingPushesForItem,
  removeItemAttachment,
  stillMirrors,
} from "../../../db/repos/index.js";
import type { JiraClient } from "./client.js";

export interface AttachmentPullResult {
  added: number;
  removed: number;
  skipped: number;
  problems: string[];
}

/**
 * Reconciles Jira's issue-level files with the item's (EO-705). A Jira
 * issue's files are what an item's own files are, so one pulled from
 * now on lands on the item, not on a comment. Files pulled before that
 * onto the "Attachments synchronized from Jira." note stay on it: the
 * Jira link is looked up across every file on the item, so they are
 * neither imported again nor moved, and a deletion in Jira still takes
 * them. A pending EO deletion is a tombstone until Jira acknowledges it,
 * preventing a pull between the local click and the outbox drain from
 * resurrecting the file.
 *
 * `item` is a snapshot, and the downloads below are the longest gap
 * anywhere in a pull — so before each write it asks whether the item
 * still mirrors the issue this listing came from (EO-127). Somebody
 * relinking mid-download would otherwise be handed the old issue's
 * files, permanently and with nothing on them to say which issue they
 * came from. Stopping partway is safe: a listing is reconciled from
 * scratch every time, so whatever was missed is done on the next pull.
 */
export async function syncJiraAttachments(
  db: Db,
  client: JiraClient,
  item: Item,
  storage: AttachmentStorage,
): Promise<AttachmentPullResult> {
  const result: AttachmentPullResult = { added: 0, removed: 0, skipped: 0, problems: [] };
  const issueKey = jiraStateOf(item).key;
  if (!issueKey) return result;

  // Snapshot before the network call. If an outbox upload finishes while
  // Jira is answering this listing, that newly assigned remote id was
  // not part of the listing and must not be mistaken for a deletion.
  const localBeforeList = listAttachmentsForItem(db, item.id);
  const remote = await client.listAttachments(issueKey);
  // Before anything is decided from this listing: a relinked item's
  // files are not this one's to reconcile, and stopping here also saves
  // downloading a set of files that would be discarded a moment later.
  // The loops below each ask again, once per file, because each of them
  // waits between one write and the next.
  if (!stillMirrors(db, item)) return result;
  const remoteIds = new Set(remote.map((attachment) => attachment.id));
  const deleting = new Set(
    pendingPushesForItem(db, item.id, "jira")
      .filter((entry) => entry.kind === "attachment_delete")
      .map((entry) => entry.payload["jiraAttachmentId"])
      .filter((id): id is string => typeof id === "string"),
  );

  // Jira deletion wins on a successful listing. Local-only files have no
  // remote id and are deliberately untouched.
  for (const local of localBeforeList) {
    if (!local.jiraAttachmentId || remoteIds.has(local.jiraAttachmentId)) continue;
    // Once per deletion, because removing the previous file was a wait
    // of its own. Relinking does not discard an item's attachment rows
    // — the files stay, which is what makes them worth keeping — so a
    // loop that carried on would delete the new issue's item's data
    // on the authority of the old issue's listing, with nothing left to
    // say what was lost. Stops the whole reconciliation rather than
    // skipping one file: everything after this point is decided by that
    // same listing.
    if (!stillMirrors(db, item)) return result;
    // An item file goes the way the item page removes one, so the
    // organisation record hears; `fromJira` keeps it from being sent
    // back to Jira as a deletion of its own. A file on a comment — one
    // pulled before EO-705, or a comment's own upload — keeps its old
    // path.
    const removed = local.commentId === null
      ? removeItemAttachment(db, local.id, { fromJira: true })
      : deleteAttachmentLocally(db, local.id);
    if (removed) {
      await storage.removeManaged(removed);
      result.removed += 1;
    }
  }

  for (const attachment of remote) {
    if (attachment.size > MAX_ATTACHMENT_BYTES) {
      result.skipped += 1;
      continue;
    }
    if (deleting.has(attachment.id) || findAttachmentByJiraId(db, item.id, attachment.id)) continue;

    try {
      const data = await client.downloadAttachment(attachment, MAX_ATTACHMENT_BYTES);
      if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${attachment.filename} is larger than the 20 MB attachment limit.`);
      // Once per file, because each download is its own wait and the
      // relink can land during any of them.
      if (!stillMirrors(db, item)) return result;

      const stored = await storage.storeImported({ name: attachment.filename, mimeType: attachment.mimeType, data });
      // Writing the bytes is a wait of its own, and the last one before
      // anything is recorded. A relink landing inside it would otherwise
      // resume here and file the old issue's document on the new issue's
      // item, where nothing on it says which issue it came from. The
      // bytes go with it: `storeImported` has already renamed them into
      // managed storage, so leaving them would be an orphan no row ever
      // points at and nothing ever collects.
      if (!stillMirrors(db, item)) {
        await storage.removeManaged({ managed: true, path: stored.storagePath });
        return result;
      }

      try {
        // Linked to its Jira id in the same write, so it is neither
        // uploaded back nor imported again on the next pull.
        addItemAttachments(db, item.id, [{ ...stored, jiraAttachmentId: attachment.id }]);
        result.added += 1;
      } catch (error) {
        await storage.removeManaged({ managed: true, path: stored.storagePath });
        // A concurrent manual/scheduled pull may have won the unique
        // identity race. That is synchronization, not an error.
        if (!findAttachmentByJiraId(db, item.id, attachment.id)) throw error;
      }
    } catch (error) {
      result.problems.push(`${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
