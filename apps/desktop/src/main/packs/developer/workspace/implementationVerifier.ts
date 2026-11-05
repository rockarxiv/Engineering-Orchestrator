import { gitStateOf, type Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getGitWorkspace, getItem } from "../../../db/repos/index.js";
import { createCliRunner, type CliRunner } from "../forge/cli.js";
import { worktreeConfigFor } from "./dispatchWorkspace.js";
import { baseRefFor, resolveItemStackTarget } from "./stackTarget.js";
import { formatVerificationComment, verifyImplementation, type VerificationResult, type VerifyOptions } from "./verify.js";
import { itemBranchName } from "./workName.js";

/**
 * G-02's verdict on what an implementer claimed.
 *
 * `comment` is what the next attempt reads through the assembled
 * context; `verification` is the account of every step that ran, which
 * the git kind carries onto the run row as the check's evidence. Both
 * optional, because a run with no repository to check against is
 * trusted and has nothing to show for it.
 */
export type VerifyRunResult =
  | { ok: true; verification?: VerificationResult }
  | { ok: false; reason: string; comment?: string; verification?: VerificationResult };

/**
 * The two ends of the range the implementation check measures, for
 * whatever has to *show* what the branch did (EO-298).
 *
 * `artifacts` computed its own until this function existed — the
 * workspace's configured base branch against the item's branch — and the
 * two disagreed in the case they were most likely to meet: a story
 * stacked on a same-feature dependency that has not merged. Its branch
 * carries the dependency's commits as well as its own, so a diff from
 * the base branch shows work this run did not do and a reviewer is asked
 * to judge somebody else's change as part of this one. The verifier has
 * resolved that since EO-10, freshly on every call, and this is the same
 * resolution asked for by name rather than reimplemented beside it.
 *
 * The rebase target rather than the base ref, which is the other thing
 * the verifier resolves and the other half of the distinction: the base
 * ref is what "has commits beyond the base" is measured against, and the
 * rebase target is what this branch was last replayed on top of. Only
 * the second answers "what did this ticket do", and for an unstacked
 * story the two are the same ref anyway.
 *
 * Resolves on the remote for the reason the verifier does — review meets
 * what actually landed rather than a local branch of that name that may
 * be behind — and falls back to the configured base branch wherever that
 * cannot be answered. A diff over a slightly wrong range is a diff
 * somebody can still read; a run that failed because it could not
 * produce one, after its work had already passed verification, is not.
 */
export function createVerifiedRange(db: Db, worktreeRoot?: string, run: CliRunner = createCliRunner()) {
  return async (item: Item): Promise<{ from: string; to: string } | null> => {
    const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);
    if (!workspace || !worktreeConfigFor(db, item.workspaceId, worktreeRoot)) return null;

    // Read fresh rather than trusting the caller's item, for the reason
    // the verifier reads fresh: the branch is written to the row by
    // `prepare`, and the in-memory item the run was dispatched with
    // predates that write.
    const storedItem = getItem(db, item.id) ?? item;
    const stored = gitStateOf(storedItem);
    const branch = await itemBranchName(db, storedItem);

    // A branch a person named shows what was committed on it since EO
    // attached it (EO-365) — the same range the check counted — rather
    // than everything it carried from before.
    if (stored.namedBranch && stored.attachedAt !== null) return { from: stored.attachedAt, to: branch };

    const decision = await resolveItemStackTarget(db, workspace, item, run);
    if (decision.kind === "escalate") return { from: workspace.config.baseBranch, to: branch };

    const target = await baseRefFor(decision, workspace);
    return { from: target.ok ? target.value : workspace.config.baseBranch, to: branch };
  };
}

/**
 * The `implementation` check of the git kind's `verify`, backed by real
 * git and the configured check commands (G-02).
 *
 * Which actions this answers for is no longer its own business (EO-297).
 * It used to open by returning "fine" for anything but `implement`,
 * which was the same sentence the kind's `verify` opened with — one
 * decision in two places, and in a place nothing outside could read.
 * The kind registers this under `implement` and no other key now, so an
 * action that reaches here is one that was meant to.
 */
