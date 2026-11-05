import { liveMessageOf, pageDescriptorFor, type AssistReply, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  appendSyncedRunEvents,
  createRun,
  getItem,
  listCommentsForItem,
  listRunEvents,
  listRunEventsAfter,
  postComment,
  setItemArchived,
  updateRun,
} from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION } from "../roles/conversationSteps.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import { listAssist, newAssist, openAssist, sendToAssist } from "./assistCommands.js";
import { conversationView, FINISHED_TURNS, heldLiveRuns, keptFinishedTurns, type ConversationKind } from "./conversationView.js";

/**
 * What drawing the assistant's chat reads (EO-552): each thing once, and
 * in proportion to what is shown or changed rather than to everything
 * the database has ever held.
 *
 * The repository is wrapped rather than replaced, so every read still
 * answers from the real in-memory database and the count is of the calls
 * every module made — the card-kind callbacks in `roles/` included.
 */
vi.mock("../db/repos/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/repos/index.js")>();
  return {
    ...actual,
    listCommentsForItem: vi.fn(actual.listCommentsForItem),
    listRunEvents: vi.fn(actual.listRunEvents),
    listRunEventsAfter: vi.fn(actual.listRunEventsAfter),
  };
});

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
  vi.clearAllMocks();
});

afterEach(() => {
  handle.close();
});

function send(body: string, conversationId: string | null = null) {
  return sendToAssist(handle.db, undefined, { page: pageDescriptorFor("/settings"), conversationId, body, attachmentIds: [], interrupt: false });
}

function rowOf(id: string): Item {
  return getItem(handle.db, id as Uuid)!;
}

/** How many times the thread of this item was read since the counts were last cleared. */
function threadReads(itemId: string): number {
  return vi.mocked(listCommentsForItem).mock.calls.filter(([, id]) => id === itemId).length;
}

/** A finished assistant turn in this chat, posted the way the supervisor posts one. */
function turn(conversation: Item, output: AssistReply): Uuid {
  const agent = assistAgent(handle.db)!;
  const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });
  updateRun(handle.db, run.id, { status: "succeeded", startedAt: 1_000, endedAt: 2_000, result: { raw: JSON.stringify(output), parsed: output } });
  postAssistReply(handle.db, conversation, agent.id, run.id, output);
  return run.id;
}

