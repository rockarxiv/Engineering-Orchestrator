import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearToken, hasToken, readToken, rekeyJiraTokens, storeToken, type CredentialsOptions } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";

/**
 * Where a Jira token lives (J-01).
 *
 * The original design: "Secrets — OS keychain, never the DB". `safeStorage`
 * is injected here so these run without Electron, the way NotifierDeps
 * does for notifications.
 */
let directory: string;

/**
 * Stands in for Electron's safeStorage. Reversible, obviously — what is
 * being tested is that the module writes what the store returned and
 * never the raw value, not that the cipher is any good. Base64 rather
 * than a marker + plaintext, so "the file does not contain the token"
 * means something.
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

function options(store: SecretStore = fakeStore()): CredentialsOptions {
  return { directory, store };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo creds "));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("storing a token", () => {
  it("round-trips it", () => {
    expect(storeToken(options(), "p1", "secret-token")).toEqual({ ok: true });
    expect(readToken(options(), "p1")).toBe("secret-token");
  });

  it("writes only what the keychain returned, never the raw token", () => {
    // The whole point of the module. Hiding the value is safeStorage's
    // job; writing nothing but its output is this module's.
    const store = fakeStore();
    storeToken({ directory, store }, "p1", "secret-token");

    const written = readdirSync(directory).map((file) => readFileSync(join(directory, file)));
    expect(written).toHaveLength(1);
    expect(written[0]!.equals(store.encryptString("secret-token"))).toBe(true);
    expect(written[0]!.toString()).not.toContain("secret-token");
  });

  it("refuses rather than storing a token unprotected", () => {
    // A Linux box with no keyring running. Writing it in the clear
    // would quietly break the one promise this module exists to keep.
    const result = storeToken(options(fakeStore(false)), "p1", "secret-token");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("keychain");
    expect(readdirSync(directory)).toEqual([]);
  });

  it("keeps one repository's token separate from another's", () => {
    storeToken(options(), "p1", "first");
    storeToken(options(), "p2", "second");

    expect(readToken(options(), "p1")).toBe("first");
    expect(readToken(options(), "p2")).toBe("second");
  });
});

describe("reading a token", () => {
  it("says there is none rather than throwing, because unconfigured is normal", () => {
    expect(readToken(options(), "never-connected")).toBeNull();
    expect(hasToken(options(), "never-connected")).toBe(false);
  });

  it("treats an undecryptable file as absent", () => {
    // Written by another machine, another OS user, or before a keychain
    // reset. The user reconnects; nothing crashes.
    storeToken({ directory, store: { ...fakeStore(), encryptString: () => Buffer.from("written by another keychain") } }, "p1", "x");

    expect(readToken(options(), "p1")).toBeNull();
  });
});

describe("clearing a token", () => {
  it("removes it", () => {
    storeToken(options(), "p1", "secret-token");
    clearToken(options(), "p1");

    expect(readToken(options(), "p1")).toBeNull();
  });

  it("is fine when there was nothing to remove", () => {
    expect(() => clearToken(options(), "never-connected")).not.toThrow();
  });
});

describe("the path it builds", () => {
  it("refuses an id that is not one", () => {
    // Ids are ours and UUIDv7, but a path is a path.
    expect(() => storeToken(options(), "../../etc/passwd", "x")).toThrow(/refusing/);
  });
});

/**
 * Moving tokens from repositories to connections (KAN-22).
 *
 * Migration 0017 could not do this: tokens are files under userData, not
 * rows. Without it, everyone with Jira connected would be asked to
 * re-enter a credential they had already given us — as the price of a
 * change whose whole purpose is to stop asking twice.
 */
describe("rekeying tokens onto connections", () => {
  it("moves a repository's token to its connection", () => {
    storeToken(options(), "repository-1", "pat");

    expect(rekeyJiraTokens(options(), [{ repositoryId: "repository-1", connectionId: "conn-1" }])).toBe(1);
    expect(readToken(options(), "conn-1")).toBe("pat");
  });

  it("gives two repositories on one site a single credential", () => {
    // The duplication this feature removes. Both had their own copy;
    // afterwards there is one, and it is the connection's.
    storeToken(options(), "repository-1", "pat");
    storeToken(options(), "repository-2", "pat");

    const moved = rekeyJiraTokens(options(), [
      { repositoryId: "repository-1", connectionId: "conn-1" },
      { repositoryId: "repository-2", connectionId: "conn-1" },
    ]);

    expect(moved, "the second is skipped, not written again").toBe(1);
    expect(readToken(options(), "conn-1")).toBe("pat");
  });

  it("runs safely on every launch, because it is skipped once done", () => {
    storeToken(options(), "repository-1", "pat");
    rekeyJiraTokens(options(), [{ repositoryId: "repository-1", connectionId: "conn-1" }]);

    // A token rotated after the move must not be overwritten by the old
    // one still sitting under the repository's name.
    storeToken(options(), "conn-1", "rotated");
    expect(rekeyJiraTokens(options(), [{ repositoryId: "repository-1", connectionId: "conn-1" }])).toBe(0);
    expect(readToken(options(), "conn-1")).toBe("rotated");
  });

  it("says nothing happened when a repository never had a token", () => {
    expect(rekeyJiraTokens(options(), [{ repositoryId: "never-connected", connectionId: "conn-1" }])).toBe(0);
    expect(readToken(options(), "conn-1")).toBeNull();
  });

  it("removes the repository's own file, but only after reading the new one back", () => {
    // Moved, not copied: what would be left otherwise is an encrypted
    // credential under userData that nothing reads, forever. The
    // read-back is what makes removing it safe.
    storeToken(options(), "repository-1", "pat");
    rekeyJiraTokens(options(), [{ repositoryId: "repository-1", connectionId: "conn-1" }]);

    expect(readToken(options(), "conn-1")).toBe("pat");
    expect(readToken(options(), "repository-1")).toBeNull();
  });

  it("still tidies the second repository's copy when the connection already has one", () => {
    // Two repositories on one site each had their own. The second is not
    // written again — but it is still cleaned up.
    storeToken(options(), "repository-1", "pat");
    storeToken(options(), "repository-2", "pat");

    rekeyJiraTokens(options(), [
      { repositoryId: "repository-1", connectionId: "conn-1" },
      { repositoryId: "repository-2", connectionId: "conn-1" },
    ]);

    expect(readToken(options(), "repository-1")).toBeNull();
    expect(readToken(options(), "repository-2")).toBeNull();
  });

  it("keeps the old file when the keychain refuses to store the new one", () => {
    // The one case where deleting would lose a credential outright.
    const refusing = options(fakeStore(false));
    storeToken(options(), "repository-1", "pat");

    rekeyJiraTokens(refusing, [{ repositoryId: "repository-1", connectionId: "conn-1" }]);

    expect(readToken(options(), "repository-1"), "not thrown away when it could not be moved").toBe("pat");
  });
});
