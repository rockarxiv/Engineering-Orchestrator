import { REVIEW_VERDICT_EVENT, type Item, type ReviewVerdictEvent, type Uuid } from "@eo/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { appendRunEvent, createPipeline, createPipelineVersion, createRun, createStep, getItem, getStep, listCommentsForItem, listRunsForItem, transitionItem } from "../../db/repos/index.js";
import { pipelineSteps, stepRoutes } from "../../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { routeOverrunFor } from "../../supervisor/routeLimits.js";
import { createRunSupervisor } from "../../supervisor/runSupervisor.js";
import { reviewRoundsNote } from "./routeLimitNotes.js";
import { developerPack } from "./index.js";

/**
 * The developer pack's paragraph on the comment that holds a send-back
 * loop (EO-921): for a route out of a step that reviews, the criteria
 * each counted review round found met, out of those declared, read from
 * the verdicts the review runs recorded.
 */

let handle: DbHandle;
let item: Item;
let clock: number;

function tick(): void {
  clock += 1_000;
  vi.setSystemTime(clock);
}

function verdict(met: number, declaredCriteria: number): ReviewVerdictEvent {
  return { verdict: "reject", blockingIssues: 1, declaredCriteria, met, notMet: declaredCriteria - met, notAssessed: 0, notReported: 0, unexamined: 0 };
}

/** One review round: a review run recording its verdict, and the move its rejection makes along `review → changes_requested`. */
function round(recorded: ReviewVerdictEvent | null): void {
  tick();
  if (getItem(handle.db, item.id)?.stepId !== "review") transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });
  tick();
  const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "review", status: "succeeded", threadId: "t" });
  if (recorded !== null) appendRunEvent(handle.db, run.id, REVIEW_VERDICT_EVENT, recorded);
  tick();
  transitionItem(handle.db, { itemId: item.id, toStepId: "todo", toPipelineId: "default" as Uuid, actor: "engine", runId: run.id, reason: "run succeeded", resultKey: "changes_requested" });
  tick();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.UTC(2026, 10, 26, 9, 0, 0);
  vi.setSystemTime(clock);
  handle = openMigratedTestDb();
  handle.db.update(stepRoutes).set({ traversalLimit: 2 }).where(and(eq(stepRoutes.fromStepId, "review"), eq(stepRoutes.resultKey, "changes_requested"))).run();
  item = createTestItem(handle.db, { type: "story", title: "Edge cases", stepId: "review" });
});

afterEach(() => {
  handle.close();
  vi.useRealTimers();
});

