import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureTar } from "../../../../testing/tar.js";
import { CODEWIKI } from "./catalog.js";
import {
  fetchChecksum,
  installCodeWiki,
  installDirectory,
  matchesSha256,
  parseChecksum,
  pruneSupersededInstalls,
  repositoryIntelligenceRoot,
  type FetchLike,
} from "./install.js";
import type { ZipExtractor } from "./zip.js";

/**
 * Fetching the CodeWiki binary (A-08).
 *
 * The subject is not "does it download". It is what happens when the
 * bytes are wrong, when the archive is hostile, when the publisher's
 * own digest is unreadable, and when the install dies halfway — because
 * what lands here is about to be executed against a user's repository.
 *
 * Nothing in this file touches the network: `fetch` is a parameter.
 */
let scratch: string;
let root: string;

/** A real gzipped tarball, built by GNU tar, shaped the way upstream ships one. */
function makeTarball(files: Record<string, string>, executable: string[] = []): Buffer {
  const source = join(scratch, "archive");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(source, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, { mode: executable.includes(path) ? 0o755 : 0o644 });
  }
  const out = join(scratch, "archive.tar.gz");
  // Entries at the archive root, with no wrapping directory — which is
  // exactly what `codewiki-x86_64-unknown-linux-gnu.tar.gz` contains.
  execFileSync(fixtureTar(), ["-czf", out, "-C", source, ...Object.keys(files)]);
  return readFileSync(out);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * GitHub Releases, serving one asset and the `.sha256` beside it.
 *
 * The digest is served in `sha256sum`'s own format, two spaces and the
 * filename included, because that is what upstream publishes and
 * parsing it is part of what is under test.
 */
function releases(archive: Buffer, overrides: { digest?: string; assetStatus?: number; checksumStatus?: number } = {}): FetchLike {
  return async (url) => {
    if (url.endsWith(".sha256")) {
      const name = url.slice(url.lastIndexOf("/") + 1, -".sha256".length);
      return new Response(`${overrides.digest ?? sha256(archive)}  ${name}\n`, { status: overrides.checksumStatus ?? 200 });
    }
    return new Response(archive, { status: overrides.assetStatus ?? 200 });
  };
}

/** Stands in for PowerShell: drops one file where Expand-Archive would have. */
function fakeUnzip(files: Record<string, string> = { "codewiki.exe": "MZ" }): ZipExtractor {
  return async (archive, destination) => {
    expect(existsSync(archive), "the zip has to be on disk for PowerShell to read it").toBe(true);
    mkdirSync(destination, { recursive: true });
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(destination, name), contents, { mode: 0o755 });
  };
}

/** Everything left in the install root, so leftovers cannot hide. */
function leftovers(): string[] {
  return existsSync(root) ? readdirSync(root).sort() : [];
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki "));
  root = join(scratch, "repositoryIntelligence");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("installing", () => {
  it("unpacks the binary and reports where it landed", async () => {
    const archive = makeTarball({ codewiki: "#!/bin/sh\necho 'codewiki 0.2.1'\n" }, ["codewiki"]);

    const result = await installCodeWiki({ root, fetchImpl: releases(archive), platform: "linux", arch: "x64" });

    expect(result).toMatchObject({ ok: true, problem: null });
    expect(result.binaryPath).toBe(join(root, "codewiki@0.2.1", "codewiki"));
    expect(existsSync(result.binaryPath!)).toBe(true);
    expect(leftovers()).toEqual(["codewiki@0.2.1"]);
  });

  // Windows has no execute bit — `chmod` is a no-op there and
  // `resolve.ts` treats existing as executable instead. The assertion is
  // about a Unix permission, so it is made where one exists.
  it.skipIf(process.platform === "win32")("makes the binary executable", async () => {
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);

    const result = await installCodeWiki({ root, fetchImpl: releases(archive), platform: "linux", arch: "x64" });

    expect(statSync(result.binaryPath!).mode & 0o111).toBeGreaterThan(0);
  });

  it("selects the asset for the platform it was asked about", async () => {
    const asked: string[] = [];
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);
    const served = releases(archive);
    const fetchImpl: FetchLike = (url, init) => {
      asked.push(url);
      return served(url, init);
    };

    await installCodeWiki({ root, fetchImpl, platform: "darwin", arch: "arm64" });

    expect(asked.every((url) => url.includes("codewiki-aarch64-apple-darwin.tar.gz"))).toBe(true);
    // Pinned, at both URLs it touches.
    expect(asked.every((url) => url.includes("/releases/download/v0.2.1/"))).toBe(true);
    expect(asked.some((url) => url.includes("latest"))).toBe(false);
  });

  it("reports how much arrived", async () => {
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);
    const seen: Array<[number, number]> = [];

    await installCodeWiki({
      root,
      fetchImpl: releases(archive),
      platform: "linux",
      arch: "x64",
      onProgress: (received, total) => seen.push([received, total]),
    });

    expect(seen.at(-1)).toEqual([archive.length, archive.length]);
  });
});

