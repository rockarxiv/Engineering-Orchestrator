import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createStep, currentOutputOf, listAgents, listCommentsForItem, listMentionsForComment, needsAttention, postComment, postOutputComment } from "../db/repos/index.js";
import { awaitsTheStep } from "../roles/interpretation.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail } from "./domainQueries.js";
import { exportItemOutput, outputFormat, setItemOutput } from "./outputCommands.js";

/**
 * A person's correction of what a ticket has produced (EO-298,
 * ARCHITECTURE.md, "The output is a comment").
 *
 * The command phase 6's editor will post through, and the half of
 * the design that a run cannot supply for itself:
 * the step that sends has to send what the *approver* wrote, and until
 * this existed the only thing that could produce an output was the run
 * that did the work.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

function story() {
  return createTestItem(handle.db, { type: "story", title: "Answer case 4821", stepId: "todo" });
}

/** What a run would have left behind, so there is something to correct. */
function agentOutput(itemId: string, body: string) {
  const [agent] = listAgents(handle.db);
  return postOutputComment(handle.db, { itemId: itemId as never, author: { type: "agent", agentId: agent!.id }, body });
}

describe("items:setOutput", () => {
  it("posts a superseding comment, and currentOutputOf returns it", () => {
    const item = story();
    const written = agentOutput(item.id, "Your refund is on its way.");

    const result = setItemOutput(handle.db, { itemId: item.id, body: "Your refund was issued this morning, and the fee is waived." });

    expect(result.problem).toBeNull();
    expect(result.supersededCommentId).toBe(written.id);

    const current = currentOutputOf(handle.db, item.id);
    expect(current?.id).toBe(result.commentId);
    expect(current?.body).toBe("Your refund was issued this morning, and the fee is waived.");
    // A person's, not the agent's — which is the whole point of it.
    expect(current?.authorType).toBe("human");
    // Chained to what it replaced, so the record says what was changed.
    expect(current?.parentId).toBe(written.id);
  });

  it("leaves the output it superseded in the thread", () => {
    const item = story();
    const written = agentOutput(item.id, "Your refund is on its way.");

    setItemOutput(handle.db, { itemId: item.id, body: "Your refund was issued this morning." });

    // EO does not rewrite what happened: "the approver changed this" is
    // only a fact the ticket can state if what was changed is still here.
    const thread = listCommentsForItem(handle.db, item.id);
    const outputs = thread.filter((comment) => comment.kind === "output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.id).toBe(written.id);
    expect(outputs[0]?.body).toBe("Your refund is on its way.");
    expect(outputs[0]?.authorType).toBe("agent");
  });

  it("is the first output when the ticket had none, and says it superseded nothing", () => {
    const item = story();

    const result = setItemOutput(handle.db, { itemId: item.id, body: "Written by hand, before anything ran." });

    expect(result.supersededCommentId).toBeNull();
    expect(currentOutputOf(handle.db, item.id)?.id).toBe(result.commentId);
  });

  it("chains a second edit to the first, so the latest is the current one however many there are", () => {
    const item = story();
    agentOutput(item.id, "one");
    const second = setItemOutput(handle.db, { itemId: item.id, body: "two" });
    const third = setItemOutput(handle.db, { itemId: item.id, body: "three" });

    expect(third.supersededCommentId).toBe(second.commentId);
    expect(currentOutputOf(handle.db, item.id)?.body).toBe("three");
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "output")).toHaveLength(3);
  });

  it("refuses an empty body rather than making the ticket produce nothing", () => {
    const item = story();
    const written = agentOutput(item.id, "Your refund is on its way.");

    const result = setItemOutput(handle.db, { itemId: item.id, body: "   \n  " });

    expect(result.commentId).toBeNull();
    expect(result.problem).toContain("cannot be empty");
    // And nothing moved: the agent's output is still what stands.
    expect(currentOutputOf(handle.db, item.id)?.id).toBe(written.id);
  });

  it("answers nothing, so it neither clears the ticket's markers nor resumes what parked on one", () => {
    // An output is a document, not a reply. A person correcting a draft
    // on a ticket that is parked on an unrelated question has not
    // answered that question — and a comment that quietly marked it
    // answered would take the `!` off a ticket still waiting for a
    // person, which is the one marker EO derives rather than stores
    // precisely so that it cannot go stale (invariant 6).
    const item = story();
    const [agent] = listAgents(handle.db);
    const asked = postComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agent!.id },
      kind: "escalation",
      body: "Which refund policy applies here?",
      mentions: [{ type: "human" }],
    });

    setItemOutput(handle.db, { itemId: item.id, body: "A draft of the reply, corrected." });

    expect(listMentionsForComment(handle.db, asked.id).every((mention) => mention.status === "open")).toBe(true);
    expect(needsAttention(handle.db, item.id)).toBe(true);
    // The other half of the same fact, at the seam the scheduler reads.
    const posted = currentOutputOf(handle.db, item.id)!;
    expect(awaitsTheStep(posted, { read: new Set(), resuming: new Set() }, null)).toBe(false);
  });

  it("summons nobody out of the text it carries", () => {
    // A corrected draft carries whatever the customer's name happens to
    // be, and a diff carries whatever the code does. Neither is somebody
    // addressing a colleague, and a mention is a dispatch trigger.
    const item = story();

    setItemOutput(handle.db, { itemId: item.id, body: "Hi @user — your refund is on its way. — @product-owner" });

    expect(needsAttention(handle.db, item.id)).toBe(false);
    expect(listMentionsForComment(handle.db, currentOutputOf(handle.db, item.id)!.id)).toEqual([]);
  });

  it("refuses a ticket that is not there", () => {
    const result = setItemOutput(handle.db, { itemId: "01a00000-0000-7000-8000-000000000000", body: "anything" });

    expect(result.commentId).toBeNull();
    expect(result.problem).toContain("no longer exists");
  });
});

