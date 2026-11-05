import { sql } from "drizzle-orm";
import { tick } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createPipeline,
  createRoute,
  createStep,
  getStep,
  getItem,
  listAgents,
  listAllDependencies,
  listCommentsForItem,
  listRunsForItem,
  listTransitionsForItem,
  openMentionsForHuman,
  listPipelineSteps,
  transitionItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { createRoleWiring } from "../packs/developer/wiring.js";

let handle: DbHandle;

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 };
const APPROVE = { verdict: "approve", feedback: "Fine.", blocking_issues: [] };
const REJECT = { verdict: "reject", feedback: "No.", criteria_coverage: [{ criterion: "a criterion", result: "not_met" }], blocking_issues: ["a thing"] };
/** The reviewer asking rather than deciding — routed to `user_attention` on the default pipeline. */
const NEEDS_INPUT = { verdict: "needs_user_input", feedback: "Which way?", blocking_issues: [] };
const IMPLEMENTED = { branch: "eo/EO-59", summary: "Built it.", handoff: "Nothing surprising." };

/**
 * A second pipeline whose steps are deliberately *not* the shipped ones:
 * different ids, different names, a different order, and an extra QA step
 * between building and review. If anything still assumed the default
 * pipeline's slugs or positions, an item on this one would go astray.
 */
