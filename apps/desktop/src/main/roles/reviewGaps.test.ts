import { describe, expect, it } from "vitest";
import { loadRolePrompt } from "./prompts.js";

/**
 * A gap a run leaves is the reviewer's to judge (ARCHITECTURE.md). Nothing
 * else picks it up, so the two prompts between them are the whole of the
 * rule: the implementer says what it left, and the reviewer judges it.
 */
describe("a gap a run leaves", () => {
  it("is stated in the implementer's handoff, with nothing left for later", () => {
    const prompt = loadRolePrompt("implementer") ?? "";
    expect(prompt).toContain("**Nothing is left for later.**");
    expect(prompt).toContain("What the story puts out of scope stays out of\n  scope");
    expect(prompt).not.toContain("exposes");
  });

  it("is a finding for the reviewer, whatever it is called, and adds no criteria", () => {
    const prompt = loadRolePrompt("reviewer") ?? "";
    expect(prompt).toContain("**A gap the implementer admits is yours to judge.**");
    expect(prompt).toContain("when a criterion or the story's stated purpose does not hold\n  without it, or when the change itself left something broken.");
    expect(prompt).toContain("story puts it out of scope, when a person settled it on the thread, or\n  when the change neither touched it nor made it worse and the story\n  still does what it set out to.");
    expect(prompt).toContain("`needs_user_input`, not a\n  rejection: this list adds no criteria. A line that leaves nothing wrong\n  is feedback, not a question.");
  });

  it("is not a follow-up in any shipped prompt", () => {
    for (const role of ["implementer", "reviewer", "system"]) {
      expect(loadRolePrompt(role) ?? "").not.toMatch(/\*\*Write it up\*\*|Writing up a follow-up/);
    }
  });
});
