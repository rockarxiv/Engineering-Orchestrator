import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { TurnNotEndedError, type RunProcessScope } from "@eo/core";
import { ProcessTree, TREE_MARKER_VARIABLE } from "../process/processTree.js";
import { launchTree } from "../process/runScope.js";

/**
 * The Claude CLI processes one turn spawned, held so the turn can end them
 * (EO-493).
 *
 * The SDK spawns the CLI itself unless it is handed
 * `spawnClaudeCodeProcess`, and then EO has no handle on it: what the SDK
 * does when EO stops reading is close the CLI's stdin and, two seconds
 * later, signal it on a timer nobody can wait for. A closed stdin is not
 * an ended turn. A CLI that has queued work — a resumed session closing
 * out the turn a restart interrupted (EO-487), or background tasks it is
 * waiting on after its `result` (EO-488) — goes on working, untracked, in
 * the worktree the next turn is about to be given.
 *
 * So EO does the spawning, through the SDK's documented hook, and keeps
 * every process it starts for the turn. `end` terminates them and settles
 * once they have exited, which is what lets the supervisor open the next
 * turn on a thread only after the last one is gone.
 *
 * What the SDK's own spawn does that a custom one would lose is kept: the
 * stderr tail, which the SDK appends to a failed exit's message and which
 * is the only place "No conversation found with session ID" is ever said
 * (EO-93, `isMissingClaudeSession`) — see `withStderr` — and an `exit`
 * delivered only once stderr has been read to its end, so that tail is
 * whole by the time anybody asks for it.
 */
export interface ClaudeProcesses {
  /** Handed to the SDK as `spawnClaudeCodeProcess`. */
  spawn: (options: SpawnOptions) => SpawnedProcess;
  /**
   * The end of what the turn's processes wrote to stderr, bounded.
   * Shared by every process of one turn — there is at most one at a time.
   */
  stderr(): string;
  /**
   * Every process this turn spawned, and everything each of those started
   * — a `setsid` test runner, a background shell, an MCP server
   * (EO-494) — terminated and exited (`ProcessTree`).
   *
   * Rejects with `TurnNotEndedError`, naming the survivors, when one is
   * still there after SIGKILL and its grace: "ended" is a fact this
   * reports, never an assumption it makes, and the supervisor opens
   * nothing more on the thread on the strength of it.
   */
  end(graceMs?: number): Promise<void>;
}

/** Seams for tests. */
export interface ClaudeProcessesOptions {
  /**
   * Handed each process as it is spawned. Lets a test stand in for a
   * process no signal moves — one in uninterruptible sleep — which no
   * real child can be made into on demand.
   */
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  /**
   * The run the turn belongs to and its memory limit (EO-738): where
   * the machine allows, the CLI starts in a systemd scope of the run's
   * own (`launchTree`). Absent on a turn that is no run's.
   */
  scope?: RunProcessScope;
}

/** How much stderr is kept for a failed exit's message — about what the SDK keeps. */
const STDERR_LIMIT = 4_000;

/** How long an exited CLI's stderr is waited on before its exit is reported anyway, as the SDK waits. */
const STDERR_DRAIN_MS = 250;

