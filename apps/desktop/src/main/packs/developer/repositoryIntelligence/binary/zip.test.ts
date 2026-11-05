import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandArchive, expandArchiveArgs, WINDOWS_TAR, windowsTarPath, ZipError } from "./zip.js";

/**
 * Unpacking the Windows build (A-08).
 *
 * Upstream ships `.zip` for Windows and `.tar.gz` everywhere else, and
 * `runtimes/tar.ts` reads gzipped tar only. The answer is the
 * `Expand-Archive` cmdlet that has been in the box since PowerShell
 * 5.1 — because the alternative is an archive dependency carried by
 * every platform for one platform's one file, and CLAUDE.md forbids
 * adding one no story named.
 *
 * Most of what can be got wrong here is in the argument vector, so that
 * is separated out and asserted on everywhere. The round trip runs
 * where PowerShell exists and is skipped where it does not.
 */
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki zip "));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the argument vector", () => {
  it("expands the archive into a fresh destination, replacing a partial retry", () => {
    expect(expandArchiveArgs("C:\\eo\\codewiki.download", "C:\\eo\\codewiki@0.2.1.partial")).toEqual([
      "-xf",
      "C:\\eo\\codewiki.download",
      "-C",
      "C:\\eo\\codewiki@0.2.1.partial",
    ]);
  });

  it("keeps spaces, brackets and quotes in individual argv entries", () => {
    const archive = "C:\\Ann's files\\EO [beta]\\codewiki.download";
    const destination = "C:\\Ann's files\\EO [beta]\\out.partial";
    expect(expandArchiveArgs(archive, destination)).toEqual(["-xf", archive, "-C", destination]);
  });

});

// EO-389. A bare `tar.exe` is whichever one PATH finds first, and under
// Git Bash that is Git's GNU tar, which reads `C:\...` as a remote host.
// These are string assertions through `path.win32`, so they hold on the
// Linux CI as well as on the Windows runner.
describe("which tar is run", () => {
  it("names the system tar by its absolute path under System32", () => {
    const tar = windowsTarPath({ SystemRoot: "C:\\Windows" });

    expect(tar).toBe("C:\\Windows\\System32\\tar.exe");
    expect(win32.isAbsolute(tar)).toBe(true);
  });

  it("follows SystemRoot when Windows is installed somewhere else", () => {
    expect(windowsTarPath({ SystemRoot: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\tar.exe");
    // A copied environment may carry the upper-case spelling Windows itself uses.
    expect(windowsTarPath({ SYSTEMROOT: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\tar.exe");
  });

  it("falls back to C:\\Windows when SystemRoot is unset", () => {
    const tar = windowsTarPath({});

    expect(tar).toBe("C:\\Windows\\System32\\tar.exe");
    expect(win32.isAbsolute(tar)).toBe(true);
  });

  it("treats an empty or relative SystemRoot as unset rather than resolving against the working directory", () => {
    expect(windowsTarPath({ SystemRoot: "" })).toBe("C:\\Windows\\System32\\tar.exe");
    expect(windowsTarPath({ SystemRoot: "Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("never resolves to a bare name that PATH would decide", () => {
    for (const env of [{}, { SystemRoot: "" }, { SystemRoot: "C:\\Windows" }, { PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32" }]) {
      const tar = windowsTarPath(env);
      expect(win32.isAbsolute(tar)).toBe(true);
      expect(win32.basename(tar)).toBe("tar.exe");
      expect(win32.basename(win32.dirname(tar))).toBe("System32");
    }
  });

  it("is what expandArchive runs, resolved from this process's environment", () => {
    expect(WINDOWS_TAR).toBe(windowsTarPath(process.env));
    expect(win32.isAbsolute(WINDOWS_TAR)).toBe(true);
    expect(WINDOWS_TAR.endsWith("\\System32\\tar.exe")).toBe(true);
  });
});

describe("no dependency was added for it", () => {
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
  const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("carries no archive library in the desktop workspace", () => {
    // The point of shelling out. If one of these ever appears, this
    // module should be rewritten to use it rather than both existing.
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };

    for (const name of ["adm-zip", "yauzl", "jszip", "unzipper", "extract-zip", "node-stream-zip", "archiver", "tar", "tar-stream", "decompress"]) {
      expect(declared[name], `${name} should not be a dependency`).toBeUndefined();
    }
  });
});

// PowerShell is a Windows fact. The release runs this suite on a hosted
// Windows runner, which is where this actually proves anything; on Linux
// and macOS it is skipped rather than failed.
describe.skipIf(process.platform !== "win32")("expanding a real archive", () => {
  // A stored ZIP containing `codewiki.exe` with the contents asserted
  // below. Keeping the fixture as bytes avoids using Compress-Archive to
  // prepare the test: that cmdlet is exactly what hangs on hosted Windows
  // runners, so it cannot be trusted to prove the reader.
  const ARCHIVE = "UEsDBBQAAAAAAAAAAACGwYYGGwAAABsAAAAMAAAAY29kZXdpa2kuZXhlTVogcHJldGVuZCB0aGlzIGlzIGEgYmluYXJ5UEsBAhQAFAAAAAAAAAAAAIbBhgYbAAAAGwAAAAwAAAAAAAAAAAAAAAAAAAAAAGNvZGV3aWtpLmV4ZVBLBQYAAAAAAQABADoAAABFAAAAAAA=";

  function compress(files: Record<string, string>): string {
    expect(files).toEqual({ "codewiki.exe": "MZ pretend this is a binary" });
    const archive = join(scratch, "codewiki.zip");
    writeFileSync(archive, Buffer.from(ARCHIVE, "base64"));
    return archive;
  }

  it("puts the archive's files where it was told to", async () => {
    const archive = compress({ "codewiki.exe": "MZ pretend this is a binary" });
    const destination = join(scratch, "codewiki@0.2.1.partial");

    await expandArchive(archive, destination);

    expect(readdirSync(destination)).toEqual(["codewiki.exe"]);
    expect(readFileSync(join(destination, "codewiki.exe"), "utf8")).toBe("MZ pretend this is a binary");
  });

  it("throws a ZipError rather than resolving when the archive is not one", async () => {
    // `install.ts` turns this into a problem string and cleans up. It
    // can only do that if the failure actually arrives.
    const notAnArchive = join(scratch, "broken.zip");
    writeFileSync(notAnArchive, "this is not a zip file");

    await expect(expandArchive(notAnArchive, join(scratch, "out"))).rejects.toBeInstanceOf(ZipError);
    expect(existsSync(join(scratch, "out", "codewiki.exe"))).toBe(false);
  });
});
