import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentProvider, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem } from "../../../db/repos/index.js";
import { getRepositoryIndex } from "../../../db/repos/repositoryIndexesRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../../../db/testHelpers.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { createRoleWiring } from "../wiring.js";
import { createRunSupervisor, type RunSupervisor } from "../../../supervisor/runSupervisor.js";
import type { RepositoryIntelligenceFactory } from "./composition.js";
import { writeRepositoryIntelligenceConfig } from "./gate.js";
import { syncRepositoryIndexAtHandover } from "./handover.js";
import type {
  RepositoryIndexBuild,
  RepositoryIndexProbe,
  RepositoryIndexRemoval,
  RepositoryIndexTarget,
  RepositoryIntelligenceProvider,
} from "./port.js";
import { createRepositoryIntelligenceService } from "./service.js";
import { fakeWorkspaceKind, installedKinds, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "../../../supervisor/workspaceKind.js";

/**
 * Syncing the index where an item's work changes hands (EO-153).
 *
 * The story this file is about is *when*, not whether. An index that is
 * stale by the time the reviewer reads it is worse than no index,
 * because the reviewer will believe it — so what has to be pinned is
 * that the sync happens at a point somebody can name, and that
 * everything which could go wrong with it degrades instead of holding an
 * item up.
 *
 * **Everything is driven through the real supervisor.** The ordering
 * against `verifyRun` and `transitionItem` is the criterion, and a
 * test that called the seam directly would be asserting its own
 * arrangement of those rather than the engine's. Where a fact is only
 * observable at the moment it is true — which step the item was on
 * while the sync ran — it is recorded from inside the fake provider,
 * because reading it afterwards cannot tell "before the move" from
 * "after it".
 *
 * **The provider is faked, and faked at the port.** The architectural
 * invariant beside this file forbids a test outside `codewiki/` from
 * reaching an implementation, and it forbids it for a reason worth
 * restating: a test that reaches past the port is where a
 * provider-specific assumption gets written down, and from there copied
 * into production code that has to satisfy it. The end-to-end proof —
 * that a symbol the implementer added comes back from a query the
 * reviewer's own server answers — is `codewiki/handoverEndToEnd.test.ts`,
 * where the binary is real.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const REVIEW_APPROVAL = { verdict: "approve", feedback: "Reads well." };
const REVIEW_REJECTION = {
  verdict: "reject",
  feedback: "The retry is unbounded.",
  criteria_coverage: [{ criterion: "The retry gives up", result: "not_met" }],
  blocking_issues: ["Bound the retry."],
};

let handle: DbHandle;
let workspaceRoot: string;
/** Everything that happened, in the order it happened, across the supervisor and the port. */
let log: string[];

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceRoot = mkdtempSync(join(tmpdir(), "eo-handover-"));
  writeRepositoryIntelligenceConfig(handle.db, { enabled: true });
  log = [];
});

