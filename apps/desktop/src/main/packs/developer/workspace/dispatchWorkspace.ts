import { existsSync } from "node:fs";
import { gitStateOf, jiraStateOf, INTERPRET_ACTION, type Item, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { GIT_WORKTREE_KIND } from "@eo/core";
import type { PrepareWorkspaceOutcome, PreparedWorkspace } from "../../../supervisor/workspaceKind.js";
import { resolveItemWorkspace, stepPickedWorkspace, workspaceFor } from "../../../supervisor/workspaceResolution.js";
import {
  asGitWorkspace,
  deleteRepositoryIndexesForItem,
  enqueueOutbox,
  getGitWorkspace,
  getItem,
  getItemByKey,
  listGitWorkspaces,
  listRepositoryIndexes,
  updateItem,
  type GitWorkspace,
  stepForItem,
} from "../../../db/repos/index.js";
import { createCliRunner, type CliRunner } from "../forge/cli.js";
import { branchPrefix } from "./branchPrefix.js";
import { git } from "./git.js";
import { baseRefFor, resolveItemStackTarget } from "./stackTarget.js";
import {
  ensureWorktree,
  excludeEoDirectories,
  listStaleWorktrees,
  removeWorktree,
  worktreePathFor,
  type BranchNaming,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  type WorktreeConfig,
  type WorktreeResult,
  type WorktreeRunOptions,
} from "./worktrees.js";
import { workNameFor } from "./workName.js";

/**
 * Where a run is to happen, or why nowhere.
 *
 * The contract's shape rather than a second copy of it (KAN-144,
 * EO-295): `prepare` is one method of the `WorkspaceKind` interface,
 * declared where the supervisor and the module host can both be typed
 * on it, and the git worktree below is one kind's answer to it.
 */
export type PrepareWorkspaceResult = PrepareWorkspaceOutcome;

/**
 * What a caller may say about the preparation it is asking for.
 *
 * Cancellation and narration, and one caller has both to give: the
 * `create_worktree` builtin, which owns a run a person can cancel and a
 * transcript they can read. An agent dispatch prepares its workspace
 * before its own controller exists, and a module is handed a prepared
 * cwd rather than preparing one — so both leave this empty and get
 * exactly the behaviour they had.
 */
export type PrepareWorkspaceOptions = WorktreeRunOptions;

function configFor(workspace: GitWorkspace, worktreeRoot?: string): WorktreeConfig {
  return { repoPath: workspace.config.repoPath, baseBranch: workspace.config.baseBranch, ...(worktreeRoot ? { worktreeRoot } : {}) };
}

/**
 * `ensureWorktree`'s `StartPointResolver` for one item (EO-10 /
 * KAN-42): resolves the stacking decision and translates it into the
 * `WorktreeResult<string>` shape a new branch's start point is cut from.
 * An escalation (closed dependency, tied siblings) refuses here — before
 * `git worktree add` ever runs — the same way an unresolvable base ref
 * or a clashing branch already does, so it surfaces through the same
 * `refuseDispatch` -> blocking `@user` comment path with no new
 * comment-posting code.
 *
 * Tied siblings carry their `choices` up with them as the answers the
 * escalation comment offers. The reason text already invites a branch
 * name as well; the buttons are for the answers EO can name itself.
 *
 * What the decision names is then resolved on the remote rather than read
 * off the local checkout (`baseRefFor`): the branch is cut from
 * `origin/main`, or from a dependency's pushed tip, so a dispatch does not
 * inherit whatever state the human's own `main` happens to be in.
 */
async function resolveStartPoint(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  run: CliRunner,
  options: PrepareWorkspaceOptions = {},
): Promise<WorktreeResult<string>> {
  const network = options.signal ? { signal: options.signal } : {};

  // Everything slow about cutting a branch is in these two calls — a
  // forge lookup per same-feature dependency, and a fetch of the base
  // branch — so the signal that stops the step has to reach them or it
  // stops nothing.
  const decision = await resolveItemStackTarget(db, workspace, item, run, undefined, network);
  if (decision.kind === "escalate") {
    const choices = decision.choices.map((choice) => choice.key);
    return { ok: false, reason: decision.reason, ...(choices.length > 0 ? { options: choices } : {}) };
  }

  // The stacking decision, said out loud. It is the one thing about a
  // dispatch that surprises people — a branch cut from a sibling's tip
  // rather than from `main` looks like a mistake until you know a
  // dependency is still open — and until this line it was recorded
  // nowhere at all.
  //
  // A base a person set on the ticket is said the same way, and says
  // where it came from (EO-364): a branch cut from somewhere other than
  // the repository's base looks like a mistake too, until you know
  // somebody asked for it.
  if (decision.kind === "named-base") options.onProgress?.(`Branching from ${decision.branch}, the base branch set on this ticket, rather than from ${workspace.config.baseBranch}.`);
  else if (decision.kind === "stack") options.onProgress?.(`Stacking on ${decision.dependency.key}, which is still open, rather than on ${workspace.config.baseBranch}.`);
  else if (decision.kind === "branch") options.onProgress?.(`Using "${decision.branch}", which you named when EO asked what to stack this on.`);
  else options.onProgress?.(`Nothing to stack on, so this comes off ${workspace.config.baseBranch}.`);

  return baseRefFor(decision, workspace, undefined, network);
}

/**
 * The worktree config for one workspace, or undefined if the id is null —
 * an item written before any repo was attached (D-04).
 *
 * Everything that touches git goes through a *item's* workspace rather
 * than "the" configured repo, which is what used to make a second
 * repository impossible: a run would have been cut from whichever
 * checkout happened to be first.
 */
export function worktreeConfigFor(db: Db, workspaceId: Uuid | null, worktreeRoot?: string): WorktreeConfig | undefined {
  if (workspaceId === null) return undefined;
  const workspace = getGitWorkspace(db, workspaceId);
  return workspace ? configFor(workspace, worktreeRoot) : undefined;
}

/** Every configured workspace's worktree config — for the operations that sweep all of them. */
export function allWorktreeConfigs(db: Db, worktreeRoot?: string): { workspace: GitWorkspace; config: WorktreeConfig }[] {
  return listGitWorkspaces(db).map((workspace) => ({ workspace, config: configFor(workspace, worktreeRoot) }));
}


/**
 * The git kind's `prepare`, in either of its two modes (G-01, EO-296).
 *
 * **Isolated** is what this always was: `~/.eo/worktrees/<KEY>` on
 * `eo/<KEY>`, cut from the right start point and recorded on the item.
 * A code-bearing item with no repository is refused here rather than run
 * somewhere — running one in EO's own directory breaks worktree
 * isolation and can make an agent edit an unrelated checkout.
 *
 * **Read** is the repository's own checkout, handed over as it stands
 * with no branch cut. Three behaviours used to arrive at that
 * separately, each with its own paragraph of reasoning and its own
 * fallback: an interpret run, an off-board conversation and a container
 * item. They are one mode now — `resolveItemWorkspace` is what decides
 * which mode an item is in, and it is the same function the card's badge
 * and the scheduler's capacity key ask.
 */
export function createWorktreeWorkspace(db: Db, worktreeRoot?: string, run: CliRunner = createCliRunner()) {
  // Every action on an item shares its worktree. Whether the
  // reviewer should get the worktree or just a diff is an open question;
  // the action is used only to make a refusal actionable.
  return async (item: Item, action: string, options: PrepareWorkspaceOptions = {}): Promise<PrepareWorkspaceResult> => {
    // Reading a reply for a parked step is not work on the branch
    // (EO-184), whatever mode the step it is parked on is in. It gets
    // the repository as it stands — and, more pointedly, because the
    // thing it is most often dispatched over is a worktree that could
    // not be cut. Preparing one here would refuse the interpretation
    // with the very refusal it was sent to read, and the reply would go
    // unread. An action rather than a mode, so it is decided here rather
    // than in the resolution every other caller shares.
    const mode = action === INTERPRET_ACTION ? "read" : resolveItemWorkspace(db, item).mode;

    if (mode === "read") {
      // The resolution's row, so the path handed over and the id
      // stamped on the prepared workspace are the same workspace. Read
      // mode has honoured the step's pick since this story landed —
      // `readableRepoPath` goes through `workspaceFor` — but it stamped
      // the *item's* id beside the picked repository's path, which is
      // the same mismatch review found one branch down.
      const picked = stepPickedWorkspace(db, item);
      const readable = asGitWorkspace(workspaceFor(db, item));
      // Nothing to read. Only reachable for an item naming a workspace
      // row that is gone while its project has none either — with the
      // foreign key off, since `items.workspace_id` references
      // `workspaces` — because an item with no workspace anywhere
      // resolves to the `none` kind and is never handed to this one. A
      // refusal rather than a substitute: there is no second checkout
      // that is this item's code.
      if (readable === undefined) {
        return { ok: false, reason: `${item.key} has no repository to read. Attach one to its project before running ${action}.` };
      }
      // The pick where there is one, and otherwise the item's own —
      // which stays null for exactly the items this mode exists for. A
      // feature spanning several repositories, a container and a
      // conversation each read *their project's* checkout without that
      // checkout being theirs, and the prepared workspace has said so
      // since EO-295. Stamping the substitute's id would claim a
      // repository for an item that deliberately has none.
      // The one thing this mode writes, and not into the working tree
      // (EO-413): the prompt tells a run on a git workspace that git
      // never sees the ticket's directory, and that has to be as true
      // of a checkout nobody cut a branch in as of a worktree.
      await excludeEoDirectories(readable.config.repoPath, options);
      return prepared(picked?.id ?? item.workspaceId, readable.config.repoPath);
    }

    // **The step's pick before the item's own** (EO-301, caught in
    // review). Read mode below has honoured the pick since this story
    // landed; isolated mode still read `item.workspaceId`, so an item on
    // repository A whose step picked repository B was dispatched as B by
    // the supervisor and then had its worktree cut in A — the two
    // readings of one question the design warns about, with the run happening
    // in the repository nobody chose. Everything after this takes the
    // row resolved here: the checkout the worktree is cut from, the base
    // branch it starts at, the outbox row's workspace, and the id the
    // prepared workspace is stamped with.
    //
    // `stepPickedWorkspace` rather than `workspaceFor`, and the
    // difference is the whole of the paragraph below: where there is no
    // pick, this path must fall back to the item's own workspace *and
    // stop*, because `workspaceFor` would go on to substitute the first
    // workspace the project spans.
    const picked = asGitWorkspace(stepPickedWorkspace(db, item));
    if (!picked && item.workspaceId === null) {
      return {
        ok: false,
        reason: `${item.key} is a ${item.type} with no repository assigned. Assign it to a repository before running ${action}.`,
      };
    }
    const workspace = picked ?? (item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId));
    // An item naming a workspace row that is gone. Reachable only with
    // the foreign key off — `items.workspace_id` references
    // `workspaces` with no cascade — so this is a defence rather than a
    // situation, but the defence has to be a refusal. The process cwd is
    // no more this item's code than it was the feature's above (issue
    // #148), and its project's other workspaces are not its either: a
    // code-bearing item's branch belongs to the one checkout it
    // names, so there is nothing here to substitute. `openForItem`
    // already refuses the same broken state for the same reason.
    if (!workspace) {
      return {
        ok: false,
        reason: `${item.key} is a ${item.type} whose repository no longer exists in EO. Assign it to a repository before running ${action}.`,
      };
    }
    const config = configFor(workspace, worktreeRoot);

    // Naming is resolved once, here, and never again for this item
    // (EO-16): an item that already has a stored branch (past its first
    // dispatch) reuses it verbatim, so a prefix change or a Jira link
    // or Reference set afterwards can never rename it. Only an item with
    // no branch yet gets a freshly computed one, from the currently
    // configured prefix and whatever names its work now (EO-638).
    // The stored branch is the git extension's since KAN-169; what it
    // means here is exactly what the column meant.
    //
    // A branch a person named is stored the same way (EO-365), and is
    // handed over marked as theirs: `ensureWorktree` then checks it out
    // from wherever it exists — locally or on the remote — and refuses
    // rather than ever creating it.
    const { branch: recorded, namedBranch, attachedAt } = gitStateOf(item);
    const naming: BranchNaming =
      recorded === null
        ? { name: workNameFor(db, item), prefix: await branchPrefix(db) }
        : namedBranch
          ? { branch: recorded, named: { remote: workspace.config.forgeRemote } }
          : { branch: recorded };

    // Only ever called on the create-a-new-branch path inside
    // ensureWorktree — reusing or re-attaching an existing worktree
    // never resolves this, since a branch's start point was decided the
    // one time it was actually cut (EO-10 / KAN-42: "resolves it once,
    // at dispatch time").
    const worktree = await ensureWorktree(config, item.key, () => resolveStartPoint(db, workspace, item, run, options), naming, options);
    if (!worktree.ok) return { ok: false, reason: worktree.reason, ...(worktree.options ? { options: worktree.options } : {}) };

    // Where a named branch stood when EO first had it (EO-365), recorded
    // once and never moved: the implementer's commits check counts from
    // here, so commits the branch already carried are not taken for this
    // item's work. It is also what makes the branch "in git" for the
    // ticket's edit rules, so a name can no longer be swapped under a
    // worktree already on it. Refused rather than skipped when it cannot
    // be read, because a check with no starting point would count the
    // person's own commits (invariant #5).
    if (namedBranch && attachedAt === null) {
      const tip = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree.value.path);
      if (!tip.ok || tip.stdout === "") {
        return {
          ok: false,
          reason: `Checked out "${worktree.value.branch}" for ${item.key}, but could not read which commit it is on, so EO cannot tell its own commits from the ones already there: ${tip.ok ? "git printed nothing" : tip.error}. Reply to retry.`,
        };
      }
      updateItem(db, item.id, { git: { attachedAt: tip.stdout } });
      options.onProgress?.(`"${worktree.value.branch}" is a branch named on this ticket, so only commits after ${tip.stdout.slice(0, 12)} count as this ticket's work.`);
    }

    // The branch is the deliverable, and until U-14 nothing wrote it
    // down: the field existed, the IPC carried it, and it was always
    // null.
    //
    // A branch a person named was written before anything was dispatched
    // (EO-365), so its first attachment is the moment that counts as
    // "the work is on this branch now", for Jira as for everything else.
    if (recorded !== worktree.value.branch || (namedBranch && attachedAt === null)) {
      if (recorded !== worktree.value.branch) updateItem(db, item.id, { git: { branch: worktree.value.branch } });
      // Where the work is happening, for whoever is watching the issue
      // rather than the app (J-04).
      // Not while Jira sync is off for this item (EO-122). The branch
      // is still recorded on the item above — the switch governs what
      // EO says to Jira, not what it knows.
      const jira = jiraStateOf(item);
      if (jira.key && jira.sync) {
        options.onProgress?.(`Told ${jira.key} which branch the work is on.`);
        enqueueOutbox(db, {
          itemId: item.id,
          // The workspace the branch was actually cut in (EO-301). The
          // binding the drain resolves from it is the *project's*, and a
          // step may only pick among its own project's workspaces — so
          // this names a different row than `item.workspaceId` would and
          // resolves to the same Jira site, which is what makes changing
          // it safe as well as correct.
          workspaceId: workspace.id,
          channel: "jira",
          kind: "branch",
          payload: { branch: worktree.value.branch },
        });
      }
    }

    return prepared(workspace.id, worktree.value.path);
  };
}

