import type { Item, Uuid } from "@eo/core";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listMentionsForComment, listRunsForItem, needsAttention, postComment, transitionItem } from "../db/repos/index.js";
import { stepRoutes } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { BuiltinRunner } from "./builtins.js";
import { routeOverrunFor, type RouteLimitNote } from "./routeLimits.js";
import { ownerMention } from "./watches.js";

/**
 * A route's traversal limit (EO-921), as the supervisor carries it out on
 * the seeded Delivery: Review's `approved` sends the item to Merge
 * Request, a builtin, so whether the item was dispatched is whether
 * `open_pull_request` ran — no provider needed. The core counts routes,
 * so which route it is does not matter here; the developer pack's
 * paragraph about review rounds is tested beside the pack.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;
let openPullRequest: ReturnType<typeof vi.fn<BuiltinRunner>>;
let clock: number;

function supervisor(routeLimitNotes: readonly RouteLimitNote[] = []): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
    limits: LIMITS,
    builtins: { open_pull_request: openPullRequest },
    routeLimitNotes,
  });
}

/** Moves and comments are stamped with the real clock; each gets a second of its own. */
function tick(): void {
  clock += 1_000;
  vi.setSystemTime(clock);
}

function setLimit(fromStepId: string, resultKey: string, limit: number | null): void {
  handle.db.update(stepRoutes).set({ traversalLimit: limit }).where(and(eq(stepRoutes.fromStepId, fromStepId), eq(stepRoutes.resultKey, resultKey))).run();
}

/** Review approves: the move a review run's result makes, along `review → approved`. */
function approve(): void {
  tick();
  if (getItem(handle.db, item.id)?.stepId !== "review") transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });
  tick();
  transitionItem(handle.db, { itemId: item.id, toStepId: "merge_request", toPipelineId: "default" as Uuid, actor: "engine", reason: "run succeeded", resultKey: "approved" });
  tick();
}

function holdComments() {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.kind === "escalation" && comment.body.startsWith("Held before "));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.UTC(2026, 10, 26, 9, 0, 0);
  vi.setSystemTime(clock);
  handle = openMigratedTestDb();
  openPullRequest = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "skipped", detail: "No forge" }));
  item = createTestItem(handle.db, { type: "story", title: "Loops", stepId: "review" });
});

afterEach(() => {
  handle.close();
  vi.useRealTimers();
});

describe("a route with a traversal limit", () => {
  it("moves and dispatches as today while it is under its limit, and on the limit itself", async () => {
    setLimit("review", "approved", 2);
    const engine = supervisor();

    approve();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(1);

    approve();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(2);
    expect(holdComments()).toEqual([]);
    expect(routeOverrunFor(handle.db, getItem(handle.db, item.id)!)).toBeNull();
  });

  it("holds the item on the step it arrived at on the (limit + 1)th traversal, and asks its owner once", async () => {
    setLimit("review", "approved", 2);
    const engine = supervisor();
    approve();
    approve();
    approve();

    await engine.runOnce();
    await engine.runOnce();

    // The move happened; nothing ran where it arrived.
    expect(getItem(handle.db, item.id)?.stepId).toBe("merge_request");
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);

    const comments = holdComments();
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain(`the route "Review" → Approved has been taken 3 times since this ticket was filed, and its limit is 2`);
    expect(body).toContain("Reply here and it carries on from your reply");
    // Complete with no pack installed: the core's words and nothing else.
    expect(body.split("\n\n")).toHaveLength(2);
    // The item's owner, as a watch that gave up mentions them.
    const owner = ownerMention(handle.db, getItem(handle.db, item.id)!);
    expect(listMentionsForComment(handle.db, comments[0]!.id)).toEqual([
      expect.objectContaining({ targetType: "human", targetId: "personId" in owner ? owner.personId : expect.anything(), status: "open" }),
    ]);
    // `!` by derivation: the open mention, nothing stored on the item.
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("carries on from a person's comment, dispatching on its current step, and counts again from it", async () => {
    setLimit("review", "approved", 2);
    const engine = supervisor();
    approve();
    approve();
    approve();
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();

    tick();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Ship it as it is." });
    tick();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(needsAttention(handle.db, item.id)).toBe(false);

    // Two more since the comment are within the limit; the third is not.
    approve();
    await engine.runOnce();
    approve();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(3);
    approve();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(3);
    const comments = holdComments();
    expect(comments).toHaveLength(2);
    expect(comments[1]!.body).toContain("has been taken 3 times since a person last commented");
  });

  it("is not reset by an agent's or the engine's comment", async () => {
    setLimit("review", "approved", 2);
    const engine = supervisor();
    approve();
    approve();
    approve();
    await engine.runOnce();

    tick();
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: "019fb8c6-de91-7f78-9211-9e193bba2ad9" as Uuid }, body: "I think it is fine." });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: "A note." });
    tick();
    await engine.runOnce();

    expect(openPullRequest).not.toHaveBeenCalled();
    expect(holdComments()).toHaveLength(1);
  });

  it("counts only its own route: another result of the same step, or a move by hand, does not add to it", async () => {
    setLimit("review", "approved", 1);
    const engine = supervisor();
    approve();
    tick();
    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });
    tick();
    transitionItem(handle.db, { itemId: item.id, toStepId: "merge_request", actor: "human" });
    tick();
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(holdComments()).toEqual([]);
  });
});

describe("a route with no traversal limit", () => {
  it("never holds, however many times it is taken", async () => {
    const engine = supervisor();
    for (let round = 0; round < 6; round += 1) {
      approve();
      await engine.runOnce();
    }
    expect(openPullRequest).toHaveBeenCalledTimes(6);
    expect(holdComments()).toEqual([]);
  });
});

describe("a pack's paragraph", () => {
  it("is said between the core's words and the reply line, for the routes it answers for", async () => {
    setLimit("review", "approved", 1);
    const note: RouteLimitNote = (_db, _item, overrun) => (overrun.route.resultKey === "approved" ? `Rounds counted: ${overrun.traversals.length}.` : null);
    const engine = supervisor([note, () => null]);
    approve();
    approve();
    await engine.runOnce();

    const parts = holdComments()[0]!.body.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe("Rounds counted: 2.");
  });
});
