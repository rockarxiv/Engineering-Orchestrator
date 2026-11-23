import { act, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanUsageBackend, PlanUsageView, RuntimeStatusView } from "@eo/core";
import { createQueryClient } from "../query/client";
import { clockTime, UsageBlock } from "./UsageBlock";

/**
 * The rail's Usage block (EO-896): which backends get a group, how each
 * window is drawn, and that it follows the main process's pushes and the
 * clock without a new reading.
 */

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
const MINUTE = 60_000;

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

const signedOut = (id: string) => runtime(id, { auth: { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null } });

function backend(provider: string, windows: Record<string, { utilization: number | null; status?: "allowed" | "rejected"; resetsAt?: number | null; readAt?: number }>, limitsApply = true): PlanUsageBackend {
  return {
    provider,
    limitsApply,
    windows: Object.entries(windows).map(([window, reading]) => ({
      window,
      utilization: reading.utilization,
      status: reading.status ?? "allowed",
      resetsAt: reading.resetsAt ?? null,
      readAt: reading.readAt ?? NOW,
    })),
  };
}

interface Setup {
  runtimes?: Record<string, RuntimeStatusView | null>;
  usage?: PlanUsageView;
}

const pushes = new Map<string, (payload: unknown) => void>();

function setup({ runtimes = { claude: runtime("claude"), codex: runtime("codex") }, usage = { backends: [] } }: Setup) {
  const state = { usage };
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === "runtime:status") return { ok: true, data: { runtime: runtimes[(payload as { provider: string }).provider] ?? null } };
    if (channel === "planUsage:get") return { ok: true, data: state.usage };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
    pushes.set(channel, callback);
    return () => pushes.delete(channel);
  }) as never;
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <UsageBlock />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return state;
}

/** Lets the queries answer without moving the clock. */
async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function group(name: string) {
  return within(screen.getByRole("group", { name }));
}

function meter(groupName: string, bar: string) {
  return screen.getByRole("group", { name: groupName }).querySelector(`[role="group"][aria-label="${bar}"]`) as HTMLElement;
}

