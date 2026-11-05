import { pageDescriptorFor, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { appendRunEvent, createRun, getItem, listCommentsForItem, listMentionsForComment, postComment, updateAgent, updateRun } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { assistAgent, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION, conversationTurnOptions } from "../roles/conversationSteps.js";
import { liveDrafts } from "../supervisor/liveDrafts.js";
import { forkAssistConversation, listAssist, newAssist, openAssist, readEarlierAssist, resumeAssist, sendToAssist, stopAssistTurn, updateAssistSettings, withdrawAssistMessage } from "./assistCommands.js";
import { runSteps } from "./conversationView.js";

/**
 * The assistant chat drawn and driven the way Claude Desktop's is: the
 * running turn step by step with the words being written, a finished
 * turn folded behind one line, Stop, per-chat settings, and fork.
 */
let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
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

/** A chat whose first message started a turn that is still running. */
async function chatWithARunningTurn() {
  const chat = (await send("Rework the release pipeline.")).conversation;
  const asked = listCommentsForItem(handle.db, chat.id as Uuid)[0]!;
  const run = createRun(handle.db, { itemId: chat.id as Uuid, agentId: assistAgent(handle.db)!.id, action: ASSIST_ACTION, status: "running", initiationId: asked.id });
  updateRun(handle.db, run.id, { startedAt: 1_000 });
  return { chat, run, asked };
}

function engine(cancelled: string[]) {
  return { cancelRun: (id: string) => cancelled.push(id), notifyStateChange: () => undefined } as never;
}

describe("the running turn, as the chat draws it", () => {
  it("lists what the turn did, what it is writing, and the answer as far as it is stored", async () => {
    const { chat, run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Reading the pipeline first." });
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "mcp__eo_admin__pipeline_get", args: { pipelineId: "p" }, callId: "c1" });
    appendRunEvent(handle.db, run.id, "tool_result", { type: "tool_result", name: "mcp__eo_admin__pipeline_get", callId: "c1", ok: true, output: "{}", truncated: false });
    liveDrafts.append(run.id, chat.id, "text", "It has three ");

    const view = openAssist(handle.db).conversation;
    expect(view.liveTurn).toMatchObject({
      runId: run.id,
      startedAt: 1_000,
      steps: [
        { kind: "text", text: "Reading the pipeline first." },
        { kind: "tool", label: "eo_admin · pipeline_get", ok: true },
      ],
      drafts: [{ stream: "text", text: "It has three " }],
      answer: "",
    });

    // The answer written as the structured-output tool: its message.
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "StructuredOutput", args: { outcome: { message: "It has three steps." } }, callId: "c2" });
    expect(openAssist(handle.db).conversation.liveTurn?.answer).toBe("It has three steps.");
    liveDrafts.clear(run.id);
  });

  it("keeps a Codex answer on screen between its JSON being stored and its comment landing", async () => {
    const { run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Looking at the board.", schemaConstrained: true });
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: '{"outcome":{"message":"Two approvals wait on you.","questions":[]}}', schemaConstrained: true });
    expect(openAssist(handle.db).conversation.liveTurn?.answer).toBe("Two approvals wait on you.");
  });

  it("stops drawing the turn once it has answered, and folds it above the answer", async () => {
    const { chat, run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "reasoning", { type: "reasoning", text: "Which board?" });
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "Read", args: { file_path: "a.ts" }, callId: "c1" });
    appendRunEvent(handle.db, run.id, "file_edit", { type: "file_edit", path: "a.ts" });
    appendRunEvent(handle.db, run.id, "file_edit", { type: "file_edit", path: "a.ts" });
    appendRunEvent(handle.db, run.id, "file_edit", { type: "file_edit", path: "b.ts" });
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "StructuredOutput", args: {}, callId: "c2" });
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 61_000 });
    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, { message: "Done.", questions: [], proposals: [] });

    const view = openAssist(handle.db).conversation;
    expect(view.liveTurn).toBeNull();
    const reply = view.messages.find((message) => message.body === "Done.");
    expect(reply?.turn).toEqual({ runId: run.id, durationMs: 60_000, toolCalls: 1, filesEdited: 2, reasoned: true });
    // Only on the turn's first message, and never on what a person said.
    expect(view.messages.filter((message) => message.turn).length).toBe(1);

    expect(runSteps(handle.db, run.id).map((step) => step.kind)).toEqual(["reasoning", "tool", "edit", "edit", "edit"]);
  });

  it("names the run working in it, even once the turn has answered and is no longer drawn, so the room can tell its own progress from other runs' (EO-550)", async () => {
    const { chat, run } = await chatWithARunningTurn();
    expect(openAssist(handle.db).conversation.activeRunId).toBe(run.id);

    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, { message: "Done.", questions: [], proposals: [] });
    const answered = openAssist(handle.db).conversation;
    expect(answered.liveTurn).toBeNull();
    expect(answered.activeRunId).toBe(run.id);

    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 2_000 });
    expect(openAssist(handle.db).conversation.activeRunId).toBeNull();
  });

  it("does not fold a turn that did nothing but answer", async () => {
    const { chat, run } = await chatWithARunningTurn();
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 2_000 });
    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, { message: "Yes.", questions: [], proposals: [] });
    expect(openAssist(handle.db).conversation.messages.every((message) => message.turn == null)).toBe(true);
  });
});

