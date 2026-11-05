import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item, Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createAgent, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { answerToLastAsk, answersInThread, answersSinceLastAsk, newestAnswerToLastAsk } from "./answers.js";

/**
 * One reader for what a parked step may treat as an answer (EO-183).
 *
 * The rules are `recordedStackAnswer`'s and were proved there first —
 * `workspace/stackAnswer.test.ts` still holds them against the caller
 * that has always applied them. What is proved here is the reader
 * itself, including the clause no caller can exercise yet: a system
 * agent's reading of a free-text reply counts as an answer, so the
 * agent EO-180 introduces is not invisible to every step waiting on one.
 */

let handle: DbHandle;
let item: Item;

function ask(options?: string[]): Uuid {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body: "CI failed on this branch. What should happen?",
    ...(options ? { options } : {}),
    mentions: [{ type: "human" }],
  }).id;
}

function reply(body: string): Uuid {
  return postComment(handle.db, { itemId: item.id, author: { type: "human" }, body }).id;
}

function systemAgent(): Agent {
  return createAgent(handle.db, { name: "EO", role: "system", provider: "claude", instructions: "" });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
});

afterEach(() => {
  handle.close();
});

describe("answersSinceLastAsk", () => {
  it("finds nothing where nothing has been asked", () => {
    reply("Merge anyway");

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  it("finds what a person said after the question", () => {
    ask(["Merge anyway", "Send it back"]);
    reply("Send it back");

    expect(answersSinceLastAsk(handle.db, item.id).map((comment) => comment.body)).toEqual(["Send it back"]);
  });

  it("leaves behind what was said before the question", () => {
    // Nobody was answering: there was no question yet, and reading it as
    // this question's answer is EO putting words in somebody's mouth.
    reply("do whichever you prefer");
    ask();

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  it("starts again at the newest question", () => {
    ask();
    reply("Send it back");
    ask();

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  it("ignores a comment that arrived from Jira", () => {
    // The same rule that stops a pulled comment closing a mention: nobody
    // answered EO — a sync found somebody talking in Jira.
    ask();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Send it back", jiraCommentId: "10001" });

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  it("ignores what the engine said after asking", () => {
    ask();
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Send it back" });

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  /**
   * The clause nothing writes yet (EO-180).
   *
   * A system agent's comment counts when it is filed under a reply that
   * counts — that is what makes it a reading of what somebody said,
   * rather than an agent volunteering an answer to a question it was not
   * asked.
   */
  it("counts a system agent's reading of a reply it is filed under", () => {
    const agent = systemAgent();
    ask(["Merge anyway", "Send it back"]);
    const said = reply("send it back to the author please");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: agent.id }, parentId: said, body: "Send it back" });

    expect(answersSinceLastAsk(handle.db, item.id).map((comment) => comment.body)).toEqual(["send it back to the author please", "Send it back"]);
  });

  it("ignores a system agent's comment that answers nothing", () => {
    const agent = systemAgent();
    ask();
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: agent.id }, body: "Send it back" });

    expect(answersSinceLastAsk(handle.db, item.id)).toEqual([]);
  });

  it("ignores another role's comment filed under a reply", () => {
    // Every agent EO dispatches can comment on an item it is working;
    // one of them landing under a person's reply is not somebody
    // answering, and reading it as one would let an implementer answer
    // the question it is parked on.
    const implementer = createAgent(handle.db, { name: "Implementer", role: "implementer", provider: "claude", instructions: "" });
    ask();
    const said = reply("no idea, ask Priya");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: implementer.id }, parentId: said, body: "Send it back" });

    expect(answersSinceLastAsk(handle.db, item.id).map((comment) => comment.body)).toEqual(["no idea, ask Priya"]);
  });
});

describe("answersInThread", () => {
  /**
   * The variant `recordedStackAnswer` reads, and the difference is the
   * whole reason it is a second function: a reply that names one of the
   * tied dependencies is an answer to *that* question whenever it was
   * written, and a later guard escalating about something else must not
   * erase a decision somebody already made.
   */
  it("keeps a reply from before the newest question", () => {
    ask();
    reply("EO-2");
    ask();
    reply("committed them, go ahead");

    expect(answersInThread(handle.db, item.id).map((comment) => comment.body)).toEqual(["EO-2", "committed them, go ahead"]);
  });

  it("still refuses what came from Jira", () => {
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "EO-2", jiraCommentId: "10001" });

    expect(answersInThread(handle.db, item.id)).toEqual([]);
  });
});

