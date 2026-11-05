import { existsSync } from "node:fs";
import type { IpcPayload, IpcResponse, RepositoryIndex, RepositoryIndexView, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getRepositoryIndexById, getItem, listActiveRuns, listGitWorkspaces, listRepositoryIndexes, postComment } from "../db/repos/index.js";
import {
  readRepositoryIntelligenceConfig,
  repositoryIntelligenceFor,
  type RepositoryIndexOutcome,
  type RepositoryIndexTarget,
  type RepositoryIntelligenceFactory,
  type RepositoryIntelligenceRuntime,
} from "../packs/developer/repositoryIntelligence/index.js";
import { allWorktreeConfigs } from "../packs/developer/workspace/dispatchWorkspace.js";
import { worktreePathFor } from "../packs/developer/workspace/worktrees.js";
import { createItemLock, type ItemHold, type ItemLock } from "../supervisor/itemLock.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * Repository intelligence, as a person meets it (EO-154).
 *
 * The subsystem has been able to index, sync and rebuild since EO-146;
 * what it has not had is a way for the person whose machine it runs on
 * to see whether it worked and put it right when it did not. Until this
 * file, a corrupted index meant opening a terminal and deleting a
 * directory by hand, and a machine that could not index at all said
 * nothing anywhere a person would look.
 *
 * A read and three operations, and the division between them is the
 * design. The read is EO's own notes and asks the implementation
 * nothing: a settings screen that probed on every render would make
 * opening Settings cost what a dispatch costs, and it would do it once
 * per index. It rides on the configuration channels rather than one of
 * its own, because the switch and what it produced are one section and
 * because a person's *operations* on an index are three — building,
 * refreshing and starting again — and looking at one is not a fourth.
 *
 * The three go straight to the service — `ensureIndexed`, `sync` and
 * `rebuild` — and nothing else does; see the contract for what is
 * deliberately not offered and why.
 *
 * **Nothing in this file names an implementation, and no caller can.**
 * Every operation names one row by its id; which implementation runs is
 * read from the configuration by `repositoryIntelligenceFor` at call
 * time, exactly as the engine reads it. That is what makes the promise
 * in EO-141 true where it is hardest to keep — at the one screen where
 * somebody could plausibly have been offered the choice.
 *
 * Nothing here throws for an outcome either. A missing binary, an
 * unsupported platform, a switch that is off and a build that fell over
 * all come back as `{ ok: false, problem }` and are shown in place. A
 * screen that blanked out on the failure it exists to explain would be
 * the wrong way round.
 *
 * **`problem` is always EO's own sentence, never the implementation's.**
 * This is the rule that makes the copy criterion structural rather than
 * a habit. An implementation writes its reasons in its own voice, and
 * the one EO ships names itself in a dozen of them. A channel that
 * passed those through would put that name on the status screen — the
 * one surface this whole feature promises it will never appear on. So a
 * provider's account never reaches `problem`. It is not thrown away: the service has already written it
 * to `repository_indexes.error_message`, where the debug area shows it
 * verbatim to whoever went looking. EO says what happened; the
 * implementation's own words are one disclosure away.
 */

/** What these commands need that is not in the database. */
export interface RepositoryIntelligenceContext {
  /**
   * Where a fetched binary is cached — `userData/repositoryIntelligence`
   * in production.
   *
   * The same root the engine uses, passed in from the one place that
   * computes it, so this screen cannot come to disagree with a dispatch
   * about what is installed.
   */
  root: string;
  /**
   * How a runtime is built, injected only by tests.
   *
   * Production leaves it out and gets `repositoryIntelligenceFor`, which
   * consults the switch. A test hands in its own so that the recovery
   * path can be driven against a real index on a real disk without a
   * 46 MB download — the same seam `supervisor/builtins.ts` takes for
   * the same reason.
   */
  factory?: RepositoryIntelligenceFactory;
  /** Overridable so tests do not touch the real `~/.eo`. */
  worktreeRoot?: string;
  /**
   * How a run working in a checkout is stopped, so that Rebuild can be
   * the recovery path the story says it is.
   *
   * Optional for the same reason `domainCommands` takes it optional: a
   * build with no engine has no runs for anything to collide with. Where
   * there *are* active rows and no handle to stop them, rebuild refuses
   * rather than deleting a directory something may still be holding.
   */
  engine?: EngineHandle;
  /**
   * The claim that says whether anything is working in an item's
   * checkout (EO-132).
   *
   * The engine's own when there is one, so that this screen and a
   * dispatch cannot both decide they have the worktree. `handlers.ts`
   * already builds exactly this — `engine?.itemLock ?? createItemLock()`
   * — for this reason: an IPC path that starts a process in an item's
   * worktree takes the same claim the supervisor takes.
   *
   * Defaulted rather than required so a caller that has no engine still
   * serialises its own presses against each other.
   */
  itemLock?: ItemLock;
  /**
   * How long to wait for a cancelled run to actually let go, and how
   * often to look.
   *
   * Injected so a test does not spend ten seconds proving a timeout.
   * `cancelRun` only signals — the run unwinds on its own thread — so
   * the wait is the difference between stopping a holder and racing it.
   */
  stopTimeoutMs?: number;
  stopPollMs?: number;
}

