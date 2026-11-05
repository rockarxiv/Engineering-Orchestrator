import { uuidv7, type Agent, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  archiveAgent,
  createAgent,
  createRun,
  getItem,
  listAgents,
  listCommentsForItem,
  listMentionsForComment,
  listRunsForItem,
  postComment,
  updateAgent,
  updateRun,
} from "../db/repos/index.js";
import { listTransitionsForItem, transitionItem } from "../db/repos/transitionsRepo.js";
import { getStep, listRoutesForPipeline, listStepsForPipeline, replacePipelineGraph } from "../db/repos/pipelineStepsRepo.js";
import { holdItem, moveItem, postHumanComment, resumeHeldItem } from "../ipc/domainCommands.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { ITEM_BUSY_REASON } from "./itemLock.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";

/**
 * Recovering a step by handing it back to its agent (#142, EO-135).
 *
 * The reported session: a reviewer run was cancelled, `@reviewer rerun`
 * was posted, the item was held and resumed — and EO acknowledged the
 * resume and then dispatched nothing, for as long as anybody watched.
 *
 * Two things could have caused that, and these tests separate them.
 * Eligibility after a cancelled run turns out never to have been broken
 * (the first test below passes without any of this story's changes). The
 * mention was: `@reviewer rerun` was read as a question to answer in
 * prose, so every tick dispatched a `respond` run, that run took the
 * item's lock, and the Review step it was asking for never got it.
 *
 * Caps are the shipped ones — concurrency stays at 1 (invariant #10) —
 * because the interaction between the mention path and the state path
 * competing for one slot is the whole of the defect.
 */

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/** A reviewer turn that approves, which is what a healthy rerun produces. */
const APPROVES: FakeProviderScript = {
  steps: [{ output: "Reading the diff again." }],
  result: { verdict: "approve", feedback: "Reads well now." },
};

let handle: DbHandle;
let item: Item;
let reviewer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
  // Arrived at Review the way a real item does, so the run that gets
  // cancelled below belongs to a real state-entry initiation.
  transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });
  item = getItem(handle.db, item.id)!;
  reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

function supervisorWith(script: FakeProviderScript = APPROVES, extra: Record<string, unknown> = {}): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: createFakeProvider(script),
    limits: LIMITS,
    ...createRoleWiring(handle.db),
    ...extra,
  });
}

/**
 * The stuck reviewer run of #141, as the user left it: cancelled by hand,
 * with an `endedAt`. This is the recorded state EO-135 starts from.
 */
function cancelledReviewRun() {
  const stuck = createRun(handle.db, {
    itemId: item.id,
    agentId: reviewer.id,
    action: "review",
    stepId: "review",
  });
  updateRun(handle.db, stuck.id, { status: "running", startedAt: Date.now() - 60_000 });
  updateRun(handle.db, stuck.id, { status: "cancelled", endedAt: Date.now() - 30_000 });
  return stuck;
}

/** Every run except the cancelled one the scenario starts with. */
function runsSince(stuckId: string) {
  return listRunsForItem(handle.db, item.id).filter((run) => run.id !== stuckId);
}

function engineNotes(): string[] {
  return listCommentsForItem(handle.db, item.id)
    .filter((comment) => comment.authorType === "engine")
    .map((comment) => comment.body);
}

/** `@reviewer rerun`, posted the way the UI posts it. */
async function postRerunRequest(supervisor: RunSupervisor, body = "@reviewer rerun"): Promise<Uuid> {
  const response = await postHumanComment(handle.db, supervisor, {
    itemId: item.id,
    body,
    mentions: [],
    pinned: false,
    parentId: null,
  });
  return response.commentId as Uuid;
}

describe("an item whose most recent run was cancelled", () => {
  it("is eligible again and gets a fresh run on the next tick", async () => {
    // The half of the diagnosis that was *not* broken, asserted so it
    // stays that way: nothing about a cancelled last run keeps the
    // scheduler away. No lock, no hold, no open dependency — so the
    // item is simply due.
    const stuck = cancelledReviewRun();

    await supervisorWith().runOnce();

    const fresh = runsSince(stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ action: "review", agentId: reviewer.id });
  });
});

