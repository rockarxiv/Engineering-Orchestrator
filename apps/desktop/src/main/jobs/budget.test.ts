import type { Job, JobTrigger, Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getJob, listCommentsForItem, listMentionsForComment, listOccurrences, openMentionsForHuman, updateRun } from "../db/repos/index.js";
import { items, jobs } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { catchUpJob, type JobGuardNotification } from "./catchUp.js";
import { jobCostCents, occurrenceOverBudget, pauseJob, resumeJob } from "./budget.js";
import { fireJob } from "./fire.js";
import { createJob } from "./jobs.js";

/**
 * Pausing a job, and what one has cost (EO-307,
 * `ARCHITECTURE.md`, "Controls").
 *
 * The clock is driven rather than waited for, `catchUp.test.ts`'s rule:
 * every moment is an explicit UTC literal and the schedule names its
 * zone, so nothing here depends on where the suite is running.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

const BERLIN = "Europe/Berlin";

/** 08:00 in Berlin on 2026-06-01 and on the two days after it. */
const DAY_ONE = Date.UTC(2026, 5, 1, 6, 0);
const DAY_TWO = Date.UTC(2026, 5, 2, 6, 0);
const DAY_THREE = Date.UTC(2026, 5, 3, 6, 0);
const TEN_MINUTES = 10 * 60_000;

const DAILY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "daily", hour: 8, minute: 0 },
  timeZone: BERLIN,
  catchUpWithinMinutes: 180,
};

function job(overrides: { trigger?: JobTrigger; createdAt?: number; budgetPerOccurrenceCents?: number } = {}): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Morning report",
    trigger: overrides.trigger ?? DAILY_0800,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
    ...(overrides.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: overrides.budgetPerOccurrenceCents }),
  });
  if (!result.ok) throw new Error(result.problem);
  const createdAt = overrides.createdAt ?? DAY_ONE - 60_000;
  // `createJob` stamps "now", and the sweep starts from a job's creation
  // before there is any history: a job made this instant has missed
  // nothing.
  handle.db.update(jobs).set({ createdAt }).where(eq(jobs.id, result.job.id)).run();
  return { ...result.job, createdAt };
}

/** The job as the database now holds it — pausing is a write, not a value the caller keeps. */
function reread(one: Job): Job {
  const row = getJob(handle.db, one.id as Uuid);
  if (!row) throw new Error("the job is gone");
  return row;
}

function threadComments(one: Job) {
  return listCommentsForItem(handle.db, one.threadItemId as Uuid);
}

