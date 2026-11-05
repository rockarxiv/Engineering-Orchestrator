import { sql } from "drizzle-orm";
import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRoute, createRun, createStep, getItem, listCommentsForItem, updateRun } from "../db/repos/index.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { EngineHandle } from "./domainCommands.js";
import { decideItem } from "./domainCommands.js";
import { getItemDetail } from "./domainQueries.js";

let handle: DbHandle;

function fakeEngine(): EngineHandle {
  return {
    resumeItem: vi.fn(async () => {}),
    cancelRun: vi.fn(),
    steerRun: vi.fn(async () => "no-live-run" as const),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: () => false,
    dispatchBlockerFor: () => null,
    activeRunCount: () => 0,
    finishingRunCount: () => 0,
    notifyStateChange: vi.fn(),
    itemLock: createItemLock(),
    // Nothing in these tests is a record answering another device.
    offerWork: async () => [],
  };
}

/**
 * A pipeline shaped like the one the design describes: a person looks at a
 * draft, and either approves it onward or sends it back with the reason.
 *
 * Built rather than borrowed from the shipped graph, because what the AC
 * names is exactly this shape — `approved → Send`, `send_back → Draft` —
 * and a fixture built from the developer pipeline would be testing the
 * developer pipeline instead of the mechanism.
 */
function marketingPipeline(): { pipelineId: string } {
  const pipelineId = "default";
  createStep(handle.db, { id: "draft", pipelineId: pipelineId as Uuid, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "implement" });
  createStep(handle.db, {
    id: "approval",
    pipelineId: pipelineId as Uuid,
    position: 21,
    name: "Approval",
    type: "user",
    results: [
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ],
  });
  createStep(handle.db, { id: "send", pipelineId: pipelineId as Uuid, position: 22, name: "Send", type: "builtin", entryAction: "open_pull_request" });
  createRoute(handle.db, { pipelineId: pipelineId as Uuid, fromStepId: "draft", resultKey: "done", label: "Drafted", target: "approval", position: 0 });
  createRoute(handle.db, { pipelineId: pipelineId as Uuid, fromStepId: "approval", resultKey: "approved", label: "Approve", tone: "success", target: "send", position: 0 });
  createRoute(handle.db, { pipelineId: pipelineId as Uuid, fromStepId: "approval", resultKey: "send_back", label: "Send back", tone: "warning", target: "draft", position: 1 });
  return { pipelineId };
}

beforeEach(() => {
  handle = openMigratedTestDb();
  marketingPipeline();
});

afterEach(() => handle.close());

