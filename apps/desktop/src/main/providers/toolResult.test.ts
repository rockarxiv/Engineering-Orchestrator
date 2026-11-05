import { describe, expect, it } from "vitest";
import { boundToolOutput, toolResultEvent, toolResultText, MAX_TOOL_RESULT_CHARS } from "./toolResult.js";

describe("boundToolOutput", () => {
  it("leaves a result that fits alone, and says it was not cut", () => {
    expect(boundToolOutput("2 passed")).toEqual({ output: "2 passed", truncated: false });
  });

  it("keeps the tail, because that is where a failing suite says what broke", () => {
    const text = `${"a".repeat(MAX_TOOL_RESULT_CHARS)}FAILED: the last line`;
    const { output, truncated } = boundToolOutput(text);

    expect(truncated).toBe(true);
    expect(output.endsWith("FAILED: the last line")).toBe(true);
    expect(output).toContain("earlier characters omitted");
  });

  it("counts what it dropped, so a reader knows this is an excerpt and how big a one", () => {
    const { output } = boundToolOutput("x".repeat(MAX_TOOL_RESULT_CHARS + 500));
    expect(output).toContain("[... 500 earlier characters omitted ...]");
  });

  it("keeps exactly the cap, whatever the marker adds", () => {
    // The marker is a sentence about the omission rather than part of
    // the output, so the bound is on the tool's own text: a cap that
    // shrank to make room for its own explanation would be a different
    // number every time.
    const { output } = boundToolOutput("y".repeat(MAX_TOOL_RESULT_CHARS * 3));
    expect(output.endsWith("y".repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(output.split("\n").at(-1)).toHaveLength(MAX_TOOL_RESULT_CHARS);
  });

  it("trims, so a result that was only whitespace reads as no output at all", () => {
    expect(boundToolOutput("\n\n  done  \n")).toEqual({ output: "done", truncated: false });
    expect(boundToolOutput("   \n ")).toEqual({ output: "", truncated: false });
  });
});

describe("toolResultText", () => {
  it("takes a plain string as it is — the shape a simple tool answers in", () => {
    expect(toolResultText("42 matches")).toBe("42 matches");
  });

  it("joins the text blocks of a content array", () => {
    expect(toolResultText([{ type: "text", text: "first" }, { type: "text", text: "second" }])).toBe("first\nsecond");
  });

  it("names a block it will not render rather than pasting megabytes of base64", () => {
    expect(toolResultText([{ type: "text", text: "here it is" }, { type: "image", data: "iVBORw0KG…", mimeType: "image/png" }])).toBe(
      "here it is\n[image]",
    );
  });

  it("says nothing about content it cannot read, rather than guessing", () => {
    expect(toolResultText(undefined)).toBe("");
    expect(toolResultText({ unexpected: true })).toBe("");
    expect(toolResultText([null, 7])).toBe("");
  });
});

describe("toolResultEvent", () => {
  it("bounds the output it is given, so no adapter can decide not to", () => {
    const event = toolResultEvent({ name: "Bash", callId: "call_1", ok: true, output: "z".repeat(MAX_TOOL_RESULT_CHARS + 1) });

    expect(event.truncated).toBe(true);
    expect(event.output.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 100);
  });

  it("leaves out what it was not told, because these rows are persisted as JSON", () => {
    const event = toolResultEvent({ ok: true, output: "" });

    // `{ name: undefined }` and no `name` are the same to TypeScript and
    // different to anything reading the stored payload back.
    expect(Object.keys(event).sort()).toEqual(["ok", "output", "truncated", "type"]);
    expect(JSON.parse(JSON.stringify(event))).toEqual({ type: "tool_result", ok: true, output: "", truncated: false });
  });

  it("carries the backend's own words about how the call ended when it has them", () => {
    expect(toolResultEvent({ name: "command_execution", callId: "i2", ok: false, output: "1 failed", status: "completed", exitCode: 1 })).toEqual({
      type: "tool_result",
      name: "command_execution",
      callId: "i2",
      ok: false,
      output: "1 failed",
      truncated: false,
      status: "completed",
      exitCode: 1,
    });
  });
});
