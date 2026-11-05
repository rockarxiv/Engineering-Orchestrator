import type { Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRoute, createStep, getItem, listCommentsForItem, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { answersSinceLastAsk, newestAnswerToLastAsk } from "../roles/answers.js";
import { unansweredQuestions } from "../roles/clarificationQuestions.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { ON_YOUR_BEHALF_TRIAL } from "../trials/onBehalf.js";
import type { EngineHandle } from "./domainCommands.js";
import { decideItem, postHumanComment } from "./domainCommands.js";
import { getItemDetail } from "./domainQueries.js";

/**
 * The system agent standing in for the person (EO-585).
 *
 * While a draft is tested the assistant presses the results of person
 * steps and answers the questions agents put to the person. Each is
 * recorded as the agent's — never as the person — and on a trial item
 * the thread says it was done on the person's behalf. Every case here
 * presses the same result twice, once as the person and once as the
 * agent, so the difference between the two is the whole of what is
 * asserted.
 *
 * `actingAgentId` is set by hand below. In the app only EO's
 * administrative MCP host sets it, from the turn's credential —
 * `mcpHost/standIn.test.ts` holds that end.
 */

let handle: DbHandle;
let systemAgentId: Uuid;

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
    offerWork: async () => [],
  };
}

/** A person approves a draft onward or sends it back with a reason. */
function approvalPipeline(): void {
  const pipelineId = "default" as Uuid;
  createStep(handle.db, { id: "draft", pipelineId, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "implement" });
  createStep(handle.db, {
    id: "approval",
    pipelineId,
    position: 21,
    name: "Approval",
    type: "user",
    results: [
      { key: "approved", label: "Approve", tone: "success", requiresComment: false },
      { key: "send_back", label: "Send back", tone: "warning", requiresComment: true },
    ],
  });
  createStep(handle.db, { id: "send", pipelineId, position: 22, name: "Send", type: "builtin", entryAction: "open_pull_request" });
  createRoute(handle.db, { pipelineId, fromStepId: "approval", resultKey: "approved", label: "Approve", tone: "success", target: "send", position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: "approval", resultKey: "send_back", label: "Send back", tone: "warning", target: "draft", position: 1 });
}

function item(onTrial: boolean, stepId = "approval") {
  return createTestItem(handle.db, { type: "story", title: onTrial ? "A test item" : "Live work", stepId, ...(onTrial ? { trialAt: Date.now() } : {}) });
}

function lastTransition(itemId: Uuid) {
  return getItemDetail(handle.db, { itemId })!.transitions.at(-1)!;
}

beforeEach(() => {
  handle = openMigratedTestDb();
  approvalPipeline();
  systemAgentId = createAgent(handle.db, {
    name: "Assistant",
    role: "system",
    provider: "fake",
    instructions: "",
    config: { allowedTools: ["mcp__eo_admin", "mcp__eo__comment"] },
  }).id;
});

afterEach(() => handle.close());