afterEach(() => {
  handle.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

interface FakeProviderOptions {
  /** Refuse every sync with this sentence, leaving builds working. */
  refuseSync?: string;
  /** What a successful sync reports it cost. */
  measured?: { durationMs: number; changedFileCount: number };
  /** Held open so a test can act while a sync is in flight. */
  hold?: Promise<void>;
}

/** What every provider this factory builds writes to, so counts are the run's and not one dispatch's. */
interface Recorder {
  /** Every call by name, in order. */
  calls: string[];
  /** The signal each sync was given, so a test can ask whether a cancel reached it. */
  syncSignals: (AbortSignal | undefined)[];
}

/**
 * A stand-in for whatever describes a checkout, plus the gate in front
 * of it.
 *
 * Built per call the way `composition.ts` builds one, because the signal
 * that cancels the work belongs to one piece of work rather than to a
 * long-lived object — and a shared `Recorder` behind them all is what
 * lets a test count across the dispatches of a whole run.
 *
 * `sync` records the item's step from *inside* the call, which is the
 * only place that fact can be observed: the whole question is whether
 * the sync ran before the transition, and by the time the run is over
 * the answer has been overwritten either way.
 */
function providerRecorder(options: FakeProviderOptions = {}): { factory: RepositoryIntelligenceFactory; recorder: Recorder } {
  const recorder: Recorder = { calls: [], syncSignals: [] };
  const indexPathFor = (target: RepositoryIndexTarget): string => join(target.workspacePath, ".index");

  function provider(signal?: AbortSignal): RepositoryIntelligenceProvider {
    const build = async (target: RepositoryIndexTarget): Promise<RepositoryIndexBuild> => {
      recorder.calls.push("build");
      return { ok: true, indexPath: indexPathFor(target), providerVersion: "9.9.9", indexedCommitSha: "abc123" };
    };

    return {
      id: "codewiki",
      initialize: build,
      ensureReady: build,
      rebuild: build,
      sync: async (target): Promise<RepositoryIndexBuild> => {
        recorder.calls.push("sync");
        recorder.syncSignals.push(signal);
        log.push(`sync:${getItem(handle.db, target.itemId as Uuid)?.stepId ?? "gone"}`);
        if (options.hold) await options.hold;
        if (options.refuseSync !== undefined) return { ok: false, reason: options.refuseSync };
        return {
          ok: true,
          indexPath: indexPathFor(target),
          providerVersion: "9.9.9",
          indexedCommitSha: "def456",
          ...(options.measured ?? {}),
        };
      },
      getStatus: async (target): Promise<RepositoryIndexProbe> => ({
        present: true,
        indexPath: indexPathFor(target),
        providerVersion: "9.9.9",
        indexedCommitSha: "abc123",
        unavailableReason: null,
      }),
      getAgentMcpConfig: async () => null,
      remove: async (): Promise<RepositoryIndexRemoval> => ({ ok: true }),
    };
  }

  // The gate is consulted on every call rather than once here, which is
  // what makes the flag-off case below about the seam reading it and not
  // about how this fixture was arranged.
  const factory: RepositoryIntelligenceFactory = ({ db, signal }) =>
    writeRepositoryIntelligenceConfig(handle.db, {}).enabled
      ? { service: createRepositoryIntelligenceService({ db, provider: provider(signal) }), ensureInstalled: async () => ({ ok: true as const }) }
      : null;

  return { factory, recorder };
}

/**
 * A backend that answers with the next scripted result and records that
 * it was asked.
 *
 * One result per *turn*, and `resume` draws from the same queue as
 * `start` rather than repeating the last answer. That is not a
 * simplification: the implementer opts into thread reuse, so its second
 * attempt after a rejection arrives as a resume — and a script keyed on
 * `start` alone would hand that attempt the reviewer's verdict, which
 * fails as a fixture problem while looking like a routing one.
 *
 * There are no corrective turns here because every scripted result is
 * valid for the action it answers, so nothing draws twice for one run.
 */
function recording(...results: unknown[]): AgentProvider {
  const scripted = results.length > 0 ? [...results] : [validImplementResult];
  const next = (): unknown => (scripted.length > 1 ? scripted.shift() : scripted[0]);
  function replay(result: unknown): AsyncIterable<AgentEvent> {
    return (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      yield { type: "result", data: result };
    })();
  }
  return {
    start: (opts) => {
      log.push(`dispatch:${opts.cwd ?? "?"}`);
      return replay(next());
    },
    resume: (_threadId, _message, opts) => {
      log.push(`dispatch:${opts?.cwd ?? "?"}`);
      return replay(next());
    },
  };
}

function storyWithWorktree(name: string): { item: Item; workspace: string } {
  const repository = attachWorkspace(handle.db, { name, keyPrefix: name.toUpperCase(), repoPath: join(workspaceRoot, `${name}-repo`) });
  const item = createTestItem(handle.db, { type: "story", title: `Rate limit ${name}`, stepId: "todo", workspaceId: repository.id, spec: REVIEWABLE_SPEC });
  return { item, workspace: join(workspaceRoot, name) };
}

interface SupervisorOptions {
  provider?: AgentProvider;
  verify?: () => Promise<{ ok: boolean; reason?: string }>;
}

function supervisorFor(
  intelligence: RepositoryIntelligenceFactory,
  workspaces: Map<string, string>,
  options: SupervisorOptions = {},
): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: options.provider ?? recording(),
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    kinds: installedKinds(
      fakeWorkspaceKind({
        prepare: async (item) => {
          const cwd = workspaces.get(item.id);
          return cwd ? preparedIn(item, cwd) : { ok: false as const, reason: "no workspace" };
        },
        verifying: async (_item, run) => {
          if (run.ended !== "succeeded") return [];
          log.push("verify");
          const answer = await (options.verify ?? (async () => ({ ok: true })))();
          return answer.ok ? [] : [{ key: "implementation", passed: false, blocks: true, describes: answer.reason ?? "not done" }];
        },
        // The same wiring `createEngine` uses in production: the sync
        // rides on what the workspace lent this run, so what is brought
        // up to date is what was handed over.
        attach: async (item, agent, workspace) => ({
          ...NOTHING_ATTACHED,
          sync: (signal) => syncRepositoryIndexAtHandover(intelligence, { db: handle.db, item, worktreePath: workspace.cwd, agentName: agent.name, signal }),
        }),
      }),
    ),
  });
}