/**
 * The three fields the supervisor and every hook downstream take in
 * place of the bare path they used to (EO-295).
 *
 * `workspaceId` is the workspace this run was actually prepared in —
 * the one the resolution chose, which since EO-301 is the step's pick
 * before the ticket's own. It was the *item's* until review found that
 * an isolated run stamped the row it had not used. Null for exactly the
 * items that get a checkout to read rather than a worktree to write in:
 * a discussion, a container, a feature spanning several repositories.
 *
 * The kind is always this one — an item that reaches here reached here
 * because its workspace named it.
 */
function prepared(workspaceId: Uuid | null, cwd: string): { ok: true; workspace: PreparedWorkspace } {
  return { ok: true, workspace: { cwd, kind: GIT_WORKTREE_KIND, workspaceId } };
}

/**
 * Releases one EO worktree, and forgets what EO recorded about the
 * index that was inside it (EO-174).
 *
 * **The record dies with the thing it describes.** An index lives in
 * the item's own checkout and is deleted with it — `removeWorktree`
 * discards the directory before git is asked to take the tree, and has
 * since EO-170. Nothing removed the row that described it, so every
 * finished item left behind a note saying `ready`, with a revision
 * and a timestamp, about a directory that no longer existed. Fifteen of
 * those on one machine and three worktrees to go round.
 *
 * **Why it is deleted rather than left visible as "not indexed".** The
 * alternative was considered and rejected: the settings panel reads as
 * a list of the indexes that exist, and a row that stays behind is a
 * row somebody has to work out is dead — with a Refresh and a Rebuild
 * on it, both of which name a checkout that is gone. Keeping it would
 * only pay for itself if something wanted to know that an item was
 * once indexed and at which revision, and nothing does: `run_events`
 * already records every build, its cost and its size, which is what the
 * benefit report reads. So the row goes, and the history stays where
 * history belongs.
 *
 * **Why here and not in a sweep that notices later.** Releasing is the
 * event. It knows the item, it is already the place that disposes of
 * the generated index, and a note removed at the moment the thing goes
 * is never wrong in between. A cleaner that ran afterwards would leave
 * a window in which the row asserts `ready` about nothing, which is the
 * whole of what this fixes.
 *
 * Only on a successful removal. A refusal — uncommitted work, a tree
 * git would not take — leaves the checkout and its index exactly where
 * they were, and a row forgotten there would be a real index nobody had
 * a note about.
 *
 * `removeWorktree` is deliberately not the place: `worktrees.ts` is
 * EO's git plumbing and takes no database handle. The one other direct
 * caller is `items:delete`, which does not need this — deleting the
 * item cascades the row away, and the foreign key is a stronger
 * guarantee than a call would be.
 */
