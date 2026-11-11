import { LOCAL_PERSON_ID, type Item, type Job, type JobTrigger, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  getJob,
  listCommentsForItem,
  listOccurrences,
  listRunsForItem,
  needsAttention,
  openMentionsForHuman,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { catchUpJob } from "../jobs/catchUp.js";
import { fireJob } from "../jobs/fire.js";
import { createJob } from "../jobs/jobs.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

/**
 * A job that spends what one occurrence was allowed (EO-307,
 * `ARCHITECTURE.md`, "Controls").
 *
 * The daily budget stops the machine and the per-item budget stops one
 * item; neither is any use against a job that fires every hour, which
 * is a runaway made of perfectly ordinary items. This is the guard in
 * between, and the two halves that make it one: the item is parked and
 * the job is stopped, because parking the item alone leaves the
 * definition that filed it due again in an hour.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/** 08:00 in Berlin on 2026-06-01, and the morning after. */
const DAY_ONE = Date.UTC(2026, 5, 1, 6, 0);
const DAY_TWO = Date.UTC(2026, 5, 2, 6, 0);
const TEN_MINUTES = 10 * 60_000;

const DAILY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "daily", hour: 8, minute: 0 },
  timeZone: "Europe/Berlin",
  catchUpWithinMinutes: 180,
};

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function job(budgetPerOccurrenceCents: number): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Morning report",
    trigger: DAILY_0800,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
    budgetPerOccurrenceCents,
  });
  if (!result.ok) throw new Error(result.problem);
  handle.db.update(jobs).set({ createdAt: DAY_ONE - 60_000 }).where(eq(jobs.id, result.job.id)).run();
  return { ...result.job, createdAt: DAY_ONE - 60_000 };
}

/**
 * The item this job filed, at the step an agent runs.
 *
 * A job files on its pipeline's *entry* step, which on the seeded
 * pipeline is a builtin that prepares a worktree — and a builtin spends
 * nothing. The guard is on the dispatch that costs money, so the case
 * worth testing is the item once it has reached the implementer, which
 * is where every one of these ends up a moment after it is filed.
 */
function filedByJob(one: Job, dueAt: number): Item {
  const item = fireJob(handle.db, one, { dueAt }).item;
  if (item === null) throw new Error("the job filed nothing");
  return transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
}

/** A turn that spent money and did not finish the work — the shape a loop is made of. */
function spend(item: Item, costCents: number): void {
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement" });
  updateRun(handle.db, run.id, { status: "failed", costCents, error: "it fell over", startedAt: DAY_ONE, endedAt: DAY_ONE });
}

function supervisor() {
  return createRunSupervisor({ db: handle.db, limits: LIMITS, provider: createFakeProvider({ result: validImplementResult }) });
}

describe("an occurrence whose item has spent the job's budget", () => {
  it("refuses the next dispatch, parks the item, and pauses the job", async () => {
    const report = job(50);
    const filed = filedByJob(report, DAY_ONE);
    spend(filed, 60);

    await supervisor().runOnce();

    // Nothing was dispatched: the guard placeholder is the only run this
    // tick added, and it never opened a thread.
    const runs = listRunsForItem(handle.db, filed.id);
    expect(runs).toHaveLength(2);
    const guardRun = runs.find((run) => run.status === "awaiting_input")!;
    expect(guardRun.threadId).toBeNull();
    expect(guardRun.error).toContain("50¢");
    expect(guardRun.error).toContain("60¢");
    expect(guardRun.error).toContain("Morning report");

    // Parked, not routed: nothing ran, so there is no outcome to route on.
    expect(needsAttention(handle.db, filed.id)).toBe(true);
    const escalation = listCommentsForItem(handle.db, filed.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.runId).toBe(guardRun.id);

    expect(getJob(handle.db, report.id as Uuid)?.pausedAt).not.toBeNull();
  });

  it("names the budget in a message to the job's owner, and posts nothing on the job's thread", async () => {
    const report = job(50);
    const filed = filedByJob(report, DAY_ONE);
    spend(filed, 60);

    await supervisor().runOnce();

    const messages = messagesAboutJob(handle.db, report.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ recipientId: LOCAL_PERSON_ID, jobId: report.id, source: "job_budget" });
    expect(messages[0]?.body).toContain("50¢");
    expect(messages[0]?.body).toContain(filed.key);
    expect(messages[0]?.body).toContain(report.name);
  });

  it("says it once, however many ticks pass", async () => {
    const report = job(50);
    const filed = filedByJob(report, DAY_ONE);
    spend(filed, 60);

    await supervisor().runOnce();
    await supervisor().runOnce();
    await supervisor().runOnce();

    expect(listRunsForItem(handle.db, filed.id)).toHaveLength(2);
    expect(messagesAboutJob(handle.db, report.id)).toHaveLength(1);
  });

  it("leaves the next morning as a skipped row saying the job was paused", async () => {
    const report = job(50);
    const filed = filedByJob(report, DAY_ONE);
    spend(filed, 60);
    await supervisor().runOnce();

    const paused = getJob(handle.db, report.id as Uuid)!;
    const swept = catchUpJob(handle.db, paused, { now: DAY_TWO + TEN_MINUTES });

    expect(swept.fired).toEqual([]);
    expect(swept.skipped).toHaveLength(1);
    const morning = listOccurrences(handle.db, report.id as Uuid).find((one) => one.dueAt === DAY_TWO);
    expect(morning?.status).toBe("skipped");
    expect(morning?.reason).toBe("paused");
  });

  it("does not touch an item of a job with no budget, or one still inside it", async () => {
    const unbudgeted = createJob(handle.db, {
      projectId: null,
      name: "Unbudgeted",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "developer:story", title: "{{job}}", body: null },
    });
    if (!unbudgeted.ok) throw new Error(unbudgeted.problem);
    const filed = filedByJob(unbudgeted.job, DAY_ONE);
    spend(filed, 9000);

    await supervisor().runOnce();

    // Dispatched, not refused: no budget was stated, so nothing was
    // reached.
    expect(listRunsForItem(handle.db, filed.id).some((run) => run.status === "succeeded")).toBe(true);
    expect(getJob(handle.db, unbudgeted.job.id as Uuid)?.pausedAt).toBeNull();
  });

  it("lets the first run of an occurrence start, whatever the budget says", async () => {
    const report = job(1);
    const filed = filedByJob(report, DAY_ONE);

    await supervisor().runOnce();

    // A budget bounds a sequence of runs, and an occurrence that has
    // spent nothing has not reached it — otherwise a job with a budget
    // would be a job that never runs.
    expect(listRunsForItem(handle.db, filed.id).some((run) => run.status === "succeeded")).toBe(true);
    expect(getJob(handle.db, report.id as Uuid)?.pausedAt).toBeNull();
  });
});
