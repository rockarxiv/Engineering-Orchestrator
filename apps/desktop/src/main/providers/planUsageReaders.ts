import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { QuotaEvent } from "@eo/core";
import { readClaudePlanUsage } from "./claudeUsage.js";
import type { AppServerSpawn } from "./codexAppServer.js";
import { readCodexPlanUsage } from "./codexUsage.js";

/**
 * One read of a backend's plan windows (EO-896): its readings, and
 * whether plan limits apply to this sign-in at all — or that the read
 * did not answer, and whatever was read before stands.
 */
export type PlanUsageAnswer = { ok: true; limitsApply: boolean; readings: QuotaEvent[] } | { ok: false };

export interface PlanUsageReader {
  provider: string;
  /** Reads the backend through the executable given. Never throws. */
  read(executablePath: string | null): Promise<PlanUsageAnswer>;
}

export interface PlanUsageReaderOptions {
  /** The Claude Agent SDK's `query`, loaded from where EO put it. */
  claudeQuery(): Promise<typeof query>;
  /** The Claude key EO holds, which a run would spend (EO-84). */
  claudeApiKey?(): string | null;
  /** A test's stand-in for the app-server. */
  codexSpawn?: AppServerSpawn;
}

/**
 * How each backend's plan windows are read while nothing runs: a table
 * keyed by backend, so that the poller that walks it never asks which
 * backend it is holding (invariant 12, `backendBranching.test.ts`).
 */
export function planUsageReaders(options: PlanUsageReaderOptions): PlanUsageReader[] {
  const readers: Record<string, (executablePath: string | null) => Promise<PlanUsageAnswer>> = {
    claude: async (executablePath) => readClaudePlanUsage(await options.claudeQuery(), { executablePath, apiKey: options.claudeApiKey?.() ?? null }),
    codex: (executablePath) => readCodexPlanUsage(executablePath, options.codexSpawn),
  };
  return Object.entries(readers).map(([provider, read]) => ({
    provider,
    read: async (executablePath) => {
      try {
        return await read(executablePath);
      } catch {
        return { ok: false };
      }
    },
  }));
}
