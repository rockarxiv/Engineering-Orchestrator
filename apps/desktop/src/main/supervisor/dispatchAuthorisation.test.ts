import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  getItem,
  getSetting,
  heldByCancelOf,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
} from "../db/repos/index.js";
import { getStep, listRoutesForPipeline, listStepsForPipeline, replacePipelineGraph } from "../db/repos/pipelineStepsRepo.js";
import { cancelRun, holdItem, moveItem, postHumanComment, resumeHeldItem } from "../ipc/domainCommands.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { answerToolCall } from "../mcpHost/server.js";
import { agentOfKind, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type RunSupervisor, type RunSupervisorOptions } from "./runSupervisor.js";
import { ITEM_BUSY_REASON } from "./itemLock.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

/**
 * An agent runs in exactly two cases: somebody asked for it by name, or
 * the item is sitting on the step its role owns (EO-175). `tick()`
 * obeys that rule; what happens after `tick()` did not.
 *
 * EO-173 is what that cost. The implementer was cancelled, the item
 * was dragged back to Index, and the implementer started anyway — on To
 * Do, a step the item had left 1.3 seconds earlier — because the
 * dispatch had been decided before the move and never asked again. It
 * then held the item for two minutes, which is why Index could not run
 * either. Cancelling it a second time was the only thing that let the
 * step that was supposed to run have the item.
 *
 * Two causes, both in the window between deciding to dispatch and
 * writing the run row, and both tested here: a step-driven dispatch that
 * never rechecked its authorisation, and a cancellation the scheduler
 * treated as a hiccup to recover from rather than as an instruction.
 *
 * Caps are wide, because neither rule is about capacity.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const CWD = "/tmp/eo/worktrees/EO-175";

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

function supervisorWith(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider({ steps: [{ sleepMs: 40, output: "working" }], result: validImplementResult }),
    limits: LIMITS,
    kinds: kindsPreparing(CWD),
    ...overrides,
  });
}

/**
 * A dispatch stopped in the middle of preflight, at the first await it
 * has (EO-135's harness, and the same window EO-173 was watched in).
 *
 * Auth is the earliest of the three long waits — auth, a worktree, a
 * context assembly — so a person acting while it is open is acting
 * before *any* of the rechecks this story is about.
 */
function gatedOnAuth() {
  let releaseAuth!: () => void;
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  const auth = new Promise<{ ok: true }>((resolve) => {
    releaseAuth = () => resolve({ ok: true });
  });
  return {
    started,
    releaseAuth,
    options: {
      checkAuth: () => {
        authStarted();
        return auth;
      },
    },
  };
}

/** A builtin that records that it ran, standing in for the indexer. */
function indexer(): { ran: number; runner: BuiltinRunner } {
  const state = {
    ran: 0,
    runner: async () => {
      state.ran += 1;
      return { ok: true as const, result: "indexed", detail: "" };
    },
  };
  return state;
}

