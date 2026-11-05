import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "../secrets/store.js";
import {
  clearMcpServerSecret,
  clearMcpServerSecrets,
  listMcpServerSecretNames,
  mcpKeychainStatus,
  readMcpServerSecret,
  readMcpServerSecretEntry,
  storeMcpServerSecret,
  type McpServerSecretsOptions,
} from "./serverSecrets.js";

/**
 * The values behind a catalogued server's declared names (EO-104).
 *
 * `safeStorage`, minus the OS — reversing rather than prefixing, so "the
 * plaintext is not in the file" stays a claim about the code under test
 * rather than about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(reverse(text)),
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

const SERVER = "019fb8c6-0000-7000-8000-0000000000a1";
const OTHER = "019fb8c6-0000-7000-8000-0000000000a2";

let directory: string;
let secrets: McpServerSecretsOptions;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo mcp server secrets "));
  secrets = { directory, store };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("storing an MCP server's secrets", () => {
  it("stores a value and reads it back", () => {
    expect(storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "ghp_secret")).toEqual({ ok: true });

    expect(readMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN")).toBe("ghp_secret");
  });

  it("writes the ciphertext and never the value", () => {
    storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "ghp_secret");

    const written = readFileSync(join(directory, SERVER, "secret-GITHUB_TOKEN.bin"), "utf8");

    expect(written).not.toContain("ghp_secret");
  });

  it("keeps one server's values away from another's", () => {
    storeMcpServerSecret(secrets, SERVER, "TOKEN", "mine");
    storeMcpServerSecret(secrets, OTHER, "TOKEN", "theirs");

    expect(readMcpServerSecret(secrets, SERVER, "TOKEN")).toBe("mine");
    expect(readMcpServerSecret(secrets, OTHER, "TOKEN")).toBe("theirs");
  });

  it("lists what is set, by name, in order", () => {
    storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "a");
    storeMcpServerSecret(secrets, SERVER, "API_KEY", "b");

    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual(["API_KEY", "GITHUB_TOKEN"]);
  });

  it("answers with nothing for a server that has never had a value", () => {
    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual([]);
    expect(readMcpServerSecret(secrets, SERVER, "TOKEN")).toBeNull();
    expect(readMcpServerSecretEntry(secrets, SERVER, "TOKEN")).toEqual({ state: "absent" });
  });

  /**
   * The only two calls in EO handed a third-party token, and what
   * happens when one of them fails.
   *
   * `encryptString` is given the value and the write is given its
   * ciphertext, so an exception out of either is the one error here that
   * could be carrying a secret — and `handleIpcRequest` stringifies a
   * throw into the IPC envelope wherever `exposeErrorDetails` is on,
   * which is how the MCP host dispatches. So both are answered rather
   * than rethrown, with a sentence written in this module. The store
   * below throws with the value in its message, which is what makes the
   * sweep a real check rather than a formality.
   */
  it("answers a keychain that throws with the value in hand, instead of letting the exception out", () => {
    const throwing: McpServerSecretsOptions = {
      directory,
      store: {
        ...store,
        encryptString: (text: string) => {
          throw new Error(`libsecret failed while encrypting ${text}`);
        },
      },
    };

    const result = storeMcpServerSecret(throwing, SERVER, "GITHUB_TOKEN", "ghp_secret");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("keyring");
    // The whole result, because a check on one field passes while the
    // value sits in the next one along.
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual([]);
  });

  it("answers a machine it cannot write to, and says the encryption was not the part that failed", () => {
    // A directory that is a file: `mkdirSync` throws ENOTDIR, which is
    // the second of the two steps and the one worth telling apart — a
    // person whose keyring is fine and whose disk is full is fixing a
    // different thing.
    const file = join(directory, "not-a-directory");
    writeFileSync(file, "");

    const result = storeMcpServerSecret({ directory: file, store }, SERVER, "GITHUB_TOKEN", "ghp_secret");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("could not write it");
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
  });

  it("clears one value and leaves the rest", () => {
    storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "a");
    storeMcpServerSecret(secrets, SERVER, "API_KEY", "b");

    clearMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN");

    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual(["API_KEY"]);
  });

  it("clears everything one server held", () => {
    storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "a");
    storeMcpServerSecret(secrets, OTHER, "GITHUB_TOKEN", "b");

    clearMcpServerSecrets(secrets, SERVER);

    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual([]);
    expect(listMcpServerSecretNames(secrets, OTHER)).toEqual(["GITHUB_TOKEN"]);
  });

  /**
   * Unreadable is a third answer, not a kind of absent.
   *
   * The file is there and was written by another machine or before a
   * keychain reset. Whoever comes to resolve these at spawn has to be
   * able to tell "you never set this" from "EO can no longer read what
   * you set" — only one of them is fixed by typing it again.
   */
  it("tells an unreadable value apart from an absent one, and does not list it as set", () => {
    storeMcpServerSecret(secrets, SERVER, "GITHUB_TOKEN", "a");
    writeFileSync(join(directory, SERVER, "secret-GITHUB_TOKEN.bin"), "not something this store can decrypt");
    const broken: McpServerSecretsOptions = {
      directory,
      store: {
        ...store,
        decryptString: () => {
          throw new Error("bad ciphertext");
        },
      },
    };

    expect(readMcpServerSecretEntry(broken, SERVER, "GITHUB_TOKEN")).toEqual({ state: "unreadable" });
    // "Set" means a dispatch would get a value, and this one would not.
    expect(listMcpServerSecretNames(broken, SERVER)).toEqual([]);
  });
});

