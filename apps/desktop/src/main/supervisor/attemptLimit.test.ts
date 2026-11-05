import { describe, expect, it } from "vitest";
import { attemptLimitStop, isAttemptLimitStop } from "./attemptLimit.js";

describe("the attempt limit's stop (EO-586)", () => {
  it("is told apart from every other stop by its own words", () => {
    expect(attemptLimitStop(3, "implement", 3)).toBe('Stopped after 3 attempt(s) in this "implement" initiation (limit: 3). Reply to start a new initiation.');
    expect(isAttemptLimitStop(attemptLimitStop(3, "implement", 3))).toBe(true);
    expect(isAttemptLimitStop('Stopped after this "implement" was interrupted 5 times — by EO being closed or restarting.')).toBe(false);
    expect(isAttemptLimitStop("Review — the pipeline routes this result to you.")).toBe(false);
  });
});
