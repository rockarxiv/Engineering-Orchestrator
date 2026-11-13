import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerConnection, AppServerExitedError, AppServerRequestError } from "./codexAppServer.js";
import { CODEX_NOT_INSTALLED, CodexClient, configArguments, dropWarmCodexThread, serializeConfigOverrides, translateItem, TurnTranslator, type ThreadEvent } from "./codexClient.js";
import { fakeAppServer, note, type FakeAppServer, type FakeAppServerScenario } from "../testing/fakeCodexAppServer.js";

/**
 * The transport itself (EO-372), against a stubbed `codex app-server`.
 *
 * The stub is a real child process speaking the protocol
 * (`testing/fakeCodexAppServer.ts`), so what is asserted here is what
 * crosses the pipe — the requests EO writes, the notifications it
 * reads — and what happens to the process, which a fake stream could
 * only pretend to.
 */

const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
const directories: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A directory Codex would accept: it has a `.git`. */
function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "eo-codex-client-"));
  mkdirSync(join(directory, ".git"));
  directories.push(directory);
  return directory;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

function client(fake: FakeAppServer, extra: Partial<ConstructorParameters<typeof CodexClient>[0]> = {}): CodexClient {
  return new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200, ...extra });
}

async function drain(events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function captureThrow(events: AsyncIterable<ThreadEvent>): Promise<unknown> {
  try {
    await drain(events);
  } catch (error) {
    return error;
  }
  throw new Error("expected the turn to throw");
}

/** A turn that says one thing and completes, as most of these need. */
const ORDINARY: FakeAppServerScenario = {
  after: {
    "turn/start": [note.turnStarted(), note.agentMessage('{"verdict":"approve"}'), note.tokenUsage({ input: 120, cached: 20, output: 7 }), note.turnCompleted()],
  },
};

describe("a Codex turn over a stubbed app-server", () => {
  it("spawns `app-server --stdio` from the resolved executable, hidden, with the MCP servers on its command line", async () => {
    const fake = fakeAppServer(ORDINARY);
    const cwd = repository();
    const thread = client(fake, { config: { mcp_servers: { eo: { command: "/electron", args: ["/app/eoServer.mjs"], env: { EO_MCP_DB_PATH: "/data/eo.db" } } } } }).startThread({
      workingDirectory: cwd,
    });

    await drain((await thread.runStreamed("go")).events);

    expect(fake.launches).toHaveLength(1);
    const [launch] = fake.launches;
    expect(launch?.command).toBe(EXECUTABLE);
    expect(launch?.args).toEqual([
      "app-server",
      "--stdio",
      "-c",
      'mcp_servers.eo.command="/electron"',
      "-c",
      'mcp_servers.eo.args=["/app/eoServer.mjs"]',
      "-c",
      'mcp_servers.eo.env.EO_MCP_DB_PATH="/data/eo.db"',
    ]);
    expect(launch?.options).toMatchObject({ windowsHide: true });
    // Never `exec`: the subcommand is the first argument, and it is this one.
    expect(launch?.args).not.toContain("exec");
  });

  it("opens a thread in the working directory with the model, sandbox and approval policy it was given", async () => {
    const fake = fakeAppServer(ORDINARY);
    const cwd = repository();
    const thread = client(fake).startThread({ workingDirectory: cwd, model: "gpt-5-codex", sandboxMode: "danger-full-access", approvalPolicy: "never", modelReasoningEffort: "high" });

    await drain((await thread.runStreamed("EO-1: do the thing", { outputSchema: { type: "object", additionalProperties: false } })).events);

    expect(fake.sent.map((message) => message.method).filter(Boolean)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(fake.paramsOf("thread/start")).toEqual({ model: "gpt-5-codex", cwd, sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(fake.paramsOf("turn/start")).toEqual({
      threadId: "thr-fake",
      input: [{ type: "text", text: "EO-1: do the thing", text_elements: [] }],
      effort: "high",
      outputSchema: { type: "object", additionalProperties: false },
    });
  });

  it("sends base instructions as the thread's own, on `thread/start` and never in the turn", async () => {
    const fake = fakeAppServer(ORDINARY);
    const cwd = repository();

    await drain((await client(fake).startThread({ workingDirectory: cwd, baseInstructions: "You are the implementer." }).runStreamed("EO-1: do the thing")).events);

    // The field's shape is 0.161.0's `ThreadStartParams`, read from
    // `codex app-server generate-ts`: an optional string (EO-385), and
    // 0.163.0's (EO-453), 0.165.0's (EO-599), 0.166.0's (EO-644) and
    // 0.167.1's (EO-774) are the same file byte for byte.
    expect(fake.paramsOf("thread/start")).toEqual({ cwd, baseInstructions: "You are the implementer." });
    expect(fake.paramsOf("turn/start")).toEqual({ threadId: "thr-fake", input: [{ type: "text", text: "EO-1: do the thing", text_elements: [] }] });
  });

  it("speaks the `exec` vocabulary, so the provider above maps what it always mapped", async () => {
    const fake = fakeAppServer(ORDINARY);
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(events).toEqual([
      { type: "thread.started", thread_id: "thr-fake", model: "gpt-6.1-sol" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: '{"verdict":"approve"}' } },
      // EO's own: what the turn has used so far, while it runs — what the
      // adapter holds it to a budget by (`AgentTurnOverrides.budgetCents`).
      { type: "turn.usage", usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 }, model: "gpt-6.1-sol" },
      // With the model the thread was opened on, which is what the turn
      // is priced at (EO-374) — the stub's default, since none was asked for.
      { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 }, model: "gpt-6.1-sol" },
    ]);
  });

  it("resumes a thread by id, in the working directory, without asking for its history back", async () => {
    const fake = fakeAppServer(ORDINARY);
    const cwd = repository();
    const events = await drain((await client(fake).resumeThread("thr-persisted", { workingDirectory: cwd, model: "gpt-5", sandboxMode: "danger-full-access", approvalPolicy: "never" }).runStreamed("the human replied")).events);

    expect(fake.paramsOf("thread/resume")).toEqual({ threadId: "thr-persisted", model: "gpt-5", cwd, sandbox: "danger-full-access", approvalPolicy: "never", excludeTurns: true });
    expect(fake.paramsOf("thread/start")).toBeUndefined();
    expect(fake.paramsOf("turn/start")).toMatchObject({ threadId: "thr-persisted" });
    // `codex exec resume` announced the thread too, under the same id.
    expect(events[0]).toEqual({ type: "thread.started", thread_id: "thr-persisted", model: "gpt-5" });
  });

  // EO-495. A resumed Claude session can close out the turn a kill
  // interrupted, and write that turn's result, before it reads EO's
  // message. Codex cannot hand a resumed turn another turn's ending: it
  // resumes without the thread's turns (`excludeTurns`), and the
  // translator passes on only what names the turn `turn/start` returned.
  it("ends a resumed turn on its own completion, not on one another turn of the thread reports first", async () => {
    const fake = fakeAppServer({
      after: {
        "turn/start": [
          note.agentMessage("", "msg-0", "turn-0"),
          note.turnCompleted("completed", null, "turn-0"),
          note.turnStarted(),
          note.agentMessage('{"verdict":"approve"}'),
          note.turnCompleted(),
        ],
      },
    });
    const events = await drain((await client(fake).resumeThread("thr-fake", { workingDirectory: repository() }).runStreamed("(EO restarted.)")).events);

    expect(fake.paramsOf("thread/resume")).toMatchObject({ excludeTurns: true });
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.completed")).toEqual([{ type: "item.completed", item: { id: "msg-1", type: "agent_message", text: '{"verdict":"approve"}' } }]);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("reports a resumed turn's own tokens, not the thread's running total", async () => {
    // A resume restates the thread's total before the turn begins; the
    // turn's share is what it adds to that.
    const fake = fakeAppServer({
      after: {
        "thread/resume": [note.tokenUsage({ input: 1_000, cached: 400, output: 50 }, "turn-0")],
        "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.tokenUsage({ input: 1_300, cached: 600, output: 70 }), note.turnCompleted()],
      },
    });
    const events = await drain((await client(fake).resumeThread("thr-fake", { workingDirectory: repository() }).runStreamed("again")).events);

    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      usage: { input_tokens: 300, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 },
      model: "gpt-6.1-sol",
    });
  });

  it("reports a fork's own tokens, not the original's total the copy carries (EO-733)", async () => {
    // `thread/fork` copies the original's running total into the copy and
    // restates nothing before the turn, so the fork's first reading holds
    // everything the original spent. What that reading's own response
    // used (`last`) is what says where the copy stood.
    const fake = fakeAppServer({
      forkId: "thr-fork",
      after: {
        "turn/start": [
          note.turnStarted("turn-1", "thr-fork"),
          note.tokenUsage({ input: 1_200, cached: 500, output: 60 }, "turn-1", "thr-fork", { input: 200, cached: 100, output: 10 }),
          note.agentMessage("ok", "msg-1", "turn-1", "thr-fork"),
          note.tokenUsage({ input: 1_500, cached: 700, output: 80 }, "turn-1", "thr-fork", { input: 300, cached: 200, output: 20 }),
          note.turnCompleted("completed", null, "turn-1", "thr-fork"),
        ],
      },
    });
    const events = await drain((await client(fake).forkThread("thr-original", { workingDirectory: repository() }).runStreamed("review")).events);

    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      usage: { input_tokens: 500, cached_input_tokens: 300, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 0 },
      model: "gpt-6.1-sol",
    });
  });

  it("opens a fork in prediction mode, from the original loaded first, so it keeps the original's prompt cache (EO-732)", async () => {
    const fake = fakeAppServer({
      forkId: "thr-fork",
      after: {
        // Loading the original restates its total, under its own id: no
        // starting point for the copy's turn.
        "thread/resume": [note.tokenUsage({ input: 9_000, cached: 8_000, output: 400 }, "turn-0", "thr-original")],
        "turn/start": [
          note.turnStarted("turn-1", "thr-fork"),
          note.tokenUsage({ input: 200, cached: 180, output: 10 }, "turn-1", "thr-fork"),
          note.agentMessage("ok", "msg-1", "turn-1", "thr-fork"),
          note.turnCompleted("completed", null, "turn-1", "thr-fork"),
        ],
      },
    });
    const cwd = repository();
    const events = await drain((await client(fake).forkThread("thr-original", { workingDirectory: cwd, model: "gpt-6.1-sol", approvalPolicy: "never" }).runStreamed("review")).events);

    const methods = fake.sent.flatMap((message) => (message.method === undefined || message.id === undefined ? [] : [message.method]));
    expect(methods).toEqual(["initialize", "thread/resume", "thread/fork", "turn/start"]);
    // The experimental API, opted into for a fork's turn alone.
    expect(fake.paramsOf("initialize")).toMatchObject({ capabilities: { experimentalApi: true } });
    // Loaded as a resumed turn on it would be, and no turn started on it.
    expect(fake.paramsOf("thread/resume")).toMatchObject({ threadId: "thr-original", cwd, model: "gpt-6.1-sol", approvalPolicy: "never", excludeTurns: true });
    // And copied with no override: everything comes from the original.
    expect(fake.paramsOf("thread/fork")).toEqual({ threadId: "thr-original", experimentalPredictionMode: true, ephemeral: true, excludeTurns: true });
    expect(fake.paramsOf("turn/start")).toMatchObject({ threadId: "thr-fork" });
    expect(events[0]).toEqual({ type: "thread.started", thread_id: "thr-fork", model: "gpt-6.1-sol", fork: { mode: "prediction" } });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 180, output_tokens: 10 } });
  });

  it("falls back to the plain fork, saying why, where the app-server refuses the prediction-mode one (EO-732)", async () => {
    const fake = fakeAppServer({
      forkId: "thr-fork",
      refusePredictionFork: "`experimentalPredictionMode` requires a loaded parent",
      after: { "turn/start": [note.turnStarted("turn-1", "thr-fork"), note.agentMessage("ok", "msg-1", "turn-1", "thr-fork"), note.turnCompleted("completed", null, "turn-1", "thr-fork")] },
    });
    const cwd = repository();
    const events = await drain((await client(fake).forkThread("thr-original", { workingDirectory: cwd, model: "gpt-6.1-sol" }).runStreamed("review")).events);

    const forks = fake.sent.filter((message) => message.method === "thread/fork").map((message) => message.params);
    expect(forks).toHaveLength(2);
    expect(forks[1]).toMatchObject({ threadId: "thr-original", cwd, model: "gpt-6.1-sol", excludeTurns: true });
    expect(forks[1]).not.toHaveProperty("experimentalPredictionMode");
    expect(events[0]).toEqual({ type: "thread.started", thread_id: "thr-fork", model: "gpt-6.1-sol", fork: { mode: "plain", fallbackReason: "thread/fork failed: `experimentalPredictionMode` requires a loaded parent (code -32600)" } });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("opts into no experimental API on a turn that is not a fork's (EO-732)", async () => {
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } });
    const events = await drain((await client(fake).resumeThread("thr-fake", { workingDirectory: repository() }).runStreamed("again")).events);

    expect(fake.paramsOf("initialize")).toMatchObject({ capabilities: null });
    expect(fake.paramsOf("thread/fork")).toBeUndefined();
    expect(events[0]).toEqual({ type: "thread.started", thread_id: "thr-fake", model: "gpt-6.1-sol" });
  });

  it("names the model the app-server opened the thread on, not the one EO asked for (EO-374)", async () => {
    // Asked for nothing, the CLI picks its own default; asked for one, it
    // may still answer with another. The answer is what a turn is priced at.
    const fake = fakeAppServer({ ...ORDINARY, replies: { "thread/start": { result: { thread: { id: "thr-fake" }, model: "gpt-6-sol", modelProvider: "openai" } } } });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository(), model: "gpt-6.1-sol" }).runStreamed("go")).events);

    expect(events.at(-1)).toMatchObject({ type: "turn.completed", model: "gpt-6-sol" });
  });

  it("names no model when the app-server did not, even though EO asked for one", async () => {
    // The request is not evidence of what ran: a turn priced at it would
    // put a guessed cost in front of the budgets. Left unnamed, the turn
    // is reported unpriced instead.
    const fake = fakeAppServer({ ...ORDINARY, replies: { "thread/start": { result: { thread: { id: "thr-fake" } } }, "thread/resume": { result: { thread: { id: "thr-fake" } } } } });
    const started = await drain((await client(fake).startThread({ workingDirectory: repository(), model: "gpt-6.1-sol" }).runStreamed("go")).events);
    const resumed = await drain((await client(fake).resumeThread("thr-fake", { workingDirectory: repository(), model: "gpt-6.1-sol" }).runStreamed("again")).events);

    for (const events of [started, resumed]) {
      expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
      expect(events.at(-1)).not.toHaveProperty("model");
    }
  });

  it("takes a reroute's model when the thread's answer named none", async () => {
    const fake = fakeAppServer({
      replies: { "thread/start": { result: { thread: { id: "thr-fake" } } } },
      after: { "turn/start": [note.turnStarted(), note.rerouted("gpt-6.1-sol", "gpt-6-luna"), note.agentMessage("ok"), note.tokenUsage({ input: 100, output: 10 }), note.turnCompleted()] },
    });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository(), model: "gpt-6.1-sol" }).runStreamed("go")).events);

    expect(events.at(-1)).toMatchObject({ type: "turn.completed", model: "gpt-6-luna" });
  });

  it("names the model a turn was rerouted to, for this turn only", async () => {
    const fake = fakeAppServer({
      after: {
        "turn/start": [
          note.turnStarted(),
          note.rerouted("gpt-6.1-sol", "gpt-6-luna", "turn-0"), // somebody else's turn
          note.rerouted("gpt-6.1-sol", "gpt-6-astra"),
          note.agentMessage("ok"),
          note.tokenUsage({ input: 100, output: 10 }),
          note.turnCompleted(),
        ],
      },
    });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(events.at(-1)).toMatchObject({ type: "turn.completed", model: "gpt-6-astra" });
  });

  it("names the model on a turn that ended badly and spent tokens, so that is priced too", async () => {
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.tokenUsage({ input: 100, output: 10 }), note.turnCompleted("interrupted")] } });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository(), model: "gpt-5.6-luna" }).runStreamed("go")).events);

    expect(events.at(-1)).toMatchObject({ type: "turn.failed", model: "gpt-5.6-luna", usage: { input_tokens: 100, output_tokens: 10 } });
  });

  it("throws the server's refusal of a resume in its own words", async () => {
    const fake = fakeAppServer({ replies: { "thread/resume": { error: { code: -32600, message: "no rollout found for thread id 0199-gone" } } } });
    const thrown = await captureThrow((await client(fake).resumeThread("0199-gone", { workingDirectory: repository() }).runStreamed("carry on")).events);

    expect(thrown).toBeInstanceOf(AppServerRequestError);
    expect((thrown as Error).message).toBe("thread/resume failed: no rollout found for thread id 0199-gone (code -32600)");
  });

  it("records a warning and a config warning as non-fatal items, and the turn goes on to finish", async () => {
    const fake = fakeAppServer({
      after: {
        initialize: [note.configWarning("Your configuration includes requirements managed by your organization.", "Some settings may be overridden.")],
        "turn/start": [note.turnStarted(), note.warning("Model metadata for `x` not found."), note.agentMessage("All done."), note.turnCompleted()],
      },
    });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(events.filter((event) => event.type === "item.completed").map((event) => (event as { item: unknown }).item)).toEqual([
      { id: "turn-1-warning-0", type: "error", message: "Your configuration includes requirements managed by your organization.\nSome settings may be overridden." },
      { id: "turn-1-warning-1", type: "error", message: "Model metadata for `x` not found." },
      { id: "msg-1", type: "agent_message", text: "All done." },
    ]);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("passes a fatal error on as the stream-level error, and the failed turn after it", async () => {
    const limit = "You've hit your usage limit for GPT-5. Switch to another model now, or try again at Sep 22, 2026 3:00 PM.";
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.error(limit), note.turnCompleted("failed", limit)] } });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(events.slice(2)).toEqual([
      // The app-server's own classification travels with the words
      // (EO-373), for `mapThreadEvent` to read a refusal from.
      { type: "error", message: limit, codex_error_info: "other" },
      { type: "turn.failed", error: { message: limit } },
    ]);
  });

  it("does not end the turn on an error the server says it is retrying", async () => {
    const fake = fakeAppServer({
      after: { "turn/start": [note.turnStarted(), note.error("Reconnecting... 1/5", true), note.agentMessage("done"), note.turnCompleted()] },
    });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    // Said as the retry it is (`RetryingEvent`), not as a warning or an error.
    expect(events).toContainEqual({ type: "retrying", message: "Reconnecting... 1/5" });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("reports the plan as one todo list, completed with the turn", async () => {
    const plan = (steps: [string, string][]) => ({ method: "turn/plan/updated", params: { threadId: "thr-fake", turnId: "turn-1", explanation: null, plan: steps.map(([step, status]) => ({ step, status })) } });
    const fake = fakeAppServer({
      after: { "turn/start": [note.turnStarted(), plan([["read", "inProgress"], ["edit", "pending"]]), plan([["read", "completed"], ["edit", "completed"]]), note.turnCompleted()] },
    });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(events.slice(-2)).toEqual([
      { type: "item.completed", item: { id: "turn-1-plan", type: "todo_list", items: [{ text: "read", completed: true }, { text: "edit", completed: true }] } },
      expect.objectContaining({ type: "turn.completed" }),
    ]);
  });

  it("reports a notification it does not know, and stays quiet about the ones it ignores on purpose", async () => {
    const onUnmappedNotification = vi.fn();
    const fake = fakeAppServer({
      after: {
        "turn/start": [
          note.turnStarted(),
          { method: "thread/status/changed", params: { threadId: "thr-fake", status: { type: "active", activeFlags: [] } } },
          { method: "account/rateLimits/updated", params: { rateLimits: {} } },
          { method: "mcpServer/startupStatus/updated", params: { threadId: "thr-fake", name: "repo", status: "ready", error: null } },
          { method: "item/agentMessage/delta", params: { delta: "d" } },
          { method: "item/started", params: { item: { type: "agentMessage", id: "m", text: "" } } },
          { method: "some/future/notification", params: { x: 1 } },
          note.item({ type: "collabAgentToolCall", id: "c1" }),
          note.item({ type: "userMessage", id: "u1", content: [] }),
          note.turnCompleted(),
        ],
      },
    });
    await drain((await client(fake, { onUnmappedNotification }).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(onUnmappedNotification.mock.calls.map(([notification]) => (notification as { method: string }).method)).toEqual(["some/future/notification", "item/completed"]);
  });

  it("refuses a request the server makes of EO, and the turn still completes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), { request: "item/tool/requestUserInput" }, note.agentMessage("ok"), note.turnCompleted()] } });
    const events = await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(fake.sent).toContainEqual({ id: "server-request-1", error: { code: -32601, message: "EO does not handle item/tool/requestUserInput" } });
    expect(events.at(-1)?.type).toBe("turn.completed");
    warn.mockRestore();
  });

  it("spawns with the environment it was given, which is how a declared secret reaches the CLI", async () => {
    const fake = fakeAppServer(ORDINARY);
    const env = { ...(process.env as Record<string, string>), EO_ADMIN_TOKEN: "t0ken" };
    await drain((await client(fake, { env }).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    // Everything given, and the tree's mark on top of it (EO-494).
    expect(fake.launches[0]?.options.env).toEqual({ ...env, EO_PROCESS_TREE: expect.any(String) });
  });

  it("asks for live web search, or none, the way the SDK did", () => {
    expect(configArguments(undefined, { webSearchEnabled: true })).toEqual(["-c", 'web_search="live"']);
    expect(configArguments(undefined, { webSearchEnabled: false })).toEqual(["-c", 'web_search="disabled"']);
    expect(configArguments(undefined, {})).toEqual([]);
  });
});

describe("the end of a Codex turn's process", () => {
  it("is the end of the turn: the app-server is gone once the turn completes", async () => {
    const fake = fakeAppServer(ORDINARY);
    await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);
    const pid = fake.launches[0]?.pid as number;
    pids.push(pid);

    expect(await goneWithin(pid, 2_000)).toBe(true);
  });

  it("is killed when it does not exit on its own after a finished turn", async () => {
    const fake = fakeAppServer({ ...ORDINARY, ignoreEof: true });
    await drain((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);
    const pid = fake.launches[0]?.pid as number;
    pids.push(pid);

    expect(await goneWithin(pid, 2_000)).toBe(true);
  });

  it("lets a cancel win over a turn whose completion is already queued", async () => {
    // The race: the consumer cancels while holding an event, and by then
    // the server has sent the rest of the turn, `turn/completed` included.
    // A cancelled run must not come back as a finished one.
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage("done"), note.tokenUsage({ input: 10, output: 2 }), note.turnCompleted()] } });
    const controller = new AbortController();
    const { events } = await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go", { signal: controller.signal });

    const seen: ThreadEvent[] = [];
    let error: unknown = null;
    try {
      for await (const event of events) {
        seen.push(event);
        if (event.type === "turn.started") {
          // Long enough for everything after it to be read off the pipe
          // and queued, which is the state the cancel has to beat.
          await new Promise((resolve) => setTimeout(resolve, 300));
          controller.abort();
        }
      }
    } catch (thrown) {
      error = thrown;
    }
    const pid = fake.launches[0]?.pid as number;
    pids.push(pid);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(seen.map((event) => event.type)).toEqual(["thread.started", "turn.started"]);
    expect(await goneWithin(pid, 2_000), "the app-server outlived its cancelled run").toBe(true);
  });

  it("is ended by a cancel mid-turn, which throws the AbortError the supervisor recognises", async () => {
    // A turn that starts and never finishes, from a server that would
    // ignore EOF: only EO's kill can end it.
    const fake = fakeAppServer({ ignoreEof: true, after: { "turn/start": [note.turnStarted()] } });
    const controller = new AbortController();
    const { events } = await client(fake).startThread({ workingDirectory: repository() }).runStreamed("count slowly", { signal: controller.signal });

    const seen: ThreadEvent[] = [];
    const thrown = (async () => {
      try {
        for await (const event of events) {
          seen.push(event);
          if (event.type === "turn.started") controller.abort();
        }
      } catch (error) {
        return error;
      }
      return null;
    })();
    const error = await thrown;
    const pid = fake.launches[0]?.pid as number;
    pids.push(pid);

    expect(seen.map((event) => event.type)).toEqual(["thread.started", "turn.started"]);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(await goneWithin(pid, 2_000), "the app-server outlived its cancelled run").toBe(true);
  });

  it("is ended when the consumer stops reading, as a supervisor that gives up on a turn does", async () => {
    const fake = fakeAppServer({ ignoreEof: true, after: { "turn/start": [note.turnStarted()] } });
    const { events } = await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go");
    for await (const event of events) if (event.type === "turn.started") break;
    const pid = fake.launches[0]?.pid as number;
    pids.push(pid);

    expect(await goneWithin(pid, 2_000)).toBe(true);
  });

  it("starts nothing for a turn already cancelled", async () => {
    const fake = fakeAppServer(ORDINARY);
    const controller = new AbortController();
    controller.abort();
    const thrown = await captureThrow((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go", { signal: controller.signal })).events);

    expect(thrown).toMatchObject({ name: "AbortError" });
    expect(fake.launches).toHaveLength(0);
  });

  it("fails the turn with what the server wrote when it dies mid-turn", async () => {
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), { exit: 3, stderr: "thread panicked: boom" }] } });
    const thrown = await captureThrow((await client(fake).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(thrown).toBeInstanceOf(AppServerExitedError);
    expect((thrown as Error).message).toBe("Codex app-server exited with code 3: thread panicked: boom");
  });
});

