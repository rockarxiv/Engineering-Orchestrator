import { describe, expect, it } from "vitest";
import type { QuotaEvent } from "./agent-provider.js";
import { createQuotaRefusals, describeQuotaReset, isQuotaRefusal, quotaResetAt, quotaStopReason } from "./quota.js";

/** A fixed "now" so every expectation below is arithmetic rather than a race. */
const NOW = Date.UTC(2026, 7, 28, 20, 40); // 2026-08-28 20:40 UTC
const HOUR = 3_600_000;

function reading(over: Partial<QuotaEvent> = {}): QuotaEvent {
  return { type: "quota", provider: "claude", window: "five_hour", utilization: 100, status: "rejected", ...over };
}

describe("isQuotaRefusal", () => {
  it("is only the backend's own word for a refusal", () => {
    expect(isQuotaRefusal(reading({ status: "rejected" }))).toBe(true);
    expect(isQuotaRefusal(reading({ status: "allowed" }))).toBe(false);
    // A warning is a window filling up, not a window that stopped
    // answering. Treating it as a refusal would park items that could
    // still have been worked.
    expect(isQuotaRefusal(reading({ status: "allowed_warning", utilization: 96 }))).toBe(false);
  });
});

describe("createQuotaRefusals", () => {
  const fiveHour = reading({ window: "five_hour", resetsAt: (NOW + 3 * HOUR) / 1000 });
  const sevenDay = reading({ window: "seven_day", resetsAt: (NOW + 4 * 24 * HOUR) / 1000 });

  it("reports the window that holds the work longest, whichever refused last", () => {
    // The case that was missed: a single slot would have reported
    // whichever arrived second. Both orders must name the seven-day
    // window, because waiting out three hours leaves the work blocked.
    const late = createQuotaRefusals();
    late.record(sevenDay);
    late.record(fiveHour);
    expect(late.blocking(NOW)?.window).toBe("seven_day");

    const early = createQuotaRefusals();
    early.record(fiveHour);
    early.record(sevenDay);
    expect(early.blocking(NOW)?.window).toBe("seven_day");
  });

  it("keeps the same window name from two backends apart", () => {
    const refusals = createQuotaRefusals();
    refusals.record(reading({ provider: "claude", window: "five_hour", resetsAt: (NOW + HOUR) / 1000 }));
    refusals.record(reading({ provider: "codex", window: "five_hour", resetsAt: (NOW + 6 * HOUR) / 1000 }));

    // Two allowances, not one overwriting the other.
    expect(refusals.blocking(NOW)?.provider).toBe("codex");
  });

  it("stops counting a window that has stopped refusing", () => {
    const refusals = createQuotaRefusals();
    refusals.record(sevenDay);
    refusals.record(fiveHour);
    // The seven-day window came back mid-run; only the five-hour one is
    // still holding anything up.
    refusals.record(reading({ window: "seven_day", status: "allowed", utilization: 40 }));

    expect(refusals.blocking(NOW)?.window).toBe("five_hour");
  });

  it("is holding nothing once every window has come back", () => {
    const refusals = createQuotaRefusals();
    expect(refusals.blocking(NOW)).toBeNull();
    refusals.record(fiveHour);
    refusals.record(reading({ window: "five_hour", status: "allowed_warning", utilization: 80 }));
    expect(refusals.blocking(NOW)).toBeNull();
  });

  it("lets a reset nobody can read outrank one that can", () => {
    // "Back in three hours" next to a window that might need a week is
    // the confident wrong answer. An unreadable reset wins, and the
    // message that follows says EO cannot tell.
    const refusals = createQuotaRefusals();
    refusals.record(sevenDay);
    const noReset: QuotaEvent = { type: "quota", provider: "claude", window: "seven_day_opus", utilization: 100, status: "rejected" };
    refusals.record(noReset);

    expect(refusals.blocking(NOW)?.window).toBe("seven_day_opus");
  });

  it("takes a fresher reading of the same window over the stale one", () => {
    const refusals = createQuotaRefusals();
    refusals.record(fiveHour);
    refusals.record(reading({ window: "five_hour", resetsAt: (NOW + 5 * HOUR) / 1000 }));

    expect(refusals.blocking(NOW)?.resetsAt).toBe((NOW + 5 * HOUR) / 1000);
  });
});

