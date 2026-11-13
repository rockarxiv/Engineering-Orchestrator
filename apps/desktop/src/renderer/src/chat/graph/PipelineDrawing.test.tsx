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
    moduleVersion: null,
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

  it("shows the module version a script step pins in its head, and nothing on a step that pins none (EO-770)", () => {
    const pinned = STEPS.map((each) => (each.id === "merge" ? { ...each, moduleVersion: 4 } : each));
    const { box } = draw({ steps: pinned });
    expect(box("merge").querySelector("[data-module-version]")).toHaveTextContent("v4");
    expect(box("todo").querySelector("[data-module-version]")).toBeNull();
  });

  it("is one row on a raised hairline box: no owner line under the name, only the entry note on the entry step", () => {
    const { box } = draw({ entryNote: "Needs a description." });

    for (const id of ["worktree", "todo", "qa", "merge"]) {
      // The name's row, and nothing else but the entry step's note.
      expect(box(id).children, id).toHaveLength(id === "worktree" ? 2 : 1);
      expect(box(id).className, id).toContain("rounded-[10px]");
    }
    // EO's own step is raised on the hairline; the others are in their owner's lane (EO-685).
    expect(box("worktree").className.split(" ")).toEqual(expect.arrayContaining(["bg-canvas-raised", "border-line"]));
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
    const { box } = draw({ loads: new Map([["todo", { running: 1, idle: 1 }]]), stepHref: (id) => `/board?step=${id}` });

    const link = within(box("todo")).getByRole("link", { name: "2 here" });
    expect(link).toHaveAttribute("href", "/board?step=todo");
    // Beside the chip, at the far end of the name's row.
    expect(link.parentElement).toBe(box("todo").querySelector("[data-step-kind]")!.parentElement);
    expect(link.parentElement!.className).toContain("ml-auto");
    // A small pill in the ink (EO-685).
    expect(link.className.split(" ")).toEqual(expect.arrayContaining(["rounded-full", "border-line-strong", "text-ink"]));
  });

  it("draws every chip as a neutral pill whose only colour is its dot, and EO's dot a hollow ring (EO-685)", () => {
    const { graph, box } = draw();
    const chip = (id: string) => box(id).querySelector<HTMLElement>("[data-step-kind]")!;
    const dot = (id: string) => chip(id).querySelector<HTMLElement>("[data-step-kind-dot]")!;

    for (const id of ["worktree", "todo", "qa", "merge"]) {
      expect(chip(id).className.split(" "), id).toEqual(expect.arrayContaining(["rounded-full", "border-line-strong", "text-ink-muted"]));
      // No tinted fill, and no colour on the pill itself.
      expect(chip(id).className, id).not.toMatch(/\bbg-|kind-|paused/);
      expect(dot(id), id).toHaveAttribute("aria-hidden");
      expect(dot(id).className, id).toContain("size-[7px]");
    }
    expect(dot("todo").className).toContain("bg-kind-agent");
    expect(dot("qa").className).toContain("bg-paused");
    expect(dot("merge").className).toContain("bg-kind-script");
    // EO: a hollow 1.5px ring in the subtle ink.
    expect(dot("worktree").className).toContain("border-[1.5px]");
    expect(dot("worktree").className).toContain("border-ink-subtle");
    expect(dot("worktree").className).not.toMatch(/\bbg-/);
    // Never the accent, and no status colour but paused for a person.
    const chips = [...graph.querySelectorAll("[data-step-kind]")].map(colours).join(" ");
    expect(chips).not.toMatch(/accent|running|reviewing|danger|warning|success|idle/);
  });

  it("draws a step an agent, a person or a script owns with its kind's edge on the neutral surface, and EO's and the end neutral (EO-685, EO-694)", () => {
    const { box } = draw();
    const classes = (id: string) => box(id).className;

    for (const [id, colour] of [
      ["todo", "--color-kind-agent"],
      ["qa", "--color-paused"],
      ["merge", "--color-kind-script"],
    ] as const) {
      // The neutral raised surface on the hairline, with no fill or outline tint (EO-694)…
      expect(classes(id).split(" "), id).toEqual(expect.arrayContaining(["bg-canvas-raised", "border-line"]));
      expect(classes(id), id).not.toContain("color-mix");
      // …and a 4px edge down the left in the kind.
      expect(classes(id), id).toContain(`[--lane-edge:var(${colour})]`);
      expect(classes(id), id).toContain("shadow-[inset_4px_0_0_var(--lane-edge)]");
    }
    // EO's own step: today's neutral surface, with a strong-line edge.
    expect(classes("worktree")).not.toContain("color-mix");
    expect(classes("worktree")).toContain("[--lane-edge:var(--color-line-strong)]");
    expect(classes("worktree")).toContain("shadow-[inset_4px_0_0_var(--lane-edge)]");
    // An end: outlined as before, no tint and no edge.
    expect(classes("done")).not.toContain("color-mix");
    expect(classes("done")).not.toContain("lane-edge");
  });

  it("keeps a chosen step's owner edge beside the accent outline", () => {
    const { box } = draw({ selectedStepId: "todo", onSelectStep: () => {} });

    expect(box("todo").className).toContain("shadow-[inset_4px_0_0_var(--lane-edge),inset_0_0_0_1.5px_var(--color-accent)]");
    expect(box("todo").className).toContain("[--lane-edge:var(--color-kind-agent)]");
    expect(box("qa").className).toContain("shadow-[inset_4px_0_0_var(--lane-edge)]");
    expect(box("qa").className).not.toContain("--color-accent");
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

describe("the load strip on a step (EO-686)", () => {
  it("is a 3px bar 12px in from each side, a segment per state in the state's colour, as wide as its count", () => {
    const { box } = draw({ loads: new Map([["todo", { idle: 1, running: 3, danger: 2, reviewing: 1, paused: 1 }]]), stepHref: (id) => `/board?step=${id}` });

    const strip = box("todo").querySelector<HTMLElement>("[data-load-strip]")!;
    expect(strip.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "left-3", "right-3", "h-[3px]"]));
    const segments = [...strip.children] as HTMLElement[];
    // What wants looking at first, first.
    expect(segments.map((one) => [one.getAttribute("data-load"), one.style.flexGrow, one.getAttribute("title")])).toEqual([
      ["danger", "2", "2 failed"],
      ["paused", "1", "1 waiting"],
      ["reviewing", "1", "1 in review"],
      ["running", "3", "3 running"],
      ["idle", "1", "1 idle"],
    ]);
    expect(segments.map((one) => one.className.match(/\bbg-[a-z]+/)?.[0])).toEqual(["bg-danger", "bg-paused", "bg-reviewing", "bg-running", "bg-idle"]);
    expect(within(box("todo")).getByRole("link", { name: "8 here" })).toBeInTheDocument();
  });

  it("is drawn on no step that holds nothing, and on none at all in a draft", () => {
    const { graph } = draw({ loads: new Map([["qa", {}]]) });
    expect(graph.querySelectorAll("[data-load-strip]")).toHaveLength(0);
  });
});

