import type { QuotaEvent } from "./agent-provider.js";

/**
 * A run stopped because the backend's plan window filled up (EO-172).
 *
 * The distinction this file exists to draw is between a run that *went
 * wrong* and a run that was *refused*. They look identical from the
 * outside — a turn cut off mid-sentence leaves a half-written result
 * that fails its schema, and EO used to report exactly that: "the
 * required object came back as a string", after two correction attempts
 * spent against an allowance that was already gone.
 *
 * Nothing here parses an error string. `QuotaEvent.status` is the
 * backend's own word for whether the call was allowed or refused, and
 * `rejected` is the whole of the signal.
 */
export function isQuotaRefusal(event: QuotaEvent): boolean {
  return event.status === "rejected";
}

/**
 * The refusals standing against one run, kept apart rather than
 * collapsed into the most recent one (EO-172).
 *
 * A plan runs several windows at once and they exhaust independently, so
 * two of them can refuse during a single run. Remembering only the last
 * reading reproduces the bug this file exists to fix by another route:
 * the seven-day window rejects, then the five-hour one does, the item
 * is told about the five-hour reset, somebody comes back in an hour, and
 * the work still cannot run. That is a confidently wrong time, which is
 * worse than an honest gap precisely because nothing about it looks like
 * a guess.
 */
export interface QuotaRefusals {
  /**
   * Takes a reading. A refusal is remembered against its window; any
   * other status clears that window, because a window that has stopped
   * refusing is no longer holding anything up.
   */
  record(event: QuotaEvent): void;
  /**
   * The refusal that holds the work longest, or null when none stands.
   *
   * One rather than all of them, and that is sufficient rather than a
   * simplification: every other outstanding window refreshes before this
   * one does, so somebody who waits for the time this names has waited
   * out the rest of them too.
   *
   * A refusal on an unnamed window is chosen only when its backend has no
   * named refusal standing beside it (EO-920).
   */
  blocking(now: number): QuotaEvent | null;
}

/**
 * Two readings are about the same allowance when the provider *and* the
 * window agree. The window name alone is not enough — `five_hour` on one
 * backend and `five_hour` on another are two separate allowances, and
 * keying on the name would let one silently overwrite the other.
 *
 * Two differently-named-but-unnamed windows from one provider do collapse
 * here, since `unknown` is all either of them says about itself. Nothing
 * can be done about that without inventing a distinction the backend did
 * not make.
 */
function allowanceKey(event: QuotaEvent): string {
  // JSON rather than a joined string: it cannot be made ambiguous by
  // a provider or window name that happens to contain the separator.
  return JSON.stringify([event.provider, event.window]);
}

/**
 * Whether a reading names no window: `unknown` is what both adapters
 * write when the backend did not say which one (EO-920).
 */
export function isUnnamedWindow(window: string): boolean {
  const named = window.trim();
  return named === "" || named === "unknown";
}

