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
 * A read is also how a backend held at its plan limit is seen back
 * (EO-920): the supervisor hears every change to the store, and one that
 * shows every window of a held backend allowed and below 100% lifts the
 * hold, before the reset it named or when it named none. So a held
 * backend is read like any other, and nothing here knows of the hold —
 * except that a read says when it was asked (`store.mark()`), so that
 * one asked before the hold began cannot lift it.
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
    // Taken before anything is asked: the answer is the account as it
    // stood then, and must not overwrite a refusal that arrives while the
    // read is in flight, nor lift the hold that refusal begins (EO-920).
    const askedAt = store.mark();
    try {
      const runtime = await options.status(reader.provider);
      if (stopped || !runtime || !planUsageRuntimeQualifies(runtime)) return;
      const answer = await reader.read(runtime.path);
      if (!stopped && answer.ok) store.recordRead(reader.provider, answer, askedAt);
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
