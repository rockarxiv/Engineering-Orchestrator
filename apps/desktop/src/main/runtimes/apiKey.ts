import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "../secrets/store.js";

/**
 * The one billable secret EO holds (EO-84).
 *
 * Codex needs nothing here: `codex login --with-api-key` reads the key
 * from stdin and the CLI stores it, so EO pipes it through and forgets
 * it. Claude has no equivalent flag — it takes `ANTHROPIC_API_KEY` from
 * the environment — so a key someone already has and types into EO has
 * to live somewhere for EO to inject it at spawn.
 *
 * "Somewhere" is the arrangement the Jira token already uses and the one
 * the original design requires: *"Secrets: OS keychain, never the DB"*. The
 * key is the OS keychain's, the ciphertext is a file under `userData`,
 * and it sits in the same `credentials` directory as the Jira tokens
 * because it is the same kind of thing under the same rule. Its own
 * filename, so clearing one cannot disturb the other.
 *
 * Nothing here returns the key anywhere it could be persisted or
 * printed. `hasApiKey` exists precisely so the status path — which
 * crosses IPC to a renderer — can know that a key is held without ever
 * being handed one.
 */

/**
 * Which providers EO stores a key for: exactly one.
 *
 * Not a `RuntimeId`, deliberately. Codex's key is the CLI's from the
 * moment it is piped in, and a type that allowed `"codex"` here would
 * be an invitation to write it down — which is the thing the pinned
 * decision on EO-81 says EO does not do.
 */
export type ApiKeyProvider = "claude";

export interface ApiKeyStoreOptions {
  /** Where the ciphertext lives. `app.getPath("userData")/credentials` in production — beside the Jira tokens. */
  directory: string;
  store: SecretStore;
}

export type StoreApiKeyResult = { ok: true } | { ok: false; reason: string };

function fileFor(directory: string, provider: ApiKeyProvider): string {
  return join(directory, `runtime-${provider}-api-key.bin`);
}

/**
 * Stores a key, or refuses and says why.
 *
 * `isEncryptionAvailable()` is false on a Linux box with no keyring (a
 * bare container, some minimal desktops). Writing an API key in the
 * clear there would quietly break the one promise this module exists to
 * keep, so — exactly as `storeToken` does — it refuses rather than
 * degrading silently. The person still has `claude auth login --console`,
 * which stores nothing in EO at all.
 */
export function storeApiKey(options: ApiKeyStoreOptions, provider: ApiKeyProvider, key: string): StoreApiKeyResult {
  if (!options.store.isEncryptionAvailable()) {
    return {
      ok: false,
      reason:
        "This machine has no OS keychain available, so EO cannot store an API key safely. " +
        "On Linux that usually means no keyring is running (gnome-keyring or kwallet). " +
        "Signing in through the Anthropic Console works without one — the Claude CLI keeps that credential itself.",
    };
  }

  mkdirSync(options.directory, { recursive: true });
  writeFileSync(fileFor(options.directory, provider), options.store.encryptString(key), { mode: 0o600 });
  return { ok: true };
}

/**
 * The key, or null when there is none.
 *
 * Read at spawn rather than held: the provider is cached per agent and
 * outlives any number of key changes, so a key read once at construction
 * would be the key EO injected forever — including after someone removed
 * it from the card and was told the runtime was signed out.
 */
export function readApiKey(options: ApiKeyStoreOptions, provider: ApiKeyProvider): string | null {
  let encrypted: Buffer;
  try {
    encrypted = readFileSync(fileFor(options.directory, provider));
  } catch {
    return null;
  }

  try {
    return options.store.decryptString(encrypted);
  } catch {
    // Written by another machine, another OS user, or before a keychain
    // reset. Unreadable is the same as absent — the runtime reports
    // signed out and the person pastes the key again, which is a better
    // outcome than a dispatch failing against a credential nobody can
    // see or fix.
    return null;
  }
}

/**
 * Whether EO holds one, without handing anybody the key.
 *
 * This is what `runtime:status` asks, and the distinction matters: that
 * answer crosses IPC to a renderer, is rendered on a card, and must
 * never be one decryption away from the secret itself.
 *
 * It reads and discards rather than testing for the file, for the same
 * reason `readApiKey` treats an undecryptable file as absent: a
 * ciphertext this machine cannot open is not a credential, and reporting
 * "signed in with an API key" on the strength of one would promise a
 * dispatch that then fails.
 */
export function hasApiKey(options: ApiKeyStoreOptions | undefined, provider: ApiKeyProvider): boolean {
  return options !== undefined && readApiKey(options, provider) !== null;
}

/** Forgets it. Answers whether there was one, so the card can say "removed" rather than guess. */
export function clearApiKey(options: ApiKeyStoreOptions, provider: ApiKeyProvider): boolean {
  const had = readApiKey(options, provider) !== null;
  rmSync(fileFor(options.directory, provider), { force: true });
  return had;
}
