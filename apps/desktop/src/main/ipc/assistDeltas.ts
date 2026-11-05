import { createHash } from "node:crypto";
import type { DiscussionMessage, DiscussionView, IpcPushPayload } from "@eo/core";
import type { Db } from "../db/client.js";
import { emitPush, onPush } from "./push.js";

/**
 * An assistant chat's changes as numbered deltas (EO-553).
 *
 * Every comment in a chat used to reach a window as `items:changed`,
 * "ask again", and the window read the whole room again through
 * `assist:open` — once per message of a turn that posts several, each
 * one rebuilding the chat from its thread. Now the main process works out
 * what changed once and sends it as `assist:delta`: the messages that are
 * new or read differently, numbered one more than the last delta for that
 * chat. A window holding the view one before it writes them in; any
 * other window reads the room again, which is the backstop it always was.
 *
 * ### What a delta is worked out against
 *
 * The view the last delta was worked out from (or, before any, the first
 * view served — and a view served since, which publishes its own delta
 * first; see `assistDeltaSeq`), held as a digest per message, in order,
 * and the count of messages before them, rather than the messages:
 * a chat's newest hundred can be megabytes. Each `items:changed` naming
 * the chat builds the view `assist:open` would answer with now and sends
 * whatever differs. A window's base holds exactly the messages its
 * `deltaSeq` names, because a view is never served numbered as a delta it
 * has moved past — so the next delta holds everything the base lacks and
 * everything it holds that has since gone.
 *
 * ### What a delta does not carry
 *
 * The run working in the chat — whether it is thinking, its live turn —
 * is `runs:changed` and `runs:progress`'s, which re-read the room as they
 * did. What else is not a message — the chat's settings, its key, its
 * closing — is sent as `resync`: the window reads the room again. The
 * messages themselves always fit: a delta names every message the view
 * now carries, in order, and how many lie beyond them, so one that left
 * the view, moved, or changed outside it is said too. That is what lets a
 * window drop `items:changed` for its own chat once it holds a numbered
 * view: every one of them is followed by a delta, unless nothing a delta
 * could carry changed at all.
 *
 * ### Whose
 *
 * Only chats a view has been served for in this process
 * (`assistDeltaSeq`): a chat nobody has open costs nothing when its
 * thread moves. The numbers are kept for the life of the process, one per
 * chat ever served. They start again at 0 when it restarts, which a
 * window learns from its reconnection refetch (`PUSH_STREAM_REFETCH_EVENT`)
 * or by reloading with the process it talks to.
 */

/** What a delta is worked out against: the view the last one was. */
interface Snapshot {
  /** Everything a delta carries no field for, as one string. */
  head: string;
  /** Each message's digest, by id, in the view's order. */
  messages: Map<string, string>;
  earlier: number;
}

interface Deltas {
  /** The last delta sent, per chat; a chat is watched once it has one. */
  seq: Map<string, number>;
  /** The view each chat's last delta was worked out from; most recently used last. */
  snapshots: Map<string, Snapshot>;
}

/**
 * How many chats' snapshots are held. The numbers are kept for every
 * chat; a chat whose snapshot was let go sends `resync` on its next
 * change and is held again from there.
 */
export const ASSIST_DELTA_SNAPSHOTS = 200;

/** Per database, as `commentEvents.ts` keys its listeners: one test's chats are not another's. */
const byDb = new WeakMap<Db, Deltas>();

function deltasOf(db: Db): Deltas {
  let held = byDb.get(db);
  if (!held) byDb.set(db, (held = { seq: new Map(), snapshots: new Map() }));
  return held;
}

function digest(message: DiscussionMessage): string {
  return createHash("sha1").update(JSON.stringify(message)).digest("base64");
}

/** What of a view a delta has no field for: a change in it is a `resync`. The run's own fields are not here — see the file comment. */
function headOf(view: DiscussionView): string {
  return JSON.stringify([view.key, view.startedAt, view.closedAt, view.settings]);
}

function snapshotOf(view: DiscussionView): Snapshot {
  return { head: headOf(view), messages: new Map(view.messages.map((message) => [message.id, digest(message)])), earlier: view.earlier ?? 0 };
}

function keep(deltas: Deltas, conversationId: string, snapshot: Snapshot): void {
  deltas.snapshots.delete(conversationId);
  deltas.snapshots.set(conversationId, snapshot);
  while (deltas.snapshots.size > ASSIST_DELTA_SNAPSHOTS) deltas.snapshots.delete(deltas.snapshots.keys().next().value!);
}

