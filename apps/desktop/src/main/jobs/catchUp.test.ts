import { LOCAL_PERSON_ID, type Job, type JobTrigger, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archivePipeline, listCommentsForItem, listOccurrences, openMentionsForHuman, setItemArchived } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { catchUpJob } from "./catchUp.js";
import { createJob } from "./jobs.js";
import { RUN_NOW_OPTION } from "./answer.js";
import { JOB_MESSAGE_SOURCE } from "./ownerMessage.js";

/**
 * The catch-up, with the clock driven rather than waited for (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * Every moment here is an explicit UTC literal and every schedule names
 * its zone, so nothing depends on where the machine running the suite
 * is. The job is created with `createdAt` moved back by hand, because
 * the sweep starts from the job's creation before there is any history
 * and a job made this instant has not missed anything.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
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

const NEW_YORK = "America/New_York";
const BERLIN = "Europe/Berlin";

/** 2026-06-01 is a Monday. 08:00 in Berlin that day is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);

const WEEKLY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
  timeZone: BERLIN,
  catchUpWithinMinutes: 180,
};

function job(trigger: JobTrigger, createdAt: number): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
  });
  if (!result.ok) throw new Error(result.problem);
  // `createJob` stamps "now", and every test here is about a job that
  // already existed when the occurrence came round.
  backdate(result.job.id, createdAt);
  return { ...result.job, createdAt };
}

/** What the job's guards told its owner (EO-729). */
function ownerMessages(monday: Job) {
  return messagesAboutJob(handle.db, monday.id);
}

describe("a schedule that came round while EO was open", () => {
  it("fires it once, with a fired row, when the clock starts inside the grace", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    // 09:10 Berlin: seventy minutes late, well inside three hours.
    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 70 * 60_000 });

    expect(result.fired).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("fired");
    // The occurrence it was *for*, not the moment the lid was opened —
    // which is what makes `{{date}}` on the item read the right day.
    expect(occurrences[0]?.dueAt).toBe(MONDAY_0800);
    expect(occurrences[0]?.itemId).not.toBeNull();
    // Nothing was missed, so nobody is told anything.
    expect(ownerMessages(monday)).toEqual([]);
  });

  it("does not fire the same occurrence twice, however often it is swept", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    const now = MONDAY_0800 + 70 * 60_000;

    catchUpJob(handle.db, monday, { now });
    catchUpJob(handle.db, monday, { now: now + 60_000 });

    expect(listOccurrences(handle.db, monday.id as Uuid)).toHaveLength(1);
  });

  it("does not reach back past the job's own creation", () => {
    // Made on Monday afternoon: it has not missed Monday morning.
    const monday = job(WEEKLY_0800, MONDAY_0800 + 6 * 60 * 60_000);

    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 7 * 60 * 60_000 });

    expect(result).toEqual({ fired: [], skipped: [] });
  });
});

describe("a schedule that came round while EO was shut", () => {
  it("writes a skipped row beyond the grace, with the reason", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    // 12:00 Berlin: four hours late, and the grace is three.
    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    expect(result.fired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences[0]?.status).toBe("skipped");
    expect(occurrences[0]?.reason).toBe("offline beyond grace");
    expect(occurrences[0]?.dueAt).toBe(MONDAY_0800);
    // The absence of a `firedAt` is what makes it a skipped row.
    expect(occurrences[0]?.firedAt).toBeNull();
    expect(occurrences[0]?.itemId).toBeNull();
  });

  it("sends the owner a message naming the job, offers to run it, and posts no comment", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    const messages = ownerMessages(monday);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      recipientId: LOCAL_PERSON_ID,
      jobId: monday.id,
      projectId: null,
      source: JOB_MESSAGE_SOURCE.skipped,
      body: `"Monday report" was skipped: EO was not open within 3 hours of 08:00. Run it now?`,
      handledAt: null,
    });
    expect(messages[0]?.options).toContain(RUN_NOW_OPTION);
    // Invariant #8 where there is no item: a message.
    expect(openMentionsForHuman(handle.db)).toEqual([]);
  });

  it("records which offer was made about which occurrence", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    // The link an answer is resolved through: without it an answer has
    // to be matched to "the newest skip", which runs the wrong occurrence
    // the moment there are two. Written with the row rather than after
    // it, so `job_occurrences` stays append-only.
    const occurrence = listOccurrences(handle.db, monday.id as Uuid)[0]!;
    expect(occurrence.offerCommentId).toBe(ownerMessages(monday)[0]?.id);
  });

  it("names the day as well as the clock when the skip was not today", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 30 * 60 * 60_000 });

    expect(ownerMessages(monday)[0]?.body).toContain("08:00 on 2026-06-01");
  });

  it("offers the grace in the words it was set in", () => {
    const monday = job({ ...WEEKLY_0800, catchUpWithinMinutes: 90 } as JobTrigger, MONDAY_0800 - 60_000);

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 4 * 60 * 60_000 });

    expect(ownerMessages(monday)[0]?.body).toContain("within 90 minutes of 08:00");
  });

  it("decides each missed occurrence separately, oldest first", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    // Three weeks later, an hour after that morning's occurrence: two
    // skipped and the most recent one caught up.
    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 14 * 24 * 60 * 60_000 + 60 * 60_000 });

    expect(result.skipped).toHaveLength(2);
    expect(result.fired).toHaveLength(1);
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["fired", "skipped", "skipped"]);
  });
});