const A_STORY = {
  action: "new_feature" as const,
  title: "Rate limiting",
  understanding: "Cap what one key can do per minute.",
  decisions: [],
  stories: [{ title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts are per key"], depends_on: [], touches: [] }],
};

describe("drawing a chat", () => {
  it("reads the thread once, however many cards and questions it holds", async () => {
    const chat = (await send("Plan the rate limiter.")).conversation;
    turn(rowOf(chat.id), { message: "One way.", questions: [], proposals: [A_STORY] });
    await send("Cut it in two.", chat.id);
    turn(rowOf(chat.id), { message: "Two ways to cut it.", questions: [], proposals: [A_STORY, { ...A_STORY, title: "Quotas" }] });
    await send("What do you need from me?", chat.id);
    turn(rowOf(chat.id), {
      message: "Two things first.",
      questions: [
        { id: "days", question: "How many days?", why: "A window.", options: ["3", "7"] },
        { id: "who", question: "Whose default?", why: "It applies to everyone.", options: ["mine", "everyone"] },
      ],
      proposals: [],
    });
    vi.clearAllMocks();

    const view = openAssist(handle.db).conversation;

    // The cards are drawn as they were: the newest run's two proposals
    // are live, the older one is superseded, and both questions are
    // answerable.
    expect(view.messages.filter((message) => message.canApprove)).toHaveLength(2);
    expect(view.messages.filter((message) => message.kind === PROPOSAL_KIND && !message.canApprove).map((message) => message.proposal?.closed)).toEqual(["superseded"]);
    expect(view.messages.filter((message) => message.canAnswer)).toHaveLength(2);
    expect(view.messages.find((message) => message.canApprove)?.approves).toBe("items");
    expect(threadReads(chat.id)).toBe(1);
    expect(vi.mocked(listCommentsForItem)).toHaveBeenCalledTimes(1);
  });
});

describe("the live turn's events", () => {
  async function chatWithARunningTurn() {
    const chat = (await send("Rework the release pipeline.")).conversation;
    const asked = listCommentsForItem(handle.db, chat.id as Uuid)[0]!;
    const run = createRun(handle.db, { itemId: chat.id as Uuid, agentId: assistAgent(handle.db)!.id, action: ASSIST_ACTION, status: "running", initiationId: asked.id });
    updateRun(handle.db, run.id, { startedAt: 1_000 });
    return { chat, run };
  }

  it("are read whole once, and after that only what arrived since", async () => {
    const { chat, run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Reading the pipeline first." });
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "mcp__eo_admin__pipeline_get", args: {}, callId: "c1" });
    appendRunEvent(handle.db, run.id, "tool_result", { type: "tool_result", name: "mcp__eo_admin__pipeline_get", callId: "c1", ok: true, output: "{}", truncated: false });
    vi.clearAllMocks();

    const first = openAssist(handle.db).conversation;
    expect(first.liveTurn?.steps).toHaveLength(2);
    expect(vi.mocked(listRunEventsAfter).mock.calls.map(([, runId, after]) => [runId, after])).toEqual([[run.id, -1]]);

    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Now the steps." });
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "mcp__eo_admin__pipeline_graph", args: {}, callId: "c2" });
    vi.clearAllMocks();

    const second = openAssist(handle.db).conversation;
    // Only past the last sequence the first view held (0, 1, 2), and the
    // whole log is never read.
    expect(vi.mocked(listRunEventsAfter).mock.calls.map(([, runId, after]) => [runId, after])).toEqual([[run.id, 2]]);
    expect(vi.mocked(listRunEvents)).not.toHaveBeenCalled();
    // And what is drawn is the whole turn, as a full read would draw it.
    expect(second.liveTurn?.steps.map((step) => step.kind)).toEqual(["text", "tool", "text", "tool"]);
    expect(second.liveActivity).toEqual(["Used mcp__eo_admin__pipeline_get", "Used mcp__eo_admin__pipeline_graph"]);
    expect(threadReads(chat.id)).toBe(1);
  });

  it("are read past a gap again until it fills, so an event that lands out of order is not skipped", async () => {
    const { run } = await chatWithARunningTurn();
    appendSyncedRunEvents(handle.db, run.id, "laptop", [
      { seq: 0, ts: 1, type: "output", payload: { type: "output", text: "One. " } },
      { seq: 2, ts: 3, type: "output", payload: { type: "output", text: "Three." } },
    ]);
    expect(openAssist(handle.db).conversation.liveOutput).toBe(liveMessageOf(["One. ", "Three."]));

    appendSyncedRunEvents(handle.db, run.id, "laptop", [{ seq: 1, ts: 2, type: "output", payload: { type: "output", text: "Two. " } }]);
    vi.clearAllMocks();
    expect(openAssist(handle.db).conversation.liveOutput).toBe(liveMessageOf(["One. ", "Two. ", "Three."]));
    // From the end of the unbroken stretch, which was only the first.
    expect(vi.mocked(listRunEventsAfter).mock.calls.map(([, , after]) => after)).toEqual([0]);
  });

  it("are let go of once the run is no longer running", async () => {
    const { run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Working." });
    openAssist(handle.db);
    expect(heldLiveRuns(handle.db)).toBe(1);

    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 2_000 });
    openAssist(handle.db);
    expect(heldLiveRuns(handle.db)).toBe(0);
  });
});