export function createImplementationVerifier(db: Db, worktreeRoot?: string, options: VerifyOptions = {}, run: CliRunner = createCliRunner()) {
  // What the agent *said* is deliberately not an argument: the whole
  // point is to check the repository rather than to re-read the claim.
  return async (item: Item): Promise<VerifyRunResult> => {
    const config = worktreeConfigFor(db, item.workspaceId, worktreeRoot);
    // Nothing to verify against without a checkout. Trusting the claim
    // here is a real weakening, so it's worth being explicit that it only
    // happens before a workspace is configured.
    if (!config) return { ok: true };

    // This item's workspace's commands, not "the" configured ones —
    // two checkouts rarely agree on how to run their tests (D-04).
    const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);

    // Read fresh rather than trusting the git state on the `item`
    // argument:
    // the caller passes the same in-memory item it dispatched with,
    // from *before* the kind's `prepare` wrote the branch to the DB, so
    // that field can still be stale null here. The DB row `prepare`
    // just wrote (or wrote on an earlier dispatch) is the actual source
    // of truth. Falling back to a fresh computation only covers an item
    // that somehow reached verification with no branch at all — it must
    // never recompute from a name/prefix that could have changed since
    // dispatch (EO-16: no rename on a later prefix change, Jira link or
    // Reference).
    const storedItem = getItem(db, item.id) ?? item;
    const stored = gitStateOf(storedItem);
    const branch = await itemBranchName(db, storedItem);
    // A per-call copy, never the captured `options` itself. This used to
    // reassign the closure variable, which two verifies in flight at once
    // read and wrote in turn: one item's branch, or rebase target, ended
    // up being what the other was checked against. Every reassignment now
    // sits on top of the factory's defaults instead of on top of whatever
    // the previous call left behind.
    let resolved: VerifyOptions = { ...options, branch };

    // Recomputed on every verify run, never cached from when the
    // worktree was first cut (EO-10 / KAN-42): the dependency this story
    // is stacked on may merge partway through its own implementation
    // attempts, and rebasing a legitimately-still-stacked branch onto
    // the base branch mid-implementation would fight the stack rather
    // than support it.
    // A branch a person named (EO-365) is measured from where it stood
    // when EO attached it, not from any base: it may carry a hundred
    // commits from before, and counting those would pass a run that
    // committed nothing. And it is never rebased — it is theirs, and EO
    // does not rewrite it — so there is no target to resolve either.
    if (stored.namedBranch) {
      if (stored.attachedAt === null) {
        const reason =
          `${item.key} works on "${branch}", a branch named on the ticket, and EO has no record of which commit it was on when it was checked out, ` +
          `so it cannot tell this run's commits from the ones already there. Run the ticket's Worktree step again, then retry.`;
        return { ok: false, reason, comment: reason };
      }
      resolved = {
        ...resolved,
        baseRef: stored.attachedAt,
        baseLabel: `${stored.attachedAt.slice(0, 12)}, where EO checked it out for ${item.key}`,
        noRebase: `Not rebased: "${branch}" is a branch named on this ticket, and EO never rewrites it.`,
      };
    } else if (workspace) {
      const decision = await resolveItemStackTarget(db, workspace, item, run);
      if (decision.kind === "escalate") {
        // Same reasoning as an unresolvable base ref or a clashing
        // branch: refuse rather than guess, through the existing
        // rejection-comment path (ARCHITECTURE.md, "Guardrails", invariant #8) — no new
        // comment-posting code.
        return { ok: false, reason: decision.reason, comment: decision.reason };
      }

      // Both resolved on the remote, and both refuse the same way the
      // decision itself does: a branch that was cut from `origin/main`
      // must be rebased onto `origin/main` too. Rebasing it onto a local
      // `main` that is behind would replay the upstream commits it
      // already carries on top of an older base — the branch would come
      // out of review sitting on work that has since moved.
      const target = await baseRefFor(decision, workspace);
      if (!target.ok) return { ok: false, reason: target.reason, comment: target.reason };

      // Resolved separately only when the two differ: an unstacked story
      // measures against and rebases onto the same ref, and fetching it
      // twice for that would be a second network round trip per verify.
      //
      // A base a person set on the ticket is the base, for both halves
      // (EO-364): the branch was cut from it, so "commits beyond the
      // base" counted from the repository's base branch would count every
      // commit the named base carries as this run's work — a branch with
      // nothing committed would pass.
      const base = decision.kind === "base" || decision.kind === "named-base" ? target : await baseRefFor({ kind: "base" }, workspace);
      if (!base.ok) return { ok: false, reason: base.reason, comment: base.reason };

      resolved = { ...resolved, rebaseTarget: target.value, baseRef: base.value };
    }

    const result = await verifyImplementation(
      config,
      item.key,
      { test: workspace?.config.testCommand ?? null, lint: workspace?.config.lintCommand ?? null, build: workspace?.config.buildCommand ?? null },
      resolved,
    );

    if (result.ok) return { ok: true, verification: result };

    const failed = result.steps.find((step) => !step.ok);
    return {
      ok: false,
      reason: `Verification failed at "${result.failedStep}": ${failed?.detail ?? ""}`.trim(),
      comment: formatVerificationComment(item.key, result),
      verification: result,
    };
  };
}
