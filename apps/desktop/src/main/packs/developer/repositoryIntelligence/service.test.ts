import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepositoryIndexStatusSchema, type RepositoryIndexStatus, type Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import { getRepositoryIndex, listRepositoryIndexes, recordRepositoryIndex } from "../../../db/repos/repositoryIndexesRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type {
  RepositoryIndexBuild,
  RepositoryIndexProbe,
  RepositoryIndexQueryServer,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "./port.js";
import { createRepositoryIntelligenceService } from "./service.js";
import { LEGAL_INDEX_TRANSITIONS } from "./transitions.js";

/**
 * The service, against the real migrations in an in-memory database
 * (EO-145).
 *
 * Two claims are being made here and they are separable. One is that
 * the status machine is exactly the table and nothing else — every
 * legal move written, every illegal one refused with the row left
 * alone. The other is that skew resolves by rebuilding: a stored
 * version that no longer matches the resolved binary marks the row
 * stale and nothing reads, converts or migrates the index itself.
 */

const ALL_STATUSES = RepositoryIndexStatusSchema.options;

/**
 * A provider that does nothing but answer.
 *
 * Written here rather than shipped beside the port, because it is a
 * table of literals and a call log — nothing a second test file would
 * want differently. The day it needs behaviour rather than answers is
 * the day the port has grown a shape it should not have.
 */
function fakeProvider(overrides: Partial<Omit<RepositoryIntelligenceProvider, "id">> & { id?: string } = {}): RepositoryIntelligenceProvider & {
  calls: string[];
} {
  const calls: string[] = [];
  const probe: RepositoryIndexProbe = { present: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", unavailableReason: null };
  const built: RepositoryIndexBuild = { ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123" };
  const server: RepositoryIndexQueryServer | null = { name: "repo", command: "/bin/index", args: ["serve"], env: {} };

  const answers = {
    initialize: async (): Promise<RepositoryIndexBuild> => built,
    sync: async (): Promise<RepositoryIndexBuild> => built,
    getStatus: async (): Promise<RepositoryIndexProbe> => probe,
    ensureReady: async (): Promise<RepositoryIndexBuild> => built,
    getAgentMcpConfig: async (): Promise<RepositoryIndexQueryServer | null> => server,
    rebuild: async (): Promise<RepositoryIndexBuild> => built,
    remove: async (): Promise<RepositoryIndexRemoval> => ({ ok: true }),
    ...overrides,
  };

  // Every method is wrapped, overrides included. A call log that only
  // recorded the defaults would go quiet exactly where a test had
  // bothered to say what the provider answers, which is the half of it
  // worth watching.
  const watch =
    <R>(name: string, answer: (target: RepositoryIndexTarget) => Promise<R>) =>
    async (target: RepositoryIndexTarget): Promise<R> => {
      calls.push(name);
      return answer(target);
    };

  return {
    calls,
    id: overrides.id ?? "example",
    initialize: watch("initialize", answers.initialize),
    sync: watch("sync", answers.sync),
    getStatus: watch("getStatus", answers.getStatus),
    ensureReady: watch("ensureReady", answers.ensureReady),
    getAgentMcpConfig: watch("getAgentMcpConfig", answers.getAgentMcpConfig),
    rebuild: watch("rebuild", answers.rebuild),
    remove: watch("remove", answers.remove),
  };
}

let handle: DbHandle;
let target: RepositoryIndexTarget;

beforeEach(() => {
  handle = openMigratedTestDb();
  const repo = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api", baseBranch: "main" });
  const story = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repo.id });
  target = { workspaceId: repo.id, itemId: story.id, workspacePath: "/tmp/worktrees/API-1" };
});

afterEach(() => {
  handle.close();
});

function service(provider = fakeProvider(), now = () => 5_000) {
  return createRepositoryIntelligenceService({ db: handle.db, provider, now });
}

