import type { JobTrigger, Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listItemsForProject, listOccurrences } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createJob } from "./jobs.js";
import { runJobTick, startJobScheduler, type JobTickResult } from "./scheduler.js";
import { receiveWebhook } from "./webhook.js";
import { signWebhook } from "./webhookSignature.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  handle.close();
});

/**
 * Moves a job's creation back.
 *
 * Every test here is about a job that already existed when the
 * occurrence came round, and `createJob` stamps "now" — the sweep starts
 * from a job's creation before there is any history, so a job made this
 * instant has missed nothing.
 */
function backdate(id: string, createdAt: number): void {
  handle.db.update(jobs).set({ createdAt }).where(eq(jobs.id, id)).run();
}

/** 2026-06-01 is a Monday; 08:00 in Berlin is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);

const WEEKLY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
  timeZone: "Europe/Berlin",
  catchUpWithinMinutes: 180,
};

/**
 * A schedule job that already existed when the occurrence came round.
 *
 * `createJob` stamps "now" and the sweep starts from a job's creation
 * before there is any history, so a job made this instant has missed
 * nothing — which is right, and not what any of these tests are about.
 */
function scheduleJob(name: string) {
  const job = jobWith(name, WEEKLY_0800);
  backdate(job.id, MONDAY_0800 - 60_000);
  return job;
}

function manualJob(name: string) {
  return jobWith(name, { kind: "manual" });
}

function jobWith(name: string, trigger: JobTrigger) {
  const result = createJob(handle.db, {
    projectId: null,
    name,
    trigger,
    pipelineId: "default",
    template: { type: "developer:story", title: name, body: null },
  });
  if (!result.ok) throw new Error(result.problem);
  return result.job;
}