/**
 * Where the checkout an index describes lives, or null if EO cannot say.
 *
 * Computed from the item's key the way `workspace/verify.ts` computes
 * it, and deliberately *not* derived from the row's `index_path`. That
 * path belongs to the implementation — where it puts an index relative
 * to what it indexed is its business, and the port says so — so reading
 * a checkout out of it would be this file quietly learning one
 * implementation's layout and breaking on the next.
 *
 * Null has three causes and the screen treats them alike: a row for a
 * workspace EO no longer has, an item that has been deleted, and a
 * baseline row (`itemId` null) which nothing writes yet. In each case
 * there is no checkout to act on and the operations refuse rather than
 * composing a path out of what is left.
 */
function workspaceFor(db: Db, row: RepositoryIndex, worktreeRoot?: string): string | null {
  if (row.itemId === null) return null;
  const item = getItem(db, row.itemId as Uuid);
  if (!item) return null;

  const entry = allWorktreeConfigs(db, worktreeRoot).find(({ workspace }) => workspace.id === row.workspaceId);
  if (!entry) return null;

  return worktreePathFor(item.key, entry.config.worktreeRoot);
}

/**
 * The items something is actually working in right now.
 *
 * `running` only, and the exclusion is the point. `listActiveRuns` is
 * `queued` *and* `running`, but a queued run is a row saying work should
 * happen — no process, nothing in the worktree, nothing holding the
 * index. Counting one here disabled Refresh on a card whose checkout was
 * free, telling a person to wait for a run that had not started, while
 * the command behind the button would have gone ahead perfectly well.
 *
 * This is the same distinction that made Rebuild unusable, seen from the
 * screen: `claimItem` asks the item lock rather than these rows, and
 * this narrowing is what keeps the card's account and the command's
 * agreeing about the same checkout.
 */
function busyItemIds(db: Db): Set<string> {
  return new Set(listActiveRuns(db).filter((run) => run.status === "running").map((run) => run.itemId));
}

function toView(db: Db, row: RepositoryIndex, busy: Set<string>, worktreeRoot?: string): RepositoryIndexView {
  const item = row.itemId === null ? undefined : getItem(db, row.itemId as Uuid);
  return {
    ...row,
    itemKey: item?.key ?? null,
    workspacePath: workspaceFor(db, row, worktreeRoot),
    // `itemId` and not `itemKey`: a run names the item by id, and
    // a row whose item has been deleted has no key to compare.
    inUse: row.itemId !== null && busy.has(row.itemId),
  };
}

/**
 * The whole state of repository intelligence: the switch, and every
 * repository with the notes EO holds about its indexes.
 *
 * What both configuration channels answer with. The switch is re-read
 * here rather than taken as an argument, so a write and a read give the
 * same answer through the same code — `setConfig`'s reply is the stored
 * truth rather than an echo of the patch it was handed.
 *
 * Every repository, including the ones with no index at all. A screen
 * listing only what exists cannot show "this repository has never been
 * indexed", which is precisely the state a person opening this section
 * is most likely to be trying to explain.
 */
export function repositoryIntelligenceStatusCommand(db: Db, worktreeRoot?: string): IpcResponse<"repositoryIntelligence:getConfig"> {
  const busy = busyItemIds(db);
  return {
    ...readRepositoryIntelligenceConfig(db),
    // The grouping keeps the word the screen shows: a `git-worktree`
    // workspace is what the Repositories screen calls a repository, so
    // the id and the name go out under the field names the renderer has
    // always read (KAN-130).
    repositories: listGitWorkspaces(db).map((workspace) => ({
      repositoryId: workspace.id,
      repositoryName: workspace.config.name,
      indexes: listRepositoryIndexes(db, workspace.id).map((row) => toView(db, row, busy, worktreeRoot)),
    })),
  };
}

