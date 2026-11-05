import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repositorySearchNudge } from "./broadSearch.js";
import { createClaudeProvider } from "../../../providers/claude.js";

/**
 * What the Claude adapter puts on the wire, pinned byte for byte (KAN-126).
 *
 * The phase this belongs to is behaviour-preserving, and the story
 * moved the search nudge from an import inside this adapter to an
 * option the composition root supplies. That is exactly the kind of
 * change that keeps every existing test green while altering what an
 * agent is actually sent — a hook that used to be registered and now
 * is not, a sentence spelled slightly differently. So this snapshot was
 * generated against the adapter *before* the move, with the nudge still
 * imported, and the refactored adapter is held to it.
 *
 * Three things are captured, because the prompt an agent sees is all
 * three: the first message on the stream, the options the SDK is built
 * with (system prompt included), and the sentence the interception hook
 * says when it fires. Functions are printed as `[Function]` since their
 * source is not the contract; what they *say* is, and that is the third
 * capture.
 *
 * In this directory rather than beside the adapter, because the third
 * capture is this directory's sentence: the adapter now has no
 * classifier of its own, and a test that wires the shipped one into it
 * is the pack testing its delivery through the core — the direction the
 * dependency runs. `liftedFromPack.test.ts` is what keeps a copy of this
 * from appearing under `providers/`.
 */

function init(sessionId = "sess_1"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function result(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.0234,
    usage: { input_tokens: 1200, output_tokens: 340 },
    session_id: "sess_1",
  } as unknown as SDKMessage;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function fakeQuery() {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      yield init();
      yield result();
    })();
  }) as never;
  return { runQuery, calls };
}

/** The first message EO sent, as text. */
async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
    const content = message.message.content;
    return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
  }
  return "";
}

/**
 * The options as a stable, printable value: functions and the abort
 * controller become markers, everything else is kept verbatim so a
 * changed key, value or ordering shows in the diff.
 */
function printable(value: unknown): unknown {
  if (typeof value === "function") return "[Function]";
  if (value instanceof AbortController) return "[AbortController]";
  // The EO server is launched through the running Node, whose path is
  // this machine's rather than the contract's.
  if (value === process.execPath) return "[process.execPath]";
  if (Array.isArray(value)) return value.map(printable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, printable(entry)]));
  }
  return value;
}

/** The options, with the CLI's environment printed as `printableEnv` says. */
function printableOptions(options: Record<string, unknown> | undefined): unknown {
  if (!options) return printable(options);
  return printable({ ...options, ...("env" in options ? { env: printableEnv(options["env"]) } : {}) });
}

/**
 * The CLI's environment as what EO sets over the parent's: since EO-453
 * every turn passes one (for `CLAUDE_CODE_FORK_SUBAGENT`), and the
 * parent's own variables are this machine's rather than the contract's.
 */
function printableEnv(env: unknown): unknown {
  if (env === null || typeof env !== "object") return printable(env);
  const own = Object.entries(env as Record<string, unknown>).filter(([key, entry]) => process.env[key] !== entry);
  return { "[process.env]": true, ...Object.fromEntries(own) };
}

type Hook = (input: unknown) => Promise<{ hookSpecificOutput?: { additionalContext?: string } } | Record<string, never>>;
type Hooks = { PreToolUse?: { matcher?: string; hooks: Hook[] }[] };

function preToolUse(tool: string, input: unknown) {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_1", session_id: "sess_1", transcript_path: "/tmp/t.jsonl", cwd: "/tmp/wt" };
}

/** Everything the hook says for a fixed set of calls — the sentences, or `{}` for silence. */
async function hookSays(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hook = (options["hooks"] as Hooks | undefined)?.PreToolUse?.[0]?.hooks[0];
  if (!hook) return { hook: "none registered" };
  const calls: [string, string, unknown][] = [
    ["grep", "Bash", { command: "grep -rn transitionItem ." }],
    ["rg", "Bash", { command: "rg transitionItem apps packages" }],
    ["find", "Bash", { command: "find . -name '*.test.ts'" }],
    ["ls", "Bash", { command: "ls -R" }],
    ["Grep", "Grep", { pattern: "transitionItem", output_mode: "content" }],
    ["Glob", "Glob", { pattern: "**/*.test.ts" }],
    ["test", "Bash", { command: "pnpm test" }],
    ["cat", "Bash", { command: "cat packages/engine/src/routing.ts" }],
  ];
  const said: Record<string, unknown> = {};
  for (const [label, tool, input] of calls) said[label] = await hook(preToolUse(tool, input));
  return said;
}

const repositoryMcp = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  knows: async (question: { of: string; name?: string; pattern?: string }) => [
    { name: question.of === "symbol" ? (question.name ?? "") : "packages/engine/src/routing.ts", path: "packages/engine/src/routing.ts" },
  ],
};

