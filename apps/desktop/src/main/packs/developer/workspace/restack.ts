import { gitStateOf, type Item, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { finishedItemIds, getItem, getStep, updateItem, type GitWorkspace } from "../../../db/repos/index.js";
import { createCliRunner, type CliRunner } from "../forge/cli.js";
import { resolveMergeState } from "../forge/mergeState.js";
import { git, isAncestor, rebaseOntoBase, type NetworkGitOptions } from "./git.js";
import { resolveRemoteRef, type RemoteRefResolver } from "./remoteRef.js";
import { baseRefFor } from "./stackTarget.js";
import { itemBranchName } from "./workName.js";
import type { WorktreeResult, WorktreeRunOptions } from "./worktrees.js";

/**
 * Keeping a stacked item's branch on its dependency's (EO-780, the
 * pinned decision "When to restack a stacked child").
 *
 * An item released by a `reached` edge is cut from its dependency's
 * branch while that dependency is still being worked on, and the cut is
 * recorded on the item (`stackedOn`: which dependency, at which commit).
 * After that the dependency's branch goes on moving — more commits, a
 * rebase onto the base branch, a force-push after review — and in the end
 * it merges, often squashed. Each of those leaves the item's branch on
 * top of commits that are no longer the dependency's, which is the
 * failure this replaces.
 *
 * So before every dispatch that works in the item's worktree, the
 * dependency's tip is compared with the recorded commit, and where it
 * has moved the item's own commits — exactly the ones after the recorded
 * commit — are carried across with `git rebase --onto <tip> <recorded>`.
 * Once the dependency has merged they are carried onto the remote base
 * branch instead, and the record is cleared: there is nothing left to be
 * stacked on.
 *
 * A conflict is taken back (`rebaseOntoBase` aborts what it started) and
 * refused, naming the dependency and the files, so the dispatch escalates
 * the way every other rebase conflict does and the branch and its
 * worktree are left as they were.
 */
export interface RestackOptions extends WorktreeRunOptions {
  /** The item's own worktree — the one checkout of its branch EO may rebase in. */
  worktreePath: string;
  run?: CliRunner;
  /** Injectable for the tests, like everywhere a ref is resolved. */
  resolve?: RemoteRefResolver;
  /** Injectable so a test can say no rebase was run at all. */
  rebase?: typeof rebaseOntoBase;
}

const DONE: WorktreeResult<void> = { ok: true, value: undefined };

export async function restackOnDependency(db: Db, workspace: GitWorkspace, item: Item, options: RestackOptions): Promise<WorktreeResult<void>> {
  // Read fresh: the item a dispatch holds can predate the cut recorded a
  // moment ago, or a restack by the dispatch before it.
  const current = getItem(db, item.id) ?? item;
  const { stackedOn, branch, namedBranch } = gitStateOf(current);
  if (stackedOn === null || branch === null || namedBranch) return DONE;

  const { onProgress, signal } = options;
  const network: NetworkGitOptions = signal ? { signal } : {};
  const resolve = options.resolve ?? resolveRemoteRef;
  const rebase = options.rebase ?? rebaseOntoBase;
  const { repoPath, forgeRemote: remote, baseBranch, forgeKind } = workspace.config;

  const dependency = getItem(db, stackedOn.itemId as Uuid);
  if (!dependency) {
    onProgress?.(`"${branch}" was cut from a ticket that no longer exists, so there is nothing to restack it on; it is left as it is.`);
    return DONE;
  }
  const dependencyBranch = await itemBranchName(db, dependency);

  const mergeState = await resolveMergeState({ repoPath, branch: dependencyBranch, baseBranch, remote, forgeKind, run: options.run ?? createCliRunner(), ...network });
  if (signal?.aborted) return { ok: false, reason: `Restacking "${branch}" was cancelled.` };
  if (mergeState === "closed") {
    // Not this function's question: the pull request step asks a person
    // what to target instead, and nothing is carried anywhere until then.
    onProgress?.(`${dependency.key}'s pull request was closed without merging, so "${branch}" is left on ${short(stackedOn.commit)} for now.`);
    return DONE;
  }

  // Where the item's own commits belong now: the dependency's tip while
  // it is open, the remote base branch once it has merged.
  let target: string;
  let targetName: string;
  if (mergeState === "merged") {
    const base = await baseRefFor({ kind: "base" }, workspace, resolve, network);
    if (!base.ok) return base;
    const commit = await commitOf(repoPath, base.value);
    if (commit === null) return { ok: false, reason: `${dependency.key} has merged, and EO could not read which commit \`${base.value}\` is on to restack "${branch}" onto it. Reply to retry.` };
    target = commit;
    targetName = base.value;
  } else {
    const tip = await dependencyTip(repoPath, remote, dependencyBranch, resolve, network);
    if (tip === null) {
      onProgress?.(`${dependency.key}'s branch "${dependencyBranch}" is not in this repository or on ${remote}, so "${branch}" is left on ${short(stackedOn.commit)}.`);
      return DONE;
    }
    // The ordinary case on every dispatch: nothing has moved.
    if (tip.commit === stackedOn.commit) return DONE;
    target = tip.commit;
    targetName = tip.ref;
  }

  // The recorded commit has to be under the branch for `--onto` to mean
  // anything. It is not when somebody carried the branch across by hand —
  // an implementer told the remote had diverged, a person after a
  // conflict — and then the branch is either already on the target, which
  // only the record has to learn, or somewhere EO cannot account for, and
  // is left alone.
  if (!(await isAncestor(repoPath, stackedOn.commit, branch))) {
    if (await isAncestor(repoPath, target, branch)) {
      if (mergeState === "merged") updateItem(db, item.id, { git: { stackedOn: null } });
      else updateItem(db, item.id, { git: { stackedOn: { itemId: dependency.id, commit: target } } });
      onProgress?.(`"${branch}" is already on ${targetName}, so there was nothing to restack.`);
      return DONE;
    }
    onProgress?.(
      `"${branch}" no longer has ${short(stackedOn.commit)}, the commit of ${dependency.key}'s branch it was cut from, so EO cannot tell its commits from ${dependency.key}'s and left it as it is.`,
    );
    return DONE;
  }

  const why = mergeState === "merged" ? `${dependency.key} has merged` : `${dependency.key}'s branch "${dependencyBranch}" has moved from ${short(stackedOn.commit)} to ${short(target)}`;
  onProgress?.(`${why}, so "${branch}" is being restacked onto ${targetName}.`);

  const rebased = await rebase(repoPath, branch, target, { worktreePath: options.worktreePath, from: stackedOn.commit, ...network });
  if (!rebased.ok) {
    const files = rebased.conflicts.length === 0 ? "" : ` It stopped on a conflict in ${rebased.conflicts.map((file) => `\`${file}\``).join(", ")}.`;
    return {
      ok: false,
      reason:
        `${item.key} is built on ${dependency.key}, and ${why}. EO tried to carry ${item.key}'s own commits across with ` +
        `\`git rebase --onto ${target} ${stackedOn.commit}\` and could not.${files} ` +
        `The rebase was taken back, so "${branch}" and its worktree are as they were.\n\n${rebased.error}\n\n` +
        `Resolve it by hand in ${options.worktreePath} — that same rebase, then \`git rebase --continue\` — or change ${dependency.key}'s branch, then reply to retry.`,
    };
  }

  // The history it replaced may be on the remote already, which is what
  // `restacked` tells the next push to a pull request (`--force-with-lease`).
  if (mergeState === "merged") updateItem(db, item.id, { git: { stackedOn: null, restacked: true } });
  else updateItem(db, item.id, { git: { stackedOn: { itemId: dependency.id, commit: target }, restacked: true } });
  onProgress?.(mergeState === "merged" ? `Restacked "${branch}" onto ${targetName}; it is no longer stacked on ${dependency.key}.` : `Restacked "${branch}" onto ${short(target)}.`);
  return DONE;
}

