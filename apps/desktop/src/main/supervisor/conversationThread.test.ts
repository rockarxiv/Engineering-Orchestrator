import { INTERPRET_ACTION, type Agent, type AgentEvent, type AgentProvider, type Item, type UsageEvent, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  postComment,
  setItemArchived,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { answerToLastAsk } from "../roles/answers.js";
import { openAssistConversation } from "../roles/assist.js";
import { promptHash } from "../roles/prompts.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * A conversation is one provider thread, and everything else is not
 * (EO-210).
 *
 * `THREAD_REUSE_BY_ROLE` said `system: false`, so every message in a
 * conversation opened a brand new provider thread and EO re-assembled the
 * whole history into the prompt to fake the continuity — a cost that
 * grows with the square of a conversation's length. A conversation room
 * is one item holding one chat, so thread-per-item and
 * thread-per-conversation are the same thing there.
 *
 * The part that would otherwise have shipped as a bug is the other two
 * actions the same agent serves. `interpret` and `respond` run against
 * *work* items, where a thread keyed on the item would pool
 * unrelated dispatches into one conversation. So these assert both
 * halves at the dispatch boundary: which provider method was called, and
 * with which thread.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/conversations";

/** What a provider was actually asked to do, in order. */
interface Turn {
  kind: "start" | "resume";
  threadId: string;
  /** The context for a start, the message for a resume — either way, what the model reads. */
  prompt: string;
}

let handle: DbHandle;
let systemAgent: Agent;
let turns: Turn[];

beforeEach(() => {
  handle = openMigratedTestDb();
  systemAgent = listAgents(handle.db).find((agent) => agent.role === "system")!;
  turns = [];
  usageReadings = [];
  malformNextResult = false;
});

afterEach(() => {
  handle.close();
});

/**
 * What the model says back, by the action it was asked for.
 *
 * `{ message }` satisfies `assist` and `respond` alike — every other field of those schemas defaults — so the
 * only branch worth writing is the interpreter's, whose answer is a
 * discriminated union. `unusable` is deliberate: it leaves the item
 * parked, which is what lets a second reply ask for a second reading.
 */
function resultFor(prompt: string): unknown {
  if (prompt.includes(`"${INTERPRET_ACTION}" action`)) {
    return { status: "unusable", problem: "That could be either of them." };
  }
  if (prompt.includes('"implement" action')) return validImplementResult;
  return { message: "Noted." };
}

/**
 * What each provider stream reports it consumed, in the shape the Claude
 * adapter produces.
 *
 * Session-scoped and *cumulative*: `usageOf` reads `modelUsage`, which
 * the SDK re-reports as a running total for the whole query on every
 * result message, summed across every model turn and every subagent.
 * `UsageTally` therefore takes the largest reading of a stream rather
 * than adding them up — which is exactly the behaviour these tests exist
 * to pin, because it is the number the spend notice is built on.
 *
 * Empty by default, so every test that is not about usage records none.
 */
let usageReadings: Omit<UsageEvent, "type">[] = [];

/** Set once to make the next stream's result fail its schema, forcing a corrective resume on the same run. */
let malformNextResult = false;

/** Records which provider method each dispatch called, and what it sent. */
function recordingProvider(): AgentProvider {
  let counter = 0;

  function* answer(prompt: string): Generator<AgentEvent> {
    for (const reading of usageReadings) yield { type: "usage", ...reading };
    if (malformNextResult) {
      malformNextResult = false;
      yield { type: "result", data: { thisFieldDoesNotExist: true } };
      return;
    }
    yield { type: "result", data: resultFor(prompt) };
  }

  return {
    async *start(opts): AsyncIterable<AgentEvent> {
      counter += 1;
      const threadId = `thread-${counter}`;
      turns.push({ kind: "start", threadId, prompt: opts.context });
      yield { type: "thread_started", threadId };
      yield* answer(opts.context);
    },
    async *resume(threadId, message): AsyncIterable<AgentEvent> {
      turns.push({ kind: "resume", threadId, prompt: message });
      yield* answer(message);
    },
  };
}

/** Claude's shape: one query's running total, re-reported as it grows. */
function claudeQuery(billed: number, modelTurns: number): Omit<UsageEvent, "type">[] {
  return [1, 2, 3].map((step) => ({
    scope: "session" as const,
    tokensIn: Math.round((billed / 3) * step),
    tokensOut: 200 * step,
    turns: Math.round((modelTurns / 3) * step),
  }));
}

function supervisor(overrides: Record<string, unknown> = {}) {
  return createRunSupervisor({
    db: handle.db,
    provider: recordingProvider(),
    ...createRoleWiring(handle.db),
    kinds: kindsPreparing(CWD),
    limits: LIMITS,
    ...overrides,
  });
}

/** What sending a chat message does: a human comment mentioning the agent. */
function say(conversation: Item, body: string) {
  return postComment(handle.db, {
    itemId: conversation.id,
    author: { type: "human" },
    body,
    mentions: [{ type: "agent", agentId: systemAgent.id }],
  });
}

const engineNotes = (itemId: Uuid): string[] =>
  listCommentsForItem(handle.db, itemId)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

/**
 * The rooms, each opened the way its own screen opens it. One since
 * EO-526 removed Discussions and the Architecture panel; a list still, so
 * a room added later is held to the same promise by adding a line.
 */
const ROOMS: { name: string; action: string; open: (db: DbHandle["db"]) => Item }[] = [
  { name: "the assistant", action: "assist", open: (db) => openAssistConversation(db, null) },
];

describe("a conversation is one provider thread", () => {
  it.each(ROOMS)("resumes the thread the first message opened, in $name", async ({ open }) => {
    const conversation = open(handle.db);
    const engine = supervisor();

    say(conversation, "How should we bill this?");
    await engine.runOnce();

    say(conversation, "And what about the free tier?");
    await engine.runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start", "resume"]);
    expect(turns[1]?.threadId).toBe(turns[0]?.threadId);
  });

  it.each(ROOMS)("stops re-sending the thread on turn two, in $name", async ({ open, action }) => {
    const conversation = open(handle.db);
    const engine = supervisor();

    say(conversation, "Rate limiting should be per API key.");
    await engine.runOnce();

    say(conversation, "And the free tier?");
    await engine.runOnce();

    const second = turns[1]?.prompt ?? "";
    // The whole saving, stated as a test: turn one's message is in the
    // conversation the provider is holding, so sending it again is the
    // quadratic cost this exists to remove.
    expect(second).not.toContain("Rate limiting should be per API key.");
    // What it *does* carry is what the thread cannot have: the action
    // being asked for now, and what has been said since.
    expect(second).toContain(`perform the "${action}" action`);
    expect(second).toContain("And the free tier?");
    // Nor its own last reply, which it wrote.
    expect(second).not.toContain("Noted.");
  });

  it("still tells an assist turn where the person is, every turn", async () => {
    // EO-192's thesis, and the reason a persistent thread is not simply
    // "send less": a `view_current` answer from ten minutes ago describes
    // a screen they have left. The pointer is re-sent; the history is not.
    const conversation = openAssistConversation(handle.db, null);
    const engine = supervisor();

    say(conversation, "What is this step for?");
    await engine.runOnce();
    say(conversation, "And this one?");
    await engine.runOnce();

    expect(turns[1]?.prompt).toContain("## The screen");
    expect(turns[1]?.prompt).toContain("read *this turn*");
  });

  it("ends the thread when the agent's instructions are edited, and says so in the chat", async () => {
    // The cost of a persistent thread, made executable: a provider
    // session keeps the instructions it was started with, so an edit
    // reaches a new thread rather than the next message of the old one.
    // EO refuses the stale thread rather than carrying it, which is what
    // stops the edit being silently ignored for the rest of the chat —
    // and `system-agent.md` says so where somebody editing that prompt
    // will read it.
    const conversation = openAssistConversation(handle.db, null);
    const engine = supervisor();

    say(conversation, "About billing.");
    await engine.runOnce();

    updateAgent(handle.db, systemAgent.id, { instructions: `${systemAgent.instructions}\n\nAlways ask about pricing.` });

    say(conversation, "And the free tier?");
    await engine.runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start", "start"]);
    expect(turns[1]?.threadId).not.toBe(turns[0]?.threadId);
    expect(engineNotes(conversation.id).join("\n")).toContain("instructions have changed since its last run");
    // And the fresh thread is given the whole conversation back, so
    // nothing said before the edit is lost.
    expect(turns[1]?.prompt).toContain("About billing.");
  });

  it("ends where Clear ends it, with no special case", async () => {
    // Clear archives the conversation's item, so the next message is a
    // new item — and a thread is keyed on the item. Nothing else has
    // to know that a conversation can end.
    const first = openAssistConversation(handle.db, null);
    const engine = supervisor();

    say(first, "About billing.");
    await engine.runOnce();

    setItemArchived(handle.db, first.id, Date.now());
    const second = openAssistConversation(handle.db, null);
    say(second, "Something else entirely.");
    await engine.runOnce();

    expect(turns.map((turn) => turn.kind)).toEqual(["start", "start"]);
    expect(turns[1]?.threadId).not.toBe(turns[0]?.threadId);
    // And the new thread gets the whole context, because it has none.
    expect(turns[1]?.prompt).toContain("Something else entirely.");
  });
});

/**
 * The same agent, dispatched against a real work item (EO-210).
 *
 * `interpret` reads one reply to a step that parked, one decision at a
 * time, and `respond` answers one @-mention. Neither is a chat, and the
 * item they run on is somebody's work — so a thread keyed on it would
 * accumulate unrelated dispatches in one conversation, which is exactly
 * what EO-178's "each dispatch is a separate question" was written
 * about.
 */
describe("the system agent's other two actions, which are not conversations", () => {
  /** A builtin that stops and asks, so a free-text reply has something to be a reply to. */
  function askingStep() {
    return vi.fn<BuiltinRunner>(async ({ db, item: current }) => {
      const answer = answerToLastAsk(db, current.id);
      if (answer?.matched != null) return { ok: true, result: "ready", detail: `cut from ${answer.matched}` };
      return { ok: false, reason: "EO-2 and EO-3 are tied. Which should this stack on?", options: ["EO-2", "EO-3"] };
    });
  }

  it("starts a fresh thread for every interpretation of the same work item", async () => {
    const work = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "worktree" });
    const engine = supervisor({ builtins: { create_worktree: askingStep() } });

    // The step asks.
    await engine.runOnce();

    // Two sentences, each unreadable, so the item stays parked and
    // each is read on its own.
    for (const said of ["whichever one the rate limiter lives in", "actually, use the other one"]) {
      const asked = listCommentsForItem(handle.db, work.id).at(-1);
      postComment(handle.db, { itemId: work.id, author: { type: "human" }, parentId: asked?.id ?? null, body: said });
      await engine.runOnce();
    }

    const interpretations = listRunsForItem(handle.db, work.id).filter((run) => run.action === INTERPRET_ACTION);
    expect(interpretations).toHaveLength(2);
    // Two readings, two threads. The item is the same one; that is the
    // whole point — reuse is keyed on the action as well.
    expect(new Set(interpretations.map((run) => run.threadId)).size).toBe(2);
    expect(turns.every((turn) => turn.kind === "start")).toBe(true);
  });

  it("starts a fresh thread for every mention it answers on a work item", async () => {
    const work = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "ready_to_merge" });
    const engine = supervisor();

    for (const question of ["@system what did we decide about keys?", "@system and about the free tier?"]) {
      postComment(handle.db, {
        itemId: work.id,
        author: { type: "human" },
        body: question,
        mentions: [{ type: "agent", agentId: systemAgent.id }],
      });
      await engine.runOnce();
    }

    const responses = listRunsForItem(handle.db, work.id).filter((run) => run.action === "respond");
    expect(responses).toHaveLength(2);
    expect(turns.map((turn) => turn.kind)).toEqual(["start", "start"]);
    expect(new Set(responses.map((run) => run.threadId)).size).toBe(2);
    // And each was given the whole thread, because none of it is in a
    // conversation the provider is holding.
    expect(turns[1]?.prompt).toContain("what did we decide about keys?");
  });
});

