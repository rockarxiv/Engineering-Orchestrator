import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "../secrets/store.js";
import { storeToken } from "../packs/developer/jira/credentials.js";
import { clearApiKey, hasApiKey, readApiKey, storeApiKey, type ApiKeyStoreOptions } from "./apiKey.js";

/**
 * Where a Claude API key lives (EO-84).
 *
 * The one billable secret EO holds, so the property under test is not
 * "it round-trips" but "the plaintext is never on disk and never comes
 * back out anywhere it should not". The design: secrets go to the OS
 * keychain, never to the DB.
 */
let directory: string;

/**
 * Stands in for Electron's safeStorage, as `credentials.test.ts` does.
 * Base64 rather than a marker plus plaintext, so "the file does not
 * contain the key" is a claim with teeth.
 */
function fakeStore(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString();
      if (!text.startsWith("v1:")) throw new Error("not encrypted by this keychain");
      return Buffer.from(text.slice(3), "base64").toString();
    },
  };
}

function options(store: SecretStore = fakeStore()): ApiKeyStoreOptions {
  return { directory, store };
}

const KEY = "sk-ant-api03-not-a-real-key";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo keys "));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("storing a key", () => {
  it("round-trips it", () => {
    expect(storeApiKey(options(), "claude", KEY)).toEqual({ ok: true });
    expect(readApiKey(options(), "claude")).toBe(KEY);
    expect(hasApiKey(options(), "claude")).toBe(true);
  });

  it("writes ciphertext, never the key", () => {
    storeApiKey(options(), "claude", KEY);

    const written = readdirSync(directory);
    expect(written).toHaveLength(1);
    const bytes = readFileSync(join(directory, written[0]!));
    // The whole point of the keychain. A file containing the key would
    // be the same leak as a database row containing it.
    expect(bytes.toString()).not.toContain(KEY);
    expect(bytes.toString()).not.toContain("sk-ant");
  });

  it("refuses rather than writing in the clear when there is no keychain", () => {
    // A Linux box with no keyring running. Storing anyway would break
    // the one promise this module exists to keep, silently.
    const result = storeApiKey(options(fakeStore(false)), "claude", KEY);

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no OS keychain") });
    // And it says what still works without one.
    expect(result.ok === false && result.reason).toContain("Anthropic Console");
    expect(readdirSync(directory)).toEqual([]);
  });

  it("leaves a Jira token in the same directory alone", () => {
    // They share `userData/credentials` deliberately — same keychain,
    // same rule — so one filename must not be the other's.
    storeToken(options(), "connection-1", "jira-token");
    storeApiKey(options(), "claude", KEY);

    expect(readApiKey(options(), "claude")).toBe(KEY);
    expect(readdirSync(directory).sort()).toEqual(["jira-connection-1.bin", "runtime-claude-api-key.bin"]);

    clearApiKey(options(), "claude");
    expect(readdirSync(directory)).toEqual(["jira-connection-1.bin"]);
  });
});

describe("reading a key", () => {
  it("answers null when there is none — unconfigured is a normal state", () => {
    expect(readApiKey(options(), "claude")).toBeNull();
    expect(hasApiKey(options(), "claude")).toBe(false);
  });

  it("treats a file this machine cannot decrypt as absent", () => {
    // Written by another OS user, or before a keychain reset. Reporting
    // "signed in with an API key" over one of these would promise a
    // dispatch that then fails against a credential nobody can see.
    writeFileSync(join(directory, "runtime-claude-api-key.bin"), "written by some other keychain");

    expect(readApiKey(options(), "claude")).toBeNull();
    expect(hasApiKey(options(), "claude")).toBe(false);
  });

  it("says whether there is one without an options object at all", () => {
    // The engine and the status path both call this on a machine that
    // may have no keychain wired up — the v1 gate, most tests — and
    // neither should have to branch first.
    expect(hasApiKey(undefined, "claude")).toBe(false);
  });
});

describe("removing a key", () => {
  it("forgets it and says there was one", () => {
    storeApiKey(options(), "claude", KEY);

    expect(clearApiKey(options(), "claude")).toBe(true);
    expect(readApiKey(options(), "claude")).toBeNull();
  });

  it("is not an error when there was nothing to remove", () => {
    expect(clearApiKey(options(), "claude")).toBe(false);
  });
});
