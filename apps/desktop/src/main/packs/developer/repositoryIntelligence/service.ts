import type { RepositoryIndex, RepositoryIndexStatus } from "@eo/core";
import type { Db } from "../../../db/client.js";
import {
  deleteRepositoryIndex,
  getRepositoryIndex,
  recordRepositoryIndex,
  setRepositoryIndexStatus,
  type RepositoryIndexPatch,
} from "../../../db/repos/repositoryIndexesRepo.js";
import { canTransitionIndex, refuseIndexTransition } from "./transitions.js";
import type { RepositoryIndexQueryServer, RepositoryIndexTarget, RepositoryIntelligenceProvider } from "./port.js";

/**
 * What EO knows about its indexes, and the only thing that changes it
 * (EO-145).
 *
 * The service sits above the port and the two own different halves. The
 * provider owns a directory and a tool: it builds, updates, deletes and
 * describes what is on disk, and it has no database handle. The service
 * owns the row: which target has an index, what state it is in, and
 * which changes of state are allowed. Nobody else writes a status —
 * the same arrangement `transitionItem` has with `items.stepId`,
 * for the same reason, which is that a state machine with two authors
 * is not a state machine.
 *
 * Nothing here throws for an outcome. A missing binary, an unsupported
 * platform and a build that fell over come back as `{ ok: false,
 * reason }`, because repository intelligence degrades and never blocks:
 * every one of those has to leave the item dispatchable with the
 * tools the agent had before this feature existed.
 */

export type RepositoryIndexOutcome = { ok: true; index: RepositoryIndex } | { ok: false; reason: string };