/**
 * What a reused thread costs, and what EO no longer says about it.
 *
 * EO-210 posted an engine note once a reused thread had been billed
 * more than a million input tokens. EO-744 removed it at the person's
 * request: nobody wants it in a chat or on an item. What stays is the
 * accounting — `runs.tokensIn` is still EO's record of what each run was
 * billed — so these pin that, and that a thread past a million tokens
 * is carried on without a word about its spend.
 */
describe("a conversation whose thread has been billed a lot", () => {
  const conversation = () => openAssistConversation(handle.db, null);

  /** Runs one turn of a chat, with whatever usage the test has scripted. */
  async function turn(chat: Item, message: string) {
    say(chat, message);
    await supervisor().runOnce();
    return listRunsForItem(handle.db, chat.id).at(-1)!;
  }

  /** The removed note was the only engine comment to speak of billed input tokens. */
  const spendNotes = (itemId: Uuid) => engineNotes(itemId).filter((body) => /input tokens/i.test(body));

  it("keeps Claude's running total rather than summing its re-reports", async () => {
    // One query, twelve model turns, re-reported three times as it grew:
    // the run's figure is the last reading, not the sum of them.
    const chat = conversation();
    usageReadings = claudeQuery(240_000, 12);

    const first = await turn(chat, "About billing.");

    expect(first.tokensIn).toBe(240_000);
    expect(first.turnsScope).toBe("session");
  });

  it("adds up the streams of one run, so a corrective turn is not lost", async () => {
    // A re-prompt after a failed validation opens a second provider
    // stream on the same run, and the SDK starts a resumed query's
    // running total again from zero — so these two genuinely add, where
    // the readings inside one stream do not. One run, one spend.
    const chat = conversation();
    usageReadings = claudeQuery(240_000, 12);
    malformNextResult = true;

    const first = await turn(chat, "About billing.");

    expect(turns.map((entry) => entry.kind)).toEqual(["start", "resume"]); // the corrective turn
    expect(first.tokensIn).toBe(480_000);
  });

  it("posts no spend note in a chat whose thread has been billed past a million", async () => {
    const chat = conversation();
    usageReadings = claudeQuery(300_000, 9);

    // Four turns billed 300k each: the fifth dispatch resumes a thread
    // already billed 1.2M, and the turns after it more again.
    for (const message of ["One.", "Two.", "Three.", "Four.", "Five.", "Six."]) await turn(chat, message);

    const runs = listRunsForItem(handle.db, chat.id);
    expect(runs.slice(0, 4).reduce((total, run) => total + (run.tokensIn ?? 0), 0)).toBeGreaterThan(1_000_000);
    expect(turns.map((entry) => entry.kind)).toEqual(["start", "resume", "resume", "resume", "resume", "resume"]);
    expect(spendNotes(chat.id)).toEqual([]);
    expect(engineNotes(chat.id)).toEqual([]);
  });

  it("posts no spend note on a work item whose implementer resumes a thread billed past a million", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const work = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });
    const prior = createRun(handle.db, {
      itemId: work.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: "thread-earlier",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
    });
    updateRun(handle.db, prior.id, { startedAt: 1_000, endedAt: 1_000, tokensIn: 1_000_001 });

    await supervisor().runOnce();

    expect(turns.map((entry) => entry.kind)).toEqual(["resume"]);
    expect(turns[0]?.threadId).toBe("thread-earlier");
    expect(spendNotes(work.id)).toEqual([]);
  });
});
