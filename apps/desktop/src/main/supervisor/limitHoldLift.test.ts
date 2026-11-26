import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentEvent, AgentProvider, Item, RuntimeStatusView } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listAgents, listRunsForItem, updateAgent } from "../db/repos/index.js";
import { createTestItem, messagesFrom, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { startPlanUsageReads } from "../planUsage/poller.js";
import { createPlanUsageStore, type PlanUsageStore } from "../planUsage/store.js";
import type { PlanUsageAnswer } from "../providers/planUsageReaders.js";
import { createClaudeProvider } from "../providers/claude.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient, dropWarmCodexThread } from "../providers/codexClient.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { RuntimeAuthCheck } from "../runtimes/auth.js";
import { fakeAppServer, note } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { RUNTIME_LIMIT_SOURCE } from "./runtimeBlocks.js";

/**
 * A plan-limit hold decided by the window the backend named, and lifted
 * by the backend's own readings (EO-920).
 *
 * Codex refuses a turn for its allowance with two readings: its window at
 * 100% with a reset, and the turn's `usageLimitExceeded`, which names no
 * window. The unnamed one used to decide the hold, so a hold Codex had
 * said would end at 08:19 waited for a person. And a read showing every
 * window back — an early reset, another account — lifted nothing.
 *
 * Driven through the real supervisor over an in-memory database and the
 * real adapters of both backends — Claude's over a stubbed `query`,
 * Codex's over a stubbed app-server — with the refused turn sent the way
 * each backend sends it (invariant 12).
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 10 };
const HOUR = 3_600_000;
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";
/** 2026-11-26 06:27 UTC, when Codex said its five-hour window was back at 08:19. */
const START = Date.UTC(2026, 10, 26, 6, 27);
const RESET = Date.UTC(2026, 10, 26, 8, 19, 45);
const WAIT = { timeout: 15_000 };

type BackendName = "claude" | "codex";

/** How a refused turn is refused: a named window with a reset beside the unnamed refusal, or the unnamed one alone. */
type Refusal = "named and unnamed" | "unnamed alone";

let handle: DbHandle;
let implementer: Agent;
let clock: number;
let store: PlanUsageStore;
let supervisor: RunSupervisor | undefined;

beforeEach(() => {
  handle = openMigratedTestDb();
  clock = START;
  store = createPlanUsageStore(() => clock);
});

afterEach(async () => {
  supervisor?.stop();
  await supervisor?.shutdown();
  supervisor = undefined;
  dropWarmCodexThread();
  handle.close();
});

const checkAuth = vi.fn(async (): Promise<RuntimeAuthCheck> => ({ ok: true }));

/** The plan's own window names on each backend. */
const FIVE_HOUR: Record<BackendName, string> = { claude: "five_hour", codex: "5_hour" };
const WEEK: Record<BackendName, string> = { claude: "seven_day", codex: "7_day" };
/** How the limit message names the five-hour window: the backend's own name for it (`quotaWindowPhrase`). */
const FIVE_HOUR_PHRASE: Record<BackendName, string> = { claude: "its five-hour usage window is full", codex: "its 5-hour usage window is full" };

/** A Claude turn as the SDK streams it: refused, or answering. */
function claudeTurn(refusal: Refusal | null): SDKMessage[] {
  const init = { type: "system", subtype: "init", session_id: "sess_1" };
  if (refusal === null) {
    return [
      init,
      {
        type: "result",
        subtype: "success",
        result: JSON.stringify(validImplementResult),
        structured_output: validImplementResult,
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 10 },
        session_id: "sess_1",
      },
    ] as unknown as SDKMessage[];
  }
  const named = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 100, resetsAt: RESET / 1000 } };
  // A reading with no `rateLimitType`: the Claude adapter's `unknown` window.
  const unnamed = { type: "rate_limit_event", rate_limit_info: { status: "rejected" } };
  return [
    init,
    ...(refusal === "named and unnamed" ? [named] : []),
    unnamed,
    { type: "result", subtype: "success", is_error: true, result: "", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 0 }, session_id: "sess_1" },
  ] as unknown as SDKMessage[];
}

/** A Codex turn as the app-server sends it: refused, or answering. */
function codexTurn(refusal: Refusal | null) {
  if (refusal === null) {
    return [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 10, output: 10 }), note.turnCompleted()];
  }
  return [
    note.turnStarted(),
    // The two events of 2026-11-26 06:27: the five-hour window at 100%
    // with its reset, and the turn failed as `usageLimitExceeded`.
    ...(refusal === "named and unnamed" ? [note.rateLimits({ usedPercent: 100, resetsAt: RESET / 1000 }, { usedPercent: 41, resetsAt: (START + 90 * HOUR) / 1000 })] : []),
    note.turnCompleted("failed", "The request could not be completed.", "turn-1", "thr-fake", "usageLimitExceeded"),
  ];
}

