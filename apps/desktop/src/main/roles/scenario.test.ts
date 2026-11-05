import { ADMIN_MCP_SERVER_NAME, type RunEvent } from "@eo/core";
import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";
import { moduleWritesIn, numberedCode, renderCodeDiff } from "./scenario.js";

/**
 * The scenario room's pure parts (EO-356): the diff a change card shows,
 * the numbering a turn names lines by, the reading of a run's log for a
 * module write, and what the prompt teaches.
 */

describe("renderCodeDiff", () => {
  it("shows a changed line as a removal and an addition, with the lines around it", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n");
    const diff = renderCodeDiff(before, after);
    expect(diff).toContain("```diff");
    expect(diff).toContain("@@ -2,7 +2,7 @@");
    expect(diff).toContain("-e\n+E");
    // Three lines of context either side, and nothing past them.
    expect(diff).toContain(" b\n c\n d\n");
    expect(diff).not.toContain(" a\n");
    expect(diff).not.toContain(" j");
  });

  it("numbers a hunk from where it starts in each version when lines are added", () => {
    const diff = renderCodeDiff("one\ntwo", "zero\none\ntwo\nthree");
    expect(diff).toContain("@@ -1,2 +1,4 @@");
    expect(diff).toContain("+zero\n one\n two\n+three");
  });

  it("says when nothing changed", () => {
    expect(renderCodeDiff("same", "same")).toBe("_No line changes._");
  });

  it("is a fence the code cannot close", () => {
    expect(renderCodeDiff("const a = 1;", "const a = `\n```\n`;")).toMatch(/^````diff/);
  });
});

describe("numberedCode", () => {
  it("numbers every line, padded so the code lines up", () => {
    const code = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(numberedCode(code).split("\n").slice(8)).toEqual([" 9 | line 9", "10 | line 10"]);
  });
});

describe("moduleWritesIn", () => {
  const event = (type: string, payload: Record<string, unknown>): RunEvent => ({ type, payload }) as unknown as RunEvent;

  it("finds a module write on either backend's spelling, and ignores test writes and other servers", () => {
    const events = [
      event("tool_call", { name: `mcp__${ADMIN_MCP_SERVER_NAME}__module_save`, callId: "1" }),
      event("tool_call", { name: `${ADMIN_MCP_SERVER_NAME}/module_archive`, callId: "2" }),
      event("tool_call", { name: `mcp__${ADMIN_MCP_SERVER_NAME}__module_test_save`, callId: "3" }),
      event("tool_call", { name: "mcp__lookalike__module_save", callId: "4" }),
      event("tool_call", { name: "module_save", callId: "5" }),
    ];
    expect(moduleWritesIn(events)).toEqual(["module_save", "module_archive"]);
  });

  it("does not count a call its backend answered with an error, which wrote nothing", () => {
    const events = [
      event("tool_call", { name: `mcp__${ADMIN_MCP_SERVER_NAME}__module_approve`, callId: "1" }),
      event("tool_result", { callId: "1", ok: false }),
    ];
    expect(moduleWritesIn(events)).toEqual([]);
  });
});

describe("the scenario section of the system agent's prompt", () => {
  function section(): string {
    const prompt = loadRolePrompt("system")!;
    const start = prompt.indexOf("## scenario");
    const end = prompt.indexOf("\n# ", start);
    expect(start).toBeGreaterThan(-1);
    return prompt.slice(start, end === -1 ? undefined : end);
  }

  it("names the action in the table of what reaches the agent", () => {
    expect(loadRolePrompt("system")!).toMatch(/\| `scenario` \|/);
  });

  it("walks a turn: ask when vague, read the cases, write one, save it, run it, report result and coverage", () => {
    const text = section();
    for (const term of ["ask in the chat", "`module_tests_list`", "`module_test_save`", "`module_tests_run`", "`testId`", "coverage"]) {
      expect(text).toContain(term);
    }
  });

  it("teaches the evidence for a failure and asks the person how to resolve it", () => {
    const text = section();
    for (const term of ["`diagnosis.scripted`", "`diagnosis.made`", "`diagnosis.lines`", "The test is wrong", "The module is wrong"]) {
      expect(text).toContain(term);
    }
  });

  it("forbids changing the module, and proposes a fix as a whole-code change the person applies", () => {
    const text = section();
    expect(text).toContain("**Never change the module on your own initiative.**");
    expect(text).toContain("`module_save`, `module_approve` or `module_archive`");
    expect(text).toContain("`change`");
    expect(text).toContain("Apply");
  });

  it("says writing, fixing or deleting a case on an approved module withdraws its approval, and the reply must say so (EO-501)", () => {
    const text = section().replace(/\s+/g, " ");
    expect(text).toContain("### When the module is approved");
    expect(text).toContain("**writing a case, fixing one (saving it again by its id) or deleting one withdraws its approval**");
    expect(text).toContain("**your reply must say so** — in `message`, that the module's approval was withdrawn");
    expect(text).toContain("Do not approve it yourself; `module_approve` is refused here.");
  });

  it("finds the tools by their server, not by one backend's punctuation (invariant #12)", () => {
    const text = section();
    expect(text).toContain(`the MCP server EO registers as \`${ADMIN_MCP_SERVER_NAME}\``);
    expect(text).not.toContain("mcp__");
    expect(text).not.toContain(`${ADMIN_MCP_SERVER_NAME}/`);
  });
});