describe("the keychain behind safeStorage", () => {
  it("reports the backend it was told about", () => {
    const status = mcpKeychainStatus({ ...store, getSelectedStorageBackend: () => "gnome_libsecret" });

    expect(status).toEqual({ available: true, backend: "gnome_libsecret", weak: false, warning: null });
  });

  /** Older `SecretStore`s cannot say, and are taken at their word. */
  it("reports a null backend when the store cannot say which one it is", () => {
    expect(mcpKeychainStatus(store)).toEqual({ available: true, backend: null, weak: false, warning: null });
  });

  it("refuses, rather than writing in the clear, when there is no keychain at all", () => {
    const none: McpServerSecretsOptions = { directory, store: { ...store, isEncryptionAvailable: () => false } };

    const result = storeMcpServerSecret(none, SERVER, "GITHUB_TOKEN", "ghp_secret");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("keychain");
    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual([]);
  });

  /**
   * The Linux case that looks like success.
   *
   * `isEncryptionAvailable()` returns true while Electron has quietly
   * fallen back to `basic_text`, which encrypts with a password compiled
   * into Chromium — so anything running as the person could read the
   * token back out of `userData`. `mcpHost/token.ts` refuses a bearer
   * token on that backend and a third-party API token is worth the same
   * care: EO asked for it, so EO owes them the storage it implied.
   */
  it("surfaces a weak backend rather than silently accepting it", () => {
    const weak: McpServerSecretsOptions = { directory, store: { ...store, getSelectedStorageBackend: () => "basic_text" } };

    expect(mcpKeychainStatus(weak.store)).toEqual({ available: true, backend: "basic_text", weak: true, warning: expect.stringContaining("basic_text") });

    const result = storeMcpServerSecret(weak, SERVER, "GITHUB_TOKEN", "ghp_secret");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("basic_text");
    // And nothing was written anyway "just in case", which would be the
    // one outcome worse than refusing.
    expect(listMcpServerSecretNames(secrets, SERVER)).toEqual([]);
  });
});

describe("paths built from ids and names", () => {
  /**
   * A programmer error, and so a throw — every id here came out of
   * `mcp_servers.id`, and every name has been through the boundary's own
   * pattern. Nothing a person types can reach this.
   */
  it("refuses to build a path out of something that is not an id", () => {
    expect(() => readMcpServerSecret(secrets, "../../etc", "TOKEN")).toThrow(/refusing to build a secret path/);
  });

  it("refuses to build a path out of something that is not a variable name", () => {
    expect(() => readMcpServerSecret(secrets, SERVER, "../token")).toThrow(/refusing to build a secret path/);
  });

  /**
   * Still a throw on the way in, now that storing catches things.
   *
   * The catches around encrypting and writing exist so that a failure
   * holding a value cannot escape as an exception. A path that cannot be
   * built is the other kind — nothing a person types reaches it — and
   * turning it into a refusal would report a programmer error as a
   * keychain that failed, so it is raised before either `try` begins.
   */
  it("throws out of storing too, rather than reporting a refused path as a failed keychain", () => {
    expect(() => storeMcpServerSecret(secrets, "../../etc", "TOKEN", "ghp_secret")).toThrow(/refusing to build a secret path/);
    expect(() => storeMcpServerSecret(secrets, SERVER, "../token", "ghp_secret")).toThrow(/refusing to build a secret path/);
  });
});
