import { z } from "zod";
import type { RuntimeStatusView } from "./ipc-schemas.js";

/**
 * Each signed-in backend's plan usage, as the rail draws it above its
 * footer (EO-896).
 *
 * The readings are the `quota` events EO already makes of both backends'
 * own reports — Claude's `rate_limit_event`, Codex's
 * `account/rateLimits/updated` — and of the two reads the main process
 * takes every five minutes so that the bars do not freeze while nothing
 * runs. The newest one per backend and window is kept in memory and
 * nowhere else: not a comment, not a message, not a run event, not a
 * table.
 */

/** One window's latest reading. */
export const PlanUsageWindowSchema = z.object({
  /** The backend's own name for it: `five_hour`, `7_day`, `seven_day_opus`, … */
  window: z.string(),
  /** Percentage used, 0–100. Null when the reading did not say. */
  utilization: z.number().nullable(),
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  /** When the window refreshes, epoch milliseconds. Null when the reading gave no time EO could believe (`quotaResetAt`). */
  resetsAt: z.number().nullable(),
  /** When this reading arrived, epoch milliseconds. */
  readAt: z.number(),
});
export type PlanUsageWindow = z.infer<typeof PlanUsageWindowSchema>;

export const PlanUsageBackendSchema = z.object({
  provider: z.string(),
  /**
   * False when the backend said plan limits do not apply to this sign-in
   * — an API key, Bedrock or Vertex, which Claude's usage read answers
   * with `rate_limits_available: false`. Such a backend gets no group.
   */
  limitsApply: z.boolean(),
  windows: z.array(PlanUsageWindowSchema),
});
export type PlanUsageBackend = z.infer<typeof PlanUsageBackendSchema>;

/** What `planUsage:get` answers: every backend EO holds a reading for, or has been told has no limits. */
export const PlanUsageViewSchema = z.object({ backends: z.array(PlanUsageBackendSchema) });
export type PlanUsageView = z.infer<typeof PlanUsageViewSchema>;

/** A window at or past this share is drawn amber. */
export const PLAN_USAGE_WARNING_PERCENT = 80;

/**
 * The windows drawn as bars, by the names either backend gives them:
 * Claude's `five_hour` and `seven_day`, the `5_hour` and `7_day` Codex's
 * are named from their lengths (`codexWindowName`), and the
 * `monthly_credits` a Codex Business or Enterprise sign-in's monthly
 * spend limit becomes (EO-922). A bar is drawn only where a reading
 * exists. Every other window is not drawn as a bar; a refusal on one is
 * a note.
 */
export const PLAN_USAGE_BARS = [
  { label: "5h", windows: ["five_hour", "5_hour"] },
  { label: "Week", windows: ["seven_day", "7_day"] },
  { label: "Month", windows: ["monthly_credits"] },
] as const;

/**
 * Whether a runtime's status puts it in the rail's Usage block: it is
 * installed, enabled and signed in. One rule for the renderer, which
 * draws a group, and the main process, which reads only backends that
 * pass it — so signing out or disabling stops the five-minute reads.
 */
export function planUsageRuntimeQualifies(runtime: RuntimeStatusView | null | undefined): boolean {
  if (!runtime) return false;
  if (runtime.enabled === false) return false;
  const state = runtime.state ?? (runtime.source === "absent" ? "needs_consent" : "ready");
  if (state === "needs_consent" || state === "disabled") return false;
  return runtime.auth.state === "signed_in";
}

export type PlanWindowTone = "neutral" | "warning" | "danger";

/** A window as it is drawn at `now`. */
export interface ShownPlanWindow {
  window: string;
  /** The share drawn, 0–100, or null when the reading gave none. */
  percent: number | null;
  tone: PlanWindowTone;
  refused: boolean;
  /** When it refreshes, when that is still ahead. */
  resetAt: number | null;
}

/**
 * A reading as it stands at `now`.
 *
 * Once `now` passes the window's reset, the reading is over whether or
 * not a new one has arrived: the window is drawn at 0%, neutral, and a
 * refusal on it has ended.
 */
export function shownPlanWindow(reading: PlanUsageWindow, now: number): ShownPlanWindow {
  if (reading.resetsAt !== null && now >= reading.resetsAt) {
    return { window: reading.window, percent: 0, tone: "neutral", refused: false, resetAt: null };
  }
  const refused = reading.status === "rejected" || (reading.utilization !== null && reading.utilization >= 100);
  const percent = reading.utilization === null ? (refused ? 100 : null) : Math.min(100, Math.max(0, reading.utilization));
  const tone: PlanWindowTone = refused ? "danger" : percent !== null && percent >= PLAN_USAGE_WARNING_PERCENT ? "warning" : "neutral";
  return { window: reading.window, percent, tone, refused, resetAt: reading.resetsAt };
}

/**
 * The next moment a reading drawn now would be drawn differently
 * without any new reading arriving: the earliest reset still ahead.
 * Null when there is none.
 */
export function nextPlanUsageChange(backends: readonly PlanUsageBackend[], now: number): number | null {
  let next: number | null = null;
  for (const backend of backends) {
    for (const reading of backend.windows) {
      if (reading.resetsAt !== null && reading.resetsAt > now && (next === null || reading.resetsAt < next)) next = reading.resetsAt;
    }
  }
  return next;
}