/** Seeds a row directly, so a test can start from a status no legal move would reach it by. */
function seed(status: RepositoryIndexStatus, providerVersion: string | null = "1.0.0", provider = "example") {
  return recordRepositoryIndex(
    handle.db,
    { workspaceId: target.workspaceId, itemId: target.itemId, provider, indexPath: "/tmp/idx", status, providerVersion },
    1_000,
  );
}

function stored() {
  return getRepositoryIndex(handle.db, { workspaceId: target.workspaceId, itemId: target.itemId });
}

/**
 * Every square of the matrix, against a real row.
 *
 * Exhaustive rather than illustrative, and generated from the table so
 * that adding a status or an edge cannot leave a corner of it untested.
 * Each case asserts the *row*, not the return value: the whole reason
 * the service owns transitions is that nothing else may write one, so a
 * refusal that still wrote would be the failure worth catching.
 */
describe("setStatus covers the transition table and nothing beyond it", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const legal = LEGAL_INDEX_TRANSITIONS[from].includes(to);

      it(`${legal ? "writes" : "refuses"} ${from} -> ${to}`, () => {
        seed(from);

        const outcome = service().setStatus(target, to);

        if (legal) {
          expect(outcome).toMatchObject({ ok: true });
          expect(stored()?.status).toBe(to);
        } else {
          expect(outcome.ok).toBe(false);
          expect(outcome.ok === false && outcome.reason).toContain(`cannot move from ${from} to ${to}`);
          expect(stored()?.status).toBe(from);
        }
      });
    }
  }

  it("refuses a status change for a workspace it has no note about, and writes nothing", () => {
    const outcome = service().setStatus(target, "indexing");

    expect(outcome).toEqual({ ok: false, reason: "EO has no index recorded for this workspace." });
    expect(listRepositoryIndexes(handle.db)).toEqual([]);
  });

  it("moves updated_at and carries the fields belonging to the move", () => {
    seed("indexing");

    const outcome = service().setStatus(target, "ready", { indexedCommitSha: "def456", indexedAt: 5_000, providerVersion: "2.0.0" });

    expect(outcome.ok && outcome.index).toMatchObject({ status: "ready", indexedCommitSha: "def456", indexedAt: 5_000, providerVersion: "2.0.0", updatedAt: 5_000 });
  });
});

/**
 * The acceptance criterion this feature is arranged around: version
 * skew is answered by rebuilding, never by migrating an index.
 */
