import { describe, expect, it } from "vitest";
import type { HandOffTargets, PipelineStepView, StepRouteView } from "@eo/core";
import { BOX_MAX_WIDTH, BOX_PAD_X, HERE_ROOM, KIND_CHIP_ROOM, NAME_CHAR, START_BADGE, layoutPipeline, packLanes, type LaidArrow, type PipelineLayout, type Point, type Rect } from "./layout";

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

let made = 0;
function route(fromStepId: string, label: string, target: string, tone: StepRouteView["tone"] = "info"): StepRouteView {
  made += 1;
  return { id: `r${made}`, pipelineId: "p", fromStepId, resultKey: label.toLowerCase().replace(/\W+/g, "_"), label, tone, target, position: made };
}

const ELSEWHERE: HandOffTargets[] = [{ pipelineId: "delivery", pipelineName: "Delivery", steps: [step("d-todo", "To Do", 0, { pipelineId: "delivery" })] }];

/** Release's shape: 8 steps and 17 routes — the straight line, send-backs, a skip, and every kind of exit. */
const RELEASE_STEPS = [
  step("prepare", "Prepare release", 0, { ownerRole: "release manager" }),
  step("changelog", "Write changelog", 1, { ownerRole: "writer" }),
  step("checks", "Run release checks", 2, { type: "module", ownerRole: null, entryAction: "release_checks" }),
  step("approve", "Approve release", 3, { type: "user", ownerRole: null, entryAction: null }),
  step("merge", "Merge release branch", 4, { type: "module", ownerRole: null, entryAction: "release_merge" }),
  step("tag", "Tag", 5, { type: "module", ownerRole: null, entryAction: "release_tag" }),
  step("announce", "Announce", 6, { ownerRole: "writer" }),
  step("released", "Released", 7, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
];

const RELEASE_ROUTES = [
  route("prepare", "Prepared", "changelog"),
  route("prepare", "Nothing to release", "terminal"),
  route("prepare", "Needs input", "user_attention", "warning"),
  route("changelog", "Written", "checks"),
  route("changelog", "Needs input", "user_attention", "warning"),
  route("checks", "Passed", "approve", "success"),
  route("checks", "Failed", "changelog", "danger"),
  route("checks", "Could not run", "user_attention", "warning"),
  route("approve", "Approve", "merge", "success"),
  route("approve", "Send back", "changelog"),
  route("approve", "Start over", "prepare", "danger"),
  route("approve", "Cancel", "terminal", "danger"),
  route("merge", "Merged", "tag", "success"),
  route("merge", "Conflict", "d-todo", "danger"),
  route("tag", "Tagged", "announce", "success"),
  route("tag", "Tag exists", "approve", "danger"),
  route("announce", "Announced", "released", "success"),
];

/** Twelve steps, wired to crowd the lanes: nested and crossing send-backs, skips, a step routing to itself. */
const TWELVE_STEPS = Array.from({ length: 12 }, (_, index) => step(`s${index}`, `Step number ${index + 1}`, index, index === 11 ? { isTerminal: true } : {}));

const TWELVE_ROUTES = [
  ...Array.from({ length: 11 }, (_, index) => route(`s${index}`, `Done ${index + 1}`, `s${index + 1}`)),
  // Two results on to the next step.
  route("s3", "Skipped", "s4"),
  // Send-backs: adjacent, nested, crossing, and three landing on one step.
  route("s2", "Changes requested", "s1"),
  route("s5", "Rejected", "s1"),
  route("s8", "Start again", "s1"),
  route("s6", "Back to design", "s3"),
  route("s9", "Reopen", "s4"),
  route("s10", "Back to the very beginning of it all, with a long label", "s0"),
  route("s7", "Retry", "s7"),
  // Skips.
  route("s0", "Trivial", "s5"),
  route("s2", "Fast track", "s9"),
  route("s6", "No review needed", "s10"),
  // Exits.
  route("s4", "Needs input", "user_attention", "warning"),
  route("s4", "Abandoned", "terminal", "danger"),
  route("s4", "Hand to delivery", "d-todo"),
  route("s9", "Needs input", "user_attention", "warning"),
];

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Whether a straight stretch of an arrow runs through the inside of a rectangle. */
function crosses(a: Point, b: Point, rect: Rect): boolean {
  const inside = { x: rect.x + 0.5, y: rect.y + 0.5, width: rect.width - 1, height: rect.height - 1 };
  const line = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  // Every stretch is horizontal or vertical, so it is a rectangle with no thickness.
  return line.x <= inside.x + inside.width && inside.x <= line.x + line.width && line.y <= inside.y + inside.height && inside.y <= line.y + line.height;
}

const texts = (arrow: LaidArrow): Rect[] => (arrow.marker ? [arrow.label.rect, arrow.marker.rect] : [arrow.label.rect]);

function expectNothingOverlaps(layout: PipelineLayout) {
  const boxes = layout.steps.map((laid) => laid.box);
  const labels = layout.arrows.flatMap(texts);

  boxes.forEach((box, at) => boxes.slice(at + 1).forEach((other) => expect(overlaps(box, other), "two boxes").toBe(false)));
  labels.forEach((label, at) => {
    boxes.forEach((box) => expect(overlaps(label, box), "a label and a box").toBe(false));
    labels.slice(at + 1).forEach((other) => expect(overlaps(label, other), "two labels").toBe(false));
  });

  // Two side arrows whose spans overlap are in different lanes.
  const sides = layout.arrows.filter((arrow) => arrow.kind === "side");
  sides.forEach((arrow, at) =>
    sides.slice(at + 1).forEach((other) => {
      if (arrow.span![0] <= other.span![1] && other.span![0] <= arrow.span![1]) expect(arrow.lane, `${arrow.label.text} and ${other.label.text}`).not.toBe(other.lane);
    }),
  );

  // No arrow runs through a box or a label, and nothing is outside the drawing.
  for (const arrow of layout.arrows) {
    for (let at = 1; at < arrow.points.length; at += 1) {
      const [a, b] = [arrow.points[at - 1]!, arrow.points[at]!];
      boxes.forEach((box) => expect(crosses(a, b, box), `${arrow.label.text} through a box`).toBe(false));
      labels.forEach((label) => expect(crosses(a, b, label), `${arrow.label.text} through a label`).toBe(false));
    }
    for (const point of arrow.points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(layout.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(layout.height);
    }
  }
  for (const rect of [...boxes, ...labels]) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(layout.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(layout.height);
  }
}

describe("where a pipeline's boxes and arrows go", () => {
  it("lays out a pipeline of Release's shape with nothing overlapping", () => {
    expect(RELEASE_STEPS).toHaveLength(8);
    expect(RELEASE_ROUTES).toHaveLength(17);
    const layout = layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE);

    expect(layout.steps).toHaveLength(8);
    expect(layout.arrows).toHaveLength(17);
    expectNothingOverlaps(layout);
  });

  it("lays out twelve steps with crowded lanes with nothing overlapping", () => {
    const layout = layoutPipeline(TWELVE_STEPS, TWELVE_ROUTES, ELSEWHERE);

    expect(layout.steps).toHaveLength(12);
    expect(layout.arrows).toHaveLength(TWELVE_ROUTES.length);
    expectNothingOverlaps(layout);
    // The lanes were needed: this is not a fixture every arrow of which fits in one.
    expect(new Set(layout.arrows.map((arrow) => arrow.lane)).size).toBeGreaterThan(3);
  });

  it("stacks the boxes top to bottom in position order, whatever order they arrive in", () => {
    const layout = layoutPipeline([...RELEASE_STEPS].reverse(), RELEASE_ROUTES, ELSEWHERE);

    expect(layout.steps.map((laid) => laid.step.id)).toEqual(RELEASE_STEPS.map((one) => one.id));
    layout.steps.slice(1).forEach((laid, at) => {
      const above = layout.steps[at]!.box;
      expect(laid.box.y).toBeGreaterThan(above.y + above.height);
      expect(laid.box.x).toBe(above.x);
    });
  });

  it("draws a route to the next step straight down, landing on that step's top", () => {
    const layout = layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE);
    const arrow = layout.arrows.find((one) => one.label.text === "Prepared")!;
    const [from, to] = [layout.steps[0]!.box, layout.steps[1]!.box];

    expect(arrow).toMatchObject({ kind: "next", back: false, to: "Write changelog" });
    expect(arrow.points).toEqual([
      { x: from.x + from.width / 2, y: from.y + from.height },
      { x: to.x + to.width / 2, y: to.y },
    ]);
  });

  it("draws a send-back around the side and back up into the earlier step", () => {
    const layout = layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE);
    const arrow = layout.arrows.find((one) => one.label.text === "Start over")!;
    const [from, to] = [layout.steps[3]!.box, layout.steps[0]!.box];
    const [leaves, , , lands] = arrow.points;

    expect(arrow).toMatchObject({ kind: "side", back: true, to: "Prepare release" });
    expect(leaves!.x).toBe(from.x);
    expect(leaves!.y).toBeGreaterThan(from.y);
    expect(leaves!.y).toBeLessThan(from.y + from.height);
    // It ends on the earlier step's edge, above where it left.
    expect(lands!.x).toBe(to.x);
    expect(lands!.y).toBeGreaterThan(to.y);
    expect(lands!.y).toBeLessThan(to.y + to.height);
    expect(lands!.y).toBeLessThan(leaves!.y);
    // The arrowhead's tip is the landing end.
    expect(arrow.head.startsWith(`M ${lands!.x} ${lands!.y} `)).toBe(true);
  });

  it("draws a skip around the side to a later step, and a step's route to itself as going back", () => {
    const layout = layoutPipeline(TWELVE_STEPS, TWELVE_ROUTES, ELSEWHERE);
    const skip = layout.arrows.find((one) => one.label.text === "Trivial")!;
    const self = layout.arrows.find((one) => one.label.text === "Retry")!;

    expect(skip).toMatchObject({ kind: "side", back: false, to: "Step number 6" });
    expect(skip.points[3]!.y).toBeGreaterThan(skip.points[0]!.y);
    expect(self).toMatchObject({ kind: "side", back: true, to: "Step number 8" });
    expect(self.points[3]!.y).not.toBe(self.points[0]!.y);
  });

  it("ends a route to you, to the end and to another pipeline at a marker naming where it goes", () => {
    const layout = layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE);
    const exit = (label: string, from: string) => layout.arrows.find((one) => one.label.text === label && one.from.id === from)!;

    expect(exit("Needs input", "prepare")).toMatchObject({ kind: "exit", to: "you", marker: { text: "you" } });
    expect(exit("Cancel", "approve")).toMatchObject({ kind: "exit", to: "the end", marker: { text: "the end" } });
    expect(exit("Conflict", "merge")).toMatchObject({ kind: "exit", to: "Delivery · To Do", marker: { text: "Delivery · To Do" } });
    // The line stops where its marker starts.
    const conflict = exit("Conflict", "merge");
    expect(conflict.points[1]!.x).toBe(conflict.marker!.rect.x);
  });

  it("leaves out a route whose target is in no pipeline, and one from a step it has not got", () => {
    const routes = [route("prepare", "Prepared", "changelog"), route("prepare", "Lost", "nowhere"), route("ghost", "Haunt", "prepare")];
    const layout = layoutPipeline(RELEASE_STEPS, routes, ELSEWHERE);

    expect(layout.arrows.map((arrow) => arrow.label.text)).toEqual(["Prepared"]);
    // Told nothing about the other pipelines, a hand-off is a target in none.
    expect(layoutPipeline(RELEASE_STEPS, [route("merge", "Conflict", "d-todo")]).arrows).toEqual([]);
  });

  it("labels an arrow with the route's result key when the route has no label", () => {
    const layout = layoutPipeline(RELEASE_STEPS, [{ ...route("prepare", "", "changelog"), resultKey: "prepared" }]);

    expect(layout.arrows[0]!.label.text).toBe("prepared");
  });

  it("makes every box wide enough for its one row: the name, the start badge, a count and the kind chip (EO-680)", () => {
    const row = (name: string) => name.length * NAME_CHAR + START_BADGE + HERE_ROOM + KIND_CHIP_ROOM + 2 * BOX_PAD_X;
    for (const layout of [layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE), layoutPipeline(TWELVE_STEPS, TWELVE_ROUTES, ELSEWHERE)]) {
      // As wide as the longest name asks, up to the cap past which a name is cut.
      const widest = Math.min(BOX_MAX_WIDTH, Math.max(...layout.steps.map((laid) => row(laid.step.name))));
      for (const { step: one, box } of layout.steps) expect(box.width, one.name).toBeGreaterThanOrEqual(widest);
    }
    // A short name still leaves the chip its room; a very long one is capped and cut by the box, not given a wider column.
    const [short] = layoutPipeline([step("a", "QA", 0)], []).steps;
    expect(short!.box.width - 2 * BOX_PAD_X - START_BADGE - HERE_ROOM).toBeGreaterThanOrEqual(KIND_CHIP_ROOM);
    const [long] = layoutPipeline([step("a", "A step whose name runs on far longer than any box", 0)], []).steps;
    expect(long!.box.width).toBe(BOX_MAX_WIDTH);
  });

  it("answers the same boxes and arrows for the same steps and routes", () => {
    expect(layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE)).toEqual(layoutPipeline(RELEASE_STEPS, RELEASE_ROUTES, ELSEWHERE));
  });

  it("is empty for a pipeline with no steps", () => {
    expect(layoutPipeline([], [])).toEqual({ width: 0, height: 0, steps: [], arrows: [] });
  });
});

describe("packing lanes", () => {
  it("keeps the short spans innermost and moves an overlapping one out a lane", () => {
    expect(
      packLanes([
        [0, 100],
        [10, 20],
        [15, 40],
        [50, 60],
      ]),
    ).toEqual([2, 0, 1, 0]);
  });

  it("separates spans that only come within the room asked for", () => {
    expect(
      packLanes(
        [
          [0, 10],
          [14, 20],
        ],
        8,
      ),
    ).toEqual([1, 0]);
  });
});
