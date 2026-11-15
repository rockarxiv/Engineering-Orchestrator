import type { Agent, AgentEvent, AgentProvider, Item, QuotaEvent } from "@eo/core";
import { quotaStopReason } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  getSetting,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  needsAttention,
  openMessageAbout,
  setSetting,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { createTestItem, messagesFrom, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { answerMessageCommand } from "../messages/messages.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { RuntimeAuthCheck } from "../runtimes/auth.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { CARRY_ON_NOW_OPTION, LIMIT_RESUME_MESSAGE, RUNTIME_BLOCK_RECHECK_MS, RUNTIME_LIMIT_SOURCE, RUNTIME_SIGN_IN_SOURCE } from "./runtimeBlocks.js";

/**
 * A runtime whose plan window is full is held on this device until the
 * window refreshes (EO-798): one message, a note on each item waiting,
 * nothing dispatched to an agent on it, and the run that found the limit
 * carried on in its own thread when the hold lifts — nobody replying
 * anywhere.
 *
 * Driven through the real supervisor over an in-memory database, with a
 * scripted backend whose first Claude turn is refused the way the Claude
 * adapter reports a `rate_limit_event` with status `rejected`.
 */

const CAP_ONE = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 10 };
const ROOMY = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const HOUR = 3_600_000;
/** Fixed, so the reset is arithmetic. */
const START = Date.UTC(2026, 7, 28, 20, 40);

let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;
let clock: number;
/** Whether the Claude probe says signed out; Codex is always signed in. */
let claudeSignedOut: boolean;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, { provider: "claude" })!;
  reviewer = updateAgent(handle.db, agents.find((agent) => agent.role === "reviewer")!.id, { provider: "codex" })!;
  clock = START;
  claudeSignedOut = false;
});

afterEach(() => {
  handle.close();
});

const checkAuth = vi.fn(async (agent: Agent): Promise<RuntimeAuthCheck> => {
  if (agent.provider !== "claude" || !claudeSignedOut) return { ok: true };
  return { ok: false, reason: "Claude Code is not signed in.", signedOut: { runtime: "claude", executablePath: "/opt/claude" } };
});

/** The five-hour window full, back `hours` from the start; no reset at all for null. */
function refusal(hours: number | null): QuotaEvent {
  return {
    type: "quota",
    provider: "claude",
    window: "five_hour",
    utilization: 100,
    status: "rejected",
    ...(hours === null ? {} : { resetsAt: (START + hours * HOUR) / 1000 }),
  };
}

/**
 * A backend whose Claude turns are refused while `refusals` has entries
 * (one taken per start), and that finishes every other turn. Each start
 * opens its own thread, so a resume can be told apart from a fresh run.
 */
function backend(refusals: (number | null)[] = [], gate?: Promise<void>) {
  const started: string[] = [];
  const resumed: { agent: string; threadId: string; message: string }[] = [];
  let threads = 0;
  const provider = (agent: Agent): AgentProvider => ({
    async *start(): AsyncIterable<AgentEvent> {
      started.push(agent.name);
      threads += 1;
      yield { type: "thread_started", threadId: `thread-${threads}` };
      if (agent.provider === "claude" && refusals.length > 0) {
        const hours = refusals.shift()!;
        if (gate) await gate;
        yield refusal(hours);
        yield { type: "result", data: "half an answer, cut off" };
        return;
      }
      yield { type: "result", data: validImplementResult };
    },
    async *resume(threadId: string, message: string): AsyncIterable<AgentEvent> {
      resumed.push({ agent: agent.name, threadId, message });
      yield { type: "result", data: validImplementResult };
    },
  });
  return { provider, started, resumed };
}

function supervising(options: Omit<RunSupervisorOptions, "db">): RunSupervisor {
  return createRunSupervisor({ db: handle.db, limits: CAP_ONE, checkAuth, now: () => clock, ...options });
}

