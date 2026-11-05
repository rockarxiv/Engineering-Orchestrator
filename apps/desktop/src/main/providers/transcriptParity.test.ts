import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent } from "./codexClient.js";
import type { AgentEvent } from "@eo/core";
import { describe, expect, it } from "vitest";
import { mapSdkMessage } from "./claude.js";
import { mapThreadEvent } from "./codex.js";
import { MAX_TOOL_RESULT_CHARS } from "./toolResult.js";

/**
 * The same work, recorded the same way, whichever backend did it
 * (EO-169).
 *
 * The failure this story is about was not that one adapter was missing a
 * field. It was that a transcript meant different things depending on
 * who ran it, so a reading taken across runs was quietly comparing two
 * kinds of record. That is a property of the pair, and neither adapter's
 * own tests can hold it: each was passing while the divergence was real.
 *
 * So this file drives one piece of work through both mappers and asserts
 * they agree. It is deliberately about the shape a person or a
 * measurement reads — did a call happen, what came back, was it cut —
 * and not about the fields only one backend can fill in, which are named
 * where they are allowed to differ.
 */

/** What the Claude SDK sends for a call and its answer: two messages, in order. */
function claudeCall(name: string, input: unknown, output: string, isError = false): AgentEvent[] {
  const pending = new Map<string, string>();
  const call = mapSdkMessage(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name, input }] } } as unknown as SDKMessage,
    pending,
  );
  const answer = mapSdkMessage(
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: isError, content: output }] },
    } as unknown as SDKMessage,
    pending,
  );
  return [...call.mapped, ...answer.mapped];
}

/** What Codex sends for the same thing: one completed item. */
function codexCommand(command: string, output: string, exitCode: number): AgentEvent[] {
  return mapThreadEvent({
    type: "item.completed",
    item: { id: "i1", type: "command_execution", command, aggregated_output: output, exit_code: exitCode, status: "completed" },
  } as ThreadEvent).mapped;
}

/** The fields both backends can answer — everything a cross-run reading may rely on. */
function comparable(events: AgentEvent[]): unknown[] {
  return events.map((event) => {
    if (event.type === "tool_call") return { type: event.type, paired: event.callId !== undefined };
    if (event.type === "tool_result") return { type: event.type, paired: event.callId !== undefined, ok: event.ok, output: event.output, truncated: event.truncated };
    return { type: event.type };
  });
}

describe("a shell command, run by either backend", () => {
  it("is recorded as a call and an answer, with the same answer in it", () => {
    const claude = claudeCall("Bash", { command: "pnpm test" }, "2 passed");
    const codex = codexCommand("pnpm test", "2 passed", 0);

    expect(comparable(claude)).toEqual(comparable(codex));
    expect(comparable(codex)).toEqual([
      { type: "tool_call", paired: true },
      { type: "tool_result", paired: true, ok: true, output: "2 passed", truncated: false },
    ]);
  });

  it("is recorded as having failed on both, though they say so in different words", () => {
    // Claude has one word for it and Codex has two numbers. `ok` is the
    // translation, and it is the only thing a reading across backends
    // can safely count.
    const claude = claudeCall("Bash", { command: "pnpm test" }, "1 failed", true);
    const codex = codexCommand("pnpm test", "1 failed", 1);

    expect(comparable(claude)).toEqual(comparable(codex));
    // …and each still carries its own backend's account underneath.
    expect(codex[1]).toMatchObject({ status: "completed", exitCode: 1 });
    expect(claude[1]).not.toHaveProperty("exitCode");
  });

  it("is cut at the same point, to the same size, with the same words about what was dropped", () => {
    const huge = `${"noise\n".repeat(20_000)}the last line`;
    const claude = claudeCall("Bash", { command: "grep -rn x ." }, huge);
    const codex = codexCommand("grep -rn x .", huge, 0);

    expect(comparable(claude)).toEqual(comparable(codex));
    const output = (codex[1] as { output: string }).output;
    expect(output).toContain("earlier characters omitted");
    expect(output.endsWith("the last line")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 80); // the tool's text, plus the sentence about the omission
  });
});

describe("a call to EO's own comment tool", () => {
  it("keeps its bare name and its answer on both backends", () => {
    const claude = claudeCall("mcp__eo__comment", { body: "@user which limit?", blocking: true }, "Comment posted.");
    const codex = mapThreadEvent({
      type: "item.completed",
      item: {
        id: "i1",
        type: "mcp_tool_call",
        server: "eo",
        tool: "comment",
        arguments: { body: "@user which limit?", blocking: true },
        result: { content: [{ type: "text", text: "Comment posted." }], structured_content: null },
        status: "completed",
      },
    } as ThreadEvent).mapped;

    // The name matters here beyond tidiness: the supervisor's escalation
    // path fires on a `tool_call` named `comment`, and it must go on
    // firing on exactly one event per call.
    expect(claude.map((event) => (event.type === "tool_call" || event.type === "tool_result" ? event.name : event.type))).toEqual(["comment", "comment"]);
    expect(comparable(claude)).toEqual(comparable(codex));
  });
});
