import { rmSync } from "node:fs";
import {
  AssistOutputSchema,
  itemTypeHoldsItemsMessage,
  pageDescriptorFor,
  packItemTypeEditRefusal,
  packItemTypeRefusal,
  type AssistCard,
  type IpcChannel,
  type IpcResponse,
  type Item,
  type ItemTypeView,
  type Uuid,
} from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getItem, listCommentsForItem, listProjects, updateRun } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { fakePlatform } from "../testing/platform.js";
import { clearHandlerRegistry, dispatchIpc } from "./registry.js";

/**
 * A project's item types through the assistant's cards (EO-523).
 *
 * The editor's Types section goes with the editor, so adding, changing and
 * removing a type is a card the assistant returns and the person presses.
 * The claim is EO-521's — returning the card changes nothing; the press
 * does it, through `itemTypes:create`, `update` or `delete` — plus the
 * two this story adds: a pack's type stays editable in its label only,
 * and whatever the channel refuses is what the card shows as the refusal.
 * Every test drives the app's own handlers and asserts against the rows.
 */

let handle: DbHandle;
let userData: string;
let projectId: Uuid;

beforeEach(async () => {
  handle = openMigratedTestDb();
  const platform = fakePlatform();
  userData = platform.userDataPath;
  attachWorkspace(handle.db, { name: "support", keyPrefix: "SUP", repoPath: "/tmp/eo-item-type-cards", baseBranch: "main" });
  projectId = listProjects(handle.db)[0]!.id;
  const { registerAllHandlers } = await import("./handlers.js");
  registerAllHandlers(handle.db, undefined, { platform });
});

afterEach(() => {
  clearHandlerRegistry();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

async function call<K extends IpcChannel>(channel: K, payload: unknown): Promise<IpcResponse<K>> {
  const answer = await dispatchIpc(channel, payload);
  if (!answer.ok) throw new Error(`${channel} refused: ${answer.error.message}`);
  return answer.data as IpcResponse<K>;
}

async function chat(body = "Can you do that?"): Promise<Item> {
  const sent = await call("assist:send", { page: pageDescriptorFor("/settings"), conversationId: null, body, attachmentIds: [], interrupt: false });
  return getItem(handle.db, sent.conversation.id as Uuid)!;
}

/** A succeeded `assist` run returning `card`, and what it posted. */
function turn(conversation: Item, card: AssistCard): { cardId: Uuid | undefined; rejections: string[] } {
  const output = { message: "That is yours to press.", card };
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
    cardId: posted.find((comment) => comment.kind === PROPOSAL_KIND)?.id,
    rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
  };
}

const press = (conversation: Item, messageId: string) => call("assist:applyCard", { conversationId: conversation.id, messageId });
const read = (conversation: Item, messageId: string) => call("assist:card", { conversationId: conversation.id, messageId });
const types = async (): Promise<ItemTypeView[]> => (await call("itemTypes:list", { projectId })).types;
const typeNamed = async (slug: string): Promise<ItemTypeView | undefined> => (await types()).find((type) => type.slug === slug);

async function messageOf(messageId: string) {
  const view = await call("assist:open", undefined);
  return view.conversation.messages.find((message) => message.id === messageId)!;
}

/** A pack's type on the project — one the developer pack ships. */
async function aPackType(): Promise<ItemTypeView> {
  return (await types()).find((type) => type.packSlug !== "local" && !type.container)!;
}

async function aLocalType(): Promise<ItemTypeView> {
  const created = await call("itemTypes:create", { projectId, label: "Case", plural: "Cases", container: false, fields: [{ name: "customer", kind: "string", required: true }] });
  return created.type!;
}

describe("adding an item type", () => {
  const CASE: AssistCard = {
    kind: "itemTypeCreate",
    projectId: "",
    label: "Case",
    plural: "Cases",
    container: false,
    fields: [
      { name: "Customer name", kind: "string", required: true },
      { name: "priority", kind: "number", required: false },
    ],
  };

  it("is a card showing the type as it would be, and nothing is added until it is pressed", async () => {
    const conversation = await chat("Add a Case type with a customer name.");
    const { cardId, rejections } = turn(conversation, { ...CASE, projectId });

    expect(rejections).toEqual([]);
    expect(await messageOf(cardId!)).toMatchObject({ canApprove: true, approves: "card", card: { kind: "itemTypeCreate", outcome: null } });
    const shown = await read(conversation, cardId!);
    expect(shown.card).toEqual({
      kind: "itemTypeCreate",
      projectId,
      projectName: "support",
      type: {
        label: "Case",
        plural: "Cases",
        slug: "case",
        container: false,
        // As the row would hold them: named the way the editor named them.
        fields: [
          { name: "customer_name", kind: "string", required: true },
          { name: "priority", kind: "number", required: false },
        ],
      },
      problem: null,
    });
    expect(await typeNamed("case")).toBeUndefined();

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true, problem: null });
    expect(pressed.said).toContain("Added the item type “Case” to support");
    expect(await typeNamed("case")).toMatchObject({ packSlug: "local", label: "Case", plural: "Cases", container: false });
    expect((await messageOf(cardId!)).card).toEqual({ kind: "itemTypeCreate", outcome: { done: true, said: pressed.said } });
  });

  it("cannot be pressed twice", async () => {
    const conversation = await chat();
    const { cardId } = turn(conversation, { ...CASE, projectId });
    await press(conversation, cardId!);

    const again = await press(conversation, cardId!);

    expect(again).toMatchObject({ applied: false, problem: "That card has already been pressed." });
    expect((await types()).filter((type) => type.slug === "case")).toHaveLength(1);
  });

  it("shows a name already taken as the refusal, and files that refusal if pressed", async () => {
    const taken = await aPackType();
    const conversation = await chat();
    const { cardId } = turn(conversation, { ...CASE, projectId, label: taken.label, plural: taken.plural });

    const shown = await read(conversation, cardId!);
    const refusal = `This project already has a “${taken.label}” filed under the word “${taken.slug}”. Pick another name.`;
    expect(shown.card).toMatchObject({ kind: "itemTypeCreate", problem: refusal });

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: false });
    expect(pressed.said).toBe(`“${taken.label}” was not added: ${refusal}`);
    expect((await types()).filter((type) => type.slug === taken.slug)).toHaveLength(1);
  });

  it("is not offered for a project that is not here", async () => {
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, { ...CASE, projectId: "no-such-project" });

    expect(cardId).toBeUndefined();
    expect(rejections[0]).toContain('there is no project with the ID "no-such-project"');
  });
});

