import { describe, expect, it } from "vitest";
import { compileSchedule, nextOccurrenceAfter, parseCronExpression, type CronFields } from "./cron.js";

const NEW_YORK = "America/New_York";
const BERLIN = "Europe/Berlin";

function fieldsOf(expression: string): CronFields {
  const parsed = parseCronExpression(expression);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.fields;
}

function compiled(schedule: Parameters<typeof compileSchedule>[0]): CronFields {
  const result = compileSchedule(schedule);
  if (!result.ok) throw new Error(result.problem);
  return result.fields;
}

describe("reading a schedule expression", () => {
  it("reads the five fields", () => {
    const fields = fieldsOf("0 8 * * 1");
    expect([...fields.minute]).toEqual([0]);
    expect([...fields.hour]).toEqual([8]);
    expect(fields.dayOfMonth).toBeNull();
    expect([...fields.month]).toHaveLength(12);
    expect([...fields.dayOfWeek!]).toEqual([1]);
  });

  it("reads steps, ranges and lists", () => {
    expect([...fieldsOf("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...fieldsOf("0 9-17 * * *").hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...fieldsOf("0 0 1,15 * *").dayOfMonth!]).toEqual([1, 15]);
    expect([...fieldsOf("0 0 * * 1-5/2").dayOfWeek!]).toEqual([1, 3, 5]);
  });

  it("treats Sunday as both 0 and 7, as every cron does", () => {
    expect([...fieldsOf("0 0 * * 7").dayOfWeek!]).toEqual([0]);
  });

  it("refuses what it cannot read, naming the field", () => {
    expect(parseCronExpression("0 8 * *")).toEqual({ ok: false, problem: expect.stringContaining("five fields") });
    expect(parseCronExpression("0 25 * * *")).toEqual({ ok: false, problem: expect.stringContaining("hour") });
    expect(parseCronExpression("0 8 * * 9")).toEqual({ ok: false, problem: expect.stringContaining("day of week") });
    expect(parseCronExpression("*/0 8 * * *")).toEqual({ ok: false, problem: expect.stringContaining("at least 1") });
    expect(parseCronExpression("nonsense 8 * * *").ok).toBe(false);
  });

  /**
   * The failure mode is not "EO refuses a schedule" — it is EO running a
   * *different* schedule from the one it was handed, without saying so.
   * Every term here reads as something narrower or wider than it says if
   * the extra segment is dropped on the floor.
   */
  it("refuses a malformed term rather than quietly reading part of it", () => {
    for (const expression of [
      "*/15/2 * * * *", // a step of a step — read as `*/15`, which is not what was written
      "0-5-8 * * * *", // a range of a range — read as `0-5`
      "0 0 1-3-5 * *",
      "0 0 * * 1-5/2/3",
      "-5 * * * *", // `Number("")` is 0, so this used to read as `0-5`
      "5- * * * *",
      "0 */ * * *", // a step with nothing to step by
      "/15 * * * *", // a step with nothing to step
      "0 8 * * 1,", // an empty list member
      "*/1.5 * * * *",
      "* */ 2 * *", // the space makes it six fields, which is its own refusal
    ]) {
      expect(parseCronExpression(expression).ok, expression).toBe(false);
    }
  });

  it("still reads the well-formed terms those refusals resemble", () => {
    // The other half of the rule: tightening the parser must not start
    // refusing expressions that mean exactly what they say.
    expect([...fieldsOf("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...fieldsOf("0-5 * * * *").minute]).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...fieldsOf("0-10/5 * * * *").minute]).toEqual([0, 5, 10]);
    expect([...fieldsOf("5 * * * *").minute]).toEqual([5]);
    // A bare number with a step means "from here on", as cron has it.
    expect([...fieldsOf("0 20/2 * * *").hour]).toEqual([20, 22]);
  });
});

describe("the simple forms", () => {
  it("compile to exactly what the expression would", () => {
    expect(compiled({ kind: "daily", hour: 8, minute: 30 })).toEqual(fieldsOf("30 8 * * *"));
    expect(compiled({ kind: "weekly", weekday: 1, hour: 8, minute: 0 })).toEqual(fieldsOf("0 8 * * 1"));
  });
});

describe("finding the next occurrence", () => {
  it("finds the next daily one, strictly after the moment asked about", () => {
    const daily = compiled({ kind: "daily", hour: 8, minute: 0 });
    // 08:00 Berlin on 2026-06-01 is 06:00Z — summer time, +2.
    const monday = Date.UTC(2026, 5, 1, 6, 0);

    expect(nextOccurrenceAfter(daily, monday - 1, BERLIN)).toBe(monday);
    // Asked *at* an occurrence, the answer is the next one and never the
    // same one again: that is what stops a tick firing twice.
    expect(nextOccurrenceAfter(daily, monday, BERLIN)).toBe(monday + 24 * 60 * 60_000);
  });

  it("finds the next weekly one a week later", () => {
    const weekly = compiled({ kind: "weekly", weekday: 1, hour: 8, minute: 0 });
    // 2026-06-01 is a Monday.
    const monday = Date.UTC(2026, 5, 1, 6, 0);

    expect(nextOccurrenceAfter(weekly, monday, BERLIN)).toBe(monday + 7 * 24 * 60 * 60_000);
  });

  it("ORs day-of-month against day-of-week when both are named, as cron does", () => {
    const fields = fieldsOf("0 0 1 * 1");
    // 2026-06-01 is both the first and a Monday; 2026-06-08 is only a
    // Monday, and an AND reading would skip it.
    const first = nextOccurrenceAfter(fields, Date.UTC(2026, 4, 20), BERLIN)!;
    const second = nextOccurrenceAfter(fields, first, BERLIN)!;
    expect(second - first).toBe(7 * 24 * 60 * 60_000);
  });

  it("gives up rather than looping on a date that never comes", () => {
    // The thirty-first of February.
    expect(nextOccurrenceAfter(fieldsOf("0 0 31 2 *"), Date.UTC(2026, 0, 1), BERLIN)).toBeNull();
  });
});

/**
 * The daylight-saving guard KAN-92 and KAN-78 asked for.
 *
 * The clock is driven by the test rather than waited for: every instant
 * is a UTC literal and the zone is New York's, so what is asserted is
 * the *instant* a wall-clock schedule lands on either side of a shift.
 */
describe("across a daylight-saving change", () => {
  it("keeps 08:00 at 08:00 in the job's zone, and moves the instant instead", () => {
    const daily = compiled({ kind: "daily", hour: 8, minute: 0 });
    // Daylight saving starts on 2026-03-08 in the United States.
    let at = Date.UTC(2026, 2, 6, 0, 0);
    const found: number[] = [];
    for (let day = 0; day < 4; day += 1) {
      at = nextOccurrenceAfter(daily, at, NEW_YORK)!;
      found.push(at);
    }

    expect(found).toEqual([
      Date.UTC(2026, 2, 6, 13, 0), // EST, -5
      Date.UTC(2026, 2, 7, 13, 0), // EST, -5
      Date.UTC(2026, 2, 8, 12, 0), // EDT, -4 — the shift, and 08:00 has not moved
      Date.UTC(2026, 2, 9, 12, 0), // EDT, -4
    ]);
    // The day the clocks went forward is twenty-three hours long, and the
    // schedule is a day later rather than twenty-four hours later.
    expect(found[2]! - found[1]!).toBe(23 * 60 * 60_000);
  });

  it("does the same in the other direction, where the day is twenty-five hours long", () => {
    const daily = compiled({ kind: "daily", hour: 8, minute: 0 });
    // Daylight saving ends on 2026-11-01.
    const saturday = nextOccurrenceAfter(daily, Date.UTC(2026, 9, 31, 0, 0), NEW_YORK)!;
    const sunday = nextOccurrenceAfter(daily, saturday, NEW_YORK)!;

    expect(saturday).toBe(Date.UTC(2026, 9, 31, 12, 0));
    expect(sunday).toBe(Date.UTC(2026, 10, 1, 13, 0));
    expect(sunday - saturday).toBe(25 * 60 * 60_000);
  });

  it("passes over a wall time the clocks skipped rather than firing it an hour late", () => {
    // 02:30 does not happen on 2026-03-08 in New York. Firing it at
    // 03:30 would be EO deciding an hour it was not asked for will do.
    const daily = compiled({ kind: "daily", hour: 2, minute: 30 });
    const before = nextOccurrenceAfter(daily, Date.UTC(2026, 2, 7, 0, 0), NEW_YORK)!;
    const after = nextOccurrenceAfter(daily, before, NEW_YORK)!;

    expect(before).toBe(Date.UTC(2026, 2, 7, 7, 30)); // 02:30 EST
    // The next real 02:30 is two days later and on the other side of the
    // shift: 02:30 EDT, which is 06:30Z and not 07:30Z.
    expect(after).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("does not move when the machine's own time zone is changed under it", () => {
    // The scope's own line: a laptop carried from Berlin to New York, or
    // a machine whose zone somebody edits, must not move the Monday
    // report. The job's zone governs, and the instant is what proves it.
    const weekly = compiled({ kind: "weekly", weekday: 1, hour: 8, minute: 0 });
    const from = Date.UTC(2026, 4, 25);
    const original = process.env.TZ;
    try {
      const answers = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"].map((machine) => {
        process.env.TZ = machine;
        return nextOccurrenceAfter(weekly, from, BERLIN);
      });

      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toBe(Date.UTC(2026, 4, 25, 6, 0));
    } finally {
      process.env.TZ = original;
    }
  });

  it("fires the repeated hour once, on its first instant", () => {
    const daily = compiled({ kind: "daily", hour: 1, minute: 30 });
    const sunday = nextOccurrenceAfter(daily, Date.UTC(2026, 10, 1, 0, 0), NEW_YORK)!;
    const next = nextOccurrenceAfter(daily, sunday, NEW_YORK)!;

    expect(sunday).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT, the first of the two
    expect(next).toBe(Date.UTC(2026, 10, 2, 6, 30)); // and not 01:30 EST an hour later the same night
  });
});
