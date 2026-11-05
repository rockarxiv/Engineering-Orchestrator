import { LOCAL_PERSON_ID, type Comment, type Job, type JobOccurrence, type JobTrigger, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listOccurrences, postComment, setItemArchived } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { answerSkipOffer, LEAVE_IT_OPTION, RUN_NOW_OPTION } from "./answer.js";
import { catchUpJob } from "./catchUp.js";
import { createJob } from "./jobs.js";

/**
 * Answering "Run it now" on a skipped occurrence (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * Through an ordinary reply, because the offer is an option on a comment
 * and not a channel of its own — which is what makes it answerable today
 * from the inbox and the item thread, before the Jobs page exists.
 *
 * The property most of this file is about: **which occurrence an answer
 * runs is decided by the comment being answered.** Matching on "the
 * newest skipped row" instead reads correctly for the one-offer case and
 * wrongly for every other, so the one-offer case is the least
 * interesting test here.
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

const BERLIN = "Europe/Berlin";
/** 2026-06-01 is a Monday; 08:00 in Berlin is 06:00Z. */
const MONDAY_0800 = Date.UTC(2026, 5, 1, 6, 0);
const A_WEEK = 7 * 24 * 60 * 60_000;
const FOUR_HOURS_LATE = MONDAY_0800 + 4 * 60 * 60_000;

const WEEKLY_0800: JobTrigger = {
  kind: "schedule",
  schedule: { kind: "weekly", weekday: 1, hour: 8, minute: 0 },
  timeZone: BERLIN,
  catchUpWithinMinutes: 180,
};

function job(trigger: JobTrigger = WEEKLY_0800): Job {
  const result = createJob(handle.db, {
    projectId: null,
    name: "Monday report",
    trigger,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
  });
  if (!result.ok) throw new Error(result.problem);
  backdate(result.job.id, MONDAY_0800 - 60_000);
  return { ...result.job, createdAt: MONDAY_0800 - 60_000 };
}

/**
 * One missed morning: a skipped occurrence with its offer on the thread.
 *
 * Returns the occurrence, which carries the id of the comment that
 * offered it — the link an answer is resolved through.
 */
function skip(monday: Job, now: number = FOUR_HOURS_LATE): JobOccurrence {
  catchUpJob(handle.db, monday, { now });
  return listOccurrences(handle.db, monday.id as Uuid)[0]!;
}

/**
 * The reply a person's press of the button posts.
 *
 * Filed under the offer, which is what the item thread and the inbox
 * both do (D-05) and what decides which occurrence is being answered.
 */
function answer(monday: Job, body: string, parentId: string | null): Comment {
  return postComment(handle.db, {
    itemId: monday.threadItemId as Uuid,
    author: { type: "human" },
    body,
    parentId: parentId as Uuid | null,
  });
}

describe("answering the offer", () => {
  it("fires the occurrence that offer was made for, for the moment it was due", () => {
    const monday = job();
    const offered = skip(monday);
    expect(offered.offerCommentId).not.toBeNull();

    const result = answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, offered.offerCommentId));

    expect(result?.item).not.toBeNull();
    // For the Monday, not for the Wednesday somebody got round to it —
    // which is what `{{date}}` on the item reads.
    expect(result?.occurrence?.dueAt).toBe(offered.dueAt);
    expect(result?.occurrence?.status).toBe("fired");
    expect(result?.item?.title).toBe("Monday report for 2026-06-01");
    expect(getItem(handle.db, result!.item!.id)?.createdBy).toBe(LOCAL_PERSON_ID);
    // The skipped row stays. `job_occurrences` is append-only, and what
    // happened is that it was skipped and then run.
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["fired", "skipped"]);
  });

  it("accepts the answer typed rather than pressed, and with a note under it", () => {
    const monday = job();
    const offered = skip(monday);

    // What the inbox sends: the chosen option, then whatever was typed.
    const result = answerSkipOffer(handle.db, answer(monday, `run it now\n\nWe still need last week's numbers.`, offered.offerCommentId));

    expect(result?.item).not.toBeNull();
  });

  it("fires it once, however many times the button is pressed", () => {
    const monday = job();
    const offered = skip(monday);

    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, offered.offerCommentId))?.item).not.toBeNull();
    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, offered.offerCommentId))).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid).filter((o) => o.status === "fired")).toHaveLength(1);
  });

  it("does nothing when the person says to leave it", () => {
    const monday = job();
    const offered = skip(monday);

    expect(answerSkipOffer(handle.db, answer(monday, LEAVE_IT_OPTION, offered.offerCommentId))).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["skipped"]);
  });
});

/**
 * Two offers on one thread, which is the ordinary state of a job that
 * has been missed twice.
 */
