import { answerOptions, type Comment, type Uuid } from "@eo/core";
import { unwrapAnswer } from "@eo/engine";
import type { Db } from "../db/client.js";
import { listAgents, listCommentsForItem } from "../db/repos/index.js";
import { isStandInReply, standInAgentIds, withoutOnYourBehalfNote } from "../trials/onBehalf.js";

/**
 * What a step that stopped and asked may treat as an answer (EO-183).
 *
 * Comments are the only communication channel (invariant #4), so a
 * non-agent step that parked with a question hears the reply by finding
 * it in the thread — there is no answers table, and adding one would put
 * a second channel beside the one that already works. Every reader of
 * that thread has to agree about what counts, and until now each wrote
 * its own version: `recordedStackAnswer` for the stacking question, and
 * a hand-written matcher in every module that asks one.
 *
 * They agreed on the rules, which is what made a single reader possible
 * rather than a compromise. Newest reply wins. Only what a person wrote
 * here — a comment pulled from Jira is excluded for the same reason it
 * closes no mentions: nobody answered EO, a sync found somebody talking
 * in Jira. And only what was written *after* EO's most recent
 * escalation, because everything before that answered a different
 * question and reading it as this one's answer is EO putting words in
 * somebody's mouth.
 *
 * The one clause that is not `recordedStackAnswer`'s is the second
 * author type below, and it is why this file exists at all rather than
 * the rules staying where they were. Every reader before this demanded
 * `authorType === "human"`, which is correct while a person is the only
 * thing that can answer — and is exactly what would have made a system
 * agent's reading of a free-text reply invisible to every step waiting
 * on one. EO-184 is what writes those comments: an `interpret` run
 * files the answer it read under the reply it read it out of, and this
 * clause is why the step that asked can see it. Landing that was one
 * change in one place rather than the same change in every waiting step,
 * which is what this file was split out for.
 */

/**
 * The role the agent that reads a reply for a step holds (EO-181).
 *
 * A string here rather than a reference to `BUILTIN_ROLES`, which is
 * what it was when no agent held the role yet. It stays one: this file
 * asks which comments count as answers, and that question does not want
 * to know what else the role means.
 */
const SYSTEM_ROLE = "system";

/**
 * Written by a person, here, in answer to something.
 *
 * A comment pulled from Jira is excluded for the same reason it closes
 * no mentions (`commentsRepo.ts`): nobody answered EO — a sync found
 * somebody talking in Jira, about anything at all.
 */
function isReplyFromPerson(comment: Comment): boolean {
  return comment.authorType === "human" && comment.jiraCommentId === null;
}

/**
 * The ids of every agent holding the system role.
 *
 * A set rather than one id: `agents.role` is not unique, and a reader
 * that picked the first row would silently ignore a second installation
 * ended up with. Read only when the thread actually contains an agent
 * comment, so the ordinary case — a person answering a question — costs
 * one query rather than two.
 */
function systemAgentIds(db: Db, thread: Comment[]): Set<string> {
  if (!thread.some((comment) => comment.authorType === "agent")) return new Set();
  return new Set(listAgents(db).filter((agent) => agent.role === SYSTEM_ROLE).map((agent) => agent.id));
}

/** The last thing EO asked, or -1 where it has asked nothing. */
function lastAskIndex(thread: Comment[]): number {
  let index = -1;
  for (const [position, comment] of thread.entries()) {
    if (comment.authorType === "engine" && comment.kind === "escalation") index = position;
  }
  return index;
}

/**
 * The answers in `thread` from `start` onwards, in thread order.
 *
 * Oldest first, matching `listCommentsForItem`, because "newest wins"
 * is the caller's to apply and a reader that reversed the order would
 * make every caller reverse it back. One pass: a system agent's reading
 * is filed under the reply it read, so it is always behind its parent in
 * this order and the parent is always already seen.
 *
 * Since EO-585 the system agent answering in the person's place on a
 * trial item (`isStandInReply`) is an answer in its own right, as the
 * person's would be.
 */
function answersFrom(thread: Comment[], start: number, systemAgents: Set<string>, standIns: ReadonlySet<string>): Comment[] {
  const parents = new Set<string>();
  const answers: Comment[] = [];

  for (const [position, comment] of thread.entries()) {
    if (position >= start && isReplyFromPerson(comment)) {
      parents.add(comment.id);
      answers.push(comment);
      continue;
    }
    // Read as its words alone: the note is EO's, for the person, and is
    // no part of the answer.
    if (position >= start && isStandInReply(comment, standIns)) {
      parents.add(comment.id);
      answers.push({ ...comment, body: withoutOnYourBehalfNote(comment.body) });
      continue;
    }
    const fromSystemAgent = comment.authorType === "agent" && comment.authorId !== null && systemAgents.has(comment.authorId);
    if (fromSystemAgent && comment.parentId !== null && parents.has(comment.parentId)) answers.push(comment);
  }

  return answers;
}

