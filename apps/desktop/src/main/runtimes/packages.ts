import { mkdirSync, renameSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extractTar, isSafeEntryPath, TarError } from "./tar.js";
import { matchesIntegrity, resolveRelease, type FetchLike } from "./install.js";

/**
 * Fetching a *library* rather than an executable (A-08).
 *
 * `install.ts` fetches the agent CLIs. This fetches the JavaScript EO
 * imports to drive one of them, and it exists for the same reason:
 * `@anthropic-ai/claude-agent-sdk` carries no redistribution grant
 * either.
 *
 *   > © Anthropic PBC. All rights reserved.
 *
 * That applies to the package's own JavaScript, not only to the ~275 MB
 * binary that used to come with it — so removing the binary took most of
 * the installer's weight off but left the actual legal question exactly
 * where it was. EO has to ship none of it.
 *
 * The complication is that a library has to be *resolvable* where it
 * lands. `sdk.mjs` imports `ajv` and `ajv-formats` by bare specifier, so
 * dropping it in a directory on its own produces a module that throws on
 * import. Node resolves those by walking up from the importing file, so
 * the whole closure is installed into one `node_modules` tree and the
 * walk finds them one level up. The dependencies are MIT and could have
 * stayed in the installer, but they have to sit next to the SDK to be
 * found at all, and 1 MB is not worth a second mechanism for.
 */

export interface PackagePin {
  name: string;
  version: string;
}

export interface PackageSetSpec {
  id: string;
  label: string;
  publisher: string;
  termsUrl: string;
  /** The version that names the install directory — the SDK's own. */
  version: string;
  /** Relative to the install directory: what to `import()`. */
  entry: string;
  /**
   * Pinned, and the transitive closure is spelled out rather than
   * resolved. A resolver would be a package manager, and the failure it
   * would protect against — Anthropic adding an import in a version EO
   * has not tested — is caught by actually importing the result.
   */
  packages: PackagePin[];
}

/**
 * The Claude Agent SDK and everything `sdk.mjs` reaches for.
 *
 * `ajv` and `ajv-formats` are not declared dependencies of the SDK; they
 * arrive through `@modelcontextprotocol/sdk`, which is a peer. Peers are
 * the host application's job to provide, and once the SDK no longer
 * lives in the host's tree, that job moves here.
 */
export const CLAUDE_SDK: PackageSetSpec = {
  id: "claude-sdk",
  label: "Claude Agent SDK",
  publisher: "Anthropic PBC",
  termsUrl: "https://code.claude.com/docs/en/legal-and-compliance",
  version: "0.3.312",
  entry: join("node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
  packages: [
    { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.312" },
    // The closure below is MIT, and is here only because Node resolves
    // bare specifiers relative to the importing file.
    { name: "ajv", version: "8.20.0" },
    { name: "ajv-formats", version: "3.0.1" },
    { name: "fast-deep-equal", version: "3.1.3" },
    { name: "fast-uri", version: "3.1.4" },
    { name: "json-schema-traverse", version: "1.0.0" },
    { name: "require-from-string", version: "2.0.2" },
  ],
};

export interface PackageSetResult {
  ok: boolean;
  /** Absolute path to the entry module, once it is in place. */
  entryPath: string | null;
  problem: string | null;
}

export function packageSetDirectory(root: string, spec: PackageSetSpec): string {
  return join(root, `${spec.id}@${spec.version}`);
}

/** The entry module, if this machine already has the set. */
export function resolvePackageSet(root: string, spec: PackageSetSpec): string | null {
  const entry = join(packageSetDirectory(root, spec), spec.entry);
  return existsSync(entry) ? entry : null;
}

/**
 * Downloads, verifies and unpacks the whole set.
 *
 * Every tarball is checked against the registry's own sha512 before it
 * touches the disk, exactly as `installRuntime` does — this code path
 * ends in `import()`, which is no less dangerous than `spawn()`.
 *
 * Assembled in a `.partial` directory and renamed at the end, so a
 * download that dies halfway cannot leave a tree that resolves but does
 * not load. A half-installed *library* is worse than a missing one: the
 * import fails somewhere inside someone else's code.
 */
export async function installPackageSet(options: {
  spec: PackageSetSpec;
  root: string;
  fetchImpl: FetchLike;
  onProgress?: (done: number, total: number) => void;
}): Promise<PackageSetResult> {
  const { spec, root, fetchImpl } = options;
  const target = packageSetDirectory(root, spec);
  const partial = `${target}.partial`;

  rmSync(partial, { recursive: true, force: true });

  try {
    let done = 0;
    for (const pin of spec.packages) {
      const release = await resolveRelease(fetchImpl, pin.name, pin.version);

      const download = await fetchImpl(release.tarball);
      if (!download.ok) {
        rmSync(partial, { recursive: true, force: true });
        return { ok: false, entryPath: null, problem: `Downloading ${pin.name} failed: HTTP ${download.status}.` };
      }

      const bytes = Buffer.from(await download.arrayBuffer());
      if (!matchesIntegrity(bytes, release.integrity)) {
        rmSync(partial, { recursive: true, force: true });
        return {
          ok: false,
          entryPath: null,
          problem: `${pin.name}@${pin.version} did not match the checksum the npm registry published for it, so EO discarded it. Nothing was installed. This is worth reporting.`,
        };
      }

      // npm's layout, because that is what Node's resolver expects to
      // walk: <partial>/node_modules/<name>/...
      const packageRoot = join(partial, "node_modules", pin.name);
      for (const file of extractTar(gunzipSync(bytes))) {
        if (!isSafeEntryPath(file.path)) {
          rmSync(partial, { recursive: true, force: true });
          return { ok: false, entryPath: null, problem: `The ${pin.name} archive contained an unsafe path (${file.path}); nothing was installed.` };
        }
        const destination = join(packageRoot, file.path);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, file.contents);
        if (file.mode & 0o111) chmodSync(destination, 0o755);
      }

      options.onProgress?.(++done, spec.packages.length);
    }

    // Proof rather than hope: if the entry is not where the spec says,
    // the set is wrong and saying so now beats an import error later,
    // from inside a file nobody here wrote.
    if (!existsSync(join(partial, spec.entry))) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, entryPath: null, problem: `${spec.label} did not contain ${spec.entry}. Nothing was installed.` };
    }

    rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(partial, target);

    return { ok: true, entryPath: join(target, spec.entry), problem: null };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    const reason = error instanceof TarError ? `the archive was malformed: ${error.message}` : error instanceof Error ? error.message : String(error);
    return { ok: false, entryPath: null, problem: `Installing ${spec.label} failed — ${reason}` };
  }
}
