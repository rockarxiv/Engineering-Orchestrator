import { takeoverLine, type Comment, type Item, type Person, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { setItemAssignee } from "../db/repos/itemsRepo.js";

/**
 * Who holds an item, written down, and the sentence the thread keeps
 * about it (EO-305, EO-367, ARCHITECTURE.md, "The board").
 *
 * One writer for both places an assignment is *decided*: a solo desktop
 * deciding for itself (`ipc/domainCommands.ts`), and the record deciding
 * for a device that asked (`record/serveRecord.ts`). Two copies of the
 * sentence would drift, and a thread that read "Claimed by Anna." on one
 * machine and something else on the next would read as two events.
 *
 * A signed-in desktop never calls this for an item on the record. It
 * writes a provisional assignee and queues a command, and the record
 * calls this when it applies it — which is how the comment comes to name
 * the person rather than whoever "you" is on the machine that asked.
 */
export type AssignmentHow = "claim" | "assign";

export function assignmentLine(how: AssignmentHow, name: string, by?: string): string {
  return how === "claim" ? `Claimed by ${name}.` : `Assigned to ${name}${by === undefined ? "" : ` by ${by}`}.`;
}

export interface WriteAssignmentInput {
  itemId: Uuid;
  person: Person;
  how: AssignmentHow;
  /** Who did the assigning, where EO can name them. Ignored for a claim, which is the claimant's own act. */
  by?: string;
  /**
   * The comment's id, where it already has one — the device minted it
   * when it queued the command, so that a replay is "already done"
   * rather than a second sentence (`RecordClaimCommandSchema`).
   */
  commentId?: Uuid;
}

/**
 * The assignee, and then the comment.
 *
 * EO's own voice, not the person's: this records what happened rather
 * than saying anything on anybody's behalf, the way the hold and resume
 * notes do. "you" is the local person's name, so the sentence reads as
 * one in solo mode without a special case here.
 *
 * Never a transition. The item does not move, `items.stepId` is not
 * written, and no run is disturbed (invariant #1).
 */
export function writeAssignment(db: Db, input: WriteAssignmentInput): Comment {
  setItemAssignee(db, input.itemId, input.person.id);
  return postComment(db, {
    ...(input.commentId === undefined ? {} : { id: input.commentId }),
    itemId: input.itemId,
    author: { type: "engine" },
    body: assignmentLine(input.how, input.person.name, input.how === "assign" ? input.by : undefined),
  });
}

export interface WriteTakeoverInput {
  itemId: Uuid;
  /** Who is taking it. */
  person: Person;
  /** Who loses it — the holder the person was warned about, and the record found still holding it. */
  previous: { id: string; name: string };
  /** The comment's id, minted by the device that asked, so a replay is "already done". */
  commentId?: Uuid;
}

/**
 * A takeover, written down (EO-368): the assignee, and "Dana took this
 * over from Anna." with a mention of Anna.
 *
 * The mention is the point of it. Losing an item somebody was holding is
 * exactly the thing that must not happen quietly (invariants #4 and #8),
 * and an open human mention *is* the inbox row — so the previous holder
 * hears it on whichever of their machines they next open, with the name
 * of the person who has it now.
 *
 * Not a transition, for the claim's reason (invariant #1).
 */
export function writeTakeover(db: Db, input: WriteTakeoverInput): Comment {
  setItemAssignee(db, input.itemId, input.person.id);
  return postComment(db, {
    ...(input.commentId === undefined ? {} : { id: input.commentId }),
    itemId: input.itemId,
    author: { type: "engine" },
    body: takeoverLine(input.person.name, input.previous.name),
    mentions: [{ type: "human", personId: input.previous.id as Uuid }],
    parseBodyMentions: false,
  });
}

/**
 * Whether a claim may take this item, and if not, who has it (EO-367).
 *
 * The record's arbitration, on its own so that it is one rule stated
 * once. The first claim on an item nobody holds wins; a claim by the
 * person who already holds it is nothing to do; anything else is
 * somebody else's item, and the claim is dropped with their name.
 *
 * A pure answer about two ids, and deliberately nothing more. Who may
 * claim at all, and taking an item over from its holder, are decisions
 * that belong beside this rather than inside it.
 */
export type ClaimVerdict = { kind: "take" } | { kind: "already" } | { kind: "held"; holderId: string };

export function arbitrateClaim(item: Pick<Item, "assigneeId">, claimantId: string): ClaimVerdict {
  if (item.assigneeId === null) return { kind: "take" };
  if (item.assigneeId === claimantId) return { kind: "already" };
  return { kind: "held", holderId: item.assigneeId };
}
