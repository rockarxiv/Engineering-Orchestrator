import { withArticle } from "../parts";

/**
 * The first-board tour's stops (EO-667, ARCHITECTURE.md, "What a person
 * sees first"), and the arithmetic of moving through them.
 *
 * Pure: what the tour shows and in which order, with nothing about the
 * screen. `Tour.tsx` draws it.
 */

/** The words a stop is written in: the pack's own word for an item (invariant 13). */
export interface TourWords {
  /** One of them, lower case: "item", "report". */
  item: string;
  /** Several, lower case. */
  items: string;
}

export interface TourStop {
  id: string;
  /** The `data-tour` value of the element the stop points at. */
  anchor: string;
  /** Where that element is drawn: the board the tour belongs to, or an address. */
  at: "board" | string;
  title: string;
  text: (words: TourWords) => string;
  /** Drawn only where there is a machine (a served tab has no MCP server section). */
  machine?: boolean;
}

/** In the order agreed with the person. */
export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: "board",
    anchor: "board",
    at: "board",
    title: "The board",
    text: (words) =>
      `Each column is a step of the pipeline, and each card is ${withArticle(words.item)} moving through it. A card shows who has it now — an agent, a person, or EO itself.`,
  },
  {
    id: "waiting",
    anchor: "waiting",
    at: "board",
    title: "Waiting on you",
    text: (words) =>
      `${capitalise(words.items)} that need your answer or approval show up here. The amber ! marker — a count on this row and on a pipeline, a ring on a card — means something is waiting on you.`,
  },
  {
    id: "assistant",
    anchor: "assistant",
    at: "board",
    title: "The assistant",
    text: (words) => `This is how work starts: describe what you want done, and the assistant files it onto a pipeline as ${withArticle(words.item)} for you to approve.`,
  },
  {
    id: "rail",
    anchor: "rail",
    at: "board",
    title: "The rail",
    text: () => "Switch projects from the name at the top. Jobs start work on a schedule, and More places, behind the gear at the foot, has everything else.",
  },
  {
    id: "agents",
    anchor: "view-agents",
    at: "/agents",
    title: "Agents",
    text: () => "Who does each step: the agents your pipelines hand work to, and the coding agent each one runs on.",
  },
  {
    id: "agentTools",
    anchor: "view-agentTools",
    at: "/agent-tools",
    title: "Agent tools",
    text: () => "The MCP servers and skills agents can use, and which agents are given each one.",
  },
  {
    id: "settings",
    anchor: "settings",
    at: "/settings",
    title: "Settings",
    text: () => "How EO itself behaves — projects, workspaces, connectors, policy and the rest — one section at a time.",
  },
  {
    id: "modules",
    anchor: "settings-modules",
    at: "/settings?section=modules",
    title: "Modules",
    text: () => "The small programs a pipeline's steps can run. Each one is read and approved before it runs.",
  },
  {
    id: "mcp",
    anchor: "settings-mcp",
    at: "/settings?section=mcp",
    title: "MCP server",
    text: () => "Connects EO to outside clients such as Claude Code, so they can read the board and file work here.",
    machine: true,
  },
];

/** The stops this window can show at all: a served tab has no machine-only section to point at. */
export function stopsFor(stops: readonly TourStop[], machine: boolean): TourStop[] {
  return stops.filter((stop) => machine || !stop.machine);
}

/** The screens the stops are on, in the tour's order: the stops of each, and where it is. */
export interface TourScreen {
  at: TourStop["at"];
  stops: TourStop[];
}

/**
 * The stops grouped by the screen they are on, so the tour can look at
 * every screen once before it shows anything and know which stops it has
 * (see `TourHost`'s survey).
 */
export function screensOf(stops: readonly TourStop[]): TourScreen[] {
  const screens: TourScreen[] = [];
  for (const stop of stops) {
    const last = screens[screens.length - 1];
    if (last !== undefined && last.at === stop.at) last.stops.push(stop);
    else screens.push({ at: stop.at, stops: [stop] });
  }
  return screens;
}

/** The stops the tour will show: every one whose element the survey found. */
export function shownStops(stops: readonly TourStop[], missing: readonly string[]): TourStop[] {
  return stops.filter((stop) => !missing.includes(stop.id));
}

/**
 * Where the tour is: the stop on screen, and the stops found to have
 * nothing to point at after the survey — an element that went between
 * the survey and its stop.
 */
export interface TourPosition {
  index: number;
  missing: readonly string[];
}

export const TOUR_START: TourPosition = { index: 0, missing: [] };

/** The next stop, or null when the one on screen was the last. */
export function next(stops: readonly TourStop[], position: TourPosition): TourPosition | null {
  return position.index + 1 < stops.length ? { ...position, index: position.index + 1 } : null;
}

/** The stop on screen had no element to point at: it is counted out, and the tour goes on past it. */
export function skipMissing(stops: readonly TourStop[], position: TourPosition): TourPosition | null {
  const stop = stops[position.index];
  const missing = stop && !position.missing.includes(stop.id) ? [...position.missing, stop.id] : position.missing;
  return next(stops, { ...position, missing });
}

/** "N of M", counting only the stops that were, or may yet be, shown. */
export function countOf(stops: readonly TourStop[], position: TourPosition): { n: number; m: number } {
  const shown = stops.filter((stop) => !position.missing.includes(stop.id));
  const before = stops.slice(0, position.index).filter((stop) => !position.missing.includes(stop.id)).length;
  return { n: before + 1, m: shown.length };
}

/** Whether the stop on screen is the last one still to be shown: its button reads Done. */
export function isLast(stops: readonly TourStop[], position: TourPosition): boolean {
  return stops.slice(position.index + 1).every((stop) => position.missing.includes(stop.id));
}

function capitalise(word: string): string {
  return word.slice(0, 1).toUpperCase() + word.slice(1);
}
