import { REVIEW_ACTION, type Item } from "@eo/core";
import type { Db } from "../db/client.js";
import { activeRunForItem, stepForItem } from "../db/repos/index.js";

/**
 * The one rule about when an item's own content may change, wherever
 * the change comes from.
 *
 * It began in `discussion.ts`, guarding the amendments a product owner
 * proposes in a conversation. EO-166 gave a person a second door onto
 * the same act — editing acceptance criteria straight from the item
 * screen or through `ticket_update` — and two doors onto one act want
 * one rule between them, not a second one written to resemble the
 * first. So it lives here and both call it; a refusal reads identically
 * whichever way the edit arrived, and there is one place to change when
 * the rule changes.
 */
/**
 * What a caller is asking to change, which is what the rule turns on.
 *
 * A boolean before EO-213, when there were two answers. The third is not
 * a widening of `content` but a much narrower thing than it: one field,
 * on an item in one state, for one reason.
 */
export type ItemChange =
  /** A title, a body, acceptance criteria, a dependency edge — anything about what the work *is*. */
  | "content"
  /** Priority and nothing else. */
  | "priority"
  /**
   * The acceptance criteria a refused review is waiting for, on an item
   * that declares none (EO-213).
   *
   * Only the caller can know this is what it is asking for, which is why
   * it is a parameter rather than something this function infers from
   * the item. Inferring it would mean "the item declares no criteria"
   * silently licensed *every* content change on it, which is the bug
   * this type exists to make impossible: a conversation could rewrite the
   * title and the dependency graph after implementation had finished,
   * then add a criterion and send the altered item to review.
   */
  | "missing-criteria";

/**
 * Whether this item may be changed, and why not when it may not.
 *
 * The rule is per change kind rather than one blanket check:
 *
 * - **Content** — a title, a body, acceptance criteria, a dependency
 *   edge — needs an item that has not moved past `todo` and has no run
 *   against it. Editing what an implementer is holding changes the
 *   thing it is being judged against halfway through, and editing
 *   something already reviewed or merged rewrites history that other
 *   work was built on. In both cases a follow-up is the honest move.
 * - **Priority alone** is allowed anywhere non-terminal. It only
 *   affects the order the scheduler picks work up in, so it cannot
 *   corrupt anything in flight — and refusing it would mean you could
 *   not deprioritise an item precisely when you most want to.
 * - **The missing criteria** are content in every respect but one: the
 *   in-review clause below does not apply to them, because there is no
 *   review to invalidate. Everything else still does — archived,
 *   finished and held-by-a-running-agent refuse it exactly as they
 *   refuse any other edit.
 *
 * Terminal is refused for all of them, because reordering or
 * reprioritising finished work does nothing at all.
 *
 * The active-run clause is the deliberate answer to "may a person
 * correct acceptance criteria while an agent holds the item?"
 * (EO-166): no, and the reasoning is the bullet above rather than a new
 * one — a reviewer approving against criteria the implementer never saw
 * is worse than either version of them. It is refused rather than
 * permitted-with-a-comment because a run is minutes long and a refusal
 * that says "try again once the run has finished" costs a wait, while a
 * target that moves mid-run costs a review nobody can trust. Runs are
 * discrete: an item sitting on a step between runs is editable, which
 * is the state a person correcting a criterion is nearly always in.
 */
export function refuseIfUntouchable(db: Db, item: Item, change: ItemChange): string | null {
  const state = stepForItem(db, item);

  if (item.archivedAt !== null) return `${item.key} has been archived. Restore it first, or propose new work instead.`;
  if (state?.isTerminal) return `${item.key} is finished. Propose a follow-up ticket rather than changing what shipped.`;
  if (change === "priority") return null;

  if (activeRunForItem(db, item.id) !== undefined) {
    return `${item.key} is being worked on right now, so its content cannot change under the agent holding it. Propose a follow-up, or try again once the run has finished.`;
  }
  // What the step *runs*, not what it is called and not who owns it.
  //
  // `stepId === "review"` was the shipped pipeline's slug, so this guard
  // silently stopped applying the moment a second pipeline existed and an
  // amendment could rewrite acceptance criteria out from under a review
  // on it. `ownerRole === "reviewer"` is no better: `owner_role` is free
  // text too, so a `qa` step that reviews — the architect's own worked
  // example — is owned by a "qa" agent and would not have matched, while
  // a reviewer-owned step sitting *before* implementation would have
  // refused amendments it has no business refusing.
  //
  // The action is the honest key. It is where this codebase already draws
  // the data/code line — `SCHEMAS_BY_ACTION` is a lookup precisely so a
  // pipeline may define steps EO has never heard of — and any step
  // running `review` is judging the item against its criteria, whatever
  // it is named and whoever owns it. Inserting a `qa` step that reviews
  // needs no TypeScript, which is what invariant #7 asks for. An action
  // EO does not ship cannot be judged from here, but such an action needs
  // a schema and a handler anyway, so it arrives with code either way.
  //
  // Not applied to the one edit a refused review is waiting for
  // (EO-213). An item sitting on a review step that declares no
  // acceptance criteria is one EO has refused to dispatch and will go on
  // refusing, and the escalation it posted asks for exactly the edit this
  // clause would turn down. The rule stands on "changing what it asks for
  // invalidates the review", and a review that cannot start is not one
  // this protects — where adding the criterion is the only thing that
  // lets it start at all.
  //
  // Narrow on purpose, and narrow in the *caller's* terms rather than in
  // the item's. Keying the exception on "this item declares no
  // criteria" would have excused every content change on such an item:
  // an amendment could rewrite the title and body, and a reorder the
  // dependency graph, after the implementer had finished — and then one
  // criterion would send that altered item to a review that had never
  // seen any of it.
  if (state?.entryAction === REVIEW_ACTION && change !== "missing-criteria") {
    return `${item.key} is in review. Changing what it asks for now would invalidate the review — propose a follow-up ticket instead.`;
  }

  return null;
}
