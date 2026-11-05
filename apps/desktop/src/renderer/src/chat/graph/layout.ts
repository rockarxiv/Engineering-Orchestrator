import { TERMINAL_TARGET, USER_ATTENTION_TARGET, type HandOffTargets, type PipelineStepView, type StepRouteView } from "@eo/core";

/**
 * Where everything in a pipeline's drawing goes (EO-400).
 *
 * Steps and routes in, rectangles and paths out — nothing here draws, so
 * "no two things overlap" is a unit test on numbers rather than something
 * checked by eye (`layout.test.ts`).
 *
 * The shape, top to bottom because both places it is drawn are narrow:
 *
 *   · every step is a box, in position order, in one column;
 *   · a route to the very next step is an arrow straight down the gap
 *     between the two boxes, its label beside it in that gap;
 *   · a route to any other step of this pipeline — a send-back, a skip, a
 *     step routing to itself — leaves the left of its box, runs along a
 *     vertical *lane* and comes back into the left of the box it lands on;
 *   · a route out of the pipeline — to you, to the end, to another
 *     pipeline — leaves the right of its box and stops at a marker naming
 *     where it goes.
 *
 * Each route that leaves a side gets a row of its own on that side, and
 * its label sits on that row, between the box and the lanes. So a label
 * is only ever beside the box its route leaves, and no arrow runs through
 * one: lanes are beyond the labels, and the gaps between boxes hold only
 * the arrows going straight down.
 *
 * Lanes are packed the way the classic routing band packs its arcs
 * (`pipeline/PipelineGraph.tsx`): shortest span first, each arrow in the
 * first lane no overlapping arrow already holds — so the short local
 * send-backs hug the boxes and the long ones ride outside them.
 *
 * Text is not measured, because nothing here has a DOM to measure it in.
 * Widths are counted from the characters at a per-character advance that
 * is exact for the monospace labels and generous for the rest; whatever
 * is longer than its cap is cut with an ellipsis by the component.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidStep {
  step: PipelineStepView;
  box: Rect;
}

export interface LaidArrow {
  route: StepRouteView;
  /** `next`: straight down. `side`: around the left to another step. `exit`: out to a marker. */
  kind: "next" | "side" | "exit";
  /** It lands on its own step or an earlier one: against the direction everything else moves. */
  back: boolean;
  /** The step it leaves, and the name of where it lands. */
  from: PipelineStepView;
  to: string;
  /** The corners of the line, from the box it leaves to where it lands. */
  points: Point[];
  /** The line, with its corners rounded. */
  path: string;
  /** The arrowhead at the landing end, as a closed path. */
  head: string;
  label: { text: string; rect: Rect };
  /** Where a route out of the pipeline ends. Null for a route to a step. */
  marker: { text: string; rect: Rect } | null;
  /** Side arrows only: which lane it runs in, and the stretch of that lane it occupies. */
  lane: number | null;
  span: [number, number] | null;
}

export interface PipelineLayout {
  width: number;
  height: number;
  steps: LaidStep[];
  arrows: LaidArrow[];
}

/** Room around the whole drawing, so a stroke on the outermost lane is not cut. */
const PAD = 6;

const BOX_MIN_WIDTH = 176;
const BOX_MAX_WIDTH = 264;
const BOX_MIN_HEIGHT = 52;
/** Inside a box, above its first side row and below its last. */
const BOX_PAD_Y = 6;
/** The box's own horizontal padding, as the component draws it. */
export const BOX_PAD_X = 12;
const NAME_CHAR = 7.4;
const OWNER_CHAR = 6.7;
/**
 * The "start" badge beside the entry step's name. Every name is given the
 * room for it: which step work enters at is not part of the shape, and a
 * drawing must not move when only that changes.
 */
const START_BADGE = 44;

/** One route leaving (or arriving at) the side of a box: its label above, its line below. */
const ROW = 22;
const ROW_LINE = 16;

export const LABEL_HEIGHT = 14;
const LABEL_CHAR = 6.4;
const LABEL_PAD = 6;
const LABEL_MAX_WIDTH = 190;
/** Between a box's edge and the label beside it, and between that label and what is beyond it. */
const GUTTER_PAD = 6;

const LANE_FIRST = 10;
const LANE_STEP = 12;
/** Two arrows this close end to end still take separate lanes: their rounded corners would touch. */
const LANE_ROOM = 8;
const CORNER = 5;

/** The gap between two boxes: with no arrow in it, and around the arrows it holds. */
const GAP_EMPTY = 20;
const GAP_MIN = 32;
const NEXT_ROW = 16;
const NEXT_SPREAD = 10;

