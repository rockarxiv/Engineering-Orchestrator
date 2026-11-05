import type { ItemSummary } from "@eo/core";
import { NO_GIT_STATE } from "@eo/core";
import { describe, expect, it } from "vitest";
import { resolveDropTarget } from "./dashboard";

function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "t1",
    key: "EO-1",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: "p1",
    repositoryName: null,
    projectId: null,
    title: "Rate limit the API",
    pipelineId: "default",
    stepId: "todo",
    pipelineVersion: null,
    stepName: "todo",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1,
    stepEnteredAt: 1,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

const STATES = [
  { id: "todo", pipelineId: "default", position: 0, name: "To Do", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false },
  { id: "pending_approval", pipelineId: "default", position: 1, name: "Pending Approval", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: false },
  { id: "review", pipelineId: "default", position: 2, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false },
];

describe("resolveDropTarget", () => {
  const columns = STATES;
  const items = [item(), item({ id: "t2", key: "EO-2", stepId: "review" })];

  it("moves to the column that was dropped on", () => {
    expect(resolveDropTarget(columns, items, "t1", "review")).toEqual({ item: items[0], toStepId: "review" });
  });

  it("dropping on a card means that card's column", () => {
    expect(resolveDropTarget(columns, items, "t1", "t2")).toEqual({ item: items[0], toStepId: "review" });
  });

  it("is a no-op within the same column — order is derived, so there is nothing to persist", () => {
    expect(resolveDropTarget(columns, items, "t1", "todo")).toBeNull();
    expect(resolveDropTarget(columns, items, "t2", "t2")).toBeNull();
  });

  it("is a no-op when dropped outside any column", () => {
    expect(resolveDropTarget(columns, items, "t1", undefined)).toBeNull();
    expect(resolveDropTarget(columns, items, "unknown", "review")).toBeNull();
  });
});
