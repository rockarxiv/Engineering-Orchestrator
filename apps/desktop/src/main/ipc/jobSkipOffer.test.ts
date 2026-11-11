import { eq } from "drizzle-orm";
import type { Job, JobTrigger, Message, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getMessage, listOccurrences } from "../db/repos/index.js";
import { jobs } from "../db/schema.js";
import { messagesAboutJob, openMigratedTestDb } from "../db/testHelpers.js";
import { catchUpJob } from "../jobs/catchUp.js";
import { createJob } from "../jobs/jobs.js";
import { LEAVE_IT_OPTION, RUN_NOW_OPTION } from "../jobs/answer.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Pressing "Run it now" on a skipped occurrence, through the channel a
 * person actually presses it on (EO-306, EO-729,
 * `ARCHITECTURE.md`, "Schedules, and a machine that was off").
 *
 * `answer.test.ts` covers what the decision is; this covers that
 * `messages:answer` reaches it at all. Worth its own test because the
 * offer has no channel of its own — it is an option on the skip's
 * message, so the wiring is one call inside the ordinary answer path and
 * nothing else would notice if it were removed.
 */

let handle: DbHandle;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform: fakePlatform() });
});

afterEach(() => {
  clearHandlerRegistry();
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

/** A schedule job whose Monday morning was missed, with the offer in a message to its owner. */
function missedMonday(name = "Monday report"): { job: Job; offer: Message } {
  const created = createJob(handle.db, {
    projectId: null,
    name,
    trigger: WEEKLY_0800,
    pipelineId: "default",
    template: { type: "developer:story", title: "{{job}} for {{date}}", body: null },
  });
  if (!created.ok) throw new Error(created.problem);
  handle.db.update(jobs).set({ createdAt: MONDAY_0800 - 60_000 }).where(eq(jobs.id, created.job.id)).run();
  // Four hours late: skipped, with the offer in the owner's inbox.
  catchUpJob(handle.db, { ...created.job, createdAt: MONDAY_0800 - 60_000 }, { now: MONDAY_0800 + 4 * 60 * 60_000 });
  const offer = messagesAboutJob(handle.db, created.job.id)[0]!;
  expect(offer.options).toContain(RUN_NOW_OPTION);
  return { job: created.job, offer };
}

describe("answering a job's skip offer", () => {
  it("fires the occurrence the message was about", async () => {
    const { job: monday, offer } = missedMonday();

    const answered = await dispatchIpc("messages:answer", { messageId: offer.id, answer: RUN_NOW_OPTION });

    expect(answered.ok).toBe(true);
    // The answer is recorded either way — the firing is a consequence of
    // it and never a replacement for it.
    expect(getMessage(handle.db, offer.id)).toMatchObject({ handledHow: "answered", answer: RUN_NOW_OPTION });
    const occurrences = listOccurrences(handle.db, monday.id as Uuid);
    expect(occurrences.map((occurrence) => occurrence.status)).toEqual(["fired", "skipped"]);
    // For the Monday it was due, not for the moment the button was
    // pressed.
    expect(occurrences[0]?.dueAt).toBe(MONDAY_0800);
    expect(occurrences[0]?.itemId).not.toBeNull();
  });

  it("does not fire when the person leaves it, or dismisses it", async () => {
    const first = missedMonday();
    const second = missedMonday("Something else");

    await dispatchIpc("messages:answer", { messageId: first.offer.id, answer: LEAVE_IT_OPTION });
    await dispatchIpc("messages:dismiss", { messageId: second.offer.id });

    expect(listOccurrences(handle.db, first.job.id as Uuid).map((occurrence) => occurrence.status)).toEqual(["skipped"]);
    expect(listOccurrences(handle.db, second.job.id as Uuid).map((occurrence) => occurrence.status)).toEqual(["skipped"]);
  });
});
