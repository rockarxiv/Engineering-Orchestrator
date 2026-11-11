import { existsSync } from "node:fs";
import { effectiveReviewers, gitStateOf, jiraStateOf, REVIEWERS_FROM_REPOSITORY, type Item, type ItemReviewers, type Uuid } from "@eo/core";
import { dependencyClosure } from "@eo/engine";
import type { StackDependency, StackTargetDecision } from "../workspace/stackDecision.js";
import type { Db } from "../../../db/client.js";
import {
  getGitWorkspace,
  getItem,
  jiraBaseUrlFor,
  listAllDependencies,
  listDependencies,
  listRunsForItem,
  postComment,
  updateItem,
  enqueueOutbox,
  type GitWorkspace,
} from "../../../db/repos/index.js";
import { withoutRepositoryIndex } from "../repositoryIntelligence/index.js";
import { branchExists, commitsAhead, pushBranch, rebaseOntoBase, statusPorcelain } from "../workspace/git.js";
import { resolveStackTargetWithAnswer } from "../workspace/stackAnswer.js";
import { baseRefFor } from "../workspace/stackTarget.js";
import { worktreePathFor } from "../workspace/worktrees.js";
import { itemBranchName, workNameFor } from "../workspace/workName.js";
import type { PullRequestFacts } from "./body.js";
import { createCliRunner, type CliRunner } from "./cli.js";
import { classifyForgeError } from "./errors.js";
import { forgePullRequestState, resolveMergeState } from "./mergeState.js";
import { openPullRequest, type ReviewerRequest } from "./openPullRequest.js";

/**
 * Opening one item's pull request, inline, as the `open_pull_request`
 * builtin runs (EO-77).
 *
 * This used to be an outbox sender. The queue was not a decision anyone
 * made for the step: in F-06 the pull request hung off a flag on
 * `transitionItem`, which is a side effect of a state write and so
 * could not take time, be watched, or report a failure — the outbox was
 * the only place retry and ordering could live. When the flag became a
 * `builtin` step it acquired a run that can do all three, and the enqueue
 * was carried across unexamined. The result was a step that reported
 * `opened` a millisecond after being asked, having opened nothing: the
 * item routed on, the run went green, and the send could still fail
 * half an hour later into a comment attached to no run at all.
 *
 * So the work happens here, in the run, and the result the step reports
 * is the one that actually happened. What the outbox was genuinely
 * buying — a few retries on a failure that is nobody's fault — is the
 * loop at the bottom of this file. What it was not buying is the
 * duplicate guard: that is three independent checks (the pull request
 * recorded on the item here, the same re-read per attempt, and asking
 * the forge itself inside `openPullRequest`), none of which depended on
 * the queue.
 */

export type ItemPullRequestOutcome =
  /** One is open — freshly created, adopted, or already recorded. */
  | { kind: "opened"; detail: string }
  /** Nothing to open, and that is not a failure: a feature, no branch, no forge. */
  | { kind: "skipped"; detail: string }
  /**
   * The ticket's worktree holds files nobody committed, so nothing was
   * pushed and nothing opened (EO-429). The engine note naming them is
   * already on the ticket by the time this is returned.
   */
  | { kind: "uncommitted_changes"; detail: string }
  /**
   * The remote branch holds commits the local one does not, and EO did
   * not force-push over them (EO-429). A result rather than a failure
   * because it is expected — verification rebases the branch after every
   * implement run — and because the implementer can resolve it. Never
   * returned for a branch a person named, which stays `failed`.
   */
  | { kind: "remote_diverged"; detail: string }
  /**
   * It did not open. `options` are the answers EO would accept when the
   * failure is a question it is asking — a tied stack target, say — which
   * the supervisor turns into the buttons on its comment.
   */
  | { kind: "failed"; reason: string; options?: string[] };

/**
 * How many times one run will try, and how long it waits between.
 *
 * Three attempts a few seconds apart, not the outbox's six across half an
 * hour. The difference is that this holds the dispatch slot while it
 * runs — concurrency is 1 (invariant #10) — so the bound has to be
 * something a person waiting on the board would accept. Every call
 * underneath is separately timed out (120s on the push, 120s on the CLI),
 * which is what keeps the worst case finite rather than merely unlikely.
 *
 * Only a failure `classifyForgeError` could not name is retried. A
 * missing `gh`, a refused credential and a non-fast-forward push are
 * final on the first try — waiting five seconds does not install a
 * binary.
 */
const RETRY_DELAYS_MS = [2_000, 5_000];

/**
 * How long the whole thing may take, attempts included.
 *
 * The delays above are seconds; the attempts are not, and it is the
 * attempts that matter. One of them is `O(dependencies)` network calls —
 * a forge lookup and a fetch per same-feature dependency, a fetch for the
 * base ref, then push, find, create, find — each with its own 120s
 * ceiling. Three dependencies is twenty minutes for a *single* attempt,
 * and this holds the one dispatch slot there is (invariant #10). The
 * outbox never had that problem, because it never blocked anything;
 * that is the one thing it was genuinely buying, and this is the price
 * of the trade.
 *
 * So it is a real deadline rather than a check between attempts:
 * everything underneath is given a signal that fires at it, which is why
 * the number can be believed. Aborting mid-flight is safe here — a
 * `git push` moves the remote ref as its last act, so a killed one leaves
 * the remote exactly as it was, and a killed `create` is covered by the
 * same read-back that already stops a crash opening two.
 */
