import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "../secrets/store.js";

/**
 * The bearer token an MCP client presents.
 *
 * Same arrangement the Jira token has, for the same reason (ARCHITECTURE.md,
 * "Secrets"): the key is the OS keychain's, the ciphertext is a file under
 * `userData`, and nothing about it reaches SQLite. `SecretStore` is
 * imported as a type only, so `safeStorage` still has exactly one import
 * site in this app.
 *
 * Why there is a token at all, on a socket bound to loopback: **loopback
 * is not a boundary.** Every process on this machine can reach
 * 127.0.0.1 — a web page's `fetch`, an npm postinstall script, anything
 * a browser extension asks for. The token is the difference between "I
 * connected Claude Desktop" and "anything running on this laptop can
 * delete my items".
 */
export interface TokenStoreOptions {
  /** `app.getPath("userData")/mcp` in production. */
  directory: string;
  store: SecretStore;
}

/**
 * Whether the keychain behind `safeStorage` is worth the name.
 *
 * `isEncryptionAvailable()` alone is not enough on Linux. With no
 * keyring running, Electron can select the `basic_text` backend, which
 * "encrypts" with a password compiled into Chromium — it still reports
 * available, and the ciphertext under `userData` is then recoverable by
 * any local process that cares to look. Since the whole point of the
 * token is that other local processes cannot have it, that backend is
 * treated as no keychain at all.
 *
 * The check is optional because `SecretStore` is EO's own narrowing of
 * `safeStorage` and the older callers do not expose the backend. A store
 * that cannot say which backend it uses is taken at its word.
 */
function keychainUsable(store: SecretStore): { ok: true } | { ok: false; reason: string } {
  if (!store.isEncryptionAvailable()) {
    return {
      ok: false,
      reason:
        "This machine has no OS keychain available, so EO cannot store the MCP server's token safely. " +
        "On Linux that usually means no keyring is running (gnome-keyring or kwallet).",
    };
  }

  if (store.getSelectedStorageBackend?.() === "basic_text") {
    return {
      ok: false,
      reason:
        "This machine's keychain is unlocked storage in disguise: Electron fell back to its `basic_text` backend, " +
        "which uses a fixed password, so anything running as you could read the token. Start a keyring " +
        "(gnome-keyring or kwallet) and enable the server again.",
    };
  }

  return { ok: true };
}

/** 32 bytes is 256 bits of entropy and 43 base64url characters — short enough to paste, long enough not to guess. */
const TOKEN_BYTES = 32;

function tokenFile(directory: string): string {
  return join(directory, "token.bin");
}

/**
 * A fresh credential, and no opinion about where it is kept.
 *
 * Split out because EO has a second listener whose token is never
 * written anywhere (EO-182): it is minted at start, held in a closure
 * for the life of the app, and handed to the one child process that
 * needs it through its environment. That server has no keychain
 * question to answer and no file to refuse to write, so it takes this
 * and not `mintToken` — while the entropy stays one number in one place.
 */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export type MintResult = { ok: true; token: string } | { ok: false; reason: string };

/**
 * Mints a token and forgets the previous one.
 *
 * Refuses rather than falling back to plaintext when there is no
 * keychain — writing a bearer token in the clear would quietly break the
 * promise this module exists to keep, and a server nobody can
 * authenticate to is better than one whose credential is lying on disk.
 */
export function mintToken(options: TokenStoreOptions): MintResult {
  const usable = keychainUsable(options.store);
  if (!usable.ok) return { ok: false, reason: usable.reason };

  const token = newToken();
  // 0o700 on the directory as well as 0o600 on the file: the file's mode
  // is what protects the ciphertext, and this only stops the directory
  // listing being world-readable, but it costs nothing.
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile(options.directory), options.store.encryptString(token), { mode: 0o600 });
  return { ok: true, token };
}

/** The token, or null when none has been minted. Unconfigured is a normal state, not an error. */
export function readTokenValue(options: TokenStoreOptions): string | null {
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(tokenFile(options.directory));
  } catch {
    return null;
  }

  try {
    return options.store.decryptString(encrypted);
  } catch {
    // Written by another machine, another OS user, or before a keychain
    // reset. Unreadable is the same as absent: the person regenerates.
    return null;
  }
}

/** The token, minting one if this is the first time the server has been enabled. */
export function ensureToken(options: TokenStoreOptions): MintResult {
  const existing = readTokenValue(options);
  if (existing !== null) return { ok: true, token: existing };
  return mintToken(options);
}

/**
 * Whether a presented credential is the token.
 *
 * Length is compared first because `timingSafeEqual` throws on a length
 * mismatch rather than returning false — and the length of a token that
 * is always 43 characters is not a secret worth protecting anyway.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
