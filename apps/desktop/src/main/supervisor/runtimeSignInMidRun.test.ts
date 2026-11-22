import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentEvent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listAgents, listCommentsForItem, listRunsForItem, needsAttention, openMessageAbout, updateAgent } from "../db/repos/index.js";
import { createTestItem, messagesFrom, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { answerMessageCommand } from "../messages/messages.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { RuntimeAuthCheck } from "../runtimes/auth.js";
import { onRuntimeSignedIn, runtimeSignedIn } from "../runtimes/signedIn.js";
import { CLAUDE_AUTH_ERRORS } from "../testing/authErrorFixtures.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { isSignInStop, RUNTIME_BLOCK_RECHECK_MS, RUNTIME_SIGN_IN_SOURCE, TRY_AGAIN_OPTION } from "./runtimeBlocks.js";

/**
 * A sign-in that dies while EO believes the runtime is signed in
 * (EO-797): the run is stopped without spending an attempt or being
 * retried, and the runtime is blocked on this device the way a
 * pre-dispatch `signed_out` blocks it (EO-796) — except that the probe,
 * which still says signed in, does not lift it.
 *
 * Driven through the real supervisor over an in-memory database, and
 * through the real Claude adapter replaying what the pinned CLI said
 * (`providers/__fixtures__/claude-0.3.329-auth-errors.json`). The probe
 * says signed in throughout, as `claude auth status` does over a dead
 * token.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let implementer: Agent;
let reviewer: Agent;
let clock: number;

beforeEach(() => {
  handle = openMigratedTestDb();
  const agents = listAgents(handle.db);
  implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, { provider: "claude" })!;
  reviewer = updateAgent(handle.db, agents.find((agent) => agent.role === "reviewer")!.id, { provider: "codex" })!;
  clock = 1_800_000_000_000;
});

afterEach(() => {
  handle.close();
});

/** Signed in, as far as the probe can tell. */
const checkAuth = vi.fn(async (): Promise<RuntimeAuthCheck> => ({ ok: true }));

/** The Claude adapter over a turn the CLI really played. */
function claudeReplaying(messages: SDKMessage[]): AgentProvider {
  const runQuery = (() =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-dead" } as unknown as SDKMessage;
      for (const message of messages) yield message;
    })()) as never;
  return createClaudeProvider({ runQuery, enableCommentTool: false });
}

/** A Codex turn that ends as the Codex adapter ends one the app-server refused for its sign-in. */
const codexRefused: AgentProvider = {
  start: () =>
    (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "thread_started", threadId: "thr-dead" };
      yield { type: "error", message: "Codex needs signing in again: Your access token could not be refreshed. Please log out and sign in again.", retryable: false, signIn: true };
    })(),
  resume: () => {
    throw new Error("not resumed");
  },
};

/**
 * A backend whose credential on one runtime is dead until `revive()`:
 * that runtime's turns end on the recorded failure (Claude's) or on what
 * the Codex adapter makes of one, and every other turn finishes.
 */
function backend(dead: SDKMessage[] = CLAUDE_AUTH_ERRORS.signIn[1]!.turn, deadOn: "claude" | "codex" = "claude") {
  const started: string[] = [];
  let alive = false;
  const healthy = createFakeProvider({ result: validImplementResult });
  const provider = (agent: Agent): AgentProvider => ({
    start: (opts) => {
      started.push(agent.name);
      if (alive || agent.provider !== deadOn) return healthy.start(opts);
      return deadOn === "codex" ? codexRefused.start(opts) : claudeReplaying(dead).start(opts);
    },
    resume: (threadId, message, opts) => {
      started.push(agent.name);
      return healthy.resume(threadId, message, opts);
    },
  });
  return { provider, started, revive: () => (alive = true) };
}

function supervising(options: Omit<RunSupervisorOptions, "db">): RunSupervisor {
  return createRunSupervisor({ db: handle.db, limits: LIMITS, checkAuth, now: () => clock, ...options });
}

const forImplementer = (title: string): Item => createTestItem(handle.db, { type: "story", title, stepId: "todo" });
const forReviewer = (title: string): Item => createTestItem(handle.db, { type: "story", title, stepId: "review", spec: REVIEWABLE_SPEC });

function engineNotes(item: Item) {
  return listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine" && comment.kind === "note");
}

