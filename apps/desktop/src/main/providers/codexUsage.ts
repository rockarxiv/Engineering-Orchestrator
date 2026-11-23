import type { QuotaEvent } from "@eo/core";
import { codexRateLimitReadings } from "./codex.js";
import { AppServerConnection, type AppServerSpawn } from "./codexAppServer.js";
import { rateLimitSnapshotOf } from "./codexClient.js";
import type { PlanUsageAnswer } from "./planUsageReaders.js";

/** How long one read may take before it is given up on until the next tick. */
const READ_TIMEOUT_MS = 30_000;

/**
 * Codex's plan windows, read on demand (EO-896): the app-server's
 * `account/rateLimits/read`, which asks the account and runs no model
 * turn (measured on 0.166.0 and 0.167.1 in EO-644/EO-774).
 *
 * The answer's snapshots become the same `quota` readings
 * `account/rateLimits/updated` does during a run (`codexRateLimitReadings`):
 * every bucket in `rateLimitsByLimitId` where the server sends it, the
 * single `rateLimits` otherwise.
 *
 * Over a connection of its own, closed when it has answered, against the
 * person's own Codex home — the one `fetchCodexModels` asks. Never
 * throws: anything that goes wrong is `{ ok: false }`, and the caller
 * keeps what it had.
 */
export async function readCodexPlanUsage(executablePath: string | null, spawn?: AppServerSpawn): Promise<PlanUsageAnswer> {
  if (!executablePath) return { ok: false };
  let connection: AppServerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opened = new AppServerConnection({ executablePath, ...(spawn ? { spawn } : {}) });
    connection = opened;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("rate limit read timed out")), READ_TIMEOUT_MS);
    });
    const answer = await Promise.race([
      (async () => {
        await opened.initialize();
        return opened.request("account/rateLimits/read");
      })(),
      timeout,
    ]);
    return codexUsageAnswer(answer);
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    connection?.close();
  }
}

/** `account/rateLimits/read`'s answer as `quota` readings. */
export function codexUsageAnswer(answer: unknown): PlanUsageAnswer {
  if (!answer || typeof answer !== "object") return { ok: false };
  const { rateLimits, rateLimitsByLimitId } = answer as { rateLimits?: unknown; rateLimitsByLimitId?: unknown };
  const buckets =
    rateLimitsByLimitId && typeof rateLimitsByLimitId === "object" && Object.keys(rateLimitsByLimitId).length > 0
      ? Object.values(rateLimitsByLimitId as Record<string, unknown>)
      : [rateLimits];
  const readings: QuotaEvent[] = [];
  for (const bucket of buckets) {
    const snapshot = rateLimitSnapshotOf(bucket);
    if (snapshot) readings.push(...codexRateLimitReadings(snapshot));
  }
  if (readings.length === 0) return { ok: false };
  return { ok: true, limitsApply: true, readings };
}