describe("the review rounds line", () => {
  it("lists the criteria met out of declared in each review round counted, oldest first", () => {
    round(verdict(1, 5));
    round(verdict(3, 5));
    round(verdict(2, 5));

    const overrun = routeOverrunFor(handle.db, getItem(handle.db, item.id)!);
    expect(overrun?.hold).toMatchObject({ count: 3, limit: 2 });
    expect(reviewRoundsNote(handle.db, getItem(handle.db, item.id)!, overrun!)).toBe(
      "Acceptance criteria met in each of these 3 review rounds, oldest first: 1 of 5, 3 of 5, 2 of 5.",
    );
  });

  it("says a round that recorded no verdict, and one against no declared criteria, for what they are", () => {
    round(null);
    round(verdict(0, 0));
    round(verdict(4, 7));

    const overrun = routeOverrunFor(handle.db, getItem(handle.db, item.id)!)!;
    expect(reviewRoundsNote(handle.db, getItem(handle.db, item.id)!, overrun)).toBe(
      "Acceptance criteria met in each of these 3 review rounds, oldest first: not recorded, none declared, 4 of 7.",
    );
  });

  it("adds nothing for a route out of a step that does not review", () => {
    handle.db.update(stepRoutes).set({ traversalLimit: 1 }).where(and(eq(stepRoutes.fromStepId, "pull_request_watch"), eq(stepRoutes.resultKey, "checks_failed"))).run();
    for (let round = 0; round < 2; round += 1) {
      tick();
      transitionItem(handle.db, { itemId: item.id, toStepId: "pull_request_watch", actor: "human" });
      tick();
      transitionItem(handle.db, { itemId: item.id, toStepId: "todo", toPipelineId: "default" as Uuid, actor: "engine", reason: "a step that keeps checking reported a result", resultKey: "checks_failed" });
    }
    const overrun = routeOverrunFor(handle.db, getItem(handle.db, item.id)!)!;
    expect(overrun.hold.resultKey).toBe("checks_failed");
    expect(reviewRoundsNote(handle.db, getItem(handle.db, item.id)!, overrun)).toBeNull();
  });

  it("reads the step's action from the version the move left, for a route into another pipeline", () => {
    const todo = getStep(handle.db, "todo")!;
    const other = createPipeline(handle.db, { name: "Elsewhere" });
    createStep(handle.db, { id: "elsewhere", pipelineId: other.id, position: 0, name: "Elsewhere", type: todo.type, agentId: todo.agentId, entryAction: todo.entryAction });
    createPipelineVersion(handle.db, other.id);
    handle.db.update(stepRoutes).set({ target: "elsewhere", traversalLimit: 1 }).where(and(eq(stepRoutes.fromStepId, "review"), eq(stepRoutes.resultKey, "changes_requested"))).run();
    createPipelineVersion(handle.db, "default");
    const handOver = (recorded: ReviewVerdictEvent) => {
      tick();
      if (getItem(handle.db, item.id)?.stepId !== "review") transitionItem(handle.db, { itemId: item.id, toStepId: "review", toPipelineId: "default" as Uuid, actor: "human" });
      tick();
      const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "review", stepId: "review", status: "succeeded", threadId: "t" });
      appendRunEvent(handle.db, run.id, REVIEW_VERDICT_EVENT, recorded);
      tick();
      transitionItem(handle.db, { itemId: item.id, toStepId: "elsewhere", toPipelineId: other.id, actor: "engine", runId: run.id, reason: "run succeeded", resultKey: "changes_requested" });
    };

    handOver(verdict(2, 6));
    tick();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", toPipelineId: "default" as Uuid, actor: "human" });
    // A newer version of the source no longer reviews on that step; the item is still on the one that does.
    handle.db.update(pipelineSteps).set({ entryAction: "implement" }).where(eq(pipelineSteps.id, "review")).run();
    createPipelineVersion(handle.db, "default");
    handOver(verdict(4, 6));

    const overrun = routeOverrunFor(handle.db, getItem(handle.db, item.id)!)!;
    expect(overrun.hold).toMatchObject({ count: 2, limit: 1 });
    expect(overrun.fromStep?.entryAction).toBe("review");
    expect(reviewRoundsNote(handle.db, getItem(handle.db, item.id)!, overrun)).toBe(
      "Acceptance criteria met in each of these 2 review rounds, oldest first: 2 of 6, 4 of 6.",
    );
  });

  it("is on the comment that holds the item, through the pack the engine installs", async () => {
    round(verdict(1, 5));
    round(verdict(3, 5));
    round(verdict(2, 5));

    const start = vi.fn(() => {
      throw new Error("a held item must not reach a provider");
    });
    const engine = createRunSupervisor({
      db: handle.db,
      provider: { start } as never,
      limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      routeLimitNotes: developerPack({ db: handle.db }).routeLimitNotes ?? [],
    });
    await engine.runOnce();

    expect(start).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.action === "implement")).toEqual([]);
    const held = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation" && comment.body.startsWith("Held before "));
    expect(held).toHaveLength(1);
    expect(held[0]!.body).toContain(`the route "Review" → Changes requested has been taken 3 times since this ticket was filed, and its limit is 2`);
    expect(held[0]!.body).toContain("Acceptance criteria met in each of these 3 review rounds, oldest first: 1 of 5, 3 of 5, 2 of 5.");
  });
});
