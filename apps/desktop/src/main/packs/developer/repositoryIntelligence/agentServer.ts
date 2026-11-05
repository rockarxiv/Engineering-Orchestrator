import { existsSync } from "node:fs";
import type { RepositoryIndex } from "@eo/core";
import type { Db } from "../../../db/client.js";
import type { RepositoryIntelligenceFactory } from "./composition.js";
import type { RepositoryIndexQueryServer, RepositoryIndexTarget } from "./port.js";
import { sayable } from "./sayable.js";
import type { RepositoryIntelligenceService } from "./service.js";

/**
 * Whether this dispatch's agent gets to query the index, and what to
 * tell somebody when it does not (EO-151).
 *
 * The one place that answers, so that all three paths reaching a
 * provider — a fresh dispatch, a person's reply unparking a run, and a
 * run recovered after a crash — give an agent the same thing and say the
 * same thing about it. Three copies of this decision would be three
 * chances for a resumed reviewer to end up quietly worse off than a
 * fresh one, and the recovery path is where that actually happened.
 *
 * **Never throws and never refuses a dispatch.** Every way this can
 * answer "no" is an ordinary outcome: the feature is off, the item
 * carries no repository, no binary could be resolved on this machine,
 * the build failed, the index is mid-rebuild. In all of them the agent
 * is dispatched with the filesystem and git tools it has always had,
 * which is what EO-141 states as a requirement rather than a
 * preference.
 *
 * **It repairs before it explains (EO-177).** An index has three ways to
 * stop being queryable while an item is in flight — the indexer on the
 * machine moved on from the one that built it, the checkout was released
 * and took the record with it, a build failed — and the indexing step is
 * behind the item by then, so nothing was ever going to run again.
 * This is the one place all three arrive at, so it is the one place the
 * repair belongs: where the machine can index and there is a checkout to
 * index, EO builds one and asks again rather than posting a notice about
 * a state it could have fixed. What is left to explain is then something
 * a person can actually act on.
 *
 * **It knows nothing about what is underneath.** It asks the service
 * for a server and gets back a command, some arguments and an
 * environment; it never composes one, and there is no subcommand or flag
 * written anywhere in this file. That is the port doing its job — the
 * day the implementation changes, this file does not.
 */

/** What a dispatch is handed: a server, or nothing and a sentence. */
export interface RepositoryQueryServerDelivery {
  /** The server to give the backend, or null when there is none to give. */
  server: RepositoryIndexQueryServer | null;
  /**
   * The engine comment to post on this run, or null when there is
   * nothing worth saying.
   *
   * Null is the *ordinary* answer, not the exceptional one. With the
   * feature off, or on an item that has no repository, nothing is
   * missing — dispatch is exactly what it was before any of this
   * shipped, and a comment saying so would appear on every item in EO
   * forever. A sentence is produced only when somebody switched this on
   * and is not getting it, which is the case invariant #8 is about.
   */
  notice: string | null;
}

export interface RepositoryQueryServerRequest {
  db: Db;
  /** The item being dispatched. A null workspace is a feature, which has no checkout to describe. */
  item: { id: string; workspaceId: string | null };
  /** The checkout this dispatch prepared. The server is pointed at exactly this and nothing else. */
  worktreePath: string;
  /** Whose agent is going without, so the sentence names them the way every other dispatch notice does. */
  agentName: string;
  /**
   * The wrapper that keeps a delivered server from outliving the backend
   * that started it (EO-151), or absent to hand the provider's command
   * line over untouched.
   *
   * Absent in tests that are about *which* server a dispatch gets rather
   * than how long it lives, so those keep asserting the provider's own
   * argv rather than a wrapper's. Production always passes it.
   */
  superviseWith?: string;
}

/**
 * The provider's command line, wrapped so that EO owns when it ends.
 *
 * **Why the wrap is here and not in the port.** What to run is the
 * provider's business and it stays so — this takes whatever it composed
 * and puts a process of EO's in front of it, knowing nothing about
 * either. The provider could not do this itself without learning about
 * backends and process lifetimes, which are precisely what the port
 * exists to keep out of it.
 *
 * **Why not in the adapters.** Both would need the same wrap, written
 * twice, and the second copy is the one that gets forgotten — which is
 * exactly how a reserved name came to be filtered on one delivery path
 * and not the other earlier in this story. Here it is one line and both
 * adapters get it by having asked for nothing.
 *
 * `ELECTRON_RUN_AS_NODE` is the same trick `eoMcpStdioConfig` uses:
 * Electron *is* Node when told to be, so there is no second runtime to
 * install and no version to keep in step.
 */
