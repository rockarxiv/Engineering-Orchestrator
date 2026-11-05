import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The three secrets the organisation's front door deals in, and what is
 * kept of each (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * A password, an invitation code and a device token. None of them is
 * stored as itself:
 *
 *  - a **password** is scrypt over a per-row salt, because it is the one
 *    secret a person chose and therefore the one a person reused
 *    somewhere else. A stolen `eo.db` must not be a list of working
 *    credentials for other people's services;
 *  - an **invitation code** is SHA-256, because it is high-entropy and
 *    EO minted it, so there is nothing to slow an attacker down for —
 *    but it is also sitting in somebody's mailbox, and the copy here
 *    must not be usable by whoever reads the file;
 *  - a **device token** is SHA-256 for the invitation's reason and one
 *    more: it is checked on *every* request, so the comparison has to be
 *    a hash lookup rather than a work factor. A token EO generated has
 *    256 bits in it; there is no dictionary to protect it from.
 *
 * `node:crypto` and nothing else. This is a headless server as often as
 * it is a desktop, so there is no keychain to lean on and no dependency
 * worth adding for what scrypt already is in the standard library
 * (ARCHITECTURE.md, "The stack": the stack is the argument for not adding to it).
 */

/** 32 bytes: 256 bits, and 43 characters of base64url — short enough to paste into a link. */
const SECRET_BYTES = 32;

/**
 * scrypt's cost, at Node's own default N and a memory bound that admits
 * it.
 *
 * `scryptSync` throws "memory limit exceeded" at the default `maxmem` of
 * 32 MiB for N=16384 r=8 p=1, which is the recipe every guide prints —
 * so the bound is raised here rather than the cost lowered. 64 MiB is
 * per call, and a sign-in is not a hot path: a person signs in once per
 * machine and the token carries every request after it.
 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const SCRYPT_KEY_BYTES = 64;

/** A fresh secret, in the form that goes in a URL and in an Authorization header. */
export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

/**
 * What is stored for a token or an invitation code.
 *
 * Unsalted on purpose: a salt defends against a precomputed table of
 * *guessable* inputs, and these are 256 random bits. What it would cost
 * is the thing that matters here — an authenticated request has to find
 * a device row *by* its token, which is an indexed lookup on this value
 * and a full scan on anything per-row.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Whether a presented secret matches a stored hash, in constant time.
 *
 * The comparison is constant-time even though both sides are hashes:
 * `===` on strings short-circuits at the first differing byte, and
 * while deriving anything from that is a stretch, "we compared a
 * credential with `===`" is not a sentence worth having to defend.
 */
export function secretMatches(presented: string, storedHash: string | null): boolean {
  if (storedHash === null || storedHash.length === 0) return false;
  const a = Buffer.from(hashSecret(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A password, as what is written to the row: `scrypt$<salt>$<key>`, both
 * halves base64url.
 *
 * The parameters are not in the string, which is a deliberate departure
 * from PHC-style encodings. EO has exactly one hash format and one
 * verifier, and a cost embedded per row is a promise to keep verifying
 * against costs nobody has used since — a migration to a stronger one is
 * a re-hash on next sign-in, which the prefix is enough to trigger.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Whether a password matches what was stored for it. False for a row that has none. */
export function passwordMatches(password: string, stored: string | null): boolean {
  if (stored === null) return false;
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) return false;

  const expected = Buffer.from(key, "base64url");
  let derived: Buffer;
  try {
    derived = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, SCRYPT_OPTIONS);
  } catch {
    // A stored hash this process cannot re-derive — a truncated row, a
    // length nobody writes — is "no", not a 500 on a sign-in screen.
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * How long an invitation link works for.
 *
 * A week, which is a person coming back from a holiday and still being
 * able to join, and is not a credential left in a mailbox for a year.
 * An admin re-invites to mint a fresh one, which also re-dates the row.
 */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
