import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { WORKTREE_AGENT_DIRECTORY, unmanagedAgentEntries } from "../../../agentAttachments/worktreeSkills.js";
import { REPOSITORY_INDEX_DIRECTORIES, discardRepositoryIndexes, withoutRepositoryIndex } from "../repositoryIntelligence/index.js";
import { DEFAULT_BRANCH_PREFIX } from "./branchPrefix.js";
import { excludeGeneratedDirectories } from "./excludes.js";
import { branchExists, canonicalPath, currentBranch, git, isGitRepo, listWorktrees, samePath, statusPorcelain, type WorktreeEntry } from "./git.js";
import { resolveRemoteRef, type RemoteRefResolver } from "./remoteRef.js";
import { TICKET_FILES_DIRECTORY } from "./ticketFiles.js";
import type { WorkName } from "./workName.js";

/**
 * What a caller may say about a worktree operation that can be
 * interrupted.
 *
 * Only cancellation, and only where it can be acted on. `git worktree
 * add` takes the signal because it writes a whole checkout and the
 * repository it cuts from may be large; the start-point resolution takes
 * it because that is where the fetches are. `show-ref` and `worktree
 * list` do not: they return in milliseconds, so the abort check between
 * steps is both cheaper and more responsive than plumbing a signal into
 * them would be.
 */
export interface WorktreeRunOptions {
  signal?: AbortSignal;
  /**
   * Where each step says what it did, for the run's transcript.
   *
   * The lines are chosen for someone asking "why is this branch cut from
   * *that*?" a week later — which worktree was reused, which ref the
   * start point resolved to — rather than being a log of every git
   * command. `show-ref` returning false is not news; `Cut eo/EO-1 from
   * origin/main` is the whole answer.
   */
  onProgress?: (text: string) => void;
}

/**
 * Everything under `.agent` that git would not put back, as git itself
 * reports it (EO-207).
 *
 * The other half of the release guard below, and the half that keeps it
 * from being a wall. `unmanagedAgentEntries` answers "did EO write
 * this?"; it cannot answer "would anything actually be lost?", because
 * that is git's question and not the filesystem's. A repository is free
 * to *track* files under `.agent` — EO's exclusion does nothing to a
 * tracked path — and removing a worktree full of tracked files loses
 * nothing at all, because the branch still has them. Refusing over those
 * would strand every worktree of such a repository forever, which is
 * exactly the failure EO-170 records for the generated index: "without
 * it every release refused, so no worktree was ever released".
 *
 * `--ignored=matching` is what makes the question answerable: the
 * ordinary porcelain says nothing about a path EO excluded, which is the
 * whole reason this guard exists. `-uall` asks for files rather than a
 * collapsed directory — git still collapses a directory holding nothing
 * *but* ignored files, which is why the caller matches prefixes in both
 * directions rather than comparing paths for equality.
 *
 * Null rather than an empty list when git could not answer. A look that
 * failed establishes nothing (invariant #5), and the caller has already
 * found something on disk it cannot account for: "git said nothing" must
 * not read as "there is nothing to lose".
 */
async function agentPathsGitWouldNotRestore(worktreePath: string): Promise<string[] | null> {
  const listed = await git(
    ["status", "--porcelain", "-uall", "--ignored=matching", "--", WORKTREE_AGENT_DIRECTORY],
    worktreePath,
  );
  if (!listed.ok) return null;
  // `XY <path>`, and never the two-path rename form: a rename is a
  // tracked change, and every line this asks for is untracked or
  // ignored. A path git had to quote does not match anything below,
  // which errs towards refusing — the safe direction for a guard whose
  // failure mode is deleting somebody's files.
  return listed.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== "");
}

/**
 * Would removing the worktree lose this entry?
 *
 * Prefix-matched in both directions because git reports at whichever
 * granularity it collapsed to: `.agent/prompts/b.md` when the directory
 * around it holds tracked files, `.agent/skills/` when it holds none.
 * The first is a path under the entry; the second is a path the entry is
 * under.
 */
function wouldBeLost(entry: string, lost: readonly string[]): boolean {
  return lost.some((path) => {
    const directory = path.endsWith("/") ? path : `${path}/`;
    return path === entry || path.startsWith(`${entry}/`) || entry.startsWith(directory);
  });
}

/**
 * The directories EO generates inside a checkout it does not own, and
 * which therefore have to be excluded from it (EO-207).
 *
 * Assembled here from the two modules that own the names rather than
 * spelled out: `.agent` belongs to the skills delivery and the index
 * directory belongs to whichever intelligence provider is configured, so
 * a provider added later is excluded without this file learning its
 * name. `workspace/` stays the git plumbing it is — `excludes.ts` is
 * handed a list and knows nothing about what is in it.
 *
 * And one EO does not generate but owns the exclusion of all the same
 * (EO-413): the directory an agent puts files in that are for the ticket
 * and not for the branch. Excluded with the others because it is the
 * same promise — git never sees it — kept by the same write.
 */
const EO_GENERATED_DIRECTORIES: readonly string[] = [WORKTREE_AGENT_DIRECTORY, ...REPOSITORY_INDEX_DIRECTORIES, TICKET_FILES_DIRECTORY];

/**
 * Excludes them, and says so in the transcript if it could not.
 *
 * Every route that hands back a usable checkout goes through here —
 * created, re-attached and reused alike — because the exclusion is
 * per-repository rather than per-worktree (see `excludes.ts`) and a
 * repository EO drove before this shipped has nothing in its exclude
 * file. Doing it on the reuse paths too is what heals those; it is a
 * file read and, after the first time, no write at all.
 *
 * A failure is reported and not raised. A worktree without the exclusion
 * still works — `verify.ts` steps over a repository index by path
 * already, and an agent still reads its skills off disk — so the cost is
 * that EO's own directories show up in `git status`, which is a thing to
 * say (invariant #8) rather than a thing to refuse a dispatch over.
 *
 * Exported for the one checkout that is not a worktree EO cut (EO-413):
 * a run that only reads a repository works in the person's own checkout,
 * is told about the ticket's directory like any other run on a git
 * workspace, and may write a file there to attach it. The exclude file
 * is the repository's and not the worktree's, so this is the same file
 * every worktree of that repository already wrote — it only stops the
 * promise depending on a branch having been cut there first.
 */
export async function excludeEoDirectories(path: string, options: WorktreeRunOptions): Promise<void> {
  const excluded = await excludeGeneratedDirectories(path, EO_GENERATED_DIRECTORIES);
  if (!excluded.ok) {
    options.onProgress?.(`Could not keep EO's own directories out of git status for ${path}: ${excluded.reason}`);
    return;
  }
  if (excluded.added.length > 0) {
    options.onProgress?.(`Excluded ${excluded.added.join(", ")} — EO's own — through ${excluded.file}, which is untracked and in nobody's diff.`);
  }
}

/** The refusal a cancelled operation reports, in the shape every other guard uses. */
function cancelled<T>(what: string): WorktreeResult<T> {
  return { ok: false, reason: `${what} was cancelled.` };
}

