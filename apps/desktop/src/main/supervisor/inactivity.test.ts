import { uuidv7, type AgentEvent, type AgentProvider, type AgentProviderStartOptions, type Item } from "@eo/core";
import { addItemAttachments } from "../db/repos/attachmentsRepo.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { listRunsForItem } from "../db/repos/runsRepo.js";
import { listRunEvents } from "../db/repos/runEventsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const MINUTE = 60_000;
const LIMIT = 10 * MINUTE;

/**
 * The inactivity guard (`watchLiveRuns`): a run whose backend has gone
 * quiet is stopped and says so, a run that is working is not, and a run
 * that went quiet across a sleep is carried on rather than stopped —
 * the way Claude Desktop watches its sessions.
 */
describe("a run whose backend goes quiet", () => {
  let handle: DbHandle;
  let item: Item;
  let clock: number;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    clock = Date.now() + 3_600_000;
  });

  afterEach(() => {
    handle.close();
  });

  /** A backend that says `first`, then nothing until it is stopped. */
  function quietAfter(first: AgentEvent[], onStopped?: () => void): AgentProvider["start"] {
    return async function* (input: AgentProviderStartOptions) {
      yield { type: "thread_started", threadId: "the-quiet-thread" };
      for (const event of first) yield event;
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve();
        else input.signal.addEventListener("abort", resolve, { once: true });
      });
      onStopped?.();
      // As both backends end a turn they were stopped in.
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    };
  }

  /** Lets `ms` go by the way the app does: a watchdog pass every thirty seconds. */
  function passTime(supervisor: { watchLiveRuns: () => void }, ms: number): void {
    for (let gone = 0; gone < ms; gone += 30_000) {
      clock += 30_000;
      supervisor.watchLiveRuns();
    }
  }

  function supervisorWith(start: AgentProvider["start"], resume?: AgentProvider["resume"]) {
    return createRunSupervisor({
      db: handle.db,
      provider: { ...createFakeProvider({ result: validImplementResult }), start, ...(resume ? { resume } : {}) },
      limits: LIMITS,
      guards: { inactivityTimeoutMs: LIMIT },
      now: () => clock,
    });
  }

  it("is stopped once it has said nothing for the limit, with why, its thread kept for a reply", async () => {
    const supervisor = supervisorWith(quietAfter([{ type: "output", text: "Looking at the code." }]));
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    // Everything it said is in before the watchdog first looks: what a
    // pass sees new is counted from that pass.
    await vi.waitFor(() => expect(listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type)).toContain("output"));

    supervisor.watchLiveRuns();
    passTime(supervisor, LIMIT - MINUTE);
    expect(supervisor.activeRunCount()).toBe(1);

    passTime(supervisor, 2 * MINUTE);
    await ticking;

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run).toMatchObject({ status: "awaiting_input", threadId: "the-quiet-thread", interruption: null });
    expect(run.error).toContain("No word from");
    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain("No word from");
    expect(escalation?.body).toContain("its output");
    expect(escalation?.body).toContain("Reply to carry on in the same thread");
  });

  it("is not stopped while its backend keeps saying it is at work, and what is retried is kept", async () => {
    // A backend that keeps going: a heartbeat or a retry whenever asked.
    let speak!: (event: AgentEvent) => void;
    const start: AgentProvider["start"] = async function* (input) {
      yield { type: "thread_started", threadId: "the-busy-thread" };
      while (!input.signal.aborted) {
        const next = await new Promise<AgentEvent | null>((resolve) => {
          speak = resolve;
          input.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
        if (next === null) break;
        yield next;
      }
    };
    const supervisor = supervisorWith(start);
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    for (const event of [{ type: "heartbeat" }, { type: "retrying", reason: "rate limited", attempt: 1, maxAttempts: 10 }, { type: "heartbeat" }] as AgentEvent[]) {
      await vi.waitFor(() => expect(speak).toBeTypeOf("function"));
      const said = speak;
      said(event);
      await vi.waitFor(() => expect(speak).not.toBe(said));
      passTime(supervisor, LIMIT - MINUTE);
      expect(supervisor.activeRunCount()).toBe(1);
    }

    supervisor.cancelRun(listRunsForItem(handle.db, item.id)[0]!.id);
    await ticking;
    const stored = listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type);
    // The retry is the run's record; a heartbeat is nobody's.
    expect(stored).toContain("retrying");
    expect(stored).not.toContain("heartbeat");
  });

  it("is not counted as silent while a tool it called is still running", async () => {
    const supervisor = supervisorWith(quietAfter([{ type: "tool_call", name: "Bash", args: { command: "pnpm test" }, callId: "call-1" }]));
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    supervisor.watchLiveRuns();
    passTime(supervisor, 3 * LIMIT);
    expect(supervisor.activeRunCount()).toBe(1);

    supervisor.cancelRun(listRunsForItem(handle.db, item.id)[0]!.id);
    await ticking;
  });

  it("is carried on in its own thread, told the computer slept, when it went quiet across a sleep", async () => {
    const supervisor = supervisorWith(quietAfter([{ type: "output", text: "Writing the tests." }]));
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    // Everything it said is in before the watchdog first looks: what a
    // pass sees new is counted from that pass.
    await vi.waitFor(() => expect(listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type)).toContain("output"));
    supervisor.watchLiveRuns();

    // Asleep for an hour: the next pass comes far later than it was due,
    // which is how a process learns it was not running.
    clock += 60 * MINUTE;
    supervisor.watchLiveRuns();
    expect(supervisor.activeRunCount()).toBe(1);

    // Still silent the whole limit after waking.
    passTime(supervisor, LIMIT + MINUTE);
    await ticking;
    const stopped = listRunsForItem(handle.db, item.id)[0]!;
    expect(stopped).toMatchObject({ status: "cancelled", interruption: "sleep", threadId: "the-quiet-thread" });
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "escalation")).toBe(false);

    const resume = vi.fn<AgentProvider["resume"]>(async function* () {
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const carrying = supervisorWith(vi.fn(), resume);
    await carrying.runOnce();
    await carrying.waitForIdle();

    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[0]).toBe("the-quiet-thread");
    expect(resume.mock.calls[0]?.[1]).toContain("The computer went to sleep while you were working");
    const continuation = listRunsForItem(handle.db, item.id).find((run) => run.id !== stopped.id && run.action === "implement");
    expect(continuation).toMatchObject({ threadId: "the-quiet-thread", attempt: stopped.attempt, initiationId: stopped.initiationId });
  });

  it("is not carried on in its own thread once a file was put on the item after it was stopped, and says why (EO-703)", async () => {
    const supervisor = supervisorWith(quietAfter([{ type: "output", text: "Writing the tests." }]));
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    await vi.waitFor(() => expect(listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]!.id).map((event) => event.type)).toContain("output"));
    supervisor.watchLiveRuns();
    clock += 60 * MINUTE;
    supervisor.watchLiveRuns();
    passTime(supervisor, LIMIT + MINUTE);
    await ticking;
    expect(listRunsForItem(handle.db, item.id)[0]).toMatchObject({ status: "cancelled", interruption: "sleep" });

    // A mock put on the item before the run is carried on: a resumed
    // thread is told nothing about the item again.
    const fileId = uuidv7();
    addItemAttachments(handle.db, item.id, [{ id: fileId, storagePath: `/tmp/eo/attachments/${fileId}`, name: "mock.png", mimeType: "image/png", size: 8 }]);

    const resume = vi.fn<AgentProvider["resume"]>(async function* () {
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const contexts: string[] = [];
    const start = vi.fn<AgentProvider["start"]>(async function* (input) {
      contexts.push(input.context);
      yield { type: "result", data: validImplementResult as unknown as Record<string, unknown> };
    });
    const carrying = supervisorWith(start, resume);
    await carrying.runOnce();
    await carrying.waitForIdle();

    expect(resume).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(contexts[0]).toContain(`- ID: ${fileId}; name: mock.png; MIME type: image/png`);
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.authorType === "engine" && comment.body.includes("The files on this item have changed"))).toBe(true);
  });

  it("is parked with why, not failed, when its backend ends the stopped turn with an error of its own", async () => {
    // How the Claude SDK ends a turn it was asked to stop: a plain error,
    // not an AbortError.
    const start: AgentProvider["start"] = async function* (input) {
      yield { type: "thread_started", threadId: "the-quiet-thread" };
      yield { type: "output", text: "Looking at the code." };
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("Claude Code process aborted by user");
    };
    const supervisor = supervisorWith(start);
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]?.id ?? ("" as never)).map((event) => event.type)).toContain("output"));
    supervisor.watchLiveRuns();
    passTime(supervisor, LIMIT + MINUTE);
    await ticking;

    expect(listRunsForItem(handle.db, item.id)[0]).toMatchObject({ status: "awaiting_input" });
    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation")?.body).toContain("No word from");
  });

  it("is still watched after a call that names no id, which nothing will ever close", async () => {
    // Codex's web search: reported as a call, with no id and no result.
    const supervisor = supervisorWith(quietAfter([{ type: "tool_call", name: "web_search", args: { query: "rate limiting" } }, { type: "output", text: "Read it." }]));
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(listRunEvents(handle.db, listRunsForItem(handle.db, item.id)[0]?.id ?? ("" as never)).map((event) => event.type)).toContain("output"));
    supervisor.watchLiveRuns();
    passTime(supervisor, LIMIT + MINUTE);
    await ticking;

    expect(listRunsForItem(handle.db, item.id)[0]).toMatchObject({ status: "awaiting_input" });
  });

  it("can be switched off", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...createFakeProvider({ result: validImplementResult }), start: quietAfter([]) },
      limits: LIMITS,
      guards: { inactivityTimeoutMs: 0 },
      now: () => clock,
    });
    const ticking = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    supervisor.watchLiveRuns();
    passTime(supervisor, 3 * LIMIT);
    expect(supervisor.activeRunCount()).toBe(1);
    supervisor.cancelRun(listRunsForItem(handle.db, item.id)[0]!.id);
    await ticking;
  });
});

