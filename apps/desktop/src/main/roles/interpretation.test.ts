import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERPRET_ACTION, type Agent, type Comment, type Run, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createRun, getItem, listAgents, listCommentsForItem, listMentionsForComment, postComment, updateAgent, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { awaitsTheStep, interpretationsOn, pendingInterpretation, postInterpretation } from "./interpretation.js";

/**
 * Which replies reach the system agent, and what it leaves behind
 * (EO-184).
 *
 * The supervisor's own test (`supervisor/interpretReply.test.ts`) drives
 * the loop end to end. What is here is the two decisions that loop rests
 * on, in isolation: whether a reply is a sentence somebody typed or a
 * button they pressed, and which of the three answers the agent can give
 * hands the item back to the step.
 */

let handle: DbHandle;
let item: Item;
/** The parked builtin run: EO acting, so no agent (see `CreateRunInput.agentId`). */
let parked: Run;

function systemAgent(): Agent {
  const agent = listAgents(handle.db).find((candidate) => candidate.role === "system");
  if (!agent) throw new Error("the seeded install has no system agent");
  return agent;
}

function ask(options?: string[]): Uuid {
  return postComment(handle.db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body: "EO-2 and EO-3 are tied. Which should this stack on?",
    ...(options ? { options } : {}),
    mentions: [{ type: "human" }],
  }).id;
}

function reply(body: string): Comment {
  return postComment(handle.db, { itemId: item.id, author: { type: "human" }, body });
}

function decide(enabled = true) {
  return pendingInterpretation(handle.db, getItem(handle.db, item.id)!, parked, enabled);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  // `worktree` is the seeded pipeline's entry step, and a builtin.
  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree" });
  parked = createRun(handle.db, { itemId: item.id, agentId: null, action: "create_worktree", status: "awaiting_input", provider: "builtin" });
});

afterEach(() => {
  handle.close();
});

describe("deciding whether a reply is for the system agent", () => {
  it("hands over a sentence nobody could match", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");

    expect(decide()).toEqual({ commentId: said.id, agentId: systemAgent().id });
  });

  it("hands over a reply to a question that offered nothing", () => {
    // The worktree that could not be cut is the case: it reports a fact
    // rather than asking between two answers, so there is nothing to
    // press and a sentence is the only reply possible.
    ask();
    const said = reply("the base repo is dirty because of my own work — stash it and carry on");

    expect(decide()).toMatchObject({ commentId: said.id });
  });

  it("leaves a button press to the step", () => {
    ask(["EO-2", "EO-3"]);
    reply("EO-3.");

    expect(decide()).toBeNull();
  });

  it("does not read its own reading back", () => {
    const agent = systemAgent();
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: agent.id }, parentId: said.id, kind: "decision", body: "not one of them" });

    // The newest answer is now the agent's, and only what a person wrote
    // is ever handed on — otherwise an unusable reading would be read
    // again, and again.
    expect(decide()).toBeNull();
  });

  it("interprets one reply once, whatever became of the interpretation", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");
    const run = createRun(handle.db, { itemId: item.id, agentId: systemAgent().id, action: INTERPRET_ACTION, initiationId: said.id });
    updateRun(handle.db, run.id, { status: "failed", endedAt: Date.now() });

    // Even a failed one. The step asks again and waits for a person,
    // which is what it did before this feature existed — paying for a
    // second opinion on the same sentence is the loop this prevents.
    expect(decide()).toBeNull();
  });

  it("stays out of it when the switch is off", () => {
    ask(["EO-2", "EO-3"]);
    reply("go with whichever one the rate limiter lives in");

    expect(decide(false)).toBeNull();
  });

  it("stays out of it when the parked run has an agent of its own", () => {
    ask(["EO-2", "EO-3"]);
    reply("go with whichever one the rate limiter lives in");
    const agentRun = createRun(handle.db, { itemId: item.id, agentId: systemAgent().id, action: "implement", status: "awaiting_input" });

    // An agent that parked has a thread, and a reply to it resumes that
    // conversation. Nothing here is for the interpreter.
    expect(pendingInterpretation(handle.db, getItem(handle.db, item.id)!, agentRun, true)).toBeNull();
  });

  it("stays out of it when there is no system agent to ask", () => {
    for (const agent of listAgents(handle.db).filter((candidate) => candidate.role === "system")) {
      updateAgent(handle.db, agent.id, { enabled: false });
    }
    ask(["EO-2", "EO-3"]);
    reply("go with whichever one the rate limiter lives in");

    // Nothing is dropped: the reply takes the path it took before this
    // existed, which is the step running again and asking again.
    expect(decide()).toBeNull();
  });
});

