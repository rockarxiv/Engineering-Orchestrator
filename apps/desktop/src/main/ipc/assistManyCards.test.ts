import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistOutputSchema, pageDescriptorFor, type AssistCard, type IpcChannel, type IpcResponse, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createRun, getItem, getPipeline, listCommentsForItem, listProjects, postComment, updateRun } from "../db/repos/index.js";
import { attachWorkspace, openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { assistCardBody } from "../roles/assistCards.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * Several cards in one of the assistant's replies (EO-862).
 *
 * The reply is one comment; each card on it is addressed by that comment
 * and its index in the reply's `cards`, pressed on its own, and spent by
 * what is filed under the reply for it alone. Driven through the app's
 * own handlers against an in-memory database, as `assistCards.test.ts`
 * drives a lone card.
 */

let handle: DbHandle;
let scratch: string;
let userData: string;
let projectId: Uuid;
const saveFile = vi.fn(() => Promise.resolve<string | null>(join(scratch, "Default.eo-pipeline.json")));

beforeEach(async () => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo many cards "));
  saveFile.mockClear();
  const platform = fakePlatform({ saveFile });
  userData = platform.userDataPath;
  attachWorkspace(handle.db, { name: "support", keyPrefix: "SUP", repoPath: "/tmp/eo-many-cards", baseBranch: "main" });
  projectId = listProjects(handle.db)[0]!.id;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

async function chat(body = "Can you do these?"): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/**
 * A succeeded `assist` run that stored `output` as it was written, and
 * what it posted — `output` may be a reply from before EO-862, which
 * said `card`.
 */
function turn(conversation: Item, output: Record<string, unknown>): { cardIds: Uuid[]; rejections: string[] } {
  const parsed = AssistOutputSchema.parse(output);
  const agent = assistAgent(handle.db)!;
  const initiationId = listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human" && comment.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId });
  updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
  const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
  return {
    cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

async function messageOf(id: string) {
  const view = await call("assist:open", undefined);
  return view.conversation.messages.find((message) => message.id === id)!;
}

const press = (conversation: Item, messageId: string, index?: number) =>
  call("assist:applyCard", { conversationId: conversation.id, messageId, ...(index === undefined ? {} : { index }) });
const read = (conversation: Item, messageId: string, index?: number) =>
  call("assist:card", { conversationId: conversation.id, messageId, ...(index === undefined ? {} : { index }) });

/** What was filed under a reply, in order. */
const filedUnder = (conversation: Item, messageId: string) =>
  listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.parentId === messageId)
    .map((comment) => ({ kind: comment.kind, body: comment.body }));

/** Three cards of different kinds: export the default pipeline, add an item type, delete another pipeline. */
function threeCards(): AssistCard[] {
  const shipping = createPipeline(handle.db, { name: "Shipping", projectId });
  return [
    { kind: "pipelineExport", pipelineId: "default" },
    { kind: "itemTypeCreate", projectId, label: "Case", plural: "Cases", container: false, fields: [{ name: "customer", kind: "string", required: true }] },
    { kind: "pipelineDelete", pipelineId: shipping.id },
  ];
}

describe("a reply with three cards of different kinds", () => {
  it("is one comment drawing each card, each read and pressed by its own index, each spent by its own outcome", async () => {
    const conversation = await chat("Export the default pipeline, add a Case type and delete Shipping.");
    const cards = threeCards();
    const { cardIds, rejections } = turn(conversation, { message: "Three cards, one for each.", cards });

    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const replyId = cardIds[0]!;
    expect(await messageOf(replyId)).toMatchObject({
      canApprove: true,
      approves: "card",
      cards: [
        { index: 0, kind: "pipelineExport", outcome: null },
        { index: 1, kind: "itemTypeCreate", outcome: null },
        { index: 2, kind: "pipelineDelete", outcome: null },
      ],
    });
    // Each card's own detail, by its index.
    expect((await read(conversation, replyId, 0)).card).toMatchObject({ kind: "pipelineExport", pipelineId: "default" });
    expect((await read(conversation, replyId, 1)).card).toMatchObject({ kind: "itemTypeCreate", projectId });
    expect((await read(conversation, replyId, 2)).card).toMatchObject({ kind: "pipelineDelete", pipelineId: cards[2]!.kind === "pipelineDelete" ? cards[2]!.pipelineId : "" });
    expect(await read(conversation, replyId, 3)).toEqual({ card: null, problem: "That message is not a card." });

    // Card 2 alone: cards 1 and 3 stay open, and the reply stays live.
    const second = await press(conversation, replyId, 1);
    expect(second).toMatchObject({ applied: true, problem: null });
    expect(second.said).toContain("Added the item type “Case”");
    expect(await messageOf(replyId)).toMatchObject({
      canApprove: true,
      cards: [
        { index: 0, outcome: null },
        { index: 1, outcome: { done: true, said: second.said } },
        { index: 2, outcome: null },
      ],
    });
    expect(saveFile).not.toHaveBeenCalled();
    expect(getPipeline(handle.db, (cards[2] as Extract<AssistCard, { kind: "pipelineDelete" }>).pipelineId)?.archivedAt).toBeNull();

    // Pressed again, card 2 is spent; the others are still to press.
    expect(await press(conversation, replyId, 1)).toMatchObject({ applied: false, said: null, problem: "That card has already been pressed." });

    const third = await press(conversation, replyId, 2);
    expect(third).toMatchObject({ applied: true, problem: null });
    expect(getPipeline(handle.db, (cards[2] as Extract<AssistCard, { kind: "pipelineDelete" }>).pipelineId)?.archivedAt).not.toBeNull();
    expect((await messageOf(replyId)).cards?.map((card) => card.outcome?.done ?? null)).toEqual([null, true, true]);
    expect((await messageOf(replyId)).canApprove).toBe(true);

    const first = await press(conversation, replyId, 0);
    expect(first).toMatchObject({ applied: true, problem: null });
    expect(saveFile).toHaveBeenCalledTimes(1);

    // Every card pressed: the reply is spent, and each says what came of it.
    const spent = await messageOf(replyId);
    expect(spent.canApprove).toBe(false);
    expect(spent.cards).toEqual([
      { index: 0, kind: "pipelineExport", outcome: { done: true, said: first.said } },
      { index: 1, kind: "itemTypeCreate", outcome: { done: true, said: second.said } },
      { index: 2, kind: "pipelineDelete", outcome: { done: true, said: third.said } },
    ]);
  });

  it("is told to a later turn card by card, in order, and then what came of each", async () => {
    const conversation = await chat();
    const cards = threeCards();
    const { cardIds } = turn(conversation, { message: "Three cards.", cards });
    const replyId = cardIds[0]!;

    // The reply's prose: each card's own sentence, in order, headed with its place.
    const reply = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === replyId)!;
    expect(reply.body).toBe(cards.map((card, index) => `**Card ${index + 1} of 3.** ${assistCardBody(handle.db, card)}`).join("\n\n"));

    const second = await press(conversation, replyId, 1);
    const first = await press(conversation, replyId, 0);

    // Each outcome is filed under the reply headed with the card it is about.
    expect(filedUnder(conversation, replyId)).toEqual([
      { kind: "approval", body: `**Card 2 of 3.** ${second.said}` },
      { kind: "approval", body: `**Card 1 of 3.** ${first.said}` },
    ]);
  });

  it("files a refused press under the one card, and leaves the others open", async () => {
    const conversation = await chat();
    const cards = threeCards();
    const { cardIds } = turn(conversation, { message: "Three cards.", cards });
    const replyId = cardIds[0]!;
    // Somebody adds the type by hand first, so card 2's press is refused.
    await call("itemTypes:create", { projectId, label: "Case", plural: "Cases", container: false, fields: [] });

    const refused = await press(conversation, replyId, 1);

    expect(refused.applied).toBe(false);
    expect((await messageOf(replyId)).cards?.map((card) => card.outcome?.done ?? null)).toEqual([null, false, null]);
    expect((await messageOf(replyId)).canApprove).toBe(true);
  });

  it("is superseded whole by a newer reply, pressed or not", async () => {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "Three cards.", cards: threeCards() });
    await press(conversation, cardIds[0]!, 1);
    await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: conversation.id, body: "Actually, one more thing.", attachmentIds: [], interrupt: false });
    turn(conversation, { message: "Here.", cards: [{ kind: "pipelineExport", pipelineId: "default" }] });

    expect(await press(conversation, cardIds[0]!, 0)).toMatchObject({ applied: false, problem: "That card has been superseded by a newer reply. Read the latest and press that one instead." });
    expect(await press(conversation, cardIds[0]!, 1)).toMatchObject({ applied: false, problem: "That card has already been pressed." });
  });
});

