import type { Job, Message, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getJob, hasFiredAt, occurrenceForOffer } from "../db/repos/index.js";
import { fireJob, fireJobChecked, type FireResult } from "./fire.js";
import { jobMeetsModuleRules } from "./jobs.js";
import { JOB_MESSAGE_SOURCE } from "./ownerMessage.js";

/**
 * "Run it now" — the offer a skip leaves behind (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * A skip that only says what did not happen leaves the person to
 * reconstruct it by hand. So the skip's message to the job's owner
 * carries the offer (EO-729), and answering it fires *that occurrence* — with its own `dueAt`, so `{{date}}` on the
 * item reads the Monday it was for rather than the Wednesday somebody
 * got round to it.
 */

/** The text of the offer. Answering with it is what fires the occurrence. */
export const RUN_NOW_OPTION = "Run it now";
/**
 * The other button, which does nothing on purpose.
 *
 * A single-option question is one a person cannot answer without doing
 * the thing, so the message would stay open in the inbox until they
 * either ran a report they had decided against or dismissed it. Saying
 * "leave it" is an answer, and answering is what closes it.
 */
export const LEAVE_IT_OPTION = "Leave it";

export const SKIP_OFFER_OPTIONS = [RUN_NOW_OPTION, LEAVE_IT_OPTION];

/**
 * Fires the occurrence a person has just answered "Run it now" to, in
 * the skip's message (EO-729).
 *
 * Called wherever a message is answered — this database, or the
 * organisation's record for one about a project it holds, which is
 * where that job's occurrences are written — and answers `null` for
 * every message that is not a skip's offer answered with yes.
 *
 * **Which occurrence is decided by the message being answered**: the
 * skip wrote its offer's id on the occurrence, so pressing an offer from
 * three weeks ago runs that week's, never the newest skip's.
 */
export function answerSkipMessage(db: Db, message: Message): FireResult | null | Promise<FireResult> {
  if (message.source !== JOB_MESSAGE_SOURCE.skipped) return null;
  if (message.handledHow !== "answered" || message.answer !== RUN_NOW_OPTION) return null;
  const occurrence = occurrenceForOffer(db, message.id as Uuid);
  if (!occurrence || occurrence.jobId !== message.jobId) return null;
  // Answered on two screens before either refreshed: an occurrence fires once.
  if (hasFiredAt(db, occurrence.jobId as Uuid, occurrence.dueAt)) return null;
  // Read now, so the firing uses the job as it is today; a deleted job
  // files nothing (`fireJob` would refuse it and say so, which a person
  // who deleted it does not need telling).
  const job = getJob(db, occurrence.jobId as Uuid);
  if (!job || job.deletedAt !== null) return null;
  return fireOffered(db, job, occurrence.dueAt);
}

/**
 * Fires the occurrence an answer named: at once, or — where the job's
 * pipeline has a `module` entry rule for what it files — once that rule
 * has run on the item (EO-736), which takes a subprocess and so a promise.
 * Every other job fires in the same turn it always did.
 */
function fireOffered(db: Db, job: Job, dueAt: number): FireResult | Promise<FireResult> {
  return jobMeetsModuleRules(db, job) ? fireJobChecked(db, job, { dueAt }) : fireJob(db, job, { dueAt });
}