function engineNotes(itemId = item.id): string[] {
  return listCommentsForItem(handle.db, itemId)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

/** Hands a step to an agent of another kind, through the call the pipeline screen publishes with. */
function reassign(stepId: string, role: string): void {
  const pipelineId = getStep(handle.db, stepId)!.pipelineId;
  const steps = listStepsForPipeline(handle.db, pipelineId);
  replacePipelineGraph(
    handle.db,
    pipelineId,
    steps.map((step) => ({
      id: step.id,
      pipelineId: step.pipelineId,
      position: step.position,
      name: step.name,
      type: step.type,
      agentId: step.id === stepId ? agentOfKind(handle.db, role) : step.agentId,
      entryAction: step.entryAction,
      isTerminal: step.isTerminal,
    })),
    listRoutesForPipeline(handle.db, pipelineId).map((route) => ({
      pipelineId: route.pipelineId,
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
  );
}

describe("a dispatch whose step has moved out from under it", () => {
  it("does not start the agent on the step the item has already left, and lets the waiting step run", async () => {
    const index = indexer();
    const gate = gatedOnAuth();
    const supervisor = supervisorWith({ ...gate.options, builtins: { index_repository: index.runner } });

    const tick = supervisor.runOnce();
    await gate.started;

    // EO-173, exactly: the card is dragged back to Index while the
    // implementer's run is being prepared. Confirmed, because the
    // dispatch holds the item's lock and the move now asks the lock
    // rather than the runs table — and there is nothing to throw away,
    // which is what `cancelledRunId` says.
    const moved = moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "repository_index",
      cancelActiveRun: true,
      comment: "",
    });
    expect(moved).toMatchObject({ moved: true, cancelledRunId: null });

    gate.releaseAuth();
    await tick;

    // No row at all — not a cancelled one, not a failed one. A dispatch
    // that turns itself back has written nothing to explain.
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("repository_index");

    // And the step that was supposed to run gets the item on the very
    // next tick, rather than waiting out a two-minute lock held by a run
    // for the step before it.
    await supervisor.runOnce();

    expect(index.ran).toBe(1);
    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ action: "index_repository", stepId: "repository_index" });
    // Indexed routes on to To Do, which is the item being handed on
    // properly — the thing that only happened after the second cancel.
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  /**
   * Reassigning the step mid-preflight publishes a *new version*
   * (EO-327, ARCHITECTURE.md, "Publish, lock and versions"), and this item entered on the
   * old one — so the contract it was authorised under is still the
   * contract it finishes under, and the run starts.
   *
   * The re-check itself has not gone anywhere: it runs, and asks
   * `rerunContract` of the item's own version rather than of the live
   * row. What changed is the answer, and only for this case — a step
   * *reconfigured* under an item that predates the save. The other two
   * things that turned a dispatch back still do, and are the tests
   * either side of this one: the item moving, and the agent being
   * archived.
   */
  it("runs an item whose step was reassigned after it entered, on the contract it entered under", async () => {
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(gate.options);

    const tick = supervisor.runOnce();
    await gate.started;
    reassign("todo", "reviewer");
    gate.releaseAuth();
    await tick;

    // Run by the role its own version says owns the step, rather than
    // turned back — and then routed on, which is the run finishing
    // normally.
    expect(listRunsForItem(handle.db, item.id)).toMatchObject([{ action: "implement", agentId: implementer.id, stepId: "todo" }]);
  });

  /** And the reassignment is real for work that enters after it. */
  it("will not run an item that entered after the reassignment under the old role", async () => {
    reassign("todo", "reviewer");
    const entered = createTestItem(handle.db, { type: "story", title: "Entered after", stepId: "todo" });

    const supervisor = supervisorWith({});
    await supervisor.runOnce();

    // Dispatched to the role the *current* version gives the step, which
    // is the reassignment doing what it was for.
    const reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
    expect(listRunsForItem(handle.db, entered.id)).toMatchObject([{ agentId: reviewer.id, stepId: "todo" }]);
  });

  it("honours a hold that lands while a scheduled run is being prepared", async () => {
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(gate.options);

    const tick = supervisor.runOnce();
    await gate.started;
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: true, comment: "" });
    gate.releaseAuth();
    await tick;

    // Which side of an await a person lands on is not something they can
    // see, so it must not change what EO does: a hold arriving during
    // preflight has to count exactly as one arriving before the tick.
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
  });

  it("does not run a builtin on a step the item has left either", async () => {
    // The same rule, for the half that is EO's own code rather than an
    // agent's. The window is narrower here — the item lock closes most
    // of it, because a builtin takes the claim and writes its row without
    // ever yielding — so this opens one deliberately: the agent
    // dispatched first in this tick moves the second item while it is
    // still deciding whether its own backend is available, which is
    // exactly the position `tick()`'s decision is left in whenever
    // anything at all happens between the decision and the row.
    const index = indexer();
    const indexing = createTestItem(handle.db, { type: "story", title: "Index me", stepId: "repository_index" });
    let moved = false;
    const supervisor = supervisorWith({
      builtins: { index_repository: index.runner },
      isAgentAvailable: () => {
        if (!moved) {
          moved = true;
          moveItem(handle.db, supervisor, { itemId: indexing.id, toStepId: "todo", cancelActiveRun: true, comment: "" });
        }
        return true;
      },
    });

    await supervisor.runOnce();

    expect(index.ran).toBe(0);
    expect(listRunsForItem(handle.db, indexing.id)).toEqual([]);
    // The agent's own item, which nobody touched, ran normally: the
    // recheck turns back the dispatch that went stale and no other.
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1);
  });
});