describe("changing an item type", () => {
  it("renames a pack's type, and the card shows it as it would be", async () => {
    const story = await aPackType();
    const conversation = await chat(`Call ${story.plural} something else.`);
    const { cardId, rejections } = turn(conversation, { kind: "itemTypeUpdate", itemTypeId: story.id, label: "Request", plural: "Requests", container: null, fields: null });

    expect(rejections).toEqual([]);
    const shown = (await read(conversation, cardId!)).card;
    expect(shown).toMatchObject({ kind: "itemTypeUpdate", itemTypeId: story.id, packSlug: story.packSlug, problem: null });
    expect(shown?.kind === "itemTypeUpdate" ? [shown.before.label, shown.after.label, shown.after.slug] : null).toEqual([story.label, "Request", story.slug]);
    expect((await typeNamed(story.slug))?.label).toBe(story.label);

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: true, said: "Saved the item type “Request” (Requests)." });
    expect(await typeNamed(story.slug)).toMatchObject({ label: "Request", plural: "Requests", container: story.container, specShape: story.specShape });
  });

  it("does not let a restated container flag or field list turn a pack type's rename into a reshape", async () => {
    const story = await aPackType();
    const conversation = await chat();
    const fields = (await read(conversation, turn(conversation, { kind: "itemTypeUpdate", itemTypeId: story.id, label: "Request", plural: null, container: null, fields: null }).cardId!)).card;
    const current = fields?.kind === "itemTypeUpdate" ? fields.before.fields : [];

    const { cardId } = turn(conversation, { kind: "itemTypeUpdate", itemTypeId: story.id, label: "Request", plural: null, container: story.container, fields: current });

    expect((await read(conversation, cardId!)).card).toMatchObject({ problem: null });
    expect(await press(conversation, cardId!)).toMatchObject({ applied: true });
    expect(await typeNamed(story.slug)).toMatchObject({ label: "Request", specShape: story.specShape });
  });

  it("keeps a pack's type editable in its label only: a reshape is shown as the channel's refusal, and refused when pressed", async () => {
    const story = await aPackType();
    const conversation = await chat();
    const { cardId, rejections } = turn(conversation, { kind: "itemTypeUpdate", itemTypeId: story.id, label: null, plural: null, container: true, fields: null });

    expect(rejections).toEqual([]);
    const refusal = packItemTypeEditRefusal(story);
    expect((await read(conversation, cardId!)).card).toMatchObject({ kind: "itemTypeUpdate", problem: refusal });

    const pressed = await press(conversation, cardId!);

    expect(pressed).toMatchObject({ applied: false, problem: `“${story.label}” was not changed: ${refusal}` });
    expect((await messageOf(cardId!)).card).toEqual({ kind: "itemTypeUpdate", outcome: { done: false, said: `“${story.label}” was not changed: ${refusal}` } });
    expect(await typeNamed(story.slug)).toMatchObject({ container: false });
  });

  it("reshapes a type made here", async () => {
    const made = await aLocalType();
    const conversation = await chat();
    const { cardId } = turn(conversation, {
      kind: "itemTypeUpdate",
      itemTypeId: made.id,
      label: null,
      plural: null,
      container: true,
      fields: [{ name: "region", kind: "string list", required: false }],
    });

    expect((await read(conversation, cardId!)).card).toMatchObject({
      problem: null,
      after: { label: "Case", container: true, fields: [{ name: "region", kind: "string list", required: false }] },
    });
    expect(await press(conversation, cardId!)).toMatchObject({ applied: true });
    const after = await typeNamed("case");
    expect(after?.container).toBe(true);
    expect(Object.keys(after?.specShape.properties ?? {})).toEqual(["region"]);
  });

  it("is not offered when it changes nothing, or for a type that is not here", async () => {
    const made = await aLocalType();
    const conversation = await chat();

    expect(turn(conversation, { kind: "itemTypeUpdate", itemTypeId: made.id, label: "Case", plural: null, container: false, fields: null }).rejections[0]).toContain(
      "“Case” already is what the card says",
    );
    expect(turn(conversation, { kind: "itemTypeUpdate", itemTypeId: "gone", label: "X", plural: null, container: null, fields: null }).rejections[0]).toContain(
      'there is no item type with the ID "gone"',
    );
  });
});