describe("pressing a person's result, as the person and as the system agent", () => {
  it("records the system agent's press as its own: its id on the transition, its name on the comment, and the note on a trial item", () => {
    const byPerson = item(true);
    const byAgent = item(true);

    const person = decideItem(handle.db, fakeEngine(), { itemId: byPerson.id, resultKey: "send_back", comment: "The total is wrong." });
    const agent = decideItem(handle.db, fakeEngine(), { itemId: byAgent.id, resultKey: "send_back", comment: "The total is wrong.", actingAgentId: systemAgentId });

    // The same route either way: who pressed it does not change where it goes.
    for (const result of [person, agent]) expect(result).toMatchObject({ decided: true, toStepId: "draft", problem: null });

    // The person, exactly as before.
    expect(lastTransition(byPerson.id)).toMatchObject({ actor: "human", reason: 'decided "Send back"' });
    const personComment = listCommentsForItem(handle.db, byPerson.id).find((comment) => comment.id === person.commentId)!;
    expect(personComment).toMatchObject({ authorType: "human", authorId: null, kind: "rejection", body: "The total is wrong." });

    // The agent, as itself.
    expect(lastTransition(byAgent.id)).toMatchObject({ actor: systemAgentId });
    expect(lastTransition(byAgent.id).reason).toMatch(/^decided "Send back"/);
    const agentComment = listCommentsForItem(handle.db, byAgent.id).find((comment) => comment.id === agent.commentId)!;
    expect(agentComment).toMatchObject({ authorType: "agent", authorId: systemAgentId, kind: "rejection" });
    expect(agentComment.body.startsWith("The total is wrong.")).toBe(true);
    expect(agentComment.body).toContain(ON_YOUR_BEHALF_TRIAL);
  });

  it("writes a comment for the system agent's press even when it gave no words, where a person's wordless press writes none", () => {
    const byPerson = item(true);
    const byAgent = item(true);

    const person = decideItem(handle.db, fakeEngine(), { itemId: byPerson.id, resultKey: "approved", comment: "" });
    const agent = decideItem(handle.db, fakeEngine(), { itemId: byAgent.id, resultKey: "approved", comment: "", actingAgentId: systemAgentId });

    expect(person.commentId).toBeNull();
    expect(listCommentsForItem(handle.db, byPerson.id)).toHaveLength(0);

    expect(agent.commentId).not.toBeNull();
    const [comment] = listCommentsForItem(handle.db, byAgent.id);
    expect(comment).toMatchObject({ authorType: "agent", authorId: systemAgentId, kind: "approval" });
    expect(comment!.body).toContain('Decided "Approve".');
    expect(comment!.body).toContain(ON_YOUR_BEHALF_TRIAL);
    expect(getItem(handle.db, byAgent.id)?.stepId).toBe("send");
  });

  it("records the system agent as itself off a trial too, without the trial note", () => {
    const live = item(false);

    const result = decideItem(handle.db, fakeEngine(), { itemId: live.id, resultKey: "approved", comment: "Fine.", actingAgentId: systemAgentId });

    expect(result.decided).toBe(true);
    expect(lastTransition(live.id).actor).toBe(systemAgentId);
    const [comment] = listCommentsForItem(handle.db, live.id);
    expect(comment).toMatchObject({ authorType: "agent", authorId: systemAgentId, body: "Fine." });
  });

  it("refuses a result that needs a reason without one, from the system agent as from a person, and writes nothing", () => {
    for (const actingAgentId of [undefined, systemAgentId]) {
      const subject = item(true);
      const result = decideItem(handle.db, fakeEngine(), { itemId: subject.id, resultKey: "send_back", comment: "  ", ...(actingAgentId ? { actingAgentId } : {}) });

      expect(result.decided).toBe(false);
      expect(result.problem).toContain("Send back");
      expect(getItem(handle.db, subject.id)?.stepId).toBe("approval");
      expect(listCommentsForItem(handle.db, subject.id)).toHaveLength(0);
      expect(getItemDetail(handle.db, { itemId: subject.id })!.transitions).toHaveLength(0);
    }
  });

  it("refuses an acting agent that names nobody here, rather than recording a press under it", () => {
    const subject = item(true);

    const result = decideItem(handle.db, fakeEngine(), { itemId: subject.id, resultKey: "approved", comment: "", actingAgentId: "019a0000-0000-7000-8000-000000000000" });

    expect(result.decided).toBe(false);
    expect(result.problem).toContain("no longer one of this installation's agents");
    expect(getItem(handle.db, subject.id)?.stepId).toBe("approval");
  });
});

