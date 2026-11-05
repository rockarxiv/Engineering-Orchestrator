import { jiraStateOf, type Comment, type IpcPayload, type IpcResponse, type Item, type Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { commentWithReplies, deleteComment, getComment, getItem, listAttachmentsForComments } from "../db/repos/index.js";
import { jiraFor, type JiraContext } from "../packs/developer/jira/connection.js";

/** Nothing was deleted, and this is why. */
function refused(problem: string): IpcResponse<"comments:delete"> {
  return { deleted: false, deletedCount: 0, problem, jira: null };
}

/**
 * Removes the Jira comments behind a set of local ones.
 *
 * Runs *after* the local delete, and reports its own outcome rather than
 * throwing: a token without Delete All Comments cannot remove a comment
 * somebody else wrote, which is an ordinary thing to discover here and
 * must not put back what the person asked to have gone.
 */
async function deleteJiraComments(
  db: Db,
  context: JiraContext,
  item: Item,
  doomed: Comment[],
): Promise<{ attempted: number; deleted: number; problem: string | null }> {
  const jira = jiraStateOf(item);
  const issueKey = jira.key!;
  // The switch gates deletion as much as it gates a push (EO-122). This
  // is not queued work that a later drain would refuse — it is an
  // immediate, destructive call to Jira — so the check has to be here or
  // nowhere, and a sync-disabled item reaching into its issue to
  // remove comments is the loudest possible contradiction of "invisible
  // to Jira in both directions".
  //
  // Said rather than silently skipped: the person ticked a box asking
  // for this, and the dialog offers that box off the Jira key alone, so
  // returning nothing at all would drop an explicit request on the floor.
  if (!jira.sync) {
    return { attempted: 0, deleted: 0, problem: `${item.key} has Jira sync switched off, so its comments in ${issueKey} were left alone.` };
  }

  const mirrored = doomed.filter((comment) => comment.jiraCommentId !== null);
  if (mirrored.length === 0) {
    return { attempted: 0, deleted: 0, problem: "None of these comments had reached Jira." };
  }

  const connection = jiraFor(db, context, item.projectId!);
  if (!connection.ok) return { attempted: mirrored.length, deleted: 0, problem: connection.reason };

  let deleted = 0;
  const problems: string[] = [];
  for (const comment of mirrored) {
    try {
      await connection.client.deleteComment(issueKey, comment.jiraCommentId!);
      deleted += 1;
    } catch (error) {
      problems.push(`${issueKey} comment ${comment.jiraCommentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    attempted: mirrored.length,
    deleted,
    // Said plainly, because the consequence is not obvious: a comment
    // still in Jira with no local row to recognise it is one the next
    // pull imports as new.
    problem:
      problems.length > 0
        ? `${problems.join("\n")}\n\nWhat is still in Jira will come back on the next sync, because nothing here recognises it any more.`
        : null,
  };
}

/**
 * Removes a comment, the replies filed under it, and their Jira
 * counterparts.
 *
 * Order follows `items:delete`: locally first, because that is what
 * was asked for, and Jira after, because it can fail on a permission the
 * token never had and must not take the local delete with it.
 */
export async function deleteCommentCommand(
  db: Db,
  jira: JiraContext,
  input: IpcPayload<"comments:delete">,
  attachmentStorage: AttachmentStorage,
): Promise<IpcResponse<"comments:delete">> {
  const commentId = input.commentId as Uuid;
  const comment = getComment(db, commentId);
  if (!comment) return refused("That comment no longer exists.");

  // Read before the rows go: the Jira ids and the issue key are what the
  // remote half needs, and neither survives the delete.
  const doomed = commentWithReplies(db, commentId)
    .map((id) => getComment(db, id))
    .filter((entry): entry is Comment => entry !== undefined);
  const doomedAttachments = listAttachmentsForComments(db, doomed.map((entry) => entry.id));
  const item = getItem(db, comment.itemId);

  const { deletedIds } = deleteComment(db, commentId);
  await Promise.all(doomedAttachments.map((attachment) => attachmentStorage.removeManaged(attachment)));

  // Only whether there is an issue to talk to at all. Whether we may
  // talk to it is `deleteJiraComments`' own first question, so that a
  // refusal comes back as a sentence rather than as silence.
  const mirrored = item !== undefined && jiraStateOf(item).key !== null && item.projectId !== null;
  return {
    deleted: true,
    deletedCount: deletedIds.length,
    problem: null,
    jira: input.deleteInJira && mirrored ? await deleteJiraComments(db, jira, item, doomed) : null,
  };
}
