import type { BrowserWindow } from "electron";
import type { DiscussionMessage, DiscussionView, IpcPushPayload, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, DbHandle } from "../db/client.js";
import { deleteComment, postComment } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { CHANGE_PUSH_WINDOW_MS } from "../changeAnnouncers.js";
import { createEngine } from "../engine.js";
import { webContentsTransport } from "../platform/webContentsTransport.js";
import { assistAgent } from "../roles/assist.js";
import { assistDeltaView, openAssist, updateAssistSettings } from "./assistCommands.js";
import { ASSIST_DELTA_SNAPSHOTS, assistDeltaSeq, nextAssistDelta, watchAssistDeltas } from "./assistDeltas.js";
import { HISTORY_PAGE } from "./conversationView.js";
import { bridgePushChannels, emitPush, onPush } from "./push.js";

/**
 * An assistant chat's changes leaving the main process as numbered
 * deltas (EO-553).
 *
 * Through the real chain: `postComment` → the engine's per-item
 * coalescer → `items:changed` → the watcher → `assist:delta` → a window's
 * `webContents`, which is the Electron IPC half of delivery. The served
 * half is `server/pushStream.test.ts`; what the room does with a delta is
 * `renderer/src/shared/assist/assistDeltas.test.tsx`.
 */
let handle: DbHandle;
let stops: (() => void)[];
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handle = openMigratedTestDb();
  // The engine is what turns a posted comment into `items:changed`.
  createEngine({ db: handle.db, eoMcpServerPath: "/unused", worktreeRoot: "/unused" });
  send = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send } };
  stops = [watchAssistDeltas(handle.db, (id) => assistDeltaView(handle.db, id)), bridgePushChannels(webContentsTransport(window as unknown as BrowserWindow))];
});

afterEach(() => {
  stops.forEach((stop) => stop());
  handle.close();
});

function deltas(): IpcPushPayload<"assist:delta">[] {
  return send.mock.calls.filter(([channel]) => channel === "push:assist:delta").map(([, payload]) => payload as IpcPushPayload<"assist:delta">);
}

/** Past the coalescer's window, so the next comment is a leading edge of its own. */
const windowCloses = () => new Promise((resolve) => setTimeout(resolve, CHANGE_PUSH_WINDOW_MS * 2 + 20));

function say(chat: string, body: string, extra: Partial<Parameters<typeof postComment>[1]> = {}) {
  return postComment(handle.db, { itemId: chat as Uuid, author: { type: "agent", agentId: assistAgent(handle.db)!.id }, body, ...extra });
}

describe("a comment in an assistant chat", () => {
  it("arrives as the next delta after the view a window was served, carrying the message", () => {
    const served = openAssist(handle.db).conversation;
    expect(served.deltaSeq).toBe(0);

    const said = say(served.id, "The Apollo board has two items waiting.");

    expect(deltas()).toEqual([
      {
        conversationId: served.id,
        seq: 1,
        messages: [expect.objectContaining({ id: said.id, body: "The Apollo board has two items waiting." })],
        messageIds: [said.id],
        earlier: 0,
        resync: false,
      },
    ]);
    // And a view served now includes it, and says so.
    expect(openAssist(handle.db).conversation.deltaSeq).toBe(1);
  });

  it("carries only what changed — the new message, and any older one it changed", async () => {
    const chat = openAssist(handle.db).conversation.id;
    const question = say(chat, "Which board?", { kind: "question" });
    expect(deltas()[0]?.messages).toEqual([expect.objectContaining({ id: question.id, canAnswer: true })]);
    await windowCloses();

    // Answering the question changes the question too: it is no longer live.
    const answer = postComment(handle.db, { itemId: chat as Uuid, author: { type: "human" }, body: "Apollo.", parentId: question.id });

    const second = deltas()[1];
    expect(second?.seq).toBe(2);
    expect(second?.messages.map((message) => [message.id, message.canAnswer])).toEqual([
      [question.id, false],
      [answer.id, false],
    ]);
  });

  it("folds a burst into fewer deltas, numbered without a gap, that between them carry every message", async () => {
    const chat = openAssist(handle.db).conversation.id;

    const said = ["One.", "Two.", "Three.", "Four.", "Five."].map((body) => say(chat, body).id);
    await windowCloses();

    const sent = deltas();
    expect(sent.length).toBeLessThan(said.length);
    expect(sent.map((delta) => delta.seq)).toEqual(sent.map((_, index) => index + 1));
    expect(new Set(sent.flatMap((delta) => delta.messages.map((message) => message.id)))).toEqual(new Set(said));
  });

  it("says a message left the thread by no longer naming it", async () => {
    const chat = openAssist(handle.db).conversation.id;
    const kept = say(chat, "Looking.");
    const said = say(chat, "Filed.");
    await windowCloses();
    const seq = deltas().at(-1)!.seq;

    deleteComment(handle.db, said.id);

    expect(deltas().at(-1)).toEqual({ conversationId: chat, seq: seq + 1, messages: [], messageIds: [kept.id], earlier: 0, resync: false });
  });

  it("says so when a chat longer than its newest stretch loses a message older than it", async () => {
    const chat = openAssist(handle.db).conversation.id;
    // One more than the view carries, so the first is outside it.
    const said: string[] = [];
    for (let index = 0; index <= HISTORY_PAGE; index += 1) said.push(say(chat, `Note ${String(index)}.`, { createdAt: 1_000 + index }).id);
    await windowCloses();
    const grown = deltas().at(-1)!;
    expect(grown.earlier).toBe(1);
    expect(grown.messageIds).toEqual(said.slice(1));

    deleteComment(handle.db, said[0]! as Uuid);

    expect(deltas().at(-1)).toEqual({ conversationId: chat, seq: grown.seq + 1, messages: [], messageIds: said.slice(1), earlier: 0, resync: false });
  });
});

