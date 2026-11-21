import type { ItemBriefPart, StepBrief, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRoute, createRun, createStep, postComment, transitionItem } from "../db/repos/index.js";
import { agentOfKind, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { foldPacks } from "../packs/pack.js";
import { getItemBrief } from "./itemBrief.js";
import { packBriefs, usePackBriefs, type DecisionBriefContext, type DecisionBriefRenderer } from "./packBriefs.js";

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
  createStep(handle.db, { id: "note_draft", pipelineId, position: 20, name: "Draft", type: "agent", agentId: agentOfKind(handle.db, "implementer"), entryAction: "implement" });
  createStep(handle.db, { id: "note_review", pipelineId, position: 21, name: "Review", type: "agent", agentId: agentOfKind(handle.db, "reviewer"), entryAction: "review" });
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
  it("with no brief declared, is the step's instructions summary, the current output and the previous step's newest verdict", async () => {
    pipeline();
    const item = decidedUpTo();

    expect(await getItemBrief(handle.db, { itemId: item.id })).toEqual({
      declared: false,
      parts: [
        { show: "summary", heading: "What this step asks", body: "Approve the release notes before they go out.", author: null, createdAt: null },
        { show: "output", heading: "Current output", body: "The notes, drafted.", author: "Ivy", createdAt: expect.any(Number) },
        { show: "comment", heading: "Verdict from Review", body: "Approved. Every change is listed.", author: "Rex", createdAt: expect.any(Number) },
      ],
    });
  });

  it("finds a person's verdict on the step before, posted with no run just before the move", async () => {
    pipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "note_review", spec: { acceptance_criteria: ["Lists every change"] } });
    later();
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, kind: "rejection", body: "Not yet: the date is wrong." });
    // The decision and the move it causes in the same millisecond, as `items:decide` writes them.
    transitionItem(handle.db, { itemId: item.id, toStepId: "note_approval", actor: "human" });

    expect((await getItemBrief(handle.db, { itemId: item.id }))?.parts[2]).toMatchObject({ heading: "Verdict from Review", body: "Not yet: the date is wrong.", author: "you" });
  });

  it("says there is no verdict yet where the step before said none, and no output where there is none", async () => {
    pipeline();
    const item = createTestItem(handle.db, { type: "story", title: "Release notes", stepId: "note_review", spec: { acceptance_criteria: ["Lists every change"] } });
    later();
    transitionItem(handle.db, { itemId: item.id, toStepId: "note_approval", actor: "human" });

    expect((await getItemBrief(handle.db, { itemId: item.id }))?.parts.slice(1)).toEqual([
      { show: "output", heading: "Current output", body: null, author: null, createdAt: null },
      { show: "comment", heading: "Verdict from Review", body: null, author: null, createdAt: null },
    ]);
  });

  it("with a brief declared, is exactly its parts in the order declared", async () => {
    pipeline([
      { show: "field", field: "acceptance_criteria" },
      { show: "comment", role: "reviewer" },
      { show: "output", step: "note_draft" },
      { show: "comment", kind: "approval", role: "human" },
      { show: "output", step: "note_review" },
    ]);
    const item = decidedUpTo();

    expect(await getItemBrief(handle.db, { itemId: item.id })).toEqual({
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

  it("is null for an item that no longer exists", async () => {
    expect(await getItemBrief(handle.db, { itemId: "nothing" })).toBeNull();
  });
});

/**
 * The third layer (EO-828): a brief a pack computes for a step it
 * recognises, shown in place of the default and never in place of one the
 * step declares — and with no pack installed, nothing computed at all.
 */
describe("items:brief with pack briefs (EO-828)", () => {
  const computed: ItemBriefPart = { show: "computed", heading: "What the pack worked out", body: "Two comments, two replies.", author: null, createdAt: null };
  /** A renderer recognising the Approval step by the action of the step that put the item there. */
  const approvals = (seen: DecisionBriefContext[] = []): DecisionBriefRenderer => ({
    id: "test:approval",
    render: (context) => {
      seen.push(context);
      return context.cameFrom?.action === "review" ? [computed] : null;
    },
  });

  afterEach(() => usePackBriefs([]));

  it("with no pack installed, nothing computes a brief, and a step that declares none gets the default", async () => {
    // What the composition root installs from a fold over no pack at all.
    usePackBriefs(foldPacks([]).briefRenderers);
    expect(packBriefs()).toEqual([]);
    pipeline();
    const item = decidedUpTo();

    const brief = await getItemBrief(handle.db, { itemId: item.id });
    expect(brief?.declared).toBe(false);
    expect(brief?.parts.map((each) => each.show)).toEqual(["summary", "output", "comment"]);
  });

  it("shows what a pack computes in place of the default, told the step and the step the item came from", async () => {
    pipeline();
    const item = decidedUpTo();
    const seen: DecisionBriefContext[] = [];
    usePackBriefs([approvals(seen)]);

    expect(await getItemBrief(handle.db, { itemId: item.id })).toEqual({ declared: false, parts: [computed] });
    expect(seen[0]).toMatchObject({ step: { id: "note_approval" }, templateStepId: null, cameFrom: { stepId: "note_review", type: "agent", action: "review", templateStepId: null } });
  });

  it("asks each renderer in turn, and falls back to the default when none answers for the step", async () => {
    pipeline();
    const item = decidedUpTo();
    const asked: string[] = [];
    const other: DecisionBriefRenderer = { id: "test:other", render: () => (asked.push("other"), null) };
    usePackBriefs([other, { id: "test:empty", render: async () => (asked.push("empty"), []) }]);

    const brief = await getItemBrief(handle.db, { itemId: item.id });
    expect(asked).toEqual(["other", "empty"]);
    expect(brief?.parts.map((each) => each.show)).toEqual(["summary", "output", "comment"]);
  });

  it("shows the step's declared brief, not the pack's, and never asks the pack", async () => {
    pipeline([{ show: "output", step: "note_draft" }]);
    const item = decidedUpTo();
    const seen: DecisionBriefContext[] = [];
    usePackBriefs([approvals(seen)]);

    expect(await getItemBrief(handle.db, { itemId: item.id })).toEqual({
      declared: true,
      parts: [{ show: "output", heading: "Output of Draft", body: "The notes, drafted.", author: "Ivy", createdAt: expect.any(Number) }],
    });
    expect(seen).toEqual([]);
  });

  it("says so above the default when a pack's brief fails, rather than dropping it", async () => {
    pipeline();
    const item = decidedUpTo();
    usePackBriefs([{ id: "test:broken", render: () => { throw new Error("the forge is down"); } }]);

    const brief = await getItemBrief(handle.db, { itemId: item.id });
    expect(brief?.parts[0]).toEqual({ show: "computed", heading: "This step's own brief could not be worked out", body: "test:broken: the forge is down", author: null, createdAt: null });
    expect(brief?.parts.slice(1).map((each) => each.show)).toEqual(["summary", "output", "comment"]);
  });
});
