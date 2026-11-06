import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where EO looks for the command-line tools it runs on a person's behalf
 * (EO-655): `gh` and `glab`, the MCP clients on Settings → MCP, and the
 * binaries a module's `ctx.exec` starts and its import preflight checks.
 *
 * An app launched from Finder or the Dock inherits launchd's PATH —
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and sees neither Homebrew nor
 * anything npm installed, while the agent shell, which loads the
 * person's profile, sees both. So the person's login shell is asked for
 * its PATH once, in the background, when EO starts, and every caller
 * reads the answer at the moment it spawns: a runner made before the
 * shell answered uses the answer once there is one.
 *
 * Deliberately not written into `process.env.PATH`: EO's own git calls
 * and agent spawns keep the environment they had.
 *
 * Windows runs no shell and adds nothing; PATH there is used as
 * inherited.
 */

/** What a shell run came back with. `code` is null when it never started. */
export interface ShellRun {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<ShellRun>;

export type ShellPathResult = { ok: true; path: string } | { ok: false; reason: string };

const START = "__EO_LOGIN_SHELL_PATH_START__";
const END = "__EO_LOGIN_SHELL_PATH_END__";

/**
 * `printenv PATH` rather than `echo $PATH`: fish keeps `$PATH` as a list
 * and echoes it space-separated, but exports it colon-joined like every
 * other shell. The markers let whatever a profile prints — a banner, a
 * `fortune`, a version manager's notice — sit around the value without
 * being mistaken for it. Plain `echo` and `;` read the same in zsh, bash
 * and fish.
 */
export const SHELL_PATH_ARGS = ["-ilc", `echo ${START}; printenv PATH; echo ${END}`];

export const SHELL_PATH_TIMEOUT_MS = 10_000;

function delimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

/** The value between the markers, or null when there is not exactly one line there. */
export function parseShellPath(stdout: string): string | null {
  const start = stdout.indexOf(START);
  if (start === -1) return null;
  const end = stdout.indexOf(END, start + START.length);
  if (end === -1) return null;
  const value = stdout.slice(start + START.length, end).trim();
  if (value === "" || /[\r\n]/.test(value)) return null;
  return value;
}

/**
 * An interactive login shell (`-i` as well as `-l`), so PATH set in
 * `.zshrc` counts as well as `.zprofile` — what the agent shell sees.
 *
 * In its own session (`detached`), so an interactive shell cannot take
 * over the terminal `pnpm dev` was started from; with no stdin, so it
 * cannot wait on input; and killed as a group on timeout, so whatever a
 * profile started goes with it.
 */
export const spawnShell: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (run: ShellRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    const child = spawn(shell, args, {
      detached: true,
      // Never run on Windows; said anyway, as every spawn here says it.
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      // Keeps oh-my-zsh from stopping to offer an update nobody can see.
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    });
    child.unref();

    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        // eslint-disable-next-line no-empty
      } catch {}
      finish({ code: null, stdout, timedOut: true });
    }, timeoutMs);
    timer.unref();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.on("error", (error) => finish({ code: null, stdout, timedOut: false, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, timedOut: false }));
  });

export interface ReadShellPathOptions {
  platform?: NodeJS.Platform;
  shell?: string | undefined;
  run?: ShellRunner;
  timeoutMs?: number;
}

/** Asks the login shell for its PATH. Never throws. */
export async function readLoginShellPath(options: ReadShellPathOptions = {}): Promise<ShellPathResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ok: false, reason: "Windows runs no login shell; PATH is used as inherited." };

  const shell = "shell" in options ? options.shell : process.env["SHELL"];
  if (!shell) return { ok: false, reason: "$SHELL is not set." };

  const timeoutMs = options.timeoutMs ?? SHELL_PATH_TIMEOUT_MS;
  let result: ShellRun;
  try {
    result = await (options.run ?? spawnShell)(shell, SHELL_PATH_ARGS, timeoutMs);
  } catch (error) {
    return { ok: false, reason: `${shell} could not be run: ${String(error)}` };
  }
  if (result.timedOut) return { ok: false, reason: `${shell} did not answer within ${timeoutMs} ms.` };
  if (result.code === null) return { ok: false, reason: `${shell} could not be run${result.error ? `: ${result.error}` : "."}` };
  if (result.code !== 0) return { ok: false, reason: `${shell} exited with ${result.code}.` };

  const path = parseShellPath(result.stdout);
  if (path === null) return { ok: false, reason: `${shell} did not print a PATH EO could read.` };
  return { ok: true, path };
}

/** Folders searched beyond PATH whatever the shell said — the list `mcpHost/clients.ts` kept before EO-655. */
export function fixedDirectories(home: string, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  return [join(home, ".local", "bin"), join(home, "bin"), join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

export interface SearchPathInputs {
  /** The login shell's PATH, or null when there is none to use. */
  shellPath: string | null;
  inherited: string;
  home: string;
  platform: NodeJS.Platform;
}

/** The shell's PATH first, then what EO inherited, then the fixed folders; each directory once. */
export function composeSearchDirectories({ shellPath, inherited, home, platform }: SearchPathInputs): string[] {
  const delimiter = delimiterFor(platform);
  const split = (value: string | null) => (value ?? "").split(delimiter).filter(Boolean);
  const dirs = platform === "win32" ? split(inherited) : [...split(shellPath), ...split(inherited), ...fixedDirectories(home, platform)];
  return [...new Set(dirs)];
}

let shellPath: string | null = null;
let resolving: Promise<ShellPathResult> | null = null;

/**
 * Starts reading the login shell's PATH, once. Startup does not await
 * it; until it answers — and if it never does — callers get the
 * inherited PATH plus the fixed folders.
 */
export function resolveSearchPath(options: ReadShellPathOptions = {}): Promise<ShellPathResult> {
  resolving ??= readLoginShellPath(options).then((result) => {
    if (result.ok) shellPath = result.path;
    else if ((options.platform ?? process.platform) !== "win32") console.warn(`[eo] login shell PATH not read, using the inherited one: ${result.reason}`);
    return result;
  });
  return resolving;
}

/** For tests: forget what the shell said. */
export function resetSearchPathForTests(): void {
  shellPath = null;
  resolving = null;
}

export interface SearchPathOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/** Every directory EO searches, read now. */
export function searchDirectories(options: SearchPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  return composeSearchDirectories({
    shellPath,
    inherited: (options.env ?? process.env)["PATH"] ?? "",
    home: options.home ?? homedir(),
    platform,
  });
}

/** The PATH to hand a child EO spawns a person's tool through, read now. */
export function searchPath(options: SearchPathOptions = {}): string {
  return searchDirectories(options).join(delimiterFor(options.platform ?? process.platform));
}

/** A sentence for an error about a tool EO did not find. */
export function describeSearchedDirectories(options: SearchPathOptions = {}): string {
  const dirs = searchDirectories(options);
  return dirs.length === 0 ? "EO had no directories to search." : `EO looked in: ${dirs.join(", ")}.`;
}