function refuse(problem: string): IpcResponse<"repositoryIntelligence:initializeRepositoryIndex"> {
  return { ok: false, index: null, problem };
}

/**
 * Where the implementation's own account of a failure can be read.
 *
 * Appended to every sentence EO substitutes for one, because a neutral
 * headline with nowhere to go from it is worse than the branded sentence
 * it replaced: it tells somebody their index is broken and then stops.
 * "Advanced" is the disclosure on the section, and it shows
 * `error_message` verbatim.
 */
const WHERE_THE_DETAIL_IS = "What the indexer said about it is on this index under Advanced.";

/**
 * What EO says when the implementation could not be run at all.
 *
 * The platform case — no build for this machine — and the one where a
 * download never arrived. Both are the implementation's sentence
 * underneath, and both are somebody else's name in it.
 */
const CANNOT_RUN = `EO could not run the indexer on this machine, so it could not touch this index. ${WHERE_THE_DETAIL_IS}`;

/** What EO says when the work started and did not finish. One per verb, because the verb is the useful part. */
const FAILED: Record<"build" | "update" | "rebuild", string> = {
  build: `EO could not build the index for this checkout. ${WHERE_THE_DETAIL_IS}`,
  update: `EO could not update the index for this checkout. ${WHERE_THE_DETAIL_IS}`,
  rebuild: `EO could not rebuild the index for this checkout. ${WHERE_THE_DETAIL_IS}`,
};

/**
 * Which indexes this process is already working on.
 *
 * The transition table refuses a second build of an index that is
 * already building, which is what protects the *directory*. This
 * protects the answer: without it, a double-click sends two calls, the
 * second is refused by the table, and the person is shown a sentence
 * about an illegal status change for having pressed a button twice. It
 * also makes the interrupted-row recovery below safe to state simply —
 * an in-flight status this process put there is not an interruption.
 */
const inFlight = new Set<string>();

/**
 * The claim used when nobody handed one in.
 *
 * Module-level rather than per-call, or it would be a fresh lock every
 * time and would exclude nothing at all. A build with no engine has no
 * scheduler to collide with; what is left to serialise is this process's
 * own presses, which this does.
 */
const fallbackLock = createItemLock();

/** How long to wait for a cancelled run to actually let go of a checkout, and how often to look. */
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_MS = 50;

/**
 * What an operation does about a run working in the checkout.
 *
 * The two answers are genuinely different operations, not a preference.
 * Refresh and Index are ordinary upkeep and can simply wait — the engine
 * syncs at its own handovers (EO-153), and two writers on one index is
 * the race `--no-watch` exists to prevent. Rebuild is the recovery path,
 * and a recovery path that a busy checkout can switch off is not one: an
 * index gets corrupted *by* a run that died badly, which is exactly when
 * a stale `running` row is most likely to be sitting in front of it.
 */
type Holders = "wait" | "stop";

/**
 * Claims the item for the duration of the work, stopping whatever
 * holds it when the caller is entitled to.
 *
 * **The lock, not the run rows, is what "something is working here"
 * means.** `itemLock` exists for exactly this and says so: the IPC
 * side starts processes in an item's worktree too, and those take the
 * same claim the supervisor's own dispatches take rather than keeping a
 * second answer of their own. Rebuilding an index spawns an indexer in
 * that worktree, so it is one of those.
 *
 * Reading `listActiveRuns` instead was wrong in a way that mattered.
 * That set is `queued` *and* `running`, but `cancelRun` only reaches a
 * run with a controller, and a queued row has none — it is a row saying
 * work *should* happen, not a process. So a queued run could not be
 * cancelled, never left the set, and Rebuild sat out its whole timeout
 * and then refused to recover a corrupted index because of a run that
 * had not started and was holding nothing.
 *
 * The lock answers both halves at once. A queued run holds no claim, so
 * the item is free and the rebuild proceeds immediately; and because
 * the rebuild now *holds* the claim, that queued run cannot be
 * dispatched underneath it. Coordinated rather than cancelled, which is
 * also the kinder answer: rebuilding an index is no reason to throw away
 * somebody's queued work.
 *
 * When the claim is taken, whoever has it is really working in the
 * checkout. Upkeep waits for them. Rebuild asks them to stop, says so on
 * the item (invariant #8 — stopping somebody's work must not be
 * silent), and then polls the claim rather than the rows, because the
 * claim is released by the run's own `finally` and is therefore the
 * moment the checkout is genuinely free. Asking again on every poll
 * closes the last gap: a dispatch that had claimed the item but not
 * yet registered its controller when EO first asked has one by the next
 * turn of the loop.
 *
 * A timeout refuses and deletes nothing. A run EO asked to stop and
 * which did not is the one case where deleting could take an index out
 * from under something still using it, and "try again" is a better
 * answer than a corrupted checkout.
 */
