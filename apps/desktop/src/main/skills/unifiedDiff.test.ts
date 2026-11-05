import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./unifiedDiff.js";

/** The diff an improvement proposal attaches beside its SKILL.md (EO-483). */
describe("unifiedDiff", () => {
  const names = { from: "a/SKILL.md", to: "b/SKILL.md" };

  it("is the two headers and nothing else for identical texts", () => {
    expect(unifiedDiff("one\ntwo\n", "one\ntwo\n", names)).toBe("--- a/SKILL.md\n+++ b/SKILL.md\n");
  });

  it("marks what was removed and added, with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    const after = ["1", "2", "3", "4", "five", "6", "7", "8", "9"].join("\n");
    expect(unifiedDiff(before, after, names)).toBe(["--- a/SKILL.md", "+++ b/SKILL.md", "@@ -2,7 +2,7 @@", " 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8", ""].join("\n"));
  });

  it("joins changes close together into one hunk and keeps distant ones apart", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const after = [...lines];
    after[1] = "changed 2";
    after[4] = "changed 5";
    after[25] = "changed 26";
    const diff = unifiedDiff(lines.join("\n"), after.join("\n"), names);
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain("@@ -1,8 +1,8 @@");
    expect(diff).toContain("@@ -23,7 +23,7 @@");
  });

  it("describes a file written from nothing", () => {
    expect(unifiedDiff("", "new\n", names)).toBe("--- a/SKILL.md\n+++ b/SKILL.md\n@@ -0,0 +1,1 @@\n+new\n");
  });
});
