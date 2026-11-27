import { REVIEW_ACTION, type Item, type ReviewVerdictEvent } from "@eo/core";
import type { Db } from "../../db/client.js";
import { reviewVerdictsOfRuns } from "../../db/repos/index.js";
import type { RouteLimitNote, RouteOverrun } from "../../supervisor/routeLimits.js";

/**
 * What this pack adds when a route's traversal limit holds an item
 * (EO-921): for a route out of a step that reviews, the acceptance
 * criteria each counted review round found met, out of those the ticket
 * declared — so the person asked can see whether the loop is converging
 * or only finding a new, rarer edge case each round.
 *
 * Read off the verdict each review run recorded (`review_verdict`,
 * `roles/reviewVerdict.ts`), by the runs whose results took the route.
 * The core counts routes and knows nothing of reviews; this is where a
 * review is recognised, by its step's action rather than its id, so a
 * `qa` step that reviews is read the same (invariant 7).
 */
export const reviewRoundsNote: RouteLimitNote = (db: Db, item: Item, overrun: RouteOverrun): string | null => {
  // The step as the graph the route was read from has it: for a route
  // into another pipeline, the version the move left, not the item's own.
  if (overrun.fromStep?.entryAction !== REVIEW_ACTION) return null;
  const verdicts = reviewVerdictsOfRuns(
    db,
    overrun.traversals.flatMap((traversal) => (traversal.runId === null ? [] : [traversal.runId])),
  );
  const rounds = overrun.traversals.map((traversal) => (traversal.runId === null ? undefined : verdicts.get(traversal.runId)));
  if (rounds.every((round) => round === undefined)) return null;
  return `Acceptance criteria met in each of these ${rounds.length} review rounds, oldest first: ${rounds.map(roundWords).join(", ")}.`;
};

/** One round, as the line reads it. */
function roundWords(round: ReviewVerdictEvent | undefined): string {
  if (round === undefined) return "not recorded";
  if (round.declaredCriteria === 0) return "none declared";
  // An approval asserts every criterion is met and records no coverage.
  if (round.verdict === "approve") return `${round.declaredCriteria} of ${round.declaredCriteria}`;
  if (round.verdict !== "reject") return "not judged";
  return `${round.met} of ${round.declaredCriteria}`;
}

/** This pack's paragraphs for the comment that holds an item, in the order they are said. */
export const developerRouteLimitNotes: readonly RouteLimitNote[] = [reviewRoundsNote];