export async function releaseWorktree(
  db: Db,
  config: WorktreeConfig,
  itemKey: string,
  options: RemoveWorktreeOptions = {},
): Promise<RemoveWorktreeResult> {
  // By key, because that is what every release path holds; the two
  // that have an item in hand would otherwise have to agree with the
  // one that does not about how to look one up. A key with no item
  // behind it is a worktree whose item has already been deleted,
  // and the cascade took its row long ago.
  const item = getItemByKey(db, itemKey);
  // The branch the item actually has, rather than one recomputed from
  // its key (EO-365) — and whether a person named it, which no release
  // may ever delete.
  const stored = item ? gitStateOf(item) : undefined;
  const removed = await removeWorktree(config, itemKey, {
    ...options,
    ...(stored?.branch ? { branch: stored.branch, namedBranch: stored.namedBranch } : {}),
  });
  if (removed.ok && item) deleteRepositoryIndexesForItem(db, item.id);
  return removed;
}

/**
 * Forgets index records whose checkout is no longer on disk, answering
 * with the item keys it forgot (EO-174).
 *
 * The reconciliation that goes with the rule above, and it is needed
 * exactly once per machine: every item finished before that rule
 * existed left a record behind, and no fix applied from now on removes
 * one on its own. Run at boot beside `releaseStaleWorktrees`, for the
 * same reason and at the same moment — nothing is dispatched yet, so
 * nothing is halfway through building an index this could contradict.
 *
 * **What it checks is the checkout, not the index directory.** Where a
 * provider puts an index inside a worktree is the provider's business
 * and this file has none of it (`indexPaths.ts` says so at length). The
 * checkout, on the other hand, is EO's own: `worktreePathFor` is the
 * same derivation `verify.ts` and the settings commands use, so all
 * three agree about where an item's work lives. A checkout that is
 * gone took its index with it, whatever the implementation called the
 * directory.
 *
 * It is also the conservative check. A checkout that is still there
 * with its index missing is *not* touched — that row describes a real
 * tree and `resolveStatus` already marks it stale, which is a rebuild
 * away rather than a lie.
 *
 * Baseline rows (`itemId` null) are skipped: nothing writes one yet,
 * and one would describe the repository rather than a worktree, so a
 * missing checkout says nothing about it.
 */
