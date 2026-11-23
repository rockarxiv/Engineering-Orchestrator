import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStatusView } from "@eo/core";
import { planUsageReaders } from "../providers/planUsageReaders.js";
import { CLAUDE_USAGE, fakeClaudeQuery } from "../testing/fakeClaudeUsage.js";
import { fakeAppServer, note, type FakeAppServer } from "../testing/fakeCodexAppServer.js";
import { PLAN_USAGE_INTERVAL_MS, startPlanUsageReads } from "./poller.js";
import { createPlanUsageStore, type PlanUsageStore } from "./store.js";

/**
 * The five-minute reads (EO-896): each signed-in backend's plan windows
 * read at start-up and on every tick, with no run taking place — Codex
 * through the fake app-server, Claude through a fake SDK `query`.
 *
 * Only the interval is faked. The app-server is a real child process,
 * so its answers arrive on real time; `until` waits for them.
 */

function runtime(id: string, over: Partial<RuntimeStatusView> = {}): RuntimeStatusView {
  return {
    id,
    label: id,
    publisher: "",
    termsUrl: "",
    source: "cache",
    path: `/runtimes/${id}`,
    version: null,
    packageName: null,
    packageVersion: null,
    state: "ready",
    enabled: true,
    auth: { state: "signed_in", method: null, kind: "subscription", storedKey: false, account: null, problem: null },
    ...over,
  };
}