describe("a window that read the chat between two deltas", () => {
  it("is not left holding a message that went before the sweep", async () => {
    const chat = openAssist(handle.db).conversation.id;
    const kept = say(chat, "Looking.");
    expect(deltas().map((delta) => delta.seq)).toEqual([1]);

    // Inside the coalescer's window: posted, not yet sent.
    const temporary = say(chat, "On second thoughts…");
    expect(deltas()).toHaveLength(1);
    // A window reads the chat now, and so holds it.
    const served = openAssist(handle.db).conversation;
    expect(served.messages.map((message) => message.id)).toEqual([kept.id, temporary.id]);
    // Its number is a delta of its own, sent to every older window.
    expect(served.deltaSeq).toBe(2);
    expect(deltas().at(-1)).toMatchObject({ seq: 2, messageIds: [kept.id, temporary.id] });

    // Gone again before the sweep.
    deleteComment(handle.db, temporary.id);
    await windowCloses();

    // The sweep finds the change against what that window holds.
    expect(deltas().at(-1)).toEqual({ conversationId: chat, seq: 3, messages: [], messageIds: [kept.id], earlier: 0, resync: false });
  });
});

describe("what sends no delta", () => {
  it("a chat no view has been served for, and an item that is not a chat", () => {
    const chat = openAssist(handle.db).conversation.id;
    const story = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "todo" });

    postComment(handle.db, { itemId: story.id, author: { type: "human" }, body: "Cap it at 100." });
    emitPush("items:changed", { itemId: "019fb8c6-de92-7a41-9c33-4471f0c2b1ff" });

    expect(deltas()).toEqual([]);
    expect(chat).toBeTruthy();
  });

  it("an `items:changed` for the chat when nothing a delta carries moved, which spends no number", () => {
    const chat = openAssist(handle.db).conversation.id;

    emitPush("items:changed", { itemId: chat });
    expect(deltas()).toEqual([]);

    say(chat, "Done.");
    expect(deltas().map((delta) => delta.seq)).toEqual([1]);
  });
});

describe("a change a list of messages cannot carry", () => {
  it("is sent as a resync: the chat's settings changed", () => {
    const chat = openAssist(handle.db).conversation.id;

    updateAssistSettings(handle.db, { conversationId: chat, showReasoning: false });
    // What the `assist:settings` handler pushes after the write.
    emitPush("items:changed", { itemId: chat });

    expect(deltas()).toEqual([{ conversationId: chat, seq: 1, messages: [], messageIds: [], earlier: 0, resync: true }]);
  });
});

