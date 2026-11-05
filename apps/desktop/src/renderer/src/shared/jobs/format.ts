import type { Job, JobSummary, ScheduleTrigger } from "@eo/core";

/**
 * How the Jobs list and the Job page say a time, a cost and a duration
 * (EO-308, `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * In one module because the list and the page say the same things about
 * the same job three inches apart: "next run" on a row and "next run"
 * on the page it opens have to be the same string, or a person reading
 * both wonders which one is right.
 */

/** "—" everywhere a number is genuinely absent, rather than a zero that reads as a measurement. */
export const NOTHING = "—";

/**
 * A moment, in the zone that governs it, with the zone named.
 *
 * **The zone is the whole point of this function.** A schedule is
 * stored with the zone it was stated in and fires by that zone, not by
 * the machine's (`ScheduleTriggerSchema` says why). A page that printed
 * `toLocaleString()` underneath the sentence "Times are in
 * America/New_York" would show a Berlin laptop 14:00 while asserting it
 * was New York time — so every time a job's page and list show comes
 * through here with the job's own zone.
 *
 * The short zone name is appended whether or not a zone was passed,
 * because ambiguity is not confined to scheduled jobs: "8:00 AM" means
 * nothing on its own, and "8:00 AM EDT" means something wherever it is
 * read.
 *
 * A zone this machine cannot format falls back to the machine's own
 * rather than throwing. `createJob` and `updateJob` both check the zone
 * against the machine's IANA table, so reaching this means a row
 * written by something else — and a blank screen is a worse answer to
 * that than a time in the wrong zone with the zone named on it.
 */
export function whenOf(at: number | null, timeZone?: string | undefined): string {
  if (at === null) return NOTHING;
  try {
    return new Intl.DateTimeFormat(undefined, { ...CLOCK, ...(timeZone === undefined ? {} : { timeZone }) }).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, CLOCK).format(at);
  }
}

/**
 * Spelled as components rather than as `dateStyle`/`timeStyle`.
 *
 * Not a preference: `Intl.DateTimeFormat` refuses `timeZoneName`
 * alongside either style, and the zone name is the part that makes
 * these times readable at all.
 */
const CLOCK: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};

/**
 * The zone a job's times are in, or none.
 *
 * Only a schedule has one. A `manual` job's occurrences happen when
 * somebody presses, and the moment they pressed is a fact about them
 * rather than about a calendar — so those read in the machine's zone,
 * which is where the pressing happened.
 */
export function zoneOf(job: Pick<Job, "trigger">): string | undefined {
  return job.trigger.kind === "schedule" ? job.trigger.timeZone : undefined;
}

/** Cents as a person writes them. Under a pound they stay cents, which is what most runs cost. */
export function costOf(cents: number): string {
  if (cents === 0) return "0¢";
  return cents < 100 ? `${cents}¢` : `$${(cents / 100).toFixed(2)}`;
}

/** "4m 12s" — a run's length, not a date. */
export function durationOf(ms: number | null): string {
  if (ms === null) return NOTHING;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The chip the design names, or nothing at all.
 *
 * `paused: daily budget reached` is the design's own wording, kept verbatim.
 * A person who stopped the job themselves is told a plain `paused`
 * instead: the two are different facts, and somebody who pressed the
 * button should not be told a budget did it.
 *
 * Read off the row rather than worked out. Which act stopped a job is
 * recorded when it happens (`jobs.paused_reason`, migration 0081),
 * because the spend a derivation would read is identical whether the
 * guard or a person stopped it. A paused job with nothing recorded —
 * one paused before the column existed — reads as a person's, the
 * honest default for a pause EO cannot attribute to a guard of its own.
 */
export function pauseChipOf(job: Pick<JobSummary, "pausedAt" | "pausedReason">): string | null {
  if (job.pausedAt === null) return null;
  return job.pausedReason === "budget" ? "paused: daily budget reached" : "paused";
}

/**
 * The zone the schedule is stated in, said out loud (ARCHITECTURE.md, "The inbox, the archive and
 * jobs").
 *
 * Shown even when it matches the machine's, and that is the point of
 * showing it: a person who set 08:00 in Berlin and then flies to New
 * York has a job that still fires at 08:00 in Berlin, and the only
 * moment to discover that is before the flight.
 */
export function timeZoneNote(trigger: ScheduleTrigger): string {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return trigger.timeZone === here
    ? `Times are in ${trigger.timeZone}, which is this machine's zone. Changing the machine's zone does not move this job.`
    : `Times are in ${trigger.timeZone}. This machine is in ${here}, and the job's zone is the one that governs.`;
}