// With criteria, so an item moved on to review does not stand at a
// refused review taking the one slot (EO-213).
const forImplementer = (title: string, priority = 0): Item =>
  createTestItem(handle.db, { type: "story", title, stepId: "todo", priority, spec: REVIEWABLE_SPEC });
const forReviewer = (title: string): Item => createTestItem(handle.db, { type: "story", title, stepId: "review", spec: REVIEWABLE_SPEC });

function engineNotes(item: Item) {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.kind === "note");
}

function limitMessages() {
  return messagesFrom(handle.db, RUNTIME_LIMIT_SOURCE);
}

function humanComments(items: readonly Item[]) {
  return items.flatMap((item) => listCommentsForItem(handle.db, item.id)).filter((comment) => comment.authorType === "human");
}

/** The run a plan limit stopped on an item: its first. */
function limitedRun(item: Item) {
  return listRunsForItem(handle.db, item.id).find((run) => run.interruption === "limit");
}

describe("a Claude run that hits its plan limit", () => {
  it("holds the next Claude item and still dispatches a Codex one", async () => {
    const first = forImplementer("Hits the limit", 10);
    const second = forImplementer("Queued behind it", 5);
    const review = forReviewer("Codex's");
    const { provider, started } = backend([3]);
    const supervisor = supervising({ provider });

    await supervisor.runOnce(); // the first Claude item, refused
    expect(limitedRun(first)).toBeDefined();
    for (let pass = 0; pass < 3; pass++) await supervisor.runOnce();

    expect(listRunsForItem(handle.db, second.id)).toEqual([]);
    expect(listRunsForItem(handle.db, review.id)).toHaveLength(1); // dispatched; what it answered is beside the point
    expect(started).toEqual([implementer.name, reviewer.name]);
    // The held item is told once, in a note naming the limit.
    const notes = engineNotes(second);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain("usage limit");
    expect(notes[0]?.body).toContain("five-hour usage window is full");
    expect(notes[0]?.body).toContain("2026-08-28 23:40 UTC");
    expect(needsAttention(handle.db, second.id)).toBe(false);
  });

  it("leaves no parked run and no escalation, keeps the thread and spends no attempt", async () => {
    const item = forImplementer("Hits the limit");
    const supervisor = supervising({ provider: backend([3]).provider });

    for (let pass = 0; pass < 3; pass++) await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run?.status).not.toBe("awaiting_input");
    expect(run?.status).toBe("cancelled");
    expect(run?.interruption).toBe("limit");
    expect(run?.threadId).toBe("thread-1");
    expect(run?.attempt).toBe(1);
    const comments = listCommentsForItem(handle.db, item.id);
    expect(comments.some((comment) => comment.kind === "escalation")).toBe(false);
    const reason = quotaStopReason({ agentName: implementer.name, event: refusal(3), now: START });
    const notes = engineNotes(item);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain(reason);
    expect(run?.error).toBe(reason);
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("sends one message naming the window and the reset, with Carry on now, however often the queue is looked at", async () => {
    forImplementer("Hits the limit", 10);
    forImplementer("Two", 5);
    forImplementer("Three", 5);
    const supervisor = supervising({ provider: backend([3]).provider });

    for (let pass = 0; pass < 4; pass++) await supervisor.runOnce();

    const messages = limitMessages();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.handledAt).toBeNull();
    expect(openMessageAbout(handle.db, RUNTIME_LIMIT_SOURCE, "claude")?.id).toBe(message?.id);
    expect(message?.body).toContain("Claude Code has hit its plan limit");
    expect(message?.body).toContain("five-hour usage window is full");
    expect(message?.body).toContain("in about 3 hours — 2026-08-28 23:40 UTC");
    expect(message?.body).toContain("3 items are waiting for Implementer");
    expect(message?.options).toEqual([CARRY_ON_NOW_OPTION]);
    // Not the sign-in block's message: a different reason, its own.
    expect(messagesFrom(handle.db, RUNTIME_SIGN_IN_SOURCE)).toEqual([]);
  });

  it("lifts at the reset: the message is resolved, the run carries on in its thread and the held item runs", async () => {
    const first = forImplementer("Hits the limit", 10);
    const second = forImplementer("Queued behind it", 5);
    const { provider, started, resumed } = backend([3]);
    const supervisor = supervising({ provider });

    await supervisor.runOnce();
    clock = START + 2 * HOUR;
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, second.id)).toEqual([]);
    expect(resumed).toEqual([]);

    clock = START + 3 * HOUR + 1;
    await supervisor.runOnce(); // lifts
    for (let pass = 0; pass < 4; pass++) await supervisor.runOnce(); // and dispatches what it held, one at a time

    expect(limitMessages()[0]?.handledHow).toBe("resolved");
    // The implementer's: the reviewer's corrections are its own business.
    expect(resumed.filter((turn) => turn.agent === implementer.name)).toEqual([{ agent: implementer.name, threadId: "thread-1", message: LIMIT_RESUME_MESSAGE }]);
    const [stopped, carried] = listRunsForItem(handle.db, first.id).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    expect(carried?.status).toBe("succeeded");
    expect(carried?.threadId).toBe("thread-1");
    expect(carried?.initiationId).toBe(stopped?.initiationId);
    expect(carried?.attempt).toBe(stopped?.attempt);
    expect(listRunsForItem(handle.db, second.id).map((run) => run.status)).toContain("succeeded");
    // Two fresh Implementer starts: the first run, and the held item's — the continuation was a resume.
    expect(started.filter((name) => name === implementer.name)).toHaveLength(2);
    expect(humanComments([first, second])).toEqual([]);
  });

  it("does not lift by itself with no reset it could read, and lifts on Carry on now", async () => {
    const first = forImplementer("Hits the limit", 10);
    const second = forImplementer("Queued behind it", 5);
    const { provider, resumed } = backend([null]);
    const supervisor = supervising({ provider });

    await supervisor.runOnce();
    for (const days of [1, 3, 10]) {
      clock = START + days * 24 * HOUR;
      await supervisor.runOnce();
    }
    expect(listRunsForItem(handle.db, second.id)).toEqual([]);
    expect(resumed).toEqual([]);
    const [message] = limitMessages();
    expect(message?.body).toContain("did not say when the window refreshes");
    expect(message?.body).toContain("Carry on now");

    answerMessageCommand(handle.db, { messageId: message!.id, answer: CARRY_ON_NOW_OPTION });
    for (let pass = 0; pass < 5; pass++) await supervisor.runOnce();

    expect(resumed.filter((turn) => turn.agent === implementer.name).map((turn) => turn.threadId)).toEqual(["thread-1"]);
    expect(listRunsForItem(handle.db, first.id).map((run) => run.status)).toContain("succeeded");
    expect(listRunsForItem(handle.db, second.id).map((run) => run.status)).toContain("succeeded");
  });

  it("blocks again, spending no attempt, when the limit is found again after the lift", async () => {
    const item = forImplementer("Hits the limit twice");
    // Refused at the first start; the resume after the lift is refused too.
    const supervisor = supervising({
      provider: () => ({
        async *start(): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: "thread-1" };
          yield refusal(1);
          yield { type: "result", data: "cut off" };
        },
        async *resume(): AsyncIterable<AgentEvent> {
          yield refusal(4);
          yield { type: "result", data: "cut off again" };
        },
      }),
    });

    await supervisor.runOnce();
    clock = START + HOUR + 1;
    await supervisor.runOnce(); // lifts
    await supervisor.runOnce(); // carried on, refused again

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.interruption === "limit" && run.attempt === 1)).toBe(true);
    expect(runs.every((run) => run.threadId === "thread-1")).toBe(true);
    expect(limitMessages()).toHaveLength(2); // the first resolved, the second open
    expect(openMessageAbout(handle.db, RUNTIME_LIMIT_SOURCE, "claude")?.body).toContain("2026-08-29 00:40 UTC");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "escalation")).toBe(false);
  });

  it("takes a later reset from a second hit without a second message, and lifts at the later time", async () => {
    const first = forImplementer("Back in three hours", 10);
    const second = forImplementer("Back in five", 9);
    const third = forImplementer("Waiting", 1);
    const { provider, resumed } = backend([3, 5]);
    // Both Claude items start in one tick; each is refused.
    const supervisor = supervising({ provider, limits: { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 10 } });

    await supervisor.runOnce();
    expect(limitedRun(first)).toBeDefined();
    expect(limitedRun(second)).toBeDefined();
    expect(limitMessages()).toHaveLength(1);

    clock = START + 4 * HOUR;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, third.id)).toEqual([]);
    expect(resumed).toEqual([]);
    expect(limitMessages()).toHaveLength(1);
    expect(limitMessages()[0]?.handledAt).toBeNull();

    clock = START + 5 * HOUR + 1;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(limitMessages()[0]?.handledHow).toBe("resolved");
    expect(resumed.length).toBeGreaterThan(0);
  });

  it("stays blocked while the runtime is also not signed in, until that clears too", async () => {
    const first = forImplementer("Hits the limit", 10);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { provider, resumed, started } = backend([1], gate);
    const supervisor = supervising({ provider, limits: ROOMY });

    // The first run is under way when Claude is found signed out for the
    // next item; then the first run is refused.
    const firstTick = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = forImplementer("Found signed out", 5);
    claudeSignedOut = true;
    const secondTick = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([firstTick, secondTick]);
    expect(limitedRun(first)).toBeDefined();
    expect(openMessageAbout(handle.db, RUNTIME_SIGN_IN_SOURCE, "claude")).toBeDefined();
    expect(openMessageAbout(handle.db, RUNTIME_LIMIT_SOURCE, "claude")).toBeDefined();

    // The window refreshes: the plan-limit block lifts, the sign-in one stands.
    clock = START + HOUR + 1;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(openMessageAbout(handle.db, RUNTIME_LIMIT_SOURCE, "claude")).toBeUndefined();
    expect(openMessageAbout(handle.db, RUNTIME_SIGN_IN_SOURCE, "claude")).toBeDefined();
    expect(resumed).toEqual([]);
    expect(listRunsForItem(handle.db, second.id)).toEqual([]);
    expect(started).toEqual([implementer.name]);

    // Signed in: both carry on.
    claudeSignedOut = false;
    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce(); // the recheck lifts it
    await supervisor.runOnce();
    expect(resumed.filter((turn) => turn.agent === implementer.name).map((turn) => turn.threadId)).toEqual(["thread-1"]);
    expect(listRunsForItem(handle.db, second.id).map((run) => run.status)).toContain("succeeded");
  });

  it("keeps a forced restart on the held runtime from holding back the other runtime's work", async () => {
    forImplementer("Hits the limit", 10);
    const closed = forImplementer("Stopped when EO was closed", 1);
    const stopped = createRun(handle.db, { itemId: closed.id, agentId: implementer.id, action: "implement", stepId: "todo", status: "queued", threadId: "closed-thread", provider: "claude" });
    updateRun(handle.db, stopped.id, { status: "cancelled", interruption: "quit", startedAt: 1, endedAt: 2 });
    const { provider } = backend([3]);
    const supervisor = supervising({ provider });

    await supervisor.runOnce(); // the first item finds the limit
    setSetting(handle.db, "engine.forced-restarts", [
      { cancelledRunId: stopped.id, itemId: closed.id, agentId: implementer.id, action: "implement", transitionOnSuccess: true, interruption: "quit" },
    ]);
    const review = forReviewer("Codex's");
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, review.id)).toHaveLength(1);
    expect(getSetting(handle.db, "engine.forced-restarts", [])).toHaveLength(1); // kept for after the hold
  });
});
