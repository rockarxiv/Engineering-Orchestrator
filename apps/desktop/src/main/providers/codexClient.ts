import { PREWARM_IDLE_MS } from "@eo/core";
import { AppServerConnection, type AppServerExit, AppServerExitedError, type AppServerNotification, type AppServerSpawn } from "./codexAppServer.js";

/**
 * Codex turns over `codex app-server --stdio` (EO-372).
 *
 * EO used to drive Codex through `@openai/codex-sdk`, which spawned the
 * one-shot `codex exec --experimental-json` per turn and read its JSONL
 * event stream. This replaces that library with EO's own client for the
 * CLI's JSON-RPC mode — the one `codexModels.ts` already spoke — and
 * keeps the library's *shape* on purpose:
 *
 * - `startThread` / `resumeThread` / `runStreamed` are the seam
 *   `providers/codex.ts` and its tests were written against, so the
 *   provider is unchanged above this line;
 * - the events come out in the `codex exec` vocabulary (`ThreadEvent`
 *   below), translated here from the app-server's notifications, so
 *   `mapThreadEvent` — and `transcriptParity.test.ts`, which holds the two
 *   backends to the same `AgentEvent`s — maps exactly what it mapped.
 *
 * And four things `exec` could not do at all, because it could not be
 * reached once it started (EO-373): a turn can be interrupted
 * (`turn/interrupt`) and spoken to (`turn/steer`) through the handle
 * `runStreamed` returns, and the plan-limit readings and MCP startup
 * report the app-server volunteers come out as two events of EO's own
 * (`rate_limits.updated`, `mcp_servers.started`) for the provider to map.
 */

// ---------------------------------------------------------------------
// The event vocabulary, as `codex exec --experimental-json` spoke it.
//
// Copied from `@openai/codex-sdk` 0.161.0's `dist/index.d.ts` when the
// library was removed, trimmed to what EO reads. It is EO's own type now:
// nothing upstream emits it any more, and `translate` below is the only
// producer.
//
// What the app-server it is translated from says and EO does not read,
// from 0.163.0's own `app-server generate-ts` set beside 0.161.0's
// (EO-453): a turn's `rootTurnId` (the turn itself, on one a person
// started); `model` and `reasoningEffort` on a `subAgentActivity` item,
// an item EO does not translate at either pin; a third agent-message
// `phase`, `partial_answer`, where EO reads the text and never the
// phase; and one new notification, `thread/readState/changed`, listed
// with the ignored ones below. The shapes `translate` does read —
// `commandExecution` with its `aggregatedOutput`, `agentMessage`,
// `RateLimitWindow`, `thread/tokenUsage/updated` — are unchanged.
//
// 0.166.0's set beside 0.165.0's (EO-644): again no notification or
// server request added, removed or reshaped — `ServerNotification`,
// `ServerRequest`, `ClientRequest`, `Turn`, `ThreadStartParams`,
// `ThreadResumeParams` and `RateLimitWindow` are the same files byte for
// byte. Every `ThreadItem` may now carry `startedAtMs` and
// `completedAtMs` beside its own fields, flat on the wire, which EO does
// not read; `CodexErrorInfo` gains `policyCapacityUnavailable` (EO reads
// only `usageLimitExceeded`); `review/start` loses its `detached`
// delivery (EO starts no review); and an image item, an account, hook
// metadata and a thread's usage each gain a field EO does not read.
//
// 0.165.0's set beside 0.163.0's (EO-599): no notification or server
// request was added, removed or reshaped — `ServerNotification`,
// `ServerRequest`, `Turn`, `ThreadStartParams`, `ThreadResumeParams` and
// `RateLimitWindow` are the same files byte for byte. What moved is what
// EO does not read: an `imageGeneration` item may carry a `fileId` in
// place of its `result` and lists its `inputImages` (EO translates no
// image item at either pin); `CodexErrorInfo` gains `modelNotFound` (EO
// reads only `usageLimitExceeded` out of it); an MCP server's status
// gains `toolListMeta`; and a new `feedback/save` request, the
// `preModelRequest` / `postModelRequest` hook events, a `gcp` account
// and two plan types.
// ---------------------------------------------------------------------

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "persistent";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";

export type CommandExecutionItem = {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
};
export type FileChangeItem = {
  id: string;
  type: "file_change";
  changes: { path: string; kind: "add" | "delete" | "update" }[];
  status: "completed" | "failed";
};
export type McpToolCallItem = {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  result?: { content: unknown[]; _meta?: unknown; structured_content: unknown };
  error?: { message: string };
  status: "in_progress" | "completed" | "failed";
};
export type AgentMessageItem = { id: string; type: "agent_message"; text: string };
export type ReasoningItem = { id: string; type: "reasoning"; text: string };
export type WebSearchItem = { id: string; type: "web_search"; query: string };
/** A warning. Non-fatal by definition — under `exec` this is how warnings arrived (EO-369). */
export type ErrorItem = { id: string; type: "error"; message: string };
export type TodoListItem = { id: string; type: "todo_list"; items: { text: string; completed: boolean }[] };
export type ThreadItem = AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem | McpToolCallItem | WebSearchItem | TodoListItem | ErrorItem;

export type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

/**
 * One allowance window, as `account/rateLimits/updated` reports it
 * (0.161.0's `RateLimitWindow`, unchanged at 0.163.0, 0.165.0 and 0.166.0): the share used,
 * 0–100, the window's length, and when it refreshes in Unix seconds.
 */
export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };

/**
 * The fields of the app-server's `RateLimitSnapshot` EO reads. The rest —
 * credits, spend controls, the plan type — say nothing about whether a
 * turn will be answered, and are left where they arrived.
 */
export type RateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
};

/** One MCP server's startup, as the app-server last reported it. `status` is its own word. */
export type McpServerStartup = { name: string; status: string; error?: string };

export type ThreadEvent =
  /** `model` is EO's addition (EO-392): the model `thread/start` or `thread/resume` answered with, when it named one. */
  | { type: "thread.started"; thread_id: string; model?: string }
  | { type: "turn.started" }
  /**
   * `model` is EO's addition (EO-374): the model the turn ran on, as the
   * app-server named it — the one `thread/start` or `thread/resume`
   * answered with, or the one `model/rerouted` moved the turn to. It is
   * what the turn is priced at (`codexPricing.ts`), so it is the model
   * that answered rather than the one EO asked for.
   */
  | { type: "turn.completed"; usage: Usage; model?: string }
  /**
   * `usage` is EO's addition (EO-373): what the turn spent before it
   * ended badly — interrupted, most of all — when the app-server reported
   * any. `exec` never did, which is how an escalated Codex run came to
   * record nothing. `codex_error_info` is the app-server's own
   * classification of the failure, passed on unread.
   */
  | { type: "turn.failed"; error: { message: string; codex_error_info?: unknown }; usage?: Usage; model?: string }
  | { type: "item.started"; item: ThreadItem }
  | { type: "item.updated"; item: ThreadItem }
  | { type: "item.completed"; item: ThreadItem }
  /**
   * EO's own: more of an agent message or a reasoning summary, from
   * `item/agentMessage/delta` and `item/reasoning/summaryTextDelta`.
   * `exec` never streamed, so this has no counterpart there; it becomes a
   * transient `output_delta` and is never stored.
   */
  | { type: "item.delta"; stream: "text" | "reasoning"; text: string }
  /**
   * EO's own: the turn is at work with nothing to show — a command
   * printing, a file being patched, a tool reporting progress. Becomes a
   * transient `heartbeat`, for the inactivity guard.
   */
  | { type: "heartbeat" }
  /** EO's own: the app-server lost its stream to the model and is trying again (`error` with `willRetry`). */
  | { type: "retrying"; message: string }
  /** EO's own: the thread's history was compacted (`thread/compacted`, or a `contextCompaction` item). */
  | { type: "compacted" }
  /**
   * EO's own: what this turn has used so far, while it runs — the turn's
   * share of the thread's running total, and the model it is on. What
   * lets the adapter hold a turn to a budget before it ends
   * (`AgentTurnOverrides.budgetCents`).
   */
  | { type: "turn.usage"; usage: Usage; model?: string }
  | { type: "error"; message: string; codex_error_info?: unknown }
  /** EO's own (EO-373): a plan-limit reading, from `account/rateLimits/updated`. */
  | { type: "rate_limits.updated"; rate_limits: RateLimitSnapshot }
  /** EO's own (EO-373): which MCP servers came up, from `mcpServer/startupStatus/updated`. */
  | { type: "mcp_servers.started"; servers: McpServerStartup[] };

