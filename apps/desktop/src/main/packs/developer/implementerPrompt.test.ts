import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourcePromptsDir } from "../../roles/prompts.js";

/**
 * What the implementer is told about a CI failure its branch did not cause
 * (EO-622). In EO-597 it finished with "re-run the failed CI job" as a next
 * step, and nobody ran it: the watch sent the ticket back for the old failure.
 */
describe("the implementer's prompt on CI failures", () => {
  const prompt = readFileSync(join(sourcePromptsDir(), "implementer.md"), "utf8");
  const paragraph = prompt.split("\n- ").find((line) => line.includes("CI failure")) ?? "";

  it("says to re-run the failed job before finishing, without waiting for the result", () => {
    expect(paragraph).toContain("not caused by this branch");
    expect(paragraph).toContain("re-run the failed job");
    expect(paragraph).toContain("before you finish");
    expect(paragraph).toContain("Do not wait for the result");
  });

  it("is not tied to one forge", () => {
    expect(paragraph).not.toMatch(/\b(gh|glab|github|gitlab)\b/i);
  });
});
