import type { JobSchedule } from "@eo/core";
import { instantOfZoned, zonedPartsOf, type ZonedParts } from "./timeZone.js";

/**
 * What a schedule is due, worked out in the job's own zone (EO-306,
 * `ARCHITECTURE.md`, "Trigger kinds", "Schedules, and a machine that was off").
 *
 * One matcher for both forms a person can state a schedule in. "Daily at
 * 08:00" and "Mondays at 08:00" compile to the same five fields a cron
 * expression parses to, so there is one definition of what "due" means
 * rather than a second, simpler one that agrees with the first until it
 * does not. The forms are what a person writes; this is what the
 * scheduler computes from.
 *
 * Deliberately no seconds field and no `@yearly` aliases. A schedule's
 * finest grain is the minute the tick runs at, and an alias is a second
 * spelling of something the fields already say.
 */

/** A parsed five-field calendar. A `null` field is a star — it constrains nothing. */
export interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  /** `null` means the field was a star. Its interaction with `dayOfWeek` is cron's own — see `dayMatches`. */
  dayOfMonth: ReadonlySet<number> | null;
  /** 1–12. */
  month: ReadonlySet<number>;
  /** `null` means the field was a star. 0–6, Sunday 0; 7 is accepted on the way in and folded to 0. */
  dayOfWeek: ReadonlySet<number> | null;
}

export type ParseCronResult = { ok: true; fields: CronFields } | { ok: false; problem: string };

interface FieldRange {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** Sunday is both 0 and 7 in every cron there has ever been. */
  readonly fold7?: boolean;
}

const MINUTE: FieldRange = { name: "minute", min: 0, max: 59 };
const HOUR: FieldRange = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldRange = { name: "day of month", min: 1, max: 31 };
const MONTH: FieldRange = { name: "month", min: 1, max: 12 };
const DAY_OF_WEEK: FieldRange = { name: "day of week", min: 0, max: 7, fold7: true };

/**
 * Parses `0 8 * * 1`.
 *
 * Returns a refusal rather than throwing, because the only thing that
 * ever reaches this is an expression somebody typed — and the moment to
 * say it is wrong is the moment they save the job, not the first morning
 * it does not run.
 */
export function parseCronExpression(expression: string): ParseCronResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      problem: `A schedule expression has five fields — minute, hour, day of month, month, day of week — and "${expression.trim()}" has ${fields.length}.`,
    };
  }

  const parsed = [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK].map((range, position) => parseField(fields[position]!, range));
  const failed = parsed.find((result) => !result.ok);
  if (failed && !failed.ok) return { ok: false, problem: failed.problem };

  const values = parsed.map((result) => (result.ok ? result.values : null));
  return {
    ok: true,
    fields: {
      minute: values[0]!,
      hour: values[1]!,
      // A star is kept as `null` rather than "every number", because the
      // difference is load-bearing: cron ORs day-of-month against
      // day-of-week when both are restricted, and a set of all 31 days
      // would make `0 8 * * 1` fire every morning.
      dayOfMonth: fields[2] === "*" ? null : values[2]!,
      month: values[3]!,
      dayOfWeek: fields[4] === "*" ? null : values[4]!,
    },
  };
}

type FieldResult = { ok: true; values: Set<number> } | { ok: false; problem: string };

/**
 * One term of one field: a star, a range, a list member, a step.
 *
 * `A star, 15 every fifteen, a range 1-5, a list 1,3,5, a bare 9` — and
 * nothing cleverer, and nothing sloppier. The shape of every part is
 * checked rather than inferred from what `split` happened to return:
 * reading only the first two segments accepts a step of a step
 * (`15 every fifteen every two`) as a step, and a range of a range
 * (`0-5-8`) as `0-5`, so EO would run a schedule nobody wrote. A term
 * EO cannot read is refused; a term EO can read means exactly one thing.
 */
function parseField(text: string, range: FieldRange): FieldResult {
  const refuse = (detail: string): FieldResult => ({ ok: false, problem: `"${text}" is not a ${range.name} EO can read: ${detail}` });
  const values = new Set<number>();
  if (text.trim() === "") return refuse("it is empty.");

  for (const term of text.split(",")) {
    const parts = term.split("/");
    if (parts.length > 2) return refuse(`"${term}" steps more than once.`);
    const [spec, step] = parts;
    if (spec === undefined || spec === "") return refuse(`"${term}" has nothing before its "/".`);

    // `Number` reads "" as 0 and " 3 " as 3, so neither is asked. A
    // whole number here means the digits and nothing else.
    if (step !== undefined && !WHOLE_NUMBER.test(step)) return refuse(`"${term}" steps by "${step}", which is not a whole number.`);
    const every = step === undefined ? 1 : Number(step);
    if (every < 1) return refuse(`"${term}" steps by ${every}, and a step is at least 1.`);

    let from: number;
    let to: number;
    if (spec === "*") {
      from = range.min;
      to = range.max;
    } else {
      const bounds = spec.split("-");
      if (bounds.length > 2) return refuse(`"${spec}" is a range of a range.`);
      if (!bounds.every((bound) => WHOLE_NUMBER.test(bound))) return refuse(`"${spec}" is not a number or a range of them.`);
      from = Number(bounds[0]);
      // A bare number with a step means "from here on", as cron has it;
      // a bare number without one means only itself.
      to = bounds.length === 2 ? Number(bounds[1]) : step === undefined ? from : range.max;
    }

    if (from < range.min || to > range.max) return refuse(`"${term}" is outside ${range.min}–${range.max}.`);
    if (from > to) return refuse(`"${term}" runs backwards.`);
    for (let value = from; value <= to; value += every) values.add(range.fold7 === true && value === 7 ? 0 : value);
  }
  return { ok: true, values };
}

