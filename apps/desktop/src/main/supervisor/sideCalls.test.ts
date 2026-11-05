import type { AgentEvent, AgentProvider, MemoryScope, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import { addMemory, consolidationState, listConsolidations, listMemories, postComment, setItemHeld } from "../db/repos/index.js";
import { createRun, listRunsForItem } from "../db/repos/runsRepo.js";
import { listSideCalls } from "../db/repos/sideCallsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge, type TestWriteBridge } from "../testing/agentWrites.js";
import { consolidateNowCommand, listConsolidationsCommand } from "../ipc/memoryCommands.js";
import { recordFor } from "../record/localRecord.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const ANSWER = z.object({ notes: z.array(z.string()) });

/**
 * Side calls and the scheduler (EO-477, invariant 10): one made on its own
 * holds a global slot for as long as it runs, so the tick dispatches
 * nothing into it, and gives it back when it ends; one made inside a
 * run's dispatch uses that run's slot.
 */
describe("side calls on the supervisor", () => {
  let handle: DbHandle;
  let writes: TestWriteBridge;

  beforeEach(async () => {
    handle = openMigratedTestDb();
    // Where an agent's comment reaches EO (EO-543): a run parks only on a
    // blocking comment posted over it.
    writes = await startTestWriteBridge();
  });

  afterEach(async () => {
    await writes.close();
    handle.close();
  });

  /** A side call that answers only when told to. */
  function heldSideCall() {
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const state = { entered: false };
    const provider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        state.entered = true;
        await answered;
        yield { type: "result", data: { notes: [] } } satisfies AgentEvent;
      },
    };
    return { provider, answer, state };
  }

  it("holds the only global slot while a call made on its own runs, so nothing is dispatched into it, and gives it back after", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Waiting its turn", stepId: "todo" });
    const held = heldSideCall();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      sideCalls: { provider: () => held.provider, smallModel: async () => "claude-haiku-5-5" },
    });

    const consolidation = supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "claude", schema: ANSWER, system: "s", input: "i", projectId: item.projectId as Uuid | null, timeoutMs: 5_000 });
    // Running, which is to say holding its slot.
    await vi.waitFor(() => expect(held.state.entered).toBe(true));
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);

    held.answer();
    expect(await consolidation).toEqual({ ok: true, value: { notes: [] } });
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(listSideCalls(handle.db)).toHaveLength(1);
  });

  it("starts a call made on its own only once the run holding the slot has ended", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Running", stepId: "todo" });
    let finishRun: () => void = () => {};
    const runFinished = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const fake = createFakeProvider({ result: validImplementResult });
    const start: AgentProvider["start"] = async function* (opts) {
      await runFinished;
      yield* fake.start(opts);
    };
    const sideCalled = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        sideCalled();
        yield { type: "result", data: { notes: [] } } satisfies AgentEvent;
      },
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...fake, start },
      limits: LIMITS,
      sideCalls: { provider: () => sideCallProvider, smallModel: async () => null },
    });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    const consolidation = supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "claude", schema: ANSWER, system: "s", input: "i", projectId: item.projectId as Uuid | null, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sideCalled).not.toHaveBeenCalled();

    finishRun();
    await tick;
    expect(await consolidation).toMatchObject({ ok: true });
    expect(sideCalled).toHaveBeenCalledOnce();
  });

  /**
   * A reply to a parked run takes no dispatch lease (EO-508), so a gate
   * that counted leases saw the only slot free while the reply's model
   * process was alive, and let a consolidation start beside it.
   */
  it("starts a call made on its own only once a running reply to a parked run, which holds no lease, has ended", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Parked", stepId: "todo" });
    let finishReply: () => void = () => {};
    const replyFinished = new Promise<void>((resolve) => {
      finishReply = resolve;
    });
    const fake = createFakeProvider({
      steps: [{ toolCall: { name: "comment", args: { body: "@user need input", mentions: ["user"], blocking: true } } }, { output: "continuing" }],
      result: validImplementResult,
    });
    let replied = false;
    // The first turn parks; the reply resumes it, and waits until told to end.
    const resume: AgentProvider["resume"] = async function* (threadId, message, opts) {
      replied = true;
      await replyFinished;
      yield* fake.resume(threadId, message, opts);
    };
    const consolidating = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        if (options.system === "consolidate") consolidating();
        yield { type: "result", data: { notes: [] } } satisfies AgentEvent;
      },
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...fake, resume },
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      sideCalls: { provider: () => sideCallProvider, smallModel: async () => null },
    });
    writes.serve(supervisor);
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.status)).toEqual(["awaiting_input"]);

    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "go ahead" });
    const replying = supervisor.resumeItem(item.id);
    await vi.waitFor(() => expect(replied).toBe(true));
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status === "running")).toBe(true);

    const consolidation = supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "claude", schema: ANSWER, system: "consolidate", input: "i", projectId: item.projectId as Uuid | null, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(consolidating).not.toHaveBeenCalled();

    finishReply();
    await replying;
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status === "queued" || run.status === "running")).toBe(false);
    expect(await consolidation).toEqual({ ok: true, value: { notes: [] } });
    expect(consolidating).toHaveBeenCalledOnce();
  });

  it("lets a call made inside a run go while that run holds the only slot", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Dispatched", stepId: "todo" });
    let sideCallResult: unknown;
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        yield { type: "result", data: { notes: ["a note"] } } satisfies AgentEvent;
      },
    };
    const fake = createFakeProvider({ result: validImplementResult });
    // The run's own turn makes the call, as selection does during dispatch.
    const supervisor: RunSupervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        ...fake,
        async *start(opts) {
          const runId = listRunsForItem(handle.db, item.id)[0]!.id;
          sideCallResult = await supervisor.sideCall({ purpose: "memory_select", backend: "claude", schema: ANSWER, system: "s", input: "i", projectId: item.projectId as Uuid | null, timeoutMs: 2_000, insideRunId: runId });
          yield* fake.start(opts);
        },
      },
      limits: LIMITS,
      sideCalls: { provider: () => sideCallProvider, smallModel: async () => null },
    });

    await supervisor.runOnce();

    expect(sideCallResult).toEqual({ ok: true, value: { notes: ["a note"] } });
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  /**
   * The engine hands the supervisor its keyring preflight (EO-509); the
   * supervisor has to pass it on to the side caller, or the refusal comes
   * from inside the adapter as an `error` after all.
   */
  it("refuses a call whose sign-in cannot reach its own home as `sign_in_unreachable`, before any sign-in probe, model lookup or call", async () => {
    const sideCalled = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall() {
        sideCalled();
        yield { type: "result", data: { notes: [] } } satisfies AgentEvent;
      },
    };
    const signedIn = vi.fn(async () => true);
    const smallModel = vi.fn(async () => null);
    const sentence = 'Set cli_auth_credentials_store = "file" and sign in to Codex again.';
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      sideCalls: { provider: () => sideCallProvider, smallModel, signedIn, signInUnreachable: (backend) => (backend === "codex" ? sentence : null) },
    });

    const refused = await supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "codex", schema: ANSWER, system: "s", input: "i", projectId: null, timeoutMs: 5_000 });

    expect(refused).toEqual({ ok: false, reason: "sign_in_unreachable", message: sentence });
    expect(signedIn).not.toHaveBeenCalled();
    expect(smallModel).not.toHaveBeenCalled();
    expect(sideCalled).not.toHaveBeenCalled();
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ backend: "codex", outcome: "failed", reason: "sign_in_unreachable" })]);

    // Another backend's call is made as usual.
    expect(await supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "claude", schema: ANSWER, system: "s", input: "i", projectId: null, timeoutMs: 5_000 })).toEqual({
      ok: true,
      value: { notes: [] },
    });
    expect(sideCalled).toHaveBeenCalledOnce();
  });

  it("stops a call in flight when EO shuts down", async () => {
    const held = heldSideCall();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      sideCalls: { provider: () => held.provider, smallModel: async () => null },
    });
    const pending = supervisor.sideCall({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null }, backend: "claude", schema: ANSWER, system: "s", input: "i", projectId: null, timeoutMs: 60_000 });

    await supervisor.shutdown();

    expect(await pending).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shut down") });
  });

  /**
   * Consolidation waits for an idle pipeline (EO-577): while an item is
   * queued to be dispatched, or its run is going, none starts — and none
   * waits in line for the slot either, which is what made the next
   * dispatch wait behind it. Once nothing is waiting and nothing runs, it
   * starts, without waiting for its next look.
   */
  it("starts no memory consolidation while an item is queued or its run is going, and starts one once the pipeline is idle", async () => {
    const repository = attachWorkspace(handle.db, { keyPrefix: "API", name: "api", repoPath: "/nonexistent/api" });
    const scope: MemoryScope = { kind: "project", id: repository.projectId! };
    // Where the entries came from: a run on a feature, which sits on no step and is never dispatched.
    const source = createTestItem(handle.db, { type: "feature", title: "Earlier work", stepId: null, projectId: repository.projectId! });
    const sourceRun = createRun(handle.db, { itemId: source.id, agentId: null, action: "implement", stepId: null, status: "succeeded" });
    for (let index = 0; index < 11; index += 1) {
      const written = addMemory(handle.db, { scope, body: `Note ${index}`, source: { type: "run", runId: sourceRun.id, itemId: source.id }, now: Date.now() - 60_000 + index });
      if (!written.ok) throw new Error(written.problem);
    }
    const queued = createTestItem(handle.db, { type: "story", title: "Queued", stepId: "todo" });
    let finishRun: () => void = () => {};
    const runFinished = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const fake = createFakeProvider({ result: validImplementResult });
    const start: AgentProvider["start"] = async function* (opts) {
      await runFinished;
      // Parked once its run is done, so nothing is left waiting after it.
      setItemHeld(handle.db, queued.id, Date.now());
      yield* fake.start(opts);
    };
    const consolidating = vi.fn();
    const sideCallProvider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        consolidating(options.system);
        yield { type: "result", data: options.system.startsWith("You read the memory") ? { skills: [] } : { retire: [], merge: [], rewrite: [] } } satisfies AgentEvent;
      },
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...fake, start },
      limits: LIMITS,
      guards: { memoryScopeMaxEntries: 10 },
      tickIntervalMs: 3_600_000,
      watchdogIntervalMs: 3_600_000,
      sideCalls: { provider: () => sideCallProvider, smallModel: async () => "claude-haiku-5-5" },
      // Looked at every few milliseconds: plenty of chances to start too early.
      memoryConsolidation: { intervalMs: 5 },
    });
    supervisor.start();
    try {
      await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(consolidating).not.toHaveBeenCalled();
      // Not started, and not recorded as anything: it has not begun.
      expect(listConsolidations(handle.db, scope)).toEqual([]);
      expect(listSideCalls(handle.db)).toEqual([]);

      finishRun();
      await vi.waitFor(() => expect(consolidating).toHaveBeenCalled());
      await vi.waitFor(() => expect(listConsolidations(handle.db, scope)[0]).toMatchObject({ status: "succeeded" }));
      expect(listRunsForItem(handle.db, queued.id).every((run) => run.status !== "queued" && run.status !== "running")).toBe(true);
    } finally {
      await supervisor.shutdown();
    }
  });

  /**
   * Pausing stops EO's own housekeeping as well as what has yet to start
   * (EO-514): a memory consolidation already running is stopped, changes
   * nothing, says why, and gives its global slot back — so the next
   * dispatch after resuming is not held behind a call nobody is owed.
   */
  it("stops a running memory consolidation when the engine is paused, and frees its slot", async () => {
    // A backend that answers nothing until it is stopped, and then stops,
    // as both adapters do when the call's signal is aborted.
    const held = { state: { entered: false }, provider: {} as AgentProvider };
    held.provider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        held.state.entered = true;
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // Nothing said before it stops.
        yield* [] as AgentEvent[];
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      },
    };
    const repository = attachWorkspace(handle.db, { keyPrefix: "API", name: "api", repoPath: "/nonexistent/api" });
    const scope: MemoryScope = { kind: "project", id: repository.projectId! };
    // Where the entries came from: a run on a feature, which sits on no step and is never dispatched.
    const source = createTestItem(handle.db, { type: "feature", title: "Earlier work", stepId: null, projectId: repository.projectId! });
    const sourceRun = createRun(handle.db, { itemId: source.id, agentId: null, action: "implement", stepId: null, status: "succeeded" });
    for (let index = 0; index < 11; index += 1) {
      const written = addMemory(handle.db, { scope, body: `Note ${index}`, source: { type: "run", runId: sourceRun.id, itemId: source.id }, now: Date.now() - 60_000 + index });
      if (!written.ok) throw new Error(written.problem);
    }
    const before = listMemories(handle.db, scope).map((entry) => entry.id);
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      guards: { memoryScopeMaxEntries: 10 },
      tickIntervalMs: 3_600_000,
      watchdogIntervalMs: 3_600_000,
      sideCalls: { provider: () => held.provider, smallModel: async () => "claude-haiku-5-5" },
    });
    supervisor.start();
    try {
      // The consolidation is running, which is to say holding the only slot.
      await vi.waitFor(() => expect(held.state.entered).toBe(true));
      const item = createTestItem(handle.db, { type: "story", title: "Waiting its turn", stepId: "todo" });

      supervisor.pause();

      await vi.waitFor(() => expect(consolidationState(handle.db, scope).failuresSince[0]?.reason).toBe("paused"));
      expect(listConsolidations(handle.db, scope)[0]).toMatchObject({ status: "failed", note: expect.stringContaining("EO was paused") });
      expect(listMemories(handle.db, scope).map((entry) => entry.id)).toEqual(before);

      // Given back, though the call never answered.
      supervisor.resume();
      await supervisor.runOnce();
      await vi.waitFor(() => expect(listRunsForItem(handle.db, item.id)).toHaveLength(1));
    } finally {
      await supervisor.shutdown();
    }
  });

  /**
   * A person asking for a scope to be consolidated now (EO-589), through
   * the channel's command: the supervisor hands it to its consolidator,
   * which runs it as `manual` though the scope is far under its caps, and
   * says so while it is pending and when it ends.
   */
  it("consolidates a scope under its caps when asked through memory:consolidateNow, recorded as manual, and refuses while paused", async () => {
    const repository = attachWorkspace(handle.db, { keyPrefix: "API", name: "api", repoPath: "/nonexistent/api" });
    const scope: MemoryScope = { kind: "project", id: repository.projectId! };
    const source = createTestItem(handle.db, { type: "feature", title: "Earlier work", stepId: null, projectId: repository.projectId! });
    const sourceRun = createRun(handle.db, { itemId: source.id, agentId: null, action: "implement", stepId: null, status: "succeeded" });
    for (let index = 0; index < 3; index += 1) {
      const written = addMemory(handle.db, { scope, body: `Note ${index}`, source: { type: "run", runId: sourceRun.id, itemId: source.id }, now: Date.now() - 60_000 + index });
      if (!written.ok) throw new Error(written.problem);
    }
    // Holds the consolidation's call until told, then answers a change of
    // nothing; the skill proposal call after it proposes nothing.
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const held = { state: { entered: false }, answer: () => answer() };
    const provider: AgentProvider = {
      ...createFakeProvider({}),
      async *sideCall(options) {
        if (options.system.startsWith("You read the memory")) {
          yield { type: "result", data: { skills: [] } } satisfies AgentEvent;
          return;
        }
        held.state.entered = true;
        await answered;
        yield { type: "result", data: { retire: [], merge: [], rewrite: [] } } satisfies AgentEvent;
      },
    };
    const changed = vi.fn();
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
      tickIntervalMs: 3_600_000,
      watchdogIntervalMs: 3_600_000,
      sideCalls: { provider: () => provider, smallModel: async () => "claude-haiku-5-5" },
      onMemoryConsolidationChanged: changed,
    });
    // Not running yet: nothing consolidates here.
    expect(consolidateNowCommand(supervisor, { scope })).toMatchObject({ outcome: "refused", reason: "unavailable" });
    supervisor.start();
    try {
      supervisor.pause();
      expect(consolidateNowCommand(supervisor, { scope })).toMatchObject({ outcome: "refused", reason: "paused" });
      supervisor.resume();

      const asked = consolidateNowCommand(supervisor, { scope });
      expect(asked).toMatchObject({ outcome: "started" });
      expect(changed).toHaveBeenCalledWith(scope);
      await vi.waitFor(() => expect(held.state.entered).toBe(true));
      expect((await listConsolidationsCommand(recordFor(handle.db), { scope }, supervisor)).pending).toBe("running");
      expect(consolidateNowCommand(supervisor, { scope })).toMatchObject({ outcome: "already", state: "running" });

      held.answer();
      await vi.waitFor(() => expect(listConsolidations(handle.db, scope)[0]).toMatchObject({ trigger: "manual", status: "succeeded" }));
      await vi.waitFor(async () => expect((await listConsolidationsCommand(recordFor(handle.db), { scope }, supervisor)).pending).toBeNull());
      expect(listConsolidations(handle.db, scope)).toHaveLength(1);
    } finally {
      await supervisor.shutdown();
    }
  });
});
