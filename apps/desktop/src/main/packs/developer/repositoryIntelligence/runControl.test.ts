import { UNSCOPED_RUN } from "@eo/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentEvent, AgentProvider, RepositoryMcpServer, Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentAttachmentsHash } from "../../../agentAttachments/fingerprint.js";
import type { DbHandle } from "../../../db/client.js";
import { createRun, getRun, listAgents, listRunsForItem, postComment, updateRun } from "../../../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { validImplementResult } from "../../../providers/fixtures.js";
import { promptHash } from "../../../roles/prompts.js";
import { createRoleWiring } from "../wiring.js";
import { createRunSupervisor, type RunSupervisor } from "../../../supervisor/runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "../../../supervisor/testWorkspaceKinds.js";
import { NOTHING_ATTACHED } from "../../../supervisor/workspaceKind.js";

/**
 * Run control around the one `await` this feature added (EO-151).
 *
 * Settling whether a dispatch gets a query server reads a row and asks a
 * binary, so it is asynchronous, and it sits between "this run is
 * `running`" and "a backend has been started for it". That gap did not
 * exist before — the row went `running` and the driver was entered in
 * the same synchronous block — and two pieces of run control quietly
 * assumed it never would.
 *
 * Both are about *not* starting something. A run somebody cancelled must
 * not have a backend spawned for it, and a query server is a second
 * process riding on that backend, so the cost of getting this wrong is
 * not an abstract state inconsistency: it is two live processes in a
 * checkout the person has finished with.
 *
 * The resolver here is deliberately slow, because a race you cannot make
 * happen on demand is a race you cannot test. Production's is fast and
 * the window is small; these hold it open and act inside it.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/worktrees/EO-151";

let handle: DbHandle;
let workspaceRoot: string;
let implementer: Agent;
/** Every turn any provider was asked for. The point of most assertions here is that it stays empty. */
let turns: { kind: "start" | "resume"; repositoryMcp: RepositoryMcpServer | undefined }[];

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceRoot = mkdtempSync(join(tmpdir(), "eo-run-control-"));
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  turns = [];
  repositories = 0;
});

afterEach(() => {
  handle.close();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** A gate a test opens by hand, standing in for a resolution that takes real time. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function recording(): AgentProvider {
  function replay(): AsyncIterable<AgentEvent> {
    return (async function* (): AsyncIterable<AgentEvent> {
      yield { type: "thread_started", threadId: "session-1" };
      yield { type: "result", data: validImplementResult };
    })();
  }
  return {
    start: (opts) => {
      turns.push({ kind: "start", repositoryMcp: opts.repositoryMcp });
      return replay();
    },
    resume: (_threadId, _message, opts) => {
      turns.push({ kind: "resume", repositoryMcp: opts?.repositoryMcp });
      return replay();
    },
  };
}

function supervisorFor(options: {
  /**
   * Resolutions to hold open, by item.
   *
   * Per item rather than for everything, and that distinction is what
   * makes the ordering tests below able to fail at all. A gate across
   * every resolution stops a stray tick's dispatch in the same place it
   * stops reconciliation's — so "nothing reached a provider" would be
   * true whether or not the tick had been let through, and the test
   * would be asserting its own fixture. Holding only the *stale*
   * items leaves a fresh one able to go all the way to a backend,
   * which is precisely the thing that must not happen yet.
   */
  heldFor?: Set<Uuid>;
  held?: Promise<void>;
  initialPaused?: boolean;
  onResolve?: (item: Item) => void;
  /**
   * The scheduler's own timers, made short enough to fire *during* a
   * held reconciliation.
   *
   * Left at their defaults these tests cannot fail: the interval is
   * minutes and the debounce is long enough that neither ever lands in
   * the window being held open, so a supervisor with no barrier at all
   * looks exactly like one that has it. Turning them down is what makes
   * the interval and the debounce genuine dispatch triggers here rather
   * than decoration — which is the whole point, because they are the two
   * that reach `runTickOnce` without any caller having chained them.
   */
  tickIntervalMs?: number;
  debounceMs?: number;
}): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: recording(),
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    ...(options.initialPaused === undefined ? {} : { initialPaused: options.initialPaused }),
    ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    kinds: installedKinds(
      fakeWorkspaceKind({
        cwd: CWD,
        attach: async (item) => {
          options.onResolve?.(item);
          const gated = options.heldFor === undefined || options.heldFor.has(item.id as Uuid);
          if (options.held && gated) await options.held;
          return NOTHING_ATTACHED;
        },
      }),
    ),
  });
}

