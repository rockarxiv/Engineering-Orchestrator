import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  gitStateOf,
  WAITING_RESULT,
  WATCH_PULL_REQUEST_ACTION,
  WATCH_PULL_REQUEST_READY_WHEN,
  WATCH_PULL_REQUEST_READY_WHEN_INPUT,
  WATCH_PULL_REQUEST_REPORT_READY_INPUT,
  REPLY_ON_PULL_REQUEST_ACTION,
  type WatchPullRequestReadyWhen,
  type BuiltinAction,
  type BuiltinResult,
  type Item,
} from "@eo/core";
import type { Db } from "../../db/client.js";
import { getGitWorkspace, listCommentsForItem, listRunsForItem, postComment, updateRun } from "../../db/repos/index.js";
import { watchStayOf } from "../../db/repos/itemWatchesRepo.js";
import type { BuiltinContext, BuiltinRunner } from "../../supervisor/builtins.js";
import { currentWatch, hasQuietCheck } from "../../supervisor/watches.js";
import { createCliRunner, type CliRunner } from "./forge/cli.js";
import { openPullRequestForItem, type OpenForItemOptions, type ItemPullRequestOutcome } from "./forge/openForItem.js";
import { postReplies, repliesOwed, unsettledReplies, type ReplyProgress } from "./forge/replyOnPullRequest.js";
import { judgePullRequest, legacyReadyCommit, parsePullRequestUrl, readPullRequest, readyNewsId } from "./forge/watchPullRequest.js";
import { fallbackRepositoryIntelligenceRoot, repositoryIntelligenceFor, sayable, type RepositoryIntelligenceFactory } from "./repositoryIntelligence/index.js";

/**
 * The functions a `builtin` step runs (ARCHITECTURE.md, "A step").
 *
 * Two of these were side effects before they were steps. The worktree was
 * cut inside dispatch, so an item whose branch was being prepared looked
 * exactly like an item nothing was happening to; the pull request hung off
 * an `opens_pull_request` flag on a terminal state, which meant it could
 * not take time, could not be watched, and had nowhere to go when it
 * failed. As steps they get a run each — an elapsed time, a status, and a
 * declared result that routes.
 *
 * A refusal is a result too, since EO-77. `{ ok: false }` is still the
 * shape a runner reports one in — it carries a reason, and sometimes the
 * answers EO would accept, which a bare result key cannot — but the
 * supervisor now maps it onto the declared `failed` result when the
 * pipeline routes that. Nothing here decides where a failure goes any
 * more than it decides where a success does.
 *
 * Deliberately not agents. There is no judgement in `git worktree add`,
 * and paying a model to make one would add a way for it to go wrong
 * without adding anything that could go right.
 *
 * The five of them are the developer pack's, and only the five: what
 * a builtin *is* — the context it is handed and the outcome it returns
 * — stayed in `supervisor/builtins.ts`, where the supervisor and the
 * module host can be typed on it without importing a pack (KAN-144).
 */


/**
 * Cuts the branch and worktree the later steps work in.
 *
 * Calls the same `prepareWorkspace` a dispatch does, which is idempotent —
 * an existing worktree is reused. That is what makes this step safe to
 * remove from a pipeline: the work still happens at dispatch, it just
 * stops being visible.
 *
 * The signal goes with it. Cutting a branch is local and quick; deciding
 * what to cut it *from* is not — it fetches the base branch and may ask a
 * forge about every same-feature dependency — so a cancel that did not
 * reach this left git and `gh` running behind a run the board had already
 * called cancelled.
 */
const createWorktree: BuiltinRunner<BuiltinResult<"create_worktree">> = async ({ item, prepareWorkspace, report, signal }) => {
  const prepared = await prepareWorkspace(item, "create_worktree", { onProgress: report, ...(signal ? { signal } : {}) });
  if (!prepared.ok) return { ok: false, reason: prepared.reason, ...(prepared.options ? { options: prepared.options } : {}) };
  return { ok: true, result: "ready", detail: `Worktree ready at ${prepared.workspace.cwd}` };
};

