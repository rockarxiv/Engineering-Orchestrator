import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineStepViewSchema } from "@eo/core";
import { runStatusOf } from "../../../shared/items/status";
import { Stepper } from "./Stepper";

const STEPS = ["Ready", "Implement", "Review", "Done"].map((name, position) =>
  PipelineStepViewSchema.parse({
    id: name.toLowerCase(),
    pipelineId: "p1",
    position,
    name,
    type: "agent",
    ownerRole: null,
    entryAction: null,
    instructionsSummary: null,
    isTerminal: name === "Done",
    planMode: false,
  }),
);

/** The stepper as the item page draws it: the current step in the latest run's state. */
function renderAt(latestRunStatus: string | null) {
  const state = runStatusOf(latestRunStatus);
  render(<Stepper steps={STEPS} currentId="implement" state={state.tone} stateLabel={state.label} />);
  const list = screen.getByRole("list", { name: "Pipeline steps" });
  const chip = (name: string) => within(list).getByText(name).parentElement!;
  return { list, chip, current: chip("Implement") };
}

function stateOf(list: HTMLElement): string {
  return list.style.getPropertyValue("--step-state");
}

describe("the item's step track (EO-689)", () => {
  it("draws the current step of a running run in running, never the accent", () => {
    const { list, current } = renderAt("running");
    expect(current.closest("li")).toHaveAttribute("aria-current", "step");
    expect(stateOf(list)).toBe("var(--color-running)");
    expect(current.querySelector("[data-state]")).toHaveAttribute("data-state", "running");
    expect(current.className).toContain("color-mix(in_oklab,var(--color-canvas-raised),var(--step-state)_18%)");
    expect(current.className).toContain("color-mix(in_oklab,var(--color-line),var(--step-state)_55%)");
    expect(current.className).toContain("text-ink");
    expect(current.className).toContain("font-semibold");
    expect(current.className).not.toMatch(/accent/);
    expect(within(current).getByText(", Active, Running")).toBeInTheDocument();
  });

  it("draws the current step of a failed run in danger", () => {
    const { list, current } = renderAt("failed");
    expect(stateOf(list)).toBe("var(--color-danger)");
    expect(current.querySelector("[data-state]")).toHaveAttribute("data-state", "danger");
    expect(current.className).not.toMatch(/accent/);
    expect(within(current).getByText(", Active, Failed")).toBeInTheDocument();
  });

  it("draws the current step in idle when nothing has run", () => {
    const { list, current } = renderAt(null);
    expect(stateOf(list)).toBe("var(--color-idle)");
    expect(current.querySelector("[data-state]")).toHaveAttribute("data-state", "idle");
    expect(current.className).not.toMatch(/accent/);
  });

  it("checks the steps walked in success, with a success connector up to the current step", () => {
    const { list, chip } = renderAt("running");
    const done = chip("Ready");
    expect(done.querySelector("svg")).toHaveClass("text-success");

    const connectors = [...list.querySelectorAll("li")].map((li) => li.querySelector(":scope > span[aria-hidden]"));
    // Into Implement (current) is walked; into Review and Done is not.
    expect(connectors[1]).toHaveClass("bg-success/65");
    expect(connectors[2]).not.toHaveClass("bg-success/65");
    expect(connectors[3]).not.toHaveClass("bg-success/65");
    expect(chip("Review").querySelector("svg")).toBeNull();
    expect(chip("Review").querySelector("[data-state]")).toBeNull();
  });
});