describe("a mention handing the step back to its agent (#142)", () => {
  it("dispatches the step's own run, not a reply about it", async () => {
    // The defect itself. `@reviewer rerun` used to produce a `respond`
    // run — an agent answering in prose — which took the item's single
    // slot and left the Review step undispatched for as long as the
    // mention stayed open.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith();
    await postRerunRequest(supervisor);

    await supervisor.runOnce();

    const fresh = runsSince(stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.action).toBe("review");
    expect(fresh[0]?.agentId).toBe(reviewer.id);
    // Attributed to the step it reran, which is what lets its result be
    // routed rather than merely posted.
    expect(fresh[0]?.stepId).toBe("review");
  });

  it("routes the rerun's result like any other run of that step", async () => {
    // A rerun is a real run of the step, so its verdict takes the step's
    // configured route — through `transitionItem`, invariant #1. A
    // `respond` run transitions nothing, which is the other half of why
    // the reported item never moved.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith();
    await postRerunRequest(supervisor);

    await supervisor.runOnce();

    expect(runsSince(stuck.id)[0]?.status).toBe("succeeded");
    const transition = listTransitionsForItem(handle.db, item.id).find((entry) => entry.fromStepId === "review");
    expect(transition).toMatchObject({ toStepId: "merge_request", actor: reviewer.id });
  });

  it("plays the whole reported sequence end to end: cancel, mention, hold, resume", async () => {
    // #142 verbatim. Every step through the real entry points, and the
    // assertion is the one the issue makes: after the resume, a new
    // reviewer run exists.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith();

    await postRerunRequest(supervisor);

    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });
    // A tick while held must not consume the request — the person who
    // held it is the person who will resume it.
    await supervisor.runOnce();
    expect(runsSince(stuck.id)).toEqual([]);

    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });
    await supervisor.runOnce();

    const fresh = runsSince(stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ action: "review", agentId: reviewer.id });
  });

  it("asks for the rerun once, not on every tick", async () => {
    // The request is a person's, and it is answered at a person's pace.
    // Left open it would be re-read on every interval, which is the
    // `respond` loop the reported session actually saw.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith();
    const commentId = await postRerunRequest(supervisor);

    await supervisor.runOnce();
    await supervisor.runOnce();

    // One rerun of Review, not one per interval. (The item routes on
    // to the next step after it, and what happens there is that step's
    // business — hence the filter rather than a bare count.)
    expect(runsSince(stuck.id).filter((run) => run.action === "review")).toHaveLength(1);
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  it("still answers an ordinary question in prose", async () => {
    // The guard on all of the above: only a request to rerun becomes a
    // run of the step. Anything carrying its own question is a question.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith({ steps: [{ output: "It failed on the null id case." }] });
    await postRerunRequest(supervisor, "@reviewer why did the rerun fail?");

    await supervisor.runOnce();

    expect(runsSince(stuck.id)[0]?.action).toBe("respond");
  });
});

