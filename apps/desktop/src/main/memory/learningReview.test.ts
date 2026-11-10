import { LEARNING_REVIEW_EVENT, LearningReviewEventSchema, MEMORY_NOTE_DEFINITION, type Run } from "@eo/core";
import { describe, expect, it } from "vitest";
import { learningReviewEvent, learningReviewFor, learningReviewPrompt, learningReviewSkillsPrompt } from "./learningReview.js";
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
  const NOTED = { ...PRODUCE, calledMemoryNote: true };

  it("skips the runs extraction skips, but for the one that wrote its own notes", () => {
    expect(learningReviewFor({ ...RUN, status: "cancelled" } as Run, ITEM, PRODUCE, SCOPES)).toEqual({ skip: "not_ended" });
    expect(learningReviewFor({ ...RUN, interruption: "quit" } as unknown as Run, ITEM, PRODUCE, SCOPES)).toEqual({ skip: "interrupted" });
    expect(learningReviewFor(RUN, { previewAt: 1 }, PRODUCE, SCOPES)).toEqual({ skip: "preview" });
    expect(learningReviewFor(RUN, ITEM, PRODUCE, [])).toEqual({ skip: "no_scopes" });
  });

  it("reviews a run with a short answer, which extraction would have skipped: the fork sees what the run did, not only what it said", () => {
    expect(learningReviewFor(RUN, ITEM, PRODUCE, SCOPES)).toEqual({ review: "full" });
    expect(learningReviewFor({ ...RUN, status: "failed" } as Run, ITEM, PRODUCE, SCOPES)).toEqual({ review: "full" });
    expect(learningReviewFor({ ...RUN, status: "awaiting_input" } as Run, ITEM, PRODUCE, SCOPES)).toEqual({ review: "full" });
  });

  it("gives a run that called memory_note the skill half alone (EO-731)", () => {
    expect(learningReviewFor(RUN, ITEM, NOTED, SCOPES)).toEqual({ review: "skills_only" });
  });

  it("still skips the whole review of a run that called memory_note for every other reason (EO-731)", () => {
    expect(learningReviewFor({ ...RUN, status: "cancelled" } as Run, ITEM, NOTED, SCOPES)).toEqual({ skip: "not_ended" });
    expect(learningReviewFor({ ...RUN, interruption: "quit" } as unknown as Run, ITEM, NOTED, SCOPES)).toEqual({ skip: "interrupted" });
    expect(learningReviewFor(RUN, { previewAt: 1 }, NOTED, SCOPES)).toEqual({ skip: "preview" });
    expect(learningReviewFor(RUN, ITEM, NOTED, [])).toEqual({ skip: "no_scopes" });
  });
});

describe("the skill-only review's prompt (EO-731)", () => {
  const skills = [{ slug: "csv-exports", description: "Use when adding a CSV export.", loaded: true, locked: false }];
  const prompt = learningReviewSkillsPrompt({ skills, canCreate: true });

  it("carries the skill part of the full review word for word", () => {
    const full = learningReviewPrompt(SCOPES, { skills, canCreate: true });
    const part = full.slice(full.indexOf("## Skills"), full.indexOf("Many runs teach nothing"));
    expect(part.length).toBeGreaterThan(0);
    expect(prompt).toContain(part);
    for (const tool of ["skill_view", "skill_create", "skill_patch", "skill_file_write", "skill_file_remove"]) expect(prompt, tool).toContain(`mcp__eo__${tool}`);
  });

  it("says the run already wrote its own notes, and that memory may be read", () => {
    expect(prompt).toContain("This run already wrote its own notes to memory");
    expect(prompt).toContain("mcp__eo__memory_read");
  });

  it("asks for no memory: no memory_note, no definition of a note, no scopes to write to", () => {
    expect(prompt).not.toContain("memory_note");
    expect(prompt).not.toContain(MEMORY_NOTE_DEFINITION);
    expect(prompt).not.toContain("Give each note the scope it is true of");
    expect(prompt).not.toContain("a fact to memory");
  });

  it("keeps the rules on what may be saved", () => {
    expect(prompt).toContain("Save only what this run can point to");
    expect(prompt).toContain("Never save any of these");
  });
});

