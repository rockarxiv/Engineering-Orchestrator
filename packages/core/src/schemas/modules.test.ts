import { describe, expect, it } from "vitest";
import { declaredStepInputs, describeModuleTestShortfall, moduleInputProblems, moduleTestShortfalls, StepInputsSchema, type ModuleTestRun } from "./modules.js";

/**
 * What a step may set for the inputs its module declares (EO-78).
 *
 * The rules live here rather than in the two callers because both of
 * them apply exactly these: `validatePipeline` so a bad value cannot be
 * published, and `runModule` so one that reached the row some other way
 * never reaches `ctx.inputs`. Two copies would be two chances to disagree
 * about what a module is allowed to be handed.
 */

const manifest = {
  inputs: {
    wait_seconds: { type: "number" as const },
    environment: { type: "string" as const },
    force: { type: "boolean" as const },
  },
};

describe("moduleInputProblems", () => {
  it("accepts a value of each declared type", () => {
    expect(moduleInputProblems(manifest, { wait_seconds: 900, environment: "production", force: true })).toEqual([]);
  });

  // The unset case, and the ordinary one: the manifest's default applies,
  // which is not something a step has to say anything about.
  it("accepts an input the step leaves alone", () => {
    expect(moduleInputProblems(manifest, {})).toEqual([]);
  });

  /**
   * The failure this exists to stop: a module that declared a number and
   * is handed `"900"` does arithmetic on a string, in a subprocess whose
   * only account of itself is a transcript nobody is watching.
   */
  it("names the input, what it declared, and what the step set", () => {
    const problems = moduleInputProblems(manifest, { wait_seconds: "900" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("wait_seconds");
    expect(problems[0]).toContain("number");
    // Quoted, so the difference between the text "900" and the number 900
    // is visible — which is the entire content of the complaint.
    expect(problems[0]).toContain('the text "900"');
  });

  it("refuses a number where a string was declared", () => {
    expect(moduleInputProblems(manifest, { environment: 3 })[0]).toContain("environment");
  });

  it("refuses a string where a boolean was declared", () => {
    expect(moduleInputProblems(manifest, { force: "yes" })[0]).toContain("force");
  });

  // Several wrong at once: each is named, because "one of these is wrong"
  // is not something anyone can act on.
  it("names every input that is wrong", () => {
    const problems = moduleInputProblems(manifest, { wait_seconds: "900", force: "yes" });
    expect(problems).toHaveLength(2);
  });

  /**
   * A manifest that dropped an input leaves whatever was stored for it
   * behind. Inert, not broken: `resolveInputs` passes only declared
   * names, so the value goes nowhere — and refusing it would park every
   * item reaching a step whose module was edited perfectly reasonably.
   */
  it("says nothing about a name the manifest does not declare", () => {
    expect(moduleInputProblems(manifest, { retired_input: "left behind" })).toEqual([]);
  });

  // Nothing declared at all is the common case: most modules take no
  // inputs, and every step running one configures nothing.
  it("says nothing when the manifest declares no inputs", () => {
    expect(moduleInputProblems({ inputs: {} }, { anything: 1 })).toEqual([]);
  });
});

describe("declaredStepInputs", () => {
  it("keeps the values the manifest declares", () => {
    expect(declaredStepInputs(manifest, { wait_seconds: 900, environment: "staging" })).toEqual({ wait_seconds: 900, environment: "staging" });
  });

  // What happens when a step is pointed at a different module: the old
  // module's values are not this one's, and carrying them would leave a
  // number nothing renders, waiting for a manifest edit to give it a
  // meaning nobody intended.
  it("drops the values it does not", () => {
    expect(declaredStepInputs(manifest, { wait_seconds: 900, flavour: "vanilla" })).toEqual({ wait_seconds: 900 });
  });
});

describe("StepInputsSchema", () => {
  it("accepts the three declared types", () => {
    expect(StepInputsSchema.parse({ a: "text", b: 1, c: false })).toEqual({ a: "text", b: 1, c: false });
  });

  // Absent is how an unset input is expressed, so null has no meaning
  // here — and a step that could store one would have a fourth state the
  // module host cannot represent.
  it("refuses a null", () => {
    expect(StepInputsSchema.safeParse({ a: null }).success).toBe(false);
  });

  it("refuses a structure a module could not have declared", () => {
    expect(StepInputsSchema.safeParse({ a: { nested: true } }).success).toBe(false);
  });
});

/**
 * Whether a module is fully tested, and if not, why (EO-354).
 *
 * The same bar approval holds a module to — at least one case, every
 * case passing, line coverage at 80% or above — read off what is
 * stored. Every place that flags a step reads this, so the three
 * reasons and the words for them are asserted once, here.
 */
describe("moduleTestShortfalls", () => {
  function run(cases: { passed: boolean; description: string }[], lines: number): ModuleTestRun {
    return {
      ranAt: 1,
      cases: cases.map((each, index) => ({ testId: `t${index}`, description: each.description, passed: each.passed, failure: each.passed ? null : "boom", durationMs: 1, output: "" })),
      coverage: { lines: { covered: lines, total: 100, percent: lines }, branches: { covered: 0, total: 0, percent: 100 } },
    };
  }

  it("says a module with no tests has none, and only that", () => {
    expect(moduleTestShortfalls({ testCount: 0, testRun: null })).toEqual([{ reason: "no_tests" }]);
    // A run of zero cases after the last was deleted is still no tests, not 0% coverage on top.
    expect(moduleTestShortfalls({ testCount: 0, testRun: run([], 0) })).toEqual([{ reason: "no_tests" }]);
    // A view from before the count existed reads as none.
    expect(moduleTestShortfalls({ testRun: null })).toEqual([{ reason: "no_tests" }]);
  });

  it("names failing cases and low coverage, each as its own reason", () => {
    const shortfalls = moduleTestShortfalls({ testCount: 2, testRun: run([{ passed: true, description: "merges" }, { passed: false, description: "waits for CI" }], 64) });
    expect(shortfalls).toEqual([
      { reason: "failing", failing: ["waits for CI"] },
      { reason: "coverage", lineCoverage: 64 },
    ]);
    expect(shortfalls.map(describeModuleTestShortfall)).toEqual(["1 failing case", "64% line coverage, under 80%"]);
  });

  it("is satisfied at exactly 80% with every case passing", () => {
    expect(moduleTestShortfalls({ testCount: 1, testRun: run([{ passed: true, description: "merges" }], 80) })).toEqual([]);
    expect(moduleTestShortfalls({ testCount: 1, testRun: run([{ passed: true, description: "merges" }], 79.9) })).toEqual([{ reason: "coverage", lineCoverage: 79.9 }]);
  });

  it("calls cases that have not run yet unmeasured coverage, not no tests", () => {
    const shortfalls = moduleTestShortfalls({ testCount: 3, testRun: null });
    expect(shortfalls).toEqual([{ reason: "coverage", lineCoverage: null }]);
    expect(describeModuleTestShortfall(shortfalls[0]!)).toBe("coverage not measured yet");
    expect(describeModuleTestShortfall({ reason: "no_tests" })).toBe("no tests");
    expect(describeModuleTestShortfall({ reason: "failing", failing: ["a", "b"] })).toBe("2 failing cases");
  });
});
