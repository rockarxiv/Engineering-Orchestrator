import { LOCAL_PERSON_ID, type Comment, type Job, type JobOccurrence, type JobTrigger, type Message, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, getMessage, listOccurrences, postComment, recordOccurrence } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { handleMessageHere } from "../messages/messages.js";
import { answerSkipMessage, answerSkipOffer, LEAVE_IT_OPTION, RUN_NOW_OPTION, SKIP_OFFER_OPTIONS } from "./answer.js";
import { catchUpJob } from "./catchUp.js";
import { createJob } from "./jobs.js";

/**
 * Answering "Run it now" on a skipped occurrence (EO-306,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * Through the skip's message to the job's owner (EO-729): answering it
 * with "Run it now", in the inbox, fires the occurrence.
 *
 * The property most of this file is about: **which occurrence an answer
 * runs is decided by the message being answered.** Matching on "the
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
 * One missed morning: a skipped occurrence with its offer in a message.
 *
 * Returns the occurrence, which carries the id of the message that
 * offered it — the link an answer is resolved through.
 */
function skip(monday: Job, now: number = FOUR_HOURS_LATE): JobOccurrence {
  catchUpJob(handle.db, monday, { now });
  return listOccurrences(handle.db, monday.id as Uuid)[0]!;
}

/** A person pressing one of the offer's buttons in the inbox, as `messages:answer` does. */
function press(occurrence: JobOccurrence, choice: string) {
  return handleMessageHere(handle.db, { messageId: occurrence.offerCommentId!, how: "answered", answer: choice });
}

function statuses(monday: Job): string[] {
  return listOccurrences(handle.db, monday.id as Uuid).map((o) => o.status);
}

describe("answering the offer", () => {
  it("fires the occurrence that offer was made for, for the moment it was due", () => {
    const monday = job();
    const offered = skip(monday);
    expect(offered.offerCommentId).toBe(messagesAboutJob(handle.db, monday.id)[0]?.id);

    const pressed = press(offered, RUN_NOW_OPTION);

    expect(pressed.ok).toBe(true);
    const fired = listOccurrences(handle.db, monday.id as Uuid).find((o) => o.status === "fired")!;
    // For the Monday, not for the Wednesday somebody got round to it —
    // which is what `{{date}}` on the item reads.
    expect(fired.dueAt).toBe(offered.dueAt);
    const item = getItem(handle.db, fired.itemId as Uuid);
    expect(item?.title).toBe("Monday report for 2026-06-01");
    expect(item?.createdBy).toBe(LOCAL_PERSON_ID);
    // The skipped row stays. `job_occurrences` is append-only, and what
    // happened is that it was skipped and then run.
    expect(statuses(monday)).toEqual(["fired", "skipped"]);
    // And the message is answered, so it leaves the inbox.
    expect(getMessage(handle.db, offered.offerCommentId!)).toMatchObject({ handledHow: "answered", answer: RUN_NOW_OPTION });
  });

  it("fires it once, however many times the answer arrives", () => {
    const monday = job();
    const offered = skip(monday);

    expect(press(offered, RUN_NOW_OPTION).ok).toBe(true);
    // The message is handled now, so a second press is refused…
    expect(press(offered, RUN_NOW_OPTION).ok).toBe(false);
    // …and a second answer reaching the hook anyway fires nothing.
    expect(answerSkipMessage(handle.db, getMessage(handle.db, offered.offerCommentId!)!)).toBeNull();
    expect(statuses(monday).filter((status) => status === "fired")).toHaveLength(1);
  });

  it("does nothing when the person says to leave it", () => {
    const monday = job();
    const offered = skip(monday);

    expect(press(offered, LEAVE_IT_OPTION).ok).toBe(true);
    expect(statuses(monday)).toEqual(["skipped"]);
  });

  it("does nothing when the person dismisses it", () => {
    const monday = job();
    const offered = skip(monday);

    expect(handleMessageHere(handle.db, { messageId: offered.offerCommentId!, how: "dismissed", answer: null }).ok).toBe(true);
    expect(statuses(monday)).toEqual(["skipped"]);
  });
});

