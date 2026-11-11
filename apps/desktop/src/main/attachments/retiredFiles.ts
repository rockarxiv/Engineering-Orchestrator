import type { Db } from "../db/client.js";
import { forgetRetiredAttachmentFile, listRetiredAttachmentFiles } from "../db/repos/index.js";
import type { AttachmentStorage } from "./storage.js";

/**
 * Removes the stored bytes of the files migration 0168 deleted with the
 * project and job threads (EO-730).
 *
 * A migration can delete an `attachments` row but not the file it
 * named, so 0168 left each managed file's path in
 * `retired_attachment_files`; this removes the file and then the path,
 * at launch. A file that will not go keeps its path, and the next launch
 * tries again. A second launch after they are all gone finds nothing.
 *
 * Answers how many it removed.
 */
export async function removeRetiredAttachmentFiles(db: Db, storage: AttachmentStorage): Promise<number> {
  let removed = 0;
  for (const path of listRetiredAttachmentFiles(db)) {
    try {
      await storage.removeManaged({ managed: true, path });
      forgetRetiredAttachmentFile(db, path);
      removed += 1;
    } catch (error) {
      console.error(`[eo] could not remove ${path}, a file on a retired project or job thread:`, error);
    }
  }
  return removed;
}
