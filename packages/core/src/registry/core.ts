import { buildRegistry, emptyRegistry, FAILED_RESULT, type BuiltinEntry, type Registry } from "./index.js";

/**
 * The functions the core ships itself (EO-459, ARCHITECTURE.md, "Where
 * the seams are", "A step").
 *
 * Every other builtin is a pack's. These are not, because what they do
 * belongs to no domain: waiting for a moment is something a support
 * pipeline, a hiring pipeline and a delivery pipeline all want, and none
 * of them should have to install the developer pack to get it. So they
 * are in the registry a core with nothing installed builds
 * (`coreRegistry`), and the fold adds them to whatever packs bring.
 *
 * Declared here as data for `BUILTIN_RESULTS`' reason: the runner
 * produces an outcome, the editor offers a row per outcome, and
 * `validatePipeline` checks a route key against them — and only the
 * runner can run the function.
 */

/** Waits until a moment in time, then reports `reached`. */
export const WAIT_UNTIL_ACTION = "wait_until";

/** What `wait_until` reports once the moment has come. */
export const WAIT_UNTIL_REACHED_RESULT = "reached";

/**
 * The step input naming a fixed moment: a date and a time with a time
 * zone, as `2026-11-01T09:00+01:00` or `2026-11-01T09:00[Europe/Paris]`.
 */
export const WAIT_UNTIL_AT_INPUT = "at";

/** The step input naming a field of the item's spec that holds the moment instead. */
export const WAIT_UNTIL_FIELD_INPUT = "field";

export const CORE_BUILTIN_ACTIONS = [WAIT_UNTIL_ACTION] as const;
export type CoreBuiltinAction = (typeof CORE_BUILTIN_ACTIONS)[number];

/**
 * What each of them can return, in the order the editor draws them.
 *
 * `failed` is a moment that could not be read: no input, a field the
 * item does not have, a value that is not a date and time with a zone.
 * It is a result rather than a failed check because asking again in five
 * minutes would find the same field missing — a failed check is retried
 * six times before anybody hears, and this is something a person has to
 * fix.
 */
export const CORE_BUILTIN_RESULTS = {
  wait_until: [WAIT_UNTIL_REACHED_RESULT, FAILED_RESULT],
} as const satisfies Record<CoreBuiltinAction, readonly [string, ...string[]]>;

export type CoreBuiltinResult<A extends CoreBuiltinAction = CoreBuiltinAction> = (typeof CORE_BUILTIN_RESULTS)[A][number];

/**
 * What the core declares about each of its functions.
 *
 * `wait_until` reaches nothing outside EO — it reads a clock and a row —
 * and it is made to be checked: asked on an interval, it says `waiting`
 * until the moment comes.
 */
const CORE_BUILTIN_ENTRIES: Record<CoreBuiltinAction, BuiltinEntry> = {
  wait_until: {
    label: "Wait until a date and time",
    results: CORE_BUILTIN_RESULTS.wait_until,
    // Exactly one of the two, which `waitUntilMoment` holds a step to; the
    // editor offers both and says so (EO-507).
    inputs: {
      [WAIT_UNTIL_AT_INPUT]: {
        type: "string",
        description: `The moment to wait for: a date and time with a time zone, such as "2026-11-01T09:00+01:00" or "2026-11-01T09:00[Europe/Paris]". Set this or "${WAIT_UNTIL_FIELD_INPUT}", not both.`,
      },
      [WAIT_UNTIL_FIELD_INPUT]: {
        type: "string",
        description: `The name of a field on the item that holds the moment instead, in the same form. Set this or "${WAIT_UNTIL_AT_INPUT}", not both.`,
      },
    },
    sideEffects: false,
    watch: true,
  },
};

/** The core's own builtins, by action, as a registry holds them. */
export function coreBuiltins(): ReadonlyMap<string, BuiltinEntry> {
  return new Map(CORE_BUILTIN_ACTIONS.map((action) => [action, CORE_BUILTIN_ENTRIES[action]]));
}

/** Whether this names a function the core ships rather than a pack. */
export function isCoreBuiltin(action: string | null): action is CoreBuiltinAction {
  return action !== null && (CORE_BUILTIN_ACTIONS as readonly string[]).includes(action);
}

/**
 * The registry a core with no pack installed builds: no roles, no item
 * types, no vocabulary — and the core's own functions.
 */
export function coreRegistry(): Registry {
  return buildRegistry({ ...emptyRegistry(), builtins: coreBuiltins() });
}

// ── Reading a moment ────────────────────────────────────────────

/** Where the moment came from, as a sentence's subject: `the "at" input`, `the "due" field`. */
export type WaitUntilMoment =
  | { ok: true; at: number; source: string }
  /** `field` is the spec field the step named, when the problem is with that field. */
  | { ok: false; reason: string; field?: string };

/** `2026-11-01T09:00`, with seconds and a fraction optional, then a zone. `T` or a space between. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(.*)$/;
/** `Z`, `+01:00` or `+0100`. */
const OFFSET = /^(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;
/** `[Europe/Paris]`, as RFC 9557 writes it, or the zone's name after a space. */
const ZONE_NAME = /^\[([^\]]+)\]$|^([A-Za-z][A-Za-z0-9_+\-/]*)$/;