/**
 * Opens the pull request for work that has one to open.
 *
 * Opens it, rather than queueing it (EO-77). This enqueued on the forge
 * outbox until the queue was examined and found to be a leftover: the
 * pull request predates the step, and when it was a flag on
 * `transitionItem` a queue was the only place that could hold a retry.
 * A step has a run, and a run can take time, be watched, and report what
 * happened — so the send belongs in it. Reporting `opened` for something
 * only queued was the concrete cost: the item routed on, the run went
 * green, and a forge that refused the credentials said so half an hour
 * later in a comment attached to no run.
 *
 * `skipped` is the same set of conditions it always was — a feature, no
 * branch, no forge configured — and saying it out loud remains the
 * improvement over an item that simply never got a pull request.
 * `failed` is new, and is everything else: the forge said no, and the
 * pipeline decides where that goes.
 *
 * `uncommitted_changes` and `remote_diverged` are the two things the
 * step finds and leaves for the implementer (EO-429). They are results,
 * not refusals, so nothing here comments on them — the step posts its
 * own engine note before returning either, which is what invariant #8
 * asks of a result the supervisor deliberately says nothing about.
 */
function createOpenPullRequest(open: OpenForItem, worktreeRoot?: string): BuiltinRunner<BuiltinResult<"open_pull_request">> {
  return async ({ db, item, report, signal }) => {
    const outcome = await open(db, item, {
      onProgress: report,
      ...(worktreeRoot ? { worktreeRoot } : {}),
      ...(signal ? { signal } : {}),
    });
    if (outcome.kind === "failed") return { ok: false, reason: outcome.reason, ...(outcome.options ? { options: outcome.options } : {}) };
    return { ok: true, result: outcome.kind, detail: outcome.detail };
  };
}

/**
 * What this step says when a provider's reason was not a sentence at all.
 *
 * The bounding rule itself lives in `repositoryIntelligence/sayable.ts`,
 * shared with the dispatch notice that says an agent is going without —
 * one rule written twice is one rule that will be edited once. What is
 * *not* shared is this fallback, because the two are telling somebody
 * different things: here a build was attempted and produced nothing
 * readable, there an agent is running without an index it was promised.
 */
const UNREADABLE_REASON = "The repository index could not be built, and the tool's account of why was not a sentence EO could repeat.";

/**
 * Describes the checkout, so the agents that follow can query it rather
 * than rediscover it (EO-149).
 *
 * A step for the reason the other two are: before this, indexing would
 * have been a hidden pause during dispatch, and an item whose worktree
 * was being walked would have looked exactly like one where nothing was
 * happening. As a step it has a card, an elapsed time, a run row, a
 * transcript, somewhere to fail — and, because a pipeline is data, a
 * person who does not want it can delete the row (invariant #7).
 *
 * **Nothing here blocks the item.** Every way this can go wrong ends
 * in `{ ok: false }`, which the shipped pipeline routes straight on to
 * the implementer with an engine comment saying what is missing. That
 * is the whole degradation promise (EO-141): an agent without an index
 * is an agent with the filesystem and git tools it has always had, and
 * repository intelligence that could stop work would be worse than
 * none. The one thing a failure must not do is pass silently, which is
 * why it is a refusal rather than a result — a refusal is what the
 * supervisor comments on (invariant #8).
 *
 * **Fresh per worktree, never restored from a snapshot.** The index
 * stores absolute paths, so a copy taken from somewhere else would
 * describe a tree that is not there: syncing it would re-extract every
 * file and leave the originals behind as stale duplicates. Building it
 * from nothing costs seconds of CPU and makes two items indexing at
 * once isolated by construction rather than by anything this file has
 * to arrange.
 */
