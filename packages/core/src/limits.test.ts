import { describe, expect, it } from "vitest";
import { DEFAULT_MODULE_TIMEOUT_MS, describeDuration, stepTimeoutMs, timeLimitBoundProblem } from "./limits.js";

/**
 * How long a step may run, and how that squares with the run timeout
 * (EO-162).
 *
 * The arithmetic lives here because two enforcement sites lean on it —
 * `validatePipeline` and `writeGuards` — and a bound that meant something
 * slightly different in each would be two limits again.
 */

describe("the limit that applies to a step", () => {
  it("is EO's default when the step sets none, which is what makes raising it opt-in", () => {
    expect(stepTimeoutMs({ timeoutMs: null })).toBe(DEFAULT_MODULE_TIMEOUT_MS);
    expect(stepTimeoutMs(undefined)).toBe(DEFAULT_MODULE_TIMEOUT_MS);
    // Unchanged from the constant that used to be unreachable in
    // `runModule.ts`: nobody's behaviour moves because this shipped.
    expect(DEFAULT_MODULE_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  it("is what the step says when it says one", () => {
    expect(stepTimeoutMs({ timeoutMs: 25 * 60 * 1000 })).toBe(25 * 60 * 1000);
  });
});

describe("the bound on that limit", () => {
  it("says nothing when the step fits inside the run timeout", () => {
    expect(timeLimitBoundProblem({ stepName: "Merge", timeoutMs: 20 * 60_000, runTimeoutMs: 30 * 60_000 })).toBeNull();
  });

  it("allows a step that is exactly the run timeout — the bound is a ceiling, not a gap", () => {
    expect(timeLimitBoundProblem({ stepName: "Merge", timeoutMs: 30 * 60_000, runTimeoutMs: 30 * 60_000 })).toBeNull();
  });

  it("refuses a step that asks for longer, naming both numbers and both ways out", () => {
    const problem = timeLimitBoundProblem({ stepName: "Merge", timeoutMs: 40 * 60_000, runTimeoutMs: 30 * 60_000 });

    expect(problem).toContain("Merge");
    expect(problem).toContain("40 minutes");
    expect(problem).toContain("30 minutes");
    // Both, because either is a legitimate answer and a message naming
    // one of them decides for the person which limit was the wrong one.
    expect(problem).toContain("Raise the run timeout");
    expect(problem).toContain("lower this step's limit");
  });
});

describe("saying a duration back", () => {
  it("uses the unit somebody typed it in", () => {
    expect(describeDuration(15 * 60_000)).toBe("15 minutes");
    expect(describeDuration(60_000)).toBe("1 minute");
    expect(describeDuration(90_000)).toBe("90 seconds");
  });

  it("does not round a sub-second limit up to a number EO never used", () => {
    expect(describeDuration(500)).toBe("500ms");
  });
});
