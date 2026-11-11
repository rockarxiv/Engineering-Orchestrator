import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { MEMORY_NOTE_TOOL_NAME, MEMORY_READ_TOOL_NAME, SKILL_WRITE_TOOLS, type AgentEvent, type AgentProvider, type AgentProviderResumeOptions, type JsonSchema, type Skill } from "@eo/core";
import { afterAll, describe, expect, it } from "vitest";
import { writeToolDirectory } from "../agentAttachments/pluginDirectory.js";
import { learningReviewPrompt } from "../memory/learningReview.js";
import { startAgentWriteBridge, type AgentWriteBridge } from "../mcp/writeBridge.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { runtimeRoot } from "../runtimes/install.js";
import { CLAUDE_SDK, resolvePackageSet } from "../runtimes/packages.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { createClaudeProvider } from "./claude.js";
import { codexClientOptions, createCodexProvider, type CodexProviderOptions } from "./codex.js";
import type { AppServerSpawn } from "./codexAppServer.js";
import { CodexClient } from "./codexClient.js";

/**
 * Whether the learning review's fork reads the run's thread from the
 * backend's prompt cache (EO-732), measured on a real turn on each
 * backend rather than argued.
 *
 * A prompt cache matches an exact prefix — tools, then system, then
 * messages — so a fork sent one tool fewer than its run pays to write the
 * whole thread again. This runs one short turn the way EO runs a run's —
 * EO's `eo` server, a repository server, an attached server and a skill,
 * an answer schema, a write credential — then forks it the way
 * `reviewOnFork` does: the run's options, the review's credential and
 * `refuseCallsExcept`. What each request read from the cache is read off
 * the backend's own record: the Claude session transcript's
 * `cache_read_input_tokens`, and on Codex the app-server's
 * `thread/tokenUsage/updated`, whose `last.cachedInputTokens` is one model
 * response's — the review's fork is ephemeral in prediction mode, so it
 * leaves no rollout. The fork's first request must read at least 90% of
 * what the run's last request read. On Codex the fork must also have been
 * opened in prediction mode, and a second fork told to write a file and
 * call the attached server must do neither.
 *
 * **Opt-in, because it spends real credit** — two short turns on each
 * backend — and needs the managed runtimes and a signed-in account:
 *
 *     EO_LIVE_REVIEW_FORK_CACHE=1 pnpm exec vitest run \
 *       src/main/providers/reviewForkCache.live.test.ts
 *
 * `EO_LIVE_CLAUDE_MODEL` / `EO_LIVE_CODEX_MODEL` pick the model (default:
 * the account's); `EO_LIVE_REPORT_DIR` is where each backend's figures
 * are written as JSON.
 */

const OPTED_IN = process.env["EO_LIVE_REVIEW_FORK_CACHE"] === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
const EO_SERVER = join(HERE, "..", "mcp", "eoServer.mjs");
const HOOK_COMMAND = join(HERE, "codexSearchHookCommand.mjs");
const REVIEW_CALLS = [MEMORY_READ_TOOL_NAME, MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS];

/** A stdio MCP server with three harmless tools: the repository server and the attached one. */
const STUB_SERVER = `import { createInterface } from "node:readline";
const name = process.argv[2] ?? "stub";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tool = (index) => ({ name: name + "_tool_" + index, description: "Tool " + index + " of the " + name + " server.", inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false } });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } } });
  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [tool(0), tool(1), tool(2)] } });
  else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
  else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
`;

const ANSWER: JsonSchema = {
  type: "object",
  properties: { summary: { type: "string", description: "One sentence about what the files say." } },
  required: ["summary"],
  additionalProperties: false,
};

/** The skill the agent has attached: in the tool directory on Claude, written into the worktree on Codex. */
const SKILL: Skill = {
  id: "0199cf00-0000-7000-8000-0000000007e2",
  slug: "settlement-checks",
  name: "Settlement checks",
  description: "How to check a settlement run against the ledger.",
  body: "# Settlement checks\n\nCompare the run's totals with the ledger's.\n",
  files: [],
  disableModelInvocation: false,
  enabled: true,
  scope: { kind: "global" },
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
  createdBy: "person",
  locked: false,
};

const scratches: string[] = [];
const bridges: AgentWriteBridge[] = [];