const RETRY_DEADLINE_MS = 3 * 60_000;

export interface OpenForItemOptions {
  run?: CliRunner;
  /**
   * Where `~/.eo/worktrees/<KEY>` lives, when it is not there.
   *
   * Read twice: by the check for uncommitted files, which looks in the
   * ticket's own worktree (EO-429), and by the rebase, to work out which
   * checkout of this branch is EO's own — the one place a rebase may
   * happen while the branch is checked out (EO-156).
   * Overridable for the same reason the engine's is: so a test does not
   * have to point at the real `~/.eo` to be honest about where the
   * item's worktree is.
   */
  worktreeRoot?: string;
  /**
   * Where each step of the send says what it did, for the transcript.
   *
   * The retry loop is the reason this matters most: two failed attempts
   * and a third that worked used to leave nothing behind but a green
   * run, so a pull request that took forty seconds and a pull request
   * that took one looked identical.
   */
  onProgress?: (text: string) => void;
  /** Aborted when a person cancels the run, or EO shuts down. */
  signal?: AbortSignal;
  /** Injectable so a test does not spend seven seconds proving it waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  delaysMs?: readonly number[];
  deadlineMs?: number;
  /** Injectable for the same reason `sleep` is: a test must not wait out a real clock. */
  clock?: () => number;
}

/** Waits, unless the run is cancelled first — a backoff is not a reason to ignore a person. */
const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Opens `item`'s pull request, retrying only what is worth retrying.
 *
 * The item is re-read on every attempt rather than reused: an attempt
 * can adopt a pull request the forge already had, and the next one must
 * see that rather than open a second.
 */
export async function openPullRequestForItem(db: Db, item: Item, options: OpenForItemOptions = {}): Promise<ItemPullRequestOutcome> {
  const run = options.run ?? createCliRunner();
  const sleep = options.sleep ?? wait;
  const clock = options.clock ?? Date.now;
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const deadlineMs = options.deadlineMs ?? RETRY_DEADLINE_MS;
  const deadline = clock() + deadlineMs;

  // The deadline as something the work can actually feel. `expiry` is
  // kept apart from the combined signal so the two ways this can stop —
  // a person cancelling, and time running out — can still be told apart
  // when reporting why.
  const expiry = AbortSignal.timeout(deadlineMs);
  const signal = options.signal ? AbortSignal.any([options.signal, expiry]) : expiry;
  const attemptOptions: OpenForItemOptions = { ...options, signal };

  const stopped = (): ItemPullRequestOutcome | null => {
    if (options.signal?.aborted) return { kind: "failed", reason: "The run was cancelled before the pull request could be opened." };
    if (expiry.aborted) {
      return {
        kind: "failed",
        reason: `The forge did not finish answering within ${Math.round(deadlineMs / 1000)}s, so EO stopped rather than hold the board any longer.`,
      };
    }
    return null;
  };

  for (let attempt = 0; ; attempt += 1) {
    const halted = stopped();
    if (halted) return halted;

    const current = getItem(db, item.id) ?? item;
    const outcome = await attemptOnce(db, current, run, attemptOptions);
    if (outcome.kind !== "retryable") return outcome;

    // Asked again after the attempt, because the attempt is where the
    // time goes: a single one can outlast the deadline on its own, and
    // whatever it returned once aborted is not a verdict about the forge.
    const halting = stopped();
    if (halting) return halting;

    const delay = delays[attempt];
    if (delay === undefined) {
      // Out of attempts. Reported as the failure it is rather than left
      // hanging: the step has a result for this, and a person reading the
      // item learns what the forge actually said.
      return { kind: "failed", reason: `${outcome.reason}\n\nEO tried ${delays.length + 1} times.` };
    }
    if (clock() >= deadline) {
      options.onProgress?.(`Giving up after ${attempt + 1} attempts — this has already taken longer than one step should hold the board.`);
      // Out of time rather than out of attempts, which is a different
      // thing to be told: the forge is not refusing, it is not answering.
      return { kind: "failed", reason: `${outcome.reason}\n\nEO stopped retrying after ${Math.round(deadlineMs / 1000)}s.` };
    }
    options.onProgress?.(`Attempt ${attempt + 1} failed with something worth trying again, so waiting ${Math.round(delay / 1000)}s: ${outcome.reason}`);
    await sleep(delay, signal);
  }
}

/** One attempt. `retryable` is the only outcome the caller loops on. */
type Attempt = ItemPullRequestOutcome | { kind: "retryable"; reason: string };

