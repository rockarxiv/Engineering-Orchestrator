import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockedSectionsFor, type IpcChannel, type PipelineStep, type PipelineStepView, type StepRouteView, type Uuid } from "@eo/core";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client.js";
import { items } from "../db/schema.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import {
  createPipeline,
  createRun,
  createStep,
  currentVersion,
  getItem,
  listAgents,
  listCommentsForItem,
  listPipelineSteps,
  listPipelineVersions,
  listTransitionsForItem,
  setEntryStep,
  setItemArchived,
  stepForItem,
} from "../db/repos/index.js";
import { buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { routeResult } from "../supervisor/routeResult.js";
import { savePipeline } from "./configCommands.js";
import { listItemSummaries } from "./domainQueries.js";
import { moveItem, moveItemToVersion } from "./domainCommands.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { TOOLS, type Dispatch } from "../mcpHost/catalog.js";
import { toolsFor } from "../mcpHost/gate.js";

/**
 * Moving an item to another version of its own pipeline (EO-567,
 * ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The shape the story was written for: Delivery v2 sends Merge Request's
 * `opened` to Done, and the next version adds Watching pull request and
 * sends `opened` there. An item that entered on the older one finishes
 * on it — until somebody moves it.
 */
describe("moving an item to another version of its pipeline", () => {
  let handle: DbHandle;
  let pipelineId: Uuid;
  let intake: PipelineStep;
  let mergeRequest: PipelineStep;
  let done: PipelineStep;
  let older: number;
  let newer: number;

  const fakeEngine = () => ({ notifyStateChange: () => {} });

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

  const route = (target: string): StepRouteView => ({
    id: `route-opened-${target}`,
    pipelineId,
    fromStepId: mergeRequest.id,
    resultKey: "opened",
    label: "Opened",
    tone: "success",
    target,
    position: 0,
  });

  const save = (steps: PipelineStep[], routes: StepRouteView[]) => {
    const saved = savePipeline(handle.db, fakeEngine(), { pipelineId, steps: asView(steps), routes, entryStepId: intake.id });
    expect(saved).toMatchObject({ saved: true, problems: [] });
  };

  /** A step the save is about to publish, which is not a row until it does. */
  const watching = (): PipelineStep => ({
    ...done,
    id: "step-watching" as Uuid,
    name: "Watching pull request",
    isTerminal: false,
    position: 3,
    results: [{ key: "merged", label: "Merged", tone: "success", requiresComment: false }],
  });
  const merged = (): StepRouteView => ({
    id: "route-merged",
    pipelineId,
    fromStepId: "step-watching",
    resultKey: "merged",
    label: "Merged",
    tone: "success",
    target: done.id,
    position: 0,
  });

  const move = (itemId: string, version: number, comment = "") =>
    moveItemToVersion(handle.db, undefined, { itemId, version, comment });

  /** Where `opened` sends the item now, as the supervisor routes an agent's result. */
  const whereOpenedGoes = (itemId: string): string | null => {
    const item = getItem(handle.db, itemId as Uuid)!;
    const next = routeResult(handle.db, stepForItem(handle.db, item)!, listPipelineSteps(handle.db), "opened", item);
    return next !== null && "stepId" in next ? next.stepId : null;
  };

  const chipOf = (itemId: string) => listItemSummaries(handle.db, null).items.find((summary) => summary.id === itemId)?.pipelineVersion;

  beforeEach(() => {
    handle = openMigratedTestDb();
    pipelineId = createPipeline(handle.db, { projectId: null, name: "Delivery" }).id as Uuid;
    intake = createStep(handle.db, { pipelineId, position: 0, name: "Intake", type: "user" });
    mergeRequest = createStep(handle.db, {
      pipelineId,
      position: 1,
      name: "Merge Request",
      type: "user",
      results: [{ key: "opened", label: "Opened", tone: "success", requiresComment: false }],
    });
    done = createStep(handle.db, { pipelineId, position: 2, name: "Done", type: "user", isTerminal: true });
    setEntryStep(handle.db, pipelineId, intake.id);

    // The older version: `opened` goes to Done.
    save([intake, mergeRequest, done], [route(done.id)]);
    older = currentVersion(handle.db, pipelineId)!.number;
  });

  afterEach(() => {
    clearHandlerRegistry();
    handle.close();
  });

  /** An item on Merge Request that entered on the older version, with the newer one published after it. */
  function itemOnTheOlderVersion() {
    const item = createTestItem(handle.db, { type: "story", title: "EO-549", stepId: mergeRequest.id });
    save([intake, mergeRequest, done, watching()], [route("step-watching"), merged()]);
    newer = currentVersion(handle.db, pipelineId)!.number;
    expect(newer).toBeGreaterThan(older);
    return item;
  }

  it("binds an item to the newer version and back, and routes it by whichever it is on", () => {
    const item = itemOnTheOlderVersion();
    const before = getItem(handle.db, item.id)!;
    const transitions = listTransitionsForItem(handle.db, item.id);
    expect(whereOpenedGoes(item.id)).toBe(done.id);
    expect(chipOf(item.id)).toBe(older);

    const up = move(item.id, newer);

    expect(up).toMatchObject({ moved: true, queued: false, fromVersion: older, toVersion: newer, problem: null });
    const after = getItem(handle.db, item.id)!;
    // Only the binding changed: the step, pipeline and assignee are where they were.
    expect(after).toMatchObject({ stepId: before.stepId, pipelineId: before.pipelineId, assigneeId: before.assigneeId });
    expect(after.pipelineVersionId).toBe(currentVersion(handle.db, pipelineId)!.id);
    // On the current version, which is no chip at all.
    expect(chipOf(item.id)).toBeNull();
    // Routed by the newer version: `opened` lands on Watching pull request.
    expect(whereOpenedGoes(item.id)).toBe("step-watching");
    // …and dispatched by it: nothing older for the scheduler to read.
    expect(buildEligibilityInput(handle.db, false).stepsByItem?.has(item.id) ?? false).toBe(false);

    const down = move(item.id, older);

    expect(down).toMatchObject({ moved: true, fromVersion: newer, toVersion: older, problem: null });
    expect(chipOf(item.id)).toBe(older);
    expect(whereOpenedGoes(item.id)).toBe(done.id);
    expect(buildEligibilityInput(handle.db, false).stepsByItem?.get(item.id)).toMatchObject({ id: mergeRequest.id });

    // No transition is written, and none of the earlier ones is touched.
    expect(listTransitionsForItem(handle.db, item.id)).toEqual(transitions);
  });

  it("posts exactly one comment per move, naming both versions and who asked, with the words given", () => {
    const item = itemOnTheOlderVersion();
    const earlier = listCommentsForItem(handle.db, item.id);

    const moved = move(item.id, newer, "Putting the unstarted stories on the version that watches pull requests.");

    const now = listCommentsForItem(handle.db, item.id);
    // Every earlier comment is exactly as it was, and one is new.
    expect(now.slice(0, earlier.length)).toEqual(earlier);
    expect(now).toHaveLength(earlier.length + 1);
    const said = now[now.length - 1]!;
    expect(said.id).toBe(moved.commentId);
    expect(said.body).toContain(`Moved from version ${older} to version ${newer} of "Delivery" by you.`);
    expect(said.body).toContain("Putting the unstarted stories on the version that watches pull requests.");

    move(item.id, older);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(earlier.length + 2);
  });

  describe("refuses, changing nothing", () => {
    function unchanged(itemId: string, answer: ReturnType<typeof move>, before: { item: unknown; comments: number }) {
      expect(answer.moved).toBe(false);
      expect(answer.commentId).toBeNull();
      expect(getItem(handle.db, itemId as Uuid)).toEqual(before.item);
      expect(listCommentsForItem(handle.db, itemId as Uuid)).toHaveLength(before.comments);
    }
    const snapshot = (itemId: string) => ({ item: getItem(handle.db, itemId as Uuid), comments: listCommentsForItem(handle.db, itemId as Uuid).length });

    it("when the item's step is not in that version, naming the step and the version and pointing to item_move", () => {
      const item = itemOnTheOlderVersion();
      expect(move(item.id, newer).moved).toBe(true);
      expect(moveItem(handle.db, undefined, { itemId: item.id, toStepId: "step-watching", cancelActiveRun: false, comment: "" }).moved).toBe(true);
      const before = snapshot(item.id);

      const answer = move(item.id, older);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain(`Version ${older} of "Delivery" has no step "Watching pull request"`);
      expect(answer.problem).toContain("item_move");
    });

    it("when the pipeline does not keep that version, listing the ones it does", () => {
      const item = itemOnTheOlderVersion();
      const before = snapshot(item.id);
      const kept = listPipelineVersions(handle.db, pipelineId).map((version) => version.number);

      const answer = move(item.id, 99);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain("no version 99");
      for (const number of kept) expect(answer.problem).toContain(String(number));
    });

    it("when the item is already on that version", () => {
      const item = itemOnTheOlderVersion();
      const before = snapshot(item.id);

      const answer = move(item.id, older);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain(`already on version ${older}`);
    });

    it("while an agent is working on the item", () => {
      const item = itemOnTheOlderVersion();
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
      const before = snapshot(item.id);

      const answer = move(item.id, newer);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain("An agent is working on");
    });

    it("while a dispatch holds the item's lock, before its run exists", () => {
      const item = itemOnTheOlderVersion();
      const before = snapshot(item.id);
      const engine = { notifyStateChange: () => {}, itemLock: { isHeld: (id: string) => id === item.id } };

      const answer = moveItemToVersion(handle.db, engine as unknown as Parameters<typeof moveItemToVersion>[1], {
        itemId: item.id,
        version: newer,
        comment: "",
      });

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain("An agent is working on");
    });

    it("when the item is archived", () => {
      const item = itemOnTheOlderVersion();
      setItemArchived(handle.db, item.id, Date.now());
      const before = snapshot(item.id);

      const answer = move(item.id, newer);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain("archived");
    });

    it("when the item is on no pipeline", () => {
      const item = itemOnTheOlderVersion();
      handle.db.update(items).set({ pipelineId: null, stepId: null }).where(eq(items.id, item.id)).run();
      const before = snapshot(item.id);

      const answer = move(item.id, newer);

      unchanged(item.id, answer, before);
      expect(answer.problem).toContain("on no pipeline");
    });
  });

  describe("as an MCP tool", () => {
    const dispatch: Dispatch = (channel: IpcChannel, payload: unknown) => dispatchIpc(channel, payload);
    const tool = TOOLS.find((candidate) => candidate.name === "item_move_to_version")!;

    it("is a write tool listed on both servers with dangerous operations off, and in no published section", () => {
      expect(tool).toMatchObject({ kind: "write", channels: expect.arrayContaining(["items:moveToVersion"]) });
      expect(tool.adminOnly).toBeUndefined();
      expect(toolsFor(false, "admin").map((one) => one.name)).toContain("item_move_to_version");
      expect(toolsFor(false, "external").map((one) => one.name)).toContain("item_move_to_version");
      const advertised = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      expect(Object.keys(advertised.properties)).toEqual(expect.arrayContaining(["itemId", "version", "comment"]));
      expect(advertised.required ?? []).not.toContain("comment");
      // A locked pipelines section does not refuse it: it changes which
      // version one item finishes on, not the graph.
      expect(lockedSectionsFor("items:moveToVersion")).toEqual([]);
    });

    it("moves the item, and answers a refusal as a successful call carrying the sentence", async () => {
      const item = itemOnTheOlderVersion();
      registerHandler("items:moveToVersion", (payload) => moveItemToVersion(handle.db, undefined, payload), { exposeErrorDetails: true });

      const moved = await tool.run(dispatch, { itemId: item.id, version: newer });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.refused).toBe(false);
      expect(moved.text).toContain(`version ${newer}`);

      const again = await tool.run(dispatch, { itemId: item.id, version: newer });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.refused).toBe(true);
      expect(again.text).toContain("already on version");
      expect(again.text).toContain("Nothing has changed");
    });
  });
});
