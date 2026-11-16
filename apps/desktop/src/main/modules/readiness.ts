import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ModuleEnvironmentReadiness, ModuleManifest, ModuleReadiness } from "@eo/core";
import { searchDirectories } from "../process/searchPath.js";
import { environmentFor, type ModuleSecretsOptions, type OrganisationSecretReader, type SecretScope, type StepScope } from "./secrets.js";

/**
 * Whether a module could run here, now, in one scope (EO-816): its
 * declared binaries looked up as `ctx.exec` would look them up, and its
 * declared environment resolved by `environmentFor`, which is what the run
 * itself is given. Read-only — nothing is installed, nothing of the
 * module's is run, and no value leaves this file.
 *
 * Asked by every door that launches module code — a pipeline step, a watch
 * job's intake check and an entry check — immediately before it launches,
 * so a CLI that is absent is found before the module's first command has
 * changed anything, and one installed since is found on the next try.
 */

/** Where a run's `needs.env` is read from: the scope the run itself would read. */
export interface ReadinessScope {
  secrets: ModuleSecretsOptions;
  /** The step's scope, or a redirected trial step's (`stepScopeFor`). Null is the shared values alone. */
  step?: SecretScope | StepScope;
  organisation?: OrganisationSecretReader | undefined;
  /** The directory the module would run in: where a `needs.bin` naming a path is taken from, as `spawn` takes it. */
  cwd?: string | undefined;
  /** For tests: the directories searched, the OS, and what counts as a runnable file. */
  binaries?: Partial<LaunchableOptions>;
}

/**
 * The readiness and, for the door about to launch, the environment it
 * would launch with — from one resolution, so the check and the run
 * cannot disagree. The environment is for the run alone; only
 * `readiness` may be shown, logged or said.
 */
export interface ResolvedModuleRun {
  readiness: ModuleReadiness;
  env: Record<string, string>;
  variables: string[];
}

export function resolveModuleRun(manifest: Pick<ModuleManifest, "needs">, scope: ReadinessScope): ResolvedModuleRun {
  const options: LaunchableOptions = {
    directories: scope.binaries?.directories ?? searchDirectories(),
    ...(scope.binaries?.platform === undefined ? {} : { platform: scope.binaries.platform }),
    ...(scope.binaries?.runnable === undefined ? {} : { runnable: scope.binaries.runnable }),
    ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
  };
  const bin = manifest.needs.bin.map((name) => ({ name, status: launchable(name, options) ? ("found" as const) : ("missing" as const) }));

  const resolved = environmentFor(scope.secrets, manifest.needs.env, scope.step ?? null, scope.organisation);
  const unreadable = new Set(resolved.unreadable);
  const dangling = new Map(resolved.dangling.map(({ name, variable }) => [name, variable]));
  const withheld = new Set(resolved.notRedirected ?? []);
  const env = manifest.needs.env.map((name): ModuleEnvironmentReadiness => {
    if (Object.hasOwn(resolved.env, name)) return { name, status: "set" };
    if (unreadable.has(name)) return { name, status: "unreadable" };
    const variable = dangling.get(name);
    if (variable !== undefined) return { name, status: "dangling", variable };
    if (withheld.has(name)) return { name, status: "withheld" };
    return { name, status: "unset" };
  });

  return {
    readiness: { ready: bin.every((each) => each.status === "found") && env.every((each) => each.status === "set"), bin, env },
    env: resolved.env,
    variables: resolved.variables,
  };
}

/** The check alone: names and statuses, no values. */
export function moduleReadiness(manifest: Pick<ModuleManifest, "needs">, scope: ReadinessScope): ModuleReadiness {
  return resolveModuleRun(manifest, scope).readiness;
}

/** The binaries a manifest declares that `ctx.exec` could not start from any directory EO searches. */
export function binariesNotFound(bins: readonly string[], options: Partial<LaunchableOptions> = {}): string[] {
  const directories = options.directories ?? searchDirectories();
  return bins.filter((bin) => !launchable(bin, { ...options, directories }));
}

/**
 * Scripts Node will not start without a shell (CVE-2024-27980), which
 * `ctx.exec` never uses.
 */
const WINDOWS_SHELL_SCRIPTS = new Set([".bat", ".cmd"]);

export interface LaunchableOptions {
  directories: readonly string[];
  platform?: NodeJS.Platform;
  /** Whether the file at this path is one the platform would execute. */
  runnable?: (path: string) => boolean;
  /**
   * The directory `ctx.exec` would spawn in. A name with a separator is
   * taken relative to it, and on Windows a bare name is looked for in it
   * before PATH, as libuv does. Absent, a relative name is taken as written.
   */
  cwd?: string;
}

/**
 * Whether `ctx.exec(bin)` could start `bin` (EO-736): what the module
 * host's `spawn`, which has no shell, finds on its PATH and can run —
 * not merely a file of that name, which is what let a `.cmd` on Windows,
 * or a file without its execute bit, pass the record's check at save and
 * fail at the first door.
 *
 * Node's lookup, as libuv does it. On Windows a bare name is tried with
 * `.com` and `.exe`, and a name with its own extension as given too,
 * unless that extension is `.bat` or `.cmd`. Elsewhere the name itself,
 * which must be a regular file with its execute bit. A name with a
 * separator in it is not looked up but taken as written.
 *
 * The PATH is the one the module host is given (`searchPath`), read at
 * the moment of asking, as the host reads it at the moment of launching.
 */
export function launchable(bin: string, options: LaunchableOptions): boolean {
  const platform = options.platform ?? process.platform;
  const path = platform === "win32" ? win32 : posix;
  const runnable = options.runnable ?? ((candidate: string) => runnableFile(candidate, platform));
  const named = platform === "win32" ? /[\\/]/.test(bin) : bin.includes("/");
  const searched = platform === "win32" && options.cwd !== undefined ? [options.cwd, ...options.directories] : options.directories;
  const bases = named ? [options.cwd === undefined ? bin : path.resolve(options.cwd, bin)] : searched.map((directory) => path.join(directory, bin));
  const forms = (base: string): string[] => {
    if (platform !== "win32") return [base];
    const extension = path.extname(bin).toLowerCase();
    const asGiven = extension !== "" && !WINDOWS_SHELL_SCRIPTS.has(extension) ? [base] : [];
    return [...asGiven, `${base}.com`, `${base}.exe`];
  };
  return bases.some((base) => forms(base).some(runnable));
}

function runnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
