import type { Job, JobTrigger, Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getJob, listOccurrences, recordOccurrence, updateRun } from "../db/repos/index.js";
import { items, jobs } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { occurrenceOverBudget, pauseForBudget, pauseJob, resumeJob } from "./budget.js";
import { catchUpJob } from "./catchUp.js";
import { fireJob } from "./fire.js";
import { createJob, updateJob } from "./jobs.js";
import { jobSummary, nextRunAt, occurrenceRows } from "./summary.js";

/**
 * What the Jobs list and the Job page read off a job (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs"), and what editing one does to it.
 *
 * The clock is driven rather than waited for, `catchUp.test.ts`'s rule:
 * every moment is an explicit UTC literal and every schedule names its
 * zone, so nothing here depends on where the machine running the suite
 * happens to be.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";

/** 2026-06-01 is a Monday. 08:00 in Berlin that day is 06:00Z. */
const MONDAY_0800_BERLIN = Date.UTC(2026, 5, 1, 6, 0);

const DAILY_0800_BERLIN: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "daily", hour: 8, minute: 0 },
  timeZone: BERLIN,
  catchUpWithinMinutes: 180,
};

function job(trigger: JobTrigger = DAILY_0800_BERLIN, createdAt = MONDAY_0800_BERLIN - 60_000): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
  });
  if (!result.ok) throw new Error(result.problem);
  // `createJob` stamps "now", and the sweep starts from a job's creation
  // before there is any history — `catchUp.test.ts` says why.
  handle.db.update(jobs).set({ createdAt }).where(eq(jobs.id, result.job.id)).run();
  return { ...result.job, createdAt };
}

describe("when a job next comes round", () => {
  it("is the next occurrence after now, in the job's own zone", () => {
    // 07:00 Berlin on the Monday. The next 08:00 is an hour away.
    expect(nextRunAt(job(), MONDAY_0800_BERLIN - 60 * 60_000)).toBe(MONDAY_0800_BERLIN);
    // 09:00 Berlin: this morning's has gone, so it is tomorrow's.
    expect(nextRunAt(job(), MONDAY_0800_BERLIN + 60 * 60_000)).toBe(MONDAY_0800_BERLIN + 24 * 60 * 60_000);
  });

  it("is nothing at all for a trigger with no calendar", () => {
    const manual = createJob(handle.db, {
      projectId: null,
      name: "On demand",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "developer:story", title: "Now", body: null },
    });
    expect(manual.ok && nextRunAt(manual.job, MONDAY_0800_BERLIN)).toBeNull();
  });

  /**
   * A paused job's next occurrence is a real moment that will come and
   * be written down as a skip. Blanking it would hide what resuming
   * would do.
   */
  it("is still computed while the job is paused", () => {
    const paused = job();
    pauseJob(handle.db, paused.id as Uuid, MONDAY_0800_BERLIN, "by hand");

    expect(jobSummary(handle.db, getJob(handle.db, paused.id as Uuid)!, MONDAY_0800_BERLIN - 60 * 60_000).nextRunAt).toBe(MONDAY_0800_BERLIN);
  });
});

/**
 * The acceptance criterion in as many words: editing the schedule and
 * the time zone on the page changes the next-run time shown *and* the
 * next occurrence fired. Both halves, because the page showing 09:00
 * while the scheduler still fires at 08:00 is the failure worth a test
 * — the number a person reads and the moment EO acts have to come from
 * one answer.
 */