/** `~/.eo/worktrees/<KEY>` (ARCHITECTURE.md, "Worktrees, and the limit of isolation"). */
export function defaultWorktreeRoot(): string {
  return join(homedir(), ".eo", "worktrees");
}

/**
 * The branch an agent works on for an item (ARCHITECTURE.md, "Worktrees,
 * and the limit of isolation", EO-14 / EO-16 / EO-638):
 * `<prefix>/<Reference>-<KEY>` when a Reference names the work, keeping
 * the EO key so sibling stories that share a Reference never share a
 * branch, and otherwise `<prefix>/<jiraKey ?? KEY>`. `prefix` defaults to
 * the historical hardcoded `eo`, and `name` to null (i.e. the EO key),
 * so every call site that only ever knew about an item's own key keeps
 * producing exactly the branch it always has. `workNameFor` is what
 * decides `name` for an item; nothing passes a Jira key by hand.
 *
 * Callers that already have a *stored* `item.branch` (anything past
 * the item's first dispatch) must pass that instead of calling this —
 * see `BranchNaming` below and its callers in dispatchWorkspace.ts,
 * verify.ts and stackTarget.ts. This function only ever computes a
 * *new* name.
 */
export function branchNameFor(itemKey: string, name: WorkName | null = null, prefix: string = DEFAULT_BRANCH_PREFIX): string {
  if (name?.kind === "reference") return `${prefix}/${name.value}-${itemKey}`;
  if (name?.kind === "jira") return `${prefix}/${name.value}`;
  return `${prefix}/${itemKey}`;
}

/**
 * Always keyed by EO's own item key, regardless of prefix or a linked
 * Jira key (EO-14's pinned decision: "the local worktree directory path
 * stays keyed by EO's internal item key regardless, since it's an
 * internal-only path").
 */
export function worktreePathFor(itemKey: string, root = defaultWorktreeRoot()): string {
  return join(root, itemKey);
}

/**
 * What to name a *new* branch, or the exact branch to reuse when one was
 * already created for this item.
 *
 * `branch`, when given, wins outright and skips computation entirely —
 * that's what makes "link Jira later, no rename", "set a Reference later,
 * no rename" and "change the prefix later, no rename" work: an item past its first dispatch always has a
 * stored `item.branch`, and passing it here is how callers (§ EO-16)
 * avoid ever recomputing a name that may no longer match what git
 * actually has on disk.
 */
export interface BranchNaming {
  branch?: string;
  /** What names the work, from `workNameFor`. */
  name?: WorkName | null;
  prefix?: string;
  /**
   * `branch` is one a person named for this item (EO-365), rather than
   * one EO cut. It must already exist: a local branch is checked out as
   * it stands, and one only `remote` has is fetched and checked out
   * under the same name. One that exists in neither place is refused,
   * naming it — never created — and so is one already checked out in
   * another working copy, naming that path. No start point is ever
   * resolved for it.
   */
  named?: { remote: string; resolve?: RemoteRefResolver };
}

function resolveBranch(itemKey: string, naming: BranchNaming): string {
  return naming.branch ?? branchNameFor(itemKey, naming.name, naming.prefix);
}

export interface WorktreeConfig {
  repoPath: string;
  baseBranch: string;
  /** Overridable so tests don't touch the real ~/.eo. */
  worktreeRoot?: string;
}

export interface CreatedWorktree {
  itemKey: string;
  path: string;
  branch: string;
}

/**
 * Every guard returns a reason instead of throwing, because the caller's
 * job is to escalate it as an engine comment (ARCHITECTURE.md, "Escalation ends the run", invariant
 * #8) rather
 * than to catch an exception. G-01: "escalate rather than guessing".
 *
 * `options` is for the refusals that are a *question* rather than a
 * report — where EO can name the answers it would accept, they travel
 * with the reason so the escalation comment can offer them as buttons
 * instead of asking the reader to type one. Most refusals have none:
 * there is no menu of answers to "the repository has uncommitted
 * changes".
 */
export type WorktreeResult<T> = { ok: true; value: T } | { ok: false; reason: string; options?: string[] };

/**
 * Resolves what a *new* branch should be cut from, invoked only when
 * `ensureWorktree` is actually about to create one (EO-10 / KAN-42:
 * "resolves it once, at dispatch time"). Reusing or re-attaching an
 * existing worktree never calls this — that branch's start point was
 * decided, and baked into git history, the one time it was created.
 *
 * Returns the same shape `createWorktree`/`ensureWorktree` do, so a
 * stacking escalation (closed dependency, tied siblings) can refuse the
 * same way an unresolvable base ref or a clashing branch already does —
 * nothing git-specific about the failure shape changes.
 */
export type StartPointResolver = () => Promise<WorktreeResult<string>>;

/**
 * Creates `~/.eo/worktrees/<KEY>` on a new branch `eo/<KEY>`, cut from
 * `startPoint`.
 *
 * `startPoint` defaults to the repository's base branch *as a local ref*,
 * which is only ever reached when a caller passed no `StartPointResolver`
 * — every dispatch does (`dispatchWorkspace.ts`), and what it resolves is
 * the remote's `origin/<base>` rather than the local branch of that name.
 *
 * Refuses rather than guesses in two situations, both of which mean
 * something a human should look at: the repo isn't a repo, or the branch
 * already exists (its history is someone's work — silently reusing or
 * clobbering it is the kind of thing you only notice afterwards).
 *
 * Uncommitted changes in `repoPath` are deliberately *not* one of them,
 * though they used to be. `git worktree add` cuts from a commit and
 * writes a fresh checkout, so the state of the human's working copy has
 * no bearing on what the new worktree contains — and now that the start
 * point is a remote ref, neither does the branch they have checked out.
 * Refusing on it only ever blocked dispatch on work that was never going
 * to be included either way.
 */
export async function createWorktree(
  config: WorktreeConfig,
  itemKey: string,
  startPoint: string = config.baseBranch,
  naming: BranchNaming = {},
  options: WorktreeRunOptions = {},
): Promise<WorktreeResult<CreatedWorktree>> {
  const { repoPath } = config;

  if (options.signal?.aborted) return cancelled(`Cutting a worktree for ${itemKey}`);

  if (!(await isGitRepo(repoPath))) {
    return { ok: false, reason: `The configured repo path is not a git repository: ${repoPath}` };
  }

  const branch = resolveBranch(itemKey, naming);
  if (await branchExists(repoPath, branch)) {
    return {
      ok: false,
      reason: `The branch "${branch}" already exists. It may hold earlier work for ${itemKey}, so nothing was created — delete or rename it, then reply to retry.`,
    };
  }

  const path = worktreePathFor(itemKey, config.worktreeRoot ?? defaultWorktreeRoot());
  const added = await git(["worktree", "add", path, "-b", branch, startPoint], repoPath, options.signal ? { signal: options.signal } : {});
  if (!added.ok) {
    return { ok: false, reason: `Could not create a worktree for ${itemKey} at ${path}: ${added.error}` };
  }

  // The line worth having a week later: which ref this branch actually
  // came from, recorded at the one moment anything knows it.
  options.onProgress?.(`Cut "${branch}" from ${startPoint}, checked out at ${path}.`);
  await excludeEoDirectories(path, options);
  return { ok: true, value: { itemKey, path, branch } };
}

