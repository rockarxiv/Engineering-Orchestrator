import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, RepositoryMcpServer } from "@eo/core";
import { describe, expect, it } from "vitest";
import { buildCodexOptions, createCodexProvider, type CodexSearchHookDelivery } from "../../../providers/codex.js";
import { serializeConfigOverrides, type ThreadEvent } from "../../../providers/codexClient.js";
import { repositorySearchNudge } from "./broadSearch.js";

/**
 * The shipped classifier, delivered through the Codex adapter (EO-379).
 *
 * The twin of `claudeInterception.test.ts`, and here rather than beside
 * the adapter for the reason that one is: driving a real command through
 * the hook and asserting the sentence it says is this directory's
 * judgement wired into the core's delivery — the pack testing itself
 * through the core, which is the direction the dependency runs.
 *
 * **Nothing in the path is stood in for except Codex.** The provider
 * opens its real listener, the configuration it builds names the real
 * command, and the fake thread below does what the CLI does with that
 * configuration: it runs the command line through a shell, in the
 * environment it was launched with, with a `PreToolUse` payload on stdin.
 * So what answers is `codexSearchHookCommand.mjs` reaching
 * `repositorySearchNudge` — the one classifier — and a second classifier
 * hidden in the command could not make these pass with the first removed.
 * Whether the pinned CLI really runs an inline hook this way is
 * `providers/codexHooks.live.test.ts`.
 */
const HOOK_COMMAND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "providers", "codexSearchHookCommand.mjs");

const withAnswers = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  /** An index that holds whatever it is asked about, so these stay about delivery (EO-173). */
  knows: async (question: { of: string; name?: string; pattern?: string }) => [
    { name: question.of === "symbol" ? (question.name ?? "") : "packages/engine/src/routing.ts", path: "packages/engine/src/routing.ts" },
    { name: question.of === "symbol" ? (question.name ?? "") : "apps/desktop/src/main/providers/codex.ts", path: "apps/desktop/src/main/providers/codex.ts" },
  ],
} as unknown as RepositoryMcpServer;

const startOpts = { instructions: "You are the implementer.", context: "EO-1: do the thing", cwd: "/tmp/wt", signal: new AbortController().signal };

/** What the hook printed for one shell call — what Codex would hand the model. */
interface HookRun {
  stdout: string;
  code: number | null;
}

/** Runs the configured hook the way the CLI does: the command line, through a shell, payload on stdin. */
function runHook(hook: CodexSearchHookDelivery, payload: unknown): Promise<HookRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(hook.command, { shell: true, env: { ...process.env, ...hook.env }, stdio: ["pipe", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ stdout, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** A `PreToolUse` payload shaped the way the pinned CLI sends one (`codexHooks.live.test.ts`). */
const preToolUse = (command: string, callId: string): unknown => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_use_id: callId,
  session_id: "thr_1",
  cwd: "/tmp/wt",
});

const shellItem = (id: string, command: string): ThreadEvent =>
  ({ type: "item.completed", item: { id, type: "command_execution", command, exit_code: 0, status: "completed", aggregated_output: "packages/engine/src/routing.ts:1:transitionItem" } }) as ThreadEvent;

/**
 * A Codex turn that makes these shell calls: for each, the hook fires
 * first and the completed item follows, which is the order the CLI
 * keeps. Records what the provider constructed the client with.
 */
function codexRunning(calls: { id: string; command: string }[]) {
  const seen: { hook: CodexSearchHookDelivery | undefined; runs: HookRun[] } = { hook: undefined, runs: [] };
  const createCodex = (_server?: RepositoryMcpServer, hook?: CodexSearchHookDelivery) => {
    seen.hook = hook;
    const thread = {
      runStreamed: async () => ({
        events: (async function* (): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "thr_1" };
          for (const call of calls) {
            if (hook) seen.runs.push(await runHook(hook, preToolUse(call.command, call.id)));
            yield shellItem(call.id, call.command);
          }
          yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } } as ThreadEvent;
        })(),
      }),
    };
    return { startThread: () => thread, resumeThread: () => thread } as never;
  };
  return { seen, createCodex };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** The adapter as the composition root wires it: the pack's nudge, and the shipped command. */
const wired = {
  searchNudge: repositorySearchNudge,
  searchHookCommandPath: HOOK_COMMAND,
  // What the CLI would answer when asked how to trust the hook; asking it
  // is `providers/codexSearchHook.test.ts` and the live test.
  searchHookTrust: async () => ({ key: "/<session-flags>/config.toml:pre_tool_use:0:0", hash: "sha256:stand-in" }),
};