describe("a paused job", () => {
  it("fires nothing, and records what it did not do", () => {
    const report = job();
    pauseJob(handle.db, report.id as Uuid, DAY_ONE - 30_000);
    const notified: JobGuardNotification[] = [];

    const result = catchUpJob(handle.db, reread(report), { now: DAY_ONE + TEN_MINUTES, notify: (one) => notified.push(one) });

    expect(result.fired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    const occurrences = listOccurrences(handle.db, report.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("skipped");
    expect(occurrences[0]?.reason).toBe("paused");
    expect(occurrences[0]?.firedAt).toBeNull();
    // Nothing was filed, which is the whole point of the row.
    expect(occurrences[0]?.itemId).toBeNull();
    // A pause is a state the person chose; they are not interrupted
    // about it every morning.
    expect(notified).toEqual([]);
  });

  it("says so on its thread, and mentions the owner — once, however many mornings pass", () => {
    const report = job();
    pauseJob(handle.db, report.id as Uuid, DAY_ONE - 30_000);

    const result = catchUpJob(handle.db, reread(report), { now: DAY_THREE + TEN_MINUTES });

    // Three mornings came round; three rows say so.
    expect(result.skipped).toHaveLength(3);
    const comments = threadComments(report);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("paused");
    expect(comments[0]?.body).toContain("Morning report");
    expect(listMentionsForComment(handle.db, comments[0]!.id as Uuid)).toHaveLength(1);
    expect(openMentionsForHuman(handle.db).length).toBeGreaterThan(0);
  });

  it("refuses a press as well as a tick, whichever door it came through", () => {
    const report = job({ trigger: { kind: "manual" } });
    pauseJob(handle.db, report.id as Uuid);

    const result = fireJob(handle.db, reread(report));

    expect(result.item).toBeNull();
    expect(result.problem).toContain("paused");
    const occurrences = listOccurrences(handle.db, report.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("failed");
    // The press was answered where a person can see it (invariant #8).
    expect(threadComments(report)).toHaveLength(1);
  });
});

describe("resuming a job", () => {
  it("fires the next occurrence normally, and does not catch up the ones it missed", () => {
    const report = job();
    pauseJob(handle.db, report.id as Uuid, DAY_ONE - 30_000);
    catchUpJob(handle.db, reread(report), { now: DAY_TWO + TEN_MINUTES }); // two mornings skipped

    resumeJob(handle.db, report.id as Uuid);
    const result = catchUpJob(handle.db, reread(report), { now: DAY_THREE + TEN_MINUTES });

    expect(result.skipped).toEqual([]);
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.dueAt).toBe(DAY_THREE);
    // The two paused mornings stay skipped: they were decided about and
    // written down, and a resumed job files the next one rather than a
    // backlog.
    const fired = listOccurrences(handle.db, report.id as Uuid).filter((one) => one.status === "fired");
    expect(fired.map((one) => one.dueAt)).toEqual([DAY_THREE]);
  });

  it("says the pause again the next time one is imposed", () => {
    const report = job();
    pauseJob(handle.db, report.id as Uuid, DAY_ONE - 30_000);
    catchUpJob(handle.db, reread(report), { now: DAY_ONE + TEN_MINUTES });
    resumeJob(handle.db, report.id as Uuid);
    catchUpJob(handle.db, reread(report), { now: DAY_TWO + TEN_MINUTES }); // fires

    pauseJob(handle.db, report.id as Uuid, DAY_TWO + TEN_MINUTES);
    catchUpJob(handle.db, reread(report), { now: DAY_THREE + TEN_MINUTES });

    // A second pause is a second decision, not the first one repeating.
    expect(threadComments(report).filter((comment) => comment.body.includes("paused"))).toHaveLength(2);
  });
});

describe("what a job has cost", () => {
  /** A finished run on an item, costing what it costs. */
  function spend(itemId: Uuid, costCents: number): void {
    const run = createRun(handle.db, { itemId, agentId: null, action: "implement" });
    updateRun(handle.db, run.id, { status: "succeeded", costCents, startedAt: Date.now(), endedAt: Date.now() });
  }

  it("is the sum of the runs of every item its occurrences filed", () => {
    const report = job({ trigger: { kind: "manual" } });
    const first = fireJob(handle.db, report, { dueAt: DAY_ONE }).item!;
    const second = fireJob(handle.db, report, { dueAt: DAY_TWO }).item!;
    // Somebody else's work, on the same board and the same day.
    const unrelated = createTestItem(handle.db, { type: "story", title: "Filed by hand", stepId: "todo" });

    spend(first.id, 120);
    spend(first.id, 35);
    spend(second.id, 7);
    spend(unrelated.id, 9000);

    expect(jobCostCents(handle.db, report.id as Uuid)).toBe(162);
  });

  it("is nought for a job that has never filed anything", () => {
    expect(jobCostCents(handle.db, job().id as Uuid)).toBe(0);
  });

  /**
   * A preview among the job's items is not money the job spent
   * (EO-313, `ARCHITECTURE.md`, "Preview").
   *
   * The Job page prints this as "Spent", and the daily total already
   * leaves previews out — so counting one here would have the same
   * installation answer the same question two ways depending on which
   * screen asked it. The item is marked directly because nothing files
   * a preview through a job yet: the template button that mints one is
   * the sixth story of this phase, and the sum has to be right before
   * something starts producing the rows it is wrong about.
   */
  it("leaves out an occurrence whose item is a preview", () => {
    const report = job({ trigger: { kind: "manual" } });
    const real = fireJob(handle.db, report, { dueAt: DAY_ONE }).item!;
    const rehearsal = fireJob(handle.db, report, { dueAt: DAY_TWO }).item!;
    handle.db.update(items).set({ previewAt: DAY_TWO }).where(eq(items.id, rehearsal.id)).run();

    spend(real.id, 120);
    spend(rehearsal.id, 900);

    expect(jobCostCents(handle.db, report.id as Uuid)).toBe(120);
  });

  it("is nought for a job whose only occurrence was a preview", () => {
    const report = job({ trigger: { kind: "manual" } });
    const rehearsal = fireJob(handle.db, report, { dueAt: DAY_ONE }).item!;
    handle.db.update(items).set({ previewAt: DAY_ONE }).where(eq(items.id, rehearsal.id)).run();
    spend(rehearsal.id, 900);

    expect(jobCostCents(handle.db, report.id as Uuid)).toBe(0);
  });

  /**
   * And the guard that reads the same sum must not stop one.
   *
   * A preview parked by a per-occurrence budget would be EO asking
   * somebody to authorize spending on the one item it had just promised
   * them cost nothing — and it would pause the job as well, which is
   * real work stopped on a rehearsal's account.
   */
  it("never trips the per-occurrence budget on a preview", () => {
    const report = job({ trigger: { kind: "manual" }, budgetPerOccurrenceCents: 100 });
    const rehearsal = fireJob(handle.db, report, { dueAt: DAY_ONE }).item!;
    handle.db.update(items).set({ previewAt: DAY_ONE }).where(eq(items.id, rehearsal.id)).run();
    spend(rehearsal.id, 900);

    expect(occurrenceOverBudget(handle.db, rehearsal.id)).toBeNull();
  });

  it("still trips it on real work, which is how we know the mark is what stopped it", () => {
    const report = job({ trigger: { kind: "manual" }, budgetPerOccurrenceCents: 100 });
    const real = fireJob(handle.db, report, { dueAt: DAY_ONE }).item!;
    spend(real.id, 900);

    expect(occurrenceOverBudget(handle.db, real.id)).toMatchObject({ budgetCents: 100, spentCents: 900 });
  });
});