/**
 * Get-or-create: returns the item's existing worktree if it already
 * has one, re-attaches its branch if the checkout is gone, and otherwise
 * creates both.
 *
 * createWorktree is deliberately strict — an existing branch is a
 * refusal, because it usually means someone else's work. But an item
 * legitimately gets dispatched more than once (implement, then review,
 * then a correction after a rejection), and each of those should land in
 * the same checkout rather than being blocked by the branch the first
 * one made.
 *
 * The re-attach branch is what makes releasing a worktree safe at all.
 * Cleanup keeps the branch and drops the checkout — that is the whole
 * point, the commits are the deliverable — but without this, the next
 * dispatch for that item hit "the branch eo/<KEY> already exists" and
 * the item could never move again. Releasing a worktree is meant to
 * free disk, not to retire an item.
 *
 * `resolveStartPoint`, when given, is only ever called on the
 * create-a-new-branch path below — never for a reuse or a re-attach,
 * since the branch's start point was already decided (and is now git
 * history) the one time it was actually cut (EO-10 / KAN-42).
 */
export async function ensureWorktree(
  config: WorktreeConfig,
  itemKey: string,
  resolveStartPoint?: StartPointResolver,
  naming: BranchNaming = {},
  options: WorktreeRunOptions = {},
): Promise<WorktreeResult<CreatedWorktree>> {
  const path = worktreePathFor(itemKey, config.worktreeRoot ?? defaultWorktreeRoot());
  const branch = resolveBranch(itemKey, naming);

  if (options.signal?.aborted) return cancelled(`Preparing the worktree for ${itemKey}`);

  const listed = await listWorktrees(config.repoPath);
  if (listed.ok) {
    // samePath, not ===: git reports its own canonical form, which
    // differs from ours on macOS (/tmp symlink) and Windows (8.3 names).
    const existing = listed.worktrees.find((entry) => samePath(entry.path, path) && entry.branch === branch);
    if (existing) {
      // The common case by a wide margin — every dispatch after the
      // first — and worth one line, because a run that says nothing and
      // a run that quietly did nothing look identical.
      options.onProgress?.(`Reusing the worktree already at ${path} on "${branch}".`);
      await excludeEoDirectories(path, options);
      return { ok: true, value: { itemKey, path, branch } };
    }

    // Held somewhere else — a human moved it, or an earlier root is
    // still registered. Say so rather than letting git fail with
    // "already checked out" from inside a dispatch.
    const elsewhere = listed.worktrees.find((entry) => entry.branch === branch);
    // A branch a person named is most often checked out in their own
    // working copy (EO-365) — the repository's checkout itself, which
    // this listing includes. Git will not check one branch out twice, and
    // switching the person's checkout to something else is not EO's to
    // do, so the refusal says where it is and that it was left alone.
    if (elsewhere && naming.named) {
      return {
        ok: false,
        reason:
          `The branch "${branch}" named for ${itemKey} is already checked out in another working copy, at ${elsewhere.path}, and git will not ` +
          `check out one branch in two places. EO left that checkout exactly as it is and created nothing. Switch it to another branch ` +
          `(or remove that worktree), then reply to retry.`,
      };
    }
    if (elsewhere) {
      return {
        ok: false,
        reason:
          `The branch "${branch}" is already checked out at ${elsewhere.path}, which is not where EO expects it (${path}). ` +
          `Remove that worktree or move it back, then reply to retry.`,
      };
    }
  }

  // What is actually at the path decides what happens next — not only
  // what git's registration list happened to report (issue #143).
  //
  // The fast path above needs a listing that succeeded *and* an entry
  // whose path and branch both match. Miss any part of that — a listing
  // git could not produce, a registration pruned while the checkout
  // stayed on disk, a restart that scheduled a run against a worktree
  // the previous process left behind — and every route out of here used
  // to end in `git worktree add`, which refuses a path that already
  // exists. A reviewer step that was perfectly runnable became
  // `fatal: '<path>' already exists`, and the item stopped moving.
  const occupancy = await inspectWorktreePath(config.repoPath, path, branch);
  switch (occupancy.state) {
    case "ours":
      // The checkout git did not tell us about is the one the agent
      // wants: same repository, same branch, work already in it.
      options.onProgress?.(`Found "${branch}" already checked out at ${path}, so it is being used as it stands rather than re-created.`);
      await excludeEoDirectories(path, options);
      return { ok: true, value: { itemKey, path, branch } };

    case "other-branch":
      return {
        ok: false,
        reason:
          `${itemKey}'s worktree goes at ${path}, and that path already holds a checkout of "${occupancy.branch}" rather than "${branch}". ` +
          `Move or remove that checkout, then reply to retry.`,
      };

    case "occupied":
      return {
        ok: false,
        reason:
          `${itemKey}'s worktree goes at ${path}, and that path already holds ${occupancy.found}. ` +
          `Nothing was created or re-attached there — clear the path or move what is in it, then reply to retry.`,
      };

    case "unknown":
      // Not "the path is free": a look that failed establishes nothing
      // (invariant #5), and guessing free is how a dispatch ends up
      // writing over something nobody agreed to lose.
      return {
        ok: false,
        reason:
          `Could not read what is at ${path}, where ${itemKey}'s worktree goes, so nothing was created or re-attached there: ${occupancy.error}. ` +
          `Deal with the path, then reply to retry.`,
      };

    case "vacant":
      break;
  }

  if (await branchExists(config.repoPath, branch)) {
    options.onProgress?.(`"${branch}" already exists, so its checkout is being put back at ${path} rather than started over.`);
    return reattachWorktree(config, itemKey, path, branch, options);
  }

  // A branch a person named is never created (EO-365): not here, and not
  // by `createWorktree` below from a start point EO worked out. It is
  // either on the remote, or it is refused.
  if (naming.named) return attachRemoteBranch(config, itemKey, path, branch, naming.named, options);

  if (!resolveStartPoint) return createWorktree(config, itemKey, undefined, naming, options);

  // The slow half: resolving a start point fetches from the remote, and
  // may ask a forge about a dependency's merge state. Both are bounded by
  // their own timeouts and both take the signal, so this is the step a
  // cancel actually lands in.
  options.onProgress?.(`Working out where to cut "${branch}" from.`);
  const startPoint = await resolveStartPoint();

  // Cancellation is read before the result, not after. Killing the
  // fetches this resolution is made of does not produce a refusal that
  // says "cancelled" — it produces whatever they degrade into: a base ref
  // that will not resolve, or a dependency that looks unmerged because
  // the fetch that would have said otherwise was the one killed. Reading
  // the result first reported one of those as the reason, so a run the
  // person themselves stopped came back blaming their repository.
  if (options.signal?.aborted) return cancelled(`Cutting a worktree for ${itemKey}`);
  if (!startPoint.ok) return startPoint;
  return createWorktree(config, itemKey, startPoint.value, naming, options);
}

