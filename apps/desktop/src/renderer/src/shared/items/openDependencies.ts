import type { ItemSummary } from "@eo/core";

/**
 * Why a card is blocked by its dependencies, as its hover says it
 * (EO-776): one line per open `reached` edge in the main process's own
 * words — "Waits for EO-12 to reach Review (now at To Do)" — and the
 * words every other open edge has always had, for the rest.
 */
export function openDependencyTitle(item: Pick<ItemSummary, "openDependencyCount" | "openDependencyGates">): string {
  const rest = item.openDependencyCount - item.openDependencyGates.length;
  const lines = [...item.openDependencyGates];
  if (rest > 0) lines.push(`Blocked by ${rest} unfinished dependency(ies)`);
  return lines.join("\n");
}
