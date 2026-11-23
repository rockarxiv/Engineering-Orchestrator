import { describe, expect, it } from "vitest";
import { nextPlanUsageChange, planUsageRuntimeQualifies, shownPlanWindow, type PlanUsageWindow } from "./planUsage.js";
import type { RuntimeStatusView } from "./ipc-schemas.js";

const NOW = 1_000_000;
const window = (over: Partial<PlanUsageWindow> = {}): PlanUsageWindow => ({ window: "five_hour", utilization: 50, status: "allowed", resetsAt: null, readAt: NOW, ...over });

describe("plan usage as the rail draws it (EO-896)", () => {
  it("is neutral below 80%, amber from 80%, and red when refused or full", () => {
    expect(shownPlanWindow(window({ utilization: 79 }), NOW).tone).toBe("neutral");
    expect(shownPlanWindow(window({ utilization: 80 }), NOW).tone).toBe("warning");
    expect(shownPlanWindow(window({ utilization: 100 }), NOW)).toMatchObject({ tone: "danger", refused: true });
    expect(shownPlanWindow(window({ utilization: 30, status: "rejected" }), NOW)).toMatchObject({ tone: "danger", refused: true, percent: 30 });
    expect(shownPlanWindow(window({ utilization: null, status: "rejected" }), NOW)).toMatchObject({ refused: true, percent: 100 });
  });

  it("is reset — 0%, neutral, no refusal — once its reset time has come", () => {
    const refused = window({ utilization: 100, status: "rejected", resetsAt: NOW + 10 });
    expect(shownPlanWindow(refused, NOW + 9)).toMatchObject({ refused: true, resetAt: NOW + 10 });
    expect(shownPlanWindow(refused, NOW + 10)).toEqual({ window: "five_hour", percent: 0, tone: "neutral", refused: false, resetAt: null });
  });

  it("names the next reset still ahead", () => {
    const backends = [{ provider: "claude", limitsApply: true, windows: [window({ resetsAt: NOW + 50 }), window({ resetsAt: NOW - 5 }), window({ resetsAt: NOW + 20 })] }];
    expect(nextPlanUsageChange(backends, NOW)).toBe(NOW + 20);
    expect(nextPlanUsageChange(backends, NOW + 60)).toBeNull();
  });

  it("counts a runtime that is installed, enabled and signed in", () => {
    const ready = { source: "cache", state: "ready", enabled: true, auth: { state: "signed_in" } } as RuntimeStatusView;
    expect(planUsageRuntimeQualifies(ready)).toBe(true);
    expect(planUsageRuntimeQualifies(null)).toBe(false);
    expect(planUsageRuntimeQualifies({ ...ready, state: "needs_consent" })).toBe(false);
    expect(planUsageRuntimeQualifies({ ...ready, state: "disabled", enabled: false })).toBe(false);
    expect(planUsageRuntimeQualifies({ ...ready, auth: { ...ready.auth, state: "unknown" } })).toBe(false);
  });
});
