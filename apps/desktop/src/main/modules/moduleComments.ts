import type { CustomModule, Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItemByKey, postComment } from "../db/repos/index.js";
import { checkRunFile, readRunFile, type RunFileStore } from "../supervisor/runAttachments.js";
import { mediaTypeFor } from "../supervisor/workspaceFiles.js";

/**
 * Writing what a module asked to say (EO-75).
 *
 * The host cannot do this itself and the restriction is not caution: its
 * handle on `eo.db` is read-only, and even a writable one would be
 * wrong. `postComment` resolves mentions, queues the Jira mirror and
 * announces the change to open windows — a row inserted around it is a
 * comment that never reaches Jira and that no open window hears about.
 * So the host emits an event on fd 3, `runModule` redacts it, and this
 * is what turns it into a row.
 *
 * One function, so the step runner — the one caller that runs a real
 * module against a real item — cannot grow a second way of filing what
 * a module said. A module's tests (EO-352) record comments and never
 * post them, so they do not come through here at all.
 */

export interface ModuleCommentContext {
  /** Whose voice this is. Only the name is used, and it goes in the body. */
  module: CustomModule;
  /** The item the run is on — not necessarily the one being commented. */
  item: Item;
  /** The run row this happened under, so the comment points at its transcript. */
  runId: Uuid | null;
}

/**
 * How a module signs what it says.
 *
 * In the body rather than resolved for display, because the body is the
 * only part of a comment Jira receives: an attribution held in a column
 * and rendered by the renderer would be an attribution that stops at
 * EO's own window, and the mirror is exactly where "who said this" is
 * hardest to work out.
 *
 * A comment that landed somewhere else names where it came from. Nobody
 * reading EO-42 should have to work out why a message about EO-99 turned
 * up under it — the run itself is named structurally, by the comment's
 * `runId`, and the item is named here because there is no column that
 * says "the item the run was on" and a bare UUID in a thread helps
 * nobody.
 *
 * Prepended rather than merged into the module's own text. What a module
 * wrote is its own; EO says who wrote it, above it, and does not edit
 * it.
 */
function attribute(context: ModuleCommentContext, target: Item, body: string): string {
  const signature = target.id === context.item.id ? `**${context.module.name}** (module)` : `**${context.module.name}** (module, from its run on ${context.item.key})`;
  // Alone where there is nothing under it — files attached with no
  // caption (EO-414) are still signed.
  return body === "" ? signature : `${signature}\n\n${body}`;
}

/**
 * Posts one module comment, or says why it could not.
 *
 * Returns null on success and the sentence on failure, which `runModule`
 * writes to the transcript. A throw would end the run over a note.
 *
 * `parseBodyMentions: false` is the load-bearing argument here, not a
 * detail. A module asks by refusing with options, and that ends the run
 * (invariant #9); a comment that could mention somebody would be a
 * second way to stop and ask, with none of the machinery that makes the
 * first one resumable. The `@name` stays visible in the text and simply
 * summons nobody — the same choice `postAssistReply` makes, for the
 * same reason: editing what somebody wrote is worse than declining to
 * act on it.
 */
export function postModuleComment(db: Db, context: ModuleCommentContext, comment: { key: string; body: string }): string | null {
  const target = getItemByKey(db, comment.key);
  // The host checked this key already, against the same database. It can
  // still be gone — an item deleted between the two — and a comment
  // that quietly went nowhere is the failure this whole path exists to
  // avoid.
  if (!target) return `no ticket has the key "${comment.key}".`;

  postComment(db, {
    itemId: target.id as Uuid,
    author: { type: "module" },
    body: attribute(context, target, comment.body),
    runId: context.runId,
    parseBodyMentions: false,
  });
  return null;
}

/**
 * Attaches what a module asked to attach, or says why it could not
 * (EO-414).
 *
 * One comment on the item the run is on, signed as `postModuleComment`
 * signs one, with the files on it. Posted through `postComment` so the
 * files get what a person's attachment gets: the upload to Jira is
 * queued on a mirrored item and open windows are told.
 *
 * **Every path is checked here, by `checkRunFile`** — the function the
 * supervisor holds an agent's `attachment_add` to, so a module and an
 * agent are held to one rule: a regular file inside the directory the
 * run worked in, reached through no symbolic link, within the size
 * limit. The host checked already and that bought the module a prompt
 * answer; this is the check that decides, because this side does the
 * write and the event can come from a module that never asked the host
 * (invariant #5).
 *
 * **And the check is not what is read.** The module still owns that
 * directory while this runs, so a name that passed can be a link, or a
 * larger file, by the time its bytes are wanted. The first pass below
 * only refuses early; the bytes come from `readRunFile`, which opens
 * each file once without following a link and holds what it opened —
 * not the name — to the same rules, and to the size limit on the bytes
 * that actually arrive.
 *
 * **All or nothing**, where `attachRunFiles` is per file. An agent has
 * moved on by the time the supervisor acts and gets a note about what
 * was left out; a module's call was answered as a whole, and the
 * sentence returned here goes to the transcript of a run that is
 * usually still going. So one refused path refuses the call, and what
 * was already copied is taken back rather than left in the store with
 * no comment to own it.
 *
 * `parseBodyMentions: false`, for the reason given above: a caption is
 * text, and an `@name` in it summons nobody.
 */
export async function postModuleAttachment(
  db: Db,
  store: RunFileStore | undefined,
  context: ModuleCommentContext,
  attach: { paths: string[]; caption: string; directory: string },
): Promise<string | null> {
  const refusals: string[] = [];
  for (const path of attach.paths) {
    const checked = await checkRunFile(attach.directory, path);
    if (!checked.ok) refusals.push(checked.reason);
  }
  if (refusals.length > 0) return refusals.join(" ");
  if (!store) return "this installation has nowhere to keep a file.";

  const records: Awaited<ReturnType<RunFileStore["storeImported"]>>[] = [];
  const takeBack = async (): Promise<void> => {
    await store.rollback?.(records).catch(() => undefined);
  };
  for (const path of attach.paths) {
    const file = { path };
    // Read by descriptor, never by the name the pass above approved.
    const read = await readRunFile(attach.directory, path);
    if (!read.ok) {
      await takeBack();
      return read.reason;
    }
    try {
      // Labelled by extension where the extension says something, and
      // left to the store's own reading of the bytes where it does not —
      // as an agent's files are.
      const mediaType = mediaTypeFor(file.path);
      records.push(
        await store.storeImported({
          name: file.path,
          ...(mediaType === "application/octet-stream" ? {} : { mimeType: mediaType }),
          data: read.data,
        }),
      );
    } catch (error) {
      await takeBack();
      return `"${file.path}" could not be stored: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  try {
    postComment(db, {
      itemId: context.item.id as Uuid,
      author: { type: "module" },
      body: attribute(context, context.item, attach.caption),
      runId: context.runId,
      attachmentRecords: records,
      parseBodyMentions: false,
    });
  } catch (error) {
    // The comment and its attachment rows are one transaction, so none
    // of them exist — and the bytes copied for them would be files
    // nothing points at.
    await takeBack();
    return `the comment could not be written: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}
