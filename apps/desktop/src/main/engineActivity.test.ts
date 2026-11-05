import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "@eo/core";
import type { DbHandle } from "./db/client.js";
import { createRoute, createRun, createStep, getItem, listAgents, listRunsForItem, postComment, setSetting, updateRun } from "./db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "./db/testHelpers.js";
import { createEngine } from "./engine.js";
import { persistEnginePause } from "./engineActivity.js";
import { pauseEngine, resumeEngine } from "./ipc/domainCommands.js";
import { sendAgentWrite } from "./mcp/writeBridge.js";
import { createFakeProvider } from "./providers/fake.js";
import { validImplementResult } from "./providers/fixtures.js";
import { createShutdownCoordinator } from "./shutdownCoordinator.js";
import { setBranchPrefix } from "./packs/developer/workspace/branchPrefix.js";
import { startTestWriteBridge, type TestWriteBridge } from "./testing/agentWrites.js";

describe("persistent engine activity preference", () => {
  let handle: DbHandle;
  /** Where an agent's comment reaches the engine, as a real `eo` server's does (EO-543). */
  let writes: TestWriteBridge;

  beforeEach(async () => {
    writes = await startTestWriteBridge();
    handle = openMigratedTestDb();
    setBranchPrefix(handle.db, "eo");
    // A step whose action is `intake`: the action outlived its column
    // (ARCHITECTURE.md, "A column is a responsibility, not a status"). These tests are about
    // restart mechanics and want a dispatch
    // that needs no worktree — `createWorktreeWorkspace` refuses a
    // repo-less story on purpose, since an implementer with nowhere to
    // write is useless, and the items below have no repository.
    createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -1, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
    createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "todo", position: 0 });
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  it("restores pause before the first automatic tick or manual resume", async () => {
    const first = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: createFakeProvider({ result: validImplementResult }),
    });
    pauseEngine(handle.db, first, { cancelRunning: false });
    first.stop();

    createTestItem(handle.db, { type: "story", title: "Automatic", stepId: "todo" });
    const parkedItem = createTestItem(handle.db, { type: "story", title: "Manual", stepId: "ready_to_merge" });
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const parked = createRun(handle.db, {
      itemId: parkedItem.id,
      agentId: implementer.id,
      action: "implement",
      threadId: "thread-before-restart",
    });
    updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: 1, endedAt: 2 });
    postComment(handle.db, { itemId: parkedItem.id, author: { type: "human" }, body: "Continue after restart." });

    const inner = createFakeProvider({ result: validImplementResult });
    const start = vi.fn(inner.start.bind(inner));
    const resume = vi.fn(inner.resume.bind(inner));
    const restored = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start, resume },
    });

    expect(restored.isPaused()).toBe(true);
    restored.start();
    await restored.resumeItem(parkedItem.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();

    resumeEngine(handle.db, restored);
    await vi.waitFor(() => expect(start.mock.calls.length + resume.mock.calls.length).toBeGreaterThan(0));
    expect(restored.isPaused()).toBe(false);
    await restored.runOnce();
    restored.stop();
  });

  it("forced close cancels an active corrective resume, and a system agent's is carried on in its own thread when EO reopens paused", async () => {
    const item = createTestItem(handle.db, { type: "feature", title: "Interrupted work", stepId: "ask" });
    const correctiveResume = vi.fn<AgentProvider["resume"]>(async function* (_threadId, _message, opts) {
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", resolve, { once: true });
      });
      // Some backends wind down with a normal terminal result after an
      // interrupt. The forced cancellation must remain authoritative.
      yield { type: "result", data: { ready: true, understanding: "Never reached", decisions: [] } };
    });
    const firstProvider: AgentProvider = {
      async *start() {
        yield { type: "thread_started", threadId: "corrective-thread" };
        yield { type: "result", data: { malformed: true } };
      },
      resume: correctiveResume,
    };
    const first = createEngine({ db: handle.db, eoMcpServerPath: "/unused", provider: firstProvider });
    first.start();
    await vi.waitFor(() => expect(correctiveResume).toHaveBeenCalledOnce());
    expect(first.activeRunCount()).toBe(1);

    const quit = vi.fn();
    const shutdown = createShutdownCoordinator({
      engine: first,
      showActiveRunsDialog: async () => "cancel-and-close",
      persistPause: () => persistEnginePause(handle.db),
      stopBackgroundServices: vi.fn(),
      quit,
    });
    shutdown.requestClose({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    expect(correctiveResume.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    // Stopped by the close, so carried on later rather than counted.
    expect(listRunsForItem(handle.db, item.id)[0]).toMatchObject({ interruption: "quit", threadId: "corrective-thread" });

    const nextInner = createFakeProvider({
      result: { ready: true, understanding: "Carried on", decisions: [] },
    });
    const start = vi.fn(nextInner.start.bind(nextInner));
    const resume = vi.fn(nextInner.resume.bind(nextInner));
    const reopened = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start, resume },
    });
    expect(reopened.isPaused()).toBe(true);
    reopened.start();
    // The step this ran on is the system role's, so it does not wait for
    // the resume (EO-615). Anybody else's does: `pausedSystemAgent.test.ts`.
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    await reopened.waitForIdle();
    expect(reopened.isPaused()).toBe(true);
    // In the thread it was cut off in, told why — not a fresh session.
    expect(start).not.toHaveBeenCalled();
    expect(resume.mock.calls[0]?.[0]).toBe("corrective-thread");
    expect(resume.mock.calls[0]?.[1]).toContain("EO was closed while you were working");
    const stopped = listRunsForItem(handle.db, item.id)[0]!;
    const continuation = listRunsForItem(handle.db, item.id).find((run) => run.id !== stopped.id);
    expect(continuation).toMatchObject({ threadId: "corrective-thread", initiationId: stopped.initiationId, attempt: stopped.attempt });
    reopened.stop();
  });

  it("restarts an interrupted manual reply even when its human-owned item cannot be scheduled", async () => {
    // The resumed run below is attempt 2, exhausting the old initiation.
    // Its forced replacement must therefore have a fresh allowance too.
    setSetting(handle.db, "engine.guards", { perItemAttemptLimit: 2 });
    // A step the scheduler will not dispatch — the point of the test is
    // that a manual reply restarts anyway. `ready_to_merge` is a `user`
    // step and terminal, which is as unschedulable as it gets.
    const item = createTestItem(handle.db, {
      type: "feature",
      title: "Manual approval question",
      stepId: "ready_to_merge",
    });
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@reviewer explain this before I approve",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });

    const activeResume = vi.fn<AgentProvider["resume"]>(async function* (_threadId, _message, opts) {
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", resolve, { once: true });
      });
      yield { type: "result", data: { message: "This late result must stay cancelled." } };
    });
    // The reviewer asks the person back, and parks on it. The question is
    // a blocking comment made the way a real one is (EO-543): handed to
    // EO over the turn's write bridge while the call is open, which is
    // what ends the run — not the `tool_call` in the stream.
    const question = { body: "@user which part should I clarify?", mentions: ["user"], blocking: true };
    const firstProvider: AgentProvider = {
      async *start(opts) {
        yield { type: "thread_started", threadId: "manual-thread" };
        yield { type: "tool_call", name: "comment", args: question, callId: "call-1" };
        if (opts.writeBridge === undefined) throw new Error("the turn was given no agent write bridge, so its question could not be asked");
        await sendAgentWrite(opts.writeBridge, { tool: "comment", args: question });
      },
      resume: activeResume,
    };
    const first = createEngine({ db: handle.db, eoMcpServerPath: "/unused", provider: firstProvider, agentWriteBridge: writes.agentWriteBridge });
    writes.serve(first);
    await first.runOnce();
    expect(listRunsForItem(handle.db, item.id).find((run) => run.threadId === "manual-thread")).toMatchObject({
      action: "respond",
      status: "awaiting_input",
      threadId: "manual-thread",
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "The cancellation behavior.",
    });
    const resumed = first.resumeItem(item.id);
    await vi.waitFor(() => expect(activeResume).toHaveBeenCalledOnce());
    expect(first.activeRunCount()).toBe(1);
    expect(listRunsForItem(handle.db, item.id).at(-1)?.attempt).toBe(2);

    const quit = vi.fn();
    const shutdown = createShutdownCoordinator({
      engine: first,
      showActiveRunsDialog: async () => "cancel-and-close",
      persistPause: () => persistEnginePause(handle.db),
      stopBackgroundServices: vi.fn(),
      quit,
    });
    shutdown.requestClose({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
    await resumed;

    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual([
      "awaiting_input",
      "cancelled",
    ]);
    // Stopped by the close, not failed: carried on later, and not an attempt spent.
    expect(listRunsForItem(handle.db, item.id).at(-1)?.interruption).toBe("quit");
    expect(activeResume.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

    // Reopened, it carries the reply on in the thread it was cut off in
    // — told why — rather than starting the conversation over.
    const freshProvider = createFakeProvider({ result: { message: "unused" } });
    const forbiddenStart = vi.fn(freshProvider.start.bind(freshProvider));
    const carriedOn = vi.fn<AgentProvider["resume"]>(async function* () {
      yield { type: "thread_started", threadId: "manual-thread" };
      yield { type: "result", data: { message: "It is cancelled before EO exits." } };
    });
    const reopened = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start: forbiddenStart, resume: carriedOn },
    });
    expect(reopened.isPaused()).toBe(true);
    reopened.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(carriedOn).not.toHaveBeenCalled();

    resumeEngine(handle.db, reopened);
    await vi.waitFor(() => expect(carriedOn).toHaveBeenCalledOnce());
    await reopened.waitForIdle();

    expect(forbiddenStart).not.toHaveBeenCalled();
    expect(carriedOn.mock.calls[0]?.[0]).toBe("manual-thread");
    expect(carriedOn.mock.calls[0]?.[1]).toContain("EO was closed while you were working");
    expect(listRunsForItem(handle.db, item.id).at(-1)).toMatchObject({
      action: "respond",
      agentId: reviewer.id,
      status: "succeeded",
      threadId: "manual-thread",
      attempt: 2,
      interruption: null,
    });
    // Answering a question is not pipeline progress: it stays put.
    expect(getItem(handle.db, item.id)?.stepId).toBe("ready_to_merge");
    reopened.stop();
  });

  it("keeps one restart intent when an uncooperative replacement is force-closed again", async () => {
    const item = createTestItem(handle.db, {
      type: "feature",
      title: "Repeated destructive close",
      stepId: "ask",
    });
    const result = { ready: true, understanding: "Carried on", decisions: [] };

    const firstStart = vi.fn<AgentProvider["start"]>(async function* (input) {
      yield { type: "thread_started", threadId: "first-interrupted-thread" };
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", resolve, { once: true });
      });
      yield { type: "result", data: result };
    });
    const fake = createFakeProvider({ result });
    const first = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start: firstStart, resume: fake.resume.bind(fake) },
    });
    first.start();
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledOnce());

    const firstQuit = vi.fn();
    createShutdownCoordinator({
      engine: first,
      showActiveRunsDialog: async () => "cancel-and-close",
      persistPause: () => persistEnginePause(handle.db),
      stopBackgroundServices: vi.fn(),
      quit: firstQuit,
    }).requestClose({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(firstQuit).toHaveBeenCalledOnce());

    let releaseReplacement!: () => void;
    const replacementReleased = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    // The stopped run is carried on in its own thread, and this
    // continuation ignores both its AbortSignal and interrupt: forced
    // cleanup must time out while it remains in flight.
    const uncooperativeResume = vi.fn<AgentProvider["resume"]>(async function* () {
      await replacementReleased;
      yield { type: "result", data: result };
    });
    const replacementStart = vi.fn<AgentProvider["start"]>();
    const replacement = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start: replacementStart, resume: uncooperativeResume },
    });
    replacement.start();
    resumeEngine(handle.db, replacement);
    await vi.waitFor(() => expect(uncooperativeResume).toHaveBeenCalledOnce());
    expect(uncooperativeResume.mock.calls[0]?.[0]).toBe("first-interrupted-thread");

    const replacementQuit = vi.fn();
    const secondShutdown = createShutdownCoordinator({
      engine: replacement,
      showActiveRunsDialog: async () => "cancel-and-close",
      persistPause: () => persistEnginePause(handle.db),
      stopBackgroundServices: vi.fn(),
      quit: replacementQuit,
    });
    vi.useFakeTimers();
    try {
      secondShutdown.requestClose({ preventDefault: vi.fn() });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2000);
      expect(replacementQuit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }

    const finalResume = vi.fn<AgentProvider["resume"]>(async function* (_threadId, _message, opts) {
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) resolve();
        else opts?.signal?.addEventListener("abort", resolve, { once: true });
      });
      yield { type: "result", data: result };
    });
    const finalStart = vi.fn<AgentProvider["start"]>();
    const reopened = createEngine({
      db: handle.db,
      eoMcpServerPath: "/unused",
      provider: { start: finalStart, resume: finalResume },
    });
    expect(reopened.isPaused()).toBe(true);
    reopened.start();
    resumeEngine(handle.db, reopened);
    await vi.waitFor(() => expect(finalResume).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));

    // One intent survived two closes: carried on once, in the same thread.
    expect(finalResume).toHaveBeenCalledOnce();
    expect(finalResume.mock.calls[0]?.[0]).toBe("first-interrupted-thread");
    expect(replacementStart).not.toHaveBeenCalled();
    expect(finalStart).not.toHaveBeenCalled();

    await reopened.shutdown();
    releaseReplacement();
    await replacement.waitForIdle();
    const onTheThread = listRunsForItem(handle.db, item.id).filter((run) => run.threadId === "first-interrupted-thread");
    // The run the first close stopped, and one continuation per reopen —
    // every one of them cut short by EO closing, and none an attempt.
    expect(onTheThread).toHaveLength(3);
    expect(onTheThread.every((run) => run.interruption === "quit")).toBe(true);
  });
});
