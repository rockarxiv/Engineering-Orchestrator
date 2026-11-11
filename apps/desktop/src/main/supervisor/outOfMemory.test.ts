import type { AgentEvent, AgentProvider, AgentProviderStartOptions, Item, StepWatch, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { createStep, getItemWatch, listCommentsForItem, listRunsForItem, postComment } from "../db/repos/index.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { RunOutOfMemory } from "../process/runScope.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { hourlyClock } from "../testing/clock.js";
import type { BuiltinRunner } from "./builtins.js";
import { isOutOfMemoryStop, outOfMemoryStop } from "./outOfMemory.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 2, perAgentConcurrency: 2, perRepositoryConcurrency: 2 };

/** A backend whose every turn opens a thread and then dies the way a CLI its scope stopped dies. */
function providerKilled(how: "error event" | "throw") {
  const fake = createFakeProvider({ result: validImplementResult });
  const starts: AgentProviderStartOptions[] = [];
  const stream = (opts: AgentProviderStartOptions) => {
    starts.push(opts);
    return (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "thread_started", threadId: `thr_${starts.length}` };
      if (how === "throw") throw new Error("Claude Code process exited with code 143");
      yield { type: "error", message: "Codex app-server exited with signal SIGTERM", retryable: true };
    })();
  };
  const provider: AgentProvider = { ...fake, start: stream, resume: (_thread, _message, opts) => stream(opts as AgentProviderStartOptions) };
  return { provider, starts };
}

const killed = (runId: string, overrides: Partial<RunOutOfMemory> = {}): RunOutOfMemory => ({
  runId,
  unit: `eo-run-${runId}.scope`,
  memoryMaxMb: 3_072,
  limitReached: true,
  killed: { pid: 4242, name: "node-MainThread", how: "kernel" },
  ...overrides,
});

/**
 * A run that ran out of memory (EO-738): its scope was stopped by the
 * kernel or by systemd, and the run ended because its CLI died. It ends
 * failed and says why, is not an attempt, and is not tried again: the
 * item parks and asks.
 */
describe("a run that runs out of memory", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
  });

  for (const how of ["error event", "throw"] as const) {
    it(`ends failed, names the limit and the process killed, and parks without trying again (CLI ending on an ${how})`, async () => {
      const { provider, starts } = providerKilled(how);
      const asked: string[] = [];
      const supervisor = createRunSupervisor({
        db: handle.db,
        provider,
        limits: LIMITS,
        guards: { perItemAttemptLimit: 3, runMemoryMaxMb: 3_072 },
        now: hourlyClock(),
        outOfMemory: async (runId) => {
          asked.push(runId);
          return killed(runId);
        },
      });

      for (let i = 0; i < 4; i++) await supervisor.runOnce();

      expect(starts).toHaveLength(1); // never retried into the same wall
      const runs = listRunsForItem(handle.db, item.id);
      const failed = runs.filter((run) => run.status === "failed");
      expect(failed).toHaveLength(1);
      expect(asked).toEqual([failed[0]!.id]);
      expect(isOutOfMemoryStop(failed[0]!.error)).toBe(true);
      expect(failed[0]!.error).toContain("3,072 MB");
      expect(failed[0]!.error).toContain("`node-MainThread` (process 4242)");
      expect(failed[0]!.error).toContain("not counted as an attempt");

      // Parked the way a guard parks: a placeholder waiting on a person,
      // and the same sentence in the thread, mentioning them.
      const parked = runs.filter((run) => run.status === "awaiting_input");
      expect(parked).toHaveLength(1);
      expect(parked[0]!.threadId).toBeNull();
      expect(needsAttention(handle.db, item.id)).toBe(true);
      const escalations = handle.db.select().from(comments).all().filter((comment) => comment.kind === "escalation");
      expect(escalations).toHaveLength(1);
      expect(escalations[0]!.body).toBe(failed[0]!.error);
      expect(escalations[0]!.body).toContain("reply to try again");
    });
  }

  it("hands every turn the run and its memory limit", async () => {
    const { provider, starts } = providerKilled("error event");
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      guards: { runMemoryMaxMb: 5_000 },
      now: hourlyClock(),
      outOfMemory: async (runId) => killed(runId),
    });
    await supervisor.runOnce();
    const [run] = listRunsForItem(handle.db, item.id);
    expect(starts[0]?.processScope).toEqual({ runId: run!.id, memoryMaxMb: 5_000 });
  });

  it("is still an ordinary failure, retried, when the scope says it did not run out", async () => {
    const { provider, starts } = providerKilled("error event");
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      guards: { perItemAttemptLimit: 3 },
      now: hourlyClock(),
      outOfMemory: async () => null,
    });
    for (let i = 0; i < 5; i++) await supervisor.runOnce();
    expect(starts).toHaveLength(3);
    expect(listRunsForItem(handle.db, item.id).filter((run) => run.status === "failed").every((run) => !isOutOfMemoryStop(run.error))).toBe(true);
  });

  it("does not count against the attempt limit", async () => {
    // Two ordinary failures, then one out of memory, then the person
    // replies: had the out-of-memory run counted, the attempt limit of 3
    // would have stopped the third run before it started.
    let calls = 0;
    const { provider, starts } = providerKilled("error event");
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      guards: { perItemAttemptLimit: 3 },
      now: hourlyClock(),
      outOfMemory: async (runId) => (++calls === 2 ? killed(runId) : null),
    });
    for (let i = 0; i < 4; i++) await supervisor.runOnce();
    expect(starts).toHaveLength(2);
    const runs = listRunsForItem(handle.db, item.id);
    const initiation = runs[0]!.initiationId;
    const counted = runs.filter((run) => run.initiationId === initiation && run.status === "failed" && !isOutOfMemoryStop(run.error));
    expect(counted).toHaveLength(1);
    expect(runs.some((run) => run.status === "awaiting_input")).toBe(true);
  });
});