async function claimItem(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  itemId: string,
  holders: Holders,
): Promise<{ ok: true; release: ItemHold } | { ok: false; problem: string }> {
  const lock = ctx.itemLock ?? fallbackLock;
  const claimed = lock.acquire(itemId);
  if (claimed) return { ok: true, release: claimed };

  if (holders === "wait") {
    return { ok: false, problem: "A run is working in that checkout. EO will not touch its index until the run has finished." };
  }

  const working = () => listActiveRuns(db).filter((run) => run.itemId === itemId);
  const holding = working();

  if (!ctx.engine) {
    // Something holds the claim and EO has no way to ask it to stop.
    return { ok: false, problem: "A run is working in that checkout and EO cannot stop it from here. Cancel it on the ticket and try again." };
  }

  // `superseded`, and this is the one caller where that word is doing
  // something other than avoiding a duplicate comment (EO-175). A
  // rebuild is maintenance: it needs the checkout for a moment and wants
  // the item to carry on the instant it has finished with it. Left at
  // the default this would read as somebody stopping the step, record a
  // stop against the item's initiation, and leave the item sitting
  // where the rebuild found it — the rebuild's own success turned into
  // the reason nothing happens next.
  for (const run of holding) ctx.engine.cancelRun(run.id, "superseded");

  // Only when something was actually stopped. Holding the claim while a
  // queued run waits its turn drops nothing, so there is nothing to
  // report — a comment there would be EO announcing an event that did
  // not happen.
  if (holding.length > 0) {
    postComment(db, {
      itemId: itemId as Uuid,
      author: { type: "engine" },
      kind: "note",
      body:
        holding.length === 1
          ? "This run was stopped because somebody asked EO to rebuild this checkout's repository index. Rebuilding deletes the index while it is being read, so whatever was holding it had to let go first."
          : `${holding.length} runs were stopped because somebody asked EO to rebuild this checkout's repository index. Rebuilding deletes the index while it is being read, so whatever was holding it had to let go first.`,
    });
  }

  const timeoutMs = ctx.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const pollMs = ctx.stopPollMs ?? STOP_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const hold = lock.acquire(itemId);
    if (hold) return { ok: true, release: hold };
    // Asked again, so a dispatch that had claimed the item but not yet
    // registered a controller when this started is reached now. Same
    // classification as above, for the same reason: this is still the
    // rebuild asking, not a person.
    for (const run of working()) ctx.engine.cancelRun(run.id, "superseded");
  }

  return {
    ok: false,
    problem: "EO asked the run working in that checkout to stop and it has not yet. Nothing was deleted. Try again in a moment.",
  };
}

/**
 * Everything the three operations do before they differ.
 *
 * The row, the checkout, the switch, the binary, and only then the
 * item. That order is not tidiness — it is the graceful-degradation
 * rule expressed as control flow, and it is checked in that sequence for
 * two separate reasons.
 *
 * The first is what a person reads: "repository intelligence is switched
 * off" before "EO could not run the indexer" before whatever the tool
 * said. Getting *that* the other way round is how somebody with the
 * feature off ends up reading about a download.
 *
 * The second is what a press is allowed to cost. Claiming the item is
 * the step with consequences — for Rebuild it cancels whatever holds the
 * checkout — so it goes last, after every refusal that could have
 * happened has happened. A screen can be looking at a stale answer to
 * either question, and a Rebuild that stopped an agent and then reported
 * "switched off" would have taken somebody's work in exchange for
 * nothing, which is precisely what the degradation promise rules out.
 */
