import { join } from "node:path";
import { isExecutable } from "../../../../runtimes/resolve.js";
import { installDirectory } from "./install.js";
import { CODEWIKI, unsupportedReason, type CodeWikiSpec } from "./catalog.js";

/**
 * Finding the CodeWiki binary (A-08).
 *
 * The order is the design, and it is `runtimes/resolve.ts`'s order for
 * the same three reasons. An explicit setting wins over everything,
 * because it is the answer for an air-gapped machine, a corporate
 * managed install, or anyone who simply knows better than us — and it
 * wins even when it is wrong, because telling someone their own setting
 * was quietly ignored is worse than failing loudly. What EO downloaded
 * comes next. Ambient installations are never considered: a `codewiki`
 * that happens to be on PATH is some other version, indexing into the
 * same `.codewiki/` directory EO's own syncs write to, and EO runs the
 * version it tested.
 *
 * The one thing this adds over the runtimes is `reason`. Repository
 * intelligence degrades rather than blocks, so every absence has to
 * arrive with something a person can read — most concretely on Intel
 * Macs, for which upstream publishes no build at all.
 */

export type CodeWikiSource = "configured" | "cache" | "absent";

export interface ResolvedCodeWiki {
  source: CodeWikiSource;
  path: string | null;
  /** Set when `source` is `cache`: which version is actually installed. */
  version: string | null;
  /** Why there is nothing. Null when something was found. */
  reason: string | null;
}

export interface ResolveOptions {
  /** `userData/repositoryIntelligence` in production. */
  root: string;
  /** An explicit path from settings. Wins outright. */
  configuredPath?: string | null;
  spec?: CodeWikiSpec;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolveCodeWiki(options: ResolveOptions): ResolvedCodeWiki {
  const spec = options.spec ?? CODEWIKI;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  // 1. What the person said, even if it does not exist. A wrong path
  //    that fails when spawned is a better outcome than a setting that
  //    silently did nothing.
  if (options.configuredPath) {
    return { source: "configured", path: options.configuredPath, version: null, reason: null };
  }

  // 2. A machine upstream publishes nothing for. Answered before the
  //    cache is consulted, so the reason a caller reports is the real
  //    one rather than "not downloaded yet" — nothing is ever going to
  //    download.
  if (!spec.assetFor(platform, arch)) {
    return { source: "absent", path: null, version: null, reason: unsupportedReason(spec, platform, arch) };
  }

  // 3. What EO downloaded, at the pinned version and no other. A
  //    version EO no longer pins must not be silently used.
  const binary = join(installDirectory(options.root, spec), spec.binaryName(platform));
  if (isExecutable(binary)) {
    return { source: "cache", path: binary, version: spec.version, reason: null };
  }

  return {
    source: "absent",
    path: null,
    version: null,
    reason: `EO has not downloaded ${spec.label} ${spec.version} on this machine yet.`,
  };
}