/** Repositories carry a unique key prefix, so these are numbered rather than named. */
let repositories = 0;

function story(title: string): Item {
  repositories += 1;
  const repository = attachWorkspace(handle.db, {
    name: title,
    keyPrefix: `R${repositories}`,
    repoPath: join(workspaceRoot, title),
  });
  return createTestItem(handle.db, { type: "story", title, stepId: "todo", workspaceId: repository.id });
}

/** A run this process did not start, left `running` by one that died. */
function staleRun(item: Item, threadId: string | null = "session-1"): Uuid {
  const run = createRun(handle.db, {
    itemId: item.id,
    agentId: implementer.id,
    action: "implement",
    status: "queued",
    ...(threadId ? { threadId } : {}),
    provider: implementer.provider,
    instructionsHash: promptHash(implementer.instructions),
    agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
    cwd: CWD,
  });
  updateRun(handle.db, run.id, { status: "running", startedAt: Date.now() });
  return run.id;
}

async function waitUntil(predicate: () => boolean, whatFor: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${whatFor}`);
}

/** The run this dispatch created, as opposed to the one it is continuing. */
function newestRunOn(item: Item, except: Uuid): Uuid | undefined {
  return listRunsForItem(handle.db, item.id).find((run) => run.id !== except)?.id;
}

describe("cancelling a run while its query server is being resolved", () => {
  /**
   * The reply path: a person answers a parked run, then changes their
   * mind before the backend is up.
   *
   * Before the claim moved, `cancelRun` here found no controller and
   * returned having done nothing at all — not aborted, and not even
   * marked the row. EO then started the backend anyway, so the person
   * watched a run they had cancelled carry on working, with a `repo`
   * server under it, in a checkout they had finished with.
   */
  it("does not start a backend for a reply the person cancelled mid-resolution", async () => {
    const item = story("reply");
    const parked = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "session-1",
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      agentAttachmentsHash: agentAttachmentsHash(handle.db, implementer.id, UNSCOPED_RUN),
      cwd: CWD,
    });
    updateRun(handle.db, parked.id, { status: "awaiting_input", endedAt: Date.now() });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Yes, go ahead." });

    const held = gate();
    const supervisor = supervisorFor({ held: held.wait });

    const replying = supervisor.resumeItem(item.id);
    // The row says `running` well before any backend exists — which is
    // exactly the state this is about.
    await waitUntil(() => newestRunOn(item, parked.id) !== undefined, "the reply's run row");
    const runId = newestRunOn(item, parked.id)!;
    await waitUntil(() => getRun(handle.db, runId)?.status === "running", "the reply's run to be running");

    supervisor.cancelRun(runId);
    // The cancel is honoured now, not once the resolution happens to
    // finish: the row is terminal before the gate is even opened.
    expect(getRun(handle.db, runId)?.status).toBe("cancelled");

    held.open();
    await replying;

    // Nothing was ever started — which is the whole point, because a
    // backend started here would have brought a query server with it.
    expect(turns).toEqual([]);
    expect(getRun(handle.db, runId)?.status).toBe("cancelled");
    // And the claim was let go, so this run is not counted as live for
    // the rest of the process's life.
    expect(supervisor.activeRunCount()).toBe(0);
  });

  /**
   * The reconciliation path: the same window, reached at boot.
   *
   * Worse here than on the reply path, because this is the one place a
   * person has no other signal: the app has just started, the board
   * shows a run being recovered, and pressing cancel did nothing.
   */
  it("does not start a backend for a recovered run the person cancelled mid-resolution", async () => {
    const item = story("recover");
    const interrupted = staleRun(item);

    const held = gate();
    const supervisor = supervisorFor({ held: held.wait });

    const reconciling = supervisor.reconcile();
    await waitUntil(() => newestRunOn(item, interrupted) !== undefined, "the recovered run row");
    const runId = newestRunOn(item, interrupted)!;
    await waitUntil(() => getRun(handle.db, runId)?.status === "running", "the recovered run to be running");

    supervisor.cancelRun(runId);
    expect(getRun(handle.db, runId)?.status).toBe("cancelled");

    held.open();
    const summary = await reconciling;
    await supervisor.waitForIdle();

    expect(turns).toEqual([]);
    expect(getRun(handle.db, runId)?.status).toBe("cancelled");
    expect(supervisor.activeRunCount()).toBe(0);
    // Nothing was resumed, and the summary says so rather than counting
    // a run that never reached a backend.
    expect(summary.resumed).toBe(0);
  });

  it("still resumes normally when nobody cancels, so the guard is not refusing the ordinary case", async () => {
    // Non-vacuous: the two tests above assert an empty `turns`, which a
    // path that had simply stopped resuming would also produce.
    const item = story("normal");
    const interrupted = staleRun(item);
    const supervisor = supervisorFor({});

    expect(await supervisor.reconcile()).toMatchObject({ resumed: 1 });
    await supervisor.waitForIdle();

    expect(turns.map((turn) => turn.kind)).toEqual(["resume"]);
    expect(getRun(handle.db, interrupted)?.status).toBe("cancelled"); // superseded by the run that continued it
  });
});

describe("resuming a paused engine", () => {
  /**
   * The design's guarantee, against an asynchronous reconciliation (EO-151).
   *
   * An engine that started paused has reconciled *nothing*:
   * `reconcile()` returns early while `paused`, so `resume()` is the
   * first time every stale run on every item is looked at. Ticking
   * before that finishes dispatches against state nothing has settled —
   * an item reconciliation is about to re-dispatch on its own thread,
   * or one it is about to hand back, with no hold taken on either yet.
   *
   * **The interval and the debounce are the point, not `resume()`'s own
   * tick.** Chaining that one tick behind the promise was the first
   * attempt and it enforced nothing: `start()` leaves a timer running,
   * `notifyStateChange` schedules another, and both reach `runTickOnce`
   * without passing through anything a caller chained. So this turns the
   * scheduler's timers down until they genuinely fire inside the held
   * window, and asserts against *them* rather than against the one tick
   * the function under test remembered to arrange.
   */
  it("dispatches nothing until reconciliation has finished", async () => {
    const first = story("stale-one");
    const second = story("stale-two");
    staleRun(first);
    staleRun(second);
    // An item with nothing wrong with it, which a tick would pick up
    // immediately and carry all the way to a backend. It is what makes
    // this test able to fail — and its resolution is deliberately *not*
    // gated, so reaching a provider is possible for it and blocked only
    // by the ordering under test.
    story("fresh");

    const held = gate();
    let resolutions = 0;
    const supervisor = supervisorFor({
      initialPaused: true,
      held: held.wait,
      heldFor: new Set([first.id, second.id]),
      onResolve: () => {
        resolutions += 1;
      },
      // Short enough that both fire many times over inside the window
      // held open below. At their defaults neither ever would, and this
      // test would pass against a scheduler with no barrier at all.
      tickIntervalMs: 10,
      debounceMs: 5,
    });

    supervisor.start();
    // Paused at boot, so `start()`'s reconciliation returned early and
    // nothing has been reconciled yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns).toEqual([]);

    supervisor.resume();
    // Reconciliation is now inside the first stale run, waiting on the
    // gate.
    await waitUntil(() => resolutions === 1, "reconciliation to reach the first stale run");
    // And now give the scheduler every chance to get past it: a debounced
    // tick asked for directly, and long enough for the interval to have
    // fired dozens of times.
    supervisor.notifyStateChange();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The assertion. Not "no run was dispatched for a stale item" but
    // *nothing at all*: a tick that got through here would have found
    // the untouched item and started an agent on it, and the point of
    // the guarantee is that no tick gets through, not that each one
    // happens to be harmless.
    expect(turns).toEqual([]);

    held.open();
    await supervisor.waitForIdle();
    supervisor.stop();

    // And once it has finished, work does flow — so this is an ordering
    // guarantee rather than a deadlock.
    await waitUntil(() => turns.length > 0, "work to flow once reconciliation is done");
  });

  /**
   * Deliberately not tested here: pausing again mid-reconciliation.
   *
   * `runTickOnce` guards every dispatch on `paused` itself, so a tick
   * that got through the chain would refuse on its own — a test written
   * against `resume()` for it passes with the guard removed, which makes
   * it a test of somewhere else. `runSupervisor.test.ts` owns that
   * behaviour and asserts it where it lives.
   */
});