export function forgetIndexesForReleasedWorktrees(db: Db, worktreeRoot?: string): string[] {
  // Keyed as a plain string: a workspace's own id is branded and a
  // row's `workspace_id` is not, and the lookup is the same string
  // either way.
  const roots = new Map<string, string | undefined>(
    allWorktreeConfigs(db, worktreeRoot).map(({ workspace, config }) => [workspace.id as string, config.worktreeRoot]),
  );
  const forgotten: string[] = [];

  for (const row of listRepositoryIndexes(db)) {
    if (row.itemId === null) continue;
    const item = getItem(db, row.itemId as Uuid);
    // A row for a workspace EO no longer configures, or an item it no
    // longer has: neither can be checked against a path, so neither is
    // deleted on the strength of a guess.
    if (!item || !roots.has(row.workspaceId)) continue;

    if (existsSync(worktreePathFor(item.key, roots.get(row.workspaceId)))) continue;
    if (deleteRepositoryIndexesForItem(db, item.id) > 0) forgotten.push(item.key);
  }

  return forgotten;
}

export type ReleaseOutcome =
  | { released: true }
  | { released: false; reason: string }
  /** No workspace configured, or nothing to release — not a failure worth reporting. */
  | { released: false };

/**
 * Releases one item's worktree, keeping its branch.
 *
 * Called when an item reaches a terminal state (G-03). Until this
 * existed, cleanup only ran at startup, so a session that finished
 * twenty items held twenty checkouts until the user happened to
 * relaunch.
 *
 * Never forces. A terminal item whose tree still has uncommitted
 * changes is the interesting case, not the routine one — something was
 * written and never committed — and the tree is the only copy.
 */
