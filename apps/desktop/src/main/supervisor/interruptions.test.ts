import type { Agent, AgentProvider, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents, updateAgent } from "../db/repos/agentsRepo.js";
import { listCommentsForItem, postComment } from "../db/repos/commentsRepo.js";
import { createRun, getRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { listTransitionsForItem, transitionItem } from "../db/repos/transitionsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { crashMidStreamFixture, validImplementResult } from "../providers/fixtures.js";
import { RETRY_BACKOFF_MS } from "./buildTickInput.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/**
 * What a run is cut short by without failing (`RunInterruption`) — a
 * person closing EO, EO going down under it — and the two things that
 * follow from it: it is not an attempt the agent spent, and EO stops
 * carrying an initiation on by itself once it has been interrupted too
 * often. Beside them, the wait a failed run's retry now has.
 */
describe("interrupted runs", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  /** The initiation the scheduler will dispatch `item` under — its latest entry into the step, or its first. */
  function initiationOf(target: Item): string {
    const entry = listTransitionsForItem(handle.db, target.id)
      .filter((transition) => transition.toStepId === target.stepId)
      .at(-1);
    return entry?.id ?? `initial:${target.id}:${target.stepId}`;
  }

  /** A run of this initiation that something cut short. */
  function interrupted(interruption: "quit" | "restart", attempt = 1): void {
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      stepId: "todo",
      status: "queued",
      initiationId: initiationOf(item),
      attempt,
    });
    updateRun(handle.db, run.id, { status: "cancelled", interruption, startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
  }

  it("does not count an interrupted run as an attempt", async () => {
    // A limit of one makes it unmistakable: two interrupted runs counted
    // as attempts would refuse the dispatch below outright.
    interrupted("quit");
    interrupted("restart");
    const provider = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, guards: { perItemAttemptLimit: 1 } });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    const ran = listRunsForItem(handle.db, item.id).filter((run) => run.interruption === null);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ status: "succeeded", attempt: 1 });
  });

  it("stops carrying an initiation on once it has been interrupted five times, and says so", async () => {
    for (let i = 0; i < 5; i++) interrupted(i % 2 === 0 ? "quit" : "restart");
    const start = vi.fn<AgentProvider["start"]>();
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start }, limits: LIMITS });

    await supervisor.runOnce();

    expect(start).not.toHaveBeenCalled();
    const refusal = listRunsForItem(handle.db, item.id).find((run) => run.status === "awaiting_input");
    expect(refusal?.error).toContain("interrupted 5 times");
    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain("interrupted 5 times");
    expect(escalation?.body).toContain("Reply to start a new initiation");
  });

  it("does not resume a run found running after a restart once its initiation has been interrupted too often", async () => {
    for (let i = 0; i < 5; i++) interrupted("restart");
    const stale = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      stepId: "todo",
      status: "queued",
      threadId: "thread-that-keeps-dying",
      initiationId: initiationOf(item),
    });
    updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now() });
    const resume = vi.fn<AgentProvider["resume"]>();
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), resume }, limits: LIMITS });

    const summary = await supervisor.reconcile();

    expect(summary).toEqual({ reattached: 0, resumed: 0, orphaned: 1 });
    expect(resume).not.toHaveBeenCalled();
    expect(getRun(handle.db, stale.id)).toMatchObject({ status: "orphaned", interruption: "restart" });
    expect(getRun(handle.db, stale.id)?.error).toContain("not carried on again");
  });

  it("starts a stopped run over in a fresh session when its thread can no longer be resumed", async () => {
    // A turn that runs until it is stopped: the close lands mid-run.
    const firstStart = vi.fn<AgentProvider["start"]>(async function* (input) {
      yield { type: "thread_started", threadId: "the-stopped-thread" };
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", resolve, { once: true });
      });
    });
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start: firstStart }, limits: LIMITS });
    // Not awaited: a tick waits for what it dispatched, and this run only
    // ends when it is stopped.
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledOnce());

    // "Stop agents and close".
    supervisor.pause({ cancelRunning: true });
    await ticking;
    await supervisor.waitForIdle();
    const stopped = listRunsForItem(handle.db, item.id)[0]!;
    // With the session it had: what a continuation would resume.
    expect(stopped).toMatchObject({ status: "cancelled", interruption: "quit", threadId: "the-stopped-thread" });

    // Changed while EO was closed: the agent is on another backend now,
    // and a session cannot be carried across backends, so the stopped
    // thread is not resumed.
    updateAgent(handle.db, implementer.id as Uuid, { provider: implementer.provider === "claude" ? "codex" : "claude" });
    const freshStart = vi.fn<AgentProvider["start"]>(async function* () {
      yield { type: "thread_started", threadId: "a-fresh-thread" };
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const resume = vi.fn<AgentProvider["resume"]>();
    const reopened = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start: freshStart, resume }, limits: LIMITS });
    // Opened again: reconciles, then restarts what the close stopped.
    reopened.start();
    await vi.waitFor(() => expect(freshStart).toHaveBeenCalledOnce());
    await reopened.waitForIdle();

    expect(resume).not.toHaveBeenCalled();
    const replacement = listRunsForItem(handle.db, item.id).find((run) => run.action === "implement" && run.id !== stopped.id);
    expect(replacement).toMatchObject({ status: "succeeded", threadId: "a-fresh-thread", interruption: null });
    reopened.stop();
  });
  /** Starts a run that works until it is stopped, and stops it the way "Stop agents and close" does. */
  async function stoppedByAClose(): Promise<ReturnType<typeof listRunsForItem>[number]> {
    const working = vi.fn<AgentProvider["start"]>(async function* (input) {
      yield { type: "thread_started", threadId: "the-stopped-thread" };
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", resolve, { once: true });
      });
    });
    const supervisor = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start: working }, limits: LIMITS });
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(working).toHaveBeenCalledOnce());
    supervisor.pause({ cancelRunning: true });
    await ticking;
    await supervisor.waitForIdle();
    return listRunsForItem(handle.db, item.id).find((run) => run.interruption === "quit" && run.threadId === "the-stopped-thread")!;
  }

  it("lets go of a stopped run it refuses to carry on past the ceiling, rather than holding every other dispatch back", async () => {
    for (let i = 0; i < 4; i++) interrupted("quit");
    await stoppedByAClose();
    const other = createTestItem(handle.db, { type: "story", title: "Another story", stepId: "todo" });

    const start = vi.fn<AgentProvider["start"]>(async function* () {
      yield { type: "thread_started", threadId: "the-other-thread" };
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const resume = vi.fn<AgentProvider["resume"]>();
    const reopened = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start, resume }, limits: LIMITS });
    reopened.start();
    await vi.waitFor(() => expect(listRunsForItem(handle.db, other.id).some((run) => run.status === "succeeded")).toBe(true));
    await reopened.waitForIdle();

    expect(resume).not.toHaveBeenCalled();
    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain("interrupted 5 times");
    reopened.stop();
  });

  it("starts fresh rather than carrying a stopped run on in a directory it was not opened in", async () => {
    const stopped = await stoppedByAClose();
    // The workspace moved while EO was closed.
    updateRun(handle.db, stopped.id, { cwd: "/somewhere/it/used/to/be" });

    const start = vi.fn<AgentProvider["start"]>(async function* () {
      yield { type: "thread_started", threadId: "a-fresh-thread" };
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const resume = vi.fn<AgentProvider["resume"]>();
    const reopened = createRunSupervisor({ db: handle.db, provider: { ...createFakeProvider({ result: validImplementResult }), start, resume }, limits: LIMITS });
    reopened.start();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await reopened.waitForIdle();

    expect(resume).not.toHaveBeenCalled();
    reopened.stop();
  });
});

