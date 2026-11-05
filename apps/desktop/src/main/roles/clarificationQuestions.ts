import type { ClarificationRequired, Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { listCommentsForItem, postComment } from "../db/repos/index.js";
import { isStandInReply, standInAgentIds } from "../trials/onBehalf.js";

/**
 * An agent's questions, put into the thread by the engine (KAN-29).
 *
 * One comment per question, deliberately. Three questions in one comment
 * can only be answered all at once or not at all, and the whole reason
 * this exists is that answering one of three used to look exactly like
 * answering three.
 *
 * `kind: "question"` and a human mention are what the inbox and the
 * item view already key on, so a question posted this way behaves like
 * every other thing waiting on a person — no new surface, no new badge.
 */
export function postClarificationQuestions(
  db: Db,
  item: Item,
  agentId: Uuid,
  runId: Uuid,
  asked: ClarificationRequired,
): void {
  for (const question of asked.questions) {
    postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "agent", agentId },
      kind: "question",
      mentions: [{ type: "human" }],
      // `why` is on its own line rather than folded into the question:
      // it is what lets someone who is not holding the agent's context
      // judge whether they can answer, and burying it in a paragraph
      // wastes the one field that makes that possible.
      body: `${question.question}\n\n_${question.why}_`,
      options: question.options.length > 0 ? question.options : null,
    });
  }
}

/**
 * Questions on this item that nobody has answered yet.
 *
 * An answer is a human comment filed *under* the question (D-05 already
 * threads replies that way, and the item view already opens a reply
 * box on anything awaiting a human). Keying on that rather than on
 * "somebody said something on this item" is the entire fix: a reply to
 * one question no longer looks like a reply to all of them.
 *
 * Deliberately not keyed on mention status. Posting a human comment
 * resolves open human mentions on the whole item at once, so a
 * mention-based count would go to zero on the first answer — which is
 * the bug wearing a different hat.
 */
export function unansweredQuestions(db: Db, itemId: Uuid): Uuid[] {
  const comments = listCommentsForItem(db, itemId);
  // The system agent's reply on a trial item answers as the person's
  // would (EO-585, `isStandInReply`).
  const standIns = standInAgentIds(db, itemId);
  const answered = new Set(
    comments
      .filter((comment) => comment.parentId && (comment.authorType === "human" || isStandInReply(comment, standIns)))
      .map((comment) => comment.parentId),
  );

  return comments
    .filter((comment) => comment.kind === "question" && comment.authorType === "agent" && !answered.has(comment.id))
    .map((comment) => comment.id);
}