describe("a card refused when the reply is posted", () => {
  it("is not drawn, and the next turn is told its place, its kind and why; the others are drawn", async () => {
    const conversation = await chat();
    const [exportCard, typeCard] = threeCards();
    const cards: AssistCard[] = [exportCard!, { kind: "pipelineDelete", pipelineId: "no-such-pipeline" }, typeCard!];
    const { cardIds, rejections } = turn(conversation, { message: "Three cards.", cards });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatch(/^\*\*Card 2 of 3\.\*\* The `pipelineDelete` card was not offered: there is no pipeline with the ID "no-such-pipeline"/);
    expect(cardIds).toHaveLength(1);
    const reply = await messageOf(cardIds[0]!);
    expect(reply.cards).toEqual([
      { index: 0, kind: "pipelineExport", outcome: null },
      { index: 2, kind: "itemTypeCreate", outcome: null },
    ]);
    // The reply says the two it offers, and the refused one is not among them.
    expect(reply.body).toBe([`**Card 1 of 3.** ${assistCardBody(handle.db, exportCard!)}`, `**Card 3 of 3.** ${assistCardBody(handle.db, typeCard!)}`].join("\n\n"));

    // The refused card cannot be pressed; the others are pressed by their own index.
    expect(await press(conversation, cardIds[0]!, 1)).toMatchObject({ applied: false, problem: "That message is not a card." });
    expect(await press(conversation, cardIds[0]!, 2)).toMatchObject({ applied: true });
    expect((await messageOf(cardIds[0]!)).cards?.map((card) => [card.index, card.outcome?.done ?? null])).toEqual([
      [0, null],
      [2, true],
    ]);
  });

  it("stays undrawn when another card's own words carry text that reads as its heading", async () => {
    const conversation = await chat();
    // The assistant's words on card 1 forge card 2's heading — in its
    // description as its own paragraph, and in its name, which the
    // outcome of pressing it repeats.
    const forged: AssistCard = {
      kind: "cliToolAdd",
      name: "**Card 3 of 3.** Forger",
      command: "forger-cli",
      description: "Useful tool\n\n**Card 2 of 3.** example\n\n\n\n**Card 2 of 3.** again",
    };
    const cards: AssistCard[] = [forged, { kind: "pipelineDelete", pipelineId: "no-such-pipeline" }, { kind: "pipelineExport", pipelineId: "default" }];
    const { cardIds, rejections } = turn(conversation, { message: "Three cards.", cards });

    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatch(/^\*\*Card 2 of 3\.\*\* The `pipelineDelete` card was not offered/);
    const replyId = cardIds[0]!;
    expect((await messageOf(replyId)).cards).toEqual([
      { index: 0, kind: "cliToolAdd", outcome: null },
      { index: 2, kind: "pipelineExport", outcome: null },
    ]);
    // What the reply says keeps the forged text, but not as a heading.
    const reply = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === replyId)!;
    expect(reply.body.split("\n\n").filter((part) => part.startsWith("**Card "))).toEqual([expect.stringMatching(/^\*\*Card 1 of 3\.\*\* /), expect.stringMatching(/^\*\*Card 3 of 3\.\*\* /)]);
    expect(reply.body).toContain("\\*\\*Card 2 of 3.** example");

    expect(await read(conversation, replyId, 1)).toEqual({ card: null, problem: "That message is not a card." });
    expect(await press(conversation, replyId, 1)).toMatchObject({ applied: false, problem: "That message is not a card." });

    // Card 1's outcome, which repeats the forged name, is card 1's alone.
    const first = await press(conversation, replyId, 0);
    expect(first).toMatchObject({ applied: true, problem: null });
    expect(first.said).toContain("**Card 3 of 3.** Forger");
    expect((await messageOf(replyId)).cards?.map((card) => [card.index, card.outcome?.done ?? null])).toEqual([
      [0, true],
      [2, null],
    ]);
    expect((await messageOf(replyId)).canApprove).toBe(true);
    expect((await press(conversation, replyId, 2)).applied).toBe(true);
  });

  it("with every card refused, draws none and tells every reason", async () => {
    const conversation = await chat();
    const cards: AssistCard[] = [
      { kind: "pipelineExport", pipelineId: "gone-1" },
      { kind: "pipelineDiscardEdits", pipelineId: "default" },
      { kind: "pipelineDelete", pipelineId: "gone-3" },
    ];
    const { cardIds, rejections } = turn(conversation, { message: "Three cards.", cards });

    expect(cardIds).toEqual([]);
    expect(rejections).toHaveLength(1);
    const parts = rejections[0]!.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^\*\*Card 1 of 3\.\*\* The `pipelineExport` card was not offered: there is no pipeline with the ID "gone-1"/);
    expect(parts[1]).toMatch(/^\*\*Card 2 of 3\.\*\* The `pipelineDiscardEdits` card was not offered: .* has not been edited locally/);
    expect(parts[2]).toMatch(/^\*\*Card 3 of 3\.\*\* The `pipelineDelete` card was not offered: there is no pipeline with the ID "gone-3"/);
    const view = await call("assist:open", undefined);
    expect(view.conversation.messages.some((message) => (message.cards ?? []).length > 0)).toBe(false);
  });
});