/** Digits and nothing else — no sign, no space, no decimal point. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * The simple forms, compiled to the same fields.
 *
 * So "daily at 08:00" and `0 8 * * *` are not two implementations of one
 * idea. A person picking the form gets the expression's exact semantics
 * without having to know it exists.
 */
export function compileSchedule(schedule: JobSchedule): ParseCronResult {
  if (schedule.kind === "cron") return parseCronExpression(schedule.expression);
  const everyMonth = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  return {
    ok: true,
    fields: {
      minute: new Set([schedule.minute]),
      hour: new Set([schedule.hour]),
      dayOfMonth: null,
      month: everyMonth,
      dayOfWeek: schedule.kind === "weekly" ? new Set([schedule.weekday]) : null,
    },
  };
}

/**
 * How far ahead a search will look before giving up: five years of days.
 *
 * A bound rather than a loop with faith in it. `31 2 * * *` — the
 * thirty-first of February — matches nothing, ever, and a walk with no
 * horizon would hang the tick that asked.
 */
const HORIZON_DAYS = 366 * 5;

/**
 * The first instant strictly after `after` at which this calendar is due,
 * or `null` if there is none within the horizon.
 *
 * The walk is in **wall-clock** parts and not in milliseconds, which is
 * the whole of how this survives daylight saving: 08:00 is 08:00 on both
 * sides of a shift, and the instant is only computed once a wall minute
 * has matched. Walking in milliseconds would drift an hour twice a year
 * and there would be nowhere to put the correction.
 *
 * Each mismatched field advances the coarsest thing that is wrong and
 * zeroes what is finer, so a daily job crossing a year costs a few
 * hundred steps rather than half a million minutes.
 */
export function nextOccurrenceAfter(fields: CronFields, after: number, timeZone: string): number | null {
  let candidate = addMinutes(zonedPartsOf(after, timeZone), 1);
  const limit = addDays({ ...candidate, hour: 0, minute: 0 }, HORIZON_DAYS);
  const beyond = (parts: ZonedParts): boolean => compare(parts, limit) > 0;

  while (!beyond(candidate)) {
    if (!fields.month.has(candidate.month)) {
      candidate = startOfNextMonth(candidate);
      continue;
    }
    if (!dayMatches(fields, candidate)) {
      candidate = addDays(candidate, 1);
      continue;
    }
    if (!fields.hour.has(candidate.hour)) {
      candidate = { ...candidate, hour: candidate.hour + 1, minute: 0 };
      if (candidate.hour > 23) candidate = addDays(candidate, 1);
      continue;
    }
    if (!fields.minute.has(candidate.minute)) {
      candidate = addMinutes(candidate, 1);
      continue;
    }

    const instant = instantOfZoned(candidate, timeZone);
    // The wall time daylight saving skipped over. 02:30 on the morning
    // the clocks go forward is not a moment, and firing it at 03:30
    // instead would be EO deciding that an hour it was not asked for
    // will do. Passed over, and the next day's 02:30 is a real one.
    const readsBack = zonedPartsOf(instant, timeZone);
    if (instant > after && compare(readsBack, candidate) === 0) return instant;
    candidate = addMinutes(candidate, 1);
  }
  return null;
}

/**
 * Cron's one genuinely strange rule, kept rather than corrected.
 *
 * When day-of-month and day-of-week are *both* restricted they are ORed,
 * not ANDed: `0 8 1 * 1` is the first of the month **and** every Monday.
 * Every cron implementation does this, so a person pasting an expression
 * that works elsewhere gets what it does elsewhere.
 */
function dayMatches(fields: CronFields, parts: ZonedParts): boolean {
  const { dayOfMonth, dayOfWeek } = fields;
  if (dayOfMonth === null && dayOfWeek === null) return true;
  if (dayOfMonth !== null && dayOfMonth.has(parts.day)) return true;
  return dayOfWeek !== null && dayOfWeek.has(weekdayOf(parts));
}

/**
 * Which day of the week a calendar date is.
 *
 * Through `Date.UTC` deliberately: a calendar date's weekday is a fact
 * about the Gregorian calendar and not about any zone, so asking a
 * formatter for it would be asking the wrong question at some expense.
 */
function weekdayOf(parts: ZonedParts): number {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function addMinutes(parts: ZonedParts, minutes: number): ZonedParts {
  return fromUtc(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) + minutes * 60_000);
}

/** Advances the date and returns midnight, since everything finer has been ruled out. */
function addDays(parts: ZonedParts, days: number): ZonedParts {
  return fromUtc(Date.UTC(parts.year, parts.month - 1, parts.day + days));
}

function startOfNextMonth(parts: ZonedParts): ZonedParts {
  return fromUtc(Date.UTC(parts.year, parts.month, 1));
}

/** Calendar arithmetic borrowed from `Date`, with no zone anywhere near it. */
function fromUtc(ms: number): ZonedParts {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function compare(left: ZonedParts, right: ZonedParts): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) -
    Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute)
  );
}