afterAll(async () => {
  for (const bridge of bridges) await bridge.close();
  for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
});

interface Setup {
  cwd: string;
  run: AgentProviderResumeOptions;
  review: AgentProviderResumeOptions;
  notes: string[];
}

/** A checkout with files worth reading, and the options a run's turn and its review's fork are opened with. */
async function setUp(backend: string): Promise<Setup> {
  const scratch = mkdtempSync(join(tmpdir(), `eo-review-fork-cache-${backend}-`));
  scratches.push(scratch);
  const cwd = join(scratch, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "eo@example.com");
  git("config", "user.name", "EO Review Fork");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "README.md"), `# Settlements\n\n${"Settlements are computed nightly in UTC and posted to the ledger before 06:00. ".repeat(40)}\n`);
  writeFileSync(join(cwd, "notes.txt"), `${"The fixtures database must be seeded before the integration tests run. ".repeat(40)}\n`);
  git("add", "-A");
  git("commit", "-m", "initial");

  const serverPath = join(scratch, "stub-server.mjs");
  writeFileSync(serverPath, STUB_SERVER);
  const toolDirectory = join(scratch, "tools");
  writeToolDirectory(toolDirectory, {
    servers: [
      {
        id: "srv-probe",
        name: "probe",
        description: "",
        config: { transport: "stdio", command: process.execPath, args: [serverPath, "probe"] },
        envNames: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
        connector: null,
      },
    ],
    skills: [SKILL],
  });

  const notes: string[] = [];
  const bridge = await startAgentWriteBridge(async (_itemId, request) => {
    notes.push(JSON.stringify(request));
    return { ok: true, text: `noted (${request.tool})`, data: { entryId: "m-1" } };
  });
  bridges.push(bridge);
  const run: AgentProviderResumeOptions = {
    cwd,
    outputSchema: ANSWER,
    toolDirectory,
    repositoryMcp: { name: "repo", command: process.execPath, args: [serverPath, "repo"], env: {} },
    attachFrom: { runId: "018f0000-0000-7000-8000-000000000732", directory: cwd },
    memoryScopes: [{ kind: "project", id: "project-settlements", name: "Settlements" }],
    skillScope: { projectId: "project-settlements", workspaceId: null },
    writeBridge: bridge.tokenFor("item-732"),
  };
  return { cwd, run, review: { ...run, writeBridge: bridge.tokenFor("item-732", [MEMORY_NOTE_TOOL_NAME, ...SKILL_WRITE_TOOLS]), refuseCallsExcept: REVIEW_CALLS }, notes };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** The run's turn and the review's fork of it, on one backend, and the thread ids the backend gave each. */
