import { z } from "zod";

/**
 * An item's priority, as anything that sets one is held to it (EO-568).
 *
 * An open integer, 0 or more, which the scheduler sorts descending:
 * higher is picked first. The common levels have names — 0 Normal,
 * 1 High, 2 Urgent — and anything above is still a priority, shown as
 * "Priority N". Negative is refused, because a person cannot set one and
 * `items:update` would refuse it anyway.
 *
 * One schema for every door that writes the column — `items:update`,
 * `work:submitItem`, `work:submitPlan` and the system agent's proposals
 * — so that an amendment, a submission and an edit cannot drift into
 * disagreeing about what a priority is. The description travels with it
 * into each tool's and each provider's JSON Schema, because a field
 * called `priority` says nothing about which way it sorts.
 */
export const ItemPrioritySchema = z
  .number()
  .int()
  .min(0)
  .describe("An integer, 0 or more; the scheduler picks the highest first. 0 is Normal, 1 High, 2 Urgent.");

/** The named levels, in ascending order. The column stays an open integer; only these have names. */
export const PRIORITY_LEVELS = [
  { value: 0, label: "Normal" },
  { value: 1, label: "High" },
  { value: 2, label: "Urgent" },
] as const;

/** A priority's name, or "Priority N" for one outside the named levels — the column is an open integer. */
export function priorityLabel(priority: number): string {
  return PRIORITY_LEVELS.find((level) => level.value === priority)?.label ?? `Priority ${priority}`;
}
