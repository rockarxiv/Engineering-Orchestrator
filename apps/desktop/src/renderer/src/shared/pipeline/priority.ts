import { PRIORITY_LEVELS, priorityLabel } from "@eo/core";

/**
 * How a priority is shown, in one place (U-13).
 *
 * The card and the item header rendered this differently — the same
 * item was red on the project and amber on its own page — because each
 * had its own copy.
 *
 * Named rather than numbered: "P1" reads as a rank, and a rank reads
 * backwards from urgency (P1 sounds more important than P2, and here it
 * is the reverse). The column stays an open integer for the scheduler,
 * which sorts descending; only the display is named.
 *
 * The names themselves are in `@eo/core` since EO-568, because the main
 * process writes them too — on a proposal card's body — and a second
 * copy there is the drift this file was made to end.
 */
export { PRIORITY_LEVELS, priorityLabel };

export type PriorityTone = "neutral" | "warning" | "danger";

export function priorityTone(priority: number): PriorityTone {
  if (priority >= 2) return "danger";
  if (priority === 1) return "warning";
  return "neutral";
}

/** Normal is the absence of a priority, and says nothing worth a badge. */
export function showsPriorityBadge(priority: number): boolean {
  return priority !== 0;
}