describe("a run somebody stopped", () => {
  /** Cancels the run in flight the way the Cancel button does. */
  async function cancelInFlight(supervisor: RunSupervisor): Promise<string> {
    const running = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toBeDefined();
    supervisor.cancelRun(run!.id);
    await running;
    return run!.id;
  }

  function slowSupervisor(overrides: Partial<RunSupervisorOptions> = {}): RunSupervisor {
    return supervisorWith({
      provider: createFakeProvider({ steps: [{ sleepMs: 2000, output: "never arrives" }], result: validImplementResult }),
      ...overrides,
    });
  }

  const HELD_NOTE = 'Run cancelled, so this ticket is on hold at "To Do". Resume it to run the step again.';

  it("holds the item on its step when the run panel cancels it, and the thread says so once", async () => {
    const supervisor = slowSupervisor();
    const running = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [run] = listRunsForItem(handle.db, item.id);
    // The run panel's Cancel, through the channel it presses.
    expect(cancelRun(supervisor, { runId: run!.id })).toEqual({ cancelled: true });
    await running;

    // Held where it was, by this cancel — the board shows it held and
    // offers Resume — and three ticks start nothing.
    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "todo", heldAt: expect.any(Number) });
    expect(heldByCancelOf(handle.db, item.id)).toBe(run!.id);
    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).map((one) => one.id)).toEqual([run!.id]);

    // Said once, as a note (invariant 8), and nothing else stands off it.
    expect(engineNotes().filter((body) => body.includes("Run cancelled"))).toEqual([HELD_NOTE]);
    expect(getSetting(handle.db, "engine.stopped-by-hand", null)).toBeNull();
  });

  it("holds the item the same way when run_cancel cancels it", async () => {
    const supervisor = slowSupervisor();
    registerHandler("runs:cancel", (payload) => cancelRun(supervisor, payload), { exposeErrorDetails: true });
    try {
      const running = supervisor.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [run] = listRunsForItem(handle.db, item.id);
      const answered = await answerToolCall({ name: "run_cancel", arguments: { runId: run!.id } }, "admin", true);
      expect(answered.isError).toBeFalsy();
      await running;

      expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
      expect(heldByCancelOf(handle.db, item.id)).toBe(run!.id);
      expect(engineNotes().filter((body) => body.includes("Run cancelled"))).toEqual([HELD_NOTE]);
    } finally {
      clearHandlerRegistry();
    }
  });

  it("stays held across a restart", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    const relaunched = supervisorWith();
    await relaunched.runOnce();

    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([cancelled]);
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
  });

  it("runs the step again once a person resumes it", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    // Resume, which a held item already offers, is the whole of it: no
    // hold-then-resume, nothing hidden left to clear.
    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });
    expect(heldByCancelOf(handle.db, item.id)).toBeNull();
    await supervisor.runOnce();

    const fresh = listRunsForItem(handle.db, item.id).filter((run) => run.id !== cancelled);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ agentId: implementer.id, stepId: "todo" });
  });

  it("is let go by a move, and the step it is moved to runs", async () => {
    const index = indexer();
    const supervisor = slowSupervisor({ builtins: { index_repository: index.runner } });
    await cancelInFlight(supervisor);

    moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "repository_index",
      cancelActiveRun: false,
      comment: "",
    });

    // A move ends the hold a cancel set, as it ended the stop before it.
    expect(getItem(handle.db, item.id)?.heldAt).toBeNull();
    expect(heldByCancelOf(handle.db, item.id)).toBeNull();
    await supervisor.runOnce();
    expect(index.ran).toBe(1);
  });

  it("leaves a hold a person set where it is when the item is moved", async () => {
    const supervisor = slowSupervisor();
    await cancelInFlight(supervisor);
    // A person holding it themselves makes the hold theirs.
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });
    expect(heldByCancelOf(handle.db, item.id)).toBeNull();

    moveItem(handle.db, supervisor, { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" });

    expect(getItem(handle.db, item.id)).toMatchObject({ stepId: "review", heldAt: expect.any(Number) });
  });

  it("still runs for a person who asks for it by name", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    // A mention on a held item is answered as it always was: a hold
    // stops the scheduler, not a person asking an agent by name.
    await postHumanComment(handle.db, supervisor, {
      itemId: item.id,
      body: "@implementer what did you get through before I stopped you?",
      mentions: [],
      pinned: false,
      parentId: null,
    });
    await supervisor.runOnce();

    const fresh = listRunsForItem(handle.db, item.id).filter((run) => run.id !== cancelled);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ agentId: implementer.id, action: "respond" });
    expect(fresh[0]?.initiationId).not.toBeNull();
    // And it does not lift the hold.
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
  });

  it("says nothing and stops nothing when the cancellation belongs to a move", async () => {
    // A move already routes the item and writes its own sentence about
    // the run it cancelled. A second paragraph saying EO has stopped —
    // about a step the item is no longer on — would be EO reporting a
    // decision nobody took.
    const supervisor = slowSupervisor();
    const running = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const moved = moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "review",
      cancelActiveRun: true,
      comment: "",
    });
    await running;

    expect(moved.cancelledRunId).not.toBeNull();
    expect(engineNotes().some((body) => body.includes("Run cancelled, so this ticket is on hold"))).toBe(false);
    expect(engineNotes().some((body) => body.includes("Run cancelled: you moved this ticket"))).toBe(true);
  });

  it("leaves the scheduler free when the cancellation was maintenance borrowing the checkout", async () => {
    // The shape a rebuild of the repository index has, and the one the
    // move test above cannot stand in for: nothing moves the item, so
    // the initiation the run belonged to is still the initiation the next
    // dispatch will run under. If a cancellation like that recorded a
    // stop, the rebuild finishing would be the reason the item then sat
    // still for good — a maintenance job quietly ending the work it
    // interrupted.
    const supervisor = slowSupervisor();
    const running = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [first] = listRunsForItem(handle.db, item.id);

    supervisor.cancelRun(first!.id, "superseded");
    await running;

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(engineNotes().some((body) => body.includes("Run cancelled, so this ticket is on hold"))).toBe(false);

    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id).filter((run) => run.id !== first!.id)).toHaveLength(1);
  });

  it("is restarted on resume when it was the pause that stopped it", async () => {
    // `pause({ cancelRunning })` puts its runs back when the engine
    // resumes, and that must keep working exactly as it did: the engine
    // stopping the world is not a person stopping this step.
    const supervisor = slowSupervisor();
    const running = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [first] = listRunsForItem(handle.db, item.id);

    supervisor.pause({ cancelRunning: true });
    await running;
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");

    supervisor.resume();
    await supervisor.runOnce();
    await supervisor.waitForIdle();

    expect(listRunsForItem(handle.db, item.id).filter((run) => run.id !== first!.id)).not.toEqual([]);
    expect(engineNotes().some((body) => body.includes("Run cancelled, so this ticket is on hold"))).toBe(false);
  });
});

