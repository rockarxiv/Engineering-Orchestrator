import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEWIKI } from "./catalog.js";
import { resolveCodeWiki } from "./resolve.js";

/**
 * Finding the CodeWiki binary (A-08).
 *
 * The order is the whole design, and it is the runtimes' order: an
 * explicit setting beats EO's exact managed download, and an ambient
 * `codewiki` on PATH is never selected at all.
 *
 * The other half of this file is absence. Repository intelligence
 * degrades rather than blocks, so every way of having nothing has to
 * arrive with a sentence a person can read — most concretely on Intel
 * Macs, where upstream publishes no build and never will for v0.2.1.
 *
 * Worth noting what is *not* here: there is no way to make resolution
 * download anything. `resolveCodeWiki` takes no `fetch`, so "no
 * download is attempted" is a property of its signature rather than
 * something a test has to catch it doing.
 */
let scratch: string;
let root: string;
let pathDir: string;

function place(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const full = join(directory, name);
  writeFileSync(full, "#!/bin/sh\n");
  chmodSync(full, 0o755);
  return full;
}

/** The managed copy, where a completed install would have left it. */
function placeCached(name = "codewiki"): string {
  return place(join(root, "codewiki@0.2.1"), name);
}

function resolve(overrides: Partial<Parameters<typeof resolveCodeWiki>[0]> = {}) {
  return resolveCodeWiki({ root, platform: "linux", arch: "x64", ...overrides });
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo codewiki resolve "));
  root = join(scratch, "repositoryIntelligence");
  pathDir = join(scratch, "bin");
  mkdirSync(pathDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("the order", () => {
  it("takes an explicit setting over everything else", () => {
    // The air-gapped answer, the corporate-managed-install answer, and
    // the "I know better than you" answer.
    placeCached();
    place(pathDir, "codewiki");

    expect(resolve({ configuredPath: "/opt/corp/codewiki" })).toEqual({
      source: "configured",
      path: "/opt/corp/codewiki",
      version: null,
      reason: null,
    });
  });

  it("takes an explicit setting even when that path is wrong", () => {
    // Telling someone their own setting was quietly ignored is worse
    // than failing loudly when it is spawned.
    const wrong = join(scratch, "does", "not", "exist", "codewiki");

    expect(resolve({ configuredPath: wrong })).toEqual({ source: "configured", path: wrong, version: null, reason: null });
  });

  it("honours an explicit setting on a platform upstream does not build for", () => {
    // Somebody who built it themselves on an Intel Mac is exactly the
    // person the setting exists for, so the unsupported answer must not
    // outrank it.
    expect(resolve({ platform: "darwin", arch: "x64", configuredPath: "/usr/local/bin/codewiki" })).toMatchObject({
      source: "configured",
      path: "/usr/local/bin/codewiki",
    });
  });

  it("reports EO's managed copy with the version it pinned", () => {
    const cached = placeCached();

    expect(resolve()).toEqual({ source: "cache", path: cached, version: "0.2.1", reason: null });
  });

  it("looks for the executable Windows actually ships", () => {
    const cached = placeCached("codewiki.exe");

    expect(resolve({ platform: "win32", arch: "x64" })).toMatchObject({ source: "cache", path: cached, version: "0.2.1" });
  });
});

describe("what is never selected", () => {
  it("ignores a codewiki on PATH", () => {
    // An ambient install is some other version, indexing into the same
    // `.codewiki/` directory EO's own syncs write to. EO runs the
    // version it tested.
    place(pathDir, "codewiki");

    expect(resolve()).toMatchObject({ source: "absent", path: null, version: null });
  });

  it("ignores a cache directory for a version EO no longer pins", () => {
    place(join(root, "codewiki@0.1.0"), "codewiki");

    expect(resolve().source).toBe("absent");
  });

  // Unix only, and not an oversight: `isExecutable` falls back to plain
  // existence on Windows precisely because the bit it would test does
  // not exist there.
  it.skipIf(process.platform === "win32")("ignores a file of the right name that is not executable", () => {
    mkdirSync(join(root, "codewiki@0.2.1"), { recursive: true });
    writeFileSync(join(root, "codewiki@0.2.1", "codewiki"), "not executable");
    chmodSync(join(root, "codewiki@0.2.1", "codewiki"), 0o644);

    expect(resolve().source).toBe("absent");
  });
});

describe("having nothing, and saying why", () => {
  it("says the download has not happened yet when the machine is supported", () => {
    const found = resolve();

    expect(found).toMatchObject({ source: "absent", path: null, version: null });
    expect(found.reason).toContain("has not downloaded");
    expect(found.reason).toContain("0.2.1");
  });

  it("names the platform on an Intel Mac, where there is nothing to download", () => {
    // The real instance of graceful degradation. Nothing is coming, so
    // "not downloaded yet" would be a lie — the caller needs the actual
    // reason to put in front of a person.
    const found = resolveCodeWiki({ root, platform: "darwin", arch: "x64" });

    expect(found).toMatchObject({ source: "absent", path: null, version: null });
    expect(found.reason).toContain("Intel Macs");
    expect(found.reason).toContain("darwin");
    expect(found.reason).toContain("x64");
  });

  it("prefers the unsupported reason over the cache, so the reason given is the true one", () => {
    // A directory left behind by a machine that once ran a supported
    // build must not turn "we will never have this" into "found it".
    place(join(root, "codewiki@0.2.1"), "codewiki");

    expect(resolveCodeWiki({ root, platform: "darwin", arch: "x64" }).source).toBe("absent");
  });

  it("carries a reason naming every unsupported pair, not only the Mac", () => {
    for (const [platform, arch] of [
      ["win32", "arm64"],
      ["linux", "ia32"],
      ["freebsd", "x64"],
    ] as Array<[NodeJS.Platform, string]>) {
      const found = resolveCodeWiki({ root, platform, arch });

      expect(found.source, `${platform} ${arch}`).toBe("absent");
      expect(found.reason, `${platform} ${arch}`).toContain(platform);
      expect(found.reason, `${platform} ${arch}`).toContain(arch);
    }
  });

  it("resolves against the version the catalogue pins, not a literal", () => {
    // If the pin moves, this test moves with it rather than passing
    // against a directory name nobody updated.
    const cached = place(join(root, `codewiki@${CODEWIKI.version}`), CODEWIKI.binaryName("linux"));

    expect(resolve()).toMatchObject({ source: "cache", path: cached, version: CODEWIKI.version });
  });
});
