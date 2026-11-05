import { describe, expect, it } from "vitest";
import { validateRefineGraph, type GraphChild } from "./refineGraph.js";

// A decomposition's children, as far as the graph cares: a name and the
// siblings each waits for (KAN-147). What type they are is the pack's
// question, and this file has no opinion about it.
function story(title: string, dependsOn: number[] = []): GraphChild {
  return { title, depends_on: dependsOn };
}

function output(...children: GraphChild[]): GraphChild[] {
  return children;
}

describe("validateRefineGraph", () => {
  it("accepts a well-formed chain", () => {
    expect(validateRefineGraph(output(story("A"), story("B", [0]), story("C", [1])))).toEqual({ ok: true });
  });

  it("accepts a diamond — two stories depending on the same predecessor", () => {
    expect(validateRefineGraph(output(story("A"), story("B", [0]), story("C", [0]), story("D", [1, 2])))).toEqual({ ok: true });
  });

  it("accepts stories with no dependencies at all", () => {
    expect(validateRefineGraph(output(story("A"), story("B")))).toEqual({ ok: true });
  });

  it("rejects an out-of-range index, naming the child and the valid range", () => {
    const result = validateRefineGraph(output(story("A"), story("B", [5])));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("children[1]");
      expect(result.error).toContain('"B"');
      expect(result.error).toContain("0-1"); // the valid range, so the agent can correct itself
    }
  });

  it("rejects a self-reference", () => {
    const result = validateRefineGraph(output(story("A", [0])));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("depends on itself");
  });

  it("rejects a two-story cycle with a readable path", () => {
    const result = validateRefineGraph(output(story("A", [1]), story("B", [0])));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cycle");
      expect(result.error).toContain('"A"');
      expect(result.error).toContain('"B"');
      expect(result.error).toContain("→");
    }
  });

  it("rejects a longer cycle", () => {
    const result = validateRefineGraph(output(story("A", [2]), story("B", [0]), story("C", [1])));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cycle");
  });

  it("reports a bad index rather than a cycle when both could apply — the index is the root cause", () => {
    // An out-of-range index can't be turned into an edge, so checking it
    // first is what keeps the cycle check well-defined.
    const result = validateRefineGraph(output(story("A", [1]), story("B", [0, 99])));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("99");
      expect(result.error).not.toContain("cycle");
    }
  });
});