/** What a thread is opened with. The names are the SDK's, so the provider's call sites did not move. */
export interface CodexThreadOptions {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  modelReasoningEffort?: ModelReasoningEffort;
  /** `summary` on `turn/start`: whether reasoning comes back summarised. Omitted is the CLI's default. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  webSearchEnabled?: boolean;
  approvalPolicy?: ApprovalMode;
  /**
   * The thread's system prompt (EO-385): `baseInstructions` on
   * `thread/start` and `thread/resume`, where it replaces the CLI's own
   * built-in prompt rather than sitting beside it.
   */
  baseInstructions?: string;
  /**
   * `ephemeral` on `thread/start` (EO-477): the thread is not
   * materialised on disk, so nothing can resume it. A side call's, and
   * nobody else's — every agent thread is one EO may carry on.
   */
  ephemeral?: boolean;
  /**
   * The thread named is copied with `thread/fork` and the turn runs on
   * the copy, rather than on the thread itself with `thread/resume`
   * (EO-716). Set by `forkThread`, and part of a warm process's key like
   * every other option here, so a warm resume of the same thread is never
   * adopted by a fork of it.
   */
  fork?: boolean;
}

export interface CodexTurnOptions {
  outputSchema?: unknown;
  signal?: AbortSignal;
  /** The caller's part of what a warm process must match to be adopted (`prewarm`). */
  warmKey?: string;
}

/**
 * One running turn: its events, and the two ways of reaching it while it
 * runs (EO-373).
 *
 * Both controls are optional in the type for the reason
 * `InterruptibleStream`'s are: a stand-in thread in a test has neither,
 * and the provider reads an absent one as "this turn cannot be reached".
 * The real client always supplies both.
 */
export interface CodexTurn {
  events: AsyncGenerator<ThreadEvent>;
  /**
   * Asks the app-server to end the turn now (`turn/interrupt`). The turn
   * then completes as `interrupted` through `events`, reporting what it
   * spent on the way — so the caller still drains. Best effort: a turn
   * already over, or a connection already gone, is not an error here.
   */
  interrupt?: () => Promise<void>;
  /**
   * Says `message` into the turn that is running (`turn/steer`). True when
   * the app-server took it into that turn; false when there was no turn
   * left to take it — it ended first — or the connection is gone.
   */
  steer?: (message: string) => Promise<boolean>;
}

export interface CodexThread {
  runStreamed(input: string, turnOptions?: CodexTurnOptions): Promise<CodexTurn>;
}

/** What `providers/codex.ts` constructs a client from, once per turn (`buildCodexOptions`). */
export interface CodexClientOptions {
  executablePath?: string;
  /** Flattened into `-c key=value` overrides on the app-server's command line. */
  config?: Record<string, unknown>;
  /** The whole environment, when EO has something to add to it; undefined inherits. */
  env?: Record<string, string>;
  /** A notification EO neither maps nor deliberately ignores — reported, never dropped. */
  onUnmappedNotification?: (notification: AppServerNotification) => void;
  /** Seam for tests: the process spawn. */
  spawn?: AppServerSpawn;
  /** Seam for tests: how long a finished turn's process is given to exit by itself. */
  shutdownGraceMs?: number;
  /**
   * Seam for tests: how long a turn's process is given after SIGTERM
   * before SIGKILL, once EO is ending it (EO-493). Five seconds otherwise.
   */
  killGraceMs?: number;
  /**
   * Called once a turn's process is over — exited, or killed after its
   * grace — however the turn ended (EO-444). What lets go of anything
   * that was minted for the one process, such as the bearer for EO's
   * administrative server, whose session the CLI does not close itself.
   * One process per turn, so once per turn.
   *
   * A warm-up (`prewarm`) hands it to the warm process instead: called
   * when that process is dropped unadopted, or after the turn that
   * adopted it — and at once when the warm-up starts nothing.
   */
  afterTurn?: () => void;
  /**
   * Names in `env` whose values are minted for each turn — the admin
   * bearer (EO-444). A warm process matches its turn on these names and
   * not on their values, which differ between the two by design.
   */
  perTurnEnv?: readonly string[];
}

/**
 * Said when there is no binary to run. Without the SDK there is no copy
 * inside `node_modules` to fall back on — which is what A-08 wanted
 * gone anyway — so a missing path is a run that cannot start, said in
 * the words `codexModels.ts` uses for the same absence.
 */
export const CODEX_NOT_INSTALLED = "The Codex CLI is not installed. Install it from the Agents screen, or set the agent's executable path.";

/**
 * How long a finished turn's app-server is given to exit on its own
 * before it is killed. It reads EOF on stdin and shuts down, which is the
 * orderly way for it to finish writing the thread's rollout; the kill
 * after this is what makes "no Codex process outlives its run" EO's
 * promise rather than the CLI's.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long an interrupt waits for a token reading the turn still owes
 * (`LiveTurn.interrupt`). The reading arrives within milliseconds when it
 * is coming at all; a second is long enough for a loaded machine and
 * short enough that nobody waiting on an escalation notices.
 */
const USAGE_SETTLE_MS = 1_000;

/**
 * One app-server's notifications as a turn reads them: a queue filled as
 * they arrive, the exit when it comes, and a way to wait for either.
 *
 * Its own object so a warm process (`prewarm`) can collect what the
 * app-server says while its thread opens — the MCP startup report above
 * all — and hand the lot to the turn that adopts it, which reads it as if
 * it had been listening all along.
 */