export function claudeProcesses(seams: ClaudeProcessesOptions = {}): ClaudeProcesses {
  const trees: ProcessTree[] = [];
  let tail = "";

  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      // As the SDK's own spawn does it: three pipes, its environment, its
      // abort signal — which it fires only after its own graceful close —
      // and no window on Windows (EO-204). Written out here, literally,
      // because `spawnInvariants.test.ts` reads the options at the call.
      //
      // Two things added (EO-494). The CLI starts inside a cgroup of its
      // own where the machine allows it — through `/bin/sh`, which puts
      // itself there and then becomes the CLI (`containedLaunch`), so
      // nothing the CLI starts is ever outside. And the tree's mark, which
      // what the CLI starts inherits: where there is no cgroup, that is
      // how a descendant that has left the CLI's group and parentage is
      // still found at the end.
      //
      // And, on a run's turn, in the run's own systemd scope where the
      // machine has one to give (EO-738): `launchTree` is the one place
      // that is decided, for this backend and the other alike.
      const marker = ProcessTree.newMarker();
      const env = { ...options.env, [TREE_MARKER_VARIABLE]: marker };
      const launch = launchTree(`eo-tree-${marker}`, options.command, options.args, env, options.cwd, seams.scope);
      const child = spawn(launch.command, launch.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      seams.onSpawn?.(child);
      const tree = new ProcessTree(child, marker, { containment: launch.adopt(child.pid) });
      trees.push(tree);
      // The SDK closes the CLI's stdin before EO ends the turn, and a CLI
      // that exits on EOF leaves its children to pid 1 in that moment.
      // Where the tree is contained that changes nothing; where it is
      // only found, a child started with an environment of its own then
      // carries nothing that says whose it is. So who they are is looked
      // at first, and the stdin closed after (EO-494).
      const closeInput = child.stdin.end.bind(child.stdin) as (...args: unknown[]) => unknown;
      child.stdin.end = ((...args: unknown[]) => {
        void tree.refresh().finally(() => closeInput(...args));
        return child.stdin;
      }) as typeof child.stdin.end;

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_LIMIT);
      });
      child.stderr.on("error", () => undefined);

      // `exit` and `error` are passed on from an emitter of this file's,
      // so an `exit` can wait for stderr. An `error` nobody listens for
      // is dropped rather than thrown from an emitter: the SDK listens
      // from the moment this returns, and the process's own exit is what
      // says it went.
      const events = new EventEmitter();
      child.on("error", (error) => {
        if (events.listenerCount("error") > 0) events.emit("error", error);
      });
      let exited = false;
      let drained = false;
      let delivered = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deliver = (): void => {
        if (delivered) return;
        delivered = true;
        if (timer) clearTimeout(timer);
        events.emit("exit", child.exitCode, child.signalCode);
      };
      child.stderr.once("close", () => {
        drained = true;
        if (exited) deliver();
      });
      child.once("exit", () => {
        exited = true;
        if (drained) deliver();
        else timer = setTimeout(deliver, STDERR_DRAIN_MS);
      });

      const on = (event: "exit" | "error", listener: (...args: never[]) => void) => {
        events.on(event, listener as (...args: unknown[]) => void);
      };
      return {
        // Not part of `SpawnedProcess`; the SDK ignores it. Who the turn's
        // CLI is, for whoever has to reach it.
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        get killed() {
          return child.killed;
        },
        get exitCode() {
          return child.exitCode;
        },
        get signalCode() {
          return child.signalCode;
        },
        kill: (signal: NodeJS.Signals) => child.kill(signal),
        on,
        once: (event: "exit" | "error", listener: (...args: never[]) => void) => {
          events.once(event, listener as (...args: unknown[]) => void);
        },
        off: (event: "exit" | "error", listener: (...args: never[]) => void) => {
          events.off(event, listener as (...args: unknown[]) => void);
        },
      } as SpawnedProcess;
    },

    stderr: () => tail,

    async end(graceMs?: number): Promise<void> {
      const survivors = (await Promise.all(trees.map((tree) => tree.end(graceMs)))).flat();
      if (survivors.length > 0) throw new TurnNotEndedError({ provider: "claude", pids: survivors });
    },
  };
}

/**
 * A failed exit's error with the stderr tail on it, as the SDK's own
 * spawn would have written it: "Claude Code process exited with code 1.
 * stderr: …". A custom spawn leaves the SDK nothing to append, and EO-93
 * reads that sentence to tell a lost session from every other failure.
 *
 * The same error, its message extended, rather than a new one: whatever
 * the SDK set on it — its class, its name, its cause — still holds.
 */
export function withStderr(error: unknown, stderr: string): unknown {
  if (!(error instanceof Error)) return error;
  const tail = stderr.trim();
  if (tail === "" || error.message.includes(" stderr: ")) return error;
  if (!/^Claude Code process (exited with code|terminated by signal)/.test(error.message)) return error;
  error.message = `${error.message}. stderr: ${tail}`;
  return error;
}
