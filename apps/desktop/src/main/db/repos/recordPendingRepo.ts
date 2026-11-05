import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { recordPending } from "../schema.js";

/**
 * What this device has been told and cannot write down yet (EO-324,
 * `ARCHITECTURE.md`, "The record").
 *
 * The rows of `record_pending` and nothing else. *Why* a row is here —
 * a run whose row is on the next page, a file whose bytes have not come
 * down — is `record/drain.ts`'s, which is the only thing that writes or
 * reads them.
 *
 * Ordered by id everywhere, which is `<kind>:<natural key>`: within a
 * kind that is the order the rows were minted in, and across kinds the
 * order is arbitrary and does not matter, because every retry is
 * independent of every other.
 */

export type PendingKind =
  | "agent"
  | "agentTools"
  | "runAgent"
  | "item"
  | "run"
  | "transition"
  | "comment"
  | "pin"
  | "mention"
  | "runEvents"
  | "attachment"
  | "watch"
  | "memory";

export interface PendingRow<T = unknown> {
  id: string;
  kind: PendingKind;
  payload: T;
  /** What it is waiting for, in words — for a log line, and for whoever reads this table. */
  waitingFor: string;
  createdAt: number;
  attempts: number;
}

/**
 * Remembers something that could not be placed.
 *
 * Idempotent by id, which is what makes it safe to call on every pass:
 * a cursor deliberately re-reads its own boundary, so the same
 * unplaceable row arrives again and again until its prerequisite shows
 * up. `attempts` counts how many times it has been tried, and is the
 * only field a second arrival changes — the payload is the same payload.
 */
export function remember<T>(db: Db, kind: PendingKind, key: string, payload: T, waitingFor: string, now: number): void {
  db.insert(recordPending)
    .values({ id: `${kind}:${key}`, kind, payload, waitingFor, createdAt: now, attempts: 0 })
    .onConflictDoNothing()
    .run();
}

/**
 * Remembers something that could not be placed, keeping the newest copy
 * (EO-476).
 *
 * `remember`'s twin for a row whose payload changes while it waits: a
 * record-held project's agent, held until the agents section is
 * published, is edited on the record in the meantime, and what has to be
 * written when the wait ends is the agent as it is *then* — not as it
 * was the first time it could not be. The same id, so a later copy
 * replaces an earlier one rather than standing beside it.
 */
export function rememberLatest<T>(db: Db, kind: PendingKind, key: string, payload: T, waitingFor: string, now: number): void {
  db.insert(recordPending)
    .values({ id: `${kind}:${key}`, kind, payload, waitingFor, createdAt: now, attempts: 0 })
    .onConflictDoUpdate({ target: recordPending.id, set: { payload, waitingFor } })
    .run();
}

/**
 * The rows of one kind whose key starts with this, oldest first
 * (EO-476).
 *
 * For a kind keyed `<prerequisite>:<row>`, which is settled by the
 * prerequisite arriving rather than by being retried: the rows waiting
 * on one agent are read when that agent lands. A range over the primary
 * key rather than a `LIKE`, so nothing in a key is read as a pattern.
 */
export function pendingWithKeyPrefix<T>(db: Db, kind: PendingKind, keyPrefix: string): PendingRow<T>[] {
  const from = `${kind}:${keyPrefix}`;
  return db
    .select()
    .from(recordPending)
    .where(and(eq(recordPending.kind, kind), gte(recordPending.id, from), lt(recordPending.id, `${from}\uffff`)))
    .orderBy(asc(recordPending.id))
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind as PendingKind,
      payload: row.payload as T,
      waitingFor: row.waitingFor,
      createdAt: row.createdAt,
      attempts: row.attempts,
    }));
}

/**
 * The things waiting, least tried first, and oldest first among those.
 *
 * Bounded, because a device joining an organisation with a long history
 * can have a great many of these at once and a tick that tried every
 * one would be a tick that never ended. What it does not finish, the
 * next pass continues: nothing is lost by stopping, which is the whole
 * point of the row being durable.
 *
 * Least tried first, and that is what makes the bound fair (EO-476). A
 * row can wait on something that may never come — an agent's server
 * that no policy publishes — and ordered by id alone the first two
 * hundred of those would be the whole of every pass, and a row behind
 * them whose prerequisite has long since landed would never be tried.
 * Every failed try adds one to `attempts`, so what has been tried least
 * comes round next, and every row is reached within a few passes of
 * however many there are.
 */
export function pending<T>(db: Db, kind: PendingKind, limit = 200): PendingRow<T>[] {
  return db
    .select()
    .from(recordPending)
    .where(eq(recordPending.kind, kind))
    .orderBy(asc(recordPending.attempts), asc(recordPending.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind as PendingKind,
      payload: row.payload as T,
      waitingFor: row.waitingFor,
      createdAt: row.createdAt,
      attempts: row.attempts,
    }));
}

/** Takes rows off, because they have been written down at last. */
export function settled(db: Db, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.delete(recordPending).where(inArray(recordPending.id, [...ids])).run();
}

/**
 * Records that a retry did not work either.
 *
 * Nothing is ever dropped for having been tried too often. A row here
 * is something the record has said and this device has not managed to
 * keep, and giving up on it would be losing exactly what the table
 * exists to hold. The count is what lets a person — or a log line — see
 * that something has been waiting a long time.
 */
export function triedAgain(db: Db, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.update(recordPending)
    .set({ attempts: sql`${recordPending.attempts} + 1` })
    .where(inArray(recordPending.id, [...ids]))
    .run();
}

/** How much this device is holding but has not placed. For the tests, and for a log line. */
export function pendingCount(db: Db, kind?: PendingKind): number {
  const query = db.select({ n: sql<number>`count(*)` }).from(recordPending);
  const row = kind === undefined ? query.get() : query.where(eq(recordPending.kind, kind)).get();
  return row?.n ?? 0;
}