describe("what an interpretation leaves in the thread", () => {
  function interpretRun(): Run {
    const said = listCommentsForItem(handle.db, item.id).at(-1)!;
    return createRun(handle.db, { itemId: item.id, agentId: systemAgent().id, action: INTERPRET_ACTION, initiationId: said.id });
  }

  it("files an answer under the person's own comment, verbatim", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");
    const run = interpretRun();

    postInterpretation(handle.db, item, systemAgent().id, run.id, { status: "answered", answer: "EO-3", note: "The limiter lives in EO-3." });

    const posted = listCommentsForItem(handle.db, item.id);
    const decision = posted.find((comment) => comment.kind === "decision");
    // Verbatim, and nothing else in the body: a step matches this
    // against what it offered, and a sentence wrapped round the answer
    // is what would make that match fail.
    expect(decision).toMatchObject({ parentId: said.id, body: "EO-3", authorType: "agent" });
    // The reasoning goes under the answer rather than beside it — filed
    // under the reply it would be a second, newer "answer", and newest
    // wins.
    expect(posted.at(-1)).toMatchObject({ parentId: decision?.id, kind: "note", body: "The limiter lives in EO-3." });
  });

  it("says what it did instead, without that reading as an answer", () => {
    ask();
    reply("that branch is stale, delete it and try again");
    const run = interpretRun();

    postInterpretation(handle.db, item, systemAgent().id, run.id, { status: "acted", summary: "Deleted the stale branch.", retry: true });

    const note = listCommentsForItem(handle.db, item.id).at(-1);
    expect(note).toMatchObject({ kind: "note", parentId: null });
    expect(note?.body).toContain("Deleted the stale branch.");
    // The step is named, because "running it again" means nothing
    // without saying what.
    expect(note?.body).toContain("Worktree");
  });

  it("asks the person again rather than dropping a reply it cannot use", () => {
    ask(["EO-2", "EO-3"]);
    reply("ask Priya, she owns that repo");
    const run = interpretRun();

    postInterpretation(handle.db, item, systemAgent().id, run.id, { status: "unusable", problem: "it names a person rather than one of the two dependencies" });

    const escalation = listCommentsForItem(handle.db, item.id).at(-1);
    expect(escalation).toMatchObject({ kind: "escalation", authorType: "agent" });
    expect(escalation?.body).toContain("it names a person rather than one of the two dependencies");
  });

  /**
   * Nothing the model writes may open a mention.
   *
   * A mention is the scheduler's second entry point, so an open one is a
   * dispatch: an interpretation that said "I asked @implementer to look"
   * would start an unrelated `respond` run — on an item it may have
   * just decided to leave parked. Every string posted from here is the
   * model's, so every one of them is posted with body parsing off.
   */
  it.each([
    ["answered", { status: "answered", answer: "EO-3", note: "Confirmed with @implementer first." }],
    ["acted", { status: "acted", summary: "Asked @implementer to rebase, then deleted the branch.", retry: false }],
    ["unusable", { status: "unusable", problem: "it names @implementer rather than one of the dependencies" }],
  ])("opens no mention out of the %s text it wrote", (_status, result) => {
    ask(["EO-2", "EO-3"]);
    reply("whatever you think, ask around");
    const run = interpretRun();

    postInterpretation(handle.db, item, systemAgent().id, run.id, result);

    const mine = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "agent");
    expect(mine.length).toBeGreaterThan(0);
    const opened = mine.flatMap((comment) => listMentionsForComment(handle.db, comment.id));
    // The implementer is never addressed, whatever the sentence says.
    expect(opened.filter((mention) => mention.targetType === "agent")).toEqual([]);
    // And the one mention EO does intend survives, because it is passed
    // beside the body rather than parsed out of it.
    const humanMentions = opened.filter((mention) => mention.targetType === "human");
    expect(humanMentions).toHaveLength(_status === "unusable" ? 1 : 0);
  });

  it("says so rather than staying silent when the result is unreadable", () => {
    ask(["EO-2", "EO-3"]);
    reply("go with whichever one the rate limiter lives in");
    const run = interpretRun();

    postInterpretation(handle.db, item, systemAgent().id, run.id, { status: "invented" });

    expect(listCommentsForItem(handle.db, item.id).at(-1)).toMatchObject({ kind: "escalation" });
  });
});

describe("whether the step is owed the reply", () => {
  function interpretation(commentId: Uuid, result: unknown, status: "succeeded" | "failed" = "succeeded"): Run {
    const run = createRun(handle.db, { itemId: item.id, agentId: systemAgent().id, action: INTERPRET_ACTION, initiationId: commentId });
    return updateRun(handle.db, run.id, { status, result: { parsed: result, raw: result }, endedAt: Date.now() });
  }

  it("takes a read reply off the step's hands, and hands its answer over instead", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");
    const run = interpretation(said.id, { status: "answered", answer: "EO-3" });
    const decision = postComment(handle.db, {
      itemId: item.id,
      runId: run.id,
      author: { type: "agent", agentId: systemAgent().id },
      parentId: said.id,
      kind: "decision",
      body: "EO-3",
    });

    const state = interpretationsOn(handle.db, item.id);
    expect(awaitsTheStep(said, state, null)).toBe(false);
    expect(awaitsTheStep(decision, state, null)).toBe(true);
  });

  it("keeps the item parked where the interpretation asked for no retry", () => {
    ask();
    const said = reply("this does not need a worktree at all");
    const run = interpretation(said.id, { status: "acted", summary: "Moved it myself.", retry: false });
    const note = postComment(handle.db, { itemId: item.id, runId: run.id, author: { type: "agent", agentId: systemAgent().id }, kind: "note", body: "Moved it myself." });

    const state = interpretationsOn(handle.db, item.id);
    expect(awaitsTheStep(said, state, null)).toBe(false);
    expect(awaitsTheStep(note, state, null)).toBe(false);
  });

  it("hands the reply back to the step when the interpretation decided nothing", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");
    interpretation(said.id, { status: "answered", answer: "EO-3" }, "failed");

    // A failed run read nothing, so the behaviour is the one that
    // existed before any of this: the step runs again and asks again.
    expect(awaitsTheStep(said, interpretationsOn(handle.db, item.id), null)).toBe(true);
  });

  it("holds the reply while an interpretation of it is still pending", () => {
    ask(["EO-2", "EO-3"]);
    const said = reply("go with whichever one the rate limiter lives in");

    // Nothing has run yet, and the step must not be handed the reply in
    // the meantime — that would be running the very thing the
    // interpretation was dispatched instead of.
    expect(awaitsTheStep(said, interpretationsOn(handle.db, item.id), decide())).toBe(false);
  });
});
