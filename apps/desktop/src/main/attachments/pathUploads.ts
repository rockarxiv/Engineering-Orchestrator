import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PathsFrom } from "@eo/core";
import { checkRunFile, readRunFile, type RunFileRead } from "../supervisor/runAttachments.js";
import { mediaTypeFor } from "../supervisor/workspaceFiles.js";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./storage.js";

/**
 * Files a comment names by path, checked and then uploaded (EO-700).
 *
 * `comment_post` takes `paths` on EO's two MCP hosts, and who may name
 * what is the host's to say — stamped on the payload as `pathsFrom`,
 * never taken from the caller:
 *
 * - **anywhere** — a client of the external host, which acts on a
 *   credential the person handed it. Any absolute path to a regular file
 *   the person's account can read; a link is followed, as the person's
 *   own file dialog would follow it.
 * - **a directory** — the system agent, over `eo_admin`. Only files
 *   inside the directory its turn runs in, held to exactly what
 *   `attachment_add` is held to: `checkRunFile` first, every component
 *   asked so no link leads out, then `readRunFile`, which reads through
 *   the descriptor so a name swapped after the check is not followed.
 *   A turn with no directory names none.
 *
 * **All or nothing, and nothing before the checks.** Every path is
 * checked before a byte is copied, one refusal refuses the call, and a
 * read or store that fails part-way takes back what was stored. The
 * caller posts the comment with what this answers, or posts nothing.
 */

type StoredUpload = Awaited<ReturnType<AttachmentStorage["storeImported"]>>;

export type UploadCheck = { ok: true; paths: string[] } | { ok: false; problem: string };
export type UploadStore = { ok: true; records: StoredUpload[] } | { ok: false; problem: string };

const nothingPosted = (reasons: string[]): string => `Nothing was posted. ${reasons.join(" ")}`;

/** The refusal for a turn the administrative host knows no directory for. */
export const NO_DIRECTORY_PROBLEM =
  "Nothing was posted: this turn runs in no directory, so it has nowhere it may upload files from. A system agent may name only files inside the directory its turn runs in.";

/** Whether one path names a file this caller may upload — the reason, where it may not. */
async function checkAnywhere(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return `"${path}" is not an absolute path; name a file by its absolute path on the machine running EO.`;
  let info;
  try {
    info = await stat(path);
  } catch {
    return `"${path}" does not exist, or cannot be read.`;
  }
  if (info.isDirectory()) return `"${path}" is a directory; only regular files can be attached.`;
  if (!info.isFile()) return `"${path}" is not a regular file.`;
  if (info.size > MAX_ATTACHMENT_BYTES) return `"${path}" is larger than the 20 MB attachment limit.`;
  return null;
}

/**
 * Every path, checked against what `from` allows, before anything is
 * read or written. Answers every reason at once rather than the first,
 * so a caller fixes the call in one go.
 */
export async function checkUploadPaths(from: PathsFrom, paths: readonly string[]): Promise<UploadCheck> {
  if (from.kind === "directory" && from.directory === null) return { ok: false, problem: NO_DIRECTORY_PROBLEM };
  const reasons: string[] = [];
  for (const path of paths) {
    if (from.kind === "anywhere") {
      const reason = await checkAnywhere(path);
      if (reason !== null) reasons.push(reason);
    } else {
      const check = await checkRunFile(from.directory as string, path);
      if (!check.ok) reasons.push(check.reason);
    }
  }
  if (new Set(paths).size !== paths.length) reasons.push("The same path is named twice.");
  return reasons.length > 0 ? { ok: false, problem: nothingPosted(reasons) } : { ok: true, paths: [...paths] };
}

/**
 * One file the person's account can read, read so that what is read is
 * a regular file within the limit — asked of the descriptor rather than
 * of the name `checkAnywhere` answered about, and bounded by the bytes
 * that arrive rather than by a size read earlier.
 */
async function readAnywhere(path: string): Promise<RunFileRead> {
  const changed: RunFileRead = { ok: false, reason: `"${path}" changed while EO was reading it, so it was not uploaded.` };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch {
    return { ok: false, reason: `"${path}" does not exist, or cannot be read.` };
  }
  try {
    if (!(await handle.stat()).isFile()) return changed;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(64 * 1024), 0, 64 * 1024, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `"${path}" is larger than the 20 MB attachment limit.` };
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return { ok: true, data: Buffer.concat(chunks, total) };
  } catch {
    return changed;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The checked paths, copied into EO's attachment store as records ready
 * to hang on a comment. The media type and size are main's: the type by
 * extension where the extension says something, as `attachment_add`
 * labels a file, and otherwise the store's own reading of the first
 * bytes; the size is what was read.
 */
export async function storeUploads(storage: AttachmentStorage, from: PathsFrom, paths: readonly string[]): Promise<UploadStore> {
  const records: StoredUpload[] = [];
  const refuse = async (reason: string): Promise<UploadStore> => {
    await storage.rollback(records).catch(() => undefined);
    return { ok: false, problem: nothingPosted([reason]) };
  };
  for (const path of paths) {
    const read = from.kind === "anywhere" ? await readAnywhere(path) : from.directory === null ? null : await readRunFile(from.directory, path);
    if (read === null) return refuse(NO_DIRECTORY_PROBLEM);
    if (!read.ok) return refuse(read.reason);
    try {
      const mediaType = mediaTypeFor(path);
      records.push(await storage.storeImported({ name: path, ...(mediaType === "application/octet-stream" ? {} : { mimeType: mediaType }), data: read.data }));
    } catch (error) {
      return refuse(`"${path}" could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, records };
}
