import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { AppServerSpawn } from "../providers/codexAppServer.js";
import { DESCENDANTS_SNIPPET } from "./escapingDescendants.js";
import { nodeScript } from "./nodeScript.js";

/**
 * A stand-in for `codex app-server --stdio`, as a real child process.
 *
 * Real rather than in-memory because the things this story has to show
 * are about a process: that it is spawned with `windowsHide`, that a
 * cancelled run ends it, and that nothing is left behind. A fake stream
 * pair could only assert that EO *called* `kill`.
 *
 * It speaks just enough of the protocol to be driven by a scenario: it
 * answers each request — with the scenario's reply for that method, or a
 * plausible default — and then sends the notifications the scenario lists
 * after it. It exits on EOF unless told to linger.
 */
export interface FakeAppServerScenario {
  /** The id `thread/start` answers with. */
  threadId?: string;
  /** The id `thread/fork` answers with: the copy's (EO-716). */
  forkId?: string;
  /** The id `turn/start` answers with. */
  turnId?: string;
  /**
   * The model `thread/start` and `thread/resume` answer with when EO
   * asked for none — the CLI's own default. The real server always names
   * one (EO-374), and names the one asked for when EO asked.
   */
  model?: string;
  /** A method's reply in place of the default. */
  replies?: Record<string, { result: unknown } | { error: { code: number; message: string } }>;
  /**
   * What to send after answering a method, in order. `{ exit }` ends the
   * process there, writing `stderr` first; `{ request }` sends a
   * server→client request. The string `"$THREAD"` anywhere in a
   * notification becomes the id of the thread this process opened,
   * resumed or forked into, so one scenario serves all three. `{ wait }` pauses that many
   * milliseconds before the next entry — a notification the real server
   * sends a moment later, with a request free to arrive in between.
   * `{ fireHook }` posts that `PreToolUse` payload to the listener EO
   * named in this process's environment, as the hook command the real
   * CLI runs would (EO-379), and waits for the answer before going on.
   */
  after?: Record<string, ({ method: string; params: unknown } | { exit: number; stderr?: string } | { request: string } | { wait: number } | { fireHook: Record<string, unknown> })[]>;
  /** Stay alive when stdin closes, as a wedged server would. */
  ignoreEof?: boolean;
  /** Stay alive on SIGTERM too, so only SIGKILL ends it (EO-493). */
  ignoreSigterm?: boolean;
  /** Write a line to stderr at startup. */
  stderr?: string;
  /**
   * At startup, start the two descendants a pid-kill misses
   * (`escapingDescendants.ts`) and write their pids to this file — what
   * the shell and the MCP servers a real app-server starts look like to
   * whoever has to end them (EO-494).
   */
  descendants?: string;
}

const SOURCE = String.raw`
const readline = require("node:readline");
const scenario = JSON.parse(process.argv[2]);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.ignoreEof) setInterval(() => {}, 1000);
if (scenario.ignoreSigterm) process.on("SIGTERM", () => {});
if (scenario.descendants) {
  const pidFile = scenario.descendants;
  ${DESCENDANTS_SNIPPET}
}
const defaults = (message) => {
  switch (message.method) {
    case "initialize": return { userAgent: "fake/0.0.0", codexHome: "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "linux" };
    case "thread/start": return { thread: { id: scenario.threadId || "thr-fake" }, model: message.params.model || scenario.model || "gpt-6.1-sol", modelProvider: "openai" };
    case "thread/resume": return { thread: { id: message.params.threadId }, model: message.params.model || scenario.model || "gpt-6.1-sol", modelProvider: "openai" };
    case "thread/fork": return { thread: { id: scenario.forkId || "thr-fork" }, model: message.params.model || scenario.model || "gpt-6.1-sol", modelProvider: "openai" };
    case "turn/start": return { turn: { id: scenario.turnId || "turn-1", items: [], status: "inProgress", error: null } };
    default: return {};
  }
};
let thread = scenario.threadId || "thr-fake";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined || message.id === undefined) return;
  if (message.method === "thread/resume") thread = message.params.threadId;
  if (message.method === "thread/fork") thread = scenario.forkId || "thr-fork";
  const reply = (scenario.replies || {})[message.method];
  if (reply && reply.error) send({ id: message.id, error: reply.error });
  else send({ id: message.id, result: reply ? reply.result : defaults(message) });
  for (const next of (scenario.after || {})[message.method] || []) {
    if (next.wait !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, next.wait));
      continue;
    }
    if (next.fireHook !== undefined) {
      await fetch(process.env.EO_SEARCH_HOOK_URL, {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.EO_SEARCH_HOOK_TOKEN },
        body: JSON.stringify(next.fireHook),
      }).catch(() => {});
      continue;
    }
    if (next.exit !== undefined) {
      if (next.stderr) process.stderr.write(next.stderr);
      process.exit(next.exit);
    }
    if (next.request) send({ id: "server-request-1", method: next.request, params: {} });
    else send(JSON.parse(JSON.stringify(next).split('"$THREAD"').join(JSON.stringify(thread))));
  }
});
lines.on("close", () => {
  if (!scenario.ignoreEof) process.exit(0);
});
`;

export interface FakeAppServer {
  spawn: AppServerSpawn;
  /** Every launch: what EO asked to run, with which options. */
  launches: { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio; pid: number | undefined }[];
  /** Every JSON-RPC message EO wrote, across launches, parsed. */
  sent: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown }[];
  /** The params of the first request EO made for `method`. */
  paramsOf(method: string): Record<string, unknown> | undefined;
}

