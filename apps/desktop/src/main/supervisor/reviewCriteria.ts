import { acceptanceCriteriaOf, criteriaField, criteriaOfferField, type Item, type SpecShape, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { blockerWords } from "./dispatchBlockers.js";
import { newestParkedRun } from "./manualDispatch.js";

/**
 * How every refusal of a criteria-less review opens (EO-213).
 *
 * Load-bearing in two directions. It is the first clause of the
 * sentence a person reads, and it is how EO recognises its own refusal
 * afterwards — `parkedForMissingCriteria` below matches on it.
 *
 * Deliberately free of interpolation. The rest of the body names the
 * item's type and quotes a bug's `expected`, and both of those are
 * things a person may edit between the refusal being written and EO
 * reading it back; matching on the whole sentence would then quietly
 * fail to recognise a park EO itself created. Comparing text rather than
 * hiding a marker in it is the same choice `postDispatchNotices` makes,
 * and for the same reason: the thing that must stay stable *is* the
 * sentence.
 */
const REFUSAL_OPENING = "EO did not start this review: ";

/**
 * What EO says instead of reviewing an item that declares nothing to
 * judge it against (EO-213).
 *
 * The words come from `blockerWords` rather than being written out
 * again, so the refusal in the thread, the answer to "why is nothing
 * happening?" and a turned-down rerun cannot come to say three
 * different things about one condition.
 *
 * The last paragraph is the whole of what a person has to do, and it is
 * deliberately not "reply here". Every other refusal in this codebase
 * parks an item until somebody answers, because a signed-out backend
 * or a dirty worktree is not something EO can watch. Criteria are: EO
 * can see them arrive, so it says so and picks the review up itself.
 *
 * Some types get one extra line, and it is an *offer*, not a criterion.
 * The tempting shortcut is to treat a bug's `expected` as an implicit
 * criterion — which would be EO inventing a criterion nobody wrote,
 * the exact thing EO-200 refuses to do. So the wording is put in front
 * of the person to accept or reject in one line, and nothing is
 * declared on their behalf.
 *
 * Which field that is, and whether there is one, is the type's shape's
 * answer since KAN-147 (`x-eo-criteria-offer`) rather than this file
 * knowing that a bug has an `expected`. A type that declares no such
 * field gets the two paragraphs and nothing more, which is what a story
 * always got.
 */
export function missingCriteriaRefusal(item: Item, shape: SpecShape): string {
  const { condition, fix } = blockerWords({ kind: "no_acceptance_criteria" });
  const paragraphs = [
    `${REFUSAL_OPENING}${condition}.`,
    `${fix} Nothing else is needed — the next tick starts the review by itself once at least one is there.`,
  ];

  const offered = criteriaOfferField(shape);
  const value = offered === undefined ? undefined : item.spec?.[offered.name];
  // Only where the type does not *demand* criteria: a type that does has
  // no "not required to declare any" to say, and an item of one that
  // reached here without them was not filed through a door that checks.
  const demanded = criteriaField(shape)?.required === true;
  if (offered !== undefined && !demanded && typeof value === "string" && value.trim() !== "") {
    paragraphs.push(
      `A ${item.type} is not required to declare any — the fields it must arrive with are its bar — so EO has not turned this one's ` +
        `"${offered.name}" into a criterion for you. If the fix should be judged against it, that is one line to add:`,
      `> ${value.trim().replace(/\n/g, "\n> ")}`,
    );
  }

  return paragraphs.join("\n\n");
}

/**
 * Whether the run parking this item is EO's own criteria refusal
 * (EO-213).
 *
 * Asked so the scheduler can stop treating it as a park. Every other
 * parked run is waiting on something only a person can supply, and the
 * park is what keeps the item still until they supply it. This one is
 * waiting on something EO checks on every tick — so the park would
 * outlive its own reason, and a person who did exactly what the
 * escalation asked would watch nothing happen. The blocker is what
 * holds the item meanwhile, and it lifts the moment a criterion is
 * written.
 *
 * `threadId === null` because a refusal never reached a provider; it is
 * the same test `isGuardPlaceholder` makes, and it is what stops a real
 * parked review whose feedback happens to quote this sentence from
 * being mistaken for one.
 */
export function parkedForMissingCriteria(db: Db, itemId: Uuid): boolean {
  const parked = newestParkedRun(db, itemId);
  return parked !== undefined && parked.threadId === null && isMissingCriteriaAsk(parked.error ?? "");
}

/**
 * Whether this text is the refusal above (EO-213).
 *
 * The refusal is a *question*, and a question has to be closed when it
 * is answered or the `!` it raised outlives it — an item whose review
 * has since run and been approved would sit in the inbox forever
 * (invariant #6: needs-attention is derived, so it has to derive from
 * something that stops being true). EO recognises its own ask by the
 * clause it opens with, which is why that clause interpolates nothing.
 *
 * Used against a run's `error` and against a comment's body, which
 * carry the same string: the refusal writes one sentence into both, so
 * one test recognises it wherever it was recorded.
 */
export function isMissingCriteriaAsk(text: string): boolean {
  return text.startsWith(REFUSAL_OPENING);
}

/**
 * True when this item declares nothing a review could be checked against.
 *
 * Read by the name its type's shape gives the field (KAN-147), so a type
 * whose bar is called something else is judged against the right one
 * rather than against an `acceptance_criteria` it never had.
 */
export function declaresNoCriteria(item: Item, shape: SpecShape): boolean {
  return acceptanceCriteriaOf(item, shape).length === 0;
}
