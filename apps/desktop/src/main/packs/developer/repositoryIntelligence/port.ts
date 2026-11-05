import type { RepositoryIndex, RepositoryIndexAnswers, RepositoryIndexHit, RepositoryIndexQuestion, RepositoryIndexStatus } from "@eo/core";

/**
 * The port everything in EO talks to when it wants repository
 * intelligence (EO-145).
 *
 * Read this file top to bottom and you cannot tell what is underneath
 * it. That is the acceptance criterion and it is also the whole point
 * of the feature: agents *consume* repository intelligence, they do not
 * own it. If the implementation is replaced tomorrow, no agent, prompt,
 * pipeline or step changes, because none of them has ever named one.
 *
 * `architecturalInvariants.test.ts` in this directory is what keeps
 * that true after everybody has stopped thinking about it.
 *
 * What an index *is*, as far as this file is concerned: a directory
 * somewhere holding a queryable description of a checkout, which can be
 * built, updated, thrown away and built again, and which an agent
 * reaches over MCP. Nothing here says how it is built, what it is built
 * with, what the description contains or what the query language is —
 * those are the implementation's business, and an interface that leaked
 * any of them would have to change when the implementation did.
 *
 * The division of labour with `RepositoryIntelligenceService`, which
 * sits above this: the service owns EO's metadata and the status
 * transitions, the provider owns the directory and the tool. A provider
 * never writes to `eo.db` and never decides what a status means; the
 * service never spawns anything.
 *
 * Every method answers rather than throws. A missing binary, an
 * unsupported platform and a build that fell over are all ordinary
 * outcomes here, not exceptions: repository intelligence degrades and
 * never blocks work, so a caller has to be able to carry on from a
 * refusal without a try/catch around every call. Throwing stays what
 * the conventions say it is — programmer error.
 */

/**
 * Which index a call is about.
 *
 * Workspace plus item, and never a bare path, because those two are
 * what identifies a row in `repository_indexes` — keyed on
 * `workspace_id` since KAN-130, the same id the repository had — and the
 * path is a consequence of them. `workspacePath` comes along because the
 * provider has to be told which checkout to look at, and a provider is
 * not given a database handle to work it out for itself.
 *
 * Two different things called "workspace" meet here, which is worth
 * saying once: `workspaceId` is the row EO holds — the repository, for
 * the one kind of workspace there is — and `workspacePath` is the
 * checkout on disk that this call describes. An item has one of each and
 * they are not derivable from one another.
 */
export interface RepositoryIndexTarget {
  workspaceId: string;
  /**
   * The item whose checkout this is, or null for the workspace's own
   * baseline.
   *
   * Nothing passes null in this version. It is in the signature for the
   * same reason the column is in the table: so that a baseline is a new
   * row and a new call, rather than a change to what an existing one
   * means.
   */
  itemId: string | null;
  /** The checkout to describe. The index lives under the provider's control, near or in it. */
  workspacePath: string;
}

/**
 * What the implementation can see for itself, without EO's metadata.
 *
 * Deliberately not a `RepositoryIndexStatus`. A provider looks at a
 * directory and a binary and reports facts; deciding that those facts
 * mean READY, or STALE, or that a failure is now being retried, needs
 * the row as well and is therefore the service's job. Two layers each
 * returning the same enum would be two places to disagree about what it
 * meant.
 */
export interface RepositoryIndexProbe {
  /** Whether a usable index for this target exists on disk right now. */
  present: boolean;
  /**
   * Where the index lives, or would live if it were built.
   *
   * Answered by the implementation because the layout is its business,
   * and answered even when `present` is false because EO has to write
   * `index_path` on the row before the build that fills it starts. A
   * caller never composes this path itself.
   */
  indexPath: string;
  /**
   * The version of the implementation as resolved on this machine, or
   * null when none could be resolved at all.
   *
   * Null is the degradation signal and is treated as "no opinion"
   * rather than as skew: a machine with no binary has an index that
   * cannot be rebuilt, and marking it stale would replace a usable note
   * with a promise EO cannot keep.
   */
  providerVersion: string | null;
  /** The commit the on-disk index was built from, when the implementation records one. */
  indexedCommitSha: string | null;
  /** Why the provider could not answer — an absent binary, an unsupported platform. Null when it could. */
  unavailableReason: string | null;
}