export async function releaseWorktreeFor(db: Db, item: Item, worktreeRoot?: string): Promise<ReleaseOutcome> {
  const config = worktreeConfigFor(db, item.workspaceId, worktreeRoot);
  if (!config) return { released: false };
  const itemKey = item.key;

  const removed = await releaseWorktree(db, config, itemKey, { deleteBranch: false });
  return removed.ok ? { released: true } : { released: false, reason: removed.reason };
}

/** A worktree the cleanup tried to release and could not, and what stopped it. */
export interface FailedWorktreeRelease {
  itemKey: string;
  reason: string;
}

export interface WorktreeCleanupSummary {
  removed: string[];
  /** Left in place because they hold uncommitted work — reported, never destroyed (G-01). */
  keptWithChanges: string[];
  /**
   * Tried, and could not be released: the checkout is still on disk and
   * nobody has said anything about what is in it (issue #131).
   *
   * A separate bucket rather than a second meaning for
   * `keptWithChanges`, because the two have different remedies — one is
   * "go and look at the work", the other is "the removal itself needs
   * fixing", and a Windows path-length failure announced as unsaved
   * work sends the reader somewhere there is nothing to find.
   */
  removalFailed: FailedWorktreeRelease[];
}

/**
 * Whether this checkout belongs to an item that is still on its way
 * through a pipeline (EO-177).
 *
 * The thing "no active run" was standing in for and is not. E-04 asked
 * for stale worktrees to be released at boot, and at boot the two really
 * did coincide: nothing had been dispatched yet, so a checkout with no
 * run behind it was a crashed run's leavings. Neither is true of the
 * other moment this now runs at — `reconcile()` fires on engine resume as
 * well as on app start, and an item parked between the implementer and
 * the reviewer has no active run and is indistinguishable from a
 * crashed one. Pausing mid-item and pressing Resume therefore tore
 * down a live item's checkout, and with it the index record that
 * `releaseWorktree` correctly forgets when a checkout genuinely goes.
 *
 * So the test is the item's own position rather than the runs beside
 * it. An item sitting on a non-terminal step is going to be dispatched
 * again into the same checkout; releasing it buys some disk back for as
 * long as it takes the next tick to recreate it, and costs a rebuild.
 * A finished item, an archived one — which is finished by definition,
 * KAN-33 archives nothing else — and a key with no item behind it are
 * all still taken.
 *
 * A step id EO cannot resolve counts as still going, which is the
 * conservative reading: somebody edited the pipeline under an item, and
 * that is not evidence the work is over.
 */
