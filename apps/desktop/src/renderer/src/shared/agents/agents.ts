import type { StatusTone } from "@eo/ui";
import { runtimeState } from "./runtimeStatus";

/**
 * What the card's status word is.
 *
 * `archivedAt` first, then `enabled` — the agent's own two, in the order
 * that settles it (EO-186): a retired agent is not paused and not
 * online, and nothing about a runtime changes that. The rest is the
 * machine's.
 */
export function agentStatus(enabled: boolean, archivedAt: number | null, state: ReturnType<typeof runtimeState> | null): { tone: StatusTone; label: string } {
  if (archivedAt !== null) return { tone: "idle", label: "Archived" };
  if (!enabled) return { tone: "paused", label: "Paused" };
  if (state === null) return { tone: "running", label: "Online" };
  if (state === "ready") return { tone: "running", label: "Online" };
  if (state === "updating") return { tone: "reviewing", label: "Updating" };
  if (state === "error") return { tone: "danger", label: "Runtime error" };
  return { tone: "paused", label: "Runtime missing" };
}

export function executablePath(config: Record<string, unknown>): string | null {
  const value = config["executablePath"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