async function prepare(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:syncRepositoryIndex">,
  holders: Holders,
): Promise<{ ok: true; runtime: RepositoryIntelligenceRuntime; target: RepositoryIndexTarget; release: ItemHold } | { ok: false; problem: string }> {
  const row = getRepositoryIndexById(db, payload.id);
  if (!row) return { ok: false, problem: "EO has no note of that repository index. It may have been removed since this screen was loaded." };

  const workspacePath = workspaceFor(db, row, ctx.worktreeRoot);
  if (workspacePath === null) {
    return { ok: false, problem: "EO can no longer find the checkout this index describes, so there is nothing to index." };
  }

  // A worktree that has been released takes its index with it. Refusing
  // here rather than letting the implementation create the directory
  // again is the difference between "that checkout is gone" and a fresh
  // index of an empty folder that would look, on this screen, exactly
  // like a working one.
  if (!existsSync(workspacePath)) {
    return { ok: false, problem: `The checkout at ${workspacePath} is no longer on disk, so there is nothing to index.` };
  }

  const build = ctx.factory ?? ((forRun) => repositoryIntelligenceFor({ ...forRun, root: ctx.root }));
  const runtime = build({ db });
  if (runtime === null) {
    return { ok: false, problem: "Repository intelligence is switched off, so EO is not indexing anything. Turn it on above to use it." };
  }

  const target: RepositoryIndexTarget = { workspaceId: row.workspaceId, itemId: row.itemId, workspacePath };

  const installed = await runtime.ensureInstalled();
  if (!installed.ok) {
    // Written onto the row as well as answered, for the reason
    // `supervisor/builtins.ts` gives: no build was attempted, so nothing
    // else would record why, and an installation that can never index
    // would otherwise read as "not indexed" forever with no account of
    // it anywhere a person looks.
    //
    // Its own outcome is deliberately not checked, and not out of
    // laziness: the transition table refuses `ready -> failed`, and that
    // refusal is right. A `ready` row describes an index that is still
    // on disk and still answers queries — a binary that has gone missing
    // since means EO cannot *refresh* it, which is a different sentence
    // from "your index is broken", and the person gets the true one
    // below either way.
    await runtime.service.recordUnavailable(target, installed.reason);
    // The row keeps the implementation's sentence; the screen is given
    // EO's. See the note at the top of this file for why that swap is
    // structural rather than tidy.
    return { ok: false, problem: CANNOT_RUN };
  }

  // Last, and only now that EO knows it can do the work.
  //
  // The claim is taken for the whole operation and held until it
  // finishes. Upkeep waits for whoever has it; recovery asks them to
  // stop. See `Holders` above for why those are different answers rather
  // than one policy applied twice — EO does not end somebody's run to
  // refresh a cache, and it does not refuse to fix a broken index
  // because something is sitting in front of it.
  //
  // **Everything that could refuse has already refused.** That ordering
  // is the graceful-degradation rule (EO-141) written as control flow:
  // a switch that is off and an indexer that will not run must leave the
  // agent working, and this screen can be looking at a stale answer to
  // either — somebody turned the feature off in another window, a binary
  // went missing since the page loaded. Claiming first meant Rebuild
  // could cancel an agent's run and *then* discover it had nothing to
  // offer, which is the one outcome this feature promised it would never
  // produce: work stopped in exchange for nothing.
  //
  // It costs nothing to wait. Building a runtime reads a setting, and
  // `ensureInstalled` touches EO's own cache rather than the checkout —
  // neither needs the worktree, and doing the download outside the claim
  // means a 46 MB fetch no longer holds an item nothing else can
  // dispatch against.
  //
  // A baseline row names no item, so there is nothing to claim and
  // nothing that could be dispatched against it. Nothing writes one yet.
  let release: ItemHold = () => undefined;
  if (row.itemId !== null) {
    const claimed = await claimItem(db, ctx, row.itemId, holders);
    if (!claimed.ok) return { ok: false, problem: claimed.problem };
    release = claimed.release;
  }

  return { ok: true, runtime, target, release };
}

async function act(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:syncRepositoryIndex">,
  verb: keyof typeof FAILED,
  holders: Holders,
  work: (runtime: RepositoryIntelligenceRuntime, target: RepositoryIndexTarget) => Promise<RepositoryIndexOutcome>,
): Promise<IpcResponse<"repositoryIntelligence:syncRepositoryIndex">> {
  if (inFlight.has(payload.id)) return refuse("EO is already working on that index. It will say what happened when it has finished.");
  inFlight.add(payload.id);
  try {
    const ready = await prepare(db, ctx, payload, holders);
    if (!ready.ok) return refuse(ready.problem);

    try {
      // `finish` is synchronous; only `work` is awaited. An `await` on a
      // plain value is not wrong, but it reads as if something asynchronous
      // happens there, and nothing does.
      return finish(db, ctx, payload, verb, await work(ready.runtime, ready.target));
    } finally {
      // The claim goes back whatever happened, including a throw. A
      // item held by a press that failed is an item nothing can
      // dispatch against again.
      ready.release();
    }
  } finally {
    inFlight.delete(payload.id);
  }
}

