import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpKeychainStatus } from "@eo/core";
import type { SecretStore } from "../secrets/store.js";

/**
 * The values behind the environment-variable names a catalogued MCP
 * server declares (EO-104).
 *
 * A server row holds names; this holds what is behind them. The key is
 * the OS keychain's, the ciphertext is a file under `userData`, and
 * nothing about a value reaches SQLite — the design, and the same
 * arrangement the Jira token, the MCP host's bearer token and a module's
 * secrets already have. A value goes in over IPC and comes back out on
 * one channel only: `mcpServers:revealSecret`, which reads
 * `readMcpServerSecretEntry` when the person presses Reveal on the
 * desktop (EO-489, ARCHITECTURE.md §14.2). It is the machine half, so a
 * server refuses it and no eo_admin tool is built on it.
 *
 * **A sibling of `modules/secrets.ts` rather than a generalisation of
 * it, deliberately.** That module's shape is not incidental: a secret
 * there is *shared with a per-step override*, and `environmentFor`'s
 * rules about which wins, and about an unreadable override stopping the
 * fallback rather than passing it, are the module secrets' whole
 * reason for existing. A server has no such pair — its variables belong
 * to it, one value each — so generalising would have meant making the
 * fallback optional, which is making the interesting half of that module
 * a flag, and then two callers depending on a branch neither of them
 * reads. It also scopes by *step id*, hashing the id because a step id is
 * whatever created the step; a server id is a UUIDv7 EO minted, so it
 * can be checked instead and left legible on disk.
 *
 * What is shared is `SecretStore`, imported as a type only, so
 * `safeStorage` still has exactly one import site in this app.
 */
export interface McpServerSecretsOptions {
  /** `app.getPath("userData")/mcp-server-secrets` in production. */
  directory: string;
  store: SecretStore;
}

const PREFIX = "secret-";
const SUFFIX = ".bin";

/**
 * Whether the keychain behind `safeStorage` is worth the name, and what
 * to say when it is not.
 *
 * `isEncryptionAvailable()` alone is not enough on Linux: with no
 * keyring running, Electron can select the `basic_text` backend, which
 * "encrypts" with a password compiled into Chromium and still reports
 * itself available. The ciphertext under `userData` is then recoverable
 * by anything running as the person. `mcpHost/token.ts` refuses to mint
 * a bearer token on that backend for exactly this reason, and a
 * third-party API token — someone's GitHub PAT, their Linear key — is
 * worth the same care: EO asked for it, so EO owes them the storage it
 * implied.
 *
 * The backend is reported either way, weak or not, because "EO will not
 * store this" is only actionable if it says what it means.
 *
 * `getSelectedStorageBackend` is optional on `SecretStore` — it is newer
 * than the interface — and a store that cannot say which backend it uses
 * is taken at its word.
 */
export function mcpKeychainStatus(store: SecretStore): McpKeychainStatus {
  const backend = store.getSelectedStorageBackend?.() ?? null;

  if (!store.isEncryptionAvailable()) {
    return {
      available: false,
      backend,
      weak: false,
      warning:
        "This machine has no OS keychain available, so EO cannot hold an MCP server's secrets safely. " +
        "On Linux that usually means no keyring is running (gnome-keyring or kwallet).",
    };
  }

  if (backend === "basic_text") {
    return {
      available: true,
      backend,
      weak: true,
      warning:
        "This machine's keychain is unlocked storage in disguise: Electron fell back to its `basic_text` backend, " +
        "which uses a fixed password, so anything running as you could read an MCP server's token. Start a keyring " +
        "(gnome-keyring or kwallet) and set the value again.",
    };
  }

  return { available: true, backend, weak: false, warning: null };
}

/**
 * One directory per server, so removing one server's values cannot
 * disturb another's, and listing one stays a readdir.
 *
 * The id is checked rather than hashed. It is a UUIDv7 EO generated, so
 * unlike a step id there is a shape to hold it to — and a legible
 * directory is worth having when somebody is looking at `userData`
 * wondering what is in it. Anything that is not an id is refused by
 * throwing, as `jira/credentials.ts` does: it can only be a programmer
 * error, since every id here came out of `mcp_servers.id`.
 */
function directoryFor(options: McpServerSecretsOptions, serverId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(serverId)) throw new Error(`refusing to build a secret path from ${JSON.stringify(serverId)}`);
  return join(options.directory, serverId);
}

/**
 * A secret's name is part of a path, so it is checked rather than
 * escaped — the same rule `modules/secrets.ts` applies, and the same
 * shape `McpServerDraftSchema` holds a declared name to, so a name a
 * person typed is refused where they can see it and this throw stays
 * unreachable from outside.
 */
function fileFor(directory: string, name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`refusing to build a secret path from ${JSON.stringify(name)}`);
  return join(directory, `${PREFIX}${name}${SUFFIX}`);
}

export type StoreMcpSecretResult = { ok: true } | { ok: false; reason: string };

/**
 * Stores one value for one server.
 *
 * Refuses rather than falling back to plaintext, on a missing keychain
 * and on a weak one alike. Writing in the clear would quietly break the
 * one promise this module exists to keep, and a value nobody can use is
 * better than a value lying readable on disk under a screen that says it
 * is safe.
 *
 * **A failure is reported, never rethrown, and nothing it said is
 * repeated.** These are the two steps in this module that hold the value
 * itself: `encryptString` is handed it outright and the write is handed
 * its ciphertext, so an exception out of either is the one failure here
 * that could be carrying a secret — a keychain binding that quotes what
 * it was given, an error from a machine EO cannot write to.
 * `handleIpcRequest` stringifies a throw into the IPC envelope when
 * `exposeErrorDetails` is on, and the MCP host dispatches through
 * exactly that envelope, so a rethrow from here is a token in a client's
 * transcript — which is what `mcpServers:setSecret` being offered as a
 * tool (EO-115) made reachable from outside this machine. Both are
 * caught and answered with a sentence written below instead, and the
 * error itself is dropped rather than logged or wrapped: which of the
 * two steps failed is the diagnosis worth keeping, and it is the half
 * that cannot be quoting a value.
 *
 * The paths are built above the first `try` deliberately, for the reason
 * `readMcpServerSecretEntry` gives about its own: an id or a name that
 * cannot be a path is a programmer error — both shapes are held at the
 * boundary — and swallowing that throw would report a refused path as a
 * keychain that failed.
 */
