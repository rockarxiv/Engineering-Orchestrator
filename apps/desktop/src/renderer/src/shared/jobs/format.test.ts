import { describe, expect, it } from "vitest";
import { costOf, durationOf, pauseChipOf, whenOf, zoneOf } from "./format";

/**
 * How a job's times, costs and chips are written (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 */

/** 08:00 in Berlin on Monday 1 June 2026 is 06:00Z; 08:00 in New York that morning is 12:00Z. */
const BERLIN_0800 = Date.UTC(2026, 5, 1, 6, 0);
const NEW_YORK_0800 = Date.UTC(2026, 5, 1, 12, 0);

/**
 * The bug this exists to stop: the Job page states "Times are in
 * America/New_York" and then printed `toLocaleString()` underneath it,
 * so a Berlin laptop was shown 14:00 while the sentence above claimed
 * it was New York time.
 *
 * Asserted by clock time rather than against a fixed string, because
 * the locale a machine runs the suite in decides the punctuation and
 * the order — but 08:00 in the zone a job is stated in is 08:00
 * wherever it is read, which is the whole property.
 */
describe("a moment in the zone that governs it", () => {
  it("reads in the zone it is given, not the machine's", () => {
    expect(whenOf(BERLIN_0800, "Europe/Berlin")).toMatch(/08:00/);
    expect(whenOf(NEW_YORK_0800, "America/New_York")).toMatch(/08:00/);
  });

  it("reads one instant differently in two zones, which is what makes the zone load-bearing", () => {
    expect(whenOf(BERLIN_0800, "Europe/Berlin")).not.toBe(whenOf(BERLIN_0800, "America/New_York"));
  });

  it("names the zone, so a time is unambiguous wherever it is read", () => {
    // Whatever this machine's locale calls it — "EDT", "GMT-4" — the
    // point is that something about the zone is in the string, because
    // "8:00 AM" on its own means nothing.
    const bare = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }).format(NEW_YORK_0800);
    expect(whenOf(NEW_YORK_0800, "America/New_York")).not.toBe(bare);
    expect(whenOf(NEW_YORK_0800, "America/New_York").length).toBeGreaterThan(bare.length);
  });

  /**
   * `createJob` and `updateJob` both check a zone against the machine's
   * IANA table, so reaching this means a row written by something else
   * — and a blank screen is a worse answer than a time in the machine's
   * zone with that zone named on it.
   */
  it("falls back to the machine's zone rather than throwing on one it cannot format", () => {
    expect(whenOf(BERLIN_0800, "Europe/Berln")).toBe(whenOf(BERLIN_0800));
  });

  it("says nothing for a moment that has not happened", () => {
    expect(whenOf(null)).toBe("—");
    expect(whenOf(null, "Europe/Berlin")).toBe("—");
  });
});

describe("which zone a job's times are in", () => {
  it("is the schedule's own, and none for a job somebody presses", () => {
    expect(zoneOf({ trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: "Europe/Berlin", catchUpWithinMinutes: 180 } })).toBe("Europe/Berlin");
    expect(zoneOf({ trigger: { kind: "manual" } })).toBeUndefined();
    expect(zoneOf({ trigger: { kind: "from-discussion", conversationId: "c1" } })).toBeUndefined();
  });
});

/**
 * The design gives a paused job one of two chips, and which one is read off
 * the row rather than worked out — see `jobs.paused_reason`
 * (migration 0081).
 */
describe("the chip a paused job wears", () => {
  it("is nothing at all while the job runs", () => {
    expect(pauseChipOf({ pausedAt: null, pausedReason: null })).toBeNull();
    // Even if a stale reason somehow survived: not paused is not paused.
    expect(pauseChipOf({ pausedAt: null, pausedReason: "budget" })).toBeNull();
  });

  it("is §6.1's own wording when a budget stopped it", () => {
    expect(pauseChipOf({ pausedAt: 1, pausedReason: "budget" })).toBe("paused: daily budget reached");
  });

  it("is a plain 'paused' when a person did", () => {
    expect(pauseChipOf({ pausedAt: 1, pausedReason: "by hand" })).toBe("paused");
    // And for a row paused before the reason was recorded: a pause EO
    // cannot attribute to a guard of its own is one a person chose.
    expect(pauseChipOf({ pausedAt: 1, pausedReason: null })).toBe("paused");
  });
});

describe("a cost and a duration", () => {
  it("stays in cents until it is worth pounds", () => {
    expect(costOf(0)).toBe("0¢");
    expect(costOf(42)).toBe("42¢");
    expect(costOf(100)).toBe("$1.00");
    expect(costOf(1234)).toBe("$12.34");
  });

  it("reads a run's length as a length, not a date", () => {
    expect(durationOf(null)).toBe("—");
    expect(durationOf(9_000)).toBe("9s");
    expect(durationOf(90_000)).toBe("1m 30s");
  });
});