/**
 * A module run whose host ran out of memory (EO-738): the same ending as
 * an agent's run — `failed`, said, parked on a run of its own and not
 * tried again — whether the step runs once or keeps checking.
 */
describe("a module run that runs out of memory", () => {
  let handle: DbHandle;
  let item: Item;
  let clock: number;

  beforeEach(() => {
    handle = openMigratedTestDb();
    clock = 1_800_000_000_000;
  });

  afterEach(() => {
    handle.close();
  });

  function seed(watch: StepWatch | null): void {
    createStep(handle.db, { id: "mod", pipelineId: "default" as Uuid, position: 15, name: "Build the bundle", type: "module", entryAction: "mod-build", watch });
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "mod" });
  }

  function supervisorWith(host: BuiltinRunner, outOfMemory: (runId: string) => Promise<RunOutOfMemory | null>) {
    return createRunSupervisor({
      db: handle.db,
      provider: { start: () => { throw new Error("a module run must not reach a provider"); } } as never,
      limits: LIMITS,
      now: () => clock,
      moduleRunner: (id: string) => (id === "mod-build" ? host : undefined),
      guards: { interpretReplies: false, runMemoryMaxMb: 3_072 },
      outOfMemory,
    });
  }

  /** How a host its scope stopped looks from inside: the process went, mid-run. */
  const diedMidRun: BuiltinRunner = async () => ({ ok: false, reason: "The module's host exited with signal SIGKILL before it answered." });

  it("ends failed, names the limit and the process, and parks on a run of its own without trying again", async () => {
    seed(null);
    const host = vi.fn<BuiltinRunner>(diedMidRun);
    const asked: string[] = [];
    const supervisor = supervisorWith(host, async (runId) => {
      asked.push(runId);
      return killed(runId);
    });

    for (let i = 0; i < 3; i++) await supervisor.runOnce();

    expect(host).toHaveBeenCalledTimes(1);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["failed", "awaiting_input"]);
    const [failed, parked] = runs;
    expect(asked).toEqual([failed!.id]);
    expect(isOutOfMemoryStop(failed!.error)).toBe(true);
    expect(failed!.error).toContain('"mod-build" reached the run\'s memory limit of 3,072 MB');
    expect(failed!.error).toContain("`node-MainThread` (process 4242)");
    expect(parked!.error).toBe(failed!.error);
    expect(needsAttention(handle.db, item.id)).toBe(true);
    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.body).toBe(failed!.error);
    expect(escalations[0]!.runId).toBe(parked!.id);
  });

  it("is a module failure like any other when its scope did not run out", async () => {
    seed(null);
    const supervisor = supervisorWith(diedMidRun, async () => null);
    await supervisor.runOnce();
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["awaiting_input"]);
    expect(isOutOfMemoryStop(runs[0]!.error)).toBe(false);
  });

  it("on a step that keeps checking, parks at the first check that ran out instead of retrying it, and watches again once a person replies", async () => {
    seed({ everyMinutes: 5, giveUpAfterHours: 168 });
    let outOfMemoryNext = true;
    const host = vi.fn<BuiltinRunner>(async (context) =>
      outOfMemoryNext ? diedMidRun(context) : { ok: true, result: "waiting", detail: "Still building." },
    );
    const supervisor = supervisorWith(host, async (runId) => (outOfMemoryNext ? killed(runId) : null));

    await supervisor.runOnce();
    // Past every backoff a failed check would have had: nothing runs again.
    for (const minutes of [1, 2, 5, 10, 30, 60]) {
      clock += minutes * 60_000;
      await supervisor.runOnce();
    }

    expect(host).toHaveBeenCalledTimes(1);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs.map((run) => run.status)).toEqual(["failed", "awaiting_input"]);
    expect(isOutOfMemoryStop(runs[0]!.error)).toBe(true);
    expect(runs[1]!.error).toBe(runs[0]!.error);
    // Not one of the failures in a row the watch gives up after.
    expect(getItemWatch(handle.db, item.id, "mod")).toMatchObject({ consecutiveFailures: 0, checks: 1, lastError: runs[0]!.error });
    const escalations = listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation");
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.body).toContain(runs[0]!.error!);
    expect(escalations[0]!.runId).toBe(runs[1]!.id);
    expect(needsAttention(handle.db, item.id)).toBe(true);

    // A person lowers the concurrency, say, and replies: watching again.
    outOfMemoryNext = false;
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Lowered the concurrency; try again." });
    await supervisor.resumeItem(item.id);
    expect(host).toHaveBeenCalledTimes(2);
    expect(getItemWatch(handle.db, item.id, "mod")).toMatchObject({ consecutiveFailures: 0, startedAt: clock });
  });
});

describe("the out-of-memory sentence (EO-738)", () => {
  const limit = { setting: null, totalMb: 15_217, globalConcurrency: 3 };
  it("says how EO knows which process was killed", () => {
    const said = (how: "kernel" | "ranked" | "launched") => outOfMemoryStop(killed("r", { killed: { pid: 7, name: "node", how } }), "Implementer", limit);
    expect(said("kernel")).toContain("the kernel killed `node` (process 7)");
    expect(said("ranked")).toContain("most likely `node` (process 7), the one the kernel ranked first when EO last looked");
    expect(said("launched")).toContain("most likely `node` (process 7), the one the run started with");
    expect(said("launched")).toContain("three quarters of its 15,217 MB, shared across a concurrency of 3");
  });
});