describe("removing an item type", () => {
  it("deletes a type made here that nothing is filed under", async () => {
    const made = await aLocalType();
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "itemTypeDelete", itemTypeId: made.id });

    expect((await read(conversation, cardId!)).card).toMatchObject({ kind: "itemTypeDelete", itemCount: 0, problem: null, type: { label: "Case" } });
    expect(await typeNamed("case")).toBeDefined();

    expect(await press(conversation, cardId!)).toMatchObject({ applied: true, said: "Deleted the item type “Case”." });
    expect(await typeNamed("case")).toBeUndefined();
  });

  it("shows items filed under the type as the refusal, and keeps the type when pressed", async () => {
    const made = await aLocalType();
    createTestItem(handle.db, { type: "case", title: "Refund", stepId: "todo", projectId });
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "itemTypeDelete", itemTypeId: made.id });

    const refusal = itemTypeHoldsItemsMessage(made, 1)!;
    expect((await read(conversation, cardId!)).card).toMatchObject({ itemCount: 1, problem: refusal });
    expect(await press(conversation, cardId!)).toMatchObject({ applied: false, said: `“Case” was not deleted: ${refusal}` });
    expect(await typeNamed("case")).toBeDefined();
  });

  it("refuses a pack's type, in the channel's words", async () => {
    const story = await aPackType();
    // Nothing filed under it, so the refusal is the pack's and not the items'.
    const conversation = await chat();
    const { cardId } = turn(conversation, { kind: "itemTypeDelete", itemTypeId: story.id });

    expect((await read(conversation, cardId!)).card).toMatchObject({ problem: packItemTypeRefusal(story) });
    expect(await press(conversation, cardId!)).toMatchObject({ applied: false, said: `“${story.label}” was not deleted: ${packItemTypeRefusal(story)}` });
    expect(await typeNamed(story.slug)).toBeDefined();
  });
});
