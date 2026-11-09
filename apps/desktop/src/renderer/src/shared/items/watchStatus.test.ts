import { describe, expect, it } from "vitest";
import type { ItemWatchView } from "@eo/core";
import { untilWords, watchStatusOf } from "./watchStatus";

/** A watching card's status line (EO-699): when it checks next, instead of "Done". */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_800_000_000_000;

function watch(overrides: Partial<ItemWatchView> = {}): ItemWatchView {
  return {
    stepId: "watch",
    startedAt: NOW - 3 * 24 * HOUR,
    lastCheckedAt: NOW - 20 * HOUR,
    nextCheckAt: NOW + 4 * HOUR,
    giveUpAt: null,
    checks: 3,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

const card = (w: ItemWatchView | null | undefined, latestRunStatus: string | null = "succeeded", heldAt: number | null = null) => ({ watch: w, latestRunStatus, heldAt });

describe("a watching card's status line", () => {
  it("between checks, says when the next is and that the last ran without failing", () => {
    expect(watchStatusOf(card(watch()), NOW)).toMatchObject({ kind: "waiting", label: "Next check in 4h", detail: "Last check 20h ago · OK" });
  });

  it("before the first check, says it has not checked yet", () => {
    expect(watchStatusOf(card(watch({ lastCheckedAt: null, nextCheckAt: NOW + 3 * MINUTE, checks: 0 }), null), NOW)).toMatchObject({
      kind: "waiting",
      label: "Next check in 3m",
      detail: "Not checked yet",
    });
  });

  it("while a quiet check is in flight, says it is checking now rather than counting down to the check after it", () => {
    // A check moves the next check an interval on before it runs, and a quiet one makes no run: the flag is what says it is running.
    const inFlight = watch({ lastCheckedAt: NOW - 24 * HOUR, nextCheckAt: NOW + 24 * HOUR, checking: true });
    expect(watchStatusOf(card(inFlight), NOW)).toMatchObject({ kind: "checking", label: "Checking now", detail: "Last check 1d ago · OK" });
    // And once it is done, the countdown again.
    expect(watchStatusOf(card({ ...inFlight, checking: false, lastCheckedAt: NOW, nextCheckAt: NOW + 24 * HOUR }), NOW)).toMatchObject({
      kind: "waiting",
      label: "Next check in 1d",
      detail: "Last check just now · OK",
    });
  });

  it("while a retry is in flight, says it is checking now over the failures so far, not a retry countdown", () => {
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW + 4 * HOUR, consecutiveFailures: 2, lastError: "503", checking: true }), "failed"), NOW)).toMatchObject({
      kind: "checking",
      label: "Checking now",
      detail: "2 in a row · 503",
    });
  });

  it("while a check with a run of its own is in flight, says it is checking now over the last check", () => {
    expect(watchStatusOf(card(watch({ lastCheckedAt: NOW - HOUR, nextCheckAt: NOW + 23 * HOUR }), "running"), NOW)).toMatchObject({
      kind: "checking",
      label: "Checking now",
      detail: "Last check 1h ago · OK",
    });
  });

  it("after failed checks, says it is retrying, how many failed in a row and with what", () => {
    expect(watchStatusOf(card(watch({ lastCheckedAt: NOW - MINUTE, nextCheckAt: NOW + 5 * MINUTE, consecutiveFailures: 2, lastError: "rate limit exceeded" }), "failed"), NOW)).toMatchObject({
      kind: "failing",
      label: "Check failed · retrying in 5m",
      detail: "2 in a row · rate limit exceeded",
    });
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW + MINUTE, consecutiveFailures: 1, lastError: null }), "failed"), NOW)?.detail).toBe("Failed once");
  });

  it("never counts down past nought: a due check, or a due retry, reads as checking now", () => {
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW - 10 * MINUTE })), NOW)).toMatchObject({ kind: "checking", label: "Checking now" });
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW })), NOW)).toMatchObject({ kind: "checking", label: "Checking now" });
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW - MINUTE, consecutiveFailures: 3, lastError: "503" }), "failed"), NOW)).toMatchObject({
      kind: "checking",
      label: "Checking now",
      detail: "3 in a row · 503",
    });
    expect(watchStatusOf(card(watch({ nextCheckAt: NOW + 30_000 })), NOW)?.label).toBe("Next check in 1m");
  });

  it("carries the full times on hover", () => {
    expect(watchStatusOf(card(watch()), NOW)?.title).toMatch(/^Last checked .+\nNext check .+\nNever gives up$/);
  });

  it("is nothing for an item on a step that runs once, so the card keeps its run status", () => {
    expect(watchStatusOf(card(null), NOW)).toBeNull();
    expect(watchStatusOf(card(undefined), NOW)).toBeNull();
  });

  it("leaves a held item, and one waiting on a person, to say so", () => {
    expect(watchStatusOf(card(watch(), "succeeded", NOW - HOUR), NOW)).toBeNull();
    expect(watchStatusOf(card(watch(), "awaiting_input"), NOW)).toBeNull();
  });

  it("counts down in the card's coarse units", () => {
    expect(untilWords(59 * MINUTE)).toBe("59m");
    expect(untilWords(60 * MINUTE)).toBe("1h");
    expect(untilWords(23 * HOUR + 59 * MINUTE)).toBe("23h");
    expect(untilWords(50 * HOUR)).toBe("2d");
  });
});
