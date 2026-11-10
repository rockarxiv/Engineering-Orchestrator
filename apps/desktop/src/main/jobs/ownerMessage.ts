import type { Job, Message, MessageSend } from "@eo/core";
import type { Db } from "../db/client.js";
import { signedInPersonId } from "../identity/viewer.js";
import { sendMessage, type MessageSendAnswer } from "../messages/messages.js";

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
 * project the record holds, the budget trip, sends through the record
 * instead (`messageJobOwnerThrough`).
 *
 * Returns the message, because a guard that offers something has to say
 * *what* it offered: a skip records the offer's id on its occurrence.
 */
export function messageJobOwner(db: Db, job: Job, body: string, message: JobMessage): Message {
  const send = jobOwnerMessage(job, body, message);
  return sendMessage(db, message.staysHere === true ? { ...send, recipientId: signedInPersonId(db), projectId: null } : send);
}

/** What `ItemRecord.sendMessage` is, for a caller that holds a record. */
export type JobMessageSender = (input: MessageSend) => Promise<MessageSendAnswer>;

/**
 * Sends a guard's message through the record that holds the job's
 * project (EO-726): the organisation's for a project it holds, this
 * database for any other.
 *
 * Never rejects. A record that cannot be reached is said in the log —
 * the guard that calls this has already ended in a comment on the item
 * it stopped, so the work is not silently dropped (invariant 8).
 */
export async function messageJobOwnerThrough(send: JobMessageSender, job: Job, body: string, message: JobMessage): Promise<void> {
  try {
    const sent = await send(jobOwnerMessage(job, body, message));
    if (!sent.ok) console.error(`[eo] the message about the job "${job.name}" was not sent: ${sent.problem}`);
  } catch (error) {
    console.error(`[eo] the message about the job "${job.name}" was not sent:`, error);
  }
}
