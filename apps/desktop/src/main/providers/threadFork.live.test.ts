import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, AgentForkResult, AgentProvider } from "@eo/core";
import { createClaudeProvider } from "./claude.js";
import { codexClientOptions, createCodexProvider } from "./codex.js";
import { CodexClient } from "./codexClient.js";
import { personCodexHome } from "./codexHome.js";
import { runtimeRoot } from "../runtimes/install.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";

/**
 * A fork of a real thread, on each real backend (EO-716): the fork's turn
 * is sent with the original's history, and the original, resumed after,
 * is sent without the fork's turn.
 *
 * Read off what each CLI sends its model, by pointing it at a server on
 * 127.0.0.1 that keeps every request body and answers with a canned
 * reply — the technique of `steering.live.test.ts` (Claude) and
 * `codexSideCall.live.test.ts` (Codex). **No credit is spent and no key
 * is needed.** What reaches the model is the history, so the request
 * bodies are the exact answer to "can the fork see it" and "does the
 * original see the fork", with no model's judgement in between.
 *
 * Opted in, because it needs the managed runtimes on disk:
 *
 *     EO_LIVE_CLAUDE_WIRE=1 EO_LIVE_CODEX=1 \
 *       EO_CODEX_BIN=<userData>/runtimes/codex@<pin>-<platform>/…/codex \
 *       pnpm exec vitest run --root apps/desktop src/main/providers/threadFork.live.test.ts
 */
const CLAUDE_OPTED_IN = process.env["EO_LIVE_CLAUDE_WIRE"] === "1";
const CODEX_OPTED_IN = process.env["EO_LIVE_CODEX"] === "1";
const CODEX = process.env["EO_CODEX_BIN"] ?? "codex";

/** Said only in the turn that opens the thread. */
const ORIGINAL = "Remember the word kumquat-original-716.";
/** Said only on the fork. */
const ON_THE_FORK = "Now also remember persimmon-fork-716.";
/** Said only when the original is resumed after the fork. */
const RESUMED = "Which words were you asked to remember? tamarind-resumed-716";

const cleanup: string[] = [];
let server: Server | null = null;
const restore: { key: string; value: string | undefined }[] = [];

