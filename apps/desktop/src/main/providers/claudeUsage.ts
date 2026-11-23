import type { query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { QuotaEvent } from "@eo/core";
import type { PlanUsageAnswer } from "./planUsageReaders.js";

const PROVIDER = "claude";

/** How long one read may take before it is given up on until the next tick. Measured at about 350 ms. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The name of the SDK's usage method, written here and nowhere else in
 * EO's non-test code (EO-896). It is experimental, and its name changes
 * when Anthropic stabilises it; `claudeUsage.test.ts` fails when the
 * bundled SDK's `Query` stops declaring it, so a bump that renames it is
 * a failing test rather than bars that silently stop moving.
 */
export const CLAUDE_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET" as const;

type UsageMethod = (opts?: { skipBehaviors?: boolean }) => Promise<SDKControlGetUsageResponse>;

/**
 * Claude's plan windows, read without a model turn (EO-896): the data
 * behind Claude Code's `/usage`.
 *
 * A fresh session for every read, closed when it has answered, as
 * `fetchClaudeModels` does for `supportedModels()`: a second call on one
 * session answered in a millisecond, which is a cache and not a reading.
 * The session's prompt is a stream that never yields, so no message is
 * sent on it and nothing is spent (measured: no message came back, cost
 * 0, API time 0).
 *
 * Never throws. A missing method, a throw, a timeout or an answer of the
 * wrong shape is `{ ok: false }`, and the caller keeps what it had.
 */
export async function readClaudePlanUsage(
  runQuery: typeof query,
  options: { executablePath: string | null; apiKey?: string | null },
): Promise<PlanUsageAnswer> {
  let release: () => void = () => {};
  const idle = new Promise<void>((resolve) => (release = resolve));
  // A prompt that sends nothing and ends when the read is over.
  const nothing: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<never>> => {
        await idle;
        return { done: true, value: undefined };
      },
    }),
  };
  let session: ReturnType<typeof query> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    session = runQuery({
      prompt: nothing,
      options: {
        maxTurns: 1,
        settingSources: [],
        ...(options.executablePath ? { pathToClaudeCodeExecutable: options.executablePath } : {}),
        // The key EO holds is what a run spends (EO-84), so the read asks
        // as the run would: a run on a key has no plan window to show.
        ...(options.apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: options.apiKey } } : {}),
      },
    });
    const opened = session;
    // Drained, never read: the session's own messages are not the answer.
    void (async () => {
      try {
        for await (const message of opened) void message;
      } catch {
        // Ended by `close()` below, or by a CLI that never came up.
      }
    })();
    const method = (opened as unknown as Record<string, unknown>)[CLAUDE_USAGE_METHOD];
    if (typeof method !== "function") return { ok: false };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("usage read timed out")), READ_TIMEOUT_MS);
    });
    const answer = await Promise.race([(method as UsageMethod).call(opened, { skipBehaviors: true }), timeout]);
    return claudeUsageAnswer(answer);
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
    release();
    try {
      session?.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * A usage answer as the `quota` readings a `rate_limit_event` becomes:
 * each window's `resets_at` (ISO 8601) as milliseconds, and a window at
 * 100% refused, since the next request on it is. Windows other than
 * `five_hour` and `seven_day` — `seven_day_opus` and the rest — are kept
 * under their own names.
 */
export function claudeUsageAnswer(answer: unknown): PlanUsageAnswer {
  if (!answer || typeof answer !== "object") return { ok: false };
  const response = answer as Partial<SDKControlGetUsageResponse>;
  if (response.rate_limits_available === false) return { ok: true, limitsApply: false, readings: [] };
  if (response.rate_limits_available !== true) return { ok: false };
  const readings: QuotaEvent[] = [];
  for (const [window, value] of Object.entries(response.rate_limits ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { utilization, resets_at } = value as { utilization?: unknown; resets_at?: unknown };
    const share = typeof utilization === "number" && Number.isFinite(utilization) ? utilization : undefined;
    const resetsAt = typeof resets_at === "string" ? Date.parse(resets_at) : Number.NaN;
    readings.push({
      type: "quota",
      provider: PROVIDER,
      window,
      ...(share === undefined ? {} : { utilization: share }),
      status: share !== undefined && share >= 100 ? "rejected" : "allowed",
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    });
  }
  return { ok: true, limitsApply: true, readings };
}