/**
 * The implementer's backend, through its real adapter: the first turn
 * refused as `refusal` says, every later one answering. The reviewer
 * stays on the in-memory backend, approving, so the item can move on.
 */
function backend(name: BackendName, refusal: Refusal) {
  const turns: string[] = [];
  let refused = false;
  const nextTurn = (kind: string): Refusal | null => {
    turns.push(kind);
    if (refused) return null;
    refused = true;
    return refusal;
  };

  const runQuery = ((call: { options: { resume?: string } }) => {
    const messages = claudeTurn(nextTurn(call.options.resume ? "resume" : "start"));
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as never;
  const claude = createClaudeProvider({ runQuery, enableCommentTool: false });

  const codexFor = (kind: string): AgentProvider => {
    // A fake app-server per turn, its scenario worked out before the turn starts.
    const fake = fakeAppServer({ after: { "turn/start": codexTurn(nextTurn(kind)) } });
    return createCodexProvider({ executablePath: EXECUTABLE, createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }) });
  };

  const reviewer: AgentProvider = {
    async *start(): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "review-thread" };
      yield { type: "result", data: { verdict: "approve", feedback: "Fine.", blocking_issues: [] } };
    },
    async *resume(): AsyncIterable<AgentEvent> {
      yield { type: "result", data: { verdict: "approve", feedback: "Fine.", blocking_issues: [] } };
    },
  };

  const provider = (agent: Agent): AgentProvider => {
    if (agent.id !== implementer.id) return reviewer;
    if (name === "claude") return claude;
    return {
      start: (opts) => codexFor("start").start(opts),
      resume: (threadId, message, opts) => codexFor("resume").resume(threadId, message, opts),
    };
  };
  return { provider, turns };
}

function supervising(name: BackendName, refusal: Refusal) {
  const agents = listAgents(handle.db);
  implementer = updateAgent(handle.db, agents.find((agent) => agent.role === "implementer")!.id, { provider: name })!;
  const scripted = backend(name, refusal);
  supervisor = createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    checkAuth,
    now: () => clock,
    provider: scripted.provider,
    planUsage: store,
    tickIntervalMs: 10,
    watchdogIntervalMs: 3_600_000,
  });
  return scripted;
}

const limitMessages = () => messagesFrom(handle.db, RUNTIME_LIMIT_SOURCE);
const limitedRun = (item: Item) => listRunsForItem(handle.db, item.id).find((run) => run.interruption === "limit");
const forImplementer = (): Item => createTestItem(handle.db, { type: "story", title: "Hits the limit", stepId: "todo", spec: REVIEWABLE_SPEC });

/** Started, and held: the refused run stopped and the limit message sent. */
async function heldOn(item: Item): Promise<void> {
  supervisor!.start();
  await vi.waitFor(() => {
    expect(limitedRun(item)).toBeDefined();
    expect(limitMessages()).toHaveLength(1);
  }, WAIT);
}

/** Long enough for several ticks to have run, had any of them anything to do. */
const someTicks = () => new Promise((resolve) => setTimeout(resolve, 150));

/** What the Usage block holds for a backend, by window. */
const shownWindows = (name: BackendName) => store.view().backends.find((backend) => backend.provider === name)?.windows.map((window) => [window.window, window.status]);

describe.each<BackendName>(["codex", "claude"])("a run on %s refused on a named window and an unnamed one", (name) => {
  it("is held on the named window's reset, says so, and carries on by itself at that reset", async () => {
    const item = forImplementer();
    const { turns } = supervising(name, "named and unnamed");

    await heldOn(item);

    const [message] = limitMessages();
    expect(message?.body).toContain(FIVE_HOUR_PHRASE[name]);
    expect(message?.body).toContain("2026-11-26 08:19 UTC");
    expect(message?.body).not.toContain("did not say");
    expect(message?.body).toContain("They carry on by themselves when the window refreshes");
    expect(limitedRun(item)?.error).toContain(FIVE_HOUR_PHRASE[name]);
    expect(limitedRun(item)?.attempt).toBe(1);

    // Before the reset, nothing moves.
    await someTicks();
    expect(turns).toEqual(["start"]);
    expect(limitMessages()[0]?.handledAt).toBeNull();

    // At the reset it lifts with nobody pressing anything, and the refused run is carried on.
    clock = RESET + 1_000;
    await vi.waitFor(() => {
      expect(turns).toEqual(["start", "resume"]);
      expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
    }, WAIT);
    expect(limitMessages()).toHaveLength(1);
    expect(limitMessages()[0]?.handledAt).not.toBeNull();
    expect(limitMessages()[0]?.answer).toBeNull();
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status === "failed")).toBe(false);
    // And the Usage block no longer shows the unnamed refusal.
    expect(shownWindows(name)?.some(([window]) => window === "unknown")).toBe(false);
  });
});

