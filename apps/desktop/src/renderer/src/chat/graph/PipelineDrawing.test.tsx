import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PipelineStepView, StepRouteView } from "@eo/core";
import { PipelineDrawing } from "./PipelineDrawing";

function step(id: string, name: string, position: number, overrides: Partial<PipelineStepView> = {}): PipelineStepView {
  return {
    id,
    pipelineId: "p",
    position,
    name,
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
    instructionsSummary: null,
    isTerminal: false,
    workspaceMode: "isolated",
    workspaceId: null,
    planMode: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    results: [],
    ...overrides,
  };
}

/** One step of every kind, and an end. */
const STEPS = [
  step("worktree", "Worktree", 0, { type: "builtin", ownerRole: null, entryAction: "create_worktree" }),
  step("todo", "To Do", 1),
  step("qa", "QA by hand", 2, { type: "user", ownerRole: null, entryAction: null }),
  step("merge", "Merge", 3, { type: "module", ownerRole: null, entryAction: "merge_branch" }),
  step("done", "Done", 4, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
];

const ROUTES: StepRouteView[] = STEPS.slice(0, -1).map((from, index) => ({
  id: `r${index}`,
  pipelineId: "p",
  fromStepId: from.id,
  resultKey: `next_${index}`,
  label: `Next ${index}`,
  tone: "info",
  target: STEPS[index + 1]!.id,
  position: index,
}));

function draw(props: Partial<Parameters<typeof PipelineDrawing>[0]> = {}) {
  render(
    <MemoryRouter>
      <PipelineDrawing steps={STEPS} routes={ROUTES} entryStepId="worktree" {...props} />
    </MemoryRouter>,
  );
  const graph = screen.getByRole("list", { name: "Pipeline graph" });
  const box = (id: string) => graph.querySelector(`[data-step="${id}"]`) as HTMLElement;
  return { graph, box };
}

/** The colour utilities on an element and everything in it. */
const colours = (element: Element) => [element, ...element.querySelectorAll("*")].flatMap((one) => [...one.classList]).join(" ");

describe("a step in the pipeline drawing (EO-680)", () => {
  it("shows one kind chip per working step, titled with its owner line, and none on an end", () => {
    const { box } = draw();
    const chips = (id: string) => [...box(id).querySelectorAll("[data-step-kind]")];

    for (const [id, text, title] of [
      ["worktree", "EO", "built in · create_worktree"],
      ["todo", "agent", "agent · implementer"],
      ["qa", "person", "you"],
      ["merge", "script", "module · merge_branch"],
    ] as const) {
      expect(chips(id), id).toHaveLength(1);
      expect(chips(id)[0]).toHaveTextContent(text);
      expect(chips(id)[0]).toHaveAttribute("title", title);
      expect(chips(id)[0]!.className, id).toContain("font-mono");
    }
    expect(chips("done")).toHaveLength(0);
  });

  it("is one row on a raised hairline box: no owner line under the name, only the entry note on the entry step", () => {
    const { box } = draw({ entryNote: "Needs a description." });

    for (const id of ["worktree", "todo", "qa", "merge"]) {
      // The name's row, and nothing else but the entry step's note.
      expect(box(id).children, id).toHaveLength(id === "worktree" ? 2 : 1);
      expect(box(id).className, id).toContain("bg-canvas-raised");
      expect(box(id).className, id).toContain("border-line");
      expect(box(id).className, id).toContain("rounded-[10px]");
    }
    // The owner line is the chip's title now, never text in the box.
    expect(within(box("todo")).queryByText("agent · implementer")).not.toBeInTheDocument();
    expect(within(box("worktree")).queryByText("built in · create_worktree")).not.toBeInTheDocument();
    expect(within(box("worktree")).getByText("Needs a description.")).toBeInTheDocument();
    expect(within(box("worktree")).getByText("Worktree").className).toContain("text-[15px]");
    expect(within(box("worktree")).getByText("Worktree").className).toContain("font-semibold");
    // An end is outlined, not filled.
    expect(box("done").className).not.toContain("bg-canvas-raised");
    expect(box("done").className).toContain("border-line-strong");
  });

  it("puts \"N here\" and the chip at the right of the row, the count a link to the narrowed board", () => {
    const { box } = draw({ counts: new Map([["todo", 2]]), stepHref: (id) => `/board?step=${id}` });

    const link = within(box("todo")).getByRole("link", { name: "2 here" });
    expect(link).toHaveAttribute("href", "/board?step=todo");
    // Beside the chip, at the far end of the name's row.
    expect(link.parentElement).toBe(box("todo").querySelector("[data-step-kind]")!.parentElement);
    expect(link.parentElement!.className).toContain("ml-auto");
  });

  it("draws neither a kind nor anything else in the accent, nor any status colour but paused for a person", () => {
    const { graph, box } = draw();

    const chips = [...graph.querySelectorAll("[data-step-kind]")].map((chip) => chip.className).join(" ");
    expect(chips).not.toMatch(/accent|running|reviewing|danger|warning|success|idle/);
    expect(box("qa").querySelector("[data-step-kind]")!.className).toContain("text-paused");
    for (const id of ["worktree", "todo", "merge"]) expect(box(id).querySelector("[data-step-kind]")!.className, id).not.toContain("paused");
    expect(box("todo").querySelector("[data-step-kind]")!.className).toContain("text-kind-agent");
    expect(box("merge").querySelector("[data-step-kind]")!.className).toContain("text-kind-script");
    expect(box("worktree").querySelector("[data-step-kind]")!.className).toContain("text-ink-subtle");
  });

  it("marks only the steps it is told are new, dashed in the neutral ink and tagged", () => {
    const { graph, box } = draw({ newStepIds: new Set(["qa"]) });

    expect([...graph.querySelectorAll("[data-new-step]")].map((one) => one.getAttribute("data-step"))).toEqual(["qa"]);
    expect(box("qa").className).toContain("border-dashed");
    expect(box("qa").className).toContain("border-ink-muted");
    expect(within(box("qa")).getByText("new")).toBeInTheDocument();
    expect(colours(box("qa"))).not.toMatch(/accent/);
    for (const id of ["worktree", "todo", "merge", "done"]) {
      expect(box(id).className, id).not.toContain("border-dashed");
      expect(within(box(id)).queryByText("new"), id).not.toBeInTheDocument();
    }
  });

  it("marks nothing when it is told of no new steps", () => {
    const { graph } = draw();

    expect(graph.querySelectorAll("[data-new-step]")).toHaveLength(0);
    expect(within(graph).queryByText("new")).not.toBeInTheDocument();
  });
});