describe("resolveStatus and version skew", () => {
  it("marks a ready index stale when the stored version differs from the resolved binary", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "abc123", unavailableReason: null }),
    });

    expect(await service(provider).resolveStatus(target)).toBe("stale");
    expect(stored()?.status).toBe("stale");
  });

  /**
   * The other half of the same claim, and the half that is easy to
   * leave untested: nothing touched the index.
   *
   * Marking the row stale is the *entire* mechanism. No conversion, no
   * read of the old graph's shape, not even a call into the provider
   * beyond the probe that spotted the difference — the rebuild happens
   * later, when somebody asks for one.
   */
  it("resolves skew without asking the provider to do anything to the index", async () => {
    const before = seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "abc123", unavailableReason: null }),
    });

    await service(provider).resolveStatus(target);

    expect(provider.calls).toEqual(["getStatus"]);
    expect(stored()).toMatchObject({ indexPath: before.indexPath, providerVersion: "1.0.0", indexedCommitSha: before.indexedCommitSha });
  });

  it("leaves a ready index alone when the versions agree", async () => {
    seed("ready", "1.0.0");

    expect(await service().resolveStatus(target)).toBe("ready");
    expect(stored()?.status).toBe("ready");
  });

  /**
   * A version that could not be resolved is no opinion, not skew.
   *
   * On a machine with no binary — an unsupported platform is a real
   * case here, not a hypothetical one — marking the index stale would
   * swap a usable note for a rebuild EO cannot perform.
   */
  it("does not call an index stale when no version could be resolved at all", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: null, indexedCommitSha: null, unavailableReason: "no build for this platform" }),
    });

    expect(await service(provider).resolveStatus(target)).toBe("ready");
  });

  it("marks a ready index stale when the directory it describes is gone", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: false, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: null, unavailableReason: null }),
    });

    expect(await service(provider).resolveStatus(target)).toBe("stale");
  });

  it("marks an index built by a different implementation stale, whatever its version says", async () => {
    seed("ready", "1.0.0", "somebody-else");

    expect(await service().resolveStatus(target)).toBe("stale");
  });

  /**
   * And the row has to stop being foreign once it has been rebuilt.
   *
   * Without this the diagnosis is permanent: the row keeps naming the
   * implementation that built it *last time*, resolves as stale again
   * on the very next call, and `agentMcpConfig` never offers it — an
   * item that rebuilds its index on every dispatch and never gets to
   * query it, which looks from the outside like an index that silently
   * does nothing.
   */
  it("takes ownership of a foreign row when it rebuilds it, so it does not go stale forever", async () => {
    seed("ready", "1.0.0", "somebody-else");
    const svc = service();
    expect(await svc.resolveStatus(target)).toBe("stale");

    const outcome = await svc.rebuild(target);

    expect(outcome.ok && outcome.index.provider).toBe("example");
    expect(await svc.resolveStatus(target)).toBe("ready");
    expect(await svc.agentMcpConfig(target)).not.toBeNull();
  });

  it("takes ownership through ensureIndexed too", async () => {
    seed("ready", "1.0.0", "somebody-else");
    const svc = service();

    await svc.ensureIndexed(target);

    expect(svc.describe(target)?.provider).toBe("example");
    expect(await svc.resolveStatus(target)).toBe("ready");
  });

  /**
   * Only a ready row is escalated. An in-flight row is mid-build and a
   * probe of it says nothing; a failed or stale row is already headed
   * for a rebuild, and moving it sideways would tell a person their
   * failure had been resolved by a version number.
   */
  it.each(["not_indexed", "indexing", "updating", "stale", "failed"] as const)("leaves a %s row where it is", async (status) => {
    seed(status, "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: false, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: null, unavailableReason: null }),
    });

    expect(await service(provider).resolveStatus(target)).toBe(status);
  });

  it("reads as not_indexed when EO has no note at all", async () => {
    expect(await service().resolveStatus(target)).toBe("not_indexed");
  });
});

describe("ensureIndexed", () => {
  it("records a build from nothing, and what built it", async () => {
    const provider = fakeProvider();

    const outcome = await service(provider).ensureIndexed(target);

    expect(provider.calls).toContain("ensureReady");
    expect(outcome.ok && outcome.index).toMatchObject({
      status: "ready",
      provider: "example",
      indexPath: "/tmp/idx",
      providerVersion: "1.0.0",
      indexedCommitSha: "abc123",
      indexedAt: 5_000,
      errorMessage: null,
    });
  });

  /**
   * A build that fell over is an outcome, not an exception — and it is
   * two facts, not one.
   *
   * Writing `failed` to the row succeeds: it is a legal move and
   * recording the failure is exactly what should happen. The operation
   * the caller asked for did not succeed, and that is what `ok` has to
   * report. Reporting the transition instead would hand back
   * `{ ok: true }` over a row that says `failed`, and a caller reading
   * only `ok` would dispatch an agent against an index that does not
   * exist.
   */
  it("reports the failure to the caller and records it on the row", async () => {
    const provider = fakeProvider({ ensureReady: async () => ({ ok: false, reason: "no build for this platform" }) });

    const outcome = await service(provider).ensureIndexed(target);

    expect(outcome).toEqual({ ok: false, reason: "no build for this platform" });
    expect(stored()).toMatchObject({ status: "failed", errorMessage: "no build for this platform" });
  });

  it("does nothing when the index is already ready", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider();

    const outcome = await service(provider).ensureIndexed(target);

    expect(outcome.ok && outcome.index.status).toBe("ready");
    expect(provider.calls).toEqual(["getStatus"]);
  });

  it("builds again when the index it finds has gone stale", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "abc123", unavailableReason: null }),
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "def456" }),
    });

    const outcome = await service(provider).ensureIndexed(target);

    expect(outcome.ok && outcome.index).toMatchObject({ status: "ready", providerVersion: "2.0.0", indexedCommitSha: "def456" });
  });
});

