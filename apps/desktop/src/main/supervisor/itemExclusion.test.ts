import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  getItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  needsAttention,
  postComment,
  updateRun,
} from "../db/repos/index.js";
import { postHumanComment } from "../ipc/domainCommands.js";
import { listTransitionsForItem } from "../db/repos/transitionsRepo.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { blockedByActiveRunRefusal } from "./itemLock.js";
import { fakeWorkspaceKind, installedKinds, kindsPreparing, preparedIn } from "./testWorkspaceKinds.js";

/**
 * One run at a time per item (EO-132).
 *
 * Five places create a run and every one of them ends in a subprocess
 * with a working tree. Two of them on one item is two processes
 * editing the same checkout, and the symptom is not a clean failure — it
 * is a diff nobody wrote. These assert the exclusion at each of those
 * entry points, and then all of them at once against the invariant
 * itself: `runs` never holds two rows for one item at `queued` or
 * `running`.
 *
 * Caps are deliberately wide here. Per-item exclusion has to hold
 * whatever the global and per-repository caps are set to — raising the
 * global cap is how several repositories progress at once, and it must
 * never become a way for two runs to land on one item.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/worktrees/EO-132";
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let handle: DbHandle;
let item: Item;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
});

afterEach(() => {
  handle.close();
});

/** Runs on this item that hold its checkout right now — the thing the lock exists to keep at one. */
function liveRuns() {
  return listRunsForItem(handle.db, item.id).filter((run) => run.status === "queued" || run.status === "running");
}

function supervisorWith(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider({ steps: [{ sleepMs: 40, output: "working" }], result: validImplementResult }),
    limits: LIMITS,
    kinds: kindsPreparing(CWD),
    ...overrides,
  });
}

describe("an item that is already held", () => {
  it("is skipped by the scheduler without a run, a comment or a transition, and taken on a later tick", async () => {
    const supervisor = supervisorWith();
    const hold = supervisor.itemLock.acquire(item.id);
    expect(hold).not.toBeNull();

    await supervisor.runOnce();

    // Normal operation, not a guard tripping: the item has not moved
    // and the next tick offers it again, so nothing is owed to anyone.
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(handle.db.select().from(comments).all()).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id)).toEqual([]);

    hold!();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("refuses a builtin step the same way it refuses an agent", async () => {
    const builtinItem = createTestItem(handle.db, { type: "story", title: "Cut me a tree", stepId: "worktree" });
    let ran = 0;
    const ready: BuiltinRunner = async () => {
      ran += 1;
      return { ok: true, result: "ready", detail: "" };
    };
    const supervisor = supervisorWith({ builtins: { create_worktree: ready } });
    const hold = supervisor.itemLock.acquire(builtinItem.id)!;

    await supervisor.runOnce();

    // A builtin cuts worktrees and opens pull requests — it is as much a
    // process in the checkout as an agent is.
    expect(ran).toBe(0);
    expect(listRunsForItem(handle.db, builtinItem.id)).toEqual([]);

    hold();
    await supervisor.runOnce();

    expect(ran).toBe(1);
  });
});

describe("the lock over the life of a run", () => {
  it("is held for the whole run, not just for the row it creates", async () => {
    const supervisor = supervisorWith();

    const running = supervisor.runOnce();
    await delay(10);

    // Mid-flight, long after `createRun` returned.
    expect(liveRuns()).toHaveLength(1);
    expect(supervisor.itemLock.isHeld(item.id)).toBe(true);
    expect(supervisor.itemLock.acquire(item.id)).toBeNull();

    await running;
    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
  });

  it("is released by a cancellation as readily as by a success, and the item dispatches again", async () => {
    const supervisor = supervisorWith({
      provider: createFakeProvider({ steps: [{ sleepMs: 200, output: "never arrives" }], result: validImplementResult }),
    });

    const running = supervisor.runOnce();
    await delay(10);
    const [first] = liveRuns();
    expect(first).toBeDefined();

    // Cancelled as part of something else — the shape a move or a hold
    // has. A person's bare stop ends the initiation and the scheduler
    // does not offer the step again (EO-175, and tested there); what is
    // being tested here is the lock, so this asks for the cancellation
    // that leaves the scheduling alone.
    supervisor.cancelRun(first!.id, "superseded");
    await running;

    // The release covers cancellation, which is the case a lock scoped to
    // row creation would have got right by accident and one scoped to a
    // successful ending would have got wrong.
    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(2);
  });

  it("gives the item back when a run falls over rather than stranding it", async () => {
    const supervisor = supervisorWith({
      provider: createFakeProvider({ throwMessage: "simulated provider crash" }),
    });

    await supervisor.runOnce();

    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
  });
});

