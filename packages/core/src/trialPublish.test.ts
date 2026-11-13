import { describe, expect, it } from "vitest";
import { resolvedGraphChanges, type ResolvedGraph } from "./trialPublish.js";

/**
 * What the publish card says changed since the design was approved
 * (EO-588): every field of the resolved graph, not only what a draft
 * wrote — a setting inherited from the target is a change too.
 */
const step = (id: string, position: number, name: string, extra: Partial<ResolvedGraph["steps"][number]> = {}): ResolvedGraph["steps"][number] => ({
  id,
  pipelineId: "trial",
  position,
  name,
  type: "agent",
  ownerRole: "implementer",
  entryAction: "implement",
  instructionsSummary: "Fix it.",
  isTerminal: false,
  planMode: false,
  workspaceMode: "isolated",
  workspaceId: null,
  inputs: {},
  timeoutMs: null,
  watch: null,
  results: [],
  moduleVersion: null,
  ...extra,
});

const graph = (steps: ResolvedGraph["steps"], routes: Partial<ResolvedGraph["routes"][number]>[] = []): ResolvedGraph => ({
  steps,
  routes: routes.map((route, index) => ({ id: `r${index}`, pipelineId: "trial", fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "done", position: 0, ...route })),
  entryStepId: "fix",
});

const approved = graph([step("fix", 0, "Fix"), step("done", 1, "Done", { type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true })], [{}]);

describe("resolvedGraphChanges", () => {
  it("says nothing changed for the same graph", () => {
    expect(resolvedGraphChanges(approved, approved)).toEqual([]);
  });

  it("names a setting nobody wrote in a draft, such as a time limit inherited from the target", () => {
    const after = graph([step("fix", 0, "Fix", { timeoutMs: 60_000 }), approved.steps[1]!], [{}]);
    expect(resolvedGraphChanges(approved, after)).toEqual(['the time limit of "Fix": none → 60000']);
  });

  it("names a step that moved, and one that runs something else", () => {
    const after = graph([step("fix", 2, "Fix", { entryAction: "open_pull_request", type: "builtin" }), approved.steps[1]!], [{}]);
    expect(resolvedGraphChanges(approved, after)).toEqual(['"Fix" becomes a builtin step instead of a agent step', '"Fix" runs open_pull_request instead of implement', '"Fix" moves from position 0 to 2']);
  });

  it("names every other setting a step runs with, and a route's target, words and order", () => {
    const after = graph(
      [step("fix", 0, "Fix", { planMode: true, workspaceMode: "read", inputs: { branch: "main" } }), approved.steps[1]!],
      [{ label: "Finished", position: 1 }],
    );
    expect(resolvedGraphChanges(approved, after)).toEqual([
      'the plan mode of "Fix": false → true',
      'the workspace mode of "Fix": isolated → read',
      'the inputs of "Fix": {} → {"branch":"main"}',
      'the words of "done" on "Fix"',
      'the order of "done" on "Fix"',
    ]);
  });
});
