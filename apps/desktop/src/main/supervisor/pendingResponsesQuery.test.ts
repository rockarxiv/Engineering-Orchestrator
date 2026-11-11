import { asksToRerun, type Agent, type Item, type Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, DbHandle } from "../db/client.js";
import {
  createRun,
  getItem,
  listActiveRuns,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  offBoardStepIds,
  openAgentMentionsQuery,
  postComment,
  createStep,
} from "../db/repos/index.js";
import { transitionItem } from "../db/repos/transitionsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { openAssistConversation } from "../roles/assist.js";
import { ASSIST_ACTION, ASSIST_STEP } from "../roles/conversationSteps.js";
import { conversationActionFor, findPendingResponses, rerunContract, RESPOND_ACTION, type PendingResponse } from "./manualDispatch.js";

/**
 * The scheduler's mention read, as one query (EO-554).
 *
 * Every tick used to walk every live item, read its whole thread with
 * attachments, and ask for each comment's mentions one by one. These
 * tests hold the replacement to three things: it is one indexed read,
 * it never goes back to the per-item reads, and it answers exactly what
 * the walk answered — the same responses in the same order.
 */

// Wrapped rather than replaced, so every reader still hits the real
// in-memory database and the spies only count.
vi.mock("../db/repos/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/repos/index.js")>();
  return {
    ...actual,
    getItem: vi.fn(actual.getItem),
    listCommentsForItem: vi.fn(actual.listCommentsForItem),
    listMentionsForComment: vi.fn(actual.listMentionsForComment),
  };
});

/**
 * `findPendingResponses` as it was before EO-554, kept verbatim in
 * everything it decides so the new one can be compared with it. Reads
 * through the same repo functions it always did.
 */