/** Two offers, which is the ordinary state of a job that has been missed twice. */
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

  function firedTitles(monday: Job): string[] {
    return listOccurrences(handle.db, monday.id as Uuid)
      .filter((o) => o.status === "fired")
      .map((o) => getItem(handle.db, o.itemId as Uuid)?.title ?? "");
  }

  it("runs the one the answered offer was about, not the newest", () => {
    const monday = job();
    const { first } = twoSkips(monday);

    press(first, RUN_NOW_OPTION);

    // Last Monday's report, which is what they asked for.
    expect(firedTitles(monday)).toEqual(["Monday report for 2026-06-01"]);
  });

  it("runs the newest when that is the one answered", () => {
    const monday = job();
    const { second } = twoSkips(monday);

    press(second, RUN_NOW_OPTION);

    expect(firedTitles(monday)).toEqual(["Monday report for 2026-06-08"]);
  });

  it("lets both be run, each once, without either answer touching the other", () => {
    const monday = job();
    const { first, second } = twoSkips(monday);

    press(first, RUN_NOW_OPTION);
    press(second, RUN_NOW_OPTION);

    const fired = listOccurrences(handle.db, monday.id as Uuid).filter((occurrence) => occurrence.status === "fired");
    expect(fired.map((occurrence) => occurrence.dueAt).sort()).toEqual([MONDAY_0800, MONDAY_0800 + A_WEEK]);
  });
});

describe("what carries no offer", () => {
  it("offers nothing for a skip made because the previous item is still open", () => {
    const monday = job();
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + 60_000 });
    catchUpJob(handle.db, monday, { now: MONDAY_0800 + A_WEEK + 60_000 });
    const blocked = listOccurrences(handle.db, monday.id as Uuid)[0]!;
    expect(blocked.reason).toBe("previous still open");
    // Nothing was offered, so there is nothing an answer could point at —
    // running it would file the second copy the skip prevented.
    expect(blocked.offerCommentId).toBeNull();
    const told = messagesAboutJob(handle.db, monday.id).at(-1)!;
    expect(told.options).toBeNull();
    expect(answerSkipMessage(handle.db, { ...told, handledAt: 1, handledHow: "answered", answer: RUN_NOW_OPTION })).toBeNull();
  });

  it("ignores an answered message some other sender sent", () => {
    const monday = job();
    const offered = skip(monday);
    const real = getMessage(handle.db, offered.offerCommentId!)!;
    const impostor: Message = { ...real, source: "template_conflict", handledAt: 1, handledHow: "answered", answer: RUN_NOW_OPTION };

    expect(answerSkipMessage(handle.db, impostor)).toBeNull();
    expect(statuses(monday)).toEqual(["skipped"]);
  });
});

/**
 * An offer a skip posted on the job's thread before EO-729, still open
 * in somebody's inbox until the threads are retired: answering it by
 * reply still fires the occurrence it named.
 */
describe("an offer posted on the thread before skips became messages", () => {
  function legacyOffer(monday: Job): JobOccurrence {
    const offer = postComment(handle.db, {
      itemId: monday.threadItemId as Uuid,
      author: { type: "engine" },
      kind: "question",
      options: SKIP_OFFER_OPTIONS,
      mentions: [{ type: "human" }],
      parseBodyMentions: false,
      body: `"Monday report" was skipped. Run it now?`,
    });
    return recordOccurrence(handle.db, {
      jobId: monday.id as Uuid,
      dueAt: MONDAY_0800,
      status: "skipped",
      firedAt: null,
      reason: "offline beyond grace",
      offerCommentId: offer.id as Uuid,
    });
  }

  function reply(item: Uuid, body: string, parentId: string | null): Comment {
    return postComment(handle.db, { itemId: item, author: { type: "human" }, body, parentId: parentId as Uuid | null });
  }

  it("fires the occurrence that offer was made for, once", () => {
    const monday = job();
    const offered = legacyOffer(monday);

    const result = answerSkipOffer(handle.db, reply(monday.threadItemId as Uuid, `run it now\n\nWe still need last week's numbers.`, offered.offerCommentId));

    expect(result?.occurrence?.dueAt).toBe(MONDAY_0800);
    expect(result?.item?.title).toBe("Monday report for 2026-06-01");
    expect(answerSkipOffer(handle.db, reply(monday.threadItemId as Uuid, RUN_NOW_OPTION, offered.offerCommentId))).toBeNull();
  });

  it("ignores a remark that answers nothing, and a reply on another item citing the offer", () => {
    const monday = job();
    const offered = legacyOffer(monday);
    const other = createJob(handle.db, {
      projectId: null,
      name: "Something else",
      trigger: { kind: "manual" },
      pipelineId: "default",
      template: { type: "developer:story", title: "x", body: null },
    });
    if (!other.ok) throw new Error(other.problem);

    expect(answerSkipOffer(handle.db, reply(monday.threadItemId as Uuid, RUN_NOW_OPTION, null))).toBeNull();
    expect(answerSkipOffer(handle.db, reply(other.job.threadItemId as Uuid, RUN_NOW_OPTION, offered.offerCommentId))).toBeNull();
    expect(statuses(monday)).toEqual(["skipped"]);
  });
});
