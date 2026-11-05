import { uuidv7, type Agent, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../../db/client.js";
import { createRun, getRun, listAgents, listCommentsForItem, postComment, postOutputComment, updateRun } from "../../db/repos/index.js";
import { setItemOutput } from "../../ipc/outputCommands.js";
import { createTestItem, openMigratedTestDb } from "../../db/testHelpers.js";
import { buildFollowUpContext, buildSeedContext } from "../../supervisor/buildDispatchContext.js";
import { developerSectionRenderers } from "./sections.js";

/**
 * What the reviewer is handed about the change (EO-298,
 * ARCHITECTURE.md, "The output is a comment").
 *
 * The implementer's diff is the item's *output*: a comment of kind
 * `output` that the run posts, that a person's edit supersedes, and that
 * the next step is given in a section of its own. Two things have to be
 * true of that at once, and they pull in opposite directions:
 *
 * - the reviewer's prompt has to contain it, because a step that judges
 *   a change and cannot see one is being asked to guess; and
 * - the reviewer's prompt has to be otherwise **unchanged**, because a
 *   deliverable arriving as one more comment in the thread would take
 *   the implementer's handover note's place at its step, push the thread
 *   against the budget, and be paid for again on every turn of an
 *   agentic loop.
 *
 * So the output is rendered here, in a section this pack supplies, and
 * the thread renders a marker in its place. The snapshot below is what
 * holds both halves: the prompt with the whole section cut back out of
 * it is byte-identical to the prompt before any output existed.
 */
let handle: DbHandle;
let item: Item;
let implementer: Agent;
let reviewer: Agent;

const DIFF = [
  "```diff",
  "--- a/src/limit.ts",
  "+++ b/src/limit.ts",
  "@@ -1,3 +1,3 @@",
  " export const window = 60_000;",
  "-export const cap = 10;",
  "+export const cap = 100;",
  "```",
].join("\n");

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, {
    type: "story",
    title: "Add rate limiting",
    stepId: "review",
    body: "Throttle the public API.",
    spec: { acceptance_criteria: ["429 after 100 req/min"] },
  });
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  reviewer = listAgents(handle.db).find((agent) => agent.role === "reviewer")!;
});

afterEach(() => {
  handle.close();
});

/** The implement run that produced the change, with the note a handover leaves behind. */
function implemented(): Uuid {
  const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", stepId: "todo", threadId: uuidv7() });
  updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
  postComment(handle.db, {
    itemId: item.id,
    runId: run.id,
    author: { type: "agent", agentId: implementer.id },
    body: "Capped per token rather than per IP — the proxy collapses addresses.",
  });
  return run.id;
}

const reviewerPrompt = () => buildSeedContext(handle.db, item, reviewer, "review", developerSectionRenderers);

/** The current-output section on its own, including the blank line that joins it to the next. */
function outputSection(prompt: string): string {
  const from = prompt.indexOf("## The current output");
  const to = prompt.indexOf("## Acceptance Criteria");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return prompt.slice(from, to);
}