class Pipe {
  readonly queue: AppServerNotification[] = [];
  exit: AppServerExit | null = null;
  private wake: (() => void) | null = null;
  private observer: ((notification: AppServerNotification) => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(readonly connection: AppServerConnection) {
    this.unsubscribe = connection.onNotification((notification) => {
      // As it arrives, not as it is read: an interrupt is decided while
      // the consumer is holding an event, with the rest still queued.
      this.observer?.(notification);
      this.queue.push(notification);
      this.nudge();
    });
    void connection.exited().then((value) => {
      this.exit = value;
      this.nudge();
    });
  }

  /** Who hears each notification as it arrives — the turn's controls — told of those already queued first. */
  watch(observer: (notification: AppServerNotification) => void): void {
    for (const notification of this.queue) observer(notification);
    this.observer = observer;
  }

  nudge(): void {
    const resolveWait = this.wake;
    this.wake = null;
    resolveWait?.();
  }

  /** Until the next notification or the exit. Asked only with the queue empty, in the same breath. */
  wait(): Promise<void> {
    return new Promise<void>((resolveWait) => {
      this.wake = resolveWait;
    });
  }

  release(): void {
    this.unsubscribe();
  }
}

/** A process spawned, handshaken and with its thread open, waiting for the turn it was started for. */
interface WarmThread {
  pipe: Pipe;
  threadId: string;
  model: string | null;
  /** Lets go of what the warm process was spawned with (`afterTurn`), once the turn that adopted it is over. */
  release?: () => void;
}

/**
 * The one app-server started ahead of its turn (`prewarm`), across every
 * client: a provider builds a client per turn, so the warm process is
 * kept here, by the exact command line, environment and thread it was
 * started for. A turn takes it only on an exact match; anything else, or
 * a minute of nobody sending, shuts it down.
 */
let warmThread: { key: string; ready: Promise<WarmThread | null>; timer: ReturnType<typeof setTimeout>; release?: () => void } | null = null;

/**
 * A warm process that has ended before Node has said so. Its `exit`
 * comes as an event, and on Windows it can come well after the process
 * has gone — a turn taking it in between ran on a process that was
 * already dead, and failed on its first request where it should have
 * opened afresh. Signal 0 asks the system instead: on Windows that is
 * the process's exit code, so a process that has ended is gone even
 * while Node still holds it. `EPERM` is a process that is there.
 */
function goneUnreported(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/** Closes a warm process and then lets go of what it was spawned with. */
function closeWarm(going: { ready: Promise<WarmThread | null>; release?: () => void }): void {
  void going.ready
    .then((thread) => {
      thread?.pipe.connection.close();
      thread?.pipe.release();
    })
    .finally(() => going.release?.());
}

function dropWarmThread(): void {
  if (!warmThread) return;
  const going = warmThread;
  warmThread = null;
  clearTimeout(going.timer);
  closeWarm(going);
}

function warmTimer(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(dropWarmThread, PREWARM_IDLE_MS);
  timer.unref?.();
  return timer;
}

/** For tests: no warm process is left over from one case to the next. */
export function dropWarmCodexThread(): void {
  dropWarmThread();
}

export class CodexClient {
  constructor(private readonly options: CodexClientOptions = {}) {}

  startThread(threadOptions: CodexThreadOptions = {}): CodexThread {
    return { runStreamed: async (input, turnOptions = {}) => this.turn(null, threadOptions, input, turnOptions) };
  }

  resumeThread(threadId: string, threadOptions: CodexThreadOptions = {}): CodexThread {
    return { runStreamed: async (input, turnOptions = {}) => this.turn(threadId, threadOptions, input, turnOptions) };
  }

  /**
   * A copy of the thread, carrying its history, that the turn runs on
   * (EO-716). The thread itself is not written to: `thread.started`
   * names the copy, and every notification after it is the copy's.
   */
  forkThread(threadId: string, threadOptions: CodexThreadOptions = {}): CodexThread {
    return { runStreamed: async (input, turnOptions = {}) => this.turn(threadId, { ...threadOptions, fork: true }, input, turnOptions) };
  }

  /**
   * Starts the app-server for a turn not yet asked for — spawned,
   * handshaken and with its thread opened — so that turn starts with
   * `turn/start` alone (`AgentProvider.prewarm`). The same call for the
   * same thread keeps the one already warm.
   */
  prewarm(resumeId: string | null, threadOptions: CodexThreadOptions, warmKey?: string): void {
    const key = this.warmKey(resumeId, threadOptions, warmKey);
    if (key === null || warmThread?.key === key) {
      // Nothing started, so nothing will be spawned with this client's
      // bearer: let go of it now (EO-444).
      this.options.afterTurn?.();
      if (warmThread && key !== null) {
        clearTimeout(warmThread.timer);
        warmThread.timer = warmTimer();
      }
      return;
    }
    dropWarmThread();
    const ready = this.openThread(resumeId, threadOptions, async (method, params, connection) => connection.request(method, params)).catch((error: unknown) => {
      // A warm-up is a saving, never a requirement: the turn opens the
      // ordinary way if this could not.
      console.warn("[eo] could not start Codex ahead of a turn:", error);
      return null;
    });
    warmThread = { key, ready, timer: warmTimer(), ...(this.options.afterTurn ? { release: this.options.afterTurn } : {}) };
  }

  /** What a warm process must have been started with: the binary, its arguments and environment, the thread, and the caller's key. */
  private warmKey(resumeId: string | null, threadOptions: CodexThreadOptions, warmKey: string | undefined): string | null {
    try {
      const env = this.options.env ? { ...this.options.env, ...Object.fromEntries((this.options.perTurnEnv ?? []).filter((name) => name in this.options.env!).map((name) => [name, "<per turn>"])) } : null;
      return JSON.stringify([this.options.executablePath ?? null, configArguments(this.options.config, threadOptions), env, resumeId, threadOptions, warmKey ?? null]);
    } catch {
      return null;
    }
  }

  /** The warm process, if it was started for exactly this; otherwise none, and the warm one is let go. */
  private async takeWarm(key: string | null, signal: AbortSignal | undefined): Promise<WarmThread | null> {
    if (!warmThread || key === null || warmThread.key !== key) {
      dropWarmThread();
      return null;
    }
    const taken = warmThread;
    warmThread = null;
    clearTimeout(taken.timer);
    // Still opening, possibly: a cancel meanwhile ends the wait — and the
    // warm process with it — rather than letting the turn start after it.
    const cancelled = new Promise<"cancelled">((resolve) => {
      if (signal?.aborted) resolve("cancelled");
      else signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    const ready = await Promise.race([taken.ready, cancelled]);
    if (ready === "cancelled") {
      closeWarm(taken);
      throw abortError(signal!);
    }
    // One that died while it waited is no use: the turn opens the
    // ordinary way rather than failing on a process that is gone.
    if (ready !== null && (ready.pipe.exit !== null || goneUnreported(ready.pipe.connection.pid))) {
      ready.pipe.release();
      taken.release?.();
      return null;
    }
    if (ready === null) {
      taken.release?.();
      return null;
    }
    return { ...ready, ...(taken.release ? { release: taken.release } : {}) };
  }

  /**
   * Spawns, handshakes and opens the thread. Shared by a turn and by a
   * warm-up, so the two cannot open a thread differently.
   */
  private async openThread(
    resumeId: string | null,
    threadOptions: CodexThreadOptions,
    ask: (method: string, params: unknown, connection: AppServerConnection) => Promise<unknown>,
    pipe?: Pipe,
  ): Promise<WarmThread> {
    const executablePath = this.options.executablePath;
    if (!executablePath) throw new Error(CODEX_NOT_INSTALLED);
    const opened = pipe ?? new Pipe(this.connect(threadOptions));
    try {
      return await this.openOn(opened, resumeId, threadOptions, ask);
    } catch (error) {
      // A process this built is this call's to stop: a warm-up that failed
      // half way must not leave an app-server running until EO quits. One
      // handed in belongs to the turn, whose own `finally` closes it.
      if (!pipe) {
        opened.release();
        opened.connection.close();
      }
      throw error;
    }
  }

  private async openOn(
    opened: Pipe,
    resumeId: string | null,
    threadOptions: CodexThreadOptions,
    ask: (method: string, params: unknown, connection: AppServerConnection) => Promise<unknown>,
  ): Promise<WarmThread> {
    await opened.connection.initialize();
    const cwd = threadOptions.workingDirectory ?? process.cwd();
    const threadParams = {
      ...(threadOptions.model ? { model: threadOptions.model } : {}),
      cwd,
      ...(threadOptions.sandboxMode ? { sandbox: threadOptions.sandboxMode } : {}),
      ...(threadOptions.approvalPolicy ? { approvalPolicy: threadOptions.approvalPolicy } : {}),
      ...(threadOptions.baseInstructions ? { baseInstructions: threadOptions.baseInstructions } : {}),
      ...(threadOptions.ephemeral ? { ephemeral: true } : {}),
    };
    const answer = (resumeId === null
      ? await ask("thread/start", threadParams, opened.connection)
      : // `excludeTurns`: EO needs the thread, not its history replayed
        // back to it — and full-history hydration is deprecated for
        // the paginated threads 0.161.0 writes (`ThreadResumeParams` is
        // unchanged at 0.163.0, 0.165.0 and 0.166.0).
        // `thread/fork` takes the same parameters (0.166.0's
        // `ThreadForkParams`), and answers with the copy's id.
        await ask(threadOptions.fork ? "thread/fork" : "thread/resume", { threadId: resumeId, ...threadParams, excludeTurns: true }, opened.connection)) as { thread?: { id?: unknown }; model?: unknown } | undefined;
    // Never the thread asked for, on a fork: a copy that named no id of
    // its own would otherwise be reported as the original, and the turn
    // on it would be taken for one on the item's own thread.
    const threadId = typeof answer?.thread?.id === "string" ? answer.thread.id : threadOptions.fork ? null : resumeId;
    // The model the thread actually runs on (EO-374). Not necessarily
    // the one asked for: with none named, the CLI picks its own default
    // — which at 0.161.0 was not the model `model/list` calls default.
    //
    // Only the app-server's word for it, never the model EO asked for.
    // A turn is priced at this, and pricing at a request would let a
    // budget decide on a cost nobody measured. An answer that names no
    // model leaves it unknown, so the turn is reported unpriced unless
    // a `model/rerouted` names one later.
    const model = typeof answer?.model === "string" && answer.model ? answer.model : null;
    if (!threadId) throw new Error(`${resumeId === null ? "thread/start" : threadOptions.fork ? "thread/fork" : "thread/resume"} returned no thread id`);
    return { pipe: opened, threadId, model };
  }

  private connect(threadOptions: CodexThreadOptions): AppServerConnection {
    return new AppServerConnection({
      executablePath: this.options.executablePath!,
      args: configArguments(this.options.config, threadOptions),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    });
  }

  private turn(resumeId: string | null, threadOptions: CodexThreadOptions, input: string, turnOptions: CodexTurnOptions): CodexTurn {
    const live = new LiveTurn();
    // `afterTurn`, once: from the end of the turn — or, for a turn never
    // read, cancelled first or let go of unread, from here, since no
    // `finally` of its will run (EO-444).
    let ended = false;
    const afterTurn = () => {
      if (ended) return;
      ended = true;
      this.options.afterTurn?.();
    };
    const state = { started: false };
    const events = this.run(resumeId, threadOptions, input, turnOptions, live, afterTurn, state);
    const unread = () => {
      if (!state.started) afterTurn();
    };
    turnOptions.signal?.addEventListener("abort", unread, { once: true });
    const close = events.return.bind(events);
    events.return = (value) => {
      unread();
      return close(value);
    };
    return {
      events,
      interrupt: () => live.interrupt(),
      steer: (message) => live.steer(message),
    };
  }

  /**
   * One turn: spawn, handshake, open or resume the thread, start the
   * turn, and translate notifications until it completes.
   *
   * One process per turn, as `codex exec` was. Every MCP server a turn
   * is configured with is named on this process's command line, and the
   * repository server is one item's (EO-151), so a process kept across
   * turns would be one item's index answering another item's questions.
   */
  private async *run(
    resumeId: string | null,
    threadOptions: CodexThreadOptions,
    input: string,
    turnOptions: CodexTurnOptions,
    live: LiveTurn,
    afterTurn: () => void,
    state: { started: boolean },
  ): AsyncGenerator<ThreadEvent> {
    state.started = true;
    // What the warm process this turn adopted was spawned with, if it
    // adopted one: its bearer is the one the turn ran under (EO-444).
    const adopted: { release?: () => void } = {};
    try {
      yield* this.runTurn(resumeId, threadOptions, input, turnOptions, live, adopted);
    } finally {
      // However the turn ended — completed, failed, cancelled, abandoned —
      // there is nothing left to steer or interrupt, and a control still
      // waiting for the turn to start is answered now.
      live.end();
      // After `runTurn`'s own finally, which is where the process is shut
      // down: by now nothing it spawned is still talking to anyone.
      afterTurn();
      adopted.release?.();
    }
  }

  private async *runTurn(
    resumeId: string | null,
    threadOptions: CodexThreadOptions,
    input: string,
    turnOptions: CodexTurnOptions,
    live: LiveTurn,
    adopted: { release?: () => void },
  ): AsyncGenerator<ThreadEvent> {
    const signal = turnOptions.signal;
    if (signal?.aborted) throw abortError(signal);
    const executablePath = this.options.executablePath;
    if (!executablePath) throw new Error(CODEX_NOT_INSTALLED);
    // No repository check here (EO-386). `codex exec` made one and the
    // app-server does not, and for a while this client re-made it — which
    // left the question to one backend and answered it by the agent's
    // role. Whether a turn must be inside a Git repository is a fact
    // about the item's workspace, so the supervisor asks the workspace
    // kind before either adapter is called (`WorkspaceKind.refusesTurn`).

    // A process started for exactly this turn while it was being typed
    // (`prewarm`), already past its handshake and its thread opened; or,
    // as always, a new one.
    const warm = await this.takeWarm(this.warmKey(resumeId, threadOptions, turnOptions.warmKey), signal);
    if (warm?.release) adopted.release = warm.release;
    const pipe = warm?.pipe ?? new Pipe(this.connect(threadOptions));
    const connection = pipe.connection;
    pipe.watch((notification) => live.observe(notification));

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      connection.close();
      pipe.nudge();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // A request that failed because the run was cancelled under it is a
    // cancellation, said the way the supervisor recognises one
    // (`isAbortError`), and not the "connection closed" it looks like
    // from here.
    const ask = async (method: string, params: unknown): Promise<unknown> => {
      try {
        return await connection.request(method, params);
      } catch (error) {
        if (aborted && signal) throw abortError(signal);
        throw error;
      }
    };

    let completed = false;
    try {
      let opened: WarmThread;
      try {
        opened = warm ?? (await this.openThread(resumeId, threadOptions, (method, params) => ask(method, params), pipe));
      } catch (error) {
        if (aborted && signal) throw abortError(signal);
        throw error;
      }
      const { threadId, model } = opened;
      // On a resume too, with the same id: `codex exec resume` did the
      // same, and it is what records the thread a run is on (E-04).
      yield { type: "thread.started", thread_id: threadId, ...(model === null ? {} : { model }) };

      const started = (await ask("turn/start", {
        threadId,
        input: [{ type: "text", text: input, text_elements: [] }],
        ...(threadOptions.modelReasoningEffort ? { effort: threadOptions.modelReasoningEffort } : {}),
        ...(threadOptions.reasoningSummary ? { summary: threadOptions.reasoningSummary } : {}),
        ...(turnOptions.outputSchema !== undefined ? { outputSchema: turnOptions.outputSchema } : {}),
      })) as { turn?: { id?: unknown } } | undefined;
      const turnId = typeof started?.turn?.id === "string" ? started.turn.id : null;
      if (!turnId) throw new Error("turn/start returned no turn id");

      live.begin(connection, threadId, turnId);
      const configured = this.options.config?.["mcp_servers"];
      const translator = new TurnTranslator(threadId, turnId, isPlainObject(configured) ? Object.keys(configured) : [], model);
      // A cancel outranks anything already queued. The consumer can abort
      // while holding an event this loop yielded, and by then the queue
      // may hold the rest of the turn, `turn/completed` included: draining
      // it would close the process and still report a finished turn. So
      // the abort is asked before every notification, after every event
      // handed out, and before a completion is accepted.
      const stopIfCancelled = () => {
        if (signal && (aborted || signal.aborted)) throw abortError(signal);
      };
      for (;;) {
        while (pipe.queue.length > 0) {
          stopIfCancelled();
          const notification = pipe.queue.shift() as AppServerNotification;
          const { events, recognised, done } = translator.translate(notification);
          if (!recognised) this.options.onUnmappedNotification?.(notification);
          // Before the turn's last events are handed out, as Claude's
          // adapter marks its turn over before yielding the result: a
          // message steered after this has no turn left to join.
          if (done) live.end();
          for (const event of events) {
            yield event;
            stopIfCancelled();
          }
          if (done) {
            stopIfCancelled();
            completed = true;
            return;
          }
        }
        stopIfCancelled();
        if (pipe.exit) throw new AppServerExitedError(pipe.exit);
        await pipe.wait();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      pipe.release();
      // Awaited either way (EO-493): the turn is not over — and the
      // supervisor opens no other turn on this thread — until its
      // app-server has exited. One abandoned mid-turn, for a correction,
      // is ended outright; it has nothing to finish that EO will read.
      if (completed) await connection.shutdown(this.options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS, this.options.killGraceMs);
      else await connection.terminate(this.options.killGraceMs);
    }
  }
}

/**
 * The turn a `CodexTurn`'s two controls reach (EO-373).
 *
 * Built before anything is spawned, because `runStreamed` hands the
 * controls back before its generator has run a line: the process, the
 * thread and the turn id all arrive later, from inside `run`. A control
 * used before then waits for the turn to start rather than being dropped
 * — the "accepted and then does nothing" Claude's `deferred` exists to
 * prevent — and is answered as soon as the turn either starts or ends
 * without starting.
 */
class LiveTurn {
  private target: { connection: AppServerConnection; threadId: string; turnId: string } | null = null;
  private over = false;
  private readonly waiters: (() => void)[] = [];
  /**
   * The turns that have completed an item since their last token reading
   * — that owe a reading, in other words. See `interrupt`. By turn id and
   * kept from the first notification, because the turn's first items can
   * arrive in the same read as the `turn/start` answer that names it.
   */
  private readonly usageOwed = new Set<string>();
  private readonly usageWaiters: (() => void)[] = [];

  /** The turn is running: `turn/start` answered with its id. */
  begin(connection: AppServerConnection, threadId: string, turnId: string): void {
    if (this.over) return;
    this.target = { connection, threadId, turnId };
    this.wake();
  }

  /** Nothing more can reach this turn. Called on `turn/completed` and again when `run` lets go. */
  end(): void {
    this.over = true;
    this.target = null;
    this.wake();
    this.usageSettled();
  }

  /** Every notification, as it arrives: keeps `usageOwed` true to what the app-server has said. */
  observe(notification: AppServerNotification): void {
    const turnId = (notification.params as { turnId?: unknown } | null | undefined)?.turnId;
    if (typeof turnId !== "string") return;
    if (notification.method === "item/completed") this.usageOwed.add(turnId);
    else if (notification.method === "thread/tokenUsage/updated") {
      this.usageOwed.delete(turnId);
      if (turnId === this.target?.turnId) this.usageSettled();
    }
  }

  /**
   * Ends the turn — once any token reading it still owes has arrived, or
   * `USAGE_SETTLE_MS` has passed.
   *
   * The wait is the difference between an escalated run recording what
   * it spent and recording nothing. The app-server reports a model
   * response's tokens just after the last call that response made comes
   * back — a few milliseconds after, at 0.161.0 — and an escalation is
   * exactly such a call, so the supervisor's interrupt lands in that
   * window. Measured live: interrupting at once lost the reading on one
   * run in four; the turn ended `interrupted` with the rate-limit reading
   * sent and no `thread/tokenUsage/updated` at all. Bounded, so an
   * app-server that never says cannot hold the interrupt up for longer
   * than a second.
   */
  async interrupt(): Promise<void> {
    const target = await this.running();
    if (!target) return;
    if (this.usageOwed.has(target.turnId)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolveWait) => this.usageWaiters.push(resolveWait)),
        new Promise<void>((resolveLater) => {
          timer = setTimeout(resolveLater, USAGE_SETTLE_MS);
        }),
      ]);
      clearTimeout(timer);
      if (this.over) return;
    }
    try {
      await target.connection.request("turn/interrupt", { threadId: target.threadId, turnId: target.turnId });
    } catch {
      // Best effort, as Claude's is: the turn finished first, or the
      // connection is gone. Either way the caller drains and stops.
    }
  }

  async steer(message: string): Promise<boolean> {
    const target = await this.running();
    if (!target) return false;
    try {
      // `expectedTurnId` makes the server refuse a message meant for a
      // turn that has already given way to another, rather than folding
      // it into the wrong one. Measured at 0.161.0: a steer after the
      // turn completed is refused "no active turn to steer" (-32600) —
      // the turn-over answer, not a failure.
      await target.connection.request("turn/steer", {
        threadId: target.threadId,
        expectedTurnId: target.turnId,
        input: [{ type: "text", text: message, text_elements: [] }],
      });
      return true;
    } catch {
      return false;
    }
  }

  private async running(): Promise<{ connection: AppServerConnection; threadId: string; turnId: string } | null> {
    while (!this.target && !this.over) await new Promise<void>((resolveWait) => this.waiters.push(resolveWait));
    return this.over ? null : this.target;
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private usageSettled(): void {
    for (const waiter of this.usageWaiters.splice(0)) waiter();
  }
}

/** What Node's own aborted spawn throws, which is what the SDK let through and the supervisor reads. */
function abortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

/**
 * The `-c key=value` overrides the app-server is launched with.
 *
 * `config` is flattened exactly as the SDK flattened it for `codex exec`
 * — dotted keys, TOML values — because the two subcommands parse
 * `--config` identically and `buildCodexOptions` was written, and its
 * comments reasoned, against that flattening. `web_search` is the one
 * thread option that has no `thread/start` field and travelled as an
 * override under the SDK too.
 */
export function configArguments(config: Record<string, unknown> | undefined, threadOptions: CodexThreadOptions = {}): string[] {
  const overrides = config ? serializeConfigOverrides(config) : [];
  if (threadOptions.webSearchEnabled === true) overrides.push(`web_search="live"`);
  else if (threadOptions.webSearchEnabled === false) overrides.push(`web_search="disabled"`);
  return overrides.flatMap((override) => ["-c", override]);
}

export function serializeConfigOverrides(config: Record<string, unknown>): string[] {
  const overrides: string[] = [];
  flatten(config, "", overrides);
  return overrides;
}

/**
 * Each leaf as its own `path=value`, except where a key would not survive
 * being a path segment (EO-377).
 *
 * Codex splits an override's key on every `.` — quoted or not: `-c
 * 'a."X.Foo"=1'` is read as the segments `a`, `"X` and `Foo"`. So a key
 * holding a dot cannot be written as part of a path, and an HTTP header
 * name may hold one (`X.Foo` is valid, and the catalogue accepts it).
 * The object such a key sits in is written instead as one inline TOML
 * table at its own path, where `toTomlValue` quotes the key — which is
 * the form the pinned binary was observed to read back as a map with
 * `X.Foo` in it.
 */
function flatten(value: Record<string, unknown>, prefix: string, overrides: string[]): void {
  const entries = Object.entries(value);
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }
  if (entries.some(([key]) => key.includes("."))) {
    if (!prefix) throw new Error("Codex config override keys at the top level must not contain a dot");
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }
  for (const [key, child] of entries) {
    if (!key) throw new Error("Codex config override keys must be non-empty strings");
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) flatten(child, path, overrides);
    else overrides.push(`${path}=${toTomlValue(child, path)}`);
  }
}