const signInMessages = () => messagesFrom(handle.db, RUNTIME_SIGN_IN_SOURCE);

/** The item's runs by Implementer: a finished implement goes on to Codex's review. */
const implementing = (item: Item) => listRunsForItem(handle.db, item.id).filter((run) => run.agentId === implementer.id);

describe("a run its sign-in stopped mid-run", () => {
  it.each(CLAUDE_AUTH_ERRORS.signIn.map((recorded) => [recorded.case, recorded.turn] as const))(
    "spends no attempt, is not retried, posts no 'Attempt N stopped' and names the runtime, for %s",
    async (_name, turn) => {
      const item = forImplementer("One");
      const { provider, started } = backend(turn);
      const supervisor = supervising({ provider });

      for (let pass = 0; pass < 4; pass++) await supervisor.runOnce();
      clock += 10 * 60_000; // past every retry backoff
      for (let pass = 0; pass < 2; pass++) await supervisor.runOnce();

      expect(started).toEqual([implementer.name]); // once, and not again
      const runs = listRunsForItem(handle.db, item.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "failed", attempt: 1 });
      expect(isSignInStop(runs[0]!.error)).toBe(true);
      const said = listCommentsForItem(handle.db, item.id);
      expect(said.some((comment) => comment.body.startsWith("Attempt "))).toBe(false);
      expect(said.some((comment) => comment.kind === "escalation")).toBe(false);
      const notes = engineNotes(item);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.body).toContain("This run stopped because Claude Code needs signing in again.");
      expect(needsAttention(handle.db, item.id)).toBe(false);
    },
  );

  it("forgets the probe's cached answer", async () => {
    const auth = await import("../runtimes/auth.js");
    const forgot = vi.spyOn(auth, "invalidateRuntimeAuth");
    forImplementer("One");
    const supervisor = supervising({ provider: backend().provider });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(forgot).toHaveBeenCalledWith("claude");
    forgot.mockRestore();
  });

  it("blocks the runtime: one runtime_sign_in message, and the other Claude items held with one note each", async () => {
    const first = forImplementer("One");
    const { provider, started } = backend();
    const supervisor = supervising({ provider });
    await supervisor.runOnce();
    await supervisor.runOnce();
    const queued = [forImplementer("Two"), forImplementer("Three")];
    const review = forReviewer("Codex's");

    for (let pass = 0; pass < 4; pass++) await supervisor.runOnce();

    const messages = signInMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.handledAt).toBeNull();
    expect(openMessageAbout(handle.db, RUNTIME_SIGN_IN_SOURCE, "claude")?.id).toBe(messages[0]?.id);
    expect(messages[0]?.body).toContain("Claude Code is not signed in");
    expect(messages[0]?.options).toContainEqual({ kind: "open", label: "Sign in", opens: { type: "runtimeSignIn", runtime: "claude" } });
    expect(messages[0]?.options).toContain(TRY_AGAIN_OPTION);
    for (const item of queued) {
      expect(listRunsForItem(handle.db, item.id)).toEqual([]);
      expect(engineNotes(item).map((note) => note.body)).toEqual([expect.stringContaining("Waiting for Claude Code to be signed in")]);
    }
    // The item the run was on is told once, by the note on its stop.
    expect(engineNotes(first).map((note) => note.body.slice(0, 60))).toEqual([expect.stringContaining("This run stopped")]);
    // And the other runtime carries on.
    expect(started.filter((name) => name === implementer.name)).toHaveLength(1);
    expect(listRunsForItem(handle.db, review.id).map((run) => run.agentId)).toContain(reviewer.id);
  });

  it("is not lifted by the probe saying signed in, and is by a sign-in EO completed: the held items then run", async () => {
    const first = forImplementer("One");
    const { provider, started, revive } = backend();
    const supervisor = supervising({ provider, onRuntimeSignedIn, tickIntervalMs: 3_600_000, watchdogIntervalMs: 3_600_000 });
    supervisor.start();
    try {
      await supervisor.runOnce();
      await supervisor.runOnce();
      const second = forImplementer("Two");

      // Long past the probe-caused block's recheck, with the probe saying signed in throughout.
      for (let pass = 0; pass < 3; pass++) {
        clock += RUNTIME_BLOCK_RECHECK_MS * 2;
        await supervisor.runOnce();
      }
      expect(started).toEqual([implementer.name]);
      expect(signInMessages().map((message) => message.handledAt)).toEqual([null]);

      revive();
      runtimeSignedIn("claude");
      expect(signInMessages().map((message) => message.handledHow)).toEqual(["resolved"]);
      await supervisor.runOnce();
      await supervisor.runOnce();

      expect(started).toEqual([implementer.name, implementer.name, implementer.name]);
      // The run that was stopped is carried on as the same attempt.
      expect(implementing(first).map((run) => run.attempt)).toEqual([1, 1]);
      expect(implementing(second)).toHaveLength(1);
      for (const item of [first, second]) expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.authorType === "human")).toBe(false);
    } finally {
      supervisor.stop();
    }
  });

  it("is lifted by the person answering Try again, and the held items then run without waiting out a retry", async () => {
    const first = forImplementer("One");
    const { provider, started, revive } = backend();
    const supervisor = supervising({ provider });
    await supervisor.runOnce();
    await supervisor.runOnce();
    const second = forImplementer("Two");
    await supervisor.runOnce();
    expect(started).toEqual([implementer.name]);

    revive();
    const [message] = signInMessages();
    answerMessageCommand(handle.db, { messageId: message!.id, answer: TRY_AGAIN_OPTION });
    await supervisor.runOnce(); // asks the probe, which says signed in, and lifts
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(implementing(first)).toHaveLength(2);
    expect(implementing(second)).toHaveLength(1);
    expect(signInMessages().map((message) => message.handledHow)).toEqual(["answered"]);
  });

  it("stays a block the probe holds when Try again finds it signed out, and lifts when the probe stops saying so", async () => {
    let signedOut = false;
    checkAuth.mockImplementation(async () => (signedOut ? { ok: false, reason: "Claude Code is not signed in.", signedOut: { runtime: "claude", executablePath: null } } : { ok: true }));
    try {
      forImplementer("One");
      const { provider, started, revive } = backend();
      const supervisor = supervising({ provider });
      await supervisor.runOnce();
      await supervisor.runOnce();

      signedOut = true;
      answerMessageCommand(handle.db, { messageId: signInMessages()[0]!.id, answer: TRY_AGAIN_OPTION });
      await supervisor.runOnce();
      await supervisor.runOnce();
      expect(started).toEqual([implementer.name]);

      // Signed in from a terminal: the probe says so on its next recheck.
      signedOut = false;
      revive();
      clock += RUNTIME_BLOCK_RECHECK_MS;
      await supervisor.runOnce();
      await supervisor.runOnce();
      expect(started).toEqual([implementer.name, implementer.name]);
    } finally {
      checkAuth.mockImplementation(async () => ({ ok: true }));
    }
  });

  it("blocks Codex for a Codex agent's run, and leaves Claude alone", async () => {
    const review = forReviewer("Codex's");
    const claudes = forImplementer("Claude's");
    const { provider, started } = backend(undefined, "codex");
    const supervisor = supervising({ provider });
    await supervisor.runOnce();
    await supervisor.runOnce();
    const nextReview = forReviewer("Codex's too");
    await supervisor.runOnce();

    expect(signInMessages()).toHaveLength(1);
    expect(openMessageAbout(handle.db, RUNTIME_SIGN_IN_SOURCE, "codex")?.id).toBe(signInMessages()[0]?.id);
    expect(listRunsForItem(handle.db, review.id)).toHaveLength(1);
    expect(isSignInStop(listRunsForItem(handle.db, review.id)[0]!.error)).toBe(true);
    expect(engineNotes(review)[0]?.body).toContain("Codex");
    expect(listRunsForItem(handle.db, nextReview.id)).toEqual([]);
    expect(started.filter((name) => name === reviewer.name)).toHaveLength(1);
    expect(implementing(claudes)).not.toEqual([]);
  });
});

describe("an error that is not about signing in", () => {
  it("is still an ordinary failure: an attempt, a note saying so, and no runtime blocked", async () => {
    const item = forImplementer("One");
    const { provider } = backend(CLAUDE_AUTH_ERRORS.notSignIn[0]!.turn);
    const supervisor = supervising({ provider });

    await supervisor.runOnce();
    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("failed");
    expect(isSignInStop(run?.error)).toBe(false);
    expect(engineNotes(item).some((note) => note.body.startsWith("Attempt 1 stopped."))).toBe(true);
    expect(signInMessages()).toEqual([]);
  });
});
