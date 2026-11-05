import { describe, expect, it } from "vitest";
import {
  CONSOLIDATION_OVERRIDE_KEYS,
  SIDE_CALL_FAILURE_REASONS,
  SIDE_CALL_MODELS,
  SIDE_CALL_PURPOSES,
  SIDE_CALL_SPEND_GROUPS,
  sideCallModelOfSystemAgent,
  spendGroupOf,
} from "./side-calls.js";

describe("side calls (EO-477)", () => {
  it("puts every purpose in exactly one spend line, so no side call's cost is spend nobody can name", () => {
    for (const purpose of SIDE_CALL_PURPOSES) {
      const groups = Object.values(SIDE_CALL_SPEND_GROUPS).filter((group) => (group.purposes as readonly string[]).includes(purpose));
      expect(groups, purpose).toHaveLength(1);
    }
    expect(SIDE_CALL_PURPOSES.map(spendGroupOf)).toEqual(["memory_upkeep", "memory_upkeep", "memory_upkeep"]);
    expect(SIDE_CALL_SPEND_GROUPS.memory_upkeep.label).toBe("Memory upkeep");
  });

  it("fails in the seven ways EO-477 and EO-509 name, and no other", () => {
    expect(SIDE_CALL_FAILURE_REASONS).toEqual(["timeout", "schema", "budget", "quota", "signed_out", "sign_in_unreachable", "error"]);
  });

  it("runs selection and extraction on the small model and consolidation on the system agent's (EO-578)", () => {
    expect(Object.keys(SIDE_CALL_MODELS).sort()).toEqual([...SIDE_CALL_PURPOSES].sort());
    expect(SIDE_CALL_MODELS).toEqual({ memory_select: "small", memory_extract: "small", memory_consolidate: "system_agent" });
  });
});

describe("the system agent's consolidation override (EO-578)", () => {
  const agent = { model: "agent-model", reasoningEffort: "medium" };
  const override = (model: unknown, reasoningEffort: unknown): Record<string, unknown> => ({
    ...(model === undefined ? {} : { [CONSOLIDATION_OVERRIDE_KEYS.model]: model }),
    ...(reasoningEffort === undefined ? {} : { [CONSOLIDATION_OVERRIDE_KEYS.reasoningEffort]: reasoningEffort }),
  });

  // Every combination: each field set, empty or absent, over an agent
  // that names a model and an effort and over one that names neither.
  it.each([
    { model: undefined, effort: undefined, expected: { model: "agent-model", reasoningEffort: "medium" } },
    { model: "big", effort: undefined, expected: { model: "big", reasoningEffort: "medium" } },
    { model: undefined, effort: "xhigh", expected: { model: "agent-model", reasoningEffort: "xhigh" } },
    { model: "big", effort: "xhigh", expected: { model: "big", reasoningEffort: "xhigh" } },
    { model: "", effort: "  ", expected: { model: "agent-model", reasoningEffort: "medium" } },
    { model: null, effort: null, expected: { model: "agent-model", reasoningEffort: "medium" } },
    { model: " big ", effort: "", expected: { model: "big", reasoningEffort: "medium" } },
  ])("model $model and effort $effort over the agent's own", ({ model, effort, expected }) => {
    expect(sideCallModelOfSystemAgent(agent, override(model, effort))).toEqual(expected);
  });

  it.each([
    { model: undefined, effort: undefined, expected: { model: null, reasoningEffort: null } },
    { model: "big", effort: undefined, expected: { model: "big", reasoningEffort: null } },
    { model: undefined, effort: "high", expected: { model: null, reasoningEffort: "high" } },
    { model: "big", effort: "high", expected: { model: "big", reasoningEffort: "high" } },
  ])("model $model and effort $effort over an agent on the backend's defaults", ({ model, effort, expected }) => {
    expect(sideCallModelOfSystemAgent({ model: null, reasoningEffort: null }, override(model, effort))).toEqual(expected);
  });

  it("follows the agent when it changes, for every field the override leaves empty", () => {
    const config = override("big", undefined);
    expect(sideCallModelOfSystemAgent({ model: "a", reasoningEffort: "low" }, config)).toEqual({ model: "big", reasoningEffort: "low" });
    expect(sideCallModelOfSystemAgent({ model: "b", reasoningEffort: "high" }, config)).toEqual({ model: "big", reasoningEffort: "high" });
  });
});
