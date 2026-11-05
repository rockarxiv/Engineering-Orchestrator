import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AttachmentAddArgsSchema, MAX_ATTACHMENT_ADD_PATHS, MAX_RUN_ATTACHMENTS, type AgentWriteAnswer, type Uuid } from "@eo/core";
import { MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { countAttachmentsForRun, postComment, type CreateAttachmentRecord } from "../db/repos/index.js";
import { mediaTypeFor, resolveWithin } from "./workspaceFiles.js";

/**
 * Files an agent attaches to its own item while it is still working
 * (EO-412).
 *
 * The `eo` server's `attachment_add` checks that a call is the shape the
 * tool advertises and hands it to EO over the agent write bridge (EO-543);
 * it cannot write, because it opens the database read-only. What is here
 * is EO's half: every path checked against the directory the run works
 * in, the bytes copied into EO's attachment store, and the one comment
 * they hang on posted — and the answer, which is what the tool tells the
 * agent.
 */

type StoredFile = Omit<CreateAttachmentRecord, "itemId" | "commentId">;

/**
 * Somewhere to put bytes — the supervisor's `ArtifactStore`, named
 * structurally so this file does not import the supervisor.
 *
 * **No bytes are left behind that no comment owns**, and the two halves
 * of that are held in two places because only one of them is this
 * file's to hold:
 *
 * - `storeImported` either answers with a record or leaves nothing. A
 *   store that fails part-way removes what it wrote before it throws —
 *   it is the only party that knows where that was, since the path is
 *   in the record a failed call never returns. `AttachmentStorage` does
 *   exactly this, and `runAttachments.test.ts` holds it to it with a
 *   write that really fails.
 * - `rollback` takes back files that *were* stored and then never got
 *   a comment to hang on. That half is this file's: it holds the
 *   records. Optional because a store with no way to remove a file is
 *   still somewhere to put one.
 */
export interface RunFileStore {
  storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<StoredFile>;
  rollback?(records: StoredFile[]): Promise<void>;
}

export type RunFileCheck = { ok: true; absolutePath: string; size: number } | { ok: false; reason: string };

/**
 * One path, checked against the directory the run was dispatched in.
 *
 * Contained by `resolveWithin`, which is what refuses `../` and an
 * absolute path elsewhere. Then every component beneath the directory
 * is asked with `lstat`: a symbolic link is refused rather than
 * followed wherever on the path it is, for the reason `filesUnder`
 * lists one as nothing — following it would put a file nobody produced
 * in the workspace onto an item, and on a mirrored item off the
 * machine.
 */
export async function checkRunFile(directory: string, path: string): Promise<RunFileCheck> {
  const base = resolve(directory);
  const target = resolveWithin(base, path);
  if (target === null) return { ok: false, reason: `"${path}" is outside the directory this run works in.` };
  if (target === base) return { ok: false, reason: `"${path}" is a directory; only regular files can be attached.` };

  const parts = target.slice(base.length + 1).split(sep);
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return { ok: false, reason: `"${path}" does not exist.` };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: `"${path}" is a symbolic link, or is reached through one; EO does not follow links.` };
    if (index < parts.length - 1) {
      if (!info.isDirectory()) return { ok: false, reason: `"${path}" does not exist.` };
      continue;
    }
    if (info.isDirectory()) return { ok: false, reason: `"${path}" is a directory; only regular files can be attached.` };
    if (!info.isFile()) return { ok: false, reason: `"${path}" is not a regular file.` };
    if (info.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: `"${path}" is larger than the 20 MB attachment limit.` };
    return { ok: true, absolutePath: target, size: info.size };
  }
  return { ok: false, reason: `"${path}" does not exist.` };
}

export type RunFileRead = { ok: true; data: Buffer } | { ok: false; reason: string };

/**
 * The bytes of one file in the directory a run worked in, read so that
 * what was checked is what is read (EO-414).
 *
 * `checkRunFile` answers about a *name*, and a name can be made to mean
 * something else between the answer and a `readFile` of it: whatever
 * ran in that directory still owns it, and can put a symbolic link where
 * the file was, or where one of its parent directories was, or grow the
 * file past the limit. So nothing here reads a name it has checked. It
 * opens the file once and asks every question of the descriptor:
 *
 * - **Opened without following a link** (`O_NOFOLLOW`), so a link put
 *   in the file's place after the check is a failed open rather than a
 *   read of whatever it points at.
 * - **Regular, by `fstat` of what was opened**, not of the name.
 * - **Inside the directory, by where the opened file really is.** A
 *   parent directory swapped for a link is followed by the open — the
 *   flag covers the last component only. Where the system can say
 *   where a descriptor's file lives (`/proc/self/fd`, on Linux), that
 *   answer has to be inside the directory's own real path, and it is
 *   about the descriptor, so there is nothing left to swap. Elsewhere
 *   the path is walked again after the open and the file it names must
 *   be the one that was opened, by device and inode: narrower than the
 *   first, since a walk is still a sequence of names, and said here
 *   rather than passed off as the same thing.
 * - **Within the limit, by the bytes that actually arrive.** The read
 *   stops one byte past it and refuses, whatever a size said earlier.
 */