describe("quotaResetAt", () => {
  it("reads epoch seconds, which is what a plausible value has to be", () => {
    expect(quotaResetAt((NOW + 3 * HOUR) / 1000, NOW)).toBe(NOW + 3 * HOUR);
  });

  it("reads epoch milliseconds too, since the field's unit is undocumented", () => {
    expect(quotaResetAt(NOW + 3 * HOUR, NOW)).toBe(NOW + 3 * HOUR);
  });

  it("returns nothing at all rather than a wrong time", () => {
    // A duration, not an instant — five hours in seconds. Read either
    // way it lands in 1970, so neither reading is believed.
    expect(quotaResetAt(18_000, NOW)).toBeNull();
    expect(quotaResetAt(0, NOW)).toBeNull();
    expect(quotaResetAt(Number.NaN, NOW)).toBeNull();
    expect(quotaResetAt(undefined, NOW)).toBeNull();
    // Next year: past any window these plans have, so it is a number
    // this code has misread rather than a reset.
    expect(quotaResetAt((NOW + 400 * 24 * HOUR) / 1000, NOW)).toBeNull();
  });

  it("still believes a window that refreshed while EO was reading about it", () => {
    expect(quotaResetAt((NOW - 60_000) / 1000, NOW)).toBe(NOW - 60_000);
    expect(quotaResetAt((NOW - 6 * HOUR) / 1000, NOW)).toBeNull(); // long gone is a misread, not a reset
  });
});

describe("describeQuotaReset", () => {
  it("leads with the gap, which is the part somebody reads at a glance", () => {
    expect(describeQuotaReset((NOW + 3 * HOUR) / 1000, NOW)).toBe("The window refreshes in about 3 hours — 2026-08-28 23:40 UTC.");
  });

  it("scales the unit to the wait", () => {
    expect(describeQuotaReset((NOW + 25 * 60_000) / 1000, NOW)).toContain("in about 25 minutes");
    expect(describeQuotaReset((NOW + 30_000) / 1000, NOW)).toContain("in under a minute");
    expect(describeQuotaReset((NOW + 5 * 24 * HOUR) / 1000, NOW)).toContain("in about 5 days");
  });

  it("says it does not know rather than inventing a time", () => {
    const said = describeQuotaReset(undefined, NOW);
    expect(said).toContain("did not say when");
    expect(said).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("puts a reset that has already been in the past tense, not as a wait", () => {
    // quotaResetAt believes a reset up to five minutes behind now. That
    // interval used to render as "refreshes in under a minute" while the
    // stamp beside it was in the past: one sentence telling a reader to
    // wait, the next saying the wait is over.
    const said = describeQuotaReset((NOW - 60_000) / 1000, NOW);

    expect(said).toBe("The window refreshed about 1 minute ago — 2026-08-28 20:39 UTC.");
    expect(said).not.toContain("refreshes in");
  });

  it("reads a reset landing exactly on now as already gone rather than as a wait", () => {
    expect(describeQuotaReset(NOW / 1000, NOW)).toContain("refreshed under a minute ago");
  });
});

describe("quotaStopReason", () => {
  it("names the limit, the provider, the window and when it comes back", () => {
    const said = quotaStopReason({ agentName: "Sam", event: reading({ resetsAt: (NOW + 3 * HOUR) / 1000 }), now: NOW });

    expect(said).toContain('"claude" backend refused this run');
    expect(said).toContain("five-hour usage window"); // the backend's own name, minus its underscores
    expect(said).toContain("(100% used)");
    expect(said).toContain("in about 3 hours");
    // The whole point of the item: a person must not be sent to look
    // at the schema for a turn that ran out of allowance.
    expect(said).toContain("nothing has been retried");
    expect(said).toContain("Sam");
  });

  it("leaves the share out when the backend did not measure one", () => {
    // Built without the key rather than with an `undefined` one: absent
    // is the fact being tested, and the two are different types here.
    const unmeasured: QuotaEvent = { type: "quota", provider: "claude", window: "five_hour", status: "rejected" };
    const said = quotaStopReason({ agentName: "Sam", event: unmeasured, now: NOW });

    expect(said).not.toContain("% used");
    expect(said).toContain("five-hour usage window is full.");
  });

  it("does not pretend to know a window the backend did not name", () => {
    const said = quotaStopReason({ agentName: "Sam", event: reading({ window: "unknown" }), now: NOW });

    expect(said).toContain("a usage window it did not name");
    expect(said).not.toContain("its unknown");
  });

  it("passes an unfamiliar window through as itself rather than as 'other'", () => {
    const said = quotaStopReason({ agentName: "Sam", event: reading({ window: "seven_day_overage_included" }), now: NOW });

    expect(said).toContain("seven-day-overage-included usage window");
  });

  it("does not tell somebody to wait for a window that has already come back", () => {
    const said = quotaStopReason({ agentName: "Sam", event: reading({ resetsAt: (NOW - 60_000) / 1000 }), now: NOW });

    expect(said).toContain("refreshed about 1 minute ago");
    expect(said).toContain("Reply to pick the work back up");
    expect(said).not.toContain("Reply once it has"); // there is nothing left to wait for
  });

  it("says how to pick the work back up", () => {
    const said = quotaStopReason({ agentName: "Sam", event: reading(), now: NOW });

    // Resumed, not restarted: the run parks with its thread, so a reply
    // carries on rather than beginning the work again from nothing.
    expect(said).toContain("Reply once it has");
    expect(said).toContain("same conversation");
  });
});