describe("the job scheduler's tick", () => {
  it("looks at a manual job and fires nothing", () => {
    const monday = manualJob("Monday report");
    const before = itemCount();

    expect(runJobTick(handle.db)).toEqual({ considered: 1, fired: [], skipped: [] });
    // A `manual` job waits for somebody to press Run now, and a timer
    // must never be the reason work appears.
    expect(listOccurrences(handle.db, monday.id as Uuid)).toEqual([]);
    expect(itemCount()).toBe(before);
  });

  it("does nothing at all, quietly, when there are no jobs", () => {
    expect(runJobTick(handle.db)).toEqual({ considered: 0, fired: [], skipped: [] });
  });

  it("fires the schedule jobs that have come round, and reports them", () => {
    const monday = scheduleJob("Monday report");

    const result = runJobTick(handle.db, { now: MONDAY_0800 + 60_000 });

    expect(result.considered).toBe(1);
    expect(result.fired).toEqual([monday.id]);
    expect(listOccurrences(handle.db, monday.id as Uuid).map((occurrence) => occurrence.dueAt)).toEqual([MONDAY_0800]);
  });

  it("reports what it skipped, so a missed morning is visible without reading the log", () => {
    const monday = scheduleJob("Monday report");

    const result = runJobTick(handle.db, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    expect(result).toEqual({ considered: 1, fired: [], skipped: [monday.id] });
  });

  it("decides every job against one clock, so two due at the same minute agree", () => {
    const first = scheduleJob("Monday report");
    const second = scheduleJob("Monday numbers");

    const result = runJobTick(handle.db, { now: MONDAY_0800 + 60_000 });

    expect([...result.fired].sort()).toEqual([first.id, second.id].sort());
  });
});

describe("the job scheduler's loop", () => {
  it("ticks at launch and then every minute, on the shared interval loop", async () => {
    const ticks: JobTickResult[] = [];
    manualJob("Monday report");

    const stop = startJobScheduler(handle.db, { onTick: (result) => ticks.push(result) });
    try {
      // At launch, for the reason the archive sweep ticks at launch: a
      // desktop closed every evening never reaches a daily timer.
      expect(ticks).toHaveLength(1);
      // …and advanced *asynchronously*, because the tick has a second
      // half since EO-332: releasing what a webhook burst left waiting.
      // The loop holds its non-overlap flag until that promise settles,
      // which is the point of it, so a synchronous advance would find
      // the flag still up and drop the next tick.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ticks).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ticks).toHaveLength(4);
      expect(ticks.every((tick) => tick.considered === 1 && tick.fired.length === 0)).toBe(true);
    } finally {
      stop();
    }
  });

  it("fires a missed occurrence on the launch tick, not on the next minute", () => {
    // The laptop opened at 09:10 with the report due at 08:00. The
    // whole of the design's catch-up rests on this: waiting for the top of the
    // next minute would be a minute, and waiting for the next *daily*
    // tick would be never.
    vi.setSystemTime(MONDAY_0800 + 70 * 60_000);
    const monday = scheduleJob("Monday report");
    const ticks: JobTickResult[] = [];

    const stop = startJobScheduler(handle.db, { onTick: (result) => ticks.push(result) });
    try {
      expect(ticks[0]?.fired).toEqual([monday.id]);
      expect(listOccurrences(handle.db, monday.id as Uuid)[0]?.dueAt).toBe(MONDAY_0800);
    } finally {
      stop();
    }
  });

  it("interrupts the person through the notifier it was handed", () => {
    // Four hours late, so the occurrence is skipped rather than caught
    // up — and showing an OS notification is the machine's job, handed
    // in by the composition root (KAN-127).
    vi.setSystemTime(MONDAY_0800 + 4 * 60 * 60_000);
    scheduleJob("Monday report");
    const notified: string[] = [];

    const stop = startJobScheduler(handle.db, { notify: (guard) => notified.push(guard.body) });
    try {
      expect(notified).toEqual([`"Monday report" was skipped: EO was not open within 3 hours of 08:00. Run it now?`]);
    } finally {
      stop();
    }
  });

  it("releases what a webhook burst left waiting (EO-332, §4.4)", async () => {
    // The other half of what a tick does. A webhook job is never
    // *fired* by a sweep — its events arrive at the server — but the
    // queue a burst leaves is released by the record's own scheduler,
    // in arrival order, as the cap makes room.
    const secret = "s".repeat(64);
    const created = createJob(handle.db, {
      projectId: null,
      name: "Deploys",
      trigger: { kind: "webhook", path: "deploys", secret, mapping: { title: null, body: null, eventKey: null, spec: {} } },
      pipelineId: "default",
      template: { type: "developer:story", title: "Deploy", body: null },
      maxItemsPerHour: 1,
    });
    if (!created.ok) throw new Error(created.problem);
    // The job's own thread is an item too, so the count is read from
    // where it stands rather than from nought.
    const before = itemCount();
    for (const id of ["evt-1", "evt-2"]) {
      const body = JSON.stringify({ id });
      const now = Date.now();
      await receiveWebhook(handle.db, {
        path: "deploys",
        rawBody: body,
        signature: signWebhook(secret, now, body),
        timestamp: String(now),
        now,
      });
    }
    expect(itemCount()).toBe(before + 1);

    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    const stop = startJobScheduler(handle.db, {});
    try {
      // The launch tick's second half is a promise; the loop holds its
      // non-overlap flag until it settles, so the flush is what makes
      // the release observable.
      await vi.advanceTimersByTimeAsync(1);
      expect(itemCount()).toBe(before + 2);
    } finally {
      stop();
    }
  });

  it("stops when it is stopped, so shutdown is not waiting on a timer", async () => {
    const ticks: JobTickResult[] = [];
    const stop = startJobScheduler(handle.db, { intervalMs: 1_000, onTick: (result) => ticks.push(result) });

    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ticks).toHaveLength(1); // the launch tick, and nothing after it
  });
});

function itemCount(): number {
  return listItemsForProject(handle.db, null).length;
}
