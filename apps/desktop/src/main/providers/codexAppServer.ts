import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createInterface } from "node:readline";
import { TurnNotEndedError, type RunProcessScope } from "@eo/core";
import { END_PROCESS_GRACE_MS } from "../process/endProcess.js";
import { ProcessTree, TREE_MARKER_VARIABLE } from "../process/processTree.js";
import { launchTree } from "../process/runScope.js";

/**
 * EO's one client for `codex app-server --stdio` (EO-372).
 *
 * The CLI's JSON-RPC mode: one JSON object per line on stdin and stdout,
 * requests answered by `id`, notifications carrying a `method` and no
 * `id`, and requests the *server* sends to the client carrying both. EO
 * first spoke it to list models (`codexModels.ts`), and now runs every
 * Codex turn over it (`codexClient.ts`). Both go through this class, so
 * there is one place that knows how a line becomes a message and what a
 * dying process means for the requests still waiting on it.
 *
 * Deliberately protocol-shaped and nothing more: it knows `initialize`
 * because every exchange starts with it, and knows no other method. What
 * a `thread/start` or a `model/list` means is the caller's business.
 */

/** A message the server sent without being asked: `{ method, params }`. */
export interface AppServerNotification {
  method: string;
  params: unknown;
}

/** How the process ended. `stderr` is the head of what it wrote, bounded. */
export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * A request the server answered with an error. Kept apart from every
 * other failure so a caller can read the server's own `code` and words —
 * which is how `thread/resume` failing on a missing rollout is told from
 * the process dying (`codex.ts`, `isMissingCodexSession`).
 */
export class AppServerRequestError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  constructor(method: string, message: string, code: number | undefined) {
    // The sentence the old `codex exec resume` printed for the same
    // refusal was "thread/resume failed: <server message> (code <n>)",
    // and EO-369 and EO-370 quote it in that form. Kept, so a failure
    // reads the same in a run's log whichever transport produced it.
    super(`${method} failed: ${message}${code === undefined ? "" : ` (code ${code})`}`);
    this.name = "AppServerRequestError";
    this.method = method;
    this.code = code;
  }
}

