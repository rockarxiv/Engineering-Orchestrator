import { describe, expect, it } from "vitest";
import { remapStepReferences, type StepBrief } from "./stepBrief.js";

/** Every step reference inside a step, through one id mapping (EO-831). */
describe("remapStepReferences", () => {
  const ids = new Map([
    ["draft-a", "trial-a"],
    ["draft-b", "trial-b"],
  ]);
  const mapped = (id: string): string => ids.get(id) ?? id;

  it("moves the step an output part names, and leaves comment and field parts alone", () => {
    const brief: StepBrief = [{ show: "output", step: "draft-a" }, { show: "comment", kind: "approval", role: "reviewer" }, { show: "field", field: "customer" }, { show: "output", step: "draft-b" }];
    const step = { id: "draft-c", name: "Decide", brief };
    expect(remapStepReferences(step, mapped)).toEqual({
      id: "draft-c",
      name: "Decide",
      brief: [{ show: "output", step: "trial-a" }, { show: "comment", kind: "approval", role: "reviewer" }, { show: "field", field: "customer" }, { show: "output", step: "trial-b" }],
    });
  });

  it("leaves a step it does not know as the mapping answers, and does not touch the step it was given", () => {
    const step = { brief: [{ show: "output", step: "elsewhere" }] as StepBrief };
    const moved = remapStepReferences(step, mapped);
    expect(moved.brief).toEqual([{ show: "output", step: "elsewhere" }]);
    const original = { brief: [{ show: "output", step: "draft-a" }] as StepBrief };
    remapStepReferences(original, mapped);
    expect(original.brief).toEqual([{ show: "output", step: "draft-a" }]);
  });

  it("keeps a step that declares no brief declaring none, absent or null", () => {
    expect(remapStepReferences({ id: "x", brief: null }, mapped)).toEqual({ id: "x", brief: null });
    const undeclared: { id: string; brief?: StepBrief } = { id: "x" };
    expect(remapStepReferences(undeclared, mapped)).toEqual({ id: "x" });
  });
});