async function attemptOnce(db: Db, item: Item, run: CliRunner, options: OpenForItemOptions): Promise<Attempt> {
  const { onProgress } = options;
  // A container carries no code changes of its own (EO-9/EO-7); the work
  // under it does. A pull request for one is always doomed — and the
  // type's flag is what says which it is, so a project whose container is
  // an Epic is skipped for the same reason without this file learning the
  // word (KAN-146).
  if (item.container) return { kind: "skipped", detail: `${item.key} holds work rather than carrying changes of its own, so there is nothing to open a pull request for.` };
  if (!item.workspaceId) return { kind: "skipped", detail: "This ticket has no repository." };
  // The branch and the pull request are the git kind's state on the item
  // since KAN-169, read here rather than off the row.
  const { branch, pullRequest } = gitStateOf(item);
  if (!branch) return { kind: "skipped", detail: "This ticket has no branch, so there is nothing to open a pull request from." };

  // Already open. This is what makes review ping-pong open exactly one:
  // the item passes through here again and says so — after the two
  // things below, since EO-429: a ticket sent back for more work comes
  // through with commits the forge has never seen. Recorded is not the
  // same as open, though, once a pipeline loops back here after a merge
  // (EO-445) — which the forge is asked about below.
  const alreadyOpen: Attempt | null = pullRequest ? { kind: "opened", detail: `Already open: ${pullRequest}` } : null;

  // A repository, specifically: opening a pull request is the git
  // kind's, and an item on a folder workspace never reaches this
  // builtin (EO-299).
  const workspace = getGitWorkspace(db, item.workspaceId);
  // Neither of the two cases below looks at the worktree or pushes, so a
  // ticket whose pull request is already recorded says what it always
  // said in them: a repository that has stopped opening pull requests
  // must not start being pushed to because one was opened before.
  if (alreadyOpen && (!workspace || !workspace.config.forgeOpenPr)) return alreadyOpen;
  // A refusal, not a skip. `skipped` means "there is correctly nothing to
  // open here", and the shipped pipeline routes it onward to the terminal
  // step — so reporting an item whose workspace row has vanished that
  // way would finish the work, quietly, with no pull request and nothing
  // saying why. That is broken state, and broken state is `failed`.
  if (!workspace) return { kind: "failed", reason: `${item.key} points at a repository that no longer exists, so EO cannot open a pull request for it.` };
  if (!workspace.config.forgeOpenPr) return { kind: "skipped", detail: "This repository is not configured to open pull requests." };

  // 1. Nothing uncommitted. Before anything is pushed, because a push
  //    made while the tree is dirty publishes a branch that is not what
  //    the reviewer read.
  const worktreePath = worktreePathFor(item.key, options.worktreeRoot);
  const checked = await uncommittedIn(worktreePath, onProgress);
  // Could not be read is not the same as clean. A worktree that is there
  // and will not answer may be holding exactly the files this check
  // exists to find, so nothing is pushed on the strength of not knowing —
  // and it is final rather than retried, because waiting does not repair
  // a checkout.
  if (!checked.ok) {
    return {
      kind: "failed",
      reason:
        `EO could not read the status of this ticket's worktree at \`${worktreePath}\`, so it cannot tell whether anything there is uncommitted. ` +
        `Nothing was pushed and no pull request was opened or updated.\n\n${checked.error}\n\n` +
        `Run \`git status\` in that directory and repair what it reports — or, if nothing in it is worth keeping, remove the directory — and this step can run again.`,
    };
  }
  const uncommitted = checked.paths;
  if (uncommitted.length > 0) {
    postComment(db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: uncommittedNote(branch, uncommitted) });
    return {
      kind: "uncommitted_changes",
      detail: `${uncommitted.length} uncommitted ${uncommitted.length === 1 ? "path" : "paths"} in the worktree, so nothing was pushed.`,
    };
  }

  // 2. Push, on every pass — including this one, where the pull request
  //    is already recorded and pushing is all there is to do. Unless the
  //    forge says the recorded one has merged or closed and the branch has
  //    carried on past it (EO-445): then it is a new pull request that is
  //    owed, not a push to one nobody will read again.
  if (alreadyOpen && pullRequest) {
    const ended = await recordedPullRequestEnded(db, workspace, item, branch, pullRequest, run, options);
    if (ended.kind === "still_open") return pushAlreadyOpen(db, workspace, item, branch, alreadyOpen, run, options);
    if (ended.kind === "settled") return ended.outcome;
    if (ended.kind === "replaced") {
      // Recorded before the push rather than after: which pull request
      // carries the branch is true whatever the push does, and a pass
      // that comes back after a diverged push must read the new one.
      options.onProgress?.(`${pullRequest} is no longer the open one: the forge has ${ended.url} open for "${branch}", so EO records that instead.`);
      recordPullRequest(db, workspace, item, ended.url, [`${item.key} already had a pull request open: ${ended.url}. It replaces ${pullRequest}.`]);
      const adopted: Attempt = { kind: "opened", detail: `Adopted the pull request already open: ${ended.url}` };
      return pushAlreadyOpen(db, workspace, item, branch, adopted, run, options);
    }
    return openNew(db, workspace, item, branch, run, options, ended.target);
  }

  return openNew(db, workspace, item, branch, run, options);
}

/**
 * Opens the pull request — the path a ticket takes when none is recorded,
 * and when the recorded one has merged or closed with work left on the
 * branch since (EO-445).
 *
 * `ended` is the send target already resolved for that second case, and
 * its presence is what says only an open pull request may be adopted: the
 * forge's lookup lists every state, and the merged one is not the answer.
 */