export function storeMcpServerSecret(options: McpServerSecretsOptions, serverId: string, name: string, value: string): StoreMcpSecretResult {
  const keychain = mcpKeychainStatus(options.store);
  if (!keychain.available || keychain.weak) return { ok: false, reason: keychain.warning ?? "This machine has no keychain EO can use." };

  const directory = directoryFor(options, serverId);
  const path = fileFor(directory, name);

  let encrypted: Buffer;
  try {
    encrypted = options.store.encryptString(value);
  } catch {
    return {
      ok: false,
      reason:
        "This machine's keychain refused to encrypt that value, so nothing was stored. That usually means the " +
        "keyring has locked or gone away since EO started — unlock it, or restart EO, and set the value again.",
    };
  }

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, encrypted, { mode: 0o600 });
  } catch {
    return {
      ok: false,
      reason:
        "EO encrypted that value but could not write it to its own storage on this machine, so nothing was " +
        "stored. Check that EO's data directory is writable and has space, and set the value again.",
    };
  }

  return { ok: true };
}

/**
 * What is behind a name, for one server.
 *
 * "Unreadable" is a third answer rather than a kind of absent, as it is
 * in `modules/secrets.ts`: the file is there, and it was written by
 * another machine or before a keychain reset. Whoever comes to resolve
 * these at spawn (EO-106) needs to be able to tell "you never set this"
 * from "EO can no longer read what you set", because only one of those
 * is fixed by typing it again.
 */
export type McpSecretRead = { state: "value"; value: string } | { state: "absent" } | { state: "unreadable" };

export function readMcpServerSecretEntry(options: McpServerSecretsOptions, serverId: string, name: string): McpSecretRead {
  // Outside the try, deliberately: the catch below means "no such file",
  // which is an ordinary answer, while a name that is not a name is a
  // programmer error and swallowing it would report a refused path as an
  // unset secret.
  const path = fileFor(directoryFor(options, serverId), name);

  let encrypted: Buffer;
  try {
    encrypted = readFileSync(path);
  } catch {
    return { state: "absent" };
  }
  try {
    return { state: "value", value: options.store.decryptString(encrypted) };
  } catch {
    return { state: "unreadable" };
  }
}

/** The value, or null for either kind of nothing. */
export function readMcpServerSecret(options: McpServerSecretsOptions, serverId: string, name: string): string | null {
  const read = readMcpServerSecretEntry(options, serverId, name);
  return read.state === "value" ? read.value : null;
}

/**
 * Which of a server's secrets are set, by name only.
 *
 * Names, never values: this is what a screen renders beside a field and
 * what `McpServerView.secretsSet` carries — and so what `mcp_servers_list`
 * tells a client — and none of them has any business seeing the value.
 *
 * A file that no longer decrypts is not listed, for the reason
 * `listSecretNames` gives: "set" means a dispatch would get a value, and
 * a name that cannot be read is one a dispatch will refuse — listing it
 * would have the screen promise something the engine then declines to
 * do.
 */
export function listMcpServerSecretNames(options: McpServerSecretsOptions, serverId: string): string[] {
  return storedNames(options, serverId).filter((name) => readMcpServerSecretEntry(options, serverId, name).state === "value");
}

/**
 * Which of a server's stored values can no longer be decrypted, by name
 * only (EO-489).
 *
 * The other half of what `listMcpServerSecretNames` leaves out. Those
 * names are not "set" — a spawn will not get a value — but something is
 * stored under each, and a screen that drew them as "Not set" would hide
 * why a value the person saved is not arriving.
 */
export function listMcpServerUnreadableNames(options: McpServerSecretsOptions, serverId: string): string[] {
  return storedNames(options, serverId).filter((name) => readMcpServerSecretEntry(options, serverId, name).state === "unreadable");
}

/** Every name with a value file for this server, readable or not. */
function storedNames(options: McpServerSecretsOptions, serverId: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directoryFor(options, serverId));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.startsWith(PREFIX) && entry.endsWith(SUFFIX))
    .map((entry) => entry.slice(PREFIX.length, entry.length - SUFFIX.length))
    // A file somebody dropped here under a name that is not one would
    // throw in `fileFor`; it is not an entry, so it is not listed.
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
}

export function clearMcpServerSecret(options: McpServerSecretsOptions, serverId: string, name: string): void {
  rmSync(fileFor(directoryFor(options, serverId), name), { force: true });
}

/**
 * Forgets everything one server held.
 *
 * Not called by archiving, and that is the decision rather than an
 * omission: an archived row is still there, still listable, and still
 * what an old attachment points at, so its values are still reachable
 * and still wanted if it comes back. This is for a server that is gone
 * — its values are reachable only through its id, so leaving them would
 * leave encrypted files under `userData` that nothing can ever read,
 * list or remove again.
 */
export function clearMcpServerSecrets(options: McpServerSecretsOptions, serverId: string): void {
  rmSync(directoryFor(options, serverId), { force: true, recursive: true });
}
