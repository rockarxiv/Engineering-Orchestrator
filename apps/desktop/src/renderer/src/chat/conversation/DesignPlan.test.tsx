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
  return { stepId, name, mode: "real", reason: null, reaches: null, mocks: [], team: null };
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

  it("labels a mocked team as mocked and not tested, and a real one as running for real (EO-848)", () => {
    const steps = [
      { ...planned("draft", "Draft"), team: { coordination: "independent" as const, tested: true, note: "Runs as an independent team for real." } },
      { ...planned("match", "Match PO"), mode: "mocked" as const, team: { coordination: "leader" as const, tested: false, note: "Mocked — the team does not run." } },
    ];
    render(<DesignPlan trial={{ ...TRIAL, steps }} steps={STEPS} />);
    const row = (name: string) => within(screen.getByRole("region", { name: "How each step runs" })).getByText(name).closest("li")!;

    expect(row("Draft")).toHaveTextContent("team · runs for real");
    expect(row("Draft")).toHaveTextContent("Runs as an independent team for real.");
    expect(row("Match PO")).toHaveTextContent("team · mocked, not tested");
    expect(row("Match PO")).not.toHaveTextContent("runs for real");
    expect(row("Match PO")).toHaveTextContent("Mocked — the team does not run.");
  });

  it("guesses no kind for a step the draft does not draw", () => {
    render(<DesignPlan trial={{ ...TRIAL, steps: [planned("gone", "Gone")] }} steps={STEPS} />);

    expect(chipOf("Gone")).toBeNull();
  });
});