describe("sync", () => {
  it("takes a ready index through updating and back", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({ sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456" }) });

    const outcome = await service(provider).sync(target);

    expect(outcome.ok && outcome.index).toMatchObject({ status: "ready", indexedCommitSha: "def456" });
  });

  /**
   * A handover is the worst moment to hand a reviewer an index built by
   * a binary that is no longer installed, so `sync` resolves staleness
   * first and then runs into the transition table, which says what to
   * do about it.
   */
  it("refuses to sync an index that has gone stale, and says a rebuild is the way out", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "abc123", unavailableReason: null }),
    });

    const outcome = await service(provider).sync(target);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("An index cannot move from stale to updating. From stale the legal moves are: indexing.");
    expect(provider.calls).not.toContain("sync");
  });

  /**
   * A sync that fell over leaves `stale`, not `failed` (EO-153).
   *
   * The distinction is what a reader is told is on their disk. Nothing
   * un-built the index the sync was updating — that directory is still
   * there, describing the checkout as it was a moment ago — so `failed`,
   * which means "there is no index here", would send somebody looking
   * for something that is in front of them. `stale` says the true
   * thing: there is one and it can no longer be trusted. Both route to
   * the same fix, so being accurate costs nothing.
   */
  it("reports a failed sync to the caller and leaves the index stale rather than failed", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({ sync: async () => ({ ok: false, reason: "the worktree moved" }) });

    const outcome = await service(provider).sync(target);

    expect(outcome).toEqual({ ok: false, reason: "the worktree moved" });
    expect(stored()).toMatchObject({ status: "stale", errorMessage: "the worktree moved" });
  });

  /**
   * The numbers the measurement story reads (EO-153).
   *
   * Recorded as the syncs happen rather than derived afterwards,
   * because a measurement retrofitted later is a measurement of
   * whatever survived. A count of zero is written like any other — a
   * handover where nothing had changed is a genuine answer, and one
   * that read back as "never measured" would be indistinguishable from
   * a sync that never ran.
   */
  it("records what the sync cost on the row", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456", durationMs: 812, changedFileCount: 4 }),
    });

    await service(provider).sync(target);

    expect(stored()).toMatchObject({ lastSyncDurationMs: 812, lastSyncChangedFiles: 4 });
  });

  it("records a sync that found nothing to do, rather than leaving it looking unmeasured", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456", durationMs: 30, changedFileCount: 0 }),
    });

    await service(provider).sync(target);

    expect(stored()).toMatchObject({ lastSyncDurationMs: 30, lastSyncChangedFiles: 0 });
  });

  /**
   * A build from nothing is not a sync, and must not be filed as one.
   *
   * `changedFileCount` is absent from an initial build on purpose —
   * there "changed" means "all of them" and answers nothing anyone
   * asked — so a duration recorded under `last_sync_*` would leave the
   * measurement story comparing a cold index against a handover with no
   * way to tell which was which.
   */
  it("leaves the sync measurements alone when the index is built rather than updated", async () => {
    seed("not_indexed", null);
    const provider = fakeProvider({
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", durationMs: 9_000 }),
    });

    await service(provider).ensureIndexed(target);

    expect(stored()).toMatchObject({ status: "ready", lastSyncDurationMs: null, lastSyncChangedFiles: null });
  });

  /**
   * The other half of the same duration, under the name that says which
   * one it is (EO-155).
   *
   * The test above pins that a build does not write the sync's columns;
   * this pins that its cost is not simply dropped on the floor, which is
   * what happened between EO-153 and here. The provider measures both
   * calls and cannot know which the service asked for, so the service
   * is what files the number — and the two columns are what let a
   * report say "seconds once, milliseconds per handover" rather than
   * averaging the two into a figure that describes neither.
   */
  it("records what a build from nothing cost, under a name a sync cannot be confused with", async () => {
    seed("not_indexed", null);
    const provider = fakeProvider({
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", durationMs: 9_000 }),
    });

    await service(provider).ensureIndexed(target);

    expect(stored()).toMatchObject({ lastIndexDurationMs: 9_000, lastSyncDurationMs: null });
  });

  it("leaves the build duration standing when a sync goes through afterwards", async () => {
    seed("not_indexed", null);
    const built = fakeProvider({
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", durationMs: 9_000 }),
    });
    await service(built).ensureIndexed(target);

    const synced = fakeProvider({
      sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456", durationMs: 41, changedFileCount: 2 }),
    });
    await service(synced).sync(target);

    expect(stored()).toMatchObject({ lastIndexDurationMs: 9_000, lastSyncDurationMs: 41 });
  });

  /**
   * The size is a property of the directory, not a cost of the call.
   *
   * So both moves refresh it, and a sync that added ten thousand
   * symbols is allowed to say the index got bigger. Recorded rather
   * than measured on demand because the directory lives inside an
   * item's worktree: by the time anybody reads a finished item's
   * numbers, the path on that row points at nothing.
   */
  it("records the size the provider reported, on a build and on a sync alike", async () => {
    seed("not_indexed", null);
    const built = fakeProvider({
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", durationMs: 9_000, indexSizeBytes: 51_781_632 }),
    });
    await service(built).ensureIndexed(target);
    expect(stored()).toMatchObject({ indexSizeBytes: 51_781_632 });

    const synced = fakeProvider({
      sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456", durationMs: 41, changedFileCount: 2, indexSizeBytes: 52_000_000 }),
    });
    await service(synced).sync(target);
    expect(stored()).toMatchObject({ indexSizeBytes: 52_000_000 });
  });

  /**
   * A provider that did not say leaves what was there.
   *
   * Null means "nobody measured", and an implementation that cannot
   * answer — or whose measurement raced a deletion — must not overwrite
   * a real figure with a zero that would read as an empty index.
   */
  it("leaves the recorded size alone when the provider reported none", async () => {
    seed("not_indexed", null);
    const built = fakeProvider({
      ensureReady: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "abc123", indexSizeBytes: 4_096 }),
    });
    await service(built).ensureIndexed(target);

    const silent = fakeProvider({
      sync: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: "def456", durationMs: 41, changedFileCount: 0 }),
    });
    await service(silent).sync(target);

    expect(stored()).toMatchObject({ indexSizeBytes: 4_096 });
  });
});

