import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "../secrets/store.js";
import { ensureToken, mintToken, readTokenValue, tokenMatches } from "./token.js";

/** The fake jira/credentials' own tests use: reversible, so a failure to decrypt is visible rather than silent. */
function fakeStore(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not ours");
      return text.slice(4);
    },
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo-mcp-token-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the MCP bearer token", () => {
  it("mints something long enough not to be guessed and short enough to paste", () => {
    const minted = mintToken({ directory, store: fakeStore() });

    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    // 32 bytes of randomness is 43 base64url characters.
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("round-trips through the store", () => {
    const options = { directory, store: fakeStore() };
    const minted = mintToken(options);

    // Narrowed rather than folded into the assertion: `expect(a.ok && x)
    // .toBe(a.ok && y)` passes trivially when `ok` is false, which is
    // the one case worth failing on.
    if (!minted.ok) throw new Error(minted.reason);
    expect(readTokenValue(options)).toBe(minted.token);
  });

  it("keeps the token it already has rather than inventing a new one each launch", () => {
    // ensureToken runs on every enable. If it minted each time, every
    // config anyone had pasted elsewhere would stop working on restart.
    const options = { directory, store: fakeStore() };
    const first = ensureToken(options);
    const second = ensureToken(options);

    if (!first.ok) throw new Error(first.reason);
    if (!second.ok) throw new Error(second.reason);
    expect(second.token).toBe(first.token);
  });

  it("refuses rather than writing a bearer token in the clear", () => {
    // A Linux box with no keyring. Falling back to plaintext would
    // quietly break the one promise this module exists to keep.
    const minted = mintToken({ directory, store: fakeStore(false) });

    expect(minted).toMatchObject({ ok: false, reason: expect.stringContaining("keychain") });
  });

  it("treats an unreadable file as no token, not as an error", () => {
    // Written by another machine, another OS user, or before a keychain
    // reset. The person regenerates; nothing throws at them.
    writeFileSync(join(directory, "token.bin"), "written by some other keychain");

    expect(readTokenValue({ directory, store: fakeStore() })).toBeNull();
  });

  it("writes through the keychain rather than around it", () => {
    // What this can honestly check. The fake is reversible on purpose,
    // so it cannot prove the plaintext is absent — only that the bytes
    // on disk came out of `encryptString`. Naming it "never the token"
    // and then asserting the token is present, as this once did, claimed
    // the opposite of what it tested.
    const options = { directory, store: fakeStore() };
    mintToken(options);

    expect(readFileSync(join(directory, "token.bin"), "utf8").startsWith("enc:")).toBe(true);
  });

  it("refuses a keychain that is unlocked storage in disguise", () => {
    // Electron's `basic_text` backend on Linux reports itself available
    // and encrypts with a password compiled into Chromium.
    const minted = mintToken({
      directory,
      store: { ...fakeStore(), getSelectedStorageBackend: () => "basic_text" },
    });

    expect(minted).toMatchObject({ ok: false, reason: expect.stringContaining("basic_text") });
  });
});

describe("comparing a presented credential", () => {
  it("accepts the token", () => {
    expect(tokenMatches("abcdef", "abcdef")).toBe(true);
  });

  it("rejects a wrong one of the same length", () => {
    expect(tokenMatches("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects a different length without throwing", () => {
    // timingSafeEqual throws on a length mismatch rather than returning
    // false, which would turn a wrong token into a 500.
    expect(() => tokenMatches("abcdef", "abc")).not.toThrow();
    expect(tokenMatches("abcdef", "abc")).toBe(false);
  });
});

