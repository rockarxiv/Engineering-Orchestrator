import { describe, expect, it } from "vitest";
import { formatZonedClock, instantOfZoned, isKnownTimeZone, offsetAt, zonedPartsOf } from "./timeZone.js";

/**
 * The zone table these tests lean on is the machine's, through `Intl`.
 * Every instant is written as an explicit UTC literal, so nothing here
 * depends on where the machine running the suite happens to be — which
 * is the property the file under test exists to give the scheduler.
 */

const NEW_YORK = "America/New_York";
const BERLIN = "Europe/Berlin";
const KOLKATA = "Asia/Kolkata";

describe("reading a clock in a named zone", () => {
  it("reads the wall time in the zone, not in the machine's", () => {
    // 2026-03-06T13:00Z, which is 08:00 in New York and 14:00 in Berlin.
    const instant = Date.UTC(2026, 2, 6, 13, 0);

    expect(zonedPartsOf(instant, NEW_YORK)).toEqual({ year: 2026, month: 3, day: 6, hour: 8, minute: 0 });
    expect(zonedPartsOf(instant, BERLIN)).toEqual({ year: 2026, month: 3, day: 6, hour: 14, minute: 0 });
  });

  it("calls midnight hour zero rather than hour twenty-four", () => {
    // The `hourCycle` the formatter is built with. `h12` or the default
    // would hand back 24 here, and every comparison against an hour
    // field would stop matching for one minute a day.
    expect(zonedPartsOf(Date.UTC(2026, 5, 1, 4, 0), NEW_YORK).hour).toBe(0);
  });

  it("knows the offset changes across a daylight-saving shift", () => {
    expect(offsetAt(Date.UTC(2026, 2, 6, 13, 0), NEW_YORK)).toBe(-5 * 60 * 60_000);
    expect(offsetAt(Date.UTC(2026, 2, 9, 12, 0), NEW_YORK)).toBe(-4 * 60 * 60_000);
  });

  it("handles a zone whose offset is not a whole hour", () => {
    expect(offsetAt(Date.UTC(2026, 5, 1, 0, 0), KOLKATA)).toBe(5.5 * 60 * 60_000);
  });
});

describe("finding the instant a wall time names", () => {
  it("turns 08:00 in the zone into the right moment on each side of a shift", () => {
    expect(instantOfZoned({ year: 2026, month: 3, day: 6, hour: 8, minute: 0 }, NEW_YORK)).toBe(Date.UTC(2026, 2, 6, 13, 0));
    expect(instantOfZoned({ year: 2026, month: 3, day: 9, hour: 8, minute: 0 }, NEW_YORK)).toBe(Date.UTC(2026, 2, 9, 12, 0));
  });

  it("round-trips every wall minute it is given back to itself", () => {
    for (const parts of [
      { year: 2026, month: 1, day: 1, hour: 0, minute: 0 },
      { year: 2026, month: 7, day: 4, hour: 23, minute: 59 },
      { year: 2026, month: 11, day: 30, hour: 12, minute: 30 },
    ]) {
      expect(zonedPartsOf(instantOfZoned(parts, BERLIN), BERLIN)).toEqual(parts);
    }
  });

  it("resolves the hour the clocks repeat to its first instant", () => {
    // 01:30 on 2026-11-01 happens twice in New York. A person waiting
    // for 01:30 means the first one.
    expect(instantOfZoned({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NEW_YORK)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("does not pretend the hour the clocks skip exists", () => {
    // 02:30 on 2026-03-08 is not a moment in New York. What comes back
    // reads as some *other* minute, which is the signal
    // `nextOccurrenceAfter` checks for before it fires anything.
    const answer = instantOfZoned({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK);
    expect(zonedPartsOf(answer, NEW_YORK).hour).not.toBe(2);
  });
});

describe("the zone name itself", () => {
  it("accepts an IANA name and refuses a typo", () => {
    expect(isKnownTimeZone(BERLIN)).toBe(true);
    expect(isKnownTimeZone("Europe/Berln")).toBe(false);
  });
});

describe("saying what time it was", () => {
  it("writes the clock in the job's zone, zero-padded", () => {
    expect(formatZonedClock(Date.UTC(2026, 2, 6, 13, 0), NEW_YORK)).toBe("08:00");
    expect(formatZonedClock(Date.UTC(2026, 2, 6, 13, 0), BERLIN)).toBe("14:00");
  });
});
