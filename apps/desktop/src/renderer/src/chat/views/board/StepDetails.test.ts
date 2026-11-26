import type { PipelineStepView, StepRouteView } from "@eo/core";
import { describe, expect, it } from "vitest";
import { resultRows } from "./StepDetails";

function step(id: string, name: string, position: number): PipelineStepView {
  return {
    id,
    pipelineId: "default",
    position,
    name,
    type: "agent",
    agentId: "agent-reviewer",
    entryAction: "review",
    instructionsSummary: null,
    isTerminal: false,
    workspaceMode: "isolated",
    workspaceId: null,
    planMode: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    results: [],
    moduleVersion: null,
    brief: null,
  };
}

const route = (resultKey: string, label: string, target: string, traversalLimit: number | null): StepRouteView => ({
  id: `r-${resultKey}`,
  pipelineId: "default",
  fromStepId: "review",
  resultKey,
  label,
  tone: "warning",
  target,
  position: 0,
  traversalLimit,
});

describe("a step's results on the Graph view", () => {
  it("says a route's traversal limit where it has one, and nothing more where it has none (EO-921)", () => {
    const steps = [step("todo", "To Do", 0), step("review", "Review", 1), step("merge", "Merge Request", 2)];
    const rows = resultRows(steps[1]!, steps, [route("changes_requested", "Changes requested", "todo", 4), route("approved", "Approved", "merge", null)], [], null, (key) => key);
    expect(rows.map((row) => row.goes)).toEqual(["To Do — at most 4 times since a person last commented, then EO holds it and asks", "Merge Request"]);
  });
});
