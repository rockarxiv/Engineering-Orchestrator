import type { Comment, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getComment, getJob, hasFiredAt, occurrenceForOffer } from "../db/repos/index.js";
import { fireJob, type FireResult } from "./fire.js";

/**
 * "Run it now" — the offer a skip leaves behind (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * A skip that only says what did not happen leaves the person to
 * reconstruct it by hand. So the comment carries the offer, and pressing
 * it fires *that occurrence* — with its own `dueAt`, so `{{date}}` on the
 * item reads the Monday it was for rather than the Wednesday somebody
 * got round to it.
 *
 * **The offer is an option on a comment and not a new IPC channel**,
 * which is the whole reason it works today. Comments are the one
 * communication channel (invariant #4) and every surface that shows one
 * — the inbox, the item thread — already draws its options as buttons
 * and answers by replying with the text. So the Jobs page that has not
 * been built yet is not in the way of a person answering this.
 *
 * **An answer is a reply to the question, on the thread it was asked
 * on.** Both halves are checked and neither is redundant: `parentId` is
 * a claim a caller makes rather than a fact the database enforces, so
 * without the second half a comment on any other item could cite an
 * offer as its parent and run a job.
 *
 * **Which occurrence is decided by the comment being answered, never by
 * which skip is newest.** A reply is filed under the comment it answers
 * (D-05), that comment is the offer, and the offer's occurrence is
 * written on the occurrence row (migration 0079). Matching on "the
 * newest skipped row" instead was wrong twice over: scrolling up to an
 * offer from three weeks ago and pressing it would have run *this*
 * week's occurrence, and any comment on the thread whose first line
 * happened to read "Run it now" would have run the latest skip.
 */

/** The text of the offer. Answering with it is what fires the occurrence. */
export const RUN_NOW_OPTION = "Run it now";
/**
 * The other button, which does nothing on purpose.
 *
 * A single-option question is one a person cannot answer without doing
 * the thing, so the mention would stay open in the inbox until they
 * either ran a report they had decided against or deleted the comment.
 * Saying "leave it" is an answer, and answering is what closes a mention.
 */
export const LEAVE_IT_OPTION = "Leave it";

export const SKIP_OFFER_OPTIONS = [RUN_NOW_OPTION, LEAVE_IT_OPTION];

/**
 * Fires the occurrence a person has just said yes to, if that is what
 * they said.
 *
 * Called on every human comment, and answers `null` for almost all of
 * them. A reply that is not filed under anything leaves after one field
 * test; the rest cost a single indexed lookup, which all but a handful
 * of comments in EO's life will miss.
 */
export function answerSkipOffer(db: Db, comment: Comment): FireResult | null {
  // A reply to nothing is answering nothing. This is also what keeps an
  // ordinary remark on a job's thread — or on any other item — from
  // firing anything by containing the right words.
  if (comment.parentId === null) return null;
  if (!chose(comment.body)) return null;

  const occurrence = occurrenceForOffer(db, comment.parentId);
  // The parent is some other comment: a note, an answer, a guard that
  // offered nothing. Only a skip beyond the grace records itself here.
  if (!occurrence) return null;

  const offer = getComment(db, comment.parentId as Uuid);
  if (!offer) return null;
  // **The reply has to be on the thread the question was asked on.**
  // `parentId` is a claim rather than a proof: `comments:post` accepts
  // any id at all in it, and nothing in the schema makes a parent and
  // its child share an item — so a comment reading "Run it now" filed on
  // some unrelated item, citing this offer as its parent, would
  // otherwise have fired the occurrence. Answering a question means
  // answering it where it was asked.
  if (offer.itemId !== comment.itemId) return null;
  // Belt and braces against a comment somebody edited or a row written
  // by a version that did not have this rule: the offer is only an offer
  // if it actually put the option in front of the person.
  if (!offer.options?.includes(RUN_NOW_OPTION)) return null;
  // Pressed twice, or pressed on a screen that had not refreshed. An
  // occurrence fires once.
  if (hasFiredAt(db, occurrence.jobId as Uuid, occurrence.dueAt)) return null;

  // Read now rather than carried from the offer, so the firing uses the
  // job as it is today — a template edited since is the template the
  // person expects to get. A job somebody deleted while the offer sat
  // in their inbox files nothing: `getJob` still answers for one, since
  // its row survives as a tombstone so that the items it filed can name
  // it (EO-308), and every door a person can press is closed to it.
  const job = getJob(db, occurrence.jobId as Uuid);
  if (!job || job.deletedAt !== null) return null;
  // And the thread has to be *this job's*. Implied by the two checks
  // above today, since a guard is only ever posted on its own job's
  // thread — stated anyway, because it is the sentence the rule is
  // actually about, and the one a future caller would have to preserve.
  if (job.threadItemId !== comment.itemId) return null;
  return fireJob(db, job, { dueAt: occurrence.dueAt });
}

/**
 * Whether this reply is the offered answer.
 *
 * The first line only, because the inbox sends the chosen option with
 * whatever else was typed underneath it (`Inbox.tsx`), and
 * case-insensitively because a person typing the answer rather than
 * pressing it should not have to match the capitals.
 */
function chose(body: string): boolean {
  const first = body.split("\n", 1)[0]?.trim().replace(/[.!]+$/, "") ?? "";
  return first.toLowerCase() === RUN_NOW_OPTION.toLowerCase();
}