describe("the learning review's prompt on skills (EO-718)", () => {
  const skills = [
    { slug: "csv-exports", description: "Use when adding a CSV export.", loaded: true, locked: false },
    { slug: "house-style", description: "Use when writing anything a person reads.", loaded: false, locked: true },
  ];
  const prompt = learningReviewPrompt(SCOPES, { skills, canCreate: true });

  it("lists the skills it may change, saying which the run loaded and which a person locked", () => {
    expect(prompt).toContain("- `csv-exports` (loaded in this run) — Use when adding a CSV export.");
    expect(prompt).toContain("- `house-style` (a person locked it: read it, but it cannot be changed) — Use when writing anything a person reads.");
  });

  it("names every skill tool", () => {
    for (const tool of ["skill_view", "skill_create", "skill_patch", "skill_file_write", "skill_file_remove"]) expect(prompt, tool).toContain(`mcp__eo__${tool}`);
  });

  it("prefers a loaded skill, then a broad one, then a references/ file, and only then a new skill named for the kind of task", () => {
    const order = ["1. Patch a skill this run loaded.", "2. Else patch an existing broad skill", "3. Else add a file under `references/`", "4. Only then create a new skill"];
    const at = order.map((line) => prompt.indexOf(line));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt).toContain("named after the kind of task — never after a ticket, an error string or a date");
  });

  it("says to state one lesson once, fix wrong text in place, and read before writing", () => {
    expect(prompt).toContain("State one lesson once");
    expect(prompt).toContain("fix that text in place rather than adding a correction beside it");
    expect(prompt).toContain("EO refuses a change to what this review has not read");
  });

  it("says not to create a skill for an item on no project, and that no skills are given where there are none", () => {
    const bare = learningReviewPrompt(SCOPES, { skills: [], canCreate: false });
    expect(bare).toContain("This run's agent is given no skills here yet.");
    expect(bare).toContain("Do not create a skill");
    expect(bare).not.toContain("4. Only then create a new skill");
  });
});

describe("the learning_review event (EO-717)", () => {
  it("records each outcome in the shape core parses", () => {
    const events = [
      learningReviewEvent({ kind: "written", entryIds: ["m-1"], skillIds: ["s-1"], forkThreadId: "f-1" }, "full"),
      learningReviewEvent({ kind: "nothing_to_save", forkThreadId: "f-1" }, "full"),
      learningReviewEvent({ kind: "failed", entryIds: ["m-2"], skillIds: [], reason: "It ran past its limit.", forkThreadId: "f-1" }, "skills_only"),
      learningReviewEvent({ kind: "fell_back", reason: "thread_not_found: gone." }, "skills_only"),
    ];
    expect(events.map((event) => [event.type, event.outcome, event.review, event.entryIds, event.skillIds, event.reason])).toEqual([
      [LEARNING_REVIEW_EVENT, "written", "full", ["m-1"], ["s-1"], null],
      [LEARNING_REVIEW_EVENT, "nothing_to_save", "full", [], [], null],
      [LEARNING_REVIEW_EVENT, "failed", "skills_only", ["m-2"], [], "It ran past its limit."],
      [LEARNING_REVIEW_EVENT, "fell_back", "skills_only", [], [], "thread_not_found: gone."],
    ]);
    for (const event of events) expect(LearningReviewEventSchema.parse(event)).toEqual(event);
  });

  it("reads an event written before there was a skill-only review as a full one (EO-731)", () => {
    const old = { type: LEARNING_REVIEW_EVENT, outcome: "nothing_to_save", entryIds: [], skillIds: [], reason: null, forkThreadId: "f-1" };
    expect(LearningReviewEventSchema.parse(old).review).toBe("full");
  });
});
