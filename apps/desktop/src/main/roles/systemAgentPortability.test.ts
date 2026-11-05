import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * What the system agent is told about values that only hold on one
 * machine (EO-448). Modules, their tests, pipelines and agent
 * instructions are exported, imported from packs and published by
 * organisations, and a hardcoded home directory or loopback port in any
 * of them passes every test where it was written and breaks silently
 * everywhere else. Before this the prompt said only "Node builtins only",
 * which covers a module's imports and nothing else it writes.
 */

const prompt = loadRolePrompt("system")!;

/** The rule's own section: from its heading to the next one. */
function portabilitySection(): string {
  const start = prompt.indexOf("## Nothing you write may only work on this machine");
  expect(start).toBeGreaterThan(-1);
  const next = /\n#{1,3} /.exec(prompt.slice(start + 1));
  return (next ? prompt.slice(start, start + 1 + next.index) : prompt.slice(start)).replace(/\s+/g, " ");
}

describe("what the system agent's prompt says about machine-specific values", () => {
  it("is a newer version than the prompt that had no portability rule", () => {
    expect(Number(/prompt-version:\s*(\d+)/.exec(prompt)![1])).toBeGreaterThanOrEqual(22);
  });

  it("applies the rule to modules, their tests, pipeline steps and agent instructions alike", () => {
    expect(portabilitySection()).toContain("modules, module test cases, pipeline steps and agent instructions alike** — not only to module code");
  });

  it("names what must not be hardcoded", () => {
    const section = portabilitySection();
    expect(section).toContain("**Absolute or home-directory paths**");
    expect(section).toContain("**User names, host names or local ports**");
    expect(section).toContain("**One operating system's shell, commands or path separators**");
    expect(section).toContain("**Personal tooling**");
  });

  it("says where a value that differs between installations goes instead", () => {
    const section = portabilitySection();
    expect(section).toContain("**A step input with a sensible default**");
    expect(section).toContain("**Read while the step runs**, from the checkout (`ctx.cwd`, git) or from the forge");
    expect(section).toContain("**A declared environment variable or secret**");
  });

  it("has test cases build paths from harness.cwd, and keeps paths in scripted output", () => {
    // Stripping a realistic path out of a scripted `stderr` makes a
    // fixture less like the binary it stands in for, and buys nothing:
    // scripted output never touches the filesystem.
    const section = portabilitySection();
    expect(section).toContain("Test cases build every path they use from `harness.cwd`");
    expect(section).toContain("a path in a scripted `stdout` or `stderr`");
    expect(section).toContain("is a realistic fixture, and it stays rather than being stripped out");
  });

  it("points at the rule from where modules are told to use Node builtins only", () => {
    const flat = prompt.replace(/\s+/g, " ");
    expect(flat).toContain("The same goes for everything else in it — see **Nothing you write may only work on this machine**");
  });
});