export interface RepositoryIntelligenceService {
  /** The row for a target, exactly as stored. No probing, no writes. */
  describe(target: RepositoryIndexTarget): RepositoryIndex | undefined;
  /**
   * The status a caller should act on, after reconciling the row with
   * what the provider can see. May write — see `resolveStatus` below.
   */
  resolveStatus(target: RepositoryIndexTarget): Promise<RepositoryIndexStatus>;
  /** Leaves a usable index in place, building one if there is none. */
  ensureIndexed(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome>;
  /**
   * Brings a ready index up to date with the working tree.
   *
   * A sync that does not work leaves the row `stale` rather than
   * `failed` (EO-153): the index it was updating is still on disk, and
   * what has stopped being true is that it describes the checkout.
   * Its cost — how long it took, how many files it touched — is
   * recorded on the row, which is the only place the measurement story
   * can read it from.
   */
  sync(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome>;
  /** Throws the index away and builds it again. The answer to every kind of skew. */
  rebuild(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome>;
  /** Deletes the index from disk and forgets the row. */
  remove(target: RepositoryIndexTarget): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** How an agent queries this index, or null when it cannot. Null is not an error. */
  agentMcpConfig(target: RepositoryIndexTarget): Promise<RepositoryIndexQueryServer | null>;
  /**
   * Why the implementation could not answer for this target at all — an
   * absent binary, an unsupported platform — or null when it could
   * (EO-151).
   *
   * A fact about the *machine*, not about the index, and that is the
   * whole reason it is separate from a status. Every status this table
   * holds describes something EO recorded about a build: not indexed
   * yet, being indexed, failed, stale. None of them can say "there is
   * nothing here that could ever index anything", and on an Intel Mac
   * — where upstream publishes no build at all — that is the only true
   * sentence there is.
   *
   * Without it a dispatch on such a machine is told its index "has not
   * been built yet", which sends a person to add a pipeline step that
   * would fail every time it ran. Asked here, through the port, because
   * a caller may not reach past it to find out.
   *
   * Reads only, and never blocks: the answer is a sentence to put in a
   * comment, and a caller that gets one still dispatches its agent.
   */
  unavailableReason(target: RepositoryIndexTarget): Promise<string | null>;
  /**
   * Moves a row from one status to the next, refusing anything the
   * transition table does not allow.
   *
   * Public because the pipeline step that does the indexing reports its
   * own progress, and because a state machine nobody can drive directly
   * is a state machine nobody can test.
   */
  setStatus(target: RepositoryIndexTarget, to: RepositoryIndexStatus, patch?: Omit<RepositoryIndexPatch, "status">): RepositoryIndexOutcome;
  /**
   * Records that this target has no usable index and why, without a
   * build ever having been attempted.
   *
   * The case is a machine that cannot index at all — an unsupported
   * platform, a binary that would not download — where there is nothing
   * to run and so nothing for `ensureIndexed` to report on. Left
   * unrecorded, those are the installations that show "not indexed"
   * forever with no account of why, on every repository, and the only
   * explanation a person ever gets is a comment on whichever item
   * happened to be dispatched. A row is where that sentence belongs:
   * it is per repository, it survives the run, and the status screen
   * reads it.
   *
   * `failed` rather than a status of its own. It is the same thing as
   * far as every reader is concerned — no index, here is the reason,
   * a rebuild is the way out — and `not_indexed -> failed` is legal in
   * the transition table precisely because a failure can arrive before
   * any build does.
   */
  recordUnavailable(target: RepositoryIndexTarget, reason: string): Promise<RepositoryIndexOutcome>;
}

export interface RepositoryIntelligenceServiceDeps {
  db: Db;
  provider: RepositoryIntelligenceProvider;
  /** Injectable so a test can assert on `indexedAt` without racing the clock. */
  now?: () => number;
}

export function createRepositoryIntelligenceService(deps: RepositoryIntelligenceServiceDeps): RepositoryIntelligenceService {
  const { db, provider } = deps;
  const now = deps.now ?? (() => Date.now());

  function describe(target: RepositoryIndexTarget): RepositoryIndex | undefined {
    return getRepositoryIndex(db, { workspaceId: target.workspaceId, itemId: target.itemId });
  }

  function setStatus(
    target: RepositoryIndexTarget,
    to: RepositoryIndexStatus,
    patch: Omit<RepositoryIndexPatch, "status"> = {},
  ): RepositoryIndexOutcome {
    const row = describe(target);
    if (!row) return { ok: false, reason: "EO has no index recorded for this workspace." };
    if (!canTransitionIndex(row.status, to)) return { ok: false, reason: refuseIndexTransition(row.status, to) };

    const updated = setRepositoryIndexStatus(db, row.id, { ...patch, status: to }, now());
    // Only reachable if the row were deleted between the two statements,
    // which nothing on one thread with concurrency at 1 can do.
    if (!updated) return { ok: false, reason: "EO has no index recorded for this workspace." };
    return { ok: true, index: updated };
  }

  /**
   * The row for a target, creating an empty note if there is none.
   *
   * A row exists before the first build starts rather than after it
   * succeeds, so that a build which is interrupted — a crash, a quit —
   * leaves something behind saying it was attempted. The path comes
   * from the provider's probe because the layout is the provider's
   * business, and it is the one field a fresh row cannot be given a
   * placeholder for.
   */
  async function ensureRow(target: RepositoryIndexTarget): Promise<RepositoryIndex> {
    const existing = describe(target);
    if (existing) return existing;

    const probe = await provider.getStatus(target);
    return recordRepositoryIndex(
      db,
      {
        workspaceId: target.workspaceId,
        itemId: target.itemId,
        provider: provider.id,
        indexPath: probe.indexPath,
        status: "not_indexed",
      },
      now(),
    );
  }

  /**
   * Reconciles the row against what the provider can see, and answers
   * with the status a caller should act on.
   *
   * The one place staleness is decided, and it is decided by comparing
   * two strings. A stored `provider_version` that differs from the
   * version resolved on this machine means the graph on disk was built
   * by something that is no longer here, and the answer is a rebuild —
   * never a migration, because an index is derived from the checkout
   * and rebuilding it costs seconds. That is the entire mechanism, and
   * it is why nothing in this codebase will ever have to read the shape
   * of an old index.
   *
   * Three things also resolve as stale, for the same reason and with
   * the same fix:
   *
   * - a row whose `provider` is not the configured implementation. Not
   *   an out-of-date index, somebody else's — and unreadable by the one
   *   now in use;
   * - a `ready` row whose directory is no longer on disk. The note
   *   outlived what it described, which is exactly the case a
   *   filesystem cannot answer on its own and this table exists for;
   * - nothing else. A version that could not be resolved at all is
   *   `null` and is treated as no opinion rather than as skew: a
   *   machine with no binary cannot rebuild, and marking the index
   *   stale there would swap a usable note for a promise EO cannot
   *   keep.
   *
   * Only a `ready` row is escalated. An in-flight row is mid-build and
   * a probe of it says nothing; a `failed` or `stale` row is already
   * headed for a rebuild, and moving it sideways would tell a person
   * their failure had been resolved by something noticing a version
   * number.
   */
  async function resolveStatus(target: RepositoryIndexTarget): Promise<RepositoryIndexStatus> {
    const row = describe(target);
    if (!row) return "not_indexed";
    if (row.status !== "ready") return row.status;

    const probe = await provider.getStatus(target);
    const foreign = row.provider !== provider.id;
    const skewed = probe.providerVersion !== null && row.providerVersion !== probe.providerVersion;
    if (!foreign && !skewed && probe.present) return "ready";

    const moved = setStatus(target, "stale");
    return moved.ok ? moved.index.status : row.status;
  }

  function recordSuccess(
    target: RepositoryIndexTarget,
    to: RepositoryIndexStatus,
    build: {
      indexPath: string;
      providerVersion: string | null;
      indexedCommitSha: string | null;
      durationMs?: number;
      changedFileCount?: number;
      indexSizeBytes?: number;
    },
    /**
     * Whether what just finished was a sync, and so whether its cost is
     * the cost EO-153 asked to be recorded.
     *
     * Passed in rather than inferred from what the build reported. A
     * provider that measured itself on an initial index would otherwise
     * have that duration filed under `last_sync_*`, and the measurement
     * story would be comparing a build from nothing against a handover
     * without being able to tell which was which.
     */
    measured: boolean,
  ): RepositoryIndexOutcome {
    return setStatus(target, to, {
      // Whoever just built it is what the directory now holds, so the
      // row is made to say so. Nearly always a no-op, and load-bearing
      // in the one case that is not: a row built by a previous
      // implementation resolves as stale, gets rebuilt by the
      // configured one, and would go on naming the old one — stale
      // again on the very next resolution, and never queryable, however
      // many times it was rebuilt.
      provider: provider.id,
      indexPath: build.indexPath,
      providerVersion: build.providerVersion,
      indexedCommitSha: build.indexedCommitSha,
      indexedAt: now(),
      // Cleared on the way through, so a row that says `ready` never
      // also carries the sentence explaining why it once did not.
      errorMessage: null,
      // Only what a sync reported, and only the fields it reported
      // (EO-153). Omitting rather than nulling is what lets a sync that
      // measured nothing leave the last real measurement standing, and
      // it is why `changedFileCount: 0` — a handover where nothing had
      // changed, which is a genuine and interesting answer — still gets
      // written rather than being mistaken for "not reported".
      ...(measured && build.durationMs !== undefined ? { lastSyncDurationMs: build.durationMs } : {}),
      ...(measured && build.changedFileCount !== undefined ? { lastSyncChangedFiles: build.changedFileCount } : {}),
      // The same duration under the other name when it was not a sync
      // (EO-155). `measured` already draws the line the row needs and it
      // is drawn here rather than by the provider for the reason it was
      // introduced: a provider that measured itself cannot know which of
      // the two costs the service asked it for, and a duration filed
      // under the wrong one is worse than no duration at all.
      ...(!measured && build.durationMs !== undefined ? { lastIndexDurationMs: build.durationMs } : {}),
      // Written by both, because it is what the directory measures now
      // rather than what this call cost.
      ...(build.indexSizeBytes === undefined ? {} : { indexSizeBytes: build.indexSizeBytes }),
    });
  }

  /**
   * The shape every build-like call has: claim the row, do the work,
   * record what happened.
   *
   * Claiming first is what makes concurrency safe while it stays at 1
   * (invariant #10) — a second call arriving mid-build is refused by
   * the transition table rather than by a lock, and gets a sentence
   * saying the index is already being built.
   *
   * A build that fell over is two separate facts and they must not be
   * confused. Writing the failure to the row *succeeds* — it is a legal
   * move, and recording it is exactly what should happen. The
   * operation the caller asked for did not. Returning the transition's
   * own outcome would report the first and hide the second, handing
   * back `{ ok: true }` with a row that says the work failed; a caller
   * reading only `ok` would then dispatch an agent against an index that
   * does not exist. So the failure is persisted and the *reason* is
   * returned.
   *
   * `failedAs` is where an update parts company with a build (EO-153).
   * A build from nothing that fell over leaves no index, which is
   * `failed`; an update that fell over leaves the one that was already
   * there, describing a checkout that has since moved on, which is
   * `stale`. Same reason recorded either way, same fix — a rebuild — and
   * the difference is what a reader is told is on their disk.
   */
  async function run(
    target: RepositoryIndexTarget,
    inFlight: RepositoryIndexStatus,
    failedAs: RepositoryIndexStatus,
    work: (target: RepositoryIndexTarget) => Promise<Awaited<ReturnType<RepositoryIntelligenceProvider["initialize"]>>>,
  ): Promise<RepositoryIndexOutcome> {
    const claimed = setStatus(target, inFlight);
    if (!claimed.ok) return claimed;

    const build = await work(target);
    if (build.ok) return recordSuccess(target, "ready", build, inFlight === "updating");

    // Deliberately not checking this write's own outcome. Each in-flight
    // status this is reached from may legally reach the failure status
    // its caller paired it with, so a refusal here would be a programmer
    // error in the transition table rather than something the caller
    // could act on, and the provider's sentence is the more useful
    // answer either way.
    setStatus(target, failedAs, { errorMessage: build.reason });
    return { ok: false, reason: build.reason };
  }

  async function ensureIndexed(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome> {
    await ensureRow(target);
    if ((await resolveStatus(target)) === "ready") {
      const ready = describe(target);
      return ready ? { ok: true, index: ready } : { ok: false, reason: "EO has no index recorded for this workspace." };
    }
    return run(target, "indexing", "failed", (it) => provider.ensureReady(it));
  }

  async function sync(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome> {
    // Through `resolveStatus` rather than straight off the row: a sync
    // is a handover, and handing a reviewer an index built by a binary
    // that is no longer installed is the failure this feature is
    // supposed to make impossible. A stale row falls through to the
    // transition table, which refuses `stale` -> `updating` and says
    // that a rebuild is the way out.
    await resolveStatus(target);
    return run(target, "updating", "stale", (it) => provider.sync(it));
  }

  async function rebuild(target: RepositoryIndexTarget): Promise<RepositoryIndexOutcome> {
    await ensureRow(target);
    return run(target, "indexing", "failed", (it) => provider.rebuild(it));
  }

  /**
   * The row for a target that cannot be indexed on this machine.
   *
   * Deliberately not routed through `run`: there is no work to do and
   * no in-flight status to claim, so pretending to start something in
   * order to fail it would put a fictional `indexing` on the row for
   * the duration of a write.
   */
  async function recordUnavailable(target: RepositoryIndexTarget, reason: string): Promise<RepositoryIndexOutcome> {
    const row = await ensureRow(target);
    // Already failed, and saying so again is not a transition the table
    // allows. The reason is refreshed instead, because the second
    // attempt's account of what is missing is the current one.
    if (row.status === "failed") {
      const updated = setRepositoryIndexStatus(db, row.id, { status: "failed", errorMessage: reason }, now());
      return updated ? { ok: true, index: updated } : { ok: false, reason };
    }
    return setStatus(target, "failed", { errorMessage: reason });
  }

  async function remove(target: RepositoryIndexTarget): Promise<{ ok: true } | { ok: false; reason: string }> {
    const row = describe(target);
    const removed = await provider.remove(target);
    // The row outlives a failed removal on purpose. A directory EO
    // cannot delete is still there, and forgetting the note would leave
    // it as an index of unknown provenance that the next build would
    // have to guess about.
    if (!removed.ok) return removed;
    if (row) deleteRepositoryIndex(db, row.id);
    return { ok: true };
  }

  /**
   * Null unless the index is ready, and null is not an error.
   *
   * The gate for graceful degradation: a caller that gets null hands
   * its agent the filesystem and git tools it has always had, says so
   * in a comment, and dispatches. Asked through `resolveStatus` so an
   * index that has quietly gone stale is not offered to an agent as if
   * it described the code in front of it.
   */
  async function agentMcpConfig(target: RepositoryIndexTarget): Promise<RepositoryIndexQueryServer | null> {
    if ((await resolveStatus(target)) !== "ready") return null;
    return provider.getAgentMcpConfig(target);
  }

  /**
   * The provider's own account of why it cannot answer, passed through
   * unchanged.
   *
   * A pass-through rather than an interpretation, because this is the
   * one thing in this file the service has no standing to judge: whether
   * a machine can run the implementation at all is the
   * implementation's business, and a service that second-guessed it
   * would be a second place to be wrong about somebody's platform.
   *
   * It probes, which on the case it exists for costs nothing — a
   * provider with no binary to resolve answers from the filesystem and
   * starts no process. Where a binary *is* present the probe is what it
   * always was, and the answer is null, so this adds a sentence on the
   * degraded path and nothing on the ordinary one.
   */
  async function unavailableReason(target: RepositoryIndexTarget): Promise<string | null> {
    return (await provider.getStatus(target)).unavailableReason;
  }

  return { describe, resolveStatus, ensureIndexed, sync, rebuild, remove, agentMcpConfig, unavailableReason, setStatus, recordUnavailable };
}