/** The index the `index_repository` step would have left behind. */
async function indexed(factory: RepositoryIntelligenceFactory, item: Item, workspace: string): Promise<void> {
  const runtime = factory({ db: handle.db });
  if (runtime === null) throw new Error("the factory answered null with the feature on");
  const outcome = await runtime.service.ensureIndexed({ workspaceId: item.workspaceId!, itemId: item.id, workspacePath: workspace });
  if (!outcome.ok) throw new Error(outcome.reason);
}

const rowFor = (item: Item) => getRepositoryIndex(handle.db, { workspaceId: item.workspaceId!, itemId: item.id });

const engineNotes = (itemId: Uuid): string[] =>
  listCommentsForItem(handle.db, itemId)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);

describe("where the sync happens in a run", () => {
  /**
   * The ordering criterion, asserted as an order rather than as a call
   * count.
   *
   * Both halves are load-bearing and they fail in opposite directions.
   * Before the verification, EO would be indexing work it is about to
   * reject — spending the cost on a claim that turned out not to be
   * true. After the transition, the reviewer is already dispatchable
   * against an index describing the code the implementer *started*
   * from, which is the precise failure this story exists to prevent.
   */
  it("syncs after the run is verified and before the item moves", async () => {
    const { item, workspace } = storyWithWorktree("alpha");
    const { factory, recorder } = providerRecorder();
    await indexed(factory, item, workspace);
    log.length = 0;

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(recorder.calls).toContain("sync");
    // `sync:todo` is the whole assertion: the step the item was on at
    // the instant the provider was called. Recorded from inside the
    // sync, because afterwards the item has moved either way.
    expect(log.filter((entry) => entry === "verify" || entry.startsWith("sync:"))).toEqual(["verify", "sync:todo"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  /**
   * A run that failed verification produced nothing worth indexing.
   *
   * G-02's whole point is that a claim of success is checked before it
   * is acted on, and syncing is acting on it: the item stays where it
   * is, the next attempt reads the rejection, and an index refreshed
   * against a rejected attempt would describe work that is about to be
   * done again.
   */
  it("does not sync a run that failed verification", async () => {
    const { item, workspace } = storyWithWorktree("beta");
    const { factory, recorder } = providerRecorder();
    await indexed(factory, item, workspace);
    log.length = 0;

    await supervisorFor(factory, new Map([[item.id, workspace]]), {
      verify: async () => ({ ok: false, reason: "nothing was committed" }),
    }).runOnce();

    expect(log).toContain("verify");
    expect(recorder.calls).not.toContain("sync");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(rowFor(item)?.status).toBe("ready");
  });

  /**
   * The second boundary, and the reason it is not a second code path.
   *
   * "After reviewer-requested fixes, before the reviewer retries" is
   * the same handover as the first one — a run succeeded and the item
   * is about to move — so it is covered by the same call site rather
   * than by a rule about attempt numbers. What this pins is that the
   * second implementer's work is in the index *before* the reviewer is
   * dispatched to judge it, which is exactly the ordering a reviewer
   * re-reading a rejected change depends on.
   */
  it("syncs again on a second implementer attempt, before the reviewer retries", async () => {
    const { item, workspace } = storyWithWorktree("gamma");
    const { factory, recorder } = providerRecorder();
    await indexed(factory, item, workspace);
    log.length = 0;

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), {
      provider: recording(validImplementResult, REVIEW_REJECTION, validImplementResult, REVIEW_APPROVAL),
    });
    // implement, review (rejects), implement again, review again. Ticked
    // until the fourth run exists rather than a fixed number of times:
    // how many ticks a route takes is the scheduler's business, and a
    // count would be this test asserting that instead of what it is for.
    for (let tick = 0; tick < 12 && listRunsForItem(handle.db, item.id).length < 4; tick += 1) {
      await supervisor.runOnce();
    }

    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review", "implement", "review"]);
    expect(recorder.calls.filter((call) => call === "sync")).toHaveLength(4);

    // The order that matters: each implementer's sync lands while the
    // item is still on `todo`, and the reviewer is dispatched after
    // it. A sync that arrived after the move would show as `sync:review`.
    const boundaries = log.filter((entry) => entry.startsWith("sync:") || entry.startsWith("dispatch:"));
    const fromTodo = boundaries.filter((entry) => entry === "sync:todo");
    expect(fromTodo).toHaveLength(2);
    for (const at of [boundaries.indexOf("sync:todo"), boundaries.lastIndexOf("sync:todo")]) {
      // Something was dispatched after this sync — the reviewer it was
      // done for — rather than the sync trailing the last dispatch.
      expect(boundaries.slice(at + 1).some((entry) => entry.startsWith("dispatch:"))).toBe(true);
    }
  });

  /**
   * The third boundary: before the pull request is opened.
   *
   * It is the reviewer's own handover, not a fourth thing bolted onto
   * the builtin that opens the request — the item reaches
   * `merge_request` by an approval transitioning into it, and that
   * transition is this call site like any other. Whether anything
   * actually changed since the last sync is the implementation's
   * question rather than EO's: the port's `sync` reconciles against
   * what is on disk, and a checkout carries uncommitted work that a
   * commit-to-commit diff computed here would miss entirely.
   */
  it("syncs on the approval, before the item reaches the step that opens the pull request", async () => {
    const { item, workspace } = storyWithWorktree("lambda");
    const { factory, recorder } = providerRecorder();
    await indexed(factory, item, workspace);
    log.length = 0;

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), {
      provider: recording(validImplementResult, REVIEW_APPROVAL),
    });
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(recorder.calls.filter((call) => call === "sync")).toHaveLength(2);
    // The approval's sync ran while the item was still on `review`.
    // After the move it would read `sync:merge_request`, which is the
    // reviewer's index being refreshed for nobody.
    expect(log.filter((entry) => entry.startsWith("sync:"))).toEqual(["sync:todo", "sync:review"]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("merge_request");
  });
});

describe("a sync that could not be done", () => {
  /**
   * Three separate promises, and the third is the one worth being
   * explicit about.
   *
   * Blocking a transition because a cache did not refresh would be the
   * wrong trade: repository intelligence degrades and never blocks
   * (EO-141), and a person whose item stopped moving because an
   * indexer fell over has been given a worse product than one who never
   * switched the feature on.
   */
  it("says so, marks the index stale, and lets the item move anyway", async () => {
    const { item, workspace } = storyWithWorktree("delta");
    const { factory } = providerRecorder({ refuseSync: "the index database is locked by another process." });
    await indexed(factory, item, workspace);

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    // Stale rather than failed: the index that was there is still
    // there, and what has stopped being true is that it describes the
    // checkout.
    expect(rowFor(item)).toMatchObject({ status: "stale", errorMessage: "the index database is locked by another process." });

    const said = engineNotes(item.id).find((body) => body.includes("up to date"));
    expect(said).toContain("the index database is locked by another process");
    // Invariant #8: a guard that dropped this silently would leave the
    // difference between "the index answered" and "the index was wrong"
    // visible only as how much the next agent spent finding its way.
    expect(said).toContain("stale");
  });

  /**
   * The reviewer is told, once, by the path that already tells it.
   *
   * A stale index is not offered to an agent, so the next dispatch says
   * why it is going without — and repeating the sync's own sentence
   * here as well would put the same explanation in the thread twice per
   * handover, which is how a thread stops being read.
   */
  it("leaves the next dispatch to go without the index rather than believing it", async () => {
    const { item, workspace } = storyWithWorktree("epsilon");
    const { factory, recorder } = providerRecorder({ refuseSync: "the indexer exited with status 3." });
    await indexed(factory, item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), {
      provider: recording(validImplementResult, REVIEW_APPROVAL),
    });
    await supervisor.runOnce();
    await supervisor.runOnce();

    // The reviewer ran, and it ran with nothing to query — not with an
    // index describing code that has since changed.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review"]);
    // A stale row is not re-synced on the next handover: `stale` is not
    // something to update, it is something to rebuild.
    expect(recorder.calls.filter((call) => call === "sync")).toHaveLength(1);
  });

  /**
   * There is nothing to bring up to date, and nothing to say about it.
   *
   * A pipeline somebody removed the indexing step from is a supported
   * arrangement (invariant #7), and a comment on every handover of every
   * item in it would be the feature nagging about not being used.
   */
  it("is silent on an item that has no index at all", async () => {
    const { item, workspace } = storyWithWorktree("zeta");
    const { factory, recorder } = providerRecorder();

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(recorder.calls).not.toContain("sync");
    expect(rowFor(item)).toBeUndefined();
    expect(engineNotes(item.id).filter((body) => body.includes("up to date"))).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });
});