describe("answering an agent's question on a trial item", () => {
  function askedQuestion(itemId: Uuid): Uuid {
    const asker = createAgent(handle.db, { name: "Implementer", role: "implementer", provider: "fake", instructions: "" });
    return postComment(handle.db, {
      itemId,
      author: { type: "agent", agentId: asker.id },
      kind: "question",
      mentions: [{ type: "human" }],
      body: "Should an empty total be zero or refused?",
    }).id;
  }

  it("files the system agent's reply as its own, with the note, and counts it as the answer", async () => {
    const subject = item(true, "draft");
    const question = askedQuestion(subject.id);
    expect(unansweredQuestions(handle.db, subject.id)).toEqual([question]);

    const posted = await postHumanComment(handle.db, fakeEngine(), {
      itemId: subject.id,
      body: "Zero — the test item says so.",
      mentions: [],
      pinned: false,
      parentId: question,
      actingAgentId: systemAgentId,
    });

    const reply = listCommentsForItem(handle.db, subject.id).find((comment) => comment.id === posted.commentId)!;
    expect(reply).toMatchObject({ authorType: "agent", authorId: systemAgentId, parentId: question });
    expect(reply.body.startsWith("Zero — the test item says so.")).toBe(true);
    expect(reply.body).toContain(ON_YOUR_BEHALF_TRIAL);
    expect(unansweredQuestions(handle.db, subject.id)).toEqual([]);
  });

  it("files the person's reply as before", async () => {
    const subject = item(true, "draft");
    const question = askedQuestion(subject.id);

    const posted = await postHumanComment(handle.db, fakeEngine(), { itemId: subject.id, body: "Zero.", mentions: [], pinned: false, parentId: question });

    const reply = listCommentsForItem(handle.db, subject.id).find((comment) => comment.id === posted.commentId)!;
    expect(reply).toMatchObject({ authorType: "human", body: "Zero." });
    expect(unansweredQuestions(handle.db, subject.id)).toEqual([]);
  });

  it("leaves the system agent's words on a live item as they always were (EO-514), and does not let another agent answer for the person", async () => {
    const live = item(false, "draft");
    const posted = await postHumanComment(handle.db, fakeEngine(), { itemId: live.id, body: "Save", mentions: [], pinned: false, parentId: null, actingAgentId: systemAgentId });
    expect(listCommentsForItem(handle.db, live.id).find((comment) => comment.id === posted.commentId)).toMatchObject({ authorType: "human", body: "Save" });

    // An agent without the administrative grant replying under a
    // question on a trial item is not the person's stand-in.
    const subject = item(true, "draft");
    const question = askedQuestion(subject.id);
    const other = createAgent(handle.db, { name: "Reviewer", role: "reviewer", provider: "fake", instructions: "" });
    postComment(handle.db, { itemId: subject.id, author: { type: "agent", agentId: other.id }, body: "Zero, probably.", parentId: question });
    expect(unansweredQuestions(handle.db, subject.id)).toEqual([question]);
  });

  it("does not count the system agent's words without the note, or written inside a run, as an answer", () => {
    const subject = item(true, "draft");
    const question = askedQuestion(subject.id);
    // Its own words with no note — what anything but `comments:post` on
    // the administrative host writes under its name.
    postComment(handle.db, { itemId: subject.id, author: { type: "agent", agentId: systemAgentId }, body: "Looking.", parentId: question });
    expect(unansweredQuestions(handle.db, subject.id)).toEqual([question]);
  });

  it("is read as the answer by a step that stopped and asked (EO-183's reader)", async () => {
    const subject = item(true, "draft");
    postComment(handle.db, { itemId: subject.id, author: { type: "engine" }, kind: "escalation", mentions: [{ type: "human" }], body: "Which region?", options: ["eu", "us"] });

    await postHumanComment(handle.db, fakeEngine(), { itemId: subject.id, body: "eu", mentions: [], pinned: false, parentId: null, actingAgentId: systemAgentId });

    expect(answersSinceLastAsk(handle.db, subject.id).map((comment) => comment.authorId)).toEqual([systemAgentId]);
    expect(newestAnswerToLastAsk(handle.db, subject.id)?.matched).toBe("eu");
  });
});
