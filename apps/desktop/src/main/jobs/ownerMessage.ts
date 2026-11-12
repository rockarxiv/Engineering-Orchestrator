import { uuidv7, type Job, type Message, type MessageSend, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { isReplica } from "../db/recordRole.js";
import { enqueueCommand } from "../db/repos/recordCommandsRepo.js";
import { signedInPersonId } from "../identity/viewer.js";
import { sendMessage } from "../messages/messages.js";

/**
 * What a job's guard says, and to whom (EO-729, ARCHITECTURE.md §7.1).
 *
 * A guard that fires where there is no item — a skipped occurrence, a
 * budget trip before dispatch, a template that no longer resolves, an
 * event a webhook could not file — ends in a message to the job's owner
 * (invariant 8), with the job as its subject. Never a comment: a job has
 * no conversation, and the thread it used to post on only grew.
 *
 * The body names the job, because a message is read in the inbox beside
 * every other one and "was skipped" about nothing is not a sentence a
 * person can act on.
 */

/** What sent a job's message: `messages.source`, one per kind of guard. */
export const JOB_MESSAGE_SOURCE = {
  /** An occurrence that did not run — paused, the previous item still open, or missed beyond the grace. */
  skipped: "job_skipped",
  /** A firing refused, or a schedule EO cannot read: nothing was filed. */
  failed: "job_failed",
  /** The job paused because one occurrence spent its budget. */
  budget: "job_budget",
  /** A webhook event that was held, deduplicated, malformed or refused over the cap. */
  webhook: "job_webhook",
  /** This machine declining to fire a job its organisation's record files. */
  declined: "job_declined",
  /** A watch job: a finding refused, or checks stopped by failures or by a declared result (EO-753). */
  watch: "job_watch",
} as const;
export type JobMessageSource = (typeof JOB_MESSAGE_SOURCE)[keyof typeof JOB_MESSAGE_SOURCE];

export interface JobMessage {
  source: JobMessageSource;
  /** Answers a person can press; absent for a guard that has nothing to offer, which is dismissed. */
  options?: string[];
  /**
   * An account of what *this machine* did, rather than of the job
   * (EO-325): a desktop declining to fire a job whose project is its
   * organisation's. Addressed to the person in front of this machine and
   * about no project, so it is kept, answered and dismissed here rather
   * than on the record — which has its own view of the same job.
   */
  staysHere?: boolean;
}

/** The message a guard sends the job's owner, about the job and its project. */
export function jobOwnerMessage(job: Job, body: string, message: JobMessage): MessageSend {
  return {
    recipientId: job.ownerId,
    projectId: job.projectId,
    jobId: job.id,
    source: message.source,
    body,
    options: message.options ?? null,
  };
}

/**
 * Sends a guard's message in this database.
 *
 * Here, because every guard that calls this runs where the job's state
 * is written: a solo desktop or a project it kept, or the organisation's
 * record itself for one it holds — whose messages its recipients'
 * desktops pull (EO-726). The one guard that runs on a desktop about a
 * project the record holds, the budget trip, queues its message for the
 * record instead (`messageJobOwnerAboutItem`).
 *
 * Returns the message, because a guard that offers something has to say
 * *what* it offered: a skip records the offer's id on its occurrence.
 */
export function messageJobOwner(db: Db, job: Job, body: string, message: JobMessage): Message {
  const send = jobOwnerMessage(job, body, message);
  return sendMessage(db, message.staysHere === true ? { ...send, recipientId: signedInPersonId(db), projectId: null } : send);
}

/**
 * Sends a guard's message from the desktop that was about to dispatch an
 * item the job filed — the budget trip, the one guard that runs there.
 *
 * For an item this database holds, here at once. For one the
 * organisation's record holds, the message is the record's to write
 * (EO-726), so it is queued as a record command beside the item's other
 * commands (`sendMessage`): written down now, sent by the drain whenever
 * the record can be reached, and written there once under the id minted
 * here, however many times a lost acknowledgement makes the drain send
 * it. The guard pauses the job and does not fire again, so a message that
 * a record out of reach refused would otherwise never reach anybody.
 */
export function messageJobOwnerAboutItem(db: Db, job: Job, itemId: Uuid, body: string, message: JobMessage): void {
  if (!isReplica(db, itemId)) {
    messageJobOwner(db, job, body, message);
    return;
  }
  const command = { kind: "sendMessage" as const, id: uuidv7(), itemId, messageId: uuidv7(), message: jobOwnerMessage(job, body, message) };
  enqueueCommand(db, command, itemId, Date.now());
}