describe("what a Codex turn refuses before spawning anything", () => {
  it("runs outside a Git repository: whether a turn needs one is the workspace's question, asked above this client (EO-386)", async () => {
    const fake = fakeAppServer(ORDINARY);
    const outside = mkdtempSync(join(tmpdir(), "eo-codex-not-a-repo-"));
    directories.push(outside);

    const events = await drain((await client(fake).startThread({ workingDirectory: outside }).runStreamed("go")).events);

    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(fake.launches).toHaveLength(1);
  });

  it("refuses to run without an executable rather than reaching for one of its own", async () => {
    const fake = fakeAppServer(ORDINARY);
    const thrown = await captureThrow((await new CodexClient({ spawn: fake.spawn }).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect((thrown as Error).message).toBe(CODEX_NOT_INSTALLED);
    expect(fake.launches).toHaveLength(0);
  });
});

describe("what is let go of once a turn's process is over (EO-444)", () => {
  it("calls afterTurn once the turn has finished and its process has been shut down", async () => {
    const fake = fakeAppServer(ORDINARY);
    const afterTurn = vi.fn();
    const turn = await client(fake, { afterTurn }).startThread({ workingDirectory: repository() }).runStreamed("go");

    const seen: boolean[] = [];
    for await (const event of turn.events) {
      void event;
      seen.push(afterTurn.mock.calls.length > 0);
    }

    // Not while the app-server was still answering, and once after.
    expect(seen.every((released) => !released)).toBe(true);
    expect(afterTurn).toHaveBeenCalledTimes(1);
  });

  it("calls it for a turn that never spawned anything", async () => {
    const afterTurn = vi.fn();

    await captureThrow((await new CodexClient({ afterTurn }).startThread({ workingDirectory: repository() }).runStreamed("go")).events);

    expect(afterTurn).toHaveBeenCalledTimes(1);
  });

  it("calls it, once, for a turn cancelled before anybody read it — and not again if it is read after", async () => {
    const fake = fakeAppServer(ORDINARY);
    const afterTurn = vi.fn();
    const controller = new AbortController();
    const turn = await client(fake, { afterTurn }).startThread({ workingDirectory: repository() }).runStreamed("go", { signal: controller.signal });

    controller.abort();
    expect(afterTurn).toHaveBeenCalledTimes(1);
    await captureThrow(turn.events);
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(fake.launches).toHaveLength(0);
  });

  it("calls it, once, for a turn let go of unread", async () => {
    const afterTurn = vi.fn();
    const turn = await client(fakeAppServer(ORDINARY), { afterTurn }).startThread({ workingDirectory: repository() }).runStreamed("go");

    await turn.events.return(undefined);
    await turn.events.return(undefined);
    expect(afterTurn).toHaveBeenCalledTimes(1);
  });
});

describe("translateItem", () => {
  it("maps a command, keeping `exec`'s three statuses and leaving out an exit code there is none of", () => {
    const base = { id: "c1", command: "/bin/bash -lc 'pnpm test'", cwd: "/w", processId: null, source: "agent", commandActions: [], durationMs: 1 };
    expect(translateItem({ ...base, type: "commandExecution", status: "completed", aggregatedOutput: "ok\n", exitCode: 0 })).toEqual({
      id: "c1",
      type: "command_execution",
      command: "/bin/bash -lc 'pnpm test'",
      aggregated_output: "ok\n",
      exit_code: 0,
      status: "completed",
    });
    // A declined command did not run, which is what `failed` meant to `exec`.
    expect(translateItem({ ...base, type: "commandExecution", status: "declined", aggregatedOutput: null, exitCode: null })).toEqual({
      id: "c1",
      type: "command_execution",
      command: "/bin/bash -lc 'pnpm test'",
      aggregated_output: "",
      status: "failed",
    });
  });

  it("maps a file change to its paths and kinds", () => {
    expect(
      translateItem({
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [
          { path: "a.ts", kind: { type: "add" }, diff: "" },
          { path: "b.ts", kind: { type: "update", move_path: null }, diff: "" },
          { path: "c.ts", kind: { type: "delete" }, diff: "" },
        ],
      }),
    ).toEqual({ id: "f1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "update" }, { path: "c.ts", kind: "delete" }] });
  });

  it("maps an MCP call's answer, in `exec`'s snake case", () => {
    expect(
      translateItem({
        type: "mcpToolCall",
        id: "m1",
        server: "eo",
        tool: "ticket_detail",
        status: "completed",
        arguments: { key: "EO-1" },
        result: { content: [{ type: "text", text: "EO-1" }], structuredContent: null, _meta: null },
        error: null,
        durationMs: 3,
      }),
    ).toEqual({
      id: "m1",
      type: "mcp_tool_call",
      server: "eo",
      tool: "ticket_detail",
      status: "completed",
      arguments: { key: "EO-1" },
      result: { content: [{ type: "text", text: "EO-1" }], structured_content: null },
    });
    expect(translateItem({ type: "mcpToolCall", id: "m2", server: "repo", tool: "q", status: "failed", arguments: {}, result: null, error: { message: "boom" } })).toEqual({
      id: "m2",
      type: "mcp_tool_call",
      server: "repo",
      tool: "q",
      status: "failed",
      arguments: {},
      error: { message: "boom" },
    });
  });

  it("maps reasoning to its summary, and says nothing for reasoning with nothing in it", () => {
    expect(translateItem({ type: "reasoning", id: "r1", summary: ["Reading the file", "then editing it"], content: [] })).toEqual({ id: "r1", type: "reasoning", text: "Reading the file\nthen editing it" });
    expect(translateItem({ type: "reasoning", id: "r2", summary: [], content: [] })).toBe("ignored");
  });

  it("maps a web search and an agent message", () => {
    expect(translateItem({ type: "webSearch", id: "w1", query: "codex app-server", action: null, results: null })).toEqual({ id: "w1", type: "web_search", query: "codex app-server" });
    expect(translateItem({ type: "agentMessage", id: "a1", text: "hi", phase: null })).toEqual({ id: "a1", type: "agent_message", text: "hi" });
  });

  it("ignores what `exec` never surfaced, and does not know what it has never seen", () => {
    for (const type of ["userMessage", "contextCompaction", "hookPrompt"]) expect(translateItem({ type, id: "x" })).toBe("ignored");
    expect(translateItem({ type: "dynamicToolCall", id: "x" })).toBeNull();
    expect(translateItem(null)).toBeNull();
  });
});

describe("serializeConfigOverrides", () => {
  it("flattens the way `@openai/codex-sdk` flattened `config` for `exec`", () => {
    expect(
      serializeConfigOverrides({
        mcp_servers: {
          eo: { command: "/e", args: ["a", "b"], env: { A: "1" } },
          "my server": { url: "https://x", http_headers: { Authorization: "Bearer ${T}", "X-Weird Key": "v" }, bearer_token_env_var: "T" },
          empty: {},
        },
        n: 3,
        flag: false,
        skip: undefined,
      }),
    ).toEqual([
      'mcp_servers.eo.command="/e"',
      'mcp_servers.eo.args=["a", "b"]',
      'mcp_servers.eo.env.A="1"',
      'mcp_servers.my server.url="https://x"',
      'mcp_servers.my server.http_headers.Authorization="Bearer ${T}"',
      'mcp_servers.my server.http_headers.X-Weird Key="v"',
      'mcp_servers.my server.bearer_token_env_var="T"',
      "mcp_servers.empty={}",
      "n=3",
      "flag=false",
    ]);
  });

  it("writes an object whose key holds a dot as one inline table, because Codex splits a key path on every dot (EO-377)", () => {
    // `X.Foo` is a valid HTTP header name. As a path segment it became
    // `env_http_headers.X.Foo`, which the pinned binary reads as a map
    // under `X` and refuses ("invalid type: map, expected a string").
    expect(
      serializeConfigOverrides({
        mcp_servers: { linear: { url: "https://x", env_http_headers: { "X.Foo": "EO_MCP_HEADER_1", Authorization: "EO_MCP_HEADER_2" }, http_headers: { "X.Plain": "v" } } },
      }),
    ).toEqual([
      'mcp_servers.linear.url="https://x"',
      'mcp_servers.linear.env_http_headers={"X.Foo" = "EO_MCP_HEADER_1", Authorization = "EO_MCP_HEADER_2"}',
      'mcp_servers.linear.http_headers={"X.Plain" = "v"}',
    ]);
  });

  it("refuses a dotted key at the top level, where there is no path to inline it at", () => {
    expect(() => serializeConfigOverrides({ "a.b": 1 })).toThrow(/top level/);
  });
});

describe("AppServerConnection", () => {
  it("answers a request, and rejects one the server refuses with its code and words", async () => {
    const fake = fakeAppServer({ replies: { "model/list": { result: { data: [{ id: "gpt-5" }], nextCursor: null } }, "bad/method": { error: { code: -32601, message: "unknown" } } } });
    const connection = new AppServerConnection({ executablePath: EXECUTABLE, spawn: fake.spawn });
    try {
      await connection.initialize();
      await expect(connection.request("model/list", { cursor: null })).resolves.toEqual({ data: [{ id: "gpt-5" }], nextCursor: null });
      const refused = connection.request("bad/method");
      await expect(refused).rejects.toBeInstanceOf(AppServerRequestError);
      await expect(refused).rejects.toMatchObject({ code: -32601, message: "bad/method failed: unknown (code -32601)" });
    } finally {
      connection.close();
    }
  });

  it("rejects what is still waiting when the process cannot be started", async () => {
    const connection = new AppServerConnection({ executablePath: join(tmpdir(), "eo-no-such-codex-binary") });
    await expect(connection.initialize()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(connection.exited()).resolves.toMatchObject({ code: null });
  });
});

describe("a Codex compaction", () => {
  const item = (id: string) => ({ method: "item/completed", params: { threadId: "thr-1", turnId: "turn-1", item: { type: "contextCompaction", id } } });
  const notice = { method: "thread/compacted", params: { threadId: "thr-1", turnId: "turn-1" } };

  it("is passed on once for each compaction, however close two of them are", () => {
    const translator = new TurnTranslator("thr-1", "turn-1");
    const events = [item("c-1"), item("c-2"), item("c-2")].flatMap((one) => translator.translate(one as never).events);
    expect(events).toEqual([{ type: "compacted" }, { type: "compacted" }]);
  });

  it("is passed on once when the app-server announces the same one both ways", () => {
    const translator = new TurnTranslator("thr-1", "turn-1");
    const events = [notice, item("c-1")].flatMap((one) => translator.translate(one as never).events);
    expect(events).toEqual([{ type: "compacted" }]);
  });
});

describe("the words of a Codex turn as they are generated", () => {
  it("passes on this turn's message and reasoning-summary deltas, and not another turn's", () => {
    const translator = new TurnTranslator("thr-1", "turn-1");
    const said = (method: string, turnId: string, delta: string) => translator.translate({ method, params: { threadId: "thr-1", turnId, itemId: "i", delta } } as never).events;
    expect(said("item/agentMessage/delta", "turn-1", "Hel")).toEqual([{ type: "item.delta", stream: "text", text: "Hel" }]);
    expect(said("item/reasoning/summaryTextDelta", "turn-1", "Hmm")).toEqual([{ type: "item.delta", stream: "reasoning", text: "Hmm" }]);
    expect(said("item/agentMessage/delta", "turn-0", "old")).toEqual([]);
    expect(said("item/agentMessage/delta", "turn-1", "")).toEqual([]);
    // Raw reasoning is still not shown — the summary is — but it is the
    // backend at work, which the inactivity guard is told (`HeartbeatEvent`).
    expect(translator.translate({ method: "item/reasoning/textDelta", params: { threadId: "thr-1", turnId: "turn-1", delta: "raw" } } as never)).toEqual({ events: [{ type: "heartbeat" }], recognised: true });
  });
});

describe("what a Codex turn is told and does nothing with", () => {
  it("recognises 0.167.0's `thread/section/changed` without passing anything on (EO-774)", () => {
    const translator = new TurnTranslator("thr-1", "turn-1");
    expect(translator.translate({ method: "thread/section/changed", params: { threadId: "thr-1", sectionId: null } } as never)).toEqual({ events: [], recognised: true });
  });
});

describe("a Codex process started ahead of its turn", () => {
  afterEach(() => dropWarmCodexThread());

  const gone = (pid: number | undefined) => {
    if (pid === undefined) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  // 30s on Windows rather than 5s: ending a warm process there reads the
  // process table through a PowerShell start (`processTree.ts`), seconds on
  // a busy runner, and waiting for it to be gone ran out at 5s while the
  // project's own per-test limit (60s there, vitest.config.ts) had room.
  // A wait that is satisfied returns at once, so only a failure is slower.
  async function until(ready: () => boolean, ms = process.platform === "win32" ? 30_000 : 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const client = (fake: FakeAppServer) => new CodexClient({ executablePath: "/opt/eo/codex", spawn: fake.spawn, shutdownGraceMs: 200 });
  async function drain(turn: { events: AsyncGenerator<ThreadEvent> }): Promise<ThreadEvent[]> {
    const events: ThreadEvent[] = [];
    for await (const event of turn.events) events.push(event);
    return events;
  }

  it("stops a warm-up whose thread could not be opened, rather than leaving it running", async () => {
    const fake = fakeAppServer({ replies: { "thread/start": { error: { code: -32603, message: "no" } } } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    client(fake).prewarm(null, {});
    await until(() => fake.sent.some((message) => message.method === "thread/start"));
    await until(() => gone(fake.launches[0]?.pid));
    expect(gone(fake.launches[0]?.pid)).toBe(true);
    warn.mockRestore();
  });

  it("opens the ordinary way when the warm process died while it waited", async () => {
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } });
    client(fake).prewarm(null, {});
    await until(() => fake.sent.some((message) => message.method === "thread/start"));
    process.kill(fake.launches[0]!.pid!, "SIGKILL");
    await until(() => gone(fake.launches[0]?.pid));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const events = await drain(await client(fake).startThread({}).runStreamed("hello"));
    expect(fake.launches).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("starts no turn when the run is cancelled while the warm process is still opening, and stops that process", async () => {
    const fake = fakeAppServer();
    client(fake).prewarm(null, {});
    const run = new AbortController();
    const turn = await client(fake).startThread({}).runStreamed("hello", { signal: run.signal });
    const first = turn.events.next();
    run.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.sent.some((message) => message.method === "turn/start")).toBe(false);
    await until(() => gone(fake.launches[0]?.pid));
    expect(fake.launches).toHaveLength(1);
  });

  it("leaves the warm process for the next turn when a run arrives already cancelled", async () => {
    const fake = fakeAppServer({ after: { "turn/start": [note.turnStarted(), note.agentMessage("ok"), note.turnCompleted()] } });
    client(fake).prewarm(null, {});
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(drain(await client(fake).startThread({}).runStreamed("hello", { signal: cancelled.signal }))).rejects.toMatchObject({ name: "AbortError" });
    await drain(await client(fake).startThread({}).runStreamed("hello"));
    expect(fake.launches).toHaveLength(1);
  });
});
