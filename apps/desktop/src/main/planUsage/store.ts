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
   *
   * `askedAt` is the `mark()` taken before the read was asked (EO-920).
   * An answer is a glance at the account when it was asked, not when it
   * came back: a window read since then — a run refused while the read
   * was in flight — keeps its newer reading. Without it the answer counts
   * as asked now.
   */
  recordRead(provider: string, answer: { limitsApply: boolean; readings: readonly QuotaEvent[] }, askedAt?: number): void;
  /**
   * A point in the order readings reach this store, later than every one
   * before it. Not a time: a count, so that it orders a read against a
   * run's refusal whatever clock either keeps.
   */
  mark(): number;
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
  /**
   * Called after every change, with the backend it was a change to and
   * the mark the readings in it were taken at — for a read, the one taken
   * when it was asked. Returns the unsubscribe.
   */
  onChange(listener: (provider: string, takenAt: number) => void): () => void;
}

interface BackendState {
  limitsApply: boolean;
  windows: Map<string, PlanUsageWindow>;
  /** The mark each window's reading was taken at. */
  takenAt: Map<string, number>;
}

export function createPlanUsageStore(now: () => number = Date.now): PlanUsageStore {
  const backends = new Map<string, BackendState>();
  const listeners = new Set<(provider: string, takenAt: number) => void>();
  let order = 0;
  const mark = (): number => ++order;

  const backendOf = (provider: string): BackendState => {
    let state = backends.get(provider);
    if (!state) {
      state = { limitsApply: true, windows: new Map(), takenAt: new Map() };
      backends.set(provider, state);
    }
    return state;
  };

  const refused = (reading: { status: string; utilization?: number | null | undefined }): boolean =>
    reading.status === "rejected" || (reading.utilization ?? 0) >= 100;

  /** Drops the backend's refusals on windows it did not name, taken before `before`; whether there was one. */
  const clearUnnamedRefusals = (state: BackendState, before: number): boolean => {
    let cleared = false;
    for (const [window, reading] of state.windows) {
      if (!isUnnamedWindow(window) || !refused(reading) || (state.takenAt.get(window) ?? 0) >= before) continue;
      state.windows.delete(window);
      state.takenAt.delete(window);
      cleared = true;
    }
    return cleared;
  };

  const take = (event: QuotaEvent, at: number, takenAt: number): void => {
    const state = backendOf(event.provider);
    // A read asked before this window's last reading arrived says less
    // than that reading does (EO-920).
    if ((state.takenAt.get(event.window) ?? 0) > takenAt) return;
    // A refusal on a window the backend did not name has no reset to end
    // it and no later reading that names it (EO-920). The backend
    // answering anything but a refusal is the evidence it has ended.
    if (!refused(event)) clearUnnamedRefusals(state, takenAt);
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
    state.takenAt.set(event.window, takenAt);
  };

  const changed = (provider: string, takenAt: number): void => {
    for (const listener of [...listeners]) {
      try {
        listener(provider, takenAt);
      } catch {
        // A listener is a doorbell; one that fails must not keep the
        // reading from the others, or from the backend that sent it.
      }
    }
  };

  return {
    record(event) {
      const takenAt = mark();
      take(event, now(), takenAt);
      changed(event.provider, takenAt);
    },
    recordRead(provider, answer, askedAt = mark()) {
      const at = now();
      const state = backendOf(provider);
      state.limitsApply = answer.limitsApply;
      for (const event of answer.readings) take({ ...event, provider }, at, askedAt);
      changed(provider, askedAt);
    },
    mark,
    limitLifted(provider) {
      const state = backends.get(provider);
      const takenAt = mark();
      if (state && clearUnnamedRefusals(state, takenAt)) changed(provider, takenAt);
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