describe("a person acting on an item a dispatch is being prepared for", () => {
  /**
   * The lock, not the runs table (EO-175).
   *
   * Preflight is seconds long and writes no row, so for the whole of it
   * the table says the item is idle while a run is being prepared
   * against it. That is the silent race EO-173 was lost in: the move
   * found no row, said nothing, and let the doomed dispatch write a run
   * for the step the item had just left.
   */
  it("is told the item is busy, in the wording every blocked action already uses", async () => {
    const supervisor = supervisorWith();
    const hold = supervisor.itemLock.acquire(item.id)!;

    const move = moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "review",
      cancelActiveRun: false,
      comment: "",
    });
    expect(move).toMatchObject({ moved: false, blockedByActiveRun: true });
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");

    const held = holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });
    expect(held).toMatchObject({ held: false, blockedByActiveRun: true });
    expect(getItem(handle.db, item.id)?.heldAt).toBeNull();

    // The refusal a person actually reads is built from this condition,
    // and it is the same sentence whether a run row exists or not.
    expect(ITEM_BUSY_REASON).toBe("an agent is working on it right now");

    // And once confirmed, both go through: the dispatch in preflight is
    // the one that turns itself back.
    hold();
    expect(moveItem(handle.db, supervisor, { itemId: item.id, toStepId: "review", cancelActiveRun: false, comment: "" }).moved).toBe(true);
  });
});
