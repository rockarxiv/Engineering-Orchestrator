import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WEBHOOK_SIGNATURE_PREFIX, webhookSigningString } from "@eo/core";

/**
 * The signature on a webhook delivery (EO-332,
 * the original design).
 *
 * "Webhooks are signed, with replay protection and a rate limit" is
 * the design's sentence, and this is the first third of it. The scheme is in
 * `@eo/core` — the header names, the string that is signed, the window a
 * timestamp is accepted in — because both ends have to agree on it and
 * the Job page has to tell a person what to configure. The computation
 * is here because `node:crypto` is a main-process thing: a renderer has
 * only `crypto.subtle`, which is asynchronous, and this door verifies
 * inside a request.
 *
 * HMAC-SHA256 rather than a bare hash of secret-and-body, because a hash
 * over a concatenation is length-extendable and HMAC is the construction
 * that exists so nobody has to think about that again.
 */

/** What EO signs a delivery with — `sha256=<hex>`, the shape every sender already writes. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `${WEBHOOK_SIGNATURE_PREFIX}${createHmac("sha256", secret).update(webhookSigningString(timestamp, rawBody)).digest("hex")}`;
}

/**
 * Whether the presented signature is the one this body deserves.
 *
 * Constant time, for `matchesToken`'s reason and rather more sharply:
 * unlike a token, a signature is something an attacker may compute
 * candidates for at will, so a comparison that returned early would hand
 * them the answer one byte at a time. The length is checked first
 * because `timingSafeEqual` throws on a mismatch — which would otherwise
 * turn "the wrong length" into a 500 and into a measurably different
 * answer from "the wrong signature".
 */
export function webhookSignatureMatches(secret: string, timestamp: number, rawBody: string, presented: string): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const offered = Buffer.from(presented);
  if (expected.length !== offered.length) return false;
  return timingSafeEqual(expected, offered);
}

/**
 * A new signing secret.
 *
 * Thirty-two bytes of `randomBytes` as hex, so sixty-four characters —
 * comfortably past `WEBHOOK_SECRET_MIN_LENGTH`, and hex rather than
 * base64 because it is a string a person copies into somebody else's
 * configuration screen and `+/=` are the characters that get mangled on
 * the way.
 *
 * Here rather than on the Job page that will offer the button, because
 * the page is the next story and a secret minted in a renderer would be
 * a key chosen by the half of the app that does not verify with it.
 * Its callers today are this phase's tests; the original design's "URL and secret" is
 * what calls it next.
 */
export function mintWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The event key for a body nothing declared one for: a hash of exactly
 * what arrived.
 *
 * Plain SHA-256 and not an HMAC, because this is an identifier rather
 * than an authentication — the thing it has to do is be the same string
 * for two identical bodies, which is what makes a sender's retry
 * recognisable as the same event.
 */
export function hashWebhookBody(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
