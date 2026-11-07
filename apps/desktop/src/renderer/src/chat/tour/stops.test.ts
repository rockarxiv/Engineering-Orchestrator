import { describe, expect, it } from "vitest";
import { TOUR_START, TOUR_STOPS, countOf, isLast, next, skipMissing, stopsFor, type TourPosition } from "./stops";

/** The first-board tour's order and arithmetic (EO-667). */
describe("the tour's stops", () => {
  it("are exactly the nine agreed, in order", () => {
    expect(TOUR_STOPS.map((stop) => stop.id)).toEqual(["board", "waiting", "assistant", "rail", "agents", "agentTools", "settings", "modules", "mcp"]);
    expect(TOUR_STOPS.map((stop) => stop.at)).toEqual([
      "board",
      "board",
      "board",
      "board",
      "/agents",
      "/agent-tools",
      "/settings",
      "/settings?section=modules",
      "/settings?section=mcp",
    ]);
  });

  it("leave out the machine-only MCP server section on a served tab", () => {
    expect(stopsFor(TOUR_STOPS, true)).toHaveLength(9);
    expect(stopsFor(TOUR_STOPS, false).map((stop) => stop.id)).not.toContain("mcp");
    expect(stopsFor(TOUR_STOPS, false)).toHaveLength(8);
  });

  it("are written in the pack's word for an item, never a fixed one", () => {
    const words = { item: "report", items: "reports" };
    expect(TOUR_STOPS[0]!.text(words)).toContain("a report moving through it");
    expect(TOUR_STOPS[1]!.text(words)).toMatch(/^Reports that need your answer/);
    expect(TOUR_STOPS[2]!.text({ item: "item", items: "items" })).toContain("as an item for you to approve");
  });
});

describe("moving through the stops", () => {
  const stops = TOUR_STOPS;

  it("goes one at a time to the last, which ends it", () => {
    let position: TourPosition | null = TOUR_START;
    const seen: string[] = [];
    while (position !== null) {
      seen.push(`${stops[position.index]!.id} ${countOf(stops, position).n} of ${countOf(stops, position).m}${isLast(stops, position) ? " (Done)" : ""}`);
      position = next(stops, position);
    }
    expect(seen).toEqual([
      "board 1 of 9",
      "waiting 2 of 9",
      "assistant 3 of 9",
      "rail 4 of 9",
      "agents 5 of 9",
      "agentTools 6 of 9",
      "settings 7 of 9",
      "modules 8 of 9",
      "mcp 9 of 9 (Done)",
    ]);
  });

  it("passes over a stop with nothing to point at, and counts only the stops shown", () => {
    // On Agents (5 of 9), Agent tools turns out to have no element.
    const atAgents: TourPosition = { index: 4, missing: [] };
    const atTools = next(stops, atAgents)!;
    const atSettings = skipMissing(stops, atTools)!;
    expect(stops[atSettings.index]!.id).toBe("settings");
    expect(atSettings.missing).toEqual(["agentTools"]);
    expect(countOf(stops, atSettings)).toEqual({ n: 6, m: 8 });
  });

  it("ends when the last stop has nothing to point at", () => {
    expect(skipMissing(stops, { index: 8, missing: [] })).toBeNull();
  });

  it("counts a missing first stop out from the start", () => {
    const atWaiting = skipMissing(stops, TOUR_START)!;
    expect(stops[atWaiting.index]!.id).toBe("waiting");
    expect(countOf(stops, atWaiting)).toEqual({ n: 1, m: 8 });
  });
});
