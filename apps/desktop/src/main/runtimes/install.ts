import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractTar, isSafeEntryPath, TarError } from "./tar.js";
import { versionFor, type RuntimeSpec } from "./catalog.js";

/**
 * Fetching an agent runtime (A-08).
 *
 * The order matters and is the whole security story: read the
 * registry's own integrity hash, download, **verify before anything is
 * written or made executable**, and only then unpack. A binary that
 * arrives over the network and is run without being checked is a
 * supply-chain hole; npm hands us the check for free, so there is no
 * excuse for skipping it.
 *
 * `fetch` is a parameter, the seam this codebase uses everywhere
 * (`fetchClaudeModels(runQuery)`, `createJiraClient(config, fetchImpl)`),
 * so none of this needs the network to test.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const REGISTRY = "https://registry.npmjs.org";

export interface InstallResult {
  ok: boolean;
  /** Absolute path to the executable, once it is in place. */
  binaryPath: string | null;
  problem: string | null;
}

export interface ResolvedRelease {
  tarball: string;
  /** As npm publishes it: `sha512-<base64>`. */
  integrity: string;
  unpackedBytes: number;
}

/** URL-encodes a scoped name the way the registry expects: `@scope%2Fname`. */
function packumentUrl(packageName: string): string {
  return `${REGISTRY}/${packageName.replace("/", "%2F")}`;
}

/**
 * What the registry says about the pinned version.
 *
 * Deliberately reads one exact version rather than `dist-tags.latest` —
 * the point of pinning is that nobody's release schedule but ours
 * changes what a user runs.
 */
export async function resolveRelease(fetchImpl: FetchLike, packageName: string, version: string): Promise<ResolvedRelease> {
  const response = await fetchImpl(packumentUrl(packageName));
  if (!response.ok) throw new Error(`the npm registry answered ${response.status} for ${packageName}`);

  const packument = (await response.json()) as { versions?: Record<string, { dist?: { tarball?: string; integrity?: string; unpackedSize?: number } }> };
  const dist = packument.versions?.[version]?.dist;
  if (!dist?.tarball) throw new Error(`${packageName}@${version} is not published`);
  if (!dist.integrity) {
    // Old packages predate integrity. Rather than fall back to a weaker
    // check, refuse: everything EO fetches is recent enough to have one.
    throw new Error(`${packageName}@${version} publishes no integrity hash, so it cannot be verified`);
  }

  return { tarball: dist.tarball, integrity: dist.integrity, unpackedBytes: dist.unpackedSize ?? 0 };
}

/** Does this tarball hash to what the registry said it would? */
export function matchesIntegrity(bytes: Buffer, integrity: string): boolean {
  const [algorithm, expected] = integrity.split("-", 2);
  if (!algorithm || !expected) return false;
  if (!["sha512", "sha384", "sha256"].includes(algorithm)) return false;
  return createHash(algorithm).update(bytes).digest("base64") === expected;
}

export interface InstallOptions {
  spec: RuntimeSpec;
  /** `userData/runtimes` in production. */
  root: string;
  fetchImpl: FetchLike;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (received: number, total: number) => void;
}

/**
 * The root every runtime lives under, from Electron's userData path.
 *
 * One definition, imported by both the engine and the IPC handlers.
 * They had a literal each, and two literals that must match is a bug
 * with a delay on it: the Agents screen would report a runtime the
 * engine could not find, and nothing would say why.
 *
 * Outside the app bundle deliberately — on macOS that bundle is signed
 * and read-only, and a per-user directory means an EO update never
 * clobbers a runtime someone is mid-run against.
 */
export function runtimeRoot(userDataPath: string): string {
  return join(userDataPath, "runtimes");
}

/** Where a runtime lands: one directory per package and version. */
export function installDirectory(root: string, spec: RuntimeSpec, version: string): string {
  return join(root, `${spec.id}@${version}`);
}

/**
 * Downloads, verifies and unpacks one runtime.
 *
 * Unpacks into a sibling `.partial` directory and renames it into place
 * at the end, so a download killed halfway leaves nothing that
 * resolution would later mistake for a working runtime.
 */
export async function installRuntime(options: InstallOptions): Promise<InstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const { spec, root, fetchImpl } = options;

  const packageName = spec.packageFor(platform, arch);
  const version = versionFor(spec, platform, arch);
  if (!packageName || !version) {
    return { ok: false, binaryPath: null, problem: `${spec.label} does not publish a build for ${platform} ${arch}.` };
  }

  const target = installDirectory(root, spec, version);
  const partial = `${target}.partial`;

  try {
    const release = await resolveRelease(fetchImpl, packageName, version);

    const download = await fetchImpl(release.tarball);
    if (!download.ok) return { ok: false, binaryPath: null, problem: `Downloading ${spec.label} failed: HTTP ${download.status}.` };
    const bytes = Buffer.from(await download.arrayBuffer());
    options.onProgress?.(bytes.length, bytes.length);

    // Before anything touches the disk.
    if (!matchesIntegrity(bytes, release.integrity)) {
      return {
        ok: false,
        binaryPath: null,
        problem: `The ${spec.label} download did not match the checksum the npm registry published for it, so EO discarded it. Nothing was installed. This is worth reporting.`,
      };
    }

    rmSync(partial, { recursive: true, force: true });
    const binaryName = spec.binaryName(platform);
    let binaryPath: string | null = null;

    for (const entry of extractTar(gunzipSync(bytes))) {
      if (!isSafeEntryPath(entry.path)) {
        rmSync(partial, { recursive: true, force: true });
        return { ok: false, binaryPath: null, problem: `The ${spec.label} archive contained an unsafe path (${entry.path}); nothing was installed.` };
      }

      const destination = join(partial, entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, entry.contents);
      // Keep the executable bit the archive asked for; npm tarballs
      // record it, and a CLI that is not executable is not a CLI.
      if (entry.mode & 0o111) chmodSync(destination, 0o755);

      if (entry.path.endsWith(`/${binaryName}`) || entry.path === binaryName) {
        binaryPath = join(target, entry.path);
        chmodSync(destination, 0o755);
      }
    }

    if (!binaryPath) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, binaryPath: null, problem: `The ${spec.label} package did not contain ${binaryName}. EO will not guess at which file to run.` };
    }

    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(partial, target);

    return { ok: true, binaryPath, problem: null };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    const reason = error instanceof TarError ? `the archive was malformed: ${error.message}` : error instanceof Error ? error.message : String(error);
    return { ok: false, binaryPath: null, problem: `Installing ${spec.label} failed — ${reason}` };
  }
}
