import { eq } from "drizzle-orm";
import type { Comment, Job, JobTrigger, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listCommentsForItem, listOccurrences } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { catchUpJob } from "../jobs/catchUp.js";
import { createJob } from "../jobs/jobs.js";
import { RUN_NOW_OPTION } from "../jobs/answer.js";
import { postHumanComment } from "./domainCommands.js";

/**
 * Pressing "Run it now" on a skipped occurrence, through the channel a
 * person actually presses it on (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * `answer.test.ts` covers what the decision is; this covers that
 * `comments:post` reaches it at all. Worth its own test because the offer
 * deliberately has no channel of its own — it is an option on a comment,
 * so the wiring is one call inside the ordinary reply path and nothing
 * else would notice if it were removed.
 */

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/** 2026-06-01 is a Monday; 08:00 in Berlin is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);

const WEEKLY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
  timeZone: "Europe/Berlin",
  catchUpWithinMinutes: 180,
};

/** A schedule job whose Monday morning was missed, with the offer on its thread. */
function missedMonday(name = "Monday report"): { job: Job; offer: Comment } {
  const created = createJob(handle.db, {
    projectId: null,
    name,
    trigger: WEEKLY_0800,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
  });
  if (!created.ok) throw new Error(created.problem);
  handle.db.update(jobs).set({ createdAt: MONDAY_0800 - 60_000 }).where(eq(jobs.id, created.job.id)).run();
  // Four hours late: skipped, with the offer on the thread.
  catchUpJob(handle.db, { ...created.job, createdAt: MONDAY_0800 - 60_000 }, { now: MONDAY_0800 + 4 * 60 * 60_000 });
  const offer = listCommentsForItem(handle.db, created.job.threadItemId as Uuid)[0]!;
  expect(offer.options).toContain(RUN_NOW_OPTION);
  return { job: created.job, offer };
}

function post(itemId: string, body: string, parentId: string | null) {
  return postHumanComment(handle.db, undefined, { itemId, body, parentId, mentions: [], pinned: false, attachmentIds: [] });
}

describe("replying to a job's skip offer", () => {
  it("fires the occurrence the comment was about", async () => {
    const { job: monday, offer } = missedMonday();

    const posted = await post(monday.threadItemId, RUN_NOW_OPTION, offer.id);

    // The reply is recorded either way — the firing is a consequence of
    // it and never a replacement for it.
    expect(posted.commentId).toBeTruthy();
    expect(posted.resumedRun).toBe(false);
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences.map((occurrence) => occurrence.status)).toEqual(["fired", "skipped"]);
    // For the Monday it was due, not for the moment the button was
    // pressed.
    expect(occurrences[0]?.dueAt).toBe(MONDAY_0800);
    expect(occurrences[0]?.itemId).not.toBeNull();
  });

  /**
   * `parentId` is a claim the caller makes and not a fact the database
   * enforces: `comments:post` takes any id at all in it, and nothing
   * makes a parent and its child share an item. So the channel is where
   * this has to be shown — the unit test can only prove the rule, and
   * this proves nobody can reach round it.
   */
  it("does not fire from a comment on another item that cites the offer as its parent", async () => {
    const { job: monday, offer } = missedMonday();
    // Any other item: this one is a second job's thread, which is simply
    // the shortest item to come by.
    const elsewhere = missedMonday("Something else").job.threadItemId;
    expect(elsewhere).not.toBe(monday.threadItemId);

    const posted = await post(elsewhere, RUN_NOW_OPTION, offer.id);

    // The comment is written, because a person said something and
    // invariant #4 says the thread is where that goes. What it does not
    // do is run somebody's job from an item it has nothing to do with.
    expect(posted.commentId).toBeTruthy();
    expect(listOccurrences(handle.db, monday.id as Uuid).map((occurrence) => occurrence.status)).toEqual(["skipped"]);
  });

  it("does not fire from a comment on the thread that answers nothing", async () => {
    const { job: monday } = missedMonday();

    await post(monday.threadItemId, RUN_NOW_OPTION, null);

    expect(listOccurrences(handle.db, monday.id as Uuid).map((occurrence) => occurrence.status)).toEqual(["skipped"]);
  });
});