/**
 * The number of the last delta a view about to be served already
 * includes, which is what it carries as `deltaSeq`. Serving the first
 * view of a chat is what starts its deltas, against that view.
 *
 * A view served later can be newer than the last delta: a comment
 * posted inside the coalescer's window has not been sent yet, or a run
 * moved a message's status. Numbered as that delta, it would claim a
 * state no number names — and if the change were then undone before the
 * sweep, the sweep would find nothing to send, and the window holding
 * this view would keep a message that is gone. So serving such a view
 * publishes the boundary first: what it holds beyond the last delta goes
 * out as the next delta, which brings every older window to the same
 * place, and this view carries that number. Every number then names one
 * state, and each delta is worked out from it.
 */
export function assistDeltaSeq(db: Db, view: DiscussionView): number {
  const deltas = deltasOf(db);
  if (!deltas.seq.has(view.id)) {
    deltas.seq.set(view.id, 0);
    keep(deltas, view.id, snapshotOf(view));
    return 0;
  }
  const boundary = nextAssistDelta(db, view);
  if (boundary) emitPush("assist:delta", boundary);
  return deltas.seq.get(view.id)!;
}

/** Whether a chat has been served a numbered view in this process. */
export function watchesAssistDeltas(db: Db, conversationId: string): boolean {
  return deltasOf(db).seq.has(conversationId);
}

/**
 * The next delta for a watched chat, given the view it has now, or null
 * when nothing a delta describes has changed — no number is spent on
 * nothing. Moves the chat on to that view.
 */
export function nextAssistDelta(db: Db, view: DiscussionView): IpcPushPayload<"assist:delta"> | null {
  const deltas = deltasOf(db);
  const last = deltas.seq.get(view.id);
  if (last === undefined) return null;
  const before = deltas.snapshots.get(view.id);
  const now = snapshotOf(view);
  keep(deltas, view.id, now);
  const delta = (messages: DiscussionMessage[], resync: boolean): IpcPushPayload<"assist:delta"> => {
    deltas.seq.set(view.id, last + 1);
    return { conversationId: view.id, seq: last + 1, messages, messageIds: [...now.messages.keys()], earlier: now.earlier, resync };
  };
  // Let go of while nobody was asking: what changed since is not known.
  if (!before) return delta([], true);
  if (now.head !== before.head) return delta([], true);

  // Each message whose digest moved — new, or reading differently. One
  // that left the view (slid out of the newest stretch, or out of the
  // thread) is said by `messageIds` not naming it; one older than the
  // stretch that changed, or went, by `earlier`. So nothing outside the
  // stretch can change without the delta saying so: what a window holds
  // beyond it is read back a page at a time, as it always was.
  const changed = view.messages.filter((message) => before.messages.get(message.id) !== now.messages.get(message.id));
  const sameIds = before.messages.size === now.messages.size && [...before.messages.keys()].every((id, index) => id === view.messages[index]?.id);
  if (changed.length === 0 && sameIds && before.earlier === now.earlier) return null;
  return delta(changed, false);
}

/**
 * Sends an `assist:delta` after every `items:changed` that names a
 * watched assistant chat. Returns a disposer.
 *
 * Hung on the push rather than on the comment, so that every writer
 * reaches it: a comment posted or taken back reaches it through the
 * engine's per-item coalescer (`changeAnnouncers.ts`, at most once per
 * window per chat and with a trailing sweep for the end of a burst), and
 * the handlers that change a chat in other ways — stop, settings,
 * withdraw, an attachment — through their own push. An item-less
 * `items:changed` names nothing, and every room re-reads on it anyway.
 *
 * `viewOf` is the view `assist:open` would answer with for that chat,
 * or null when it is not an assistant chat any more.
 */
export function watchAssistDeltas(db: Db, viewOf: (conversationId: string) => DiscussionView | null): () => void {
  return onPush("items:changed", ({ itemId }) => {
    if (itemId === undefined || !watchesAssistDeltas(db, itemId)) return;
    let view: DiscussionView | null;
    try {
      view = viewOf(itemId);
    } catch (error) {
      // A delta that could not be worked out is still a change the window
      // has to hear about: it drops `items:changed` for its own chat.
      console.error("[eo] could not work out an assistant chat's delta:", error);
      const deltas = deltasOf(db);
      const seq = (deltas.seq.get(itemId) ?? 0) + 1;
      deltas.seq.set(itemId, seq);
      deltas.snapshots.delete(itemId);
      emitPush("assist:delta", { conversationId: itemId, seq, messages: [], messageIds: [], earlier: 0, resync: true });
      return;
    }
    if (view === null) return;
    const delta = nextAssistDelta(db, view);
    if (delta) emitPush("assist:delta", delta);
  });
}
