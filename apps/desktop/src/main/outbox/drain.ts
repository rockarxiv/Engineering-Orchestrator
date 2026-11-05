import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { completePush, deferPush, duePushes, postComment, type OutboxChannel, type OutboxEntry } from "../db/repos/index.js";

/**
 * Sending what the outbox is holding (J-04, generalised in F-06).
 *
 * The policy lives here and the sending lives with whatever is being
 * sent to. Retry, ordering and giving up are one problem, worth getting
 * right once.
 *
 * Jira is the only channel that uses it. The forge was the other, until
 * EO-77 moved opening a pull request into its own step's run — a queue
 * can hold a retry, and only a run can report what happened, which is
 * the whole job of a step. What is left here is work nothing on the
 * board is waiting to hear about: a mirrored issue catching up.
 *
 * Runs on its own timer, apart from the dispatch tick: a slow server
 * must not slow down agents, and a busy agent must not delay something
 * someone is watching for.
 */

/** After this many failures a push is not going to work, and someone should be told. */
export const MAX_ATTEMPTS = 6;

/** 30s, 1m, 2m, 4m, 8m, 16m. A server that is down stays down for a while. */
function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** attempts, 16 * 60_000);
}

export interface SendOutcome {
  ok: boolean;
  /** True when retrying cannot help — the push is dropped instead of queued forever. */
  final?: boolean;
  /** Said on the item when dropping it would otherwise be invisible (invariant #8). */
  notify?: string;
  /**
   * How loudly. `note` is a remark in the thread; `escalation` carries a
   * human mention, so it raises `!` and reaches the inbox.
   *
   * The difference is whether anything else will ever tell the user. A
   * Jira that is behind is a nuisance they will notice, so it stays a
   * note. The case that needed an escalation was a pull request that
   * never opened — and that is a run's business now (EO-77), which is
   * where its failure is reported and where its comment is attached.
   */
  notifyKind?: "note" | "escalation";
  /**
   * The answers EO would accept, when the escalation is a question it
   * can name them for — offered as buttons on the comment. A send that
   * is merely reporting a failure names none.
   */
  notifyOptions?: string[];
  error: string;
}

/** What a channel needs to provide: how to send one entry, and what to call its entries. */
export interface ChannelSender {
  send(db: Db, entry: OutboxEntry): Promise<SendOutcome>;
  /** For the give-up comment: "a status change to Jira". */
  describe(entry: OutboxEntry): string;
  /**
   * What giving up means for this channel, said in the same comment.
   *
   * The consequence is the channel's own knowledge, and only the channel
   * can state it: a Jira left behind means the issue disagrees with EO
   * until somebody reconciles it, and affects nothing EO itself does.
   */
  gaveUpNote(entry: OutboxEntry): string;
  /** Called after the queue row reflects this attempt; used for live UI refreshes. */
  settled?: (entry: OutboxEntry) => void;
}

export interface DrainResult {
  sent: number;
  deferred: number;
  dropped: number;
  gaveUp: number;
}

const EMPTY: DrainResult = { sent: 0, deferred: 0, dropped: 0, gaveUp: 0 };

/**
 * Sends every due push on one channel, in order, and reports what happened.
 *
 * Order is per item **within a channel**: if an item's oldest push
 * fails, its newer ones wait rather than jumping the queue. Two comments
 * arriving backwards, or a status landing before the comment that
 * explains it, is worse than both arriving a minute late. Channels drain
 * independently so one server's outage cannot hold up another's — a
 * property kept rather than exercised, now that Jira is the only one.
 */
export async function drainChannel(db: Db, channel: OutboxChannel, sender: ChannelSender, now = Date.now()): Promise<DrainResult> {
  const result: DrainResult = { ...EMPTY };
  const blocked = new Set<string>();

  for (const entry of duePushes(db, channel, now)) {
    if (blocked.has(entry.itemId)) continue;

    const outcome = await sender.send(db, entry);

    if (outcome.ok) {
      completePush(db, entry.id);
      result.sent += 1;
      settled(sender, entry);
      continue;
    }

    if (outcome.final) {
      completePush(db, entry.id);
      result.dropped += 1;
      if (outcome.notify) note(db, entry.itemId, outcome.notify, outcome.notifyKind, outcome.notifyOptions);
      settled(sender, entry);
      continue;
    }

    blocked.add(entry.itemId);

    // Attachment actions represent durable file identity, including a
    // deletion whose local row is already gone. Dropping one would make
    // the two systems disagree permanently with no user action capable
    // of reconstructing the operation, so these retain the capped
    // backoff and keep retrying. Existing status/comment policy remains
    // bounded as before.
    const durableAttachment = entry.kind === "attachment_upload" || entry.kind === "attachment_delete";
    if (!durableAttachment && entry.attempts + 1 >= MAX_ATTEMPTS) {
      completePush(db, entry.id);
      result.gaveUp += 1;
      note(
        db,
        entry.itemId,
        `Gave up sending ${sender.describe(entry)} after ${MAX_ATTEMPTS} attempts: ${outcome.error}\n\n${sender.gaveUpNote(entry)}`,
        outcome.notifyKind,
      );
      settled(sender, entry);
      continue;
    }

    deferPush(db, entry.id, now + backoffMs(entry.attempts), outcome.error);
    result.deferred += 1;
    settled(sender, entry);
  }

  return result;
}

function settled(sender: ChannelSender, entry: OutboxEntry): void {
  try {
    sender.settled?.(entry);
  } catch (error) {
    console.error("[eo] an outbox settled listener threw:", error);
  }
}

/**
 * An engine comment, mentioning the human when the news is bad enough
 * that nothing else would tell them.
 *
 * `needsAttention` derives only from an open human mention (invariant
 * #6 — derived, never stored), so the mention is what makes an
 * escalation appear on the project and in the inbox. There is no separate
 * mechanism, and this is the reason not to add one.
 */
function note(db: Db, itemId: string, body: string, kind: SendOutcome["notifyKind"] = "note", options?: string[]): void {
  postComment(db, {
    itemId: itemId as Uuid,
    author: { type: "engine" },
    kind: kind === "escalation" ? "escalation" : "note",
    ...(kind === "escalation" ? { mentions: [{ type: "human" as const }] } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    body,
  });
}