function buildSecondPipeline() {
  const pipeline = createPipeline(handle.db, { name: "Hotfix", position: 9 });
  const build = createStep(handle.db, {
    id: "hx_build",
    pipelineId: pipeline.id,
    position: 0,
    name: "Build",
    ownerRole: "implementer",
    entryAction: "implement",
  });
  const qa = createStep(handle.db, {
    id: "hx_qa",
    pipelineId: pipeline.id,
    position: 1,
    name: "QA",
    ownerRole: "reviewer",
    entryAction: "review",
  });
  const shipped = createStep(handle.db, {
    id: "hx_shipped",
    pipelineId: pipeline.id,
    position: 2,
    name: "Shipped",
    type: "builtin",
    ownerRole: null,
    entryAction: null,
    isTerminal: true,
  });

  createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: build.id, resultKey: "done", label: "Built", target: qa.id });
  createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: qa.id, resultKey: "approved", label: "Passed", target: shipped.id });
  createRoute(handle.db, {
    pipelineId: pipeline.id,
    fromStepId: qa.id,
    resultKey: "changes_requested",
    label: "Failed",
    target: build.id,
    position: 1,
  });

  return { pipeline, build, qa, shipped };
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("two pipelines in one install", () => {
  it("routes a reviewer's rejection to the implementer step of the item's own pipeline", () => {
    // The assertion the whole epic rests on. Both pipelines have a review
    // step that rejects backwards; they must land in different places.
    const { qa } = buildSecondPipeline();
    const wiring = createRoleWiring(handle.db);
    const steps = listPipelineSteps(handle.db);

    const onDefault = createTestItem(handle.db, { type: "story", title: "Default", stepId: "review", spec: REVIEWABLE_SPEC });
    const onHotfix = createTestItem(handle.db, { type: "story", title: "Hotfix", stepId: qa.id });

    expect(wiring.resolveNextState(getStep(handle.db, "review")!, steps, REJECT, "review", onDefault)).toEqual({ stepId: "todo", pipelineId: "default", resultKey: "changes_requested" });
    expect(wiring.resolveNextState(qa, steps, REJECT, "review", onHotfix)).toEqual({ stepId: "hx_build", pipelineId: qa.pipelineId, resultKey: "changes_requested" });
  });

  it("routes an approval to each pipeline's own terminal step", () => {
    const { qa } = buildSecondPipeline();
    const wiring = createRoleWiring(handle.db);
    const steps = listPipelineSteps(handle.db);

    const onDefault = createTestItem(handle.db, { type: "story", title: "Default", stepId: "review", spec: REVIEWABLE_SPEC });
    const onHotfix = createTestItem(handle.db, { type: "story", title: "Hotfix", stepId: qa.id });

    // The default pipeline puts a merge step between review and done; the
    // hotfix one ships straight from QA. Same verdict, different routes —
    // which is the whole point of the routes being data.
    expect(wiring.resolveNextState(getStep(handle.db, "review")!, steps, APPROVE, "review", onDefault)).toEqual({ stepId: "merge_request", pipelineId: "default", resultKey: "approved" });
    expect(wiring.resolveNextState(qa, steps, APPROVE, "review", onHotfix)).toEqual({ stepId: "hx_shipped", pipelineId: qa.pipelineId, resultKey: "approved" });
  });

  it("dispatches each item with the entry action of its own pipeline's step", () => {
    // Both pipelines own a step at position 0 — `worktree` on the default
    // one and `Build` on the hotfix. Matching on position rather than
    // pipeline would run the wrong thing against a hotfix.
    const { build } = buildSecondPipeline();
    const onDefault = createTestItem(handle.db, { type: "story", title: "Default", stepId: "todo" });
    const onHotfix = createTestItem(handle.db, { type: "story", title: "Hotfix", stepId: build.id });

    const dispatches = tick({
      items: [onDefault, onHotfix],
      deps: listAllDependencies(handle.db),
      steps: listPipelineSteps(handle.db),
      agents: listAgents(handle.db),
      activeRuns: [],
      awaitingInput: new Set(),
      heldItemIds: new Set(),
      limits: LIMITS,
      paused: false,
    });

    const byItem = new Map(dispatches.map((dispatch) => [dispatch.item.id, dispatch]));
    expect(byItem.get(onDefault.id)?.action).toBe("implement");
    expect(byItem.get(onHotfix.id)?.action).toBe("implement");
  });

  it("keeps an item blocked by a dependency that lives in another pipeline", () => {
    // Cross-pipeline dependencies are legitimate now, so the dependency's
    // terminal-ness has to be resolved in *its* pipeline, not the blocked
    // item's.
    const { build, shipped } = buildSecondPipeline();
    const blocker = createTestItem(handle.db, { type: "story", title: "Blocker", stepId: build.id });
    const blocked = createTestItem(handle.db, { type: "story", title: "Blocked", stepId: "todo" });
    handle.db.run(sql`INSERT INTO item_deps (item_id, depends_on_id) VALUES (${blocked.id}, ${blocker.id})`);

    const input = {
      deps: listAllDependencies(handle.db),
      steps: listPipelineSteps(handle.db),
      agents: listAgents(handle.db),
      activeRuns: [],
      awaitingInput: new Set<string>(),
      heldItemIds: new Set<string>(),
      limits: LIMITS,
      paused: false,
    };

    expect(tick({ ...input, items: [blocked, blocker] }).map((d) => d.item.id)).not.toContain(blocked.id);

    transitionItem(handle.db, { itemId: blocker.id, toStepId: shipped.id, actor: "human" });
    const afterMerge = getItem(handle.db, blocker.id)!;
    expect(tick({ ...input, items: [getItem(handle.db, blocked.id)!, afterMerge] }).map((d) => d.item.id)).toContain(blocked.id);
  });

  it("parks the item when a result routes to the human, and the scheduler leaves it alone", () => {
    // KAN-55. The default pipeline routes the reviewer's `needs_user_input`
    // to `user_attention`; reaching it must end the run rather than move
    // the item, and the item stays on its step — flagged in place (ARCHITECTURE.md,
    // "Needs-attention is derived")
    // rather than shuffled into a "needs human" column that would lose
    // which phase it is stuck at.
    const wiring = createRoleWiring(handle.db);
    const item = createTestItem(handle.db, { type: "story", title: "Asks", stepId: "review", spec: REVIEWABLE_SPEC });
    const review = getStep(handle.db, "review")!;

    const outcome = wiring.resolveNextState(review, listPipelineSteps(handle.db), NEEDS_INPUT, "review", item);

    expect(outcome).toEqual({ park: expect.stringContaining("Needs user input") });
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");

    // And it asked, with an open mention, so the inbox has something.
    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(openMentionsForHuman(handle.db).some((row) => row.comment.id === escalation?.id)).toBe(true);

    // A run left `awaiting_input` is what actually stops the scheduler; the
    // supervisor writes that status, so this asserts the contract tick()
    // relies on rather than re-testing tick() itself.
    expect(
      tick({
        items: [getItem(handle.db, item.id)!],
        deps: [],
        steps: listPipelineSteps(handle.db),
        agents: listAgents(handle.db),
        activeRuns: [],
        awaitingInput: new Set([item.id]),
        heldItemIds: new Set(),
        limits: LIMITS,
        paused: false,
      }),
    ).toEqual([]);
  });

  it("asks the human when a result has no route, rather than moving the item", () => {
    // Invariant #8: nothing drops work on the floor silently. The QA step
    // declares `approved` and `changes_requested` only, so an `implement`
    // run finishing there produces `done` — a real result key with nowhere
    // to go, which is the case that would otherwise strand the item.
    const { qa } = buildSecondPipeline();
    const wiring = createRoleWiring(handle.db);
    const onHotfix = createTestItem(handle.db, { type: "story", title: "Hotfix", stepId: qa.id });

    const next = wiring.resolveNextState(qa, listPipelineSteps(handle.db), {}, "implement", onHotfix);

    // Parked rather than merely unmoved: the question has to stop the
    // item, or the next tick asks it again.
    expect(next).toEqual({ park: expect.stringContaining("no route configured") });
    expect(next).toEqual({ park: expect.stringContaining("Ask the assistant to add a route for it") });
    expect(getItem(handle.db, onHotfix.id)?.stepId).toBe(qa.id);

    // It said so, on the item, and asked for a person.
    const escalation = listCommentsForItem(handle.db, onHotfix.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain('"done"');
    expect(escalation?.body).toContain("QA");
    expect(openMentionsForHuman(handle.db).some((row) => row.comment.id === escalation?.id)).toBe(true);
  });
});

/**
 * One pipeline handing work to another (EO-59).
 *
 * `Delivery` builds and `Merge` merges — two pipelines rather than one
 * more column on the end of the first, which is the shape this feature
 * exists for. Delivery has no terminal step at all: its only way out is
 * the hand-off, which is exactly the pipeline EO-58 taught the validator
 * to accept.
 */
function buildHandoff() {
  const merge = createPipeline(handle.db, { name: "Merge", position: 11 });
  const mergeStep = createStep(handle.db, {
    id: "mg_merge",
    pipelineId: merge.id,
    position: 0,
    name: "Merge",
    ownerRole: "reviewer",
    entryAction: "review",
  });
  const merged = createStep(handle.db, {
    id: "mg_merged",
    pipelineId: merge.id,
    position: 1,
    name: "Merged",
    type: "user",
    ownerRole: null,
    entryAction: null,
    isTerminal: true,
  });
  // Deliberately the only result the merge step declares, so a rejection
  // there is a real key with nowhere to go.
  createRoute(handle.db, { pipelineId: merge.id, fromStepId: mergeStep.id, resultKey: "approved", label: "Merged", target: merged.id });

  const delivery = createPipeline(handle.db, { name: "Delivery", position: 10 });
  const build = createStep(handle.db, {
    id: "dl_build",
    pipelineId: delivery.id,
    position: 0,
    name: "Build",
    ownerRole: "implementer",
    entryAction: "implement",
  });
  // The hand-off itself: out of this pipeline and into the other one.
  createRoute(handle.db, { pipelineId: delivery.id, fromStepId: build.id, resultKey: "done", label: "Ready to merge", target: mergeStep.id });

  return { delivery, build, merge, mergeStep, merged };
}

function handoffSupervisor(verdict: unknown = APPROVE) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([
      { when: (context) => context.includes(`"implement" action`), script: { result: IMPLEMENTED } },
      { when: (context) => context.includes(`"review" action`), script: { result: verdict } },
    ]),
    ...createRoleWiring(handle.db),
  });
}

