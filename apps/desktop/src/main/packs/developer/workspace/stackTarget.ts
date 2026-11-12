import { gitStateOf, type Item } from "@eo/core";
import { dependencyClosure } from "@eo/engine";
import { resolveStackTarget, type StackDependency, type StackTargetDecision } from "./stackDecision.js";
import type { Db } from "../../../db/client.js";
import { getItem, listAllDependencies, listDependencies, type GitWorkspace } from "../../../db/repos/index.js";
import { createCliRunner, type CliRunner } from "../forge/cli.js";
import { resolveMergeState } from "../forge/mergeState.js";
import type { NetworkGitOptions } from "./git.js";
import { resolveRemoteRef, type RemoteRefResolver } from "./remoteRef.js";
import { resolveStackTargetWithAnswer, type RefChecker } from "./stackAnswer.js";
import { itemBranchName } from "./workName.js";
import type { WorktreeResult } from "./worktrees.js";

/**
 * The DB/git-facing half of EO-10 / KAN-42's stacking decision: gathers
 * `item`'s direct dependencies, resolves each same-feature one's merge
 * state (forge first, git fallback — `forge/mergeState.ts`), and hands
 * them to the pure resolver in `stackDecision.ts` to decide whether `item`
 * should branch from / rebase onto the workspace's base branch, or a
 * still-unmerged same-feature dependency's branch instead.
 *
 * Out-of-scope dependencies (no parent feature, or a different one) are
 * filtered out *before* any forge/git call — not merely by
 * `resolveStackTarget` itself — so an item with no same-feature
 * dependency costs nothing beyond the one `listDependencies` query: no
 * CLI spawned, no `git fetch` run.
 *
 * Also filtered out here, ahead of the pure resolver: a same-feature
 * dependency in a *different* workspace. A feature can span several
 * repositories (KAN-17), but a branch only ever lives in one — there is
 * no `git worktree add` that cuts a branch in one checkout from a ref
 * that only exists in another. The pure resolver only
 * knows about `parentId`, so this workspace check is this adapter's job,
 * not something a story about wiring gets to skip.
 *
 * A dependency's branch is read from its own stored `dep.branch`
 * (EO-16), never recomputed from `dep.key`/`dep.jiraKey`: the
 * dependency may have been linked to Jira *after* its branch was
 * already cut, and recomputing here would go looking for a branch that
 * was never actually created under the new name. For a dependency with
 * no stored branch yet (not yet dispatched), `itemBranchName` gives the
 * name dispatch will cut it under — its Reference, Jira key or EO key,
 * and the configured prefix (EO-638) — the same case that already made
 * this a defensive lookup rather than an assumed-to-exist one.
 *
 * Each dependency also carries what *it* depends on, so the resolver can
 * tell a tie from a chain: C depending on both A and B, where B already
 * depends on A, is not a choice anyone needs to make.
 */
export async function resolveItemStackTarget(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  run: CliRunner = createCliRunner(),
  refExists?: RefChecker,
  options: NetworkGitOptions = {},
): Promise<StackTargetDecision> {
  // Nothing to gather when nothing could change the answer: an item with
  // no feature has no same-feature dependency, and one whose base a
  // person set is cut from that base whatever its dependencies say
  // (EO-364). The pure resolver still has the last word on both — it is
  // what knows that a set base wins — but neither is worth a forge
  // lookup per dependency to find out.
  //
  // Nor for a branch a person named (EO-365): it is never cut, so never
  // stacked, and it opens against the ticket's base or the repository's.
  const { baseBranch, namedBranch } = gitStateOf(item);
  if (item.parentId === null || baseBranch !== null || namedBranch) return resolveStackTarget(item, []);

  const dependencies = await gatherStackDependencies(db, workspace, item, run, options);
  return resolveStackTargetWithAnswer(db, item, dependencies, workspace.config.repoPath, refExists);
}

/**
 * `item`'s in-scope direct dependencies, each annotated with its merge
 * state and its own transitive dependencies.
 *
 * The whole edge table is read once and the closures computed from it in
 * memory, rather than walking the graph with a query per hop: the table
 * is one row per dependency link across every item EO knows about, and
 * a dispatch already reads more than that.
 */
