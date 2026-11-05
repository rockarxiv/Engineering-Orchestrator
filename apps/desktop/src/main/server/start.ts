import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerPlatform, type ServerPlatform } from "../platform/server.js";
import { startMain, type RunningMain } from "../startMain.js";
import { serverRenderer, serverResources, type ServerConfig } from "./config.js";
import { lockDataDirectory } from "./dataDirectoryLock.js";
import type { ResourcePaths } from "../resources.js";

/**
 * EO composed on a headless host (EO-319,
 * `ARCHITECTURE.md`, "The server").
 *
 * The whole of a server launch that is not reading the environment,
 * which is index.ts's. Kept apart from that file because a module with
 * a side effect in it cannot be imported by a test without performing
 * it — and the thing most worth testing here is a *real* server: real
 * HTTP, real SQLite, real migrations, on a temporary directory and a
 * free port. That is what `smoke.test.ts` starts.
 *
 * Everything that makes EO EO — the database, the engine, the packs,
 * the schedulers, the MCP hosts — is on the other side of `startMain`
 * and does not know which of the two machines it is running on. That is
 * the whole of what phase 7a set out to prove.
 */
export interface RunningServer {
  platform: ServerPlatform;
  main: RunningMain;
  /**
   * Gives up this process's claim on the data directory (EO-320).
   *
   * Production does not call it: the process exits, and the next start
   * finds a lock whose holder is gone and takes it over — one recovery
   * path, exercised on every restart, rather than a rare one that runs
   * only after a crash. It is here for a caller that outlives the server
   * it started, which today means a test starting a second one on the
   * same volume.
   */
  release(): void;
}

/**
 * A started server, or the one sentence that says why not.
 *
 * A result rather than a throw, for the reason `readServerConfig` gives
 * — "another server is already using this directory" is an operator's
 * situation, not a programmer error — and returned from here rather than
 * checked in the entry because the lock has to be held by whoever holds
 * the server, for as long as they hold it.
 */
export type StartServerResult = { ok: true; server: RunningServer } | { ok: false; problem: string };

export interface StartServerOptions {
  /**
   * Where the files that ship beside the bundle are.
   *
   * Resolved from the entry's own location when nothing says otherwise
   * — see `serverResources`. A test hands its own in the way
   * `fakePlatform` does, so it does not depend on `out/` existing.
   */
  resources?: ResourcePaths;
  /**
   * The directory this binary was loaded from, which is what both the
   * resources and the renderer hang off.
   *
   * Defaults to this module's own, which is the truth in production.
   * A test passes an `out/`-shaped directory it built, so that the
   * resolution it exercises is the same one the binary performs rather
   * than a path handed straight to the platform — the difference
   * between covering the default and covering around it.
   */
  entryDir?: string;
  /** How the platform ends the process. See `ServerPlatformOptions.exit`. */
  exit?: (code: number) => void;
}

export function startServer(config: ServerConfig, options: StartServerOptions = {}): StartServerResult {
  // Before `openDb`, which opens `<userData>/eo.db` and does not create
  // the directory holding it. On a desktop that directory is Electron's
  // and already exists; on a server it is a volume that may have been
  // mounted empty a second ago, which is exactly the clean start this
  // story's first acceptance criterion is about.
  mkdirSync(config.userDataPath, { recursive: true });

  // Before `openDb` and before anything reads a secret. Two servers on
  // one SQLite file is a problem of its own, but the one this closes is
  // EO-320's: a rotation running against the directory this process is
  // serving would re-encrypt values while this process writes more of
  // them under the old key.
  const lock = lockDataDirectory(config.userDataPath, "a server");
  if (!lock.ok) return { ok: false, problem: lock.problem };

  const entryDir = options.entryDir ?? dirname(fileURLToPath(import.meta.url));

  const platform = createServerPlatform({
    // The renderer resolved here rather than in `readServerConfig`, for
    // the reason the resources are: only the entry knows where it was
    // loaded from, and the app is the `out/renderer` beside it. An
    // operator who says nothing gets the app, which is what
    // the design asks of a server.
    config: { ...config, rendererDirectory: serverRenderer(config.rendererDirectory, entryDir) },
    resources: options.resources ?? serverResources(process.env, entryDir),
    ...(options.exit ? { exit: options.exit } : {}),
  });

  return { ok: true, server: { platform, main: startMain(platform), release: () => lock.lock.release() } };
}