/** The outcome of any call that builds, updates or replaces an index. */
export type RepositoryIndexBuild =
  | {
      ok: true;
      /** Where the index ended up. Reported rather than dictated: the provider owns the layout. */
      indexPath: string;
      providerVersion: string | null;
      indexedCommitSha: string | null;
      /**
       * How long the work took, in milliseconds, measured by EO around
       * the implementation rather than reported by it.
       *
       * Here because the question this feature exists to answer — is a
       * persistent index worth what rediscovering the repository every
       * time costs — is a question about numbers, and a measurement
       * retrofitted after the fact is a measurement of whatever survived.
       * `scripts/index-benefit.mts` is what asks it, and this
       * directory's README records what it answered.
       *
       * EO's own clock rather than the implementation's, so that what is
       * recorded is the cost EO paid, process startup included, and so
       * that two implementations reporting time differently still
       * produce comparable rows.
       *
       * Optional because not every implementation of this port has to
       * measure itself, and a caller that only wants to know whether the
       * index is usable must not have to care.
       */
      durationMs?: number;
      /**
       * How many files the implementation reported updating.
       *
       * Meaningful for an update of an existing index and absent for a
       * build from nothing, where "changed" would mean "all of them" and
       * would say nothing anyone asked. Reported by the implementation
       * rather than computed by the caller: a checkout carries
       * uncommitted work that a commit-to-commit diff would miss, and
       * the thing that just walked the tree already knows the answer.
       */
      changedFileCount?: number;
      /**
       * How much disk the index occupies now, in bytes (EO-155).
       *
       * The implementation's own account of the directory it owns, for
       * the reason `indexPath` is: what counts as "the index" is its
       * business, and a caller that measured the path itself would be
       * deciding that question from outside. It is the third number the
       * measurement asks for beside the two durations, and the one a
       * person weighs when the answer is "this costs a worktree
       * something" — fifty megabytes per item is a different
       * proposition from five.
       *
       * Reported on a build and on an update alike, because it is a
       * property of the directory rather than a cost of the call.
       * Optional like the rest: an implementation that cannot say, or
       * whose measurement failed, reports nothing rather than a zero
       * that would read as an empty index.
       */
      indexSizeBytes?: number;
    }
  | {
      ok: false;
      /**
       * One sentence, addressed to a person.
       *
       * It reaches a comment on the item and a card on the board, so
       * "the index binary is not available for this platform" is right
       * and a stack trace is not.
       */
      reason: string;
    };

/** The outcome of removing an index from disk. */
export type RepositoryIndexRemoval = { ok: true } | { ok: false; reason: string };

/**
 * How an agent reaches the index: an EO-owned stdio MCP server, spawned
 * per dispatch and pointed at that item's checkout.
 *
 * A command, its arguments and its environment — the generic shape of
 * every stdio MCP server in this codebase, which is what keeps this
 * free of any assumption about what is being spawned.
 */