const snapshot = (fiveHour: number, week: number) => note.rateLimits({ usedPercent: fiveHour, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, { usedPercent: week }).params.rateLimits;

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Long enough for any read that was going to start to have finished. */
async function quiet(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("the plan usage reads", () => {
  let store: PlanUsageStore;
  let statuses: Record<string, RuntimeStatusView | null>;
  let codex: FakeAppServer;
  const servers: FakeAppServer[] = [];
  let stop: () => void = () => {};

  const useCodex = (scenario: Parameters<typeof fakeAppServer>[0]): void => {
    codex = fakeAppServer(scenario);
    servers.push(codex);
  };
  const codexReads = (): number => servers.flatMap((server) => server.sent).filter((message) => message.method === "account/rateLimits/read" && message.id !== undefined).length;
  const share = (provider: string, window: string): number | null | undefined =>
    store.view().backends.find((backend) => backend.provider === provider)?.windows.find((reading) => reading.window === window)?.utilization;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    store = createPlanUsageStore();
    statuses = { claude: null, codex: null };
    servers.length = 0;
    useCodex({});
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  function start(claudeQuery = fakeClaudeQuery(() => CLAUDE_USAGE(10, 20)).runQuery): void {
    stop = startPlanUsageReads({
      readers: planUsageReaders({ claudeQuery: async () => claudeQuery, codexSpawn: (command, args, options) => codex.spawn(command, args, options) }),
      status: async (provider) => statuses[provider] ?? null,
      store,
    });
  }

  it("reads Codex at start-up and every five minutes, and each answer moves its bars with no run", async () => {
    statuses["codex"] = runtime("codex");
    useCodex({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(20, 40), rateLimitsByLimitId: { codex: snapshot(20, 40) } } } } });
    start();

    await until(() => share("codex", "5_hour") === 20, "the start-up read");
    expect(codexReads()).toBe(1);
    expect(share("codex", "7_day")).toBe(40);

    useCodex({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(55, 61), rateLimitsByLimitId: null } } } });
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS - 1);
    await quiet();
    expect(codexReads()).toBe(1);
    vi.advanceTimersByTime(1);
    await until(() => share("codex", "5_hour") === 55, "the five-minute read");
    expect(codexReads()).toBe(2);
    expect(share("codex", "7_day")).toBe(61);
  });

  it("reads Claude at start-up and every five minutes, a fresh session each time that is sent nothing", async () => {
    statuses["claude"] = runtime("claude");
    let answer = CLAUDE_USAGE(34, 61);
    const { runQuery, sessions } = fakeClaudeQuery(() => answer);
    start(runQuery);

    await until(() => share("claude", "five_hour") === 34, "the start-up read");
    expect(share("claude", "seven_day")).toBe(61);
    expect(sessions).toHaveLength(1);

    answer = CLAUDE_USAGE(80, 100);
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await until(() => share("claude", "five_hour") === 80, "the five-minute read");
    expect(sessions).toHaveLength(2);
    await Promise.all(sessions.map((session) => session.promptEnded));
    expect(sessions.map((session) => [session.yielded.length, session.closed, session.usageCalls])).toEqual([
      [0, true, [{ skipBehaviors: true }]],
      [0, true, [{ skipBehaviors: true }]],
    ]);
    expect(store.view().backends.find((backend) => backend.provider === "claude")?.windows.find((reading) => reading.window === "seven_day")?.status).toBe("rejected");
  });

  it("keeps the last reading when a read fails, says nothing, and tries again on the next tick", async () => {
    statuses = { claude: runtime("claude"), codex: runtime("codex") };
    useCodex({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(30, 50) } } } });
    let claudeAnswer: unknown = CLAUDE_USAGE(25, 45);
    const { runQuery, sessions } = fakeClaudeQuery(() => claudeAnswer);
    start(runQuery);
    await until(() => share("codex", "5_hour") === 30 && share("claude", "five_hour") === 25, "the start-up reads");

    const changed = vi.fn();
    store.onChange(changed);
    useCodex({ replies: { "account/rateLimits/read": { error: { code: -32603, message: "usage endpoint unavailable" } } } });
    claudeAnswer = new Error("Control request failed");
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await until(() => codexReads() === 2 && sessions.length === 2 && sessions[1]!.closed, "the failing reads");
    await quiet();
    expect(changed).not.toHaveBeenCalled();
    expect(share("codex", "5_hour")).toBe(30);
    expect(share("claude", "five_hour")).toBe(25);

    useCodex({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(33, 52) } } } });
    claudeAnswer = CLAUDE_USAGE(27, 46);
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await until(() => share("codex", "5_hour") === 33 && share("claude", "five_hour") === 27, "the retried reads");
  });

  it("keeps the last reading when the bundled SDK has no usage method", async () => {
    statuses["claude"] = runtime("claude");
    let missing = false;
    const present = fakeClaudeQuery(() => CLAUDE_USAGE(15, 35));
    const absent = fakeClaudeQuery(() => CLAUDE_USAGE(99, 99), { missing: true });
    start(((params: never) => (missing ? absent.runQuery : present.runQuery)(params)) as never);
    await until(() => share("claude", "five_hour") === 15, "the start-up read");

    missing = true;
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await until(() => absent.sessions.length === 1 && absent.sessions[0]!.closed, "the read without the method");
    await quiet();
    expect(share("claude", "five_hour")).toBe(15);
  });

  it("stops a backend's reads when it is signed out or disabled, and reads nothing that does not qualify", async () => {
    statuses = { claude: runtime("claude"), codex: runtime("codex") };
    useCodex({ replies: { "account/rateLimits/read": { result: { rateLimits: snapshot(10, 10) } } } });
    const { runQuery, sessions } = fakeClaudeQuery(() => CLAUDE_USAGE(10, 10));
    start(runQuery);
    await until(() => codexReads() === 1 && sessions.length === 1 && sessions[0]!.closed, "the start-up reads");

    statuses = {
      claude: runtime("claude", { auth: { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null } }),
      codex: runtime("codex", { state: "disabled", enabled: false }),
    };
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await quiet();
    vi.advanceTimersByTime(PLAN_USAGE_INTERVAL_MS);
    await quiet();
    expect(codexReads()).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(servers.reduce((launched, server) => launched + server.launches.length, 0)).toBe(1);
  });
});