export function fakeAppServer(scenario: FakeAppServerScenario = {}): FakeAppServer {
  const launches: FakeAppServer["launches"] = [];
  const sent: FakeAppServer["sent"] = [];
  const fake: FakeAppServer = {
    launches,
    sent,
    paramsOf: (method) => sent.find((message) => message.method === method)?.params as Record<string, unknown> | undefined,
    spawn: (command, args, options) => {
      // The options EO chose are kept and honoured — `env` and the rest —
      // but the program is Node running the scenario.
      const child = spawn(process.execPath, [nodeScript(SOURCE), JSON.stringify(scenario)], { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
      launches.push({ command, args, options, pid: child.pid });
      const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
      child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
        for (const line of String(chunk).split("\n")) if (line.trim()) sent.push(JSON.parse(line) as FakeAppServer["sent"][number]);
        return write(chunk, ...rest);
      }) as typeof child.stdin.write;
      return child;
    },
  };
  return fake;
}

/**
 * Notification builders, in the app-server's own shapes (0.161.0, and
 * re-read against 0.163.0's `generate-ts` at EO-453, 0.165.0's at
 * EO-599 and 0.166.0's at EO-644, which changed none of them — 0.166.0
 * lets every item carry two optional timestamps, which a builder may
 * leave out). The one shape a
 * builder mirrors that moved is `Turn`, which gained `rootTurnId`: a
 * real 0.163.0 turn a person started names itself as its root, which is
 * what both turn builders below now say.
 */
export const note = {
  turnStarted: (turnId = "turn-1", threadId = "thr-fake") => ({ method: "turn/started", params: { threadId, turn: { id: turnId, rootTurnId: turnId, items: [], status: "inProgress", error: null } } }),
  item: (item: Record<string, unknown>, turnId = "turn-1", threadId = "thr-fake") => ({ method: "item/completed", params: { item, threadId, turnId, completedAtMs: 0 } }),
  agentMessage: (text: string, id = "msg-1", turnId = "turn-1", threadId = "thr-fake") =>
    note.item({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null }, turnId, threadId),
  /** More of an agent message, as it is generated. */
  agentMessageDelta: (delta: string, itemId = "msg-1", turnId = "turn-1", threadId = "thr-fake") => ({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta } }),
  /** More of a reasoning summary, as it is generated. */
  reasoningDelta: (delta: string, itemId = "rs-1", turnId = "turn-1", threadId = "thr-fake") => ({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId, turnId, itemId, delta, summaryIndex: 0 },
  }),
  /** A finished reasoning item, its summary in parts. */
  reasoning: (summary: string[], id = "rs-1", turnId = "turn-1", threadId = "thr-fake") => note.item({ type: "reasoning", id, summary, content: [] }, turnId, threadId),
  /** `model/rerouted`: the turn moved to another model (EO-374). */
  rerouted: (fromModel: string, toModel: string, turnId = "turn-1", threadId = "thr-fake") => ({ method: "model/rerouted", params: { threadId, turnId, fromModel, toModel, reason: "highRiskCyberActivity" } }),
  tokenUsage: (total: { input: number; cached?: number; output: number }, turnId = "turn-1", threadId = "thr-fake") => {
    const breakdown = { totalTokens: total.input + total.output, inputTokens: total.input, cachedInputTokens: total.cached ?? 0, cacheWriteInputTokens: 0, outputTokens: total.output, reasoningOutputTokens: 0 };
    return { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: 258_400 } } };
  },
  turnCompleted: (status: "completed" | "failed" | "interrupted" = "completed", error: string | null = null, turnId = "turn-1", threadId = "thr-fake", codexErrorInfo: unknown = null) => ({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, rootTurnId: turnId, items: [], status, error: error === null ? null : { message: error, codexErrorInfo, additionalDetails: null }, startedAt: 0, completedAt: 0, durationMs: 0 } },
  }),
  /** `account/rateLimits/updated`, the plan's own reading: a five-hour and a seven-day window, by default. */
  rateLimits: (
    primary: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null,
    secondary: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null = null,
    limitId: string | null = "codex",
  ) => {
    const window = (value: typeof primary, minutes: number) =>
      value === null ? null : { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins === undefined ? minutes : value.windowDurationMins, resetsAt: value.resetsAt ?? null };
    return {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId,
          limitName: null,
          normalModelSlug: null,
          primary: window(primary, 300),
          secondary: window(secondary, 10_080),
          credits: null,
          individualLimit: null,
          spendControlReached: null,
          planType: "plus",
          rateLimitReachedType: null,
        },
      },
    };
  },
  /** `mcpServer/startupStatus/updated`, one server at a time, as 0.161.0 sends it and 0.163.0, 0.165.0 and 0.166.0 still do. */
  mcpStartup: (name: string, status: "starting" | "ready" | "failed" | "cancelled", error: string | null = null, threadId: string | null = "thr-fake") => ({
    method: "mcpServer/startupStatus/updated",
    params: { threadId, name, status, error, failureReason: null },
  }),
  error: (message: string, willRetry = false, turnId = "turn-1", threadId = "thr-fake") => ({
    method: "error",
    params: { error: { message, codexErrorInfo: "other", additionalDetails: null }, willRetry, threadId, turnId },
  }),
  warning: (message: string, threadId: string | null = "thr-fake") => ({ method: "warning", params: { threadId, message } }),
  configWarning: (summary: string, details: string | null = null) => ({ method: "configWarning", params: { summary, details } }),
};
