import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCH_GIVE_UP_HOURS,
  MAX_WATCH_FINDINGS,
  WatchFindingSchema,
  watchFindingsProblem,
  itemWatchLines, settledWatch, StepWatchSchema, watchDurationWords, watchIntervalWords, watchLine, watchNeverGivesUp } from "./watch.js";

describe("keep checking, as a column head says it (EO-456)", () => {
  it("says how often the step checks and when it gives up", () => {
    expect(watchLine({ watch: { everyMinutes: 5, giveUpAfterHours: 168 } })).toBe("Checks every 5 minutes · gives up after 7 days");
    expect(watchLine({ watch: { everyMinutes: 1, giveUpAfterHours: 2 } })).toBe("Checks every minute · gives up after 2 hours");
    expect(watchLine({ watch: { everyMinutes: 15, giveUpAfterHours: 36 } })).toBe("Checks every 15 minutes · gives up after 36 hours");
  });

  it("says the interval in the unit that reads naturally (EO-699)", () => {
    expect(watchLine({ watch: { everyMinutes: 1440, giveUpAfterHours: 168 } })).toBe("Checks every day · gives up after 7 days");
    expect(watchLine({ watch: { everyMinutes: 60, giveUpAfterHours: 168 } })).toBe("Checks every hour · gives up after 7 days");
    expect(watchLine({ watch: { everyMinutes: 5, giveUpAfterHours: 168 } })).toBe("Checks every 5 minutes · gives up after 7 days");
    expect(watchIntervalWords(360)).toBe("6 hours");
    expect(watchIntervalWords(2880)).toBe("2 days");
    expect(watchIntervalWords(90)).toBe("90 minutes");
    expect(watchIntervalWords(1500)).toBe("25 hours");
  });

  it("says nothing about a step that runs once", () => {
    expect(watchLine({ watch: null })).toBeNull();
  });

  it("reads a duration in the largest unit that reads naturally", () => {
    expect(watchDurationWords(30 * 60_000)).toBe("30 minutes");
    expect(watchDurationWords(60 * 60_000)).toBe("1 hour");
    expect(watchDurationWords(26 * 3_600_000)).toBe("26 hours");
    expect(watchDurationWords(48 * 3_600_000)).toBe("2 days");
    // A watch that gave up runs a little past its limit, and still reads as the limit.
    expect(watchDurationWords(168 * 3_600_000 + 4 * 60_000)).toBe("7 days");
  });

  it("gives up after a week unless the step says otherwise", () => {
    expect(StepWatchSchema.parse({ everyMinutes: 5 })).toEqual({ everyMinutes: 5, giveUpAfterHours: DEFAULT_WATCH_GIVE_UP_HOURS });
    expect(DEFAULT_WATCH_GIVE_UP_HOURS).toBe(168);
  });

  it("says a step that never gives up never does, instead of a time (EO-571)", () => {
    expect(watchLine({ watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true } })).toBe("Checks every 5 minutes · never gives up");
    expect(watchLine({ watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: false } })).toBe("Checks every 5 minutes · gives up after 7 days");
  });

  it("never gives up only when the watch says so: hours left out are still a week (EO-571)", () => {
    const never = StepWatchSchema.parse({ everyMinutes: 5, neverGivesUp: true });
    expect(never).toEqual({ everyMinutes: 5, giveUpAfterHours: DEFAULT_WATCH_GIVE_UP_HOURS, neverGivesUp: true });
    expect(watchNeverGivesUp(never)).toBe(true);
    expect(watchNeverGivesUp(StepWatchSchema.parse({ everyMinutes: 5 }))).toBe(false);
    expect(watchNeverGivesUp(StepWatchSchema.parse({ everyMinutes: 5, giveUpAfterHours: 1e9 }))).toBe(false);
    // It survives JSON, which is how MCP answers and exports travel.
    expect(StepWatchSchema.parse(JSON.parse(JSON.stringify(never)))).toEqual(never);
  });

  it("settles a false flag to what its absence says, so a written and a stored watch compare equal (EO-571)", () => {
    expect(settledWatch({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: false })).toEqual({ everyMinutes: 5, giveUpAfterHours: 168 });
    expect(settledWatch({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true })).toEqual({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true });
  });

  it("leaves an interval under a minute to the validator, which can name the step", () => {
    expect(StepWatchSchema.safeParse({ everyMinutes: 0.5, giveUpAfterHours: 1 }).success).toBe(true);
  });
});

describe("keep checking, as the item page says it (EO-456)", () => {
  const view = { stepId: "s", startedAt: 0, lastCheckedAt: 100, nextCheckAt: 200, giveUpAt: 900, checks: 3, consecutiveFailures: 0, lastError: null };
  const at = (ms: number) => `t${ms}`;

  it("says when the last check ran, when the next is due and when it gives up", () => {
    expect(itemWatchLines(view, at)).toEqual(["Last checked t100", "Next check t200", "Gives up t900"]);
  });

  it("says so before the first check, and names the failures while checks are failing", () => {
    expect(itemWatchLines({ ...view, lastCheckedAt: null }, at)[0]).toBe("Not checked yet");
    expect(itemWatchLines({ ...view, consecutiveFailures: 2, lastError: "503" }, at).at(-1)).toBe("The last 2 checks failed: 503");
  });

  it("says a watch that never gives up never does, instead of a date (EO-571)", () => {
    expect(itemWatchLines({ ...view, giveUpAt: null }, at)).toEqual(["Last checked t100", "Next check t200", "Never gives up"]);
  });
});

describe("what an intake check found (EO-752)", () => {
  it("takes a key, a title and the optional body, spec and existing branch", () => {
    const finding = { key: "dependabot:owner/repo#123", title: "Bump zod", body: "From 4.6 to 4.7", spec: { pr: 123 }, existingBranch: "dependabot/zod" };
    expect(WatchFindingSchema.parse(finding)).toEqual(finding);
    expect(WatchFindingSchema.parse({ key: "a", title: "b" })).toEqual({ key: "a", title: "b" });
  });

  it("refuses a blank or over-long key, a blank title, a spec that is not an object and a blank branch", () => {
    expect(WatchFindingSchema.safeParse({ key: "", title: "t" }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "   ", title: "t" }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "k".repeat(200), title: "t" }).success).toBe(true);
    expect(WatchFindingSchema.safeParse({ key: "k".repeat(201), title: "t" }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "k", title: "" }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "k", title: "t", body: 3 }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "k", title: "t", spec: [1] }).success).toBe(false);
    expect(WatchFindingSchema.safeParse({ key: "k", title: "t", existingBranch: "" }).success).toBe(false);
  });

  it("names what keeps a list of findings from being filed", () => {
    expect(watchFindingsProblem([{ key: "a", title: "A" }, { key: "b", title: "B" }])).toBeNull();
    const many = Array.from({ length: MAX_WATCH_FINDINGS + 1 }, (_, index) => ({ key: `k${index}`, title: "t" }));
    expect(watchFindingsProblem(many)).toBe(`An intake check may report at most ${MAX_WATCH_FINDINGS} findings, and this one reported ${MAX_WATCH_FINDINGS + 1}.`);
    expect(watchFindingsProblem([{ key: "a", title: "A" }, { key: "b" }])).toMatch(/^findings\[1\] is not a finding EO can file \(title\)/);
    expect(watchFindingsProblem([{ key: "a", title: "A" }, { key: "b", title: "B" }, { key: "a", title: "C" }])).toBe(
      'findings[0] and findings[2] both have the key "a". Each finding needs a key of its own.',
    );
  });
});