function previousFindPendingResponses(db: Db, itemIds: Uuid[]): PendingResponse[] {
  const activeByItem = new Set(listActiveRuns(db).map((run) => run.itemId));
  const offBoard = offBoardStepIds(db);
  const pending: PendingResponse[] = [];

  for (const itemId of itemIds) {
    const stepId = getItem(db, itemId)?.stepId ?? "";
    const action = (offBoard.has(stepId) ? conversationActionFor(stepId) : undefined) ?? RESPOND_ACTION;

    for (const comment of listCommentsForItem(db, itemId)) {
      for (const mention of listMentionsForComment(db, comment.id)) {
        if (mention.status !== "open" || mention.targetType !== "agent" || !mention.targetId) continue;
        if (comment.authorType === "agent" && comment.authorId === mention.targetId) continue;

        const currentStep = asksToRerun(comment.body) ? getItem(db, itemId)?.stepId : undefined;
        const rerunStep = currentStep == null ? null : rerunContract(db, itemId, mention.targetId, currentStep);
        if (rerunStep) {
          pending.push({ itemId, agentId: mention.targetId, commentId: comment.id, action: rerunStep.action, rerunStepId: rerunStep.step.id });
          continue;
        }
        if (activeByItem.has(itemId)) continue;
        pending.push({ itemId, agentId: mention.targetId, commentId: comment.id, action });
      }
    }
  }

  const seen = new Set<string>();
  return [...pending].reverse().filter((entry) => {
    const key = `${entry.itemId}:${entry.agentId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reverse();
}

let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = agents.find((agent) => agent.role === "implementer")!;
  reviewer = agents.find((agent) => agent.role === "reviewer")!;
  vi.mocked(getItem).mockClear();
  vi.mocked(listCommentsForItem).mockClear();
  vi.mocked(listMentionsForComment).mockClear();
});

afterEach(() => {
  handle.close();
});

function story(title: string): Item {
  return createTestItem(handle.db, { type: "story", title, stepId: "todo" });
}

function human(item: Item, body: string, agents: Agent[] = []) {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "human" },
    body,
    mentions: agents.map((agent) => ({ type: "agent" as const, agentId: agent.id })),
  });
}

function byAgent(item: Item, author: Agent, body: string, agents: Agent[] = []) {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "agent", agentId: author.id },
    body,
    mentions: agents.map((agent) => ({ type: "agent" as const, agentId: agent.id })),
  });
}

/**
 * A board shaped like the real one: many items, long threads, and only
 * a few open agent mentions among them — plus one of every case the
 * loop has a rule for.
 */
function busyBoard(): Item[] {
  const items: Item[] = [];
  for (let index = 0; index < 60; index += 1) {
    const item = story(`Story ${index}`);
    items.push(item);
    for (let line = 0; line < 8; line += 1) {
      if (line % 2 === 0) human(item, `Line ${line} of the thread on story ${index}.`);
      else byAgent(item, implementer, `Agent line ${line} on story ${index}.`);
    }
  }

  // An ordinary question.
  human(items[3]!, "@implementer can you look at this?", [implementer]);
  // Two agents in one comment, and a later comment naming one of them
  // again — collapsed to one run each, ordered as the thread reads.
  human(items[7]!, "@reviewer @implementer both of you, please", [reviewer, implementer]);
  human(items[7]!, "@implementer and one more thing", [implementer]);
  // Two agents in one comment and nothing after it: both are answered,
  // in the order the comment's mentions were always read.
  human(items[39]!, "@implementer @reviewer over to you both", [implementer, reviewer]);
  // Already answered: the agent's reply settles it.
  human(items[11]!, "@implementer thoughts?", [implementer]);
  byAgent(items[11]!, implementer, "Here is what I think.");
  // An agent asking another agent, and an agent naming itself.
  byAgent(items[15]!, implementer, "@reviewer does this read right?", [reviewer]);
  byAgent(items[19]!, implementer, "note to self @implementer", [implementer]);
  // A mention of a person is theirs to answer, never an agent's.
  postComment(handle.db, { itemId: items[23]!.id, author: { type: "agent", agentId: implementer.id }, body: "@user which limit?", mentions: [{ type: "human" }] });
  // A question on an item with a run in flight waits; a rerun request
  // on a busy item does not.
  transitionItem(handle.db, { itemId: items[27]!.id, toStepId: "review", actor: "human" });
  createRun(handle.db, { itemId: items[27]!.id, agentId: reviewer.id, action: "review", status: "running" });
  human(items[27]!, "@implementer a question while it runs", [implementer]);
  human(items[27]!, "@reviewer rerun", [reviewer]);
  // A rerun asked of an agent that does not own the step is a question.
  transitionItem(handle.db, { itemId: items[31]!.id, toStepId: "review", actor: "human" });
  human(items[31]!, "@implementer rerun", [implementer]);
  // A rerun asked of the step's own agent.
  transitionItem(handle.db, { itemId: items[35]!.id, toStepId: "review", actor: "human" });
  human(items[35]!, "@reviewer please rerun", [reviewer]);

  // The assistant's room: an off-board step answered with its own action.
  const conversation = openAssistConversation(handle.db, null);
  human(conversation, "@implementer what is this step for?", [implementer]);
  items.push(conversation);

  // An open mention on an item the caller did not ask about.
  const unlisted = story("Not on the board");
  human(unlisted, "@implementer hello?", [implementer]);

  return items;
}

describe("findPendingResponses as one query (EO-554)", () => {
  it("answers exactly what the per-item walk answered, in the same order", () => {
    const items = busyBoard();
    // Not creation order, so the order of the answer is visibly the
    // caller's and not the database's.
    const order = [...items].reverse().map((item) => item.id);
    order.push(order.shift()!, order.shift()!);

    const previous = previousFindPendingResponses(handle.db, order);
    const current = findPendingResponses(handle.db, order);

    expect(current).toEqual(previous);
    // And the fixture really exercised the rules, rather than agreeing
    // on an empty list.
    expect(current.map((entry) => entry.action)).toContain(ASSIST_ACTION);
    expect(current.some((entry) => entry.rerunStepId === "review")).toBe(true);
    expect(current.length).toBeGreaterThanOrEqual(6);
  });

  it("does not read any item's thread or any comment's mentions one by one", () => {
    const items = busyBoard();
    vi.mocked(getItem).mockClear();
    vi.mocked(listCommentsForItem).mockClear();
    vi.mocked(listMentionsForComment).mockClear();

    findPendingResponses(handle.db, items.map((item) => item.id));

    expect(listCommentsForItem).not.toHaveBeenCalled();
    expect(listMentionsForComment).not.toHaveBeenCalled();
    // `getItem` is asked only about the few comments that read as a
    // rerun request, never once per item on the board.
    expect(vi.mocked(getItem).mock.calls.length).toBeLessThan(10);
  });

  it("finds the open agent mentions through idx_mentions_open", () => {
    busyBoard();
    const plan = handle.db
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${openAgentMentionsQuery()}`)
      .map((row) => row.detail);

    expect(plan.join("\n")).toMatch(/SEARCH m USING (COVERING )?INDEX idx_mentions_open \(status=\? AND target_type=\?/);
    // Nothing read whole: every other table is reached by its key.
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("never dispatches an agent to answer its own comment, but does dispatch the other agent it named", () => {
    const item = story("Self");
    const comment = byAgent(item, implementer, "@implementer @reviewer over to you", [implementer, reviewer]);

    expect(findPendingResponses(handle.db, [item.id])).toEqual([
      { itemId: item.id, agentId: reviewer.id, commentId: comment.id, action: RESPOND_ACTION },
    ]);
  });

  it("answers an off-board conversation with its room's action, and an off-board step it does not know with respond", () => {
    const conversation = openAssistConversation(handle.db, null);
    expect(conversation.stepId).toBe(ASSIST_STEP);
    const asked = human(conversation, "@implementer what is this?", [implementer]);

    // An off-board step with no conversation action of its own.
    createStep(handle.db, { id: "notes" as Uuid, pipelineId: "discussions" as Uuid, position: -9, name: "Notes", type: "user", offBoard: true });
    const notes = createTestItem(handle.db, { type: "story", title: "Notes", stepId: "notes" });
    expect(offBoardStepIds(handle.db).has("notes")).toBe(true);
    const noted = human(notes, "@implementer a note", [implementer]);

    // An on-board step is an ordinary question.
    const work = story("Work");
    const questioned = human(work, "@implementer a question", [implementer]);

    expect(findPendingResponses(handle.db, [conversation.id, notes.id, work.id])).toEqual([
      { itemId: conversation.id, agentId: implementer.id, commentId: asked.id, action: ASSIST_ACTION },
      { itemId: notes.id, agentId: implementer.id, commentId: noted.id, action: RESPOND_ACTION },
      { itemId: work.id, agentId: implementer.id, commentId: questioned.id, action: RESPOND_ACTION },
    ]);
  });
});
