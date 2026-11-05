import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent, Item } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import {
  getItem,
  listAgents,
  listCommentsForItem,
  listRunsForItem,
  needsAttention,
} from "../db/repos/index.js";
import { getStep, listRoutesForPipeline, listStepsForPipeline, replacePipelineGraph } from "../db/repos/pipelineStepsRepo.js";
import { holdItem, moveItem, postHumanComment, resumeHeldItem } from "../ipc/domainCommands.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
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

/** Hands a step to another role, through the call the pipeline screen publishes with. */
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
      ownerRole: step.id === stepId ? role : step.ownerRole,
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

  it("is not dispatched again by the scheduler, and the thread says so once", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    // Three ticks — the item has not moved, is not held and is not
    // awaiting an answer, which is precisely the state that used to have
    // it offered again five seconds later, and again, until the attempt
    // limit stopped it three runs later.
    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([cancelled]);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");

    // Said once, not once per tick (invariant 8) — and as a note, because
    // EO is acknowledging an instruction, not asking for attention.
    const stopped = engineNotes().filter((body) => body.includes("EO has stopped with it"));
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toContain('nothing will pick "To Do" up again on its own');
    // And what starts it again, which is the half a person needs.
    expect(stopped[0]).toContain("Mention Implementer to hand the step back");
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("stays stopped across a restart", async () => {
    // A person who stops a run and quits for the day has not asked EO to
    // start it again on the next launch, so the decision is recorded
    // where it outlives the process that took it.
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    const relaunched = supervisorWith();
    await relaunched.runOnce();

    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([cancelled]);
  });

  it("is picked up again once a person moves the item", async () => {
    const index = indexer();
    const supervisor = slowSupervisor({ builtins: { index_repository: index.runner } });
    await cancelInFlight(supervisor);

    moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "repository_index",
      cancelActiveRun: false,
      comment: "",
    });
    await supervisor.runOnce();

    // A move is a person re-authorising, and it needs nothing added to
    // say so: one entry into a step is one initiation, so the item is
    // in an initiation the stop has never heard of.
    expect(index.ran).toBe(1);
  });

  it("is picked up again once a person resumes it from a hold", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.id)).toEqual([cancelled]);

    // Resuming is the one re-authorisation that leaves the item exactly
    // where it was — same step, same initiation — so it is the one that
    // has to clear the stop outright.
    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });
    await supervisor.runOnce();

    expect(listRunsForItem(handle.db, item.id).length).toBeGreaterThan(1);
  });

  it("still runs for a person who asks for it by name", async () => {
    const supervisor = slowSupervisor();
    const cancelled = await cancelInFlight(supervisor);

    // A mention is the first of the three things the note offers, so it
    // has to work while the stop is standing: it runs under an initiation
    // of its own — the comment that asked — and the scheduler's stop is
    // not about it.
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
    // Answered as `respond`, under the asking comment's own initiation —
    // which is why the stop, which is about the step's, does not reach it.
    expect(fresh[0]).toMatchObject({ agentId: implementer.id, action: "respond" });
    expect(fresh[0]?.initiationId).not.toBeNull();
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
    expect(engineNotes().some((body) => body.includes("EO has stopped with it"))).toBe(false);
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
    expect(engineNotes().some((body) => body.includes("EO has stopped with it"))).toBe(false);

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
    expect(engineNotes().some((body) => body.includes("EO has stopped with it"))).toBe(false);
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
