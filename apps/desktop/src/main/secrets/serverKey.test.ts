import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NEW_SERVER_SECRET_KEY_FILE_VARIABLE,
  NEW_SERVER_SECRET_KEY_VARIABLE,
  parseSecretKey,
  readSecretKey,
  SERVER_SECRET_KEY_FILE_VARIABLE,
  SERVER_SECRET_KEY_VARIABLE,
} from "./serverKey.js";

/**
 * Where a server's key comes from, and what it says when it does not
 * come (EO-320, the story's second acceptance criterion).
 *
 * The refusal is the interesting half. Anybody can write a function that
 * reads a variable; the decision this file holds is that EO does not
 * generate one, because a key generated on first boot is a key nobody
 * backed up — and a refusal an operator cannot act on is the same
 * failure wearing a message.
 */
const NAMES = { value: SERVER_SECRET_KEY_VARIABLE, file: SERVER_SECRET_KEY_FILE_VARIABLE, fileFlag: "secret-key-file" };
const BASE64_KEY = Buffer.alloc(32, 3).toString("base64");

let directories: string[] = [];

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function keyFile(contents: string, name = "key"): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-key-"));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

describe("reading a server's secret key", () => {
  it("refuses to start without one, naming the variable to set", () => {
    const result = readSecretKey({ names: NAMES, purpose: "encrypts its secrets with" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("EO_SERVER_SECRET_KEY");
    // And says where else it could have come from, because an operator
    // reading this line is about to choose one of the two.
    expect(result.ok === false && result.problem).toContain("EO_SERVER_SECRET_KEY_FILE");
  });

  it("never generates one, and says why in the same breath", () => {
    const result = readSecretKey({ names: NAMES, purpose: "encrypts its secrets with" });

    // The sentence is the decision: a key EO invented is a key that dies
    // with the container while the volume it encrypted lives on.
    expect(result.ok === false && result.problem).toMatch(/will not generate/);
    expect(result.ok === false && result.problem).toMatch(/openssl rand/);
  });

  it("takes the key from the environment", () => {
    const result = readSecretKey({ value: BASE64_KEY, names: NAMES, purpose: "p" });

    expect(result.ok && result.key.equals(Buffer.alloc(32, 3))).toBe(true);
  });

  it("takes it from a file, which is how a mounted secret arrives", () => {
    // With the trailing newline `openssl rand -base64 32 > key` leaves,
    // because refusing that would be a refusal about nothing.
    const result = readSecretKey({ file: keyFile(`${BASE64_KEY}\n`), names: NAMES, purpose: "p" });

    expect(result.ok && result.key.equals(Buffer.alloc(32, 3))).toBe(true);
  });

  it("prefers the file when both are set, because the file is the safer one", () => {
    const result = readSecretKey({ value: Buffer.alloc(32, 4).toString("base64"), file: keyFile(BASE64_KEY), names: NAMES, purpose: "p" });

    expect(result.ok && result.key.equals(Buffer.alloc(32, 3))).toBe(true);
  });

  it("says which file it could not read, rather than falling back to the variable", () => {
    // Falling back would start a server under a key the operator did not
    // choose, and encrypt tomorrow's secrets under it.
    const result = readSecretKey({ value: BASE64_KEY, file: join(tmpdir(), "eo-no-such-key-file"), names: NAMES, purpose: "p" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("eo-no-such-key-file");
  });

  it("reports an unreadable file rather than throwing at an operator", () => {
    const path = keyFile(BASE64_KEY, "unreadable");
    chmodSync(path, 0o000);
    // Root reads anything, so a container built as root would read it
    // and this assertion would be about nothing. Windows reads it too:
    // `chmod` there only sets the read-only flag.
    if (process.getuid?.() === 0 || process.platform === "win32") return;

    const result = readSecretKey({ file: path, names: NAMES, purpose: "p" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain(SERVER_SECRET_KEY_FILE_VARIABLE);
  });

  it("names the other pair of variables when it is rotation asking", () => {
    const result = readSecretKey({
      names: { value: NEW_SERVER_SECRET_KEY_VARIABLE, file: NEW_SERVER_SECRET_KEY_FILE_VARIABLE, fileFlag: "new-secret-key-file" },
      purpose: "should encrypt its secrets with from now on",
    });

    expect(result.ok === false && result.problem).toContain("EO_SERVER_NEW_SECRET_KEY");
  });
});

describe("what counts as a key", () => {
  it("takes base64 and hex, which is what the tools that make one write", () => {
    expect(parseSecretKey(Buffer.alloc(32, 5).toString("base64"), "x")).toMatchObject({ ok: true });
    expect(parseSecretKey(Buffer.alloc(32, 5).toString("hex"), "x")).toMatchObject({ ok: true });
    // base64url, for a generator that expected to be put in a URL.
    expect(parseSecretKey(Buffer.alloc(32, 250).toString("base64url"), "x")).toMatchObject({ ok: true });
  });

  it("refuses a passphrase rather than stretching one into a key", () => {
    // A KDF here would accept this and report AES-256 over eight
    // characters of entropy. The refusal is one `openssl` command to fix.
    const result = parseSecretKey("hunter2", "EO_SERVER_SECRET_KEY");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("EO_SERVER_SECRET_KEY");
    expect(result.ok === false && result.problem).toMatch(/openssl rand/);
  });

  it("refuses a key of the wrong size, and says what size it was", () => {
    const result = parseSecretKey(Buffer.alloc(16, 5).toString("base64"), "x");

    expect(result.ok === false && result.problem).toContain("decodes to 16");
  });

  it("refuses an empty value, which is what an unset compose variable interpolates to", () => {
    expect(parseSecretKey("   \n", "EO_SERVER_SECRET_KEY")).toMatchObject({ ok: false, problem: expect.stringContaining("is empty") });
  });

  it("says a sentence is not a key, rather than decoding whatever survives", () => {
    // `Buffer.from(text, "base64")` drops what it does not recognise and
    // answers with the rest, so this would otherwise be a short key
    // reported as a length problem.
    const result = parseSecretKey("please use this as the key, thanks!", "x");

    expect(result.ok === false && result.problem).toContain("not base64 or hex at all");
  });
});