async function openNew(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  branch: string,
  run: CliRunner,
  options: OpenForItemOptions,
  ended?: OpenTarget,
): Promise<Attempt> {
  const { signal, onProgress } = options;

  // Re-resolved now, not reused from whenever the worktree was cut or an
  // earlier run last checked: a same-feature dependency can merge while
  // this item sits in review, after which no further "implement" run
  // ever touches it, and this is the last moment before the pull request
  // opens that anything will (EO-10 / KAN-42).
  onProgress?.(`Opening a pull request for "${branch}" on ${workspace.config.name}.`);

  const target = ended ?? (await resolveSendTarget(db, workspace, item, run, signal));
  if (target.kind === "escalate") {
    return { kind: "failed", reason: target.reason, ...(target.options ? { options: target.options } : {}) };
  }

  // Onto the *remote* base branch, not the local one: the pull request is
  // about to be judged against what the forge has, so rebasing onto a
  // local `main` that is behind would replay the branch onto a base that
  // no longer exists upstream — and the conflicts it did or did not hit
  // would say nothing about the merge that matters.
  onProgress?.(`It will open against "${target.baseBranch}".`);

  if (target.rebase) {
    onProgress?.(`A dependency has merged since this branch was cut, so it is being rebased onto ${target.baseRef} first.`);
    // Which checkout of this branch EO is allowed to rebase in: its own
    // worktree for this item, whether or not it still exists. Anything
    // else holding the branch is refused rather than rewritten (EO-156).
    const rebased = await rebaseOntoBase(workspace.config.repoPath, branch, target.baseRef, {
      worktreePath: worktreePathFor(item.key, options.worktreeRoot),
      ...(signal ? { signal } : {}),
    });
    if (!rebased.ok) {
      return { kind: "failed", reason: `EO could not rebase this branch onto \`${target.baseRef}\` before opening its pull request.\n\n${rebased.error}` };
    }
  }

  const reviewers = pullRequestReviewers(db, item, workspace);
  const result = await openPullRequest({
    repoPath: workspace.config.repoPath,
    branch,
    baseBranch: target.baseBranch,
    baseRef: target.baseRef,
    remote: workspace.config.forgeRemote,
    forgeKind: workspace.config.forgeKind,
    draft: workspace.config.forgeDraft,
    templatePath: workspace.config.forgeTemplatePath,
    agentBody: reviewerBody(db, item.id),
    implementSummary: implementSummary(db, item.id),
    itemBody: item.body,
    facts: factsFor(db, item.id, target.baseBranch),
    run,
    ...(signal ? { signal } : {}),
    ...(ended ? { onlyAdoptOpen: true } : {}),
    reviewers: reviewers.value,
  });

  if (!result.ok) {
    // The default in `classifyForgeError` is retryable, deliberately —
    // classifying a CLI's stderr is a heuristic, and the two mistakes are
    // not equal. Here the cost of being wrong is smaller than it was in
    // the outbox: a retry is seconds away rather than half an hour, and
    // whichever way it ends the step reports it.
    if (result.diverged && !gitStateOf(item).namedBranch) return diverged(db, item, workspace.config.forgeRemote, branch, target.baseRef);
    return result.final ? { kind: "failed", reason: result.error } : { kind: "retryable", reason: result.error };
  }

  onProgress?.(result.adopted ? `The forge already had one open: ${result.url}` : `Created ${result.url}`);

  const remarks = [result.adopted ? `${item.key} already had a pull request open: ${result.url}` : `Opened ${result.url}`];
  if (result.fallbackBody) {
    remarks.push("The description was not written by an agent — EO used the repository's template, or the implementer's summary, as it found them.");
  }
  if (result.ambiguousTemplates) {
    remarks.push(
      `The repository has several templates and none is a default, so none was used: ${result.ambiguousTemplates.join(", ")}. Name one in Settings → Forge to pick.`,
    );
  }
  recordPullRequest(db, workspace, item, result.url, remarks);
  if (result.reviewers) reportReviewers(db, item, result.reviewers, reviewers, onProgress);

  return { kind: "opened", detail: result.adopted ? `Adopted the pull request already open: ${result.url}` : `Opened ${result.url}` };
}

/**
 * Who is asked to review the pull request `item` opens, and where the
 * list came from (EO-741, EO-742): the item's own, else its feature's,
 * else the repository's default — `effectiveReviewers`, which the item
 * page, `item_get` and a module's `git.pullRequestReviewers` read too.
 */
export function pullRequestReviewers(db: Db, item: Item, workspace: GitWorkspace): ItemReviewers {
  const parent = item.parentId === null ? undefined : getItem(db, item.parentId);
  return effectiveReviewers(item, parent, workspace.config.forgeReviewers);
}

/** Where a person corrects the list a refused reviewer came from. */
function whereReviewersAreSet(item: Item, reviewers: ItemReviewers): string {
  if (reviewers.inheritedFrom === REVIEWERS_FROM_REPOSITORY) return "correct the repository's default reviewers in Settings";
  if (reviewers.inheritedFrom === null) return `correct the reviewers set on ${item.key}`;
  return `correct the reviewers set on ${reviewers.inheritedFrom}`;
}

/**
 * What came of asking for reviewers: a transcript line for whoever was
 * asked and for an author left out — a forge will not have them review
 * their own, so that is not something to tell anybody about — and one
 * comment naming every reviewer the forge refused, with what it said.
 * The pull request is open either way, so none of it is a failure.
 */