describe("a reply arriving on an item that is already working", () => {
  /** A parked run for a reply to land on: a real thread, ended awaiting a person. */
  function park(): void {
    const parked = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "parked-thread",
    });
    updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: Date.now(), endedAt: Date.now() });
  }

  it("does not open a second live run", async () => {
    park();
    const supervisor = supervisorWith();

    // The first reply picks the parked conversation up and is still
    // going when the second arrives — the race `resumeItem` used to
    // lose, because it found the newest parked run and dispatched
    // without ever asking whether something else was live.
    const first = supervisor.resumeItem(item.id);
    await delay(10);
    const during = liveRuns();
    expect(during).toHaveLength(1);

    await supervisor.resumeItem(item.id);

    const after = liveRuns();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(during[0]?.id);

    await first;
  });

  it("does not open one on top of a run the scheduler started either", async () => {
    park();
    const supervisor = supervisorWith();
    // Something else is live on the item — a builtin, a module step, an
    // agent; the lock does not distinguish.
    const hold = supervisor.itemLock.acquire(item.id)!;

    await supervisor.resumeItem(item.id);

    expect(liveRuns()).toEqual([]);
    hold();
  });

  /**
   * What the person actually sees (EO-132).
   *
   * `postHumanComment` does not await the resume — running an agent
   * takes minutes and the IPC response cannot be held open for it — so
   * it answers `resumedRun: true` before the claim is even attempted. If
   * the claim then loses, the response has already said the reply was
   * picked up, and the thread is the only channel left to correct it
   * (invariant #4). Saying nothing is the version of this that looks to
   * a person like their reply vanishing.
   */
  it("tells the person, in the refusal EO already gives for a busy item", async () => {
    park();
    const supervisor = supervisorWith();
    // Something already owns the item — in production, a dispatch
    // still in preflight, which has taken the lock but not yet written
    // its row, so the item still reads as parked.
    const hold = supervisor.itemLock.acquire(item.id)!;

    // The real path: a person types into the item and presses Post.
    const posted = await postHumanComment(handle.db, supervisor, {
      itemId: item.id,
      body: "Go ahead, that approach is fine.",
      mentions: [],
      pinned: false,
      parentId: null,
    });
    expect(posted.resumedRun).toBe(true); // said before the claim was tried, and now wrong
    await delay(10);

    const engineNotes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
    expect(engineNotes).toHaveLength(1);
    expect(engineNotes[0]?.body).toBe(blockedByActiveRunRefusal("pick this ticket back up after your reply"));
    // The refusal is a correction, not a summons: the item is being
    // worked on right now, so raising `!` on it would ask for attention
    // it does not need.
    expect(engineNotes[0]?.kind).toBe("note");
    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(liveRuns()).toEqual([]);

    hold();
  });

  it("says nothing when it is the scheduler's own recovery pass that loses the claim", async () => {
    park();
    const supervisor = supervisorWith();
    const hold = supervisor.itemLock.acquire(item.id)!;

    // The tick's deferred-reply recovery, which has written nothing and
    // offers the same item again next tick. A comment per tick would
    // report contention as if it were a guard dropping work.
    await supervisor.resumeItem(item.id, { requestedBy: "scheduler" });

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
    hold();
  });

  it("says nothing when the reply is picked up normally", async () => {
    park();
    const supervisor = supervisorWith();

    await supervisor.resumeItem(item.id);

    // The refusal is for a refusal. A reply that ran must not collect an
    // explanation of something that did not happen to it.
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
    expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(1);
  });
});