async function gatherStackDependencies(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  run: CliRunner,
  options: NetworkGitOptions,
): Promise<StackDependency[]> {
  const edges = listAllDependencies(db);
  const dependencies: StackDependency[] = [];

  for (const edge of listDependencies(db, item.id)) {
    const dep = getItem(db, edge.dependsOnId);
    if (!dep || dep.parentId === null || dep.parentId !== item.parentId) continue;
    if (dep.workspaceId !== item.workspaceId) continue;

    const branch = await itemBranchName(db, dep);
    const mergeState = await resolveMergeState({
      repoPath: workspace.config.repoPath,
      branch,
      baseBranch: workspace.config.baseBranch,
      remote: workspace.config.forgeRemote,
      forgeKind: workspace.config.forgeKind,
      run,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    dependencies.push({ item: dep, branch, mergeState, dependsOn: [...dependencyClosure(edges, dep.id)] });
  }

  return dependencies;
}

/** Every decision that names somewhere to cut from, rather than a question to ask. */
export type ResolvedStackTarget = Exclude<StackTargetDecision, { kind: "escalate" }>;

/**
 * The branch a non-escalating decision resolves to — `stack` names the
 * dependency's own stored branch, `branch` the one a person named in
 * answer to the stacking question, `named-base` the one a person set on
 * the item (EO-364), and `base` the workspace's. A stacked dependency's
 * branch is the one its gatherer resolved — its recorded branch, or the
 * one dispatch will cut for it (EO-16, EO-638) — never recomputed here.
 */
export function branchFor(decision: ResolvedStackTarget, workspace: GitWorkspace): string {
  if (decision.kind === "base") return workspace.config.baseBranch;
  if (decision.kind === "branch" || decision.kind === "named-base") return decision.branch;
  return decision.branch;
}

/**
 * The *ref* a decision resolves to — `branchFor`'s branch name looked up
 * on the remote (`remoteRef.ts`), which is what a new branch is cut from,
 * what an existing one is rebased onto, and what "has commits beyond the
 * base" is measured against.
 *
 * Never the branch name itself where a git command is concerned: a local
 * `main` is whatever the human last left it as, and both halves of a
 * stack have the same problem — a dependency's branch is *pushed* by the
 * time anything is stacked on it, so its remote tip is the one its own
 * reviewer is looking at, while its local ref may still hold the commits
 * from before a force-push or a rebase during review.
 *
 * The base branch refuses when it cannot be resolved on the remote,
 * because a repository that has a remote and no base branch on it is
 * misconfigured (or unreachable), and quietly cutting from a possibly
 * stale local branch instead is the exact failure this replaces. A
 * *stacked* target falls back to the local branch instead: a dependency
 * whose branch has genuinely not been pushed yet is a normal state, and
 * its local branch is then the only account of it that exists.
 *
 * A base a person set on the item (EO-364) refuses the way the base
 * branch does, and for a sharper version of the same reason: it was named
 * before anything was cut, possibly days ago, and a name the remote does
 * not have is a typo or a branch nobody pushed — either way not something
 * to quietly cut from a local copy of. The refusal names the branch and
 * the remote, and nothing is created.
 *
 * A repository with no remote at all resolves to the local branch for
 * the repository's base and for a stacked dependency — there is nothing
 * else it could mean. Not for a base a person named: that is a promise
 * the branch is cut from the remote's copy and the pull request opened
 * against it there, and with no such remote — none configured, or one
 * named differently — neither can be kept, so it is refused rather than
 * quietly cut from whatever a local branch of that name holds.
 */
export async function baseRefFor(
  decision: ResolvedStackTarget,
  workspace: GitWorkspace,
  resolve: RemoteRefResolver = resolveRemoteRef,
  options: NetworkGitOptions = {},
): Promise<WorktreeResult<string>> {
  const branch = branchFor(decision, workspace);
  const resolved = await resolve(workspace.config.repoPath, workspace.config.forgeRemote, branch, options);

  // A base a person named has to be on the remote *now* (EO-364). A
  // tracking ref this call could not refresh is what a branch deleted
  // upstream leaves behind, and cutting from it would start the work on a
  // branch nobody can open a pull request against. The repository's own
  // base and a stacked dependency keep accepting it: there, an
  // unreachable remote is the likelier story and the old tip is still
  // the best account of it.
  if (resolved.kind === "remote" && decision.kind === "named-base" && resolved.unconfirmed !== undefined) {
    return {
      ok: false,
      reason:
        `This ticket is set to branch from \`${branch}\`, and EO could not confirm it is still on \`${workspace.config.forgeRemote}\`: ` +
        `\`git fetch ${workspace.config.forgeRemote} ${branch}\` failed: ${resolved.unconfirmed} ` +
        `No branch or worktree was created from the copy EO fetched earlier, since the branch may have been deleted upstream. ` +
        `Push \`${branch}\` to \`${workspace.config.forgeRemote}\` or check the remote is reachable, or change or clear the ticket's base branch, then reply to retry.`,
    };
  }
  if (resolved.kind === "remote") return { ok: true, value: resolved.ref };
  if (resolved.kind === "no-remote" && decision.kind === "named-base") {
    return {
      ok: false,
      reason:
        `This ticket is set to branch from \`${branch}\` on \`${workspace.config.forgeRemote}\`, and this repository has no remote called \`${workspace.config.forgeRemote}\`. ` +
        `No branch or worktree was created — not even from a local \`${branch}\`, which EO cannot check against the remote. ` +
        `Add the remote, correct the repository's remote name in Settings, or clear the ticket's base branch, then reply to retry.`,
    };
  }
  if (resolved.kind === "no-remote") return { ok: true, value: branch };
  if (decision.kind === "named-base") {
    return {
      ok: false,
      reason:
        `This ticket is set to branch from \`${branch}\`, and EO could not resolve it on \`${workspace.config.forgeRemote}\`: ${resolved.problem} ` +
        `No branch or worktree was created. Push \`${branch}\` to \`${workspace.config.forgeRemote}\`, or change or clear the ticket's base branch, then reply to retry.`,
    };
  }
  if (decision.kind !== "base") return { ok: true, value: branch };

  return {
    ok: false,
    reason:
      `EO works from the remote base branch, and could not resolve \`${branch}\` on \`${workspace.config.forgeRemote}\`: ${resolved.problem} ` +
      `Nothing was cut from the local \`${branch}\`, since it may be behind — fix the remote or the configured base branch, then reply to retry.`,
  };
}