/**
 * Puts a checkout back on a branch this item already owns — `git
 * worktree add` *without* `-b`, which is the difference between
 * resuming work and starting it over.
 */
async function reattachWorktree(
  config: WorktreeConfig,
  itemKey: string,
  path: string,
  branch: string,
  options: WorktreeRunOptions = {},
): Promise<WorktreeResult<CreatedWorktree>> {
  const added = await git(["worktree", "add", path, branch], config.repoPath, options.signal ? { signal: options.signal } : {});
  if (!added.ok) {
    return {
      ok: false,
      reason: `Could not re-attach the worktree for ${itemKey} at ${path} on its existing branch "${branch}": ${added.error}`,
    };
  }
  options.onProgress?.(`Checked "${branch}" back out at ${path}, keeping every commit already on it.`);
  await excludeEoDirectories(path, options);
  return { ok: true, value: { itemKey, path, branch } };
}

/**
 * Checks out a branch a person named that this repository has no local
 * copy of, from the remote (EO-365).
 *
 * The local branch it makes carries the same name and starts at the
 * commit the remote has now, so nothing is renamed and every commit on
 * it is kept; it tracks the remote's branch where a tracking ref exists,
 * so a push later goes back to the same branch. A branch the remote does
 * not have, a repository with no such remote, or a remote this call could
 * not reach is refused naming the branch, and nothing is created — a
 * stale tracking ref is not taken as proof the branch is still there,
 * because checking out what a deleted branch left behind would start the
 * work somewhere nobody can open a pull request from.
 */
async function attachRemoteBranch(
  config: WorktreeConfig,
  itemKey: string,
  path: string,
  branch: string,
  named: NonNullable<BranchNaming["named"]>,
  options: WorktreeRunOptions,
): Promise<WorktreeResult<CreatedWorktree>> {
  const { remote } = named;
  const resolve = named.resolve ?? resolveRemoteRef;
  options.onProgress?.(`"${branch}" is not in this repository, so EO is looking for it on ${remote}.`);
  const resolved = await resolve(config.repoPath, remote, branch, options.signal ? { signal: options.signal } : {});
  if (options.signal?.aborted) return cancelled(`Checking out "${branch}" for ${itemKey}`);

  const nothing = `Nothing was created. Push it to \`${remote}\`, or change or clear the branch named on ${itemKey}, then reply to retry.`;
  if (resolved.kind === "no-remote") {
    return {
      ok: false,
      reason: `The branch "${branch}" named for ${itemKey} does not exist in this repository, and the repository has no remote called \`${remote}\` to look for it on. ${nothing}`,
    };
  }
  if (resolved.kind === "unresolved") {
    return { ok: false, reason: `The branch "${branch}" named for ${itemKey} exists neither in this repository nor on \`${remote}\`: ${resolved.problem} ${nothing}` };
  }
  if (resolved.unconfirmed !== undefined) {
    return {
      ok: false,
      reason:
        `The branch "${branch}" named for ${itemKey} is not in this repository, and EO could not confirm it is still on \`${remote}\`: ` +
        `\`git fetch ${remote} ${branch}\` failed: ${resolved.unconfirmed} ${nothing}`,
    };
  }

  // The tracking ref this call's own fetch wrote, so the branch starts at
  // the remote's tip and tracks it (EO-755: never `FETCH_HEAD`, which a
  // fetch for another item can replace before this line runs).
  const args = ["worktree", "add", "--track", "-b", branch, path, resolved.ref];
  const added = await git(args, config.repoPath, options.signal ? { signal: options.signal } : {});
  if (!added.ok) {
    return { ok: false, reason: `Could not check out "${branch}" from ${remote} for ${itemKey} at ${path}: ${added.error}` };
  }
  options.onProgress?.(`Checked out "${branch}" from ${remote} at ${path}, keeping every commit already on it.`);
  await excludeEoDirectories(path, options);
  return { ok: true, value: { itemKey, path, branch } };
}

/**
 * What is sitting at the item's worktree path, established by looking
 * at the disk rather than by asking git what it has registered.
 *
 * The registration list is the faster answer and still the first one
 * `ensureWorktree` asks for, but it is not the authority: it can be
 * unreadable, it can be pruned out from under a checkout that is still
 * there, and it can name a branch that is not the one HEAD is on. The
 * disk cannot disagree with itself.
 *
 * Five answers rather than "free or not", because they have five
 * different remedies — and because "the look failed" is not the same
 * claim as "there is nothing there" (invariant #5), the same distinction
 * `checkPath` draws for a removal.
 */
type PathOccupancy =
  /** Nothing there, or an empty directory — which `git worktree add` itself accepts. */
  | { state: "vacant" }
  /** A working tree of this repository, already checked out on the item's own branch. */
  | { state: "ours" }
  /** A working tree of this repository, on some other branch. */
  | { state: "other-branch"; branch: string }
  /** Something else, described in terms of what was found there. */
  | { state: "occupied"; found: string }
  /** The look itself failed, so nothing about the path is established. */
  | { state: "unknown"; error: string };

async function inspectWorktreePath(repoPath: string, path: string, branch: string): Promise<PathOccupancy> {
  let entries: string[];
  try {
    // `lstat` before `readdir`, so a symlink or a file at the path is
    // reported as what it is instead of as an ENOTDIR from the read.
    const found = await lstat(path);
    if (!found.isDirectory()) return { state: "occupied", found: found.isSymbolicLink() ? "a symbolic link, not a directory" : "a file, not a directory" };
    entries = await readdir(path);
  } catch (failure) {
    if (errorCode(failure) === "ENOENT") return { state: "vacant" };
    return { state: "unknown", error: describeError(failure) };
  }

  // An existing *empty* directory is not in the way of anything: `git
  // worktree add` refuses a path that exists only when it has something
  // in it, so calling this vacant keeps the create and re-attach paths
  // below exactly as they were.
  if (entries.length === 0) return { state: "vacant" };

  // `--show-toplevel` rather than `--is-inside-work-tree`: the question
  // is whether *this* path is the root of a working tree, and a
  // directory that merely sits inside somebody's repository (a home
  // directory under version control, say) would answer yes to the
  // second and is not a checkout of anything EO can use.
  const toplevel = await git(["rev-parse", "--show-toplevel"], path);
  if (!toplevel.ok || toplevel.stdout === "" || !samePath(toplevel.stdout, path)) {
    return { state: "occupied", found: describeContents(entries) };
  }

  // Same branch name in an unrelated repository is not this item's
  // work, and handing an agent that checkout would be worse than
  // refusing: it would commit to somebody else's history.
  const theirs = await commonGitDir(path);
  const ours = await commonGitDir(repoPath);
  if (theirs === null || ours === null) {
    return { state: "unknown", error: `could not work out which repository the checkout at ${path} belongs to` };
  }
  if (!samePath(theirs, ours)) return { state: "occupied", found: `a checkout of a different repository (${theirs})` };

  const head = await currentBranch(path);
  if (!head.ok) return { state: "unknown", error: head.error };
  if (head.stdout === "HEAD") {
    const commit = await git(["rev-parse", "--short", "HEAD"], path);
    return { state: "occupied", found: `a checkout with a detached HEAD${commit.ok ? ` at ${commit.stdout}` : ""}, not on any branch` };
  }
  if (head.stdout !== branch) return { state: "other-branch", branch: head.stdout };

  return { state: "ours" };
}