describe("what the sync leaves behind for the measurement story", () => {
  /**
   * Recorded as it happens, because the alternative is not a
   * measurement.
   *
   * EO-141's last story asks whether a persistent index actually costs
   * less than rediscovering the repository, and it cannot ask that of
   * something nobody wrote down at the time. The count comes from the
   * implementation rather than from EO: a checkout carries uncommitted
   * work that a commit-to-commit diff would miss entirely, and the thing
   * that just walked the tree already knows the answer.
   */
  it("records how long the sync took and how many files it touched", async () => {
    const { item, workspace } = storyWithWorktree("eta");
    const { factory } = providerRecorder({ measured: { durationMs: 431, changedFileCount: 7 } });
    await indexed(factory, item, workspace);

    await supervisorFor(factory, new Map([[item.id, workspace]])).runOnce();

    expect(rowFor(item)).toMatchObject({ status: "ready", lastSyncDurationMs: 431, lastSyncChangedFiles: 7 });
  });
});

describe("with the flag off", () => {
  /**
   * The rollout promise, at this boundary.
   *
   * With `repositoryIntelligence.enabled` false, a build carrying this
   * story has to behave exactly like one carrying none of it: no
   * provider constructed, no row written, no process, no comment. The
   * gate is read inside the factory, so this also pins that the seam
   * consults it rather than caching an answer from launch.
   */
  it("does nothing at any of the boundaries", async () => {
    const { item, workspace } = storyWithWorktree("theta");
    const { factory, recorder } = providerRecorder();
    await indexed(factory, item, workspace);
    writeRepositoryIntelligenceConfig(handle.db, { enabled: false });
    recorder.calls.length = 0;

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]), {
      provider: recording(validImplementResult, REVIEW_APPROVAL),
    });
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(recorder.calls).toEqual([]);
    expect(engineNotes(item.id).filter((body) => body.includes("up to date"))).toEqual([]);
    // The run still happened, so the assertions above are about a
    // dispatch that occurred rather than about one that never did.
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review"]);
  });
});

