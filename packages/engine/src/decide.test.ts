import type { PipelineStep, StepResult, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { decisionRefusal } from "./decide.js";

function result(overrides: Partial<StepResult> = {}): StepResult {
  return { key: "approved", label: "Approve", tone: "success", requiresComment: false, ...overrides };
}

function step(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: "sign_off",
    pipelineId: "p1" as Uuid,
    position: 3,
    name: "Sign-off",
    type: "user",
    ownerRole: null,
    entryAction: null,
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated" as const,
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    moduleVersion: null,
    results: [result(), result({ key: "send_back", label: "Send back", tone: "warning", requiresComment: true })],
    ...overrides,
  };
}

/**
 * What a person may decide, judged before anything is written (EO-310).
 *
 * Each refusal is tested for what it *says*, not merely that it refuses.
 * The sentence is the whole point: a client cannot see the screen, and
 * "cannot decide" is an answer it can only respond to by guessing —
 * which is how a decision that was one corrected key away becomes three
 * more calls.
 */
describe("deciding on a step", () => {
  it("allows a declared result that needs no reason", () => {
    expect(decisionRefusal({ step: step(), resultKey: "approved", comment: "" })).toBeNull();
  });

  it("allows one that needs a reason once there is one", () => {
    expect(decisionRefusal({ step: step(), resultKey: "send_back", comment: "The Q3 number is wrong." })).toBeNull();
  });

  it("refuses an item on no step at all", () => {
    expect(decisionRefusal({ step: undefined, resultKey: "approved", comment: "" })).toBe(
      "This item is not on a pipeline step, so there is nothing to decide. Nothing has changed.",
    );
  });

  it("refuses a step an agent acts on, saying what acts there", () => {
    const agentStep = step({ name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", results: [] });
    expect(decisionRefusal({ step: agentStep, resultKey: "approved", comment: "" })).toBe(
      '"Review" is not a step a person decides on — it is dispatched to an agent, which reports its own result. Nothing has changed.',
    );
  });

  it("refuses a builtin step in its own words", () => {
    const builtin = step({ name: "Index", type: "builtin", entryAction: "index_repository", results: [] });
    expect(decisionRefusal({ step: builtin, resultKey: "approved", comment: "" })).toContain("run by EO itself");
  });

  /**
   * The keys *and* the labels, because the caller sends a key and the
   * person reads a label — a refusal naming only one of them leaves
   * whichever of the two is asking to translate.
   */
  it("refuses an undeclared key and lists what the step does offer", () => {
    expect(decisionRefusal({ step: step(), resultKey: "reject", comment: "" })).toBe(
      '"reject" is not one of the results "Sign-off" declares (approved (Approve), send_back (Send back)). Nothing has changed.',
    );
  });

  it("says the step has no decision at all when it declares none", () => {
    expect(decisionRefusal({ step: step({ results: [] }), resultKey: "approved", comment: "" })).toBe(
      '"Sign-off" declares no results, so there is nothing to decide there yet. Ask the assistant to give the step its results first. Nothing has changed.',
    );
  });

  it("refuses a missing reason by the name of the button that needs one", () => {
    expect(decisionRefusal({ step: step(), resultKey: "send_back", comment: "" })).toBe(
      '"Send back" needs a comment saying why — it is how the reason reaches the next step. Say what is wrong and decide again. Nothing has changed.',
    );
  });

  /** Whitespace is not a reason. A space bar is not "the Q3 number is wrong". */
  it("refuses a reason that is only whitespace", () => {
    expect(decisionRefusal({ step: step(), resultKey: "send_back", comment: "   \n  " })).toContain("needs a comment saying why");
  });

  /**
   * The key is checked before the reason. A caller that sent both wrong
   * would otherwise be told to write a reason for a result that does not
   * exist, and would write one.
   */
  it("names the key before the missing reason when both are wrong", () => {
    expect(decisionRefusal({ step: step(), resultKey: "nope", comment: "" })).toContain('"nope" is not one of the results');
  });
});
