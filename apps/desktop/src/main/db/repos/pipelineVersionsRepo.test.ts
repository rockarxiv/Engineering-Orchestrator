import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PipelineStep, Uuid } from "@eo/core";
import { resolveRoute } from "@eo/engine";
import type { DbHandle } from "../client.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { getItem } from "./itemsRepo.js";
import { transitionItem } from "./transitionsRepo.js";
import {
  createPipeline,
  createRoute,
  createStep,
  listPipelineSteps,
  listStepsForPipeline,
  listRetiredStepsForPipeline,
  replacePipelineGraph,
  setEntryStep,
} from "./pipelineStepsRepo.js";
import {
  boundGraphForItem,
  currentVersion,
  ensureCurrentVersion,
  graphForItem,
  itemsOnOlderVersions,
  listPipelineVersions,
  setPipelineVersionsToKeep,
  stepForItem,
  versionGraph,
} from "./pipelineVersionsRepo.js";

/**
 * Versions, and the promise they exist to keep (EO-327,
 * the original design): "an item binds to the version it entered
 * on and finishes there".
 *
 * The fixture is a three-step pipeline of `user` steps — nothing here is
 * about dispatch, and a human step is the one kind that needs no agent
 * to exist. What is about to change between versions is where `decide`'s
 * `yes` goes.
 */
