import { describe, expect, it } from "vitest";
import { blockerWords, resumeOutlook } from "./dispatchBlockers.js";

/**
 * What EO says about an item held on a step that keeps checking (EO-456).
 *
 * The question a person reading it asked is "when does EO look next", so
 * the next check is named in both sentences — and when the deadline comes
 * first, the sentence says that EO stops then, before that check.
 */
describe("the words for a watching item", () => {
  const at = (ms: number) => new Date(ms).toLocaleString();
  const nextCheckAt = Date.UTC(2026, 9, 20, 9, 0);

  it("names the next check when it comes before the give-up time", () => {
    const giveUpAt = Date.UTC(2026, 9, 27, 9, 0);
    const { condition, fix } = blockerWords({ kind: "watching", nextCheckAt, giveUpAt });

    expect(condition).toBe(`this step keeps checking on something outside EO, and its next check is at ${at(nextCheckAt)}`);
    expect(fix).toContain("checks again by itself then");
  });

  it("names both moments when the give-up time comes first, and says EO stops before checking again", () => {
    const giveUpAt = Date.UTC(2026, 9, 20, 8, 0);
    const { condition, fix } = blockerWords({ kind: "watching", nextCheckAt, giveUpAt });

    expect(condition).toContain(`its next check would be at ${at(nextCheckAt)}`);
    expect(condition).toContain(`it gives up first, at ${at(giveUpAt)}`);
    expect(condition).toContain("will not check again before then");
    expect(fix).toContain("when it gives up it stops and asks you itself");
  });

  it("never says a watch that never gives up gives up first, however close its next check (EO-571)", () => {
    const { condition, fix } = blockerWords({ kind: "watching", nextCheckAt, giveUpAt: null });

    expect(condition).toBe(`this step keeps checking on something outside EO, and its next check is at ${at(nextCheckAt)}`);
    expect(condition).not.toContain("gives up");
    expect(fix).not.toContain("gives up");
    expect(resumeOutlook("Wait for it", { kind: "watching", nextCheckAt, giveUpAt: null })).not.toContain("gives up");
  });

  it("is what a resume promises about the step, in the same words", () => {
    const giveUpAt = Date.UTC(2026, 9, 20, 8, 0);
    expect(resumeOutlook("Wait for it", { kind: "watching", nextCheckAt, giveUpAt })).toContain(`it gives up first, at ${at(giveUpAt)}`);
  });
});
