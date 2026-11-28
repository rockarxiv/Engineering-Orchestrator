import { UNCHANGED_SINCE_APPROVAL_RESULT, type Item, type Run, type Uuid } from "@eo/core";
import { resultUnlessUnchangedSinceApproval } from "@eo/engine";
import type { Db } from "../../db/client.js";
import { getStep, graphForItem, listRunsForItem, postComment, reviewVerdictsOfRuns } from "../../db/repos/index.js";
import { branchHeadsOfRuns, type BranchHeadEvent } from "./workspace/branchHead.js";

/**
 * Skipping Review when a To Do run left the approved commit as it was
 * (EO-930).
 *
 * In the shipped Delivery a failed check on the pull request sends the
 * item back to To Do, and To Do's `done` leads to Review. An implementer
 * sent back over a flaky job re-runs it and changes nothing, and a second
 * review of a commit Review has already approved proves nothing. So when
 * the branch is on the very commit of the item's most recent approval,
 * the run reports `UNCHANGED_SINCE_APPROVAL_RESULT` instead of `done`,
 * where the step routes it: Delivery 1.6 sends it to the step after
 * Review. Both commits are EO's own reading of the repository
 * (`BRANCH_HEAD_EVENT`), never the agent's word (invariant 5), and where
 * the target is is a row in the graph, never a name here (invariant 7).
 */

/** The item's most recent approval and the commit it was of, before a given run. */
export interface Approval {
  run: Run;
  head: BranchHeadEvent;
}

/**
 * The most recent review run, before `before`, whose verdict was an
 * approval, with the commit it recorded. Null where no review approved the
 * item, or the newest that did recorded no commit — an approval from
 * before EO read one, which is not evidence of anything.
 *
 * Ordered by run id, which is a UUIDv7 and so the order the runs were made.
 */
export function latestApproval(db: Db, itemId: Uuid, before: Uuid): Approval | null {
  const reviews = listRunsForItem(db, itemId).filter((run) => run.action === "review" && run.id < before);
  if (reviews.length === 0) return null;
  const verdicts = reviewVerdictsOfRuns(
    db,
    reviews.map((run) => run.id),
  );
  const approval = reviews.filter((run) => verdicts.get(run.id)?.verdict === "approve").at(-1);
  if (approval === undefined) return null;
  const head = branchHeadsOfRuns(db, [approval.id]).get(approval.id);
  return head === undefined ? null : { run: approval, head };
}

/** What a finished `implement` run was compared with, and the result that comparison gives it. */
export interface ImplementOutcome {
  result: string;
  head: BranchHeadEvent | null;
  approval: Approval | null;
}

/**
 * The result a finished `implement` run routes on from `stepId`: `done`,
 * or `UNCHANGED_SINCE_APPROVAL_RESULT` where its branch is on the commit
 * of the item's most recent approval and the step, in the graph the item
 * is bound to, routes that key.
 */
export function implementOutcome(db: Db, item: Item, run: Run | undefined, stepId: string): ImplementOutcome {
  if (run === undefined) return { result: "done", head: null, approval: null };
  const head = branchHeadsOfRuns(db, [run.id]).get(run.id) ?? null;
  const approval = head === null ? null : latestApproval(db, item.id, run.id);
  const result = resultUnlessUnchangedSinceApproval({
    reported: "done",
    stepId,
    routes: graphForItem(db, item).routes,
    revision: head?.commit ?? null,
    approvedRevision: approval?.head.commit ?? null,
  });
  return { result, head, approval };
}

/**
 * The run whose finished result is being routed from `stepId`: the item's
 * newest `implement` run, where it was dispatched from that step. A run
 * from anywhere else — a manual dispatch names no step — is not a pass
 * through it.
 */
export function routedImplementRun(db: Db, item: Item, stepId: string): Run | undefined {
  const newest = listRunsForItem(db, item.id)
    .filter((run) => run.action === "implement")
    .at(-1);
  return newest !== undefined && newest.stepId === stepId ? newest : undefined;
}

/**
 * Says in the thread that the step that approved the commit was skipped,
 * and why (EO-930), where the run is about to be routed past it. Posted
 * before the move, like every record of a run, so it sits above it.
 */
export function postReviewSkippedNote(db: Db, item: Item, runId: Uuid): void {
  if (item.stepId === null) return;
  const run = routedImplementRun(db, item, item.stepId);
  if (run === undefined || run.id !== runId) return;
  const outcome = implementOutcome(db, item, run, item.stepId);
  if (outcome.result !== UNCHANGED_SINCE_APPROVAL_RESULT || outcome.head === null || outcome.approval === null) return;
  const reviewed = (outcome.approval.run.stepId === null ? undefined : getStep(db, outcome.approval.run.stepId))?.name ?? "Review";
  const commit = outcome.head.commit.slice(0, 12);
  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "engine" },
    kind: "note",
    body:
      `${reviewed} was skipped because the approved commit was unchanged: after this run \`${outcome.head.branch}\` is still on ${commit}, ` +
      `the commit ${reviewed} approved in its most recent approval, so reviewing it again would prove nothing. ` +
      `EO read both commits from git, not from what the agent reported. Any change to the branch goes through ${reviewed} as usual.`,
  });
}
