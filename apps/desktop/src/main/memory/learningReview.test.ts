import { LEARNING_REVIEW_EVENT, LearningReviewEventSchema, MEMORY_NOTE_DEFINITION, type Run } from "@eo/core";
import { describe, expect, it } from "vitest";
import { learningReviewEvent, learningReviewPrompt, learningReviewSkip } from "./learningReview.js";
import type { RunProduce } from "./extraction.js";
import type { MemoryScopeInfo } from "./selection.js";

const SCOPES: MemoryScopeInfo[] = [
  { scope: { kind: "project", id: "p-1" }, name: "Payments" },
  { scope: { kind: "workspace", id: "w-1" }, name: "payments-api" },
] as MemoryScopeInfo[];

const RUN = { status: "succeeded", interruption: null, result: null } as unknown as Run;
const PRODUCE: RunProduce = { finalAnswer: "Done.", comments: [], toolNames: ["Bash"], calledMemoryNote: false };
const ITEM = { previewAt: null };

describe("the learning review's prompt (EO-717)", () => {
  const prompt = learningReviewPrompt(SCOPES);

  it("carries what a note is word for word, and the tools it is served", () => {
    expect(prompt).toContain(MEMORY_NOTE_DEFINITION);
    expect(prompt).toContain("mcp__eo__memory_note");
    expect(prompt).toContain("mcp__eo__memory_read");
  });

  it("says to save only what the run can point to, and never what a person is like", () => {
    expect(prompt).toContain("Save only what this run can point to");
    expect(prompt).toContain("Never infer a person's traits, habits or preferences");
  });

  it("says never to save environment failures, negative tool claims, errors that resolved themselves, or approaches that did not work", () => {
    expect(prompt).toContain("An environment failure");
    expect(prompt).toContain("A claim that a tool, command or service does not work");
    expect(prompt).toContain("An error that went away on its own or on a retry");
    expect(prompt).toContain("An approach that did not work");
  });

  it("names the scopes a note may go to", () => {
    expect(prompt).toContain("`project` — what is true across the whole project, Payments.");
    expect(prompt).toContain("`w-1` — what is true only of the workspace payments-api.");
  });
});

describe("which runs are reviewed (EO-717)", () => {
  it("skips the runs extraction skips", () => {
    expect(learningReviewSkip({ ...RUN, status: "cancelled" } as Run, ITEM, PRODUCE, SCOPES)).toBe("not_ended");
    expect(learningReviewSkip({ ...RUN, interruption: "quit" } as unknown as Run, ITEM, PRODUCE, SCOPES)).toBe("interrupted");
    expect(learningReviewSkip(RUN, { previewAt: 1 }, PRODUCE, SCOPES)).toBe("preview");
    expect(learningReviewSkip(RUN, ITEM, { ...PRODUCE, calledMemoryNote: true }, SCOPES)).toBe("noted_itself");
    expect(learningReviewSkip(RUN, ITEM, PRODUCE, [])).toBe("no_scopes");
  });

  it("reviews a run with a short answer, which extraction would have skipped: the fork sees what the run did, not only what it said", () => {
    expect(learningReviewSkip(RUN, ITEM, PRODUCE, SCOPES)).toBeNull();
    expect(learningReviewSkip({ ...RUN, status: "failed" } as Run, ITEM, PRODUCE, SCOPES)).toBeNull();
    expect(learningReviewSkip({ ...RUN, status: "awaiting_input" } as Run, ITEM, PRODUCE, SCOPES)).toBeNull();
  });
});

describe("the learning_review event (EO-717)", () => {
  it("records each outcome in the shape core parses", () => {
    const events = [
      learningReviewEvent({ kind: "written", entryIds: ["m-1"], forkThreadId: "f-1" }),
      learningReviewEvent({ kind: "nothing_to_save", forkThreadId: "f-1" }),
      learningReviewEvent({ kind: "failed", entryIds: ["m-2"], reason: "It ran past its limit.", forkThreadId: "f-1" }),
      learningReviewEvent({ kind: "fell_back", reason: "thread_not_found: gone." }),
    ];
    expect(events.map((event) => [event.type, event.outcome, event.entryIds, event.reason])).toEqual([
      [LEARNING_REVIEW_EVENT, "written", ["m-1"], null],
      [LEARNING_REVIEW_EVENT, "nothing_to_save", [], null],
      [LEARNING_REVIEW_EVENT, "failed", ["m-2"], "It ran past its limit."],
      [LEARNING_REVIEW_EVENT, "fell_back", [], "thread_not_found: gone."],
    ]);
    for (const event of events) expect(LearningReviewEventSchema.parse(event)).toEqual(event);
  });
});
