import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { developerRegistry, isThreadNotFound, outputSchemaFor, type AgentEvent, type ThreadNotFoundError } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answersTurn, createClaudeProvider, mapSdkMessage, normaliseToolName, stripSchemaDialect, type SearchNudge } from "./claude.js";
import { writeToolDirectory } from "../agentAttachments/pluginDirectory.js";

/** No settings files at all, so a test does not read the developer's own (EO-599). */
const NO_SETTINGS = { readText: () => null, listDir: () => [] };

// The real SDK spawns the `claude` CLI and spends money, so these drive
// the mapping and the stream plumbing — the part that is ours to get
// right. See scripts/claude-smoke.mjs for the live check.
function init(sessionId = "sess_1"): SDKMessage {
  return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function assistant(content: unknown[]): SDKMessage {
  return { type: "assistant", message: { content }, session_id: "sess_1" } as unknown as SDKMessage;
}

/** The envelope a tool result arrives in: a user message of `tool_result` blocks. */
function toolResults(content: unknown[]): SDKMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "sess_1" } as unknown as SDKMessage;
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    total_cost_usd: 0.0234,
    usage: { input_tokens: 1200, output_tokens: 340 },
    session_id: "sess_1",
    ...overrides,
  } as unknown as SDKMessage;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function fakeQuery(messages: SDKMessage[]) {
  const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
  const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options ?? {} });
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  return { runQuery, calls };
}

/**
 * What EO actually put on the wire as the turn's first message.
 *
 * The prompt is an async iterable rather than a string since EO-176 —
 * that is what holds the CLI's stdin open, and so what makes a message
 * steerable into a running turn — so a test asking "what was the agent
 * sent?" reads the first message off it. Everything downstream of that
 * first message is unchanged, which is what these assertions are for.
 */
async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
    const content = message.message.content;
    return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
  }
  return "";
}

/** A turn that fails the way a real one does: on the first `next()`, not on the call. */
function throwingQuery(error: unknown) {
  const runQuery = (() => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  })) as never;
  return { runQuery };
}

/** Whatever draining the stream threw. Fails the test if it threw nothing. */
async function captureThrow(stream: AsyncIterable<AgentEvent>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  throw new Error("expected the stream to throw");
}

const startOpts = { instructions: "You are the implementer.", context: "EO-1: do the thing", cwd: "/tmp/wt", signal: new AbortController().signal };

/** The environment the CLI would be spawned with: `options.env` when set, which replaces the parent's, and the parent's own otherwise. */
function childEnv(options: Record<string, unknown> | undefined): Record<string, string | undefined> {
  return (options?.["env"] ?? process.env) as Record<string, string | undefined>;
}

