import type { Item } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { listItemsIncludingArchived } from "../db/repos/index.js";
import { deleteConversationItem } from "./deleteConversationItem.js";

/**
 * Deleting what Discussions and the Architecture panel left behind
 * (EO-526).
 *
 * Both rooms are gone: Discussions (`DISC-n`, on the hidden `discussion`
 * step) and the classic configure screen's Architecture panel (`ARCH-n`,
 * on `architecture`). Their conversations are deleted rather than left
 * where nothing can open them — a person decided that, not a migration
 * being tidy.
 *
 * In code at startup, after the precedent of `retireForgeQueue`, rather
 * than in a SQL migration, for two reasons. A conversation owns files on
 * disk — its attachments — which SQL cannot remove. And deleting an item
 * is the KAN-30 cascade in `deleteItem`, the one deletion invariant #3
 * allows, which a migration would have had to repeat by hand and keep in
 * step. So each conversation goes through `deleteConversationItem`, the
 * deletion removing an assistant chat already uses: its comments,
 * mentions, attachments and their files, runs, run events, transitions,
 * and any `from-discussion` job whose thread it was. Those runs' cost
 * leaves recorded spend with them, as it does for any deleted item.
 *
 * Every conversation on either step, archived ones included — an ended
 * discussion is still one of its rooms. The `key_counters` rows for
 * `DISC` and `ARCH` stay: nothing deletes a key sequence, and nothing
 * here should start.
 *
 * The organisation server runs the same startup (`server/start.ts` →
 * `startMain`), so the record is cleaned too. Deletions are not
 * replicated, which is why each side cleans its own copy. A second start
 * finds nothing and does nothing.
 *
 * **Every row is gone before this returns**, though it returns a
 * promise: the database half of each deletion runs synchronously before
 * its first `await`, and only the file removals are left in flight. So
 * a caller that starts this before the engine starts — as `startMain`
 * does — has no conversation left for the engine to reconcile or
 * dispatch, and need not hold startup open for the disk.
 *
 * No engine is passed: nothing has been dispatched in this process yet,
 * so there is no live run to cancel, and a run row a previous process
 * left `running` is deleted with its conversation.
 */
export function retireConversationRooms(db: Db, attachmentStorage: AttachmentStorage): Promise<number> {
  const retired = listItemsIncludingArchived(db).filter(isRetiredRoom);
  // Started together rather than awaited in turn, so that every
  // deletion's database half has run by the time this returns (above).
  return Promise.all(retired.map((conversation) => deleteConversationItem(db, undefined, conversation, attachmentStorage))).then(
    () => retired.length,
  );
}

/**
 * The steps the two retired rooms kept their conversations on —
 * migrations 0032 and 0036. Spelled here and nowhere else now: nothing
 * else in the app has any business with either step.
 */
const RETIRED_ROOM_STEPS: ReadonlySet<string> = new Set(["discussion", "architecture"]);

function isRetiredRoom(item: Item): boolean {
  return item.stepId !== null && RETIRED_ROOM_STEPS.has(item.stepId);
}
