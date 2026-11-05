import type { IpcChannel, IpcPayload, IpcResponse, IpcResult, SyncStatus } from "@eo/core";
import type { Db } from "../db/client.js";
import { clearSetting, getSetting, setSetting } from "../db/repos/settingsRepo.js";
import { itemsWithQueuedMoves, queuedCommandCount } from "../db/repos/recordCommandsRepo.js";

/**
 * How this device is getting on with its record (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * Two durable facts and one derived one.
 *
 * **Since when.** `offline since 09:12` rather than `offline`, because
 * the number is the whole of what a person wants from that line: an
 * outage of forty seconds is a shrug and an outage since this morning
 * is something to go and look at. It is written the first time a
 * request fails and cleared the first time one succeeds, so it is the
 * start of the current outage and never the start of the last one.
 *
 * **What went wrong**, in the record's own words where it gave any.
 * `EO could not reach https://… : fetch failed` is worth showing; so is
 * "your organisation signed this device out", which arrives here as an
 * ordinary failure and is the one case where the remedy is not waiting.
 *
 * **How much is waiting**, which is derived from `record_commands` and
 * never stored — the same rule `!` follows (invariant #6). A count in a
 * settings row would be a second answer to a question the queue itself
 * answers exactly.
 *
 * In `app_settings` rather than in memory because the line has to be
 * right on the first frame after a restart. A desktop that was shut
 * while its server was down comes back still offline, and a person
 * looking at a board with four queued cards on it deserves the sentence
 * that explains them rather than a blank strip that fills in a tick
 * later.
 */

const OFFLINE_SINCE_KEY = "record.offlineSince";
const OFFLINE_PROBLEM_KEY = "record.offlineProblem";

/**
 * Records that the record answered.
 *
 * Idempotent and cheap on the common path: an installation that is
 * online stays online, and this writes nothing at all unless it is the
 * transition. Returns whether it *was* the transition, so a caller can
 * push once on coming back rather than once per request.
 */
export function markOnline(db: Db): boolean {
  if (getSetting<number>(db, OFFLINE_SINCE_KEY, 0) === 0) return false;
  clearSetting(db, OFFLINE_SINCE_KEY);
  clearSetting(db, OFFLINE_PROBLEM_KEY);
  return true;
}

/**
 * Records that the record did not answer.
 *
 * The timestamp is written once per outage — the first failure — and
 * the reason is written every time, because the reason can change
 * while the outage does not: a server that was refusing connections
 * and is now refusing the token is still one outage and a different
 * sentence.
 */
export function markOffline(db: Db, now: number, problem: string): boolean {
  setSetting(db, OFFLINE_PROBLEM_KEY, problem);
  if (getSetting<number>(db, OFFLINE_SINCE_KEY, 0) !== 0) return false;
  setSetting(db, OFFLINE_SINCE_KEY, now);
  return true;
}

/** Forgets any outage, because this machine is no longer signed in to anything. */
export function forgetSyncState(db: Db): void {
  clearSetting(db, OFFLINE_SINCE_KEY);
  clearSetting(db, OFFLINE_PROBLEM_KEY);
}

/**
 * The line, the card treatment and the count, in one answer.
 *
 * `signedIn` is handed in rather than looked up, because this file
 * knows about a queue and a settings table and deliberately nothing
 * about sessions or keychains — the same separation `server/http.ts`
 * keeps from `devicesRepo`.
 *
 * A solo desktop answers `solo` with an empty queue, which is not the
 * same as `online` and is why the state is three-valued: there is no
 * record to be online with, so a screen that drew a green dot for it
 * would be reporting on a relationship that does not exist.
 */
export function syncStatus(db: Db, signedIn: boolean): SyncStatus {
  const queuedItemIds = itemsWithQueuedMoves(db);
  const queued = queuedCommandCount(db);
  if (!signedIn) {
    return { state: "solo", offlineSince: null, queued, queuedItemIds, problem: null };
  }
  const since = getSetting<number>(db, OFFLINE_SINCE_KEY, 0);
  return {
    state: since === 0 ? "online" : "offline",
    offlineSince: since === 0 ? null : since,
    queued,
    queuedItemIds,
    problem: since === 0 ? null : getSetting<string>(db, OFFLINE_PROBLEM_KEY, "") || null,
  };
}

/**
 * How a device reaches its record.
 *
 * The record half of the IPC contract, as a function. `ServerClient`
 * from `managed/serverClient.ts` already *is* this — the desktop's
 * production transport is HTTP over a device token — and the shape is
 * named separately so that this file and `remoteRecord.ts` do not have
 * to import a thing that knows about TLS, hostnames and 401s in order
 * to say "send this and tell me what came back".
 *
 * It is also what lets a test put two devices and one record in one
 * process and drive the whole of the design without opening a socket.
 */
export interface RecordTransport {
  request<K extends IpcChannel>(channel: K, payload: IpcPayload<K>): Promise<IpcResult<IpcResponse<K>>>;
}