describe("mapSdkMessage", () => {
  it("takes the session id from init — what E-04 resumes from", () => {
    expect(mapSdkMessage(init("sess_abc")).mapped).toEqual([{ type: "thread_started", threadId: "sess_abc" }]);
  });

  it("says which MCP servers came up, in the backend's own names and words", () => {
    // EO does not get to assume a directory it wrote is a server that
    // started (EO-107, invariant #5). Passed through unmapped: the name
    // is the CLI's `plugin:<plugin>:<server>` rather than the one a
    // person typed, and `needs-auth` and `failed` are different things
    // to do something about.
    const message = {
      type: "system",
      subtype: "init",
      session_id: "sess_1",
      mcp_servers: [
        { name: "eo", status: "connected" },
        { name: "plugin:eo-attachments:github", status: "failed" },
      ],
    } as unknown as SDKMessage;

    expect(mapSdkMessage(message).mapped).toEqual([
      { type: "thread_started", threadId: "sess_1" },
      {
        type: "server_status",
        servers: [
          { name: "eo", status: "connected" },
          { name: "plugin:eo-attachments:github", status: "failed" },
        ],
      },
    ]);
  });

  it("reports an empty server list as an answer, because that is the one that matters", () => {
    const message = { type: "system", subtype: "init", session_id: "sess_1", mcp_servers: [] } as unknown as SDKMessage;

    // A run whose only attached server never appeared has to be
    // distinguishable from a CLI too old to say anything at all — which
    // is the `init()` above, and which maps to `thread_started` alone.
    expect(mapSdkMessage(message).mapped).toEqual([
      { type: "thread_started", threadId: "sess_1" },
      { type: "server_status", servers: [] },
    ]);
    expect(mapSdkMessage(init()).mapped).toEqual([{ type: "thread_started", threadId: "sess_1" }]);
  });

  it("maps assistant text to output, skipping empty blocks", () => {
    const { mapped } = mapSdkMessage(assistant([{ type: "text", text: "working on it" }, { type: "text", text: "   " }]));
    expect(mapped).toEqual([{ type: "output", text: "working on it" }]);
  });

  it("maps a tool call, stripping the MCP prefix so A-03's branch fires", () => {
    const { mapped } = mapSdkMessage(
      assistant([{ type: "tool_use", name: "mcp__eo__comment", input: { body: "@user which limit?", blocking: true } }]),
    );

    expect(mapped).toEqual([{ type: "tool_call", name: "comment", args: { body: "@user which limit?", blocking: true } }]);
  });

  it("records what a tool returned, under the name of the call it answers (EO-169)", () => {
    // The name is on the call and the id is on both, so the pairing is
    // the whole trick: a result block carries `tool_use_id` and nothing
    // else that says what ran.
    const pending = new Map<string, string>();
    mapSdkMessage(assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]), pending);
    const { mapped } = mapSdkMessage(toolResults([{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "a.ts\nb.ts" }] }]), pending);

    expect(mapped).toEqual([{ type: "tool_result", name: "Bash", callId: "toolu_1", ok: true, output: "a.ts\nb.ts", truncated: false }]);
  });

  it("pairs each of a batch with its own call, rather than with the one before it", () => {
    const pending = new Map<string, string>();
    mapSdkMessage(
      assistant([
        { type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "TODO" } },
        { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "src/a.ts" } },
      ]),
      pending,
    );
    // Answered out of order, which is what parallel calls do.
    const { mapped } = mapSdkMessage(
      toolResults([
        { type: "tool_result", tool_use_id: "toolu_2", content: "export const a = 1;" },
        { type: "tool_result", tool_use_id: "toolu_1", content: "src/a.ts:3: TODO" },
      ]),
      pending,
    );

    expect(mapped).toMatchObject([
      { name: "Read", callId: "toolu_2", output: "export const a = 1;" },
      { name: "Grep", callId: "toolu_1", output: "src/a.ts:3: TODO" },
    ]);
  });

  it("says nothing about a tool it never saw called, instead of guessing a name", () => {
    const { mapped } = mapSdkMessage(toolResults([{ type: "tool_result", tool_use_id: "toolu_unseen", content: "…" }]));

    expect(mapped).toEqual([{ type: "tool_result", callId: "toolu_unseen", ok: true, output: "…", truncated: false }]);
  });

  it("carries the backend's one word about failure through as `ok`", () => {
    const { mapped } = mapSdkMessage(
      toolResults([{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "No such file or directory" }]),
    );

    expect(mapped[0]).toMatchObject({ type: "tool_result", ok: false, output: "No such file or directory" });
  });

  it("bounds a result, because run_events is append-only and a grep is not small", () => {
    const { mapped } = mapSdkMessage(toolResults([{ type: "tool_result", tool_use_id: "toolu_1", content: "hit\n".repeat(20_000) }]));

    const event = mapped[0] as { output: string; truncated: boolean };
    expect(event.truncated).toBe(true);
    expect(event.output.length).toBeLessThan(5_000);
    expect(event.output.endsWith("hit")).toBe(true); // the tail, not the head
  });

  it("leaves the prompt and the CLI's own notices out of the transcript", () => {
    // A user message is also how EO's own dispatch text and the CLI's
    // synthetic interruptions arrive. Mapping those would put words in
    // the agent's mouth, so only `tool_result` blocks are read.
    expect(mapSdkMessage(toolResults([{ type: "text", text: "Implement EO-169." }])).mapped).toEqual([]);
    expect(mapSdkMessage({ type: "user", message: { role: "user", content: "[Request interrupted]" } } as unknown as SDKMessage).mapped).toEqual([]);
  });

  it("keeps a built-in tool's own name", () => {
    const { mapped } = mapSdkMessage(assistant([{ type: "tool_use", name: "Bash", input: { command: "pnpm test" } }]));
    expect(mapped[0]).toMatchObject({ type: "tool_call", name: "Bash" });
  });

  it("reports a file-writing tool as a file edit as well as a call", () => {
    const { mapped } = mapSdkMessage(assistant([{ type: "tool_use", name: "Write", input: { file_path: "src/a.ts" } }]));

    expect(mapped.map((event) => event.type)).toEqual(["tool_call", "file_edit"]);
    expect(mapped[1]).toEqual({ type: "file_edit", path: "src/a.ts" });
  });

  it("counts every input token, cache included, from modelUsage rather than the main-loop-only usage", () => {
    // The bug this pins: `usage.input_tokens` is net of both cache
    // counters and excludes subagents, so an hour of reading a
    // repository recorded a few hundred input tokens against a run that
    // cost real money. The SDK's own types say to prefer `modelUsage`.
    const { mapped } = mapSdkMessage(result({
      num_turns: 9,
      usage: { input_tokens: 1_200, output_tokens: 340 },
      modelUsage: {
        "claude-opus-4-7": { inputTokens: 1_200, outputTokens: 340, cacheReadInputTokens: 610_000, cacheCreationInputTokens: 24_000 },
        // A subagent on another model is this run's doing too.
        "claude-haiku-4-5": { inputTokens: 800, outputTokens: 60, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }));

    expect(mapped[0]).toEqual({
      type: "usage",
      scope: "session",
      tokensIn: 1_200 + 610_000 + 24_000 + 800,
      tokensOut: 400,
      cacheReadTokens: 610_000,
      cacheWriteTokens: 24_000,
      turns: 9,
      // Recorded because E-05's guards are denominated in cents and
      // nothing else reports any — not because anyone is reading it.
      costCents: 2,
      // And unrounded, for a side call's sake (EO-510).
      costMicrocents: 2_340_000,
    });
  });

  it("reports a side call's fraction of a cent to the micro-cent, which whole cents round to nothing (EO-510)", () => {
    // A memory selection on Haiku: $0.004, which is 0.4¢.
    const { mapped } = mapSdkMessage(result({ total_cost_usd: 0.004, usage: { input_tokens: 3_401, output_tokens: 352 } }));

    expect(mapped[0]).toMatchObject({ type: "usage", costCents: 0, costMicrocents: 400_000 });
  });

  it("says the reading is the session's running total, not this turn's", () => {
    // The SDK re-reports the whole query's total on every result and
    // documents "read the latest result rather than summing across
    // results". A consumer that adds them up inflates silently, so the
    // scope is stated rather than assumed.
    const { mapped } = mapSdkMessage(result());

    expect(mapped[0]).toMatchObject({ type: "usage", scope: "session" });
  });

  it("falls back to the narrow reading when modelUsage is absent, rather than reporting nothing", () => {
    // An older CLI may not send `modelUsage` at all. An undercount beats
    // a run that accounts for nothing.
    const { mapped } = mapSdkMessage(result({
      usage: { input_tokens: 1_200, output_tokens: 340, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 500 },
    }));

    expect(mapped[0]).toMatchObject({ tokensIn: 10_700, cacheReadTokens: 9_000, cacheWriteTokens: 500 });
  });

  it("falls back when modelUsage is present but zeroed — which is how a crash reports", () => {
    // The other documented case, and the one a check for the *key* gets
    // wrong: the SDK says a crash or startup-error result may carry
    // zeroed values, and it carries them in `modelUsage`. Gating the
    // fallback on the key being missing takes the primary branch here
    // and records nothing at all.
    const { mapped } = mapSdkMessage(result({
      usage: { input_tokens: 1_200, output_tokens: 340, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 500 },
      modelUsage: { "claude-opus-4-7": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }));

    expect(mapped[0]).toMatchObject({ tokensIn: 10_700, cacheReadTokens: 9_000, cacheWriteTokens: 500 });
  });

  it("says nothing about caching when the message carries no cache counters", () => {
    // Absent is not zero: "0% cached" is a claim, and this message makes
    // none. The fields are left off so the run row keeps its nulls.
    const { mapped } = mapSdkMessage(result({ usage: { input_tokens: 1_200, output_tokens: 340 } }));

    expect(mapped[0]).not.toHaveProperty("cacheReadTokens");
    expect(mapped[0]).not.toHaveProperty("cacheWriteTokens");
  });

  it("records what the subscription window has left, which used to be dropped with the chatter", () => {
    // EO runs on a claude.ai plan: what stops work is a window filling
    // up, not a bill. The SDK volunteers this and nothing read it.
    const { mapped, recognised } = mapSdkMessage({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day_opus", utilization: 83, resetsAt: 1_787_600_000 },
      uuid: "u1",
      session_id: "sess_1",
    } as unknown as SDKMessage);

    expect(recognised).toBe(true);
    expect(mapped).toEqual([{
      type: "quota",
      provider: "claude",
      window: "seven_day_opus",
      utilization: 83,
      status: "allowed_warning",
      resetsAt: 1_787_600_000,
    }]);
  });

  it("keeps a recovery that carries no share — it is what takes a refusal back (EO-172)", () => {
    // This used to be dropped, on the reasoning that a reading with no
    // share said nothing. It says the one thing that matters: a refusal
    // is remembered for the length of a run, and an `allowed` reading is
    // the only thing that can clear it. Dropped, a window that came back
    // is never recorded and the stale refusal goes on suppressing
    // ordinary correction attempts.
    const { mapped, recognised } = mapSdkMessage({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "sess_1",
    } as unknown as SDKMessage);

    expect(recognised).toBe(true);
    expect(mapped).toEqual([{ type: "quota", provider: "claude", window: "five_hour", status: "allowed" }]);
    // Absent, not zero: a window nobody measured is not a window at 0%.
    expect(mapped[0]).not.toHaveProperty("utilization");
  });

  it("keeps a refusal even with no share on it — the status is what stops the run (EO-172)", () => {
    // The share was once the whole point of the reading, so one without
    // it was dropped. A `rejected` status is now what tells the
    // supervisor not to re-prompt against an allowance that is gone, and
    // dropping the event would leave it to diagnose the wreckage again.
    const { mapped, recognised } = mapSdkMessage({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      uuid: "u1",
      session_id: "sess_1",
    } as unknown as SDKMessage);

    expect(recognised).toBe(true);
    expect(mapped).toEqual([{ type: "quota", provider: "claude", window: "five_hour", status: "rejected" }]);
    // Absent, not zero: a window nobody measured is not a window at 0%.
    expect(mapped[0]).not.toHaveProperty("utilization");
  });

  it("recognises a rate limit event with no reading at all without taking the stream down", () => {
    const { mapped, recognised } = mapSdkMessage({ type: "rate_limit_event", uuid: "u1", session_id: "sess_1" } as unknown as SDKMessage);

    expect(recognised).toBe(true);
    expect(mapped).toEqual([]);
  });

  it("drops a reading with no status, which says nothing about whether the backend is answering", () => {
    // The status is the field every consumer keys off. A share on its own
    // cannot say whether the call was allowed or refused.
    const { mapped, recognised } = mapSdkMessage({
      type: "rate_limit_event",
      rate_limit_info: { utilization: 40 },
      uuid: "u1",
      session_id: "sess_1",
    } as unknown as SDKMessage);

    expect(recognised).toBe(true);
    expect(mapped).toEqual([]);
  });

  it("prefers structured output over the prose result when a schema was requested", () => {
    const { mapped } = mapSdkMessage(result({ structured_output: { branch: "eo/EO-1", summary: "done", handoff: "Straightforward; nothing to flag." } }));

    expect(mapped.at(-1)).toEqual({ type: "result", data: { branch: "eo/EO-1", summary: "done", handoff: "Straightforward; nothing to flag." } });
  });

  it("falls back to the prose result when no schema was requested", () => {
    expect(mapSdkMessage(result()).mapped.at(-1)).toEqual({ type: "result", data: "done" });
  });

  it("maps a failed run to an error, still reporting what it cost", () => {
    const { mapped } = mapSdkMessage(result({ subtype: "error_during_execution", is_error: true }));

    expect(mapped[0]?.type).toBe("usage"); // the money was spent either way
    expect(mapped.at(-1)).toMatchObject({ type: "error", retryable: true });
  });

  it("ignores streaming partials rather than persisting a copy of every keystroke", () => {
    expect(mapSdkMessage({ type: "stream_event" } as unknown as SDKMessage).mapped).toEqual([]);
    expect(mapSdkMessage({ type: "stream_event" } as unknown as SDKMessage).recognised).toBe(true);
  });

  it("flags a genuinely unknown message instead of dropping it", () => {
    const { mapped, recognised } = mapSdkMessage({ type: "some_future_kind" } as unknown as SDKMessage);
    expect(mapped).toEqual([]);
    expect(recognised).toBe(false);
  });
});

describe("normaliseToolName", () => {
  it("strips only our own server's prefix", () => {
    expect(normaliseToolName("mcp__eo__comment")).toBe("comment");
    expect(normaliseToolName("mcp__github__create_issue")).toBe("mcp__github__create_issue");
    expect(normaliseToolName("Bash")).toBe("Bash");
  });
});

describe("createClaudeProvider", () => {
  it("streams a turn and ends with the structured result", async () => {
    const { runQuery } = fakeQuery([
      init(),
      assistant([{ type: "text", text: "looking" }]),
      result({ structured_output: { branch: "eo/EO-1", summary: "done", handoff: "Straightforward; nothing to flag." } }),
    ]);

    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(events.map((event) => event.type)).toEqual(["thread_started", "output", "usage", "result"]);
  });

  it("carries a call's name across to the result that answers it, over the length of a turn (EO-169)", async () => {
    // The pairing lives in a map the stream owns, and a mapper test
    // cannot see whether the stream actually lends it one. This is the
    // test that fails if that wiring is dropped.
    const { runQuery } = fakeQuery([
      init(),
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test" } }]),
      assistant([{ type: "text", text: "still going" }]),
      toolResults([{ type: "tool_result", tool_use_id: "toolu_1", content: "2 passed" }]),
      result({ structured_output: { branch: "eo/EO-1", summary: "done", handoff: "Nothing to flag." } }),
    ]);

    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(events.map((event) => event.type)).toEqual(["thread_started", "tool_call", "output", "tool_result", "usage", "result"]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ name: "Bash", callId: "toolu_1", output: "2 passed" });
  });

  it("runs in the worktree and passes the agent's own instructions as the system prompt", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, cwd: "/tmp/worktrees/EO-42" }));

    expect(calls[0]?.options).toMatchObject({ cwd: "/tmp/worktrees/EO-42", systemPrompt: "You are the implementer." });
    expect(await promptText(calls[0]?.prompt)).toBe("EO-1: do the thing"); // the assembled context is the turn's first message
  });

  it("sends attachment metadata without eagerly reading image bytes or exposing a path", async () => {
    const { runQuery, calls } = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({
      ...startOpts,
      model: "claude-conversation",
      reasoningEffort: "high",
      attachments: [{ id: "attachment-1", kind: "image", name: "screen.png", mimeType: "image/png", size: 120, origin: "eo", synchronizationState: "local" }],
    }));

    expect(calls[0]?.options).toMatchObject({ model: "claude-conversation", effort: "high" });
    // Read once: the prompt is a stream, and asking it twice asks a
    // stream that has already given up its first message.
    const sent = await promptText(calls[0]?.prompt);
    expect(sent).toContain("ID: attachment-1; name: screen.png; MIME type: image/png; size: 120 bytes");
    expect(sent).toContain("use attachment_read for content");
  });

  it("requests structured output through the SDK rather than parsing prose (§5.3)", async () => {
    const { runQuery, calls } = fakeQuery([init()]);
    const schema = { type: "object", properties: { verdict: { type: "string" } } };

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, outputSchema: schema }));

    expect(calls[0]?.options).toMatchObject({ outputFormat: { type: "json_schema", schema } });
  });

  it("passes a real A-02 schema in a form the CLI accepts", async () => {
    // Uses outputSchemaFor rather than a hand-written schema on purpose.
    // The first cut of this test invented its own tiny schema, which had
    // no `$schema` key — so it passed while every real run died with
    // `--json-schema is not a valid JSON Schema`, because everything
    // z.toJSONSchema emits carries the 2020-12 dialect URL and the CLI
    // cannot resolve it.
    const { runQuery, calls } = fakeQuery([init()]);
    const real = outputSchemaFor(developerRegistry(), "implement")!;
    expect(real["$schema"]).toBeDefined(); // guards the premise: if Zod stops emitting it, this test is moot

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, outputSchema: real }));

    const passed = (calls[0]?.options as { outputFormat: { schema: Record<string, unknown> } }).outputFormat.schema;
    expect(passed).not.toHaveProperty("$schema");
    expect(passed).toMatchObject({ type: "object", properties: real["properties"] as object }); // nothing else lost
  });

  it("leaves a schema without a dialect declaration alone", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(stripSchemaDialect(schema)).toBe(schema);
  });

  it("runs unattended by default, because nobody is there to approve a tool call", async () => {
    // Found live: under the CLI's default mode every Write, Edit and
    // Bash call is denied and the agent escalates saying it cannot
    // write anything. The worktree is disposable and G-02 checks the
    // result, so the permission prompt buys nothing here.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(calls[0]?.options).toMatchObject({ permissionMode: "bypassPermissions" });
  });

  /**
   * The guarantee lives at the spawn site, not in the editor (EO-178).
   *
   * `agents.config` is an open bag: the editor writes it, MCP
   * `agent_save` writes it, and anyone holding the SQLite file writes
   * it. Removing the dropdown is presentation — this is the assertion
   * that a key which arrives anyway, from an older EO's config or from
   * somebody's edit, changes nothing about the process that starts.
   *
   * `as never` because `ClaudeAgentConfig` no longer declares the key.
   * That is the point of the cast rather than a way around it: the test
   * has to be able to write what the type forbids, because SQLite can.
   */
  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
    "spawns on bypass whatever config says (%s)",
    async (stored) => {
      const { runQuery, calls } = fakeQuery([init()]);

      await collect(
        createClaudeProvider({ runQuery, enableCommentTool: false, config: { permissionMode: stored } as never }).start(startOpts),
      );

      expect(calls[0]?.options).toMatchObject({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      });
    },
  );

  /**
   * EO-120: the two halves of the bypass travel together.
   *
   * `allowDangerouslySkipPermissions` is what the SDK's declaration asks
   * for beside `permissionMode: "bypassPermissions"`, and 0.3.251 does
   * not enforce it — established from sdk.mjs and a live run, and
   * recorded at the call site. Nothing would fail today if a later edit
   * dropped one and kept the other, which is exactly why the pairing is
   * asserted here rather than left to the comment.
   */
  it("declares the bypass to the SDK, not only the mode", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(calls[0]?.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });

  it("applies per-agent config", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        enableCommentTool: false,
        config: { model: "claude-opus-5" },
      }).start(startOpts),
    );

    expect(calls[0]?.options).toMatchObject({ model: "claude-opus-5" });
  });

  /**
   * Max turns is gone from both backends (EO-375), and a stored config
   * that still carries it is ignored rather than migrated — the same
   * treatment as a stale `permissionMode` above. `as never` for the same
   * reason: the type no longer declares the key, and SQLite can still
   * hold it.
   */
  it("dispatches without maxTurns even when the stored config carries it", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false, config: { model: "claude-opus-5", maxTurns: 12 } as never }).start(startOpts),
    );

    expect(calls[0]?.options).toMatchObject({ model: "claude-opus-5" });
    expect(calls[0]?.options).not.toHaveProperty("maxTurns");
  });

  it("launches the shared EO stdio service with comment enabled when asked", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({
      runQuery,
      enableCommentTool: true,
      eoMcp: { serverPath: "/app/eoServer.mjs", dbPath: "/data/eo.db" },
    }).start(startOpts));

    expect(calls[0]?.options).toHaveProperty("mcpServers");
    expect(Object.keys((calls[0]?.options as { mcpServers: Record<string, unknown> }).mcpServers)).toEqual(["eo"]);
    expect((calls[0]?.options as { mcpServers: Record<string, unknown> }).mcpServers["eo"]).toMatchObject({
      type: "stdio",
      command: process.execPath,
      args: ["/app/eoServer.mjs"],
      env: { ELECTRON_RUN_AS_NODE: "1", EO_MCP_DB_PATH: "/data/eo.db", EO_MCP_COMMENT_ENABLED: "1" },
    });
  });

  /**
   * Repository intelligence, as this adapter delivers it (EO-151).
   *
   * The `eo` case above is the template and this is deliberately
   * asserted the same way: what reaches `options.mcpServers`, under
   * which key, with which argv. What is *in* that argv — `serve --mcp
   * --path <checkout> --no-watch` — is the provider's business and is
   * asserted where the provider is, behind the port. This adapter is
   * asserted not to touch it, which is the property that lets the
   * implementation change without a provider file moving.
   */
  it("registers the repository query server beside EO's own, verbatim", async () => {
    const { runQuery, calls } = fakeQuery([init()]);
    const repositoryMcp = {
      name: "repo",
      command: "/opt/eo/index-tool",
      args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
      env: {},
    };

    await collect(createClaudeProvider({
      runQuery,
      enableCommentTool: true,
      eoMcp: { serverPath: "/app/eoServer.mjs", dbPath: "/data/eo.db" },
    }).start({ ...startOpts, repositoryMcp }));

    const servers = (calls[0]?.options as { mcpServers: Record<string, unknown> }).mcpServers;
    // Both, and only both: an attached server reaches this backend
    // through the generated directory, never through here.
    expect(Object.keys(servers).sort()).toEqual(["eo", "repo"]);
    expect(servers["repo"]).toEqual({
      type: "stdio",
      command: "/opt/eo/index-tool",
      // Passed through unedited. The adapter adds Claude's `type` and
      // the tool-search exemption below, and nothing else — no flag
      // invented here, none dropped.
      args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
      alwaysLoad: true,
    });
    // `--no-watch` is load-bearing rather than incidental: without it
    // the server runs a debounced file watcher that writes to the index
    // on every save, racing EO's own deterministic syncs.
    expect((servers["repo"] as { args: string[] }).args).toContain("--no-watch");
    // Empty env omitted rather than sent: an adapter that serialised
    // `env: {}` would be declaring an environment where there was none.
    expect(servers["repo"]).not.toHaveProperty("env");
  });

  /**
   * EO's own tools are in the prompt, not behind `ToolSearch` (EO-161).
   *
   * Comments are the only channel EO has (invariant #4) and the index is
   * the only thing that offers navigation as an alternative to grepping,
   * and both arrived deferred: a name in a system-reminder and a round-trip
   * before first use, competing against `Bash`, which is always loaded
   * and always works. `alwaysLoad` is the SDK's own per-server exemption
   * from that, and the constant it is set from carries the evidence.
   *
   * Asserted per server rather than over the map as a whole, because the
   * two are registered by separate branches and one of them is
   * conditional — the failure this guards against is the index arriving
   * exempt and the comment tools not, or the reverse.
   *
   * What the option *does* is a property of the binary and cannot be
   * established here; `toolLoading.live.test.ts` reads it off the
   * request the real CLI builds.
   */
  it("exempts both of EO's own servers from tool search, so their tools arrive loaded", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        enableCommentTool: true,
        eoMcp: { serverPath: "/app/eoServer.mjs" },
      }).start({
        ...startOpts,
        repositoryMcp: { name: "repo", command: "/opt/eo/index-tool", args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"], env: {} },
      }),
    );

    const servers = (calls[0]?.options as { mcpServers: Record<string, { alwaysLoad?: boolean }> }).mcpServers;
    expect(servers["eo"]?.alwaysLoad, "the only communication channel EO has").toBe(true);
    expect(servers["repo"]?.alwaysLoad, "the index nothing has ever queried").toBe(true);
  });

  /**
   * An allowlisted agent is permitted to call the index it was given
   * (EO-151).
   *
   * The sharpest version of a bug this file already documents for
   * attached servers: `allowedTools` is a closed list, so an agent that
   * carries one and is handed a server nobody added to it gets the
   * server *configured* and every call to it refused. The tools are
   * advertised, the connection comes up, and the agent is told no — the
   * loudest possible way to give somebody nothing.
   *
   * Not load-bearing under EO's pinned `bypassPermissions` (EO-178),
   * which no per-agent config can loosen or tighten any more. Kept
   * because the allowlist is what the CLI is *told* this agent may call,
   * and handing it a server its list does not name would be wrong the
   * day the CLI starts enforcing one.
   */
  it("grants an allowlisted agent the query server it was handed", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        eoMcp: { serverPath: "/app/eoServer.mjs" },
        config: { allowedTools: ["Read", "Grep"] },
      }).start({
        ...startOpts,
        repositoryMcp: { name: "repo", command: "/opt/eo/index-tool", args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"], env: {} },
      }),
    );

    // A bare `mcp__<server>` is Claude Code's grant of that whole
    // server, which is the same spelling an attached server's grant uses.
    expect(calls[0]?.options["allowedTools"]).toEqual(["Read", "Grep", "mcp__repo"]);
  });

  it("grants an allowlisted agent memory_read on a turn it serves it, and not otherwise (EO-478)", async () => {
    const served = fakeQuery([init()]);
    await collect(
      createClaudeProvider({ runQuery: served.runQuery, eoMcp: { serverPath: "/app/eoServer.mjs" }, config: { allowedTools: ["Read"] } }).start({
        ...startOpts,
        memoryScopes: [{ kind: "project", id: "project-p", name: "Payments" }],
      }),
    );
    expect(served.calls[0]?.options["allowedTools"]).toEqual(["Read", "mcp__eo__memory_read"]);

    const notServed = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery: notServed.runQuery, eoMcp: { serverPath: "/app/eoServer.mjs" }, config: { allowedTools: ["Read"] } }).start(startOpts));
    expect(notServed.calls[0]?.options["allowedTools"] ?? []).not.toContain("mcp__eo__memory_read");
  });

  it("adds nothing to an agent that has no allowlist", async () => {
    // An agent with no allowlist is one the CLI permits everything
    // advertised to. Writing one here would be a restriction nobody
    // asked for — the grant only ever widens a list that already exists.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, eoMcp: { serverPath: "/app/eoServer.mjs" } }).start({
        ...startOpts,
        repositoryMcp: { name: "repo", command: "/opt/eo/index-tool", args: [], env: {} },
      }),
    );

    expect(calls[0]?.options).not.toHaveProperty("allowedTools");
  });

  it("does not repeat a grant an agent's allowlist already names", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, config: { allowedTools: ["Read", "mcp__repo"] } }).start({
        ...startOpts,
        repositoryMcp: { name: "repo", command: "/opt/eo/index-tool", args: [], env: {} },
      }),
    );

    expect(calls[0]?.options["allowedTools"]).toEqual(["Read", "mcp__repo"]);
  });

  it("still ends up with `eo` when something else claims that name", async () => {
    // The catalogue refuses both reserved names at save time and this is
    // the second answer to the same question: whatever reaches a
    // dispatch, the service every agent talks to EO through is written
    // last and cannot be displaced.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({
      runQuery,
      eoMcp: { serverPath: "/app/eoServer.mjs" },
    }).start({ ...startOpts, repositoryMcp: { name: "eo", command: "/tmp/not-eo", args: [], env: {} } }));

    const servers = (calls[0]?.options as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers)).toEqual(["eo"]);
    expect(servers["eo"]).toMatchObject({ command: process.execPath, args: ["/app/eoServer.mjs"] });
  });

  it("gives the server to a resumed turn too, because resuming spawns the CLI again", async () => {
    // A session keeps what it was told, not what it was pointed at: the
    // CLI this resume launches starts the servers *this* invocation
    // declares. The same reason `toolDirectory` is re-stated on a
    // resume (EO-107).
    const { runQuery, calls } = fakeQuery([assistant([{ type: "text", text: "continuing" }])]);
    const repositoryMcp = { name: "repo", command: "/opt/eo/index-tool", args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"], env: {} };

    await collect(
      createClaudeProvider({ runQuery, eoMcp: { serverPath: "/app/eoServer.mjs" } }).resume("sess_persisted", "carry on", {
        cwd: "/tmp/wt",
        repositoryMcp,
      }),
    );

    const servers = (calls[0]?.options as { mcpServers: Record<string, unknown> }).mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["eo", "repo"]);
  });

  /**
   * The server's life is the query's life, which is what "no orphan
   * survives" rests on (EO-151).
   *
   * EO never spawns this process. It names it in the options the SDK
   * launches the CLI with, and the CLI is what starts it — so ending the
   * CLI ends the server, and the thing that ends the CLI is the abort
   * controller in this same object. This asserts the two are one object:
   * a cancelled or timed-out run aborts the controller that governs the
   * very query the server was declared inside.
   *
   * What it does not and cannot assert is that the CLI reaps its own
   * children, which is upstream behaviour EO does not own. What EO owns
   * is not holding a second handle to the process — and it holds none,
   * because it never opened one.
   */
  it("declares the server inside the query its own cancel ends", async () => {
    const { runQuery, calls } = fakeQuery([init()]);
    const controller = new AbortController();

    await collect(
      createClaudeProvider({ runQuery, eoMcp: { serverPath: "/app/eoServer.mjs" } }).start({
        ...startOpts,
        signal: controller.signal,
        repositoryMcp: { name: "repo", command: "/opt/eo/index-tool", args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"], env: {} },
      }),
    );

    const options = calls[0]?.options as { mcpServers: Record<string, unknown>; abortController: AbortController };
    expect(options.mcpServers).toHaveProperty("repo");
    expect(options.abortController.signal.aborted).toBe(false);

    controller.abort();

    expect(options.abortController.signal.aborted).toBe(true);
  });

  it("does not offer it by default — asking is a result now (KAN-29 slice 3)", async () => {
    // Not tidiness. Two live intake runs on the same feature asked in
    // two different ways: one returned separate questions with their
    // own `why` and options, the other posted a single prose escalation
    // through the tool. Offering both mechanisms is what made that a
    // coin flip.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery }).start(startOpts));

    expect(calls[0]?.options).not.toHaveProperty("mcpServers");
  });

  it("resumes an existing session in the worktree it started in", async () => {
    const { runQuery, calls } = fakeQuery([assistant([{ type: "text", text: "continuing" }])]);
    const controller = new AbortController();

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_persisted", "the human replied", {
        cwd: "/tmp/worktrees/EO-42",
        signal: controller.signal,
      }),
    );

    expect(calls[0]?.options).toMatchObject({ resume: "sess_persisted", cwd: "/tmp/worktrees/EO-42" });
    expect(await promptText(calls[0]?.prompt)).toBe("the human replied");
    const passed = (calls[0]?.options as { abortController?: AbortController }).abortController;
    expect(passed?.signal.aborted).toBe(false);
    controller.abort();
    expect(passed?.signal.aborted).toBe(true);
  });

  it("re-states the output schema on a resumed turn", async () => {
    const { runQuery, calls } = fakeQuery([result({ structured_output: { verdict: "approve" } })]);
    const schema = { type: "object", properties: { verdict: { type: "string" } } };

    // A-02 resumes to correct a result that failed validation. Drop the
    // schema and the SDK returns prose, so `structured_output` is absent
    // and the corrective turn fails the same validation again.
    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess", "fix it", { outputSchema: schema }));

    expect(calls[0]?.options).toMatchObject({ outputFormat: { type: "json_schema", schema } });
    expect(events.at(-1)).toEqual({ type: "result", data: { verdict: "approve" } });
  });

  it("recognises the SDK's status messages instead of reporting each as unmapped", async () => {
    const onUnmappedMessage = vi.fn();
    // Seen live: a real run emits rate_limit_event, which the first cut
    // of the mapper logged as unknown on every single turn.
    const chatter = ["rate_limit_event", "tool_progress", "tool_use_summary", "auth_status", "prompt_suggestion", "conversation_reset"];
    const { runQuery } = fakeQuery(chatter.map((type) => ({ type }) as unknown as SDKMessage));

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, onUnmappedMessage }).start(startOpts));

    expect(onUnmappedMessage).not.toHaveBeenCalled();
  });

  it("bridges the supervisor's abort signal onto the SDK's controller", async () => {
    const { runQuery, calls } = fakeQuery([init()]);
    const controller = new AbortController();

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, signal: controller.signal }));

    const passed = (calls[0]?.options as { abortController?: AbortController }).abortController;
    expect(passed).toBeInstanceOf(AbortController);
    expect(passed?.signal.aborted).toBe(false);
    controller.abort();
    expect(passed?.signal.aborted).toBe(true); // cancelling the run reaches the SDK
  });

  it("reports an unmapped message rather than dropping it", async () => {
    const onUnmappedMessage = vi.fn();
    const { runQuery } = fakeQuery([init(), { type: "brand_new" } as unknown as SDKMessage]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, onUnmappedMessage }).start(startOpts));

    expect(onUnmappedMessage).toHaveBeenCalledWith({ type: "brand_new" });
  });

  // EO-93. Sessions live under ~/.claude, which EO does not own: they can
  // be cleaned up, and then a thread id EO stored points at nothing.
  describe("a session the CLI cannot find", () => {
    it("is translated into the one error the supervisor recognises", async () => {
      // The shape it really arrives in: the CLI writes the line to
      // stderr and exits non-zero, and the SDK wraps that in its own
      // message. Nobody above the provider should have to know that.
      const { runQuery } = throwingQuery(
        new Error("Claude Code process exited with code 1\nstderr: No conversation found with session ID: sess_gone"),
      );

      const thrown = await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_gone", "carry on", { cwd: "/tmp/worktrees/EO-42" }));

      expect(isThreadNotFound(thrown)).toBe(true);
      expect((thrown as ThreadNotFoundError).threadId).toBe("sess_gone");
      expect((thrown as ThreadNotFoundError).provider).toBe("claude");
      expect((thrown as ThreadNotFoundError).cause).toBeInstanceOf(Error); // what the backend actually said, kept
    });

    // EO-493. EO spawns the CLI itself now, through the SDK's
    // `spawnClaudeCodeProcess`, and an SDK handed a custom spawn has no
    // stderr to append to its "exited with code 1". The adapter puts it
    // back, or a lost session would be read as any other failure.
    it("is still recognised when EO spawned the CLI, from what the CLI wrote to stderr", async () => {
      const runQuery = ((params: { options?: Options }) =>
        (async function* () {
          const spawned = params.options!.spawnClaudeCodeProcess!({
            command: process.execPath,
            args: ["-e", 'process.stderr.write("No conversation found with session ID: sess_gone\\n"); process.exit(1);'],
            env: { ...process.env },
            signal: new AbortController().signal,
          });
          // As the SDK does: the exit is the error, worded as it words it.
          const code = await new Promise<number | null>((resolve) => spawned.once("exit", (exitCode) => resolve(exitCode)));
          if (code !== 0) throw new Error(`Claude Code process exited with code ${code}`);
          yield init();
        })()) as never;

      const thrown = await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_gone", "carry on", { cwd: "/tmp/worktrees/EO-42" }));

      expect(isThreadNotFound(thrown)).toBe(true);
      expect((thrown as ThreadNotFoundError).threadId).toBe("sess_gone");
    });

    it("is recognised behind a wrapper, since the SDK reports failures by wrapping them", async () => {
      const { runQuery } = throwingQuery(
        new Error("the resumed turn failed", { cause: new Error("No conversation found with session ID: sess_gone") }),
      );

      expect(isThreadNotFound(await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_gone", "carry on")))).toBe(true);
    });

    // EO-492. Translating the error must not cost the turn its ending:
    // the wrapper passes `return()` on, so a resumed turn the supervisor
    // stops reading closes its input and finishes like a fresh one.
    it("passes on the consumer walking away, so the resumed turn's input is closed", async () => {
      const { runQuery, calls } = fakeQuery([init(), assistant([{ type: "text", text: "Working on it." }]), result()]);
      const onEnd = vi.fn();
      const provider = createClaudeProvider({ runQuery, enableCommentTool: false, admin: () => ({ server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: "turn-bearer" }, release: onEnd }) });

      const iterator = provider.resume("sess_1", "carry on")[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.(undefined);

      // What the CLI reads from stdin: the one message, and then the end
      // of the stream — not a pipe left open waiting for another.
      const input = (calls[0]?.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      expect((await input.next()).done).toBe(false);
      const open = Symbol("still open");
      const after = await Promise.race([input.next(), new Promise<typeof open>((resolve) => setTimeout(() => resolve(open), 50))]);
      expect(after).toEqual({ done: true, value: undefined });
      expect(onEnd).toHaveBeenCalledTimes(1); // `finish()` ran
    });

    it("is not what any other provider error becomes — that still fails the run as it always did", async () => {
      // The line this path must not cross. A resume that fails for any
      // other reason is a failed run, not a lost conversation, and
      // treating it as one would restart work that should have stopped.
      const boom = new Error("Claude Code process exited with code 1\nstderr: overloaded_error");
      const { runQuery } = throwingQuery(boom);

      expect(await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_live", "carry on"))).toBe(boom);
    });
  });
});


/**
 * The API key, spent at spawn (EO-84).
 *
 * Claude Code has no command that takes a key — it reads
 * `ANTHROPIC_API_KEY` from its environment — so a key someone typed into
 * EO is only worth anything if it reaches the child's environment. That
 * is the one thing this provider does with a secret, and it is
 * asserted here rather than trusted.
 */
/**
 * EO's administrative server's bearer, one per turn (EO-444).
 *
 * The CLI leaves without closing the session it opened on EO's admin
 * host, so the adapter lets the turn's bearer go when the turn is over —
 * and the host closes that session. `providerParity.test.ts` holds both
 * backends to the ordinary turn; these are the ways a Claude turn can end
 * that are not one.
 */
describe("the admin bearer", () => {
  function leasing() {
    const release = vi.fn();
    const admin = () => ({ server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: "turn-bearer" }, release });
    return { admin, release };
  }

  it("is let go of when a turn built by a steer is let go of unread, and nothing is spawned", async () => {
    const { admin, release } = leasing();
    const { runQuery, calls } = fakeQuery([init(), result()]);
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false, admin }).start(startOpts);

    await stream.steer?.("Before anybody read it.");
    await stream[Symbol.asyncIterator]().return?.(undefined);

    expect(release).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("is let go of when a turn is cancelled before it is built, and reading it after spawns nothing", async () => {
    const { admin, release } = leasing();
    const { runQuery, calls } = fakeQuery([init(), result()]);
    const controller = new AbortController();
    const stream = createClaudeProvider({ runQuery, enableCommentTool: false, admin }).start({ ...startOpts, signal: controller.signal });

    controller.abort();
    await stream.steer?.("After the cancel.");
    expect(release).toHaveBeenCalledTimes(1);

    expect(await collect(stream)).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is let go of when the turn fails", async () => {
    const { admin, release } = leasing();
    const { runQuery } = throwingQuery(new Error("the CLI died"));

    await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false, admin }).start(startOpts));

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is let go of when the query cannot even be opened", async () => {
    const { admin, release } = leasing();
    const runQuery = (() => {
      throw new Error("spawn ENOENT");
    }) as never;

    await captureThrow(createClaudeProvider({ runQuery, enableCommentTool: false, admin }).resume("sess_1", "carry on"));

    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is let go of when the consumer walks away after the result, as the supervisor does", async () => {
    const { admin, release } = leasing();
    const { runQuery } = fakeQuery([init(), result()]);

    for await (const event of createClaudeProvider({ runQuery, enableCommentTool: false, admin }).start(startOpts)) {
      if (event.type === "result") break;
    }

    expect(release).toHaveBeenCalledTimes(1);
  });

  // EO-492. A resumed turn is wrapped so a lost session can be told
  // apart (EO-93); the wrapper used to pull by hand and never pass on
  // `return()`, so a resumed turn the supervisor stopped reading kept its
  // bearer — one more lease on the admin host for every such turn.
  it("is let go of when the consumer walks away from a resumed turn after its first event", async () => {
    const out = new Set<string>();
    let minted = 0;
    const admin = () => {
      const token = `turn-bearer-${++minted}`;
      out.add(token);
      return { server: { url: "http://127.0.0.1:9/mcp", envName: "EO_ADMIN_TOKEN" }, environment: { EO_ADMIN_TOKEN: token }, release: () => out.delete(token) };
    };
    const { runQuery } = fakeQuery([init(), assistant([{ type: "text", text: "Working on it." }]), result()]);
    const before = out.size;

    const iterator = createClaudeProvider({ runQuery, enableCommentTool: false, admin }).resume("sess_1", "carry on")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "thread_started", threadId: "sess_1" });
    expect(out.size).toBe(before + 1); // held while the turn is being read
    await iterator.return?.(undefined);

    expect(minted).toBe(1);
    expect(out.size).toBe(before);
  });

  it("wins over an attached server declaring the same variable", async () => {
    const { admin } = leasing();
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, admin, attachmentEnv: () => ({ env: { EO_ADMIN_TOKEN: "a-value-a-person-typed", GITHUB_TOKEN: "ghp" } }) }).start(startOpts));

    expect(calls[0]?.options["env"]).toMatchObject({ EO_ADMIN_TOKEN: "turn-bearer", GITHUB_TOKEN: "ghp" });
  });
});