function supervised(server: RepositoryIndexQueryServer, supervisor: string | undefined): RepositoryIndexQueryServer {
  if (supervisor === undefined) return server;
  return {
    name: server.name,
    command: process.execPath,
    args: [supervisor, server.command, ...server.args],
    env: { ...server.env, ELECTRON_RUN_AS_NODE: "1" },
    // Carried through rather than rebuilt. This wrapper changes *how*
    // the server is started and nothing about what it answers, so
    // dropping the provider's vocabulary here would silently switch
    // EO-165's interception off in production and leave it on in every
    // test that skips the wrapper — the worst possible place for a
    // difference. The same goes for the way of asking the index what it
    // holds: dropping that would switch EO-173's check off and leave the
    // suggestions being made unchecked, which is worse than either.
    ...(server.answers ? { answers: server.answers } : {}),
    ...(server.knows ? { knows: server.knows } : {}),
  };
}

/**
 * What a person is told when the index is not there, and EO could not
 * put one there.
 *
 * One sentence per state, because "unavailable" on its own is a fact
 * nobody can act on: a failed build wants the tool's reason, and an
 * index mid-rebuild wants to know it will be there next time. The
 * difference between them is the difference between going and looking at
 * what the indexer said and simply waiting.
 *
 * Read *after* the repair above has had its go, which is what makes
 * these sentences true when they are read. A `failed` row here is a
 * build EO has just tried and watched fall over, carrying the indexer's
 * own account of it, rather than one nobody retried.
 */
function whyNot(index: RepositoryIndex | undefined): string {
  // No row at all, and the sentence that used to be here — "the indexing
  // step has not run on it" — was false on the item that prompted
  // EO-177. The step had run, at +0s, and succeeded; the record was
  // thrown away fifty-six minutes later when something released the
  // checkout between two steps. A person following that sentence goes
  // looking for a missing step and finds one that ran.
  //
  // Which of the two it was is not a question this row can answer — the
  // row is gone, that is the whole of what is known — and reconstructing
  // it would mean asking the pipeline graph whether this item is past
  // its indexing step, for a clause in a sentence. So it names both, and
  // sends nobody anywhere on a guess.
  if (index === undefined) {
    return "EO has no index recorded for this ticket's worktree — either one was never built, or the record of one was forgotten when its checkout was released";
  }
  switch (index.status) {
    case "failed":
      return index.errorMessage === null
        ? "the last attempt to index this ticket's worktree did not produce one, and EO recorded no reason"
        : sayable(index.errorMessage, "the last attempt to index this ticket's worktree did not produce one, and what went wrong was not a sentence EO could repeat");
    case "not_indexed":
      return "this ticket's worktree has not been indexed yet";
    case "indexing":
      return "this ticket's worktree is still being indexed";
    case "updating":
      return "this ticket's index is being brought up to date";
    // Two ways to arrive here and they are not the same news. A version
    // skew carries no message and the sentence names it; a handover sync
    // that could not be completed (EO-153) carries the indexer's own
    // account, and repeating that is the difference between "rebuild
    // this" and "here is what stopped working".
    case "stale":
      return index.errorMessage === null
        ? "this ticket's index was built by a version of the indexer that is no longer on this machine, so it has to be rebuilt before it can be queried"
        : sayable(
            index.errorMessage,
            "this ticket's index could not be brought up to date and no longer describes the checkout, so it has to be rebuilt before it can be queried",
          );
    // `ready` and still no server: the row says there is an index and
    // the provider cannot open one — a binary that has gone missing
    // since, or a directory somebody deleted underneath it. Reachable,
    // and the honest thing to say is that the two disagree.
    case "ready":
      return "EO has an index recorded for this ticket's worktree but could not reach it on this machine";
  }
}

/**
 * Builds this item's index again and asks for the server a second
 * time, or null when there was nothing here to try (EO-177).
 *
 * **Why the dispatch is where this goes.** Three separate faults end in
 * the same place — a version skew resolved to `stale`, a record forgotten
 * with a released checkout, a build that failed — and every one of them
 * happens *after* the indexing step is behind the item, where nothing
 * in the pipeline will run again. Repairing at each of the three sites
 * would be three fixes that have to stay in step; repairing here is one,
 * at the moment the answer is actually needed. Routing the item
 * backwards to the step instead was rejected on the story: an item does
 * not return to step 1 because a cache expired, and the run history
 * would then describe a journey the work never took.
 *
 * **A rebuild, never an update.** `resolveStatus` sets out at length why
 * a rebuild is the answer to every kind of skew and why nothing in this
 * codebase reads the shape of an old index. `ensureIndexed` would reach
 * the provider's `ensureReady`, which updates whatever directory it finds
 * present — and a directory that is present *and* unqueryable is exactly
 * the case here, so that is the one call that could hand a new indexer an
 * old graph. `rebuild` throws it away first, and from every status this
 * can be reached in — no row, `not_indexed`, `failed`, `stale`, and a
 * `ready` the provider cannot open — the move to `indexing` is one the
 * transition table already allows.
 *
 * **The two things it will not do.** It will not index a checkout that is
 * not on disk: a recovered or unparked run carries the worktree path its
 * run was created with, and that directory can have been released since,
 * which is a build that would fail slowly and explain nothing. And it
 * will not start a second build over one already running — that is what
 * `indexing` and `updating` mean, invariant #10 is the reason it matters,
 * and the transition table would refuse it anyway with a sentence about
 * state machines that no person reading an item needs.
 *
 * **The outcome of the rebuild is deliberately not read.** What decides
 * whether this dispatch gets a server is asking for one again, not what
 * the build claimed (invariant #5). A rebuild that failed has already
 * written its reason to the row on the way out, which is what `whyNot`
 * then repeats — so the caller needs no second channel for it.
 */