describe("answerToLastAsk", () => {
  it("is null where nothing has been asked", () => {
    reply("Merge anyway");

    expect(answerToLastAsk(handle.db, item.id)).toBeNull();
  });

  it("is null where the question is unanswered", () => {
    ask(["Merge anyway", "Send it back"]);

    expect(answerToLastAsk(handle.db, item.id)).toBeNull();
  });

  it("carries the newest answer and what the question offered", () => {
    ask(["Merge anyway", "Send it back"]);
    reply("Merge anyway");
    reply("Send it back");

    expect(answerToLastAsk(handle.db, item.id)).toEqual({
      text: "Send it back",
      offered: ["Merge anyway", "Send it back"],
      matched: "Send it back",
    });
  });

  /**
   * A clicked button arrives as prose a person finished typing.
   *
   * The same unwrapping `readStackAnswer` applies, which is why it is
   * exported from the engine rather than written out twice: an option
   * that matched on one side and not the other is an answered question
   * that looks unread.
   */
  it("matches through the wrapping and casing a person types", () => {
    ask(["Merge anyway", "Send it back"]);
    reply("`send it back.`");

    expect(answerToLastAsk(handle.db, item.id)).toMatchObject({ matched: "Send it back" });
  });

  it("hands back the offered label rather than what was typed", () => {
    // The module compares this with its own constant, so it has to be the
    // module's own spelling of the option and not the person's.
    ask(["Merge anyway"]);
    reply("MERGE ANYWAY");

    expect(answerToLastAsk(handle.db, item.id)).toMatchObject({ text: "MERGE ANYWAY", matched: "Merge anyway" });
  });

  it("matches nothing when somebody answers in their own words", () => {
    ask(["Merge anyway", "Send it back"]);
    reply("hold it until Priya is back");

    expect(answerToLastAsk(handle.db, item.id)).toEqual({
      text: "hold it until Priya is back",
      offered: ["Merge anyway", "Send it back"],
      matched: null,
    });
  });

  it("offers nothing where the question offered nothing", () => {
    ask();
    reply("go ahead");

    expect(answerToLastAsk(handle.db, item.id)).toEqual({ text: "go ahead", offered: [], matched: null });
  });
});

/**
 * The same answer, with the comment it was read out of (EO-184).
 *
 * Split out because the interpreter needs two things `StepAnswer` cannot
 * say: who wrote the newest answer — a system agent's own reading must
 * not be handed back to it — and which row it is, since one reply is
 * read once and the id is what remembers that.
 */
describe("newestAnswerToLastAsk", () => {
  it("carries the comment the answer was read out of", () => {
    ask(["Merge anyway", "Send it back"]);
    const said = reply("hold it until Priya is back");

    expect(newestAnswerToLastAsk(handle.db, item.id)).toMatchObject({
      comment: { id: said, authorType: "human" },
      matched: null,
    });
  });

  it("names the system agent when its reading is the newest answer", () => {
    const agent = systemAgent();
    ask(["Merge anyway", "Send it back"]);
    const said = reply("hold it until Priya is back");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: agent.id }, parentId: said, kind: "decision", body: "Send it back" });

    // Which is what stops an interpretation being interpreted: the newest
    // answer is now an agent's, and only a person's reply is handed on.
    expect(newestAnswerToLastAsk(handle.db, item.id)).toMatchObject({
      comment: { authorType: "agent", authorId: agent.id },
      matched: "Send it back",
    });
  });

  it("agrees with answerToLastAsk about everything else", () => {
    ask(["Merge anyway"]);
    reply("MERGE ANYWAY");

    const newest = newestAnswerToLastAsk(handle.db, item.id);
    expect(answerToLastAsk(handle.db, item.id)).toEqual({ text: newest?.text, offered: newest?.offered, matched: newest?.matched });
  });
});
