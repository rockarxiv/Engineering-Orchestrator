import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./store.js";

/**
 * The `SecretStore` a headless server has instead of a keychain
 * (EO-320, `ARCHITECTURE.md`, "Secrets",
 * "The server").
 *
 * The original design says *"Secrets: OS keychain, never the DB"*, and a
 * desktop keeps that promise through `safeStorage`: the key lives in
 * the login keyring and EO never sees it. A Linux container has no
 * keyring, no login session and nobody to unlock one — which the review
 * named as new work rather than a detail. So the server keeps the
 * second half of the promise exactly (nothing goes in the database; the
 * ciphertext is the same `.bin` file beside it) and moves the first
 * half to the only place a headless host has: the operator's own
 * configuration. The key arrives in the environment or in a file they
 * mounted, and `serverKey.ts` is where that is read.
 *
 * **Every existing consumer works unchanged**, which is the point of
 * implementing `SecretStore` rather than inventing something: the Jira
 * token, a runtime's API key, a module's named secrets, an attached MCP
 * server's and the MCP host's bearer token each hand this a string and
 * write the `Buffer` back where they already wrote one.
 *
 * ### The format
 *
 * `EOSEC1` ‖ key id (4) ‖ IV (12) ‖ GCM tag (16) ‖ ciphertext.
 *
 * AES-256-GCM from Node's own `crypto` — no dependency, and the tag
 * means a value edited on disk is refused rather than decrypted into
 * something else. The magic is what makes a file on a volume
 * *identifiable* as one of these without opening it, which is how
 * rotation finds every value rather than being told a list of paths it
 * would fall behind (`rotateServerSecrets.ts`).
 *
 * The key id is a **label, not proof**. Four bytes of a
 * domain-separated hash of the key, they let a refusal say "this was
 * written under a different key" instead of "this did not decrypt",
 * which is the difference between an operator reaching for the right
 * key and reaching for a backup. Four bytes also collide — cheaply, and
 * on purpose if somebody chooses one of the keys — so nothing may
 * decide *which* key a value belongs to by reading them. Only the GCM
 * tag decides that, and `rotateServerSecrets.ts` says why it matters
 * there.
 *
 * Magic and key id are the cipher's additional data as well as the
 * file's header, so neither can be edited without the tag failing.
 */

/** The file header that says this is one of EO's server secrets, and which version of the format. */
const MAGIC = Buffer.from("EOSEC1", "ascii");

/** Four bytes is enough to tell two keys apart and far too few to attack one with. */
const KEY_ID_BYTES = 4;

/** 96 bits, which is the IV size GCM is defined for and the one Node's implementation is fastest on. */
const IV_BYTES = 12;

/** GCM's tag, in full. A truncated tag is a weaker forgery bound for no saving worth having. */
const TAG_BYTES = 16;

/** AES-256, so the key an operator configures is 32 bytes and nothing else. */
export const SERVER_SECRET_KEY_BYTES = 32;

const HEADER_BYTES = MAGIC.length + KEY_ID_BYTES;
const PREAMBLE_BYTES = HEADER_BYTES + IV_BYTES + TAG_BYTES;

/**
 * What this store calls its backend, for the one caller that asks.
 *
 * `mcpHost/token.ts` and `mcp/serverSecrets.ts` treat Electron's
 * `basic_text` as no keychain at all, because it encrypts with a
 * password compiled into Chromium. This is the opposite case and has to
 * be distinguishable from it: the key is the operator's, held nowhere
 * in this repository, and a value is exactly as safe as the way they
 * mounted it. So the name is EO's own rather than one of Chromium's.
 */
export const SERVER_SECRET_BACKEND = "eo_server_key";

/**
 * Four bytes that label a key without being usable as one.
 *
 * Domain-separated, so this is not the plain SHA-256 of the key that
 * something else might one day also compute. Truncated, because it is
 * written into every value and its only job is to make a refusal
 * specific.
 *
 * **Not an identity.** Two keys share these four bytes once in 2^32 by
 * chance and for about 65,000 tries of work on purpose, so a `true`
 * here means "probably the same key" and a `false` means "certainly
 * not". Code that needs the first of those as a fact has to decrypt.
 */
export function serverSecretKeyId(key: Buffer): Buffer {
  return createHash("sha256").update("eo-server-secret-key-id").update(key).digest().subarray(0, KEY_ID_BYTES);
}

/**
 * Whether these first bytes are EO's — the only question rotation asks
 * of a file before deciding whether to read the rest of it.
 */
export function hasServerSecretMagic(header: Buffer): boolean {
  return header.length >= MAGIC.length && header.subarray(0, MAGIC.length).equals(MAGIC);
}

/** How many bytes `hasServerSecretMagic` needs, so rotation need not read a whole volume to ask. */
export const SERVER_SECRET_PROBE_BYTES = MAGIC.length;

/** Whether this file is one of these at all: EO's magic, and enough bytes to hold a value. */
export function isServerSecret(contents: Buffer): boolean {
  return contents.length >= PREAMBLE_BYTES && hasServerSecretMagic(contents);
}

/**
 * Refuses anything that is not a 256-bit key, because silently
 * stretching one would be the same lie as generating one.
 */
function assertKey(key: Buffer): void {
  if (key.length !== SERVER_SECRET_KEY_BYTES) {
    throw new Error(`EO's server secret key must be ${String(SERVER_SECRET_KEY_BYTES)} bytes, and this one is ${String(key.length)}.`);
  }
}

export function createServerSecretStore(key: Buffer): SecretStore {
  assertKey(key);
  const keyId = serverSecretKeyId(key);
  const header = Buffer.concat([MAGIC, keyId]);

  return {
    // True, and it means what it says here: there is a key, it is this
    // process's, and every caller that refuses to write a secret without
    // one may now write it. What it does *not* claim is that the key is
    // safe from whoever can read the server's environment — that is the
    // operator's arrangement, and no answer here could change it.
    isEncryptionAvailable: () => true,

    getSelectedStorageBackend: () => SERVER_SECRET_BACKEND,

    encryptString(plainText: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      // The header is authenticated but not encrypted: it is how a file
      // is recognised, so it has to be readable, and binding it means a
      // value cannot be relabelled as another key's.
      cipher.setAAD(header);
      const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
    },

    decryptString(encrypted: Buffer): string {
      // Throws, the way `safeStorage.decryptString` throws, because that
      // is the contract every caller was written against: `readApiKey`,
      // `readSecretEntry` and the rest already catch it and treat an
      // unreadable value as absent rather than crashing a dispatch.
      if (!isServerSecret(encrypted)) {
        throw new Error("This is not one of EO's server secrets. It may have been written by a desktop, whose keychain this server does not have.");
      }
      const storedKeyId = encrypted.subarray(MAGIC.length, HEADER_BYTES);
      if (!timingSafeEqual(storedKeyId, keyId)) {
        throw new Error("This secret was written under a different key. Rotate the store, or restore the key it was written with.");
      }

      const iv = encrypted.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES);
      const tag = encrypted.subarray(HEADER_BYTES + IV_BYTES, PREAMBLE_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(encrypted.subarray(0, HEADER_BYTES));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted.subarray(PREAMBLE_BYTES)), decipher.final()]).toString("utf8");
    },
  };
}