describe("a route's colour (EO-686)", () => {
  const routes: StepRouteView[] = [
    ...ROUTES,
    { ...ROUTES[0]!, id: "back", fromStepId: "merge", resultKey: "conflict", label: "Conflicts", tone: "warning", target: "todo" },
    { ...ROUTES[0]!, id: "you", fromStepId: "todo", resultKey: "failed", label: "Could not open", tone: "danger", target: "user_attention" },
    { ...ROUTES[0]!, id: "red", fromStepId: "qa", resultKey: "broken", label: "Broke", tone: "danger", target: "todo" },
    { ...ROUTES[0]!, id: "end", fromStepId: "qa", resultKey: "dropped", label: "Dropped", tone: "warning", target: "terminal" },
  ];

  it("is amber only where it lands with you, red for a failure, neutral for a send-back and plain otherwise", () => {
    const { container } = render(
      <MemoryRouter>
        <PipelineDrawing steps={STEPS} routes={routes} entryStepId="worktree" />
      </MemoryRouter>,
    );
    const line = (id: string) => container.querySelector(`[data-route="${id}"]`)!;

    expect(line("you")).toHaveClass("text-paused");
    expect(screen.getByText("Could not open")).toHaveClass("text-paused");
    expect(line("red")).toHaveClass("text-danger");
    expect(screen.getByText("Broke")).toHaveClass("text-danger");
    expect(line("back")).toHaveClass("text-ink-subtle/70");
    expect(screen.getByText("Conflicts")).toHaveClass("text-ink-subtle");
    expect(line("r0")).toHaveClass("text-line-strong");
    // A warning out to the end is not waiting on anyone: plain, and its marker dashed as ever.
    expect(line("end")).toHaveClass("text-line-strong");
    expect(screen.getByText("the end")).toHaveClass("border-dashed", "text-ink-muted");
    // Where it lands with you, the marker is solid on a light amber fill.
    expect(screen.getByText("you")).toHaveClass("border-solid", "text-paused");
    expect(screen.getByText("you").className).toContain("bg-[color:color-mix(in_oklab,var(--color-canvas),var(--color-paused)_16%)]");
  });
});