describe("verifying what arrived", () => {
  it("discards an archive whose bytes do not match the published digest", async () => {
    // The whole supply-chain story in one test. If this passes wrongly,
    // EO downloads and executes whatever it is handed.
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20]! ^ 0xff) & 0xff;

    // The release advertises the *original* digest; the download serves
    // the tampered bytes.
    const result = await installCodeWiki({ root, fetchImpl: releases(tampered, { digest: sha256(archive) }), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("did not match the SHA-256 checksum");
    // Nothing at all, not even a `.partial` — the check happens before
    // the first write.
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a checksum file that is not a digest rather than installing anyway", async () => {
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);

    const result = await installCodeWiki({ root, fetchImpl: releases(archive, { digest: "404: Not Found" }), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("cannot be verified");
    expect(existsSync(root)).toBe(false);
  });

  it("refuses when the digest cannot be fetched at all", async () => {
    const archive = makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);

    const result = await installCodeWiki({ root, fetchImpl: releases(archive, { checksumStatus: 404 }), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("404");
    expect(existsSync(root)).toBe(false);
  });

  it("reads the digest and nothing else out of a sha256sum file", () => {
    const digest = "d5748f145f13749746218562922578e47f39fb035419e6d8f205f2c0457697cf";

    expect(parseChecksum(`${digest}  codewiki-x86_64-unknown-linux-gnu.tar.gz\n`)).toBe(digest);
    expect(parseChecksum(`${digest.toUpperCase()}\n`)).toBe(digest);
    // Fails closed. "Could not parse" must never become "install it anyway".
    expect(parseChecksum("")).toBeNull();
    expect(parseChecksum("not a digest")).toBeNull();
    expect(parseChecksum(`${digest.slice(0, 63)}\n`)).toBeNull();
    expect(parseChecksum("<html>404: Not Found</html>")).toBeNull();
  });

  it("compares against the digest it was given, not one it chose", () => {
    const bytes = Buffer.from("some bytes");

    expect(matchesSha256(bytes, sha256(bytes))).toBe(true);
    expect(matchesSha256(bytes, sha256(bytes).toUpperCase())).toBe(true);
    expect(matchesSha256(bytes, sha256(Buffer.from("other bytes")))).toBe(false);
  });

  it("asks for the digest published beside the pinned asset", async () => {
    const asked: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      asked.push(url);
      return new Response(`${"a".repeat(64)}  x\n`, { status: 200 });
    };

    await fetchChecksum(fetchImpl, CODEWIKI, "codewiki-x86_64-unknown-linux-gnu.tar.gz");

    expect(asked).toEqual(["https://github.com/0xsyncroot/codewiki/releases/download/v0.2.1/codewiki-x86_64-unknown-linux-gnu.tar.gz.sha256"]);
  });

  it("refuses an archive that tries to write outside its directory", async () => {
    // GNU tar will not build this one, so the archive is assembled by
    // hand — which is the only way to test a hostile tarball. The check
    // is `isSafeEntryPath` from `runtimes/tar.ts`, not a second copy.
    const header = Buffer.alloc(512);
    header.write("../../escaped", 0);
    header.write("000644 \0", 100);
    header.write("00000000004\0", 124);
    header.write("0", 156);
    header.write("        ", 148);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(512);
    body.write("evil");
    const tar = Buffer.concat([header, body, Buffer.alloc(1024)]);
    const gzipped = execFileSync("gzip", ["-c"], { input: tar, encoding: "buffer" });

    const result = await installCodeWiki({ root, fetchImpl: releases(gzipped), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("unsafe path");
    expect(existsSync(join(scratch, "escaped"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe("the Windows zip", () => {
  it("stages the archive, expands it, and leaves neither behind", async () => {
    const archive = Buffer.from("PK pretend this is a zip");

    const result = await installCodeWiki({ root, fetchImpl: releases(archive), platform: "win32", arch: "x64", unzip: fakeUnzip() });

    expect(result).toMatchObject({ ok: true, problem: null });
    expect(result.binaryPath).toBe(join(root, "codewiki@0.2.1", "codewiki.exe"));
    // The downloaded `.zip` is a means, not an artefact.
    expect(leftovers()).toEqual(["codewiki@0.2.1"]);
  });

  it("expands into a .partial path and renames it into place", async () => {
    // An install killed halfway must not leave something resolution
    // would mistake for a working binary, which is what the rename buys.
    const archive = Buffer.from("PK");
    let destination: string | null = null;
    const unzip: ZipExtractor = async (archivePath, into) => {
      destination = into;
      expect(existsSync(join(root, "codewiki@0.2.1")), "nothing is in place until the rename").toBe(false);
      await fakeUnzip()(archivePath, into);
    };

    await installCodeWiki({ root, fetchImpl: releases(archive), platform: "win32", arch: "x64", unzip });

    expect(destination).toBe(join(root, "codewiki@0.2.1.partial"));
  });

  it("cleans up after PowerShell refuses", async () => {
    const archive = Buffer.from("PK");
    const unzip: ZipExtractor = async () => {
      throw new Error("Expand-Archive : The archive file is corrupted");
    };

    const result = await installCodeWiki({ root, fetchImpl: releases(archive), platform: "win32", arch: "x64", unzip });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("corrupted");
    expect(leftovers()).toEqual([]);
  });

  it("says so when the zip did not contain the executable", async () => {
    const archive = Buffer.from("PK");

    const result = await installCodeWiki({
      root,
      fetchImpl: releases(archive),
      platform: "win32",
      arch: "x64",
      unzip: fakeUnzip({ "README.md": "docs" }),
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("will not guess");
    expect(leftovers()).toEqual([]);
  });
});

describe("when there is nothing to fetch", () => {
  it("does not touch the network on a platform upstream does not build for", async () => {
    // Intel Macs are the real instance of this, and the answer is a
    // sentence rather than a retry.
    const fetchImpl: FetchLike = async () => {
      throw new Error("the network must not be reached for a platform with no published asset");
    };

    const result = await installCodeWiki({ root, fetchImpl, platform: "darwin", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Intel Macs");
    expect(result.problem).toContain("darwin");
    expect(existsSync(root)).toBe(false);
  });

  it("refuses every other unsupported pair without downloading either", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };

    for (const [platform, arch] of [
      ["win32", "arm64"],
      ["linux", "ia32"],
      ["freebsd", "x64"],
    ] as Array<[NodeJS.Platform, string]>) {
      const result = await installCodeWiki({ root, fetchImpl, platform, arch });
      expect(result.ok, `${platform} ${arch}`).toBe(false);
      expect(result.problem, `${platform} ${arch}`).toContain(platform);
    }
    expect(existsSync(root)).toBe(false);
  });
});

describe("when it goes wrong halfway", () => {
  it("leaves nothing resolution would mistake for a working binary", async () => {
    // An archive that unpacks but has no binary is the closest thing to
    // an interrupted install this can produce deterministically.
    const result = await installCodeWiki({ root, fetchImpl: releases(makeTarball({ "README.md": "docs" })), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("replaces a previous install rather than merging with it", async () => {
    const stale = join(root, "codewiki@0.2.1");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "leftover.txt"), "from a previous version");

    await installCodeWiki({ root, fetchImpl: releases(makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"])), platform: "linux", arch: "x64" });

    expect(readdirSync(stale)).toEqual(["codewiki"]);
  });

  it("reports a download that will not arrive, rather than throwing", async () => {
    const result = await installCodeWiki({ root, fetchImpl: releases(Buffer.alloc(4), { assetStatus: 503 }), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("503");
  });

  it("reports a network that is simply not there", async () => {
    const result = await installCodeWiki({
      root,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("fetch failed");
  });

  it("reports a body that is not a gzipped archive at all", async () => {
    const notAnArchive = Buffer.from("<html>504 Gateway Timeout</html>");

    const result = await installCodeWiki({ root, fetchImpl: releases(notAnArchive), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("Installing CodeWiki failed");
    expect(leftovers()).toEqual([]);
  });
});

/**
 * A copy of a version EO no longer pins, as a real directory with real
 * bytes in it — the 30 MB this story is about.
 */
function supersede(version: string, name = "codewiki"): string {
  const directory = join(root, `codewiki@${version}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), "#!/bin/sh\necho 'a version EO used to pin'\n", { mode: 0o755 });
  return directory;
}

/** A working tarball, shaped the way upstream ships one. */
function goodTarball(): Buffer {
  return makeTarball({ codewiki: "#!/bin/sh\n" }, ["codewiki"]);
}

describe("versions this one supersedes (EO-158)", () => {
  it("collects the previous version once the new one is in place", async () => {
    // The bug, stated: a pin that moves installs beside its predecessor
    // and leaves it there for good.
    supersede("0.1.9");

    const result = await installCodeWiki({ root, fetchImpl: releases(goodTarball()), platform: "linux", arch: "x64" });

    expect(result).toMatchObject({ ok: true, problem: null });
    expect(leftovers()).toEqual(["codewiki@0.2.1"]);
  });

  it("keeps the older copy when the replacement did not verify", async () => {
    // The property inherited from `cleanupSuperseded`: an older-only
    // cache is retained, so a failed replacement stays recoverable. A
    // machine that deleted 0.1.9 here would have no repository
    // intelligence at all, when 0.1.9 was working perfectly well.
    const stale = supersede("0.1.9");

    const result = await installCodeWiki({
      root,
      fetchImpl: releases(goodTarball(), { digest: "0".repeat(64) }),
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(false);
    expect(leftovers()).toEqual(["codewiki@0.1.9"]);
    expect(existsSync(join(stale, "codewiki"))).toBe(true);
  });

  it("keeps the older copy when the machine is offline", async () => {
    const stale = supersede("0.1.9");

    const result = await installCodeWiki({
      root,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(false);
    expect(existsSync(join(stale, "codewiki"))).toBe(true);
  });

  it("collects an older install's litter as well as the install itself", () => {
    supersede("0.1.9");
    mkdirSync(join(root, "codewiki@0.1.9.partial"), { recursive: true });
    writeFileSync(join(root, "codewiki@0.1.8.download"), "half a zip");
    mkdirSync(join(root, "codewiki@0.2.1"), { recursive: true });

    expect(pruneSupersededInstalls(root).sort()).toEqual(["codewiki@0.1.8.download", "codewiki@0.1.9", "codewiki@0.1.9.partial"]);
    expect(leftovers()).toEqual(["codewiki@0.2.1"]);
  });

  it("leaves the scratch names a concurrent install of the pinned version is writing", () => {
    // Same pin, mid-flight. `.partial` and `.download` belong to that
    // install; taking them out from under it would fail it for nothing.
    mkdirSync(join(root, "codewiki@0.2.1.partial"), { recursive: true });
    writeFileSync(join(root, "codewiki@0.2.1.download"), "PK");

    expect(pruneSupersededInstalls(root)).toEqual([]);
    expect(leftovers()).toEqual(["codewiki@0.2.1.download", "codewiki@0.2.1.partial"]);
  });

  it("touches nothing EO did not write", () => {
    mkdirSync(join(root, "codewiki-notes"), { recursive: true });
    writeFileSync(join(root, "README.txt"), "somebody's file");

    expect(pruneSupersededInstalls(root)).toEqual([]);
    expect(leftovers()).toEqual(["README.txt", "codewiki-notes"]);
  });

  it("removes nothing, and says so, when there is no root yet", () => {
    expect(pruneSupersededInstalls(join(scratch, "never-downloaded-anything"))).toEqual([]);
  });

  // Running as root ignores the permission bits this uses to make a
  // delete refuse, and Windows has no equivalent to set — but Windows is
  // the platform the behaviour is *for*, so the skip is honest about
  // being a limitation of the harness rather than of the code.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves a copy it cannot delete for a later call, rather than failing",
    async () => {
      // What a running `codewiki serve --mcp` does on Windows: the file
      // is locked and the unlink refuses. An agent mid-run must not turn
      // a completed install into a reported failure.
      supersede("0.1.9");
      chmodSync(root, 0o500);
      try {
        expect(pruneSupersededInstalls(root)).toEqual([]);
        expect(existsSync(join(root, "codewiki@0.1.9"))).toBe(true);
      } finally {
        chmodSync(root, 0o755);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("still reports an install that worked when the collection could not", async () => {
    supersede("0.1.9");
    // Writable enough to install into, then locked before the prune —
    // which cannot be arranged from outside, so the refusal is aimed at
    // the one directory instead. `rmSync` needs write on the parent of
    // what it unlinks, so a read-only *child* is enough.
    const nested = join(root, "codewiki@0.1.9", "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "held-open"), "an agent still has this");
    chmodSync(nested, 0o500);

    try {
      const result = await installCodeWiki({ root, fetchImpl: releases(goodTarball()), platform: "linux", arch: "x64" });

      expect(result).toMatchObject({ ok: true, problem: null });
      expect(result.binaryPath).toBe(join(root, "codewiki@0.2.1", "codewiki"));
      expect(leftovers()).toContain("codewiki@0.1.9");
    } finally {
      chmodSync(nested, 0o755);
    }
  });
});

describe("where things live", () => {
  it("keeps its downloads beside the runtimes rather than inside the app bundle", () => {
    // The macOS bundle is signed and read-only, and a per-user
    // directory means an EO update never clobbers a binary a run is
    // using.
    expect(repositoryIntelligenceRoot(join("/tmp", "userData"))).toBe(join("/tmp", "userData", "repositoryIntelligence"));
    expect(installDirectory("/root", CODEWIKI)).toBe(join("/root", "codewiki@0.2.1"));
  });
});
