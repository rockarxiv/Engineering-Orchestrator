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
});
