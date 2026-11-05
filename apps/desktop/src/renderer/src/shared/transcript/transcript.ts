import type { RunGroup } from "./grouping";

export function formatDuration(elapsedMs: number | null): string {
  if (elapsedMs === null) return "—";
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** How many turns it took, said only when that is more than one. */
export function turnLabel(group: RunGroup): string | null {
  return group.runs.length > 1 ? `${group.runs.length} turns` : null;
}

/** Token counts run to six and seven figures, and nobody reads those digit by digit. */
export function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  // Rounded before the comparison, so 999,999 reads as 1.0M rather than
  // as the "1000k" that rounding it inside the k-branch produces.
  if (Math.round(tokens / 1_000) < 1_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * How much of the input came back out of the prompt cache.
 *
 * The number that says whether a long prompt is actually expensive. An
 * agentic loop re-sends its whole conversation every turn, so input
 * tokens climb into the millions either way — a high cached share means
 * those re-sends are being served cheaply, a low one means they are not.
 */
export function cachedShare(tokensIn: number | null, cacheReadTokens: number | null): string | null {
  if (tokensIn === null || cacheReadTokens === null || tokensIn === 0) return null;
  // Clamped because this renders a backend's arithmetic, not ours: a
  // cached figure larger than the total it is a part of is nonsense, and
  // "103% cached" reads as a bug in EO rather than in what it was told.
  return `${Math.min(100, Math.round((100 * cacheReadTokens) / tokensIn))}% cached`;
}