describe("editing the schedule and the zone", () => {
  it("moves the next run shown, and the occurrence that fires", () => {
    const monday = job();
    // Before the edit: 07:00 Berlin, so the next run is 08:00 Berlin.
    expect(jobSummary(handle.db, monday, MONDAY_0800_BERLIN - 60 * 60_000).nextRunAt).toBe(MONDAY_0800_BERLIN);

    const edited = updateJob(handle.db, {
      jobId: monday.id as Uuid,
      trigger: { kind: "schedule", schedule: { kind: "daily", hour: 8, minute: 0 }, timeZone: NEW_YORK, catchUpWithinMinutes: 180 },
    });
    expect(edited.ok).toBe(true);

    // 08:00 in New York on that Monday is 12:00Z — six hours after the
    // Berlin one, and the machine's own zone has nothing to do with it.
    const NEW_YORK_0800 = Date.UTC(2026, 5, 1, 12, 0);
    const after = getJob(handle.db, monday.id as Uuid)!;
    expect(jobSummary(handle.db, after, MONDAY_0800_BERLIN - 60 * 60_000).nextRunAt).toBe(NEW_YORK_0800);

    // And the sweep agrees. At 08:05 Berlin nothing is due any more; at
    // 08:05 New York the edited occurrence fires, for the moment it was
    // edited to.
    expect(catchUpJob(handle.db, after, { now: MONDAY_0800_BERLIN + 5 * 60_000 }).fired).toEqual([]);
    const fired = catchUpJob(handle.db, after, { now: NEW_YORK_0800 + 5 * 60_000 }).fired;
    expect(fired).toHaveLength(1);
    expect(fired[0]?.dueAt).toBe(NEW_YORK_0800);
  });

  it("refuses a zone this machine does not know, and changes nothing", () => {
    const monday = job();

    const refused = updateJob(handle.db, {
      jobId: monday.id as Uuid,
      trigger: { kind: "schedule", schedule: { kind: "daily", hour: 9, minute: 0 }, timeZone: "Europe/Berln", catchUpWithinMinutes: 180 },
    });

    expect(refused.ok).toBe(false);
    expect(getJob(handle.db, monday.id as Uuid)?.trigger).toEqual(DAILY_0800_BERLIN);
  });

  it("renames the job", () => {
    const monday = job();

    expect(updateJob(handle.db, { jobId: monday.id as Uuid, name: "Weekly digest" }).ok).toBe(true);

    expect(getJob(handle.db, monday.id as Uuid)?.name).toBe("Weekly digest");
  });

  it("will not edit a deleted job", () => {
    const monday = job();
    handle.db.update(jobs).set({ deletedAt: 1 }).where(eq(jobs.id, monday.id)).run();

    expect(updateJob(handle.db, { jobId: monday.id as Uuid, name: "Anything" }).ok).toBe(false);
  });
});

/**
 * Which act stopped a job is recorded when it happens, not read back
 * off the spend (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs", migration 0081). The
 * case that matters
 * is the last one: a person pausing a budgeted job after an expensive
 * occurrence has exactly the same numbers as a budget trip, so a
 * derivation would have called it one.
 */
describe("why a paused job is paused", () => {
  it("says nothing at all while it is running", () => {
    expect(job().pausedReason).toBeNull();
  });

  it("is 'budget' when the guard stopped it", () => {
    const monday = job();
    const item = fireJob(handle.db, monday, { dueAt: MONDAY_0800_BERLIN }).item!;
    spend(item.id, 500);
    updateJob(handle.db, { jobId: monday.id as Uuid, budgetPerOccurrenceCents: 400 });
    const budgeted = getJob(handle.db, monday.id as Uuid)!;

    const trip = occurrenceOverBudget(handle.db, item.id)!;
    expect(trip).not.toBeNull();
    pauseForBudget(handle.db, trip, item);

    expect(getJob(handle.db, monday.id as Uuid)?.pausedReason).toBe("budget");
    expect(budgeted.pausedReason).toBeNull();
  });

  it("is 'by hand' when a person stopped it, however much the last occurrence spent", () => {
    const monday = job();
    const item = fireJob(handle.db, monday, { dueAt: MONDAY_0800_BERLIN }).item!;
    spend(item.id, 500);
    updateJob(handle.db, { jobId: monday.id as Uuid, budgetPerOccurrenceCents: 400 });

    // The spend that would have tripped the guard, and a person who got
    // there first. Derived from the numbers, this was indistinguishable.
    pauseJob(handle.db, monday.id as Uuid, MONDAY_0800_BERLIN, "by hand");

    expect(getJob(handle.db, monday.id as Uuid)?.pausedReason).toBe("by hand");
  });

  it("forgets the reason on resume, so the next pause speaks for itself", () => {
    const monday = job();
    pauseJob(handle.db, monday.id as Uuid, MONDAY_0800_BERLIN, "budget");

    resumeJob(handle.db, monday.id as Uuid);

    const resumed = getJob(handle.db, monday.id as Uuid)!;
    expect(resumed.pausedAt).toBeNull();
    expect(resumed.pausedReason).toBeNull();
  });
});