/**
 * The milliseconds a zone is ahead of UTC at `utc`, or null for a zone
 * this runtime does not know.
 */
function zoneOffsetMs(utc: number, zone: string): number | null {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(utc / 1000) * 1000;
}

/**
 * A date and a time with a time zone, as milliseconds since the epoch, or
 * null for anything else.
 *
 * The zone is required. A time without one means a different moment on
 * every machine that reads it, and a wait that ends at a different hour
 * depending on where EO happens to run is not a wait anybody set. So
 * `2026-11-01T09:00` is refused, as is a bare date.
 *
 * Out-of-range parts are refused rather than rolled over: `2026-02-30`
 * is a mistake, not the second of March. So is a time a named zone
 * never shows, inside the hour its clock skips when summer time starts.
 * A time it shows twice, when the clock goes back, is read as one of
 * the two.
 */
export function parseZonedDateTime(text: string): number | null {
  const match = DATE_TIME.exec(text.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = "0", zone = ""] = match;
  const parts = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0"))] as const;
  const wall = Date.UTC(...parts);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() !== parts[1] || check.getUTCDate() !== parts[2]) return null;
  if (parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;

  const offset = OFFSET.exec(zone);
  if (offset !== null) {
    if (offset[1] === undefined) return wall;
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    if (hours > 23 || minutes > 59) return null;
    const sign = offset[1] === "-" ? -1 : 1;
    return wall - sign * (hours * 60 + minutes) * 60_000;
  }

  const named = ZONE_NAME.exec(zone);
  const name = named?.[1] ?? named?.[2];
  if (name === undefined) return null;
  // The wall time read in that zone. Asked twice, because the offset at
  // the guess can differ from the offset at the answer when a clock
  // change falls between them.
  const first = zoneOffsetMs(wall, name);
  if (first === null) return null;
  const settled = zoneOffsetMs(wall - first, name) ?? first;
  const instant = wall - settled;
  // And read back. A wall time inside the hour a clock skips forward
  // (02:30 in New York on the March change) is no moment at all, and
  // the two lookups above land an hour away from it — 01:30 by the
  // clock on the wall. Waiting until a time nobody wrote is worse than
  // saying the time does not exist, so it is refused.
  const readBack = zoneOffsetMs(instant, name);
  if (readBack === null || instant + readBack !== wall) return null;
  return instant;
}

/** How a value reads back in a sentence: the text quoted, anything else as JSON. */
function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
}

const ZONED_EXAMPLE = `a date and time with a time zone, such as "2026-11-01T09:00+01:00" or "2026-11-01T09:00[Europe/Paris]"`;

/**
 * The moment a `wait_until` step waits for, read from its inputs and the
 * item's spec, or why it cannot be.
 *
 * Exactly one of the two inputs: `at` for a fixed moment, `field` for
 * the name of a spec field holding one. Both is refused rather than one
 * of them winning, since a person who set both meant something this
 * cannot tell apart.
 */
export function waitUntilMoment(inputs: Readonly<Record<string, unknown>>, spec: Readonly<Record<string, unknown>> | null): WaitUntilMoment {
  const at = inputs[WAIT_UNTIL_AT_INPUT];
  const field = inputs[WAIT_UNTIL_FIELD_INPUT];
  const hasAt = at !== undefined && at !== "";
  const hasField = field !== undefined && field !== "";

  if (hasAt && hasField) {
    return { ok: false, reason: `This step sets both the "${WAIT_UNTIL_AT_INPUT}" and the "${WAIT_UNTIL_FIELD_INPUT}" inputs, so it cannot tell which moment to wait for. Set one of them.` };
  }
  if (!hasAt && !hasField) {
    return {
      ok: false,
      reason: `This step has nothing to wait for: set its "${WAIT_UNTIL_AT_INPUT}" input to ${ZONED_EXAMPLE}, or its "${WAIT_UNTIL_FIELD_INPUT}" input to the name of a field that holds one.`,
    };
  }

  if (hasAt) {
    const moment = typeof at === "string" ? parseZonedDateTime(at) : null;
    if (moment === null) return { ok: false, reason: `The "${WAIT_UNTIL_AT_INPUT}" input is ${shown(at)}, which is not ${ZONED_EXAMPLE}.` };
    return { ok: true, at: moment, source: `the "${WAIT_UNTIL_AT_INPUT}" input` };
  }

  if (typeof field !== "string") return { ok: false, reason: `The "${WAIT_UNTIL_FIELD_INPUT}" input is ${shown(field)}, which is not the name of a field.` };
  const value = spec !== null && Object.hasOwn(spec, field) ? spec[field] : undefined;
  if (value === undefined || value === null || value === "") {
    return { ok: false, field, reason: `The "${field}" field is not set on this item, so there is no date to wait for.` };
  }
  const moment = typeof value === "string" ? parseZonedDateTime(value) : null;
  if (moment === null) return { ok: false, field, reason: `The "${field}" field holds ${shown(value)}, which is not ${ZONED_EXAMPLE}.` };
  return { ok: true, at: moment, source: `the "${field}" field` };
}
