import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureTar } from "../testing/tar.js";
import { RUNTIMES, versionFor } from "./catalog.js";
import { installRuntime, matchesIntegrity, resolveRelease, type FetchLike } from "./install.js";

/**
 * Fetching an agent runtime (A-08).
 *
 * The subject is not "does it download" — it is what happens when the
 * bytes are wrong, when the archive is hostile, and when the download
 * dies halfway. A binary that arrives over the network and is executed
 * is the most dangerous thing this application does.
 */
let scratch: string;
let root: string;

/** A real gzipped tarball, built by GNU tar, shaped like the npm package. */
function makeTarball(files: Record<string, string>, executable: string[] = []): Buffer {
  const source = join(scratch, "package");
  rmSync(source, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(source, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, { mode: executable.includes(path) ? 0o755 : 0o644 });
  }
  const out = join(scratch, "package.tgz");
  execFileSync(fixtureTar(), ["-czf", out, "-C", scratch, "package"]);
  return execFileSync("cat", [out], { encoding: "buffer" });
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** A registry that serves one package: the packument, then the tarball. */
function registry(tarball: Buffer, overrides: { integrity?: string; version?: string } = {}): FetchLike {
  const version = overrides.version ?? CLAUDE_VERSION;
  return async (url) => {
    if (url.includes("registry.npmjs.org") && !url.endsWith(".tgz")) {
      return new Response(
        JSON.stringify({
          versions: {
            [version]: { dist: { tarball: "https://registry.npmjs.org/pkg/-/pkg.tgz", integrity: overrides.integrity ?? integrityOf(tarball), unpackedSize: tarball.length } },
          },
        }),
        { status: 200 },
      );
    }
    return new Response(tarball, { status: 200 });
  };
}

const claude = RUNTIMES.claude;

// Read off the catalog rather than restated. These tests are about what
// happens to the bytes, not about which release they came from, and a
// literal here is a file that has to be edited every time the pin moves
// — which is how a fixture ends up describing a version nobody ships.
const CLAUDE_VERSION = versionFor(claude, "linux", "x64")!;
const CODEX_VERSION = versionFor(RUNTIMES.codex, "linux", "x64")!;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "eo runtime "));
  root = join(scratch, "runtimes");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("installing", () => {
  it("unpacks the runtime and reports where the executable landed", async () => {
    const tarball = makeTarball({ claude: "#!/bin/sh\necho hi\n", "README.md": "docs" }, ["claude"]);

    const result = await installRuntime({ spec: claude, root, fetchImpl: registry(tarball), platform: "linux", arch: "x64" });

    expect(result).toMatchObject({ ok: true, problem: null });
    expect(result.binaryPath).toBe(join(root, `claude@${CLAUDE_VERSION}`, "claude"));
    expect(existsSync(result.binaryPath!)).toBe(true);
  });

  // Windows has no execute bit, and `install.ts` knows it — the chmod is a
  // no-op there and `resolve.ts` treats existing as executable instead. The
  // assertion is about a Unix permission, so it is asserted where it exists.
  it.skipIf(process.platform === "win32")("makes the executable executable", async () => {
    // A CLI that is not executable is not a CLI, and the archive's own
    // mode bits do not survive being written naively.
    const tarball = makeTarball({ claude: "#!/bin/sh\n" }, ["claude"]);

    const result = await installRuntime({ spec: claude, root, fetchImpl: registry(tarball), platform: "linux", arch: "x64" });

    expect(statSync(result.binaryPath!).mode & 0o111).toBeGreaterThan(0);
  });

  it("finds a binary buried under a vendor directory", async () => {
    // Codex hides its executable under vendor/<target-triple>/bin/,
    // which is why resolution searches for the name rather than
    // encoding six Rust target triples that change without warning.
    const tarball = makeTarball({ "vendor/x86_64-unknown-linux-musl/bin/codex": "#!/bin/sh\n" }, ["vendor/x86_64-unknown-linux-musl/bin/codex"]);

    const result = await installRuntime({
      spec: RUNTIMES.codex,
      root,
      fetchImpl: registry(tarball, { version: CODEX_VERSION }),
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(true);
    expect(result.binaryPath).toContain(join("vendor", "x86_64-unknown-linux-musl", "bin", "codex"));
  });

  it("says so rather than guessing when the package has no such binary", async () => {
    const result = await installRuntime({ spec: claude, root, fetchImpl: registry(makeTarball({ "README.md": "docs" })), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("will not guess");
    expect(existsSync(join(root, `claude@${CLAUDE_VERSION}`))).toBe(false);
  });

  it("refuses a platform nobody publishes a build for", async () => {
    const result = await installRuntime({ spec: claude, root, fetchImpl: registry(Buffer.alloc(0)), platform: "freebsd" as NodeJS.Platform, arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("does not publish a build");
  });
});

describe("verifying what arrived", () => {
  it("discards a tarball whose bytes do not match the published checksum", async () => {
    // The whole supply-chain story in one test. If this passes wrongly,
    // EO downloads and executes whatever it is handed.
    const tarball = makeTarball({ claude: "#!/bin/sh\n" }, ["claude"]);
    const tampered = Buffer.from(tarball);
    tampered[tampered.length - 20] = (tampered[tampered.length - 20]! ^ 0xff) & 0xff;

    const result = await installRuntime({
      spec: claude,
      root,
      // The packument advertises the *original* hash; the download
      // serves the tampered bytes.
      fetchImpl: registry(tampered, { integrity: integrityOf(tarball) }),
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("did not match the checksum");
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a version that publishes no integrity hash at all", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith(".tgz")
        ? new Response(Buffer.alloc(10), { status: 200 })
        : new Response(JSON.stringify({ versions: { [CLAUDE_VERSION]: { dist: { tarball: "https://x/-/x.tgz" } } } }), { status: 200 });

    const result = await installRuntime({ spec: claude, root, fetchImpl, platform: "linux", arch: "x64" });

    expect(result.problem).toContain("cannot be verified");
  });

  it("checks the hash the registry named, not one it chose", () => {
    const bytes = Buffer.from("some bytes");
    expect(matchesIntegrity(bytes, integrityOf(bytes))).toBe(true);
    expect(matchesIntegrity(bytes, "sha512-AAAA")).toBe(false);
    // An unrecognised or absent algorithm must fail closed.
    expect(matchesIntegrity(bytes, "md5-whatever")).toBe(false);
    expect(matchesIntegrity(bytes, "nonsense")).toBe(false);
  });

  it("refuses an archive that tries to write outside its directory", async () => {
    // GNU tar will not build this one, so the archive is assembled by
    // hand — which is the only way to test a hostile tarball.
    const header = Buffer.alloc(512);
    header.write("package/../../escaped", 0);
    header.write("000644 \0", 100);
    header.write("00000000004\0", 124);
    header.write("0", 156);
    // Checksum field must be spaces while computing, then the octal sum.
    header.write("        ", 148);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(512);
    body.write("evil");
    const tar = Buffer.concat([header, body, Buffer.alloc(1024)]);
    const gzipped = execFileSync("gzip", ["-c"], { input: tar, encoding: "buffer" });

    const result = await installRuntime({ spec: claude, root, fetchImpl: registry(gzipped), platform: "linux", arch: "x64" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("unsafe path");
    expect(existsSync(join(scratch, "escaped"))).toBe(false);
  });
});

describe("when it goes wrong halfway", () => {
  it("leaves nothing resolution would mistake for a working runtime", async () => {
    // A tarball that unpacks but has no binary is the closest thing to
    // an interrupted download this can produce deterministically.
    await installRuntime({ spec: claude, root, fetchImpl: registry(makeTarball({ "README.md": "x" })), platform: "linux", arch: "x64" });

    const leftovers = existsSync(root) ? readdirSync(root) : [];
    expect(leftovers.filter((name) => !name.endsWith(".partial"))).toEqual([]);
    expect(leftovers.some((name) => name.endsWith(".partial"))).toBe(false);
  });

  it("reports a registry that will not answer, rather than throwing", async () => {
    const result = await installRuntime({
      spec: claude,
      root,
      fetchImpl: async () => new Response("nope", { status: 503 }),
      platform: "linux",
      arch: "x64",
    });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("503");
  });

  it("reports a network that is simply not there", async () => {
    const result = await installRuntime({
      spec: claude,
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
});

describe("reading the registry", () => {
  it("asks for the pinned version and never for latest", async () => {
    // Pinning is the point: a bump arrives with an EO release, having
    // been tested, rather than landing on every user at once.
    const asked: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      asked.push(url);
      return new Response(
        JSON.stringify({ "dist-tags": { latest: "9.9.9" }, versions: { [CLAUDE_VERSION]: { dist: { tarball: "t", integrity: "sha512-x" } } } }),
        { status: 200 },
      );
    };

    const release = await resolveRelease(fetchImpl, "@anthropic-ai/claude-agent-sdk-linux-x64", CLAUDE_VERSION);

    expect(release.tarball).toBe("t");
    expect(asked[0]).toContain("%2F"); // the scope is encoded, or the registry 404s
  });

  it("says plainly when the pinned version has been unpublished", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ versions: {} }), { status: 200 });

    await expect(resolveRelease(fetchImpl, "@scope/pkg", "1.0.0")).rejects.toThrow("not published");
  });
});
