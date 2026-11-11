import {
  parseQualifiedItemType,
  qualifiedItemType,
  uuidv7,
  type Agent,
  type Comment,
  type DiscussionMessage,
  type Item,
  type ItemTypeRef,
  type ProposalSummary,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, listCommentsForItem, localPerson, postComment } from "../db/repos/index.js";
import type { ItemRecord } from "../record/record.js";
import { recordItemsFromConversation } from "../jobs/fromDiscussion.js";
import type { ConversationThread } from "../roles/conversationThread.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import {
  applyDiscussionProposal,
  describeProposal,
  reorderOnTheRecord,
  type ApplyDiscussionResult,
  handedOver,
  proposalOfComment,
  SKIPPED_ANSWER,
  summariseProposal,
  type ProposalAtLength,
  type AddedFieldValues,
} from "../roles/discussion.js";
import type { ItemTypeName } from "../db/repos/itemTypesRepo.js";
import { approvalNote } from "./approvalNote.js";
import { answerableQuestionIds } from "./conversationView.js";
import type { EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";

/**
 * The write half of a conversation, for whichever room is having one.
 *
 * `conversationView.ts` is the read half and says why it is shared: two
 * implementations of "is this question still live" would drift, and the
 * failure would be silent. This is the same argument applied to the
 * answer that follows — which questions a batch actually answers, what a
 * skip is recorded as, and which single comment carries the mention that
 * starts the next turn. Discussions and the architect panel had that
 * written out twice, identically, before the assistant's room made it
 * three (EO-190).
 *
 * It deliberately takes a conversation and an agent rather than an id:
 * *which* conversation a room may write to differs — Discussions scopes
 * to the active project, the architect to a pipeline, the widget to a
 * page — and those guards belong with the room that owns them.
 */
export interface AnsweredBatch {
  /** How many questions this actually answered; 0 with a problem when they were already stale. */
  answered: number;
  problem: string | null;
}

export function answerQuestionBatch(
  db: Db,
  engine: EngineHandle | undefined,
  conversation: Item,
  agent: Agent,
  answers: { questionId: string; answer: string | null }[],
): AnsweredBatch {
  const answerable = answerableQuestionIds(db, conversation);
  // In the order they were asked, not the order they arrived: the card
  // can be clicked through in any order, and the thread should read the
  // way the questions were put.
  const asked = listCommentsForItem(db, conversation.id)
    .filter((comment) => answerable.has(comment.id))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const pending = asked.flatMap((question) => {
    const given = answers.find((entry) => entry.questionId === question.id);
    return given ? [{ question, answer: given.answer }] : [];
  });

  if (pending.length === 0) {
    return {
      answered: 0,
      problem: "Those questions have already been answered or replaced by a newer turn. Read the latest message and answer that instead.",
    };
  }

  pending.forEach(({ question, answer }, index) => {
    const trimmed = answer?.trim() ?? "";
    postComment(db, {
      id: uuidv7(),
      itemId: conversation.id,
      author: { type: "human" },
      parentId: question.id,
      body: trimmed === "" ? SKIPPED_ANSWER : trimmed,
      // The last answer is the one that starts the turn, so the agent
      // reads a complete set rather than being dispatched on the first
      // click and re-dispatched on every one after it.
      ...(index === pending.length - 1 ? { mentions: [{ type: "agent" as const, agentId: agent.id }] } : {}),
    });
  });

  // A person's send: the turn it asks for starts on the next tick, not after a debounce.
  engine?.notifyStateChange({ promptly: true });
  return { answered: pending.length, problem: null };
}

/** What approving a proposal did, for the room that offered the button. */
export interface AppliedProposal {
  applied: boolean;
  /** Why nothing was applied, when `applied` is false. Posted into the thread too. */
  problem: string | null;
  /** Keys of whatever was created or changed, so the room can name them. */
  createdKeys: string[];
  changedKeys: string[];
}

/**
 * Creates the work a proposal describes, and says so in the thread.
 *
 * `applyDiscussionProposal` is the gate and always was; what is here is
 * the half either room would otherwise have written twice — the comment
 * filed under the proposal, which is *also* what marks it as dealt with
 * so it stops being approvable, and the pushes that make the new items
 * show up on the board behind the panel.
 *
 * Whether *this* card may be approved at all is the calling room's
 * business and stays there: each room recognises its own cards, and the
 * assistant's room has a second refusal of its own for a pipeline
 * draft, which is approvable-looking and published rather than approved.
 */
export function approveWorkProposal(
  db: Db,
  engine: EngineHandle | undefined,
  conversation: Item,
  proposalCommentId: Uuid,
  /**
   * The type the person picked at the gate, qualified — `local:case`
   * (ARCHITECTURE.md, "An item type is data", KAN-164). Undefined means "as proposed", which is
   * what every
   * approval was before the picker existed.
   *
   * Qualified rather than a bare word because two packs may ship a
   * `case` and `resolveItemType` refuses a slug with two answers; an
   * unreadable spelling is passed straight through so that the refusal
   * naming it comes from the resolver rather than from a silent fallback
   * to the proposal's own type.
   */
  chosenType?: string,
  /** What a person set for fields the project added to a row's type (EO-735); see `assist:approve`. */
  addedValues: AddedFieldValues = [],
): AppliedProposal {
  const applied = applyDiscussionProposal(db, conversation, proposalCommentId, null, typeChoice(chosenType), addedValues);
  return settleApproval(db, engine, conversation, proposalCommentId, applied);
}

/**
 * `approveWorkProposal`, for a door that can reach the record (EO-600).
 *
 * A reorder card on an item the organisation's record holds is asked of
 * the record, which judges the change against its graph and writes it
 * whole with its one comment, or refuses it whole; the answer is copied
 * into this replica before it comes back. A record that cannot be reached
 * changes nothing, and the rejection filed under the card says so. Every
 * other card is `approveWorkProposal`, here, unchanged.
 */
export async function approveWorkProposalThroughRecord(
  db: Db,
  engine: EngineHandle | undefined,
  record: Pick<ItemRecord, "changeDependencies">,
  conversation: Item,
  proposalCommentId: Uuid,
  chosenType?: string,
  addedValues: AddedFieldValues = [],
): Promise<AppliedProposal> {
  const held = reorderOnTheRecord(db, conversation, proposalCommentId);
  if (held === null) return approveWorkProposal(db, engine, conversation, proposalCommentId, chosenType, addedValues);

  const { item, proposal } = held;
  const answer = await record.changeDependencies({
    itemId: item.id,
    add: proposal.add_depends_on,
    remove: proposal.remove_depends_on,
    by: localPerson(db).name,
    why: proposal.why,
  });
  const applied: ApplyDiscussionResult = answer.ok ? { ok: true, created: [], changed: [getItem(db, item.id) ?? item] } : { ok: false, reason: answer.problem };
  return settleApproval(db, engine, conversation, proposalCommentId, applied);
}

/**
 * What an approval leaves behind, however it was applied: the comment
 * under the card, which is also what marks it dealt with, and the pushes.
 */
function settleApproval(
  db: Db,
  engine: EngineHandle | undefined,
  conversation: Item,
  proposalCommentId: Uuid,
  applied: ApplyDiscussionResult,
): AppliedProposal {
  // Either way it goes in the thread, under the proposal it answers
  // (invariant #8: nothing is dropped silently).
  postComment(db, {
    itemId: conversation.id,
    author: { type: "human" },
    kind: applied.ok ? "approval" : "rejection",
    parentId: proposalCommentId,
    body: applied.ok ? approvalNote(applied) : `Not applied. ${applied.reason}`,
  });

  if (applied.ok) {
    // The `from-discussion` trigger (EO-304, ARCHITECTURE.md, "Trigger kinds"). This call
    // is what "pressing Create in a conversation" means, so this is
    // where the item's provenance is recorded — one occurrence per item
    // created, on the job this conversation owns.
    recordItemsFromConversation(db, conversation, applied.created);
    for (const item of [...applied.created, ...applied.changed]) emitPush("items:changed", { itemId: item.id });
    engine?.notifyStateChange();
  }

  return {
    applied: applied.ok,
    problem: applied.ok ? null : applied.reason,
    createdKeys: applied.ok ? applied.created.map((item) => item.key) : [],
    changedKeys: applied.ok ? applied.changed.map((item) => item.key) : [],
  };
}

/**
 * A qualified spelling as the resolver takes it, or the word itself when
 * it is not one.
 *
 * `undefined` for "nothing was chosen". A string that does not split is
 * handed on as a bare slug rather than dropped: `resolveItemType` has
 * the sentence for a word this project does not have, and inventing a
 * pack here would be guessing which of two somebody meant.
 */
function typeChoice(chosen: string | undefined): ItemTypeName | undefined {
  if (chosen === undefined) return undefined;
  return parseQualifiedItemType(chosen) ?? chosen;
}

/**
 * Which type a single-item proposal would file, qualified, or null.
 *
 * What the approval gate's picker opens on (ARCHITECTURE.md, "An item type is data", KAN-164). Null
 * for the
 * three cards where choosing a type would mean nothing: a plan carries a
 * container and its children, each with their own, and an amendment or a
 * reorder is about work that already exists and already has one.
 *
 * Read from the proposal behind the comment for `approvalOf`'s reason —
 * the renderer cannot read the run, and a second implementation that
 * guessed from the card's prose would be a picker offering to change
 * something it had misidentified.
 */
export function proposedTypeOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): string | null {
  const proposal = proposalOfComment(db, conversation, comment.id, thread);
  if (!proposal) return null;
  if (proposal.action !== "new_story" && proposal.action !== "new_bug") return null;
  return qualifiedItemType(handedOver(proposal).type as ItemTypeRef);
}

