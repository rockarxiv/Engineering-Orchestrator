import { z } from "zod";

/**
 * A step a save would remove while items sit on it (EO-230).
 *
 * `items.stepId` is a foreign key to `pipeline_steps.id` with no cascade,
 * and a publish replaces the graph wholesale — so nothing said what an
 * item does when the step under it goes. The full answer is immutable
 * pipeline versions (ARCHITECTURE.md, "Publish, lock and versions", phase 7c). The
 * honest first step, usable in solo mode now, is a refusal that names
 * the step and says how many: a person can move two items, and cannot
 * act on a foreign-key error.
 *
 * Typed rather than only worded, because a screen has more to offer than
 * the sentence — the board, narrowed to exactly those items — and it
 * cannot parse a count back out of prose. Both the validator's problem
 * and the repository's own refusal carry this shape, so whichever guard
 * a caller meets, it gets the same answer.
 *
 * `archived` is how many of `count` are put away. The foreign key holds
 * for them exactly as for live work, so they are counted — but they are
 * not on the board, and a refusal that sent somebody to the board for
 * an item the board cannot show would be naming a task with no door to
 * it. An archived item is restored from the Archive, and then moved.
 */
export const StepHoldingItemsSchema = z.object({
  stepId: z.string(),
  stepName: z.string(),
  /** Every item whose `stepId` is this step, archived ones included — the foreign key does not care. */
  count: z.number().int().positive(),
  /** Of those, the ones in the Archive: not on the board, restored before they can be moved. */
  archived: z.number().int().nonnegative(),
});

export type StepHoldingItems = z.infer<typeof StepHoldingItemsSchema>;

/**
 * The one sentence for a step that cannot go because items sit on it.
 *
 * One wording for the three places that say it — the editor's refusal
 * beside the step, the validator's problem at Publish, and the
 * repository's own guard under both — for the reason
 * `timeLimitBoundProblem` gives: a person who meets the same fact
 * spelled three ways comes to believe they are three different
 * problems. The step is named because it is what they were looking at;
 * the count is in the sentence because it is the size of what they have
 * to do.
 *
 * Archived items get a second sentence rather than a different first
 * one: the count is still the count, and what changes is the path — a
 * put-away item is not on the board to be moved, so it is restored
 * first, and the refusal says so rather than leaving somebody to find a
 * board with nothing on it.
 */
export function stepHoldsItemsMessage(hold: Pick<StepHoldingItems, "stepName" | "count" | "archived">): string {
  const lead =
    hold.count === 1
      ? `${hold.stepName} has 1 item on it. Move it before removing the step.`
      : `${hold.stepName} has ${hold.count} items on it. Move them before removing the step.`;
  if (hold.archived === 0) return lead;
  if (hold.archived === hold.count) {
    return hold.count === 1 ? `${lead} It is archived — restore it first.` : `${lead} All of them are archived — restore them first.`;
  }
  return hold.archived === 1 ? `${lead} 1 of them is archived — restore it first.` : `${lead} ${hold.archived} of them are archived — restore them first.`;
}