describe("an API key EO is holding", () => {
  it("reaches the spawned CLI as ANTHROPIC_API_KEY", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, apiKey: () => "sk-ant-test" }).start(startOpts));

    const env = calls[0]?.options["env"] as Record<string, string | undefined>;
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
    // The SDK documents that `env` REPLACES the subprocess environment
    // rather than merging with it, so a child given only the key would
    // lose PATH and HOME — and `claude` needs both.
    expect(env["PATH"]).toBe(process.env["PATH"]);
  });

  it("is spent on a resumed turn too", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, apiKey: () => "sk-ant-test" }).resume("sess_1", "carry on"));

    expect((calls[0]?.options["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
  });

  it("writes no ANTHROPIC_API_KEY when there is no key, leaving the person's own in place", async () => {
    // Writing the variable empty would *override* an ANTHROPIC_API_KEY
    // the person exported for themselves — a credential EO was never
    // asked to have an opinion about. (The environment itself is set on
    // every turn since EO-453, for CLAUDE_CODE_FORK_SUBAGENT; what this
    // holds is that the key in it is theirs and not EO's.)
    const before = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-the-persons-own";
    try {
      const { runQuery, calls } = fakeQuery([init()]);

      await collect(createClaudeProvider({ runQuery, enableCommentTool: false, apiKey: () => null }).start(startOpts));

      expect(childEnv(calls[0]?.options)["ANTHROPIC_API_KEY"]).toBe("sk-ant-the-persons-own");
    } finally {
      if (before === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = before;
    }
  });

  it("is read per turn, so removing it takes effect on the next dispatch", async () => {
    // The provider is cached for the life of the process. A key captured
    // at construction would go on being injected after somebody removed
    // it from the Runtimes card and was told the runtime was signed out.
    let stored: string | null = "sk-ant-first";
    const { runQuery, calls } = fakeQuery([init()]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, apiKey: () => stored });

    await collect(provider.start(startOpts));
    stored = null;
    await collect(provider.start(startOpts));

    expect((calls[0]?.options["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe("sk-ant-first");
    expect(childEnv(calls[1]?.options)["ANTHROPIC_API_KEY"]).toBe(process.env["ANTHROPIC_API_KEY"]);
  });
});

/**
 * The servers and skills an agent was given, and the ambient
 * configuration it is no longer given (EO-107).
 *
 * The directory itself is written by `agentAttachments/pluginDirectory.ts`
 * and pinned against a fixture there; these are about what the adapter
 * does with one — which flags it sets, and what it keeps off the command
 * line.
 */
describe("attachments", () => {
  const SECRET_VALUE = "ghp_liveSecretValue_0000";
  let scratch: string;
  let toolDirectory: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "eo claude attachments "));
    toolDirectory = join(scratch, "plugin");
    writeToolDirectory(toolDirectory, {
      servers: [
        {
          id: "s1",
          name: "github",
          description: "",
          config: { transport: "stdio", command: "gh-mcp", args: [] },
          envNames: ["GITHUB_TOKEN"],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
          connector: null,
        },
      ],
      skills: [
        {
          id: "k1",
          slug: "pr-review",
          name: "PR review",
          description: "How this house reviews a pull request.",
          body: "Read the whole diff.",
          files: [],
          disableModelInvocation: false,
          enabled: true,
          scope: { kind: "global" },
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        },
      ],
    });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Everything the adapter built except the environment — which is to say, everything that reaches argv. */
  function withoutEnv(options: Record<string, unknown>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(options).filter(([key]) => key !== "env")));
  }

  /**
   * A path as it is spelled *inside* `withoutEnv`'s JSON.
   *
   * On Windows a path separator is a backslash, and JSON escapes it — so
   * the raw path is not a substring of the serialised options even when
   * the options carry exactly that path. Searching for the escaped
   * spelling asks the question the assertion means on every platform.
   */
  function asJsonText(path: string): string {
    return JSON.stringify(path).slice(1, -1);
  }

  it("names the directory and its server file by path, and puts neither in argv as configuration", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false, eoMcp: { serverPath: "/unused/eoServer.mjs" } })
      .start({ ...startOpts, toolDirectory }));

    // `--plugin-dir <dir>` for the skills, with `skipMcpDiscovery` so the
    // loader does not also go looking for the servers.
    expect(calls[0]?.options["plugins"]).toEqual([{ type: "local", path: toolDirectory, skipMcpDiscovery: true }]);
    // `--mcp-config <file>` for the servers. A path, because the
    // alternative — `mcpServers` — is serialised as the whole
    // configuration inline, and `--strict-mcp-config` will not read the
    // plugin's own copy.
    expect(calls[0]?.options["extraArgs"]).toEqual({ "mcp-config": join(toolDirectory, ".mcp.json") });
    // EO's own service is the only thing that goes inline, as it always
    // did. An attached server never does.
    expect(Object.keys(calls[0]?.options["mcpServers"] as object)).toEqual(["eo"]);
    expect(withoutEnv(calls[0]?.options ?? {})).not.toContain("gh-mcp");
  });

  /**
   * The tool-search exemption stops at EO's own servers (EO-161).
   *
   * EO-161 privileges `eo` and `repo` because they are EO's: one is the
   * only channel it has and the other is an index it builds. A server a
   * person attached from the catalogue has neither argument behind it,
   * there may be many, and putting all of their schemas in every turn-1
   * prompt would spend somebody else's context on EO's decision.
   *
   * Asserted at both ends of the only route an attached server takes:
   * the file the CLI is pointed at, which is where an exemption would
   * have to be written, and the inline map, which is where it is written
   * for EO's own. Neither mentions it. A regression here is silent —
   * every test above would still pass — which is why this is checked as
   * text rather than as a shape: a key added under a nested transport
   * would slip past a field-by-field assertion.
   */
  it("leaves a server a person attached deferred, wherever it was written", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false, eoMcp: { serverPath: "/unused/eoServer.mjs" } })
        .start({ ...startOpts, toolDirectory }),
    );

    expect(readFileSync(join(toolDirectory, ".mcp.json"), "utf8")).not.toContain("alwaysLoad");
    // And it never reaches the inline map, which is the only place EO
    // writes the exemption at all.
    expect(Object.keys(calls[0]?.options["mcpServers"] as object)).toEqual(["eo"]);
  });

  it("names no server file for a directory that holds only skills", async () => {
    const skillsOnly = join(scratch, "skills-only");
    writeToolDirectory(skillsOnly, {
      servers: [],
      skills: [
        {
          id: "k1",
          slug: "pr-review",
          name: "PR review",
          description: "How this house reviews a pull request.",
          body: "Read the whole diff.",
          files: [],
          disableModelInvocation: false,
          enabled: true,
          scope: { kind: "global" },
          createdAt: 1,
          updatedAt: 1,
          archivedAt: null,
        },
      ],
    });
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, toolDirectory: skillsOnly }));

    // Pointing the CLI at a file that is not there is a startup error,
    // not an empty list.
    expect(calls[0]?.options["extraArgs"]).toBeUndefined();
    expect(calls[0]?.options["skills"]).toEqual(["eo-attachments:pr-review"]);
  });

  it("names the skills it delivered, because omitting the option is not the same as off", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, toolDirectory }));

    // Plugin-qualified, which is the spelling the CLI offers a
    // plugin-delivered skill under.
    expect(calls[0]?.options["skills"]).toEqual(["eo-attachments:pr-review"]);
  });

  it("names each skill it offers in the prompt of the turn that opens the thread, and in no resumed turn (EO-602)", async () => {
    const started = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery: started.runQuery, enableCommentTool: false }).start({ ...startOpts, toolDirectory }));
    const sent = await promptText(started.calls[0]?.prompt);
    // After the context, by the name the Skill tool takes.
    expect(sent.startsWith(`${startOpts.context}\n\n## Skills\n`)).toBe(true);
    expect(sent).toContain("- `eo-attachments:pr-review` — How this house reviews a pull request.");
    expect(sent).toContain("invoke it with the Skill tool");

    // The thread already holds it.
    const resumed = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery: resumed.runQuery, enableCommentTool: false }).resume("sess-1", "carry on", { cwd: "/tmp/wt", toolDirectory }));
    expect(await promptText(resumed.calls[0]?.prompt)).toBe("carry on");
  });

  it("names only the skills EO attached on the person's own setup, and none without a directory", async () => {
    // `skills: "all"` offers the person's own too; the prompt names what EO put in the directory.
    const ambient = fakeQuery([init()]);
    await collect(
      createClaudeProvider({ runQuery: ambient.runQuery, enableCommentTool: false, config: { inheritAmbientConfig: true } }).start({ ...startOpts, toolDirectory }),
    );
    expect([...(await promptText(ambient.calls[0]?.prompt)).matchAll(/^- `([^`]+)` — /gm)].map((match) => match[1])).toEqual(["eo-attachments:pr-review"]);

    const bare = fakeQuery([init()]);
    await collect(createClaudeProvider({ runQuery: bare.runQuery, enableCommentTool: false }).start(startOpts));
    expect(await promptText(bare.calls[0]?.prompt)).toBe(startOpts.context);
  });

  it("hands a secret to the process's environment and to nothing that could be read out of argv", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        enableCommentTool: false,
        attachmentEnv: () => ({ env: { GITHUB_TOKEN: SECRET_VALUE } }),
      }).start({ ...startOpts, toolDirectory }),
    );

    const env = calls[0]?.options["env"] as Record<string, string>;
    expect(env["GITHUB_TOKEN"]).toBe(SECRET_VALUE);
    // Spread over `process.env`, never replacing it: the SDK documents
    // that `env` replaces the subprocess environment entirely, and a
    // child given one variable loses PATH and HOME.
    expect(env["PATH"]).toBe(process.env["PATH"]);
    // Neither the value nor the name is in the arguments: what is there
    // is the path to the file that holds the name. A secret must not be
    // readable out of `/proc/<pid>/cmdline`, and here nothing about the
    // server is.
    expect(withoutEnv(calls[0]?.options ?? {})).not.toContain(SECRET_VALUE);
    expect(withoutEnv(calls[0]?.options ?? {})).toContain(asJsonText(join(toolDirectory, ".mcp.json")));
    expect(await promptText(calls[0]?.prompt)).not.toContain(SECRET_VALUE);
    // And the file the CLI reads carries the name, not the value.
    expect(readFileSync(join(toolDirectory, ".mcp.json"), "utf8")).toContain("${GITHUB_TOKEN}");
    expect(readFileSync(join(toolDirectory, ".mcp.json"), "utf8")).not.toContain(SECRET_VALUE);
  });

  it("does not let an attached server's variable displace the credential EO signs the run in with", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        enableCommentTool: false,
        apiKey: () => "sk-ant-eo",
        attachmentEnv: () => ({ env: { ANTHROPIC_API_KEY: "sk-ant-somebody-elses" } }),
      }).start({ ...startOpts, toolDirectory }),
    );

    expect((calls[0]?.options["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBe("sk-ant-eo");
  });

  it("reads the values per turn, so clearing one takes effect on the next dispatch", async () => {
    let stored: Record<string, string> = { GITHUB_TOKEN: SECRET_VALUE };
    const { runQuery, calls } = fakeQuery([init()]);
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false, attachmentEnv: () => ({ env: stored }) });

    await collect(provider.start({ ...startOpts, toolDirectory }));
    stored = {};
    await collect(provider.start({ ...startOpts, toolDirectory }));

    expect((calls[0]?.options["env"] as Record<string, string>)["GITHUB_TOKEN"]).toBe(SECRET_VALUE);
    expect(childEnv(calls[1]?.options)["GITHUB_TOKEN"]).toBe(process.env["GITHUB_TOKEN"]);
  });

  /**
   * The attached servers' values are read for the turn's own environment
   * variables (EO-488): the reader is handed them, less EO's reserved
   * names, on a start and on a resume, so a declared name no secret
   * fills is filled from the step's variables rather than whatever the
   * provider saw first.
   */
  it("hands the reader each turn's own environment variables, less EO's reserved names", async () => {
    const seen: Record<string, string>[] = [];
    const { runQuery, calls } = fakeQuery([init()]);
    const provider = createClaudeProvider({
      runQuery,
      enableCommentTool: false,
      attachmentEnv: (variables) => {
        seen.push({ ...variables });
        return { env: variables["REGION"] === undefined ? {} : { REGION: variables["REGION"] } };
      },
    });

    await collect(provider.start({ ...startOpts, toolDirectory, environmentVariables: { REGION: "eu-west-1", PATH: "/from/a/variable" } }));
    await collect(provider.resume("sess_1", "carry on", { toolDirectory, environmentVariables: { REGION: "us-east-2" } }));

    expect(seen).toEqual([{ REGION: "eu-west-1" }, { REGION: "us-east-2" }]);
    expect(childEnv(calls[0]?.options)["REGION"]).toBe("eu-west-1");
    expect(childEnv(calls[1]?.options)["REGION"]).toBe("us-east-2");
  });

  it("takes a withheld name out of the run's variables and the inherited environment alike", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_from_the_persons_shell");
    try {
      const { runQuery, calls } = fakeQuery([init()]);

      await collect(
        createClaudeProvider({ runQuery, enableCommentTool: false, attachmentEnv: () => ({ env: {}, withheld: ["GITHUB_TOKEN"] }) }).start({
          ...startOpts,
          toolDirectory,
          environmentVariables: { GITHUB_TOKEN: "ghp_from_a_variable", REGION: "eu-west-1" },
        }),
      );

      const env = childEnv(calls[0]?.options);
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      // Only the withheld name: the rest of both layers is untouched.
      expect(env["REGION"]).toBe("eu-west-1");
      expect(env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("points a resumed turn at the same directory, because resuming spawns the CLI again", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess_1", "carry on", { toolDirectory }));

    expect(calls[0]?.options["plugins"]).toEqual([{ type: "local", path: toolDirectory, skipMcpDiscovery: true }]);
    expect(calls[0]?.options["skills"]).toEqual(["eo-attachments:pr-review"]);
    expect(calls[0]?.options["extraArgs"]).toEqual({ "mcp-config": join(toolDirectory, ".mcp.json") });
  });

  it("adds an agent's own servers to an allowlist it already has", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false, config: { allowedTools: ["Read", "mcp__eo__ticket_detail"] } })
        .start({ ...startOpts, toolDirectory }),
    );

    // `mcp__eo__item_detail` beside the spelling the config carries:
    // KAN-162 widened an allowlist so a grant of either name of an
    // aliased EO tool is a grant of both, which is what keeps an agent
    // whose list was written by a migration permitted to call the tool
    // its prompt now names.
    expect(calls[0]?.options["allowedTools"]).toEqual(["Read", "mcp__eo__ticket_detail", "mcp__eo__item_detail", "mcp__github"]);
  });

  it("grants them to an opted-out agent too, which is the other half of the same switch", async () => {
    // `inheritAmbientConfig` says what EO stops suppressing; it says
    // nothing about what EO was asked to deliver. An agent that ticked it
    // *and* carries an allowlist was handed a directory and an
    // `--mcp-config` naming servers it was then not permitted to call.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({
        runQuery,
        enableCommentTool: false,
        config: { inheritAmbientConfig: true, allowedTools: ["Read", "mcp__eo__ticket_detail"] },
      }).start({ ...startOpts, toolDirectory }),
    );

    expect(calls[0]?.options["allowedTools"]).toEqual(["Read", "mcp__eo__ticket_detail", "mcp__eo__item_detail", "mcp__github"]);
    // And the opt-out is still an opt-out: the three suppressions stay
    // lifted, so this cannot pass by having quietly re-locked the agent.
    expect(calls[0]?.options["settingSources"]).toBeUndefined();
    expect(calls[0]?.options["strictMcpConfig"]).toBeUndefined();
    expect(calls[0]?.options["skills"]).toBe("all");
  });

  it("leaves an agent with no allowlist alone — absent means everything advertised", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, toolDirectory }));

    expect(calls[0]?.options["allowedTools"]).toBeUndefined();
  });
});

/**
 * The ambient-configuration decision, as flags (EO-107).
 *
 * EO used to set none of these, so what an agent could reach depended on
 * the person's `~/.claude` and on the repository it was pointed at —
 * which made "this agent has these tools" untrue and any test asserting
 * it meaningless.
 */
describe("ambient configuration", () => {
  it("is off by default, and skills are named even when there are none", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    // The person's own sources are the ones suppressed: no
    // `~/.claude/settings.json`, no `settings.local.json`.
    expect(calls[0]?.options["settingSources"]).toEqual(["project"]);
    // And stated rather than omitted — the SDK is explicit that leaving
    // `skills` out is "not skills off", because the CLI's own defaults
    // still apply.
    expect(calls[0]?.options["skills"]).toEqual([]);
  });

  it("is restored whole by the per-agent opt-out", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false, config: { inheritAmbientConfig: true } }).start(startOpts),
    );

    // Nothing suppressed, and every skill the machine offers enabled:
    // somebody who ticks this is asking for their own setup, and half of
    // it would be worse than none.
    expect(calls[0]?.options["settingSources"]).toBeUndefined();
    expect(calls[0]?.options["skills"]).toBe("all");
  });

  it("keeps the repository's own source, because CLAUDE.md rides on it", async () => {
    // `[]` reads like the tighter, more obvious answer, and it silently
    // takes CLAUDE.md with it — the SDK requires `'project'` to load one,
    // and EO renders no substitute anywhere in the dispatch context. So
    // an agent would go on working in a repository whose stated rules it
    // could no longer see, which is the one file written to constrain
    // exactly these runs.
    //
    // Measured against the binary rather than inferred: with a marker in
    // `CLAUDE.md` and the outgoing request body captured, `[]` dropped it
    // and `["project"]` kept it, EO's own `systemPrompt` set and nothing
    // else varied. `buildOptions` carries the figures; this is what
    // notices somebody reaching for `[]` again.
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(calls[0]?.options["settingSources"]).toContain("project");
    // And the two it does not readmit, which is what makes this a
    // narrowing of what EO did before rather than a widening.
    expect(calls[0]?.options["settingSources"]).not.toContain("user");
    expect(calls[0]?.options["settingSources"]).not.toContain("local");
  });

  it("uses only the MCP servers EO handed over, and none the machine happens to have", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start(startOpts));

    expect(calls[0]?.options["strictMcpConfig"]).toBe(true);
  });

  it("gives the opt-out its own servers back along with everything else", async () => {
    const { runQuery, calls } = fakeQuery([init()]);

    await collect(
      createClaudeProvider({ runQuery, enableCommentTool: false, config: { inheritAmbientConfig: true } }).start(startOpts),
    );

    expect(calls[0]?.options["strictMcpConfig"]).toBeUndefined();
  });
});

/**
 * The interception, as this adapter delivers it (EO-165) — with whatever
 * judgement the caller supplied (KAN-126).
 *
 * What is asserted here is the delivery and nothing else: that a hook
 * reaches the SDK, that it hands the nudge what the nudge needs, that
 * it says what the nudge answered without deciding anything, and that
 * it is absent entirely on a run with no index or no nudge. Which
 * *commands* fire it is `repositoryIntelligence/broadSearch.test.ts`
 * — one classifier, one place it is pinned — and the shipped classifier
 * driven end to end through this adapter is
 * `repositoryIntelligence/claudeInterception.test.ts`, on the pack's
 * side of the arrow. Nothing here imports it.
 */
const withAnswers = {
  name: "repo",
  command: "/opt/eo/index-tool",
  args: ["serve", "--mcp", "--path", "/tmp/wt", "--no-watch"],
  env: {},
  answers: { symbol: "idx_symbol", area: "idx_area", reach: ["idx_callers"], files: "idx_files" },
  knows: async (question: { of: string; name?: string; pattern?: string }) => [
    { name: question.of === "symbol" ? (question.name ?? "") : "packages/engine/src/routing.ts", path: "packages/engine/src/routing.ts" },
  ],
};

/** A stand-in judgement: every call it is asked about is a broad search for `x`. */
const alwaysNudge: SearchNudge = async () => ({ kind: "symbol", needle: "x", nudge: "use the index" });

type Hooks = { PreToolUse?: { matcher?: string; hooks: ((input: unknown) => Promise<Record<string, unknown>>)[] }[] };

/** A `PreToolUse` payload shaped the way the CLI sends one. */
const preToolUse = (tool: string, input: unknown, callId = "toolu_1"): unknown => ({
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
  tool_use_id: callId,
  session_id: "sess_1",
  transcript_path: "/tmp/t.jsonl",
  cwd: "/tmp/wt",
});

describe("delivering a nudge the caller supplied", () => {
  /** The one hook EO registers, or a failure that says so rather than a type error. */
  function onlyHook(options: Record<string, unknown>): (input: unknown) => Promise<Record<string, unknown>> {
    const hooks = options["hooks"] as Hooks | undefined;
    const matcher = hooks?.PreToolUse?.[0];
    expect(matcher, "EO registered no PreToolUse hook").toBeDefined();
    // Bash is the one that matters — EO-162 was 176 shell calls — and
    // the tidier doors are covered too.
    expect(matcher?.matcher).toBe("Bash|Grep|Glob");
    expect(matcher?.hooks).toHaveLength(1);
    return matcher?.hooks[0] as (input: unknown) => Promise<Record<string, unknown>>;
  }

  async function optionsFor(searchNudge: SearchNudge | undefined, repositoryMcp: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const { runQuery, calls } = fakeQuery([init()]);
    await collect(
      createClaudeProvider({ runQuery, ...(searchNudge ? { searchNudge } : {}) }).start({ ...startOpts, ...(repositoryMcp ? { repositoryMcp } : {}) } as never),
    );
    return calls[0]?.options ?? {};
  }

  it("registers no hook when the caller supplied no nudge (KAN-126)", async () => {
    // The judgement is the caller's. An adapter constructed without one
    // — a test, a script, a composition root with no developer pack —
    // has nothing to say about a search and says nothing, in the same
    // shape as every other absence: no `hooks` option, not a hook that
    // stays quiet.
    expect(await optionsFor(undefined, withAnswers)).not.toHaveProperty("hooks");
  });

  it("registers no hook at all on a run with no index, whatever the nudge would have said", async () => {
    // Every reason arrives the same way — feature off, no repository, no
    // binary, a build that failed — because all of them mean the
    // supervisor hands this turn no server. A nudge with nothing to
    // qualify its answer against is not asked.
    expect(await optionsFor(alwaysNudge, undefined)).not.toHaveProperty("hooks");
  });

  it("registers no hook when the index offered no vocabulary, or no way of being asked (EO-173)", async () => {
    // A server with nothing to suggest is silent rather than
    // approximate, and vocabulary alone is not enough: a suggestion is
    // only worth making when EO has established the index can answer.
    expect(await optionsFor(alwaysNudge, { name: "repo", command: "/opt/eo/index-tool", args: [], env: {} })).not.toHaveProperty("hooks");
    const withoutAsking: Record<string, unknown> = { ...withAnswers };
    delete withoutAsking["knows"];
    expect(await optionsFor(alwaysNudge, withoutAsking)).not.toHaveProperty("hooks");
  });

  it("hands the nudge the call, the index's vocabulary, its own spelling of a tool id and the worktree", async () => {
    // What crosses the option, pinned: a pack's classifier gets the same
    // question the imported one did, so moving it changes nothing it
    // sees. `qualify` is the adapter's — the pack supplies bare names
    // and Claude's `mcp__<server>__` spelling is not its business.
    const asked: unknown[] = [];
    const hook = onlyHook(
      await optionsFor(async (request) => {
        asked.push({ ...request, qualified: request.qualify("idx_symbol"), holds: await request.knows({ of: "symbol", name: "x" }) });
        return { kind: "symbol", needle: "x", nudge: "use the index" };
      }, withAnswers),
    );

    const answer = await hook(preToolUse("Bash", { command: "grep -rn x ." }));

    expect(asked).toEqual([
      expect.objectContaining({
        tool: "Bash",
        input: { command: "grep -rn x ." },
        answers: withAnswers.answers,
        root: "/tmp/wt",
        qualified: "mcp__repo__idx_symbol",
        holds: [expect.objectContaining({ name: "x" })],
      }),
    ]);
    // And what it answered is what the model is told, verbatim — with
    // nothing that could stop the call. Blocking mode is deliberately
    // not built (EO-165), and this is where that would first show up.
    expect(answer).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "use the index" } });
  });

  it("says nothing when the nudge says nothing, and ignores an event that is not a tool call", async () => {
    // Null is the nudge's every way of saying "not this one", and the
    // adapter records nothing for it. The matcher is a filter, never the
    // decision — a CLI that reads the pattern differently changes what
    // the hook is offered, not what it says.
    const hook = onlyHook(await optionsFor(async () => null, withAnswers));

    expect(await hook(preToolUse("Bash", { command: "grep -rn x ." }))).toEqual({});
    expect(await hook({ hook_event_name: "SessionStart", session_id: "s", transcript_path: "/tmp/t", cwd: "/tmp/wt" })).toEqual({});
  });

  it("records the firing with what the nudge decided, joined to the call it fired on (EO-168)", async () => {
    // A fake CLI that announces a call, runs EO's hook before it, and
    // carries on — the order the real one uses. The event is composed
    // from the nudge's own answer, so the log and the model are told the
    // same thing.
    const runQuery = ((params: { options?: Record<string, unknown> }) => {
      const hook = (params.options?.["hooks"] as Hooks | undefined)?.PreToolUse?.[0]?.hooks[0];
      return (async function* () {
        yield init();
        yield assistant([{ type: "tool_use", id: "toolu_7", name: "Bash", input: { command: "grep -rn x ." } }]);
        if (hook) await hook(preToolUse("Bash", { command: "grep -rn x ." }, "toolu_7"));
        yield result();
      })();
    }) as never;

    const events = await collect(createClaudeProvider({ runQuery, searchNudge: alwaysNudge }).start({ ...startOpts, repositoryMcp: withAnswers } as never));

    expect(events.filter((event) => event.type === "search_interception")).toEqual([
      { type: "search_interception", tool: "Bash", callId: "toolu_7", kind: "symbol", needle: "x", suggestion: "use the index" },
    ]);
  });

  it("writes no configuration file to make any of this work", async () => {
    // The whole mechanism is an in-process callback. The alternative —
    // a `.claude/settings.json` in the worktree — also works and is
    // deliberately refused: that file is meant to be committed, so an
    // agent running `git add -A` would put EO's configuration on
    // somebody's default branch.
    const options = await optionsFor(alwaysNudge, withAnswers);
    const hooks = options["hooks"] as Hooks;
    expect(typeof hooks.PreToolUse?.[0]?.hooks[0]).toBe("function");
    // And the settings EO does read are still only the project's.
    expect(options["settingSources"]).toEqual(["project"]);
  });
});

/**
 * A turn that stays open, and keeps what was said into it (EO-176).
 *
 * The real SDK reads the prompt stream on a track of its own — writing
 * each message to the CLI's stdin as it arrives — while yielding the
 * CLI's messages back through the query. This does both, so a test can
 * assert on what EO actually put on the wire and when, rather than on
 * what it meant to.
 */
function liveQuery() {
  const sent: SDKUserMessage[] = [];
  let letGo!: () => void;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let announce!: () => void;
  const working = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let inputEnded = false;

  let pump: Promise<void> = Promise.resolve();
  const runQuery = ((params: { prompt: unknown }) => {
    pump = (async () => {
      for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) sent.push(message);
      inputEnded = true;
    })();
    return (async function* () {
      // Before the yield, not after it: a generator suspends *at* a
      // yield, so a line under one only runs when the consumer asks for
      // the next message — and a test waiting on it would wait forever.
      announce();
      yield init();
      await held;
      yield result();
    })();
  }) as never;

  return {
    runQuery,
    /** Every message EO wrote into the turn, in order. */
    sent,
    /** Resolves once the turn is under way, which is when saying something to it means anything. */
    working,
    finish: () => letGo(),
    /** True once EO let go of the CLI's stdin — which is what ends the session. */
    inputEnded: () => inputEnded,
    settled: () => pump,
  };
}

/** The words of a message EO put on the wire. */
function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join("");
}

describe("saying something into a turn that is running (EO-176)", () => {
  /**
   * A steered message's files (EO-395).
   *
   * The case that was asked for: a screenshot sent seconds after the
   * message it belonged to. Before this the steer carried the text
   * alone, so the agent was never told a file existed.
   */
  it("names each file that came with the message, and the tool that reads it", async () => {
    const live = liveQuery();
    const stream = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false }).start(startOpts);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await live.working;

    expect(
      await stream.steer!("This is what I meant.", [
        { id: "attachment-1", kind: "image", name: "screen.png", mimeType: "image/png", size: 8, origin: "eo", synchronizationState: "local" },
      ]),
    ).toBe(true);
    // And one with nothing typed under it is still a message, not an
    // empty string.
    expect(
      await stream.steer!("", [
        { id: "attachment-2", kind: "file", name: "trace.log", mimeType: "text/plain", size: 120, origin: "eo", synchronizationState: "local" },
      ]),
    ).toBe(true);

    live.finish();
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
    await live.settled();

    const [, withWords, filesOnly] = live.sent.map(textOf);
    expect(withWords).toMatch(/^This is what I meant\.\n\nAttachments \(metadata only; use attachment_read for content\):\n- ID: attachment-1; name: screen\.png; MIME type: image\/png;/);
    expect(filesOnly).toMatch(/^Attachments \(metadata only; use attachment_read for content\):\n- ID: attachment-2; name: trace\.log; MIME type: text\/plain;/);
    // Still folded into the running turn, as a message with no files is.
    expect(live.sent[1]).toMatchObject({ priority: "next", shouldQuery: false });
  });

  it("pushes the message into the open turn, marked so the CLI folds it into that turn", async () => {
    const live = liveQuery();
    const stream = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false }).start(startOpts);

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // the session is open and the agent has said something
    await live.working;

    expect(await stream.steer!("Stop rewriting the schema.")).toBe(true);

    live.finish();
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
    await live.settled();

    expect(live.sent.map(textOf)).toEqual(["EO-1: do the thing", "Stop rewriting the schema."]);
    // Marked so the CLI folds it into the turn that is running. Which
    // of the SDK's three priorities does that is not the one it sounds
    // like — `steeredMessage` carries the measurement, and
    // `steering.live.test.ts` is the measurement. The dispatch itself is
    // marked with neither: it *is* the turn.
    expect(live.sent[0]?.priority).toBeUndefined();
    expect(live.sent[0]?.shouldQuery).toBeUndefined();
    expect(live.sent[1]?.priority).toBe("next");
    // And asked about nothing on its own account, so a message that
    // misses its turn cannot open one EO is no longer reading.
    expect(live.sent[1]?.shouldQuery).toBe(false);
  });

  it("lets go of the input once the turn's result is in, so the session ends with the turn", async () => {
    // The other half of holding stdin open. With a string prompt the SDK
    // closed it on the first result by itself; now that EO owns the
    // stream, a run that walked away without closing would leave a CLI
    // process waiting for input nobody is going to send.
    const live = liveQuery();
    const stream = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false }).start(startOpts);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await live.working;
    expect(live.inputEnded()).toBe(false);

    live.finish();
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
    await live.settled();

    expect(live.inputEnded()).toBe(true);
  });

  it("refuses a message that arrives after the turn has ended, rather than starting a second one", async () => {
    // Not a failure, and the caller is expected to treat it as one:
    // `false` means the comment it already posted is what the next turn
    // reads. What must not happen is the message opening a second turn,
    // which would give one run two candidate results.
    const live = liveQuery();
    const provider = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false });
    const stream = provider.start(startOpts);

    live.finish();
    await collect(stream);
    await live.settled();

    expect(await stream.steer!("Too late.")).toBe(false);
    expect(live.sent.map(textOf)).toEqual(["EO-1: do the thing"]);
  });

  it("holds a message said before the SDK had finished loading, rather than dropping it", async () => {
    // `deferred` exists because `start` has to return a stream before
    // there is a query to control. A person who says something a second
    // after pressing Start is talking to a turn that exists; where the
    // SDK load had got to is EO's business, not theirs.
    const live = liveQuery();
    const stream = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false }).start(startOpts);

    expect(await stream.steer!("Read the ADR first.")).toBe(true);

    live.finish();
    await collect(stream);
    await live.settled();

    expect(live.sent.map(textOf)).toEqual(["EO-1: do the thing", "Read the ADR first."]);
  });

  it("carries the control through a resumed turn too, which is where a correction happens", async () => {
    const live = liveQuery();
    const stream = createClaudeProvider({ runQuery: live.runQuery, enableCommentTool: false }).resume("sess_persisted", "carry on", {
      cwd: "/tmp/worktrees/EO-42",
    });

    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await live.working;
    expect(await stream.steer!("Use the middleware.")).toBe(true);

    live.finish();
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
    }
    await live.settled();

    expect(live.sent.map(textOf)).toEqual(["carry on", "Use the middleware."]);
  });
});

describe("the words of a turn as they are generated", () => {
  const stream = (event: Record<string, unknown>, parent: string | null = null) =>
    ({ type: "stream_event", event, parent_tool_use_id: parent, uuid: "u", session_id: "s" }) as unknown as SDKMessage;
  const deltas = (messages: SDKMessage[]) => {
    const blocks = new Map();
    return messages.flatMap((message) => mapSdkMessage(message, new Map(), blocks).mapped);
  };

  it("passes on the answer's JSON as the structured-output tool writes it, and no other tool's input", () => {
    expect(
      deltas([
        stream({ type: "message_start", message: {} }),
        stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Bash", id: "t1", input: {} } }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
        stream({ type: "content_block_stop", index: 0 }),
        stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "StructuredOutput", id: "t2", input: {} } }),
        stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"outcome":{"message":"Hi' } }),
      ]),
    ).toEqual([{ type: "output_delta", stream: "text", text: '{"outcome":{"message":"Hi' }]);
  });

  it("does not pass on a subagent's words, which are its own conversation", () => {
    expect(
      deltas([
        stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "toolu_task"),
        stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "inner" } }, "toolu_task"),
      ]),
    ).toEqual([]);
  });

  it("forgets a message's blocks when the next message starts", () => {
    expect(
      deltas([
        stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        stream({ type: "message_start", message: {} }),
        stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "orphan" } }),
      ]),
    ).toEqual([]);
  });

  it("records summarised thinking as reasoning, and an omitted one as nothing", () => {
    const thinking = (text: string) => ({ type: "assistant", message: { content: [{ type: "thinking", thinking: text, signature: "s" }] }, session_id: "s" }) as unknown as SDKMessage;
    expect(mapSdkMessage(thinking("Weighing it.")).mapped).toEqual([{ type: "reasoning", text: "Weighing it." }]);
    expect(mapSdkMessage(thinking("")).mapped).toEqual([]);
  });

  it("keeps fork subagents off, as they were before 0.3.302 turned them on, unless the person set the switch themselves (EO-453)", async () => {
    const envFor = async () => {
      const calls: Record<string, unknown>[] = [];
      const runQuery = ((params: { options?: Record<string, unknown> }) => {
        calls.push(params.options ?? {});
        return (async function* () {})();
      }) as never;
      for await (const _ of createClaudeProvider({ runQuery, enableCommentTool: false }).start({ instructions: "i", context: "c", cwd: "/tmp" } as never)) void _;
      return childEnv(calls[0]);
    };
    const before = process.env["CLAUDE_CODE_FORK_SUBAGENT"];
    try {
      delete process.env["CLAUDE_CODE_FORK_SUBAGENT"];
      const held = await envFor();
      expect(held["CLAUDE_CODE_FORK_SUBAGENT"]).toBe("0");
      // Spread over the parent's environment, not instead of it.
      expect(held["PATH"]).toBe(process.env["PATH"]);

      process.env["CLAUDE_CODE_FORK_SUBAGENT"] = "1";
      expect((await envFor())["CLAUDE_CODE_FORK_SUBAGENT"]).toBe("1");
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CODE_FORK_SUBAGENT"];
      else process.env["CLAUDE_CODE_FORK_SUBAGENT"] = before;
    }
  });

  it("hands the CLI ENABLE_TOOL_SEARCH=false behind a gateway, whether the base URL is inherited or the run's own (EO-599)", async () => {
    const envFor = async (environmentVariables?: Record<string, string>) => {
      const calls: Record<string, unknown>[] = [];
      const runQuery = ((params: { options?: Record<string, unknown> }) => {
        calls.push(params.options ?? {});
        return (async function* () {})();
      }) as never;
      const start = { instructions: "i", context: "c", cwd: "/tmp", ...(environmentVariables ? { environmentVariables } : {}) };
      for await (const _ of createClaudeProvider({ runQuery, enableCommentTool: false, settingsReader: NO_SETTINGS }).start(start as never)) void _;
      return (calls[0]?.["env"] ?? {}) as Record<string, string | undefined>;
    };
    const saved = { base: process.env["ANTHROPIC_BASE_URL"], search: process.env["ENABLE_TOOL_SEARCH"] };
    try {
      delete process.env["ANTHROPIC_BASE_URL"];
      delete process.env["ENABLE_TOOL_SEARCH"];
      // Nothing set: the CLI's own default, untouched.
      expect((await envFor())["ENABLE_TOOL_SEARCH"]).toBeUndefined();
      // A run's own variable is in the environment the CLI is given (EO-487).
      expect((await envFor({ ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" }))["ENABLE_TOOL_SEARCH"]).toBe("false");

      process.env["ANTHROPIC_BASE_URL"] = "https://llm-gateway.example.com";
      expect((await envFor())["ENABLE_TOOL_SEARCH"]).toBe("false");
      process.env["ENABLE_TOOL_SEARCH"] = "true";
      expect((await envFor())["ENABLE_TOOL_SEARCH"]).toBe("true");
    } finally {
      if (saved.base === undefined) delete process.env["ANTHROPIC_BASE_URL"];
      else process.env["ANTHROPIC_BASE_URL"] = saved.base;
      if (saved.search === undefined) delete process.env["ENABLE_TOOL_SEARCH"];
      else process.env["ENABLE_TOOL_SEARCH"] = saved.search;
    }
  });

  /**
   * EO-599: the holds are decided on what the CLI will see, which is the
   * spawn environment with the settings files the turn loads laid over it
   * — so a base URL only a settings file names counts, and which files
   * those are follows the agent's own-setup switch. Driven through the
   * provider, with the files handed in rather than read off whoever runs
   * this.
   */
  describe("holding claude@0.3.302's defaults (EO-599)", () => {
    const optionsFor = async (files: Record<string, unknown>, extra: { config?: Record<string, unknown>; environmentVariables?: Record<string, string>; model?: string } = {}) => {
      const calls: Record<string, unknown>[] = [];
      const runQuery = ((params: { options?: Record<string, unknown> }) => {
        calls.push(params.options ?? {});
        return (async function* () {})();
      }) as never;
      // By path with either separator, since the provider joins them the
      // way this platform does and these are spelled with slashes.
      const slashed = (path: string) => path.replaceAll("\\", "/");
      const byPath = new Map(Object.entries(files).map(([path, contents]) => [slashed(path), contents]));
      const settingsReader = { readText: (path: string) => (byPath.has(slashed(path)) ? JSON.stringify(byPath.get(slashed(path))) : null), listDir: () => [] };
      const start = { instructions: "i", context: "c", cwd: "/work/repo", ...(extra.environmentVariables ? { environmentVariables: extra.environmentVariables } : {}), ...(extra.model ? { model: extra.model } : {}) };
      for await (const _ of createClaudeProvider({ runQuery, enableCommentTool: false, settingsReader, ...(extra.config ? { config: extra.config as never } : {}) }).start(start as never)) void _;
      const options = calls[0] ?? {};
      return { env: (options["env"] ?? {}) as Record<string, string | undefined>, disallowedTools: options["disallowedTools"] as string[] | undefined };
    };
    const HELD = ["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH", "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DO_NOT_TRACK", "DISABLE_GROWTHBOOK", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_MODEL"];
    let saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      saved = Object.fromEntries(HELD.map((name) => [name, process.env[name]]));
      for (const name of HELD) delete process.env[name];
    });
    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    it("holds tool search off for a base URL only the repository's settings name", async () => {
      const { env } = await optionsFor({ "/work/repo/.claude/settings.json": { env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" } } });
      expect(env["ENABLE_TOOL_SEARCH"]).toBe("false");
    });

    it("reads the person's own settings only for an agent on their own setup", async () => {
      const home = process.env["HOME"] || homedir();
      const files = { [`${home}/.claude/settings.json`]: { env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" } } };
      expect((await optionsFor(files)).env["ENABLE_TOOL_SEARCH"]).toBeUndefined();
      expect((await optionsFor(files, { config: { inheritAmbientConfig: true } })).env["ENABLE_TOOL_SEARCH"]).toBe("false");
    });

    it("leaves a settings file's own ENABLE_TOOL_SEARCH alone", async () => {
      const { env } = await optionsFor({ "/work/repo/.claude/settings.json": { env: { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com", ENABLE_TOOL_SEARCH: "true" } } });
      expect(env["ENABLE_TOOL_SEARCH"]).toBeUndefined();
    });

    it("withholds no built-in tool, Monitor included, with telemetry off (a scope decision, EO-599)", async () => {
      process.env["DISABLE_TELEMETRY"] = "1";
      expect((await optionsFor({})).disallowedTools).toBeUndefined();
      expect((await optionsFor({}, { environmentVariables: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } })).disallowedTools).toBeUndefined();
    });

    it("keeps the full prompt, no refusal fallback and no downloaded catalogue for a custom deployment on Vertex", async () => {
      process.env["CLAUDE_CODE_USE_VERTEX"] = "1";
      const custom = await optionsFor({}, { model: "my-custom-deployment" });
      expect(custom.env).toMatchObject({ CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: "0", CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1", CLAUDE_CODE_MODEL_CATALOG: "off" });
      // A model the CLI knows: only the catalogue, which is the platform's.
      const known = await optionsFor({}, { model: "claude-sonnet-4-5@20250929" });
      expect(known.env["CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT"]).toBeUndefined();
      expect(known.env["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK"]).toBeUndefined();
      expect(known.env["CLAUDE_CODE_MODEL_CATALOG"]).toBe("off");
    });
  });

  /**
   * EO-468: Claude Code's own auto-memory is off on every turn EO starts,
   * by the CLI's switch in the spawn environment rather than by its
   * default (which is on). Read off `options.env` itself, not through
   * `childEnv`, because an unset `env` would fall back to the parent's
   * and prove nothing about what EO passed. Literal, so removing or
   * flipping the setting fails here.
   */
  it("starts and resumes every turn with Claude Code's auto-memory switched off, whoever asks otherwise (EO-468)", async () => {
    const calls: Record<string, unknown>[] = [];
    const runQuery = ((params: { options?: Record<string, unknown> }) => {
      calls.push(params.options ?? {});
      return (async function* () {})();
    }) as never;
    const spawnedWith = (options: Record<string, unknown> | undefined) => (options?.["env"] as Record<string, string | undefined> | undefined)?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"];
    const before = process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"];
    try {
      // A person's own `=0` is what the CLI reads as forcing it on.
      process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0";
      for (const provider of [
        createClaudeProvider({ runQuery, enableCommentTool: false }),
        // An agent on the person's own setup gets their settings back, not a second memory.
        createClaudeProvider({ runQuery, enableCommentTool: false, config: { inheritAmbientConfig: true } }),
        // An attached server declaring the same name cannot turn it back on.
        createClaudeProvider({ runQuery, enableCommentTool: false, attachmentEnv: () => ({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } }) }),
      ]) {
        await collect(provider.start({ instructions: "i", context: "c", cwd: "/tmp" } as never));
        await collect(provider.resume("sess", "carry on", { cwd: "/tmp" }));
      }
    } finally {
      if (before === undefined) delete process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"];
      else process.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = before;
    }

    expect(calls).toHaveLength(6);
    expect(calls.map(spawnedWith)).toEqual(Array(6).fill("1"));
    // Over what the CLI inherits, never instead of it.
    expect(calls.map((options) => childEnv(options)["PATH"])).toEqual(Array(6).fill(process.env["PATH"]));
  });

  it("asks the CLI for partial messages on every turn, for the answer's input streamed eagerly only where the answer is being read, and for thinking only when it is shown", async () => {
    const optionsFor = async (turn: Record<string, unknown>) => {
      const calls: Record<string, unknown>[] = [];
      const runQuery = ((params: { options?: Record<string, unknown> }) => {
        calls.push(params.options ?? {});
        return (async function* () {})();
      }) as never;
      for await (const _ of createClaudeProvider({ runQuery, enableCommentTool: false }).start({ instructions: "i", context: "c", cwd: "/tmp", ...turn } as never)) void _;
      return calls[0] ?? {};
    };
    const pipelineStep = await optionsFor({});
    // On every turn: the words are the only sign a long write is going on (`HeartbeatEvent`).
    expect(pipelineStep["includePartialMessages"]).toBe(true);
    expect(pipelineStep["thinking"]).toBeUndefined();
    const watched = await optionsFor({ streamDeltas: true, streamAnswer: true, showReasoning: true });
    expect(watched["includePartialMessages"]).toBe(true);
    // And the answer's tool input streamed eagerly, not in a few chunks.
    expect((watched["env"] as Record<string, string> | undefined)?.["CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"]).toBe("1");
    expect((pipelineStep["env"] as Record<string, string> | undefined)?.["CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"]).toBeUndefined();
    // A step's words stream; its tools' input is not streamed eagerly (`streamAnswer`).
    const stepStreaming = await optionsFor({ streamDeltas: true });
    expect((stepStreaming["env"] as Record<string, string> | undefined)?.["CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"]).toBeUndefined();
    expect(watched["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect((await optionsFor({ streamDeltas: true, showReasoning: false }))["thinking"]).toBeUndefined();
  });

  it("passes a watched turn's words on, and an unwatched one's as no more than a heartbeat", async () => {
    const turnOf = async (turn: Record<string, unknown>) => {
      const runQuery = (() =>
        (async function* () {
          yield init();
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: "sess_1" } as unknown as SDKMessage;
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Writing it now." } }, session_id: "sess_1" } as unknown as SDKMessage;
          yield assistant([{ type: "text", text: "Writing it now." }]);
          yield result();
        })()) as never;
      return collect(createClaudeProvider({ runQuery, enableCommentTool: false }).start({ ...startOpts, ...turn }));
    };
    const watched = await turnOf({ streamDeltas: true });
    expect(watched.some((event) => event.type === "output_delta")).toBe(true);
    const unwatched = await turnOf({});
    expect(unwatched.some((event) => event.type === "output_delta")).toBe(false);
    expect(unwatched.some((event) => event.type === "heartbeat")).toBe(true);
  });
});

describe("a warm query that died while it waited", () => {
  it("is replaced by a query of the turn's own, which is told the prompt and then anything steered into the dead one", async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runQuery = ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
      calls.push({ prompt: params.prompt, options: params.options ?? {} });
      if (calls.length === 1) return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("Claude Code process exited with code 1")) }) };
      return (async function* () {
        yield init();
        yield result({ result: "Hi." });
      })();
    }) as never;
    const provider = createClaudeProvider({ runQuery, enableCommentTool: false });
    provider.prewarm!({ kind: "start", instructions: startOpts.instructions, cwd: startOpts.cwd, warmKey: "k" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stream = provider.start({ ...startOpts, warmKey: "k" });
    expect(await stream.steer?.("And one more thing.")).toBe(true);
    const events = await collect(stream);
    warn.mockRestore();

    expect(calls).toHaveLength(2);
    expect((calls[1]?.options["abortController"] as AbortController | undefined)?.signal.aborted).toBe(false);
    expect((calls[0]?.options["abortController"] as AbortController | undefined)?.signal.aborted).toBe(true);
    const said: string[] = [];
    for await (const message of calls[1]?.prompt as AsyncIterable<SDKUserMessage>) {
      const content = message.message.content;
      said.push(typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join(""));
    }
    expect(said[0]).toBe(startOpts.context);
    expect(said[1]).toContain("And one more thing.");
    expect(events.at(-1)?.type).toBe("result");
  });
});

/**
 * A result the CLI wrote for something it was finishing before EO's
 * message (EO-495). On EO-487's restart recovery the resumed CLI closed
 * out the turn the kill had interrupted — an empty `success`, 0 turns,
 * echoing no message — and only then opened the turn carrying the
 * recovery prompt. The shapes below are the ones the pinned CLI was
 * measured writing, against a capture server.
 */
describe("a result that is not the turn's own (EO-495)", () => {
  /** The interrupted turn's close, as the resumed CLI writes it: no model call, no message echoed. */
  const closingResult = (): SDKMessage => result({ result: "", num_turns: 0, is_error: false, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });

  /**
   * A CLI that closes out an interrupted turn before it reads EO's
   * message, then answers that message — echoing the uuid it was sent
   * with, as the real one does. `inputOpen` is whether EO still had the
   * turn's input open once the stale result had been read.
   */
  function resumingCli(answer: (uuid: string) => SDKMessage[] | null) {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const seen: { uuid?: string | undefined; inputOpen?: boolean } = {};
    const runQuery = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Record<string, unknown> }) => {
      calls.push({ prompt: params.prompt, options: params.options ?? {} });
      return (async function* () {
        const input = params.prompt[Symbol.asyncIterator]();
        const first = await input.next();
        seen.uuid = first.done ? undefined : first.value.uuid;
        yield init();
        yield closingResult();
        // A closed input answers at once; an open one waits for a message.
        seen.inputOpen = await Promise.race([input.next().then((next) => !next.done), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20))]);
        const rest = answer(seen.uuid ?? "");
        if (rest === null) return;
        yield { ...init(), user_message_uuids: [seen.uuid] } as unknown as SDKMessage;
        yield* rest;
      })();
    }) as never;
    return { runQuery, calls, seen };
  }

  it("is read past on a resumed turn, which ends on its own result instead", async () => {
    const { runQuery, calls, seen } = resumingCli((uuid) => [
      assistant([{ type: "text", text: "Picking up where I left off." }]),
      result({ structured_output: { verdict: "approve" }, num_turns: 3, user_message_uuid: uuid, user_message_uuids: [uuid] }),
    ]);

    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess", "(EO restarted.)", { outputSchema: { type: "object" } }));

    expect(calls).toHaveLength(1);
    expect(seen.uuid).toEqual(expect.any(String));
    // Still listening: the CLI had EO's message yet to read.
    expect(seen.inputOpen).toBe(true);
    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", data: { verdict: "approve" } }]);
    expect(events).toContainEqual({ type: "output", text: "Picking up where I left off." });
    // The stale result's zeroed accounting is not reported over the real one.
    expect(events.filter((event) => event.type === "usage")).toEqual([expect.objectContaining({ turns: 3 })]);
  });

  it("is still passed on when it is the only result the turn got, so the supervisor validates it as before", async () => {
    const { runQuery } = resumingCli(() => null);

    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess", "(EO restarted.)"));

    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", data: "" }]);
    expect(events.at(-1)).toEqual({ type: "result", data: "" });
  });

  it("does not hold back the turn's own empty answer", async () => {
    const { runQuery } = resumingCli((uuid) => [result({ result: "", num_turns: 1, user_message_uuids: [uuid] })]);

    const events = await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).resume("sess", "(EO restarted.)"));

    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", data: "" }]);
  });

  describe("answersTurn", () => {
    const said = new Set(["ours"]);
    const resultOf = (fields: Record<string, unknown>) => result(fields) as SDKMessage & { type: "result" };

    it("goes by the messages the CLI says a result answers", () => {
      expect(answersTurn(resultOf({ user_message_uuid: "ours", user_message_uuids: ["ours"], num_turns: 0 }), said)).toBe(true);
      // Folded in with others, e.g. a steer: one of ours is enough.
      expect(answersTurn(resultOf({ user_message_uuid: "later", user_message_uuids: ["ours", "later"] }), said)).toBe(true);
      // Another send's answer — an interrupted turn re-run on resume — however much work it did.
      expect(answersTurn(resultOf({ user_message_uuid: "earlier", user_message_uuids: ["earlier"], num_turns: 7 }), said)).toBe(false);
    });

    it("falls back on the turn count only when nothing is echoed", () => {
      expect(answersTurn(resultOf({ num_turns: 0 }), said)).toBe(false);
      expect(answersTurn(resultOf({ num_turns: 1 }), said)).toBe(true);
      // A zeroed failure echoes nothing either, and is never skipped.
      expect(answersTurn(resultOf({ subtype: "error_during_execution", num_turns: 0, is_error: true }), said)).toBe(true);
      expect(answersTurn(resultOf({ num_turns: 0, is_error: true }), said)).toBe(true);
    });

    it("never reads the result's words", () => {
      expect(answersTurn(resultOf({ result: "No response requested.", num_turns: 2 }), said)).toBe(true);
      expect(answersTurn(resultOf({ result: "Anything at all.", num_turns: 0 }), said)).toBe(false);
    });
  });
});

/**
 * A side call (EO-477): one question, one structured answer, and none of
 * what an agent is given — asserted on the options the SDK is handed.
 */
describe("a side call", () => {
  const sideCallOpts = {
    model: "claude-haiku-5-5",
    system: "Pick the entries that bear on the task.",
    input: "Which of these matter?",
    outputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { picked: { type: "array", items: { type: "string" } } }, required: ["picked"] },
    cwd: "/tmp/eo-side-call-x",
    signal: new AbortController().signal,
  };

  it("starts with no tools, no MCP servers, no skills, no setting sources and no session kept, in the directory it was given", async () => {
    const { runQuery, calls } = fakeQuery([init(), result({ structured_output: { picked: ["e1"] } })]);
    // Handed everything an agent could be: none of it may reach a side call.
    const provider = createClaudeProvider({
      runQuery,
      enableCommentTool: true,
      apiKey: () => "sk-ant-test",
      executablePath: "/opt/eo/runtimes/claude/bin/claude",
      eoMcp: { serverPath: "/opt/eo/eoServer.mjs" },
      config: { allowedTools: ["Read", "mcp__eo__comment"], inheritAmbientConfig: true },
    });

    const events = await collect(provider.sideCall!(sideCallOpts));

    expect(events.find((event) => event.type === "result")).toEqual({ type: "result", data: { picked: ["e1"] } });
    const options = calls[0]!.options;
    expect(options).toMatchObject({
      cwd: "/tmp/eo-side-call-x",
      model: "claude-haiku-5-5",
      systemPrompt: "Pick the entries that bear on the task.",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      persistSession: false,
      pathToClaudeCodeExecutable: "/opt/eo/runtimes/claude/bin/claude",
      outputFormat: { type: "json_schema", schema: stripSchemaDialect(sideCallOpts.outputSchema) },
      // The answer's words as they are written, which the caller holds to its output-token cap (EO-577).
      includePartialMessages: true,
    });
    for (const absent of ["mcpServers", "plugins", "extraArgs", "allowedTools", "resume", "hooks", "thinking"]) {
      expect(options, absent).not.toHaveProperty(absent);
    }
    // One turn, its question the one message on an input EO closes at the
    // result — a stream rather than a string, so it can be interrupted (EO-577).
    expect(await promptText(calls[0]!.prompt)).toBe("Which of these matter?");
    // The lockdown it keeps: the key EO holds, and the CLI's own memory off.
    expect(childEnv(options)["ANTHROPIC_API_KEY"]).toBe("sk-ant-test");
    expect(childEnv(options)["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
  });

  it("is interrupted, not killed, when it is wound down, and passes on the spend its closing result reports (EO-577)", async () => {
    let interrupted = 0;
    let release: () => void = () => {};
    const interruptedTurn = new Promise<void>((resolve) => (release = resolve));
    const runQuery = (() => {
      const generator = (async function* () {
        yield init();
        await interruptedTurn;
        yield result({ subtype: "error_during_execution", usage: { input_tokens: 4_000, output_tokens: 2_100 }, total_cost_usd: 0.031 });
      })();
      return Object.assign(generator, {
        interrupt: async () => {
          interrupted += 1;
          release();
        },
      });
    }) as never;
    const windDown = new AbortController();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of createClaudeProvider({ runQuery, enableCommentTool: false }).sideCall!({ ...sideCallOpts, signal: controller.signal, windDown: windDown.signal })) {
      events.push(event);
      if (event.type === "thread_started") windDown.abort();
    }

    expect(interrupted).toBe(1);
    expect(controller.signal.aborted).toBe(false);
    expect(events.find((event) => event.type === "usage")).toMatchObject({ tokensOut: 2_100 });
  });

  it("is held to the budget it was handed, and cancelled by its signal", async () => {
    const { runQuery, calls } = fakeQuery([init(), result({ structured_output: { picked: [] } })]);
    const controller = new AbortController();
    await collect(createClaudeProvider({ runQuery, enableCommentTool: false }).sideCall!({ ...sideCallOpts, signal: controller.signal, budgetCents: 12 }));

    expect(calls[0]!.options["maxBudgetUsd"]).toBe(0.12);
    const bridged = calls[0]!.options["abortController"] as AbortController;
    expect(bridged.signal.aborted).toBe(false);
    controller.abort();
    expect(bridged.signal.aborted).toBe(true);
  });

  it("names the model and reasoning effort it was given (EO-578), and no effort where it was given none", async () => {
    const big = fakeQuery([init(), result({ structured_output: { picked: [] } })]);
    await collect(createClaudeProvider({ runQuery: big.runQuery, enableCommentTool: false }).sideCall!({ ...sideCallOpts, model: "claude-opus-5-5", reasoningEffort: "high" }));
    expect(big.calls[0]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "high" });

    // Selection and extraction: the small model, and the backend's own effort.
    const small = fakeQuery([init(), result({ structured_output: { picked: [] } })]);
    await collect(createClaudeProvider({ runQuery: small.runQuery, enableCommentTool: false, config: { effort: "xhigh" } }).sideCall!(sideCallOpts));
    expect(small.calls[0]!.options["model"]).toBe("claude-haiku-5-5");
    expect(small.calls[0]!.options).not.toHaveProperty("effort");
  });
});
