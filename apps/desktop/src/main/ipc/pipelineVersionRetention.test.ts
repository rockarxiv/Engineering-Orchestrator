import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stepHoldsItemsMessage, type PipelineStep, type PipelineStepView, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { pipelineVersions } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import {
  createPerson,
  createPipeline,
  createStep,
  currentVersion,
  deleteGroup,
  getItem,
  getStep,
  listPipelineVersions,
  listRetiredStepsForPipeline,
  listStepsForPipeline,
  prunePipelineVersions,
  saveGroup,
  setCurrentVersion,
  setEntryStep,
  setItemArchived,
  setPipelineVersionsToKeep,
  setStepOwner,
  versionSnapshot,
} from "../db/repos/index.js";
import { savePipeline } from "./configCommands.js";
import { pipelineVersionsCommand } from "./pipelineCommands.js";

/**
 * Keeping a pipeline's history to a size, and going back to a version
 * in it (EO-359).
 *
 * The fixture is three `user` steps, for `pipelineVersions.test.ts`'s
 * reason: nothing here is about dispatch, and a human step is the one
 * kind that needs no agent to exist.
 */
describe("pipeline version history", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  let intake: PipelineStep;
  let decide: PipelineStep;
  let done: PipelineStep;

  const engine = { notifyStateChange: () => {} };

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

  const save = (steps: PipelineStep[] = [intake, decide, done]) =>
    savePipeline(handle.db, engine, { pipelineId, steps: asView(steps), routes: [], entryStepId: intake.id });

  const numbers = () => listPipelineVersions(handle.db, pipelineId).map((version) => version.number);
  const versionNumbered = (number: number) => listPipelineVersions(handle.db, pipelineId).find((version) => version.number === number)!;

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

  describe("retention", () => {
    it("keeps the three newest after five saves at a limit of three", () => {
      setPipelineVersionsToKeep(handle.db, 3);
      for (let save_ = 0; save_ < 5; save_ += 1) expect(save().saved).toBe(true);

      // The first save files v1 of the graph it replaces, then v2; five
      // saves therefore reach v6.
      expect(numbers()).toEqual([4, 5, 6]);
      expect(currentVersion(handle.db, pipelineId)?.number).toBe(6);
    });

    it("never deletes a version an item is bound to, archived or not", () => {
      // Bound to v1 the moment it lands on the pipeline, then put away.
      const archived = createTestItem(handle.db, { type: "story", title: "Put away", stepId: decide.id });
      setItemArchived(handle.db, archived.id, Date.now());
      const bound = getItem(handle.db, archived.id)!.pipelineVersionId;
      expect(bound).toBe(versionNumbered(1).id);

      save();
      // And a live one standing on v2.
      const live = createTestItem(handle.db, { type: "story", title: "Still here", stepId: intake.id });
      expect(getItem(handle.db, live.id)!.pipelineVersionId).toBe(versionNumbered(2).id);

      setPipelineVersionsToKeep(handle.db, 2);
      for (let save_ = 0; save_ < 4; save_ += 1) save();

      expect(numbers()).toEqual([1, 2, 5, 6]);
    });

    it("never deletes the current version, even when it is not among the newest", () => {
      for (let save_ = 0; save_ < 4; save_ += 1) save();
      expect(numbers()).toEqual([1, 2, 3, 4, 5]);

      // What the organisation's rollback does to the pointer (EO-329).
      setCurrentVersion(handle.db, pipelineId, versionNumbered(2).id);
      expect(prunePipelineVersions(handle.db, pipelineId, 2)).toEqual([1, 3]);

      expect(numbers()).toEqual([2, 4, 5]);
    });

    it("never hands a number out twice, however much has been deleted", () => {
      for (let save_ = 0; save_ < 4; save_ += 1) save();
      const highestEver = Math.max(...numbers());

      // The pointer moved back to v2, so the newest row is not the
      // current one — and is exactly the row whose loss would let `v5`
      // be issued again.
      setCurrentVersion(handle.db, pipelineId, versionNumbered(2).id);
      prunePipelineVersions(handle.db, pipelineId, 0);
      expect(numbers()).toEqual([2, 5]);

      setPipelineVersionsToKeep(handle.db, 1);
      const next = save();
      expect(next.version).toBe(highestEver + 1);
      // And again, now that the limit has let everything else go.
      expect(save().version).toBe(highestEver + 2);
      expect(numbers()).toEqual([highestEver + 2]);
    });

    it("applies a lowered limit at the pipeline's next save, not when it is set", () => {
      for (let save_ = 0; save_ < 5; save_ += 1) save();
      expect(numbers()).toHaveLength(6);

      setPipelineVersionsToKeep(handle.db, 2);
      expect(numbers()).toHaveLength(6);

      save();
      expect(numbers()).toEqual([6, 7]);
    });

    it("prunes nothing on a save that is refused", () => {
      setPipelineVersionsToKeep(handle.db, 20);
      for (let save_ = 0; save_ < 3; save_ += 1) save();
      createTestItem(handle.db, { type: "story", title: "Holding", stepId: decide.id });
      setPipelineVersionsToKeep(handle.db, 1);

      expect(save([intake, done]).saved).toBe(false);
      expect(numbers()).toEqual([1, 2, 3, 4]);
    });
  });

  describe("restoring a version", () => {
    it("sends an older version's graph back as a draft and writes nothing", () => {
      save([intake, done]);
      const before = listPipelineVersions(handle.db, pipelineId);

      const answer = pipelineVersionsCommand(handle.db, { pipelineId, graph: 1 });

      expect(answer.current).toBe(2);
      expect(answer.graph?.number).toBe(1);
      expect(answer.graph?.steps.map((step) => step.id)).toEqual([intake.id, decide.id, done.id]);
      expect(answer.graph?.entryStepId).toBe(intake.id);
      // Asking is not publishing.
      expect(listPipelineVersions(handle.db, pipelineId)).toEqual(before);
      expect(currentVersion(handle.db, pipelineId)?.number).toBe(2);
      expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).not.toContain(decide.id);
    });

    it("answers null for a version the pipeline does not have", () => {
      save();
      expect(pipelineVersionsCommand(handle.db, { pipelineId, graph: 99 }).graph).toBeNull();
      expect(pipelineVersionsCommand(handle.db, { pipelineId }).graph).toBeNull();
    });

    it("publishes a restored version as a new current one, reviving a retired step under its own id", () => {
      // v1 has Review; v2 removed it, which retired the row.
      save([intake, done]);
      expect(listRetiredStepsForPipeline(handle.db, pipelineId).map((entry) => entry.step.id)).toEqual([decide.id]);
      const restoredRow = handle.db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionNumbered(1).id)).get();

      const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: 1 }).graph!;
      const published = savePipeline(handle.db, engine, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId });

      expect(published.saved).toBe(true);
      expect(published.version).toBe(3);
      expect(currentVersion(handle.db, pipelineId)?.number).toBe(3);
      expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).toEqual([intake.id, decide.id, done.id]);
      expect(listRetiredStepsForPipeline(handle.db, pipelineId)).toEqual([]);
      // The version restored from is exactly as it was.
      expect(handle.db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionNumbered(1).id)).get()).toEqual(restoredRow);
    });

    it("numbers a restored publish above every version the pipeline has had, deleted ones included", () => {
      setPipelineVersionsToKeep(handle.db, 2);
      save([intake, done]);
      for (let save_ = 0; save_ < 3; save_ += 1) save([intake, done]);
      expect(numbers()).toEqual([4, 5]);

      const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: 4 }).graph!;
      expect(savePipeline(handle.db, engine, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId }).version).toBe(6);
    });

    it("refuses a restored draft that drops a step holding tickets, with the ordinary message", () => {
      // v2 adds a step, and work arrives on it.
      const extra: PipelineStep = { ...decide, id: "019fb8c6-0000-7000-8000-00000000e0a1", name: "Extra", position: 3 };
      expect(save([intake, decide, done, extra]).saved).toBe(true);
      createTestItem(handle.db, { type: "story", title: "On the new step", stepId: extra.id });

      const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: 1 }).graph!;
      const refused = savePipeline(handle.db, engine, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId });

      expect(refused.saved).toBe(false);
      const holding = { stepId: extra.id, stepName: "Extra", count: 1, archived: 0 };
      expect(refused.problems.find((problem) => problem.holdsItems !== undefined)?.message).toBe(stepHoldsItemsMessage(holding));
      expect(numbers()).toEqual([1, 2]);
    });
  });

  /**
   * Who a human step waits on is not on `pipeline:save`'s wire, and an
   * ordinary publish leaves it alone. A restored version is the one
   * publish with an opinion about it, and the opinion is the version's
   * own (review of EO-359).
   */
  describe("restoring who a human step waited on", () => {
    /** Publishes version `number`'s graph; `restoredFrom: null` publishes it without saying where it came from. */
    const publish = (number: number, restoredFrom: number | null = number) => {
      const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: number }).graph!;
      return savePipeline(handle.db, engine, {
        pipelineId,
        steps: draft.steps,
        routes: draft.routes,
        entryStepId: draft.entryStepId,
        ...(restoredFrom === null ? {} : { restoredFrom }),
      });
    };
    const ownerOf = (stepId: string) => {
      const step = getStep(handle.db, stepId)!;
      return { personId: step.ownerPersonId, groupId: step.ownerGroupId };
    };

    it("publishes the version's owner, and files it in the new version", () => {
      const dana = createPerson(handle.db, { name: "Dana" });
      const pat = createPerson(handle.db, { name: "Pat" });
      setStepOwner(handle.db, decide.id, { personId: dana.id, groupId: null });
      save(); // v1 and v2, both waiting on Dana.
      setStepOwner(handle.db, decide.id, { personId: pat.id, groupId: null });
      save(); // v3, waiting on Pat.

      const published = publish(1);

      expect(published.saved).toBe(true);
      expect(ownerOf(decide.id)).toEqual({ personId: dana.id, groupId: null });
      const filed = versionSnapshot(handle.db, versionNumbered(published.version!).id)!;
      expect(filed.steps.find((step) => step.id === decide.id)?.ownerPersonId).toBe(dana.id);
    });

    it("puts a group back in place of a person, clearing the person", () => {
      const team = saveGroup(handle.db, { name: "Reviewers", memberIds: [] });
      const pat = createPerson(handle.db, { name: "Pat" });
      setStepOwner(handle.db, decide.id, { personId: null, groupId: team.id });
      save();
      setStepOwner(handle.db, decide.id, { personId: pat.id, groupId: null });
      save();

      expect(publish(1).saved).toBe(true);
      expect(ownerOf(decide.id)).toEqual({ personId: null, groupId: team.id });
    });

    it("leaves today's owner alone on a publish that is not a restore", () => {
      const dana = createPerson(handle.db, { name: "Dana" });
      const pat = createPerson(handle.db, { name: "Pat" });
      setStepOwner(handle.db, decide.id, { personId: dana.id, groupId: null });
      save();
      setStepOwner(handle.db, decide.id, { personId: pat.id, groupId: null });

      // The same graph, published without naming the version it came from.
      expect(publish(1, null).saved).toBe(true);
      expect(ownerOf(decide.id)).toEqual({ personId: pat.id, groupId: null });
    });

    it("brings back nobody in particular for a group that no longer exists", () => {
      const team = saveGroup(handle.db, { name: "Reviewers", memberIds: [] });
      setStepOwner(handle.db, decide.id, { personId: null, groupId: team.id });
      save();
      const pat = createPerson(handle.db, { name: "Pat" });
      setStepOwner(handle.db, decide.id, { personId: pat.id, groupId: null });
      save();
      deleteGroup(handle.db, team.id);

      expect(publish(1).saved).toBe(true);
      expect(ownerOf(decide.id)).toEqual({ personId: null, groupId: null });
    });

    it("refuses, writing nothing, when the version restored from is no longer kept", () => {
      save();
      save();
      const draft = pipelineVersionsCommand(handle.db, { pipelineId, graph: 1 }).graph!;
      setPipelineVersionsToKeep(handle.db, 1);
      save(); // v4, and v1 to v3 go.
      expect(numbers()).toEqual([4]);

      const refused = savePipeline(handle.db, engine, { pipelineId, steps: draft.steps, routes: draft.routes, entryStepId: draft.entryStepId, restoredFrom: 1 });

      expect(refused.saved).toBe(false);
      expect(refused.problems.map((problem) => problem.message).join(" ")).toContain("v1 is no longer kept");
      expect(numbers()).toEqual([4]);
    });
  });
});