describe("boot reconciliation", () => {
  it("seeds the lock for a run it adopts, and refuses a dispatch until that run ends", async () => {
    // A run this process is already driving. The lock is in memory, so a
    // restart forgets it — without seeding, the very first tick after
    // boot would dispatch on top of a live process in the same checkout.
    const adopted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "still-going",
    });
    updateRun(handle.db, adopted.id, { status: "running", startedAt: Date.now(), pid: 42 });

    const supervisor = supervisorWith({ isOurLiveProcess: (run) => run.pid === 42 });
    expect(await supervisor.reconcile()).toEqual({ reattached: 1, resumed: 0, orphaned: 0 });

    expect(supervisor.itemLock.isHeld(item.id)).toBe(true);
    expect(supervisor.itemLock.acquire(item.id)).toBeNull();

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // nothing dispatched on top of it

    // ...until that run ends. Nothing here drives it, so the run row
    // reaching a terminal status is the only signal the item is free.
    updateRun(handle.db, adopted.id, { status: "succeeded", endedAt: Date.now() });
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id)).toHaveLength(2);
    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
  });

  it("holds the item for a run it re-dispatches, from the moment it is adopted", async () => {
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "crashed-thread",
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    const supervisor = supervisorWith();
    expect(await supervisor.reconcile()).toMatchObject({ resumed: 1 });

    // Synchronously after reconcile returns — before any tick could run.
    expect(supervisor.itemLock.isHeld(item.id)).toBe(true);

    await supervisor.waitForIdle();
    expect(supervisor.itemLock.isHeld(item.id)).toBe(false);
  });

  it("orphans a second interrupted run on the same item rather than resuming both", async () => {
    for (const threadId of ["thread-a", "thread-b"]) {
      const stale = createRun(handle.db, {
        itemId: item.id,
        agentId: implementer.id,
        action: "implement",
        status: "queued",
        threadId,
        cwd: CWD,
      });
      updateRun(handle.db, stale.id, { status: "running", startedAt: Date.now() });
    }

    const supervisor = supervisorWith();
    const summary = await supervisor.reconcile();

    // One continuation, not two: an item has one checkout.
    expect(summary).toMatchObject({ resumed: 1, orphaned: 1 });
    await supervisor.waitForIdle();

    const orphaned = listRunsForItem(handle.db, item.id).filter((run) => run.status === "orphaned");
    expect(orphaned).toHaveLength(1);
    // Invariant #8: it did not go quietly.
    expect(handle.db.select().from(comments).all().some((comment) => comment.body.includes("Only one of them can carry on"))).toBe(true);
  });
});

describe("every entry point at once", () => {
  it("never leaves two runs on one item at queued or running", async () => {
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;

    let peak = 0;
    const sample = (): void => {
      peak = Math.max(peak, liveRuns().length);
    };

    const supervisor = supervisorWith({
      // Sampled at the seams a second dispatch could slip through — the
      // awaits between reading "nothing is running" and writing the row.
      // The old checks were read-then-write with an await in between,
      // which is what made them advisory even where they existed.
      kinds: installedKinds(
        fakeWorkspaceKind({
          prepare: async (item) => {
            sample();
            await delay(2);
            sample();
            return preparedIn(item, CWD);
          },
        }),
      ),
      buildContext: async () => {
        sample();
        await delay(2);
        sample();
        return "what the agent reads";
      },
    });

    // Somebody @-mentioned an agent, so the manual entry point has work
    // to offer alongside the state-driven one.
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "@reviewer is this the right shape?",
      mentions: [{ type: "agent", agentId: reviewer.id }],
    });

    // And a run was interrupted by a restart, so boot reconciliation has
    // something to recover in the same moment.
    const interrupted = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "queued",
      threadId: "crashed-thread",
      cwd: CWD,
    });
    updateRun(handle.db, interrupted.id, { status: "running", startedAt: Date.now() });

    const sampler = setInterval(sample, 1);
    try {
      // Boot recovery, two scheduler ticks, an @-mention and a reply,
      // all reaching for one item at once. (A module dry run was a fifth
      // until EO-353 removed it.)
      await Promise.all([
        (async () => {
          await supervisor.reconcile();
          await supervisor.waitForIdle();
        })(),
        supervisor.runOnce(),
        supervisor.runOnce(),
        supervisor.resumeItem(item.id),
      ]);

      // And again with a parked run in the way, which is what the reply
      // path needs to have anything to resume.
      const parked = createRun(handle.db, {
        itemId: item.id,
        agentId: implementer.id,
        action: "implement",
        status: "queued",
        threadId: "parked-thread",
      });
      updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: Date.now(), endedAt: Date.now() });

      await Promise.all([
        supervisor.resumeItem(item.id),
        supervisor.resumeItem(item.id),
        supervisor.runOnce(),
      ]);
      await supervisor.waitForIdle();
    } finally {
      clearInterval(sampler);
    }

    expect(peak).toBe(1);
    // Not vacuous: the entry points really did produce work, they just
    // took their turns.
    expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(2);
    expect(liveRuns()).toEqual([]);
  });
});