/**
 * What a waiting step may read as an answer to the question it asked.
 *
 * Empty where EO has asked nothing — a thread with no escalation in it
 * has no question outstanding, so there is nothing anybody could be
 * answering. That is the same gate `recordedStackAnswer` has always
 * applied before quoting a reply back as unusable.
 */
export function answersSinceLastAsk(db: Db, itemId: Uuid): Comment[] {
  const thread = listCommentsForItem(db, itemId);
  const lastAsk = lastAskIndex(thread);
  if (lastAsk === -1) return [];
  return answersFrom(thread, lastAsk + 1, systemAgentIds(db, thread), standInAgentIds(db, itemId));
}

/**
 * The same, over the whole thread rather than since the last ask.
 *
 * For the reader that has a question of its own and can tell whether a
 * reply answers *it*. The stacking question is the case: EO asks where a
 * tied story should stack, a person names a dependency, and then some
 * other guard escalates about something else entirely. The naming is
 * still the answer — it named one of the choices — and only the reader
 * that knows what the choices were can say so.
 *
 * Which is why this is not what a module gets. A module's ask is prose,
 * so a reply from before it was asked cannot be told apart from a reply
 * to it, and `answersSinceLastAsk` is the only honest answer there.
 */
export function answersInThread(db: Db, itemId: Uuid): Comment[] {
  const thread = listCommentsForItem(db, itemId);
  return answersFrom(thread, 0, systemAgentIds(db, thread), standInAgentIds(db, itemId));
}

/** The newest answer to this step's last question, and what that question offered (EO-183). */
export interface StepAnswer {
  /**
   * What was actually said, raw.
   *
   * Unprocessed on purpose: `matched` is what EO is prepared to claim,
   * and this is everything else. A step that wants to read more out of a
   * sentence than "it is one of these five" has the sentence.
   */
  text: string;
  /** The options that ask carried, in the order they were offered. Empty where it offered none. */
  offered: string[];
  /** The one of `offered` this answer is, or null where it is none of them. */
  matched: string | null;
}

/** The same, with the comment it was read out of (EO-184). */
export interface NewestAnswer extends StepAnswer {
  /**
   * The comment itself.
   *
   * Who wrote it and which row it is are both load-bearing for the
   * interpreter and for neither of `answerToLastAsk`'s other readers: a
   * sentence is handed to the system agent only when a *person* wrote
   * it, and only once, which needs an id to remember it by.
   */
  comment: Comment;
}

/**
 * The newest answer since EO last asked on this item, and the comment
 * carrying it — or null.
 *
 * The whole of `answerToLastAsk`, which is now the same answer with the
 * comment dropped. Split rather than duplicated because the two must
 * agree about which reply is the newest one and what it matched: a
 * module acting on one comment while the interpreter reads another is a
 * disagreement nothing downstream could detect.
 */
export function newestAnswerToLastAsk(db: Db, itemId: Uuid): NewestAnswer | null {
  const thread = listCommentsForItem(db, itemId);
  const lastAsk = lastAskIndex(thread);
  if (lastAsk === -1) return null;

  const answers = answersFrom(thread, lastAsk + 1, systemAgentIds(db, thread), standInAgentIds(db, itemId));
  const newest = answers.at(-1);
  if (newest === undefined) return null;

  // Answers only: an action button (EO-533) is pressed, never said.
  const offered = answerOptions(thread[lastAsk]?.options);
  const said = unwrapAnswer(newest.body).toLowerCase();
  return {
    comment: newest,
    text: newest.body,
    offered,
    // The offered label, not what the person typed: it is what the
    // module named its own answers with, and handing back the reply's
    // own casing would make an equality check the module writes fail on
    // the very answer it was told matched.
    matched: offered.find((option) => unwrapAnswer(option).toLowerCase() === said) ?? null,
  };
}

/**
 * The newest answer since EO last asked on this item, or null.
 *
 * Null covers both "nobody has answered" and "nothing has been asked",
 * deliberately: the difference does not change what a step does about
 * it, which is ask.
 *
 * `matched` is an exact comparison against what was actually offered,
 * after the unwrapping `readStackAnswer` applies — so "Send it back."
 * typed with the full stop a person types, or a label a button pasted
 * back inside backticks, is still the option "Send it back". Case is
 * ignored for the same reason. What it is not is a guess: a reply that
 * equals none of the options comes back with `matched: null` and its
 * `text`, and whether those words meant one of the options is a
 * judgement this cannot make and does not fake.
 */
export function answerToLastAsk(db: Db, itemId: Uuid): StepAnswer | null {
  const newest = newestAnswerToLastAsk(db, itemId);
  if (newest === null) return null;
  const { text, offered, matched } = newest;
  return { text, offered, matched };
}