describe("intercepting a broad search on Codex", () => {
  it("answers a repository-wide grep with the nudge a Claude agent gets, and records it against the call", async () => {
    const { seen, createCodex } = codexRunning([{ id: "call_1", command: "grep -rn transitionItem ." }]);

    const events = await collect(createCodexProvider({ ...wired, createCodex }).start({ ...startOpts, repositoryMcp: withAnswers }));

    // What the model is told: the hook's own stdout, in the shape Codex
    // reads `additionalContext` from, and nothing that could stop the call.
    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0]?.code).toBe(0);
    const said = JSON.parse(seen.runs[0]?.stdout ?? "") as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string }; decision?: string };
    expect(said.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(said.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(said).not.toHaveProperty("decision");

    // The same nudge, from the same function: what `repositorySearchNudge`
    // says for this call when asked directly in this backend's spelling of
    // a tool id is, word for word, what the command printed.
    const direct = await repositorySearchNudge({
      tool: "Bash",
      input: { command: "grep -rn transitionItem ." },
      answers: withAnswers.answers,
      knows: withAnswers.knows,
      qualify: (tool) => `repo/${tool}`,
      root: "/tmp/wt",
    });
    expect(direct).not.toBeNull();
    expect(said.hookSpecificOutput?.additionalContext).toBe(direct?.nudge);
    // And that sentence is Claude's but for the spelling of the tool ids.
    const claude = await repositorySearchNudge({
      tool: "Bash",
      input: { command: "grep -rn transitionItem ." },
      answers: withAnswers.answers,
      knows: withAnswers.knows,
      qualify: (tool) => `mcp__repo__${tool}`,
      root: "/tmp/wt",
    });
    expect(direct?.nudge.replaceAll("repo/", "mcp__repo__")).toBe(claude?.nudge);
    expect(direct?.nudge).toContain("repo/idx_symbol");
    expect(direct?.nudge).toContain("transitionItem");

    // The record of the firing (EO-168), carrying the call's own id and
    // sitting between that call and its result — the order a Claude run
    // records.
    expect(events.map((event) => event.type)).toEqual(["thread_started", "tool_call", "search_interception", "tool_result", "output", "result"]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({ callId: "call_1" });
    expect(events.find((event) => event.type === "search_interception")).toEqual({
      type: "search_interception",
      tool: "Bash",
      callId: "call_1",
      kind: "symbol",
      needle: "transitionItem",
      suggestion: direct?.nudge,
    });
  });

  it("says nothing, and records nothing, about the commands a run is mostly made of", async () => {
    const commands = ["pnpm test", "git status --porcelain", "cat packages/engine/src/routing.ts"];
    const { seen, createCodex } = codexRunning(commands.map((command, index) => ({ id: `call_${index}`, command })));

    const events = await collect(createCodexProvider({ ...wired, createCodex }).start({ ...startOpts, repositoryMcp: withAnswers }));

    // The hook ran each time and had nothing to say: empty stdout and a
    // clean exit, which Codex reads as a hook with no opinion.
    expect(seen.runs).toEqual(commands.map(() => ({ stdout: "", code: 0 })));
    expect(events.filter((event) => event.type === "search_interception")).toEqual([]);
  });

  it("joins each of two broad searches to its own call", async () => {
    const { createCodex } = codexRunning([
      { id: "call_a", command: "grep -rn transitionItem ." },
      { id: "call_b", command: "find . -name '*.test.ts'" },
    ]);

    const events = await collect(createCodexProvider({ ...wired, createCodex }).start({ ...startOpts, repositoryMcp: withAnswers }));

    const order = events.filter((event) => event.type === "tool_call" || event.type === "search_interception").map((event) => `${event.type}:${(event as { callId?: string | null }).callId}`);
    expect(order).toEqual(["tool_call:call_a", "search_interception:call_a", "tool_call:call_b", "search_interception:call_b"]);
    expect(events.filter((event) => event.type === "search_interception").map((event) => (event as { kind: string }).kind)).toEqual(["symbol", "file"]);
  });

  it("carries the hook on a resume too, because that spawns the CLI afresh", async () => {
    const { seen, createCodex } = codexRunning([{ id: "call_9", command: "grep -rn transitionItem ." }]);

    const events = await collect(createCodexProvider({ ...wired, createCodex }).resume("thr_1", "carry on", { cwd: "/tmp/wt", repositoryMcp: withAnswers }));

    expect(seen.hook).toBeDefined();
    expect(events.filter((event) => event.type === "search_interception")).toMatchObject([{ callId: "call_9" }]);
  });
});

describe("a Codex run with no index", () => {
  it("is configured with no hook at all", async () => {
    const { seen, createCodex } = codexRunning([{ id: "call_1", command: "grep -rn transitionItem ." }]);

    // The composition root's wiring, exactly — and an item with no index.
    const events = await collect(createCodexProvider({ ...wired, createCodex }).start(startOpts));

    // No hook handed to the client, so none ran and none was recorded.
    expect(seen.hook).toBeUndefined();
    expect(seen.runs).toEqual([]);
    expect(events.filter((event) => event.type === "search_interception")).toEqual([]);
    // And what the CLI is launched with says nothing about hooks: no
    // `hooks` override on its command line — neither an entry nor a
    // trust state — and nothing of the listener's in its environment.
    const options = buildCodexOptions({ ...wired, executablePath: "/opt/eo/runtimes/codex/bin/codex" });
    expect(serializeConfigOverrides(options.config ?? {}).filter((override) => override.startsWith("hooks"))).toEqual([]);
    expect(options).not.toHaveProperty("env");
  });

  it("is configured with none when the index names its tools but cannot be asked what it holds (EO-173)", async () => {
    const { seen, createCodex } = codexRunning([{ id: "call_1", command: "grep -rn transitionItem ." }]);
    const unaskable = { ...withAnswers, knows: undefined } as unknown as RepositoryMcpServer;

    const events = await collect(createCodexProvider({ ...wired, createCodex }).start({ ...startOpts, repositoryMcp: unaskable }));

    expect(seen.hook).toBeUndefined();
    expect(events.filter((event) => event.type === "search_interception")).toEqual([]);
  });
});
