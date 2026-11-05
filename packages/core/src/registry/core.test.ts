import { describe, expect, it } from "vitest";
import { WAITING_RESULT } from "../watch.js";
import { coreBuiltins, coreRegistry, isCoreBuiltin, parseZonedDateTime, waitUntilMoment, WAIT_UNTIL_ACTION, WAIT_UNTIL_AT_INPUT, WAIT_UNTIL_FIELD_INPUT } from "./core.js";
import { developerRegistry } from "./developer.js";
import { builtinCanWait, builtinHasSideEffects, builtinResults, emptyRegistry, fromRegistryView, isBuiltinAction, toRegistryView } from "./index.js";

/**
 * The core's own builtins (EO-459): what the core ships with no pack
 * installed, and how `wait_until` reads the moment it waits for.
 */
describe("the core's builtins", () => {
  it("registers wait_until with reached and failed, able to wait and with no side effects", () => {
    const registry = coreRegistry();

    expect(isBuiltinAction(registry, WAIT_UNTIL_ACTION)).toBe(true);
    expect(builtinResults(registry, WAIT_UNTIL_ACTION)).toEqual(["reached", "failed"]);
    expect(builtinCanWait(registry, WAIT_UNTIL_ACTION)).toBe(true);
    expect(builtinHasSideEffects(registry, WAIT_UNTIL_ACTION)).toBe(false);
    // `waiting` is what it says while it waits, never a result it declares.
    expect(builtinResults(registry, WAIT_UNTIL_ACTION)).not.toContain(WAITING_RESULT);
  });

  it("builds a registry with no packs: no roles, no types, no vocabulary, and the core's functions", () => {
    const registry = coreRegistry();

    expect(registry.roles.size).toBe(0);
    expect(registry.itemTypes.size).toBe(0);
    expect(registry.packs.size).toBe(0);
    expect([...registry.builtins.keys()]).toEqual([WAIT_UNTIL_ACTION]);
    // Still empty is empty: the renderer's placeholder is not the core.
    expect(emptyRegistry().builtins.size).toBe(0);
  });

  it("survives the wire, so the editor offers it and the renderer's validator accepts it", () => {
    const back = fromRegistryView(toRegistryView(coreRegistry()));
    expect(back.builtins.get(WAIT_UNTIL_ACTION)).toEqual(coreRegistry().builtins.get(WAIT_UNTIL_ACTION));
    expect(back.builtins.get(WAIT_UNTIL_ACTION)).toMatchObject({ label: "Wait until a date and time", results: ["reached", "failed"], sideEffects: false, watch: true });
  });

  it("declares the two inputs it reads, so the editor can offer them (EO-507)", () => {
    const inputs = coreRegistry().builtins.get(WAIT_UNTIL_ACTION)?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual([WAIT_UNTIL_AT_INPUT, WAIT_UNTIL_FIELD_INPUT]);
    expect(inputs[WAIT_UNTIL_AT_INPUT]).toMatchObject({ type: "string", description: expect.stringContaining("time zone") as unknown });
    expect(inputs[WAIT_UNTIL_FIELD_INPUT]).toMatchObject({ type: "string", description: expect.stringContaining("field") as unknown });
  });

  it("is the core's, not a pack's", () => {
    expect(isCoreBuiltin(WAIT_UNTIL_ACTION)).toBe(true);
    expect(isCoreBuiltin("open_pull_request")).toBe(false);
    expect(isCoreBuiltin(null)).toBe(false);
    expect(developerRegistry().builtins.has(WAIT_UNTIL_ACTION)).toBe(false);
    expect([...coreBuiltins().keys()]).toEqual([WAIT_UNTIL_ACTION]);
  });
});

