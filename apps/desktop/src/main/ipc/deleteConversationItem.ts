import type { Item } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { deleteItem, listActiveRuns, listAttachmentsForItem } from "../db/repos/index.js";
import { discardTrialsOfConversation } from "../trials/discard.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * The deletion itself, for any room whose conversation is an item: what
 * removing an assistant chat does once `removeAssist` has found one
 * (EO-390), and what retiring Discussions and the Architecture panel does
 * to every conversation they left (`retireConversationRooms`, EO-526).
 * One deletion, so the callers cannot come to disagree about what a
 * conversation owns.
 *
 * Which conversation, and whether the caller may delete it at all, is the
 * caller's to have settled: this takes the row and removes it.
 *
 * Its own module rather than Discussions' (EO-519), so the assistant's
 * commands did not reach into a room that was going away to delete their
 * own chats.
 */
export async function deleteConversationItem(
  db: Db,
  engine: EngineHandle | undefined,
  conversation: Item,
  attachmentStorage: AttachmentStorage,
): Promise<void> {
  // `superseded`: the conversation is about to stop existing, so there is
  // no step for EO to stand off afterwards and nobody left to tell
  // (EO-175).
  for (const run of listActiveRuns(db).filter((entry) => entry.itemId === conversation.id)) {
    engine?.cancelRun(run.id, "superseded");
  }

  const ownedAttachments = listAttachmentsForItem(db, conversation.id);
  // Before anything is awaited: the rows are gone by the time this
  // returns its promise, which is the state a caller starting the engine
  // straight after relies on (`retireConversationRooms`).
  deleteItem(db, conversation.id);
  // Then the trials it was testing drafts on (EO-582): a hidden pipeline
  // whose conversation is gone would go on running where nobody could see
  // it or discard it. After the conversation's own rows rather than before
  // them, because discarding waits on worktrees being released; a trial
  // finds its conversation by id, and needs no row to be found.
  await discardTrialsOfConversation(db, engine, attachmentStorage, conversation.id);
  await Promise.all(ownedAttachments.map((attachment) => attachmentStorage.removeManaged(attachment)));
  engine?.notifyStateChange();
}
