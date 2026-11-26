import type { LearningReviewKind, Run, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { quietChatReview } from "./quietChats.js";

const IDLE = 10 * 60_000;

/** An `assist` run, ended at `endedAt`, by an id that sorts as creation order. */
function run(id: string, threadId: string | null, endedAt: number | null, status: Run["status"] = "succeeded"): Run {
  return { id: id as Uuid, threadId, status, endedAt, startedAt: endedAt === null ? null : endedAt - 1_000 } as Run;
}

const full = (): LearningReviewKind => "full";

describe("which review a quiet assistant chat is owed (EO-788)", () => {
  it("owes nothing where nothing since the last review is reviewable", () => {
    expect(quietChatReview({ runs: [], reviewedThrough: null, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "settled" });
    // Reviewed through its newest run.
    expect(quietChatReview({ runs: [run("01", "t1", 0), run("02", "t1", 1)], reviewedThrough: "02", now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "settled" });
    // A run the review would skip, or with no thread, is not owed one.
    expect(quietChatReview({ runs: [run("01", "t1", 0)], reviewedThrough: null, now: IDLE * 3, idleMs: IDLE, reviewFor: () => null })).toEqual({ kind: "settled" });
    expect(quietChatReview({ runs: [run("01", null, 0)], reviewedThrough: null, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "settled" });
  });

  it("waits until the idle time has passed since the last run ended, and while a run is going", () => {
    const runs = [run("01", "t1", 1_000), run("02", "t1", 5_000)];
    expect(quietChatReview({ runs, reviewedThrough: null, now: 5_000 + IDLE - 1, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "waiting", dueAt: 5_000 + IDLE });
    expect(quietChatReview({ runs: [...runs, run("03", "t1", null, "running")], reviewedThrough: null, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "waiting", dueAt: null });
    expect(quietChatReview({ runs, reviewedThrough: null, now: 5_000 + IDLE, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "due", threads: [{ runId: "02", threadId: "t1", review: "full", runIds: ["01", "02"] }] });
  });

  it("owes each thread since the last review one review, of its newest run, oldest thread first", () => {
    const runs = [run("01", "t1", 0), run("02", "t2", 1), run("03", "t3", 2), run("04", "t2", 3), run("05", "t1", 4)];
    expect(quietChatReview({ runs, reviewedThrough: "01", now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({
      kind: "due",
      threads: [
        { runId: "03", threadId: "t3", review: "full", runIds: ["03"] },
        { runId: "04", threadId: "t2", review: "full", runIds: ["02", "04"] },
        { runId: "05", threadId: "t1", review: "full", runIds: ["05"] },
      ],
    });
  });

  it("is the skill half alone only where every run on the thread wrote its own notes, and skips a newest run the review would skip", () => {
    const runs = [run("01", "t1", 0), run("02", "t1", 1), run("03", "t1", 2, "cancelled")];
    const reviewFor = (r: Run): LearningReviewKind | null => (r.id === "03" ? null : r.id === "02" ? "skills_only" : "full");
    expect(quietChatReview({ runs, reviewedThrough: null, now: IDLE * 3, idleMs: IDLE, reviewFor })).toEqual({ kind: "due", threads: [{ runId: "02", threadId: "t1", review: "full", runIds: ["01", "02"] }] });
    expect(quietChatReview({ runs, reviewedThrough: "01", now: IDLE * 3, idleMs: IDLE, reviewFor })).toEqual({ kind: "due", threads: [{ runId: "02", threadId: "t1", review: "skills_only", runIds: ["02"] }] });
  });

  it("owes nothing for a run whose review was skipped for its action's setting, and still owes an older run on another thread its review (EO-911)", () => {
    // Thread t1's run ended with reviews on and is not reviewed yet; t2's
    // ended with them off and carries its skip.
    const runs = [run("01", "t1", 0), run("02", "t2", 1)];
    const skipped = new Set(["02"]);
    expect(quietChatReview({ runs, reviewedThrough: null, skipped, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({
      kind: "due",
      threads: [{ runId: "01", threadId: "t1", review: "full", runIds: ["01"] }],
    });
    // On one thread: the skipped newer run is left out, the older one is the review's.
    expect(quietChatReview({ runs: [run("01", "t1", 0), run("02", "t1", 1)], reviewedThrough: null, skipped, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({
      kind: "due",
      threads: [{ runId: "01", threadId: "t1", review: "full", runIds: ["01"] }],
    });
    expect(quietChatReview({ runs: [run("02", "t2", 1)], reviewedThrough: null, skipped, now: IDLE * 3, idleMs: IDLE, reviewFor: full })).toEqual({ kind: "settled" });
  });
});
