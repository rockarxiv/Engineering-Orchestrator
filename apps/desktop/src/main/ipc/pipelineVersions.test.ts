import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghostColumnLabel, pipelineUpdatedBanner, stepNotInVersionMessage, type PipelineStep, type PipelineStepView, type StepRouteView, type Uuid } from "@eo/core";
import { dispatchBlocker, resolveRoute } from "@eo/engine";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { items, pipelines, pipelineVersions } from "../db/schema.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import {
  addDependency,
  createAgent,
  createPerson,
  createPipeline,
  createRoute,
  createStep,
  currentVersion,
  ensureCurrentVersion,
  graphForItem,
  deleteItem,
  getItem,
  listCommentsForItem,
  listPipelineVersions,
  listStepsForPipeline,
  setEntryStep,
  setItemArchived,
  setStepOwner,
  transitionItem,
  unreachableRetiredSteps,
} from "../db/repos/index.js";
import { savePipeline } from "./configCommands.js";
import { sweepArchive } from "../archive/sweep.js";
import { getItemDetail, listInbox, listItemSummaries, listPipelineStepViews } from "./domainQueries.js";
import { decideItem, moveItem } from "./domainCommands.js";
import { buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { moveStepItemsCommand, pipelineVersionsCommand } from "./pipelineCommands.js";

/**
 * What a desktop shows for items on an older version (EO-327,
 * ARCHITECTURE.md, "Publish, lock and versions"): the banner over the board, the chip on a
 * card, and the ghost column for a step that is not there any more.
 */
describe("a board whose pipeline has moved on", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  let intake: PipelineStep;
  let decide: PipelineStep;
  let done: PipelineStep;

  const fakeEngine = () => ({ notifyStateChange: () => {} });

  /** The graph as the editor would send it back, minus whatever is named. */
  const asView = (steps: PipelineStep[]): PipelineStepView[] =>
    steps.map((step, index) => ({
      id: step.id,
      pipelineId,
      position: index,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      workspaceMode: step.workspaceMode,
      workspaceId: step.workspaceId,
      inputs: step.inputs,
      timeoutMs: step.timeoutMs,
      watch: step.watch,
      results: step.results,
    }));

  const save = (steps: PipelineStep[], routes: StepRouteView[] = []) =>
    savePipeline(handle.db, fakeEngine(), { pipelineId, steps: asView(steps), routes, entryStepId: intake.id });

  /**
   * A branch out of the Review step, as the editor publishes one.
   *
   * `results` on the step and a route for the key are two halves of one
   * thing — `validatePipeline` refuses a save where either is missing
   * its other — so the fixture writes both.
   */
  const decidesWith = (result: { key: string; label: string; tone: "success" | "warning" | "info" | "danger" }): PipelineStep => ({
    ...decide,
    results: [{ key: result.key, label: result.label, tone: result.tone, requiresComment: false }],
  });

  const branch = (result: { key: string; label: string; tone: "success" | "warning" | "info" | "danger" }, position = 0): StepRouteView => ({
    id: `route-${result.key}`,
    pipelineId,
    fromStepId: decide.id,
    resultKey: result.key,
    label: result.label,
    tone: result.tone,
    target: done.id,
    position,
  });

  beforeEach(() => {
    handle = openMigratedTestDb();
    const pipeline = createPipeline(handle.db, { projectId: null, name: "Approvals" });
    pipelineId = pipeline.id as Uuid;
    intake = createStep(handle.db, { pipelineId, position: 0, name: "Intake", type: "user" });
    decide = createStep(handle.db, { pipelineId, position: 1, name: "Review", type: "user" });
    done = createStep(handle.db, { pipelineId, position: 2, name: "Done", type: "user", isTerminal: true });
    setEntryStep(handle.db, pipelineId, intake.id);
  });

  afterEach(() => {
    handle.close();
  });

  /** A step the editor is about to publish, which is not a row until the save writes it. */
  const notYetPublished = (name: string): PipelineStep => ({ ...done, id: `step-${name.toLowerCase()}` as Uuid, name, isTerminal: false, position: 3 });

  /**
   * The second acceptance criterion, end to end and through the door a
   * person actually meets it at: the save is refused with the count, the
   * offer moves the work, and the same save then lands.
   */
  it("refuses to remove a step holding two items with the count, and takes the same save once they have moved", () => {
    createTestItem(handle.db, { type: "story", title: "First", stepId: decide.id });
    createTestItem(handle.db, { type: "story", title: "Second", stepId: decide.id });

    const refused = save([intake, done]);

    expect(refused.saved).toBe(false);
    expect(refused.version).toBeNull();
    expect(refused.problems[0]?.message).toContain("2 items");
    expect(refused.problems[0]?.holdsItems).toEqual({ stepId: decide.id, stepName: "Review", count: 2, archived: 0 });
    // No version filed: the two items above made v1 when they bound to
    // the pipeline, and a refused save adds nothing to it.
    expect(listPipelineStepViews(handle.db, { pipelineId }).version?.number).toBe(1);

    // The offer: "move them to X", through the ordinary transition path.
    const moved = moveStepItemsCommand(handle.db, { fromStepId: decide.id, toStepId: intake.id });
    expect(moved).toEqual({ moved: 2, archived: 0, running: 0, otherVersion: 0, problem: null });

    const accepted = save([intake, done]);
    expect(accepted.saved).toBe(true);
    expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).not.toContain(decide.id);
  });

  it("says why each item moved, in its own thread", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Moved for me", stepId: decide.id });

    moveStepItemsCommand(handle.db, { fromStepId: decide.id, toStepId: intake.id });

    expect(getItem(handle.db, item.id)?.stepId).toBe(intake.id);
    const engineComments = listCommentBodies(handle, item.id);
    expect(engineComments.some((body) => body.includes("Moved from **Review** to **Intake**"))).toBe(true);
  });

  /**
   * The third acceptance criterion. The ghost appears because an item
   * bound to v1 is routed onto a step v2 removed — the only way a step
   * can be both gone and occupied — and it disappears when the last item
   * leaves, with nobody dismissing it.
   */
  it("draws a ghost column for a step only an older version has, and stops when the last item leaves", () => {
    const first = createTestItem(handle.db, { type: "story", title: "First", stepId: intake.id });
    const second = createTestItem(handle.db, { type: "story", title: "Second", stepId: intake.id });

    // v1 exists because those two bound to it. v2 removes Review, which
    // is empty and so may go.
    expect(save([intake, done]).saved).toBe(true);

    // Both items finish on v1, which still has Review — so they can be
    // moved onto it, and the board has to say so.
    for (const item of [first, second]) {
      transitionItem(handle.db, { itemId: item.id, toStepId: decide.id, toPipelineId: pipelineId, actor: "human" });
    }

    const board = listPipelineStepViews(handle.db, { pipelineId });
    expect(board.steps.map((step) => step.id)).not.toContain(decide.id);
    expect(board.ghosts).toEqual([{ stepId: decide.id, name: "Review", version: 1, holding: 2 }]);
    expect(ghostColumnLabel({ stepName: "Review", number: 1, holding: 2 })).toBe("Review (v1) · 2 finishing");

    transitionItem(handle.db, { itemId: first.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    expect(listPipelineStepViews(handle.db, { pipelineId }).ghosts).toEqual([
      { stepId: decide.id, name: "Review", version: 1, holding: 1 },
    ]);

    transitionItem(handle.db, { itemId: second.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    expect(listPipelineStepViews(handle.db, { pipelineId }).ghosts).toEqual([]);
  });

  it("counts what is finishing on the old version, and chips the cards that are", () => {
    const older = createTestItem(handle.db, { type: "story", title: "Older", stepId: intake.id });
    expect(save([intake, decide, done]).saved).toBe(true);
    const newer = createTestItem(handle.db, { type: "story", title: "Newer", stepId: intake.id });

    const board = listPipelineStepViews(handle.db, { pipelineId });
    expect(board.version?.number).toBe(2);
    expect(board.finishingOn).toEqual([{ number: 1, items: 1 }]);
    expect(pipelineUpdatedBanner({ current: 2, older: board.finishingOn, by: "Dana" })).toBe("Pipeline updated to v2 by Dana · 1 item finishes on v1");

    const summaries = new Map(listItemSummaries(handle.db, null).items.map((item) => [item.id, item.pipelineVersion]));
    // The chip is on the card that is not on the current version, and on
    // nothing else: a board nobody has edited draws no chips at all.
    expect(summaries.get(older.id)).toBe(1);
    expect(summaries.get(newer.id)).toBeNull();
  });

  /**
   * The half of "finishes on the version it entered on" that is about
   * *running* rather than routing (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * A human step whose decisions a later save renamed is the sharpest
   * case there is: the person is shown the buttons of a version this
   * item is not on, presses one, and `items:decide` judges the answer
   * against declarations its own routes have no branch for. Both ends
   * have to read the item's own version or neither is any use.
   */
  it("offers an older version's buttons on an older version's item, and takes the answer", () => {
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    // The item enters on v1, standing on the step whose decisions the
    // next save is about to rewrite.
    const item = createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: decide.id });

    // v2 renames the key entirely: "approved" is gone, "shipped" is what
    // this step declares now, and its route goes with it.
    const ships = { key: "shipped", label: "Ship it", tone: "success" } as const;
    expect(save([intake, decidesWith(ships), done], [branch(ships)]).saved).toBe(true);

    // The detail offers what v1 declared, not what v2 does.
    const detail = getItemDetail(handle.db, { itemId: item.id });
    expect(detail?.decision.map((decision) => decision.key)).toEqual(["approved"]);

    // And the answer is taken, and routed by v1.
    const decided = decideItem(handle.db, undefined, { itemId: item.id, resultKey: "approved", comment: "" });
    expect(decided.problem).toBeNull();
    expect(decided.decided).toBe(true);
    expect(getItem(handle.db, item.id)?.stepId).toBe(done.id);

    // The live graph's own key is refused on this item, because v1 has
    // no such decision to take.
    const newer = createTestItem(handle.db, { type: "story", title: "On v2", stepId: decide.id });
    expect(decideItem(handle.db, undefined, { itemId: newer.id, resultKey: "shipped", comment: "" }).decided).toBe(true);
  });

  /**
   * The same promise for dispatch. A save that turns an agent step into
   * a human one must not strand the work already standing on it: the
   * scheduler is told each older item's own definition, so it still sees
   * an `agent` step to run.
   */
  it("schedules an older version's item by the step its own version declares", () => {
    createAgent(handle.db, { name: "Implementer", role: "implementer", provider: "fake", model: null, instructions: "Do the work." });
    const agentStep: PipelineStep = { ...decide, type: "agent", ownerRole: "implementer", entryAction: "implement" };
    // Routed, because an agent step has to say where each result its
    // action declares goes (EO-423), and `implement` declares `done`.
    const implemented: StepRouteView = { id: "route-done", pipelineId, fromStepId: decide.id, resultKey: "done", label: "Done", tone: "success", target: done.id, position: 0 };
    expect(save([intake, agentStep, done], [implemented]).saved).toBe(true);

    const item = createTestItem(handle.db, { type: "story", title: "Being implemented", stepId: decide.id, spec: REVIEWABLE_SPEC });

    // v3 makes the same step a person's. The live row now says `user`,
    // which the scheduler would never dispatch.
    expect(save([intake, { ...decide, type: "user" }, done]).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === decide.id)?.type).toBe("user");

    const input = buildEligibilityInput(handle.db, false);
    expect(input.stepsByItem?.get(item.id)).toMatchObject({ id: decide.id, type: "agent", ownerRole: "implementer" });
    // Nothing stands between it and a slot: the blocker asked of the
    // live row would be "this step has no role to dispatch".
    expect(dispatchBlocker(input, item.id)).toBeNull();
  });

  /**
   * Who waits at a step is part of what a version says (EO-327, ARCHITECTURE.md, "Publish, lock and
   * versions",
   * EO-302). If v1 sends an item to a step Dana approves at and v2 hands
   * that step to Pat, the item that entered on v1 arrives on Dana's
   * step — the arrival is a step of *finishing*, and finishing happens
   * under the rules the item entered on.
   */
  it("assigns an arriving item to the person its own version's step waits on", () => {
    const dana = createPerson(handle.db, { name: "Dana", email: "dana@example.com" });
    const pat = createPerson(handle.db, { name: "Pat", email: "pat@example.com" });
    setStepOwner(handle.db, done.id, { personId: dana.id, groupId: null });

    // v1 is taken with Done waiting on Dana, and the item binds to it.
    const item = createTestItem(handle.db, { type: "story", title: "Entered under Dana", stepId: intake.id });
    expect(currentVersion(handle.db, pipelineId)?.number).toBe(1);

    // v2 hands the same step to Pat. `steps:setOwner` is not part of a
    // published graph, so the save is what files the version that
    // records it.
    setStepOwner(handle.db, done.id, { personId: pat.id, groupId: null });
    expect(save([intake, decide, done]).saved).toBe(true);

    transitionItem(handle.db, { itemId: item.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    expect(getItem(handle.db, item.id)?.assigneeId).toBe(dana.id);

    // And an item that entered afterwards arrives on Pat's step.
    const newer = createTestItem(handle.db, { type: "story", title: "Entered under Pat", stepId: intake.id });
    transitionItem(handle.db, { itemId: newer.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    expect(getItem(handle.db, newer.id)?.assigneeId).toBe(pat.id);
  });

  /**
   * A step removed from the pipeline keeps whatever is filed against it
   * for as long as an older version can still route work onto it
   * (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). Its module secrets are reachable only
   * through its
   * id, so discarding them at the moment of removal is how a ghost
   * step's run fails with the module's name on it and no way back.
   */
  it("keeps a retired step's belongings while an older version can still reach it, and reports them once it cannot", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Finishing on v1", stepId: intake.id });
    const discarded: string[][] = [];
    const saveWatching = () =>
      savePipeline(handle.db, fakeEngine(), { pipelineId, steps: asView([intake, done]), routes: [], entryStepId: intake.id }, (stepIds) =>
        discarded.push(stepIds),
      );

    // Review goes. It is empty, so the save lands — and v1, which the
    // item is on, still has it.
    expect(saveWatching().saved).toBe(true);
    expect(discarded).toEqual([]);
    expect(unreachableRetiredSteps(handle.db, pipelineId)).toEqual([]);

    // The item routes onto it, which is the ghost column: still nothing
    // to discard, for the more obvious reason.
    transitionItem(handle.db, { itemId: item.id, toStepId: decide.id, toPipelineId: pipelineId, actor: "human" });
    expect(unreachableRetiredSteps(handle.db, pipelineId)).toEqual([]);

    // It finishes and is archived, so no version anybody is bound to can
    // reach the step any more — and the next ordinary save sweeps it up.
    transitionItem(handle.db, { itemId: item.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    setItemArchived(handle.db, item.id, Date.now());
    deleteItem(handle.db, item.id);

    expect(unreachableRetiredSteps(handle.db, pipelineId)).toEqual([decide.id]);
    expect(saveWatching().saved).toBe(true);
    expect(discarded).toEqual([[decide.id]]);
  });

  /**
   * And kept when the item that will need it is on *another pipeline*
   * (EO-327, ARCHITECTURE.md, "Publish, lock and versions", EO-58).
   *
   * A route is resolved against the sending item's version, so a
   * hand-off drawn in an older version of another pipeline can still
   * name a step this one has retired. Asking only about this pipeline's
   * own items is how the credential filed against that step gets thrown
   * away while the item that will run there is still two steps upstream
   * somewhere else — and the module then fails with its own name on it,
   * for a secret EO deleted.
   */
  it("keeps a retired step's belongings while another pipeline's older version can still hand work to it", () => {
    // The receiver, whose step the sender hands work to.
    const receiver = createPipeline(handle.db, { projectId: null, name: "Merge" });
    const receiverId = receiver.id as Uuid;
    const reception = createStep(handle.db, { pipelineId: receiverId, position: 0, name: "Reception", type: "user" });
    const deploy = createStep(handle.db, { pipelineId: receiverId, position: 1, name: "Deploy", type: "module", entryAction: "deploy-module" });
    const closed = createStep(handle.db, { pipelineId: receiverId, position: 2, name: "Closed", type: "user", isTerminal: true });
    setEntryStep(handle.db, receiverId, reception.id);
    ensureCurrentVersion(handle.db, receiverId);

    // The sender's version hands `approved` to Deploy, and an item
    // enters on it — standing well upstream, on Intake.
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    expect(save([intake, decidesWith(approves), done], [{ ...branch(approves), target: deploy.id }]).saved).toBe(true);
    const upstream = createTestItem(handle.db, { type: "story", title: "Will be handed over", stepId: intake.id });
    // …and the sender stops handing work there, which is what lets the
    // receiver retire the step at all (EO-167 refuses while a live route
    // points at it). The item is still on the version that hands off.
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    const discarded: string[][] = [];
    const saveReceiver = (steps: PipelineStep[]) =>
      savePipeline(
        handle.db,
        fakeEngine(),
        {
          pipelineId: receiverId,
          steps: steps.map((step, index) => ({ ...asView([step])[0]!, id: step.id, pipelineId: receiverId, position: index, name: step.name, type: step.type, entryAction: step.entryAction, isTerminal: step.isTerminal })),
          routes: [],
          entryStepId: reception.id,
        },
        (stepIds) => discarded.push(stepIds),
      );

    // The receiver retires Deploy. Nothing of its is discarded: an item
    // on another pipeline's older version can still be routed onto it.
    expect(saveReceiver([reception, closed]).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, receiverId).map((step) => step.id)).not.toContain(deploy.id);
    expect(discarded).toEqual([]);
    expect(unreachableRetiredSteps(handle.db, receiverId)).toEqual([]);

    // Still nothing once the item has actually arrived there.
    transitionItem(handle.db, { itemId: upstream.id, toStepId: decide.id, toPipelineId: pipelineId, actor: "human" });
    expect(decideItem(handle.db, undefined, { itemId: upstream.id, resultKey: "approved", comment: "" })).toMatchObject({
      decided: true,
      toStepId: deploy.id,
    });
    expect(unreachableRetiredSteps(handle.db, receiverId)).toEqual([]);

    // And discarded only once nothing anywhere can reach it.
    deleteItem(handle.db, upstream.id);
    expect(unreachableRetiredSteps(handle.db, receiverId)).toEqual([deploy.id]);
    expect(saveReceiver([reception, closed]).saved).toBe(true);
    expect(discarded).toEqual([[deploy.id]]);
  });

  /**
   * A person's Approve completing a hand-off its own version drew, to a
   * step the destination has since retired (EO-327, ARCHITECTURE.md, "Publish, lock and versions",
   * EO-58).
   *
   * The narrow case where a decision and an agent's verdict could
   * disagree: `routeResult` is handed every step in the installation,
   * retired rows included, while the decision path is handed the steps
   * other pipelines *have*. So the same route resolved for an agent and
   * refused for a person — and the item sat on a human step with a
   * button that could not be pressed, which is the quietest kind of
   * stuck there is.
   */
  it("takes a decision that hands work to a step the destination pipeline has retired, and routes it onward there", () => {
    // The receiving pipeline: a step to hand work to, and somewhere for
    // it to go afterwards.
    const receiver = createPipeline(handle.db, { projectId: null, name: "Merge" });
    const receiverId = receiver.id as Uuid;
    const reception = createStep(handle.db, { pipelineId: receiverId, position: 0, name: "Reception", type: "user" });
    const review = createStep(handle.db, { pipelineId: receiverId, position: 1, name: "Second pair of eyes", type: "user" });
    const closed = createStep(handle.db, { pipelineId: receiverId, position: 2, name: "Closed", type: "user", isTerminal: true });
    createRoute(handle.db, { pipelineId: receiverId, fromStepId: review.id, resultKey: "seen", label: "Seen", target: closed.id });
    setEntryStep(handle.db, receiverId, reception.id);
    const hadReview = ensureCurrentVersion(handle.db, receiverId)!;

    // Approvals hands `approved` to that step, and an item enters on the
    // version that says so.
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    expect(save([intake, decidesWith(approves), done], [{ ...branch(approves), target: review.id }]).saved).toBe(true);
    const item = createTestItem(handle.db, { type: "story", title: "Waiting on a person", stepId: decide.id });

    // Approvals then stops handing work there — which is what lets the
    // receiver retire the step at all: while a live route points at it,
    // removing it is refused (EO-167). The item is still on the version
    // that hands off, which is the whole case.
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    const withoutReview = [reception, closed].map((step, index) => ({
      id: step.id,
      pipelineId: receiverId,
      position: index,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      workspaceMode: step.workspaceMode,
      workspaceId: step.workspaceId,
      inputs: step.inputs,
      timeoutMs: step.timeoutMs,
      watch: step.watch,
      results: step.results,
    }));
    expect(savePipeline(handle.db, fakeEngine(), { pipelineId: receiverId, steps: withoutReview, routes: [], entryStepId: reception.id }).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, receiverId).map((step) => step.id)).not.toContain(review.id);

    // The button still names where it goes, and pressing it works.
    const detail = getItemDetail(handle.db, { itemId: item.id });
    expect(detail?.decision).toEqual([expect.objectContaining({ key: "approved", targetName: "Second pair of eyes" })]);

    const decided = decideItem(handle.db, undefined, { itemId: item.id, resultKey: "approved", comment: "" });
    expect(decided.problem).toBeNull();
    expect(decided).toMatchObject({ decided: true, toStepId: review.id, toPipelineId: receiverId });

    // It arrived on the receiver's *older* version — the one that has
    // the step — so it has a definition to run and a route to leave by.
    const arrived = getItem(handle.db, item.id)!;
    expect(arrived.pipelineId).toBe(receiverId);
    expect(arrived.pipelineVersionId).toBe(hadReview.id);
    expect(arrived.pipelineVersionId).not.toBe(currentVersion(handle.db, receiverId)!.id);

    // An item that enters Approvals now takes the current route, which
    // hands off nowhere: the widening is for the older version only.
    const newer = createTestItem(handle.db, { type: "story", title: "Entered after the repoint", stepId: decide.id });
    expect(decideItem(handle.db, undefined, { itemId: newer.id, resultKey: "approved", comment: "" })).toMatchObject({
      decided: true,
      toStepId: done.id,
      toPipelineId: pipelineId,
    });

    // And onward, by that version's own route out of the retired step.
    const onward = graphForItem(handle.db, arrived);
    expect(
      resolveRoute({ step: onward.steps.find((step) => step.id === review.id)!, steps: onward.steps, routes: onward.routes, result: "seen" }),
    ).toEqual({ kind: "step", stepId: closed.id, pipelineId: receiverId });
    transitionItem(handle.db, { itemId: item.id, toStepId: closed.id, toPipelineId: receiverId, actor: "human" });
    expect(getItem(handle.db, item.id)?.stepId).toBe(closed.id);
  });

  /**
   * Whether an item is *finished* is the most consequential thing a
   * version says about it (EO-327, ARCHITECTURE.md, "Publish, lock and versions"): it releases
   * everything waiting
   * on it, closes its feature, takes it out of the inbox's "everything
   * is blocked", and eventually puts it in the Archive. All four of
   * those read the same answer, so all four are asserted here.
   */
  it("does not finish an older version's item because a later save marked its step terminal", () => {
    const waiting = createTestItem(handle.db, { type: "story", title: "Waits for the other one", stepId: intake.id });
    const item = createTestItem(handle.db, { type: "story", title: "Mid-flight on Review", stepId: decide.id });
    addDependency(handle.db, waiting.id, item.id);

    // v2 marks Review terminal. The item entered on v1, which says it
    // has further to go.
    expect(save([intake, { ...decide, isTerminal: true }, done]).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === decide.id)?.isTerminal).toBe(true);

    // Nothing that waits on it is released.
    const summaries = new Map(listItemSummaries(handle.db, null).items.map((row) => [row.id, row]));
    expect(summaries.get(waiting.id)?.openDependencyCount).toBe(1);
    // Nor does the Archive take it, however long it has stood there.
    expect(sweepArchive(handle.db, Date.now() + 365 * 24 * 60 * 60 * 1000)).toEqual({ archived: 0, disabled: false });
    expect(getItem(handle.db, item.id)?.archivedAt).toBeNull();
    // And the board still counts it as work the engine could move.
    expect(listInbox(handle.db, null).summary.everythingBlocked).toBe(false);

    // An item that enters *now* is finished the moment it lands there,
    // because its version says so.
    const newer = createTestItem(handle.db, { type: "story", title: "Entered after the change", stepId: decide.id });
    expect(listItemSummaries(handle.db, null).items.find((row) => row.id === newer.id)?.stepName).toBe("Review");
    const waitsOnNewer = createTestItem(handle.db, { type: "story", title: "Waits for the newer one", stepId: intake.id });
    addDependency(handle.db, waitsOnNewer.id, newer.id);
    expect(listItemSummaries(handle.db, null).items.find((row) => row.id === waitsOnNewer.id)?.openDependencyCount).toBe(0);
  });

  /**
   * The mirror, which is the worse direction: work that genuinely
   * finished would be reported as still running for ever, holding open
   * everything that waits on it.
   */
  it("keeps an older version's item finished after a later save unmarks its step", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Finished on v1", stepId: intake.id });
    const waiting = createTestItem(handle.db, { type: "story", title: "Waits on it", stepId: intake.id });
    addDependency(handle.db, waiting.id, item.id);
    transitionItem(handle.db, { itemId: item.id, toStepId: done.id, toPipelineId: pipelineId, actor: "human" });
    expect(listItemSummaries(handle.db, null).items.find((row) => row.id === waiting.id)?.openDependencyCount).toBe(0);

    // v2 says Done is no longer the end — the pipeline carries on to a
    // new step, which is where a graph has to end (`validatePipeline`
    // refuses one with no terminal step at all). The item finished under
    // v1 and is still finished.
    const ending = createStep(handle.db, { pipelineId, position: 3, name: "Shipped", type: "user", isTerminal: true });
    expect(save([intake, decide, { ...done, isTerminal: false }, ending]).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === done.id)?.isTerminal).toBe(false);

    expect(listItemSummaries(handle.db, null).items.find((row) => row.id === waiting.id)?.openDependencyCount).toBe(0);
  });

  /**
   * What the chat rail's planned and finished counts are added up from
   * (EO-384): the flag is the step's `isTerminal`, never its name, so
   * renaming steps in either direction moves nothing.
   */
  it("says which items stand on a terminal step, whatever the steps are called", () => {
    const queued = createTestItem(handle.db, { type: "story", title: "Queued", stepId: intake.id });
    const working = createTestItem(handle.db, { type: "story", title: "Being reviewed", stepId: decide.id });
    const shipped = createTestItem(handle.db, { type: "story", title: "Shipped", stepId: done.id });
    const swept = createTestItem(handle.db, { type: "story", title: "Shipped long ago", stepId: done.id });
    const feature = createTestItem(handle.db, { type: "feature", title: "The feature", stepId: null });

    const flags = () => new Map(listItemSummaries(handle.db, null).items.map((row) => [row.id, row.atTerminalStep]));
    const expected = new Map([
      [queued.id, false],
      [working.id, false],
      [shipped.id, true],
      [swept.id, true],
      [feature.id, false],
    ]);
    expect(flags()).toEqual(expected);
    // The detail spreads the same summary, so it says the same thing.
    expect(getItemDetail(handle.db, { itemId: shipped.id })?.item.atTerminalStep).toBe(true);

    // The terminal step loses the word, and a step in the middle takes it.
    expect(save([intake, { ...decide, name: "Done" }, { ...done, name: "Parking" }]).saved).toBe(true);
    expect(listItemSummaries(handle.db, null).items.find((row) => row.id === working.id)?.stepName).toBe("Review");
    expect(flags()).toEqual(expected);
    // Nor for an item that enters after the rename, and reads the new names.
    const later = createTestItem(handle.db, { type: "story", title: "Entered after the rename", stepId: decide.id });
    const parked = createTestItem(handle.db, { type: "story", title: "Finished after the rename", stepId: done.id });
    const renamed = new Map(listItemSummaries(handle.db, null).items.map((row) => [row.id, row]));
    expect(renamed.get(later.id)).toMatchObject({ stepName: "Done", atTerminalStep: false });
    expect(renamed.get(parked.id)).toMatchObject({ stepName: "Parking", atTerminalStep: true });

    // An archived item is not on the list at all, so it is in neither count.
    setItemArchived(handle.db, swept.id, Date.now());
    expect(flags().has(swept.id)).toBe(false);
  });

  /** A feature is finished when its stories are — each by its own version. */
  it("does not call a feature done because a later save made its stories' step terminal", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "The feature", stepId: null });
    createTestItem(handle.db, { type: "story", title: "Still going", stepId: decide.id, parentId: feature.id });

    expect(save([intake, { ...decide, isTerminal: true }, done]).saved).toBe(true);

    const row = listItemSummaries(handle.db, null).items.find((entry) => entry.id === feature.id);
    expect(row?.progress).toEqual({ done: 0, total: 1 });
    expect(row?.stepName).toBe("0 of 1 done");
  });

  /**
   * A save that is interrupted leaves nothing behind (EO-327, ARCHITECTURE.md, "Publish, lock and
   * versions").
   *
   * The graph, where work enters it, and the version that freezes both
   * are three writes that must never be seen apart. The dangerous gap is
   * the middle one: new steps live under the *old* current version means
   * every item still bound to it reads as "on the current version", so
   * `boundGraphForItem` answers with the live rows and work mid-flight
   * finishes on a graph it never entered — the one promise this story
   * makes, broken by a power cut.
   *
   * The crash is simulated where it can actually happen, by failing the
   * version insert: the graph has landed by then, which is precisely the
   * state the transaction has to undo.
   */
  it("leaves the graph, the entry step and the pointer untouched when filing the version fails", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Mid-flight", stepId: decide.id });
    const v1 = currentVersion(handle.db, pipelineId)!;
    const before = listStepsForPipeline(handle.db, pipelineId);

    const stop = failStatementsMatching(handle, /insert into "pipeline_versions"/i);
    try {
      expect(() => save([intake, { ...decide, name: "Second look" }, done])).toThrow("the lights went out");
    } finally {
      stop();
    }

    // Nothing moved: not the step somebody renamed, not the pointer, and
    // not what the item is bound to.
    expect(listStepsForPipeline(handle.db, pipelineId)).toEqual(before);
    expect(currentVersion(handle.db, pipelineId)?.id).toBe(v1.id);
    expect(getItem(handle.db, item.id)?.pipelineVersionId).toBe(v1.id);
    // And the save that follows lands whole, which is what makes this a
    // crash rather than a corruption.
    expect(save([intake, { ...decide, name: "Second look" }, done]).saved).toBe(true);
    expect(listStepsForPipeline(handle.db, pipelineId).find((step) => step.id === decide.id)?.name).toBe("Second look");
    expect(currentVersion(handle.db, pipelineId)?.number).toBe(2);
  });

  /**
   * The same for the lazy v1 a pipeline gets the first time anybody asks
   * what version it is on. Filing it and pointing at it while the items
   * standing in it are still unbound is the same hazard read the other
   * way round: they would all report as current, and the next save would
   * move them onto a graph they never entered.
   */
  it("files no v1 at all when binding the items already standing there fails", () => {
    const fresh = createPipeline(handle.db, { projectId: null, name: "Fresh" });
    const only = createStep(handle.db, { pipelineId: fresh.id as Uuid, position: 0, name: "Only", type: "user", isTerminal: true });
    setEntryStep(handle.db, fresh.id, only.id);
    // Standing on the pipeline with no version filed yet — the state the
    // migration leaves, and the one a pack install leaves.
    const standing = createTestItem(handle.db, { type: "story", title: "Already here", stepId: only.id });
    // Wound back to the state the migration leaves: the item standing
    // there, and no version filed at all. (Creating it filed one, which
    // is the whole point of the lazy path — this is what it looked like
    // a moment before.)
    handle.db.update(items).set({ pipelineVersionId: null }).where(eq(items.id, standing.id)).run();
    handle.db.update(pipelines).set({ currentVersionId: null }).where(eq(pipelines.id, fresh.id)).run();
    handle.db.delete(pipelineVersions).where(eq(pipelineVersions.pipelineId, fresh.id)).run();

    const stop = failStatementsMatching(handle, /update "items" set "pipeline_version_id"/i);
    try {
      expect(() => ensureCurrentVersion(handle.db, fresh.id)).toThrow("the lights went out");
    } finally {
      stop();
    }

    // No half-filed version: no row, no pointer, and the item still
    // unbound rather than bound to something that does not exist.
    expect(listPipelineVersions(handle.db, fresh.id)).toEqual([]);
    expect(currentVersion(handle.db, fresh.id)).toBeUndefined();
    expect(getItem(handle.db, standing.id)?.pipelineVersionId).toBeNull();

    // Asked again, it files the whole thing.
    const filed = ensureCurrentVersion(handle.db, fresh.id)!;
    expect(filed.number).toBe(1);
    expect(getItem(handle.db, standing.id)?.pipelineVersionId).toBe(filed.id);
  });

  /**
   * The other direction of the same rule: an item cannot be walked out
   * of the graph it agreed to. A step added after it entered has no
   * definition in its version and no route leaving it.
   */
  it("refuses to move an older version's item onto a step that version does not have", () => {
    const item = createTestItem(handle.db, { type: "story", title: "On v1", stepId: intake.id });

    // v2 adds a step v1 never had — in the save, as the editor does. A
    // step written outside one is the live graph the item was already
    // standing in, and a publish catches its version up to it (EO-514).
    const extra = notYetPublished("QA");
    expect(save([intake, decide, done, extra]).saved).toBe(true);

    const refused = moveItem(handle.db, undefined, { itemId: item.id, toStepId: extra.id, cancelActiveRun: false, comment: "" });

    expect(refused.moved).toBe(false);
    expect(refused.problem).toBe(stepNotInVersionMessage({ stepName: "QA", number: 1 }));
    expect(getItem(handle.db, item.id)?.stepId).toBe(intake.id);

    // A step v1 does have is still a move it can make.
    expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: done.id, cancelActiveRun: false, comment: "" }).moved).toBe(true);
  });

  it("leaves such an item behind when a bulk move names a step its version lacks, and counts it", () => {
    const older = createTestItem(handle.db, { type: "story", title: "On v1", stepId: decide.id });
    const extra = notYetPublished("QA");
    expect(save([intake, decide, done, extra]).saved).toBe(true);
    const newer = createTestItem(handle.db, { type: "story", title: "On v2", stepId: decide.id });

    const moved = moveStepItemsCommand(handle.db, { fromStepId: decide.id, toStepId: extra.id });

    expect(moved).toEqual({ moved: 1, archived: 0, running: 0, otherVersion: 1, problem: null });
    expect(getItem(handle.db, newer.id)?.stepId).toBe(extra.id);
    expect(getItem(handle.db, older.id)?.stepId).toBe(decide.id);
  });

  /**
   * The route half of "what changed" (EO-327, ARCHITECTURE.md, "Publish, lock and versions"). A
   * version is an
   * immutable route *set*, so a save that renames a button produces a
   * different set — and the diff has to say so, or "View changes" is
   * silent about the commonest edit anybody makes to a branch.
   */
  it("answers a route edit that leaves the target alone", () => {
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    createTestItem(handle.db, { type: "story", title: "Binds v1", stepId: intake.id });
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    // Only the words on the button, the colour of its dot and where it
    // sits in the list. Nothing about where it goes.
    const renamed = { key: "approved", label: "Ship it", tone: "warning" } as const;
    expect(save([intake, decidesWith(renamed), done], [branch(renamed, 3)]).saved).toBe(true);

    const answer = pipelineVersionsCommand(handle.db, { pipelineId, from: 2, to: 3 });

    expect(answer.diff?.routes).toEqual([
      {
        fromStepName: "Review",
        resultKey: "approved",
        change: "changed",
        fields: [
          { field: "label", before: "Approve", after: "Ship it" },
          { field: "tone", before: "success", after: "warning" },
          { field: "position", before: "0", after: "3" },
        ],
      },
    ]);
  });

  it("answers a route that was added, with where it goes", () => {
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    createTestItem(handle.db, { type: "story", title: "Binds v1", stepId: intake.id });
    expect(save([intake, decide, done]).saved).toBe(true);
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    expect(pipelineVersionsCommand(handle.db, { pipelineId }).diff?.routes).toEqual([
      {
        fromStepName: "Review",
        resultKey: "approved",
        change: "added",
        fields: [
          { field: "target", before: null, after: "Done" },
          { field: "label", before: null, after: "Approve" },
          { field: "tone", before: null, after: "success" },
          { field: "position", before: null, after: "0" },
        ],
      },
    ]);
  });

  /**
   * The step half of the same completeness (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   * `position`
   * and `results` are saved into the document, so a save that reorders
   * the columns or rewrites a button is a distinct immutable version —
   * and "View changes" has to say so.
   */
  it("answers a step edit that is only an order and a decision", () => {
    const approves = { key: "approved", label: "Approve", tone: "success" } as const;
    createTestItem(handle.db, { type: "story", title: "Binds v1", stepId: intake.id });
    expect(save([intake, decidesWith(approves), done], [branch(approves)]).saved).toBe(true);

    // Review moves to the end, and its button is renamed. Nothing else.
    const renamed = { key: "approved", label: "Ship it", tone: "success" } as const;
    expect(save([intake, done, decidesWith(renamed)], [branch(renamed)]).saved).toBe(true);

    const changed = pipelineVersionsCommand(handle.db, { pipelineId, from: 2, to: 3 }).diff?.steps ?? [];
    const review = changed.find((step) => step.stepId === decide.id);

    expect(review?.fields).toEqual([
      { field: "position", before: "1", after: "2" },
      { field: "results", before: 'approved "Approve" (success)', after: 'approved "Ship it" (success)' },
    ]);
    // And the step it swapped places with says so too, rather than the
    // diff reporting one half of a reorder.
    expect(changed.find((step) => step.stepId === done.id)?.fields).toEqual([{ field: "position", before: "2", after: "1" }]);
  });

  it("answers what changed between two versions, in steps, routes and prompts", () => {
    createTestItem(handle.db, { type: "story", title: "Binds v1", stepId: intake.id });
    const renamed = { ...decide, name: "Second look", instructionsSummary: "Look again." };
    expect(save([intake, renamed, done]).saved).toBe(true);

    const answer = pipelineVersionsCommand(handle.db, { pipelineId });

    expect(answer.versions.map((version) => version.number)).toEqual([1, 2]);
    expect(answer.diff?.from).toBe(1);
    expect(answer.diff?.to).toBe(2);
    expect(answer.diff?.steps).toEqual([
      {
        stepId: decide.id,
        name: "Second look",
        change: "changed",
        kind: { type: "user", ownerRole: null, entryAction: null },
        fields: [
          { field: "name", before: "Review", after: "Second look" },
          { field: "instructionsSummary", before: null, after: "Look again." },
        ],
      },
    ]);
  });
});

/**
 * Stops the next statement that matches, the way a power cut would.
 *
 * At the driver rather than at drizzle, because a transaction runs its
 * statements through the transaction object and not through the one the
 * caller holds — so a spy on `db.insert` sees the outer calls and misses
 * exactly the ones this is about. `$client.prepare` is where every
 * statement passes, whichever object issued it.
 *
 * Returns the undo, which the caller runs in a `finally`: a database
 * left with a throwing driver would fail the next test for a reason
 * that has nothing to do with it.
 */
function failStatementsMatching(handle: DbHandle, pattern: RegExp): () => void {
  const client = (handle.db as unknown as { $client: { prepare: (sql: string) => unknown } }).$client;
  const prepare = client.prepare.bind(client);
  client.prepare = (sql: string) => {
    if (pattern.test(sql)) throw new Error("the lights went out");
    return prepare(sql);
  };
  return () => {
    client.prepare = prepare;
  };
}

/** The bodies of everything said on an item, engine notes included. */
function listCommentBodies(handle: DbHandle, itemId: Uuid): string[] {
  return listCommentsForItem(handle.db, itemId).map((comment) => comment.body);
}