describe("a rerun EO will not dispatch", () => {
  it("refuses one asked for while a run is genuinely active, and says why", async () => {
    // Invariant #10 and the EO-132 lock: never a second concurrent run.
    // And never silently — a person who asked for a rerun and got none
    // is owed the reason and the way out (invariant #8).
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith();
    const live = createRun(handle.db, {
      itemId: item.id,
      agentId: reviewer.id,
      action: "review",
      stepId: "review",
    });
    updateRun(handle.db, live.id, { status: "running", startedAt: Date.now() });

    const commentId = await postRerunRequest(supervisor);
    await supervisor.runOnce();

    // No second run was queued behind the live one.
    expect(runsSince(stuck.id).map((run) => run.id)).toEqual([live.id]);

    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain('run "Review" again as you asked');
    expect(refusal).toContain(ITEM_BUSY_REASON);
    expect(refusal).toContain("Nothing has changed.");
    // Closed, so the refusal is posted once rather than every interval.
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  it("refuses when the item is waiting on another, naming what would work", async () => {
    // A standing reason rather than a busy one: this item will not be
    // dispatched until something a person controls changes, so saying so
    // is the difference between a stuck item and an explained one.
    const stuck = cancelledReviewRun();
    const blocker = createTestItem(handle.db, { type: "story", title: "Comes first", stepId: "todo" });
    addDependency(handle.db, item.id, blocker.id);

    const supervisor = supervisorWith();
    await postRerunRequest(supervisor);
    await supervisor.runOnce();

    expect(runsSince(stuck.id)).toEqual([]);
    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain("waiting on another that has not finished");
    expect(refusal).toContain("Finish that ticket, or remove the dependency.");
  });

  it("refuses when the agent it names is switched off", async () => {
    const stuck = cancelledReviewRun();
    updateAgent(handle.db, reviewer.id, { enabled: false });

    const supervisor = supervisorWith();
    // Posted directly: a disabled agent is still a mention target, which
    // is exactly the case that used to dispatch nothing and say nothing.
    const comment = postComment(handle.db, {
      id: uuidv7(),
      itemId: item.id,
      author: { type: "human" },
      body: "@reviewer rerun",
    });
    await supervisor.runOnce();

    expect(runsSince(stuck.id)).toEqual([]);
    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain("Reviewer is switched off");
    expect(refusal).toContain("Enable Reviewer in Settings.");
    expect(listMentionsForComment(handle.db, comment.id).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  it("refuses when the agent it names has been archived, and does not send anybody to look for a switch", async () => {
    // The other half of "an archived agent is not dispatched" (EO-186).
    // The scheduler cannot catch this one: a rerun request names an
    // agent and never goes through `tick()` at all, so the mention would
    // have handed Review straight back to a retired agent.
    const stuck = cancelledReviewRun();
    const comment = postComment(handle.db, {
      id: uuidv7(),
      itemId: item.id,
      author: { type: "human" },
      body: "@reviewer rerun",
    });
    // Archived *after* the request, which is the case that has to be
    // caught at dispatch rather than at the mention: the row the mention
    // names is still there and every tick goes on offering it.
    expect(listMentionsForComment(handle.db, comment.id).map((mention) => mention.targetId)).toEqual([reviewer.id]);
    archiveAgent(handle.db, reviewer.id);

    const supervisor = supervisorWith();
    await supervisor.runOnce();

    expect(runsSince(stuck.id)).toEqual([]);
    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain("Reviewer has been archived");
    // Not "enable it in Settings": there is no switch, and sending
    // somebody to look for one is worse than saying nothing.
    expect(refusal).not.toContain("Settings");
    expect(refusal).toContain('give the "reviewer" role another agent');
    // Closed, so the same paragraph is not posted again on the next
    // tick — and archiving being one-way, "again" would be forever.
    expect(listMentionsForComment(handle.db, comment.id).map((mention) => mention.status)).toEqual(["dismissed"]);

    const notesAfterOne = engineNotes().length;
    await supervisor.runOnce();
    expect(engineNotes()).toHaveLength(notesAfterOne);
    expect(runsSince(stuck.id)).toEqual([]);
  });

  it("will not quietly hand the work to a different agent with the same role", async () => {
    // The scheduler staffs a step from whoever holds its role, so with a
    // second reviewer enabled its answer is "this step is staffed" and
    // the request sailed through — running the agent the person had
    // deliberately switched off. A request that names somebody is about
    // that somebody.
    const stuck = cancelledReviewRun();
    updateAgent(handle.db, reviewer.id, { enabled: false });
    const standIn = createAgent(handle.db, {
      name: "Second Reviewer",
      role: "reviewer",
      provider: "fake",
      instructions: "Reviews things.",
      enabled: true,
    });

    const supervisor = supervisorWith();
    const comment = postComment(handle.db, {
      id: uuidv7(),
      itemId: item.id,
      author: { type: "human" },
      // By name, so the mention resolves to the disabled agent rather
      // than to whichever of the two the role happens to match first.
      body: "@Reviewer rerun",
    });
    await supervisor.runOnce();

    const started = runsSince(stuck.id);
    // The agent that was switched off did not run — the whole point.
    expect(started.filter((run) => run.agentId === reviewer.id)).toEqual([]);
    // Nor did anything run *as* the request: no run carries its
    // initiation, so the request was answered rather than redirected.
    expect(started.filter((run) => run.initiationId === comment.id)).toEqual([]);

    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain("Reviewer is switched off");
    expect(listMentionsForComment(handle.db, comment.id).map((mention) => mention.status)).toEqual(["dismissed"]);

    // The pipeline is untouched by any of this, and that is correct: the
    // step is staffed by an enabled reviewer and the item is due, so
    // the scheduler dispatches it on its own account. Refusing to run
    // the agent somebody named is not a reason to stall the step.
    expect(started.filter((run) => run.agentId === standIn.id)).toHaveLength(1);
  });
});

describe("what a resume promises", () => {
  it("says the item can be picked up when it can", async () => {
    cancelledReviewRun();
    const supervisor = supervisorWith();
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });

    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });

    expect(engineNotes().at(-1)).toContain("It can be picked up again from the same step.");
    // And it is true: the very next tick takes it.
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).some((run) => run.status !== "cancelled")).toBe(true);
  });

  it("names an unstaffed role rather than promising a pickup", async () => {
    // The scheduler's own staffing question, which a rerun request no
    // longer asks — it names an agent, so it says whether *that* one is
    // on. Here nobody holds the role at all, and "Enable one in
    // Settings" is the right advice rather than the wrong one.
    cancelledReviewRun();
    updateAgent(handle.db, reviewer.id, { enabled: false });

    const supervisor = supervisorWith();
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });
    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });

    const acknowledgement = engineNotes().at(-1);
    expect(acknowledgement).toContain('no enabled agent holds the "reviewer" role');
    expect(acknowledgement).toContain("Enable one in Settings.");

    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).every((run) => run.status === "cancelled")).toBe(true);
  });

  it("does not claim a pickup that is not coming", async () => {
    // The acknowledgement and the outcome have to agree (#142). Here
    // they cannot both be the old sentence: the item is blocked on a
    // dependency, so nothing will take it however long anyone waits.
    cancelledReviewRun();
    const blocker = createTestItem(handle.db, { type: "story", title: "Comes first", stepId: "todo" });
    addDependency(handle.db, item.id, blocker.id);

    const supervisor = supervisorWith();
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false, comment: "" });

    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });

    const acknowledgement = engineNotes().at(-1);
    expect(acknowledgement).not.toContain("It can be picked up again from the same step.");
    expect(acknowledgement).toContain("Nothing will pick it up");
    expect(acknowledgement).toContain("waiting on another that has not finished");

    // And the outcome agrees with what was said.
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).every((run) => run.status === "cancelled")).toBe(true);
  });
});

