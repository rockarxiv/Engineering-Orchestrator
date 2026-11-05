import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureTar } from "../testing/tar.js";
import { extractTar, isSafeEntryPath } from "./tar.js";

/**
 * The tar reader (A-08).
 *
 * Tested against archives GNU tar produced, not archives this code
 * produced — a reader tested against its own writer proves only that it
 * is self-consistent.
 */
let scratch: string;

function makeTar(files: Record<string, string>, extraArgs: string[] = []): Buffer {
  const source = join(scratch, "src");
  mkdirSync(source, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(source, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  const out = join(scratch, "out.tgz");
  execFileSync(fixtureTar(), ["-czf", out, "-C", scratch, ...extraArgs, "src"], { encoding: "utf8" });
  return gunzipSync(execFileSync("cat", [out], { encoding: "buffer" }));
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo tar "));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("reading an archive", () => {
  it("returns every regular file with its contents intact", () => {
    const entries = extractTar(makeTar({ "a.txt": "first", "nested/b.txt": "second" }));

    const byPath = new Map(entries.map((entry) => [entry.path, entry.contents.toString()]));
    expect(byPath.get("src/a.txt")).toBe("first");
    expect(byPath.get("src/nested/b.txt")).toBe("second");
  });

  it("handles a file that is not a multiple of the block size", () => {
    // The padding arithmetic is the one thing in a tar reader that is
    // easy to get subtly wrong, and it only shows up on some sizes.
    for (const size of [1, 511, 512, 513, 1024, 2047]) {
      const entries = extractTar(makeTar({ "f.bin": "x".repeat(size) }));
      const file = entries.find((entry) => entry.path.endsWith("f.bin"));
      expect(file?.contents.length, `size ${size}`).toBe(size);
    }
  });

  it("skips directories rather than reporting them as empty files", () => {
    const entries = extractTar(makeTar({ "dir/inside.txt": "x" }));

    expect(entries.every((entry) => !entry.path.endsWith("/"))).toBe(true);
    expect(entries.map((entry) => entry.path)).toContain("src/dir/inside.txt");
  });

  // The fixture is a real file tarred by a real tar, per this file's rule
  // about not testing a reader against its own writer — which means the
  // mode in the archive is whatever the filesystem gave it. On Windows
  // that is never an executable one, so there is nothing here to read back.
  it.skipIf(process.platform === "win32")("carries the mode, so an executable can stay executable", () => {
    const source = join(scratch, "src");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "bin"), "#!/bin/sh\n", { mode: 0o755 });
    const out = join(scratch, "out.tgz");
    execFileSync(fixtureTar(), ["-czf", out, "-C", scratch, "src"]);

    const entry = extractTar(gunzipSync(execFileSync("cat", [out], { encoding: "buffer" }))).find((e) => e.path.endsWith("bin"));

    expect(entry!.mode & 0o111).toBeGreaterThan(0);
  });

  it("stops at the end-of-archive padding instead of reading past it", () => {
    const entries = extractTar(makeTar({ "only.txt": "x" }));

    expect(entries.filter((entry) => entry.path.endsWith("only.txt"))).toHaveLength(1);
  });

  it("strips npm's package/ wrapper", () => {
    // Every npm tarball is wrapped in one, and callers should deal in
    // the paths the package itself declares.
    const source = join(scratch, "package");
    mkdirSync(join(source, "bin"), { recursive: true });
    writeFileSync(join(source, "bin", "cli"), "#!/bin/sh\n");
    const out = join(scratch, "out.tgz");
    execFileSync(fixtureTar(), ["-czf", out, "-C", scratch, "package"]);

    const entries = extractTar(gunzipSync(execFileSync("cat", [out], { encoding: "buffer" })));

    expect(entries.map((entry) => entry.path)).toContain("bin/cli");
  });

  it("returns nothing for an empty buffer rather than throwing", () => {
    expect(extractTar(Buffer.alloc(0))).toEqual([]);
    expect(extractTar(Buffer.alloc(1024))).toEqual([]);
  });
});

describe("refusing to write outside the destination", () => {
  it("rejects traversal, absolute paths and drive letters", () => {
    // A tarball comes off the network. There is no legitimate archive
    // that contains any of these, so they are refused rather than
    // normalised — normalising only makes an attack quieter.
    for (const path of ["../escape", "a/../../escape", "/etc/passwd", "\\\\server\\share", "C:/Windows/system32", ".."]) {
      expect(isSafeEntryPath(path), path).toBe(false);
    }
  });

  it("accepts ordinary relative paths", () => {
    for (const path of ["bin/claude", "vendor/x86_64-unknown-linux-musl/bin/codex", "a.txt"]) {
      expect(isSafeEntryPath(path), path).toBe(true);
    }
  });

  it("is not fooled by a name that merely contains two dots", () => {
    expect(isSafeEntryPath("lib/foo..bar/baz")).toBe(true);
  });
});