/**
 * What approving a work card would do, as the card itself says it.
 *
 * Read from the proposal behind the comment rather than from its text,
 * and shared by the two rooms that can hold one so they cannot answer it
 * differently. `changes` for a card that has no readable proposal
 * behind it any more: the honest fallback is the vaguer promise, since
 * "Create item" over something that turns out to amend one is the
 * failure this exists to avoid.
 */
export function approvalOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): NonNullable<DiscussionMessage["approves"]> {
  const proposal = proposalOfComment(db, conversation, comment.id, thread);
  if (!proposal) return "changes";
  return proposal.action === "amend" || proposal.action === "reorder" ? "changes" : "items";
}

/**
 * The work a card proposes, as rows, or null for a comment with no work
 * proposal behind it (EO-407) — see `DiscussionMessage.proposal`.
 *
 * Read through `proposalOfComment`, the reader `applyDiscussionProposal`
 * builds from, for `approvalOf`'s reason: what the card lists has to be
 * what the button files. Asked of every comment, approvable or not, so
 * it answers null for anything that is not a card before reading a run.
 */
export function proposalSummaryOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): Omit<ProposalSummary, "closed"> | null {
  if (comment.kind !== PROPOSAL_KIND) return null;
  const proposal = proposalOfComment(db, conversation, comment.id, thread);
  return proposal ? summariseProposal(db, conversation, proposal) : null;
}

/**
 * What a card's rows leave out (EO-408): each new item's description and
 * where the work would land, or null where `proposalSummaryOf` is null.
 *
 * Through the same reader, for the same reason. Asked for one card at a
 * time by the view that draws a proposed item, never for a whole thread.
 */
export function proposalAtLengthOf(db: Db, conversation: Item, comment: Comment): ProposalAtLength | null {
  if (comment.kind !== PROPOSAL_KIND) return null;
  const proposal = proposalOfComment(db, conversation, comment.id);
  return proposal ? describeProposal(db, conversation, proposal) : null;
}