describe("a rerun whose preflight turns back", () => {
  /**
   * The window the reviewer of this change found, and it is a real one:
   * `dispatchHeld` rechecks pause, item existence and runtime
   * availability after *every* preflight await, and returns without a
   * word when one of them has changed. A request closed on the way in
   * would be gone at that point — no run, no comment, and a person told
   * nothing. So the request is closed on admission instead, which is the
   * first moment something durable exists to point at.
   */
  function gatedOnAuth() {
    let available = true;
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
      makeUnavailable: () => {
        available = false;
      },
      makeAvailable: () => {
        available = true;
      },
      options: {
        isAgentAvailable: () => available,
        checkAuth: () => {
          authStarted();
          return auth;
        },
      },
    };
  }

  /**
   * Hands Review to another role, through the same call the pipeline
   * configuration screen publishes with — steps are updated in place, so
   * the item stays exactly where it is and only the contract changes.
   */
  function reassignReviewTo(role: string): void {
    const pipelineId = getStep(handle.db, "review")!.pipelineId;
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
        ownerRole: step.id === "review" ? role : step.ownerRole,
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

  it("keeps the request when availability flips after preflight has started", async () => {
    const stuck = cancelledReviewRun();
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(APPROVES, gate.options);
    const commentId = await postRerunRequest(supervisor);

    const tick = supervisor.runOnce();
    await gate.started;
    gate.makeUnavailable(); // the managed backend went away mid-preflight
    gate.releaseAuth();
    await tick;

    // Nothing ran, which is correct — and nothing was lost, which is the
    // point. The request is still open, so the next tick offers it again.
    expect(runsSince(stuck.id)).toEqual([]);
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["open"]);

    // And it was said out loud rather than left looking like #142.
    const note = engineNotes().find((body) => body.includes("just yet"));
    expect(note).toContain("still queued");
    expect(note).toContain("Nothing has been lost.");

    // The proof that it was kept: the moment the backend is back, it runs.
    gate.makeAvailable();
    await supervisor.runOnce();

    const fresh = runsSince(stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ action: "review", agentId: reviewer.id });
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  it("honours a hold that lands while the run is being prepared", async () => {
    // Eligibility was read at the top of the tick and never asked again,
    // so a hold arriving during auth, the worktree or the context
    // assembly got the run anyway. Which side of an await a person lands
    // on is not something they can see, so it must not change what EO
    // does: the gate re-asks immediately before the run row is written.
    const stuck = cancelledReviewRun();
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(APPROVES, gate.options);
    const commentId = await postRerunRequest(supervisor);

    const tick = supervisor.runOnce();
    await gate.started;
    // Confirmed, because the hold is now asked first: the dispatch in
    // preflight holds the item's lock, and `holdItem` reads the lock
    // rather than the runs table (EO-175), so a person parking an item
    // with a run being prepared against it is told so instead of losing a
    // silent race. There is no run row to cancel — that is the whole
    // point of the window — so nothing is thrown away by confirming.
    holdItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: true, comment: "" });
    gate.releaseAuth();
    await tick;

    // No run, and in particular no run that a hold would then have to
    // chase down and cancel.
    expect(runsSince(stuck.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.heldAt).not.toBeNull();
    // Kept, in silence: the hold posted its own comment saying the
    // item stays put until resumed, and the request is waiting for
    // exactly the thing the person is about to do.
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["open"]);
    expect(engineNotes().some((body) => body.includes("EO did not"))).toBe(false);

    resumeHeldItem(handle.db, supervisor, { itemId: item.id, cancelActiveRun: false });
    await supervisor.runOnce();

    const fresh = runsSince(stuck.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ action: "review", agentId: reviewer.id });
  });

  it("does not run the old step against an item that has been moved off it", async () => {
    // Preflight writes no run row, so `moveItem` lets a person move the
    // item while a rerun is assembling its context. Generic eligibility
    // does not notice: the destination is dispatchable, so the answer is
    // "fine". The run would then carry Review's action, and the success
    // path resolves its route from the same stale snapshot — transitioning
    // the item out of a step it had already been moved off, and undoing
    // the move.
    const stuck = cancelledReviewRun();
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(APPROVES, gate.options);
    const commentId = await postRerunRequest(supervisor);

    const tick = supervisor.runOnce();
    await gate.started;
    // Back to Todo, which is an ordinary agent step with an enabled
    // implementer on it — eligible, which is exactly what made this slip
    // through.
    // Confirmed for the same reason the hold above is: the rerun holds
    // the item while it assembles its context, and the move now asks
    // the lock about that rather than the runs table (EO-175).
    const moved = moveItem(handle.db, supervisor, {
      itemId: item.id,
      toStepId: "todo",
      cancelActiveRun: true,
      comment: "",
    });
    expect(moved.moved).toBe(true);
    // And there was nothing to cancel: preflight has written no row, so
    // confirming threw no work away.
    expect(moved.cancelledRunId).toBeNull();
    gate.releaseAuth();
    await tick;

    // Nothing ran as the request.
    const started = runsSince(stuck.id);
    expect(started.filter((run) => run.initiationId === commentId)).toEqual([]);
    expect(started.filter((run) => run.action === "review")).toEqual([]);

    // And the move stands: nothing routed the item out of Review, which
    // is the shape the overwrite would have taken.
    // And the move stands. This is the assertion that matters, and it is
    // worth being exact about the shape of what it catches: the *route*
    // came from the stale snapshot, but `transitionItem` reads
    // `fromStepId` live — so the overwrite does not record itself as
    // leaving Review. It records as leaving To Do, where the person had
    // just put the item, and arriving at Review's destination. Against
    // the code before this guard, the item ends at "merge_request".
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id).filter((entry) => entry.actor !== "human")).toEqual([]);

    const refusal = engineNotes().find((body) => body.includes("EO did not"));
    expect(refusal).toContain('this ticket has moved to "To Do" since you asked');
    // And who to ask about where it actually is, rather than leaving that
    // to be worked out.
    expect(refusal).toContain('Mention Implementer if you want "To Do" run instead.');
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  /**
   * Reconfiguring the step mid-preflight publishes a *new version*
   * (EO-327, ARCHITECTURE.md, "Publish, lock and versions"), and this item entered on the
   * old one — so the contract the request was classified against is
   * still the contract the item finishes under, and the rerun runs.
   *
   * The re-check has not gone anywhere: `rerunContract` is still asked
   * at admission, and it is still the same function the classification
   * used. What changed is which graph it asks — the item's own version
   * rather than the live row — so a save made while a person's request
   * was in flight no longer turns that request back. The refusal is
   * still reachable by everything that is genuinely about *this* item:
   * it moving, its agent being archived, the run it asked for having
   * already started.
   */
  it("runs a rerun whose step was reconfigured after the item entered, on the contract it entered under", async () => {
    const stuck = cancelledReviewRun();
    const gate = gatedOnAuth();
    const supervisor = supervisorWith(APPROVES, gate.options);
    const commentId = await postRerunRequest(supervisor);

    const tick = supervisor.runOnce();
    await gate.started;
    reassignReviewTo("implementer");
    gate.releaseAuth();
    await tick;

    // The reviewer ran, attributed to the request that asked for it.
    const started = runsSince(stuck.id);
    expect(started.filter((run) => run.agentId === reviewer.id && run.initiationId === commentId)).toHaveLength(1);
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
  });

  it("does not tell somebody to enable an agent that is already enabled", async () => {
    // A runtime that is not ready is not an agent that is switched off.
    // Reporting it as one sent the person to Settings to turn on
    // something already on, which is worse than saying nothing.
    const stuck = cancelledReviewRun();
    let available = false;
    const supervisor = supervisorWith(APPROVES, { isAgentAvailable: () => available });
    const commentId = await postRerunRequest(supervisor);

    await supervisor.runOnce();

    expect(runsSince(stuck.id)).toEqual([]);
    const note = engineNotes().find((body) => body.includes("just yet"));
    expect(note).toContain("Reviewer is not ready");
    expect(note).not.toContain("Enable one in Settings");
    // Deferred, not refused: the request is still there to be honoured.
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["open"]);
    expect(engineNotes().some((body) => body.includes("EO did not"))).toBe(false);

    available = true;
    await supervisor.runOnce();

    expect(runsSince(stuck.id).map((run) => run.action)).toContain("review");
  });

  it("says it once while the backend stays away, not once a tick", async () => {
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith(APPROVES, { isAgentAvailable: () => false });
    await postRerunRequest(supervisor);

    await supervisor.runOnce();
    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(runsSince(stuck.id)).toEqual([]);
    expect(engineNotes().filter((body) => body.includes("just yet"))).toHaveLength(1);
  });

  it("closes the request when preflight refuses it, because that refusal is its answer", async () => {
    // The other side of admission: a guard placeholder is a durable,
    // explained outcome even though no agent ever ran. Re-offering the
    // request against it would stack a second escalation on the first.
    const stuck = cancelledReviewRun();
    const supervisor = supervisorWith(APPROVES, {
      kinds: installedKinds(fakeWorkspaceKind({ prepare: async () => ({ ok: false as const, reason: "The repository has uncommitted changes." }) })),
    });
    const commentId = await postRerunRequest(supervisor);

    await supervisor.runOnce();
    await supervisor.runOnce();

    // One guard run carrying the request's initiation, not one per tick.
    expect(runsSince(stuck.id)).toHaveLength(1);
    expect(runsSince(stuck.id)[0]).toMatchObject({ status: "awaiting_input", initiationId: commentId });
    expect(listMentionsForComment(handle.db, commentId).map((mention) => mention.status)).toEqual(["dismissed"]);
    // And the guard said why, in its own words.
    expect(engineNotes().some((body) => body.includes("uncommitted changes"))).toBe(true);
  });
});