/**
 * The output above the thread (EO-311, ARCHITECTURE.md, "The output is a comment", "The item").
 *
 * Which output is current is derived and tested above; what this is
 * about is the two questions the screen asks of the main process —
 * *may a person act on this here*, and *what is this thing* — because
 * both of them decide what gets drawn, and neither is the renderer's to
 * guess at.
 */
describe("the item's current output, as the detail offers it", () => {
  /**
   * The shape the design describes: an agent drafts, a person approves.
   *
   * Built rather than borrowed from the shipped pipeline, for
   * `decide.test.ts`'s reason: what this is about is the *kind* of step,
   * and a fixture made of the developer pipeline would be testing the
   * developer pipeline.
   */
  function draftAndApproval() {
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "agent", ownerRole: "implementer", entryAction: "implement" });
    createStep(handle.db, {
      id: "approval",
      pipelineId: "default" as Uuid,
      position: 21,
      name: "Approval",
      type: "user",
      results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
    });
  }

  function onStep(stepId: string) {
    return createTestItem(handle.db, { type: "story", title: "The Q3 report", stepId });
  }

  it("is offered on a user step, and is the latest output there is", () => {
    draftAndApproval();
    const item = onStep("approval");
    agentOutput(item.id, "The first draft.");
    const corrected = setItemOutput(handle.db, { itemId: item.id, body: "The draft, corrected." });

    const output = getItemDetail(handle.db, { itemId: item.id })!.currentOutput;

    expect(output?.commentId).toBe(corrected.commentId);
    expect(output?.body).toBe("The draft, corrected.");
    expect(output?.authorType).toBe("human");
    // What it displaced, so the panel can point at the thread for it.
    expect(output?.supersedesCommentId).toBe(corrected.supersededCommentId);
  });

  it("is not offered on an agent step, where the run is still producing it", () => {
    draftAndApproval();
    const item = onStep("draft");
    agentOutput(item.id, "Half a draft.");

    const detail = getItemDetail(handle.db, { itemId: item.id })!;

    // Null where nobody may act on it — and nothing is hidden by that:
    // the output is a comment, and the thread has it on every step.
    expect(detail.currentOutput).toBeNull();
    expect(detail.comments.filter((comment) => comment.kind === "output")).toHaveLength(1);
  });

  it("is null on a user step that has produced nothing", () => {
    draftAndApproval();
    const item = onStep("approval");

    expect(getItemDetail(handle.db, { itemId: item.id })!.currentOutput).toBeNull();
  });

  it("carries the files a run produced, with the comment they hang on", () => {
    draftAndApproval();
    const item = onStep("approval");
    const [agent] = listAgents(handle.db);
    postOutputComment(handle.db, {
      itemId: item.id,
      author: { type: "agent", agentId: agent!.id },
      body: "The file this run produced:\n\n- q3.docx",
      attachmentRecords: [{ id: uuidv7(), storagePath: "/tmp/q3.docx", name: "q3.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4_096 }],
    });

    const output = getItemDetail(handle.db, { itemId: item.id })!.currentOutput;

    // A file rather than text, so the panel draws the attachment card
    // and offers no editor over EO's own sentence naming it.
    expect(output?.format).toBe("file");
    expect(output?.attachments.map((attachment) => attachment.name)).toEqual(["q3.docx"]);
  });
});