/** The diff on its own, against views written by hand. */
describe("working a delta out", () => {
  const db = {} as Db;
  const CHAT = "019fb8c6-de92-7a41-9c33-4471f0c2b1aa";

  /** The deltas sent from here on, through the push contract. */
  function listen(): () => IpcPushPayload<"assist:delta">[] {
    const heard: IpcPushPayload<"assist:delta">[] = [];
    stops.push(onPush("assist:delta", (payload) => void heard.push(payload)));
    return () => heard;
  }

  function message(index: number, body = `Message ${String(index)}`): DiscussionMessage {
    return {
      id: `m-${String(index)}`,
      authorType: "agent",
      authorName: "Assistant",
      body,
      attachments: [],
      kind: "note",
      parentId: null,
      runId: null,
      options: null,
      canAnswer: false,
      createdAt: index,
      canApprove: false,
      approves: null,
      moduleSlug: null,
      proposedType: null,
      status: null,
    };
  }

  function view(indexes: number[], earlier = 0, id = CHAT): DiscussionView {
    return {
      id,
      key: "ASK-1",
      startedAt: 0,
      closedAt: null,
      thinking: false,
      thinkingSince: null,
      liveOutput: "",
      liveActivity: [],
      settings: { agentId: "a", agentName: "Assistant", provider: "claude", model: null, defaultModel: null, reasoningEffort: null, defaultReasoningEffort: null },
      messages: indexes.map((index) => message(index)),
      earlier,
    } as DiscussionView;
  }

  it("carries the new message and the stretch it slid along, when the oldest slides out", () => {
    assistDeltaSeq(db, view([1, 2, 3]));

    const delta = nextAssistDelta(db, view([2, 3, 4], 1));

    expect(delta).toEqual({ conversationId: CHAT, seq: 1, messages: [message(4)], messageIds: ["m-2", "m-3", "m-4"], earlier: 1, resync: false });
  });

  it("is not nothing when only a message older than the stretch left", () => {
    // The stretch is the same three; the one before them is gone.
    const other = "019fb8c6-de92-7a41-9c33-4471f0c2b1ad";
    assistDeltaSeq(db, view([2, 3, 4], 1, other));

    expect(nextAssistDelta(db, view([2, 3, 4], 0, other))).toEqual({ conversationId: other, seq: 1, messages: [], messageIds: ["m-2", "m-3", "m-4"], earlier: 0, resync: false });
  });

  it("places a message that lands between two the window has, by the order it names", () => {
    const other = "019fb8c6-de92-7a41-9c33-4471f0c2b1ab";
    assistDeltaSeq(db, view([1, 3], 0, other));

    expect(nextAssistDelta(db, view([1, 2, 3], 0, other))).toEqual({ conversationId: other, seq: 1, messages: [message(2)], messageIds: ["m-1", "m-2", "m-3"], earlier: 0, resync: false });
  });

  it("keeps a chat's number when its snapshot is let go, and resyncs on the next view it serves", () => {
    const first = "019fb8c6-de92-7a41-9c33-4471f0c2b1ac";
    const fresh = {} as Db;
    assistDeltaSeq(fresh, view([1], 0, first));
    expect(nextAssistDelta(fresh, view([1, 2], 0, first))?.seq).toBe(1);
    // Enough other chats served to push the first one's snapshot out.
    for (let index = 0; index < ASSIST_DELTA_SNAPSHOTS; index += 1) assistDeltaSeq(fresh, view([1], 0, `chat-${String(index)}`));
    const heard = listen();

    // A view served now is not numbered from 0: what it holds against the
    // number it would carry is not known, so the windows are told to read
    // again, and it carries that resync's number.
    expect(assistDeltaSeq(fresh, view([1, 2], 0, first))).toBe(2);
    expect(heard()).toEqual([expect.objectContaining({ conversationId: first, seq: 2, resync: true })]);
    // And from there it is held again.
    expect(nextAssistDelta(fresh, view([1, 2, 3], 0, first))).toEqual({
      conversationId: first,
      seq: 3,
      messages: [message(3)],
      messageIds: ["m-1", "m-2", "m-3"],
      earlier: 0,
      resync: false,
    });
  });

  it("numbers a view served between deltas as a delta of its own, so a change undone before the sweep is still sent", () => {
    // The race: a window reads the chat with a message in it that the
    // coalescer has not sent yet, and the message is gone again before
    // the sweep. Numbered as the last delta, that window would hold a
    // state no delta describes, and the sweep would find nothing changed.
    const chat = "019fb8c6-de92-7a41-9c33-4471f0c2b1ae";
    const fresh = {} as Db;
    expect(assistDeltaSeq(fresh, view([1], 0, chat))).toBe(0);
    const heard = listen();

    const served = assistDeltaSeq(fresh, view([1, 2], 0, chat));

    expect(served).toBe(1);
    expect(heard()).toEqual([{ conversationId: chat, seq: 1, messages: [message(2)], messageIds: ["m-1", "m-2"], earlier: 0, resync: false }]);
    expect(nextAssistDelta(fresh, view([1], 0, chat))).toEqual({ conversationId: chat, seq: 2, messages: [], messageIds: ["m-1"], earlier: 0, resync: false });
  });

  it("serves a view holding nothing past the last delta under that delta's number, and sends nothing", () => {
    const chat = "019fb8c6-de92-7a41-9c33-4471f0c2b1af";
    const fresh = {} as Db;
    assistDeltaSeq(fresh, view([1], 0, chat));
    nextAssistDelta(fresh, view([1, 2], 0, chat));
    const heard = listen();

    expect(assistDeltaSeq(fresh, view([1, 2], 0, chat))).toBe(1);
    expect(heard()).toEqual([]);
  });
});
