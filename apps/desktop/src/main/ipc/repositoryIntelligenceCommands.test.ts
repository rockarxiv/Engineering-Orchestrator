import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER, ipcContract } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRun, getRepositoryIndex, listActiveRuns, listCommentsForItem, updateRun } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type {
  RepositoryIndexBuild,
  RepositoryIndexProbe,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "../packs/developer/repositoryIntelligence/index.js";
import { createRepositoryIntelligenceService } from "../packs/developer/repositoryIntelligence/index.js";
import { createItemLock, type ItemHold, type ItemLock } from "../supervisor/itemLock.js";
import {
  initializeRepositoryIndexCommand,
  rebuildRepositoryIndexCommand,
  repositoryIntelligenceStatusCommand,
  syncRepositoryIndexCommand,
  type RepositoryIntelligenceContext,
} from "./repositoryIntelligenceCommands.js";

/**
 * The status screen's channels, at the layer that answers them (EO-154).
 *
 * What is exercised here is everything that happens *around* an index —
 * which rows the screen is shown, which operations are refused and what
 * they say when they are. The recovery itself, against a real index on a
 * real disk, is `rebuildRecovery.test.ts`, which lives beside the
 * implementation because breaking an index means knowing what one is.
 * This file deliberately has no implementation behind it at all, which
 * is how it stays a test of the command layer rather than of an indexer
 * — and why it can be read, like the port, without learning what is
 * underneath.
 *
 * The stand-in provider below is not a mock of the port so much as the
 * smallest honest implementation of it: it says an index is present once
 * it has built one, and it does nothing to disk. Nothing here asserts on
 * calls made to it — a test that checks a spy was called proves the code
 * was written, not that it works — so it exists only to give the service
 * something to talk to.
 */

/** A provider that keeps its whole index in memory and touches nothing. */
function stubProvider(overrides: Partial<RepositoryIntelligenceProvider> = {}): RepositoryIntelligenceProvider {
  let present = false;
  const probe = (target: RepositoryIndexTarget): RepositoryIndexProbe => ({
    present,
    indexPath: join(target.workspacePath, ".index"),
    providerVersion: "1.0.0",
    indexedCommitSha: present ? "0123456789abcdef" : null,
    unavailableReason: null,
  });
  const build = async (target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> => {
    present = true;
    return { ok: true, indexPath: probe(target).indexPath, providerVersion: "1.0.0", indexedCommitSha: "0123456789abcdef" };
  };

  return {
    id: "stub",
    initialize: build,
    sync: build,
    ensureReady: build,
    rebuild: build,
    getStatus: async (target) => probe(target),
    getAgentMcpConfig: async () => null,
    remove: async (): Promise<RepositoryIndexRemoval> => {
      present = false;
      return { ok: true };
    },
    ...overrides,
  };
}

let handle: DbHandle | undefined;
let worktreeRoot: string;
/**
 * One provider for the whole test, because a provider is stateful.
 *
 * `context()` is called several times in a test — once per press — and
 * the production factory builds a fresh runtime each time too. What it
 * does *not* do is build a fresh index: a new stand-in per call would
 * forget it had ever built one, and every second press would find a row
 * saying `ready` over an index that had vanished, which resolves as
 * stale. That is a real state and it has its own tests; it is not what
 * these are about.
 */
let provider: RepositoryIntelligenceProvider;
/**
 * The claim that decides whether anything is working in a checkout.
 *
 * One per test and shared with the context, because that is the shape in
 * production: the engine's lock, handed to the IPC side so both cannot
 * decide they have the worktree. The tests below take and release it
 * exactly where a dispatch would.
 */
let lock: ItemLock;

beforeEach(() => {
  handle = openMigratedTestDb();
  worktreeRoot = mkdtempSync(join(tmpdir(), "eo-index-commands-"));
  provider = stubProvider();
  lock = createItemLock();
});

afterEach(() => {
  for (const hold of holds.values()) hold();
  holds.clear();
  handle?.close();
  handle = undefined;
  rmSync(worktreeRoot, { recursive: true, force: true });
});

function db(): DbHandle["db"] {
  if (!handle) throw new Error("no database");
  return handle.db;
}

/**
 * A context whose runtime is the stand-in, and whose installation always
 * succeeds.
 *
 * `null` for the factory is how the production one answers when the
 * feature is switched off, so a test of that path passes `null` rather
 * than reaching for a mock of the gate.
 */
function context(
  options: {
    provider?: RepositoryIntelligenceProvider;
    off?: boolean;
    install?: { ok: true } | { ok: false; reason: string };
    engine?: RepositoryIntelligenceContext["engine"];
  } = {},
): RepositoryIntelligenceContext {
  const behind = options.provider ?? provider;
  return {
    root: join(worktreeRoot, "binaries"),
    worktreeRoot,
    itemLock: lock,
    // Short, because these tests prove what happens when a run does or
    // does not let go, not how patient the wait is.
    stopTimeoutMs: 250,
    stopPollMs: 5,
    ...(options.engine ? { engine: options.engine } : {}),
    factory: ({ db: handed }) =>
      options.off === true
        ? null
        : {
            service: createRepositoryIntelligenceService({ db: handed, provider: behind }),
            ensureInstalled: async () => options.install ?? { ok: true },
          },
  };
}

/** Whatever holds an item in a given test, so the fake engine can let go of it. */
const holds = new Map<string, ItemHold>();

/**
 * An engine that ends the run it is asked to cancel, and gives the
 * item back.
 *
 * Both halves, because the supervisor does both: `cancelActiveRun`
 * writes the terminal row, and the dispatch's own `finally` releases the
 * claim as it unwinds. A fake that only did the first would let a test
 * pass over a command that never waits for the checkout to be free.
 *
 * `deaf` models the run that will not let go — the timeout branch — and
 * models it accurately by doing neither.
 *
 * Note what it does *not* do: reach a queued run. `cancelActiveRun`
 * returns early when there is no controller, and a queued row has none.
 * That is the bug this round is about, so the fake reproduces it.
 */
function fakeEngine(options: { deaf?: boolean } = {}) {
  const cancelled: string[] = [];
  /** How each cancellation was classified — see `asked`, below (EO-175). */
  const asked: (string | undefined)[] = [];
  const handle = {
    cancelRun: (runId: string, cancellation?: string) => {
      cancelled.push(runId);
      asked.push(cancellation);
      if (options.deaf) return;
      const run = listActiveRuns(db()).find((active) => active.id === runId);
      // A queued run has no controller in the real supervisor, so
      // cancelling it does nothing at all.
      if (!run || run.status !== "running") return;
      updateRun(db(), runId as Uuid, { status: "cancelled" });
      holds.get(run.itemId)?.();
      holds.delete(run.itemId);
    },
  } as unknown as NonNullable<RepositoryIntelligenceContext["engine"]>;
  return { handle, cancelled, asked };
}

/**
 * A run actually working in an item's checkout.
 *
 * The row *and* the claim, because in production a dispatch holds both —
 * and the claim is the half that means "something is in that worktree".
 */
function runningOn(itemId: Uuid) {
  const agent = createAgent(db(), { name: "implementer", role: "implementer", provider: "claude", instructions: "go" });
  const run = createRun(db(), { itemId, agentId: agent.id, action: "implement", status: "running" });
  const hold = lock.acquire(itemId);
  if (!hold) throw new Error("expected the ticket to be free");
  holds.set(itemId, hold);
  return run;
}

/**
 * A run waiting its turn: a row and no claim.
 *
 * This is the state the reviewer found unhandled. `listActiveRuns`
 * counts it, so the old code treated it as something holding the index —
 * but `cancelRun` cannot reach it, so it could never be stopped, and
 * Rebuild sat out its whole timeout and then refused. It holds nothing:
 * it is a row saying work *should* happen, not a process.
 */
function queuedOn(itemId: Uuid) {
  const agent = createAgent(db(), { name: "implementer", role: "implementer", provider: "claude", instructions: "go" });
  return createRun(db(), { itemId, agentId: agent.id, action: "implement", status: "queued" });
}

/** A repository, an item and a checkout directory named the way EO names one. */
function seed(options: { key?: string; withCheckout?: boolean } = {}) {
  const repository = attachWorkspace(db(), { name: "api", keyPrefix: options.key ?? "EO", repoPath: join(worktreeRoot, "origin"), baseBranch: "main" });
  const item = createTestItem(db(), { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id });
  const workspacePath = join(worktreeRoot, item.key);
  if (options.withCheckout !== false) mkdirSync(workspacePath, { recursive: true });
  return { repository, item, workspacePath, target: { workspaceId: repository.id, itemId: item.id, workspacePath } };
}

function only() {
  const index = repositoryIntelligenceStatusCommand(db(), worktreeRoot).repositories.flatMap((entry) => entry.indexes)[0];
  if (!index) throw new Error("expected the listing to hold an index");
  return index;
}

describe("what the repository intelligence section is shown", () => {
  it("lists a repository that has never been indexed rather than leaving it out", () => {
    // The state a person opening this section is most likely trying to
    // explain. A listing of only what exists cannot express it.
    seed();

    const listed = repositoryIntelligenceStatusCommand(db(), worktreeRoot);

    expect(listed.repositories.map((entry) => ({ name: entry.repositoryName, indexes: entry.indexes.length }))).toEqual([
      { name: "api", indexes: 0 },
    ]);
  });

  it("answers the switch and the statuses together, so one section is one read", () => {
    // The reason there is no channel of its own for this. The switch and
    // what it produced are the same screen, and splitting them would be
    // a second round trip and a fourth verb on a surface the story fixes
    // at three.
    seed();

    const answered = repositoryIntelligenceStatusCommand(db(), worktreeRoot);

    expect(answered.enabled).toBe(false);
    // The constant rather than the string it holds. This file has no
    // business naming an implementation — `importSites.test.ts` enforces
    // exactly that, in prose as well as in imports — and a test that
    // spelled the id out would have to be edited the day it changes.
    expect(answered.provider).toBe(DEFAULT_REPOSITORY_INTELLIGENCE_PROVIDER);
    expect(answered.repositories).toHaveLength(1);
  });

  it("names the item and the checkout an index describes, which the row cannot", async () => {
    const { item, workspacePath, target } = seed();
    const ctx = context();
    await initializeRow(ctx, target);

    const index = only();

    expect({ itemKey: index.itemKey, workspacePath: index.workspacePath, status: index.status }).toEqual({
      itemKey: item.key,
      workspacePath,
      status: "ready",
    });
  });

  it("reports the status, the revision and when the index was last updated", async () => {
    const { target } = seed();
    await initializeRow(context(), target);

    const index = only();

    expect(index.status).toBe("ready");
    expect(index.indexedCommitSha).toBe("0123456789abcdef");
    expect(index.indexedAt).not.toBeNull();
  });

  it("says an index is in use while a run is working in its checkout", async () => {
    const { item, target } = seed();
    await initializeRow(context(), target);
    const agent = createAgent(db(), { name: "implementer", role: "implementer", provider: "claude", instructions: "go" });
    createRun(db(), { itemId: item.id, agentId: agent.id, action: "implement", status: "running" });

    expect(only().inUse).toBe(true);
  });
});

describe("acting on a repository index", () => {
  it("refuses every operation while the switch is off, and says which switch", async () => {
    const { target } = seed();
    await initializeRow(context(), target);
    const id = only().id;
    const off = context({ off: true });

    const results = [
      await initializeRepositoryIndexCommand(db(), off, { id }),
      await syncRepositoryIndexCommand(db(), off, { id }),
      await rebuildRepositoryIndexCommand(db(), off, { id }),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.problem).toContain("switched off");
    }
  });

  it("makes upkeep wait while a run is working in the checkout", async () => {
    // Refresh and Index wait; Rebuild does not, and the tests for that
    // are in "rebuild stops whatever is holding the index" below. EO
    // does not end somebody's run to refresh a cache.
    const { item, target } = seed();
    await initializeRow(context(), target);
    runningOn(item.id);

    const refused = await syncRepositoryIndexCommand(db(), context(), { id: only().id });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("A run is working in that checkout");
  });

  it("records why a machine cannot index at all, so the screen has something to show", async () => {
    // The Intel Mac case, and every other machine upstream publishes
    // nothing for. Without the row there is no account of it anywhere a
    // person looks — only a comment on whichever item came through.
    const { target } = seed();
    const broken = { ...provider, ensureReady: async () => ({ ok: false as const, reason: "The first build fell over." }) };
    const runtime = context({ provider: broken }).factory?.({ db: db() });
    await runtime?.service.ensureIndexed(target);
    expect(only().status).toBe("failed");

    const reason = "Widgetron 4.1 publishes no build for this machine.";
    const refused = await initializeRepositoryIndexCommand(db(), context({ install: { ok: false, reason } }), { id: only().id });

    // EO's sentence on the wire, the implementation's on the row. The
    // screen shows the first and puts the second under Advanced.
    expect(refused.problem).toContain("could not run the indexer on this machine");
    expect(refused.problem).not.toContain("Widgetron");
    expect(only().status).toBe("failed");
    // The current attempt's account, not the one from last time.
    expect(only().errorMessage).toBe(reason);
  });

  it("does not call a usable index failed just because it cannot be refreshed", async () => {
    // The other half of the same path, and the reason the recording is
    // left to the transition table. A `ready` row describes an index
    // that is still on disk and still answers queries; a binary that has
    // gone missing since means EO cannot *update* it, which is a
    // different sentence from "your index is broken".
    const { target } = seed();
    await initializeRow(context(), target);
    const reason = "EO has not downloaded Widgetron 4.1 on this machine yet.";

    const refused = await syncRepositoryIndexCommand(db(), context({ install: { ok: false, reason } }), { id: only().id });

    expect(refused.problem).toContain("could not run the indexer on this machine");
    expect(only().status).toBe("ready");
    expect(only().errorMessage).toBeNull();
  });

  it("answers with the row as it now stands when an operation fails", async () => {
    const { target } = seed();
    await initializeRow(context(), target);
    // The same provider with one method replaced, so it still remembers
    // it built an index — a wholly new one would have forgotten, and the
    // sync would be refused as stale before it ever reached the failure
    // this test is about.
    const failing = { ...provider, sync: async () => ({ ok: false as const, reason: "Widgetron could not read the index." }) };

    const result = await syncRepositoryIndexCommand(db(), context({ provider: failing }), { id: only().id });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("could not update the index");
    // Not the status it had before the press. A screen showing `ready`
    // beside a sentence about a failed update would be two accounts of
    // one event.
    //
    // `stale` rather than `failed`, which is the same distinction the
    // test above this one draws (EO-153): an update that did not work
    // does not un-build the index it was updating. That directory is
    // still on disk and still describes the checkout as it was a moment
    // ago, so the true sentence is "this can no longer be trusted" and
    // not "there is nothing here". Both offer a rebuild as the way out.
    expect(result.index?.status).toBe("stale");
  });

  it("never puts an implementation's own words on the wire, but keeps them on the row", async () => {
    // The structural half of the copy criterion, and the reason it is
    // enforced here rather than trusted to a renderer. An implementation
    // writes its reasons in its own voice and names itself doing it; a
    // channel that passed those through would put that name on the
    // status screen whatever the screen intended. So EO substitutes its
    // own sentence, and the implementation's survives on the row for the
    // debug area to show verbatim.
    const { target } = seed();
    await initializeRow(context(), target);
    const branded = "Widgetron 4.1 left no index at /tmp/nowhere: there is no widget.db in it.";
    const failing = { ...provider, rebuild: async () => ({ ok: false as const, reason: branded }) };

    const result = await rebuildRepositoryIndexCommand(db(), context({ provider: failing }), { id: only().id });

    expect(result.problem).not.toContain("Widgetron");
    expect(result.problem).toContain("could not rebuild the index");
    // Confined, not discarded — this is what Advanced renders.
    expect(only().errorMessage).toBe(branded);
  });

  it("says the same about a refusal EO wrote itself, because those are already its own words", async () => {
    // The other side of the substitution: EO's own refusals — the switch
    // is off, the checkout has gone, a run is using it — are named
    // precisely, because there is no implementation in them to leak and
    // a person can act on the specifics.
    const { target } = seed();
    await initializeRow(context(), target);

    const refused = await syncRepositoryIndexCommand(db(), context({ off: true }), { id: only().id });

    expect(refused.problem).toContain("switched off");
    expect(refused.problem).not.toContain("Advanced");
  });

  it("consults the real switch when nothing injects a runtime, so a screen cannot outrun the gate", async () => {
    // No factory: this is the production wiring, and the flag defaults
    // off. What it proves is that the gate is read *here*, at the press,
    // rather than cached at launch — and that with the feature off this
    // command reaches no binary and no implementation at all.
    const { target } = seed();
    await initializeRow(context(), target);

    const result = await rebuildRepositoryIndexCommand(db(), { root: join(worktreeRoot, "binaries"), worktreeRoot }, { id: only().id });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("switched off");
  });

  it("refuses a row it has no note of, without inventing one", async () => {
    const result = await rebuildRepositoryIndexCommand(db(), context(), { id: "01a00000-0000-7000-8000-000000000000" });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no note of that repository index");
    expect(result.index).toBeNull();
  });

  it("refuses when the checkout has been released, rather than indexing a directory it recreates", async () => {
    const { target, workspacePath } = seed();
    await initializeRow(context(), target);
    rmSync(workspacePath, { recursive: true, force: true });

    const result = await syncRepositoryIndexCommand(db(), context(), { id: only().id });

    expect(result.ok).toBe(false);
    expect(result.problem).toContain("no longer on disk");
  });
});

/**
 * Which action actually works in which status, asked of the real
 * service.
 *
 * This is the authority the settings card's `availableUpkeep` mirrors,
 * and it is here rather than in a renderer test on purpose: a renderer
 * test with a stubbed IPC bridge will happily agree that pressing
 * Refresh sends `syncRepositoryIndex`, which is exactly what it did
 * while that press could only ever come back with "an index cannot move
 * from failed to updating". What matters is whether the *service*
 * accepts it, so that is what is asked.
 */
describe("which action a status can actually take", () => {
  /**
   * Drives the one row into a status through legal moves only.
   *
   * Never by writing the column directly: a fixture that bypassed the
   * transition table could set up a state the table says is impossible,
   * and then this whole file would be asserting about a machine that
   * does not exist.
   */
  async function inStatus(status: "ready" | "stale" | "failed") {
    const { target } = seed();
    const service = context().factory?.({ db: db() })?.service;
    if (!service) throw new Error("expected a service");

    await service.ensureIndexed(target);
    if (status === "stale") service.setStatus(target, "stale");
    if (status === "failed") {
      service.setStatus(target, "indexing");
      service.setStatus(target, "failed", { errorMessage: "Something went wrong." });
    }
    return { target, service };
  }

  it("syncs a ready index, and only a ready index", async () => {
    await inStatus("ready");

    const refreshed = await syncRepositoryIndexCommand(db(), context(), { id: only().id });

    expect({ ok: refreshed.ok, problem: refreshed.problem }).toEqual({ ok: true, problem: null });
  });

  it("refuses to sync a failed index, which is why the card does not offer Refresh for one", async () => {
    // The bug this test exists for: the card offered Refresh on every
    // status except `not_indexed`, so a person looking at a broken index
    // was given a button whose whole effect was to report an illegal
    // transition back at them.
    await inStatus("failed");

    const refreshed = await syncRepositoryIndexCommand(db(), context(), { id: only().id });

    expect(refreshed.ok).toBe(false);
    expect(only().status).toBe("failed");
  });

  it("refuses to sync a stale index, because a new binary must not reason about an old graph", async () => {
    await inStatus("stale");

    const refreshed = await syncRepositoryIndexCommand(db(), context(), { id: only().id });

    expect(refreshed.ok).toBe(false);
  });

  it("rebuilds from failed and from stale, which is the exit the card offers for both", async () => {
    await inStatus("failed");
    const fromFailed = await rebuildRepositoryIndexCommand(db(), context(), { id: only().id });
    expect({ ok: fromFailed.ok, problem: fromFailed.problem }).toEqual({ ok: true, problem: null });

    // And again, from stale, on the row this time in `ready`.
    const service = context().factory?.({ db: db() })?.service;
    const target = { workspaceId: only().workspaceId, itemId: only().itemId, workspacePath: only().workspacePath as string };
    service?.setStatus(target, "stale");
    expect(only().status).toBe("stale");

    const fromStale = await rebuildRepositoryIndexCommand(db(), context(), { id: only().id });
    expect({ ok: fromStale.ok, problem: fromStale.problem }).toEqual({ ok: true, problem: null });
    expect(only().status).toBe("ready");
  });
});

describe("rebuild stops whatever is holding the index", () => {
  it("cancels the run working in the checkout and rebuilds, rather than refusing", async () => {
    // The recovery criterion, end to end. An index gets corrupted *by* a
    // run that died badly, so a Rebuild that a `running` row can switch
    // off is missing exactly when it is needed.
    const { item, target } = seed();
    await initializeRow(context(), target);
    const run = runningOn(item.id);
    const engine = fakeEngine();

    const rebuilt = await rebuildRepositoryIndexCommand(db(), context({ engine: engine.handle }), { id: only().id });

    expect({ ok: rebuilt.ok, problem: rebuilt.problem }).toEqual({ ok: true, problem: null });
    expect(engine.cancelled).toEqual([run.id]);
    expect(only().status).toBe("ready");
    // And classified as what it is (EO-175). A rebuild borrows the
    // checkout and hands it straight back; read as somebody asking for
    // the step to stop, it would end the initiation it interrupted and
    // the item would sit still from here on — the rebuild succeeding
    // turned into the reason nothing happens next.
    expect(engine.asked).toEqual(["superseded"]);
  });

  it("says on the item that it stopped the run, and why", async () => {
    // Invariant #8. Stopping somebody's work is the last thing that
    // should happen silently, and a transcript where a run simply dies
    // is a transcript nobody can account for.
    const { item, target } = seed();
    await initializeRow(context(), target);
    runningOn(item.id);

    await rebuildRepositoryIndexCommand(db(), context({ engine: fakeEngine().handle }), { id: only().id });

    const said = listCommentsForItem(db(), item.id).map((comment) => comment.body).join("\n");
    expect(said).toMatch(/stopped because somebody asked EO to rebuild/i);
  });

  it("waits for the run to actually let go before deleting anything", async () => {
    // `cancelRun` only signals; the run unwinds on its own thread. A
    // rebuild that returned as soon as it had asked would be deleting a
    // directory something was still writing to — and on Windows the
    // delete would fail outright against an open handle.
    //
    // So the engine here lets go *late*, several polls after being
    // asked. A command that did not wait would reach `remove` while the
    // run was still active, which is what this records.
    const { item, target } = seed();
    await initializeRow(context(), target);
    const run = runningOn(item.id);

    // Scheduled once, however many times it is asked. The loop re-asks
    // every poll — that is what reaches a dispatch whose controller
    // appeared late — and a fresh timer per ask would outlive the test.
    let unwinding: ReturnType<typeof setTimeout> | undefined;
    const slow = {
      cancelRun: (runId: string) => {
        if (unwinding) return;
        // Late, the way a real run unwinds: the row goes terminal and
        // the claim comes back several polls after being asked.
        unwinding = setTimeout(() => {
          updateRun(db(), runId as Uuid, { status: "cancelled" });
          holds.get(item.id)?.();
          holds.delete(item.id);
        }, 40);
      },
    } as unknown as NonNullable<RepositoryIntelligenceContext["engine"]>;

    // Observed at the provider, which is the moment the index directory
    // is actually thrown away — `service.rebuild` is remove-then-build,
    // and this is the call that does the removing.
    let heldWhenDeleted: boolean | null = null;
    const watching = {
      ...provider,
      rebuild: async (target: RepositoryIndexTarget) => {
        heldWhenDeleted = listActiveRuns(db()).some((active) => active.id === run.id);
        return provider.rebuild(target);
      },
    };

    const rebuilt = await rebuildRepositoryIndexCommand(db(), context({ engine: slow, provider: watching }), { id: only().id });
    if (unwinding) clearTimeout(unwinding);

    expect(rebuilt.ok).toBe(true);
    // Reached at all — otherwise the assertion below would pass vacuously.
    expect(heldWhenDeleted).not.toBeNull();
    expect(heldWhenDeleted).toBe(false);
  });

  it("refuses, and deletes nothing, when the run will not stop", async () => {
    // The bounded fallback. "Try again in a moment" is a better answer
    // than an index taken out from under something still using it.
    const { item, target } = seed();
    await initializeRow(context(), target);
    runningOn(item.id);

    const refused = await rebuildRepositoryIndexCommand(db(), context({ engine: fakeEngine({ deaf: true }).handle }), { id: only().id });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toMatch(/has not yet\. Nothing was deleted/i);
    expect(only().status).toBe("ready");
  });

  it("rebuilds while a run is queued, because a queued run holds nothing", async () => {
    // The state that made Rebuild unusable. `listActiveRuns` counts a
    // queued run, so it looked like something holding the index — but
    // `cancelRun` cannot reach one (no controller), so it could never be
    // stopped, and the recovery sat out its whole timeout and refused.
    //
    // A queued run is a row saying work *should* happen. It has no
    // process and no claim on the checkout, so there is nothing to stop
    // and the rebuild goes ahead.
    const { item, target } = seed();
    await initializeRow(context(), target);
    queuedOn(item.id);
    const engine = fakeEngine();

    const rebuilt = await rebuildRepositoryIndexCommand(db(), context({ engine: engine.handle }), { id: only().id });

    expect({ ok: rebuilt.ok, problem: rebuilt.problem }).toEqual({ ok: true, problem: null });
    expect(only().status).toBe("ready");
    // Nothing was cancelled, and the queued run is still waiting its
    // turn — rebuilding an index is no reason to throw away somebody's
    // queued work.
    expect(engine.cancelled).toEqual([]);
    expect(listActiveRuns(db()).map((run) => run.status)).toEqual(["queued"]);
    // And nothing was announced, because nothing was stopped.
    expect(listCommentsForItem(db(), item.id)).toEqual([]);
  });

  it("holds the item while it rebuilds, so a queued run cannot start underneath it", async () => {
    // The other half of the answer. The queued run is not cancelled, so
    // what stops it dispatching into a checkout whose index is being
    // deleted is that the rebuild has claimed the item — the same
    // claim the scheduler takes before it dispatches anything.
    const { item, target } = seed();
    await initializeRow(context(), target);
    queuedOn(item.id);

    let heldDuringRebuild: boolean | null = null;
    const watching = {
      ...provider,
      rebuild: async (rebuilding: RepositoryIndexTarget) => {
        heldDuringRebuild = lock.isHeld(item.id);
        return provider.rebuild(rebuilding);
      },
    };

    await rebuildRepositoryIndexCommand(db(), context({ provider: watching, engine: fakeEngine().handle }), { id: only().id });

    expect(heldDuringRebuild).toBe(true);
    // And given back afterwards, or the item would be stranded for the
    // lifetime of the process.
    expect(lock.isHeld(item.id)).toBe(false);
  });

  it("gives the item back when the press fails", async () => {
    const { item, target } = seed();
    await initializeRow(context(), target);
    const failing = { ...provider, rebuild: async () => ({ ok: false as const, reason: "It did not work." }) };

    await rebuildRepositoryIndexCommand(db(), context({ provider: failing }), { id: only().id });

    expect(lock.isHeld(item.id)).toBe(false);
  });

  it("never claims the item at all when the feature is switched off", async () => {
    // The switch is read before the claim is taken, so a disabled
    // feature costs the item nothing — it is not claimed and released,
    // it is never claimed. The version of this that claimed first is
    // what let Rebuild cancel a run and then say "switched off".
    const { item, target } = seed();
    await initializeRow(context(), target);

    await rebuildRepositoryIndexCommand(db(), context({ off: true }), { id: only().id });

    expect(lock.isHeld(item.id)).toBe(false);
  });

  it("does not stop a run to discover the feature is switched off", async () => {
    // Graceful degradation, at the one place it is easiest to lose
    // (EO-141): a disabled indexer must leave the agent working. This
    // screen can be looking at a stale answer — somebody turned the
    // feature off in another window since the page loaded — and a
    // Rebuild that cancelled a run and *then* said "switched off" would
    // have taken somebody's work in exchange for nothing.
    const { item, target } = seed();
    await initializeRow(context(), target);
    const run = runningOn(item.id);
    const engine = fakeEngine();

    const refused = await rebuildRepositoryIndexCommand(db(), context({ off: true, engine: engine.handle }), { id: only().id });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("switched off");
    // Nothing was asked to stop, nothing was announced, and the agent is
    // still working.
    expect(engine.cancelled).toEqual([]);
    expect(listCommentsForItem(db(), item.id)).toEqual([]);
    expect(listActiveRuns(db()).map((active) => ({ id: active.id, status: active.status }))).toEqual([{ id: run.id, status: "running" }]);
    // And the run still holds its checkout, which is the whole point of
    // not having disturbed it.
    expect(lock.isHeld(item.id)).toBe(true);
  });

  it("does not stop a run to discover the indexer will not run on this machine", async () => {
    // The same rule, one step further along. An Intel Mac has no build
    // to fetch, so `ensureInstalled` refuses — and it must refuse before
    // anything is cancelled rather than after. The row still gets the
    // account of why, because that is how a machine that can never index
    // stops reading as "not indexed" forever.
    const { item, target } = seed();
    await initializeRow(context(), target);
    const run = runningOn(item.id);
    const engine = fakeEngine();
    const reason = "Widgetron 4.1 publishes no build for this machine.";

    const refused = await rebuildRepositoryIndexCommand(
      db(),
      context({ install: { ok: false, reason }, engine: engine.handle }),
      { id: only().id },
    );

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("could not run the indexer on this machine");
    expect(engine.cancelled).toEqual([]);
    expect(listCommentsForItem(db(), item.id)).toEqual([]);
    expect(listActiveRuns(db()).map((active) => ({ id: active.id, status: active.status }))).toEqual([{ id: run.id, status: "running" }]);
    expect(lock.isHeld(item.id)).toBe(true);
  });

  it("refuses when there is no engine to stop the run with, rather than deleting under it", async () => {
    const { item, target } = seed();
    await initializeRow(context(), target);
    runningOn(item.id);

    const refused = await rebuildRepositoryIndexCommand(db(), context(), { id: only().id });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toMatch(/cannot stop it from here/i);
  });

  it("leaves Refresh and Index waiting, because upkeep is not worth ending a run for", async () => {
    // The other half of the policy. EO does not kill somebody's run to
    // refresh a cache.
    const { item, target } = seed();
    await initializeRow(context(), target);
    runningOn(item.id);
    const engine = fakeEngine();

    const refreshed = await syncRepositoryIndexCommand(db(), context({ engine: engine.handle }), { id: only().id });

    expect(refreshed.ok).toBe(false);
    expect(refreshed.problem).toContain("will not touch its index until the run has finished");
    expect(engine.cancelled).toEqual([]);
  });
});

describe("the shape of the channels themselves", () => {
  /**
   * No channel accepts a provider argument, asserted against the
   * contract rather than against a handler.
   *
   * This is the criterion the whole subsystem's architecture rests on
   * where it is easiest to lose: a screen able to name an implementation
   * is a screen that has to know they exist. Zod strips what a schema
   * does not declare, so the proof is that a payload carrying one comes
   * out the other side without it — which also means a renderer that
   * started sending one would be sending it into a void rather than
   * quietly getting its way.
   */
  it("takes an index id and nothing else — a provider named in a payload is dropped", () => {
    const channels = [
      "repositoryIntelligence:initializeRepositoryIndex",
      "repositoryIntelligence:syncRepositoryIndex",
      "repositoryIntelligence:rebuildRepositoryIndex",
    ] as const;

    for (const name of channels) {
      expect(ipcContract[name].request.parse({ id: "an-index", provider: "something-else", indexPath: "/tmp/anywhere" })).toEqual({ id: "an-index" });
    }
  });

  it("exposes three index operations and nothing else that acts on one", () => {
    // The criterion this file exists to keep: initialize, sync and
    // rebuild, and no fourth. Everything else the subsystem can do is
    // deliberately out of a person's reach — probing, describing an
    // agent's query server, and removing an index without replacing it —
    // and *looking* at one rides on the configuration channels rather
    // than becoming a verb. Asserted as the whole namespace rather than
    // as three names, because the way a fourth operation arrives is
    // beside the three rather than instead of one.
    const offered = Object.keys(ipcContract).filter((name) => name.startsWith("repositoryIntelligence:"));

    expect(offered.sort()).toEqual([
      "repositoryIntelligence:getConfig",
      "repositoryIntelligence:initializeRepositoryIndex",
      "repositoryIntelligence:rebuildRepositoryIndex",
      "repositoryIntelligence:setConfig",
      "repositoryIntelligence:syncRepositoryIndex",
    ]);
  });
});

/**
 * Puts a row in place the way the indexing step does.
 *
 * Through the service rather than through a command, because that is
 * where rows come from: this screen acts on notes something else wrote,
 * and a test that created them through the screen would be testing a
 * path production never takes.
 */
async function initializeRow(ctx: RepositoryIntelligenceContext, target: RepositoryIndexTarget): Promise<void> {
  const runtime = ctx.factory?.({ db: db() });
  if (!runtime) throw new Error("expected a runtime");
  const outcome = await runtime.service.ensureIndexed(target);
  if (!outcome.ok) throw new Error(`expected an index, got: ${outcome.reason}`);
  if (!getRepositoryIndex(db(), { workspaceId: target.workspaceId, itemId: target.itemId })) throw new Error("expected a row");
}
