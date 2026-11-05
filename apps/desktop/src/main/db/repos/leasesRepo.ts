import { and, eq, gt, lte, notInArray, sql } from "drizzle-orm";
import type { Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { dispatchLeases } from "../schema.js";

/**
 * A device's claim on dispatching one item, with a time limit (EO-322,
 * `ARCHITECTURE.md`, "The record").
 *
 * The rows of `dispatch_leases`, and nothing else: granting one is a
 * fact about the database, so it lives here beside every other one, and
 * what a *lease* means — when it is granted, what happens when it
 * expires, who is told — is the record's, in `record/localRecord.ts`.
 */
export interface DispatchLease {
  itemId: Uuid;
  deviceId: string;
  grantedAt: number;
  expiresAt: number;
}

function toDomain(row: typeof dispatchLeases.$inferSelect): DispatchLease {
  return {
    itemId: row.itemId as Uuid,
    deviceId: row.deviceId,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
  };
}

export interface GrantLeaseInput {
  itemId: Uuid;
  deviceId: string;
  /** Now, as the caller reckons it — the record's clock, so a test can hold it still. */
  now: number;
  /** How long the claim stands without being renewed. */
  ttlMs: number;
}

/**
 * Claim the item for this device, or refuse because somebody else's
 * claim still stands.
 *
 * One statement rather than a read and a write, so two devices cannot
 * interleave between them: the insert lands on the empty row, and the
 * `where` on the update is the whole of the exclusion — a lease is
 * takeable when it is this device's own (a renewal) or when it has
 * expired (its holder stopped saying it was still working).
 *
 * `<=` rather than `<`, here and in every other comparison against
 * `expires_at` in this file. `expiresAt` is when the claim *stops*
 * standing, not the last instant it does, and a boundary spelled two
 * ways is a millisecond in which one function calls a lease live and
 * another calls it dead. Which of the two it is matters least; that
 * they agree matters a great deal, because the sweep that releases an
 * expired lease and the renewal that would keep it are looking at the
 * same number.
 *
 * Refusing is not an event. A device that could not claim an item has
 * written nothing and moved nothing, and the next tick offers the same
 * item again — exactly as the in-process item lock has always behaved.
 * The one thing that *is* said out loud is an expiry, and the record
 * says it (invariant #8).
 */
export function grantLease(db: Db, input: GrantLeaseInput): DispatchLease | null {
  const row = db
    .insert(dispatchLeases)
    .values({
      itemId: input.itemId,
      deviceId: input.deviceId,
      grantedAt: input.now,
      expiresAt: input.now + input.ttlMs,
    })
    .onConflictDoUpdate({
      target: dispatchLeases.itemId,
      set: { deviceId: input.deviceId, grantedAt: input.now, expiresAt: input.now + input.ttlMs },
      // Written out rather than composed with `or`, which answers
      // `SQL | undefined` and would need an assertion to satisfy a
      // parameter that is never optional here.
      setWhere: sql`${dispatchLeases.deviceId} = ${input.deviceId} or ${dispatchLeases.expiresAt} <= ${input.now}`,
    })
    .returning()
    .get();
  return row === undefined ? null : toDomain(row);
}

/**
 * Push this device's claim out again, for as long as it is still
 * working — and only while the claim is still standing.
 *
 * Distinct from granting, and the difference is what it will not do: it
 * never takes a lease, neither one this device does not hold nor one it
 * held until the deadline passed. A renewal that could claim is a
 * device that, having lost its lease to an expiry and had the item
 * handed to somebody else, quietly takes it back.
 *
 * The expiry check is the half that makes the sweep authoritative
 * rather than advisory. A device renews on every tick and ticks are
 * seconds apart, so a claim can only reach its deadline if this process
 * was not running: a laptop asleep, a machine suspended, an event loop
 * blocked for longer than the whole term. In every one of those the
 * honest thing to say is that the claim lapsed — the device was *not*
 * still working, whatever it believes on waking — and the first tick
 * back must release it and say so (invariant #8) rather than revive it
 * and leave an item claimed by a process that has no idea what it
 * missed. Without this, waking up is indistinguishable from never
 * having stopped, and the comment the expiry owes a person is never
 * posted.
 *
 * `null` is what tells the caller its claim is gone. `renewClaims`
 * forgets the lease on that answer, which is what leaves the row for
 * the record's tick to release.
 */
export function renewLease(db: Db, input: GrantLeaseInput): DispatchLease | null {
  const row = db
    .update(dispatchLeases)
    .set({ expiresAt: input.now + input.ttlMs })
    .where(
      and(
        eq(dispatchLeases.itemId, input.itemId),
        eq(dispatchLeases.deviceId, input.deviceId),
        gt(dispatchLeases.expiresAt, input.now),
      ),
    )
    .returning()
    .get();
  return row === undefined ? null : toDomain(row);
}

/**
 * Give the item back, if this device is the one holding it.
 *
 * The device id is part of the condition for the item lock's reason: a
 * release that arrives late — after the lease expired and the item was
 * claimed by somebody else — must not take the item away from its new
 * holder.
 */
export function releaseLease(db: Db, itemId: Uuid, deviceId: string): boolean {
  const row = db
    .delete(dispatchLeases)
    .where(and(eq(dispatchLeases.itemId, itemId), eq(dispatchLeases.deviceId, deviceId)))
    .returning()
    .get();
  return row !== undefined;
}

/**
 * The claims this device holds that nothing in this process is working
 * under — what an earlier run of it left behind.
 *
 * `stillHeld` is the exclusion and it is not an optimisation: the
 * caller is a live process, and it may be asking this question while
 * one of its own dispatches is mid-flight. A device that handed back
 * every row with its name on it would drop the claim covering work it
 * is still doing, and another machine could then start the same item
 * underneath it. So what is released is the difference between what the
 * database says this device holds and what the device says it is
 * actually doing; at boot the second of those is empty and the answer is
 * everything, which is the case this exists for.
 */
export function releaseDeviceLeases(db: Db, deviceId: string, stillHeld: Iterable<Uuid> = []): DispatchLease[] {
  const keep = [...stillHeld];
  return db
    .delete(dispatchLeases)
    .where(
      keep.length === 0
        ? eq(dispatchLeases.deviceId, deviceId)
        : and(eq(dispatchLeases.deviceId, deviceId), notInArray(dispatchLeases.itemId, keep)),
    )
    .returning()
    .all()
    .map(toDomain);
}

/** The claim standing on this item, expired or not. */
export function leaseFor(db: Db, itemId: Uuid): DispatchLease | null {
  const row = db.select().from(dispatchLeases).where(eq(dispatchLeases.itemId, itemId)).get();
  return row === undefined ? null : toDomain(row);
}

/** Every claim, expired or not. */
export function listLeases(db: Db): DispatchLease[] {
  return db.select().from(dispatchLeases).all().map(toDomain);
}

/**
 * The claims whose holder has stopped saying it is still working.
 *
 * `lte`, so a claim is expired *at* its deadline rather than a
 * millisecond after it — the same boundary `grantLease` and the
 * record's own pick read, for the reason argued above `grantLease`.
 */
export function listExpiredLeases(db: Db, now: number): DispatchLease[] {
  return db.select().from(dispatchLeases).where(lte(dispatchLeases.expiresAt, now)).all().map(toDomain);
}
