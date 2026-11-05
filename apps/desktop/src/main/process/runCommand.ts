import { spawn } from "node:child_process";
import { killTree } from "./killTree.js";

/** How long to wait for a killed process tree to actually die before giving up on it. */
const KILL_GRACE_MS = 5000;

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  /** Captured output is truncated to this many characters, keeping the tail. */
  maxOutputChars: number;
}

export interface CommandOutcome {
  ok: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  truncated: boolean;
}

/** Keeps the tail, which is where a failing suite prints what actually broke. */
function truncateHead(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const kept = text.slice(text.length - maxChars);
  return { text: `[... ${text.length - maxChars} earlier characters omitted ...]\n${kept}`, truncated: true };
}

/**
 * Runs a user-configured check command (`test`, `lint`, `build`) and
 * captures its output.
 *
 * In `process/` rather than `workspace/` since KAN-126: nothing about it
 * is git's or a worktree's — a command line, a directory, a timeout and
 * the tail of what it printed — and the kill helper it is built on is
 * shared with the module host, which is core.
 *
 * Through a shell on purpose — the config holds command lines like
 * "pnpm test -- --run", which users expect to behave as typed. That's
 * the user's own machine and their own command, so the usual injection
 * concern doesn't apply; the risk is the reverse, a command that works
 * in their terminal failing here.
 *
 * Always resolves, never rejects: a check command failing is an ordinary
 * outcome that gets reported, not an exception.
 */
export function runCommand(command: string, options: RunCommandOptions): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
      // New process group so the whole tree can be killed on timeout.
      detached: process.platform !== "win32",
    });

    let buffer = "";
    let settled = false;
    let timedOut = false;

    const append = (chunk: Buffer): void => {
      buffer += chunk.toString();
      // Bound memory even while still running: a runaway command can
      // print gigabytes, and we only ever keep the tail anyway.
      const hardCap = options.maxOutputChars * 4;
      if (buffer.length > hardCap) buffer = buffer.slice(buffer.length - hardCap);
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: Omit<CommandOutcome, "output" | "truncated">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const { text, truncated } = truncateHead(buffer.trim(), options.maxOutputChars);
      resolve({ ...outcome, output: text, truncated });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);

      // Deliberately not resolving here: killing is a request, not a
      // completion. On Windows the kill is itself an async `taskkill`,
      // so the process can still be alive — and still holding an open
      // handle on the worktree — for a moment afterwards. Resolving
      // early let the caller proceed to remove that directory and fail
      // with EBUSY. We wait for 'close', which means the OS has actually
      // reaped it, and keep a grace timer so a truly unkillable process
      // can't hang EO either — which is the thing this timeout exists to
      // prevent.
      graceTimer = setTimeout(() => finish({ ok: false, exitCode: null, timedOut: true }), KILL_GRACE_MS);
      graceTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.on("error", (error) => {
      buffer += `\n${String(error)}`;
      finish({ ok: false, exitCode: null, timedOut });
    });

    child.on("close", (code) => {
      finish({ ok: !timedOut && code === 0, exitCode: code, timedOut });
    });
  });
}