function reportReviewers(db: Db, item: Item, outcome: ReviewerRequest, asked: ItemReviewers, onProgress?: (text: string) => void): void {
  if (outcome.author !== null) {
    onProgress?.(`Left ${outcome.author} out of the reviewers: they opened the pull request, and a forge does not let its author review it.`);
  }
  if (outcome.requested.length > 0) onProgress?.(`Asked for review from ${outcome.requested.join(", ")}.`);
  if (outcome.refused.length === 0) return;

  onProgress?.(`The forge refused ${outcome.refused.length === 1 ? "a reviewer" : "some reviewers"}: ${outcome.refused.map((refusal) => refusal.reviewer).join(", ")}.`);
  const listed = outcome.refused.map((refusal) => `- \`${refusal.reviewer}\`: ${refusal.reason.replace(/\s*\n\s*/g, " ")}`);
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    body: [
      `The pull request is open, but EO could not ask ${outcome.refused.length === 1 ? "this reviewer" : "these reviewers"} to review it:`,
      listed.join("\n"),
      `Ask them on the forge, or ${whereReviewersAreSet(item, asked)}.`,
    ].join("\n\n"),
  });
}

/**
 * Makes `url` the ticket's pull request: recorded on the item, said in
 * the thread with `remarks`, and passed on to the mirrored Jira issue.
 * Shared by opening one and by adopting the open one the forge has in
 * place of a recorded one that merged or closed (EO-445).
 */
function recordPullRequest(db: Db, workspace: GitWorkspace, item: Item, url: string | null, remarks: string[]): void {
  updateItem(db, item.id, { git: { pullRequest: url } });
  postComment(db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: remarks.join("\n\n") });

  // The mirrored issue should carry the link too. Queued rather than
  // sent, so a Jira that is down cannot make this look like a failure.
  // The engine note above goes in the EO thread regardless; this is
  // only the Jira half, and the sync switch decides it (EO-122).
  const jira = jiraStateOf(item);
  if (jira.key && jira.sync && url) {
    enqueueOutbox(db, {
      itemId: item.id,
      workspaceId: workspace.id,
      channel: "jira",
      kind: "comment",
      payload: { authorType: "engine", body: `Pull request: ${url}` },
    });
  }
}

/** How many paths one note lists before it says how many more there are. */
const LISTED_PATHS = 50;

/**
 * What `git status --porcelain` reports in the ticket's worktree, one
 * line per entry — modified, staged and untracked, and nothing git
 * ignores. Empty means there is nothing to commit.
 *
 * A worktree that is not there has nothing in it to lose, which is the
 * ordinary case for a ticket whose checkout was released. That is said
 * in the transcript and is the **only** case the check is skipped in.
 *
 * A worktree that is there and that git cannot read is the opposite
 * case and is reported as such: `ok: false` is "nobody knows", which
 * the caller must not treat as "nothing there". An earlier cut of this
 * returned an empty list for it, and so pushed a branch on the strength
 * of a check that had not run.
 */
async function uncommittedIn(
  worktreePath: string,
  onProgress?: (text: string) => void,
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  if (!existsSync(worktreePath)) {
    onProgress?.(`There is no worktree at ${worktreePath}, so there is nothing to check for uncommitted files.`);
    return { ok: true, paths: [] };
  }
  const status = await statusPorcelain(worktreePath);
  if (!status.ok) {
    onProgress?.(`Could not read the status of ${worktreePath}, so nothing will be pushed: ${status.error}`);
    return { ok: false, error: status.error };
  }
  // EO's generated index is its own output, not the ticket's work —
  // stepped over here exactly as verification steps over it.
  const left = withoutRepositoryIndex(status.stdout);
  if (left === "") {
    onProgress?.("The worktree has nothing uncommitted.");
    return { ok: true, paths: [] };
  }
  onProgress?.(`The worktree has uncommitted changes, so nothing will be pushed:\n${left}`);
  return { ok: true, paths: left.split("\n").map(pathOf) };
}

/**
 * The path on one porcelain line: two status columns and a space, then
 * the path. A rename keeps its `old -> new`, which names both halves of
 * what has to be committed.
 *
 * The third character is checked rather than assumed, because `git()`
 * trims what it returns: when the first line's first column is blank —
 * ` M outbox.ts`, the commonest line there is — its leading space is
 * gone by the time it arrives here, and cutting three characters off
 * names a file called `utbox.ts`.
 */
function pathOf(line: string): string {
  return line[2] === " " ? line.slice(3) : line.slice(2);
}

function uncommittedNote(branch: string, paths: string[]): string {
  const listed = paths.slice(0, LISTED_PATHS).map((path) => `- \`${path}\``);
  if (paths.length > LISTED_PATHS) listed.push(`- … and ${paths.length - LISTED_PATHS} more`);
  return [
    `This ticket's worktree has uncommitted changes, so EO did not push \`${branch}\` or open a pull request for it.`,
    listed.join("\n"),
    "Each of these must be committed or removed before the pull request step can run.",
  ].join("\n\n");
}

/**
 * The pass through here after the pull request is open: push, and say
 * what was already true.
 *
 * Straight to `pushBranch` rather than through `openPullRequest`, whose
 * other seven steps are all about creating one. The send target is
 * resolved only if the push turns out to have diverged, because that is
 * the only time anything here needs to name the base — the ordinary
 * pass is one forge lookup (asked first, by `recordedPullRequestEnded`,
 * since EO-445) and one git command.
 */