describe("stopping a turn", () => {
  it("cancels the run, keeps the queued message from starting the next turn, and says so under the run", async () => {
    const { chat, run, asked } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "Bash", args: { command: "ls" }, callId: "c1" });
    const queued = (await send("and the hotfix one", chat.id)).conversation.messages.at(-1)!;
    const cancelled: string[] = [];

    const stopped = stopAssistTurn(handle.db, engine(cancelled), { conversationId: chat.id });

    expect(stopped.stopped).toBe(true);
    expect(cancelled).toEqual([run.id]);
    for (const id of [asked.id, queued.id]) {
      expect(listMentionsForComment(handle.db, id as Uuid).some((mention) => mention.status === "open")).toBe(false);
    }
    const note = listCommentsForItem(handle.db, chat.id as Uuid).at(-1)!;
    // And says the queued message will not be answered (invariant 8).
    expect(note).toMatchObject({ authorType: "engine", body: "Turn stopped.\n\nThe message sent while it ran was not answered; send again to ask.", runId: run.id });
    // The work it did before it was stopped is folded above that line.
    updateRun(handle.db, run.id, { status: "cancelled", endedAt: 3_000 });
    expect(openAssist(handle.db).conversation.messages.at(-1)?.turn).toMatchObject({ runId: run.id, toolCalls: 1 });
  });

  it("does nothing once the turn has answered, and says nothing under the answer", async () => {
    const { chat, run } = await chatWithARunningTurn();
    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, { message: "Done.", questions: [], proposals: [] });
    const cancelled: string[] = [];
    expect(stopAssistTurn(handle.db, engine(cancelled), { conversationId: chat.id }).stopped).toBe(false);
    expect(cancelled).toEqual([]);
    expect(listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body)).toEqual(["Rework the release pipeline.", "Done."]);
  });

  it("does nothing when nothing is running, and refuses a conversation that is not the assistant's", async () => {
    const chat = (await send("hello")).conversation;
    const cancelled: string[] = [];
    expect(stopAssistTurn(handle.db, engine(cancelled), { conversationId: chat.id }).stopped).toBe(false);
    expect(cancelled).toEqual([]);
    expect(listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body)).toEqual(["hello"]);

    const story = createTestItem(handle.db, { type: "story", title: "Somebody's story", stepId: "todo" });
    expect(() => stopAssistTurn(handle.db, engine(cancelled), { conversationId: story.id })).toThrow("That is not an assist conversation.");
  });
});

