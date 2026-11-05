import type { Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { deleteTrialPipelineRows, getTrialPipeline, itemWithDescendants, listItemsIncludingArchived, listRunsForItem, listTrialPipelinesForConversation } from "../db/repos/index.js";
import { heldWorktreesFor, removeItemsAndTheirWork } from "../ipc/deleteItemCommand.js";
import type { EngineHandle } from "../ipc/domainCommands.js";

/**
 * Discarding a trial pipeline (EO-582, ARCHITECTURE.md, "Trial pipelines").
 *
 * Its own module, apart from making one (`trials.ts`), because deleting a
 * conversation discards its trials and must not depend on the assistant's
 * commands to do it.
 */

export type DiscardTrialResult =
  | { ok: true; deletedItemIds: Uuid[]; leftoverWorktrees: { itemKey: string; path: string; problem: string }[] }
  | { ok: false; problem: string };

/**
 * Discards a trial: its items, then its pipeline (EO-582).
 *
 * The items go through the item-delete path — `removeItemsAndTheirWork`,
 * the sequence `items:delete` and `projects:delete` share — which stops
 * their runs, releases their worktrees (their branches are kept, as every
 * delete keeps them), and removes their comments, runs, run events,
 * transitions and attachment files. That path is invariant #3's one
 * exception, and a trial is exactly what it is for: work somebody asked to
 * be gone. Uncommitted work in a trial's worktree is discarded with it —
 * it was made to be thrown away, and nothing live was ever in it.
 *
 * Then, in the same transaction as the item rows, the trial's own rows:
 * its routes, steps, versions and the pipeline. Nothing of the pipeline it
 * would have replaced is read or written.
 */
export async function discardTrial(
  db: Db,
  engine: EngineHandle | undefined,
  attachmentStorage: AttachmentStorage,
  input: { trialPipelineId: string },
  worktreeRoot?: string,
): Promise<DiscardTrialResult> {
  const trial = getTrialPipeline(db, input.trialPipelineId);
  if (trial === undefined) return { ok: false, problem: "That is not a trial pipeline, so there is nothing to discard." };

  // Every item on it, marked or not — the pipeline cannot go while one stands on it.
  const everyItem = listItemsIncludingArchived(db);
  const rootIds = everyItem.filter((item) => item.pipelineId === trial.id).map((item) => item.id);
  const doomedIds = new Set(rootIds.flatMap((id) => itemWithDescendants(db, id)));
  const doomed = everyItem.filter((item) => doomedIds.has(item.id));
  const activeRuns = [...doomedIds].flatMap((id) => listRunsForItem(db, id as Uuid).filter((run) => run.status === "running" || run.status === "queued"));
  const held = await heldWorktreesFor(db, doomed, worktreeRoot);

  const { deletedItemIds, leftoverWorktrees } = await removeItemsAndTheirWork(
    db,
    engine,
    attachmentStorage,
    { rootIds, doomed, activeRuns, held, discardUncommitted: true },
    () => deleteTrialPipelineRows(db, trial.id),
  );
  engine?.notifyStateChange();
  return { ok: true, deletedItemIds, leftoverWorktrees };
}

/**
 * Discards every trial made from one conversation (EO-582) — what
 * deleting that conversation does first, so a chat that is gone leaves no
 * hidden pipeline running behind it.
 */
export async function discardTrialsOfConversation(
  db: Db,
  engine: EngineHandle | undefined,
  attachmentStorage: AttachmentStorage,
  conversationId: string,
  worktreeRoot?: string,
): Promise<void> {
  for (const trial of listTrialPipelinesForConversation(db, conversationId)) {
    await discardTrial(db, engine, attachmentStorage, { trialPipelineId: trial.id }, worktreeRoot);
  }
}