async function pushAlreadyOpen(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  branch: string,
  alreadyOpen: Attempt,
  run: CliRunner,
  options: OpenForItemOptions,
): Promise<Attempt> {
  const { signal, onProgress } = options;
  const { repoPath, forgeRemote: remote } = workspace.config;

  // A branch that is gone has nothing to publish. Not a failure: the
  // pull request is the record of it, and that is still open.
  if (!(await branchExists(repoPath, branch))) {
    onProgress?.(`The branch "${branch}" no longer exists locally, so there is nothing to push.`);
    return alreadyOpen;
  }

  onProgress?.(`The pull request is already open, so pushing "${branch}" to ${remote}.`);
  const pushed = await pushBranch(repoPath, remote, branch, signal ? { signal } : {});
  if (pushed.ok) return alreadyOpen;

  const classified = classifyForgeError(pushed.error);
  if (classified.diverged && !gitStateOf(item).namedBranch) {
    const target = await resolveSendTarget(db, workspace, item, run, signal);
    if (target.kind === "escalate") {
      return { kind: "failed", reason: target.reason, ...(target.options ? { options: target.options } : {}) };
    }
    return diverged(db, item, remote, branch, target.baseRef);
  }
  return classified.final ? { kind: "failed", reason: classified.message } : { kind: "retryable", reason: classified.message };
}

type RecordedPullRequest =
  /** Open, or the forge could not say: the pass through here is what it always was. */
  | { kind: "still_open" }
  /**
   * The forge has a different pull request open for the branch — one EO
   * created and did not get to record, or one a person opened. That one
   * is adopted rather than a third opened beside it.
   */
  | { kind: "replaced"; url: string }
  /** Merged or closed, with commits the base lacks: a new one is opened against `target`. */
  | { kind: "ended"; target: OpenTarget }
  /** Nothing further to decide — an escalation, a failure, or nothing new to open for. */
  | { kind: "settled"; outcome: Attempt };

/**
 * Whether the pull request recorded on the ticket is still the one the
 * branch's work goes through (EO-445).
 *
 * Nothing returns to this step after a merge in Delivery, so for a long
 * time "recorded" was as good as "open". A pipeline that loops — Release's
 * fix round, which comes back through here after its first pull request
 * merged — breaks that: answering "already open" for a merged pull request
 * pushes commits to a branch no pull request will carry, and the merge
 * step behind this one reads the merged state and calls it done.
 *
 * So the forge is asked. An open answer naming a different pull request
 * than the recorded one is adopted in its place. An open answer naming
 * the recorded one, or none at all — a missing CLI,
 * a refused credential, a branch the forge has no pull request for — keeps
 * the pass exactly as it was: not knowing is not a reason to open a second
 * one. A merged or closed answer opens a new one, unless the branch holds
 * nothing its base lacks — an empty pull request looks like work, so that
 * pass answers as it always did.
 */
async function recordedPullRequestEnded(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  branch: string,
  pullRequest: string,
  run: CliRunner,
  options: OpenForItemOptions,
): Promise<RecordedPullRequest> {
  const { signal, onProgress } = options;
  const { repoPath, forgeRemote: remote, forgeKind } = workspace.config;

  // A branch that is gone has nothing to open a pull request from either;
  // the push path below says so as it always has.
  if (!(await branchExists(repoPath, branch))) return { kind: "still_open" };

  const forge = await forgePullRequestState({ repoPath, branch, remote, forgeKind, run, ...(signal ? { signal } : {}) });
  if (!forge) {
    onProgress?.(`The forge did not say whether ${pullRequest} is still open, so it is treated as open.`);
    return { kind: "still_open" };
  }
  if (forge.state === "open") return sameUrl(forge.url, pullRequest) ? { kind: "still_open" } : { kind: "replaced", url: forge.url };

  const target = await resolveSendTarget(db, workspace, item, run, signal);
  if (target.kind === "escalate") {
    return { kind: "settled", outcome: { kind: "failed", reason: target.reason, ...(target.options ? { options: target.options } : {}) } };
  }

  const ahead = await commitsAhead(repoPath, target.baseRef, branch);
  if (!ahead.ok) {
    return {
      kind: "settled",
      outcome: {
        kind: "retryable",
        reason: `${pullRequest} is ${forge.state}, and EO could not count what \`${branch}\` has beyond \`${target.baseRef}\`, so it did not open another: ${ahead.error}`,
      },
    };
  }
  if (ahead.count === 0) {
    onProgress?.(`${pullRequest} is ${forge.state}, and "${branch}" has nothing ${target.baseRef} lacks, so there is no new pull request to open.`);
    const alreadyOpen: Attempt = { kind: "opened", detail: `Already open: ${pullRequest}` };
    return { kind: "settled", outcome: await pushAlreadyOpen(db, workspace, item, branch, alreadyOpen, run, options) };
  }

  onProgress?.(
    `${pullRequest} is ${forge.state}, and "${branch}" has ${ahead.count} ${ahead.count === 1 ? "commit" : "commits"} ${target.baseRef} lacks, so a new pull request is being opened.`,
  );
  return { kind: "ended", target };
}

/** The same pull request, whatever a trailing slash or letter case says. */
function sameUrl(a: string, b: string): boolean {
  const normal = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  return normal(a) === normal(b);
}

