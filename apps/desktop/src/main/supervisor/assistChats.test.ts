import type { Agent, AgentEvent, AgentProvider, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, listCommentsForItem, listRunsForItem, postComment } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { newAssist, openAssist, resumeAssist } from "../ipc/assistCommands.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { postAssistReply } from "../roles/assist.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * Two assistant chats, each with a turn of its own (EO-391).
 *
 * The question the story asked before anything was built: how are assist
 * turns counted against invariant #10? They are not. A conversation turn
 * is a mention-driven dispatch (`manualDispatch.ts`), which has never
 * gone through `tick()`'s capacity accounting — "which is what keeps a
 * chat reply out of the capacity accounting, and so out from behind
 * whatever the implementer is doing". The one thing that holds a turn
 * back is a run already active *on the same item*. So an assist turn and
 * an architect turn could always run at the same moment, and two chats
 * are two items in exactly that position: nothing about the cap changes.
 *
 * These prove it against the supervisor itself, with the global cap at 1
 * so that it is plainly not the cap letting the second turn through — and
 * prove the half the person hit as cost: a new chat is a new provider
 * session, and nothing said in the other one is resumed into it.
 */

/** Invariant #10's own numbers. */
const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

let handle: DbHandle;
let systemAgent: Agent;

/** What the provider was asked for, in order: a fresh session, or one resumed by id. */
let calls: { kind: "start" | "resume"; threadId: string }[];
/** Turns that wait to be let go, so one can still be running while another starts. */
let held: Map<string, () => void>;
let holdNext: boolean;

beforeEach(() => {
  handle = openMigratedTestDb();
  systemAgent = listAgents(handle.db).find((agent) => agent.role === "system")!;
  calls = [];
  held = new Map();
  holdNext = false;
});

afterEach(() => {
  for (const release of held.values()) release();
  handle.close();
});

function provider(): AgentProvider {
  let sessions = 0;
  async function* turn(kind: "start" | "resume", threadId: string): AsyncIterable<AgentEvent> {
    calls.push({ kind, threadId });
    yield { type: "thread_started", threadId };
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => held.set(threadId, resolve));
    }
    yield { type: "result", data: { message: `Answered on ${threadId}.`, questions: [], proposals: [] } };
  }
  return {
    start: () => turn("start", `session-${(sessions += 1)}`),
    resume: (threadId) => turn("resume", threadId),
  };
}

function supervisor() {
  return createRunSupervisor({
    db: handle.db,
    provider: provider(),
    kinds: kindsPreparing("/tmp/eo/assist-chats"),
    limits: LIMITS,
    onRunSucceeded: (item: Item, agent: Agent, action: string, parsedResult: unknown, runId: Uuid): void => {
      if (action === ASSIST_ACTION) postAssistReply(handle.db, item, agent.id, runId, parsedResult);
    },
  });
}

/** What sending a message does: a human comment mentioning the agent. */
function say(conversationId: string, body: string): void {
  postComment(handle.db, { itemId: conversationId as Uuid, author: { type: "human" }, body, mentions: [{ type: "agent", agentId: systemAgent.id }] });
}

function bodies(conversationId: string): string[] {
  return listCommentsForItem(handle.db, conversationId as Uuid).map((comment) => comment.body);
}

function runsOf(conversationId: string) {
  return listRunsForItem(handle.db, conversationId as Uuid).filter((run) => run.action === ASSIST_ACTION);
}

describe("two assistant chats", () => {
  it("answers a message in a new chat while the other chat's turn is still running, and stops neither", async () => {
    const engine = supervisor();
    const a = openAssist(handle.db).conversation;
    say(a.id, "Rework the release pipeline.");

    // A's turn starts and does not finish.
    holdNext = true;
    const first = engine.runOnce();
    await vi.waitFor(() => expect(held.size).toBe(1));
    expect(runsOf(a.id).map((run) => run.status)).toEqual(["running"]);

    // New chat, and a quick question in it.
    const b = newAssist(handle.db).conversation;
    expect(b.id).not.toBe(a.id);
    say(b.id, "What does Hold do?");
    const second = engine.runOnce();

    // B is answered in B while A is still thinking: it did not wait, so
    // there is nothing to say about waiting, and nothing was said.
    await vi.waitFor(() => expect(bodies(b.id)).toEqual(["What does Hold do?", "Answered on session-2."]));
    expect(runsOf(a.id).map((run) => run.status)).toEqual(["running"]);
    expect(bodies(a.id)).toEqual(["Rework the release pipeline."]);

    // Switching back and forth while it runs changes nothing either.
    resumeAssist(handle.db, { conversationId: a.id });
    resumeAssist(handle.db, { conversationId: b.id });
    expect(runsOf(a.id).map((run) => run.status)).toEqual(["running"]);

    // And A's turn runs to its end and answers in A.
    held.get("session-1")!();
    await Promise.all([first, second]);
    expect(runsOf(a.id).map((run) => run.status)).toEqual(["succeeded"]);
    expect(bodies(a.id)).toEqual(["Rework the release pipeline.", "Answered on session-1."]);
    expect(bodies(b.id)).toEqual(["What does Hold do?", "Answered on session-2."]);
    for (const chat of [a, b]) expect(bodies(chat.id).join("\n")).not.toMatch(/Turn stopped|Not answered/);
  });

  it("opens a fresh provider session for a new chat, and resumes each chat's own thread after that", async () => {
    const engine = supervisor();
    const a = openAssist(handle.db).conversation;
    say(a.id, "Rework the release pipeline.");
    await engine.runOnce();

    const b = newAssist(handle.db).conversation;
    say(b.id, "What does Hold do?");
    await engine.runOnce();

    // B's first turn is a start, not a resume of A's thread.
    expect(calls).toEqual([
      { kind: "start", threadId: "session-1" },
      { kind: "start", threadId: "session-2" },
    ]);
    expect(runsOf(a.id).map((run) => run.threadId)).toEqual(["session-1"]);
    expect(runsOf(b.id).map((run) => run.threadId)).toEqual(["session-2"]);

    // A second message in each goes back to that chat's own thread.
    say(b.id, "And Resume?");
    await engine.runOnce();
    say(a.id, "Add a QA step too.");
    await engine.runOnce();

    expect(calls.slice(2)).toEqual([
      { kind: "resume", threadId: "session-2" },
      { kind: "resume", threadId: "session-1" },
    ]);
    expect(bodies(a.id).at(-1)).toBe("Answered on session-1.");
    expect(bodies(b.id).at(-1)).toBe("Answered on session-2.");
  });
});
