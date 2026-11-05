import type { Comment, Uuid } from "@eo/core";
import type { Db } from "./client.js";

/**
 * What a listener is told beside the comment itself (EO-324).
 *
 * `staysHere` is the one fact about a comment that is not on the row:
 * whether this copy travels any further than this machine. A listener
 * that carries comments onward — the queue for the organisation's
 * record — has to know it, and it cannot read it back afterwards
 * because nothing about a stored comment says where it came from.
 *
 * A second parameter rather than a field on `Comment`, because it is
 * not a property of what was said. It is a property of *this writing of
 * it*: the same comment is ordinary on the desktop that wrote it and
 * stays-here on every desktop it is mirrored to.
 */
export interface CommentContext {
  /** See `PostCommentInput.staysHere`. */
  staysHere: boolean;
  /** See `PostCommentInput.endsRun`. Absent is false. */
  endsRun?: boolean;
}

export type CommentListener = (comment: Comment, context: CommentContext) => void;
export type ThreadListener = (itemId: Uuid) => void;

/**
 * Who wants to know that a comment was written.
 *
 * Keyed on the `Db` instance rather than module-global, which matters
 * for two reasons: one test's in-memory database must not fire another
 * test's listeners, and the production wiring must not stay alive inside
 * every unit test that happens to open a database. A `WeakMap` also lets
 * a test's DB and its listener set be collected together.
 */
const listeners = new WeakMap<Db, Set<CommentListener>>();
const removalListeners = new WeakMap<Db, Set<ThreadListener>>();

/**
 * Called when any comment is written against `db`. Returns a disposer.
 *
 * This exists because comments *are* the thread (invariant 4) and
 * nothing announced them. `announceRun` was the only emitter of
 * `items:changed`, and all thirteen of its call sites passed a
 * terminal run status — so from the moment a run started until it ended,
 * an open item froze no matter how much the agent wrote.
 *
 * A hook threaded through the supervisor would have covered only the ten
 * `postComment` calls inside it; the rest are in `roles/`, `jira/`,
 * `outbox/` and `archive/`. Hand-placed announcements are exactly the
 * bug class being fixed here, so this is one subscription covering every
 * writer, present and future.
 */
export function onCommentPosted(db: Db, listener: CommentListener): () => void {
  const existing = listeners.get(db) ?? new Set<CommentListener>();
  existing.add(listener);
  listeners.set(db, existing);

  return () => {
    existing.delete(listener);
  };
}

/**
 * Announces a written comment. Called by `postComment`, and nowhere
 * else.
 *
 * The repo publishes a domain fact — "a comment row exists" — and the
 * composition root decides that this means an IPC push. That is the same
 * shape as `onItemChanged` and `onRunChanged`, which are injected
 * options on the supervisor and mapped to pushes in `engine.ts`; the
 * only difference is where the subscription is registered.
 *
 * A listener that throws is logged and skipped. Telling the UI about a
 * comment must never be able to take down the thing that wrote it.
 */
export function notifyCommentPosted(db: Db, comment: Comment, context: CommentContext = { staysHere: false }): void {
  for (const listener of listeners.get(db) ?? []) {
    try {
      listener(comment, context);
    } catch (error) {
      console.error("[eo] a comment listener threw:", error);
    }
  }
}

/**
 * Somebody pinned a comment, or took the pin off (EO-324).
 *
 * A subscription of its own rather than a second `CommentContext` flag,
 * because it is a different event about an existing row: nothing was
 * said, and the thing that changed is one boolean. The one listener is
 * the outbound queue, which turns it into a command for the record —
 * without which a pin reaches one desktop and nowhere else, and an
 * agent on another machine reads a truncated thread with the important
 * part cut out of it (ARCHITECTURE.md, "What an agent is given").
 */
export interface PinnedComment {
  commentId: Uuid;
  itemId: Uuid;
  pinned: boolean;
}

export type PinListener = (pinned: PinnedComment) => void;

const pinListeners = new WeakMap<Db, Set<PinListener>>();

export function onCommentPinned(db: Db, listener: PinListener): () => void {
  const existing = pinListeners.get(db) ?? new Set<PinListener>();
  existing.add(listener);
  pinListeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

/** Announces a pin. Called by `setCommentPinned`, and nowhere else. */
export function notifyCommentPinned(db: Db, pinned: PinnedComment): void {
  for (const listener of pinListeners.get(db) ?? []) {
    try {
      listener(pinned);
    } catch (error) {
      console.error("[eo] a pin listener threw:", error);
    }
  }
}

/**
 * The same fact from the other direction: comments left an item's
 * thread.
 *
 * A separate subscription rather than a deleted row handed to
 * `onCommentPosted`, because the row is gone and a listener has no
 * business being given one. It carries the item, which is all any
 * subscriber uses — a thread changed, so whatever derives from it (the
 * project's `!`, the inbox, the dock badge) is stale.
 */
export function onCommentsRemoved(db: Db, listener: ThreadListener): () => void {
  const existing = removalListeners.get(db) ?? new Set<ThreadListener>();
  existing.add(listener);
  removalListeners.set(db, existing);

  return () => {
    existing.delete(listener);
  };
}

/** Announces removed comments. Called by `deleteComment`, and nowhere else. */
export function notifyCommentsRemoved(db: Db, itemId: Uuid): void {
  for (const listener of removalListeners.get(db) ?? []) {
    try {
      listener(itemId);
    } catch (error) {
      console.error("[eo] a comment-removal listener threw:", error);
    }
  }
}

/**
 * A mention that stopped waiting (EO-325).
 *
 * `PinnedComment`'s twin, and the same argument one step along: a
 * status is what the inbox and the `!` marker *are*, and until this
 * event nothing carried a change to one. A comment is serialised for
 * the record when it is *posted*, so an escalation went up open and
 * stayed open — answering it or dismissing it a minute later wrote one
 * local row and told nobody. The person then saw it answered on the
 * machine they were sitting at and still waiting on their other one,
 * and on their organisation's board.
 *
 * The three columns that identify the row, plus what it became. The
 * item comes along because a command is queued against one:
 * `record_commands.item_id` is how the queue knows what a command is
 * about.
 */
export interface SettledMention {
  commentId: Uuid;
  itemId: Uuid;
  targetType: "human" | "agent";
  targetId: string | null;
  status: string;
  /** The reply that resolved it, where a reply did. */
  addressedBy: string | null;
}

export type MentionListener = (settled: SettledMention) => void;

const mentionListeners = new WeakMap<Db, Set<MentionListener>>();

export function onMentionSettled(db: Db, listener: MentionListener): () => void {
  const existing = mentionListeners.get(db) ?? new Set<MentionListener>();
  existing.add(listener);
  mentionListeners.set(db, existing);
  return () => {
    existing.delete(listener);
  };
}

/**
 * Announces one.
 *
 * Called by the three functions that decide a mention is over —
 * answering, dismissing a thread's, dismissing one agent's — and
 * deliberately *not* by `settleMention`, which is the mirror writing
 * down what the record already decided. Announcing there would send the
 * record its own decision back, once per machine that pulled it.
 */
export function notifyMentionSettled(db: Db, settled: SettledMention): void {
  for (const listener of mentionListeners.get(db) ?? []) {
    try {
      listener(settled);
    } catch (error) {
      console.error("[eo] a mention listener threw:", error);
    }
  }
}
