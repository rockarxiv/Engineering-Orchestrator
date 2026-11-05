import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraStateOf } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { pendingPushesForItem } from "./outboxRepo.js";
import { createPipeline, createStep } from "./pipelineStepsRepo.js";
import { getItem, setJiraSync } from "./itemsRepo.js";
import { listTransitionsForItem, transitionItem } from "./transitionsRepo.js";

describe("transitionItem", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("writes the item row and the transition row together", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    const updated = transitionItem(handle.db, {
      itemId: item.id,
      toStepId: "review",
      actor: "human",
      reason: "ready to review",
    });

    expect(updated.stepId).toBe("review");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");

    const transitions = listTransitionsForItem(handle.db, item.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      itemId: item.id,
      fromStepId: "todo",
      toStepId: "review",
      actor: "human",
      reason: "ready to review",
    });
  });

  it("rolls back both the item update and the transition insert together on failure", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    // "not_a_real_state" violates items.stepId's FK to workflow_states —
    // the update and the transition insert must both fail atomically.
    expect(() =>
      transitionItem(handle.db, { itemId: item.id, toStepId: "not_a_real_state", actor: "human" }),
    ).toThrow();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(0);
  });

  it("throws for an unknown item rather than silently no-op-ing", () => {
    expect(() =>
      transitionItem(handle.db, {
        itemId: "018f8f5e-0000-7000-8000-000000000000" as never,
        toStepId: "review",
        actor: "human",
      }),
    ).toThrow(/not found/);
  });

  it("leaves pipelineId alone when the caller names no pipeline", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const before = getItem(handle.db, item.id)?.pipelineId;

    const updated = transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    expect(updated.pipelineId).toBe(before);
    expect(getItem(handle.db, item.id)?.pipelineId).toBe(before);
  });

});

/**
 * Work handed from one pipeline to another (EO-57).
 *
 * A second pipeline with its own steps, so "the destination step" and
 * "the pipeline named" can be made to disagree — which is the case that
 * matters, since the symptom of getting it wrong is an item the
 * scheduler resolves to no step at all and therefore never ticks again.
 */
/**
 * The status push, and the switch that stops it (EO-122).
 *
 * Enqueued here rather than at the callers because invariant 1 makes
 * this the one place a step change can happen — which also makes it the
 * one place the switch has to be honoured for status.
 */
describe("transitionItem and the Jira sync switch", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function mirroredStory() {
    const workspace = attachWorkspace(handle.db, { name: "svc", keyPrefix: "SVC", repoPath: "/tmp/svc" });
    return createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: workspace.id, jiraKey: "ACME-11" });
  }

  it("queues a status push for a mirrored item that syncs", () => {
    const item = mirroredStory();

    transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    expect(pendingPushesForItem(handle.db, item.id, "jira").map((entry) => entry.kind)).toEqual(["status"]);
  });

  it("queues nothing once sync is switched off, key and all", () => {
    // The item still knows which issue it is: the switch governs what
    // EO says to Jira, not what it remembers.
    const item = mirroredStory();
    setJiraSync(handle.db, item.id, false);

    const moved = transitionItem(handle.db, { itemId: item.id, toStepId: "review", actor: "human" });

    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    // The EO side is untouched — the move itself is not what was gated.
    expect(moved.stepId).toBe("review");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(1);
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBe("ACME-11");
  });
});

describe("transitionItem across pipelines", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function buildMergePipeline() {
    const pipeline = createPipeline(handle.db, { name: "Merge", position: 9 });
    const merging = createStep(handle.db, {
      id: "mg_merging",
      pipelineId: pipeline.id,
      position: 0,
      name: "Merging",
      ownerRole: "implementer",
      entryAction: "merge",
    });
    return { pipeline, merging };
  }

  it("moves pipelineId and stepId together, and records the move", () => {
    const { pipeline, merging } = buildMergePipeline();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "ready_to_merge" });
    expect(item.pipelineId).not.toBe(pipeline.id);

    const updated = transitionItem(handle.db, {
      itemId: item.id,
      toStepId: merging.id,
      toPipelineId: pipeline.id,
      actor: "engine",
      reason: "handed to the merge pipeline",
    });

    expect(updated.pipelineId).toBe(pipeline.id);
    expect(updated.stepId).toBe(merging.id);

    const reread = getItem(handle.db, item.id);
    expect(reread?.pipelineId).toBe(pipeline.id);
    expect(reread?.stepId).toBe(merging.id);

    const transitions = listTransitionsForItem(handle.db, item.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      itemId: item.id,
      fromStepId: "ready_to_merge",
      toStepId: merging.id,
      actor: "engine",
      reason: "handed to the merge pipeline",
    });
  });

  it("refuses a step that does not belong to the pipeline named, leaving both columns alone", () => {
    const { pipeline } = buildMergePipeline();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const before = getItem(handle.db, item.id);

    expect(() =>
      transitionItem(handle.db, {
        itemId: item.id,
        // A real step, but one of the *default* pipeline's.
        toStepId: "review",
        toPipelineId: pipeline.id,
        actor: "engine",
      }),
    ).toThrow(/does not belong to pipeline/);

    const after = getItem(handle.db, item.id);
    expect(after?.pipelineId).toBe(before?.pipelineId);
    expect(after?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(0);
  });

  it("refuses a pipeline named alongside a step that does not exist", () => {
    const { pipeline } = buildMergePipeline();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    expect(() =>
      transitionItem(handle.db, {
        itemId: item.id,
        toStepId: "no_such_step",
        toPipelineId: pipeline.id,
        actor: "engine",
      }),
    ).toThrow(/does not belong to pipeline/);

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(0);
  });

  it("writes neither column when the transition insert fails part-way", () => {
    const { pipeline, merging } = buildMergePipeline();
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "ready_to_merge" });
    const before = getItem(handle.db, item.id);

    // A runId with no `runs` row violates transitions.run_id's FK, so the
    // insert fails *after* the item update in the same transaction.
    expect(() =>
      transitionItem(handle.db, {
        itemId: item.id,
        toStepId: merging.id,
        toPipelineId: pipeline.id,
        actor: "engine",
        runId: "019fb8c6-0000-7000-8000-00000000dead" as never,
      }),
    ).toThrow(/FOREIGN KEY/i);

    const after = getItem(handle.db, item.id);
    expect(after?.pipelineId).toBe(before?.pipelineId);
    expect(after?.stepId).toBe("ready_to_merge");
    expect(listTransitionsForItem(handle.db, item.id)).toHaveLength(0);
  });

  it("still moves an item within its own pipeline when that pipeline is named explicitly", () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    const updated = transitionItem(handle.db, {
      itemId: item.id,
      toStepId: "review",
      toPipelineId: item.pipelineId,
      actor: "human",
    });

    expect(updated.pipelineId).toBe(item.pipelineId);
    expect(updated.stepId).toBe("review");
  });
});