describe("opening the room", () => {
  it("weighs every live chat's last word without reading any of their threads", async () => {
    const first = (await send("The first chat.")).conversation;
    for (let index = 0; index < 20; index++) postComment(handle.db, { itemId: first.id as Uuid, author: { type: "human" }, body: `Note ${index}.` });
    const second = newAssist(handle.db).conversation;
    await send("The second chat.", second.id);
    vi.clearAllMocks();

    const opened = openAssist(handle.db);

    expect(opened.conversation.id).toBe(second.id);
    // The chat not on show is not read at all; the one on show once, to draw it.
    expect(threadReads(first.id)).toBe(0);
    expect(threadReads(second.id)).toBe(1);
  });
});

describe("the list of chats", () => {
  it("names and dates a put-away chat without reading everything said in it", async () => {
    const chat = (await send("An old conversation about quotas.\nWith a second line.")).conversation;
    let newest = 0;
    for (let index = 0; index < 60; index++) {
      newest = postComment(handle.db, { itemId: chat.id as Uuid, author: { type: "human" }, body: `Follow-up ${index}.`, createdAt: Date.now() + index + 1 }).createdAt;
    }
    setItemArchived(handle.db, chat.id as Uuid, Date.now() + 1_000);
    // A chat EO opened with a brief of its own, and nobody answered.
    const briefed = newAssist(handle.db).conversation;
    const brief = postComment(handle.db, { itemId: briefed.id as Uuid, author: { type: "engine" }, body: "A brief from EO.", kind: "note" });
    postComment(handle.db, { itemId: briefed.id as Uuid, author: { type: "engine" }, body: "Filed under it.", kind: "note", parentId: brief.id });
    setItemArchived(handle.db, briefed.id as Uuid, Date.now() + 2_000);
    vi.clearAllMocks();

    const listed = listAssist(handle.db).conversations;

    const archived = listed.find((entry) => entry.id === chat.id);
    expect(archived).toMatchObject({ title: "An old conversation about quotas.", lastActivityAt: newest, live: false, state: "idle" });
    // A brief EO opened a chat with still names it, as before (EO-533).
    expect(listed.find((entry) => entry.id === briefed.id)?.title).toBe("A brief from EO.");
    expect(threadReads(chat.id)).toBe(0);
    expect(threadReads(briefed.id)).toBe(0);
  });
});

describe("the folded line over a finished turn", () => {
  it("is kept for the most recently drawn turns only", async () => {
    const chat = rowOf((await send("Lots of turns.")).conversation.id);
    const agent = assistAgent(handle.db)!;
    const turns = FINISHED_TURNS + 50;
    for (let index = 0; index < turns; index++) {
      const run = createRun(handle.db, { itemId: chat.id, agentId: agent.id, action: ASSIST_ACTION });
      updateRun(handle.db, run.id, { status: "succeeded", startedAt: 1_000, endedAt: 1_000 + index });
      appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "Read", args: {}, callId: `c${index}` });
      postComment(handle.db, { itemId: chat.id, runId: run.id, author: { type: "agent", agentId: agent.id }, body: `Reply ${index}.`, createdAt: Date.now() + index + 1 });
    }
    const kind: ConversationKind = {
      agent: () => undefined,
      fallbackName: "Assistant",
      isProposal: () => false,
      approves: () => "items",
      proposedType: () => null,
      settingsKey: "test",
      drawsTurns: true,
    };

    const view = conversationView(handle.db, chat, kind, { limit: Infinity });
    expect(view.messages.filter((message) => message.turn !== null)).toHaveLength(turns);
    expect(keptFinishedTurns()).toBe(FINISHED_TURNS);

    // A line that fell out is counted again when its turn is drawn, and
    // says the same thing.
    const again = conversationView(handle.db, chat, kind, { limit: Infinity });
    expect(again.messages.map((message) => message.turn)).toEqual(view.messages.map((message) => message.turn));
    expect(keptFinishedTurns()).toBe(FINISHED_TURNS);
  });
});