/** The process went away while something was still waiting on it. */
export class AppServerExitedError extends Error {
  readonly exit: AppServerExit;
  constructor(exit: AppServerExit) {
    const detail = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 1}`;
    super(`Codex app-server exited with ${detail}${exit.stderr.trim() ? `: ${exit.stderr.trim()}` : ""}`);
    this.name = "AppServerExitedError";
    this.exit = exit;
  }
}

/** The only spawn this file performs, as a seam: a unit test must not run the real CLI. */
export type AppServerSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface AppServerLaunch {
  executablePath: string;
  /** Extra arguments after `app-server --stdio` — `-c key=value` overrides, today. */
  args?: readonly string[];
  /** Undefined inherits `process.env`, which is what Node does by default. */
  env?: Record<string, string>;
  spawn?: AppServerSpawn;
  /** Handed the process as it is spawned, before anything else is done with it — a test's way to stand between the two. */
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  /**
   * The run the process belongs to and its memory limit (EO-738): where
   * the machine allows, the app-server starts in a systemd scope of the
   * run's own (`launchTree`). Absent for a process that is no run's — a
   * model list, a side call, a conversation's turn.
   */
  scope?: RunProcessScope;
}

/** How much of the server's stderr is kept for an error message. */
const STDERR_LIMIT = 4_000;

/** How long an exited server's stdout is waited on before the exit is reported anyway. */
const EXIT_DRAIN_MS = 250;

type Pending = { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void };

export class AppServerConnection {
  readonly pid: number | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  /** The app-server and everything it starts — its shells, its MCP servers — ended together (EO-494). */
  private readonly tree: ProcessTree;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  private nextId = 1;
  private stderr = "";
  private exitInfo: AppServerExit | null = null;
  private failure: Error | null = null;
  private readonly exitWaiters: ((exit: AppServerExit) => void)[] = [];
  /** Called for a server→client request; the default refuses it (see `refuseServerRequest`). */
  onServerRequest: (method: string, params: unknown) => { result: unknown } | { error: { code: number; message: string } } = refuseServerRequest;

  constructor(launch: AppServerLaunch) {
    const args = ["app-server", "--stdio", ...(launch.args ?? [])];
    // The tree's mark (EO-494), on top of what the launch asked for — or
    // of what Node would have inherited, which is what no `env` means.
    // What the app-server starts inherits it, and that is how a command
    // that left its process group and its parent is still found when the
    // turn ends.
    const marker = ProcessTree.newMarker();
    const env = { env: { ...(launch.env ?? process.env), [TREE_MARKER_VARIABLE]: marker } };
    // And the app-server starts inside a cgroup of its own where the
    // machine allows it: through `/bin/sh`, which puts itself there and
    // then becomes the app-server (`containedLaunch`), so nothing it starts
    // is ever outside. A spawn seam runs what it likes in place of the
    // command, so there the process is moved in once spawned instead.
    //
    // On a run's turn, in the run's own systemd scope where the machine has
    // one to give (EO-738) — decided in `launchTree`, the one place both
    // backends' trees are planned. A spawn seam is handed that plan too,
    // when there is a scope, so what the turn would have started is what
    // a test sees.
    const contained = launchTree(`eo-tree-${marker}`, launch.executablePath, args, env.env, undefined, launch.scope);
    // `windowsHide` because this is spawned straight from the Electron
    // main process, which is a GUI process and has no console of its own
    // (EO-204). Windows gives a console program started from such a
    // parent a brand new console, and a new console is a visible window —
    // an empty `cmd` box appearing over EO for every model list and, now
    // that turns run here too, for every Codex turn.
    //
    // Not `detached`: the process belongs to this one, and a cancelled
    // run ends it through `close()` below rather than leaving it to a
    // process group nobody signals. A group would not reach far enough
    // anyway — a command started with `setsid` leaves it — so what it
    // started is found by `ProcessTree` instead (EO-494).
    //
    // Written out at both calls, literally and last, because
    // `spawnInvariants.test.ts` reads the options at the call site: a
    // seam taking an options object it built elsewhere is a spawn that
    // scan cannot clear.
    this.child = launch.spawn
      ? launch.scope
        ? launch.spawn(contained.command, contained.args, { stdio: ["pipe", "pipe", "pipe"], ...env, windowsHide: true } as SpawnOptionsWithoutStdio)
        : launch.spawn(launch.executablePath, args, { stdio: ["pipe", "pipe", "pipe"], ...env, windowsHide: true } as SpawnOptionsWithoutStdio)
      : nodeSpawn(contained.command, contained.args, { stdio: ["pipe", "pipe", "pipe"], ...env, windowsHide: true });
    this.pid = this.child.pid;
    launch.onSpawn?.(this.child);
    this.tree = new ProcessTree(this.child, marker, { containment: contained.adopt(this.child.pid) });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      if (this.stderr.length < STDERR_LIMIT) this.stderr += chunk;
    });
    // A write to a pipe whose reader has gone is reported here, and the
    // process's own exit below is what says so to anyone waiting.
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => {
      this.fail(error);
      // A process that never started — a path with nothing at it — fires
      // no `exit`, so this is the only place its end is ever reported.
      if (this.pid === undefined && !this.exitInfo) {
        this.exitInfo = { code: null, signal: null, stderr: error.message };
        for (const waiter of this.exitWaiters.splice(0)) waiter(this.exitInfo);
      }
    });
    // The exit is reported once stdout has been read to its end, so the
    // last thing the server said — often the reason it is going — is
    // delivered before anyone is told it went. Bounded, because a
    // grandchild that inherited the pipe can hold it open indefinitely.
    let stdoutEnded = false;
    let ended: () => void = () => {};
    const drained = new Promise<void>((resolveDrain) => {
      ended = resolveDrain;
    });
    this.child.stdout.on("end", () => {
      stdoutEnded = true;
      ended();
    });
    this.child.on("exit", (code, signal) => {
      const finish = () => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal, stderr: this.stderr };
        this.fail(new AppServerExitedError(this.exitInfo));
        for (const waiter of this.exitWaiters.splice(0)) waiter(this.exitInfo);
      };
      if (stdoutEnded) finish();
      else void Promise.race([drained, new Promise((resolveLater) => setTimeout(resolveLater, EXIT_DRAIN_MS))]).then(finish);
    });

    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
  }

  /** The exit, once there is one. Resolves immediately for a process already gone. */
  exited(): Promise<AppServerExit> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** Every notification from now on. Returns the unsubscribe. */
  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.failure) return;
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  /**
   * The handshake every exchange begins with: `initialize`, then the
   * `initialized` notification. Nothing else is accepted before it.
   * `capabilities` are the client's opt-ins, such as the experimental API
   * a fork's turn asks for (EO-732).
   */
  async initialize(capabilities: Record<string, unknown> | null = null): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo: { name: "eo", title: "EO", version: "0.0.0" }, capabilities });
    this.notify("initialized");
    return result;
  }

  /**
   * End the process, whatever it is doing, without waiting for it.
   *
   * Closing stdin first is the polite half: an app-server that reads EOF
   * shuts down on its own and takes its MCP servers with it. The kill
   * is the half that does not depend on that, because "no Codex process
   * outlives its run" is EO's promise and not the CLI's — SIGTERM, and
   * SIGKILL after a grace if that was not enough (EO-493), to the
   * app-server and to everything it started (EO-494). `terminate` is the
   * same, for a caller that has to know it has gone.
   */
  close(): void {
    // Nobody is waiting on this, so a server that survives even SIGKILL is
    // said here; a caller that has to know uses `terminate`, which throws.
    this.terminate().catch((error: unknown) => console.warn("[codex] the app-server did not exit:", error));
  }

  /**
   * End the process and settle once it has exited (EO-493): stdin
   * closed, SIGTERM, then SIGKILL if it is still there after `graceMs`.
   *
   * What a turn EO stops reading is ended with. The next turn on the
   * same thread is a new app-server, and it must not be spawned beside
   * one that is still working — so a server still there after SIGKILL
   * and its grace is not reported as ended: this rejects with
   * `TurnNotEndedError`, and the supervisor fails the run closed.
   */
  async terminate(graceMs: number = END_PROCESS_GRACE_MS): Promise<void> {
    this.fail(new Error("Codex app-server connection closed"));
    // Who its children are, looked at before stdin closes, where the tree
    // is found rather than contained: an app-server that exits on EOF
    // leaves them to pid 1 at once, and one Codex started with an
    // environment of its own carries no mark (EO-494).
    await this.tree.refresh();
    try {
      this.child.stdin.end();
    } catch {
      // Already closed; the signals below are what matter.
    }
    // Its whole tree, not only the app-server (EO-494): whether Codex
    // takes its shells and MCP servers down with it is the CLI's promise,
    // and a test runner started with `setsid` is out of its reach anyway.
    const survivors = await this.tree.end(graceMs);
    if (survivors.length > 0) throw new TurnNotEndedError({ provider: "codex", pids: survivors });
  }

  /**
   * End the process the orderly way, then the certain way.
   *
   * For a turn that finished: stdin closes, the app-server reads EOF and
   * shuts down — finishing the thread's rollout as it goes, which is
   * what the next resume reads — and only if it has not gone within
   * `graceMs` is it terminated, SIGKILL included (`terminate`). Settles
   * once it has exited, and rejects as `terminate` does when it will not.
   */
  async shutdown(graceMs: number, killGraceMs: number = END_PROCESS_GRACE_MS): Promise<void> {
    if (!this.exitInfo) {
      // Who the app-server's children are, looked at while it is still
      // their parent: one that exits on EOF leaves them to pid 1, and an
      // MCP server Codex started with an environment of its own carries
      // no mark to be found by.
      await this.tree.refresh();
      this.fail(new Error("Codex app-server connection closed"));
      try {
        this.child.stdin.end();
      } catch {
        // Already closed.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exited(),
        new Promise<void>((resolveLater) => {
          timer = setTimeout(resolveLater, graceMs);
        }),
      ]);
      clearTimeout(timer);
    }
    // Whether or not it went on its own, what it started is ended
    // (EO-494); for an app-server already gone that is all this does.
    await this.terminate(killGraceMs);
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(this.failure);
    }
  }

  private receive(line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error("app-server returned invalid JSON"));
      this.close();
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

    if (typeof record.method === "string") {
      if (record.id !== undefined && record.id !== null) {
        const answer = this.onServerRequest(record.method, record.params);
        this.write({ id: record.id, ...answer });
        return;
      }
      const notification = { method: record.method, params: record.params };
      for (const listener of this.listeners) listener(notification);
      return;
    }

    if (typeof record.id !== "number") return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    if (record.error) {
      const text = typeof record.error.message === "string" ? record.error.message : "request failed";
      const code = typeof record.error.code === "number" ? record.error.code : undefined;
      pending.reject(new AppServerRequestError(pending.method, text, code));
      return;
    }
    pending.resolve(record.result);
  }
}

/**
 * The answer to anything the server asks of EO: no.
 *
 * Under the pinned `never` approval policy (EO-178) the server has no
 * approval to ask for, and EO offers it no client-side tools, so a
 * request arriving here is one EO never invited. Refusing it is what
 * keeps the turn moving — a request left unanswered holds the turn open
 * until the wall-clock guard ends the run — and it is said loudly
 * because it means the CLI wanted something EO did not expect it to.
 */
function refuseServerRequest(method: string): { error: { code: number; message: string } } {
  console.warn(`[codex] the app-server asked EO for "${method}", which EO does not answer; refused.`);
  return { error: { code: -32601, message: `EO does not handle ${method}` } };
}
