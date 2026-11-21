import { isCommentAction, type Agent, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, createStep, createRoute, listAgents, openMessageAbout, postComment, updateRun, listCommentsForItem, listRunsForItem, needsAttention, updateAgent } from "../db/repos/index.js";
import { agentOfKind, createTestItem, messagesFrom, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { answerMessageCommand } from "../messages/messages.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { RuntimeAuthCheck } from "../runtimes/auth.js";
import { onRuntimeSignedIn, runtimeSignedIn } from "../runtimes/signedIn.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { RUNTIME_BLOCK_RECHECK_MS, RUNTIME_SIGN_IN_SOURCE, TRY_AGAIN_OPTION } from "./runtimeBlocks.js";

/**
 * A runtime that is not signed in is blocked on this device (EO-796):
 * one message to the person, a note on each item waiting, nothing
 * dispatched to an agent on it, and everything else carrying on.
 *
 * Driven through the real supervisor over an in-memory database. Only
 * the backend and the auth probe are stubbed: the probe answers as
 * `checkAgentAuth` does, with `signedOut` when the CLI said signed out.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CLAUDE_PATH = "/opt/eo/runtimes/claude/bin/claude";

let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;
let clock: number;
/** What the Claude probe says right now; Codex is always signed in. */
let claude: "signed_in" | "signed_out" | "unknown";

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, { provider: "claude" })!;
  reviewer = updateAgent(handle.db, agents.find((agent) => agent.role === "reviewer")!.id, { provider: "codex" })!;
  clock = 1_800_000_000_000;
  claude = "signed_out";
});

afterEach(() => {
  handle.close();
});

const checkAuth = vi.fn(async (agent: Agent): Promise<RuntimeAuthCheck> => {
  if (agent.provider !== "claude" || claude !== "signed_out") return { ok: true };
  return { ok: false, reason: "Claude Code is not signed in.", signedOut: { runtime: "claude", executablePath: CLAUDE_PATH } };
});

/** A backend that finishes every turn, and remembers which agents it was started for. */
function backend() {
  const started: string[] = [];
  const resumed: string[] = [];
  const inner = createFakeProvider({ result: validImplementResult });
  const provider = (agent: Agent): AgentProvider => ({
    start: (opts) => {
      started.push(agent.name);
      return inner.start(opts);
    },
    resume: (threadId, message, opts) => {
      resumed.push(agent.name);
      return inner.resume(threadId, message, opts);
    },
  });
  return { provider, started, resumed };
}

function supervising(options: Omit<RunSupervisorOptions, "db">): RunSupervisor {
  return createRunSupervisor({ db: handle.db, limits: LIMITS, checkAuth, now: () => clock, ...options });
}

const forImplementer = (title: string, priority = 0): Item => createTestItem(handle.db, { type: "story", title, stepId: "todo", priority });
const forReviewer = (title: string): Item => createTestItem(handle.db, { type: "story", title, stepId: "review", spec: REVIEWABLE_SPEC });

function engineNotes(item: Item) {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.kind === "note");
}

function signInMessages() {
  return messagesFrom(handle.db, RUNTIME_SIGN_IN_SOURCE);
}