describe("a backend that does not end a turn it was told to stop", () => {
  let handle: DbHandle;
  let item: Item;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  });

  afterEach(() => {
    vi.useRealTimers();
    handle.close();
  });

  it("is not waited on for ever: the run lets go of the item once the grace is over", async () => {
    let started!: () => void;
    const wedged = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Ignores its signal entirely: a process wedged on a dead connection.
    const start: AgentProvider["start"] = async function* () {
      yield { type: "thread_started", threadId: "the-wedged-thread" };
      started();
      await new Promise<never>(() => undefined);
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...createFakeProvider({ result: validImplementResult }), start },
      limits: LIMITS,
    });
    const ticking = supervisor.runOnce();
    await wedged;
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));

    vi.useFakeTimers();
    supervisor.cancelRun(listRunsForItem(handle.db, item.id)[0]!.id);
    // The stop's grace (15s), and then the bounded wait for the turn's
    // ending to be confirmed (30s, EO-493), which a wedged backend never
    // gives.
    await vi.advanceTimersByTimeAsync(16_000 + 31_000);
    vi.useRealTimers();
    await ticking;

    expect(supervisor.activeRunCount()).toBe(0);
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
    // Nothing confirmed the wedged turn's process gone, so its thread is
    // never resumed beside it (EO-493).
    expect(listRunsForItem(handle.db, item.id)[0]?.threadLost).toBe(true);
  });
});