describe("a schedule whose last item has not finished", () => {
  it("skips the next occurrence and says why, rather than filing it twice", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    const filed = listOccurrences(handle.db, monday.id as Uuid)[0]!;

    // A week on, with last week's report still sitting on the board.
    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 7 * 24 * 60 * 60_000 + 60_000 });

    expect(result.fired).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.status).toBe("skipped");
    expect(result.skipped[0]?.reason).toBe("previous still open");
    const messages = ownerMessages(monday);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("is still open");
    // No offer: running it is exactly the duplicate the skip prevented.
    expect(messages[0]?.options).toBeNull();
    // And the row points at no offer, so no answer can be read as
    // having accepted one.
    expect(result.skipped[0]?.offerCommentId).toBeNull();
    expect(filed.itemId).not.toBeNull();
  });

  it("fires again once that item is finished", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    const filed = listOccurrences(handle.db, monday.id as Uuid)[0]!;
    setItemArchived(handle.db, filed.itemId as Uuid, MONDAY_0800 + 60_000);

    const result = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 7 * 24 * 60 * 60_000 + 60_000 });

    expect(result.fired).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});

describe("a schedule in another zone", () => {
  it("fires at the right instant on both sides of a daylight-saving change", () => {
    // Daily at 08:00 in New York. 2026-03-08 is the morning the clocks
    // go forward there, so 08:00 is 13:00Z before and 12:00Z after.
    const daily: JobTrigger = {
      kind: "schedule",
      schedule: { kind: "daily", hour: 8, minute: 0 },
      timeZone: NEW_YORK,
      catchUpWithinMinutes: 180,
    };
    const before = Date.UTC(2026, 2, 6, 13, 0);
    const report = job(daily, before - 60_000);

    // Swept once a day, each sweep a few minutes after that morning's
    // 08:00 in New York — which is a *different* UTC instant on Monday
    // than it was on Friday.
    for (const now of [before + 60_000, Date.UTC(2026, 2, 7, 13, 1), Date.UTC(2026, 2, 8, 12, 1), Date.UTC(2026, 2, 9, 12, 1)]) {
      // Nothing is left open to block the next morning; the point here
      // is the calendar, not the queue.
      const open = listOccurrences(handle.db, report.id as Uuid)[0];
      if (open?.itemId) setItemArchived(handle.db, open.itemId as Uuid, now);
      catchUpJob(handle.db, report, { now });
    }

    expect(listOccurrences(handle.db, report.id as Uuid).map((o) => o.dueAt).reverse()).toEqual([
      Date.UTC(2026, 2, 6, 13, 0),
      Date.UTC(2026, 2, 7, 13, 0),
      // 08:00 has not moved; the instant has.
      Date.UTC(2026, 2, 8, 12, 0),
      Date.UTC(2026, 2, 9, 12, 0),
    ]);
    expect(listOccurrences(handle.db, report.id as Uuid).every((o) => o.status === "fired")).toBe(true);
  });

  it("does not move when the machine's own zone would", () => {
    // The schedule is stated in Berlin and computed in Berlin, whatever
    // `process.env.TZ` is: the assertion is the instant, which is what
    // a machine-zone reading would get wrong.
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });

    expect(listOccurrences(handle.db, monday.id as Uuid)[0]?.dueAt).toBe(MONDAY_0800);
  });
});

describe("a schedule that cannot run at all", () => {
  it("records the failure once and does not repeat it every minute", () => {
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    archivePipeline(handle.db, "default");

    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    const after = listOccurrences(handle.db, monday.id as Uuid);

    // `fire.ts` records the `failed` row and sends its own guard; the
    // catch-up counts it as neither fired nor skipped, because nothing
    // ran and nothing was passed over either.
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe("failed");
    expect(ownerMessages(monday)).toHaveLength(1);
  });
});

describe("a schedule EO cannot read", () => {
  it("records the fault and says so once, rather than every minute", () => {
    // `createJob` refuses an expression that does not parse, so a row
    // like this was written by something else — an older version, a
    // hand-edited database. The guard is still owed a message
    // (invariant #8); sixty a day is owed to nobody.
    const monday = job(WEEKLY_0800, MONDAY_0800 - 60_000);
    const broken: Job = { ...monday, trigger: { kind: "schedule", schedule: { kind: "cron", expression: "0 8 * *" }, timeZone: BERLIN, catchUpWithinMinutes: 180 } };

    catchUpJob(handle.db, broken, { now: MONDAY_0800 + 60_000 });
    catchUpJob(handle.db, broken, { now: MONDAY_0800 + 120_000 });

    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.status).toBe("failed");
    expect(occurrences[0]?.reason).toContain("five fields");
    expect(ownerMessages(monday)).toHaveLength(1);
  });
});

describe("a trigger that is not a schedule", () => {
  it("is passed over, rather than fired on a timer", () => {
    const manual = job({ kind: "manual" }, MONDAY_0800 - 60_000);

    expect(catchUpJob(handle.db, manual, { now: MONDAY_0800 + 60_000 })).toEqual({ fired: [], skipped: [] });
    expect(listOccurrences(handle.db, manual.id as Uuid)).toEqual([]);
  });
});
