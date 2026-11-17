import type { StepBrief, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRoute, createRun, createStep, postComment, transitionItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemBrief } from "./itemBrief.js";

/**
 * What a person's decision is about (EO-827): the brief `items:brief`
 * resolves for the decision bar's "Show details", read from the thread,
 * the runs and the moves of an in-memory database.
 *
 * A Draft step an implementer works on, a Review step a reviewer works on,
 * and an Approval step a person decides on. The item is drafted, reviewed
 * and sent on to the person, with comments around it that a brief must not
 * pick: an approval from the draft's time, and a note after the move.
 */
let handle: DbHandle;
let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = 1_000_000;
  vi.setSystemTime(clock);
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
  vi.useRealTimers();
});

/** Every write a moment after the one before, so the order of the thread is the order things happened. */
function later(): void {
  clock += 1_000;
  vi.setSystemTime(clock);
}

function pipeline(brief: StepBrief | null = null): void {
  const pipelineId = "default" as Uuid;
  createStep(handle.db, { id: "note_draft", pipelineId, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "implement" });
  createStep(handle.db, { id: "note_review", pipelineId, position: 21, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review" });
  createStep(handle.db, {
    id: "note_approval",
    pipelineId,
    position: 22,
    name: "Approval",
    type: "user",
    instructionsSummary: "Approve the release notes before they go out.",
    results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    brief,
  });
  createRoute(handle.db, { pipelineId, fromStepId: "note_draft", resultKey: "done", label: "Drafted", target: "note_review", position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: "note_review", resultKey: "approved", label: "Approved", target: "note_approval", position: 0 });
  createRoute(handle.db, { pipelineId, fromStepId: "note_approval", resultKey: "approved", label: "Approve", tone: "success", target: "terminal", position: 0 });
}

/** An item drafted, reviewed and handed to the person, and what was said along the way. */
function decidedUpTo() {
  const implementer = createAgent(handle.db, { name: "Ivy", role: "implementer", provider: "fake", instructions: "Implement." });
  const reviewer = createAgent(handle.db, { name: "Rex", role: "reviewer", provider: "fake", instructions: "Review." });
  const item = createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "note_draft", spec: { acceptance_criteria: ["Lists every change", "Names the release"] } });

  later();
  // Said while the item stood on Draft, by a person: an approval, but not the step before Approval's.
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "approval", body: "Go ahead and draft it." });
  later();
  const drafting = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", stepId: "note_draft" });
  postComment(handle.db, { itemId: item.id, runId: drafting.id, author: { type: "agent", agentId: implementer.id }, kind: "output", body: "The notes, drafted." });
  later();
  transitionItem(handle.db, { itemId: item.id, toStepId: "note_review", actor: implementer.id, runId: drafting.id });
  later();
  const reviewing = createRun(handle.db, { itemId: item.id, agentId: reviewer.id, action: "review", stepId: "note_review" });
  postComment(handle.db, { itemId: item.id, runId: reviewing.id, author: { type: "agent", agentId: reviewer.id }, kind: "approval", body: "Approved. Every change is listed." });
  later();
  postComment(handle.db, { itemId: item.id, runId: reviewing.id, author: { type: "agent", agentId: reviewer.id }, kind: "note", body: "A nit: the date format." });
  later();
  transitionItem(handle.db, { itemId: item.id, toStepId: "note_approval", actor: reviewer.id, runId: reviewing.id });
  later();
  // After the move, on Approval: neither the verdict before it nor the reviewer's.
  postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "note", body: "Looking now." });
  return item;
}

describe("items:brief (EO-827)", () => {
  it("with no brief declared, is the step's instructions summary, the current output and the previous step's newest verdict", () => {
    pipeline();
    const item = decidedUpTo();

    expect(getItemBrief(handle.db, { itemId: item.id })).toEqual({
      declared: false,
      parts: [
        { show: "summary", heading: "What this step asks", body: "Approve the release notes before they go out.", author: null, createdAt: null },
        { show: "output", heading: "Current output", body: "The notes, drafted.", author: "Ivy", createdAt: expect.any(Number) },
        { show: "comment", heading: "Verdict from Review", body: "Approved. Every change is listed.", author: "Rex", createdAt: expect.any(Number) },
      ],
    });
  });

  it("finds a person's verdict on the step before, posted with no run just before the move", () => {
    pipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "note_review", spec: { acceptance_criteria: ["Lists every change"] } });
    later();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "rejection", body: "Not yet: the date is wrong." });
    // The decision and the move it causes in the same millisecond, as `items:decide` writes them.
    transitionItem(handle.db, { itemId: item.id, toStepId: "note_approval", actor: "human" });

    expect(getItemBrief(handle.db, { itemId: item.id })?.parts[2]).toMatchObject({ heading: "Verdict from Review", body: "Not yet: the date is wrong.", author: "you" });
  });

  it("says there is no verdict yet where the step before said none, and no output where there is none", () => {
    pipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "note_review", spec: { acceptance_criteria: ["Lists every change"] } });
    later();
    transitionItem(handle.db, { itemId: item.id, toStepId: "note_approval", actor: "human" });

    expect(getItemBrief(handle.db, { itemId: item.id })?.parts.slice(1)).toEqual([
      { show: "output", heading: "Current output", body: null, author: null, createdAt: null },
      { show: "comment", heading: "Verdict from Review", body: null, author: null, createdAt: null },
    ]);
  });

  it("with a brief declared, is exactly its parts in the order declared", () => {
    pipeline([
      { show: "field", field: "acceptance_criteria" },
      { show: "comment", role: "reviewer" },
      { show: "output", step: "note_draft" },
      { show: "comment", kind: "approval", role: "human" },
      { show: "output", step: "note_review" },
    ]);
    const item = decidedUpTo();

    expect(getItemBrief(handle.db, { itemId: item.id })).toEqual({
      declared: true,
      parts: [
        { show: "field", heading: "Acceptance criteria", body: "- Lists every change\n- Names the release", author: null, createdAt: null },
        { show: "comment", heading: "Newest comment by reviewer", body: "A nit: the date format.", author: "Rex", createdAt: expect.any(Number) },
        { show: "output", heading: "Output of Draft", body: "The notes, drafted.", author: "Ivy", createdAt: expect.any(Number) },
        { show: "comment", heading: "Newest approval by human", body: "Go ahead and draft it.", author: "you", createdAt: expect.any(Number) },
        // Review produced no output: said, rather than left out.
        { show: "output", heading: "Output of Review", body: null, author: null, createdAt: null },
      ],
    });
  });

  it("is null for an item that no longer exists", () => {
    expect(getItemBrief(handle.db, { itemId: "nothing" })).toBeNull();
  });
});
