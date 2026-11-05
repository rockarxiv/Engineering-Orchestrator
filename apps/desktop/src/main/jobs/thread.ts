import { developerType, type Comment, type CommentKind, type Item, type Job, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { createItem, postComment } from "../db/repos/index.js";

/**
 * The one off-board item a job owns as its thread (EO-304,
 * `ARCHITECTURE.md`, "What a job records", "Conversations").
 *
 * The Discussions precedent reused. A guard that fires when no item
 * exists — a skipped occurrence, a budget trip before dispatch, a
 * template that no longer resolves — still has to end in a comment
 * (invariant #8), and it must not invent a second channel to do it
 * (invariant #4). So every job owns a thread, and the guard posts there
 * and mentions the owner: the inbox, the `!` marker and the OS
 * notification all work unchanged because none of them learn anything
 * new.
 */

/**
 * The step a job thread sits on — migration 0078.
 *
 * Its own step on the `discussions` pipeline rather than a
 * conversation's, for 0036's and 0064's reason: the step is what the code
 * keys on. Sharing one would put every job in a conversation room's list
 * and could hand a person a job thread as the room they are typing into.
 *
 * Not in `roles/conversationSteps.ts` with the rooms, because that
 * module answers "which off-board steps hold a *conversation*, and what
 * each one runs" — and a job thread runs nothing. Nothing is ever
 * dispatched against it: it is somewhere to post.
 */
export const JOB_THREAD_STEP = "job-thread";

/** Its own key sequence, for `DISC`'s reason — a thread is not work people quote. */
export const JOB_THREAD_KEY_PREFIX = "JOB";

/**
 * What the thread is called (EO-308).
 *
 * One spelling, because renaming a job retitles its thread: the title
 * is written here when the job is created and rewritten here when it is
 * renamed, and two copies of the prefix would leave half the threads in
 * an installation with the old one.
 */
export function jobThreadTitle(name: string): string {
  return `Job: ${name}`;
}

/**
 * Creates the thread for a job about to be made.
 *
 * Throws rather than returning a refusal, exactly as
 * `openAssistConversation` does and for the same reason: the thread is being created, so there is
 * no thread to post the refusal into. An installation whose project has
 * no container type cannot host a job any more than it can host a chat.
 */
export function openJobThread(db: Db, name: string, projectId: Uuid | null): Item {
  const created = createItem(db, {
    // A container type, deliberately and not cosmetically: it is what
    // gives a thread item the read-only shape `openAssistConversation` relies
    // on — the repository itself rather than a worktree, no branch and
    // no pull request. Inherited rather than special-cased.
    type: developerType("feature"),
    title: jobThreadTitle(name),
    stepId: JOB_THREAD_STEP,
    projectId,
    keyPrefix: JOB_THREAD_KEY_PREFIX,
  });
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

/**
 * What a guard offers the person to do about it, when there is something
 * (EO-306).
 *
 * A `question` with options is drawn as buttons by the inbox and the
 * item thread alike, and answering one is an ordinary reply — which is
 * how "Run it now" works before the Jobs page exists. A guard with
 * nothing to offer stays a `note`: a question nobody can answer is a
 * mention that never closes.
 */
export interface JobThreadOffer {
  kind?: CommentKind;
  options?: string[];
  /**
   * An account of what *this machine* did, rather than of the job
   * (EO-325).
   *
   * One caller: a desktop declining to fire a job whose project is its
   * organisation's. That is a sentence for the person in front of this
   * machine — the record has its own view of the same job and files its
   * own work — so it is not queued onward, exactly as the drain's note
   * about its own queue is not.
   */
  staysHere?: boolean;
}

/**
 * Says something on a job's thread, in the owner's name.
 *
 * `author: { type: "engine" }` because EO is the one talking — no agent
 * ran — and a human mention because the owner is who needs to know. In
 * solo mode the owner is the local person, which is precisely who
 * `postComment` resolves a human mention to (EO-302); when 7b brings
 * other people, the mention target grows an id and this is the call site
 * that gains it. The owner is named in the sentence either way, so the
 * comment reads as being about somebody rather than about nobody.
 *
 * Returns the comment, because a guard that offers something has to be
 * able to say *what* it offered: EO-306 records the offer's id on the
 * occurrence it is an offer for, which is what binds a person's reply to
 * one occurrence rather than to whichever skip is newest.
 */
export function postToJobThread(db: Db, job: Job, body: string, offer: JobThreadOffer = {}): Comment {
  return postComment(db, {
    itemId: job.threadItemId as Uuid,
    author: { type: "engine" },
    kind: offer.kind ?? "note",
    ...(offer.options === undefined ? {} : { options: offer.options }),
    // An account of what *this machine* did, where it is one (EO-325):
    // a desktop declining to fire a job whose project is the record's
    // is telling the person in front of it, not telling the
    // organisation. Absent for every other guard, which is something
    // that happened to the job itself and belongs wherever the job is.
    ...(offer.staysHere === true ? { staysHere: true } : {}),
    mentions: [{ type: "human" }],
    // The body is EO's own sentence, so nothing in it should be re-read
    // as an @-mention: a job called "@ops nightly" must not dispatch an
    // agent by being named in a guard about itself.
    parseBodyMentions: false,
    body,
  });
}