describe("the history the Job page lists", () => {
  it("carries the item, its cost and how long its runs took — and keeps the skipped rows", () => {
    const monday = job();
    // Both occurrences are given the moment they were *for*, so the
    // table's order is the calendar's rather than the wall clock the
    // suite happens to run at.
    const item = fireJob(handle.db, monday, { dueAt: MONDAY_0800_BERLIN }).item!;
    spend(item.id, 42, 90_000);
    recordOccurrence(handle.db, { jobId: monday.id as Uuid, dueAt: MONDAY_0800_BERLIN + 60_000, status: "skipped", reason: "paused" });

    const rows = occurrenceRows(handle.db, monday.id as Uuid);

    expect(rows).toHaveLength(2);
    // Newest first, which is `listOccurrences`' order.
    expect(rows[0]?.status).toBe("skipped");
    expect(rows[0]?.itemKey).toBeNull();
    expect(rows[0]?.costCents).toBe(0);
    expect(rows[1]?.itemKey).toBe(item.key);
    expect(rows[1]?.costCents).toBe(42);
    expect(rows[1]?.durationMs).toBe(90_000);
  });

  /**
   * The history table's other cost cell, and the same rule (EO-313,
   * `ARCHITECTURE.md`, "Preview").
   *
   * The Job page prints "Spent" over this table and a figure on each
   * row of it. Both read `sumCostCentsForItem`, so both have to agree
   * about a preview — a total that excluded one while the rows beneath
   * it did not would be a column that does not add up.
   */
  it("shows nought for an occurrence whose item is a preview", () => {
    const monday = job();
    const item = fireJob(handle.db, monday, { dueAt: MONDAY_0800_BERLIN }).item!;
    handle.db.update(items).set({ previewAt: MONDAY_0800_BERLIN }).where(eq(items.id, item.id)).run();
    spend(item.id, 900, 90_000);

    const rows = occurrenceRows(handle.db, monday.id as Uuid);

    // The row stays — the firing happened, and how long it took is
    // still true. Only the money is nought.
    expect(rows[0]?.itemKey).toBe(item.key);
    expect(rows[0]?.costCents).toBe(0);
    expect(rows[0]?.durationMs).toBe(90_000);
  });

  it("leaves the cells blank rather than the row out when the item has been deleted", () => {
    const monday = job();
    recordOccurrence(handle.db, {
      jobId: monday.id as Uuid,
      dueAt: MONDAY_0800_BERLIN,
      status: "fired",
      firedAt: MONDAY_0800_BERLIN,
      itemId: "01a0a0af-0000-7000-8000-000000000000" as Uuid,
    });

    const rows = occurrenceRows(handle.db, monday.id as Uuid);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.itemKey).toBeNull();
    expect(rows[0]?.durationMs).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid)).toHaveLength(1);
  });
});

/** A finished run on an item, with what it cost and how long it took. */
function spend(itemId: Uuid, costCents: number, durationMs = 1000): void {
  const run = createRun(handle.db, { itemId, agentId: null, action: "implement" });
  updateRun(handle.db, run.id, { status: "succeeded", costCents, startedAt: MONDAY_0800_BERLIN, endedAt: MONDAY_0800_BERLIN + durationMs });
}