/**
 * The remote branch has commits the local one does not, on a branch EO
 * cut. Said on the ticket, because a successful builtin result posts
 * nothing of its own and the implementer this routes to reads the
 * thread (invariant #8) — with the three names it would otherwise have
 * to work out.
 */
function diverged(db: Db, item: Item, remote: string, branch: string, baseRef: string): Attempt {
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "note",
    body: [
      `The remote branch has diverged: \`${branch}\` on \`${remote}\` holds commits the local branch does not, so the push was rejected. EO did not force-push.`,
      [`- Remote: \`${remote}\``, `- Branch: \`${branch}\``, `- Base ref the pull request targets: \`${baseRef}\``].join("\n"),
      "Nothing was pushed and no pull request was opened or updated. The local branch has to be reconciled with the remote one before this step can run again.",
    ].join("\n\n"),
  });
  return { kind: "remote_diverged", detail: `\`${branch}\` has diverged from \`${remote}/${branch}\`, and EO did not force-push.` };
}

/** The reviewer's prose, from the approval that opened this pull request. */
function reviewerBody(db: Db, itemId: Uuid): string | null {
  const review = latestSucceeded(db, itemId, "review");
  const parsed = parsedOf(review?.result);
  const body = parsed?.["pull_request_body"];
  return typeof body === "string" && body.trim() !== "" ? body : null;
}

function implementSummary(db: Db, itemId: Uuid): string | null {
  const parsed = parsedOf(latestSucceeded(db, itemId, "implement")?.result);
  const summary = parsed?.["summary"];
  return typeof summary === "string" && summary.trim() !== "" ? summary : null;
}

/**
 * What EO signs its name to.
 *
 * The checks come from `runs.verification` — what G-02 actually ran —
 * and never from `ImplementOutput.tests_run`, which is the implementer's
 * word for it. Invariant #5 is precisely this difference, and a pull
 * request that repeats a claim as though it were a check is how the
 * claim comes to be worth nothing.
 *
 * `baseBranch` is the caller's already-resolved send target — the
 * dependency's branch when stacked, the workspace's base branch
 * otherwise — so the pull request's own body says where it actually
 * points rather than always naming the workspace's base branch.
 */
function factsFor(db: Db, itemId: Uuid, baseBranch: string): PullRequestFacts {
  const item = getItem(db, itemId)!;
  const verification = latestSucceeded(db, itemId, "implement")?.verification as { steps?: { name?: string; ok?: boolean }[] } | null | undefined;
  // The site comes from the project's Jira binding (KAN-130): the eight
  // `jira*` columns that used to sit on the repository are one binding
  // per project now, so the item's project is what the link is built
  // from rather than the workspace it happens to be worked in.
  const jiraBase = jiraBaseUrlFor(db, item.projectId);
  const issueKey = jiraStateOf(item).key;

  const criteria = item.spec?.["acceptance_criteria"];
  // Read when the pull request is opened, and only then: one already
  // open keeps the title and description it was opened with (EO-638).
  const name = workNameFor(db, item);

  return {
    itemKey: item.key,
    itemTitle: item.title,
    branch: gitStateOf(item).branch ?? "",
    baseBranch,
    acceptanceCriteria: Array.isArray(criteria) ? criteria.filter((entry): entry is string => typeof entry === "string") : [],
    checks: (verification?.steps ?? [])
      .filter((step) => typeof step.name === "string")
      .map((step) => ({ name: step.name!, passed: step.ok === true })),
    jiraKey: issueKey,
    jiraUrl: issueKey && jiraBase ? `${jiraBase}/browse/${issueKey}` : null,
    reference: name.kind === "reference" ? name.value : null,
  };
}

function latestSucceeded(db: Db, itemId: Uuid, action: string) {
  return listRunsForItem(db, itemId)
    .filter((run) => run.action === action && run.status === "succeeded")
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id))[0];
}