describe("parseZonedDateTime", () => {
  it("reads a date and time with an offset or Z", () => {
    expect(parseZonedDateTime("2026-11-01T09:00Z")).toBe(Date.UTC(2026, 10, 1, 9, 0));
    expect(parseZonedDateTime("2026-11-01T09:00:30+01:00")).toBe(Date.UTC(2026, 10, 1, 8, 0, 30));
    expect(parseZonedDateTime("2026-11-01 09:00-0530")).toBe(Date.UTC(2026, 10, 1, 14, 30));
    expect(parseZonedDateTime("2026-11-01T09:00:00.250Z")).toBe(Date.UTC(2026, 10, 1, 9, 0, 0, 250));
  });

  it("reads a date and time in a named zone, either side of a clock change", () => {
    // Paris is UTC+2 in summer and UTC+1 from the last Sunday of October.
    expect(parseZonedDateTime("2026-07-01T09:00[Europe/Paris]")).toBe(Date.UTC(2026, 6, 1, 7, 0));
    expect(parseZonedDateTime("2026-11-01T09:00[Europe/Paris]")).toBe(Date.UTC(2026, 10, 1, 8, 0));
    expect(parseZonedDateTime("2026-11-01T09:00 America/New_York")).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(parseZonedDateTime("2026-11-01T09:00[UTC]")).toBe(Date.UTC(2026, 10, 1, 9, 0));
  });

  it("refuses a time a named zone never shows, inside the hour its clock skips forward", () => {
    // New York goes from 02:00 EST straight to 03:00 EDT on 8 March 2026.
    expect(parseZonedDateTime("2026-03-08T02:30[America/New_York]")).toBeNull();
    expect(parseZonedDateTime("2026-03-08T02:00[America/New_York]")).toBeNull();
    // Either side of the gap is an ordinary moment.
    expect(parseZonedDateTime("2026-03-08T01:30[America/New_York]")).toBe(Date.UTC(2026, 2, 8, 6, 30));
    expect(parseZonedDateTime("2026-03-08T03:30[America/New_York]")).toBe(Date.UTC(2026, 2, 8, 7, 30));
    // Paris skips 02:00–03:00 on 29 March 2026.
    expect(parseZonedDateTime("2026-03-29T02:15[Europe/Paris]")).toBeNull();
    // An offset says exactly which moment it means, so it has no gap.
    expect(parseZonedDateTime("2026-03-08T02:30-05:00")).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it("reads a time a named zone shows twice, when its clock goes back, as one of the two", () => {
    // 01:30 happens at 05:30Z (EDT) and again at 06:30Z (EST) on 1 November 2026.
    expect([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]).toContain(parseZonedDateTime("2026-11-01T01:30[America/New_York]"));
  });

  it("refuses a time with no zone, a bare date, a zone nobody knows and parts out of range", () => {
    expect(parseZonedDateTime("2026-11-01T09:00")).toBeNull();
    expect(parseZonedDateTime("2026-11-01")).toBeNull();
    expect(parseZonedDateTime("2026-11-01T09:00[Mars/Olympus]")).toBeNull();
    expect(parseZonedDateTime("2026-02-30T09:00Z")).toBeNull();
    expect(parseZonedDateTime("2026-11-01T25:00Z")).toBeNull();
    expect(parseZonedDateTime("next Tuesday")).toBeNull();
    expect(parseZonedDateTime("")).toBeNull();
  });
});

describe("waitUntilMoment", () => {
  const at = Date.UTC(2026, 10, 1, 8, 0);

  it("reads a fixed moment from the at input", () => {
    expect(waitUntilMoment({ at: "2026-11-01T09:00+01:00" }, null)).toEqual({ ok: true, at, source: `the "at" input` });
  });

  it("reads the moment from the spec field the field input names", () => {
    expect(waitUntilMoment({ field: "due" }, { due: "2026-11-01T09:00[Europe/Paris]" })).toEqual({ ok: true, at, source: `the "due" field` });
  });

  it("names the field when the item does not have it, or it holds no date", () => {
    for (const spec of [null, {}, { due: "" }, { due: null }]) {
      const missing = waitUntilMoment({ field: "due" }, spec);
      expect(missing).toMatchObject({ ok: false, field: "due" });
      if (!missing.ok) expect(missing.reason).toContain(`"due" field is not set`);
    }

    const unreadable = waitUntilMoment({ field: "due" }, { due: "soon" });
    expect(unreadable).toMatchObject({ ok: false, field: "due" });
    if (!unreadable.ok) expect(unreadable.reason).toContain(`The "due" field holds "soon"`);

    const skipped = waitUntilMoment({ field: "due" }, { due: "2026-03-08T02:30[America/New_York]" });
    expect(skipped).toMatchObject({ ok: false, field: "due" });
    if (!skipped.ok) expect(skipped.reason).toContain(`The "due" field holds "2026-03-08T02:30[America/New_York]"`);

    const zoneless = waitUntilMoment({ field: "due" }, { due: "2026-11-01T09:00" });
    expect(zoneless).toMatchObject({ ok: false, field: "due" });

    const number = waitUntilMoment({ field: "due" }, { due: 1_700_000_000_000 });
    expect(number).toMatchObject({ ok: false, field: "due" });
  });

  it("refuses an at input that is not a moment, a step that sets neither input and one that sets both", () => {
    expect(waitUntilMoment({ at: "tomorrow" }, null)).toMatchObject({ ok: false });
    const neither = waitUntilMoment({}, { due: "2026-11-01T09:00Z" });
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.reason).toContain("nothing to wait for");
    const both = waitUntilMoment({ at: "2026-11-01T09:00Z", field: "due" }, null);
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.reason).toContain("both");
  });
});