describe("a chat's own settings", () => {
  it("are written where the next turn reads them, reasoning switch included", async () => {
    // On a backend that offers efforts: the test database's agent runs on the fake one, which offers none.
    updateAgent(handle.db, assistAgent(handle.db)!.id, { provider: "claude" });
    const chat = (await send("hello")).conversation;
    expect(chat.settings.showReasoning).toBe(true);
    expect(chat.settings.reasoningEfforts?.length).toBeGreaterThan(0);

    const effort = chat.settings.reasoningEfforts![0]!;
    const { settings } = updateAssistSettings(handle.db, { conversationId: chat.id, model: " claude-sonnet-5 ", reasoningEffort: effort, showReasoning: false });

    expect(settings).toMatchObject({ model: "claude-sonnet-5", reasoningEffort: effort, showReasoning: false });
    expect(conversationTurnOptions(rowOf(chat.id))).toEqual({ model: "claude-sonnet-5", reasoningEffort: effort, showReasoning: false, streamDeltas: true, streamAnswer: true });

    // One field at a time leaves the others.
    updateAssistSettings(handle.db, { conversationId: chat.id, showReasoning: true });
    expect(conversationTurnOptions(rowOf(chat.id))).toEqual({ model: "claude-sonnet-5", reasoningEffort: effort, showReasoning: true, streamDeltas: true, streamAnswer: true });
    // And clearing the model goes back to the agent's.
    updateAssistSettings(handle.db, { conversationId: chat.id, model: null });
    expect(conversationTurnOptions(rowOf(chat.id)).model).toBeUndefined();
  });

  it("refuses an effort the backend does not offer", async () => {
    updateAgent(handle.db, assistAgent(handle.db)!.id, { provider: "claude" });
    const chat = (await send("hello")).conversation;
    expect(() => updateAssistSettings(handle.db, { conversationId: chat.id, reasoningEffort: "galactic" })).toThrow(/does not offer reasoning effort "galactic"/);
  });
});

describe("forking a chat", () => {
  it("starts a new chat holding the conversation up to a message, starts no turn, and leaves the original alone", async () => {
    const { chat, run } = await chatWithARunningTurn();
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 2_000 });
    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, { message: "Which board?", questions: [], proposals: [] });
    const said = openAssist(handle.db).conversation.messages;
    await send("The release one.", chat.id);
    // A copied @name asks nobody anything in the fork.
    postComment(handle.db, { itemId: chat.id as Uuid, author: { type: "human" }, body: "@user can you check the release board?", parseBodyMentions: true });

    const forked = forkAssistConversation(handle.db, { conversationId: chat.id, messageId: said.at(-1)!.id });
    const withName = forkAssistConversation(handle.db, { conversationId: chat.id, messageId: listCommentsForItem(handle.db, chat.id as Uuid).at(-1)!.id });
    for (const message of withName.conversation.messages) expect(listMentionsForComment(handle.db, message.id as Uuid)).toEqual([]);
    resumeAssist(handle.db, { conversationId: forked.conversation.id });

    expect(forked.problem).toBeNull();
    expect(forked.conversation.id).not.toBe(chat.id);
    expect(forked.conversation.messages.map((message) => [message.authorType, message.body])).toEqual([
      ["engine", `Forked from ${rowOf(chat.id).key}.`],
      ["human", "Rework the release pipeline."],
      ["agent", "Which board?"],
    ]);
    // Nothing in it asks for a turn.
    for (const message of forked.conversation.messages) {
      expect(listMentionsForComment(handle.db, message.id as Uuid)).toEqual([]);
    }
    // It is the chat on show, and the original still has everything.
    expect(openAssist(handle.db).conversation.id).toBe(forked.conversation.id);
    expect(listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body)).toEqual(["Rework the release pipeline.", "Which board?", "The release one.", "@user can you check the release board?"]);
  });

  it("says so when the message is not in the conversation", async () => {
    const chat = (await send("hello")).conversation;
    const forked = forkAssistConversation(handle.db, { conversationId: chat.id, messageId: "nope" });
    expect(forked.problem).toBe("That message is not in this conversation any more.");
    expect(forked.conversation.id).toBe(chat.id);
  });
});

describe("what each chat is doing, for the rail", () => {
  it("is working while a turn runs, waiting while a question is the person's, and idle otherwise", async () => {
    const { chat, run } = await chatWithARunningTurn();
    const stateOf = (id: string) => listAssist(handle.db).conversations.find((entry) => entry.id === id)?.state;
    expect(stateOf(chat.id)).toBe("working");

    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 2_000 });
    postAssistReply(handle.db, rowOf(chat.id), assistAgent(handle.db)!.id, run.id, {
      message: "Which board?",
      questions: [{ id: "board", question: "Which board?", why: "Both have a release step.", options: ["Release", "Hotfix"] }],
      proposals: [],
    } as never);
    expect(stateOf(chat.id)).toBe("waiting");

    const other = newAssist(handle.db).conversation;
    expect(stateOf(other.id)).toBe("idle");
  });
});

