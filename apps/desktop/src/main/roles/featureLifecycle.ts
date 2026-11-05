import type { Item, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { finishedItemIds, listItems } from "../db/repos/index.js";

/**
 * How far a feature's work has got (ARCHITECTURE.md, "One work entity").
 *
 * A feature is a container, not a task: it carries no changes of its own
 * and nothing dispatches against it, so it is finished exactly when the
 * stories under it are. That used to be *stored* — a story's transition
 * pushed its feature to `pending_approval` or to the terminal step, and
 * pushed it back when a story reopened — which meant a feature had a
 * column, a position in the pipeline, and a state that could be wrong
 * between the two writes.
 *
 * Derived instead, for the same reason `!` is (invariant #6): a stored
 * copy of something computable is a second source of truth, free to
 * disagree with the first. Nothing writes a feature's state any more,
 * because there is nothing to write.
 */
export interface FeatureProgress {
  done: number;
  total: number;
}

export function featureProgress(db: Db, featureId: Uuid, items?: Item[]): FeatureProgress {
  const stories = (items ?? listItems(db)).filter((candidate) => candidate.parentId === featureId);
  // Each story by *its own* version (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
  // Whether a story is
  // done is a fact about the story, and a save that marks a step
  // terminal must not finish work that entered before it said so — nor
  // unfinish work that already ended on a step a later save unmarked.
  // A feature's progress is the sum of those answers, so it inherits the
  // rule rather than restating it.
  const finished = finishedItemIds(db, stories);
  return { done: stories.filter((story) => finished.has(story.id)).length, total: stories.length };
}

/**
 * Is this feature finished?
 *
 * A feature with no stories is not: its plan has not been approved, so it
 * has not started rather than ended.
 */
export function featureIsDone(progress: FeatureProgress): boolean {
  return progress.total > 0 && progress.done === progress.total;
}
