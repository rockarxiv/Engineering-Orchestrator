/**
 * Wall-clock time in a named zone, both ways (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * A schedule job stores an IANA zone and means it: 08:00 in
 * `Europe/Berlin` stays 08:00 in Berlin whatever the machine's own zone
 * is set to, and whatever the machine's zone is changed to on a Tuesday
 * afternoon. So every occurrence is computed in wall-clock terms in the
 * job's zone and only then turned into an instant — which is the one
 * order that survives a daylight-saving change, because an offset is a
 * fact about a moment rather than about a zone.
 *
 * Built on `Intl.DateTimeFormat`, which is the zone table Node already
 * ships, rather than on a dependency. The rule this file exists to keep:
 * nothing anywhere else may reach for `getHours()` on a job's schedule,
 * because that is the machine's zone by another name.
 */

/** A wall-clock minute, as a person in the zone would read it off a clock. */
export interface ZonedParts {
  year: number;
  /** 1–12, not `Date`'s 0–11. The cron field is 1-based and the arithmetic below is the only place that converts. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * One formatter per zone, kept.
 *
 * Constructing an `Intl.DateTimeFormat` is the expensive part of this
 * file by some margin, and catching up a year of hourly occurrences
 * would otherwise construct several thousand of them.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `h23`, or midnight comes back as hour 24 and every comparison
    // against a cron field quietly stops matching one minute a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  formatters.set(timeZone, made);
  return made;
}

/** Whether the machine's zone table knows this name. What refuses a mistyped `Europe/Berln`. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `timeZone` reads at this instant. */
export function zonedPartsOf(instant: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute") };
}

/** The zone's offset from UTC at this instant, in milliseconds — positive east. */
export function offsetAt(instant: number, timeZone: string): number {
  const parts = zonedPartsOf(instant, timeZone);
  // Truncated to the minute on both sides: the formatter has no seconds,
  // so the seconds of `instant` would otherwise land in the offset.
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant at which a clock in `timeZone` reads these parts.
 *
 * Two passes, which is what makes this exact rather than approximate: the
 * offset that applies is the offset *at the answer*, not at the guess, so
 * the first pass finds the neighbourhood and the second finds the minute.
 * A third pass would change nothing — zone offsets do not shift twice
 * within one shift's distance of each other.
 *
 * Two wall-clock times have no single answer and this deliberately does
 * not pretend otherwise. The hour that daylight saving repeats resolves
 * to its **first** instant, which is the one a person waiting for 01:30
 * means. The hour it skips has no instant at all, and the answer here
 * round-trips to a different minute — `nextOccurrenceAfter` checks for
 * exactly that and passes the occurrence over rather than firing it an
 * hour from where it was asked for.
 */
export function instantOfZoned(parts: ZonedParts, timeZone: string): number {
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const firstGuess = asIfUtc - offsetAt(asIfUtc, timeZone);
  return asIfUtc - offsetAt(firstGuess, timeZone);
}

/** "08:00" in the job's zone — what a skip says it was waiting for. */
export function formatZonedClock(instant: number, timeZone: string): string {
  const parts = zonedPartsOf(instant, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