/**
 * What an output *is*, read off what it says (EO-311).
 *
 * Three answers, and the screen draws a different thing for each: a
 * file is its attachment card, a diff is today's diff view and is not
 * edited here, and text is the case the editor exists for.
 */
describe("outputFormat", () => {
  it("is a file whenever the output carries one, whatever the body says", () => {
    expect(outputFormat({ body: "```diff\n+ one\n```", attachments: [{}] })).toBe("file");
  });

  it("is a diff for the fence the git workspace posts", () => {
    expect(outputFormat({ body: "```diff\n--- a/src/limit.ts\n+++ b/src/limit.ts\n```" })).toBe("diff");
    // Longer fences are what `composeOutputBody` writes when the diff
    // itself contains backticks.
    expect(outputFormat({ body: "````diff\n+ const fence = \"```\";\n````" })).toBe("diff");
  });

  it("is text for prose that merely quotes one, which is a report a person may correct", () => {
    expect(outputFormat({ body: "Here is what changed:\n\n```diff\n+ one\n```" })).toBe("text");
    expect(outputFormat({ body: "Your refund is on its way." })).toBe("text");
  });
});

/**
 * Saving the output as a file (EO-311, ARCHITECTURE.md, "The item").
 *
 * The dialog and the write are the machine's — a renderer has neither
 * (F-02) — so what is tested here is that the right bytes reach the path
 * the person chose, and that the three ways it can come to nothing are
 * told apart: a ticket that has gone, a ticket that produced nothing,
 * and a person who closed the dialog.
 */
describe("items:exportOutput", () => {
  const savesTo = (destination: string | null) => ({ saveFile: () => Promise.resolve(destination) });

  it("writes the output's text where the person chose", async () => {
    const item = story();
    agentOutput(item.id, "Your refund is on its way.");
    const destination = join(mkdtempSync(join(tmpdir(), "eo-export-")), "out.md");

    const result = await exportItemOutput(handle.db, savesTo(destination), { itemId: item.id });

    expect(result).toEqual({ saved: true, path: destination, problem: null });
    expect(readFileSync(destination, "utf8")).toBe("Your refund is on its way.");
  });

  it("writes what a person corrected, not what the run wrote", async () => {
    const item = story();
    agentOutput(item.id, "Your refund is on its way.");
    setItemOutput(handle.db, { itemId: item.id, body: "Your refund was issued this morning, and the fee is waived." });
    const destination = join(mkdtempSync(join(tmpdir(), "eo-export-")), "out.md");

    await exportItemOutput(handle.db, savesTo(destination), { itemId: item.id });

    expect(readFileSync(destination, "utf8")).toBe("Your refund was issued this morning, and the fee is waived.");
  });

  it("says nothing at all when the person closes the dialog", async () => {
    const item = story();
    agentOutput(item.id, "Your refund is on its way.");

    // Not a failure. Somebody decided, and a screen shouting about it
    // would be shouting about their decision.
    expect(await exportItemOutput(handle.db, savesTo(null), { itemId: item.id })).toEqual({ saved: false, path: null, problem: null });
  });

  it("refuses a ticket with nothing to export, and one that is not there", async () => {
    const item = story();

    expect((await exportItemOutput(handle.db, savesTo("/nowhere"), { itemId: item.id })).problem).toContain("has not produced anything");
    expect((await exportItemOutput(handle.db, savesTo("/nowhere"), { itemId: "01a00000-0000-7000-8000-000000000000" })).problem).toContain("no longer exists");
  });

  it("reports a write it could not make rather than throwing at the renderer", async () => {
    const item = story();
    agentOutput(item.id, "Your refund is on its way.");

    const result = await exportItemOutput(handle.db, savesTo("/nowhere/at/all/out.md"), { itemId: item.id });

    expect(result.saved).toBe(false);
    expect(result.problem).not.toBeNull();
  });
});
