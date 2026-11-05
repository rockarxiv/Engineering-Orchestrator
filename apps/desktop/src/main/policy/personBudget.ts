import { personBudgetRefusal, PERSON_BUDGET_REFUSAL_OPENING, type PersonBudget, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { listCommentsForItem, listMentionsForComment, postComment } from "../db/repos/commentsRepo.js";
import { getProject } from "../db/repos/projectsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";

/**
 * A person's day, as the **record** counts it (EO-328,
 * `ARCHITECTURE.md`, "Policy", review).
 *
 * The design says the budget is *per person*, and a person has more than one
 * machine. The first draft counted from whichever replica happened to
 * ask — so Anna's laptop and Anna's desktop each believed they had the
 * whole ceiling to themselves, and two devices could spend it twice.
 * Worse, a replica that had not synced yet counted a fraction of what
 * had actually been spent and let work through on the strength of it.
 *
 * So the number is the record's. Every device's runs reach the record
 * (EO-324 ships them on the tick), the record is the only thing that
 * can see all of them at once, and this is the query that asks it —
 * reached from a device through `record:spend`, and answered locally
 * where this process *is* the record.
 */

/**
 * Whose day an item spends from.
 *
 * Through the project, which is the chain EO-326 already reasons about
 * for a project total: a run belongs to an item, an item to a project,
 * and a project to the person the record assigned it to on the move.
 * Null on every item of a solo installation and of a project somebody
 * kept local — there is nobody for a per-person ceiling to be about, and
 * `NO_POLICY` means there is no ceiling either.
 */
export function ownerOfItem(db: Db, itemId: Uuid): Uuid | null {
  const item = getItem(db, itemId);
  if (item === undefined || item.projectId === null) return null;
  return (getProject(db, item.projectId as Uuid)?.ownerId as Uuid | undefined) ?? null;
}

/**
 * Says the day is spent, on the item, once.
 *
 * **One owner of this sentence, called from two places**, and that is
 * why it is a function rather than two copies. The record withholds the
 * work (`localRecord.offerWork`) and a device refuses the dispatch
 * (`runSupervisor`), and which of the two gets there first depends on
 * whether the device was holding a lease when the ceiling was reached.
 * Both have to speak — a guard that dropped work without a comment is
 * invariant #8 broken — and neither may speak twice.
 *
 * Idempotent on the *open mention* rather than on a stored flag
 * (invariant #6): the question "has this item already been told" is
 * exactly "is there an unaddressed budget escalation on it", and a
 * person replying is what makes it worth saying again tomorrow. So a
 * hundred ticks under the ceiling produce one comment, and the next day
 * — a fresh ceiling, an addressed mention — produces a fresh one.
 *
 * Answers whether it wrote, so a caller can log or test the distinction
 * without asking the database a second time.
 */
export function parkForPersonBudget(db: Db, itemId: Uuid, budget: PersonBudget): boolean {
  if (alreadyParked(db, itemId)) return false;
  postComment(db, {
    itemId,
    author: { type: "engine" },
    kind: "escalation",
    mentions: [{ type: "human" }],
    parseBodyMentions: false,
    body: personBudgetRefusal(budget),
  });
  return true;
}

/**
 * Whether this item is already carrying an unanswered word about the
 * budget.
 *
 * Matched on the sentence's own opening rather than on a comment kind,
 * because `escalation` is what every guard writes and an item parked by
 * the attempt limit must not silence this one.
 * `PERSON_BUDGET_REFUSAL_OPENING` is core's and is what
 * `personBudgetRefusal` is built from, so the recogniser cannot drift
 * away from the sentence it recognises.
 */
function alreadyParked(db: Db, itemId: Uuid): boolean {
  for (const comment of listCommentsForItem(db, itemId)) {
    if (comment.kind !== "escalation" || !comment.body.startsWith(PERSON_BUDGET_REFUSAL_OPENING)) continue;
    if (listMentionsForComment(db, comment.id).some((mention) => mention.status === "open")) return true;
  }
  return false;
}