describe("rebuild", () => {
  it("takes a stale index back to ready on the resolved version", async () => {
    seed("stale", "1.0.0");
    const provider = fakeProvider({ rebuild: async () => ({ ok: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "def456" }) });

    const outcome = await service(provider).rebuild(target);

    expect(provider.calls).toContain("rebuild");
    expect(outcome.ok && outcome.index).toMatchObject({ status: "ready", providerVersion: "2.0.0", errorMessage: null });
  });

  it("clears the sentence a failure left behind", async () => {
    seed("failed", "1.0.0");
    const provider = fakeProvider();

    await service(provider).rebuild(target);

    expect(stored()).toMatchObject({ status: "ready", errorMessage: null });
  });

  it("reports a failed rebuild to the caller and records it on the row", async () => {
    seed("stale", "1.0.0");
    const provider = fakeProvider({ rebuild: async () => ({ ok: false, reason: "the index binary is not available" }) });

    const outcome = await service(provider).rebuild(target);

    expect(outcome).toEqual({ ok: false, reason: "the index binary is not available" });
    expect(stored()).toMatchObject({ status: "failed", errorMessage: "the index binary is not available" });
  });

  it("refuses to start a second build over one already running", async () => {
    seed("indexing");

    const outcome = await service().rebuild(target);

    expect(outcome.ok).toBe(false);
    expect(stored()?.status).toBe("indexing");
  });
});

