import { writeFileSync } from "node:fs";
import type { Comment, CommentView, IpcPayload, IpcResponse, Item, ItemOutput, PipelineStep, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { currentOutputOf, getItem, postOutputComment } from "../db/repos/index.js";
import type { Platform } from "./platform.js";

/**
 * A person's correction becomes the item's output (EO-298,
 * ARCHITECTURE.md, "The output is a comment").
 *
 * The command behind phase 6's editor, landed without it. There is no
 * screen on this yet and deliberately so: what the editor needs from the
 * rest of EO is exactly this — a way to say "what stands now is *this*"
 * — and building the command with the machinery it belongs to leaves
 * that phase a screen to write rather than a model to design.
 *
 * What it is for is the design. A step that sends,
 * posts or publishes works from the item's current output, and until
 * this existed the only thing that could produce one was the run that
 * did the work — so the "post to Slack" module posted what the agent
 * wrote, and the correction a person made before approving it went out
 * nowhere. The correction is an output like any other now, and it is
 * current because it is the latest, by the same derivation everything
 * else reads (invariant 6).
 *
 * **It supersedes rather than replaces.** The output it displaces stays
 * in the thread, chained beneath it, attributed to whoever wrote it —
 * EO does not rewrite what happened, and "the approver changed this"
 * is only a fact the item can state if what was changed is still there.
 *
 * Refuses an empty body. An output is the thing somebody approves, and
 * an empty one is not an edit anybody meant to make: it would become the
 * current output, the next step would send nothing, and nothing in the
 * thread would say why. A person who wants to retract an output has no
 * command for it here and should not get one by accident.
 */
export function setItemOutput(db: Db, input: IpcPayload<"items:setOutput">): IpcResponse<"items:setOutput"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) {
    return { commentId: null, supersededCommentId: null, problem: "That ticket no longer exists." };
  }

  if (input.body.trim() === "") {
    return {
      commentId: null,
      supersededCommentId: null,
      problem: "An output cannot be empty — it is the thing this ticket has produced, and the next step works from it.",
    };
  }

  // Read before the write, so the answer can name what was displaced.
  // `postOutputComment` resolves it again for the `parentId` it writes;
  // both reads are of the same row in the same synchronous tick, and
  // better-sqlite3 gives no window between them for a third to land.
  const superseded = currentOutputOf(db, itemId);

  const posted = postOutputComment(db, {
    itemId,
    author: { type: "human" },
    body: input.body,
  });

  return { commentId: posted.id, supersededCommentId: superseded?.id ?? null, problem: null };
}

/**
 * The fence the git workspace posts a diff inside (EO-298,
 * `composeOutputBody`).
 *
 * Read rather than stored, and that is a deliberate choice between two
 * bad options. The alternative was a column on `comments` saying what an
 * output *is* — which is a migration, a second thing every writer of an
 * output has to remember, and a fact that can disagree with the body it
 * describes. What the workspace kind knows ("this artifact is a `diff`")
 * it already writes into the body, as the info string of the fence
 * markdown requires; reading it back is one rule in one place, and an
 * output that stops looking like a diff stops being drawn as one, which
 * is the answer a person would expect anyway.
 *
 * Anchored at the start, because that is what `composeOutputBody`
 * produces for git's single artifact: the diff and nothing else, no
 * heading and no preamble. A body that merely *contains* a diff fence —
 * a report quoting one — is prose with a code block in it, and editing
 * that is exactly what this screen is for.
 */