const outputSchema = {
  type: "object",
  properties: { branch: { type: "string" }, summary: { type: "string" } },
  required: ["branch", "summary"],
  additionalProperties: false,
};

const attachments = [
  { id: "att-1", name: "spec.pdf", mimeType: "application/pdf", size: 1234, origin: "local", synchronizationState: "synced" },
  { id: "att-2", name: "mock.png", mimeType: "image/png", size: 99, origin: "jira", synchronizationState: "pending" },
];

/**
 * How the composition root wires the adapter (`engine.ts`): the nudge
 * is the developer directories' own, handed in as an option.
 */
const composed = { searchNudge: repositorySearchNudge };

describe("the Claude adapter's prompt, pinned", () => {
  // Unset for the snapshot, whatever the shell running it says: EO sets
  // it to "0" for every Claude turn it dispatches (EO-453), so an agent
  // running this suite inherits it, and the adapter leaves a value it
  // finds alone — which would print a different `env`.
  //
  // The auto-memory switch (EO-468) likewise: EO sets it on every turn,
  // so an agent running this suite inherits it, and `printableEnv` would
  // then drop it as the parent's own rather than print what EO sets.
  const pinned = ["CLAUDE_CODE_FORK_SUBAGENT", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"] as const;
  let before: Partial<Record<(typeof pinned)[number], string>> = {};
  beforeEach(() => {
    before = {};
    for (const name of pinned) {
      if (process.env[name] !== undefined) before[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of pinned) {
      const value = before[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("sends the same bare start turn", async () => {
    const { runQuery, calls } = fakeQuery();
    await collect(
      createClaudeProvider({ runQuery, ...composed }).start({
        instructions: "You are the implementer.",
        context: "EO-1: do the thing",
        cwd: "/tmp/wt",
        signal: new AbortController().signal,
      }),
    );

    const [call] = calls;
    expect({ prompt: await promptText(call?.prompt), options: printableOptions(call?.options), hook: await hookSays(call?.options ?? {}) }).toMatchSnapshot();
  });

  it("sends the same fully configured start turn, and the hook says the same things", async () => {
    const { runQuery, calls } = fakeQuery();
    await collect(
      createClaudeProvider({
        runQuery,
        ...composed,
        config: { model: "claude-sonnet-4-5", effort: "high", allowedTools: ["Read", "Edit", "Bash"] },
        enableCommentTool: true,
        executablePath: "/opt/eo/runtimes/claude/claude",
        eoMcp: { serverPath: "/opt/eo/mcp/server.js", dbPath: "/tmp/eo.db", enableConfigTools: true, enableFullThread: false, runtimeRoot: "/opt/eo/runtimes" },
      }).start({
        instructions: "You are the implementer.\n\nDo exactly what the ticket says.",
        context: "# Task\nEO-1: do the thing\n\n## Acceptance Criteria\n- It does the thing.",
        cwd: "/tmp/wt",
        signal: new AbortController().signal,
        outputSchema,
        attachments,
        model: "claude-opus-4-1",
        reasoningEffort: "max",
        repositoryMcp,
      } as never),
    );

    const [call] = calls;
    expect({ prompt: await promptText(call?.prompt), options: printableOptions(call?.options), hook: await hookSays(call?.options ?? {}) }).toMatchSnapshot();
  });

  it("sends the same resumed turn", async () => {
    const { runQuery, calls } = fakeQuery();
    await collect(
      createClaudeProvider({ runQuery, ...composed, config: { model: "claude-sonnet-4-5" } }).resume("sess_1", "carry on", {
        cwd: "/tmp/wt",
        signal: new AbortController().signal,
        outputSchema,
        repositoryMcp,
      } as never),
    );

    const [call] = calls;
    expect({ prompt: await promptText(call?.prompt), options: printableOptions(call?.options), hook: await hookSays(call?.options ?? {}) }).toMatchSnapshot();
  });

  it("sends the same start turn minus the hook when the caller supplies no nudge", async () => {
    // Written after the move, unlike the three above: with an index but
    // no judgement about it, the hook goes with the nudge and everything
    // else is the fully configured turn, byte for byte.
    const { runQuery, calls } = fakeQuery();
    await collect(
      createClaudeProvider({ runQuery, config: { model: "claude-sonnet-4-5" } }).start({
        instructions: "You are the implementer.",
        context: "EO-1: do the thing",
        cwd: "/tmp/wt",
        signal: new AbortController().signal,
        repositoryMcp,
      } as never),
    );

    const [call] = calls;
    expect({ prompt: await promptText(call?.prompt), options: printableOptions(call?.options), hook: await hookSays(call?.options ?? {}) }).toMatchSnapshot();
  });
});
