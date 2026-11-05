import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractTar, isSafeEntryPath, TarError } from "../../../../runtimes/tar.js";
import type { FetchLike } from "../../../../runtimes/install.js";
import { assetUrl, checksumUrl, unsupportedReason, CODEWIKI, type CodeWikiSpec } from "./catalog.js";
import { expandArchive, ZipError, type ZipExtractor } from "./zip.js";

/**
 * Fetching the CodeWiki binary (A-08).
 *
 * The order is the whole security story, and it is the order
 * `runtimes/install.ts` uses: read the publisher's own digest,
 * download, **verify before anything is written or made executable**,
 * and only then unpack. A binary that arrives over the network and is
 * executed unchecked is a supply-chain hole.
 *
 * What differs from the runtimes is only where the digest comes from.
 * npm publishes `dist.integrity` inside the packument; GitHub Releases
 * publishes a `<asset>.sha256` file beside the archive, in the format
 * `sha256sum` writes — `<hex>  <filename>`.
 *
 * The tar targets are unpacked with `extractTar`/`isSafeEntryPath` from
 * `runtimes/tar.ts`. There is exactly one tar reader in this
 * repository and this module is not the place for a second one.
 *
 * `fetch` is a parameter, the seam this codebase uses everywhere, so
 * none of this needs the network to test.
 */

export type { FetchLike };

export interface InstallResult {
  ok: boolean;
  /** Absolute path to the executable, once it is in place. */
  binaryPath: string | null;
  problem: string | null;
}

/**
 * The root everything this subsystem downloads lives under, from
 * Electron's userData path.
 *
 * A sibling of `runtimeRoot`, and outside the app bundle for the same
 * reasons: the macOS bundle is signed and read-only, and a per-user
 * directory means an EO update never clobbers a binary a run is
 * currently using.
 */
export function repositoryIntelligenceRoot(userDataPath: string): string {
  return join(userDataPath, "repositoryIntelligence");
}

/**
 * The same root for a caller with no `userData` to derive one from: a
 * test, or the v1 gate, that builds an engine and passes no path
 * (EO-157).
 *
 * Being outside every worktree is the requirement — `verify.ts` fails a
 * run whose checkout is not clean, and a downloaded binary would make
 * one dirty. A scratch directory meets it. `~/.eo/repositoryIntelligence`,
 * which is what two separate copies of this fallback used to say, meets
 * it too and costs something a scratch directory does not: a test run
 * that enables the feature and passes no root fetches 46 MB into the
 * developer's home, and leaves it there.
 *
 * One spelling, for the reason `createEngine` gives about the root
 * itself. Two copies of a default are two things to change, and the one
 * that is missed is a cache the rest of EO cannot see. Nothing shipped
 * resolves this — `main/index.ts` passes
 * `repositoryIntelligenceRoot(userData)` and the settings screen asks
 * the same function — so anything found underneath it was put there by
 * a test.
 *
 * A fixed name rather than a fresh directory per process, so that a
 * suite which does reach it downloads once rather than once a run.
 */
export function fallbackRepositoryIntelligenceRoot(): string {
  return join(tmpdir(), "eo-repositoryIntelligence");
}

/** Where one pinned version lands: one directory per version, never shared. */
export function installDirectory(root: string, spec: CodeWikiSpec): string {
  return join(root, `${spec.id}@${spec.version}`);
}

/**
 * Removes the copies the pinned version has superseded (EO-158).
 *
 * Every version gets a directory of its own, and `resolve.ts` looks
 * only for the one the catalogue currently pins. So a version bump
 * installs beside its predecessor and leaves it there: never resolved
 * again, never read again, ~30 MB in a folder nobody has reason to
 * open, once per release that moves the pin. This is what collects it,
 * and it is deliberately the same thing `cleanupSuperseded` in
 * `ipc/runtimeCommands.ts` does for the agent runtimes rather than a
 * second idea about the same problem.
 *
 * Two properties come with that precedent and both are load-bearing.
 *
 * **It is only ever called once a complete current version exists.**
 * Deleting the old copy before the new one is downloaded and verified
 * turns a failed or offline update into no repository intelligence at
 * all, when the old copy would have gone on working perfectly well. So
 * the install calls this after the rename and never before it, and the
 * cached-hit path calls it having just resolved a working binary.
 *
 * **A delete that refuses is not a failure.** `agentServer.ts` keeps a
 * `codewiki serve --mcp` process alive for the length of an agent run,
 * and those outlive an install. Unlinking a running executable is
 * harmless on Linux and macOS, where the inode survives until the last
 * handle closes, and impossible on Windows, where the file is locked.
 * A copy that survives today because an agent was mid-run is collected
 * the next time round — not retried in a loop, and not reported as a
 * problem with an install that worked. Nothing here throws, for that
 * reason: housekeeping must not be able to fail a completed install.
 *
 * What it will not touch is anything EO did not write. The scan is
 * bounded to names beginning `codewiki@`, inside `root` and no deeper,
 * and the three paths the pinned version's own install owns are kept —
 * its directory and the two scratch names beside it, because a
 * concurrent install of the same pin is part-way through writing them.
 *
 * Answers with what it actually removed, so a test can tell "collected
 * nothing" from "found nothing to collect".
 */
export function pruneSupersededInstalls(root: string, spec: CodeWikiSpec = CODEWIKI): string[] {
  const current = basename(installDirectory(root, spec));
  const keep = new Set([current, `${current}.partial`, `${current}.download`]);

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // A root that is not there holds nothing to collect, and one EO
    // cannot read is not EO's to guess about. Both removed nothing.
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(`${spec.id}@`) || keep.has(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Windows, holding a superseded executable open for an agent that
      // is still running. Left exactly where it is for a later call.
    }
  }
  return removed;
}