/**
 * The repository a working tree belongs to, as its shared git directory
 * — the one path that is identical for a repository and every worktree
 * cut from it.
 *
 * Resolved rather than compared as printed: `--git-common-dir` answers
 * relative to the directory it ran in when that is shorter (a plain
 * `.git` in a repository's own root), so the two sides of the
 * comparison are not in the same form until this puts them there.
 */
async function commonGitDir(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--git-common-dir"], cwd);
  if (!result.ok || result.stdout === "") return null;
  return isAbsolute(result.stdout) ? result.stdout : join(cwd, result.stdout);
}

/**
 * What is in a directory that is in the way, in the words of somebody
 * who has to go and look at it.
 *
 * `fatal: '<path>' already exists` — git's own answer, and the one this
 * replaces — sends the reader to a path without telling them what they
 * are looking for. A few names from inside it usually settle in one
 * glance whether it is a half-deleted checkout, an npm install nobody
 * cleaned up, or something that was never EO's at all.
 */
function describeContents(entries: string[]): string {
  const shown = entries.slice(0, 3);
  const rest = entries.length - shown.length;
  return `a directory that is not a git checkout (${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""})`;
}

export interface RemoveWorktreeOptions {
  /** Required to discard uncommitted agent work — G-01: "don't destroy work silently". */
  force?: boolean;
  deleteBranch?: boolean;
  /**
   * The item's stored branch — the one `deleteBranch` would delete
   * (EO-365). A branch is named once and may since carry a Jira key or
   * an older prefix, or be one a person named, so recomputing it from the
   * item key deletes the wrong branch or none. `branchNameFor(itemKey)`
   * only when the caller has nothing stored.
   */
  branch?: string;
  /**
   * The stored branch is one a person named (EO-365). It is theirs, and
   * it is never deleted, whatever `deleteBranch` says.
   */
  namedBranch?: boolean;
}

/**
 * Why a removal did not happen. Two situations, and they are not
 * interchangeable (issue #131).
 *
 * `uncommitted-changes` is the deliberate refusal: the tree holds work
 * that exists nowhere else, so it was left alone and a person has
 * something to look at. `removal-failed` is EO trying and not managing
 * it — the checkout is still on disk with nothing said about its
 * contents, and the remedy is whatever the reason names. Reporting the
 * second as the first sends the reader looking for unsaved work that
 * was never there.
 */
export type RemovalRefusal = "uncommitted-changes" | "removal-failed";

/**
 * `WorktreeResult<{ removed: boolean }>` with the refusal classified.
 *
 * Assignable to `WorktreeResult` wherever a caller only wants the
 * reason, which is most of them; the callers that report a removal to a
 * person — boot-time cleanup and item deletion — read `refusal` to say
 * which of the two happened.
 */
export type RemoveWorktreeResult = { ok: true; value: { removed: boolean } } | { ok: false; reason: string; refusal: RemovalRefusal };

/**
 * Does either half of a failed removal name the Windows path-length
 * wall?
 *
 * Both can: git says "Filename too long", and libuv reports
 * ENAMETOOLONG. Either one means the same thing and has the same
 * remediation, so both are matched.
 */
function isPathLengthFailure(text: string): boolean {
  return /file ?name too long|ENAMETOOLONG/i.test(text);
}

/**
 * What to say when neither git nor the filesystem could remove a
 * worktree.
 *
 * Names both errors, because they are two different failures and the
 * second one is the interesting one: "git said X, and deleting it
 * ourselves said Y" is diagnosable, while either alone reads as a
 * mystery.
 *
 * On Windows it also names the remediation. EO already passes
 * `core.longpaths` to every git invocation (EO-129), so a path-length
 * failure that survives that is the OS's own 260-character limit, which
 * nothing EO can pass to git will lift — only the user can, at the OS
 * level. Issue #131 asks for exactly this: succeed, or say something
 * actionable.
 *
 * The platform is a parameter rather than read from `process` so both
 * shapes can be asserted from any machine, same as `composeGitArgs`.
 */
export function removalFailureReason(input: {
  itemKey: string;
  path: string;
  gitError: string;
  fsError: string;
  platform: NodeJS.Platform;
}): string {
  return (
    `Could not remove the worktree for ${input.itemKey} at ${input.path}. ` +
    `git worktree remove failed: ${input.gitError} — and clearing it directly did not finish either: ${input.fsError}` +
    windowsLongPathRemediation(`${input.gitError}\n${input.fsError}`, input.platform)
  );
}

/** The OS-level fix, appended to a refusal whose evidence names the path-length wall. */
function windowsLongPathRemediation(evidence: string, platform: NodeJS.Platform): string {
  if (platform !== "win32" || !isPathLengthFailure(evidence)) return "";
  return (
    `\n\n` +
    `This is Windows' 260-character path limit, and EO already passes core.longpaths to git, so the remaining fix is at the OS ` +
    `level: enable Windows long-path support — Group Policy "Enable Win32 long paths", or set ` +
    `HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled to 1 — then reboot and release the worktree again.`
  );
}

/**
 * What a look at the worktree path established.
 *
 * Three answers, not two. "The `lstat` threw" is not the same claim as
 * "the path is gone": only ENOENT proves absence, while EACCES, EPERM
 * or ELOOP mean the path may well still be sitting there, unreadable.
 * Collapsing those into "gone" is how a fallback reports a success it
 * never verified (invariant #5).
 */
type PathCheck = { state: "gone" } | { state: "present" } | { state: "unknown"; error: string };

async function checkPath(path: string): Promise<PathCheck> {
  try {
    // `lstat`, not `stat`: the question is whether this entry is still
    // there, and a dangling symlink at the path is still something to
    // clear rather than a path that is gone.
    await lstat(path);
    return { state: "present" };
  } catch (failure) {
    if (errorCode(failure) === "ENOENT") return { state: "gone" };
    return { state: "unknown", error: describeError(failure) };
  }
}

function errorCode(failure: unknown): string | undefined {
  if (typeof failure !== "object" || failure === null || !("code" in failure)) return undefined;
  return typeof failure.code === "string" ? failure.code : undefined;
}