describe("cancelling a run while it is syncing", () => {
  /**
   * The signal has to reach the sync, and by this point the run's own
   * controller has been let go of.
   *
   * `driveToCompletion` clears `activeControllers` before it handles the
   * terminal result, so a cancel arriving during the handover would find
   * nothing to abort and the indexer would go on running in a checkout
   * the person has finished with. That is the one cost of this feature
   * nobody agreed to pay, which is why the abort is registered
   * separately rather than left to the run's own claim.
   */
  it("aborts the sync the run is in the middle of", async () => {
    const { item, workspace } = storyWithWorktree("iota");
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, recorder } = providerRecorder({ hold });
    await indexed(factory, item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]));
    const tick = supervisor.runOnce();

    // Wait until the sync is genuinely in flight rather than guessing at
    // a delay: a race you cannot make happen on demand is a race you
    // cannot test.
    for (let attempt = 0; attempt < 400 && recorder.syncSignals.length === 0; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 5));
    }
    const [signal] = recorder.syncSignals;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    const [run] = listRunsForItem(handle.db, item.id);
    supervisor.cancelRun(run!.id);
    expect(signal?.aborted).toBe(true);

    release();
    await tick;
  });

  /**
   * And a shutdown does the same, for the same reason.
   *
   * `shutdown` sweeps `activeControllers`, which a run past its result
   * is not in. Quitting EO while a handover sync is running must not
   * leave an indexer behind any more than cancelling one must.
   */
  it("aborts the sync when EO is shutting down", async () => {
    const { item, workspace } = storyWithWorktree("kappa");
    let release = (): void => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, recorder } = providerRecorder({ hold });
    await indexed(factory, item, workspace);

    const supervisor = supervisorFor(factory, new Map([[item.id, workspace]]));
    const tick = supervisor.runOnce();
    for (let attempt = 0; attempt < 400 && recorder.syncSignals.length === 0; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 5));
    }
    const [signal] = recorder.syncSignals;
    expect(signal?.aborted).toBe(false);

    const stopping = supervisor.shutdown();
    expect(signal?.aborted).toBe(true);

    release();
    await tick;
    await stopping;
  });
});
