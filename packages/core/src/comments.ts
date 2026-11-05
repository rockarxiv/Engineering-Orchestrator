import type { Uuid } from "./index.js";
import type { CommentOption } from "./schemas/commentOptions.js";

// Closed unions, like RunStatus — the engine/service layer branches on
// these exact values (ARCHITECTURE.md, "The timeline is two tables"), so a new one is a code
// change, not a data row.
/**
 * Who wrote a comment.
 *
 * `module` joined the three (EO-75). A module's comment is neither an
 * agent's nor EO's own: there is no agent row behind it, and `engine`
 * means EO talking about its own bookkeeping — which is why an engine
 * note is deliberately never mirrored to Jira, and a module's note has
 * to be. Folding it into either would have made the thread say
 * something untrue about who spoke.
 *
 * `authorId` stays null for one: the module's name travels in the body,
 * because that is the only part of a comment Jira receives.
 */
export type CommentAuthorType = "human" | "agent" | "engine" | "module";
/**
 * What a comment is for.
 *
 * `output` joined the six (EO-298). It is the thing a person approves —
 * a report, a reply, a diff — and until it was a kind it was whatever
 * the run happened to leave behind: buried in the thread, or hanging off
 * an attachment nobody pointed at. So the "post this to Slack" module
 * posted what the agent produced rather than what the approver corrected
 * (ARCHITECTURE.md, "The output is a comment").
 *
 * A kind rather than a table, and deliberately: `attachments.commentId`
 * is NOT NULL, so an output that carries files already had to hang on a
 * comment, and making it a comment keeps invariant 4 — comments are the
 * only communication channel — instead of opening a second one beside it
 * (ARCHITECTURE.md, "The output is a comment").
 *
 * The *current* output is derived rather than stored, the way the
 * needs-attention marker is (invariant 6): it is the latest output
 * comment on the item. A person's edit posts a superseding one whose
 * `parentId` chains it to the one it replaces, and the one it replaced
 * stays in the thread — `run_events` is not the only place EO refuses to
 * rewrite what happened.
 */
export type CommentKind = "note" | "question" | "decision" | "approval" | "rejection" | "escalation" | "output";
export type MentionTargetType = "human" | "agent";
export type MentionStatus = "open" | "addressed" | "dismissed";

/** A local file deliberately attached to a human chat message. */
export interface AgentAttachment {
  /** Stable UUIDv7 identity for persisted attachments. Absent only on legacy fixtures. */
  id?: Uuid;
  itemId?: Uuid;
  commentId?: Uuid;
  kind: "image" | "file";
  /** Absolute path resolved and validated by the main process. */
  path: string;
  name: string;
  mimeType: string;
  size: number;
  /** Safe provenance metadata shown to agents; absent only on legacy fixtures. */
  origin?: "eo" | "legacy";
  synchronizationState?: "local";
}

export interface Comment {
  id: Uuid;
  itemId: Uuid;
  authorType: CommentAuthorType;
  authorId: Uuid | null; // agents.id when authorType === "agent"
  runId: Uuid | null; // set if written during a run
  /** The comment this answers, if it is a reply (D-05). */
  parentId: Uuid | null;
  body: string; // markdown
  kind: CommentKind;
  /** Choices, rendered as buttons: answers (strings) and, since EO-533, actions that open something (`CommentOption`). */
  options: CommentOption[] | null;
  /** Absent only on legacy/in-memory fixtures; persisted comments normalize it to an empty array. */
  attachments?: AgentAttachment[];
  pinned: boolean; // survives context truncation (ARCHITECTURE.md, "What an agent is given")
  /**
   * The Jira comment this one is, when it is one — pulled from there,
   * or pushed there and acknowledged. Null for a comment that has no
   * Jira counterpart.
   */
  jiraCommentId: string | null;
  createdAt: number;
}

export interface CommentMention {
  commentId: Uuid;
  targetType: MentionTargetType;
  /**
   * Who is being asked: `agents.id` on an `agent` row, `people.id` on a
   * `human` one (EO-302, ARCHITECTURE.md, "Identity").
   *
   * Null only on a row written before migration 0077, which no database
   * that has opened since holds: "the human" had no id to name, so the
   * inbox and the `!` marker were queries for an absence. Kept nullable
   * because the column is — tightening it is a table rebuild bought for
   * a constraint `postComment` cannot break.
   */
  targetId: Uuid | null;
  status: MentionStatus;
  addressedBy: Uuid | null; // the reply comment that resolved it
}

/**
 * What postComment()'s explicit `mentions` array (and @-parsing) resolve to.
 *
 * `human` carries no person by default, deliberately (EO-302). Which
 * person "the human" is, is a fact about the installation rather than
 * about the token, and `postComment` — the single write path for a
 * mention row — is what fills it in. Seven places build one of these;
 * none of them has to remember.
 *
 * `personId` is the one case where the caller knows better than the
 * installation does (EO-325): a comment arriving over the record
 * contract was written on somebody else's machine, for somebody the
 * record can name, and resolving it against *this* machine's person
 * would put a colleague's question in your inbox — or, on a second
 * desktop of your own, put your own question in nobody's. It is
 * optional because every local caller should go on not knowing.
 */
export type MentionTarget = { type: "human"; personId?: Uuid } | { type: "agent"; agentId: Uuid };

export interface OpenMention {
  comment: Comment;
  mention: CommentMention;
}
