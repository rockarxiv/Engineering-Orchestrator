import { REPOSITORY_INDEX_QUERYABLE } from "@eo/core";
import type { Db } from "../../../db/client.js";
import type { RepositoryIntelligenceFactory } from "./composition.js";
import type { RepositoryIndexTarget } from "./port.js";
import { sayable } from "./sayable.js";

/**
 * Bringing an item's index up to date at the moment its work changes
 * hands (EO-153).
 *
 * **Why a boundary rather than a watcher.** An index that is stale by
 * the time the reviewer reads it is worse than no index, because the
 * reviewer will believe it. A file watcher would keep one roughly
 * current and leave nobody able to say what any particular agent
 * actually saw; a sync at a named point in the run means EO can. That
 * is also why the query server runs with `--no-watch` (EO-151): EO's
 * own syncs are the only writes to an item's index, so a query never
 * races a build.
 *
 * **Where the boundary is.** `driveToCompletion` accepts a result,
 * verifies it, and then moves the item. This sits between the
 * verification and the move, and both halves of that are deliberate: a
 * run that failed verification produced nothing worth indexing, and an
 * item that has already moved is the next agent's problem rather than
 * the last one's. Every handover in the pipeline is the same moment, so
 * this is not a list of roles — the implementer handing over to the
 * reviewer, the implementer handing over again after changes were
 * requested, and the approval that precedes a pull request are one rule
 * applied three times. A `qa` step inserted between two of them gets it
 * without a line of TypeScript, which is what invariant #7 is for.
 *
 * **It never blocks the transition.** Every way this can fail is
 * ordinary: the feature is off, the item carries no repository, no
 * index was ever built, the tool fell over. In all of them the item
 * moves and the next agent is dispatched with the filesystem and git
 * tools every agent has always had. Holding a person's item in place
 * because a cache did not refresh would be the wrong trade, and EO-141
 * states graceful degradation as a requirement rather than a
 * preference.
 *
 * **It knows nothing about what is underneath.** It asks the port to
 * sync and is told how it went. There is no subcommand, no flag and no
 * changed-file computation here — the port's `sync` reconciles against
 * what is actually on disk, which is the only way uncommitted work in a
 * worktree gets into the index at all. EO keeps the commit sha for its
 * own bookkeeping; a sha-to-sha diff handed over as "what changed"
 * would miss everything an agent has not committed yet, which on a
 * handover is frequently all of it.
 */

/** What the caller is told: a sentence to put in the thread, or nothing to say. */
export interface RepositoryHandoverSync {
  /**
   * The engine comment to post, or null when there is nothing worth
   * saying.
   *
   * Null is the ordinary answer. A successful sync is not news — it is
   * what is supposed to happen at every handover of every item, and a
   * comment for it would bury the ones that matter. A sentence is
   * produced only when somebody switched this on and the index they
   * were promised has stopped describing their code, which is the case
   * invariant #8 is about.
   */
  notice: string | null;
}

export interface RepositoryHandoverSyncRequest {
  db: Db;
  /** The item handing over. A null workspace is a feature, which has no checkout to describe. */
  item: { id: string; workspaceId: string | null };
  /** The checkout whose work is being handed on. Exactly this and nothing else is reconciled. */
  worktreePath: string;
  /** Whose work this was, so the sentence names them the way every other engine note does. */
  agentName: string;
  /**
   * Ends the sync when a person cancels the run or EO shuts down.
   *
   * Load-bearing rather than tidy. This runs *after* the run's own
   * controller has been let go of, so without a signal reaching the
   * implementation an indexer started here would outlive the cancel
   * that was meant to end it — a live process in a checkout the person
   * has finished with, which is the one cost of this feature nobody
   * agreed to pay.
   */
  signal?: AbortSignal;
}

/** Said when the implementation's account of a failure was not a sentence EO could repeat. */
const UNREADABLE_REASON = "the indexer did not say why";

/**
 * Brings this item's index up to date, or says why it could not.
 *
 * The factory is passed in rather than imported, exactly as
 * `agentServer.ts` takes it: the supervisor stays ignorant of where a
 * binary is cached, and this file stays ignorant of the gate — the
 * runtime is null when the feature is off, and that is the whole of
 * what this needs to know about it (EO-148).
 */
export async function syncRepositoryIndexAtHandover(
  intelligence: RepositoryIntelligenceFactory,
  request: RepositoryHandoverSyncRequest,
): Promise<RepositoryHandoverSync> {
  const { db, item, worktreePath, agentName, signal } = request;

  // The gate first, and before anything else is touched. With the
  // feature off this must cost exactly nothing — no binary resolved, no
  // row read, no process — because the rollout promise is that a build
  // carrying this story behaves like one carrying none of it until
  // somebody says otherwise.
  const runtime = intelligence({ db, ...(signal === undefined ? {} : { signal }) });
  if (runtime === null) return { notice: null };

  // A feature carries no workspace, and an index is keyed on one.
  // Nothing is missing here: there is no checkout to describe, which is
  // a fact about the item rather than something that went wrong.
  if (item.workspaceId === null) return { notice: null };

  const target: RepositoryIndexTarget = {
    workspaceId: item.workspaceId,
    itemId: item.id,
    workspacePath: worktreePath,
  };

  // **Only a queryable index has anything to bring up to date.** Asked
  // through `resolveStatus` rather than off the row, so a version skew
  // that has quietly happened during the run is reconciled here and the
  // sync is not attempted against a graph the installed binary can no
  // longer read.
  //
  // Silent when the answer is no, and that is not a guard dropping work
  // on the floor. There is no index to update: it was never built,
  // its build failed, or it is already known not to describe the
  // checkout. Whichever it is, the next dispatch asks the same question
  // and posts the sentence explaining it (EO-151) — so saying it here
  // as well would put the same explanation in the thread twice per
  // handover, which is how a thread stops being read.
  if ((await runtime.service.resolveStatus(target)) !== REPOSITORY_INDEX_QUERYABLE) return { notice: null };

  const outcome = await runtime.service.sync(target);
  if (outcome.ok) return { notice: null };

  // The trailing stop is trimmed for `agentServer.ts`'s reason: the
  // clause may be EO's own, written to be joined, or a provider's,
  // written to stand alone and already ending in one. Left in, the one
  // sentence a person actually reads would carry two.
  const why = sayable(outcome.reason, UNREADABLE_REASON).replace(/[.\s]+$/, "");
  return {
    notice:
      `EO could not bring this ticket's repository index up to date after ${agentName} finished: ${why}. ` +
      `The index is marked stale rather than handed on describing code that has since changed, so the next run ` +
      `goes ahead with the filesystem and git tools every agent has always had. Rebuilding it is the way back.`,
  };
}