describe("the rail's Usage block", () => {
  afterEach(() => {
    vi.useRealTimers();
    pushes.clear();
  });

  async function rendered(options: Setup) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const state = setup(options);
    await settle();
    return state;
  }

  it("draws a Claude and a Codex group, each with a 5h and a Week bar at the reading's percentage", async () => {
    await rendered({
      usage: {
        backends: [backend("claude", { five_hour: { utilization: 34 }, seven_day: { utilization: 61 } }), backend("codex", { "5_hour": { utilization: 12 }, "7_day": { utilization: 27 } })],
      },
    });

    const block = screen.getByRole("region", { name: "Usage" });
    expect(within(block).getAllByRole("group").filter((element) => element.parentElement === block).map((element) => element.getAttribute("aria-label"))).toEqual(["Claude", "Codex"]);
    expect(meter("Claude", "5h")).toHaveTextContent("34%");
    expect(meter("Claude", "Week")).toHaveTextContent("61%");
    expect(meter("Codex", "5h")).toHaveTextContent("12%");
    expect(meter("Codex", "Week")).toHaveTextContent("27%");
    expect((meter("Claude", "Week").querySelector('[data-testid="usage-fill"]') as HTMLElement).style.width).toBe("61%");
  });

  it("gives no group to a backend that is not installed, disabled or signed out, and draws nothing when none qualifies", async () => {
    await rendered({ runtimes: { claude: runtime("claude", { source: "absent", state: "needs_consent" }), codex: runtime("codex", { state: "disabled", enabled: false }) } });
    expect(screen.queryByRole("region", { name: "Usage" })).toBeNull();
    expect(screen.queryByText("Usage")).toBeNull();
  });

  it("leaves out a signed-out backend and keeps the signed-in one", async () => {
    await rendered({ runtimes: { claude: signedOut("claude"), codex: runtime("codex") } });
    expect(screen.queryByRole("group", { name: "Claude" })).toBeNull();
    expect(screen.getByRole("group", { name: "Codex" })).toBeInTheDocument();
  });

  it("gives no group to a Claude sign-in plan limits do not apply to", async () => {
    await rendered({ usage: { backends: [backend("claude", {}, false), backend("codex", { "5_hour": { utilization: 5 } })] } });
    expect(screen.queryByRole("group", { name: "Claude" })).toBeNull();
    expect(screen.getByRole("group", { name: "Codex" })).toBeInTheDocument();
  });

  it("draws 79% in the accent blue, and 80% amber with when it resets", async () => {
    const resetsAt = NOW + 3 * 24 * 60 * MINUTE;
    await rendered({ runtimes: { claude: runtime("claude") }, usage: { backends: [backend("claude", { five_hour: { utilization: 79, resetsAt: NOW + 60 * MINUTE }, seven_day: { utilization: 80, resetsAt } })] } });

    const neutral = meter("Claude", "5h");
    expect(neutral.dataset["tone"]).toBe("neutral");
    expect(neutral.querySelector('[data-testid="usage-fill"]')).toHaveClass("bg-accent");
    expect(neutral.querySelector('[data-testid="usage-fill"]')).not.toHaveClass("bg-ink-subtle");
    expect(within(neutral).getByText("79%")).toHaveClass("text-ink-subtle");
    expect(within(neutral).queryByText(/Resets/)).toBeNull();

    const amber = meter("Claude", "Week");
    expect(amber.dataset["tone"]).toBe("warning");
    expect(amber.querySelector('[data-testid="usage-fill"]')).toHaveClass("bg-warning");
    expect(amber.querySelector('[data-testid="usage-fill"]')).not.toHaveClass("bg-accent");
    expect(within(amber).getByText("80%")).toHaveClass("text-warning");
    expect(within(amber).getByText(`Resets ${clockTime(resetsAt, NOW)}`)).toBeInTheDocument();
    expect(clockTime(resetsAt, NOW)).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
  });

  it("draws a refused window red with when it is back, a 100% window as refused, and 'Refused' alone with no time", async () => {
    const back = NOW + 220 * MINUTE;
    await rendered({
      usage: {
        backends: [
          backend("claude", { five_hour: { utilization: 40, status: "rejected", resetsAt: back }, seven_day: { utilization: 100 } }),
          backend("codex", { "5_hour": { utilization: 100, resetsAt: NOW + 30 * MINUTE } }),
        ],
      },
    });

    const rejected = meter("Claude", "5h");
    expect(rejected.dataset["tone"]).toBe("danger");
    expect(rejected.querySelector('[data-testid="usage-fill"]')).toHaveClass("bg-danger");
    expect(rejected.querySelector('[data-testid="usage-fill"]')).not.toHaveClass("bg-accent");
    expect(within(rejected).getByText(`Refused · back at ${clockTime(back, NOW)}`)).toHaveClass("text-danger");
    expect(clockTime(back, NOW)).toBe("15:40");

    const full = meter("Claude", "Week");
    expect(full.dataset["tone"]).toBe("danger");
    expect(within(full).getByText("Refused")).toBeInTheDocument();
    expect(within(full).getByText("100%")).toHaveClass("text-danger");

    expect(within(meter("Codex", "5h")).getByText("Refused · back at 12:30")).toBeInTheDocument();
  });

  it("marks a backend with an amber or red window with a dot of that colour, and one below 80% with none", async () => {
    await rendered({
      usage: {
        backends: [backend("claude", { five_hour: { utilization: 41 }, seven_day: { utilization: 88 } }), backend("codex", { "5_hour": { utilization: 100 }, "7_day": { utilization: 52 } })],
      },
    });
    expect(group("Claude").getByTestId("usage-mark")).toHaveClass("bg-warning");
    expect(group("Codex").getByTestId("usage-mark")).toHaveClass("bg-danger");
  });

  it("draws no dot when every window is below 80%", async () => {
    await rendered({ usage: { backends: [backend("claude", { five_hour: { utilization: 34 }, seven_day: { utilization: 79 } })] } });
    expect(group("Claude").queryByTestId("usage-mark")).toBeNull();
  });

  it("notes a refusal on another window under its backend, naming it, without a bar", async () => {
    await rendered({
      usage: { backends: [backend("claude", { five_hour: { utilization: 20 }, seven_day: { utilization: 30 }, seven_day_opus: { utilization: 100, resetsAt: NOW + 120 * MINUTE } })] },
    });
    const claude = screen.getByRole("group", { name: "Claude" });
    expect(within(claude).getByText(`seven-day-opus: Refused · back at ${clockTime(NOW + 120 * MINUTE, NOW)}`)).toHaveClass("text-danger");
    expect(claude.querySelectorAll('[data-testid="usage-fill"]')).toHaveLength(2);
    expect(group("Claude").getByTestId("usage-mark")).toHaveClass("bg-danger");
  });

  it("says there is no reading yet for a signed-in backend nothing has been read from", async () => {
    await rendered({ runtimes: { claude: runtime("claude") } });
    expect(group("Claude").getByText("No reading yet — shown after the next run")).toBeInTheDocument();
  });

  it("redraws on planUsage:changed without a reload", async () => {
    const state = await rendered({ runtimes: { codex: runtime("codex") } });
    expect(group("Codex").getByText("No reading yet — shown after the next run")).toBeInTheDocument();

    state.usage = { backends: [backend("codex", { "5_hour": { utilization: 17 }, "7_day": { utilization: 44 } })] };
    act(() => pushes.get("planUsage:changed")?.({}));
    await settle();

    expect(meter("Codex", "5h")).toHaveTextContent("17%");
    expect(meter("Codex", "Week")).toHaveTextContent("44%");
  });

  it("shows a window as reset, and its refusal gone, at its reset time with no new reading", async () => {
    await rendered({ usage: { backends: [backend("codex", { "5_hour": { utilization: 100, resetsAt: NOW + 10 * MINUTE + 7_000 }, "7_day": { utilization: 52 } })] } });
    expect(meter("Codex", "5h").dataset["tone"]).toBe("danger");
    expect(screen.getByText("Refused · back at 12:10")).toBeInTheDocument();

    await advance(10 * MINUTE + 6_000);
    expect(meter("Codex", "5h").dataset["tone"]).toBe("danger");

    // Not on a 30-second boundary: it is the reset itself that redraws.
    await advance(1_000);
    const reset = meter("Codex", "5h");
    expect(reset.dataset["tone"]).toBe("neutral");
    expect(reset).toHaveTextContent("0%");
    expect(screen.queryByText(/Refused/)).toBeNull();
    expect(screen.queryByTestId("usage-mark")).toBeNull();
    expect(window.eo.ipc.invoke).toHaveBeenCalledTimes(3);
  });

  it("says how long ago the newest reading arrived, and advances it while no reading arrives", async () => {
    await rendered({
      usage: { backends: [backend("claude", { five_hour: { utilization: 10, readAt: NOW - 5 * MINUTE } }), backend("codex", { "5_hour": { utilization: 10, readAt: NOW - 20_000 } })] },
    });
    const header = () => screen.getByRole("region", { name: "Usage" }).firstElementChild as HTMLElement;
    expect(header()).toHaveTextContent("Usagejust now");

    await advance(30_000);
    expect(header()).toHaveTextContent("Usagejust now");
    await advance(30_000);
    expect(header()).toHaveTextContent("Usage1 min ago");
    await advance(2 * MINUTE);
    expect(header()).toHaveTextContent("Usage3 min ago");
  });
});