describe("pipeline versions", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  /** A pipeline whose middle step routes `yes` to `first`, and `no` nowhere in particular. */
  function drawPipeline(): { pipelineId: string; steps: PipelineStep[] } {
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Approvals" });
    const intake = createStep(handle.db, { pipelineId: pipeline.id, position: 0, name: "Intake", type: "user" });
    const decide = createStep(handle.db, { pipelineId: pipeline.id, position: 1, name: "Decide", type: "user" });
    const first = createStep(handle.db, { pipelineId: pipeline.id, position: 2, name: "First", type: "user" });
    const second = createStep(handle.db, { pipelineId: pipeline.id, position: 3, name: "Second", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: decide.id, resultKey: "yes", label: "Yes", target: first.id });
    setEntryStep(handle.db, pipeline.id, intake.id);
    return { pipelineId: pipeline.id, steps: [intake, decide, first, second] };
  }

  /** The whole graph as `pipeline:save` would send it back, with one route repointed. */
  function repoint(pipelineId: string, fromStepId: string, target: string): void {
    const steps = listStepsForPipeline(handle.db, pipelineId);
    replacePipelineGraph(
      handle.db,
      pipelineId,
      steps.map((step) => ({ ...step, pipelineId: pipelineId as Uuid })),
      [{ pipelineId: pipelineId as Uuid, fromStepId, resultKey: "yes", label: "Yes", target, position: 0 }],
    );
  }

  it("files v1 the first time anybody asks, and binds what is already standing there to it", () => {
    const { pipelineId, steps } = drawPipeline();
    // Nothing has asked yet: a pipeline written step by step has a graph
    // and no document of it.
    expect(currentVersion(handle.db, pipelineId)).toBeUndefined();

    const item = createTestItem(handle.db, { type: "story", title: "Standing here", stepId: steps[1]!.id });

    const v1 = currentVersion(handle.db, pipelineId);
    expect(v1?.number).toBe(1);
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(v1?.id);
  });

  /**
   * The first acceptance criterion, walked: one item through the old
   * version and one through the new, in the same database at the same
   * time, disagreeing about where `yes` goes because they entered on
   * different versions.
   */
  it("routes an item mid-flight by its own version while a new item takes the current one", () => {
    const { pipelineId, steps } = drawPipeline();
    const [intake, decide, first, second] = steps as [PipelineStep, PipelineStep, PipelineStep, PipelineStep];

    const midFlight = createTestItem(handle.db, { type: "story", title: "Already going", stepId: decide.id });
    const v1 = currentVersion(handle.db, pipelineId)!;
    expect(v1.number).toBe(1);

    // The save: `yes` now goes to Second rather than First.
    repoint(pipelineId, decide.id, second.id);
    const v2 = currentVersion(handle.db, pipelineId)!;
    expect(v2.number).toBe(2);
    expect(listPipelineVersions(handle.db, pipelineId).map((version) => version.number)).toEqual([1, 2]);

    const afterwards = createTestItem(handle.db, { type: "story", title: "Started after", stepId: decide.id });
    expect(getItem(handle.db, afterwards.id)?.pipelineVersionId).toBe(v2.id);

    const where = (itemId: Uuid) => {
      const item = getItem(handle.db, itemId)!;
      const graph = graphForItem(handle.db, item);
      return resolveRoute({ step: graph.steps.find((step) => step.id === decide.id)!, steps: graph.steps, routes: graph.routes, result: "yes" });
    };

    // The item that entered on v1 still goes where v1 said.
    expect(where(midFlight.id)).toEqual({ kind: "step", stepId: first.id, pipelineId });
    // The one that entered afterwards takes the graph as it is now.
    expect(where(afterwards.id)).toEqual({ kind: "step", stepId: second.id, pipelineId });

    // Walked, not merely resolved: each is moved where its own version
    // sends it, and they end up in different columns from the same
    // answer to the same question.
    for (const id of [midFlight.id, afterwards.id]) {
      const outcome = where(id);
      expect(outcome.kind).toBe("step");
      if (outcome.kind !== "step") throw new Error("unreachable");
      transitionItem(handle.db, { itemId: id, toStepId: outcome.stepId, toPipelineId: outcome.pipelineId, actor: "human" });
    }
    expect(getItem(handle.db, midFlight.id)?.stepId).toBe(first.id);
    expect(getItem(handle.db, afterwards.id)?.stepId).toBe(second.id);
    // And each is still on the version it entered on: a move within the
    // pipeline is a step of finishing, not a new entry.
    expect(getItem(handle.db, midFlight.id)?.pipelineVersionId).toBe(v1.id);
    expect(getItem(handle.db, afterwards.id)?.pipelineVersionId).toBe(v2.id);

    // And the banner's count is about the first of them only.
    expect(itemsOnOlderVersions(handle.db, pipelineId)).toEqual([{ versionId: v1.id, number: 1, items: 1 }]);

    // An item on the current version reads the live rows rather than a
    // snapshot, which is what keeps every other caller correct.
    expect(boundGraphForItem(handle.db, getItem(handle.db, afterwards.id)!)).toBeNull();
    expect(intake.id).toBeTruthy();
  });

  /**
   * The step is retired rather than dropped, and that is what lets an
   * item on an older version still be routed onto it — the ghost column
   * the design draws.
   */
  it("retires a removed step, keeps it out of the current graph, and still routes an older version's item onto it", () => {
    const { pipelineId, steps } = drawPipeline();
    const [intake, decide, first, second] = steps as [PipelineStep, PipelineStep, PipelineStep, PipelineStep];

    const midFlight = createTestItem(handle.db, { type: "story", title: "Still going", stepId: decide.id });
    const v1 = currentVersion(handle.db, pipelineId)!;

    // v2 drops First entirely, and repoints `yes` at Second.
    replacePipelineGraph(
      handle.db,
      pipelineId,
      [intake, decide, second].map((step) => ({ ...step, pipelineId: pipelineId as Uuid })),
      [{ pipelineId: pipelineId as Uuid, fromStepId: decide.id, resultKey: "yes", label: "Yes", target: second.id, position: 0 }],
    );

    expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).not.toContain(first.id);
    expect(listRetiredStepsForPipeline(handle.db, pipelineId)).toEqual([{ step: expect.objectContaining({ id: first.id }), retiredVersion: 1 }]);

    // The item that entered on v1 is routed onto the retired step, and
    // the foreign key holds because the row is still there.
    const item = getItem(handle.db, midFlight.id)!;
    expect(item.pipelineVersionId).toBe(v1.id);
    const graph = graphForItem(handle.db, item);
    const outcome = resolveRoute({ step: graph.steps.find((step) => step.id === decide.id)!, steps: graph.steps, routes: graph.routes, result: "yes" });
    expect(outcome).toEqual({ kind: "step", stepId: first.id, pipelineId });

    transitionItem(handle.db, { itemId: midFlight.id, toStepId: first.id, toPipelineId: pipelineId as Uuid, actor: "human" });
    expect(getItem(handle.db, midFlight.id)?.stepId).toBe(first.id);
  });

  it("brings a retired step back, items and all, when a later save re-adds it by id", () => {
    const { pipelineId, steps } = drawPipeline();
    const [intake, decide, first, second] = steps as [PipelineStep, PipelineStep, PipelineStep, PipelineStep];
    ensureCurrentVersion(handle.db, pipelineId);

    const without = [intake, decide, second].map((step) => ({ ...step, pipelineId: pipelineId as Uuid }));
    replacePipelineGraph(handle.db, pipelineId, without, []);
    expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).not.toContain(first.id);

    const back = [intake, decide, first, second].map((step) => ({ ...step, pipelineId: pipelineId as Uuid }));
    expect(replacePipelineGraph(handle.db, pipelineId, back, [])).toMatchObject({ replaced: true });
    expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).toContain(first.id);
    expect(listRetiredStepsForPipeline(handle.db, pipelineId)).toEqual([]);
  });

  it("binds an item to the destination pipeline's version when it is handed over", () => {
    const { pipelineId, steps } = drawPipeline();
    const other = drawPipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Handed on", stepId: steps[1]!.id });
    const mine = currentVersion(handle.db, pipelineId)!;

    transitionItem(handle.db, { itemId: item.id, toStepId: other.steps[0]!.id, toPipelineId: other.pipelineId as Uuid, actor: "human" });

    const theirs = currentVersion(handle.db, other.pipelineId)!;
    expect(theirs.id).not.toBe(mine.id);
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(theirs.id);
  });

  /**
   * The hand-off case, walked end to end (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * A route is resolved against the *sending* item's version, so a
   * hand-off drawn in v1 of Approvals can still name a step the
   * destination pipeline has since retired — the destination removed it
   * while it was empty, which it was entitled to do, and nothing there
   * could know an older version of another pipeline still pointed at it.
   * Binding that arrival to the destination's *current* version would
   * hand the item a graph with no definition for the step it is standing
   * on and no route leaving it: stranded on arrival.
   */
  it("binds a hand-off from an older version to the destination version that has the step", () => {
    const sender = drawPipeline();
    const receiver = drawPipeline();
    const [, decide] = sender.steps as [PipelineStep, PipelineStep];
    const [reception, review, , closed] = receiver.steps as [PipelineStep, PipelineStep, PipelineStep, PipelineStep];

    // Approvals hands `yes` to the receiver's Review step, and an item
    // enters on that version.
    repoint(sender.pipelineId, decide.id, review.id);
    const handsOver = currentVersion(handle.db, sender.pipelineId)!;
    const item = createTestItem(handle.db, { type: "story", title: "About to be handed over", stepId: decide.id });
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(handsOver.id);

    // The receiver then retires Review — empty, so it may go — and files
    // a version without it. Its current graph has no such step.
    // The version it had while Review was part of it. Filed here
    // explicitly; in an installation it is filed by the first item that
    // enters the receiver or by the first save of it, and the
    // retirement below would file it anyway.
    const hadReview = ensureCurrentVersion(handle.db, receiver.pipelineId)!;
    replacePipelineGraph(
      handle.db,
      receiver.pipelineId,
      [reception, closed].map((step) => ({ ...step, pipelineId: receiver.pipelineId as Uuid })),
      [{ pipelineId: receiver.pipelineId as Uuid, fromStepId: review.id, resultKey: "yes", label: "Yes", target: closed.id, position: 0 }],
    );
    expect(listStepsForPipeline(handle.db, receiver.pipelineId).map((step) => step.id)).not.toContain(review.id);

    // The sender's own version still resolves the hand-off, because a
    // retired step is a row and `listPipelineSteps` keeps it.
    const sending = graphForItem(handle.db, getItem(handle.db, item.id)!);
    const outcome = resolveRoute({
      step: sending.steps.find((step) => step.id === decide.id)!,
      steps: sending.steps,
      routes: sending.routes,
      result: "yes",
      stepsElsewhere: listPipelineSteps(handle.db).filter((step) => step.pipelineId !== sender.pipelineId),
    });
    expect(outcome).toEqual({ kind: "step", stepId: review.id, pipelineId: receiver.pipelineId });

    transitionItem(handle.db, { itemId: item.id, toStepId: review.id, toPipelineId: receiver.pipelineId as Uuid, actor: "human" });

    // **Not** the receiver's current version, which has no Review at all.
    const arrived = getItem(handle.db, item.id)!;
    expect(arrived.pipelineId).toBe(receiver.pipelineId);
    expect(arrived.pipelineVersionId).toBe(hadReview.id);
    expect(arrived.pipelineVersionId).not.toBe(currentVersion(handle.db, receiver.pipelineId)!.id);

    // And it can go on: the version it arrived on has the step, its
    // definition, and the route out of it.
    expect(stepForItem(handle.db, arrived)?.id).toBe(review.id);
    const onward = graphForItem(handle.db, arrived);
    expect(
      resolveRoute({ step: onward.steps.find((step) => step.id === review.id)!, steps: onward.steps, routes: onward.routes, result: "yes" }),
    ).toEqual({ kind: "step", stepId: receiver.steps[2]!.id, pipelineId: receiver.pipelineId });

    // Which it takes, landing on a step that version has.
    transitionItem(handle.db, { itemId: item.id, toStepId: receiver.steps[2]!.id, toPipelineId: receiver.pipelineId as Uuid, actor: "human" });
    expect(getItem(handle.db, item.id)?.stepId).toBe(receiver.steps[2]!.id);
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(hadReview.id);
  });

  /** The same question at the other door an item can enter by. */
  it("binds an item filed straight onto a retired step to the version that has it", () => {
    const { pipelineId, steps } = drawPipeline();
    const [intake, decide, first, second] = steps as [PipelineStep, PipelineStep, PipelineStep, PipelineStep];
    const hadFirst = ensureCurrentVersion(handle.db, pipelineId)!;

    replacePipelineGraph(
      handle.db,
      pipelineId,
      [intake, decide, second].map((step) => ({ ...step, pipelineId: pipelineId as Uuid })),
      [],
    );

    // A job stamping an item onto a step, or an import putting work back
    // where it was: it is standing there, so it binds to a version that
    // has the step rather than to one that does not.
    const filed = createTestItem(handle.db, { type: "story", title: "Filed onto a ghost", stepId: first.id });

    expect(getItem(handle.db, filed.id)?.pipelineVersionId).toBe(hadFirst.id);
    expect(stepForItem(handle.db, getItem(handle.db, filed.id)!)?.id).toBe(first.id);
  });

  it("keeps the version when the item moves within its own pipeline", () => {
    const { pipelineId, steps } = drawPipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Walking", stepId: steps[0]!.id });
    const v1 = currentVersion(handle.db, pipelineId)!;
    repoint(pipelineId, steps[1]!.id, steps[3]!.id);

    transitionItem(handle.db, { itemId: item.id, toStepId: steps[1]!.id, toPipelineId: pipelineId as Uuid, actor: "human" });

    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(v1.id);
  });

  it("holds a version's document still after the graph moves on", () => {
    const { pipelineId, steps } = drawPipeline();
    ensureCurrentVersion(handle.db, pipelineId);
    const v1 = currentVersion(handle.db, pipelineId)!;
    repoint(pipelineId, steps[1]!.id, steps[3]!.id);

    // v1 still says what v1 said, which is the whole of "immutable".
    // Every field of the route, not only where it went: a version is an
    // immutable route *set*, and a document that dropped the label and
    // the tone could not tell a save that renamed a button from one that
    // changed nothing (EO-327).
    expect(versionGraph(handle.db, v1.id)?.routes).toEqual([
      { fromStepId: steps[1]!.id, resultKey: "yes", label: "Yes", target: steps[2]!.id, tone: "info", position: 0 },
    ]);
    expect(versionGraph(handle.db, v1.id)?.steps.map((step) => step.name)).toEqual(["Intake", "Decide", "First", "Second"]);
  });

  /**
   * "Pipeline versions to keep" belongs to filing a version, not to any
   * one door that files one (EO-359, review). An editor save, an approved
   * suggestion and an import all write through `replacePipelineGraph`, so
   * that is where the limit is applied — and a rollback, which files
   * nothing, prunes nothing.
   */
  describe("retention, wherever a version is filed", () => {
    const numbers = (pipelineId: string) => listPipelineVersions(handle.db, pipelineId).map((version) => version.number);

    it("keeps only the newest three after five graph writes at a limit of three", () => {
      const { pipelineId, steps } = drawPipeline();
      setPipelineVersionsToKeep(handle.db, 3);

      for (let write = 0; write < 5; write += 1) repoint(pipelineId, steps[1]!.id, steps[write % 2 === 0 ? 2 : 3]!.id);

      // The first write files v1 of the graph it replaces, then v2.
      expect(numbers(pipelineId)).toEqual([4, 5, 6]);
      expect(currentVersion(handle.db, pipelineId)?.number).toBe(6);
    });

    it("prunes nothing on a rollback, which files no version", () => {
      const { pipelineId, steps } = drawPipeline();
      for (let write = 0; write < 4; write += 1) repoint(pipelineId, steps[1]!.id, steps[2]!.id);
      expect(numbers(pipelineId)).toEqual([1, 2, 3, 4, 5]);

      setPipelineVersionsToKeep(handle.db, 1);
      const v2 = listPipelineVersions(handle.db, pipelineId).find((version) => version.number === 2)!;
      const rolledBack = replacePipelineGraph(
        handle.db,
        pipelineId,
        listStepsForPipeline(handle.db, pipelineId).map((step) => ({ ...step, pipelineId: pipelineId as Uuid })),
        [],
        { republishVersionId: v2.id },
      );

      expect(rolledBack).toEqual({ replaced: true, version: 2 });
      expect(numbers(pipelineId)).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