/**
 * The commit a dependency's branch is at: its remote-tracking ref, after
 * a fetch, and the local branch where the remote has none — a dependency
 * not pushed yet is a normal state, and its local branch is then the only
 * account of it there is.
 */
export async function dependencyTip(
  repoPath: string,
  remote: string,
  branch: string,
  resolve: RemoteRefResolver = resolveRemoteRef,
  options: NetworkGitOptions = {},
): Promise<{ ref: string; commit: string } | null> {
  const resolved = await resolve(repoPath, remote, branch, options);
  if (resolved.kind === "remote") {
    const commit = await commitOf(repoPath, resolved.ref);
    if (commit !== null) return { ref: resolved.ref, commit };
  }
  const local = await commitOf(repoPath, `refs/heads/${branch}`);
  return local === null ? null : { ref: branch, commit: local };
}

async function commitOf(repoPath: string, ref: string): Promise<string | null> {
  const read = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
  return read.ok && read.stdout !== "" ? read.stdout : null;
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * What the agent working on a stacked item is told about the dependency
 * its branch is built on, by that dependency's key (EO-780) — beside the
 * key in its prompt's dependency summary.
 *
 * Only for the one dependency the branch was cut from, and only while it
 * is: an agent that reads "work that shipped before yours" over a
 * dependency still in review would take its commits under the branch for
 * finished work, and go looking for a pull request that has merged.
 */
export async function stackedDependencyNotes(db: Db, item: Item): Promise<Record<string, string>> {
  const current = getItem(db, item.id) ?? item;
  const { stackedOn } = gitStateOf(current);
  if (stackedOn === null) return {};
  const dependency = getItem(db, stackedOn.itemId as Uuid);
  if (!dependency) return {};

  const branch = await itemBranchName(db, dependency);
  const step = dependency.stepId === null ? null : (getStep(db, dependency.stepId)?.name ?? dependency.stepId);
  const at = step === null ? "" : ` It is at "${step}".`;
  const built = `Your branch is built on its branch, \`${branch}\`, so its commits are under yours until it merges; EO restacks yours onto it whenever it moves.`;
  return {
    [dependency.key]: finishedItemIds(db, [dependency]).has(dependency.id)
      ? `finished, but its branch has not merged yet.${at} ${built}`
      : `not finished yet.${at} ${built}`,
  };
}