async function rebuiltFor(
  service: RepositoryIntelligenceService,
  target: RepositoryIndexTarget,
  worktreePath: string,
): Promise<RepositoryIndexQueryServer | null> {
  if (!existsSync(worktreePath)) return null;

  // Off the row rather than through `resolveStatus`, because
  // `agentMcpConfig` has just reconciled it: a second probe would ask the
  // provider the same question for the same answer.
  const recorded = service.describe(target);
  if (recorded?.status === "indexing" || recorded?.status === "updating") return null;

  await service.rebuild(target);
  return service.agentMcpConfig(target);
}

/**
 * The server for this dispatch, or the reason there is none.
 *
 * The factory is passed in rather than imported so that the supervisor
 * stays ignorant of where a binary is cached and this file stays
 * ignorant of the gate — the runtime is null when the feature is off,
 * and that is the whole of what this needs to know about it (EO-148).
 */
export async function repositoryQueryServerFor(
  intelligence: RepositoryIntelligenceFactory,
  request: RepositoryQueryServerRequest,
): Promise<RepositoryQueryServerDelivery> {
  const { db, item, worktreePath, agentName, superviseWith } = request;

  // The gate first, and before anything else is touched. With the
  // feature off this costs exactly nothing and says nothing — the
  // rollout promise is that dispatch is what it was, and an engine
  // comment on every run would not be that.
  const runtime = intelligence({ db });
  if (runtime === null) return { server: null, notice: null };

  // A feature carries no workspace, and an index is keyed on one.
  // Nothing is missing here: there is no checkout to describe, which is
  // a fact about the item rather than something that went wrong.
  if (item.workspaceId === null) return { server: null, notice: null };

  const target: RepositoryIndexTarget = {
    workspaceId: item.workspaceId,
    itemId: item.id,
    // This item's checkout and no other. The provider composes the
    // server's whole command line from exactly this target, which is
    // what makes an agent on one item unable to reach another's: there
    // is no shared index, and no second checkout for one to be pointed
    // at.
    workspacePath: worktreePath,
  };

  const server = await runtime.service.agentMcpConfig(target);
  if (server !== null) return { server: supervised(server, superviseWith), notice: null };

  // **Can this machine index anything at all?** Asked first, and it wins
  // outright, because it is the more fundamental fact: no status this
  // row could hold is actionable on a machine with no binary to run.
  //
  // It is what stops the Intel Mac — where upstream publishes no build,
  // so this is a real case and not a hypothetical — from being told its
  // index "has not been built yet", which reads as "run the step" and
  // sends a person to add one that would fail every time. It also
  // corrects a `stale` row on such a machine, whose sentence promises a
  // rebuild EO cannot perform.
  //
  // Null on any machine that can run the implementation, which is nearly
  // all of them, and the row's own account is used then.
  const blocked = await runtime.service.unavailableReason(target);

  // **And if the machine can index, index.** Only then: a rebuild on a
  // machine with no binary is the promise `blocked` exists to stop EO
  // making, and it would fail every time it was attempted. Everything
  // else about the attempt is in `rebuiltFor`, including the two states
  // it declines to touch.
  //
  // The cost is seconds of CPU on a dispatch that was otherwise about to
  // send an agent to rediscover the checkout by hand, which is the exact
  // work this feature exists to stop paying for. Nothing is said when it
  // works: a rebuilt index is what the run was promised, and a comment
  // per repair would be the kind of narration that stops threads being
  // read — the same rule a successful handover sync already follows.
  const rebuilt = blocked === null ? await rebuiltFor(runtime.service, target, worktreePath) : null;
  if (rebuilt !== null) return { server: supervised(rebuilt, superviseWith), notice: null };

  // Asked *after* `agentMcpConfig`, never before: that call reconciles
  // the row against what the provider can see, so a row read first could
  // name a status the reconciliation has since moved.
  //
  // Read again here rather than reused from above, for the same reason:
  // the repair may have moved it, and a `failed` row carrying the
  // indexer's account of the build that just fell over is the whole of
  // what is worth saying by this point.
  //
  // The trailing stop is trimmed because half of these clauses are EO's
  // own — written to be joined — and half are a provider's, written to
  // stand alone and ending in a full stop of their own. Left in, the one
  // sentence a person actually reads on the failure path would carry two.
  const why = (blocked ?? whyNot(runtime.service.describe(target))).replace(/[.\s]+$/, "");
  const notice =
    `Repository intelligence is unavailable to ${agentName} on this run: ${why}. ` +
    `The run goes ahead with the filesystem and git tools every agent has always had.`;
  return { server: null, notice };
}