export interface RepositoryIndexQueryServer {
  /** The key under `mcpServers`, and so the middle of every tool id the model sees. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * What this implementation would like an agent to call instead of
   * searching the tree, in its own tool names (EO-165).
   *
   * The one thing in this interface that is not the generic shape of an
   * stdio server, and it is here for the reason the rest of it is
   * generic: an adapter that intercepts a broad `grep -rn` has to name
   * the call that answers it, and only the implementation knows what its
   * calls are called. Naming them in the adapter would train an agent on
   * one provider's vocabulary — the thing this port exists to prevent —
   * so the provider says the words and nothing between here and the
   * adapter reads them.
   *
   * Optional. A provider with nothing to offer here is not intercepted
   * at all, which is the same answer a provider with no server gets.
   */
  answers?: RepositoryIndexAnswers;
  /**
   * Asks the index whether it holds the thing a search is looking for,
   * so nothing is suggested that could not have helped (EO-173).
   *
   * Here for `answers`' reason, one step further on. Naming the call
   * that answers a `grep -rn` is only advice worth giving when the index
   * has an answer, and whether it has one is a question about the
   * implementation's own contents that nothing above this line can ask
   * for itself. So the provider does the asking, in whatever way its
   * index is asked, and what comes back is names and paths — the least
   * this decision needs and nothing an agent would have to be shown.
   *
   * Bound to the target it was fetched for, so a caller cannot ask about
   * the wrong checkout. It never throws, answers empty for an index it
   * cannot reach, and is expected back in milliseconds: the caller is a
   * hook holding up a tool call, not a background job.
   *
   * Optional, like `answers`, and absent means the same thing — no
   * interception at all. A provider that cannot be asked does not get to
   * be suggested unchecked.
   */
  knows?: (question: RepositoryIndexQuestion) => Promise<RepositoryIndexHit[]>;
}

/**
 * The port. Seven methods, and each is a thing EO's runtime actually
 * does at a point in an item's life.
 */
export interface RepositoryIntelligenceProvider {
  /**
   * Names this implementation in `repository_indexes.provider`.
   *
   * Opaque. EO stores it, compares it to what a row already holds, and
   * never interprets it — a row naming an implementation that is not
   * the configured one describes somebody else's index, whatever the
   * two are called.
   */
  readonly id: string;

  /** Builds an index for a checkout that has none. */
  initialize(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild>;

  /**
   * Brings an existing index up to date with the working tree.
   *
   * Called at handovers — after an implementer succeeds and before a
   * reviewer starts — rather than continuously, so that EO is the only
   * thing writing to the index and a query never races a build.
   */
  sync(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild>;

  /** What the provider can see for this target, right now. Reads only. */
  getStatus(target: RepositoryIndexTarget): Promise<RepositoryIndexProbe>;

  /**
   * Whatever it takes to leave a usable index in place — build it, update
   * it, or report that neither was possible.
   *
   * The method a caller wants who does not care which of the two
   * happened, which is most of them.
   */
  ensureReady(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild>;

  /**
   * How an agent dispatched against this checkout queries the index, or
   * null when it cannot.
   *
   * Null is a first-class answer and every caller must handle it: it is
   * what an unsupported platform, an absent binary and an index that
   * failed to build all look like, and the agent runs regardless with
   * the filesystem and git tools it has always had.
   */
  getAgentMcpConfig(target: RepositoryIndexTarget): Promise<RepositoryIndexQueryServer | null>;

  /**
   * Throws the index away and builds it again from nothing.
   *
   * The answer to every kind of skew, which is why there is no other
   * one. An index is derived from the checkout and costs seconds of
   * CPU, so "rebuild it" is always available and always correct —
   * nothing in this codebase will ever migrate an index.
   */
  rebuild(target: RepositoryIndexTarget): Promise<RepositoryIndexBuild>;

  /** Deletes the index from disk. Called when a worktree goes, and when a row is being forgotten. */
  remove(target: RepositoryIndexTarget): Promise<RepositoryIndexRemoval>;
}

/**
 * Re-exported so that a reader of this directory finds the model beside
 * the port that uses it.
 *
 * They are *defined* in `packages/core`, not here, because they cross
 * IPC — the board shows an index's status — and the conventions say a
 * boundary-crossing shape is a zod schema in that package and not a
 * hand-written interface on either side of the wire.
 */
export type { RepositoryIndex, RepositoryIndexAnswers, RepositoryIndexHit, RepositoryIndexQuestion, RepositoryIndexStatus };
