import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installDirectory } from "./install.js";
import { versionFor, type RuntimeSpec } from "./catalog.js";

/**
 * Finding an agent's executable (A-08).
 *
 * The order is the design. An explicit setting wins over everything,
 * because it is the answer for an air-gapped machine, a corporate
 * managed install, or anyone who simply knows better than us. What EO
 * downloaded comes next. Ambient installations are deliberately not
 * considered: EO runs the versions it tested and owns their lifecycle.
 */

export type RuntimeSource = "configured" | "cache" | "absent";

export interface ResolvedRuntime {
  source: RuntimeSource;
  path: string | null;
  /** Set when `source` is `cache`, so the UI can say which version is installed. */
  version: string | null;
}

export interface ResolveOptions {
  spec: RuntimeSpec;
  /** `userData/runtimes` in production. */
  root: string;
  /** An explicit path from Agent settings. Wins outright. */
  configuredPath?: string | null;
  /** Whether EO's managed cache may be selected. Does not affect an explicit path. */
  managedEnabled?: boolean;
  /** Retained for API compatibility; ambient system discovery is deliberately ignored. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

const ABSENT: ResolvedRuntime = { source: "absent", path: null, version: null };

/** Exported for `repositoryIntelligence/binary/resolve.ts`, which asks the same question. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    // On Windows the execute bit is meaningless; existing is enough.
    return process.platform === "win32" && existsSync(path);
  }
}

export function resolveRuntime(options: ResolveOptions): ResolvedRuntime {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const { spec, root } = options;

  // 1. What the user said, even if it is wrong — telling someone their
  //    own setting was quietly ignored is worse than failing loudly.
  if (options.configuredPath) {
    return { source: "configured", path: options.configuredPath, version: null };
  }

  // Disabling is a selection preference, not an uninstall. The files
  // stay in place so enabling can make the same copy available again.
  if (options.managedEnabled === false) return ABSENT;

  // 2. What EO downloaded, pinned version first.
  const pinned = versionFor(spec, platform, arch);
  if (pinned) {
    const found = findBinary(installDirectory(root, spec, pinned), spec.binaryName(platform));
    if (found) return { source: "cache", path: found, version: pinned };
  }

  return ABSENT;
}

/** Depth-limited search for the executable by name — Codex buries its under `vendor/<triple>/bin/`. */
function findBinary(directory: string, name: string, depth = 6): string | null {
  if (depth < 0 || !existsSync(directory)) return null;

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isFile() && entry.name === name && isExecutable(full)) return full;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findBinary(join(directory, entry.name), name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}