describe.each<BackendName>(["codex", "claude"])("a %s hold seen back by a usage read", (name) => {
  /** Every window of the backend allowed, as the five-minute read reports them. */
  const allBack = (fiveHour = 0) => ({
    limitsApply: true,
    readings: [
      { type: "quota" as const, provider: name, window: FIVE_HOUR[name], utilization: fiveHour, status: "allowed" as const, resetsAt: (clock + 5 * HOUR) / 1000 },
      { type: "quota" as const, provider: name, window: WEEK[name], utilization: 0, status: "allowed" as const, resetsAt: (clock + 7 * 24 * HOUR) / 1000 },
    ],
  });

  it("lifts before the reset the backend named, and the run carries on", async () => {
    const item = forImplementer();
    const { turns } = supervising(name, "named and unnamed");
    await heldOn(item);

    // 13:47 on 2026-11-26: both windows started again from 0%, hours before the named reset.
    clock = START + HOUR;
    store.recordRead(name, allBack());

    await vi.waitFor(() => expect(turns).toEqual(["start", "resume"]), WAIT);
    expect(limitMessages()).toHaveLength(1);
    expect(limitMessages()[0]?.handledAt).not.toBeNull();
    expect(limitMessages()[0]?.answer).toBeNull();
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status === "failed")).toBe(false);
  });

  it("lifts a hold that had no reset at all, and clears the unnamed refusal from the Usage block", async () => {
    const item = forImplementer();
    const { turns } = supervising(name, "unnamed alone");
    await heldOn(item);
    expect(limitMessages()[0]?.body).toContain("a usage window it did not name is full");
    expect(limitMessages()[0]?.body).toContain("did not say when the window refreshes");
    expect(shownWindows(name)).toEqual([["unknown", "rejected"]]);

    // Ticks alone, with no reading, lift nothing: there is no evidence it has ended.
    clock = START + 10 * HOUR;
    await someTicks();
    expect(turns).toEqual(["start"]);
    expect(shownWindows(name)).toEqual([["unknown", "rejected"]]);

    store.recordRead(name, allBack(8));
    await vi.waitFor(() => expect(turns).toEqual(["start", "resume"]), WAIT);
    expect(limitMessages()[0]?.handledAt).not.toBeNull();
    expect(shownWindows(name)?.some(([window]) => window === "unknown")).toBe(false);
  });

  it("stands while a read still shows a window at 100%", async () => {
    const item = forImplementer();
    const { turns } = supervising(name, "named and unnamed");
    await heldOn(item);

    clock = START + HOUR;
    store.recordRead(name, allBack(100));
    // And a reading from the other backend says nothing about this one.
    const other: BackendName = name === "codex" ? "claude" : "codex";
    store.record({ type: "quota", provider: other, window: FIVE_HOUR[other], utilization: 3, status: "allowed" });
    await someTicks();

    expect(turns).toEqual(["start"]);
    expect(limitMessages()).toHaveLength(1);
    expect(limitMessages()[0]?.handledAt).toBeNull();
  });

  it("is not lifted by a read asked before the hold began whose answer came back after it", async () => {
    const item = forImplementer();
    const { turns } = supervising(name, "named and unnamed");

    // The five-minute read is asked while the backend still has room, and
    // its answer is slow to come back.
    let answerStale: (answer: PlanUsageAnswer) => void = () => {};
    const stale = new Promise<PlanUsageAnswer>((resolve) => (answerStale = resolve));
    const read = vi.fn((): Promise<PlanUsageAnswer> => stale);
    const signedIn = { path: EXECUTABLE, state: "ready", enabled: true, auth: { state: "signed_in", kind: "subscription" } } as RuntimeStatusView;
    let stopReads = startPlanUsageReads({ readers: [{ provider: name, read }], status: async () => signedIn, store, intervalMs: 3_600_000 });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1), WAIT);

    // Meanwhile a run reaches the limit and the hold begins.
    await heldOn(item);
    // Then the read answers with what it saw before.
    answerStale({ ok: true, ...allBack() });
    await someTicks();

    expect(turns).toEqual(["start"]);
    expect(limitMessages()[0]?.handledAt).toBeNull();
    // Nor does the Usage block take the older answer over the refusal.
    expect(shownWindows(name)).toContainEqual([FIVE_HOUR[name], "rejected"]);
    stopReads();

    // A read asked after the hold began, showing every window back, lifts it.
    read.mockImplementation(async () => ({ ok: true, ...allBack() }));
    stopReads = startPlanUsageReads({ readers: [{ provider: name, read }], status: async () => signedIn, store, intervalMs: 3_600_000 });
    await vi.waitFor(() => expect(turns).toEqual(["start", "resume"]), WAIT);
    expect(limitMessages()[0]?.handledAt).not.toBeNull();
    expect(limitMessages()[0]?.answer).toBeNull();
    stopReads();
  });
});