function createIndexRepository(intelligence: RepositoryIntelligenceFactory): BuiltinRunner<BuiltinResult<"index_repository">> {
  return async ({ db, item, prepareWorkspace, report, signal }) => {
    // The gate first, before anything else is touched. With the feature
    // off this must cost exactly nothing — no binary fetched, no
    // workspace prepared, no row written — which is the rollout promise
    // `repositoryIntelligence/flagOff.test.ts` pins (EO-148).
    const runtime = intelligence({ db, ...(signal ? { signal } : {}), onProgress: report });
    if (runtime === null) return { ok: true, result: "skipped", detail: "Repository intelligence is off, so nothing was indexed." };

    // A feature carries no workspace, and `repository_indexes` is keyed
    // on one. Skipped rather than failed: there is no checkout to
    // describe, which is a fact about the item rather than something
    // that went wrong.
    if (item.workspaceId === null) {
      return { ok: true, result: "skipped", detail: "This ticket has no repository, so there was nothing to index." };
    }

    // The same idempotent preparation `create_worktree` does, so this
    // step still works in a pipeline somebody has removed that one from.
    const prepared = await prepareWorkspace(item, "index_repository", { onProgress: report, ...(signal ? { signal } : {}) });
    if (!prepared.ok) return { ok: false, reason: prepared.reason, ...(prepared.options ? { options: prepared.options } : {}) };

    const target = { workspaceId: item.workspaceId, itemId: item.id, workspacePath: prepared.workspace.cwd };

    const installed = await runtime.ensureInstalled();
    if (!installed.ok) {
      // Recorded before routing on, and this is the one place a failure
      // has to be written down by hand: no build was attempted, so
      // `ensureIndexed` never runs and nothing else would leave a row.
      // Without it an unsupported platform reads as "not indexed"
      // forever, on every repository, with the only account of why
      // being a comment on whichever item happened to come through.
      await runtime.service.recordUnavailable(target, installed.reason);
      return { ok: false, reason: sayable(installed.reason, UNREADABLE_REASON) };
    }

    report(`Indexing ${prepared.workspace.cwd}.`);
    const outcome = await runtime.service.ensureIndexed(target);
    // The service has already written `failed` and the reason onto the
    // row; this is the same sentence on its way to a comment.
    if (!outcome.ok) return { ok: false, reason: sayable(outcome.reason, UNREADABLE_REASON) };

    // Deliberately the row's own fields rather than anything the tool
    // printed. Nothing this step writes to a run event or a comment is
    // derived from an indexer's stdout, because a tool that quotes the
    // line it choked on must not be able to put somebody's source in a
    // transcript.
    const at = outcome.index.indexedCommitSha === null ? "" : ` at ${outcome.index.indexedCommitSha.slice(0, 12)}`;
    return { ok: true, result: "indexed", detail: `Indexed ${prepared.workspace.cwd}${at}.` };
  };
}

/**
 * The news ids this item's earlier pull-request checks reported, on every
 * stay on the step (EO-460).
 *
 * Read off the runs rather than the watch row, because the watch row is
 * one stay's: an item sent back to be fixed comes back to a fresh watch
 * with nothing posted, and without this its first check would post every
 * review comment on the pull request again — and answer
 * `changes_requested` again for a request the fix has not been reviewed
 * against yet, sending the work straight back. Every check that reported
 * news made a run, and the run holds what the check answered, news and
 * all, so the runs are the item's whole account of what it was told.
 *
 * `ready` is among them but does not outlast its stay, because its id
 * names the stay (`readyNewsId`): an earlier stay's is simply not the id
 * this stay's check looks for.
 *
 * A run from before ids named the stay holds `ready:<sha>`, so a ticket
 * parked on one when EO updated is placed here, or a reply would answer it
 * twice. On this stay it counts as this stay's id; on an earlier one it
 * counts for nothing, or the ticket this story frees would stay stuck. The
 * watch row says which where there is one: it is reset on arrival and only
 * these old versions wrote such an id to it, so an id on it was written on
 * this stay. A step that runs once has no row, so there the run says: one
 * still parked on this step is the park a reply answers, and one that routed
 * or finished is not. Never by comparing a run with the arrival: their ids
 * and stamps come from two machines' clocks.
 *
 * What that cannot see is a parked ticket moved off the step and back. A
 * move leaves a parked run as it was, so the rows are the ones a ticket
 * moved first and parked after would have, and it hears `waiting`, which on
 * such a step parks with a comment saying what to do.
 */
function reportedNewsIds(db: Db, item: Item, stay: string): Set<string> {
  const watch = item.stepId === null ? undefined : currentWatch(db, item, item.stepId);
  const ids = new Set<string>();
  for (const run of listRunsForItem(db, item.id)) {
    if (run.action !== WATCH_PULL_REQUEST_ACTION || run.result === null) continue;
    const raw = run.result["raw"];
    if (typeof raw !== "object" || raw === null || !("news" in raw) || !Array.isArray(raw.news)) continue;
    for (const entry of raw.news as unknown[]) {
      if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") continue;
      ids.add(entry.id);
      const commit = legacyReadyCommit(entry.id);
      const parkedHere = run.status === "awaiting_input" && run.stepId === item.stepId;
      if (commit !== null && (watch === undefined ? parkedHere : watch.postedNewsIds.includes(entry.id))) ids.add(readyNewsId(commit, stay));
    }
  }
  return ids;
}

