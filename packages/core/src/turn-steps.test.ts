import { describe, expect, it } from "vitest";
import { HUMAN_MESSAGE_EVENT } from "./execution.js";
import { answerArgsOf, toolLabel, turnStepsOf } from "./turn-steps.js";

const event = (seq: number, type: string, payload: unknown) => ({ seq, type, payload });

describe("a run's events, read as steps", () => {
  it("pairs a call with its result and keeps everything in the order it happened", () => {
    const steps = turnStepsOf([
      event(0, "thread_started", { threadId: "t" }),
      event(1, "output", { text: "Looking at the board." }),
      event(2, "tool_call", { name: "Read", callId: "c1", args: { file_path: "src/a.ts" } }),
      event(3, "reasoning", { text: "The step is missing." }),
      event(4, "tool_result", { name: "Read", callId: "c1", ok: true, output: "export {}" }),
      event(5, "usage", { tokensIn: 1 }),
    ]);
    expect(steps).toEqual([
      { kind: "text", seq: 1, text: "Looking at the board." },
      { kind: "tool", seq: 2, callId: "c1", name: "Read", label: "Read src/a.ts", input: '{\n  "file_path": "src/a.ts"\n}', ok: true, output: "export {}" },
      { kind: "reasoning", seq: 3, text: "The step is missing." },
    ]);
  });

  it("leaves a call with no result yet as still running", () => {
    const [step] = turnStepsOf([event(0, "tool_call", { name: "Bash", callId: "c1", args: { command: "pnpm test" } })]);
    expect(step).toMatchObject({ kind: "tool", label: "Ran pnpm test", ok: null, output: null });
  });

  it("keeps a failed result as failed", () => {
    const steps = turnStepsOf([
      event(0, "tool_call", { name: "Bash", callId: "c1", args: { command: "false" } }),
      event(1, "tool_result", { name: "Bash", callId: "c1", ok: false, output: "exit 1" }),
    ]);
    expect(steps[0]).toMatchObject({ ok: false, output: "exit 1" });
  });

  it("keeps a result that came without its call", () => {
    expect(turnStepsOf([event(0, "tool_result", { name: "eo/comment", ok: true, output: "posted" })])).toEqual([
      { kind: "tool", seq: 0, callId: null, name: "eo/comment", label: "eo · comment", input: null, ok: true, output: "posted" },
    ]);
  });

  it("does not repeat an answer written as JSON, or as the structured-output tool, as narration", () => {
    const events = [
      event(0, "output", { text: '{"outcome":{"message":"Hi"}}' }),
      event(1, "tool_call", { name: "StructuredOutput", callId: "c9", args: { outcome: { message: "Hi" } } }),
      event(2, "tool_result", { name: "StructuredOutput", callId: "c9", ok: true, output: "ok" }),
    ];
    expect(turnStepsOf(events)).toEqual([]);
    expect(answerArgsOf(events)).toEqual({ outcome: { message: "Hi" } });
  });

  it("does not list an edit twice when the call already names the file", () => {
    const steps = turnStepsOf([
      event(0, "tool_call", { name: "Edit", callId: "c1", args: { file_path: "src/a.ts", old_string: "a", new_string: "b" } }),
      event(1, "file_edit", { path: "src/a.ts" }),
      event(2, "file_edit", { path: "src/b.ts" }),
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["tool", "edit"]);
    expect(steps[1]).toMatchObject({ path: "src/b.ts" });
  });

  it("shows errors and the messages a person steered into the turn, and not one that missed it", () => {
    const steps = turnStepsOf([
      event(0, "error", { message: "overloaded", retryable: true }),
      event(1, HUMAN_MESSAGE_EVENT, { commentId: "c", body: "use the other board", delivery: "now", delivered: true }),
      event(2, HUMAN_MESSAGE_EVENT, { commentId: "d", body: "too late", delivery: "now", delivered: false }),
    ]);
    expect(steps).toEqual([
      { kind: "error", seq: 0, message: "overloaded" },
      { kind: "steer", seq: 1, text: "use the other board" },
    ]);
  });

  it("bounds a long output", () => {
    const [step] = turnStepsOf([event(0, "tool_result", { name: "Bash", ok: true, output: "x".repeat(5000) })]);
    expect(step?.kind === "tool" && step.output?.endsWith("1000 more characters")).toBe(true);
  });
});

describe("the label of a tool call", () => {
  it("names both backends' MCP spellings the same way", () => {
    expect(toolLabel("mcp__eo_admin__items_list", {})).toBe("eo_admin · items_list");
    expect(toolLabel("eo_admin/items_list", {})).toBe("eo_admin · items_list");
  });

  it("says what a built-in tool did to what", () => {
    expect(toolLabel("Grep", { pattern: "TODO" })).toBe("Searched for TODO");
    expect(toolLabel("command_execution", { command: "git status" })).toBe("Ran git status");
    expect(toolLabel("WebSearch", {})).toBe("Searched the web for");
    expect(toolLabel("Something", { a: 1 })).toBe("Something");
  });

  it("keeps a label to one line", () => {
    const label = toolLabel("Bash", { command: `echo ${"a".repeat(200)}\nls` });
    expect(label.includes("\n")).toBe(false);
    expect(label.length).toBeLessThanOrEqual(124);
  });
});