describe("one pipeline handing work to another", () => {
  it("resolves a cross-pipeline route to the other pipeline's step, and says which pipeline that is", () => {
    const { build, mergeStep, merge } = buildHandoff();
    const wiring = createRoleWiring(handle.db);
    const item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: build.id, spec: REVIEWABLE_SPEC });

    const next = wiring.resolveNextState(build, listPipelineSteps(handle.db), IMPLEMENTED, "implement", item);

    // Both halves. A destination that named only the step would be the
    // half-moved item `stepFor` resolves to nothing.
    expect(next).toEqual({ stepId: mergeStep.id, pipelineId: merge.id, resultKey: "done" });
  });

  it("moves the item to the other pipeline and step when a run returns that result key", async () => {
    const { build, delivery, mergeStep, merge } = buildHandoff();
    const item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: build.id, spec: REVIEWABLE_SPEC });
    expect(item.pipelineId).toBe(delivery.id);

    await handoffSupervisor().runOnce(); // implement on Delivery, which returns `done`

    const moved = getItem(handle.db, item.id)!;
    expect(moved.stepId).toBe(mergeStep.id);
    expect(moved.pipelineId).toBe(merge.id);

    // An ordinary transition that happened to change one more column:
    // the same actor, the same run, the same reason, one row.
    const records = listTransitionsForItem(handle.db, item.id);
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fromStepId: build.id, toStepId: mergeStep.id, actor: run.agentId, runId: run.id, reason: "run succeeded" });
  });

  it("dispatches the item in its new pipeline on the very next tick", async () => {
    // The failure this exists to prevent is an item that has moved and
    // never runs again — invisible to `stepFor`, skipped by every tick,
    // stopped with nothing said. So this runs the ticks rather than
    // reading the two columns back and calling that dispatchable.
    const { build, merged } = buildHandoff();
    const item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: build.id, spec: REVIEWABLE_SPEC });
    const supervisor = handoffSupervisor();

    await supervisor.runOnce(); // Delivery: implement, and the hand-off
    await supervisor.runOnce(); // the next tick, with nothing else prodding it

    const runs = listRunsForItem(handle.db, item.id);
    // `review` is a step of the pipeline it arrived in and of no other, so
    // running it is the proof that the move left the item dispatchable.
    expect(runs.map((run) => run.action)).toEqual(["implement", "review"]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe(merged.id);
  });

  it("leaves a route within one pipeline on the pipeline it started on", async () => {
    // The other half of the change: naming the destination's pipeline on
    // every routed move must not move anything that was staying put.
    const { pipeline, qa } = buildSecondPipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Hotfix", stepId: qa.id, spec: REVIEWABLE_SPEC });

    await createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      provider: createScriptedProvider([{ when: (context) => context.includes(`"review" action`), script: { result: APPROVE } }]),
      ...createRoleWiring(handle.db),
    }).runOnce();

    const moved = getItem(handle.db, item.id)!;
    expect(moved.stepId).toBe("hx_shipped");
    expect(moved.pipelineId).toBe(pipeline.id);
  });

  it("still parks a result that routes nowhere, on an item that has already been handed over", async () => {
    // The merge step declares `approved` and nothing else, so a rejection
    // there is a real result key with nowhere to go. Being on a pipeline
    // something handed work to changes none of that: the item stays put,
    // the run ends `awaiting_input` and a human is asked (invariant #8).
    //
    // Run rather than resolved directly, because "parks" is a claim about
    // the run and the next tick, and calling `resolveNextState` by hand
    // asserts neither — it would pass just as happily against a supervisor
    // that asked the question and then let the item be dispatched again.
    const { build, merge, mergeStep } = buildHandoff();
    const item = createTestItem(handle.db, { type: "story", title: "Ship it", stepId: build.id, spec: REVIEWABLE_SPEC });
    const supervisor = handoffSupervisor(REJECT);

    await supervisor.runOnce(); // Delivery: implement, and the hand-off
    await supervisor.runOnce(); // Merge: review, whose verdict routes nowhere

    // Both columns, together: an item stopped mid-move is the failure this
    // feature exists to prevent, and a stop is when it would show.
    const still = getItem(handle.db, item.id)!;
    expect(still.stepId).toBe(mergeStep.id);
    expect(still.pipelineId).toBe(merge.id);

    const review = listRunsForItem(handle.db, item.id).find((run) => run.action === "review");
    expect(review?.status).toBe("awaiting_input");

    const escalation = listCommentsForItem(handle.db, item.id).find((comment) => comment.kind === "escalation");
    expect(escalation?.body).toContain('"changes_requested"');
    expect(escalation?.body).toContain("Merge");
    expect(openMentionsForHuman(handle.db).some((row) => row.comment.id === escalation?.id)).toBe(true);

    // And it stays stopped. Succeeding without moving would leave the
    // item exactly where the scheduler looks next, so the tick after the
    // question would ask it a second time — the loop `awaiting_input` is
    // what actually prevents, which no column read back can show.
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id).map((run) => run.action)).toEqual(["implement", "review"]);
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "escalation")).toHaveLength(1);
  });
});