describe("when more than one occurrence has been offered", () => {
  /** Two missed Mondays, oldest first. */
  function twoSkips(monday: Job): { first: JobOccurrence; second: JobOccurrence } {
    const first = skip(monday, FOUR_HOURS_LATE);
    const second = skip(monday, FOUR_HOURS_LATE + A_WEEK);
    expect(first.dueAt).toBe(MONDAY_0800);
    expect(second.dueAt).toBe(MONDAY_0800 + A_WEEK);
    expect(first.offerCommentId).not.toBe(second.offerCommentId);
    return { first, second };
  }

  it("runs the one the answered offer was about, not the newest", () => {
    const monday = job();
    const { first } = twoSkips(monday);

    // Somebody scrolls up in the thread — or opens last week's inbox row
    // — and presses the button there.
    const result = answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, first.offerCommentId));

    // Last Monday's report, which is what they asked for. Reading "the
    // newest skipped row" instead would have filed this Monday's and
    // left the one they pressed still missing.
    expect(result?.occurrence?.dueAt).toBe(MONDAY_0800);
    expect(result?.item?.title).toBe("Monday report for 2026-06-01");
  });

  it("runs the newest when that is the one answered", () => {
    const monday = job();
    const { second } = twoSkips(monday);

    const result = answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, second.offerCommentId));

    expect(result?.occurrence?.dueAt).toBe(MONDAY_0800 + A_WEEK);
    expect(result?.item?.title).toBe("Monday report for 2026-06-08");
  });

  it("lets both be run, each once, without either answer touching the other", () => {
    const monday = job();
    const { first, second } = twoSkips(monday);

    answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, first.offerCommentId));
    answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, second.offerCommentId));
    // And pressing the first again changes nothing.
    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, first.offerCommentId))).toBeNull();

    const fired = listOccurrences(handle.db, monday.id as Uuid).filter((occurrence) => occurrence.status === "fired");
    expect(fired.map((occurrence) => occurrence.dueAt).sort()).toEqual([MONDAY_0800, MONDAY_0800 + A_WEEK]);
  });
});

describe("what carries no offer", () => {
  it("ignores a comment on the thread that answers nothing", () => {
    const monday = job();
    skip(monday);

    // A remark somebody typed into the thread, not an answer to the
    // question. It reads exactly like the button and must do nothing: a
    // job thread is an ordinary item that people can write on.
    const remark = answer(monday, RUN_NOW_OPTION, null);

    expect(answerSkipOffer(handle.db, remark)).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["skipped"]);
  });

  it("ignores a reply filed under a comment that offered nothing", () => {
    const monday = job();
    const offered = skip(monday);
    // Somebody replies to the question, and then somebody replies to
    // *that* — under a comment which is not an offer and names no
    // occurrence.
    const chat = answer(monday, "Do we still need this?", offered.offerCommentId);

    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, chat.id))).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["skipped"]);
  });

  it("refuses a skip that was made because the previous item is still open", () => {
    const monday = job();
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + A_WEEK + 60_000 });
    const blocked = listOccurrences(handle.db, monday.id as Uuid)[0]!;
    expect(blocked.reason).toBe("previous still open");
    // No question was asked, so there is nothing an answer could point
    // at — running it would file the second copy the skip prevented.
    expect(blocked.offerCommentId).toBeNull();

    const note = listCommentsForItem(handle.db, monday.threadItemId as Uuid).at(-1)!;
    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, note.id))).toBeNull();
  });

  it("ignores a comment on another item that cites the offer as its parent", () => {
    const monday = job();
    const offered = skip(monday);
    // An item that has nothing to do with this job, with a comment on it
    // naming the offer as its parent. Nothing refuses that: `parentId`
    // is whatever the caller sent, and neither `comments:post` nor the
    // schema makes a parent and its child share an item. So the only
    // thing standing between "a comment on any item in the project"
    // and "this job runs" is the check being tested here.
    const other = otherItem();
    const elsewhere = postComment(handle.db, {
      itemId: other,
      author: { type: "human" },
      body: RUN_NOW_OPTION,
      parentId: offered.offerCommentId as Uuid,
    });
    expect(elsewhere.itemId).not.toBe(monday.threadItemId);

    expect(answerSkipOffer(handle.db, elsewhere)).toBeNull();
    expect(listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status)).toEqual(["skipped"]);
  });

  it("ignores a reply on an item that is not a job's thread", () => {
    const monday = job();
    // The item the job filed is not the job's thread, and it is exactly
    // the kind of item a person says things on all day.
    const fired = catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    const onTheWork = postComment(handle.db, {
      itemId: fired.fired[0]!.itemId as Uuid,
      author: { type: "human" },
      body: RUN_NOW_OPTION,
    });

    expect(answerSkipOffer(handle.db, onTheWork)).toBeNull();
  });

  it("ignores a manual job's thread, which has a button instead", () => {
    const manual = job({ kind: "manual" });
    const remark = answer(manual, RUN_NOW_OPTION, null);

    expect(answerSkipOffer(handle.db, remark)).toBeNull();
  });

  it("stays silent when nothing has been skipped at all", () => {
    const monday = job();
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    const filed = listOccurrences(handle.db, monday.id as Uuid)[0]!;
    setItemArchived(handle.db, filed.itemId as Uuid, MONDAY_0800);

    expect(answerSkipOffer(handle.db, answer(monday, RUN_NOW_OPTION, null))).toBeNull();
  });
});

/**
 * An ordinary item, somewhere else entirely.
 *
 * A second job's thread rather than a hand-made item, because it is the
 * shortest way to one: what matters is only that it is not the item the
 * offer was posted on.
 */
function otherItem(): Uuid {
  const created = createJob(handle.db, {
    projectId: null,
    name: "Something else",
    trigger: { kind: "manual" },
    pipelineId: "default",
    template: { type: "developer:story", title: "x", body: null },
  });
  if (!created.ok) throw new Error(created.problem);
  return created.job.threadItemId as Uuid;
}