async function runAndFork(provider: AgentProvider, setup: Setup): Promise<{ runThread: string; forkThread: string; runEvents: AgentEvent[]; forkEvents: AgentEvent[] }> {
  const runEvents = await collect(
    provider.start({
      ...setup.run,
      cwd: setup.cwd,
      instructions: "You are an implementer. Work in the checkout you are given, using your tools, and answer in the format you are asked for.",
      context: "Read README.md and notes.txt in this checkout with your tools, then answer with one sentence summarising what they say.",
      signal: new AbortController().signal,
    }),
  );
  const started = runEvents.find((event) => event.type === "thread_started");
  expect(started, `the run never started: ${JSON.stringify(runEvents.filter((event) => event.type === "error"))}`).toBeDefined();
  const runThread = (started as { threadId: string }).threadId;
  const forked = await provider.fork!(runThread, learningReviewPrompt([{ scope: { kind: "project", id: "project-settlements" }, name: "Settlements" }]), {
    ...setup.review,
    signal: new AbortController().signal,
  });
  expect(forked.ok, JSON.stringify(forked)).toBe(true);
  if (!forked.ok) throw new Error("unreachable");
  const forkEvents = await collect(forked.events);
  return { runThread, forkThread: forked.threadId, runEvents, forkEvents };
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function jsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function report(backend: string, figures: Record<string, unknown>): void {
  const dir = process.env["EO_LIVE_REPORT_DIR"];
  if (dir) writeFileSync(join(dir, `review-fork-cache-${backend}.json`), `${JSON.stringify(figures, null, 2)}\n`);
  console.log(`[review fork cache] ${backend}: ${JSON.stringify(figures)}`);
}

/** What each request a session made read from the cache, in order, from a Claude transcript. */
function claudeRequests(sessionId: string): { cacheRead: number; cacheWrite: number; input: number; afterReview: boolean }[] {
  const path = filesUnder(join(homedir(), ".claude", "projects")).find((file) => file.endsWith(`${sessionId}.jsonl`));
  expect(path, `no transcript for session ${sessionId}`).toBeDefined();
  const requests: { cacheRead: number; cacheWrite: number; input: number; afterReview: boolean }[] = [];
  const seen = new Set<string>();
  let afterReview = false;
  for (const entry of jsonLines(path as string)) {
    const message = entry["message"] as { id?: string; role?: string; content?: unknown; usage?: Record<string, number> } | undefined;
    if (entry["type"] === "user" && JSON.stringify(message?.content ?? "").includes("# Learning review")) afterReview = true;
    if (entry["type"] !== "assistant" || !message?.usage || message.id === undefined || seen.has(message.id)) continue;
    // One request can be written as several entries, one per block.
    seen.add(message.id);
    requests.push({ cacheRead: message.usage["cache_read_input_tokens"] ?? 0, cacheWrite: message.usage["cache_creation_input_tokens"] ?? 0, input: message.usage["input_tokens"] ?? 0, afterReview });
  }
  return requests;
}

describe.skipIf(!OPTED_IN)("the learning review's fork reads the run's thread from the prompt cache (EO-732)", () => {
  it(
    "on Claude",
    async () => {
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executablePath = resolveRuntime({ spec: RUNTIMES.claude, root }).path;
      const sdkEntryPath = resolvePackageSet(root, CLAUDE_SDK);
      expect(executablePath, "the managed claude runtime must be installed").not.toBeNull();
      expect(sdkEntryPath, "the managed Claude Agent SDK must be installed").not.toBeNull();
      const setup = await setUp("claude");
      const model = process.env["EO_LIVE_CLAUDE_MODEL"];
      const provider = createClaudeProvider({
        sdkEntryPath: sdkEntryPath as string,
        executablePath,
        eoMcp: { serverPath: EO_SERVER, enableCommentTool: true, enableMemoryNote: true },
        ...(model ? { config: { model } } : {}),
      });
      const { runThread, forkThread, forkEvents } = await runAndFork(provider, setup);

      const runRequests = claudeRequests(runThread).filter((request) => !request.afterReview);
      const forkRequests = claudeRequests(forkThread).filter((request) => request.afterReview);
      const runLast = runRequests.at(-1);
      const forkFirst = forkRequests[0];
      expect(runLast && forkFirst, `run ${JSON.stringify(runRequests)} fork ${JSON.stringify(forkRequests)}`).toBeTruthy();
      const figures = {
        runThread,
        forkThread,
        runLastRequest: runLast,
        forkFirstRequest: forkFirst,
        readOfRun: Number(((forkFirst!.cacheRead / runLast!.cacheRead) * 100).toFixed(1)),
        forkCalls: forkEvents.filter((event) => event.type === "tool_call").map((event) => (event as { name: string }).name),
        notes: setup.notes,
      };
      report("claude", figures);
      expect(forkFirst!.cacheRead).toBeGreaterThanOrEqual(0.9 * runLast!.cacheRead);
    },
    600_000,
  );

  it(
    "on Codex, in prediction mode",
    async () => {
      const root = runtimeRoot(join(homedir(), ".config", "EO"));
      const executablePath = resolveRuntime({ spec: RUNTIMES.codex, root }).path;
      expect(executablePath, "the managed codex runtime must be installed").not.toBeNull();
      const setup = await setUp("codex");
      const model = process.env["EO_LIVE_CODEX_MODEL"];
      // What each model response read from the cache, as the app-server
      // reports it (`thread/tokenUsage/updated`'s `last`), by thread. Read
      // off the wire because a prediction-mode fork is ephemeral: it
      // leaves no rollout to read it from.
      const readings: { threadId: string; cached: number; input: number }[] = [];
      const listening: AppServerSpawn = (command, args, spawnOptions) => {
        const child = spawn(command, args, spawnOptions) as ChildProcessWithoutNullStreams;
        createInterface({ input: child.stdout }).on("line", (line) => {
          let message: { method?: string; params?: { threadId?: string; tokenUsage?: { last?: { cachedInputTokens?: number; inputTokens?: number } } } };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            return;
          }
          const last = message.params?.tokenUsage?.last;
          if (message.method === "thread/tokenUsage/updated" && message.params?.threadId && last) {
            readings.push({ threadId: message.params.threadId, cached: last.cachedInputTokens ?? 0, input: last.inputTokens ?? 0 });
          }
        });
        return child;
      };
      const providerOptions: CodexProviderOptions = {
        executablePath,
        eoMcp: { serverPath: EO_SERVER, enableCommentTool: true, enableMemoryNote: true },
        attachedServers: [
          {
            id: "srv-probe",
            name: "probe",
            description: "",
            config: { transport: "stdio", command: process.execPath, args: [join(dirname(setup.cwd), "stub-server.mjs"), "probe"] },
            envNames: [],
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
            connector: null,
          },
        ],
        attachedSkills: [SKILL],
        searchHookCommandPath: HOOK_COMMAND,
        ...(model ? { config: { model } } : {}),
      };
      const provider = createCodexProvider({
        ...providerOptions,
        createCodex: (...turn: Parameters<NonNullable<CodexProviderOptions["createCodex"]>>) => new CodexClient({ ...codexClientOptions(providerOptions, ...turn), spawn: listening }),
      });
      const { runThread, forkThread, forkEvents } = await runAndFork(provider, setup);

      const runLast = readings.filter((reading) => reading.threadId === runThread).at(-1);
      const forkFirst = readings.find((reading) => reading.threadId === forkThread);
      expect(runLast && forkFirst, JSON.stringify(readings)).toBeTruthy();
      const started = forkEvents.find((event) => event.type === "thread_started");
      const figures = {
        runThread,
        forkThread,
        fork: started?.type === "thread_started" ? started.fork : undefined,
        runLastRequest: runLast,
        forkFirstRequest: forkFirst,
        readOfRun: Number(((forkFirst!.cached / runLast!.cached) * 100).toFixed(1)),
        forkCalls: forkEvents.filter((event) => event.type === "tool_call").map((event) => (event as { name: string }).name),
        notes: setup.notes,
      };

      // And what the review may not do is still refused on a fork that
      // takes its configuration from the original rather than from EO
      // (EO-732): a fork told to write a file and call the attached
      // server does neither — while `memory_note`, made with the review's
      // credential, which reaches the copy the same way, is written.
      const notesBefore = setup.notes.length;
      const refusedFork = await provider.fork!(
        runThread,
        "Do these three things, each once, even if one fails: (1) run the shell command `echo hi > refused.txt`; (2) call the probe server's probe_tool_0 tool; (3) call the eo server's memory_note tool with scope `project` and the text `Settlements are posted to the ledger before 06:00 UTC.` Then report what happened to each in one line each.",
        { ...setup.review, signal: new AbortController().signal },
      );
      expect(refusedFork.ok, JSON.stringify(refusedFork)).toBe(true);
      if (!refusedFork.ok) throw new Error("unreachable");
      const refusedEvents = await collect(refusedFork.events);
      const refusedStarted = refusedEvents.find((event) => event.type === "thread_started");
      const refusals = {
        fork: refusedStarted?.type === "thread_started" ? refusedStarted.fork : undefined,
        fileWritten: existsSync(join(setup.cwd, "refused.txt")),
        notesWritten: setup.notes.slice(notesBefore).map((note) => (JSON.parse(note) as { tool: string }).tool),
        said: refusedEvents.flatMap((event) => (event.type === "output" ? [event.text] : [])).join(""),
      };
      report("codex", { ...figures, refusals });

      expect(figures.fork).toEqual({ mode: "prediction" });
      expect(forkFirst!.cached).toBeGreaterThanOrEqual(0.9 * runLast!.cached);
      expect(refusals.fork).toEqual({ mode: "prediction" });
      expect(refusals.fileWritten).toBe(false);
      expect(refusals.notesWritten).toEqual([MEMORY_NOTE_TOOL_NAME]);
    },
    600_000,
  );
});