const HEAD = 6;
/** The bare line between an exit's label and its marker — where the arrowhead is. */
const EXIT_REACH = 16;
const MARKER_HEIGHT = 18;
const MARKER_CHAR = 6.8;
const MARKER_PAD = 16;
const MARKER_MAX_WIDTH = 220;

function labelWidth(text: string): number {
  return Math.min(LABEL_MAX_WIDTH, Math.ceil(text.length * LABEL_CHAR) + LABEL_PAD);
}

function markerWidth(text: string): number {
  return Math.min(MARKER_MAX_WIDTH, Math.ceil(text.length * MARKER_CHAR) + MARKER_PAD);
}

/** "agent · reporter", "you", "module · match_po", "built in · merge": who a step belongs to. */
export function ownerLine(step: Pick<PipelineStepView, "type" | "ownerRole" | "entryAction">): string {
  switch (step.type) {
    case "agent":
      return `agent · ${step.ownerRole ?? "agent"}`;
    case "user":
      return "you";
    case "module":
      return `module · ${step.entryAction ?? "module"}`;
    default:
      return `built in · ${step.entryAction ?? "EO"}`;
  }
}

/** What a route's arrow says: its label, or its result key when it has none. */
export function routeLabel(route: Pick<StepRouteView, "label" | "resultKey">): string {
  return route.label || route.resultKey;
}

/**
 * Give every span a lane no overlapping span already holds.
 *
 * Shortest first, so the tight local arrows stay near the boxes and the
 * long reaching ones ride outside them. Answers each span's lane, in the
 * order the spans were given.
 */
export function packLanes(spans: readonly (readonly [number, number])[], room = 0): number[] {
  const order = spans.map((_, index) => index).sort((a, b) => spans[a]![1] - spans[a]![0] - (spans[b]![1] - spans[b]![0]) || a - b);
  const taken: [number, number][][] = [];
  const lanes = new Array<number>(spans.length).fill(0);
  for (const index of order) {
    const [start, end] = spans[index]!;
    const claim: [number, number] = [start - room, end + room];
    let lane = 0;
    while (taken[lane]?.some(([s, e]) => claim[0] <= e && s <= claim[1])) lane += 1;
    (taken[lane] ??= []).push(claim);
    lanes[index] = lane;
  }
  return lanes;
}

/** A line through `points`, each corner turned on a small radius. */
function roundedPath(points: Point[]): string {
  const first = points[0]!;
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < points.length; index += 1) {
    const here = points[index]!;
    const next = points[index + 1];
    if (!next) {
      path += ` L ${here.x} ${here.y}`;
      continue;
    }
    const before = points[index - 1]!;
    const into = Math.hypot(here.x - before.x, here.y - before.y);
    const out = Math.hypot(next.x - here.x, next.y - here.y);
    const radius = Math.min(CORNER, into / 2, out / 2);
    if (radius <= 0) {
      path += ` L ${here.x} ${here.y}`;
      continue;
    }
    const enter = { x: here.x - ((here.x - before.x) / into) * radius, y: here.y - ((here.y - before.y) / into) * radius };
    const leave = { x: here.x + ((next.x - here.x) / out) * radius, y: here.y + ((next.y - here.y) / out) * radius };
    path += ` L ${enter.x} ${enter.y} Q ${here.x} ${here.y} ${leave.x} ${leave.y}`;
  }
  return path;
}

/** An arrowhead whose tip is at `tip`, pointing down or to the right. */
function headPath(tip: Point, direction: "down" | "right"): string {
  const half = HEAD * 0.55;
  return direction === "down"
    ? `M ${tip.x} ${tip.y} L ${tip.x - half} ${tip.y - HEAD} L ${tip.x + half} ${tip.y - HEAD} Z`
    : `M ${tip.x} ${tip.y} L ${tip.x - HEAD} ${tip.y - half} L ${tip.x - HEAD} ${tip.y + half} Z`;
}

/** A route, resolved to where it goes. */
interface Resolved {
  route: StepRouteView;
  from: number;
  /** The step it lands on, or null when it leaves the pipeline. */
  to: number | null;
  /** Where it goes, in words. */
  name: string;
}

/**
 * Where each route lands. A route from a step this pipeline has not got,
 * or to a target in no pipeline at all, is a broken route: configuration
 * reports it and the drawing leaves it out. This pipeline's own steps are
 * checked before any hand-off, as the validator checks them, so nothing
 * elsewhere can capture a target that resolves here.
 */