function toTomlValue(value: unknown, path: string): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${path} must be a finite number`);
    return `${value}`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item, index) => toTomlValue(item, `${path}[${index}]`)).join(", ")}]`;
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) throw new Error("Codex config override keys must be non-empty strings");
      if (child === undefined) continue;
      parts.push(`${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${toTomlValue(child, `${path}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${path}: ${value === null ? "null" : typeof value}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------
// Translation: app-server notifications → the `exec` vocabulary.
// ---------------------------------------------------------------------

/**
 * Notifications EO receives and deliberately does nothing with.
 *
 * Listed rather than defaulted, so that anything *not* here and not
 * translated below reaches `onUnmappedNotification` — a binary that
 * starts saying something new shows up, as `onUnmappedEvent` always made
 * a new `exec` event show up (EO-179).
 *
 * The item deltas still here are because EO records an item when it
 * completes and not before — the rule `mapThreadEvent` has always kept.
 * An agent message's and a reasoning summary's deltas left this list when
 * the chat started streaming words as they are written; they are passed
 * on as transient `item.delta`s and still never stored. The plan-limit
 * readings and the MCP startup report used to be on this list too, until
 * EO-373 read them.
 */
const IGNORED_NOTIFICATIONS = new Set([
  // Ours is emitted from the `thread/start` response instead, which also
  // covers a resume, where there is no such notification.
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "thread/settings/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/queue/changed",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/project/updated",
  "thread/prediction/updated",
  "thread/attachment/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/closed",
  "thread/deleted",
  "thread/reverted",
  // New at 0.163.0 (EO-453): a client's unread marker for a thread,
  // which is a sidebar's business and not a run's.
  "thread/readState/changed",
  "project/changed",
  "skills/changed",
  "remoteControl/status/changed",
  "account/updated",
  "account/gatewayOAuth/changed",
  "account/login/completed",
  "app/list/updated",
  "mcpServer/oauthLogin/completed",
  "mcpServer/event/stream/notification",
  "model/verification",
  "model/safetyBuffering/updated",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "turn/diff/updated",
  "turn/moderationMetadata",
  "item/plan/delta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "autoApprovalReview/strictReviewRequired",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "serverRequest/resolved",
  "hook/started",
  "hook/completed",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "fs/changed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "windowsSandbox/setupCompleted",
  // About the Windows *sandbox*, which EO does not use: every thread is
  // opened `danger-full-access` (EO-178).
  "windows/worldWritableWarning",
  // About EO's use of the protocol, not about the agent's work. Said in
  // the console for whoever maintains this file, not in a run's events.
  "deprecationNotice",
]);

/** Thread items that `exec` never surfaced and that carry nothing EO records. */
/**
 * What the app-server sends while a turn is at work with nothing to show
 * yet: output as a command prints it, a file patch as it is applied, an
 * MCP tool's progress, the model's raw reasoning and plan as they form.
 * None of it is recorded — `item.completed` is the record — but each is
 * the backend being busy, which the inactivity guard has to be told.
 */
const WORKING_NOTIFICATIONS = new Set([
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/reasoning/textDelta",
  "item/plan/delta",
]);

/** The items whose start is passed on: a tool at work, which nothing else reports until it ends. */
const STARTED_TOOL_ITEMS = new Set<ThreadItem["type"]>(["command_execution", "mcp_tool_call"]);

/** The fewest milliseconds between two heartbeats from one turn. */
const HEARTBEAT_EVERY_MS = 5_000;

/** How close together two announcements of a compaction must be to be one compaction. */
const COMPACTION_ECHO_MS = 10_000;

const IGNORED_ITEMS = new Set(["userMessage", "hookPrompt", "contextCompaction", "imageView", "enteredReviewMode", "exitedReviewMode", "sleep"]);

type Translation = { events: ThreadEvent[]; recognised: boolean; done?: boolean };

type Breakdown = { inputTokens?: unknown; cachedInputTokens?: unknown; cacheWriteInputTokens?: unknown; outputTokens?: unknown; reasoningOutputTokens?: unknown };

/**
 * One turn's notifications, translated in order. Stateful because three
 * things `exec` reported at the end of a turn are assembled from several
 * notifications here: the usage, the plan and the outcome.
 */
export class TurnTranslator {
  /** The thread's running total before this turn began; zero for a new thread. */
  private baseline: Usage = zeroUsage();
  private total: Usage | null = null;
  private plan: { step: string; status: string }[] | null = null;
  private warnings = 0;
  /** When this turn last said it was at work (`WORKING_NOTIFICATIONS`). */
  private lastHeartbeatAt = 0;
  /** The compaction items already passed on, and when each kind of announcement last was. */
  private readonly compactionItems = new Set<string>();
  private lastCompactionBy: Record<"item" | "notice", number> = { item: 0, notice: 0 };

  /**
   * One compaction per compaction. The app-server may say so as an item
   * and as a notification: an item is known by its id, and an
   * announcement of the *other* kind a moment after one is the same
   * compaction. Two items are two compactions, however close together.
   */
  private compaction(by: "item" | "notice", id: string | null): ThreadEvent[] {
    const at = Date.now();
    if (id !== null) {
      if (this.compactionItems.has(id)) return [];
      this.compactionItems.add(id);
    }
    const other = by === "item" ? "notice" : "item";
    const echo = at - this.lastCompactionBy[other] < COMPACTION_ECHO_MS;
    this.lastCompactionBy[by] = at;
    if (echo) {
      this.lastCompactionBy[other] = 0;
      return [];
    }
    return [{ type: "compacted" }];
  }
  /** The last plan-limit reading passed on, so an unchanged one is not recorded again. */
  private lastReading: string | null = null;
  /** Each MCP server's startup as last reported, by name (EO-373). */
  private readonly startups = new Map<string, McpServerStartup>();
  private startupsReported = false;

  constructor(
    private readonly threadId: string,
    private readonly turnId: string,
    /**
     * The MCP servers EO launched this turn with — the names in its
     * `mcp_servers` config. The startup report waits for every one of
     * them to have settled before it is said (`startupReport`).
     */
    private readonly configuredServers: readonly string[] = [],
    /**
     * The model the thread was opened on, as the app-server named it
     * (EO-374), until a `model/rerouted` for this turn says otherwise.
     */
    private model: string | null = null,
  ) {}

  translate(notification: AppServerNotification): Translation {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    switch (notification.method) {
      case "turn/started":
        return { events: this.isOurTurn(turnIdOf(params)) ? [{ type: "turn.started" }] : [], recognised: true };

      // The words as they are generated, for a person watching (EO's
      // `item.delta`). Raw reasoning (`item/reasoning/textDelta`) stays
      // ignored: the summary is what a person is shown, as with Claude.
      // A reasoning summary arrives in parts, and the finished item joins
      // them with a line break; the draft does the same, so it does not
      // read as one run-on paragraph until it is stored.
      case "item/reasoning/summaryPartAdded": {
        if (!this.isOurTurn(params["turnId"])) return { events: [], recognised: true };
        const index = typeof params["summaryIndex"] === "number" ? params["summaryIndex"] : 0;
        return { events: index > 0 ? [{ type: "item.delta", stream: "reasoning", text: "\n" }] : [], recognised: true };
      }

      case "item/agentMessage/delta":
      case "item/reasoning/summaryTextDelta": {
        if (!this.isOurTurn(params["turnId"])) return { events: [], recognised: true };
        const text = typeof params["delta"] === "string" ? params["delta"] : "";
        const stream = notification.method === "item/agentMessage/delta" ? "text" : "reasoning";
        return { events: text === "" ? [] : [{ type: "item.delta", stream, text }], recognised: true };
      }

      // The thread was compacted. Said two ways by the app-server — this
      // notification and a `contextCompaction` item — and passed on once
      // for either (`compaction`).
      case "thread/compacted":
        if (!this.isOurThread(params["threadId"], true)) return { events: [], recognised: true };
        return { events: this.compaction("notice", null), recognised: true };

      // A tool call begun (`HeartbeatEvent.call`): passed on so the
      // inactivity guard knows it is running. Only tool items — a message
      // or a reasoning block starting says nothing the deltas do not.
      case "item/started": {
        if (!this.isOurTurn(params["turnId"])) return { events: [], recognised: true };
        const item = translateItem(params["item"]);
        if (item === "ignored" || item === null) return { events: [], recognised: true };
        return { events: STARTED_TOOL_ITEMS.has(item.type) ? [{ type: "item.started", item }] : [], recognised: true };
      }

      case "item/completed": {
        if (!this.isOurTurn(params["turnId"])) return { events: [], recognised: true };
        const completing = params["item"] as { type?: unknown; id?: unknown } | undefined;
        if (completing?.type === "contextCompaction") return { events: this.compaction("item", typeof completing.id === "string" ? completing.id : null), recognised: true };
        const item = translateItem(params["item"]);
        return item === "ignored" ? { events: [], recognised: true } : item === null ? { events: [], recognised: false } : { events: [{ type: "item.completed", item }], recognised: true };
      }

      // A running total, per thread. Read twice over: the last one before
      // this turn is where it started — a resume restates the thread's
      // total before anything else happens — and the last one during it
      // is where it ended.
      case "thread/tokenUsage/updated": {
        const total = usageOf((params["tokenUsage"] as { total?: Breakdown } | undefined)?.total);
        if (!this.isOurTurn(params["turnId"])) {
          this.baseline = total;
          return { events: [], recognised: true };
        }
        this.total = total;
        return { events: [{ type: "turn.usage", usage: this.turnUsage(), ...this.modelNamed() }], recognised: true };
      }

      // The turn moved to another model (EO-374), and is priced at the
      // one it ended on. Splitting its tokens at the reroute would need
      // a reading taken at that moment, and the running total carries
      // no mark of where the reroute fell.
      case "model/rerouted":
        if (this.isOurTurn(params["turnId"]) && typeof params["toModel"] === "string" && params["toModel"]) this.model = params["toModel"];
        return { events: [], recognised: true };

      // `exec` reported the plan tool as one `todo_list` item, completed
      // with the turn and holding the plan as it stood at the end.
      case "turn/plan/updated":
        if (this.isOurTurn(params["turnId"]) && Array.isArray(params["plan"])) this.plan = params["plan"] as { step: string; status: string }[];
        return { events: [], recognised: true };

      case "turn/completed":
        return this.completed(params["turn"]);

      // The fatal channel, unless the server says it is retrying — a
      // dropped stream it is about to reconnect, which has not ended
      // anything and is recorded as the warning it is.
      case "error": {
        // One without a thread is about this process, which runs only
        // this thread — kept rather than dropped (invariant 8).
        if (!this.isOurThread(params["threadId"], true)) return { events: [], recognised: true };
        const error = params["error"] as { message?: unknown; codexErrorInfo?: unknown } | undefined;
        const message = typeof error?.message === "string" ? error.message : "Codex reported an error";
        if (params["willRetry"] === true) return { events: [{ type: "retrying", message }], recognised: true };
        return { events: [{ type: "error", message, ...errorInfo(error?.codexErrorInfo) }], recognised: true };
      }

      // What the plan has left (EO-373). Not tied to a thread — it is the
      // account's — and sent after every model response, so a reading the
      // same as the last one is not passed on again: forty identical rows
      // in a run's events say nothing the first did not.
      case "account/rateLimits/updated": {
        const snapshot = rateLimitSnapshotOf(params["rateLimits"]);
        if (!snapshot) return { events: [], recognised: true };
        const key = JSON.stringify(snapshot);
        if (key === this.lastReading) return { events: [], recognised: true };
        this.lastReading = key;
        return { events: [{ type: "rate_limits.updated", rate_limits: snapshot }], recognised: true };
      }

      // One server at a time, and not only once: measured at 0.161.0, a
      // server that cannot start is reported `starting` then `failed`,
      // and then the same pair again as the turn begins. Collected here
      // and said once, as one report, because that is what the
      // supervisor judges — a report naming one server reads every other
      // attached server as one that never came up.
      case "mcpServer/startupStatus/updated": {
        if (!this.isOurThread(params["threadId"], true)) return { events: [], recognised: true };
        const name = params["name"];
        const status = params["status"];
        if (typeof name !== "string" || typeof status !== "string") return { events: [], recognised: true };
        const error = typeof params["error"] === "string" && params["error"] ? { error: params["error"] } : {};
        this.startups.set(name, { name, status, ...error });
        return { events: this.startupReport(false), recognised: true };
      }

      // Warnings, which `exec` delivered as a non-fatal `ErrorItem` and the
      // app-server delivers as notifications of their own. Translated
      // into the former, so EO-369 holds unchanged: recorded in the run's
      // events, and the run goes on.
      case "warning":
      case "guardianWarning": {
        if (!this.isOurThread(params["threadId"], true)) return { events: [], recognised: true };
        const message = typeof params["message"] === "string" ? params["message"] : "";
        return { events: message ? [this.warning(message)] : [], recognised: true };
      }
      case "configWarning": {
        const summary = typeof params["summary"] === "string" ? params["summary"] : "";
        const details = typeof params["details"] === "string" && params["details"] ? params["details"] : "";
        const message = [summary, details].filter(Boolean).join("\n");
        return { events: message ? [this.warning(message)] : [], recognised: true };
      }

      default:
        // The turn at work: passed on as a heartbeat, at most one every few
        // seconds — a command can print far faster than anybody needs to
        // be told it is still printing.
        if (WORKING_NOTIFICATIONS.has(notification.method) && this.isOurThread(params["threadId"], true)) {
          const at = Date.now();
          if (at - this.lastHeartbeatAt < HEARTBEAT_EVERY_MS) return { events: [], recognised: true };
          this.lastHeartbeatAt = at;
          return { events: [{ type: "heartbeat" }], recognised: true };
        }
        if (notification.method === "deprecationNotice") {
          const summary = typeof params["summary"] === "string" ? params["summary"] : "";
          console.warn(`[codex] app-server deprecation notice: ${summary}`);
        }
        return { events: [], recognised: IGNORED_NOTIFICATIONS.has(notification.method) };
    }
  }

  private completed(value: unknown): Translation {
    const turn = (value ?? {}) as { id?: unknown; status?: unknown; error?: { message?: unknown } | null };
    if (!this.isOurTurn(turn.id)) return { events: [], recognised: true };
    // A report still waiting on a server is said now, as it stands:
    // there is no later for it.
    const events: ThreadEvent[] = this.startupReport(true);
    if (this.plan && this.plan.length > 0) {
      events.push({
        type: "item.completed",
        item: { id: `${this.turnId}-plan`, type: "todo_list", items: this.plan.map((step) => ({ text: String(step.step), completed: step.status === "completed" })) },
      });
    }
    if (turn.status === "completed") {
      events.push({ type: "turn.completed", usage: this.turnUsage(), ...this.modelNamed() });
    } else {
      const message = typeof turn.error?.message === "string" && turn.error.message ? turn.error.message : `Codex turn ${String(turn.status ?? "ended")}`;
      const info = errorInfo((turn.error as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo);
      // What the turn spent before it stopped, when the app-server said
      // (EO-373). An interrupted turn is the case this is for: EO
      // interrupts a turn whose agent has escalated, and the tokens it
      // spent getting there were real. Only when a reading arrived for
      // this turn — a turn refused before the model answered spent
      // nothing, and a zero would claim a measurement nobody made.
      events.push({ type: "turn.failed", error: { message, ...(info.codex_error_info === undefined ? {} : info) }, ...(this.total ? { usage: this.turnUsage(), ...this.modelNamed() } : {}) });
    }
    return { events, recognised: true, done: true };
  }

  /**
   * This turn's own tokens: where the thread's total ended, less where
   * it started.
   *
   * Not the total itself, which is what `codex exec` reported — measured
   * at 0.161.0, a resumed `exec` turn's `turn.completed` carried the
   * whole thread's input, history included. `mapThreadEvent` records it
   * as one turn's cost and the run's figure is the sum of them, so on
   * a resumed thread that counted every earlier turn again. The
   * app-server states the running total before the turn begins, which
   * is what makes the turn's own share readable at all.
   */
  private turnUsage(): Usage {
    const end = this.total ?? this.baseline;
    return {
      input_tokens: Math.max(0, end.input_tokens - this.baseline.input_tokens),
      cached_input_tokens: Math.max(0, end.cached_input_tokens - this.baseline.cached_input_tokens),
      cache_write_input_tokens: Math.max(0, end.cache_write_input_tokens - this.baseline.cache_write_input_tokens),
      output_tokens: Math.max(0, end.output_tokens - this.baseline.output_tokens),
      reasoning_output_tokens: Math.max(0, end.reasoning_output_tokens - this.baseline.reasoning_output_tokens),
    };
  }

  /**
   * The MCP startup report, once — or nothing yet (EO-373).
   *
   * Said as soon as every server EO configured has settled: `ready`, or
   * any word that is not `starting`. Said at the end of the turn in any
   * case, as it stands, if anything was reported at all. A server EO
   * configured that the app-server never mentioned is left out rather
   * than invented, so the supervisor reads it the way it reads Claude's
   * silence about one: as a server that never came up.
   *
   * Nothing is said when nothing was reported, which is what a turn with
   * no servers looks like and what every binary before the app-server
   * did.
   */
  private startupReport(final: boolean): ThreadEvent[] {
    if (this.startupsReported || this.startups.size === 0) return [];
    if (!final) {
      if (this.configuredServers.length === 0) return [];
      const settled = this.configuredServers.every((name) => {
        const status = this.startups.get(name)?.status;
        return status !== undefined && status !== "starting";
      });
      if (!settled) return [];
    }
    this.startupsReported = true;
    return [{ type: "mcp_servers.started", servers: [...this.startups.values()] }];
  }

  /** The model, for an event that carries usage — and nothing, rather than a guess, when none was named. */
  private modelNamed(): { model?: string } {
    return this.model === null ? {} : { model: this.model };
  }

  private warning(message: string): ThreadEvent {
    return { type: "item.completed", item: { id: `${this.turnId}-warning-${this.warnings++}`, type: "error", message } };
  }

  private isOurTurn(turnId: unknown): boolean {
    return turnId === this.turnId;
  }

  /** A warning with no thread named is about the process, and this process runs one thread. */
  private isOurThread(threadId: unknown, nullMeansOurs = false): boolean {
    return threadId === this.threadId || (nullMeansOurs && (threadId === null || threadId === undefined));
  }
}

/** The app-server's own classification of a failure, when it gave one that says anything. */
function errorInfo(value: unknown): { codex_error_info?: unknown } {
  return value === undefined || value === null ? {} : { codex_error_info: value };
}

function windowOf(value: unknown): RateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  };
}