/**
 * The pull request comments and requests for changes this item's earlier
 * checks handed on — acted on, or handed to planning — on every stay
 * (EO-759).
 *
 * Read off the runs for `reportedNewsIds`' reason, from the `handled` each
 * check's outcome carries. Not from its news: a comment posted as news
 * beside a failed check has been seen and nothing more, and is still owed
 * the answer that sends it somewhere.
 *
 * A run from before checks recorded what they handed on has no `handled`,
 * and every id of its news counts. Those versions answered nothing for a
 * comment, so a comment they reported was all EO was ever going to do with
 * it, and a request for changes they reported was answered. Without this,
 * every ticket watched across the update would hear every old comment on
 * its pull request as new.
 */
function handledIds(db: Db, item: Item): Set<string> {
  const ids = new Set<string>();
  for (const run of listRunsForItem(db, item.id)) {
    if (run.action !== WATCH_PULL_REQUEST_ACTION || run.result === null) continue;
    const raw = run.result["raw"];
    if (typeof raw !== "object" || raw === null) continue;
    const recorded = "handled" in raw && Array.isArray(raw.handled) ? (raw.handled as unknown[]) : "news" in raw && Array.isArray(raw.news) ? (raw.news as unknown[]).map((entry) => (typeof entry === "object" && entry !== null && "id" in entry ? entry.id : null)) : [];
    for (const id of recorded) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * The comments EO posted on this item's pull request itself (EO-759): the
 * `postedCommentIds` any run of the item recorded, in `forgeCommentId`'s
 * spelling. Read from every run rather than one action's, since what posts
 * them is whichever step replies on the pull request, not the watch.
 */
function ownCommentIds(db: Db, item: Item): Set<string> {
  const ids = new Set<string>();
  for (const run of listRunsForItem(db, item.id)) {
    const raw = run.result?.["raw"];
    if (typeof raw !== "object" || raw === null || !("postedCommentIds" in raw) || !Array.isArray(raw.postedCommentIds)) continue;
    for (const id of raw.postedCommentIds as unknown[]) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * Whether an earlier check on this stay had an answer from the forge
 * (EO-620).
 *
 * Read off what an answer leaves, because a check the forge never answered
 * saw nothing, so the one after it is still the first look. Every judged
 * answer names its stay on its run, and a quiet one, which has no run of its
 * own, is on the stay's quiet run. Nothing else will do. A watch row's counts
 * include failed checks, and a reply clears the failures they would be told
 * apart by. A run's status says no more, because a failed call parks exactly
 * as a `waiting` answer does, and a parked run outlives a hand move off the
 * step and back.
 *
 * On a record shared between devices a run can arrive after the watch row,
 * and then this is one more first look rather than a check skipped.
 */
function checkedThisStay(db: Db, item: Item, stay: string): boolean {
  if (hasQuietCheck(db, item.id, stay)) return true;
  return listRunsForItem(db, item.id).some((run) => {
    const raw = run.result?.["raw"];
    return run.action === WATCH_PULL_REQUEST_ACTION && typeof raw === "object" && raw !== null && "stay" in raw && raw.stay === stay;
  });
}

/** Whether the step asked to hear `ready`. A switch in the editor is a boolean; a value typed into a field is the word. */
function reportsReady(inputs: BuiltinContext["inputs"]): boolean {
  const value = inputs?.[WATCH_PULL_REQUEST_REPORT_READY_INPUT];
  return value === true || value === "true";
}

/**
 * What the step counts as ready (EO-515): `approved` when it does not say,
 * and null for a value that is neither — a typo of `mergeable` read as the
 * default would wait for an approval nobody is going to give, and say
 * nothing about why.
 */
function readyWhen(inputs: BuiltinContext["inputs"]): WatchPullRequestReadyWhen | null {
  const value = inputs?.[WATCH_PULL_REQUEST_READY_WHEN_INPUT];
  if (value === undefined || value === null || value === "") return "approved";
  return WATCH_PULL_REQUEST_READY_WHEN.find((known) => known === value) ?? null;
}

/**
 * Posts an engine note naming the run — making the run's row first, since
 * a check has none until it has something to record — unless the newest
 * comment on the item already says exactly this. A forge CLI that is not
 * installed is still not installed five minutes later, and the backoff
 * asks again up to six times before it escalates; once is enough to say so.
 */
function noteOnce({ db, item, runId, ensureRun }: BuiltinContext, body: string): void {
  if (listCommentsForItem(db, item.id).at(-1)?.body === body) return;
  ensureRun?.();
  // What the forge's CLI printed can hold anything, an at-name included.
  postComment(db, { itemId: item.id, runId, author: { type: "engine" }, kind: "note", body, parseBodyMentions: false });
}

/**
 * Watches the ticket's pull request (EO-460).
 *
 * A check, made for a step that keeps checking: each call asks the forge
 * once, through the same `gh` or `glab` the pull request was opened with,
 * and answers `waiting` or one of its results — in the order
 * `judgePullRequest` documents — with news of failed checks, comments and
 * a conflict, and the comments and requests for changes the answer hands
 * on (`handledIds`).
 *
 * Three of the ways it can go wrong are answers rather than failures, and
 * two are failures. No pull request recorded on the ticket, one whose
 * address EO cannot read, or a `readyWhen` input it does not know, is
 * `failed` with a note: nothing a retry could change. A CLI that is not installed or not signed in is a failed check,
 * with a note saying which — the watch's backoff asks again, and after six
 * in a row it escalates, which is the point: somebody signing in should
 * not have to move the ticket back to get it watched. Anything else the
 * forge says is a failed check with no note, since a forge that is briefly
 * unreachable is what the backoff is for.
 */
function createWatchPullRequest(run: CliRunner): BuiltinRunner<BuiltinResult<"watch_pull_request"> | typeof WAITING_RESULT> {
  return async (context) => {
    const { db, item, signal } = context;
    const { pullRequest } = gitStateOf(item);
    const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);

    if (!pullRequest) {
      const reason = `${item.key} has no pull request recorded, so there is nothing for "${WATCH_PULL_REQUEST_ACTION}" to watch. Open one first — the step that opens pull requests records it here — or move this ticket on yourself.`;
      noteOnce(context, reason);
      return { ok: true, result: "failed", detail: reason };
    }

    const when = readyWhen(context.inputs);
    if (when === null) {
      const said = context.inputs?.[WATCH_PULL_REQUEST_READY_WHEN_INPUT];
      const reason = `This step's "${WATCH_PULL_REQUEST_READY_WHEN_INPUT}" input is ${JSON.stringify(said)}, which "${WATCH_PULL_REQUEST_ACTION}" does not know. Set it to ${WATCH_PULL_REQUEST_READY_WHEN.map((known) => `"${known}"`).join(" or ")}, or leave it unset for "approved".`;
      noteOnce(context, reason);
      return { ok: true, result: "failed", detail: reason };
    }

    const address = parsePullRequestUrl(pullRequest, workspace?.config.forgeKind ?? null);
    if (address === null) {
      const reason = `EO cannot tell which pull request ${pullRequest} is: it is not a GitHub pull request or a GitLab merge request address, so "${WATCH_PULL_REQUEST_ACTION}" has nothing it can ask the forge about.`;
      noteOnce(context, reason);
      return { ok: true, result: "failed", detail: reason };
    }

    // The repository when it is there, for whatever the CLI reads from a
    // checkout; anywhere else when it is not, because a missing directory
    // fails the spawn the same way a missing binary does.
    const repoPath = workspace?.config.repoPath;
    const cwd = repoPath !== undefined && existsSync(repoPath) ? repoPath : tmpdir();
    const reading = await readPullRequest({ address, url: pullRequest, run, cwd, ...(signal ? { signal } : {}) });
    if (!reading.ok) {
      if (reading.problem !== "error") noteOnce(context, `"${WATCH_PULL_REQUEST_ACTION}" could not check ${pullRequest}. ${reading.reason}`);
      return { ok: false, reason: reading.reason };
    }

    const stay = watchStayOf(db, item);
    const judged = judgePullRequest(reading.snapshot, {
      reportReady: reportsReady(context.inputs),
      readyWhen: when,
      stay,
      checkedThisStay: checkedThisStay(db, item, stay),
      reported: reportedNewsIds(db, item, stay),
      // The row rather than each run's `stay`: it is reset on arrival, so it
      // holds this stay's news alone, including on a run from before runs
      // named their stay.
      reportedThisStay: new Set(item.stepId === null ? [] : currentWatch(db, item, item.stepId)?.postedNewsIds),
      handled: handledIds(db, item),
      ownComments: ownCommentIds(db, item),
    });
    // `handled` even when it is empty: a run that has it is one whose news
    // is not to be taken for handled (`handledIds`).
    return { ok: true, result: judged.result, detail: judged.detail, stay, handled: judged.handled, ...(judged.news.length > 0 ? { news: judged.news } : {}) };
  };
}

/**
 * Replies on the pull request to every comment EO handled and has not
 * replied to yet (EO-761), run after the branch is pushed.
 *
 * What is owed, and what each reply says, is `repliesOwed`'s reading of the
 * runs; nothing is asked of the forge when nothing is owed, which on a
 * ticket's first pass is always. Every comment posted is recorded on the run
 * as `postedCommentIds`, which the watch skips — the replies are under the
 * account it takes for the person — and every comment answered as
 * `repliedTo`, so running it again posts nothing twice.
 *
 * Recorded as it goes, not only at the end: before each post the run's
 * result names the reply in flight as `pending`, and after it the comment
 * posted. A run EO stops in the middle of — a restart, a crash, a cancel —
 * keeps on its row what it posted, and a reply in flight when it stopped is
 * looked for on the forge by its mark before the next run posts it again.
 *
 * A refusal is `failed` with a note naming what was refused, answered as a
 * result rather than a failed run so that what was posted before it is still
 * recorded: a reply left off the record would come back as the person's.
 */
function createReplyOnPullRequest(run: CliRunner): BuiltinRunner<BuiltinResult<"reply_on_pull_request">> {
  return async ({ db, item, runId, report, signal, ensureRun }) => {
    const owed = repliesOwed(db, item.id);
    const unsettled = unsettledReplies(db, item.id);
    if (owed.length === 0 && unsettled.length === 0) return { ok: true, result: "nothing_to_reply", detail: "No pull request comment was handled since EO last replied, so there was nothing to reply to." };

    let progress: ReplyProgress = { postedCommentIds: [], repliedTo: [], pending: [] };
    const fail = (reason: string) => {
      const posted = progress.postedCommentIds.length;
      const stands = posted === 0 ? "" : ` The ${posted} repl${posted === 1 ? "y" : "ies"} posted before it stand${posted === 1 ? "s" : ""} and will not be posted again.`;
      postComment(db, { itemId: item.id, runId, author: { type: "engine" }, kind: "note", body: `"${REPLY_ON_PULL_REQUEST_ACTION}" could not reply on the pull request. ${reason}${stands}`, parseBodyMentions: false });
      return { ok: true as const, result: "failed" as const, detail: reason, ...progress };
    };
    const { pullRequest } = gitStateOf(item);
    const workspace = item.workspaceId === null ? undefined : getGitWorkspace(db, item.workspaceId);
    if (!pullRequest) return fail(`${item.key} has no pull request recorded, so there is nowhere to reply to the ${owed.length} comment${owed.length === 1 ? "" : "s"} EO handled.`);
    const address = parsePullRequestUrl(pullRequest, workspace?.config.forgeKind ?? null);
    if (address === null) return fail(`EO cannot tell which pull request ${pullRequest} is: it is not a GitHub pull request or a GitLab merge request address.`);

    const repoPath = workspace?.config.repoPath;
    const cwd = repoPath !== undefined && existsSync(repoPath) ? repoPath : tmpdir();
    const record = (now: ReplyProgress): void => {
      progress = now;
      ensureRun?.();
      updateRun(db, runId, { result: { raw: now, parsed: null } });
    };
    try {
      const outcome = await postReplies({ address, url: pullRequest, owed, unsettled, ownComments: ownCommentIds(db, item), run, cwd, report, record, ...(signal ? { signal } : {}) });
      progress = outcome.progress;
      if (!outcome.ok) return fail(outcome.refused);
      const posted = outcome.progress.postedCommentIds.length - outcome.found;
      const found = outcome.found === 0 ? [] : [`Found ${outcome.found} repl${outcome.found === 1 ? "y" : "ies"} on ${pullRequest} that EO posted before without recording, and recorded ${outcome.found === 1 ? "it" : "them"} rather than post again.`];
      const replied = posted === 0 ? [] : [`Replied to ${posted} comment${posted === 1 ? "" : "s"} on ${pullRequest}.`];
      if (outcome.progress.postedCommentIds.length === 0) return { ok: true, result: "nothing_to_reply", detail: "Every reply owed is already on the pull request.", ...outcome.progress };
      return { ok: true, result: "replied", detail: [...replied, ...found].join(" "), ...outcome.progress };
    } catch (error) {
      // Thrown rather than answered, it would be stored as a failed run
      // whose result is the error alone, and what was posted would be off
      // the record.
      return fail(error instanceof Error ? error.message : String(error));
    }
  };
}

/**
 * Every shipped builtin, typed by what `BUILTIN_RESULTS` declares it returns.
 *
 * The mapped type is the whole point (EO-77): `ready`, `opened` and
 * `skipped` used to be literals here and nowhere else, so nothing stopped
 * one of them drifting from what the editor offered and the validator
 * checked. Now the declaration in `packages/core` is where an outcome
 * comes into existence, and a runner that reports one that is not in it
 * fails to compile.
 */
export type BuiltinRunners = { [A in BuiltinAction]: BuiltinRunner<BuiltinResult<A> | (A extends WatchingBuiltin ? typeof WAITING_RESULT : never)> };

/** The builtins made to be checked, which may also answer `waiting` (`BUILTIN_WATCH`). */
type WatchingBuiltin = typeof WATCH_PULL_REQUEST_ACTION;

/**
 * The one seam through which a builtin reaches the forge.
 *
 * Injected rather than imported so a test can prove what the *step* does
 * with an outcome without standing up a repository, a remote and a
 * recorded CLI to produce one. The end-to-end path has its own tests
 * beside `openForItem.ts`, where the repository is real.
 */
export type OpenForItem = (db: Db, item: Item, options?: OpenForItemOptions) => Promise<ItemPullRequestOutcome>;

/**
 * Where a fetched index binary is cached when nobody said otherwise.
 *
 * Production passes `userData`, and a test or the v1 gate that passes
 * nothing still gets somewhere outside every worktree. It is never
 * reached with the feature off either, because the factory reads the
 * gate before it looks at a path.
 *
 * The same function `createEngine` falls back to, rather than the same
 * path written out twice, which is what this was (EO-157). Its own
 * comment beside `intelligenceFor` has the argument: a second copy
 * pointed somewhere else would have the step that builds an index and
 * the dispatch that hands one to an agent disagree about which index
 * exists. Two copies that happen to agree are that defect waiting for
 * somebody to edit one of them.
 */
const defaultIntelligence: RepositoryIntelligenceFactory = (options) =>
  repositoryIntelligenceFor({ ...options, root: fallbackRepositoryIntelligenceRoot() });

/**
 * `worktreeRoot` travels the same way it does everywhere else it is
 * overridable: not because production has anything but `~/.eo`, but so
 * that an engine told to keep its worktrees elsewhere is telling the
 * send that too. The rebase before a pull request reads it to know
 * which checkout of the branch is EO's own (EO-156), and a send that
 * looked at the real `~/.eo` while the rest of the engine worked
 * somewhere else would answer that question wrongly.
 */
export function createBuiltinRunners(
  open: OpenForItem = openPullRequestForItem,
  worktreeRoot?: string,
  intelligence: RepositoryIntelligenceFactory = defaultIntelligence,
  forge: CliRunner = createCliRunner(),
): BuiltinRunners {
  return {
    create_worktree: createWorktree,
    index_repository: createIndexRepository(intelligence),
    open_pull_request: createOpenPullRequest(open, worktreeRoot),
    watch_pull_request: createWatchPullRequest(forge),
    reply_on_pull_request: createReplyOnPullRequest(forge),
  };
}

export const BUILTIN_RUNNERS: BuiltinRunners = createBuiltinRunners();