function resolveRoutes(ordered: PipelineStepView[], routes: StepRouteView[], elsewhere: HandOffTargets[]): Resolved[] {
  const indexOf = new Map(ordered.map((step, index) => [step.id, index]));
  const resolved: Resolved[] = [];
  const inOrder = routes.map((route, index) => ({ route, index })).sort((a, b) => a.route.position - b.route.position || a.index - b.index);
  for (const { route } of inOrder) {
    const from = indexOf.get(route.fromStepId);
    if (from === undefined) continue;
    const here = indexOf.get(route.target);
    if (here !== undefined) {
      resolved.push({ route, from, to: here, name: ordered[here]!.name });
      continue;
    }
    if (route.target === USER_ATTENTION_TARGET) {
      resolved.push({ route, from, to: null, name: "you" });
      continue;
    }
    if (route.target === TERMINAL_TARGET) {
      resolved.push({ route, from, to: null, name: "the end" });
      continue;
    }
    for (const pipeline of elsewhere) {
      const there = pipeline.steps.find((step) => step.id === route.target);
      if (!there) continue;
      resolved.push({ route, from, to: null, name: `${pipeline.pipelineName} · ${there.name}` });
      break;
    }
  }
  return resolved;
}

export function layoutPipeline(
  steps: readonly PipelineStepView[],
  routes: readonly StepRouteView[],
  elsewhere: readonly HandOffTargets[] = [],
): PipelineLayout {
  const ordered = steps.map((step, index) => ({ step, index })).sort((a, b) => a.step.position - b.step.position || a.index - b.index).map(({ step }) => step);
  if (ordered.length === 0) return { width: 0, height: 0, steps: [], arrows: [] };
  const resolved = resolveRoutes(ordered, [...routes], [...elsewhere]);

  const next = ordered.map(() => [] as Resolved[]);
  const backs = ordered.map(() => [] as Resolved[]);
  const skips = ordered.map(() => [] as Resolved[]);
  const exits = ordered.map(() => [] as Resolved[]);
  const arrivesFromAbove = ordered.map(() => false);
  const arrivesFromBelow = ordered.map(() => false);
  for (const one of resolved) {
    if (one.to === null) exits[one.from]!.push(one);
    else if (one.to === one.from + 1) next[one.from]!.push(one);
    else if (one.to <= one.from) {
      backs[one.from]!.push(one);
      arrivesFromBelow[one.to] = true;
    } else {
      skips[one.from]!.push(one);
      arrivesFromAbove[one.to] = true;
    }
  }
  // The order a side's rows are in is what keeps one step's arrows from
  // crossing each other: an arrow leaving upward from a higher row than a
  // longer one never meets it, and the same downward, mirrored.
  for (const list of backs) list.sort((a, b) => b.to! - a.to!);
  for (const list of skips) list.sort((a, b) => b.to! - a.to!);

  // Left rows, top to bottom: what arrives from above, what leaves upward,
  // what leaves downward, what arrives from below.
  const leftRows = ordered.map((_, index) => (arrivesFromAbove[index] ? 1 : 0) + backs[index]!.length + skips[index]!.length + (arrivesFromBelow[index] ? 1 : 0));
  const heights = ordered.map((_, index) => Math.max(BOX_MIN_HEIGHT, 2 * BOX_PAD_Y + ROW * Math.max(leftRows[index]!, exits[index]!.length)));

  const boxWidth = Math.min(
    BOX_MAX_WIDTH,
    Math.max(
      BOX_MIN_WIDTH,
      ...ordered.map((step) =>
        Math.ceil(Math.max(step.name.length * NAME_CHAR + START_BADGE, (step.isTerminal ? 3 : ownerLine(step).length) * OWNER_CHAR)) + 2 * BOX_PAD_X,
      ),
    ),
  );

  // Down the column.
  const tops: number[] = [];
  let y = PAD;
  ordered.forEach((_, index) => {
    tops.push(y);
    y += heights[index]!;
    if (index < ordered.length - 1) {
      const count = next[index]!.length;
      y += count === 0 ? GAP_EMPTY : Math.max(GAP_MIN, count * NEXT_ROW + 14);
    }
  });
  const height = y + PAD;

  /** The y of a side row's line: rows are centred in the box's height. */
  const rowLine = (index: number, row: number, rows: number) => tops[index]! + (heights[index]! - rows * ROW) / 2 + row * ROW + ROW_LINE;
  const leftRowOf = (one: Resolved): number => {
    const index = one.from;
    const lead = arrivesFromAbove[index] ? 1 : 0;
    const back = backs[index]!.indexOf(one);
    return back >= 0 ? lead + back : lead + backs[index]!.length + skips[index]!.indexOf(one);
  };
  const arrivalRowOf = (one: Resolved): number => (one.to! <= one.from ? leftRows[one.to!]! - 1 : 0);

  // The side arrows' two ends, then their lanes.
  const sides = resolved
    .filter((one) => one.to !== null && one.to !== one.from + 1)
    .map((one) => {
      const leaves = rowLine(one.from, leftRowOf(one), leftRows[one.from]!);
      const lands = rowLine(one.to!, arrivalRowOf(one), leftRows[one.to!]!);
      return { one, leaves, lands, span: [Math.min(leaves, lands), Math.max(leaves, lands)] as [number, number] };
    });
  const lanes = packLanes(
    sides.map((side) => side.span),
    LANE_ROOM,
  );
  const laneCount = lanes.reduce((most, lane) => Math.max(most, lane + 1), 0);

  // Across: lanes, the labels of what leaves the left, the boxes, the
  // labels of what leaves the right, the markers.
  const leftLabels = sides.reduce((widest, side) => Math.max(widest, labelWidth(routeLabel(side.one.route))), 0);
  const leftGutter = sides.length > 0 ? leftLabels + 2 * GUTTER_PAD : 0;
  const boxLeft = PAD + (sides.length > 0 ? leftGutter + LANE_FIRST + (laneCount - 1) * LANE_STEP : 0);
  const boxRight = boxLeft + boxWidth;
  const centre = boxLeft + boxWidth / 2;
  const laneX = (lane: number) => boxLeft - leftGutter - LANE_FIRST - lane * LANE_STEP;
  const allExits = exits.flat();
  const exitLabels = allExits.reduce((widest, one) => Math.max(widest, labelWidth(routeLabel(one.route))), 0);
  const markerLeft = boxRight + GUTTER_PAD + exitLabels + EXIT_REACH;

  const arrows: LaidArrow[] = [];
  let right = boxRight;

  ordered.forEach((step, index) => {
    // Straight down, side by side when more than one result goes on to the next step.
    const down = next[index]!;
    if (down.length > 0) {
      const top = tops[index]! + heights[index]!;
      const bottom = tops[index + 1]!;
      const firstLabel = top + (bottom - top - down.length * NEXT_ROW) / 2 + (NEXT_ROW - LABEL_HEIGHT) / 2;
      const labelLeft = centre + ((down.length - 1) * NEXT_SPREAD) / 2 + 8;
      down.forEach((one, at) => {
        const x = centre + (at - (down.length - 1) / 2) * NEXT_SPREAD;
        const points = [
          { x, y: top },
          { x, y: bottom },
        ];
        const text = routeLabel(one.route);
        const rect = { x: labelLeft, y: firstLabel + at * NEXT_ROW, width: labelWidth(text), height: LABEL_HEIGHT };
        right = Math.max(right, rect.x + rect.width);
        arrows.push({
          route: one.route,
          kind: "next",
          back: false,
          from: step,
          to: one.name,
          points,
          path: roundedPath(points),
          head: headPath(points[1]!, "down"),
          label: { text, rect },
          marker: null,
          lane: null,
          span: null,
        });
      });
    }

    // Out to a marker.
    exits[index]!.forEach((one, row) => {
      const line = rowLine(index, row, exits[index]!.length);
      const points = [
        { x: boxRight, y: line },
        { x: markerLeft, y: line },
      ];
      const text = routeLabel(one.route);
      const marker = { x: markerLeft, y: line - MARKER_HEIGHT / 2, width: markerWidth(one.name), height: MARKER_HEIGHT };
      right = Math.max(right, marker.x + marker.width);
      arrows.push({
        route: one.route,
        kind: "exit",
        back: false,
        from: step,
        to: one.name,
        points,
        path: roundedPath(points),
        head: headPath(points[1]!, "right"),
        label: { text, rect: { x: boxRight + GUTTER_PAD, y: line - 2 - LABEL_HEIGHT, width: labelWidth(text), height: LABEL_HEIGHT } },
        marker: { text: one.name, rect: marker },
        lane: null,
        span: null,
      });
    });
  });

  // Around the left.
  sides.forEach((side, at) => {
    const lane = lanes[at]!;
    const x = laneX(lane);
    const points = [
      { x: boxLeft, y: side.leaves },
      { x, y: side.leaves },
      { x, y: side.lands },
      { x: boxLeft, y: side.lands },
    ];
    const text = routeLabel(side.one.route);
    const width = labelWidth(text);
    arrows.push({
      route: side.one.route,
      kind: "side",
      back: side.one.to! <= side.one.from,
      from: ordered[side.one.from]!,
      to: side.one.name,
      points,
      path: roundedPath(points),
      head: headPath(points[3]!, "right"),
      label: { text, rect: { x: boxLeft - GUTTER_PAD - width, y: side.leaves - 2 - LABEL_HEIGHT, width, height: LABEL_HEIGHT } },
      marker: null,
      lane,
      span: side.span,
    });
  });

  return {
    width: right + PAD,
    height,
    steps: ordered.map((step, index) => ({ step, box: { x: boxLeft, y: tops[index]!, width: boxWidth, height: heights[index]! } })),
    arrows,
  };
}