describe("a runtime the probe says is signed out", () => {
  it("starts nothing for its items, parks none of them, and tells each one once", async () => {
    const queued = [forImplementer("One"), forImplementer("Two"), forImplementer("Three")];
    const { provider, started } = backend();
    const supervisor = supervising({ provider });

    for (let pass = 0; pass < 4; pass++) await supervisor.runOnce();

    expect(started).toEqual([]);
    for (const item of queued) {
      expect(listRunsForItem(handle.db, item.id)).toEqual([]);
      const notes = engineNotes(item);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toContain("Claude");
      expect(notes[0]?.body).toContain("not signed in");
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "escalation")).toBe(false);
      expect(needsAttention(handle.db, item.id)).toBe(false);
    }
  });

  it("sends one message with a Sign in action and Try again, however often the queue is looked at", async () => {
    forImplementer("One");
    forImplementer("Two");
    forImplementer("Three");
    const supervisor = supervising({ provider: backend().provider });

    for (let pass = 0; pass < 4; pass++) await supervisor.runOnce();

    const messages = signInMessages();
    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message?.handledAt).toBeNull();
    expect(openMessageAbout(handle.db, RUNTIME_SIGN_IN_SOURCE, "claude")?.id).toBe(message?.id);
    expect(message?.body).toContain("Claude Code is not signed in");
    expect(message?.body).toContain(CLAUDE_PATH);
    expect(message?.body).toContain("3 items are waiting for Implementer");
    expect(message?.options).toContainEqual({ kind: "open", label: "Sign in", opens: { type: "runtimeSignIn", runtime: "claude" } });
    expect(message?.options).toContain(TRY_AGAIN_OPTION);
    expect(message?.options?.filter(isCommentAction)).toHaveLength(1);
  });

  it("still dispatches a Codex agent's item, a step the system role owns and a built-in step", async () => {
    createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", agentId: agentOfKind(handle.db, "system"), entryAction: "intake" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "todo", position: 0 });
    const held = forImplementer("Claude's");
    const review = forReviewer("Codex's");
    const intake = createTestItem(handle.db, { type: "feature", title: "The system agent's", stepId: "ask" });
    const prep = createTestItem(handle.db, { type: "story", title: "Needs a worktree", stepId: "worktree" });
    const createWorktree = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "ready", detail: "done" }));
    const supervisor = supervising({ provider: backend().provider, builtins: { create_worktree: createWorktree } });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, held.id)).toEqual([]);
    expect(listRunsForItem(handle.db, review.id).map((run) => run.agentId)).toContain(reviewer.id);
    expect(listRunsForItem(handle.db, intake.id)).not.toEqual([]);
    expect(createWorktree).toHaveBeenCalled();
    expect(listRunsForItem(handle.db, prep.id)).not.toEqual([]);
  });

  it("holds no slot: with the cap at one, the Codex item is dispatched", async () => {
    // Claude's are older and more urgent, so they are first in line.
    const held = [forImplementer("One", 5), forImplementer("Two", 5)];
    const review = forReviewer("Codex's");
    const { provider, started } = backend();
    const supervisor = supervising({ provider, limits: { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 } });

    await supervisor.runOnce(); // the first Claude item meets the probe, and the runtime is blocked
    await supervisor.runOnce();

    expect(started).toEqual([reviewer.name]);
    expect(listRunsForItem(handle.db, review.id)).not.toEqual([]);
    for (const item of held) expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("lifts once the probe next says signed in: the message is resolved and the items run, with nobody replying", async () => {
    const queued = [forImplementer("One"), forImplementer("Two")];
    const { provider, started } = backend();
    const supervisor = supervising({ provider });
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(started).toEqual([]);

    // Signed in from a terminal: nothing tells EO, so the recheck finds it.
    claude = "signed_in";
    await supervisor.runOnce();
    expect(started).toEqual([]); // not due yet

    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(signInMessages().map((message) => message.handledHow)).toEqual(["resolved"]);
    expect(started).toEqual([implementer.name, implementer.name]);
    for (const item of queued) {
      expect(listRunsForItem(handle.db, item.id)).not.toEqual([]);
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.authorType === "human")).toBe(false);
    }
  });

  it("lifts at once when EO completes a sign-in of it", async () => {
    const item = forImplementer("One");
    const { provider, started } = backend();
    const supervisor = supervising({ provider, onRuntimeSignedIn, tickIntervalMs: 3_600_000, watchdogIntervalMs: 3_600_000 });
    supervisor.start();
    try {
      await supervisor.runOnce();
      expect(started).toEqual([]);

      claude = "signed_in";
      runtimeSignedIn("claude");
      expect(signInMessages().map((message) => message.handledHow)).toEqual(["resolved"]);

      await supervisor.runOnce();
      expect(started).toEqual([implementer.name]);
      expect(listRunsForItem(handle.db, item.id)).not.toEqual([]);
      expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.authorType === "human")).toBe(false);
    } finally {
      supervisor.stop();
    }
  });

  it("asks again when the person answers Try again, and sends nothing more while it is still signed out", async () => {
    const item = forImplementer("One");
    const { provider, started } = backend();
    const supervisor = supervising({ provider });
    await supervisor.runOnce();
    const asked = checkAuth.mock.calls.length;
    const [message] = signInMessages();

    answerMessageCommand(handle.db, { messageId: message!.id, answer: TRY_AGAIN_OPTION });
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(checkAuth.mock.calls.length).toBe(asked + 1); // asked once, at once, not on every tick
    expect(started).toEqual([]);
    expect(signInMessages()).toHaveLength(1);
    expect(engineNotes(item)).toHaveLength(1);

    // And a Try again that finds it signed in lifts the block.
    claude = "signed_in";
    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(started).toEqual([implementer.name]);
  });

  it("tells an item again in a later block, and only once in each", async () => {
    const item = forImplementer("One");
    const supervisor = supervising({ provider: backend().provider });
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(engineNotes(item)).toHaveLength(1);

    // Paused, so the item is still waiting when the first block lifts.
    supervisor.pause();
    claude = "signed_in";
    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(signInMessages().map((message) => message.handledHow)).toEqual(["resolved"]);

    claude = "signed_out";
    clock += 1_000;
    supervisor.resume();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(engineNotes(item)).toHaveLength(2);
    expect(signInMessages().map((message) => message.handledHow)).toEqual(["resolved", null]);
  });
});

