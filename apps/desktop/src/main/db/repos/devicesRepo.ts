import { desc, eq } from "drizzle-orm";
import { uuidv7, type DeviceView } from "@eo/core";
import type { Db } from "../client.js";
import { devices, people } from "../schema.js";

/**
 * The machines people have signed in from (EO-323,
 * the original design).
 *
 * "Each device holds its own token, revocable by the admin." This file
 * is both halves of that: the row a sign-in writes, and the lookup every
 * authenticated request makes.
 *
 * Nothing here ever returns a token. The server issues one at sign-in
 * and keeps `token_hash`; a device presents the token and this finds the
 * row by hashing what was presented. There is no code path back from a
 * row to the secret, which is the property that makes a copied database
 * a list rather than a keyring.
 */

/** What an authenticated request resolves to: who is asking, and from which machine. */
export interface DeviceIdentity {
  deviceId: string;
  personId: string;
  personName: string;
  isAdmin: boolean;
}

export interface IssueDeviceInput {
  personId: string;
  name: string;
  tokenHash: string;
  /**
   * The hash of this device's organisation-secrets key, or null
   * (EO-328, ARCHITECTURE.md, "Secrets").
   *
   * Null for a client that did not say it runs work, which is every
   * browser a server hands its renderer to — so the credential that
   * opens `ORGANISATION_SECRETS_PATH` is one no renderer is ever issued.
   * Written on every re-issue including the null, because signing in
   * from a browser as the same person on the same device row must *take
   * away* a key that row used to hold rather than leave it live.
   */
  secretsKeyHash: string | null;
  /**
   * The row to re-issue onto, when this machine has signed in before.
   *
   * Re-used rather than replaced so the admin's list does not grow a row
   * per sign-in — a person signing in again after a revocation would
   * otherwise leave a graveyard of revoked rows beside the live one.
   * Ignored when the id belongs to somebody else: a machine cannot prove
   * it is the one that held that row, and quietly moving a device
   * between people is worse than minting a second.
   */
  deviceId?: string;
}

/**
 * Records a sign-in, and returns the row as the admin will see it.
 *
 * The re-issue clears `revoked_at`, which is the point: revoking is
 * "this token stops working now", not "this machine is banned". A person
 * whose laptop was revoked because it was thought lost signs in again
 * with their password and it works — the credential that was taken away
 * was the token, and the token they had is gone.
 */
export function issueDevice(db: Db, input: IssueDeviceInput, at: number = Date.now()): DeviceView {
  const existing = input.deviceId === undefined ? undefined : db.select().from(devices).where(eq(devices.id, input.deviceId)).get();
  const reuse = existing !== undefined && existing.personId === input.personId;
  const id = reuse ? existing.id : (uuidv7() as string);

  if (reuse) {
    db.update(devices)
      .set({ name: input.name, tokenHash: input.tokenHash, secretsKeyHash: input.secretsKeyHash, lastSeenAt: at, revokedAt: null })
      .where(eq(devices.id, id))
      .run();
  } else {
    db.insert(devices)
      .values({
        id,
        personId: input.personId,
        name: input.name,
        tokenHash: input.tokenHash,
        secretsKeyHash: input.secretsKeyHash,
        createdAt: at,
        lastSeenAt: at,
        revokedAt: null,
      })
      .run();
  }

  const view = getDevice(db, id);
  if (view === undefined) throw new Error(`device ${id} vanished between its own write and its read`);
  return view;
}

export function getDevice(db: Db, id: string): DeviceView | undefined {
  const row = db
    .select({ device: devices, personName: people.name })
    .from(devices)
    .innerJoin(people, eq(people.id, devices.personId))
    .where(eq(devices.id, id))
    .get();
  return row === undefined ? undefined : toView(row.device, row.personName);
}

/**
 * The admin's list: newest first, revoked rows included.
 *
 * Included rather than filtered out because the list is a record of what
 * has held a key. "Anna's MacBook · revoked on Tuesday" is the answer to
 * the question an admin opens this screen with after a laptop goes
 * missing; a list that only shows what still works cannot answer it.
 */
export function listDevices(db: Db): DeviceView[] {
  return db
    .select({ device: devices, personName: people.name })
    .from(devices)
    .innerJoin(people, eq(people.id, devices.personId))
    .orderBy(desc(devices.createdAt))
    .all()
    .map((row) => toView(row.device, row.personName));
}

/**
 * Who is presenting this token hash, or nothing.
 *
 * Nothing covers both "no such device" and "revoked", and the caller
 * must not be able to tell them apart: they are one answer — 401 — and a
 * door that answered differently would be a way to learn which tokens
 * once existed.
 */
export function deviceByTokenHash(db: Db, tokenHash: string): DeviceIdentity | undefined {
  const row = db
    .select({ device: devices, personName: people.name, isAdmin: people.isAdmin })
    .from(devices)
    .innerJoin(people, eq(people.id, devices.personId))
    .where(eq(devices.tokenHash, tokenHash))
    .get();
  if (row === undefined || row.device.revokedAt !== null) return undefined;
  return { deviceId: row.device.id, personId: row.device.personId, personName: row.personName, isAdmin: row.isAdmin };
}

/**
 * Whether this is a live device's organisation-secrets key (EO-328,
 * ARCHITECTURE.md, "Secrets").
 *
 * Deliberately a yes-or-no rather than an identity. Nothing downstream
 * needs to know *which* device is collecting: the values an organisation
 * publishes are the same for every device it published them to, and a
 * caller resolved to a person would invite somebody to narrow the answer
 * per person later, which is not what the design says a policy is.
 *
 * A revoked row opens nothing, which is the same rule
 * `deviceByTokenHash` applies and the reason revoking a laptop is worth
 * doing: it stops the credentials, both of them, on the next request.
 *
 * The empty hash is refused before the query, because `secrets_key_hash`
 * is NULL on every row that has no key and a lookup for "" must not
 * become a lookup that could match one.
 */
export function deviceHoldsSecretsKey(db: Db, secretsKeyHash: string): boolean {
  if (secretsKeyHash.length === 0) return false;
  const row = db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.secretsKeyHash, secretsKeyHash)).get();
  return row !== undefined && row.revokedAt === null;
}

/**
 * Records that a device was heard from.
 *
 * Written on every authenticated request, which is why it is an
 * unconditional UPDATE of one indexed row and not a read-then-write: the
 * "last seen" column in the admin's list is the only thing that reads
 * it, and a second of resolution there is worth nothing.
 */
export function touchDevice(db: Db, deviceId: string, at: number = Date.now()): void {
  db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, deviceId)).run();
}

/**
 * Stops a device's token working, from now.
 *
 * Idempotent, and deliberately keeps the first revocation's time: an
 * admin pressing Revoke twice is one event, and the second press must
 * not rewrite when the organisation stopped trusting that machine.
 */
export function revokeDevice(db: Db, deviceId: string, at: number = Date.now()): DeviceView | undefined {
  const current = db.select().from(devices).where(eq(devices.id, deviceId)).get();
  if (current === undefined) return undefined;
  if (current.revokedAt === null) db.update(devices).set({ revokedAt: at }).where(eq(devices.id, deviceId)).run();
  return getDevice(db, deviceId);
}

function toView(row: typeof devices.$inferSelect, personName: string): DeviceView {
  return {
    id: row.id,
    personId: row.personId,
    personName,
    name: row.name,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}
