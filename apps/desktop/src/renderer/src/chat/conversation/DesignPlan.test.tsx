import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AssistTrialCard, PipelineStepView } from "@eo/core";
import { DesignPlan } from "./DesignPlan";

/**
 * The design card's plan (EO-587): each step's kind chip beside its
 * name (EO-681), read from the draft the graph above it draws, so the
 * list and the graph say the same thing about a step.
 */
type DrawnStep = Pick<PipelineStepView, "id" | "type" | "ownerRole" | "entryAction" | "isTerminal">;

const STEPS: DrawnStep[] = [
  { id: "draft", type: "agent", ownerRole: "writer", entryAction: "implement", isTerminal: false },
  { id: "match", type: "module", ownerRole: null, entryAction: "match_po", isTerminal: false },
  { id: "approve", type: "user", ownerRole: null, entryAction: null, isTerminal: false },
  { id: "done", type: "user", ownerRole: null, entryAction: null, isTerminal: true },
];

function planned(stepId: string, name: string): AssistTrialCard["steps"][number] {
  return { stepId, name, mode: "real", reason: null, reaches: null, mocks: [] };
}

const TRIAL: AssistTrialCard = {
  items: [],
  steps: [planned("draft", "Draft"), planned("match", "Match PO"), planned("approve", "Approve"), planned("done", "Done")],
  modules: [],
  changes: [],
  problem: null,
  approved: null,
};

/** The kind chip on a step's row in "How each step runs", or null where it has none. */
function chipOf(name: string): HTMLElement | null {
  const list = screen.getByRole("region", { name: "How each step runs" });
  const row = within(list).getByText(name).closest("li")!;
  return row.querySelector<HTMLElement>("[data-step-kind]");
}

describe("the design card's plan", () => {
  it("shows each step's kind beside its name: agent, script and person", () => {
    render(<DesignPlan trial={TRIAL} steps={STEPS} />);

    expect(chipOf("Draft")).toHaveTextContent("agent");
    expect(chipOf("Draft")).toHaveAttribute("title", "agent · writer");
    expect(chipOf("Match PO")).toHaveTextContent("script");
    expect(chipOf("Approve")).toHaveTextContent("person");
  });

  it("gives where work ends no chip", () => {
    render(<DesignPlan trial={TRIAL} steps={STEPS} />);

    expect(chipOf("Done")).toBeNull();
  });

  it("guesses no kind for a step the draft does not draw", () => {
    render(<DesignPlan trial={{ ...TRIAL, steps: [planned("gone", "Gone")] }} steps={STEPS} />);

    expect(chipOf("Gone")).toBeNull();
  });
});
