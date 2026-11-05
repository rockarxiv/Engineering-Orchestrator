import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readApiKey, storeApiKey } from "../runtimes/apiKey.js";
import { createServerSecretStore, serverSecretKeyId, SERVER_SECRET_BACKEND, SERVER_SECRET_KEY_BYTES } from "./serverStore.js";

/**
 * The server's secret store (EO-320).
 *
 * What a desktop gets from the OS and a headless host has to be given.
 * The tests below are the story's first acceptance criterion taken
 * apart: intact after a restart, unreadable without the key, and
 * — the part no criterion says out loud — indistinguishable from
 * `safeStorage` to every caller that already exists.
 */
const KEY = Buffer.alloc(SERVER_SECRET_KEY_BYTES, 1);
const ANOTHER_KEY = Buffer.alloc(SERVER_SECRET_KEY_BYTES, 2);

describe("a server's secret store", () => {
  it("reads back what it wrote", () => {
    const store = createServerSecretStore(KEY);

    expect(store.decryptString(store.encryptString("a token"))).toBe("a token");
  });

  it("reads back what another instance of itself wrote, which is what a restart is", () => {
    // Nothing is held in memory between these two, because nothing can
    // be: a container that restarts gets a new process with the same
    // key and the same volume, and that is the whole of the state.
    const written = createServerSecretStore(KEY).encryptString("a token that outlives the process");

    expect(createServerSecretStore(Buffer.from(KEY)).decryptString(written)).toBe("a token that outlives the process");
  });

  it("keeps unicode and empty values intact", () => {
    const store = createServerSecretStore(KEY);

    for (const value of ["", "ünïcodé ✓", "x".repeat(10_000), '{"json":"too"}']) {
      expect(store.decryptString(store.encryptString(value))).toBe(value);
    }
  });

  it("writes nothing a reader can see", () => {
    const encrypted = createServerSecretStore(KEY).encryptString("hunter2-is-the-password");

    expect(encrypted.includes("hunter2")).toBe(false);
    // The header is readable on purpose — it is how rotation finds a
    // value without opening it — and it is all that is.
    expect(encrypted.subarray(0, 6).toString("ascii")).toBe("EOSEC1");
  });

  it("uses a fresh IV, so two of the same value are not the same bytes", () => {
    const store = createServerSecretStore(KEY);

    // A deterministic ciphertext would tell anybody with the volume that
    // two servers hold the same token, or that a rotated value was never
    // really changed.
    expect(store.encryptString("same").equals(store.encryptString("same"))).toBe(false);
  });

  it("refuses a value written under another key, and says which problem it is", () => {
    const written = createServerSecretStore(KEY).encryptString("not yours");

    expect(() => createServerSecretStore(ANOTHER_KEY).decryptString(written)).toThrow(/different key/);
  });

  it("refuses a value that was edited on disk", () => {
    const written = createServerSecretStore(KEY).encryptString("a token");
    const tampered = Buffer.from(written);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);

    // GCM, not CBC: an edit is detected rather than decrypted into
    // something else. This is what makes a secret on a shared volume
    // something an attacker can destroy but not change.
    expect(() => createServerSecretStore(KEY).decryptString(tampered)).toThrow();
  });

  it("refuses to be told a value is under a key it is not", () => {
    const written = createServerSecretStore(KEY).encryptString("a token");
    const relabelled = Buffer.from(written);
    serverSecretKeyId(ANOTHER_KEY).copy(relabelled, 6);

    // The header is authenticated as well as read, so relabelling a file
    // is not a way to make rotation re-encrypt something it cannot open.
    expect(() => createServerSecretStore(ANOTHER_KEY).decryptString(relabelled)).toThrow();
  });

  it("refuses something that is not one of EO's secrets at all", () => {
    const store = createServerSecretStore(KEY);

    expect(() => store.decryptString(Buffer.from("a desktop's safeStorage ciphertext"))).toThrow(/not one of EO's server secrets/);
    expect(() => store.decryptString(Buffer.alloc(0))).toThrow();
  });

  it("refuses a key that is not 256 bits, rather than stretching one", () => {
    // A key EO padded or hashed into shape would be a key whose strength
    // is whatever the operator typed, reported as AES-256.
    expect(() => createServerSecretStore(Buffer.from("too short"))).toThrow(/32 bytes/);
    expect(() => createServerSecretStore(randomBytes(64))).toThrow(/32 bytes/);
  });

  it("answers the two questions every consumer asks before it writes anything", () => {
    const store = createServerSecretStore(KEY);

    expect(store.isEncryptionAvailable()).toBe(true);
    // Not `basic_text`, which `mcpHost/token.ts` and `mcp/serverSecrets.ts`
    // treat as no keychain at all. This is a real key, and it is EO's own
    // arrangement rather than one of Chromium's, so it says so.
    expect(store.getSelectedStorageBackend?.()).toBe(SERVER_SECRET_BACKEND);
  });

  it("is what an existing consumer, written for safeStorage, already expects", () => {
    // `runtimes/apiKey.ts` knows nothing about any of this. The story
    // says every existing consumer works unchanged; this is that,
    // through the file layout the consumer itself chose.
    const directory = mkdtempSync(join(tmpdir(), "eo-secret-"));
    try {
      const options = { directory, store: createServerSecretStore(KEY) };

      expect(storeApiKey(options, "claude", "sk-ant-secret")).toEqual({ ok: true });
      expect(readApiKey(options, "claude")).toBe("sk-ant-secret");
      // And an unreadable file is "absent" rather than a crash, which is
      // the contract `safeStorage` set by throwing.
      expect(readApiKey({ directory, store: createServerSecretStore(ANOTHER_KEY) }, "claude")).toBeNull();
      expect(readFileSync(join(directory, "runtime-claude-api-key.bin")).includes("sk-ant")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
