import { MAX_COMMENT_ATTACHMENTS, type PathsFrom } from "@eo/core";
import { checkUploadPaths, storeUploads } from "./pathUploads.js";
import type { AttachmentStorage } from "./storage.js";

/**
 * Files an item is filed or edited with, named by path (EO-704):
 * `work:submitItem`, `work:submitPlan` on the feature and on each story,
 * and `items:update`.
 *
 * The rules are a comment's (EO-700), and the code is too: who may name
 * what is the door's `pathsFrom`, every path goes through
 * `checkUploadPaths` before anything is read or written, and the bytes
 * are copied by `storeUploads`, which works out the type and size
 * itself. What this adds is only that one call may carry several lists —
 * a plan's feature and stories — and that the item channels' refusals
 * open with the reasons, since their tools already say nothing was
 * created or changed.
 *
 * Checking and storing come apart so a caller can do both before its
 * transaction: better-sqlite3's is synchronous, and the item and its
 * files are written in one.
 */

type StoredUpload = Awaited<ReturnType<AttachmentStorage["storeImported"]>>;

export type ItemUploads = { ok: true; from: PathsFrom; storage: AttachmentStorage } | { ok: false; problem: string };
export type StoredItemUploads = { ok: true; records: StoredUpload[][] } | { ok: false; problem: string };

/** The refusal for a door that granted no reading by path — the renderer and an organisation server's HTTP door. */
export const NO_GRANT_PROBLEM = "Files can be named by path only through EO's MCP servers. Add them on the item page in the app instead.";

/**
 * Whether every list may be read, and from where — or every reason it
 * may not, naming each path. Asked before anything is written. Only for
 * a call that names at least one path; one that names none needs no
 * grant.
 */
export async function checkItemUploads(
  from: PathsFrom | undefined,
  lists: readonly (readonly string[])[],
  storage: AttachmentStorage | undefined,
): Promise<ItemUploads> {
  if (from === undefined) return { ok: false, problem: NO_GRANT_PROBLEM };
  if (!storage) return { ok: false, problem: "This installation has nowhere to keep a file." };
  // The limit is per call, as a comment's is: a plan's feature and
  // stories together, not eight each.
  const named = lists.reduce((total, paths) => total + paths.length, 0);
  if (named > MAX_COMMENT_ATTACHMENTS) {
    return { ok: false, problem: `One call may name at most ${MAX_COMMENT_ATTACHMENTS} files by path, and this one names ${named}${lists.length > 1 ? " across the feature and its stories" : ""}.` };
  }
  const problems: string[] = [];
  for (const paths of lists) {
    if (paths.length === 0) continue;
    const checked = await checkUploadPaths(from, paths, null);
    if (!checked.ok) problems.push(checked.problem);
    // A turn with no directory is one sentence, however many lists named a path.
    if (!checked.ok && from.kind === "directory" && from.directory === null) break;
  }
  return problems.length > 0 ? { ok: false, problem: problems.join(" ") } : { ok: true, from, storage };
}

/**
 * Every list, copied into the attachment store, one list of records per
 * list of paths and in the same order. All or nothing: a list that fails
 * part-way takes back what this call stored for the lists before it.
 */
export async function storeItemUploads(granted: { from: PathsFrom; storage: AttachmentStorage }, lists: readonly (readonly string[])[]): Promise<StoredItemUploads> {
  const records: StoredUpload[][] = [];
  for (const paths of lists) {
    if (paths.length === 0) {
      records.push([]);
      continue;
    }
    const stored = await storeUploads(granted.storage, granted.from, paths, null);
    if (!stored.ok) {
      await rollbackItemUploads(granted.storage, records);
      return { ok: false, problem: stored.problem };
    }
    records.push(stored.records);
  }
  return { ok: true, records };
}

/** Takes back stored files that no item ended up carrying. */
export async function rollbackItemUploads(storage: AttachmentStorage, records: readonly (readonly StoredUpload[])[]): Promise<void> {
  await storage.rollback(records.flat()).catch((error: unknown) => console.error("[eo] could not take back uploaded item files:", error));
}