describe("a long chat, a page at a time", () => {
  it("carries the newest hundred messages, says how many more there are, and reads them back a page at a time", async () => {
    const chat = (await send("Message 0")).conversation;
    for (let index = 1; index < 130; index++) {
      postComment(handle.db, { itemId: chat.id as Uuid, author: { type: "human" }, body: `Message ${index}`, createdAt: Date.now() + index });
    }
    const view = openAssist(handle.db).conversation;
    expect(view.messages).toHaveLength(100);
    expect(view.messages[0]?.body).toBe("Message 30");
    expect(view.earlier).toBe(30);

    const page = readEarlierAssist(handle.db, { conversationId: chat.id, before: view.messages[0]!.id, limit: 20 });
    expect(page.messages.map((message) => message.body)).toEqual(Array.from({ length: 20 }, (_, index) => `Message ${index + 10}`));
    expect(page.earlier).toBe(10);
    const last = readEarlierAssist(handle.db, { conversationId: chat.id, before: page.messages[0]!.id, limit: 20 });
    expect(last.messages).toHaveLength(10);
    expect(last.earlier).toBe(0);
  });

  it("answers an empty page before a message the thread does not hold", async () => {
    const chat = (await send("Only message")).conversation;
    expect(readEarlierAssist(handle.db, { conversationId: chat.id, before: "gone", limit: 20 })).toEqual({ messages: [], earlier: 0 });
  });

  it("folds a turn once, on the page its first reply is on", async () => {
    const { chat, run } = await chatWithARunningTurn();
    appendRunEvent(handle.db, run.id, "tool_call", { type: "tool_call", name: "Read", args: { file_path: "a.ts" }, callId: "c1" });
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: 3_000 });
    const first = postComment(handle.db, { itemId: chat.id as Uuid, runId: run.id, author: { type: "agent", agentId: assistAgent(handle.db)!.id }, body: "Part one.", createdAt: Date.now() + 1 });
    const second = postComment(handle.db, { itemId: chat.id as Uuid, runId: run.id, author: { type: "agent", agentId: assistAgent(handle.db)!.id }, body: "Part two.", createdAt: Date.now() + 2 });
    // A page holding only the second reply has no fold on it.
    const page = readEarlierAssist(handle.db, { conversationId: chat.id, before: "nope", limit: 1 });
    expect(page.messages).toEqual([]);
    const tail = openAssist(handle.db).conversation.messages;
    expect(tail.find((message) => message.id === first.id)?.turn).toMatchObject({ runId: run.id });
    expect(tail.find((message) => message.id === second.id)?.turn ?? null).toBeNull();
  });

  it("refuses an item that is not the assistant's", () => {
    const story = createTestItem(handle.db, { type: "story", title: "Somebody's story", stepId: "todo" });
    expect(() => readEarlierAssist(handle.db, { conversationId: story.id, before: "x", limit: 10 })).toThrow("That is not an assist conversation.");
  });
});

describe("taking back a queued message", () => {
  it("withdraws the request to the assistant and keeps the message, and refuses the one being answered", async () => {
    const { chat, asked } = await chatWithARunningTurn();
    const queued = (await send("And the hotfix board.", chat.id)).conversation.messages.at(-1)!;
    expect(queued.status).toBe("queued");

    expect(withdrawAssistMessage(handle.db, { conversationId: chat.id, messageId: asked.id }).withdrawn).toBe(false);
    const result = withdrawAssistMessage(handle.db, { conversationId: chat.id, messageId: queued.id });
    expect(result.withdrawn).toBe(true);
    expect(result.conversation.messages.at(-2)).toMatchObject({ body: "And the hotfix board.", status: null });
    expect(result.conversation.messages.at(-1)).toMatchObject({ authorType: "engine", body: "Taken back before the assistant read it.", parentId: queued.id });
    expect(withdrawAssistMessage(handle.db, { conversationId: chat.id, messageId: queued.id }).withdrawn).toBe(false);
  });
});