describe("remove", () => {
  it("deletes the index from disk and forgets the note", async () => {
    seed("ready");
    const provider = fakeProvider();

    expect(await service(provider).remove(target)).toEqual({ ok: true });
    expect(provider.calls).toContain("remove");
    expect(stored()).toBeUndefined();
  });

  /**
   * A directory EO could not delete is still there. Forgetting the note
   * would leave it as an index of unknown provenance that the next
   * build would have to guess about.
   */
  it("keeps the note when the directory could not be deleted", async () => {
    seed("ready");
    const provider = fakeProvider({ remove: async () => ({ ok: false, reason: "permission denied" }) });

    expect(await service(provider).remove(target)).toEqual({ ok: false, reason: "permission denied" });
    expect(stored()).toBeDefined();
  });
});

/**
 * Graceful degradation, at the one place it is decided.
 *
 * Null is not an error and every caller must handle it: an agent whose
 * index is missing, mid-build or stale runs with the filesystem and git
 * tools it has always had.
 */
describe("agentMcpConfig", () => {
  it("offers the query server when the index is ready", async () => {
    seed("ready", "1.0.0");

    expect(await service().agentMcpConfig(target)).toEqual({ name: "repo", command: "/bin/index", args: ["serve"], env: {} });
  });

  it.each(["not_indexed", "indexing", "updating", "stale", "failed"] as const)("offers nothing while the index is %s", async (status) => {
    seed(status, "1.0.0");

    expect(await service().agentMcpConfig(target)).toBeNull();
  });

  it("offers nothing when the index has quietly gone stale under a ready row", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: true, indexPath: "/tmp/idx", providerVersion: "2.0.0", indexedCommitSha: "abc123", unavailableReason: null }),
    });

    expect(await service(provider).agentMcpConfig(target)).toBeNull();
  });

  /**
   * The question EO-174 asked to have settled rather than assumed.
   *
   * A stored `ready` about a directory that is gone is exactly the
   * claim that could hand an agent an index that is not there — a
   * finished item's worktree takes its index with it, and until
   * EO-174 the row describing it outlived both. It cannot, and this is
   * why: every read goes through `resolveStatus`, which probes before
   * it answers, so the row is corrected on the way past and no server
   * is offered. Deleting the record with the worktree is what stops it
   * being in a position to mislead in the first place; this is the
   * belt underneath it, and it is asserted rather than argued.
   */
  it("offers nothing when the directory a ready row describes is no longer on disk", async () => {
    seed("ready", "1.0.0");
    const provider = fakeProvider({
      getStatus: async () => ({ present: false, indexPath: "/tmp/idx", providerVersion: "1.0.0", indexedCommitSha: null, unavailableReason: null }),
    });

    expect(await service(provider).agentMcpConfig(target)).toBeNull();
    // Corrected on the way past, so the next reader is not told the
    // same thing again.
    expect(stored()?.status).toBe("stale");
    // And never asked for a server it could not have opened.
    expect(provider.calls).not.toContain("getAgentMcpConfig");
  });

  it("offers nothing when EO has no note about the workspace at all", async () => {
    expect(await service().agentMcpConfig(target)).toBeNull();
  });
});

/**
 * The one question a status cannot answer (EO-151).
 *
 * Every status in this table describes something EO recorded about a
 * *build* — not indexed yet, being indexed, failed, stale. None of them
 * can say "this machine has nothing that could ever index anything", and
 * on a platform upstream publishes no build for that is the only true
 * sentence there is. Asked through the port, because a caller above the
 * service may not reach past it to find out.
 */
