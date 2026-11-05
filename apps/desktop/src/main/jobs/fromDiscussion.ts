import type { Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { recordOccurrence } from "../db/repos/index.js";
import { createJob } from "./jobs.js";

/**
 * The `from-discussion` trigger: an item created by pressing Create in
 * a conversation (EO-304, `ARCHITECTURE.md`, "Trigger kinds").
 *
 * Why this is a job at all, rather than a flag on the item. The design makes
 * one claim and everything here follows from it: a scheduled run and a
 * webhook are not a different kind of work item, they are a different
 * way of *creating* one. A conversation is a third such way. If it were
 * recorded any other way then EO would hold provenance in two
 * mechanisms — an occurrence for the ways that recur, something else
 * for the way that does not — and the detail rail would have to ask
 * both. One job per conversation, made on the first approval and reused
 * after, keeps it to one.
 *
 * The conversation is the job's own thread (ARCHITECTURE.md, "What a job records"), so no second
 * item is
 * created and the guard channel a job needs is the one the conversation
 * already is.
 */

/**
 * What a conversation's job is called.
 *
 * The key rather than a title, because a conversation has none: they are
 * all called "Conversation" and are told apart by `DISC-12` everywhere
 * else in the app. The original design's example reads "From: conversation 'Q3 report'"
 * because it assumes a named one; naming the item is the closest true
 * thing EO can say, and it is what the person sees on the rail.
 */
export function conversationJobName(conversation: Item): string {
  return `Conversation ${conversation.key}`;
}

/**
 * Records that these items came from this conversation.
 *
 * One occurrence per created item rather than one per press. Approving
 * a plan creates a container and its children in one act, and an
 * occurrence per press would leave all but one of them unable to say
 * where they came from — which is the question the record exists to
 * answer.
 *
 * Silent when there is nothing to record, and never the reason an
 * approval fails: the items are already created and committed by the
 * time this is called, so a provenance that could refuse would be a
 * provenance that could undo somebody's work.
 */
export function recordItemsFromConversation(db: Db, conversation: Item, created: Item[]): void {
  if (created.length === 0) return;

  const job = createJob(db, {
    projectId: conversation.projectId,
    name: conversationJobName(conversation),
    trigger: { kind: "from-discussion", conversationId: conversation.id },
  });
  // The only refusal this call has is a conversation that does not
  // exist, and the caller is holding it. Handled rather than asserted
  // because the alternative is throwing out of a path whose work has
  // already been committed — the approval would report a failure that
  // did not happen, and the items would still be there.
  if (!job.ok) return;

  const now = Date.now();
  for (const item of created) {
    recordOccurrence(db, {
      jobId: job.job.id as Uuid,
      // The press is both when it was due and when it fired: nobody
      // scheduled it, so there is no earlier moment it was meant for.
      dueAt: now,
      status: "fired",
      firedAt: now,
      itemId: item.id,
    });
  }
}
