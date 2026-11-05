import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSecret, storeSecret } from "../modules/secrets.js";
import { readApiKey, storeApiKey } from "../runtimes/apiKey.js";
import { lockDataDirectory } from "../server/dataDirectoryLock.js";
import { rotateServerSecrets } from "./rotateServerSecrets.js";
import { createServerSecretStore, serverSecretKeyId } from "./serverStore.js";

/**
 * Rotation (EO-320, the story's third acceptance criterion).
 *
 * Written against the *real* consumers rather than against files this
 * test wrote itself, because the claim being made is "every value" and
 * the risk is a layout rotation does not know about. `runtimes/apiKey.ts`
 * puts one file in `credentials/`; `modules/secrets.ts` puts one per
 * name in a per-step directory hashed from its id. Neither was told
 * about rotation, and neither should have to be.
 */
const OLD_KEY = Buffer.alloc(32, 1);
const NEW_KEY = Buffer.alloc(32, 2);
const THIRD_KEY = Buffer.alloc(32, 3);

const API_KEY_FILE = join("credentials", "runtime-claude-api-key.bin");

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eo-rotate-"));
});
afterEach(() => {
  // Restore anything a permissions test locked, or the removal below
  // fails and every later test runs on a directory that should be gone.
  for (const path of restore.splice(0)) chmodSync(path, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

/** Paths whose mode a test changed, put back before teardown. */
const restore: string[] = [];

/**
 * Root reads and lists whatever it likes, so a permissions test proves
 * nothing under it. Skipped rather than quietly passing.
 */
const unprivileged = process.getuid?.() !== 0;

/**
 * Windows has no POSIX mode bits: `chmod` there sets or clears the
 * read-only flag and nothing else, so a mode can be neither withheld nor
 * read back. A read-only file is still readable, and it is the rename
 * over it that fails, which is a different test from the one written.
 */
const posixModes = process.platform !== "win32";

/** Where the two consumers this test uses keep their values. */
function credentials(key: Buffer): { directory: string; store: ReturnType<typeof createServerSecretStore> } {
  return { directory: join(directory, "credentials"), store: createServerSecretStore(key) };
}
function modules(key: Buffer): { directory: string; store: ReturnType<typeof createServerSecretStore> } {
  return { directory: join(directory, "modules"), store: createServerSecretStore(key) };
}

/** The data directory as a running server leaves it: values in three layouts, and a database. */
function aServersVolume(key: Buffer): void {
  storeApiKey(credentials(key), "claude", "sk-ant-the-billable-one");
  storeSecret(modules(key), "GITHUB_TOKEN", "ghp-a-module-secret");
  storeSecret(modules(key), "NESTED_TOKEN", "a-secret-under-a-step", "01a0-a-step-id");
  // Not a secret, and the biggest file on a real volume.
  writeFileSync(join(directory, "eo.db"), "SQLite format 3 and then some pages");
}

describe("rotating a server's secret key", () => {
  it("re-encrypts every value, wherever the consumer chose to put it", () => {
    aServersVolume(OLD_KEY);

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(true);
    // Three values in three different layouts, two of them nested under
    // a directory named from a hash, found by walking rather than by
    // being told where to look.
    expect(result.ok && result.rotated).toHaveLength(3);
    expect(result.ok && result.rotated).toContain(API_KEY_FILE);

    expect(readApiKey(credentials(NEW_KEY), "claude")).toBe("sk-ant-the-billable-one");
    expect(readSecret(modules(NEW_KEY), "GITHUB_TOKEN")).toBe("ghp-a-module-secret");
    expect(readSecret(modules(NEW_KEY), "NESTED_TOKEN", "01a0-a-step-id")).toBe("a-secret-under-a-step");
  });

  it("leaves the old key reading nothing at all", () => {
    aServersVolume(OLD_KEY);

    rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    // The point of rotating: a key that has leaked is a key that no
    // longer opens this volume.
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBeNull();
    expect(readSecret(modules(OLD_KEY), "GITHUB_TOKEN")).toBeNull();
    expect(readSecret(modules(OLD_KEY), "NESTED_TOKEN", "01a0-a-step-id")).toBeNull();
  });

  it("touches nothing that is not one of EO's secrets", () => {
    aServersVolume(OLD_KEY);
    const database = readFileSync(join(directory, "eo.db"));

    rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(readFileSync(join(directory, "eo.db")).equals(database)).toBe(true);
    // And leaves no half-written copies behind.
    expect(readdirSync(join(directory, "credentials")).filter((entry) => entry.endsWith(".rotating"))).toEqual([]);
  });

  it("keeps a rotated value as private as the consumer wrote it", () => {
    if (!posixModes) return;
    aServersVolume(OLD_KEY);

    rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    // 0600 was not incidental: a rewrite that widened the mode would
    // quietly undo what every consumer does deliberately.
    expect(statSync(join(directory, API_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it("refuses to rotate onto the same key", () => {
    aServersVolume(OLD_KEY);

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: Buffer.from(OLD_KEY) });

    // An operator asking for this has decided the old key is
    // compromised. "0 rotated, all fine" would be the wrong answer.
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining("same as the old one") });
  });

  it("writes nothing at all when one value cannot be read", () => {
    aServersVolume(OLD_KEY);
    // A value from another installation, restored onto this volume by
    // mistake, or a file somebody edited.
    mkdirSync(join(directory, "mcp", "01a0-a-server"), { recursive: true });
    writeFileSync(join(directory, "mcp", "01a0-a-server", "secret-TOKEN.bin"), createServerSecretStore(THIRD_KEY).encryptString("not ours"));

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unreadable).toEqual([join("mcp", "01a0-a-server", "secret-TOKEN.bin")]);
    // All or nothing: a volume where half the values are under each key
    // is a volume no key reads whole, and nobody could tell which half.
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBe("sk-ant-the-billable-one");
    expect(readdirSync(join(directory, "credentials"))).toEqual(["runtime-claude-api-key.bin"]);
  });

  it("can be run again after one that died halfway", () => {
    aServersVolume(OLD_KEY);
    // What an interrupted rotation leaves: one value already moved on.
    writeFileSync(join(directory, API_KEY_FILE), createServerSecretStore(NEW_KEY).encryptString("sk-ant-the-billable-one"));

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(true);
    // Counted and named rather than refused, so the way out of a failed
    // rotation is to run it again.
    expect(result.ok && result.alreadyRotated).toEqual([API_KEY_FILE]);
    expect(result.ok && result.rotated).toHaveLength(2);
    expect(readApiKey(credentials(NEW_KEY), "claude")).toBe("sk-ant-the-billable-one");
  });

  it("refuses while a server is using the directory, rather than racing it", () => {
    aServersVolume(OLD_KEY);
    // What a serving process holds for as long as it serves. It also
    // holds the old key in memory, and writes secrets with it whenever
    // somebody saves one — so a rotation that scanned around it would
    // report success over a value the old key still opens.
    const server = lockDataDirectory(directory, "a server");

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("A server");
    // And nothing was touched, so the running server's own reads are
    // unaffected by the attempt.
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBe("sk-ant-the-billable-one");
    if (server.ok) server.lock.release();
  });

  it("closes the window a secret written mid-rotation would have fallen through", () => {
    aServersVolume(OLD_KEY);
    const server = lockDataDirectory(directory, "a server");

    // The race, in the order it happens: rotation looks at the volume,
    // and the server writes a new secret with the old key immediately
    // afterwards. The only reason this is safe is that the look was
    // refused — so the write below is still the old key's, and rotation
    // has claimed nothing about it.
    const attempted = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });
    storeApiKey(credentials(OLD_KEY), "claude", "saved-a-moment-after-the-attempt");

    expect(attempted.ok).toBe(false);
    if (server.ok) server.lock.release();

    // Once the server is stopped, the same rotation takes the value that
    // was written during it. Nothing was left behind under the old key.
    const afterwards = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(afterwards.ok).toBe(true);
    expect(readApiKey(credentials(NEW_KEY), "claude")).toBe("saved-a-moment-after-the-attempt");
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBeNull();
  });

  it("gives the directory back when it is done, whether it worked or not", () => {
    aServersVolume(OLD_KEY);

    expect(rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY }).ok).toBe(true);
    // The server an admin is about to restart has to be able to start.
    // A rotation that kept the lock — or dropped it only on the happy
    // path — would be a rotation that takes the volume away for good.
    const afterSuccess = lockDataDirectory(directory, "a server");
    expect(afterSuccess.ok).toBe(true);
    if (afterSuccess.ok) afterSuccess.lock.release();

    // A failure that happens with the lock already held, which is the
    // one the `finally` is for: a value under a key that is neither.
    writeFileSync(join(directory, "stray.bin"), createServerSecretStore(THIRD_KEY).encryptString("not ours"));
    expect(rotateServerSecrets({ directory, from: NEW_KEY, to: OLD_KEY }).ok).toBe(false);

    const afterFailure = lockDataDirectory(directory, "a server");
    expect(afterFailure.ok).toBe(true);
    if (afterFailure.ok) afterFailure.lock.release();
  });

  it("refuses when a directory will not be listed, rather than reporting success around it", () => {
    if (!unprivileged || !posixModes) return;
    aServersVolume(OLD_KEY);
    // `0o111` is the dangerous mode, not `0o000`: the directory is
    // traversable, so every secret inside it is still readable by
    // anything holding the name — and invisible to a walk that gave up
    // on `readdir` and moved on.
    const unlistable = join(directory, "mcp");
    mkdirSync(unlistable, { recursive: true });
    writeFileSync(join(unlistable, "secret-TOKEN.bin"), createServerSecretStore(OLD_KEY).encryptString("still under the old key"));
    restore.push(unlistable);
    chmodSync(unlistable, 0o111);

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unreadable).toEqual(["mcp"]);
    // Nothing was written, so the volume is still whole under one key
    // rather than split across two.
    expect(readApiKey(credentials(OLD_KEY), "claude")).toBe("sk-ant-the-billable-one");
  });

  it("refuses when a file will not be opened, because it might be a secret", () => {
    if (!unprivileged || !posixModes) return;
    aServersVolume(OLD_KEY);
    const path = join(directory, "credentials", "runtime-claude-api-key.bin");
    chmodSync(path, 0o000);
    restore.push(path);

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    // "Might be" is not something a promise about every value survives.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.unreadable).toEqual([join("credentials", "runtime-claude-api-key.bin")]);
  });

  it("looks inside a package tree, because a data directory has one", () => {
    aServersVolume(OLD_KEY);
    // `<userData>/runtimes` is an installed `node_modules` tree
    // (`runtimes/install.ts`), and this walk used to skip any directory
    // of that name as an obvious place for no secrets. An obvious place
    // for no secrets is still a place this command claimed to have
    // rotated, so nothing is excluded by name any more.
    const inside = join(directory, "runtimes", "claude", "node_modules");
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "secret-TOKEN.bin"), createServerSecretStore(OLD_KEY).encryptString("somewhere nobody looks"));

    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result.ok).toBe(true);
    expect(createServerSecretStore(NEW_KEY).decryptString(readFileSync(join(inside, "secret-TOKEN.bin")))).toBe("somewhere nobody looks");
  });

  it("is not fooled by two keys whose labels are the same", () => {
    // Every ciphertext carries four bytes identifying the key it was
    // written under. Four bytes collide: these two were found by
    // searching `sha256(i)` for a pair sharing them, which takes about
    // 65,000 candidates — a birthday collision on 32 bits, and cheap
    // enough that an attacker who chooses one of the keys can arrange
    // it. Hard-coded so this test is deterministic; the assertion below
    // is the premise, and it fails loudly if the label ever changes.
    const from = Buffer.from("af1c80456cb5e2a1f15c274adbccf6ff8fa2f841d9df8d8c2b339c244ba3e197", "hex");
    const to = Buffer.from("540e7d6ceb971bba05000ad837cf8753cc543d01c787c361de8aa3b8e282a523", "hex");
    expect(serverSecretKeyId(from).equals(serverSecretKeyId(to))).toBe(true);
    aServersVolume(from);

    const result = rotateServerSecrets({ directory, from, to });

    // Reading the label and believing it, every value would have been
    // filed under "already under the new key" and skipped — a rotation
    // that reported success over a volume the old key still opened
    // whole. Ownership is decided by decrypting, so the label decides
    // nothing.
    expect(result.ok).toBe(true);
    expect(result.ok && result.alreadyRotated).toEqual([]);
    expect(result.ok && result.rotated).toHaveLength(3);
    expect(readApiKey(credentials(to), "claude")).toBe("sk-ant-the-billable-one");
    expect(readApiKey(credentials(from), "claude")).toBeNull();
    expect(readSecret(modules(from), "GITHUB_TOKEN")).toBeNull();
  });

  it("says there is no directory rather than claiming an empty one was rotated", () => {
    const result = rotateServerSecrets({ directory: join(directory, "not-a-volume"), from: OLD_KEY, to: NEW_KEY });

    // The likeliest operator error of all — a typo in EO_SERVER_DATA —
    // and the one most dangerous to answer with "0 values rotated".
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("no data directory");
  });

  it("says so plainly when there is nothing to rotate", () => {
    const result = rotateServerSecrets({ directory, from: OLD_KEY, to: NEW_KEY });

    expect(result).toMatchObject({ ok: true, rotated: [], alreadyRotated: [] });
  });
});