describe("unavailableReason", () => {
  it("passes the provider's account through unchanged", async () => {
    const provider = fakeProvider({
      getStatus: async () => ({
        present: false,
        indexPath: "/tmp/idx",
        providerVersion: null,
        indexedCommitSha: null,
        unavailableReason: "EO has no build of the repository indexer for darwin-x64.",
      }),
    });

    // Unchanged rather than reworded: whether a machine can run the
    // implementation is the implementation's business, and a service
    // that paraphrased it would be a second place to be wrong about
    // somebody's platform.
    expect(await service(provider).unavailableReason(target)).toBe("EO has no build of the repository indexer for darwin-x64.");
  });

  it("answers null on a machine that can run the implementation", async () => {
    expect(await service().unavailableReason(target)).toBeNull();
  });

  it("answers without needing a row, which is the case it exists for", async () => {
    // No row at all: nothing has been attempted, because nothing on this
    // machine could attempt it. A caller with only the table to read
    // would have to call that "not indexed yet".
    const provider = fakeProvider({
      getStatus: async () => ({
        present: false,
        indexPath: "/tmp/idx",
        providerVersion: null,
        indexedCommitSha: null,
        unavailableReason: "this platform has no build",
      }),
    });

    expect(service(provider).describe(target)).toBeUndefined();
    expect(await service(provider).unavailableReason(target)).toBe("this platform has no build");
  });

  it("writes nothing — it is a reading, not a transition", async () => {
    const provider = fakeProvider();
    const row = seed("ready", "1.0.0");

    await service(provider).unavailableReason(target);

    expect(service(provider).describe(target)).toEqual(row);
  });
});

describe("describe", () => {
  it("answers with the row exactly as stored, without probing anything", () => {
    const row = seed("ready", "1.0.0");
    const provider = fakeProvider();

    expect(service(provider).describe(target)).toEqual(row);
    expect(provider.calls).toEqual([]);
  });

  it("answers with undefined for a workspace that has never been indexed", () => {
    expect(service().describe(target)).toBeUndefined();
  });
});

/** The branded id the repository layer hands back is the one the target carries. */
describe("targets", () => {
  it("keeps two items in one repository apart", async () => {
    const other = createTestItem(handle.db, { type: "story", title: "Another", stepId: "todo", workspaceId: target.workspaceId as Uuid });
    const otherTarget: RepositoryIndexTarget = { ...target, itemId: other.id, workspacePath: "/tmp/worktrees/API-2" };
    const svc = service();

    await svc.ensureIndexed(target);

    expect(svc.describe(target)?.status).toBe("ready");
    expect(svc.describe(otherTarget)).toBeUndefined();
  });
});

describe("recordUnavailable", () => {
  it("writes a failed row carrying the reason when no build was ever attempted", async () => {
    // The Intel Mac case: nothing to run, so `ensureIndexed` never gets
    // a chance to record anything, and without this the installation
    // reads as "not indexed" forever with no account of why.
    const outcome = await service().recordUnavailable(target, "CodeWiki publishes no build for Intel Macs (darwin x64).");

    expect(outcome.ok).toBe(true);
    const row = getRepositoryIndex(handle.db, { workspaceId: target.workspaceId, itemId: target.itemId });
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("darwin x64");
  });

  it("refreshes the reason on a row that already failed, rather than refusing the move", async () => {
    // `failed -> failed` is not in the transition table, and it should
    // not be: a state machine that lets a status move to itself is one
    // that cannot tell a change from a repeat. But every dispatch on an
    // unindexable machine comes back here, and the current account of
    // what is missing is the one worth keeping.
    seed("failed");
    await service().recordUnavailable(target, "The download was refused.");
    const again = await service().recordUnavailable(target, "CodeWiki publishes no build for this machine.");

    expect(again.ok).toBe(true);
    const row = getRepositoryIndex(handle.db, { workspaceId: target.workspaceId, itemId: target.itemId });
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toBe("CodeWiki publishes no build for this machine.");
  });

  it("leaves a ready index alone rather than tearing it down over a resolution that failed", async () => {
    // A binary that has gone missing does not make the graph on disk
    // wrong, and `ready -> failed` is not a legal move. The refusal is
    // the correct answer and the row keeps describing what is there.
    seed("ready");
    const outcome = await service().recordUnavailable(target, "The binary is gone.");

    expect(outcome.ok).toBe(false);
    expect(getRepositoryIndex(handle.db, { workspaceId: target.workspaceId, itemId: target.itemId })?.status).toBe("ready");
  });
});