const OPENS_WITH_A_DIFF = /^\s*(?:`{3,}|~{3,})diff\b/;

/**
 * What the output is, so the screen knows what to draw and what it may
 * offer to edit (EO-311, ARCHITECTURE.md, "The output is a comment").
 *
 * Three answers, in the order they exclude each other. A file wins over
 * everything: the body of a file output is EO's own sentence naming what
 * the run produced (EO-299), and the deliverable is the attachment
 * rather than the naming. A diff is next, and is read off the fence the
 * workspace wrote — editing one is out of this story's scope, so what
 * this decides is whether an Edit button appears at all. Everything else
 * is text, which is the case the editor exists for: the report, the
 * drafted reply, the thing a person corrects before approving it.
 */
export function outputFormat(comment: Pick<Comment, "body"> & { attachments?: unknown[] }): ItemOutput["format"] {
  if ((comment.attachments ?? []).length > 0) return "file";
  return OPENS_WITH_A_DIFF.test(comment.body) ? "diff" : "text";
}

/**
 * The item's output, as the editor above the thread receives it
 * (EO-311, ARCHITECTURE.md, "The output is a comment",
 * "The item").
 *
 * Null on an agent step, by the same gate `decisionsFor` takes: the
 * deliverable is lifted to the top of the page where a person may act on
 * it, and while a run holds the item what is there is a working copy
 * somebody would be editing underneath it. Nothing is hidden either way
 * — every output comment is in the thread on every step, which is where
 * the earlier ones are read.
 *
 * `currentOutputOf` decides *which* one, rather than a second walk of
 * the comment list beside it: latest by `created_at`, id breaking a
 * same-millisecond tie, one definition shared with the context builder
 * so the screen and the next step cannot disagree about what the output
 * is. The comment views the detail has already built supply the rest —
 * the author's name, the attachments and their Jira state — because
 * building them twice would be two answers to "what is on this comment".
 */
export function outputFor(db: Db, item: Item, step: PipelineStep | undefined, comments: readonly CommentView[]): ItemOutput | null {
  if (step === undefined || step.type !== "user") return null;
  const current = currentOutputOf(db, item.id);
  if (current === undefined) return null;
  const view = comments.find((comment) => comment.id === current.id);
  return {
    commentId: current.id,
    body: current.body,
    format: outputFormat(current),
    authorName: view?.authorName ?? "EO",
    authorType: current.authorType,
    createdAt: current.createdAt,
    attachments: view?.attachments ?? [],
    // What it displaced. An output chains to the one it supersedes, so
    // this is also the thread entry a person scrolls to for "what did it
    // say before I changed it".
    supersedesCommentId: current.parentId,
  };
}

/**
 * Saving the output as a file (EO-311, ARCHITECTURE.md, "The item").
 *
 * The Export button's half that a window cannot do for itself: the
 * dialog and the write both belong to the machine (F-02), so the
 * renderer asks and this answers. Copy is the renderer's own — the
 * clipboard is a thing the window has.
 *
 * Only the text. An output carrying files carries them as attachments,
 * and `attachments:save` has saved one of those since attachments
 * existed; a second path to the same bytes would be a second set of
 * failures to keep in step, and the card the file is drawn on already
 * has the button.
 *
 * Cancelling is not a failure. `saved: false, problem: null` is a person
 * closing the dialog, and a screen that reported an error for it would
 * be shouting about something they decided.
 */
export async function exportItemOutput(
  db: Db,
  platform: Pick<Platform, "saveFile">,
  input: IpcPayload<"items:exportOutput">,
): Promise<IpcResponse<"items:exportOutput">> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) return { saved: false, path: null, problem: "That ticket no longer exists." };

  // Read before the dialog opens. A run can post one while the picker is
  // up, and exporting whatever became current in the meantime would save
  // something other than what was on screen when the button was pressed
  // — the file would not be the output the person was looking at.
  const output = currentOutputOf(db, itemId);
  if (output === undefined) return { saved: false, path: null, problem: "This ticket has not produced anything to export." };

  const destination = await platform.saveFile({
    title: "Export output",
    // The key, because that is what the item is called everywhere else
    // a person meets it, and `.md` because an output body is markdown —
    // which is what the thread, the context builder and this screen all
    // render it as.
    defaultPath: `${item.key}.md`,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "Text", extensions: ["txt"] },
    ],
  });
  if (destination === null) return { saved: false, path: null, problem: null };

  try {
    writeFileSync(destination, output.body);
    return { saved: true, path: destination, problem: null };
  } catch (error) {
    return { saved: false, path: null, problem: error instanceof Error ? error.message : String(error) };
  }
}
