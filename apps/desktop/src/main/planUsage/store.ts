import { isUnnamedWindow, quotaResetAt, shownPlanWindow, type PlanUsageView, type PlanUsageWindow, type QuotaEvent } from "@eo/core";
import { emitPush } from "../ipc/push.js";

/**
 * The latest plan usage reading per backend and window (EO-896), as the
 * rail's Usage block draws it.
 *
 * Fed from everywhere a backend reports one — a run's `quota` events, a
 * side call's, and the reads `poller.ts` takes every five minutes — and
 * kept in this process's memory and nowhere else. Nothing here writes a
 * comment, a message, a run event or a row: a reading is a glance at an
 * account, and the next one replaces it.
 */
export interface PlanUsageStore {
  /** One reading, from a run or a side call. */
  record(event: QuotaEvent): void;
  /**
   * One read's answer for a backend: its windows, and whether plan limits
   * apply to this sign-in at all. One change, however many windows.
   */
  recordRead(provider: string, answer: { limitsApply: boolean; readings: readonly QuotaEvent[] }): void;
  /**
   * The backend's plan-limit hold on this device has lifted (EO-920):
   * a refusal on a window it did not name is over with it, since nothing
   * else would ever end one — no reset, and no later reading names it.
   */
  limitLifted(provider: string): void;
  /**
   * Whether every window held for the backend is allowed and below 100%
   * at `now`, by the latest readings (EO-920). False when none is held:
   * no reading is no evidence the backend is back.
   */
  allowed(provider: string, now: number): boolean;
  view(): PlanUsageView;
  /** Called after every change, with the backend it was a change to. Returns the unsubscribe. */
  onChange(listener: (provider: string) => void): () => void;
}

interface BackendState {
  limitsApply: boolean;
  windows: Map<string, PlanUsageWindow>;
}

export function createPlanUsageStore(now: () => number = Date.now): PlanUsageStore {
  const backends = new Map<string, BackendState>();
  const listeners = new Set<(provider: string) => void>();

  const backendOf = (provider: string): BackendState => {
    let state = backends.get(provider);
    if (!state) {
      state = { limitsApply: true, windows: new Map() };
      backends.set(provider, state);
    }
    return state;
  };

  const refused = (reading: { status: string; utilization?: number | null | undefined }): boolean =>
    reading.status === "rejected" || (reading.utilization ?? 0) >= 100;

  /** Drops the backend's refusals on windows it did not name; whether there was one. */
  const clearUnnamedRefusals = (state: BackendState): boolean => {
    let cleared = false;
    for (const [window, reading] of state.windows) {
      if (isUnnamedWindow(window) && refused(reading)) cleared = state.windows.delete(window) || cleared;
    }
    return cleared;
  };

  const take = (event: QuotaEvent, at: number): void => {
    const state = backendOf(event.provider);
    // A refusal on a window the backend did not name has no reset to end
    // it and no later reading that names it (EO-920). The backend
    // answering anything but a refusal is the evidence it has ended.
    if (!refused(event)) clearUnnamedRefusals(state);
    const previous = state.windows.get(event.window);
    const resetsAt = quotaResetAt(event.resetsAt, at);
    // A reading that says the status and not the share — Claude's
    // `rate_limit_event` often does — keeps the share the last one gave,
    // as long as that one was not a refusal the new status has ended and
    // its window has not refreshed meanwhile.
    const previousStands = previous !== undefined && (previous.resetsAt === null || previous.resetsAt > at);
    const previousRefused = previous !== undefined && refused(previous);
    const carried = previousStands && !(previousRefused && event.status !== "rejected");
    state.windows.set(event.window, {
      window: event.window,
      utilization: event.utilization ?? (carried ? (previous?.utilization ?? null) : null),
      status: event.status,
      resetsAt: resetsAt ?? (carried && event.resetsAt === undefined ? (previous?.resetsAt ?? null) : null),
      readAt: at,
    });
  };

  const changed = (provider: string): void => {
    for (const listener of [...listeners]) {
      try {
        listener(provider);
      } catch {
        // A listener is a doorbell; one that fails must not keep the
        // reading from the others, or from the backend that sent it.
      }
    }
  };

  return {
    record(event) {
      take(event, now());
      changed(event.provider);
    },
    recordRead(provider, answer) {
      const at = now();
      const state = backendOf(provider);
      state.limitsApply = answer.limitsApply;
      for (const event of answer.readings) take({ ...event, provider }, at);
      changed(provider);
    },
    limitLifted(provider) {
      const state = backends.get(provider);
      if (state && clearUnnamedRefusals(state)) changed(provider);
    },
    allowed(provider, at) {
      const windows = [...(backends.get(provider)?.windows.values() ?? [])];
      return (
        windows.length > 0 &&
        windows.every((reading) => {
          const shown = shownPlanWindow(reading, at);
          return !shown.refused && (shown.percent === null || shown.percent < 100);
        })
      );
    },
    view() {
      return {
        backends: [...backends.entries()].map(([provider, state]) => ({
          provider,
          limitsApply: state.limitsApply,
          windows: [...state.windows.values()],
        })),
      };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * This process's readings: one store, which the supervisor and side
 * calls write into wherever they are built and `planUsage:get` reads.
 * Module-level for the reason `emitPush` is — a reading arrives deep in
 * a run, far from anything that could be handed a store.
 */
export const planUsage: PlanUsageStore = createPlanUsageStore();

// Every change rings `planUsage:changed`, so an open rail asks again
// without a reload.
planUsage.onChange(() => emitPush("planUsage:changed", {}));
