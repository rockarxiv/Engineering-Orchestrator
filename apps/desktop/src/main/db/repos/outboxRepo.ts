import { and, asc, eq, lte } from "drizzle-orm";
import { uuidv7, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { outbox } from "../schema.js";

/**
 * The queue of things the outside world has not been told yet (J-04,
 * generalised in F-06).
 *
 * Deliberately in the repo layer rather than beside either client: an
 * entry has to be written in the same transaction as the transition or
 * comment that caused it, and that transaction belongs to the database,
 * not to the network. Nothing here talks to Jira or to a forge.
 */

/**
 * Who an entry is for. Ordering is guaranteed within one of these, not
 * across them.
 *
 * `jira` is the only one left. `forge` was here for the pull request,
 * which is opened inside its own step's run since EO-77 — a queue can
 * hold a retry, but only the run can report what happened, and reporting
 * it is the whole job of a step. The name stays because rows written by
 * an earlier build still carry it; nothing enqueues one.
 */
export type OutboxChannel = "jira" | "forge";

export type OutboxKind = "status" | "comment" | "branch" | "attachment_upload" | "attachment_delete";

export interface OutboxEntry {
  id: Uuid;
  itemId: Uuid;
  workspaceId: Uuid;
  channel: OutboxChannel;
  kind: OutboxKind;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

function toDomain(row: typeof outbox.$inferSelect): OutboxEntry {
  return {
    id: row.id as Uuid,
    itemId: row.itemId as Uuid,
    workspaceId: row.workspaceId as Uuid,
    channel: row.channel as OutboxChannel,
    kind: row.kind as OutboxKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

export interface EnqueueOutboxInput {
  itemId: Uuid;
  workspaceId: Uuid;
  channel: OutboxChannel;
  kind: OutboxKind;
  payload: Record<string, unknown>;
}

/**
 * Queues one push. Synchronous on purpose — every caller is inside the
 * transaction that made the change worth pushing.
 */
export function enqueueOutbox(db: Db, input: EnqueueOutboxInput): OutboxEntry {
  const now = Date.now();
  const row = db
    .insert(outbox)
    .values({
      id: uuidv7(),
      itemId: input.itemId,
      workspaceId: input.workspaceId,
      channel: input.channel,
      kind: input.kind,
      payload: input.payload,
      attempts: 0,
      // Due immediately; the drain runs on its own timer.
      nextAttemptAt: now,
      createdAt: now,
    })
    .returning()
    .get();
  return toDomain(row);
}

/**
 * What is due, oldest first.
 *
 * Order is the whole contract: two comments on one item must reach
 * Jira in the order they were written, and UUIDv7 ids give that for
 * free without a sequence column.
 */
export function duePushes(db: Db, channel: OutboxChannel, now: number, limit = 50): OutboxEntry[] {
  return db
    .select()
    .from(outbox)
    .where(and(eq(outbox.channel, channel), lte(outbox.nextAttemptAt, now)))
    .orderBy(asc(outbox.id))
    .limit(limit)
    .all()
    .map(toDomain);
}

/** Everything still queued for an item, in order — used to keep an item's pushes sequential. */
export function pendingPushesForItem(db: Db, itemId: Uuid, channel?: OutboxChannel): OutboxEntry[] {
  const scope = channel ? and(eq(outbox.itemId, itemId), eq(outbox.channel, channel)) : eq(outbox.itemId, itemId);
  return db.select().from(outbox).where(scope).orderBy(asc(outbox.id)).all().map(toDomain);
}

/** It landed. */
export function completePush(db: Db, id: Uuid): void {
  db.delete(outbox).where(eq(outbox.id, id)).run();
}

/** It failed; try again later, and remember why in case it never works. */
export function deferPush(db: Db, id: Uuid, nextAttemptAt: number, error: string): void {
  const current = db.select().from(outbox).where(eq(outbox.id, id)).get();
  if (!current) return;
  db.update(outbox)
    .set({ attempts: current.attempts + 1, nextAttemptAt, lastError: error })
    .where(eq(outbox.id, id))
    .run();
}

/**
 * Nothing left to send for this repository on one channel.
 *
 * The channel is required, not optional: disconnecting Jira must not
 * silently delete a pending pull request.
 */
export function discardPushesForProject(db: Db, workspaceId: Uuid, channel: OutboxChannel): number {
  const scope = and(eq(outbox.workspaceId, workspaceId), eq(outbox.channel, channel));
  const rows = db.select().from(outbox).where(scope).all();
  db.delete(outbox).where(scope).run();
  return rows.length;
}

/** How many pushes are waiting, and how many have failed at least once — for the Settings panel. */
export function outboxDepth(db: Db, workspaceId: Uuid, channel: OutboxChannel): { pending: number; failing: number } {
  const rows = db
    .select()
    .from(outbox)
    .where(and(eq(outbox.workspaceId, workspaceId), eq(outbox.channel, channel)))
    .all();
  return { pending: rows.length, failing: rows.filter((row) => row.attempts > 0).length };
}