describe("the output an implement run produced", () => {
  it("is in the reviewer's prompt, and the rest of that prompt is unchanged", async () => {
    const runId = implemented();
    const before = await reviewerPrompt();

    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });
    const after = await reviewerPrompt();

    // It is there, whole.
    expect(after).toContain("## The current output");
    expect(after).toContain("+export const cap = 100;");

    // And it displaced nothing. The handover note still stands as what
    // the implement step said — an output is what a step *produced*, not
    // what it said, and a deliverable taking a note's place would cost
    // the reviewer the one sentence written for it.
    expect(after).toContain("Capped per token rather than per IP");
    expect(after.replace(outputSection(after), "")).toBe(before);

    await expect(after).toMatchFileSnapshot("./__snapshots__/reviewerPrompt.md");
  });

  it("is not also counted as a comment left out, since it is rendered in full", async () => {
    const runId = implemented();

    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });

    // The census counts what is *gone*. An output rendered in its own
    // section is the one comment on the ticket that certainly is not,
    // and counting it would make the seed's bargain read as a lie.
    expect(await reviewerPrompt()).toContain("## What is not here\n\nNothing — the whole thread is above.");
  });

  it("is the version a person corrected, not the one the run wrote", async () => {
    const runId = implemented();
    const written = postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });
    postOutputComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The cap is 250, not 100 — I changed it before approving.", parentId: written.id });

    const prompt = await reviewerPrompt();

    // The design, in one assertion: the next step works from what the
    // approver wrote. The diff is not gone from the ticket — it is in
    // the thread under its replacement — it is simply no longer what
    // "the output" means.
    expect(prompt).toContain("The cap is 250, not 100");
    expect(prompt).toContain("It supersedes an earlier version");
    expect(outputSection(prompt)).not.toContain("+export const cap = 100;");

    // And it is there once. An output is not something a person *said*
    // either, so the section is where it is — rather than there and
    // again under "what the person said", as a line reporting that a
    // correction exists somewhere above.
    expect(prompt.match(/The cap is 250, not 100/g)).toHaveLength(1);
    expect(prompt).toContain("## What the person said\n\nNothing since you last worked on this ticket.");
  });

  /**
   * The same fact, through the path a person actually takes (EO-311).
   *
   * The case above posts the correction with the repository function.
   * This one goes through `items:setOutput` — the command the editor
   * above the thread posts through, dialog and all — because that is
   * the claim the design makes and the one worth holding: what a person
   * typed into the box is what the next step is handed, with nothing in
   * between that could quietly hand on the agent's version instead.
   */
  it("is what the editor posted, all the way from the box to the next step's prompt", async () => {
    const runId = implemented();
    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });

    const edited = setItemOutput(handle.db, { itemId: item.id, body: "The cap is 250 — I raised it before approving, and the window stays at a minute." });
    expect(edited.problem).toBeNull();

    const prompt = await reviewerPrompt();

    expect(outputSection(prompt)).toContain("The cap is 250 — I raised it before approving");
    // And the draft it replaced is not what "the output" means any
    // more, though it is still on the ticket, in the thread, under it.
    expect(outputSection(prompt)).not.toContain("+export const cap = 100;");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "output")).toHaveLength(2);
  });

  it("says nothing at all on a ticket that has produced nothing", async () => {
    implemented();

    expect(await reviewerPrompt()).not.toContain("## The current output");
  });

  it("is capped in the prompt, and says where the rest of it is", async () => {
    const runId = implemented();
    // A diff has no natural size, and this section is fixed: truncation
    // is never allowed to take it, so an unbounded one would push the
    // comment thread out of the prompt to make room for itself.
    const enormous = Array.from({ length: 4_000 }, (_, line) => `+  const line${line} = ${line};`).join("\n");
    const output = postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: enormous });

    const section = outputSection(await reviewerPrompt());

    expect(section.length).toBeLessThan(14_000);
    expect(section).toContain("+  const line0 = 0;");
    expect(section).not.toContain("+  const line3999 = 3999;");
    // Capped, not lost: the marker names the comment the rest is in.
    expect(section).toContain(output.id);
    expect(section).toContain("more characters");
  });

  it("closes a code fence the cap cut in half, so the rest of the prompt is not inside it", async () => {
    const runId = implemented();
    // The shape the supervisor actually posts: a diff is fenced, and a
    // 12,000-character cut lands inside that fence about as often as
    // not. An unterminated fence here swallows everything below this
    // section — the acceptance criteria, the thread, the census — since
    // this section is anchored above all of them.
    const enormous = ["```diff", ...Array.from({ length: 4_000 }, (_, line) => `+  const line${line} = ${line};`), "```"].join("\n");
    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: enormous });

    const prompt = await reviewerPrompt();

    // An even number of fence markers is a prompt whose fences all
    // close. An odd one is the bug.
    expect(prompt.split("\n").filter((line) => /^\s*(`{3,}|~{3,})/.test(line)).length % 2).toBe(0);
    // And the sections below it are still sections rather than code.
    expect(prompt).toContain("## Acceptance Criteria");
  });

  it("leaves a fence alone when the whole of it fits", async () => {
    const runId = implemented();
    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });

    // Nothing appended where nothing was cut: the section is the output
    // as it was written.
    expect(outputSection(await reviewerPrompt())).toContain(DIFF);
  });
});

/**
 * The second attempt, on the thread the first one used (EO-298).
 *
 * A reused thread gets `assembleFollowUpContext`: the task line and the
 * comments the agent has not seen, and none of the sections it was sent
 * on the first turn — which is the whole economy of it, since an agentic
 * loop re-sends its conversation every turn.
 *
 * The current output is the exception, and it has to be. An implementer
 * sent back after review resumes its own thread; the diff it produced is
 * filtered out of the delta as a comment it wrote itself; and the
 * correction a person made to that diff before sending it back arrives
 * — if it arrives at all — as a one-line marker. So the one dispatch on
 * the ticket that could not see what the ticket had produced was the one
 * being asked to produce it again.
 */
describe("a reused implementation thread", () => {
  /** The first attempt, its diff, and the run a resumed dispatch carries on from. */
  function firstAttempt(): Uuid {
    const runId = implemented();
    postOutputComment(handle.db, { itemId: item.id, runId, author: { type: "agent", agentId: implementer.id }, body: DIFF });
    postComment(handle.db, { itemId: item.id, author: { type: "agent", agentId: reviewer.id }, kind: "rejection", body: "The cap is off by an order of magnitude." });
    return runId;
  }

  const followUp = (runId: Uuid) =>
    buildFollowUpContext(handle.db, item, implementer, "implement", getRun(handle.db, runId)!, { sectionRenderers: developerSectionRenderers }).fullText;

  it("receives the same current-output section a fresh dispatch would", async () => {
    const runId = firstAttempt();

    const resumed = followUp(runId);

    expect(resumed).toContain("## The current output");
    expect(resumed).toContain("+export const cap = 100;");
    // Byte-identical to what the seed renders, because it is the same
    // renderer given the same facts — a section that read differently
    // depending on which shape carried it would be a difference an agent
    // could only take for the world having changed.
    expect(resumed).toContain(outputSection(await reviewerPrompt()).trimEnd());
  });

  it("receives the correction a person made, not the diff it wrote itself", async () => {
    const runId = firstAttempt();
    postOutputComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "The cap is 250, not 100 — corrected before this went back." });

    const resumed = followUp(runId);

    expect(resumed).toContain("The cap is 250, not 100");
    expect(resumed).toContain("It supersedes an earlier version");
  });

  it("is still a delta: the sections it was sent on the first turn are not sent again", async () => {
    const runId = firstAttempt();

    const resumed = followUp(runId);

    // Instructions, which the conversation already holds. Re-sending
    // them is the duplication the follow-up shape exists to remove, and
    // the reason a section says for itself whether it is volatile.
    expect(resumed).not.toContain("## Acceptance Criteria");
    expect(resumed).not.toContain("Throttle the public API.");
    // What it *is* sent: the task line, the delta, and the output.
    expect(resumed).toContain('perform the "implement" action on this ticket');
    expect(resumed).toContain("The cap is off by an order of magnitude.");
  });

  it("says nothing about an output on a ticket that has produced none", async () => {
    const runId = implemented();

    expect(followUp(runId)).not.toContain("## The current output");
  });
});
