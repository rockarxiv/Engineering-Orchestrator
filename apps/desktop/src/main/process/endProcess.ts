/**
 * Ends one process and says when it has gone (EO-493).
 *
 * SIGTERM, then SIGKILL if it is still there after `graceMs`, and the
 * promise settles once the process has actually exited — not once it has
 * been asked to. "Asked to" is what EO used to settle for: a closed stdin,
 * or one SIGTERM nobody waited on. A Claude CLI with background tasks
 * outlives both, and on EO-487 and EO-488 that left an agent working in a
 * worktree EO believed it had finished with, next to the one it had
 * started after it.
 *
 * One helper for both backends, so a Claude turn and a Codex turn end the
 * same way (invariant 12): the Claude CLI EO spawns for the SDK
 * (`providers/claudeProcess.ts`) and the Codex app-server
 * (`providers/codexAppServer.ts`) are both handed here.
 *
 * Reaches the one pid it is given. Whatever that process started is
 * `processTree.ts`'s (EO-494), which ends the root through this; this is
 * the half that makes "the previous turn's process has exited" something
 * EO can wait for.
 *
 * Resolves `true` once the process is gone, and `false` only if it is
 * still there after SIGKILL and a second grace — a process in
 * uninterruptible sleep, which no signal moves and nobody should wait on
 * for ever. A process that never started (`pid` undefined: the
 * executable was not there) is gone already.
 */
export interface EndableProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/** How long a process is given after SIGTERM before SIGKILL, unless a caller says otherwise — the Claude SDK's own figure. */
export const END_PROCESS_GRACE_MS = 5_000;

export function hasExited(child: EndableProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || (child.signalCode ?? null) !== null;
}

export async function endProcess(child: EndableProcess, graceMs: number = END_PROCESS_GRACE_MS): Promise<boolean> {
  if (hasExited(child)) return true;
  // Listened for before the first signal, so an exit that follows it at
  // once is not missed.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  send(child, "SIGTERM");
  if (await within(exited, graceMs)) return true;
  if (hasExited(child)) return true;
  send(child, "SIGKILL");
  return (await within(exited, graceMs)) || hasExited(child);
}

function send(child: EndableProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // Gone between the check and the signal.
  }
}

/** Whether `promise` settled within `ms`. */
async function within(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    // A process being ended is no reason for EO itself to stay up.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