function describeError(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Is this path git reported the one we just deleted?
 *
 * `samePath` alone is not enough here. It canonicalises both sides, and
 * canonicalising a path that no longer exists cannot resolve the
 * symlinks above it — macOS's /tmp is /private/tmp, which is the form
 * git prints — so the deleted side is rebuilt from its parent, which
 * does still exist. Comparing basenames instead would be wrong the
 * other way: a human's own worktree of the same name under a different
 * root is not this one.
 */
function isDeletedPath(reported: string, deleted: string): boolean {
  return samePath(reported, join(canonicalPath(dirname(deleted)), basename(deleted)));
}

/**
 * Is git still carrying a registration for a checkout that is gone?
 *
 * The registration is the half of the removal that outlives the
 * directory, and a stale one is not cosmetic: `ensureWorktree` reads
 * `listWorktrees` to decide a tree already exists and reuses it, so a
 * left-behind entry turns the next dispatch for this item into a
 * reuse of a directory that is not there.
 *
 * Three answers here for the same reason as `checkPath`: a listing git
 * could not produce establishes nothing, and "we could not look" is not
 * "there is nothing there". Reading it as an absence is how the one
 * state this reconciliation exists to catch gets reported as a clean
 * removal.
 */
type RegistrationCheck = { state: "gone" } | { state: "present" } | { state: "unknown"; error: string };

async function checkRegistration(repoPath: string, path: string): Promise<RegistrationCheck> {
  const listed = await listWorktrees(repoPath);
  if (!listed.ok) return { state: "unknown", error: listed.error };
  return listed.worktrees.some((entry) => isDeletedPath(entry.path, path)) ? { state: "present" } : { state: "gone" };
}

/** A failure the delete itself also had something to say about, or just the failure. */
function withDeleteError(deleteError: string, detail: string): string {
  return deleteError === "" ? detail : `${deleteError} — and ${detail}`;
}

/** A path check that did not establish the tree is gone — the only two states worth a refusal. */
type UnverifiedPath = Exclude<PathCheck, { state: "gone" }>;

/**
 * What to say when git reported a removal the disk does not show.
 *
 * Distinct from `removalFailureReason` because nothing failed as far as
 * git is concerned, which is the confusing part and so the part the
 * message leads with. Same remediation appendix: a tree Windows would
 * not let go of is one of the ways this state arises.
 */
function unverifiedRemovalReason(input: { itemKey: string; path: string; checked: UnverifiedPath; platform: NodeJS.Platform }): string {
  const detail =
    input.checked.state === "unknown"
      ? `whether ${input.path} is gone could not be established: ${input.checked.error}`
      : `${input.path} is still on disk`;
  return (
    `Could not remove the worktree for ${input.itemKey}: git worktree remove reported success, but ${detail}.` +
    windowsLongPathRemediation(input.checked.state === "unknown" ? input.checked.error : "", input.platform)
  );
}

/**
 * The last resort when `git worktree remove` fails: clear the directory
 * ourselves, then make git's bookkeeping match.
 *
 * `fs.rm` reaches trees git cannot. It goes through libuv, which
 * prefixes an absolute long path with `\\?\` itself, so it clears paths
 * Windows would otherwise refuse — and it does not care about the
 * states git's own recursive delete gives up on.
 *
 * Both halves are then verified rather than assumed (invariant #5). The
 * directory is re-read from disk, because a removal that half-succeeded
 * is exactly the case a thrown/not-thrown answer gets wrong. And the
 * registration is re-read from git, because `worktree prune`
 * deliberately keeps a locked entry — so the one tree git most reliably
 * refuses to remove is also the one whose registration a bare prune
 * leaves behind. Unlocking first is what lets the prune land; its own
 * failure says nothing (a tree that was never locked cannot be
 * unlocked), so what counts is what git lists afterwards — and a
 * listing git could not produce is a refusal too, since a removal
 * nobody can confirm is not one to report as done.
 *
 * Never called on a tree nobody has accounted for — see `removeWorktree`.
 */
async function clearWorktreeDirectory(repoPath: string, path: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let error = "";
  try {
    await rm(path, { recursive: true, force: true });
  } catch (failure) {
    error = describeError(failure);
  }

  const checked = await checkPath(path);

  // A lock comes off only once the tree it was protecting is
  // demonstrably gone. A person locks a worktree to stop exactly this,
  // and unlocking one still sitting on disk would strip that protection
  // off a checkout the call is about to refuse to remove anyway —
  // leaving it easier to destroy than it was before EO touched it.
  if (checked.state === "gone") await git(["worktree", "unlock", path], repoPath);

  // The prune runs either way: a tree the delete half-cleared is exactly
  // the one whose registration git can now drop. Neither call's outcome
  // is read — `unlock` fails on anything that was not locked, and
  // `prune` succeeding is not the same as the entry being gone. The
  // listing below is the ground truth for both.
  const pruned = await git(["worktree", "prune"], repoPath);

  if (checked.state === "present") return { ok: false, error: error === "" ? `${path} is still on disk.` : error };
  if (checked.state === "unknown") {
    return { ok: false, error: withDeleteError(error, `whether ${path} is gone could not be established: ${checked.error}`) };
  }

  // The directory went. Whether git agrees it did is the other half, and
  // an unread answer to it counts as neither a yes nor a no — the prune
  // that was supposed to settle it is named here precisely because a
  // prune that failed is the likeliest reason there is still something
  // to find.
  const registered = await checkRegistration(repoPath, path);
  const prune = pruned.ok ? "" : ` The prune before it failed: ${pruned.error}`;
  if (registered.state === "present") {
    return {
      ok: false,
      error: withDeleteError(
        error,
        `the directory is gone, but git still lists it as a worktree of ${repoPath}, ` +
          `which would make the next dispatch for this ticket reuse a checkout that is not there.${prune}`,
      ),
    };
  }
  if (registered.state === "unknown") {
    return {
      ok: false,
      error: withDeleteError(
        error,
        `the directory is gone, but whether git still lists it as a worktree of ${repoPath} could not be established: ` +
          `${registered.error}.${prune}`,
      ),
    };
  }

  return { ok: true };
}

/**
 * May the filesystem fallback clear this tree by hand?
 *
 * `force` says so outright. Otherwise the tree has to be clean as *git*
 * reads it, raw and with nothing overlooked — an unreadable status
 * accounts for nothing that may be in there, and neither does a status
 * something has filtered.
 *
 * Asked here, after the generated index has been disposed of, rather
 * than inherited from the guard above, and the difference is the whole
 * point (EO-170). The guard deliberately overlooks anything on an
 * index-shaped path, at any depth, because that is what keeps it
 * agreeing with `verify.ts` and `borrowed.ts` about what an index is.
 * Disposal is narrower on purpose: it deletes only the index EO writes,
 * at the root. So the two do not meet in the middle, and what can be
 * left over is a directory somebody else created that merely shares the
 * name — overlooked by the guard, still on disk, and still enough for
 * git to refuse the removal.
 *
 * Reading the guard's verdict as permission to delete would then hand
 * that refusal to a recursive delete, which is the one outcome this
 * whole path exists to prevent: EO would destroy a directory it did not
 * create, on the strength of a check that was never asked whether the
 * directory mattered. Re-reading is cheap, happens only where a removal
 * has already failed, and means the fallback acts on exactly what its
 * own comment claims — a checkout with nothing in it to lose.
 */
async function mayClearByHand(path: string, force: boolean): Promise<boolean> {
  if (force) return true;
  const status = await statusPorcelain(path);
  return status.ok && status.stdout === "";
}

/**
 * Prunes an item's worktree, and optionally its branch.
 *
 * Refuses when the worktree has uncommitted changes unless `force` is
 * set: those changes are an agent's in-progress work, and a run that
 * crashed halfway is exactly when they exist and exactly when you'd
 * want them.
 *
 * A generated repository index is not that work, on either side of the
 * removal (EO-170). EO's guard steps over it, and it is deleted before
 * git is asked, because git counts an untracked directory as dirty too
 * and would refuse the removal EO had just decided to allow. Both halves
 * are needed and neither is `--force`: forcing would clear the same
 * obstruction by discarding whatever else was in the tree, which is
 * precisely what the refusal above exists to prevent.
 *
 * When git fails to remove a tree it was allowed to remove, the
 * directory is cleared from the filesystem instead and git's own
 * registration of it is reconciled afterwards (issue #131: on Windows
 * the checkout was otherwise stranded on disk). That fallback is gated
 * on its own check rather than on the refusal above — `force`, or a
 * status git could read and found clean once EO's own index is out of
 * the way — so it can never be the thing that discards an agent's
 * uncommitted work, nor anything else EO did not put there.
 *
 * Either refusal carries which of the two it is (`RemovalRefusal`), so
 * a caller reporting it to a person does not have to read the prose
 * back to find out whether anything was left unsaved.
 */
export async function removeWorktree(
  config: WorktreeConfig,
  itemKey: string,
  options: RemoveWorktreeOptions = {},
): Promise<RemoveWorktreeResult> {
  const path = worktreePathFor(itemKey, config.worktreeRoot ?? defaultWorktreeRoot());
  const branch = options.branch ?? branchNameFor(itemKey);

  if (!options.force) {
    const status = await statusPorcelain(path);
    // The generated repository index sits in the worktree and is EO's
    // own output, not an agent's work — the same step-over `verify.ts`
    // and `borrowed.ts` already make, through the same helper, and the
    // one this path was missing (EO-170). Without it every release on an
    // indexed repository refused, so no worktree was ever released and
    // each one went on holding its branch checked out where nothing else
    // could reach it.
    //
    // It narrows what counts as work and nothing else. A tree with a
    // real uncommitted file still refuses below, and the text attached
    // to that refusal names the file without mentioning the index.
    const uncommitted = status.ok ? withoutRepositoryIndex(status.stdout) : "";
    // An unreadable status means the worktree is already gone or broken;
    // let `git worktree remove` be the judge of that, not this check.
    if (status.ok && uncommitted !== "") {
      return {
        ok: false,
        refusal: "uncommitted-changes",
        reason:
          `The worktree for ${itemKey} has uncommitted changes, so it was left alone. ` +
          `Removing it would discard an agent's work — pass force to remove it anyway.\n\n${uncommitted}`,
      };
    }

    // The half the status above cannot see, and the reason it cannot
    // (EO-207).
    //
    // EO excludes `.agent` from git so its own skill delivery does not
    // fail every run's `clean` step. That exclusion also takes the
    // directory out of the porcelain read here *and* out of git's own
    // refusal below — and `git worktree remove` deletes ignored content
    // along with everything else. So a repository that keeps its own
    // material under `.agent` had it protected by git until EO hid it,
    // and the party that hid it owes the protection back.
    //
    // Narrow on purpose. Only `.agent` is asked about, because only
    // `.agent` is a directory EO both excluded and may find somebody
    // else's files in: the generated index is EO's own output by
    // construction and is disposed of a few lines down, and everything
    // else a checkout ignores — `node_modules`, build output — was
    // ignored by the repository's own rules long before EO arrived and
    // never blocked a removal.
    //
    // A skill folder carrying EO's marker is not counted: it is derived,
    // it goes with the worktree, and nobody loses anything.
    // Two questions, and both have to say yes before this refuses.
    // `unmanagedAgentEntries` answers "is this EO's?" off the disk;
    // `agentPathsGitWouldNotRestore` answers "would it actually be
    // lost?" out of git. A file the repository tracks is neither EO's
    // nor at risk, and refusing over one would strand the worktree of
    // every repository that keeps something under `.agent`.
    const found = unmanagedAgentEntries(path);
    const lost = found.length > 0 ? await agentPathsGitWouldNotRestore(path) : [];
    const unmanaged = lost === null ? found : found.filter((entry) => wouldBeLost(entry, lost));
    if (unmanaged.length > 0) {
      return {
        ok: false,
        refusal: "uncommitted-changes",
        reason:
          `The worktree for ${itemKey} holds files under ${WORKTREE_AGENT_DIRECTORY}/ that EO did not write, so it was left alone. ` +
          `They are excluded from git — EO excluded them — so removing the worktree would delete them without git ever having said ` +
          `they were there. Move them, or pass force to remove the worktree anyway.\n\n${unmanaged.join("\n")}`,
      };
    }
  }

  // Ignoring the index in EO's own guard is only half of it: git will
  // not remove a worktree it considers dirty either, and an untracked
  // directory is enough. So the thing EO put there is taken back out
  // before git is asked — never `--force`, which would get past the same
  // refusal by discarding whatever else is in the tree and would turn
  // the careful refusal above into a silent destruction the one time it
  // matters.
  //
  // Since EO-207 the exclusion usually answers git's half before this
  // does: a worktree EO prepared has the index excluded, so git no
  // longer sees it. This stays regardless, and not only as belt and
  // braces — the exclusion is a write that can fail, a checkout EO
  // adopted rather than cut may never have had it, and a person is
  // entitled to delete the lines. None of those should decide whether a
  // settled item lets go of its worktree.
  //
  // Safe to run before a removal that may still fail: an index is
  // derived, rebuilt from source whenever it is next wanted, and this
  // tree is about to stop existing. Deleting it costs a rebuild in the
  // worst case and nobody's work in any case.
  const stubborn = await discardRepositoryIndexes(path);

  const args = ["worktree", "remove", path];
  if (options.force) args.push("--force");
  const removed = await git(args, config.repoPath);
  if (removed.ok) {
    // git saying it removed the tree is a claim like any other
    // (invariant #5), and the acceptance criterion is about the disk,
    // not about who reported what: a removal is a removal once the path
    // is gone. Checked before the branch goes, so a refusal here leaves
    // the item's work exactly as reachable as it was.
    const checked = await checkPath(path);
    if (checked.state !== "gone") {
      return { ok: false, refusal: "removal-failed", reason: unverifiedRemovalReason({ itemKey, path, checked, platform: process.platform }) };
    }
  } else {
    // Nobody could account for what is in this tree and nobody asked for
    // it to go regardless, so nothing of anybody's is deleted and git's
    // own error goes back unchanged.
    if (!(await mayClearByHand(path, options.force === true))) {
      // A git refusal reading "contains untracked files" is baffling on
      // a tree EO just cleared its own index out of, so a disposal that
      // did not manage it says so here rather than leaving the reader to
      // guess. Nothing else changes: the tree is untouched either way.
      const blocked = stubborn.map((index) => ` EO could not delete the index it generated at ${index.path}: ${index.error}`).join("");
      return { ok: false, refusal: "removal-failed", reason: `Could not remove the worktree for ${itemKey} at ${path}: ${removed.error}${blocked}` };
    }

    const cleared = await clearWorktreeDirectory(config.repoPath, path);
    if (!cleared.ok) {
      return {
        ok: false,
        refusal: "removal-failed",
        reason: removalFailureReason({ itemKey, path, gitError: removed.error, fsError: cleared.error, platform: process.platform }),
      };
    }
  }

  // Never a branch a person named (EO-365): the checkout was EO's, the
  // branch never was.
  if (options.deleteBranch && !options.namedBranch) {
    // -D, not -d: an abandoned agent branch is unmerged by definition,
    // and -d would refuse. Reaching here already means the caller
    // decided the work is finished with.
    const deleted = await git(["branch", "-D", branch], config.repoPath);
    if (!deleted.ok) {
      return { ok: false, refusal: "removal-failed", reason: `Removed the worktree for ${itemKey}, but could not delete branch "${branch}": ${deleted.error}` };
    }
  }

  return { ok: true, value: { removed: true } };
}

/**
 * Whether a registered worktree is one EO made, and so one it may list
 * and release.
 *
 * On a `<prefix>/...` branch, as it has always been — and, since EO-365,
 * checked out directly under EO's own worktree root on any branch at
 * all: a ticket worked on a branch a person named has its checkout at
 * `<root>/<KEY>` on that branch, which carries no prefix. Without the
 * second half that checkout would be invisible to everything that
 * releases one — the settings list, deleting the ticket, boot cleanup —
 * and it would go on holding the person's branch where their own
 * working copy could not check it out. The root is EO's directory; a
 * human's worktree elsewhere is still none of EO's business.
 */
function isEoWorktree(entry: WorktreeEntry, prefix: string, root: string): entry is WorktreeEntry & { branch: string } {
  if (entry.branch === null) return false;
  return entry.branch.startsWith(`${prefix}/`) || samePath(dirname(entry.path), root);
}

export interface StaleWorktree {
  itemKey: string;
  path: string;
  branch: string;
}

/**
 * EO-managed worktrees whose item has no active run — what E-04
 * releases on launch.
 *
 * Only worktrees on a `<prefix>/...` branch, or checked out directly
 * under EO's worktree root (`isEoWorktree`, EO-365), are considered: the main
 * checkout and any worktree a human made for their own work are none of
 * our business, and deleting one would be a genuinely bad surprise.
 * `prefix` is the *currently* configured branch prefix (EO-14 / EO-16) —
 * a worktree cut under a since-changed prefix is still recognised as
 * long as the caller passes the prefix it was actually made under.
 *
 * The item key is read from the worktree's directory name, not the
 * branch: a branch may be named after a linked Jira key instead
 * (`<prefix>/KAN-46`), but the directory is always EO's own key
 * (`worktreePathFor`, unconditionally) — see EO-16.
 */
export async function listStaleWorktrees(
  config: WorktreeConfig,
  hasActiveRun: (itemKey: string) => boolean,
  prefix: string = DEFAULT_BRANCH_PREFIX,
): Promise<WorktreeResult<StaleWorktree[]>> {
  const listed = await listWorktrees(config.repoPath);
  if (!listed.ok) return { ok: false, reason: `Could not list worktrees in ${config.repoPath}: ${listed.error}` };

  const root = config.worktreeRoot ?? defaultWorktreeRoot();
  const stale: StaleWorktree[] = [];
  for (const entry of listed.worktrees) {
    if (!isEoWorktree(entry, prefix, root)) continue;
    const itemKey = basename(entry.path);
    if (!hasActiveRun(itemKey)) {
      stale.push({ itemKey, path: entry.path, branch: entry.branch });
    }
  }

  return { ok: true, value: stale };
}

export interface HeldWorktree extends StaleWorktree {
  /** Bytes on disk. Reported so a user can see what the cost of keeping it is (G-03). */
  sizeBytes: number;
  /** Uncommitted work: the reason a tree is never released automatically. */
  uncommittedChanges: number;
}

/**
 * Every EO-managed worktree, with what it costs and whether it still
 * holds unsaved work.
 *
 * `prefix` is the currently configured branch prefix (EO-14 / EO-16),
 * same caveat as `listStaleWorktrees`. The item key comes from the
 * worktree's directory name rather than the branch, for the same reason.
 *
 * Sizing walks the directory rather than shelling out to `du`, which
 * doesn't exist on Windows. Symlinks are not followed — a worktree
 * containing a link to somewhere large would otherwise report a number
 * that has nothing to do with what releasing it would free.
 */
export async function listHeldWorktrees(config: WorktreeConfig, prefix: string = DEFAULT_BRANCH_PREFIX): Promise<WorktreeResult<HeldWorktree[]>> {
  const listed = await listWorktrees(config.repoPath);
  if (!listed.ok) return { ok: false, reason: `Could not list worktrees in ${config.repoPath}: ${listed.error}` };

  const root = config.worktreeRoot ?? defaultWorktreeRoot();
  const held: HeldWorktree[] = [];
  for (const entry of listed.worktrees) {
    if (!isEoWorktree(entry, prefix, root)) continue; // never report, and so never offer to delete, a tree that isn't ours
    const status = await statusPorcelain(entry.path);
    held.push({
      itemKey: basename(entry.path),
      path: entry.path,
      branch: entry.branch,
      sizeBytes: await directorySize(entry.path),
      uncommittedChanges: status.ok && status.stdout !== "" ? status.stdout.split("\n").length : 0,
    });
  }

  return { ok: true, value: held };
}

async function directorySize(path: string): Promise<number> {
  const { readdir, lstat } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");

  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0; // gone or unreadable: reporting 0 beats failing the whole listing
  }

  for (const entry of entries) {
    const child = joinPath(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await directorySize(child);
    } else {
      try {
        total += (await lstat(child)).size;
      } catch {
        // Raced with a delete; skip it.
      }
    }
  }
  return total;
}

/** Is the configured repo ready for a run to start? Used for the boot check and before dispatch. */
export async function checkRepoReady(config: WorktreeConfig): Promise<WorktreeResult<{ branch: string }>> {
  if (!(await isGitRepo(config.repoPath))) {
    return { ok: false, reason: `The configured repo path is not a git repository: ${config.repoPath}` };
  }
  const branch = await currentBranch(config.repoPath);
  if (!branch.ok) return { ok: false, reason: `Could not determine the current branch in ${config.repoPath}: ${branch.error}` };
  return { ok: true, value: { branch: branch.stdout } };
}