/**
 * The digest out of a `sha256sum`-format file.
 *
 * Only the first field is read, and it has to look like a SHA-256 or it
 * is refused. Failing closed matters more here than being generous:
 * "could not parse the checksum" must never degrade into "install it
 * anyway".
 */
export function parseChecksum(text: string): string | null {
  const token = text.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null;
}

/** Do these bytes hash to what the publisher said they would? */
export function matchesSha256(bytes: Buffer, expected: string): boolean {
  return createHash("sha256").update(bytes).digest("hex") === expected.toLowerCase();
}

/**
 * The published digest for one asset of the pinned release.
 *
 * Asks for an exact tag rather than `releases/latest`, for the reason
 * the catalogue pins in the first place — the point of a pin is that
 * nobody's release schedule but ours changes what a user runs.
 */
export async function fetchChecksum(fetchImpl: FetchLike, spec: CodeWikiSpec, asset: string): Promise<string> {
  const response = await fetchImpl(checksumUrl(spec, asset));
  if (!response.ok) throw new Error(`the published checksum for ${asset} answered HTTP ${response.status}`);

  const digest = parseChecksum(await response.text());
  if (!digest) throw new Error(`the published checksum for ${asset} was not a SHA-256 digest, so the download cannot be verified`);
  return digest;
}

export interface InstallOptions {
  /** `userData/repositoryIntelligence` in production. */
  root: string;
  fetchImpl: FetchLike;
  spec?: CodeWikiSpec;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (received: number, total: number) => void;
  /** How a `.zip` is expanded. Injected so the tests need no PowerShell. */
  unzip?: ZipExtractor;
}

/**
 * Downloads, verifies and unpacks CodeWiki.
 *
 * Unpacks into a sibling `.partial` directory and renames it into place
 * at the end, so an install killed halfway leaves nothing that
 * `resolve.ts` would later mistake for a working binary. A half-present
 * CodeWiki is worse than an absent one: absent degrades cleanly and
 * says so, whereas half-present is discovered by spawning it.
 */
export async function installCodeWiki(options: InstallOptions): Promise<InstallResult> {
  const spec = options.spec ?? CODEWIKI;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const { root, fetchImpl } = options;

  // Before any network call: a platform upstream does not build for is
  // an answer, not a failure to retry.
  const asset = spec.assetFor(platform, arch);
  if (!asset) return { ok: false, binaryPath: null, problem: unsupportedReason(spec, platform, arch) };

  const target = installDirectory(root, spec);
  const partial = `${target}.partial`;
  // The `.zip` path needs the bytes on disk for PowerShell to read.
  // Kept outside `partial` so it cannot be renamed into place with it.
  const staged = `${target}.download`;

  try {
    const expected = await fetchChecksum(fetchImpl, spec, asset);

    const download = await fetchImpl(assetUrl(spec, asset));
    if (!download.ok) return { ok: false, binaryPath: null, problem: `Downloading ${spec.label} failed: HTTP ${download.status}.` };
    const bytes = Buffer.from(await download.arrayBuffer());
    options.onProgress?.(bytes.length, bytes.length);

    if (!matchesSha256(bytes, expected)) {
      return {
        ok: false,
        binaryPath: null,
        problem: `The ${spec.label} download did not match the SHA-256 checksum published beside it, so EO discarded it. Nothing was installed. This is worth reporting.`,
      };
    }

    // Nothing above this line has touched the disk.
    rmSync(partial, { recursive: true, force: true });
    rmSync(staged, { force: true });

    const binaryName = spec.binaryName(platform);

    if (asset.endsWith(".zip")) {
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, bytes);
      await (options.unzip ?? expandArchive)(staged, partial);
      rmSync(staged, { force: true });
    } else {
      for (const entry of extractTar(gunzipSync(bytes))) {
        if (!isSafeEntryPath(entry.path)) {
          rmSync(partial, { recursive: true, force: true });
          return { ok: false, binaryPath: null, problem: `The ${spec.label} archive contained an unsafe path (${entry.path}); nothing was installed.` };
        }

        const destination = join(partial, entry.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, entry.contents);
        if (entry.mode & 0o111) chmodSync(destination, 0o755);
      }
    }

    // Upstream ships one file at the archive root and nothing else. If
    // that ever changes, this fails loudly rather than searching the
    // tree for something plausible to execute.
    const unpacked = join(partial, binaryName);
    if (!existsSync(unpacked)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, binaryPath: null, problem: `The ${spec.label} archive did not contain ${binaryName}. EO will not guess at which file to run.` };
    }
    // A CLI that is not executable is not a CLI. No-op on Windows,
    // which has no such bit.
    chmodSync(unpacked, 0o755);

    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(partial, target);

    // Only now. A complete current version is in place, so collecting
    // the ones it replaces cannot leave the machine with none — which
    // is the whole reason this line is below the rename rather than
    // above the download. It cannot throw, so an install that has
    // already succeeded cannot be turned into a failure by tidying up.
    pruneSupersededInstalls(root, spec);

    return { ok: true, binaryPath: join(target, binaryName), problem: null };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    rmSync(staged, { force: true });
    const reason =
      error instanceof TarError || error instanceof ZipError
        ? `the archive could not be unpacked: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, binaryPath: null, problem: `Installing ${spec.label} failed — ${reason}` };
  }
}
