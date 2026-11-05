import { jiraStateOf, type IpcPayload, type IpcResponse, type Item, type Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { deleteItem, getItem, getProject, listAttachmentsForComments, listCommentsForItem, listRunsForItem, listItems, itemWithDescendants } from "../db/repos/index.js";
import { isProjectThread } from "../projects/projectThread.js";
import { jiraFor, type JiraContext } from "../packs/developer/jira/connection.js";
import { branchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { allWorktreeConfigs } from "../packs/developer/workspace/dispatchWorkspace.js";
import { releaseReferenceCheckouts } from "../packs/developer/workspace/referenceCheckouts.js";
import { listHeldWorktrees, removeWorktree, type WorktreeConfig } from "../packs/developer/workspace/worktrees.js";
import type { EngineHandle } from "./domainCommands.js";

/** Nothing was deleted, and this is why. Every early return has this shape. */
function refused(problem: string, flags: { activeRun?: boolean; uncommitted?: boolean } = {}): IpcResponse<"items:delete"> {
  return {
    deleted: false,
    deletedCount: 0,
    blockedByActiveRun: flags.activeRun ?? false,
    blockedByUncommittedWork: flags.uncommitted ?? false,
    problem,
    jira: null,
    // Nothing was deleted, so nothing was released and nothing can have
    // been left behind.
    leftoverWorktrees: [],
  };
}

/** A checkout a doomed item is holding, and how much in it exists nowhere else. */
export interface HeldWorktree {
  key: string;
  path: string;
  config: WorktreeConfig;
  uncommittedChanges: number;
}

/**
 * The worktree, if any, that each doomed item is holding — keyed by item key.
 *
 * Exported for `projects:delete` (EO-346), which asks the same question
 * about every item on a project before it asks the person anything.
 */
export async function heldWorktreesFor(
  db: Db,
  doomed: Item[],
  worktreeRoot: string | undefined,
): Promise<HeldWorktree[]> {
  const wanted = new Set(doomed.map((item) => item.key));
  // Only the workspaces the doomed items actually live in: listing
  // worktrees shells out to git per repo, and a project spanning five
  // repositories should not pay for four of them to delete one story.
  const workspaceIds = new Set(doomed.map((item) => item.workspaceId).filter((id): id is Uuid => id !== null));

  const found: HeldWorktree[] = [];
  const prefix = await branchPrefix(db);
  for (const { workspace, config } of allWorktreeConfigs(db, worktreeRoot)) {
    if (!workspaceIds.has(workspace.id)) continue;
    const held = await listHeldWorktrees(config, prefix);
    // A repo that has moved or been deleted cannot be holding anything
    // we could release, and refusing the delete over it would trap the
    // item on the project forever.
    if (!held.ok) continue;

    for (const entry of held.value) {
      if (wanted.has(entry.itemKey)) {
        found.push({ key: entry.itemKey, path: entry.path, config, uncommittedChanges: entry.uncommittedChanges });
      }
    }
  }
  return found;
}

/**
 * Deletes the Jira issues behind a set of items, children first.
 *
 * Deliberately not transactional with anything: it runs *after* the
 * local delete has already happened, and reports its own outcome. A
 * token without the Delete Issues permission is a normal thing to
 * discover here, and it must not leave the project unchanged — the user
 * asked for the item to go, and it has.
 */
async function deleteJiraIssues(
  db: Db,
  context: JiraContext,
  doomed: Item[],
): Promise<{ attempted: number; deleted: number; problem: string | null }> {
  const linked = doomed.filter((item) => jiraStateOf(item).key !== null && item.projectId !== null);
  // A sync-disabled item keeps its key, so being linked is no longer
  // the same as being reachable (EO-122). Deleting the issue behind one
  // would be the worst version of the leak: the item was deliberately
  // made invisible to Jira, and the issue is the thing that survives the
  // EO item going away.
  //
  // Filtered per item rather than decided for the whole set, because a
  // set is exactly what this takes: deleting a feature whose sync is on
  // must still remove its issue even if one story underneath was
  // silenced, and must leave that story's issue standing.
  const silenced = linked.filter((item) => !jiraStateOf(item).sync);
  // Children first: deleting a parent out from under its stories is how
  // you get an issue Jira refuses to remove.
  const withKeys = linked.filter((item) => jiraStateOf(item).sync).reverse();

  // Named, not merely omitted. These are issues that outlive the items
  // that explain them, and a silent skip is how somebody finds out
  // months later.
  const skipped =
    silenced.length === 0
      ? null
      : `Jira sync is off for ${silenced.map((item) => `${item.key} (${jiraStateOf(item).key})`).join(", ")}, so ${
          silenced.length === 1 ? "that issue was" : "those issues were"
        } left alone.`;

  if (withKeys.length === 0) {
    return { attempted: 0, deleted: 0, problem: skipped ?? "None of these tickets is linked to a Jira issue." };
  }

  let deleted = 0;
  const problems: string[] = [];
  if (skipped !== null) problems.push(skipped);

  for (const item of withKeys) {
    const connection = jiraFor(db, context, item.projectId!);
    if (!connection.ok) {
      problems.push(`${item.key}: ${connection.reason}`);
      continue;
    }

    try {
      await connection.client.deleteIssue(jiraStateOf(item).key!);
      deleted += 1;
    } catch (error) {
      problems.push(`${jiraStateOf(item).key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { attempted: withKeys.length, deleted, problem: problems.length > 0 ? problems.join("\n") : null };
}

/**
 * Everything after the refusals: stop the runs, release the worktrees,
 * delete the rows, remove the files (KAN-30).
 *
 * Its own function since EO-346, because deleting a project deletes
 * every item on it and has to do so exactly the way deleting one
 * does — a second copy of this sequence would be a second answer to
 * "what does deleting an item take with it", and the two would drift.
 * The refusals stay with each caller: what a person is asked before a
 * project goes is a different question from what they are asked before
 * one item does, and both have been answered by the time this runs.
 *
 * `rootIds` are handed to `deleteItem` one by one, each taking its
 * descendants; `doomed` is every item that goes, which is what the
 * attachments are collected from.
 */
export async function removeItemsAndTheirWork(
  db: Db,
  engine: EngineHandle | undefined,
  attachmentStorage: AttachmentStorage,
  work: {
    rootIds: readonly Uuid[];
    doomed: readonly Item[];
    activeRuns: readonly { id: string }[];
    held: readonly HeldWorktree[];
    discardUncommitted: boolean;
  },
  /**
   * More rows to delete once the items are gone, in the same
   * transaction — the project row, for `projects:delete`. Absent for a
   * single item, where nothing else goes.
   */
  afterRows?: () => void,
): Promise<{ deletedItemIds: Uuid[]; leftoverWorktrees: { itemKey: string; path: string; problem: string }[] }> {
  // `superseded`: the item and its runs are about to stop existing, so
  // there is no step for EO to stand off afterwards and nobody left to
  // tell about it (EO-175).
  for (const run of work.activeRuns) engine?.cancelRun(run.id, "superseded");

  // Before the DB rows go: releasing needs the item's key and its
  // repository, and neither survives the delete. The branch is kept even
  // when discarding — committed work is never lost here, the same rule
  // `worktrees:release` follows.
  //
  // A removal that fails does not stop the delete — the rows are what
  // was asked for — but it is not swallowed either: the checkout stays
  // on disk, and after the rows go there is nothing left to say what
  // that directory was. So it is collected and named in the response
  // (issue #131), the last moment anyone can connect the two.
  const leftoverWorktrees: { itemKey: string; path: string; problem: string }[] = [];
  for (const entry of work.held) {
    const released = await removeWorktree(entry.config, entry.key, { force: work.discardUncommitted, deleteBranch: false });
    if (!released.ok) leftoverWorktrees.push({ itemKey: entry.key, path: entry.path, problem: released.reason });
  }

  // Reference checkouts the doomed items were lent (EO-632), removed
  // whatever was written to them: nothing in one is anyone's work. What
  // was written is still said on the item first, as every removal says
  // it (invariant 8).
  for (const entry of work.doomed) await releaseReferenceCheckouts(db, entry);

  // Collected before the rows go, because the rows are how a file is
  // found; removed after, because a file removed for a delete that then
  // failed would be a comment pointing at nothing.
  const doomedAttachments = listAttachmentsForComments(
    db,
    work.doomed.flatMap((entry) => listCommentsForItem(db, entry.id).map((comment) => comment.id)),
  );
  // One transaction for every root and whatever the caller adds, so a
  // project is never left half-emptied by a delete that failed partway.
  const deletedItemIds = db.transaction(() => {
    const gone = work.rootIds.flatMap((rootId) => deleteItem(db, rootId).deletedItemIds);
    afterRows?.();
    return gone;
  });
  await Promise.all(doomedAttachments.map((attachment) => attachmentStorage.removeManaged(attachment)));

  return { deletedItemIds, leftoverWorktrees };
}

/**
 * Removes an item, its stories, and everything written about them
 * (KAN-30).
 *
 * The two refusals follow `items:move`: rather than silently
 * destroying something that exists nowhere else, the handler says no
 * and hands the decision back. A live run is one, and a worktree with
 * uncommitted changes is the other — both are an agent's work, and both
 * become unrecoverable the moment the item that explains them is
 * gone. That is also why the worktree is checked *before* the delete
 * rather than reported after it: a stray directory called `EO-12` is
 * only meaningful while EO-12 still exists.
 *
 * Order of the rest is deliberate. Local delete first, because that is
 * what was asked for; Jira after, because it can fail on a permission
 * the token never had and must not take the local delete down with it.
 */
export async function deleteItemCommand(
  db: Db,
  engine: EngineHandle | undefined,
  jira: JiraContext,
  input: IpcPayload<"items:delete">,
  attachmentStorage: AttachmentStorage,
  worktreeRoot?: string,
): Promise<IpcResponse<"items:delete">> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) return refused("That ticket no longer exists.");

  // A project's thread lives as long as its project (EO-471). It is
  // where things that belong to no single item were said, and deleting
  // it on its own would take those with it while leaving the project
  // somewhere to say the next one — a new, empty thread. The project's
  // own delete still takes it, through `removeItemsAndTheirWork`.
  const project = item.projectId === null ? undefined : getProject(db, item.projectId as Uuid);
  if (isProjectThread(item) && project !== undefined) {
    return refused(`${item.key} is ${project.name}'s notes, which stay as long as the project does. Deleting the project removes them with it.`);
  }

  const ids = itemWithDescendants(db, itemId);
  const byId = new Map(listItems(db).map((entry) => [entry.id, entry]));
  const doomed = ids.map((id) => byId.get(id)).filter((entry): entry is Item => entry !== undefined);

  // Every item in the set, not just the one clicked: deleting a
  // feature takes its stories, and one of *them* may be the one an
  // agent is working in.
  const activeRuns = ids.flatMap((id) => listRunsForItem(db, id).filter((run) => run.status === "running" || run.status === "queued"));
  if (activeRuns.length > 0 && !input.cancelActiveRun) {
    const owner = byId.get(activeRuns[0]!.itemId as Uuid);
    return refused(
      activeRuns.length === 1 && owner?.id === item.id
        ? `An agent is working on ${item.key} right now.`
        : `An agent is working on ${owner?.key ?? "a story under this feature"}.`,
      { activeRun: true },
    );
  }

  const held = await heldWorktreesFor(db, doomed, worktreeRoot);
  const dirty = held.filter((entry) => entry.uncommittedChanges > 0);
  if (dirty.length > 0 && !input.discardUncommitted) {
    const names = dirty.map((entry) => `${entry.key} (${entry.uncommittedChanges} uncommitted ${entry.uncommittedChanges === 1 ? "change" : "changes"})`);
    return refused(
      `There is uncommitted work in ${names.join(", ")}. It exists nowhere else — deleting the ticket would be the last chance to look at it.`,
      { uncommitted: true },
    );
  }

  const { deletedItemIds, leftoverWorktrees } = await removeItemsAndTheirWork(db, engine, attachmentStorage, {
    rootIds: [itemId],
    doomed,
    activeRuns,
    held,
    discardUncommitted: input.discardUncommitted,
  });

  // A feature's state is derived from its stories (U-12), so deleting
  // one can be what finishes it: a feature with one story done and one
  // in `todo` is complete the moment the second is deleted. Every other
  // caller runs this after a story *moves*; a story that vanishes
  // changes the same sum and had nothing to run it.

  engine?.notifyStateChange();

  return {
    deleted: true,
    deletedCount: deletedItemIds.length,
    blockedByActiveRun: false,
    blockedByUncommittedWork: false,
    problem: null,
    jira: input.deleteInJira ? await deleteJiraIssues(db, jira, doomed) : null,
    leftoverWorktrees,
  };
}