export function createQuotaRefusals(): QuotaRefusals {
  const outstanding = new Map<string, QuotaEvent>();
  return {
    record(event) {
      const key = allowanceKey(event);
      // A repeat refusal replaces the earlier one: same allowance, fresher
      // reading, and the reset it carries is the more current of the two.
      if (isQuotaRefusal(event)) outstanding.set(key, event);
      else outstanding.delete(key);
    },
    blocking(now) {
      // An unnamed refusal beside a named one from the same backend is
      // that backend's account of the same refusal, not a second one
      // (EO-920): Codex classifies a refused turn `usageLimitExceeded`
      // on no window because its reading at 100% says which. Left in, its
      // missing reset outranked the named one, and a hold the backend had
      // said would end at a time waited for a person instead.
      const named = new Set([...outstanding.values()].filter((event) => !isUnnamedWindow(event.window)).map((event) => event.provider));
      let worst: QuotaEvent | null = null;
      let worstAt: number | null = null;
      for (const event of outstanding.values()) {
        if (isUnnamedWindow(event.window) && named.has(event.provider)) continue;
        const at = quotaResetAt(event.resetsAt, now);
        if (worst === null) {
          worst = event;
          worstAt = at;
          continue;
        }
        // An unreadable reset outranks every known one, and cannot be
        // outranked. "Back in three hours" alongside a window that might
        // need a week is the confident wrong answer; "EO cannot say" is
        // the honest one, and honesty is the tie-break the item asks
        // for. Ties between known resets keep the first seen, so the
        // choice does not depend on Map iteration being re-ordered.
        if (worstAt === null) continue;
        if (at === null || at > worstAt) {
          worst = event;
          worstAt = at;
        }
      }
      return worst;
    },
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How far either side of now a reset may sit and still be believed.
 *
 * Behind, because a reading and the moment it is read are not the same
 * instant and a window that refreshed while EO was writing about it is
 * ordinary. Ahead, because the longest window any of these plans has is
 * a week — a reading that resolves to next year is not a reset time, it
 * is a number this code has misread, and saying so is the point.
 */
const RESET_BEHIND_MS = 5 * MINUTE;
const RESET_AHEAD_MS = 31 * DAY;

/**
 * `QuotaEvent.resetsAt` as an actual instant, or null when it cannot be
 * read as one.
 *
 * **The unit is not documented.** The SDK types the field as a bare
 * `number` and says nothing else about it; the same vendor's usage
 * endpoint reports the same fact as an ISO 8601 string, so there is no
 * sibling to copy the unit from either. That is why the provider adapter
 * passes it through untouched and why the conversion lives here, once,
 * with its reasoning written down.
 *
 * Read as epoch seconds first, then as epoch milliseconds, and believed
 * only if the result lands in the window above. The two readings cannot
 * both land there — an epoch-seconds value read as milliseconds is 1970,
 * and an epoch-milliseconds value read as seconds is the year 58000 — so
 * the order is a preference between two answers that never both exist,
 * not a tie-break.
 *
 * Anything else — a duration rather than an instant, a zero, a NaN, a
 * clock EO cannot reconcile — is null. The item's own words: a
 * confident wrong time is worse than an honest gap.
 */
export function quotaResetAt(resetsAt: number | undefined, now: number): number | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  const believable = (at: number): boolean => at >= now - RESET_BEHIND_MS && at <= now + RESET_AHEAD_MS;
  if (believable(resetsAt * 1000)) return resetsAt * 1000;
  if (believable(resetsAt)) return resetsAt;
  return null;
}

/**
 * The size of a gap, in the words somebody would use for it, with no
 * tense on it either way.
 *
 * Deliberately vague — "about three hours" is what a person needs from a
 * window that refreshes on the backend's schedule rather than on EO's,
 * and a precise "2h 58m" would be a precision this number does not have.
 *
 * Tenseless because the gap runs in both directions: `quotaResetAt`
 * believes a reset a few minutes into the past, and a phrase that had
 * "in" baked into it rendered one of those as "in under a minute" — a
 * wait, for a moment that had already been and gone.
 */
function magnitude(ms: number): string {
  if (ms < MINUTE) return "under a minute";
  if (ms < 90 * MINUTE) {
    const minutes = Math.round(ms / MINUTE);
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms < 48 * HOUR) {
    const hours = Math.round(ms / HOUR);
    return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(ms / DAY);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The same instant written out, so the relative phrase above does not
 * have to survive being read tomorrow.
 *
 * UTC and not the machine's zone: a comment is a durable record that
 * outlives the session that wrote it, and a bare local time with no zone
 * on it is the sort of thing that is quietly wrong for whoever reads it
 * next. The glanceable form is the phrase in front of it — this is the
 * one that can be checked.
 */
function utcStamp(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * When the window refreshes, as a sentence — including the sentence for
 * "nobody said", and the one for "it already has".
 *
 * The past tense is not a curiosity. `quotaResetAt` deliberately believes
 * a reset up to five minutes behind now, because a reading and the moment
 * it is read are not the same instant; without a branch here that
 * interval came out as "refreshes in under a minute" while the UTC stamp
 * beside it was in the past. One sentence telling a reader to wait and
 * another saying the wait is over is worse than either alone.
 */
export function describeQuotaReset(resetsAt: number | undefined, now: number): string {
  const at = quotaResetAt(resetsAt, now);
  if (at === null) {
    return "The backend did not say when the window refreshes, and EO is not going to invent a time for it.";
  }
  if (at <= now) return `The window refreshed ${magnitude(now - at)} ago — ${utcStamp(at)}.`;
  return `The window refreshes in ${magnitude(at - now)} — ${utcStamp(at)}.`;
}

/**
 * Whether the window this refusal names has already come back.
 *
 * Only ever true for the narrow past interval `quotaResetAt` accepts, but
 * that is exactly the case where "until then" would be telling somebody to
 * wait for something that has happened.
 */
function alreadyRefreshed(event: QuotaEvent, now: number): boolean {
  const at = quotaResetAt(event.resetsAt, now);
  return at !== null && at <= now;
}

/** What ends the wait, as the start of a sentence. */
function carryOnWhen(event: QuotaEvent, now: number): string {
  if (alreadyRefreshed(event, now)) return "EO picks the work back up";
  if (quotaResetAt(event.resetsAt, now) === null) {
    return `EO holds the work on "${event.provider}" until somebody says the window is back (Carry on now, on EO's message about the limit)`;
  }
  return `EO holds the work on "${event.provider}" until then`;
}

/**
 * Which window filled up, in a form that survives a backend inventing a
 * new one — "its five-hour usage window". Exported so the runtime's own
 * message (EO-798) names the window in the item's words.
 */
export function quotaWindowPhrase(window: string): string {
  // `unknown` is what the Claude adapter writes when the reading arrives
  // without a `rateLimitType`. Rendering it as "its unknown usage window"
  // would read as a window called "unknown".
  if (isUnnamedWindow(window)) return "a usage window it did not name";
  const named = window.trim();
  // Underscores are the backend's spelling, not a person's. Nothing here
  // maps the names — a plan that grows a seventh window must reach the
  // item as itself rather than as "other".
  return `its ${named.replace(/_/g, "-")} usage window`;
}

/**
 * What lands on the item when a run is stopped by a plan limit
 * (EO-172).
 *
 * Three things, because a person reading this needs all three and used
 * to get none of them: that the limit is what stopped the run, which
 * allowance it was, and when they can expect it back. The second
 * paragraph is there because the *previous* message on this item is
 * likely to be about a malformed result — the visible symptom of a turn
 * that ran out of allowance halfway through writing one — and somebody
 * has to be told not to go looking at the schema.
 *
 * One wording, in `packages/core`, for the same reason `limits.ts` holds
 * one: the run's `error` and the comment must not drift apart, since
 * they are read side by side.
 */
export function quotaStopReason(input: {
  /** Whoever was working, so the sentence can say this was not their doing. */
  agentName: string;
  event: QuotaEvent;
  now: number;
}): string {
  const { agentName, event, now } = input;
  // No share (EO-938): the run's own event is all this has, and Claude's
  // carries it as a fraction, so a full window would read "(1% used)".
  // "Is full" is what the refusal says.
  return [
    `The "${event.provider}" backend refused this run: ${quotaWindowPhrase(event.window)} is full. ` +
      `The run stopped there, and nothing has been retried.`,
    `Retrying could not help. A limit does not clear in the seconds between attempts, so asking again would spend ` +
      `an allowance that is already gone, fail the same way, and bury this reason one message deeper. If ${agentName} ` +
      `looks as though it produced something malformed just before this, that is the same turn being cut off ` +
      `mid-sentence — not a schema anybody needs to change.`,
    // Nobody is asked to reply (EO-798): the backend is held as a whole
    // until the window refreshes, and the run is carried on by itself
    // when it does. Which of three things ends the wait depends on what
    // EO knows of the reset: a time it can watch for, one already past,
    // or none — and then only a person can say the window is back.
    `${describeQuotaReset(event.resetsAt, now)} ${carryOnWhen(event, now)}, and ${agentName} carries on by itself ` +
      `in the same conversation from where this run stopped. Nobody needs to reply here.`,
  ].join("\n\n");
}