/** The answer a press gets: the row as it now stands, and EO's own sentence if it did not work. */
function finish(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:syncRepositoryIndex">,
  verb: keyof typeof FAILED,
  outcome: RepositoryIndexOutcome,
): IpcResponse<"repositoryIntelligence:syncRepositoryIndex"> {
  // Re-read rather than returned from the outcome, so a refusal answers
  // with the row as it now stands — the service has already written
  // `failed` and the reason onto it, and a screen showing the *old*
  // status beside the new sentence would be showing two accounts of one
  // event.
  const row = getRepositoryIndexById(db, payload.id);
  const busy = busyItemIds(db);
  return {
    ok: outcome.ok,
    index: row ? toView(db, row, busy, ctx.worktreeRoot) : null,
    // `FAILED[verb]` and deliberately not `outcome.reason`. The service
    // has just written that reason onto the row, so nothing is lost and
    // the debug area has it; what must not happen is the
    // implementation's name arriving on the status screen in a sentence
    // nobody here composed.
    problem: outcome.ok ? null : FAILED[verb],
  };
}

/** Builds an index for a checkout that has none. */
export function initializeRepositoryIndexCommand(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:initializeRepositoryIndex">,
): Promise<IpcResponse<"repositoryIntelligence:initializeRepositoryIndex">> {
  return act(db, ctx, payload, "build", "wait", (runtime, target) => runtime.service.ensureIndexed(target));
}

/** Brings an index up to date with its checkout. What Refresh does. */
export function syncRepositoryIndexCommand(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:syncRepositoryIndex">,
): Promise<IpcResponse<"repositoryIntelligence:syncRepositoryIndex">> {
  return act(db, ctx, payload, "update", "wait", (runtime, target) => runtime.service.sync(target));
}

/**
 * Stops anything holding the index, throws it away, and builds it again.
 *
 * The recovery path, and the reason this screen exists: an index that
 * has been truncated, half-written or built by a binary that is no
 * longer here is fixed by deleting it and doing it again, and a person
 * should not have to know where it lives to do that.
 *
 * All three parts of that sentence are load-bearing, and the first one
 * is the one that is easy to leave out. A recovery path a busy checkout
 * can switch off is not a recovery path — an index gets corrupted *by* a
 * run that died badly, which is precisely when a `running` row is most
 * likely to be sitting in front of the button. So the run is cancelled,
 * the item gets a comment saying why, and the rebuild waits for the
 * checkout to actually be let go before it deletes anything.
 *
 * What it touches is `service.rebuild` and nothing else, which is
 * `provider.remove` followed by `provider.initialize`. The only path
 * either of them composes is the index directory, out of the index
 * directory's own name, inside a checkout the implementation is about
 * to read again from source. Source files, git history, and every row
 * EO keeps — items, comments, runs, pipelines, agents, repositories —
 * are nobody's business here, and `rebuildRecovery.test.ts` asserts that
 * rather than leaving it as something this comment claims.
 */
export function rebuildRepositoryIndexCommand(
  db: Db,
  ctx: RepositoryIntelligenceContext,
  payload: IpcPayload<"repositoryIntelligence:rebuildRepositoryIndex">,
): Promise<IpcResponse<"repositoryIntelligence:rebuildRepositoryIndex">> {
  return act(db, ctx, payload, "rebuild", "stop", async (runtime, target) => {
    // An index left mid-build by a crash or a quit, freed before the
    // rebuild starts.
    //
    // `indexing -> indexing` is refused by the transition table, and
    // rightly: it is the only thing standing between EO and two builds
    // writing to one directory. But a row saying `indexing` with nothing
    // building is a row no button could ever move, and this screen's job
    // is to be the way out of exactly that. So the interruption is
    // *recorded* — `indexing -> failed` is legal and true — and the
    // rebuild proceeds from there. Nothing weakens the rule.
    //
    // Safe to say plainly because of what has already been checked: no
    // run is working in this checkout, and this process is not building
    // it either, or `inFlight` would have turned the call away.
    const row = getRepositoryIndexById(db, payload.id);
    if (row?.status === "indexing" || row?.status === "updating") {
      runtime.service.setStatus(target, "failed", { errorMessage: "EO was interrupted while it was working on this index, so it never finished." });
    }
    return runtime.service.rebuild(target);
  });
}