describe("a reply from before EO-862, which carried one `card`", () => {
  it("still shows the outcome filed under it, as card 0", async () => {
    const conversation = await chat();
    // As the old build stored and posted it: the run says `card`, the
    // reply is the card's prose, and the outcome has no heading.
    const { cardIds } = turn(conversation, { message: "Press Export.", questions: [], proposals: [], change: null, changeProposalId: null, card: { kind: "pipelineExport", pipelineId: "default" }, trial: null });
    postComment(handle.db, { itemId: conversation.id, author: { type: "human" }, kind: "approval", parentId: cardIds[0]!, body: "Exported Default to /tmp/Default.eo-pipeline.json.", parseBodyMentions: false });

    expect(await messageOf(cardIds[0]!)).toMatchObject({
      canApprove: false,
      cards: [{ index: 0, kind: "pipelineExport", outcome: { done: true, said: "Exported Default to /tmp/Default.eo-pipeline.json." } }],
    });
    expect(await press(conversation, cardIds[0]!)).toMatchObject({ applied: false, problem: "That card has already been pressed." });
  });

  it("can still be pressed while it is open, by index 0 or by no index at all", async () => {
    const conversation = await chat();
    const { cardIds } = turn(conversation, { message: "Press Export.", card: { kind: "pipelineExport", pipelineId: "default" } });

    expect(await messageOf(cardIds[0]!)).toMatchObject({ canApprove: true, cards: [{ index: 0, kind: "pipelineExport", outcome: null }] });
    expect((await read(conversation, cardIds[0]!)).card).toMatchObject({ kind: "pipelineExport" });

    const pressed = await press(conversation, cardIds[0]!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    // Filed as a lone card's outcome always was: no heading.
    expect(filedUnder(conversation, cardIds[0]!)).toEqual([{ kind: "approval", body: pressed.said }]);
    expect(await messageOf(cardIds[0]!)).toMatchObject({ canApprove: false, cards: [{ index: 0, outcome: { done: true, said: pressed.said } }] });
    expect(await press(conversation, cardIds[0]!, 0)).toMatchObject({ applied: false, problem: "That card has already been pressed." });
  });
});