afterEach(() => {
  server?.close();
  server = null;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const { key, value } of restore.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setEnv(key: string, value: string): void {
  restore.push({ key, value: process.env[key] });
  process.env[key] = value;
}

function repository(): string {
  const scratch = mkdtempSync(join(tmpdir(), "eo-thread-fork-"));
  cleanup.push(scratch);
  const cwd = join(scratch, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO Fork");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), "# probe\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  return cwd;
}

/** A model that keeps every request body and answers each with `reply`. */
async function captureServer(path: string, reply: (response: ServerResponse) => void): Promise<{ port: number; bodies: string[] }> {
  const bodies: string[] = [];
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url?.includes(path) === true) bodies.push(Buffer.concat(chunks).toString("utf8"));
      try {
        reply(response);
      } catch {
        // A CLI abandoning a request it no longer wants is not this server's failure.
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, bodies };
}

function sse(response: ServerResponse, events: [string, unknown][]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.end();
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * The scenario both backends are held to: open a thread, fork it, then
 * resume the original — and read what each turn sent its model.
 */
async function forkScenario(provider: AgentProvider, cwd: string, bodies: string[]) {
  const opened = await drain(provider.start({ instructions: "You are a probe.", context: ORIGINAL, cwd, signal: new AbortController().signal }));
  const original = opened.find((event) => event.type === "thread_started");
  expect(original?.type, "the opening turn names its thread").toBe("thread_started");
  const originalId = original!.type === "thread_started" ? original!.threadId : "";

  const forked = await provider.fork!(originalId, ON_THE_FORK, { cwd });
  expect(forked.ok, forked.ok ? "" : forked.message).toBe(true);
  const fork = forked as Extract<AgentForkResult, { ok: true }>;
  const forkEvents = await drain(fork.events);

  const resumed = await drain(provider.resume(originalId, RESUMED, { cwd }));

  const sentWith = (words: string) => bodies.filter((body) => body.includes(words));
  const missing = await provider.fork!("019a0000-0000-7000-8000-000000000716", ON_THE_FORK, { cwd });
  return { originalId, fork, forkEvents, resumed, forkBodies: sentWith("persimmon-fork-716"), resumedBodies: sentWith("tamarind-resumed-716"), missing };
}

function expectAFork(observed: Awaited<ReturnType<typeof forkScenario>>): void {
  // A copy, with an id of its own, said at the head of its turn.
  expect(observed.fork.threadId).not.toBe(observed.originalId);
  expect(observed.forkEvents.find((event) => event.type === "thread_started")).toMatchObject({ threadId: observed.fork.threadId });
  expect(observed.forkEvents.some((event) => event.type === "result")).toBe(true);

  // The fork's turn was sent the original's history.
  expect(observed.forkBodies.length).toBeGreaterThan(0);
  for (const body of observed.forkBodies) expect(body).toContain("kumquat-original-716");

  // The original, resumed after, was sent its own history and nothing of the fork's.
  expect(observed.resumed.some((event) => event.type === "result")).toBe(true);
  expect(observed.resumedBodies.length).toBeGreaterThan(0);
  for (const body of observed.resumedBodies) {
    expect(body).toContain("kumquat-original-716");
    expect(body).not.toContain("persimmon-fork-716");
  }

  // And a thread the backend never had is a typed failure naming it.
  expect(observed.missing).toMatchObject({ ok: false, reason: "thread_not_found", threadId: "019a0000-0000-7000-8000-000000000716" });
}

describe.skipIf(!CLAUDE_OPTED_IN)("forking a Claude session, against the real CLI (live, no credit)", () => {
  it("sends the fork the session's history, and leaves the session without the fork's turn", { timeout: 240_000 }, async () => {
    const root = runtimeRoot(join(homedir(), ".config", "EO"));
    const executable = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
    const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
    expect(executable, "the managed claude runtime must be installed").not.toBeNull();
    expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();

    const capture = await captureServer("/v1/messages", (response) => {
      const message = { id: "msg_capture", type: "message", role: "assistant", model: "capture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 3 } };
      sse(response, [
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "noted" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    });
    setEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${capture.port}`);
    setEnv("ANTHROPIC_API_KEY", "sk-ant-capture-not-a-real-key");
    setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

    const provider = createClaudeProvider({ sdkEntryPath, executablePath: executable });
    expectAFork(await forkScenario(provider, repository(), capture.bodies));
  });
});

describe.skipIf(!CODEX_OPTED_IN)("forking a Codex thread, against the real app-server (live, no credit)", () => {
  it("sends the fork the thread's history, and leaves the thread without the fork's turn", { timeout: 240_000 }, async () => {
    const capture = await captureServer("/responses", (response) => {
      const usage = { input_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 14 };
      sse(response, [
        ["response.created", { type: "response.created", response: { id: "resp_capture" } }],
        ["response.output_item.done", { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "msg_capture", content: [{ type: "output_text", text: "noted" }] } }],
        ["response.completed", { type: "response.completed", response: { id: "resp_capture", usage } }],
      ]);
    });
    // A home of its own, so the threads this writes are not left among the person's.
    const home = mkdtempSync(join(homedir(), ".eo-thread-fork-home-"));
    cleanup.push(home);
    mkdirSync(join(home, "sessions"), { recursive: true });
    const cache = join(personCodexHome(), "models_cache.json");
    if (existsSync(cache)) copyFileSync(cache, join(home, "models_cache.json"));

    const options = { executablePath: CODEX, codexHome: () => home };
    const provider = createCodexProvider({
      ...options,
      createCodex: (repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory) => {
        const built = codexClientOptions(options, repository, searchHook, attachFrom, memoryScopes, environmentVariables, writeBridge, withheld, adminDirectory);
        return new CodexClient({
          ...built,
          config: {
            ...built.config,
            model_provider: "capture",
            model_providers: { capture: { name: "capture", base_url: `http://127.0.0.1:${capture.port}/v1`, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 } },
          },
        });
      },
    });
    const rolloutOf = (threadId: string): string | undefined => filesUnder(join(home, "sessions")).find((file) => file.includes(threadId));
    const cwd = repository();
    // The original as its turn left it, before anything forks it.
    let originalRollout: string | null = null;
    /** The original's rollout once the fork's turn has ended, before anything resumes it. */
    let afterTheFork: string | null = null;
    const probing: AgentProvider = {
      ...provider,
      fork: async (threadId, message, opts) => {
        const path = rolloutOf(threadId);
        // The first fork's: the scenario forks a thread nobody has after.
        const first = originalRollout === null && path !== undefined;
        if (first) originalRollout = readFileSync(path, "utf8");
        const forked = await provider.fork!(threadId, message, opts);
        if (!first || !forked.ok) return forked;
        const events = forked.events;
        async function* read(): AsyncGenerator<AgentEvent> {
          yield* events;
          afterTheFork = readFileSync(path!, "utf8");
        }
        return { ...forked, events: read() };
      },
    };
    const observed = await forkScenario(probing, cwd, capture.bodies);
    expectAFork(observed);

    // In prediction mode (EO-732): the copy's request is keyed to the
    // original's prompt cache — the original's own thread id, measured at
    // 0.166.0 — and starts with everything the original's request sent, so
    // the backend reads the original's thread from its cache, where a
    // plain fork's key is its own and reads none of it.
    expect(observed.forkEvents.find((event) => event.type === "thread_started")).toMatchObject({ fork: { mode: "prediction" } });
    const request = (words: string) => JSON.parse(capture.bodies.find((body) => body.includes(words))!) as Record<string, unknown>;
    const original = request("kumquat-original-716");
    const fork = request("persimmon-fork-716");
    expect(original["prompt_cache_key"]).toBe(observed.originalId);
    expect(fork["prompt_cache_key"]).toBe(original["prompt_cache_key"]);
    const withoutIds = (items: unknown) => JSON.parse(JSON.stringify(items).replace(/"id":"[^"]*",?/g, "")) as unknown[];
    const originalInput = withoutIds(original["input"]);
    expect(withoutIds(fork["input"]).slice(0, originalInput.length)).toEqual(originalInput);
    expect(fork["model"]).toBe(original["model"]);
    expect(fork["reasoning"]).toEqual(original["reasoning"]);
    // Loading the original to fork it wrote nothing to it: its rollout is
    // byte for byte what its own turn left.
    expect(originalRollout).not.toBeNull();
    expect(afterTheFork).toBe(originalRollout);
    // And the copy is ephemeral: nothing of it is kept on disk.
    expect(rolloutOf(observed.fork.threadId)).toBeUndefined();
    // The copy carries the original's token totals and no reading
    // restates them, measured at 0.166.0: the fork's turn — one request,
    // 11 in and 3 out — is still reported as its own (EO-733).
    expect(observed.forkEvents.filter((event) => event.type === "usage")).toEqual([expect.objectContaining({ scope: "turn", tokensIn: 11, tokensOut: 3 })]);
  });
});
