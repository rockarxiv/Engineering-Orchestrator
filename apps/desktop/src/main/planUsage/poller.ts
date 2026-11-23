import { planUsageRuntimeQualifies, type RuntimeStatusView } from "@eo/core";
import type { PlanUsageReader } from "../providers/planUsageReaders.js";
import { planUsage, type PlanUsageStore } from "./store.js";

/** How often each signed-in backend's plan windows are read while EO runs. */
export const PLAN_USAGE_INTERVAL_MS = 5 * 60_000;

export interface PlanUsageReadOptions {
  readers: readonly PlanUsageReader[];
  /** The backend's runtime as `runtime:status` reports it — installed, enabled, signed in. */
  status(provider: string): Promise<RuntimeStatusView | null>;
  store?: PlanUsageStore;
  intervalMs?: number;
}

/**
 * Reads every signed-in backend's plan windows at start-up and every five
 * minutes after (EO-896), so that the rail's bars keep moving while
 * nothing runs.
 *
 * Each tick asks the runtime's status first and reads only a backend that
 * is installed, enabled and signed in: signing one out or disabling it
 * is what stops its reads, and signing back in starts them on the next
 * tick. A read that fails keeps the last reading and is tried again on
 * the next tick; it is never said anywhere — not a comment, a message or
 * an error in the UI. One read per backend at a time: a tick that finds
 * the last still running leaves it be.
 *
 * Returns the stop.
 */
export function startPlanUsageReads(options: PlanUsageReadOptions): () => void {
  const store = options.store ?? planUsage;
  const reading = new Set<string>();
  let stopped = false;

  const readOne = async (reader: PlanUsageReader): Promise<void> => {
    if (reading.has(reader.provider)) return;
    reading.add(reader.provider);
    try {
      const runtime = await options.status(reader.provider);
      if (stopped || !runtime || !planUsageRuntimeQualifies(runtime)) return;
      const answer = await reader.read(runtime.path);
      if (!stopped && answer.ok) store.recordRead(reader.provider, answer);
    } catch {
      // Kept quiet on purpose: the last reading stands, and the next tick tries again.
    } finally {
      reading.delete(reader.provider);
    }
  };

  const tick = (): void => {
    for (const reader of options.readers) void readOne(reader);
  };

  tick();
  const timer = setInterval(tick, options.intervalMs ?? PLAN_USAGE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
