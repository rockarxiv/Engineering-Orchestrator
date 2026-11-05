import { describe, expect, it } from "vitest";
import { isMockedOutput, MOCKED_OUTPUT_MARK, mockedOutputBody, TrialPlanSchema } from "./trialPlan.js";

/** The trial plan (EO-584): a mode per step, and for a mocked step a result and output per trial item. */
describe("TrialPlanSchema", () => {
  it("holds where each test item must end, with the person's words optional (EO-586)", () => {
    expect(TrialPlanSchema.parse({ expected: [{ itemId: "i1", stepId: "done" }] })).toEqual({ steps: [], expected: [{ itemId: "i1", stepId: "done", criteria: null }] });
    expect(TrialPlanSchema.safeParse({ expected: [{ itemId: "i1", stepId: "" }] }).success).toBe(false);
  });

  it("holds a mode per step and, for a mocked step, a result key and output per trial item", () => {
    const plan = TrialPlanSchema.parse({
      steps: [
        { stepId: "fix", mode: "real" },
        { stepId: "notify", mode: "redirected" },
        { stepId: "deploy", mode: "mocked", mocks: [{ itemId: "item-1", resultKey: "deployed", output: "Deployed to staging." }] },
      ],
    });
    expect(plan.steps.map((step) => step.mode)).toEqual(["real", "redirected", "mocked"]);
    // Absent mocks are none, so a real or redirected step need not say so.
    expect(plan.steps[0]!.mocks).toEqual([]);
    expect(plan.steps[2]!.mocks).toEqual([{ itemId: "item-1", resultKey: "deployed", output: "Deployed to staging." }]);
  });

  it("is every step real when it says nothing", () => {
    expect(TrialPlanSchema.parse({})).toEqual({ steps: [], expected: [] });
  });

  it("refuses a mode that is not one of the three, and a mock with no result key", () => {
    expect(TrialPlanSchema.safeParse({ steps: [{ stepId: "fix", mode: "skipped" }] }).success).toBe(false);
    expect(TrialPlanSchema.safeParse({ steps: [{ stepId: "fix", mode: "mocked", mocks: [{ itemId: "item-1", resultKey: "", output: "" }] }] }).success).toBe(false);
  });
});

describe("a mocked step's output", () => {
  it("opens with the mark and says which result it reports", () => {
    const body = mockedOutputBody("Deploy", "deployed", "Deployed to staging.");
    expect(body.startsWith(MOCKED_OUTPUT_MARK)).toBe(true);
    expect(body).toContain('"Deploy" report `deployed`');
    expect(body.endsWith("Deployed to staging.")).toBe(true);
  });

  it("is a mark only on EO's own output comment, so nobody else can forge one", () => {
    const body = mockedOutputBody("Deploy", "deployed", "");
    expect(isMockedOutput({ authorType: "engine", kind: "output", body })).toBe(true);
    expect(isMockedOutput({ authorType: "agent", kind: "output", body })).toBe(false);
    expect(isMockedOutput({ authorType: "engine", kind: "note", body })).toBe(false);
    expect(isMockedOutput({ authorType: "engine", kind: "output", body: "Deployed." })).toBe(false);
  });
});
