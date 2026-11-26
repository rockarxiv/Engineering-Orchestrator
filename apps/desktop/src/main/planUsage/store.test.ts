import { describe, expect, it, vi } from "vitest";
import type { QuotaEvent } from "@eo/core";
import { createPlanUsageStore } from "./store.js";

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const HOUR = 3_600_000;

const reading = (over: Partial<QuotaEvent> = {}): QuotaEvent => ({ type: "quota", provider: "claude", window: "five_hour", utilization: 30, status: "allowed", ...over });

/** The latest plan usage reading per backend and window (EO-896), in memory. */
describe("the plan usage store", () => {
  it("keeps the newest reading per backend and window, with its reset as milliseconds", () => {
    let clock = NOW;
    const store = createPlanUsageStore(() => clock);
    store.record(reading({ resetsAt: (NOW + 2 * HOUR) / 1000 }));
    store.record(reading({ provider: "codex", window: "5_hour", utilization: 12 }));
    clock += 1_000;
    store.record(reading({ utilization: 41, resetsAt: NOW + 2 * HOUR }));

    expect(store.view()).toEqual({
      backends: [
        { provider: "claude", limitsApply: true, windows: [{ window: "five_hour", utilization: 41, status: "allowed", resetsAt: NOW + 2 * HOUR, readAt: NOW + 1_000 }] },
        { provider: "codex", limitsApply: true, windows: [{ window: "5_hour", utilization: 12, status: "allowed", resetsAt: null, readAt: NOW }] },
      ],
    });
  });

  it("keeps the last share when a reading says only its status, but not past a refusal it ended", () => {
    const store = createPlanUsageStore(() => NOW);
    store.record(reading({ utilization: 64, resetsAt: NOW + HOUR }));
    const shareless: QuotaEvent = { type: "quota", provider: "claude", window: "five_hour", status: "allowed" };
    store.record(shareless);
    expect(store.view().backends[0]?.windows[0]).toMatchObject({ utilization: 64, resetsAt: NOW + HOUR });

    store.record(reading({ utilization: 100, status: "rejected" }));
    store.record(shareless);
    expect(store.view().backends[0]?.windows[0]).toMatchObject({ utilization: null, status: "allowed" });
  });

  it("takes a read's answer as one change, and remembers that limits do not apply", () => {
    const store = createPlanUsageStore(() => NOW);
    const changed = vi.fn();
    store.onChange(changed);
    store.recordRead("codex", { limitsApply: true, readings: [reading({ provider: "codex", window: "5_hour" }), reading({ provider: "codex", window: "7_day" })] });
    expect(changed).toHaveBeenCalledTimes(1);
    store.recordRead("claude", { limitsApply: false, readings: [] });
    expect(store.view().backends.map((backend) => [backend.provider, backend.limitsApply, backend.windows.length])).toEqual([
      ["codex", true, 2],
      ["claude", false, 0],
    ]);
  });

  describe("a refusal on a window the backend did not name (EO-920)", () => {
    const unnamed = (provider: string): QuotaEvent => ({ type: "quota", provider, window: "unknown", status: "rejected" });
    const windowsOf = (store: ReturnType<typeof createPlanUsageStore>, provider: string) =>
      store.view().backends.find((backend) => backend.provider === provider)?.windows.map((window) => [window.window, window.status]);

    it("is cleared by the same backend's next reading that is not a refusal, from a run or a read", () => {
      for (const provider of ["codex", "claude"]) {
        const store = createPlanUsageStore(() => NOW);
        store.record(reading({ provider, window: "5_hour", utilization: 100, status: "rejected", resetsAt: (NOW + HOUR) / 1000 }));
        store.record(unnamed(provider));
        // Another backend's reading says nothing about this one.
        store.record(reading({ provider: "other", window: "5_hour", utilization: 8 }));
        expect(windowsOf(store, provider)).toEqual([
          ["5_hour", "rejected"],
          ["unknown", "rejected"],
        ]);

        store.record(reading({ provider, window: "7_day", utilization: 40 }));
        expect(windowsOf(store, provider)).toEqual([
          ["5_hour", "rejected"],
          ["7_day", "allowed"],
        ]);
      }

      const read = createPlanUsageStore(() => NOW);
      read.record(unnamed("codex"));
      read.recordRead("codex", { limitsApply: true, readings: [reading({ window: "5_hour", utilization: 8 })] });
      expect(windowsOf(read, "codex")).toEqual([["5_hour", "allowed"]]);
    });

    it("is not cleared by another refusal", () => {
      const store = createPlanUsageStore(() => NOW);
      store.record(unnamed("codex"));
      store.record(reading({ provider: "codex", window: "5_hour", utilization: 100, status: "rejected" }));
      expect(windowsOf(store, "codex")).toEqual([
        ["unknown", "rejected"],
        ["5_hour", "rejected"],
      ]);
    });

    it("stands while nothing else arrives, and is cleared when the backend's limit hold lifts", () => {
      const store = createPlanUsageStore(() => NOW);
      const changed = vi.fn();
      store.onChange(changed);
      store.record(reading({ provider: "codex", window: "5_hour", utilization: 30 }));
      store.record(unnamed("codex"));
      expect(windowsOf(store, "codex")).toEqual([
        ["5_hour", "allowed"],
        ["unknown", "rejected"],
      ]);
      changed.mockClear();

      store.limitLifted("claude");
      expect(changed).not.toHaveBeenCalled();
      store.limitLifted("codex");
      expect(windowsOf(store, "codex")).toEqual([["5_hour", "allowed"]]);
      expect(changed).toHaveBeenCalledWith("codex", expect.any(Number));
    });
  });

  it("says a backend is allowed only when every window it holds is allowed and below 100% now", () => {
    const store = createPlanUsageStore(() => NOW);
    expect(store.allowed("codex", NOW)).toBe(false); // nothing held is no evidence
    store.record(reading({ provider: "codex", window: "5_hour", utilization: 100, status: "rejected", resetsAt: (NOW + HOUR) / 1000 }));
    store.record(reading({ provider: "codex", window: "7_day", utilization: 40 }));
    expect(store.allowed("codex", NOW)).toBe(false);
    // Past its reset the refusal is over, read or no read.
    expect(store.allowed("codex", NOW + HOUR)).toBe(true);
    store.record(reading({ provider: "codex", window: "5_hour", utilization: 0 }));
    expect(store.allowed("codex", NOW)).toBe(true);
    store.record({ type: "quota", provider: "codex", window: "7_day", utilization: 100, status: "allowed" });
    expect(store.allowed("codex", NOW)).toBe(false);
  });

  it("keeps a reading that arrived while a read was in flight over that read's answer (EO-920)", () => {
    const store = createPlanUsageStore(() => NOW);
    const heard = vi.fn();
    store.onChange(heard);
    const askedAt = store.mark();
    // A run is refused while the read is being answered.
    store.record(reading({ provider: "codex", window: "5_hour", utilization: 100, status: "rejected", resetsAt: (NOW + HOUR) / 1000 }));
    store.record({ type: "quota", provider: "codex", window: "unknown", status: "rejected" });
    const refusedAt = heard.mock.lastCall?.[1] as number;
    expect(refusedAt).toBeGreaterThan(askedAt);

    store.recordRead("codex", { limitsApply: true, readings: [reading({ window: "5_hour", utilization: 30 }), reading({ window: "7_day", utilization: 20 })] }, askedAt);
    expect(heard).toHaveBeenLastCalledWith("codex", askedAt);
    expect(store.view().backends[0]?.windows.map((window) => [window.window, window.status, window.utilization])).toEqual([
      ["5_hour", "rejected", 100],
      ["unknown", "rejected", null],
      ["7_day", "allowed", 20],
    ]);
    expect(store.allowed("codex", NOW)).toBe(false);

    // A read asked after them replaces them.
    store.recordRead("codex", { limitsApply: true, readings: [reading({ window: "5_hour", utilization: 0 })] }, store.mark());
    expect(store.view().backends[0]?.windows.map((window) => [window.window, window.status])).toEqual([
      ["5_hour", "allowed"],
      ["7_day", "allowed"],
    ]);
    expect(store.allowed("codex", NOW)).toBe(true);
  });
});