describe("a failed run's retry", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  it("waits out a backoff that grows with each failure, and the scheduler says so in the meantime", async () => {
    // Ahead of the real clock, so nothing written with it — the item's
    // own creation — reads as having happened after these failures.
    let clock = Date.now() + 3_600_000;
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(crashMidStreamFixture),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 3 },
      now: () => clock,
    });
    const attempts = () => listRunsForItem(handle.db, item.id).filter((run) => run.status === "failed").length;

    await supervisor.runOnce();
    expect(attempts()).toBe(1);
    const firstEnded = listRunsForItem(handle.db, item.id)[0]!.endedAt!;

    clock += 1_000;
    await supervisor.runOnce();
    expect(attempts()).toBe(1);
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "retry_backoff", until: firstEnded + RETRY_BACKOFF_MS[0] });

    clock = firstEnded + RETRY_BACKOFF_MS[0];
    await supervisor.runOnce();
    expect(attempts()).toBe(2);
    const secondEnded = listRunsForItem(handle.db, item.id).at(-1)!.endedAt!;

    // The second wait is longer than the first.
    clock = secondEnded + RETRY_BACKOFF_MS[0];
    await supervisor.runOnce();
    expect(attempts()).toBe(2);
    expect(supervisor.dispatchBlockerFor(item.id)).toEqual({ kind: "retry_backoff", until: secondEnded + RETRY_BACKOFF_MS[1] });

    clock = secondEnded + RETRY_BACKOFF_MS[1];
    await supervisor.runOnce();
    expect(attempts()).toBe(3);
  });

  it("does not wait out a failure that spent the last attempt: the limit's escalation comes at once", async () => {
    let clock = Date.now() + 3_600_000;
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(crashMidStreamFixture),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 1 },
      now: () => clock,
    });
    await supervisor.runOnce();
    clock += 1_000;

    expect(supervisor.dispatchBlockerFor(item.id)).toBeNull();
    await supervisor.runOnce();
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation")?.body).toContain("attempt");
  });

  it("does not turn away a person who asks for the step again while a retry is waiting", async () => {
    let clock = Date.now() + 3_600_000;
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(crashMidStreamFixture), limits: LIMITS, now: () => clock });
    await supervisor.runOnce();
    clock += 1_000;
    expect(supervisor.dispatchBlockerFor(item.id)?.kind).toBe("retry_backoff");

    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: `@${implementer.name} try that again`,
      mentions: [{ type: "agent", agentId: implementer.id }],
    });
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("EO waits until"))).toBe(false);
    expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(1);
  });

  it("owes nothing to the failure once the item has entered its step again", async () => {
    let clock = Date.now() - 1_000;
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(crashMidStreamFixture), limits: LIMITS, now: () => clock });
    await supervisor.runOnce();
    clock += 1;
    expect(supervisor.dispatchBlockerFor(item.id)?.kind).toBe("retry_backoff");

    // Sent back to the step — a new initiation, as a move always is.
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });

    expect(supervisor.dispatchBlockerFor(item.id)).toBeNull();
  });
});