describe("the other doors to an agent on a blocked runtime", () => {
  /** An item parked on a Claude run that asked a question, with its thread. */
  function parkedOnClaude(): Item {
    const item = forImplementer("Parked");
    const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", threadId: "thr-parked", stepId: "todo", initiationId: `first:${item.id}` });
    updateRun(handle.db, run.id, { status: "awaiting_input", startedAt: 1, endedAt: 2 });
    return item;
  }

  it("keeps a reply to a parked Claude run, starts nothing, tells the item once, and answers it once the block lifts", async () => {
    const parked = parkedOnClaude();
    forImplementer("Queued"); // what meets the probe and blocks Claude
    const { provider, started, resumed } = backend();
    const supervisor = supervising({ provider, guards: { interpretReplies: false } });
    await supervisor.runOnce();
    expect(signInMessages()).toHaveLength(1);

    postComment(handle.db, { itemId: parked.id, author: { type: "human" }, body: "Yes, go ahead." });
    await supervisor.resumeItem(parked.id); // what posting the reply does
    await supervisor.runOnce(); // and the scheduler's recovery of it
    await supervisor.runOnce();

    expect(started).toEqual([]);
    expect(resumed).toEqual([]);
    expect(listRunsForItem(handle.db, parked.id)).toHaveLength(1); // the parked run alone: nothing started, nothing reserved
    expect(engineNotes(parked)).toHaveLength(1);

    claude = "signed_in";
    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce();
    await supervisor.runOnce();

    // The reply is answered by itself: a new run on the item, as Implementer.
    const runs = listRunsForItem(handle.db, parked.id);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.every((run) => run.agentId === implementer.id)).toBe(true);
    expect([...started, ...resumed]).toContain(implementer.name);
  });

  it("keeps a mention of a Claude agent open while Claude is blocked, and answers it afterwards", async () => {
    forImplementer("Queued");
    const atRest = createTestItem(handle.db, { type: "story", title: "Waiting to merge", stepId: "ready_to_merge" });
    const supervisor = supervising({ provider: backend().provider });
    await supervisor.runOnce();

    postComment(handle.db, { itemId: atRest.id, author: { type: "human" }, body: `@${implementer.name} a question`, mentions: [{ type: "agent", agentId: implementer.id }] });
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, atRest.id)).toEqual([]);
    expect(engineNotes(atRest)).toHaveLength(1);

    claude = "signed_in";
    clock += RUNTIME_BLOCK_RECHECK_MS;
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, atRest.id).map((run) => run.agentId)).toEqual([implementer.id]);
  });
});

describe("an unknown answer from the probe", () => {
  it("lets the dispatch through, as it always has", async () => {
    claude = "unknown";
    const item = forImplementer("One");
    const { provider, started } = backend();
    const supervisor = supervising({ provider });

    await supervisor.runOnce();

    expect(started).toEqual([implementer.name]);
    expect(listRunsForItem(handle.db, item.id)).not.toEqual([]);
    expect(signInMessages()).toEqual([]);
  });
});

describe("a refusal that is not a sign-in", () => {
  it("is still the item's: a parked run and an escalation, and no runtime is blocked", async () => {
    const item = forImplementer("One");
    const review = forReviewer("Codex's");
    const supervisor = supervising({
      provider: backend().provider,
      checkAuth: async (agent) => (agent.provider === "claude" ? { ok: false, reason: "EO could not make Implementer a Codex home." } : { ok: true }),
    });

    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "escalation")).toBe(true);
    expect(signInMessages()).toEqual([]);
    expect(listRunsForItem(handle.db, review.id)).not.toEqual([]);
  });
});