export function stillOnItsWay(db: Db, itemKey: string): boolean {
  const item = getItemByKey(db, itemKey);
  // No item: deleted, or a checkout for something EO never knew about.
  // Nothing is going to be dispatched into it.
  if (!item || item.stepId === null) return false;
  const step = stepForItem(db, item);
  return step === undefined || !step.isTerminal;
}

/**
 * Releases worktrees whose item has finished — E-04's "then release
 * stale git worktrees", which that story deferred because G-01 hadn't
 * landed.
 *
 * Deliberately never forces: a stale worktree with uncommitted changes
 * is a crashed run's unsaved work, and boot-time cleanup is the worst
 * possible moment to discard it silently. Those are reported for a human
 * to deal with instead.
 *
 * A removal that *failed* is reported too, and separately: it is a
 * checkout still sitting on disk for a reason nobody has dealt with,
 * which is not the same news as work waiting to be looked at.
 *
 * A checkout skipped because its item is still moving is not reported
 * at all, and that is not invariant #8 being ducked: nothing was
 * dropped on the floor. The work is exactly where it was, in the
 * checkout it will be dispatched into next, and a line per live item
 * per resume would be a log of everything that did not happen.
 */
export async function releaseStaleWorktrees(
  db: Db,
  hasActiveRun: (itemKey: string) => boolean,
  worktreeRoot?: string,
): Promise<WorktreeCleanupSummary> {
  const summary: WorktreeCleanupSummary = { removed: [], keptWithChanges: [], removalFailed: [] };
  const prefix = await branchPrefix(db);

  // Every workspace, not the active one: a checkout left behind in a repo
  // the user isn't currently looking at is exactly the one nobody will
  // notice (D-04).
  for (const { config } of allWorktreeConfigs(db, worktreeRoot)) {
    const stale = await listStaleWorktrees(config, hasActiveRun, prefix);
    if (!stale.ok) continue;

    for (const entry of stale.value) {
      // Never a live item's checkout, however quiet its runs are right
      // now (EO-177).
      if (stillOnItsWay(db, entry.itemKey)) continue;

      const removed = await releaseWorktree(db, config, entry.itemKey, { deleteBranch: false });
      if (removed.ok) summary.removed.push(entry.itemKey);
      // Which refusal it was, taken from the removal rather than
      // guessed: only the deliberate one means there is work in there to
      // go and look at.
      else if (removed.refusal === "uncommitted-changes") summary.keptWithChanges.push(entry.itemKey);
      else summary.removalFailed.push({ itemKey: entry.itemKey, reason: removed.reason });
    }
  }

  return summary;
}