describe("items:decide", () => {
  /**
   * The acceptance criterion, whole: the route decides where it goes,
   * the person is the actor, and their words are in the thread *before*
   * the move rather than after it.
   */
  it("moves the item by the route, as the person, with the comment first", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });
    const notifyStateChange = vi.fn();
    const engine = { ...fakeEngine(), notifyStateChange };

    const result = decideItem(handle.db, engine, { itemId: item.id, resultKey: "approved", comment: "Numbers check out." });

    expect(result).toMatchObject({ decided: true, toStepId: "send", toStepName: "Send", problem: null });
    expect(getItem(handle.db, item.id)?.stepId).toBe("send");

    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.transitions.at(-1)).toMatchObject({ fromStepId: "approval", toStepId: "send", actor: "human", reason: 'decided "Approve"' });
    // Before the transition, which is what puts it in front of whatever
    // the decision dispatches (ARCHITECTURE.md, "Moving an item by hand").
    const comment = detail.comments.find((entry) => entry.id === result.commentId)!;
    expect(comment.authorType).toBe("human");
    expect(comment.createdAt).toBeLessThanOrEqual(detail.transitions.at(-1)!.ts);
    // The scheduler is told, because the step it landed on may be
    // dispatchable this instant.
    expect(notifyStateChange).toHaveBeenCalled();
  });

  /** An approval is an approval and a send-back is a rejection — said in the thread, not derived from prose. */
  it("files the comment as an approval or a rejection by what the result means", () => {
    const approved = createTestItem(handle.db, { type: "story", title: "One", stepId: "approval" });
    decideItem(handle.db, fakeEngine(), { itemId: approved.id, resultKey: "approved", comment: "Ship it." });
    expect(listCommentsForItem(handle.db, approved.id)[0]?.kind).toBe("approval");

    const sentBack = createTestItem(handle.db, { type: "story", title: "Two", stepId: "approval" });
    decideItem(handle.db, fakeEngine(), { itemId: sentBack.id, resultKey: "send_back", comment: "The Q3 number is wrong." });
    expect(listCommentsForItem(handle.db, sentBack.id)[0]?.kind).toBe("rejection");
  });

  it("sends it back where the route says, carrying the reason", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "send_back", comment: "The Q3 number is wrong." });

    expect(result.toStepId).toBe("draft");
    expect(getItem(handle.db, item.id)?.stepId).toBe("draft");
    expect(listCommentsForItem(handle.db, item.id)[0]?.body).toBe("The Q3 number is wrong.");
  });

  it("refuses a key the step does not declare, and moves nothing", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "reject", comment: "" });

    expect(result.decided).toBe(false);
    expect(result.problem).toContain('"reject" is not one of the results "Approval" declares');
    expect(getItem(handle.db, item.id)?.stepId).toBe("approval");
  });

  it("refuses on a step an agent acts on, saying so", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "draft" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "approved", comment: "" });

    expect(result.problem).toContain("is not a step a person decides on");
    expect(getItem(handle.db, item.id)?.stepId).toBe("draft");
  });

  /** And leaves no half-decision behind: no comment, because nothing happened. */
  it("refuses a result that needs a reason without one, and posts nothing", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "send_back", comment: "  " });

    expect(result.problem).toContain('"Send back" needs a comment saying why');
    expect(result.commentId).toBeNull();
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(0);
    expect(getItem(handle.db, item.id)?.stepId).toBe("approval");
  });

  /**
   * A person can put an agent on any item by mentioning it, so an item
   * on a human step is not guaranteed idle — and deciding under a run
   * would move the work out from under it.
   */
  it("refuses while an agent is working on the item", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });
    const run = createRun(handle.db, { itemId: item.id, agentId: null, action: "implement" });
    updateRun(handle.db, run.id, { status: "running" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "approved", comment: "" });

    expect(result.problem).toContain("An agent is working on this item right now");
    expect(getItem(handle.db, item.id)?.stepId).toBe("approval");
  });

  /**
   * The graph the validator refuses to save, met at runtime because
   * something wrote it another way. Refused rather than silently doing
   * nothing, which is what a drag would have done.
   */
  it("refuses a declared result whose route has gone", () => {
    // A graph edited around the validator, which is the only way this
    // state is reached: `validatePipeline` refuses to save it.
    handle.db.run(sql`delete from step_routes where from_step_id = 'approval' and result_key = 'approved'`);
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "approved", comment: "" });

    expect(result.problem).toContain('"Approve" has nowhere to go');
    // Pointed at the assistant, which is where a pipeline is changed now (EO-525).
    expect(result.problem).toContain("Ask the assistant to route it");
    expect(result.problem).not.toContain("configuration screen");
    expect(getItem(handle.db, item.id)?.stepId).toBe("approval");
  });
});

describe("what the item detail offers", () => {
  it("names the buttons and where each one leads", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });

    expect(getItemDetail(handle.db, { itemId: item.id })!.decision).toEqual([
      { key: "approved", label: "Approve", tone: "success", requiresComment: false, targetName: "Send" },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true, targetName: "Draft" },
    ]);
  });

  it("offers nothing on a step nobody decides on", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "draft" });
    expect(getItemDetail(handle.db, { itemId: item.id })!.decision).toEqual([]);
  });

  /** A human step that only waits, which is every one EO shipped before this. */
  it("offers nothing on a human step that declares no results", () => {
    // A human step from before a person could decide at all.
    handle.db.run(sql`update pipeline_steps set results = '[]' where id = 'approval'`);
    const item = createTestItem(handle.db, { type: "story", title: "Q3 post", stepId: "approval" });
    expect(getItemDetail(handle.db, { itemId: item.id })!.decision).toEqual([]);
  });
});

/**
 * The developer pack's own human step (EO-310).
 *
 * "Done" is where a person looks at finished work, and until now
 * accepting it was doing nothing and sending it back was a drag. The
 * migration gives it both as results, so the shipped pipeline exercises
 * the mechanism rather than only a fixture's.
 */
describe("the shipped Done step", () => {
  it("offers Approve and Send back, and sending back returns the item to To Do", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "ready_to_merge" });

    const offered = getItemDetail(handle.db, { itemId: item.id })!.decision;
    expect(offered.map((result) => result.key)).toEqual(["approved", "send_back"]);
    expect(offered.find((result) => result.key === "send_back")?.requiresComment).toBe(true);

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "send_back", comment: "The limiter counts per process." });
    expect(result.toStepId).toBe("todo");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("records an approval on the step the work finished on", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limiting", stepId: "ready_to_merge" });

    const result = decideItem(handle.db, fakeEngine(), { itemId: item.id, resultKey: "approved", comment: "" });

    expect(result).toMatchObject({ decided: true, toStepId: "ready_to_merge", problem: null });
    const detail = getItemDetail(handle.db, { itemId: item.id })!;
    expect(detail.transitions.at(-1)).toMatchObject({ toStepId: "ready_to_merge", actor: "human", reason: 'decided "Approve"' });
  });
});