/**
 * The part of a `RateLimitSnapshot` EO reads, or null when it carries no
 * window at all. A rolling update is sparse by the protocol's own
 * account — a null window "does not clear a previously observed value" —
 * so a snapshot with neither window says nothing.
 */
function rateLimitSnapshotOf(value: unknown): RateLimitSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as { limitId?: unknown; limitName?: unknown; primary?: unknown; secondary?: unknown };
  const primary = windowOf(snapshot.primary);
  const secondary = windowOf(snapshot.secondary);
  if (!primary && !secondary) return null;
  return {
    limitId: typeof snapshot.limitId === "string" ? snapshot.limitId : null,
    limitName: typeof snapshot.limitName === "string" ? snapshot.limitName : null,
    primary,
    secondary,
  };
}

function turnIdOf(params: Record<string, unknown>): unknown {
  return (params["turn"] as { id?: unknown } | undefined)?.id;
}

function zeroUsage(): Usage {
  return { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(breakdown: Breakdown | undefined): Usage {
  return {
    input_tokens: count(breakdown?.inputTokens),
    cached_input_tokens: count(breakdown?.cachedInputTokens),
    cache_write_input_tokens: count(breakdown?.cacheWriteInputTokens),
    output_tokens: count(breakdown?.outputTokens),
    reasoning_output_tokens: count(breakdown?.reasoningOutputTokens),
  };
}

/**
 * One app-server `ThreadItem` as the `exec` item it used to arrive as,
 * `"ignored"` for one `exec` never surfaced, or null for one EO does not
 * know — which is reported rather than dropped.
 */
export function translateItem(value: unknown): ThreadItem | "ignored" | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown> & { type?: unknown; id?: unknown };
  const id = typeof item.id === "string" ? item.id : "";
  switch (item.type) {
    case "agentMessage":
      return { id, type: "agent_message", text: stringOr(item["text"]) };

    // The summary is what `exec` reported as a reasoning item's text, and
    // a reasoning item with nothing to say was not reported at all.
    case "reasoning": {
      const summary = Array.isArray(item["summary"]) ? item["summary"].filter((part): part is string => typeof part === "string") : [];
      const content = Array.isArray(item["content"]) ? item["content"].filter((part): part is string => typeof part === "string") : [];
      const text = (summary.length > 0 ? summary : content).join("\n");
      return text ? { id, type: "reasoning", text } : "ignored";
    }

    case "commandExecution": {
      const exitCode = item["exitCode"];
      return {
        id,
        type: "command_execution",
        command: stringOr(item["command"]),
        aggregated_output: stringOr(item["aggregatedOutput"]),
        ...(typeof exitCode === "number" ? { exit_code: exitCode } : {}),
        // `declined` has no counterpart in `exec`'s three, and is a
        // command that did not run — which is what `failed` meant there.
        status: item["status"] === "completed" ? "completed" : item["status"] === "inProgress" ? "in_progress" : "failed",
      };
    }

    case "fileChange": {
      const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
      return {
        id,
        type: "file_change",
        changes: changes.flatMap((change: unknown) => {
          const entry = (change ?? {}) as { path?: unknown; kind?: { type?: unknown } };
          if (typeof entry.path !== "string") return [];
          const kind = entry.kind?.type === "add" || entry.kind?.type === "delete" ? entry.kind.type : "update";
          return [{ path: entry.path, kind }];
        }),
        status: item["status"] === "completed" ? "completed" : "failed",
      };
    }

    case "mcpToolCall": {
      const result = item["result"] as { content?: unknown; structuredContent?: unknown; _meta?: unknown } | null | undefined;
      const error = item["error"] as { message?: unknown } | null | undefined;
      return {
        id,
        type: "mcp_tool_call",
        server: stringOr(item["server"]),
        tool: stringOr(item["tool"]),
        arguments: item["arguments"],
        ...(result
          ? {
              result: {
                content: Array.isArray(result.content) ? result.content : [],
                structured_content: result.structuredContent ?? null,
                ...(result._meta !== undefined && result._meta !== null ? { _meta: result._meta } : {}),
              },
            }
          : {}),
        ...(error ? { error: { message: typeof error.message === "string" ? error.message : "" } } : {}),
        status: item["status"] === "completed" ? "completed" : item["status"] === "inProgress" ? "in_progress" : "failed",
      };
    }

    case "webSearch":
      return { id, type: "web_search", query: stringOr(item["query"]) };

    default:
      return typeof item.type === "string" && IGNORED_ITEMS.has(item.type) ? "ignored" : null;
  }
}

function stringOr(value: unknown): string {
  return typeof value === "string" ? value : "";
}