function parsedOf(result: unknown): Record<string, unknown> | null {
  if (typeof result !== "object" || result === null) return null;
  const parsed = (result as { parsed?: unknown }).parsed;
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

interface OpenTarget {
  kind: "open";
  /** The branch name the forge opens against. */
  baseBranch: string;
  /** The same thing as a local ref — `origin/main` — for everything git is asked. */
  baseRef: string;
  rebase: boolean;
}

type SendTarget = OpenTarget | { kind: "escalate"; reason: string; options?: string[] };

/**
 * The stacking decision for `item`'s pull request, and the same-feature
 * dependencies it was made from — the half of `resolveSendTarget` that
 * says *which branch*, without the refs and the escalation wording that
 * opening one also needs.
 *
 * Shared with `pullRequestTargetBranch`, which is what a module reads as
 * `ctx.item().git.targetBranch` (EO-709): the branch a module is told the
 * pull request goes into must be the branch this builtin would open it
 * against, and two copies of this choice would be two answers.
 */
async function stackDecisionFor(
  db: Db,
  workspace: GitWorkspace,
  item: Item,
  run: CliRunner,
  signal?: AbortSignal,
): Promise<{ decision: StackTargetDecision; sameFeature: StackDependency[] }> {
  const edges = listAllDependencies(db);
  const sameFeature: StackDependency[] = [];
  // A base a person set on the ticket is the target whatever its
  // dependencies say (EO-364), so there is nothing to ask the forge about
  // them. The resolver below still decides — it is what knows the set
  // base wins — from an empty list.
  //
  // A branch a person named is not stacked on anything either (EO-365):
  // it was never cut from a dependency, so it opens against the base set
  // on the ticket or the repository's base, and with no same-feature
  // dependency in the list the resolver never asks for a rebase.
  const { baseBranch, namedBranch } = gitStateOf(item);
  const named = baseBranch !== null || namedBranch;
  for (const edge of named ? [] : listDependencies(db, item.id)) {
    const dependency = getItem(db, edge.dependsOnId);
    if (!dependency || dependency.parentId === null || dependency.parentId !== item.parentId) continue;

    const dependencyBranch = gitStateOf(dependency).branch;
    const mergeState = dependencyBranch
      ? await resolveMergeState({
          repoPath: workspace.config.repoPath,
          branch: dependencyBranch,
          baseBranch: workspace.config.baseBranch,
          remote: workspace.config.forgeRemote,
          forgeKind: workspace.config.forgeKind,
          run,
          ...(signal ? { signal } : {}),
        })
      : "open";
    sameFeature.push({ item: dependency, branch: await itemBranchName(db, dependency), mergeState, dependsOn: [...dependencyClosure(edges, dependency.id)] });
  }

  const decision = await resolveStackTargetWithAnswer(db, item, sameFeature, workspace.config.repoPath);
  return { decision, sameFeature };
}

/**
 * The branch `item`'s pull request is, or will be, opened against, or
 * null where there is none to name (EO-709): no git workspace, or a
 * stacking question EO would ask a person rather than answer.
 *
 * The item's own base branch where one is set, the branch of the
 * same-feature dependency it stacks on, or the repository's base branch
 * — decided by `stackDecisionFor`, the code `open_pull_request` opens
 * with. Asks the forge about each unmerged same-feature dependency, as
 * opening does; an item with none asks it nothing.
 */
export async function pullRequestTargetBranch(db: Db, item: Item, options: { run?: CliRunner; signal?: AbortSignal } = {}): Promise<string | null> {
  const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);
  if (!workspace) return null;
  const { decision } = await stackDecisionFor(db, workspace, item, options.run ?? createCliRunner(), options.signal);
  if (decision.kind === "escalate") return null;
  if (decision.kind === "branch" || decision.kind === "named-base") return decision.branch;
  if (decision.kind === "stack") {
    const { branch } = gitStateOf(decision.dependency);
    return branch;
  }
  return workspace.config.baseBranch;
}

/**
 * Where this send should open its pull request against, resolved fresh
 * on every call (EO-10 / KAN-42's "target decision, at MR-open time").
 *
 * Only `item`'s direct dependencies that share its non-null parent
 * feature matter to `resolveStackTarget`; merge state is fetched only
 * for those, both to avoid pointless forge/git calls for out-of-scope
 * dependencies and because a dependency without a recorded branch yet is
 * unambiguously not merged.
 */
async function resolveSendTarget(db: Db, workspace: GitWorkspace, item: Item, run: CliRunner, signal?: AbortSignal): Promise<SendTarget> {
  const { decision, sameFeature } = await stackDecisionFor(db, workspace, item, run, signal);
  const { namedBranch } = gitStateOf(item);

  if (decision.kind === "escalate") {
    const options = decision.choices.map((choice) => choice.key);
    return { kind: "escalate", reason: decision.reason, ...(options.length > 0 ? { options } : {}) };
  }

  // Resolved once for the whole send: the ref everything git is asked
  // here works from — the rebase, the "is this branch actually ahead"
  // check, and the pull request template — while the forge is told the
  // branch *name* below, which is the only thing it would accept.
  const baseRef = await baseRefFor(decision, workspace, undefined, signal ? { signal } : {});
  if (!baseRef.ok) return { kind: "escalate", reason: baseRef.reason };

  // A branch a person named when EO asked which dependency to stack on:
  // their answer is the base, exactly as a dependency's branch would be.
  // A base they set on the ticket is the same thing said earlier
  // (EO-364, the pinned decision on EO-363): opened against it, and not
  // rebased first — the branch was cut from it, and EO never rewrites a
  // branch's history onto somewhere a person did not ask for.
  if (decision.kind === "branch" || decision.kind === "named-base") {
    return { kind: "open", baseBranch: decision.branch, baseRef: baseRef.value, rebase: false };
  }

  if (decision.kind === "stack") {
    const stackedOn = gitStateOf(decision.dependency).branch;
    if (!stackedOn) {
      return {
        kind: "escalate",
        reason: `${decision.dependency.key} has no branch recorded, so EO cannot stack ${item.key} on it.`,
      };
    }
    return { kind: "open", baseBranch: stackedOn, baseRef: baseRef.value, rebase: false };
  }

  // decision.kind === "base": stacking no longer applies. If there was
  // ever a same-feature dependency in the picture, it can only have
  // gotten here by having merged — the branch may still hold its
  // pre-merge (possibly squash-rewritten) commits, so it is rebased onto
  // the current base branch before the push. No same-feature dependency
  // at all means nothing could have been stacked, so nothing to rebase —
  // exactly today's behaviour.
  //
  // Never a branch a person named (EO-365), whatever the list held.
  return { kind: "open", baseBranch: workspace.config.baseBranch, baseRef: baseRef.value, rebase: sameFeature.length > 0 && !namedBranch };
}