export async function readRunFile(directory: string, path: string): Promise<RunFileRead> {
  // Where the name points, and nothing more: no question is asked of
  // the filesystem by name before the open. The caller has already
  // refused what `checkRunFile` refuses; asking again here would be one
  // more answer about a name, and it is the descriptor that is believed.
  const target = resolveWithin(resolve(directory), path);
  if (target === null) return { ok: false, reason: `"${path}" is outside the directory this run works in.` };
  const changed: RunFileRead = { ok: false, reason: `"${path}" changed while EO was reading it, so it was not attached.` };

  let handle;
  try {
    // `O_NOFOLLOW` does not exist on Windows, where a link is not
    // something an unprivileged process can create in passing either.
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return changed;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return changed;

    let where: string | null = null;
    try {
      where = await realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      // No such filesystem here; the second walk below stands in.
    }
    if (where !== null) {
      const base = await realpath(resolve(directory));
      if (!where.startsWith(base + sep)) return changed;
    } else {
      const again = await checkRunFile(directory, path);
      if (!again.ok) return again;
      const named = await lstat(again.absolutePath, { bigint: true });
      if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return changed;
    }

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

export interface AttachRunFilesInput {
  db: Db;
  /** Absent on an installation with nowhere to keep a file, which is then the answer rather than assumed away. */
  store: RunFileStore | undefined;
  itemId: Uuid;
  runId: Uuid;
  agent: { id: Uuid; name: string };
  /** `runs.cwd`, or null for a run with no workspace directory. */
  directory: string | null;
  /** The call's arguments exactly as the agent gave them. */
  args: unknown;
}

const refused = (code: string, problem: string): AgentWriteAnswer => ({ ok: false, code, problem });

/**
 * Acts on one `attachment_add` call: one comment, with the files on it —
 * or nothing at all, and the reason (EO-543).
 *
 * **All or nothing.** Every path is checked before a byte is copied, and
 * one refused path refuses the call, so the comment that results is the
 * one the agent asked for and never a part of it. The agent hears the
 * refusal in the tool's answer while it is still working, and can fix the
 * call and make it again; nothing is said on the item, because nothing
 * happened there.
 *
 * The comment is the agent's: kind `note`, on the run, its body the
 * caption and nothing else. `parseBodyMentions: false` because a caption
 * is text — `postComment` would otherwise read "@user" in it as a
 * mention, which opens an Inbox row and parks the item on a question
 * nobody asked (KAN-29).
 *
 * Posted through `postComment` so that everything a person's attachment
 * gets, this gets: the Jira upload is queued on a mirrored item and
 * open windows are told.
 */
export function attachRunFiles(input: AttachRunFilesInput): Promise<AgentWriteAnswer> {
  // One call at a time per run (EO-543). The count of what a run has
  // attached is read before the files are checked and copied, which is
  // asynchronous work; two calls let through together would both read the
  // same count, and three calls of eight files each stored twenty-four on
  // a run allowed sixteen. Queued behind each other, every call counts
  // what the calls before it actually stored. Kept here rather than in
  // the bridge handler so that no caller can go around it.
  const running = attachmentQueues.get(input.db) ?? new Map<Uuid, Promise<unknown>>();
  attachmentQueues.set(input.db, running);
  const before = running.get(input.runId) ?? Promise.resolve();
  const turn = before.then(
    () => attachRunFilesNow(input),
    () => attachRunFilesNow(input),
  );
  running.set(input.runId, turn);
  // Forgotten once nothing is queued behind it, so a finished run leaves nothing here.
  void turn.finally(() => {
    if (running.get(input.runId) === turn) running.delete(input.runId);
  }).catch(() => undefined);
  return turn;
}

/** The calls queued per run, per database: what `attachRunFiles` serialises on. */
const attachmentQueues = new WeakMap<Db, Map<Uuid, Promise<unknown>>>();

async function attachRunFilesNow(input: AttachRunFilesInput): Promise<AgentWriteAnswer> {
  const { db, store, itemId, runId, agent } = input;

  if (input.directory === null) return refused("TOOL_DISABLED", "This run has no workspace directory to attach files from, so nothing was attached.");
  const paths = typeof input.args === "object" && input.args !== null && Array.isArray((input.args as { paths?: unknown }).paths) ? ((input.args as { paths: unknown[] }).paths) : null;
  if (paths !== null && paths.length > MAX_ATTACHMENT_ADD_PATHS && paths.every((path) => typeof path === "string")) {
    const over = (paths as string[]).slice(MAX_ATTACHMENT_ADD_PATHS).map((path, index) => `"${path}" is path ${MAX_ATTACHMENT_ADD_PATHS + index + 1} of this call; a call may attach at most ${MAX_ATTACHMENT_ADD_PATHS} files.`);
    return refused("ATTACHMENT_REFUSED", `Nothing was attached. ${over.join(" ")}`);
  }
  const parsed = AttachmentAddArgsSchema.safeParse(input.args);
  if (!parsed.success) {
    return refused(
      "INVALID_ARGUMENT",
      `Nothing was attached: attachment_add takes \`paths\`, a list of one to ${MAX_ATTACHMENT_ADD_PATHS} file paths, and an optional \`caption\`, and nothing else (${parsed.error.issues.map((issue) => issue.message).join("; ")}).`,
    );
  }
  if (!store) return refused("ATTACHMENT_REFUSED", "Nothing was attached: this installation has nowhere to keep a file.");

  const reasons: string[] = [];
  const checked: { path: string; absolutePath: string }[] = [];
  const already = countAttachmentsForRun(db, runId);
  for (const [index, path] of parsed.data.paths.entries()) {
    const position = already + index + 1;
    if (position > MAX_RUN_ATTACHMENTS) reasons.push(`"${path}" would be file ${position} attached by this run; a run may attach at most ${MAX_RUN_ATTACHMENTS}.`);
    const check = await checkRunFile(input.directory, path);
    if (check.ok) checked.push({ path, absolutePath: check.absolutePath });
    else reasons.push(check.reason);
  }
  if (reasons.length > 0) return refused("ATTACHMENT_REFUSED", `Nothing was attached. ${reasons.join(" ")}`);

  const records: StoredFile[] = [];
  const takeBack = async (): Promise<void> => {
    await store.rollback?.(records).catch(() => undefined);
  };
  for (const { path } of checked) {
    // Read through the descriptor rather than by name (EO-414): what was
    // checked a moment ago is a name, and whatever runs in the directory
    // can make it mean something else before it is read.
    const read = await readRunFile(input.directory, path);
    if (!read.ok) {
      await takeBack();
      return refused("ATTACHMENT_REFUSED", `Nothing was attached. ${read.reason}`);
    }
    try {
      // Labelled by extension where the extension says something, as a
      // run's artifacts are, and left to the store's own reading of the
      // first bytes where it does not.
      const mediaType = mediaTypeFor(path);
      records.push(await store.storeImported({ name: path, ...(mediaType === "application/octet-stream" ? {} : { mimeType: mediaType }), data: read.data }));
    } catch (error) {
      await takeBack();
      return refused("ATTACHMENT_REFUSED", `Nothing was attached. "${path}" could not be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let comment;
  try {
    comment = postComment(db, {
      itemId,
      runId,
      author: { type: "agent", agentId: agent.id },
      kind: "note",
      body: parsed.data.caption ?? "",
      attachmentRecords: records,
      parseBodyMentions: false,
    });
  } catch (error) {
    // The comment and its attachment rows are one transaction, so a throw
    // here means none of them exist — and the bytes copied for them above
    // are files in the store that nothing points at, which no later sweep
    // would find. Taken back before the refusal is said.
    await takeBack();
    return refused("ATTACHMENT_REFUSED", `Nothing was attached: EO could not post the comment they would hang on (${error instanceof Error ? error.message : String(error)}).`);
  }

  const attached = comment.attachments ?? [];
  return {
    ok: true,
    text:
      `EO attached ${attached.length === 1 ? "this file" : `these ${attached.length} files`} to the ticket in one comment (${comment.id}):\n` +
      attached.map((attachment) => `- ${attachment.name} — attachment ${attachment.id}`).join("\n"),
    data: {
      commentId: comment.id,
      attached: attached.map((attachment) => ({ attachmentId: attachment.id, name: attachment.name })),
    },
  };
}
