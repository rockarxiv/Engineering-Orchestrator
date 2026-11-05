import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { postComment } from "../db/repos/commentsRepo.js";
import { unansweredQuestions } from "./clarificationQuestions.js";

/**
 * What still needs a person, and what a reply actually closed.
 *
 * Both halves of the filter were unguarded: mutation testing could turn
 * "answered by a human, in a reply" into "answered by a human, or a
 * reply" with the whole desktop suite still green — so an agent talking
 * to itself could close a question meant for a person.
 */
describe("which questions are still waiting on a human", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  let reviewer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "Add the limiter", stepId: "todo" });
    const agents = listAgents(handle.db);
    implementer = agents.find((agent) => agent.role === "implementer")!;
    reviewer = agents.find((agent) => agent.role === "reviewer")!;
  });

  afterEach(() => {
    handle.close();
  });

  const ask = (body: string) => postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, kind: "question", body });

  it("lists an agent's question nobody has answered", () => {
    const question = ask("Which bucket should anonymous callers share?");

    expect(unansweredQuestions(handle.db, item.id)).toEqual([question.id]);
  });

  it("stops listing it once a human replies to that question", () => {
    const question = ask("Which bucket?");
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Per API key.", parentId: question.id });

    expect(unansweredQuestions(handle.db, item.id)).toEqual([]);
  });

  it("does not treat a reply from another agent as an answer", () => {
    // The guard that was unpinned. Agents reply to each other's questions
    // routinely; if that counted, a question meant for a person would
    // close itself and the run would carry on without the answer.
    const question = ask("Which bucket?");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: reviewer.id }, body: "I would say per key.", parentId: question.id });

    expect(unansweredQuestions(handle.db, item.id)).toEqual([question.id]);
  });

  it("does not treat a top-level human comment as an answer to anything", () => {
    // The other half. A human comment with no parent is a remark on the
    // item, not a reply — counting it would close every open question
    // at once, which is the bug this function was written to remove.
    const question = ask("Which bucket?");
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Bumping this." });

    expect(unansweredQuestions(handle.db, item.id)).toEqual([question.id]);
  });

  it("answers one question without closing the others", () => {
    const first = ask("Which bucket?");
    const second = ask("What should the window be?");
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Per API key.", parentId: first.id });

    expect(unansweredQuestions(handle.db, item.id)).toEqual([second.id]);
  });

  it("ignores comments that are not questions", () => {
    ask("Which bucket?");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, kind: "note", body: "Starting on this." });

    expect(unansweredQuestions(handle.db, item.id)).toHaveLength(1);
  });
});
