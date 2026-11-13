import { activeProjectId } from "./repositoryCommands.js";
import {
  ADMIN_MCP_SERVER_NAME,
  CHAT_HOME_ROUTE,
  AssistOutputSchema,
  DEFAULT_PIPELINE_ID,
  HUMAN_MESSAGE_EVENT,
  pageDescriptorFor,
  type AgentEvent,
  type AgentInputAttachment,
  type AssistOutput,
  type AssistReply,
  type InterruptibleStream,
  type IpcChannel,
  type PipelineDraft,
  type Item,
  type Uuid,
  ProposalDetailSchema,
  ProposalSummarySchema,
  proposedItemPath,
  specFields,
} from "@eo/core";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { markReplica } from "../db/recordRole.js";
import { sectionLockFor } from "../managed/locks.js";
import { items, modules as modulesTable, pipelines } from "../db/schema.js";
import {
  appendRunEvent,
  createPipeline,
  getActionDefinition,
  listActionDefinitions,
  publishSection,
  createProject,
  createRun,
  deleteItem,
  dismissOpenMentionsForComment,
  getItem,
  getItemByKey,
  listDependencies,
  listItemsForProject,
  listAttachmentsForItem,
  listCommentsForItem,
  listMentionsForComment,
  listRoutesForPipeline,
  listRunEvents,
  listRunsForItem,
  postComment,
  listStepsForPipeline,
  approveModule,
  deleteModuleTest,
  listModules,
  listProjects,
  clearSetting,
  listModuleTests,
  getModule,
  currentVersion,
  moduleTestFingerprint,
  getModuleVersion,
  listModuleVersions,
  listPipelines,
  replacePipelineGraph,
  saveModule,
  archiveModule,
  saveModuleTest,
  setItemArchived,
  setSetting,
  setProjectArchived,
  updateRun,
  getPipeline,
  versionSnapshot,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { PREVIEW_PROJECT_KEY } from "../gallery/commands.js";
import { PIPELINE_NEEDS_PROJECT } from "./pipelineHome.js";
import { ACTIVE_PROJECT_KEY } from "./repositoryCommands.js";
import { DEFAULT_ASSIST_EXPIRY_DAYS, assistAgent, assistBoards, assistDraftForPublish, shownAssistConversation, postAssistReply } from "../roles/assist.js";
import { ASSIST_ACTION, ASSIST_STEP } from "../roles/conversationSteps.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createItemLock } from "../supervisor/itemLock.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import { createRunSupervisor, type SteerResult } from "../supervisor/runSupervisor.js";
import { SKIPPED_ANSWER } from "../roles/discussion.js";
import { PROPOSAL_KIND } from "../roles/proposal.js";
import {
  answerAssistQuestions,
  approveAssistProposal,
  clearAssist,
  listAssist,
  newAssist,
  openAssist,
  approveAndPublishAssistDraft,
  publishNewAssistPipeline,
  readAssistDraftForPublish,
  readAssistProposal,
  reorderAssist,
  removeAssist,
  removeManyAssist,
  resumeAssist,
  sendToAssist,
} from "./assistCommands.js";
import { DEFAULT_GUARD_CONFIG, GUARDS_KEY, savePipeline } from "./configCommands.js";
import type { ModuleTestRunAnswer, ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { clearPublishedView, publishView, readCurrentView } from "./currentView.js";
import { renderCurrentView } from "../mcpHost/render.js";
import { STEER_REPLY_WITHIN_MS, type EngineHandle } from "./domainCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { clearHandlerRegistry, dispatchIpc, registerHandler } from "./registry.js";
import { resolveItemType } from "../db/repos/itemTypesRepo.js";
import { updateItemTypeCommand } from "./itemTypeCommands.js";

/**
 * One thread, and a page that names one thing (EO-192, EO-193).
 *
 * The descriptor still arrives on both channels, and what it is for is
 * now a single question: which board a graph raised here would be
 * published against. It stopped naming the room with EO-193 — there is
 * one thread, resumed wherever the widget is opened — and it stopped
 * framing the turn with EO-192, which is proved here too: nothing about
 * the page is rendered into a prompt. Where the person is *now* is
 * `view:current`'s answer, read live — see `currentView.test.ts`, which
 * is where "move this to Review acts on the right item" is proved end
 * to end.
 */
let handle: DbHandle;

const opts = { exposeErrorDetails: true };

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  clearHandlerRegistry();
  // Module state, like the registry next door: a case that published a
  // view would otherwise decide the board of a later case's message.
  clearPublishedView();
  handle.close();
});

function page(path: string) {
  return pageDescriptorFor(path);
}

function send(path: string, body: string, conversationId: string | null = null, attachmentIds: string[] = [], storage?: AttachmentStorage) {
  return sendToAssist(handle.db, undefined, { page: page(path), conversationId, body, attachmentIds, interrupt: false }, storage);
}

/** The conversation behind a view, as a row. */
function rowOf(id: string): Item {
  return getItem(handle.db, id as Uuid)!;
}

/**
 * The thread, as it stands after somebody has spoken in it from `path`.
 *
 * Opening carries no page any more (EO-193) — one thread, and opening
 * decides nothing about where anybody is — so the way a conversation
 * comes to know which board a question was asked from is the way a
 * person does it: by asking there. Which is also the only way a turn
 * ever starts.
 */
async function openedOn(path: string): Promise<Item> {
  return rowOf((await send(path, "what is here?")).conversation.id);
}

/** The newest thing a person said here — the comment the mention path would dispatch on. */
function newestQuestion(conversation: Item): Uuid {
  return listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)!.id;
}

/** The board pinned to the newest question asked here. */
function boardOfNewestQuestion(conversation: Item): string | null {
  const asked = newestQuestion(conversation);
  return assistBoards(rowOf(conversation.id)).find((board) => board.from === asked)?.pipelineId ?? null;
}

describe("opening the room", () => {
  it("is one thread, and opening it takes no page at all", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    // Three screens, three questions asked from them, and one thread —
    // which is the whole of EO-193. The page used to decide which
    // conversation you were in (EO-188); now nothing does, because there
    // is only one.
    const onAItem = (await send(`/items/${item.id}`, "what is left here?")).conversation;
    const onSettings = (await send("/settings", "and how long may a run take?")).conversation;
    const opened = openAssist(handle.db).conversation;

    expect(onSettings.id).toBe(onAItem.id);
    expect(opened.id).toBe(onAItem.id);
    expect(rowOf(opened.id).stepId).toBe(ASSIST_STEP);
  });

  /**
   * The one thing the descriptor still says, and it is an identifier
   * rather than an account of a screen: a draft names no pipeline of its
   * own, so without this a graph proposed on a board could not be
   * published against it. Pinned to the message, so each question keeps
   * the board it was asked from.
   */
  it("pins the board to the message, and pins Settings as no board at all", async () => {
    const onABoard = rowOf((await send("/project", "add a QA step")).conversation.id);
    expect(boardOfNewestQuestion(onABoard)).toBe(DEFAULT_PIPELINE_ID);

    const later = rowOf((await send("/settings", "never mind", onABoard.id)).conversation.id);
    expect(boardOfNewestQuestion(later)).toBeNull();
    // Two questions, two boards. The second does not rub out the first.
    expect(assistBoards(later).map((board) => board.pipelineId)).toEqual([DEFAULT_PIPELINE_ID, null]);
  });

  it("pins the pipeline the Graph view names, and nothing to the configure address it replaced", async () => {
    // The Graph view's address is the board's with `?view=graph`, and
    // the query is no part of the page a message is sent from — so a
    // graph drafted over it is publishable against that pipeline.
    const graph = rowOf((await send(`/pipelines/${DEFAULT_PIPELINE_ID}`, "add a QA step after Implement")).conversation.id);
    expect(boardOfNewestQuestion(graph)).toBe(DEFAULT_PIPELINE_ID);
    // The editor's address is no screen any more (EO-525): the chat
    // layout replaces it with the Graph view's before it publishes, so
    // nothing names it, and a message arriving from it anyway names no
    // board rather than one EO would be guessing at.
    const editing = rowOf((await send(`/pipelines/${DEFAULT_PIPELINE_ID}/configure`, "and another", graph.id)).conversation.id);
    expect(boardOfNewestQuestion(editing)).toBeNull();
  });

  /** A pipeline this installation does not have is no board at all (invariant #5). */
  it("does not believe a board that is not there", async () => {
    const view = rowOf((await send("/pipelines/not-a-pipeline", "what is this?")).conversation.id);

    expect(boardOfNewestQuestion(view)).toBeNull();
  });

  /**
   * The chat layout's home is not a screen about anything (EO-383).
   *
   * With the canvas popped out, the conversation is sent from `/chat`,
   * which names no board. Left there, a graph proposed from it would
   * have had nothing to publish against, which is the one job the
   * descriptor still has. The board is in the canvas's own window — the
   * one publishing while it is out — and the main process already holds
   * what it published.
   *
   * Read here rather than sent from there, deliberately. The
   * conversation's window has no way of knowing what the other window is
   * showing, and invariant #5 says EO checks a fact it holds itself
   * rather than taking a renderer's word for it.
   */
  it("pins the board in the popped-out canvas to a message sent from the chat layout's home", async () => {
    publishView({ page: page("/project"), filter: null, selection: [], sort: null, unsavedEdits: [] });

    const fromTheChat = rowOf((await send(CHAT_HOME_ROUTE, "add a QA step")).conversation.id);

    expect(boardOfNewestQuestion(fromTheChat)).toBe(DEFAULT_PIPELINE_ID);
  });

  /** With the canvas *not* out, the home publishes itself, and that is no board. */
  it("pins no board to a message from the chat layout's home with nothing beside it", async () => {
    publishView({ page: page(CHAT_HOME_ROUTE), filter: null, selection: [], sort: null, unsavedEdits: [] });

    const fromTheChat = rowOf((await send(CHAT_HOME_ROUTE, "what is this?")).conversation.id);

    expect(boardOfNewestQuestion(fromTheChat)).toBeNull();
  });

  it("pins no board when the popped-out canvas is on a screen that is not one", async () => {
    publishView({ page: page("/settings"), filter: null, selection: [], sort: null, unsavedEdits: [] });

    const fromTheChat = rowOf((await send(CHAT_HOME_ROUTE, "what is this?")).conversation.id);

    expect(boardOfNewestQuestion(fromTheChat)).toBeNull();
  });

  /**
   * And no board at all when nothing has published — a desktop whose
   * window is closed, or a browser, which never publishes. "No
   * board" is the same answer every other non-board screen gives, rather
   * than a stale one from whenever a window last spoke.
   */
  it("pins no board when no window has said what it is showing", async () => {
    clearPublishedView();

    const fromTheChat = rowOf((await send(CHAT_HOME_ROUTE, "anybody there?")).conversation.id);

    expect(boardOfNewestQuestion(fromTheChat)).toBeNull();
  });
});

describe("clearing the thread", () => {
  it("archives what was said, leaves an empty thread, and needs nothing to be told which", async () => {
    const started = (await send("/settings", "what is this?")).conversation;

    const cleared = clearAssist(handle.db, undefined);

    expect(cleared.conversation.id).not.toBe(started.id);
    expect(cleared.conversation.messages).toEqual([]);
    // Archived rather than deleted (invariant #3), and still readable.
    expect(rowOf(started.id).archivedAt).not.toBeNull();
    // What was asked and never answered is said to be, rather than left open (invariant #8).
    expect(listCommentsForItem(handle.db, started.id as Uuid).map((comment) => comment.body)).toEqual([
      "what is this?",
      "Not answered: the thread was cleared before a turn started.",
    ]);
    // And the next message continues the empty one rather than the
    // archived one.
    expect((await send("/settings", "starting again")).conversation.id).toBe(cleared.conversation.id);
  });

  it("ends a turn nobody is going to read, and says so in the thread it archived", async () => {
    const started = (await send("/settings", "what is this?")).conversation;
    const run = createRun(handle.db, {
      itemId: started.id as Uuid,
      agentId: assistAgent(handle.db)!.id,
      action: ASSIST_ACTION,
      initiationId: listCommentsForItem(handle.db, started.id as Uuid)[0]!.id,
    });
    const cancelled: string[] = [];

    clearAssist(handle.db, { cancelRun: (id: string) => cancelled.push(id), notifyStateChange: () => undefined } as never);

    expect(cancelled).toEqual([run.id]);
    // Invariant #8: nothing is dropped silently, and the archived thread
    // is where somebody reads back what happened to that turn.
    expect(listCommentsForItem(handle.db, started.id as Uuid).map((comment) => comment.body)).toContain(
      "Turn stopped: the thread was cleared.",
    );
  });

  it("leaves an empty thread alone rather than burning a key on a second one", () => {
    const empty = openAssist(handle.db).conversation;

    const cleared = clearAssist(handle.db, undefined);

    expect(cleared.conversation.id).toBe(empty.id);
    expect(rowOf(empty.id).archivedAt).toBeNull();
  });
});

describe("going back to an earlier thread", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const start = new Date("2026-08-01T09:00:00Z").getTime();

  beforeEach(() => {
    // The clock is moved rather than slept through, so "newest first" and
    // the expiry are about the times the test says.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Two threads: one put away by Clear, and the live one after it. */
  async function twoThreads() {
    const first = (await send("/settings", "  \nWhy is the weekly report late?\nIt was due Monday.")).conversation;
    vi.setSystemTime(start + 60_000);
    clearAssist(handle.db, undefined);
    vi.setSystemTime(start + 120_000);
    const second = (await send("/settings", "What is waiting on me?")).conversation;
    return { first, second };
  }

  it("lists the open thread and then those somebody said something in, newest first, each titled by its first line", async () => {
    const { first, second } = await twoThreads();
    // The empty thread a Clear leaves is the chat that is open: listed, under the room's own name.
    vi.setSystemTime(start + 180_000);
    const empty = clearAssist(handle.db, undefined).conversation;

    const { conversations } = listAssist(handle.db);
    expect(conversations.map((thread) => [thread.id, thread.title, thread.live, thread.shown])).toEqual([
      [empty.id, "Assistant", true, true],
      [second.id, "What is waiting on me?", false, false],
      [first.id, "Why is the weekly report late?", false, false],
    ]);
    // The note the second Clear wrote into it is the last thing that moved there.
    expect(conversations[1]!.lastActivityAt).toBe(start + 180_000);

    // Going back to one puts nothing away (EO-391): the empty chat is
    // still open, so it is still a row. Put away without a word in it, it
    // is not a conversation anybody had.
    resumeAssist(handle.db, { conversationId: first.id });
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toContain(empty.id);
    setItemArchived(handle.db, empty.id as Uuid, start + 190_000);
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).not.toContain(empty.id);
  });

  it("marks the live thread, and cuts a long first line", async () => {
    await send("/settings", "x".repeat(200));
    const [thread] = listAssist(handle.db).conversations;
    expect(thread!.live).toBe(true);
    expect(thread!.title).toHaveLength(80);
    expect(thread!.title.endsWith("…")).toBe(true);
  });

  it("makes the chosen one live and shows it, archiving no other chat and deleting nothing", async () => {
    const { first, second } = await twoThreads();
    vi.setSystemTime(start + 240_000);

    const resumed = resumeAssist(handle.db, { conversationId: first.id });

    expect(resumed.problem).toBeNull();
    expect(resumed.conversation.id).toBe(first.id);
    expect(rowOf(first.id).archivedAt).toBeNull();
    // The chat that was on show is left exactly as it was: live, and
    // with its unanswered message still waiting for its turn.
    expect(rowOf(second.id).archivedAt).toBeNull();
    expect(listCommentsForItem(handle.db, second.id as Uuid).map((comment) => comment.body)).toEqual(["What is waiting on me?"]);
    expect(findPendingResponses(handle.db, [second.id as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
    // Still one room: every surface that opens it opens this one, and the
    // next message continues it.
    expect(openAssist(handle.db).conversation.id).toBe(first.id);
    vi.setSystemTime(start + 300_000);
    expect((await send("/settings", "and now?")).conversation.id).toBe(first.id);
    // Both live, said of each on its own, and one of them on show. The
    // one gone back to joined below the one already open (EO-438), and
    // being shown and spoken in since has not moved it.
    expect(listAssist(handle.db).conversations.map((thread) => [thread.id, thread.live, thread.shown])).toEqual([
      [second.id, true, false],
      [first.id, true, true],
    ]);
  });

  /** EO-438: the order is the person's, written through `assist:reorder` and answered by `assist:list`. */
  it("moves an open chat where it is dragged, answers with the list as stored, and refuses one that is put away", async () => {
    const { first, second } = await twoThreads();
    vi.setSystemTime(start + 180_000);
    const third = newAssist(handle.db).conversation;
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([third.id, second.id, first.id]);

    const moved = reorderAssist(handle.db, { conversationId: third.id, index: 1 });

    expect(moved.problem).toBeNull();
    expect(moved.conversations).toEqual(listAssist(handle.db).conversations);
    expect(moved.conversations.map((thread) => [thread.id, thread.live])).toEqual([
      [second.id, true],
      [third.id, true],
      [first.id, false],
    ]);

    // Speaking in the one at the bottom, and showing it, leaves it at the bottom.
    vi.setSystemTime(start + 240_000);
    await send("/settings", "And one more thing.", third.id);
    resumeAssist(handle.db, { conversationId: third.id });
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([second.id, third.id, first.id]);

    const refused = reorderAssist(handle.db, { conversationId: first.id, index: 0 });
    expect(refused.problem).toBe("That chat is not open any more, so it was not moved.");
    expect(refused.conversations).toEqual(listAssist(handle.db).conversations);
    expect(rowOf(first.id).archivedAt).not.toBeNull();
  });

  it("counts going back as the thread's last word, so the expiry does not put it straight away again", async () => {
    const { first } = await twoThreads();
    vi.setSystemTime(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 3) * DAY);

    resumeAssist(handle.db, { conversationId: first.id });

    expect(openAssist(handle.db).conversation.id).toBe(first.id);
    expect(rowOf(first.id).archivedAt).toBeNull();
  });

  it("switches between two live chats and back, stopping and dismissing nothing in either", async () => {
    const { first, second } = await twoThreads();
    resumeAssist(handle.db, { conversationId: first.id });
    vi.setSystemTime(start + 180_000);
    await send("/settings", "and the one before it?", first.id);
    const agentId = assistAgent(handle.db)!.id;
    const runs = [first, second].map((chat) =>
      createRun(handle.db, { itemId: chat.id as Uuid, agentId, action: ASSIST_ACTION, status: "running", initiationId: newestQuestion(rowOf(chat.id)) }),
    );
    const before = [first, second].map((chat) => listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body));

    expect(resumeAssist(handle.db, { conversationId: second.id })).toMatchObject({ problem: null, conversation: { id: second.id } });
    expect(openAssist(handle.db).conversation.id).toBe(second.id);
    expect(resumeAssist(handle.db, { conversationId: first.id })).toMatchObject({ problem: null, conversation: { id: first.id } });
    expect(openAssist(handle.db).conversation.id).toBe(first.id);

    expect([first, second].map((chat) => rowOf(chat.id).archivedAt)).toEqual([null, null]);
    // No engine is handed to this at all, so nothing could have been
    // cancelled; and no sentence was written into either chat.
    expect(runs.map((run) => listRunsForItem(handle.db, run.itemId).find((row) => row.id === run.id)?.status)).toEqual(["running", "running"]);
    expect([first, second].map((chat) => listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body))).toEqual(before);
    for (const chat of [first, second]) {
      expect(listCommentsForItem(handle.db, chat.id as Uuid).map((comment) => comment.body).join("\n")).not.toMatch(/another conversation was opened/);
    }
  });

  it("does the same for Clear", async () => {
    const started = (await send("/settings", "what is blocked?")).conversation;
    clearAssist(handle.db, undefined);
    expect(listCommentsForItem(handle.db, started.id as Uuid).map((comment) => comment.body)).toContain(
      "Not answered: the thread was cleared before a turn started.",
    );
    expect(findPendingResponses(handle.db, [started.id as Uuid])).toEqual([]);
  });

  it("neither lists nor goes back to a thread on an archived project, where nothing would answer", async () => {
    const project = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const shelved = (await send("/settings", "Why is the queue so long?")).conversation;
    vi.setSystemTime(start + 60_000);
    clearAssist(handle.db, undefined);
    setProjectArchived(handle.db, project.id, start + 90_000);

    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).not.toContain(shelved.id);
    const refused = resumeAssist(handle.db, { conversationId: shelved.id });
    expect(refused.problem).toBe("That conversation is on Support, which is archived. Restore the project to go back to it.");
    expect(rowOf(shelved.id).archivedAt).not.toBeNull();
  });

  it("titles a thread that began with only a file by saying so", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo assist title "));
    try {
      const source = join(directory, "screen.png");
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const storage = new AttachmentStorage(join(directory, "managed"));
      const [draft] = await storage.stagePaths([source]);
      await send("/settings", "", null, [draft!.id], storage);
      expect(listAssist(handle.db).conversations.map((thread) => thread.title)).toEqual(["Attachments"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("goes back to a thread when none is live", async () => {
    const { first, second } = await twoThreads();
    // Put away by some other path, leaving no thread live.
    setItemArchived(handle.db, second.id as Uuid, start + 150_000);
    vi.setSystemTime(start + 200_000);

    expect(resumeAssist(handle.db, { conversationId: first.id })).toMatchObject({ problem: null, conversation: { id: first.id } });
    expect(listAssist(handle.db).conversations.filter((thread) => thread.live).map((thread) => thread.id)).toEqual([first.id]);
    expect(rowOf(second.id).archivedAt).toBe(start + 150_000);
  });

  it("changes nothing for the live thread, and refuses anything that is not an assistant thread", async () => {
    const { second } = await twoThreads();
    expect(resumeAssist(handle.db, { conversationId: second.id })).toMatchObject({ problem: null, conversation: { id: second.id } });

    const story = createTestItem(handle.db, { type: "story", title: "Somebody's story", stepId: "todo" });
    const refused = resumeAssist(handle.db, { conversationId: story.id });
    expect(refused.problem).toBe("That is not one of your conversations with the assistant.");
    expect(refused.conversation.id).toBe(second.id);
    expect(rowOf(second.id).archivedAt).toBeNull();
  });
});

/**
 * Several live chats (EO-391).
 *
 * There was one live thread from EO-193 until here, and starting or going
 * back to another put the current one away — stopping a turn still
 * running in it. Starting and switching are navigation now, and only
 * Clear, of the chat on show, puts anything away.
 */
describe("several live chats", () => {
  /** A chat with a turn running in it, on show. */
  async function chatWithARunningTurn(body = "Rework the release pipeline.") {
    const chat = (await send("/settings", body)).conversation;
    const run = createRun(handle.db, {
      itemId: chat.id as Uuid,
      agentId: assistAgent(handle.db)!.id,
      action: ASSIST_ACTION,
      status: "running",
      initiationId: newestQuestion(rowOf(chat.id)),
    });
    return { chat, run };
  }

  /** An engine that records what it was asked to cancel. */
  function engine(cancelled: string[]) {
    return { cancelRun: (id: string) => cancelled.push(id), notifyStateChange: () => undefined } as never;
  }

  function bodies(id: string) {
    return listCommentsForItem(handle.db, id as Uuid).map((comment) => comment.body);
  }

  it("starts a new chat beside one with a turn running, leaving that chat live and its turn alone", async () => {
    const { chat: a, run } = await chatWithARunningTurn();

    const b = newAssist(handle.db).conversation;

    expect(b.id).not.toBe(a.id);
    expect(b.messages).toEqual([]);
    expect(rowOf(a.id).archivedAt).toBeNull();
    expect(rowOf(b.id).archivedAt).toBeNull();
    expect(listRunsForItem(handle.db, a.id as Uuid).map((row) => [row.id, row.status])).toEqual([[run.id, "running"]]);
    // Nothing was said in A about being left: there is nothing to say.
    expect(bodies(a.id)).toEqual(["Rework the release pipeline."]);

    // The turn runs to its end and answers in A, with B on show.
    updateRun(handle.db, run.id, { status: "succeeded" });
    postAssistReply(handle.db, rowOf(a.id), assistAgent(handle.db)!.id, run.id, { message: "Done: three steps.", questions: [], proposals: [] });
    expect(bodies(a.id)).toEqual(["Rework the release pipeline.", "Done: three steps."]);
    expect(bodies(b.id)).toEqual([]);
    expect(openAssist(handle.db).conversation.id).toBe(b.id);
  });

  it("shows the new chat on every surface, and sends a message with no chat named to it", async () => {
    const { chat: a } = await chatWithARunningTurn();
    const b = newAssist(handle.db).conversation;

    expect(openAssist(handle.db).conversation.id).toBe(b.id);
    expect((await send("/settings", "What does Hold do?")).conversation.id).toBe(b.id);
    // And one named is sent where it says, on show or not.
    expect((await send("/settings", "one more thing", a.id)).conversation.id).toBe(a.id);
    expect(openAssist(handle.db).conversation.id).toBe(b.id);
  });

  it("gives each chat its own turn, dispatched on its own item", async () => {
    const { chat: a } = await chatWithARunningTurn();
    const b = newAssist(handle.db).conversation;
    await send("/settings", "What does Hold do?", b.id);

    // A's turn is running, so its item offers nothing; B's message is a
    // turn of its own, on B, and is not held behind A's.
    expect(findPendingResponses(handle.db, [a.id as Uuid, b.id as Uuid]).map((pending) => [pending.itemId, pending.action])).toEqual([
      [b.id, ASSIST_ACTION],
    ]);
  });

  it("does not make a second empty chat when the one on show is already empty, or another open one is", async () => {
    const empty = openAssist(handle.db).conversation;
    expect(newAssist(handle.db).conversation.id).toBe(empty.id);

    const said = (await send("/settings", "What is waiting on me?")).conversation;
    const fresh = newAssist(handle.db).conversation;
    resumeAssist(handle.db, { conversationId: said.id });
    // New chat again, from the one that has words in it: the empty one is shown.
    expect(newAssist(handle.db).conversation.id).toBe(fresh.id);
    expect(listAssist(handle.db).conversations.filter((thread) => thread.live)).toHaveLength(2);
  });

  it("clears only the chat on show, leaving another live chat and the turn running in it untouched", async () => {
    const { chat: a, run } = await chatWithARunningTurn();
    const b = newAssist(handle.db).conversation;
    await send("/settings", "What does Hold do?", b.id);
    const cancelled: string[] = [];

    const cleared = clearAssist(handle.db, engine(cancelled));

    expect(rowOf(b.id).archivedAt).not.toBeNull();
    expect(cleared.conversation.id).not.toBe(b.id);
    expect(cleared.conversation.messages).toEqual([]);
    // A: still live, still running, nothing written into it.
    expect(cancelled).toEqual([]);
    expect(rowOf(a.id).archivedAt).toBeNull();
    expect(listRunsForItem(handle.db, a.id as Uuid).map((row) => [row.id, row.status])).toEqual([[run.id, "running"]]);
    expect(bodies(a.id)).toEqual(["Rework the release pipeline."]);
    expect(listAssist(handle.db).conversations.map((thread) => [thread.id, thread.live, thread.shown])).toEqual(
      expect.arrayContaining([
        [a.id, true, false],
        [b.id, false, false],
        [cleared.conversation.id, true, true],
      ]),
    );
  });

  it("stops the turn in the chat it clears, and no other", async () => {
    const { chat: a, run: runA } = await chatWithARunningTurn();
    newAssist(handle.db);
    const { chat: b, run: runB } = await chatWithARunningTurn("Why is the queue so long?");
    expect(b.id).not.toBe(a.id);
    const cancelled: string[] = [];

    clearAssist(handle.db, engine(cancelled));

    expect(cancelled).toEqual([runB.id]);
    expect(cancelled).not.toContain(runA.id);
    expect(bodies(b.id)).toContain("Turn stopped: the thread was cleared.");
    expect(bodies(a.id)).toEqual(["Rework the release pipeline."]);
  });

  it("goes back to an archived chat without archiving any live one", async () => {
    const archived = (await send("/settings", "Why is the weekly report late?")).conversation;
    clearAssist(handle.db, undefined);
    const { chat: a, run } = await chatWithARunningTurn();
    const b = newAssist(handle.db).conversation;
    await send("/settings", "What does Hold do?", b.id);

    expect(resumeAssist(handle.db, { conversationId: archived.id })).toMatchObject({ problem: null, conversation: { id: archived.id } });

    expect([archived, a, b].map((chat) => rowOf(chat.id).archivedAt)).toEqual([null, null, null]);
    expect(listRunsForItem(handle.db, a.id as Uuid).map((row) => [row.id, row.status])).toEqual([[run.id, "running"]]);
    expect(listAssist(handle.db).conversations.filter((thread) => thread.shown).map((thread) => thread.id)).toEqual([archived.id]);
    expect(listAssist(handle.db).conversations.filter((thread) => thread.live).map((thread) => thread.id).sort()).toEqual([archived.id, a.id, b.id].sort());
  });

  it("removes a live chat that is not on show without changing what is", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eo assist several "));
    try {
      const storage = new AttachmentStorage(join(directory, "managed"));
      const a = (await send("/settings", "Why is the weekly report late?")).conversation;
      const b = newAssist(handle.db).conversation;

      expect(await removeAssist(handle.db, undefined, { conversationId: a.id }, storage)).toEqual({ removed: true, conversation: null });
      expect(openAssist(handle.db).conversation.id).toBe(b.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /**
   * A chat on an archived project takes a message and never answers it:
   * nothing there is dispatched (EO-347). The list hides it and going
   * back to it is refused, so nothing that picks a chat on the person's
   * behalf may pick it either.
   */
  describe("an empty chat left on a project that was then archived", () => {
    /** An empty chat on a project since archived, and a chat with words in it on the project now active, on show. */
    async function strandedBesideActive() {
      const shelvedProject = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
      const stranded = openAssist(handle.db).conversation;
      expect(rowOf(stranded.id).projectId).toBe(shelvedProject.id);
      const active = createProject(handle.db, { name: "Platform", keyPrefix: "PLT" });
      setProjectArchived(handle.db, shelvedProject.id, Date.now());
      const said = (await send("/settings", "Rework the release pipeline.")).conversation;
      expect(said.id).not.toBe(stranded.id);
      expect(rowOf(said.id).projectId).toBe(active.id);
      return { stranded, said, active };
    }

    /** The chat is one the supervisor would answer in: sent to, it offers a turn. */
    async function expectAnswerable(conversationId: string, projectId: string) {
      expect(rowOf(conversationId).projectId).toBe(projectId);
      expect(listAssist(handle.db).conversations.filter((thread) => thread.shown).map((thread) => thread.id)).toEqual([conversationId]);
      await send("/settings", "What does Hold do?", conversationId);
      expect(findPendingResponses(handle.db, [conversationId as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
    }

    it("is not what the room opens on", async () => {
      const { stranded, said } = await strandedBesideActive();
      expect(openAssist(handle.db).conversation.id).toBe(said.id);
      // Not put away: restoring the project brings it back as it was.
      expect(rowOf(stranded.id).archivedAt).toBeNull();
    });

    it("is not what New chat shows: a new one is started on the active project", async () => {
      const { stranded, active } = await strandedBesideActive();

      const started = newAssist(handle.db).conversation;

      expect(started.id).not.toBe(stranded.id);
      expect(started.messages).toEqual([]);
      await expectAnswerable(started.id, active.id);
    });

    it("is not what Clear leaves: a new one is started on the active project", async () => {
      const { stranded, said, active } = await strandedBesideActive();

      const cleared = clearAssist(handle.db, undefined).conversation;

      expect(rowOf(said.id).archivedAt).not.toBeNull();
      expect(cleared.id).not.toBe(stranded.id);
      expect(cleared.messages).toEqual([]);
      await expectAnswerable(cleared.id, active.id);
    });

    it("is not what removing the chat on show leaves", async () => {
      const { stranded, said, active } = await strandedBesideActive();
      const directory = mkdtempSync(join(tmpdir(), "eo assist stranded "));
      try {
        const removed = await removeAssist(handle.db, undefined, { conversationId: said.id }, new AttachmentStorage(join(directory, "managed")));
        expect(removed).toMatchObject({ removed: true, conversation: { messages: [] } });
        const left = (removed as { conversation: { id: string } }).conversation;
        expect(left.id).not.toBe(stranded.id);
        await expectAnswerable(left.id, active.id);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("is not swept for being idle, since it is not one of the chats there are", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { stranded } = await strandedBesideActive();
        vi.setSystemTime(Date.now() + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000);
        openAssist(handle.db);
        expect(rowOf(stranded.id).archivedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not reuse an empty chat left on another project, which is not the chat being asked for", async () => {
    const first = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const elsewhere = openAssist(handle.db).conversation;
    expect(rowOf(elsewhere.id).projectId).toBe(first.id);
    const second = createProject(handle.db, { name: "Platform", keyPrefix: "PLT" });
    setSetting(handle.db, "ui.activeProjectId", second.id);
    const said = (await send("/settings", "Rework the release pipeline.", elsewhere.id)).conversation;
    const empty = newAssist(handle.db).conversation;
    expect(rowOf(empty.id).projectId).toBe(second.id);
    setSetting(handle.db, "ui.activeProjectId", first.id);
    resumeAssist(handle.db, { conversationId: said.id });

    const started = newAssist(handle.db).conversation;

    expect(started.id).not.toBe(empty.id);
    expect(rowOf(started.id).projectId).toBe(first.id);
  });

  /**
   * Each project has its own chat on show (EO-765), so an empty chat
   * left on show on a project the person has since left is not the one
   * the room shows on the project they are on — and is never a new chat
   * for it: a draft raised in it would be checked against the other
   * project's pipelines.
   */
  describe("an empty chat on show from another active project", () => {
    /** An empty chat opened on P and on show there, with Q now the active project. Both projects live. */
    function emptyOnPWhileOnQ() {
      const p = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
      const onP = openAssist(handle.db).conversation;
      expect(rowOf(onP.id).projectId).toBe(p.id);
      const q = createProject(handle.db, { name: "Platform", keyPrefix: "PLT" });
      setSetting(handle.db, "ui.activeProjectId", q.id);
      // Switching project switches chat: Q's room is Q's own.
      const opened = openAssist(handle.db).conversation;
      expect(opened.id).not.toBe(onP.id);
      expect(rowOf(opened.id).projectId).toBe(q.id);
      return { p, q, onP };
    }

    it("is not what New chat answers with: a chat for the active project is shown", async () => {
      const { q, onP } = emptyOnPWhileOnQ();

      const started = newAssist(handle.db).conversation;

      expect(started.id).not.toBe(onP.id);
      expect(started.messages).toEqual([]);
      expect(rowOf(started.id).projectId).toBe(q.id);
      expect(openAssist(handle.db).conversation.id).toBe(started.id);
      // The one left behind is left as any chat is: live, not put away.
      expect(rowOf(onP.id).archivedAt).toBeNull();
      // And pressed again on Q, the empty Q chat is what there is — not a third.
      expect(newAssist(handle.db).conversation.id).toBe(started.id);
      // Q's list is Q's chats alone.
      expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([started.id]);
    });

    it("is not what Clear leaves: a chat for the active project is shown, and nothing is archived", async () => {
      const { q, onP } = emptyOnPWhileOnQ();
      const cancelled: string[] = [];

      const cleared = clearAssist(handle.db, engine(cancelled)).conversation;

      expect(cleared.id).not.toBe(onP.id);
      expect(cleared.messages).toEqual([]);
      expect(rowOf(cleared.id).projectId).toBe(q.id);
      expect(openAssist(handle.db).conversation.id).toBe(cleared.id);
      // An empty chat is still not archived by Clear, and nothing was stopped.
      expect(rowOf(onP.id).archivedAt).toBeNull();
      expect(cancelled).toEqual([]);
      expect(bodies(onP.id)).toEqual([]);
    });

    it("goes back to the empty chat that is already there when the person returns to its project", async () => {
      const { p, onP } = emptyOnPWhileOnQ();
      const onQ = newAssist(handle.db).conversation;
      setSetting(handle.db, "ui.activeProjectId", p.id);

      expect(newAssist(handle.db).conversation.id).toBe(onP.id);
      expect(clearAssist(handle.db, undefined).conversation.id).toBe(onP.id);
      expect(rowOf(onQ.id).archivedAt).toBeNull();
    });

    it("still answers New chat and Clear with the empty chat on show when it is on the active project", () => {
      const p = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
      const onP = openAssist(handle.db).conversation;
      expect(rowOf(onP.id).projectId).toBe(p.id);

      expect(newAssist(handle.db).conversation.id).toBe(onP.id);
      expect(clearAssist(handle.db, undefined).conversation.id).toBe(onP.id);
    });
  });

  /**
   * The list is drawn from a cache in every window, and opening answers
   * only with the chat on show. So an idle chat that is *not* on show is
   * archived by an opening that hands back the same conversation as
   * before — and nothing but a push tells the rail and the switcher that
   * the chat they are calling open has been put away.
   */
  describe("a chat that goes idle while another is on show", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const start = new Date("2026-08-01T09:00:00Z").getTime();

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** An idle chat off screen, and the one on show spoken in since. */
    async function idleBesideShown() {
      const idle = (await send("/settings", "Why is the weekly report late?")).conversation;
      const shown = newAssist(handle.db).conversation;
      await send("/settings", "Rework the release pipeline.", shown.id);
      vi.setSystemTime(start + (DEFAULT_ASSIST_EXPIRY_DAYS - 1) * DAY);
      await send("/settings", "And add a QA step.", shown.id);
      vi.setSystemTime(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY);
      return { idle, shown };
    }

    it("announces the opening that archived it, though the chat it answers with has not changed", async () => {
      const { idle, shown } = await idleBesideShown();
      // What a window drew before the opening: both of them open.
      expect(listAssist(handle.db).conversations.map((thread) => [thread.id, thread.live])).toEqual(
        expect.arrayContaining([
          [idle.id, true],
          [shown.id, true],
        ]),
      );
      const announce = vi.fn();

      const opened = openAssist(handle.db, announce);

      expect(opened.conversation.id).toBe(shown.id);
      expect(rowOf(shown.id).archivedAt).toBeNull();
      expect(rowOf(idle.id).archivedAt).not.toBeNull();
      expect(announce).toHaveBeenCalledTimes(1);
      // And the list a window fetches on that push says so.
      expect(listAssist(handle.db).conversations.map((thread) => [thread.id, thread.live, thread.shown])).toEqual([
        [shown.id, true, true],
        [idle.id, false, false],
      ]);

      // The opening that push causes writes nothing, so it announces nothing: no loop.
      openAssist(handle.db, announce);
      expect(announce).toHaveBeenCalledTimes(1);
    });

    it("announces it when a message sent to no chat in particular is what opened the room", async () => {
      const { idle, shown } = await idleBesideShown();
      const announce = vi.fn();

      const sent = await sendToAssist(
        handle.db,
        undefined,
        { page: page("/settings"), conversationId: null, body: "one more thing", attachmentIds: [], interrupt: false },
        undefined,
        announce,
      );

      expect(sent.conversation.id).toBe(shown.id);
      expect(rowOf(idle.id).archivedAt).not.toBeNull();
      expect(announce).toHaveBeenCalledTimes(1);
    });

    it("announces nothing for an opening that archived nothing", async () => {
      await send("/settings", "Why is the weekly report late?");
      newAssist(handle.db);
      const announce = vi.fn();

      openAssist(handle.db, announce);

      expect(announce).not.toHaveBeenCalled();
    });

    it("announces the opening that started a chat, where there was none or the one on show went idle", async () => {
      const announce = vi.fn();
      const first = openAssist(handle.db, announce).conversation;
      expect(announce).toHaveBeenCalledTimes(1);
      await send("/settings", "Why is the weekly report late?", first.id);

      vi.setSystemTime(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY);
      const fresh = openAssist(handle.db, announce).conversation;

      expect(fresh.id).not.toBe(first.id);
      expect(announce).toHaveBeenCalledTimes(2);
    });
  });

  it("goes through the channels the renderer calls", async () => {
    registerHandler("assist:new", () => newAssist(handle.db), opts);
    registerHandler("assist:list", () => listAssist(handle.db), opts);
    const a = (await send("/settings", "Why is the weekly report late?")).conversation;

    const started = await dispatchIpc("assist:new", undefined);
    expect(started).toMatchObject({ ok: true, data: { conversation: { messages: [] } } });
    const listed = await dispatchIpc("assist:list", undefined);
    expect(listed).toMatchObject({ ok: true });
    const rows = (listed as { data: { conversations: { id: string; live: boolean; shown: boolean }[] } }).data.conversations;
    expect(rows.map((thread) => [thread.id === a.id, thread.live, thread.shown]).sort()).toEqual([
      [false, true, true],
      [true, true, false],
    ]);
  });
});

describe("removing a chat for good", () => {
  let directory: string;
  let storage: AttachmentStorage;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo assist remove "));
    storage = new AttachmentStorage(join(directory, "managed"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** An earlier chat carrying a file and a finished run, and the open chat after it. */
  async function earlierAndOpen() {
    const source = join(directory, "brief.txt");
    writeFileSync(source, "what the report should say");
    const [draft] = await storage.stagePaths([source]);
    const earlier = (await send("/settings", "Why is the weekly report late?", null, [draft!.id], storage)).conversation;
    const run = createRun(handle.db, { itemId: earlier.id as Uuid, agentId: assistAgent(handle.db)!.id, action: ASSIST_ACTION });
    appendRunEvent(handle.db, run.id, "output", { type: "output", text: "Looking" });
    updateRun(handle.db, run.id, { status: "succeeded" });
    clearAssist(handle.db, undefined);
    const open = (await send("/settings", "What is waiting on me?")).conversation;
    return { earlier, open, run };
  }

  it("deletes an earlier chat with its comments, runs, events and attachment files, and leaves the open one alone", async () => {
    const { earlier, open, run } = await earlierAndOpen();
    const managedPath = listAttachmentsForItem(handle.db, earlier.id as Uuid)[0]!.path;
    expect(existsSync(managedPath)).toBe(true);

    const result = await removeAssist(handle.db, undefined, { conversationId: earlier.id }, storage);

    expect(result).toEqual({ removed: true, conversation: null });
    expect(getItem(handle.db, earlier.id as Uuid)).toBeUndefined();
    expect(listCommentsForItem(handle.db, earlier.id as Uuid)).toEqual([]);
    expect(listRunsForItem(handle.db, earlier.id as Uuid)).toEqual([]);
    expect(listRunEvents(handle.db, run.id)).toEqual([]);
    expect(listAttachmentsForItem(handle.db, earlier.id as Uuid)).toEqual([]);
    expect(existsSync(managedPath)).toBe(false);
    expect(listAssist(handle.db).conversations.map((thread) => [thread.id, thread.live])).toEqual([[open.id, true]]);
    expect(openAssist(handle.db).conversation).toMatchObject({ id: open.id, messages: [{ body: "What is waiting on me?" }] });
  });

  it("removes the open chat, cancelling its turn, and leaves the room on one new empty thread", async () => {
    const { earlier, open } = await earlierAndOpen();
    const running = createRun(handle.db, {
      itemId: open.id as Uuid,
      agentId: assistAgent(handle.db)!.id,
      action: ASSIST_ACTION,
      status: "running",
      initiationId: newestQuestion(rowOf(open.id)),
    });
    const cancelled: [string, string | undefined][] = [];
    const engine = { cancelRun: (id: string, reason?: string) => cancelled.push([id, reason]), notifyStateChange: () => undefined } as never;

    const result = await removeAssist(handle.db, engine, { conversationId: open.id }, storage);

    expect(cancelled).toEqual([[running.id, "superseded"]]);
    expect(getItem(handle.db, open.id as Uuid)).toBeUndefined();
    expect(listRunsForItem(handle.db, open.id as Uuid)).toEqual([]);
    // Nothing left for the mention path to dispatch on.
    expect(findPendingResponses(handle.db, [open.id as Uuid])).toEqual([]);

    // One live thread, new and empty: what New chat leaves.
    const fresh = openAssist(handle.db).conversation;
    expect(result).toMatchObject({ removed: true, conversation: { id: fresh.id } });
    expect(fresh.id).not.toBe(open.id);
    expect(fresh.messages).toEqual([]);
    expect(shownAssistConversation(handle.db, activeProjectId(handle.db))?.id).toBe(fresh.id);
    // Exactly one live entry in the list, the new empty one, and the chat removed is not in it.
    const listed = listAssist(handle.db).conversations;
    expect(listed.filter((thread) => thread.live).map((thread) => [thread.id, thread.title])).toEqual([[fresh.id, "Assistant"]]);
    expect(listed.filter((thread) => !thread.live).map((thread) => thread.id)).toEqual([earlier.id]);

    // An empty open chat is removed the same way, and leaves the same thing.
    const again = await removeAssist(handle.db, engine, { conversationId: fresh.id }, storage);
    const next = openAssist(handle.db).conversation;
    expect(again).toMatchObject({ removed: true, conversation: { id: next.id, messages: [] } });
    expect(getItem(handle.db, fresh.id as Uuid)).toBeUndefined();
    expect(listAssist(handle.db).conversations.filter((thread) => thread.live).map((thread) => thread.id)).toEqual([next.id]);
  });

  it("refuses an id that is not an assistant thread, deleting nothing", async () => {
    const { earlier, open } = await earlierAndOpen();
    const story = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });

    expect(await removeAssist(handle.db, undefined, { conversationId: story.id }, storage)).toEqual({
      removed: false,
      problem: expect.stringMatching(/not one of your conversations with the assistant/),
    });

    expect(getItem(handle.db, story.id)).toBeDefined();
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([open.id, earlier.id]);
  });

  it("refuses a chat that is already gone, through the channel, with the reason in the response", async () => {
    const { earlier, open } = await earlierAndOpen();
    registerHandler("assist:remove", (payload) => removeAssist(handle.db, undefined, payload, storage), opts);
    const remove = () => dispatchIpc("assist:remove", { conversationId: earlier.id });

    expect(await remove()).toEqual({ ok: true, data: { removed: true, conversation: null } });
    expect(await remove()).toMatchObject({ ok: true, data: { removed: false, problem: expect.stringMatching(/already have been removed/) } });
    expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([open.id]);
  });

  /** EO-442: the rail's selection, removed in one call. */
  describe("several at once", () => {
    /** Two earlier chats, then two open ones: `other`, and `shown` on show after it. */
    async function four() {
      const { earlier: first, open: second } = await earlierAndOpen();
      clearAssist(handle.db, undefined);
      const other = (await send("/settings", "Which pipeline is slowest?")).conversation;
      newAssist(handle.db);
      const shown = (await send("/settings", "Summarise today")).conversation;
      expect(shownAssistConversation(handle.db, activeProjectId(handle.db))?.id).toBe(shown.id);
      return { first, second, other, shown };
    }

    it("removes every chat named, earlier and open, with what each owns, through the channel", async () => {
      const { first, second, other, shown } = await four();
      const managedPath = listAttachmentsForItem(handle.db, first.id as Uuid)[0]!.path;
      registerHandler("assist:removeMany", (payload) => removeManyAssist(handle.db, undefined, payload, storage), opts);

      const result = await dispatchIpc("assist:removeMany", { conversationIds: [first.id, second.id, other.id] });

      expect(result).toEqual({ ok: true, data: { removed: [first.id, second.id, other.id], refused: [], conversation: null } });
      for (const gone of [first, second, other]) {
        expect(getItem(handle.db, gone.id as Uuid)).toBeUndefined();
        expect(listCommentsForItem(handle.db, gone.id as Uuid)).toEqual([]);
        expect(listRunsForItem(handle.db, gone.id as Uuid)).toEqual([]);
      }
      expect(existsSync(managedPath)).toBe(false);
      // The chat on show was not among them, so the room is as it was.
      expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([shown.id]);
      expect(openAssist(handle.db).conversation.id).toBe(shown.id);
    });

    it("refuses what is not an assistant chat, or is gone, on its own, and still removes the rest", async () => {
      const { first, second, other, shown } = await four();
      const story = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
      await removeAssist(handle.db, undefined, { conversationId: second.id }, storage);

      const result = await removeManyAssist(handle.db, undefined, { conversationIds: [first.id, story.id, second.id, other.id] }, storage);

      expect(result).toEqual({
        removed: [first.id, other.id],
        refused: [
          { conversationId: story.id, problem: expect.stringMatching(/not one of your conversations with the assistant/) },
          { conversationId: second.id, problem: expect.stringMatching(/already have been removed/) },
        ],
        conversation: null,
      });
      expect(getItem(handle.db, story.id)).toBeDefined();
      expect(listAssist(handle.db).conversations.map((thread) => thread.id)).toEqual([shown.id]);
    });

    it("leaves exactly one new empty chat when the chat on show is among those removed", async () => {
      const { first, second, other, shown } = await four();

      const result = await removeManyAssist(handle.db, undefined, { conversationIds: [shown.id, other.id, first.id, second.id] }, storage);

      const fresh = openAssist(handle.db).conversation;
      expect(result).toMatchObject({ removed: [shown.id, other.id, first.id, second.id], refused: [], conversation: { id: fresh.id, messages: [] } });
      expect(shownAssistConversation(handle.db, activeProjectId(handle.db))?.id).toBe(fresh.id);
      const listed = listAssist(handle.db).conversations;
      expect(listed.map((thread) => [thread.id, thread.live, thread.title])).toEqual([[fresh.id, true, "Assistant"]]);
      expect(listItemsForProject(handle.db, rowOf(fresh.id).projectId).filter((item) => item.stepId === ASSIST_STEP).map((item) => item.id)).toEqual([fresh.id]);
    });

    it("cancels the turn running in a chat it removes, and only that one", async () => {
      const { other, shown } = await four();
      const running = createRun(handle.db, {
        itemId: other.id as Uuid,
        agentId: assistAgent(handle.db)!.id,
        action: ASSIST_ACTION,
        status: "running",
        initiationId: newestQuestion(rowOf(other.id)),
      });
      const cancelled: [string, string | undefined][] = [];
      const engine = { cancelRun: (id: string, reason?: string) => cancelled.push([id, reason]), notifyStateChange: () => undefined } as never;

      const result = await removeManyAssist(handle.db, engine, { conversationIds: [other.id, other.id] }, storage);

      expect(result).toEqual({ removed: [other.id], refused: [], conversation: null });
      expect(cancelled).toEqual([[running.id, "superseded"]]);
      expect(listRunsForItem(handle.db, other.id as Uuid)).toEqual([]);
      expect(findPendingResponses(handle.db, [other.id as Uuid])).toEqual([]);
      expect(openAssist(handle.db).conversation.id).toBe(shown.id);
    });
  });
});

describe("saying something from a page", () => {
  it("posts the person's own words and nothing else, and mentions the agent so the turn runs", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    const view = (await send(`/items/${item.id}`, "move this to Review")).conversation;
    const comments = listCommentsForItem(handle.db, view.id as Uuid);

    expect(comments.map((comment) => comment.body)).toEqual(["move this to Review"]);
    expect(findPendingResponses(handle.db, [view.id as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
  });

  /**
   * What EO-192 removed, asserted as removed.
   *
   * The turn is dispatched with no description of the page at all — not
   * in the prompt, where the section used to be, and not on the
   * conversation, where the descriptor used to be written so the section
   * could be built. What the prompt carries instead is the name of the
   * tool that reads the screen live.
   */
  it("preloads nothing about the page, and points at the tool instead", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const view = (await send(`/items/${item.id}`, "what is left here?")).conversation;

    const context = await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION);
    expect(context).not.toContain("## The page");
    expect(context).toContain("## The screen");
    // Named by tool and by the server it answers on, rather than in one
    // backend's spelling of the id (EO-203).
    expect(context).toContain("`view_current`");
    expect(context).toContain("`eo_admin`");
    // Nothing describing the item was pasted in: the key appears only
    // where the person's own words are.
    expect(context.slice(0, context.indexOf("## Comments"))).not.toContain(item.key);

    // And no description of the page was recorded on the conversation for
    // a section to be built from later. A page held on a row is a page
    // that can be read back after it stopped being true, which is the
    // whole defect. What the row *may* hold is the board a draft would be
    // published against — an identifier, not an account of a screen — and
    // an item's page is not a board, so there is not even that.
    expect(rowOf(view.id).spec?.["assist"] ?? {}).not.toHaveProperty("page");
    expect(boardOfNewestQuestion(rowOf(view.id))).toBeNull();

    for (const comment of listCommentsForItem(handle.db, view.id as Uuid)) {
      // Nothing about the page is attributable to anyone: the only
      // comment on this thread is the one the person typed.
      expect(comment.authorType).toBe("human");
    }
  });

  it("keeps one thread across a walk, whether or not the conversation is named", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    const started = (await send(`/items/${item.id}`, "what is this?")).conversation;
    // Same thread — the panel does not close when you navigate — asked
    // from somewhere else.
    const moved = (await send("/settings", "and how long may a run take?", started.id)).conversation;
    // And the same thread again with nothing named at all, which is what
    // EO-193 changed: this used to open a second room keyed on Settings.
    const unnamed = (await send("/settings", "one more thing", null)).conversation;

    expect(moved.id).toBe(started.id);
    expect(unnamed.id).toBe(started.id);
    // What the walk changed is the board the *newest* question was asked
    // from: Settings is not one, so there is none.
    expect(boardOfNewestQuestion(rowOf(moved.id))).toBeNull();
  });

  /** The board is carried by every message, so a graph proposed after a walk publishes where it was asked. */
  it("records the board each message was sent from, in the order they were sent", async () => {
    const started = (await send("/settings", "what is this?")).conversation;

    await send("/project", "add a QA step after Review", started.id);

    expect(boardOfNewestQuestion(rowOf(started.id))).toBe(DEFAULT_PIPELINE_ID);
    expect(assistBoards(rowOf(started.id)).map((board) => board.pipelineId)).toEqual([null, DEFAULT_PIPELINE_ID]);
  });

  it("refuses an empty message and a conversation that does not exist, leaving no thread behind", async () => {
    await expect(send("/settings", "   ")).rejects.toThrow(/needs text/);
    await expect(send("/settings", "hello", "019fb8c6-de92-7a41-9c33-4471f0c2b1de")).rejects.toThrow(/does not exist/);
    expect(shownAssistConversation(handle.db, activeProjectId(handle.db))).toBeUndefined();
  });

  it("refuses to graft a help thread onto a piece of work", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    await expect(send(`/items/${item.id}`, "move this to Review", item.id)).rejects.toThrow(/not an assist conversation/);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(getItem(handle.db, item.id)?.spec?.["assist"]).toBeUndefined();
  });
});

/**
 * Files, on the last chat surface in EO that could not take one (EO-194).
 *
 * Nothing about attachments is built here: the panel stages bytes through
 * `attachments:*` exactly as the item page and Discussions do, and what
 * reaches this channel is a list of ids. What these cases are about is
 * the three-step commit — promote, post, clear — and the half of it that
 * only ever runs when something has gone wrong.
 */
describe("sending a file with the message", () => {
  let directory: string;
  let source: string;
  let storage: AttachmentStorage;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo assist attachment "));
    source = join(directory, "screen.png");
    // A PNG by its magic bytes, so the sniffer calls it an image without
    // being told: the panel sends a name and bytes, never a MIME type.
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    storage = new AttachmentStorage(join(directory, "managed"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const managed = () => readdirSync(join(directory, "managed", "files"));
  const staged = () => readdirSync(join(directory, "managed", "staging"));

  it("posts one comment carrying the file, and hands the next turn what it needs to read it", async () => {
    const [draft] = await storage.stagePaths([source]);

    const view = (await send("/settings", "what is wrong here?", null, [draft!.id], storage)).conversation;

    // One message with a file on it, not a message and a message about a
    // file: the mention that dispatches the turn is on the comment the
    // attachment belongs to.
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.attachments).toEqual([
      expect.objectContaining({ id: draft!.id, kind: "image", name: "screen.png", mimeType: "image/png", size: 8 }),
    ]);
    // Committed and cleaned up: the bytes are managed and the staging
    // area is empty, which is `finish` having run.
    expect(managed()).toHaveLength(1);
    expect(staged()).toEqual([]);

    // And the turn is told what it holds and which tool reads it. This is
    // the shared rendering in `packages/engine/src/context.ts` — the
    // assist room needed nothing of its own for the agent side, which is
    // the point.
    const context = await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION);
    expect(context).toContain(`ID: ${draft!.id}; name: screen.png; MIME type: image/png`);
    expect(context).toContain("attachment_read");
  });

  /** A screenshot with nothing typed under it is a message. */
  it("takes a file with no words, and still refuses a message that is empty of both", async () => {
    const [draft] = await storage.stagePaths([source]);

    const view = (await send("/settings", "   ", null, [draft!.id], storage)).conversation;
    expect(view.messages[0]?.attachments).toHaveLength(1);

    await expect(send("/settings", "   ", view.id)).rejects.toThrow(/needs text or an attachment/);
  });

  /**
   * The rollback, which is the only reason the commit has three steps.
   *
   * `prepare` copies the bytes into managed storage before the comment
   * exists, so a post that fails after it would leave a file on disk no
   * row points at — invisible, and never collected. The thread is deleted
   * inside `prepare` here because that is precisely the window the guard
   * is about: the foreign key refuses the comment, and what has to happen
   * next is the copy going away and the staged original staying, so the
   * person can send it again.
   */
  it("puts the bytes back when the comment does not land", async () => {
    const conversation = await openedOn("/settings");
    const [draft] = await storage.stagePaths([source]);

    const promote = storage.prepare.bind(storage);
    vi.spyOn(storage, "prepare").mockImplementation(async (ids) => {
      const prepared = await promote(ids);
      deleteItem(handle.db, conversation.id);
      return prepared;
    });

    await expect(send("/settings", "look at this", conversation.id, [draft!.id], storage)).rejects.toThrow();

    expect(managed()).toEqual([]);
    expect(staged()).toContain(`${draft!.id}.bin`);
  });

  /** The storage's cap, refused at the boundary rather than after eight files have been copied. */
  it("refuses more than eight at the boundary", async () => {
    const tooMany = await handleIpcRequest(
      "assist:send",
      {
        page: page("/settings"),
        conversationId: null,
        body: "all of these",
        attachmentIds: Array.from({ length: 9 }, (_, index) => `019fb8c6-de92-7a41-9c33-4471f0c2b1${String(index).padStart(2, "0")}`),
      },
      (payload) => sendToAssist(handle.db, undefined, payload, storage),
      opts,
    );

    expect(tooMany.ok).toBe(false);
    // And nothing was created for a message that was never accepted.
    expect(shownAssistConversation(handle.db, activeProjectId(handle.db))).toBeUndefined();
  });

  /** Ids with no storage behind them are a refusal, not a silently text-only message. */
  it("refuses a file it has nowhere to put", async () => {
    await expect(send("/settings", "look at this", null, ["019fb8c6-de92-7a41-9c33-4471f0c2b1de"])).rejects.toThrow(
      /Attachment storage is unavailable/,
    );
    expect(shownAssistConversation(handle.db, activeProjectId(handle.db))).toBeUndefined();
  });
});

/**
 * A message sent while the assistant is working (EO-395).
 *
 * Asked for on ASK-21: somebody sent a message and, seconds later, the
 * screenshot that went with it, and the screenshot started a second turn
 * after the first had answered without it. The room now does what the
 * ticket composer has done since EO-176 — the comment first, then the
 * delivery into the turn that is running — and always with delivery
 * `now`, because this room has no send-mode picker.
 */
describe("a message sent while the assistant's turn is running", () => {
  function engineThatAnswers(result: SteerResult, during: () => void = () => undefined): EngineHandle & { steerRun: ReturnType<typeof vi.fn> } {
    return {
      resumeItem: vi.fn(async () => {}),
      cancelRun: vi.fn(),
      steerRun: vi.fn(async () => {
        during();
        return result;
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      isPaused: () => false,
      dispatchBlockerFor: () => null,
      activeRunCount: () => 1,
      finishingRunCount: () => 0,
      notifyStateChange: vi.fn(),
      itemLock: createItemLock(),
      offerWork: async () => [],
    };
  }

  /** A conversation with a turn in flight on its first message. */
  async function midTurn() {
    const view = (await send("/settings", "why is the reviewer step red?")).conversation;
    const run = createRun(handle.db, {
      itemId: view.id as Uuid,
      agentId: assistAgent(handle.db)!.id,
      action: ASSIST_ACTION,
      status: "running",
      initiationId: newestQuestion(rowOf(view.id)),
    });
    return { view, run };
  }

  const sendDuring = (engine: EngineHandle, conversationId: string, body: string) =>
    sendToAssist(handle.db, engine, { page: page("/settings"), conversationId, body, attachmentIds: [], interrupt: false });

  const mentionOf = (commentId: Uuid) => listMentionsForComment(handle.db, commentId).find((mention) => mention.targetType === "agent");

  it("is steered into that turn with delivery now: no run row, no cancel, and the mention is dismissed", async () => {
    const { view, run } = await midTurn();
    // Invariant 4, at the moment it matters: by the time anything is
    // delivered, the message is already a comment in the thread.
    let inTheThreadAlready: string[] = [];
    const engine = engineThatAnswers("steered", () => {
      inTheThreadAlready = listCommentsForItem(handle.db, view.id as Uuid).map((comment) => comment.body);
    });

    const result = await sendDuring(engine, view.id, "the one on the default board");

    const said = newestQuestion(rowOf(view.id));
    expect(inTheThreadAlready).toEqual(["why is the reviewer step red?", "the one on the default board"]);
    expect(engine.steerRun).toHaveBeenCalledExactlyOnceWith(run.id, { commentId: said, body: "the one on the default board", delivery: "now" });
    expect(result.delivery).toEqual({ requested: "now", outcome: "now", note: null });
    // In the chat at once, whichever turn reads it.
    expect(result.conversation.messages.map((message) => message.body)).toContain("the one on the default board");

    // Steering is not stop-and-restart: the same run, still going.
    expect(engine.cancelRun).not.toHaveBeenCalled();
    const runs = listRunsForItem(handle.db, view.id as Uuid);
    expect(runs.map((row) => [row.id, row.status])).toEqual([[run.id, "running"]]);

    // The agent has been told, so nothing is left to start a second turn
    // once this one ends.
    expect(mentionOf(said)?.status).toBe("dismissed");
    // The turn ends, having answered the message that started it — and
    // there is no second message waiting for a turn of its own.
    dismissOpenMentionsForComment(handle.db, run.initiationId as Uuid);
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    expect(findPendingResponses(handle.db, [view.id as Uuid])).toEqual([]);
  });

  it("stays queued for the next turn, and says so, when the turn ended first", async () => {
    const { view, run } = await midTurn();

    const result = await sendDuring(engineThatAnswers("turn-over"), view.id, "the one on the default board");

    const said = newestQuestion(rowOf(view.id));
    expect(result.delivery).toMatchObject({ requested: "now", outcome: "next" });
    // A sentence, in this room's words rather than a ticket's.
    expect(result.delivery?.note).toMatch(/already finished the turn/);
    expect(result.delivery?.note).toMatch(/next turn in this conversation/);
    expect(result.delivery?.note).not.toMatch(/ticket/);

    // Queued the way every message here is queued: the mention is open,
    // and it is what starts the turn that reads it.
    expect(mentionOf(said)?.status).toBe("open");
    updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
    expect(findPendingResponses(handle.db, [view.id as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
    expect(await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION)).toContain("the one on the default board");
  });

  it.each([
    ["no-live-run", /no live turn to say this into/],
    ["unsupported", /cannot be spoken to mid-turn/],
  ] as const)("stays queued and says why when the answer is %s", async (answer, sentence) => {
    const { view } = await midTurn();

    const result = await sendDuring(engineThatAnswers(answer), view.id, "and the QA step?");

    expect(result.delivery?.outcome).toBe("next");
    expect(result.delivery?.note).toMatch(sentence);
    expect(mentionOf(newestQuestion(rowOf(view.id)))?.status).toBe("open");
  });

  /**
   * A backend slow to take the message (EO-558): the person is answered
   * within the bound, told it is pending, and the delivery finishes
   * afterwards — closing the mention if it lands, leaving it open for
   * the next turn if it does not.
   */
  describe("when the backend has not answered by the time the person should be", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function engineThatWaits() {
      let settle!: (result: SteerResult) => void;
      const answer = new Promise<SteerResult>((resolve) => {
        settle = resolve;
      });
      const engine = { ...engineThatAnswers("steered"), steerRun: vi.fn(() => answer) };
      return { engine, settle };
    }

    async function sendWhileWaiting(engine: EngineHandle, conversationId: string) {
      vi.useFakeTimers();
      let answered: Awaited<ReturnType<typeof sendDuring>> | undefined;
      void sendDuring(engine, conversationId, "the one on the default board").then((result) => {
        answered = result;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      return answered;
    }

    it("answers within two seconds with the delivery pending, and the message in the chat", async () => {
      expect(STEER_REPLY_WITHIN_MS).toBeLessThan(2_000);
      const { view } = await midTurn();
      const { engine } = engineThatWaits();

      const result = await sendWhileWaiting(engine, view.id);

      expect(result, "Send is answered while the steer is still outstanding").toBeDefined();
      expect(result!.delivery).toMatchObject({ requested: "now", outcome: "pending" });
      expect(result!.delivery?.note).toMatch(/next turn in this conversation/);
      expect(result!.conversation.messages.map((message) => message.body)).toContain("the one on the default board");
      expect(mentionOf(newestQuestion(rowOf(view.id)))?.status).toBe("open");
    });

    it("dismisses the mention when the steer lands after the reply, so no second turn starts", async () => {
      const { view, run } = await midTurn();
      const { engine, settle } = engineThatWaits();
      const result = await sendWhileWaiting(engine, view.id);
      expect(result!.delivery?.outcome).toBe("pending");

      settle("steered");
      await vi.advanceTimersByTimeAsync(0);

      const said = newestQuestion(rowOf(view.id));
      expect(mentionOf(said)?.status).toBe("dismissed");
      dismissOpenMentionsForComment(handle.db, run.initiationId as Uuid);
      updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
      expect(findPendingResponses(handle.db, [view.id as Uuid])).toEqual([]);
    });

    it("leaves the message for the next turn when the late steer misses", async () => {
      const { view, run } = await midTurn();
      const { engine, settle } = engineThatWaits();
      await sendWhileWaiting(engine, view.id);

      settle("turn-over");
      await vi.advanceTimersByTimeAsync(0);

      expect(mentionOf(newestQuestion(rowOf(view.id)))?.status).toBe("open");
      updateRun(handle.db, run.id, { status: "succeeded", endedAt: Date.now() });
      expect(findPendingResponses(handle.db, [view.id as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
      vi.useRealTimers();
      expect(await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION)).toContain("the one on the default board");
    });
  });

  it("is an ordinary send, with nothing to report, when no turn is running", async () => {
    const view = (await send("/settings", "why is the reviewer step red?")).conversation;
    const engine = engineThatAnswers("steered");

    const result = await sendDuring(engine, view.id, "anyone there?");

    expect(engine.steerRun).not.toHaveBeenCalled();
    expect(result.delivery).toBeNull();
    expect(mentionOf(newestQuestion(rowOf(view.id)))?.status).toBe("open");
  });

  /**
   * The whole path, against a supervisor that is really driving the
   * turn: the file reaches the agent named as a prompt would name it, a
   * file with no words is delivered, and each delivery is a
   * `human_message` row on the run.
   */
  describe("with files", () => {
    let directory: string;
    let storage: AttachmentStorage;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "eo assist steer "));
      storage = new AttachmentStorage(join(directory, "managed"));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    it("delivers the screenshot into the running turn, which ends as one run", async () => {
      const heard: { message: string; attachments: AgentInputAttachment[] }[] = [];
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let announce!: () => void;
      const working = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const open = (): InterruptibleStream<AgentEvent> => {
        async function* events(): AsyncIterable<AgentEvent> {
          yield { type: "thread_started", threadId: "session-1" };
          announce();
          await held;
          yield { type: "result", data: { message: "It is red because of the screenshot." } };
        }
        const iterator = events()[Symbol.asyncIterator]();
        return {
          [Symbol.asyncIterator]: () => iterator,
          steer: (message, attachments = []) => {
            heard.push({ message, attachments });
            return Promise.resolve(true);
          },
        };
      };
      const supervisor = createRunSupervisor({
        db: handle.db,
        provider: { start: open, resume: open },
        limits: { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 },
      });
      const engine: EngineHandle = { ...engineThatAnswers("steered"), steerRun: supervisor.steerRun };

      const view = (await send("/settings", "why is the reviewer step red?")).conversation;
      const turn = supervisor.runOnce();
      await working;
      const [run] = listRunsForItem(handle.db, view.id as Uuid);
      expect(run?.status).toBe("running");

      const source = join(directory, "screen.png");
      writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const [withWords, alone] = await storage.stagePaths([source, source]);
      const during = (body: string, attachmentId: string) =>
        sendToAssist(handle.db, engine, { page: page("/settings"), conversationId: view.id, body, attachmentIds: [attachmentId], interrupt: false }, storage);

      expect((await during("this is the one I mean", withWords!.id)).delivery).toEqual({ requested: "now", outcome: "now", note: null });
      // A screenshot with nothing typed under it is a message.
      expect((await during("", alone!.id)).delivery).toEqual({ requested: "now", outcome: "now", note: null });

      expect(heard.map((steered) => steered.message)).toEqual(["this is the one I mean", ""]);
      expect(heard.map((steered) => steered.attachments)).toEqual([
        [expect.objectContaining({ id: withWords!.id, name: "screen.png", mimeType: "image/png", kind: "image" })],
        [expect.objectContaining({ id: alone!.id, name: "screen.png", mimeType: "image/png", kind: "image" })],
      ]);

      // Recorded on the run as the ticket composer's is, and nothing a
      // cancel would have written.
      const delivered = listRunEvents(handle.db, run!.id).filter((event) => event.type === HUMAN_MESSAGE_EVENT);
      expect(delivered.map((event) => event.payload)).toEqual([
        expect.objectContaining({ body: "this is the one I mean", delivery: "now", delivered: true }),
        expect.objectContaining({ body: "", delivery: "now", delivered: true }),
      ]);
      expect(listRunsForItem(handle.db, view.id as Uuid)).toHaveLength(1);

      finish();
      await turn;

      // One run, ended as itself rather than cancelled, covering all
      // three messages.
      const runs = listRunsForItem(handle.db, view.id as Uuid);
      expect(runs.map((row) => row.status)).toEqual(["succeeded"]);
      // This supervisor is built bare, without the pack wiring that
      // posts the reply and settles the mention that started the turn,
      // so that one is not asserted on. What is: neither steered message
      // is left to start a turn of its own.
      const steered = listCommentsForItem(handle.db, view.id as Uuid).slice(1);
      expect(steered.map((comment) => mentionOf(comment.id)?.status)).toEqual(["dismissed", "dismissed"]);
      const waiting = findPendingResponses(handle.db, [view.id as Uuid]).map((pending) => pending.commentId);
      for (const comment of steered) expect(waiting).not.toContain(comment.id);
    });
  });
});

describe("a page EO cannot resolve", () => {
  it("runs the turn anyway when the route is one EO does not know", async () => {
    const view = (await send("/somewhere-new", "what should I look at?")).conversation;
    const context = await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION);

    expect(context).toContain("what should I look at?");
    expect(findPendingResponses(handle.db, [view.id as Uuid]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
  });

  it("runs the turn anyway when the item has been deleted since the panel was opened", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const view = (await send(`/items/${item.id}`, "what is left here?")).conversation;

    deleteItem(handle.db, item.id);

    expect(await buildDispatchContext(handle.db, rowOf(view.id), ASSIST_ACTION)).toContain("what is left here?");
  });

  /**
   * At the boundary rather than inside: a route this build has not heard
   * of is accepted (it costs a section), while something that is not a
   * descriptor at all is refused before any of this runs.
   */
  it("is validated at the IPC boundary", async () => {
    const malformed = await handleIpcRequest(
      "assist:send",
      { page: { route: 7 }, conversationId: null, body: "hello" },
      (payload) => sendToAssist(handle.db, undefined, payload),
      opts,
    );
    expect(malformed.ok).toBe(false);

    const unknownRoute = await handleIpcRequest(
      "assist:send",
      { page: { route: "/somewhere-new" }, conversationId: null, body: "hello" },
      (payload) => sendToAssist(handle.db, undefined, payload),
      opts,
    );
    expect(unknownRoute.ok).toBe(true);
  });
});

describe("the installation listing", () => {
  /**
   * EO-189 gave it to an assist turn on the three screens whose subject
   * is how EO is set up, decided from the page it had preloaded. Nothing
   * is preloaded now, so there is nothing to decide from — and giving it
   * unconditionally would put a page of inventory in front of every
   * question the widget is ever asked, which is the cost this story
   * exists to stop paying. The agent lists what it needs with the tools
   * it holds.
   */
  it("no longer comes with an assist turn at all", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    const onAgents = (await send("/agents", "who reviews?")).conversation;
    expect(await buildDispatchContext(handle.db, rowOf(onAgents.id), ASSIST_ACTION)).not.toContain("## The configuration");

    const onItem = (await send(`/items/${item.id}`, "who reviews?")).conversation;
    expect(await buildDispatchContext(handle.db, rowOf(onItem.id), ASSIST_ACTION)).not.toContain("## The configuration");
  });
});

describe("an assist turn asked to move the item it is looking at", () => {
  it("continues the one conversation, from the item's page or from its runs page", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    const first = (await send(`/items/${item.id}`, "move this to Review")).conversation;
    const second = (await send(`/items/${item.id}/runs`, "did that work?", null)).conversation;

    expect(second.id).toBe(first.id);
    expect(shownAssistConversation(handle.db, activeProjectId(handle.db))?.id).toBe(first.id);
  });
});

/** How Claude Code advertises the read that answers with a pipeline's graph. */
const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

/** The same read as Codex sends it. Different punctuation, same capability (invariant #12). */
const PIPELINE_READ_ON_CODEX = `${ADMIN_MCP_SERVER_NAME}/pipeline_get`;

/** The screen read. A real read, and deliberately not evidence about any particular board. */
const SCREEN_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__view_current`;

/**
 * Somebody else's tool, wearing the same name.
 *
 * An agent carries third-party MCP servers, and "pipeline" is ordinary
 * CI vocabulary — so a `pipeline_get` that takes a `pipelineId` and has
 * nothing to do with EO is a thing that exists.
 */
const ANOTHER_SERVERS_READ = "mcp__ci__pipeline_get";

/** What a turn's log says it read: a tool, and the board it asked that tool for. */
interface ScriptedRead {
  tool: string;
  pipelineId?: string;
}

/**
 * The buttons the panel draws (EO-190).
 *
 * Each of them goes somewhere that already existed — the shared answer
 * path, `applyDiscussionProposal`, `pipeline:save` — so what these cases
 * are about is the wiring and the guards, not a third implementation of
 * any of the three.
 */
describe("the buttons on a card", () => {
  /**
   * The shipped pipeline as a draft, with one step added.
   *
   * Changed rather than identical because `renderDraft` refuses a graph
   * that proposes nothing — a Publish button over a no-op would be a
   * button that could not work.
   */
  function graphWithQa(): PipelineDraft {
    const draft: PipelineDraft = {
      rationale: "Adds a QA step after Review.",
      entryStepId: "worktree",
      // Nothing is dropped, so nothing is declared (EO-209).
      removes: [],
      steps: listStepsForPipeline(handle.db, "default")
        .filter((step) => !step.offBoard)
        .map((step) => ({
          id: step.id,
          position: step.position,
          name: step.name,
          type: step.type,
          ownerRole: step.ownerRole,
          entryAction: step.entryAction,
          instructionsSummary: step.instructionsSummary,
          isTerminal: step.isTerminal,
          planMode: step.planMode,
        })),
      routes: listRoutesForPipeline(handle.db, "default").map((route) => ({
        fromStepId: route.fromStepId,
        resultKey: route.resultKey,
        label: route.label,
        tone: route.tone,
        target: route.target,
        position: route.position,
      })),
    };

    const review = draft.steps.find((step) => step.name === "Review") ?? draft.steps[0]!;
    // After the last column, whatever the pipeline happens to hold: two
    // steps sharing a position is a graph the validator refuses, and the
    // count of steps is not the highest position among them.
    const last = Math.max(...draft.steps.map((step) => step.position));
    return {
      ...draft,
      steps: [...draft.steps, { ...review, id: "qa", position: last + 1, name: "QA", instructionsSummary: null }],
      // And a route for each result the step's action declares: an agent
      // step that leaves one unrouted is a graph the validator refuses
      // (EO-423), which would make every case below one about that.
      routes: [
        ...draft.routes,
        ...draft.routes
          .filter((route) => route.fromStepId === review.id)
          .map((route) => ({ ...route, fromStepId: "qa", target: "user_attention" })),
      ],
    };
  }

  /**
   * One turn: a succeeded `assist` run carrying `output`, and what it
   * posted.
   *
   * `read` is the run's own log, and it defaults to a turn that asked
   * for *this board's* graph and got an answer (EO-208). That is what an
   * ordinary turn does — the prompt tells it to and the tool is there —
   * and a draft from a turn that did not is refused, so a helper that
   * recorded nothing would make every case below a test of the refusal
   * rather than of what it was written for.
   *
   * The call *and its answer*, because the gate requires both: a call on
   * its own records that the agent asked, not that anything came back,
   * and EO-208's run is precisely a turn that asked and was told
   * nothing. Null is how a case asks for the run that read nothing at
   * all.
   *
   * Spelled the way Claude Code advertises the tool. The Codex spelling
   * is exercised too, a few cases down: invariant #12, and the failure it
   * describes is silent — a check written around one backend's
   * punctuation refuses every draft raised on the other while every test
   * still passes.
   */
  function turn(
    conversation: Item,
    output: AssistReply,
    initiationId?: Uuid,
    read: ScriptedRead | null = { tool: PIPELINE_READ, pipelineId: "default" },
  ): { runId: Uuid; cardIds: Uuid[] } {
    const agent = assistAgent(handle.db)!;
    // The comment the mention path dispatched on, which is what the turn
    // answers for when it is asked which board it was started from.
    // Defaults to the newest question, and is passed explicitly by the
    // case where the person asked one thing and then said another.
    const run = createRun(handle.db, {
      itemId: conversation.id,
      agentId: agent.id,
      action: ASSIST_ACTION,
      initiationId: initiationId ?? newestQuestion(conversation),
    });
    // Before the reply is posted, as the supervisor has it: the buffer is
    // flushed before a terminal state is decided, so the log is complete
    // by the time `wiring.ts` posts what the turn came back with.
    if (read !== null) {
      const args = read.pipelineId === undefined ? {} : { pipelineId: read.pipelineId };
      appendRunEvent(handle.db, run.id, "tool_call", { name: read.tool, args, callId: "call-1" });
      appendRunEvent(handle.db, run.id, "tool_result", { name: read.tool, callId: "call-1", ok: true, output: "", truncated: false });
    }
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });
    postAssistReply(handle.db, conversation, agent.id, run.id, output);
    return {
      runId: run.id,
      cardIds: listCommentsForItem(handle.db, conversation.id)
        .filter((comment) => comment.runId === run.id && comment.kind === PROPOSAL_KIND)
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map((comment) => comment.id),
    };
  }

  const A_STORY = {
    action: "new_feature" as const,
    title: "Rate limiting",
    understanding: "Cap what one key can do per minute.",
    decisions: [],
    stories: [{ title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts are per key"], depends_on: [], touches: [] }],
  };

  it("answers a batch of questions together, and starts one turn rather than one per answer", async () => {
    const conversation = await openedOn("/settings");
    turn(conversation, {
      message: "Two things first.",
      questions: [
        { id: "days", question: "How many days?", why: "A thread older than that starts fresh.", options: ["3", "7"] },
        { id: "who", question: "Whose default?", why: "It applies to everyone.", options: ["mine", "everyone"] },
      ],
      proposals: [],
    });
    const asked = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.kind === "question");

    const answered = answerAssistQuestions(handle.db, undefined, {
      conversationId: conversation.id,
      answers: asked.map((question, index) => ({ questionId: question.id, answer: index === 0 ? "3" : null })),
    });

    expect(answered.answered).toBe(2);
    expect(answered.problem).toBeNull();
    // A skip is recorded as one rather than lost, and the batch is one
    // dispatch: the questions were asked together.
    const bodies = listCommentsForItem(handle.db, conversation.id)
      .filter((comment) => comment.parentId !== null && comment.authorType === "human")
      .map((comment) => comment.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(SKIPPED_ANSWER);
    expect(findPendingResponses(handle.db, [conversation.id]).map((pending) => pending.action)).toEqual([ASSIST_ACTION]);
  });

  it("refuses a batch a newer turn has replaced, with a reason rather than a crash", async () => {
    const conversation = await openedOn("/settings");
    turn(conversation, {
      message: "One thing first.",
      questions: [{ id: "days", question: "How many days?", why: "A thread older than that starts fresh.", options: ["3", "7"] }],
      proposals: [],
    });
    const stale = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "question")!;
    // Answered their own way: somebody who reads a card and replies in
    // their own words has answered it, and the card stops collecting.
    await send("/settings", "three is fine, and stop asking");

    const answered = answerAssistQuestions(handle.db, undefined, {
      conversationId: conversation.id,
      answers: [{ questionId: stale.id, answer: "7" }],
    });

    expect(answered.answered).toBe(0);
    expect(answered.problem).toContain("already been answered or replaced");
  });

  it("creates the work a decomposition proposes, through the path Discussions approves through", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const conversation = await openedOn(`/items/${item.id}`);
    const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [A_STORY] });

    const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(applied.applied).toBe(true);
    expect(applied.createdKeys.length).toBeGreaterThan(0);
    // The approval is filed under the card, which is also what stops it
    // being approvable a second time (invariant #8).
    const under = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.parentId === cardIds[0]);
    expect(under.map((comment) => comment.kind)).toEqual(["approval"]);
    expect(applied.conversation.messages.find((message) => message.id === cardIds[0])?.canApprove).toBe(false);

    const again = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(again.applied).toBe(false);
    expect(again.problem).toContain("superseded or already applied");
  });

  /**
   * The card's rows and the work its button creates are one reading of
   * one proposal (EO-407).
   *
   * The rows travel on the message, built from the run's structured
   * result — never the prose body — so this compares them with the items
   * `assist:approve` then files for the same message: title, type label,
   * criteria, and each dependency by the title of what it waits on. The
   * second and third stories overlap in `touches`, so one of those edges
   * is one the agent never stated and the approval path derives.
   */
  describe("the rows a work card lists", () => {
    const PLAN = {
      action: "new_feature" as const,
      title: "Rate limiting",
      understanding: "Cap what one key can do per minute.",
      decisions: [],
      stories: [
        { title: "Count requests", body: "BODY-ONE per key, per minute.", acceptance_criteria: ["counts are per key", "counts reset each minute"], depends_on: [], touches: [] },
        { title: "Refuse over the limit", body: "BODY-TWO answer 429.", acceptance_criteria: ["a 429 past the limit"], depends_on: [0], touches: ["src/limit.ts"] },
        { title: "Show the limit", body: "BODY-THREE in the headers.", acceptance_criteria: ["headers carry the limit"], depends_on: [], touches: ["src/limit.ts"] },
      ],
    };

    const proposalOn = (messageId: string) => openAssist(handle.db).conversation.messages.find((message) => message.id === messageId)?.proposal ?? null;

    it("match what approving the same message creates", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });

      const summary = proposalOn(cardIds[0]!)!;
      expect(ProposalSummarySchema.safeParse(summary).success).toBe(true);
      expect(summary.closed).toBeNull();
      expect(summary.rows).toHaveLength(3);
      // The stated edge and the derived one, each by title.
      expect(summary.rows.flatMap((row) => (row.kind === "new" ? row.waitsOn.map((dependency) => `${row.title} <- ${dependency.title}`) : []))).toEqual([
        "Refuse over the limit <- Count requests",
        "Show the limit <- Refuse over the limit",
      ]);

      const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(applied.applied).toBe(true);

      const created = applied.createdKeys.map((key) => getItemByKey(handle.db, key)!);
      const [container, ...items] = created;
      expect(summary.container).toEqual({ title: container!.title, typeLabel: container!.typeLabel });
      expect(summary.rows).toEqual(
        items.map((item) => ({
          kind: "new",
          title: item.title,
          typeLabel: item.typeLabel,
          acceptanceCriteria: item.spec?.["acceptance_criteria"],
          waitsOn: listDependencies(handle.db, item.id).map((edge) => ({ key: null, title: getItem(handle.db, edge.dependsOnId)!.title })),
          under: null,
        })),
      );

      // Approved, the card keeps its rows and says so; nothing offers the button again.
      const after = applied.conversation.messages.find((message) => message.id === cardIds[0])!;
      expect(after.canApprove).toBe(false);
      // And each row now names the item it became (EO-408), in the rows' own order.
      expect(after.proposal).toEqual({
        ...summary,
        rows: summary.rows.map((row, index) => ({ ...row, created: { itemId: items[index]!.id, key: items[index]!.key } })),
        closed: "applied",
      });
    });

    /**
     * The proposed item the canvas draws (EO-408) is the same proposal at
     * full length: the card's rows with each description, where the work
     * would land, and whether it can still be approved — read by message
     * id, which is all the view's address carries.
     */
    it("are read at full length by message id, with each description and where the work lands", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      const messageId = cardIds[0]!;

      const { proposal } = readAssistProposal(handle.db, { messageId });
      expect(ProposalDetailSchema.safeParse(proposal).success).toBe(true);
      expect(proposal).toMatchObject({ conversationId: conversation.id, canApprove: true, closed: null, container: { title: "Rate limiting" } });
      expect(proposal!.rows.map((row) => (row.kind === "new" ? row.description : null))).toEqual(PLAN.stories.map((story) => story.body));
      // The rows are the card's own, so the two cannot list different things.
      expect(proposal!.rows.map((row) => (row.kind === "new" ? { ...row, description: undefined, addedFields: undefined } : row))).toEqual(
        proposalOn(messageId)!.rows.map((row) => ({ ...row, description: undefined, addedFields: undefined })),
      );

      const applied = approveAssistProposal(handle.db, undefined, { conversationId: proposal!.conversationId, messageId });
      const first = getItemByKey(handle.db, applied.createdKeys[1]!)!;
      // Where it said the work would land is where the work landed.
      expect(proposal!.landsOn).toEqual({
        pipelineName: listPipelines(handle.db, conversation.projectId).find((pipeline) => pipeline.id === first.pipelineId)!.name,
        stepName: listStepsForPipeline(handle.db, first.pipelineId!).find((step) => step.id === first.stepId)!.name,
      });

      // Approved: still readable, no longer approvable, and each row names its item.
      const after = readAssistProposal(handle.db, { messageId }).proposal!;
      expect(after).toMatchObject({ canApprove: false, closed: "applied" });
      expect(after.rows.map((row) => (row.kind === "new" ? row.created?.key : null))).toEqual(applied.createdKeys.slice(1));
    });

    /**
     * A field the project added to the items' type (EO-735) is offered on
     * each row, and what a person sets before Create is filed with that
     * row alone; a row nobody set anything on is created without it.
     */
    it("offer each row's added fields, and file what a person set on them when approved", async () => {
      const conversation = await openedOn("/settings");
      const story = resolveItemType(handle.db, conversation.projectId, { packSlug: "developer", slug: "story" });
      if (!story.ok) throw new Error(story.problem);
      const own = specFields(story.type.specShape).map(({ name, kind, required }) => ({ name, kind, required }));
      expect(updateItemTypeCommand(handle.db, { id: story.type.id, fields: [...own, { name: "automerge", kind: "boolean", required: false }] }).problem).toBeNull();
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      const messageId = cardIds[0]!;

      const { proposal } = readAssistProposal(handle.db, { messageId });
      expect(proposal!.rows.map((row) => (row.kind === "new" ? row.addedFields : null))).toEqual(
        PLAN.stories.map(() => [{ name: "automerge", label: "Automerge", kind: "boolean" }]),
      );

      const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId, addedFields: [{ row: 1, values: { automerge: false } }] });

      expect(applied.problem).toBeNull();
      const [, first, second, third] = applied.createdKeys.map((key) => getItemByKey(handle.db, key)!);
      expect(second!.spec).toMatchObject({ automerge: false });
      expect(first!.spec).not.toHaveProperty("automerge");
      expect(third!.spec).not.toHaveProperty("automerge");
    });

    it("refuse a value for a field the row's type was not given here, and create nothing", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });

      const refused = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]!, addedFields: [{ row: 0, values: { acceptance_criteria: [] } }] });

      expect(refused.applied).toBe(false);
      expect(refused.problem).toContain("“acceptance_criteria” is not a field this project added");
      expect(refused.createdKeys).toEqual([]);
    });

    /**
     * Putting the chat away is not un-approving it. A card approved and
     * then cleared still names what it created, so its rows stay links
     * and a proposed item's address reloaded afterwards still finds the
     * item it became.
     */
    it("keep naming what they became after the approved conversation is put away", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      const messageId = cardIds[0]!;
      const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId });
      expect(applied.applied).toBe(true);

      clearAssist(handle.db, undefined);
      expect(getItem(handle.db, conversation.id)!.archivedAt).not.toBeNull();

      const after = readAssistProposal(handle.db, { messageId }).proposal!;
      expect(after).toMatchObject({ canApprove: false, closed: "applied" });
      expect(after.rows.map((row) => (row.kind === "new" ? row.created?.key : null))).toEqual(applied.createdKeys.slice(1));
      expect(after.rows.map((row) => (row.kind === "new" ? row.created?.itemId : null))).toEqual(applied.createdKeys.slice(1).map((key) => getItemByKey(handle.db, key)!.id));
    });

    it("say nothing about why for a card nobody approved before its conversation was put away", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });

      clearAssist(handle.db, undefined);

      const after = readAssistProposal(handle.db, { messageId: cardIds[0]! }).proposal!;
      expect(after).toMatchObject({ canApprove: false, closed: null });
      expect(after.rows.every((row) => row.kind === "new" && !row.created)).toBe(true);
    });

    it("create the items once when approve is pressed in two places at once", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      const before = listItemsForProject(handle.db, conversation.projectId).length;

      // The card's button and the canvas's make the same call; the main process answers them one after the other.
      const press = () => approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      const [one, two] = [press(), press()];

      expect([one.applied, two.applied]).toEqual([true, false]);
      expect(two.createdKeys).toEqual([]);
      expect(listItemsForProject(handle.db, conversation.projectId).length - before).toBe(one.createdKeys.length);
      expect(listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.parentId === cardIds[0]).map((comment) => comment.kind)).toEqual(["approval"]);
    });

    it("stay readable at full length once a newer proposal replaced them, and answer nothing for a message that is no work card", async () => {
      const conversation = await openedOn("/pipelines/default");
      const older = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      await send("/pipelines/default", "make it one");
      turn(rowOf(conversation.id), { message: "One, then.", questions: [], proposals: [{ ...PLAN, stories: PLAN.stories.slice(0, 1) }] });

      const replaced = readAssistProposal(handle.db, { messageId: older.cardIds[0]! }).proposal!;
      expect(replaced).toMatchObject({ canApprove: false, closed: "superseded" });
      expect(replaced.rows.map((row) => (row.kind === "new" ? row.description : null))).toEqual(PLAN.stories.map((story) => story.body));

      const note = openAssist(handle.db).conversation.messages.find((message) => message.kind === "note")!;
      expect(readAssistProposal(handle.db, { messageId: note.id }).proposal).toBeNull();
      expect(readAssistProposal(handle.db, { messageId: "019fb8c6-de92-7a41-9c33-000000000000" }).proposal).toBeNull();
      // A comment on ordinary work is not the assistant's card, whatever its kind.
      const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
      const elsewhere = postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: PROPOSAL_KIND, body: "Not a card." });
      expect(readAssistProposal(handle.db, { messageId: elsewhere.id }).proposal).toBeNull();
    });

    /**
     * What the assistant is told is open (EO-408). The window publishes
     * the proposed item's address and nothing else; EO resolves the
     * proposal behind it, so "split this one in two" lands on a proposed,
     * unfiled item named by its title.
     */
    it("tell the assistant which proposed, unfiled item is open, by title", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      const deps = { hasWindow: () => true, proposal: (messageId: string) => readAssistProposal(handle.db, { messageId }).proposal };

      const page = pageDescriptorFor(proposedItemPath(cardIds[0]!, 1));
      expect(page).toEqual({ route: "/proposals/:messageId/:index", params: { messageId: cardIds[0], index: "1" } });
      publishView({ page, filter: null, selection: [], sort: null, unsavedEdits: [] });

      const answer = readCurrentView(handle.db, deps);
      expect(answer.view?.showing).toEqual({
        kind: "proposedItem",
        proposed: {
          title: "Refuse over the limit",
          type: "Story",
          acceptanceCriteria: ["a 429 past the limit"],
          waitsOn: ["Count requests"],
          container: "Rate limiting",
          landsOn: expect.stringContaining(" · "),
          proposedTogether: 3,
          position: 2,
          state: "open",
        },
      });
      const text = renderCurrentView(answer);
      expect(text).toContain("**proposed, unfiled Story** open: **Refuse over the limit**");
      expect(text).toContain("It is not filed yet");

      // Approved, it says so; and a place past the end of the rows is no view at all.
      approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(readCurrentView(handle.db, deps).view?.showing).toMatchObject({ kind: "proposedItem", proposed: { state: "applied" } });
      publishView({ page: pageDescriptorFor(proposedItemPath(cardIds[0]!, 9)), filter: null, selection: [], sort: null, unsavedEdits: [] });
      expect(readCurrentView(handle.db, deps)).toMatchObject({ view: null, absence: expect.stringContaining("proposed item is not there") });
    });

    it("name a single item's parent and what it waits on, and the item an amendment changes", async () => {
      const parent = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });
      const first = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo" });
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, {
        message: "Two of them.",
        questions: [],
        proposals: [
          { action: "new_story", parent: parent.key, title: "Refuse over the limit", body: "Answer 429.", acceptance_criteria: ["a 429 past the limit"], depends_on: [first.key], touches: [] },
          { action: "amend", item: first.key, why: "The title is vague.", title: "Count requests per key" },
        ],
      });

      const created = proposalOn(cardIds[0]!)!;
      expect(created.container).toBeNull();
      expect(created.rows).toEqual([
        {
          kind: "new",
          title: "Refuse over the limit",
          typeLabel: "Story",
          acceptanceCriteria: ["a 429 past the limit"],
          waitsOn: [{ key: first.key, title: "Count requests" }],
          under: { key: parent.key, title: "Rate limiting" },
        },
      ]);

      const change = proposalOn(cardIds[1]!)!;
      expect(change.rows).toEqual([
        { kind: "change", itemId: first.id, itemKey: first.key, itemTitle: "Count requests", change: "Changes the title, to “Count requests per key”." },
      ]);
      const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[1]! });
      expect(applied.changedKeys).toEqual(change.rows.map((row) => (row.kind === "change" ? row.itemKey : null)));
    });

    it("stay on a card a newer proposal replaced, and are absent from a draft and an ordinary message", async () => {
      const conversation = await openedOn("/pipelines/default");
      const older = turn(conversation, { message: "Here is that as work.", questions: [], proposals: [PLAN] });
      await send("/pipelines/default", "make it two, and add a QA step");
      const newer = turn(rowOf(conversation.id), {
        message: "Both, then.",
        questions: [],
        proposals: [{ ...PLAN, stories: PLAN.stories.slice(0, 1) }],
        draft: graphWithQa(),
      });

      expect(proposalOn(older.cardIds[0]!)).toMatchObject({ closed: "superseded", rows: [{ title: "Count requests" }, { title: "Refuse over the limit" }, { title: "Show the limit" }] });
      expect(proposalOn(newer.cardIds[0]!)).toMatchObject({ closed: null, rows: [{ title: "Count requests" }] });
      // The draft is a card on the same run with no work proposal behind it.
      expect(proposalOn(newer.cardIds[1]!)).toBeNull();
      const view = openAssist(handle.db).conversation;
      expect(view.messages.find((message) => message.kind === "note")?.proposal).toBeNull();
    });
  });

  it("refuses to approve a pipeline draft, and says to publish it instead", async () => {
    const conversation = await openedOn("/pipelines/default");
    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: graphWithQa() });

    const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds.at(-1)! });

    expect(applied.applied).toBe(false);
    expect(applied.problem).toContain("Publish it rather than approving it");
    // And nothing was written to the thread about it: a click on the
    // wrong button is not a decision anybody made.
    expect(listCommentsForItem(handle.db, conversation.id).some((comment) => comment.kind === "rejection")).toBe(false);
  });

  it("says which of two cards from one turn is which, so the panel offers the button that fits", async () => {
    const conversation = await openedOn("/pipelines/default");
    const { cardIds } = turn(conversation, {
      message: "Both, then.",
      questions: [],
      proposals: [A_STORY],
      draft: graphWithQa(),
    });

    const view = openAssist(handle.db).conversation;
    const approves = (id: string) => view.messages.find((message) => message.id === id)?.approves;

    expect(cardIds).toHaveLength(2);
    // The order `postAssistReply` writes: proposals, then the draft
    // last. That order is the only thing telling two identical-looking
    // comments apart, which is why the room answers this and not the
    // panel.
    expect(approves(cardIds[0]!)).toBe("items");
    expect(approves(cardIds[1]!)).toBe("pipeline");
    // An ordinary message approves nothing at all.
    expect(view.messages.find((message) => message.kind === "note")?.approves).toBeNull();
  });

  /**
   * A button is a promise about what the click does.
   *
   * An amendment and a decomposition are the same kind of card on the
   * same run, and only the proposal behind them says which — so a panel
   * labelling both "Create item" would be telling somebody it was
   * about to file new work when it was about to rewrite their story.
   */
  it("tells a card that creates work from one that changes work", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const conversation = await openedOn(`/items/${item.id}`);
    const { cardIds } = turn(conversation, {
      message: "Two of them.",
      questions: [],
      proposals: [A_STORY, { action: "amend", item: item.key, why: "The title is wrong.", title: "Rate-limit the API" }],
    });

    const view = openAssist(handle.db).conversation;
    const approves = (id: string) => view.messages.find((message) => message.id === id)?.approves;

    expect(approves(cardIds[0]!)).toBe("items");
    expect(approves(cardIds[1]!)).toBe("changes");
  });

  /**
   * A proposal that could not be built must not take the one beside it
   * with it.
   *
   * `renderProposal` refuses an amendment naming an item that does not
   * exist, and that refusal is posted as a rejection carrying the reason
   * — which fills its place in the turn but offers no button. Counting
   * only the cards then read the story after it as the amendment:
   * labelled "Apply change", refused with "There is no item EO-9999",
   * and impossible to create.
   */
  it("keeps a story approvable when the proposal before it could not be built", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });
    const conversation = await openedOn(`/items/${item.id}`);
    const { cardIds } = turn(conversation, {
      message: "Two of them.",
      questions: [],
      proposals: [
        { action: "amend", item: "EO-9999", why: "It does not exist.", title: "Never mind" },
        { action: "new_story", title: "The card you can see", body: "It happens on every run.", acceptance_criteria: ["it stops happening"], depends_on: [], touches: [] },
      ],
    });

    // One card and one rejection: the amendment said why it could not be
    // built (invariant #8) and left nothing to click.
    expect(cardIds).toHaveLength(1);

    const view = openAssist(handle.db).conversation;
    expect(view.messages.find((message) => message.id === cardIds[0])?.body).toContain("The card you can see");
    // The button says what this card does, not what the refused one
    // would have done.
    expect(view.messages.find((message) => message.id === cardIds[0])?.approves).toBe("items");

    const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(applied.problem).toBeNull();
    expect(applied.createdKeys).toHaveLength(1);
  });

  /**
   * A draft that could not be rendered must not cost the work beside it.
   *
   * A turn on a page with no pipeline can still propose a graph, and that
   * card is posted as a rejection carrying the reason. Reading "which
   * card is the draft" as "the last proposal card" then named the
   * decomposition next to it — which was offered Publish, refused by the
   * approve path for being a draft and refused by the publish path for
   * having no pipeline. Unusable in both directions.
   */
  it("keeps a decomposition approvable when the draft beside it could not be rendered", async () => {
    // Settings is not a board, so the graph is refused there.
    const conversation = await openedOn("/settings");
    const { cardIds } = turn(conversation, {
      message: "Both, then.",
      questions: [],
      proposals: [A_STORY],
      draft: graphWithQa(),
    });

    // One card, and it is the story. The graph is a rejection saying why
    // (invariant #8), not something with a button on it.
    expect(cardIds).toHaveLength(1);
    expect(listCommentsForItem(handle.db, conversation.id).some((comment) => comment.kind === "rejection")).toBe(true);

    const view = openAssist(handle.db).conversation;
    expect(view.messages.find((message) => message.id === cardIds[0])?.approves).toBe("items");

    const applied = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(applied.applied).toBe(true);
    expect(applied.createdKeys.length).toBeGreaterThan(0);
  });

  /**
   * The screenshot's graph (EO-208): the shipped pipeline with two steps
   * simply not mentioned.
   *
   * Nothing in the draft says "remove these". `PipelineDraftSchema` is a
   * whole document and there is deliberately no patch form, so a step it
   * omits is a step it deletes — which is why a graph an agent invented
   * and a graph it derived are the same shape, and why EO has to ask
   * which one it is looking at.
   *
   * The entry moves to a step that survives, so the two removals are what
   * this case is about rather than a missing entry step.
   */
  function graphOmitting(...stepIds: string[]): PipelineDraft {
    const base = graphWithQa();
    const gone = new Set(stepIds);
    return {
      ...base,
      entryStepId: "todo",
      steps: base.steps.filter((step) => !gone.has(step.id)),
      routes: base.routes.filter((route) => !gone.has(route.fromStepId) && !gone.has(route.target)),
    };
  }

  /** Work parked where the screenshot had it: one on Worktree, eight on Done. */
  function fillTheBoard(): void {
    createTestItem(handle.db, { type: "story", title: "Being cut", stepId: "worktree" });
    for (let index = 0; index < 8; index += 1) {
      createTestItem(handle.db, { type: "story", title: `Finished ${index}`, stepId: "ready_to_merge" });
    }
  }

  /** Nothing on this screen has a button on it. The strongest form of "no card". */
  function offersNothing(): boolean {
    return openAssist(handle.db).conversation.messages.every((message) => !message.canApprove);
  }

  /** What EO said about the draft it threw away. */
  function refusalIn(conversation: Item): string {
    return listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "rejection")!.body;
  }

  /**
   * The load-bearing rule (EO-208): a draft must be derived from a graph
   * the run actually read.
   *
   * The graph here is the *good* one — the case below publishes it — so
   * nothing about its contents explains the refusal. What is missing is
   * the read, and the engine can see that for itself rather than take the
   * agent's word for it (invariant #5).
   */
  it("refuses a draft from a turn that never read the pipeline, whatever the graph says", async () => {
    const conversation = await openedOn("/pipelines/default");

    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: graphWithQa() }, undefined, null);

    // No card, and therefore no button: refused where it is rendered, not
    // where it is pressed.
    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    expect(
      listCommentsForItem(handle.db, conversation.id)
        .filter((comment) => comment.kind === "rejection")
        .map((comment) => comment.body)
        .join(" "),
    ).toContain("nothing in this turn read the pipeline it would replace");
  });

  /**
   * A refused draft has to be legible a week later (invariant #8).
   *
   * "EO refused a draft" and "EO refused a draft that would have emptied
   * Worktree and Done" are different facts, and only the second lets
   * somebody reading the thread tell an agent that proposed nothing from
   * one whose proposal EO threw away.
   */
  it("names what the refused draft would have removed", async () => {
    const conversation = await openedOn("/pipelines/default");
    fillTheBoard();

    turn(
      conversation,
      { message: "Here is the graph.", questions: [], proposals: [], draft: graphOmitting("worktree", "ready_to_merge") },
      undefined,
      null,
    );

    const refusal = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "rejection")!.body;
    expect(refusal).toContain("**Worktree**, holding 1 ticket");
    expect(refusal).toContain("**Done**, holding 8 tickets");
    // And what to do about it, named by server rather than by one
    // backend's punctuation (invariant #12).
    expect(refusal).toContain("`pipeline_get`");
    expect(refusal).toContain("`eo_admin`");
  });

  /**
   * The turn EO-208 was filed about, in the field it actually used.
   *
   * `AssistOutputSchema`'s refinement is the rule this needed — "a turn
   * either asks or proposes" — and it could not see this, because the
   * question was in `message` prose and `questions[]` was empty. The
   * output parses; the schema is unchanged and still says yes. What stops
   * it is the derivation rule, which does not care where the question was
   * written: an agent that could not read the graph has nothing to derive
   * a graph from.
   */
  it("gives no card to a turn that asked in prose and proposed a graph anyway", async () => {
    const conversation = await openedOn("/pipelines/default");
    const output: AssistReply = {
      message: "I cannot inspect the screen. Which ticket or pipeline should I identify?",
      questions: [],
      proposals: [],
      draft: graphWithQa(),
    };

    // The guard that was supposed to catch this still passes it, which is
    // the whole point of fixing it somewhere else.
    expect(AssistOutputSchema.safeParse(output).success).toBe(true);

    const { cardIds } = turn(conversation, output, undefined, null);

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
  });

  /**
   * The navigation this gate would otherwise miss.
   *
   * The panel stays open across a walk (EO-193) and the draft stays
   * pinned to the board the person *asked* from (`assistBoardFor`), so a
   * turn can read somebody else's board while the graph it is writing
   * would overwrite this one. A gate that accepted any read at all would
   * have exactly EO-208's hole, one board along — and the refusal names
   * which board it did read, because an agent told only "you read
   * nothing" would go and write the same graph again.
   */
  it("refuses a draft from a turn that read another pipeline", async () => {
    const conversation = await openedOn("/pipelines/default");
    // A real second board, because this is the walk it models: two
    // pipelines exist, the person asked on one and wandered to the other.
    const other = createPipeline(handle.db, { name: "Delivery" });

    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: graphWithQa() }, undefined, {
      tool: PIPELINE_READ,
      pipelineId: other.id,
    });

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    expect(refusalIn(conversation)).toContain(`this turn read \`${other.id}\`, which is not the board the graph would replace`);
  });

  /**
   * Reading the screen is a read, and it is not this evidence.
   *
   * `view_current` answers about wherever the person is at the moment it
   * is called and takes no pipeline id, so nothing in the log ties its
   * answer to the board a draft is pinned to — and what it returned is
   * bounded on its way into `run_events`, so the line that names the
   * board is gone from any pipeline big enough to matter. The refusal
   * says which read it wants instead, and names the board's id, because
   * the tool takes one.
   */
  it("refuses a draft from a turn that only read the screen", async () => {
    const conversation = await openedOn("/pipelines/default");

    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: graphWithQa() }, undefined, {
      tool: SCREEN_READ,
    });

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    const refusal = refusalIn(conversation);
    expect(refusal).toContain("Reading the screen is not enough");
    expect(refusal).toContain("`pipeline_get` for `default`");
  });

  /**
   * The evidence has to come from EO's own server.
   *
   * Matching the end of a tool id — anything called `pipeline_get` —
   * left a hole big enough to walk a whole-graph replacement through: a
   * successful call to an unrelated server's same-named tool, carrying
   * the pinned board's id, and the card appears without EO's graph ever
   * having reached the agent.
   */
  it("refuses a draft whose only read was another server's tool of the same name", async () => {
    const conversation = await openedOn("/pipelines/default");

    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: graphWithQa() }, undefined, {
      tool: ANOTHER_SERVERS_READ,
      pipelineId: "default",
    });

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    expect(refusalIn(conversation)).toContain("nothing in this turn read the pipeline it would replace");
  });

  /**
   * The second line of defence, at the point that matters.
   *
   * These three sentences are `validatePipeline`'s, and they are what the
   * person in EO-208 was shown. Every one of them is knowable when the
   * card is rendered, so this turn *did* read the graph — the derivation
   * rule is satisfied and the refusal is about the graph itself.
   */
  it("refuses a graph that omits steps holding items when the card is rendered, not when Publish is pressed", async () => {
    const conversation = await openedOn("/pipelines/default");
    fillTheBoard();

    const { cardIds } = turn(conversation, {
      message: "Here is the graph.",
      questions: [],
      proposals: [],
      draft: graphOmitting("worktree", "ready_to_merge"),
    });

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    const refusal = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "rejection")!.body;
    expect(refusal).toContain("Worktree has 1 item on it");
    expect(refusal).toContain("Done has 8 items on it");
  });

  /** The tell that a graph was invented: nobody editing a real pipeline picks the terminal step as the entry. */
  it("refuses a draft whose entry step is terminal, at the same point", async () => {
    const conversation = await openedOn("/pipelines/default");

    const { cardIds } = turn(conversation, {
      message: "Here is the graph.",
      questions: [],
      proposals: [],
      draft: { ...graphWithQa(), entryStepId: "ready_to_merge" },
    });

    expect(cardIds).toEqual([]);
    expect(offersNothing()).toBe(true);
    expect(listCommentsForItem(handle.db, conversation.id).find((comment) => comment.kind === "rejection")!.body).toContain(
      "Work cannot enter at a terminal step",
    );
  });

  /**
   * Invariant #12, where it would otherwise fail silently.
   *
   * The same read, spelled the way Codex reports it. A derivation check
   * written around Claude Code's punctuation would refuse every draft
   * raised on the other backend and no test built on one spelling could
   * tell — the graph, the card and the publish path are identical.
   */
  it("takes the other backend's spelling of the same read as the same read", async () => {
    const conversation = await openedOn("/pipelines/default");

    const { cardIds } = turn(
      conversation,
      { message: "Adds a QA step.", questions: [], proposals: [], draft: graphWithQa() },
      undefined,
      { tool: PIPELINE_READ_ON_CODEX, pipelineId: "default" },
    );

    expect(cardIds).toHaveLength(1);
    expect(readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! }).problem).toBeNull();
  });

  it("hands a draft back as the graph pipeline:save takes, and publishing it writes that graph", async () => {
    const conversation = await openedOn("/pipelines/default");
    const { cardIds } = turn(conversation, { message: "Adds a QA step.", questions: [], proposals: [], draft: graphWithQa() });

    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds.at(-1)! });

    expect(read.problem).toBeNull();
    expect(read.pipelineId).toBe("default");
    expect(read.steps.map((step) => step.name)).toContain("QA");
    // Every field `pipeline:save` demands, filled by EO rather than by a
    // renderer that has never read them.
    for (const step of read.steps) {
      expect(step.pipelineId).toBe("default");
      expect(step.inputs).toEqual({});
      expect(step.timeoutMs).toBeNull();
    }

    // And it publishes through the channel the configuration screen uses,
    // not through a second path of its own.
    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
    const saved = await dispatchIpc("pipeline:save", {
      pipelineId: read.pipelineId,
      steps: read.steps,
      routes: read.routes,
      entryStepId: read.entryStepId,
    });

    expect(saved).toMatchObject({ ok: true });
    expect(listStepsForPipeline(handle.db, "default").map((step) => step.name)).toContain("QA");
  });

  it("carries a module step's configured inputs and timeout across, and drops what a kind cannot hold", async () => {
    // A tuned installation: a module step with a value somebody set and a
    // limit somebody raised because their CI is slow.
    const module = saveModule(handle.db, {
      slug: "deploy",
      name: "Deploy",
      description: "Ships the branch.",
      code: "export default async () => ({ result: 'shipped' });",
      manifest: {
        name: "Deploy",
        description: "Ships the branch.",
        inputs: { environment: { type: "string" } },
        needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
        results: ["shipped"],
      },
      approve: true,
    });
    expect(module.ok).toBe(true);
    const moduleId = module.ok ? module.module.id : "";

    const base = graphWithQa();
    replacePipelineGraph(
      handle.db,
      "default",
      [
        ...base.steps
          .filter((step) => step.id !== "qa")
          .map((step) => ({ ...step, pipelineId: "default" as Uuid, inputs: {}, timeoutMs: null })),
        {
          pipelineId: "default" as Uuid,
          id: "ship",
          position: base.steps.length,
          name: "Ship",
          type: "module" as const,
          ownerRole: null,
          entryAction: moduleId,
          instructionsSummary: null,
          isTerminal: false,
          planMode: false,
          inputs: { environment: "production", gone: "stale" },
          timeoutMs: 900_000,
        },
      ],
      base.routes.filter((route) => route.fromStepId !== "qa").map((route) => ({ ...route, pipelineId: "default" as Uuid })),
    );

    const conversation = await openedOn("/pipelines/default");
    // The QA step is what makes this a change at all; `ship` is carried
    // across untouched, which is the property under test.
    const { cardIds } = turn(conversation, { message: "Adds a QA step.", questions: [], proposals: [], draft: graphWithQa() });

    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds.at(-1)! });
    const ship = read.steps.find((step) => step.id === "ship")!;

    // Kept, because a draft is not asked for either and one that omitted
    // them would read as "set nothing" (EO-78, EO-162)…
    expect(ship.timeoutMs).toBe(900_000);
    expect(ship.inputs).toEqual({ environment: "production" });
    // …minus the value the module it runs does not declare, which is not
    // that module's anything.
    expect(ship.inputs["gone"]).toBeUndefined();
  });

  /**
   * AC (EO-516): an existing builtin step's inputs and keep checking are
   * carried across a draft that does not mention them. Before, Publish
   * wrote `{}` as every non-module step's inputs, so a draft of the
   * shipped pipeline quietly turned the pull request watch's `ready` off.
   */
  it("carries a builtin step's inputs and keep checking across a draft that says nothing about them", async () => {
    replacePipelineGraph(
      handle.db,
      "default",
      listStepsForPipeline(handle.db, "default").map((step) =>
        step.id === "pull_request_watch" ? { ...step, inputs: { reportReady: true }, watch: { everyMinutes: 15, giveUpAfterHours: 48 } } : step,
      ),
      listRoutesForPipeline(handle.db, "default"),
    );

    const conversation = await openedOn("/pipelines/default");
    const draft = graphWithQa();
    // The draft names the watch step, and says nothing about either.
    const named = draft.steps.find((step) => step.id === "pull_request_watch");
    expect(named).toBeDefined();
    expect(named).not.toHaveProperty("watch");
    expect(named).not.toHaveProperty("inputs");
    const { cardIds } = turn(conversation, { message: "Adds a QA step.", questions: [], proposals: [], draft });

    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds.at(-1)! });
    expect(read.problem).toBeNull();
    expect(read.steps.find((step) => step.id === "pull_request_watch")).toMatchObject({
      inputs: { reportReady: true },
      watch: { everyMinutes: 15, giveUpAfterHours: 48 },
    });

    registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
    expect(await dispatchIpc("pipeline:save", { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId })).toMatchObject({
      ok: true,
    });
    expect(listStepsForPipeline(handle.db, "default").find((step) => step.id === "pull_request_watch")).toMatchObject({
      inputs: { reportReady: true },
      watch: { everyMinutes: 15, giveUpAfterHours: 48 },
    });
  });

  /**
   * The walk, mid-turn (EO-193).
   *
   * The panel stays open across a navigation — that is the whole premise
   * of one thread — so this is an ordinary thing to do: ask for a graph
   * on a board, wander off, and send a follow-up while the first turn is
   * still thinking. Read as "wherever the conversation is now", that
   * first turn's draft would render against Settings and be refused; on
   * another board it would be *published there*, over a graph nobody was
   * looking at. The board belongs to the exchange, so the answer does not
   * move when the person does.
   */
  it("renders and publishes a pending turn's draft against the board it was asked from", async () => {
    const conversation = await openedOn("/pipelines/default");
    const asked = newestQuestion(conversation);

    // The follow-up, from a screen that is not a board, while the first
    // turn is still running.
    await send("/settings", "and how long may a run take?", conversation.id);

    const { cardIds } = turn(conversation, { message: "Adds a QA step.", questions: [], proposals: [], draft: graphWithQa() }, asked);

    // A card with a Publish button on it, not a rejection saying the
    // assistant is not on a board.
    expect(cardIds).toHaveLength(1);
    expect(listCommentsForItem(handle.db, conversation.id).some((comment) => comment.kind === "rejection")).toBe(false);

    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds.at(-1)! });
    expect(read.problem).toBeNull();
    expect(read.pipelineId).toBe("default");
    expect(read.steps.map((step) => step.name)).toContain("QA");
  });

  /**
   * The same property, past any number a cap could have been set to.
   *
   * The composer takes another message while a turn is thinking — that is
   * how you correct yourself mid-question — so "how many messages later"
   * is not a thing the board of a pending turn may depend on. This sends
   * ten, alternating screens so that not one of them says the same thing
   * as the entry before it and nothing can be collapsed away: whatever is
   * kept, the board that turn was asked from has to be among it.
   */
  it("keeps a pending turn's board through more messages than a cap would have kept", async () => {
    const conversation = await openedOn("/pipelines/default");
    const asked = newestQuestion(conversation);

    for (let index = 0; index < 10; index += 1) {
      await send(index % 2 === 0 ? "/settings" : "/pipelines/default", `and another thing ${index}`, conversation.id);
    }

    // Nothing was thrown away to make room: the entries outnumber any
    // fixed count this could have been pruned to.
    expect(assistBoards(rowOf(conversation.id)).length).toBeGreaterThan(8);

    const { cardIds } = turn(conversation, { message: "Adds a QA step.", questions: [], proposals: [], draft: graphWithQa() }, asked);

    // A card, not a rejection saying the graph was raised nowhere…
    expect(cardIds).toHaveLength(1);
    expect(listCommentsForItem(handle.db, conversation.id).some((comment) => comment.kind === "rejection")).toBe(false);
    // …and pressing Publish on it works, which is the half that a card
    // offered and then refused would have failed.
    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds.at(-1)! });
    expect(read.problem).toBeNull();
    expect(read.pipelineId).toBe("default");
  });

  /**
   * The other half of the same rule: a graph asked for on Settings is
   * refused there, however many boards have been visited since. Without
   * this the pair would be satisfied by a lookup that always answered
   * with the oldest board it could find.
   */
  it("still refuses a draft asked for from a screen that is not a board, after a walk onto one", async () => {
    const conversation = await openedOn("/settings");
    const asked = newestQuestion(conversation);

    await send("/pipelines/default", "and what is on this board?", conversation.id);

    const { cardIds } = turn(conversation, { message: "That would need a new step.", questions: [], proposals: [], draft: graphWithQa() }, asked);

    expect(cardIds).toEqual([]);
    expect(
      listCommentsForItem(handle.db, conversation.id)
        .filter((comment) => comment.kind === "rejection")
        .map((comment) => comment.body)
        .join(" "),
    ).toContain("not raised on a pipeline's board");
  });

  it("refuses a draft the agent has since revised", async () => {
    const conversation = await openedOn("/pipelines/default");
    const first = turn(conversation, { message: "One graph.", questions: [], proposals: [], draft: graphWithQa() });
    turn(conversation, { message: "A better graph.", questions: [], proposals: [], draft: graphWithQa() });

    const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: first.cardIds.at(-1)! });

    expect(read.pipelineId).toBeNull();
    expect(read.steps).toEqual([]);
    expect(read.problem).toContain("superseded");
  });

  it("refuses an item that is not one of its conversations", () => {
    const item = createTestItem(handle.db, { type: "story", title: "Add rate limiting", stepId: "todo" });

    // An item id is an item id, and these channels take one. Without
    // the check, approving would read a card off somebody's story and
    // write a comment onto it.
    expect(() => approveAssistProposal(handle.db, undefined, { conversationId: item.id, messageId: item.id })).toThrow(
      /not an assist conversation/,
    );
    expect(() => readAssistDraftForPublish(handle.db, { conversationId: item.id, messageId: item.id })).toThrow(
      /not an assist conversation/,
    );
    expect(() =>
      answerAssistQuestions(handle.db, undefined, { conversationId: item.id, answers: [{ questionId: item.id, answer: "no" }] }),
    ).toThrow(/not an assist conversation/);
  });
});

/**
 * A pipeline built end to end from the assistant (EO-381).
 *
 * ASK-21's Release pipeline, asked for from Settings: a pipeline that
 * does not exist yet, a module step running a module that does not
 * exist yet, and that step's own time limit and inputs. One card, which
 * after the module is approved and Publish is pressed creates all of it.
 */
describe("a pipeline built from the chat", () => {
  // A pipeline goes on a project (EO-766). These chats are opened on none,
  // so what they publish goes on the oldest project: this one.
  beforeEach(() => {
    createProject(handle.db, { name: "Workbench", keyPrefix: "WRK" });
  });

  /** A succeeded `assist` run carrying `output`, its log holding `reads`, and what it posted. */
  function turn(conversation: Item, output: unknown, reads: ScriptedRead[] = []): { cardIds: Uuid[]; rejections: string[] } {
    const parsed: AssistOutput = AssistOutputSchema.parse(output);
    const agent = assistAgent(handle.db)!;
    const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: newestQuestion(conversation) });
    reads.forEach((read, index) => {
      const callId = `call-${index}`;
      appendRunEvent(handle.db, run.id, "tool_call", { name: read.tool, args: read.pipelineId === undefined ? {} : { pipelineId: read.pipelineId }, callId });
      appendRunEvent(handle.db, run.id, "tool_result", { name: read.tool, callId, ok: true, output: "", truncated: false });
    });
    updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(parsed), parsed } });
    postAssistReply(handle.db, conversation, agent.id, run.id, parsed);
    const posted = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.runId === run.id);
    return {
      cardIds: posted.filter((comment) => comment.kind === PROPOSAL_KIND).map((comment) => comment.id),
      rejections: posted.filter((comment) => comment.kind === "rejection").map((comment) => comment.body),
    };
  }

  /** The merge module ASK-21 needed, in the Architecture panel's shape, tests and all. */
  const MERGE_MODULE = {
    name: "Release merge",
    slug: "release-merge",
    description: "Merges the release branch once CI is green.",
    code: "export default async () => ({ ok: true, result: 'merged' });",
    manifest: {
      name: "Release merge",
      description: "Merges the release branch once CI is green.",
      inputs: { ciWaitSeconds: { type: "number" } },
      results: ["merged"],
    },
    why: "Before agents existed this was a script.",
    tests: [{ description: "merges", source: "export default async function (harness) { await harness.run({}); }" }],
  };

  const FIFTY_EIGHT_MINUTES = 58 * 60 * 1000;

  /** A two-step Release pipeline: the merge module, then a person. */
  function releaseDraft(target: Record<string, string>, merge: Record<string, unknown> = {}) {
    return {
      rationale: "A release pipeline: merge once CI is green, then hand over.",
      entryStepId: "release_merge",
      target,
      steps: [
        {
          id: "release_merge",
          position: 0,
          name: "Merge",
          type: "module",
          ownerRole: null,
          entryAction: "release-merge",
          instructionsSummary: null,
          isTerminal: false,
          planMode: false,
          timeoutMs: FIFTY_EIGHT_MINUTES,
          inputs: { ciWaitSeconds: 2400 },
          ...merge,
        },
        { id: "release_done", position: 1, name: "Released", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
      ],
      routes: [{ fromStepId: "release_merge", resultKey: "merged", label: "Merged", tone: "success", target: "release_done", position: 0 }],
    };
  }

  /** A run timeout long enough for the step to ask for 58 minutes — the bound a step's own limit is held under (EO-162). */
  function allowAnHourPerRun(): void {
    setSetting(handle.db, GUARDS_KEY, { ...DEFAULT_GUARD_CONFIG, wallClockTimeoutMs: 60 * 60 * 1000 });
  }

  /**
   * A person approving a module some time after it was saved — which is
   * when anybody does: approving runs the tests first. Stamped later
   * explicitly, because a case written in the same millisecond as an
   * approval is not treated as covered by it, and a test that saves and
   * approves back to back would land there by accident.
   */
  function approvedLater(moduleId: string): void {
    approveModule(handle.db, moduleId, Date.now() + 1_000);
  }

  function pipelinesNamed(name: string) {
    return listPipelines(handle.db).filter((pipeline) => pipeline.name === name);
  }

  /** AC: the whole story, driven through `assistDraftForPublish` and Publish. */
  it("creates the pipeline, its module step's limit and inputs, once the module is approved and Publish is pressed", async () => {
    allowAnHourPerRun();
    const conversation = await openedOn("/settings");

    // Nothing to read: the pipeline does not exist, so there is no graph
    // a draft could delete from.
    const { cardIds, rejections } = turn(conversation, {
      message: "Here is the Release pipeline.",
      draft: releaseDraft({ newPipeline: "Release" }),
      modules: [MERGE_MODULE],
    });
    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === cardIds[0])!;
    expect(card.body).toContain("**New pipeline** Release");
    expect(card.body).toContain("**New module** Release merge");
    expect(card.body).toContain("may run 58 min");
    expect(card.body).toContain("`ciWaitSeconds` = 2400");

    // The module is saved, unapproved, with its tests; the pipeline is not
    // created — that waits for Publish.
    const saved = listModules(handle.db).find((module) => module.slug === "release-merge")!;
    expect(saved.approvedAt).toBeNull();
    expect(listModuleTests(handle.db, saved.id).map((test) => test.description)).toEqual(["merges"]);
    expect(pipelinesNamed("Release")).toEqual([]);

    // The draft is read with its graph and the module it is waiting on
    // (EO-399); Publish is refused until that module is approved, and
    // says which.
    const waiting = assistDraftForPublish(handle.db, rowOf(conversation.id), cardIds[0]!);
    expect(waiting).toMatchObject({ ok: true, waiting: [{ id: saved.id, slug: "release-merge", name: "Release merge", state: "unapproved" }] });
    expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({
      saved: false,
      pipelineId: null,
      problem: expect.stringContaining('Publish is waiting on "Release merge"'),
    });
    expect(pipelinesNamed("Release")).toEqual([]);

    // A person approves it.
    approvedLater(saved.id);

    const graph = assistDraftForPublish(handle.db, rowOf(conversation.id), cardIds[0]!);
    expect(graph.ok && graph.waiting).toEqual([]);
    expect(graph.ok && graph.newPipelineName).toBe("Release");
    expect(graph.ok && graph.pipelineId).toBeNull();
    const merge = graph.ok ? graph.steps.find((step) => step.id === "release_merge") : undefined;
    // Named by slug in the draft, by id on the step that is published.
    expect(merge).toMatchObject({ entryAction: saved.id, timeoutMs: FIFTY_EIGHT_MINUTES, inputs: { ciWaitSeconds: 2400 } });

    const drawn = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(drawn).toMatchObject({ pipelineId: null, newPipelineName: "Release", problem: null });

    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(published).toMatchObject({ saved: true, problem: null });

    const [release] = pipelinesNamed("Release");
    expect(release?.id).toBe(published.pipelineId);
    expect(release?.projectId).toBe(rowOf(conversation.id).projectId);
    expect(release?.entryStepId).toBe("release_merge");
    const steps = listStepsForPipeline(handle.db, release!.id);
    expect(steps.map((step) => step.id)).toEqual(["release_merge", "release_done"]);
    expect(steps[0]).toMatchObject({ entryAction: saved.id, timeoutMs: FIFTY_EIGHT_MINUTES, inputs: { ciWaitSeconds: 2400 } });
    expect(listRoutesForPipeline(handle.db, release!.id).map((route) => [route.fromStepId, route.resultKey, route.target])).toEqual([
      ["release_merge", "merged", "release_done"],
    ]);
  });

  it("goes through the channel the renderer calls, and announces nothing it did not do", async () => {
    allowAnHourPerRun();
    const conversation = await openedOn("/settings");
    const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
    approvedLater(listModules(handle.db).find((module) => module.slug === "release-merge")!.id);

    registerHandler("assist:publishNew", (payload) => publishNewAssistPipeline(handle.db, undefined, payload), opts);
    const response = await dispatchIpc("assist:publishNew", { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(response).toMatchObject({ ok: true, data: { saved: true } });
    expect(pipelinesNamed("Release")).toHaveLength(1);
  });

  /**
   * A chat opened before any project existed publishes onto the oldest
   * (EO-766); with no project but the gallery's Preview there is nowhere
   * to put a pipeline, and the publish says so and writes nothing.
   */
  it("puts what a chat with no project publishes on the oldest project, and refuses it where there is none", async () => {
    allowAnHourPerRun();
    const workbench = listProjects(handle.db)[0]!;
    const conversation = await openedOn("/settings");
    handle.db.update(items).set({ projectId: null }).where(eq(items.id, conversation.id)).run();
    const { cardIds } = turn(getItem(handle.db, conversation.id)!, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
    approvedLater(listModules(handle.db).find((module) => module.slug === "release-merge")!.id);

    // Only Preview, as far as a pipeline is concerned.
    setSetting(handle.db, PREVIEW_PROJECT_KEY, workbench.id);
    const before = listPipelines(handle.db, undefined, true).length;
    const refused = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(refused).toMatchObject({ saved: false, pipelineId: null, problem: `Nothing was created: ${PIPELINE_NEEDS_PROJECT}` });
    expect(listPipelines(handle.db, undefined, true)).toHaveLength(before);

    // A real project again, and a newer one on screen: the oldest still gets it.
    clearSetting(handle.db, PREVIEW_PROJECT_KEY);
    const later = createProject(handle.db, { name: "Later", keyPrefix: "LAT" });
    setSetting(handle.db, ACTIVE_PROJECT_KEY, later.id);
    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(published).toMatchObject({ saved: true, problem: null });
    expect(getPipeline(handle.db, published.pipelineId!)?.projectId).toBe(workbench.id);
  });

  it("refuses a name another pipeline on the project already has, as pipeline_manage does", async () => {
    allowAnHourPerRun();
    const conversation = await openedOn("/settings");
    const existing = createPipeline(handle.db, { projectId: rowOf(conversation.id).projectId, name: "Release" });

    // Matched trimmed and case-insensitively, as placement matches it.
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: " release " }), modules: [MERGE_MODULE] });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain(`already has a pipeline called "Release" (id: ${existing.id})`);
    // A refused card saves no module either.
    expect(listModules(handle.db).some((module) => module.slug === "release-merge")).toBe(false);
  });

  /** EO-765: switching project switches chat, so the draft is the new project's. */
  it("checks a pipeline drafted after switching project against that project, and publishes it there", async () => {
    allowAnHourPerRun();
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    setSetting(handle.db, "ui.activeProjectId", shop.id);
    const onShop = await openedOn("/settings");
    expect(onShop.projectId).toBe(shop.id);
    // A's own Release would clash on A, and is no business of B's.
    createPipeline(handle.db, { projectId: shop.id, name: "Release" });
    const blog = createProject(handle.db, { name: "Blog", keyPrefix: "BLOG" });
    setSetting(handle.db, "ui.activeProjectId", blog.id);

    const conversation = await openedOn("/settings");
    expect(conversation.id).not.toBe(onShop.id);
    expect(conversation.projectId).toBe(blog.id);
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
    expect(rejections).toEqual([]);
    approvedLater(listModules(handle.db).find((module) => module.slug === "release-merge")!.id);

    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(published).toMatchObject({ saved: true, problem: null });
    expect(pipelinesNamed("Release").find((pipeline) => pipeline.id === published.pipelineId)?.projectId).toBe(blog.id);
  });

  it("refuses at Publish a name somebody took after the card was drawn, and creates nothing", async () => {
    allowAnHourPerRun();
    const conversation = await openedOn("/settings");
    const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
    approvedLater(listModules(handle.db).find((module) => module.slug === "release-merge")!.id);

    createPipeline(handle.db, { projectId: rowOf(conversation.id).projectId, name: "Release" });
    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

    expect(published).toMatchObject({ saved: false, pipelineId: null, problem: expect.stringContaining("already has a pipeline called") });
    expect(pipelinesNamed("Release")).toHaveLength(1);
  });

  it("refuses a new pipeline whose step ids another pipeline already holds, before the database would", async () => {
    const conversation = await openedOn("/settings");
    const draft = releaseDraft({ newPipeline: "Release" }, { id: "todo", timeoutMs: undefined, inputs: undefined });
    const { cardIds, rejections } = turn(conversation, {
      message: "Here.",
      draft: { ...draft, entryStepId: "todo", routes: [{ ...draft.routes[0], fromStepId: "todo" }] },
      modules: [MERGE_MODULE],
    });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain("cannot reuse step ids another pipeline already has: `todo`");
  });

  /**
   * The step's own limit, judged against the run timeout `savePipeline`
   * judges it against — not EO's ten-minute default, which would refuse
   * every limit the card is for.
   */
  it("judges a new step's time limit against the configured run timeout", async () => {
    const conversation = await openedOn("/settings");
    // Thirty minutes per run: 58 is more than a run may take.
    setSetting(handle.db, GUARDS_KEY, { wallClockTimeoutMs: 30 * 60 * 1000 });
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain('"Merge" may run for');
    expect(rejections.join(" ")).toContain("longer than the run timeout");

    allowAnHourPerRun();
    expect(turn(conversation, { message: "Again.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] }).cardIds).toHaveLength(1);
  });

  it("refuses inputs a new step's module does not declare, naming what it does", async () => {
    allowAnHourPerRun();
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, {
      message: "Here.",
      draft: releaseDraft({ newPipeline: "Release" }, { inputs: { ciWait: 2400 } }),
      modules: [MERGE_MODULE],
    });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain('sets `ciWait`, which "Release merge" does not declare');
    expect(rejections.join(" ")).toContain("`ciWaitSeconds`");
  });

  /**
   * A pull request watch proposed from the chat (EO-516). Since EO-505 a
   * function made to be checked cannot be published on a step that runs
   * once, so a draft that could not say `watch` could not propose one at
   * all — and without `inputs` on a builtin it could not say `reportReady`.
   */
  function watchDraft(target: Record<string, string>, watcher: Record<string, unknown> = {}) {
    const elsewhere = ["closed", "conflict", "checks_failed", "changes_requested", "ready", "failed"];
    return {
      rationale: "Watch the pull request until it is merged, and say when it is ready.",
      entryStepId: "pr_watch",
      target,
      steps: [
        {
          id: "pr_watch",
          position: 0,
          name: "Watching",
          type: "builtin",
          ownerRole: null,
          entryAction: "watch_pull_request",
          instructionsSummary: null,
          isTerminal: false,
          planMode: false,
          watch: { everyMinutes: 10, giveUpAfterHours: 72 },
          inputs: { reportReady: true },
          ...watcher,
        },
        { id: "pr_done", position: 1, name: "Merged", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
      ],
      routes: [
        { fromStepId: "pr_watch", resultKey: "merged", label: "Merged", tone: "success", target: "pr_done", position: 0 },
        ...elsewhere.map((resultKey, index) => ({ fromStepId: "pr_watch", resultKey, label: resultKey, tone: "warning", target: "user_attention", position: index + 1 })),
      ],
    };
  }

  /** AC: a created `watch_pull_request` step keeps checking with the draft's values and its `reportReady`. */
  it("publishes a new pull request watch that keeps checking, with the interval and reportReady the draft set", async () => {
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, { message: "Here is the watch.", draft: watchDraft({ newPipeline: "Watch" }) });
    expect(rejections).toEqual([]);
    expect(cardIds).toHaveLength(1);
    // What Publish agrees to is on the card.
    const card = listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === cardIds[0])!;
    expect(card.body).toContain("checks every 10 minutes · gives up after 3 days");
    expect(card.body).toContain("`reportReady` = true");

    const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
    expect(published).toMatchObject({ saved: true, problem: null });

    const [watching] = listStepsForPipeline(handle.db, published.pipelineId!);
    expect(watching).toMatchObject({
      id: "pr_watch",
      type: "builtin",
      entryAction: "watch_pull_request",
      watch: { everyMinutes: 10, giveUpAfterHours: 72 },
      inputs: { reportReady: true },
    });
  });

  it("refuses a new pull request watch that runs once, as the validator refuses one anywhere", async () => {
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: watchDraft({ newPipeline: "Watch" }, { watch: undefined }) });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain('"Watching"');
  });

  /** AC: an undeclared builtin input is refused by name, as an undeclared module input is. */
  it("refuses an input a new builtin step's function does not declare, naming what it does", async () => {
    const conversation = await openedOn("/settings");
    const { cardIds, rejections } = turn(conversation, {
      message: "Here.",
      draft: watchDraft({ newPipeline: "Watch" }, { inputs: { reportReady: true, mergeWhenGreen: true } }),
    });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain("sets `mergeWhenGreen`, which `watch_pull_request` does not declare");
    expect(rejections.join(" ")).toContain("It declares `reportReady`");
    expect(pipelinesNamed("Watch")).toEqual([]);
  });

  it("still refuses inputs on a step that runs neither a module nor a builtin", async () => {
    const conversation = await openedOn("/settings");
    const draft = watchDraft({ newPipeline: "Watch" });
    const { cardIds, rejections } = turn(conversation, {
      message: "Here.",
      draft: { ...draft, steps: draft.steps.map((step) => (step.id === "pr_done" ? { ...step, inputs: { reportReady: true } } : step)) },
    });

    expect(cardIds).toEqual([]);
    expect(rejections.join(" ")).toContain("**Merged** sets `inputs`, which only a module or builtin step has");
  });

  /**
   * The module on the card, the module a person approves and the module
   * a step runs are one module (EO-381 review).
   *
   * A step names a proposed module by slug, and Publish resolves that
   * slug against the catalog. So a slug the catalog already holds as
   * something else would publish code no card described — approved, for
   * all anybody could tell, because somebody approved the *other* one.
   */
  /**
   * A module asked for on its own (EO-398): a proposal like any other.
   * Saved unapproved with its tests, and offered as a card per module
   * that says which module it is for — and nothing else about it, since
   * the card reads the catalog.
   */
  describe("a module proposed with no draft", () => {
    const NOTIFY_MODULE = {
      ...MERGE_MODULE,
      name: "Notify release",
      slug: "notify-release",
      description: "Posts the release note.",
      manifest: { ...MERGE_MODULE.manifest, name: "Notify release", description: "Posts the release note." },
      tests: [
        { description: "posts the note", source: "export default async function (harness) { await harness.run({}); }" },
        { description: "says nothing when there is no note", source: "export default async function (harness) { await harness.run({ note: '' }); }" },
      ],
    };

    function messageOf(id: string) {
      return openAssist(handle.db).conversation.messages.find((message) => message.id === id)!;
    }

    it("saves each one unapproved with every test case, and posts a card for each naming its module", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Two modules.", modules: [MERGE_MODULE, NOTIFY_MODULE] });

      expect(rejections).toEqual([]);
      expect(cardIds).toHaveLength(2);
      const catalog = listModules(handle.db);
      const merge = catalog.find((module) => module.slug === "release-merge")!;
      const notify = catalog.find((module) => module.slug === "notify-release")!;
      expect(merge).toMatchObject({ approvedAt: null, source: "architect", code: MERGE_MODULE.code });
      expect(notify.approvedAt).toBeNull();
      expect(listModuleTests(handle.db, merge.id).map((test) => test.description)).toEqual(["merges"]);
      expect(listModuleTests(handle.db, notify.id).map((test) => test.description)).toEqual(["posts the note", "says nothing when there is no note"]);

      // Each card says which module it is for, in the order the turn gave them.
      expect(messageOf(cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: "release-merge" });
      expect(messageOf(cardIds[1]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: "notify-release" });
      // And reads as an ordinary message naming it, for the layout that draws no card.
      expect(messageOf(cardIds[0]!).body).toContain("**New module** Release merge (`release-merge`)");
      // The turn's own message is not a card.
      const note = openAssist(handle.db).conversation.messages.find((message) => message.body === "Two modules.")!;
      expect(note).toMatchObject({ approves: null, moduleSlug: null });
    });

    it("says the catalog changed, so a list already on screen shows the module", async () => {
      const conversation = await openedOn("/settings");
      const agent = assistAgent(handle.db)!;
      const output = AssistOutputSchema.parse({ message: "Here.", modules: [MERGE_MODULE] });
      const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: newestQuestion(conversation) });
      updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });

      expect(postAssistReply(handle.db, conversation, agent.id, run.id, output)).toEqual({ modulesSaved: true });
    });

    it("keeps a work proposal from the same turn a work proposal", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds } = turn(conversation, {
        message: "Work, and a module.",
        proposals: [
          {
            action: "new_feature",
            title: "Rate limiting",
            understanding: "Cap what one key can do per minute.",
            decisions: [],
            stories: [{ title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts are per key"], depends_on: [], touches: [] }],
          },
        ],
        modules: [MERGE_MODULE],
      });

      expect(cardIds).toHaveLength(2);
      expect(messageOf(cardIds[0]!)).toMatchObject({ approves: "items", moduleSlug: null });
      expect(messageOf(cardIds[1]!)).toMatchObject({ approves: "module", moduleSlug: "release-merge" });
    });

    it("still says which module a card is for after a newer turn has taken its place", async () => {
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const second = turn(conversation, { message: "And another.", modules: [NOTIFY_MODULE] });

      expect(messageOf(first.cardIds[0]!)).toMatchObject({ canApprove: false, approves: null, moduleSlug: "release-merge" });
      expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: "notify-release" });
    });

    it("posts a rejection carrying the reason when the slug is held by different code, and saves nothing", async () => {
      const held = saveModule(handle.db, {
        slug: MERGE_MODULE.slug,
        name: "Old merge",
        description: "Merges without waiting for CI.",
        code: "export default async () => ({ ok: true, result: 'merged' }); // force-pushes",
        manifest: AssistOutputSchema.parse({ message: "x", modules: [MERGE_MODULE] }).modules![0]!.manifest,
        approve: true,
      });
      if (!held.ok) throw new Error(held.reason);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Two modules.", modules: [NOTIFY_MODULE, MERGE_MODULE] });

      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain("No module was saved.");
      expect(rejections[0]).toContain(`which the module "Old merge" (id: ${held.module.id}) already holds`);
      // All or none: the module with nothing wrong with it is not written either.
      expect(listModules(handle.db).map((module) => module.slug)).toEqual([MERGE_MODULE.slug]);
      expect(listModules(handle.db)[0]).toMatchObject({ id: held.module.id, code: held.module.code, name: "Old merge" });
      expect(listModuleTests(handle.db, held.module.id)).toEqual([]);
      expect(openAssist(handle.db).conversation.messages.every((message) => message.moduleSlug === null)).toBe(true);
    });

    it("offers a card for a module the catalog already holds as the same module, and writes nothing over it", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const saved = listModules(handle.db).find((module) => module.slug === MERGE_MODULE.slug)!;
      approvedLater(saved.id);

      const again = turn(conversation, { message: "Here it is again.", modules: [MERGE_MODULE] });

      expect(again.rejections).toEqual([]);
      expect(messageOf(again.cardIds[0]!)).toMatchObject({ moduleSlug: MERGE_MODULE.slug });
      const after = listModules(handle.db).filter((module) => module.slug === MERGE_MODULE.slug);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: saved.id, approvedAt: expect.any(Number) });
    });

    it("refuses the work-approval channel on a module card, and files nothing under it", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const before = listCommentsForItem(handle.db, conversation.id).length;

      const answer = approveAssistProposal(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

      expect(answer).toMatchObject({ applied: false, problem: expect.stringContaining("That card is a module") });
      expect(listCommentsForItem(handle.db, conversation.id)).toHaveLength(before);
      expect(listModules(handle.db)[0]!.approvedAt).toBeNull();
    });

    it("does not read a draft card as a module card", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

      expect(messageOf(cardIds[0]!)).toMatchObject({ approves: "pipeline", moduleSlug: null });
    });
  });

  describe("a proposed module whose slug the catalog already holds", () => {
    /** A module already in the catalog under the slug the draft proposes, approved, with code of its own. */
    function alreadyThere(code: string) {
      const saved = saveModule(handle.db, {
        slug: MERGE_MODULE.slug,
        name: "Old merge",
        description: "Merges without waiting for CI.",
        code,
        manifest: AssistOutputSchema.parse({ message: "x", draft: releaseDraft({ newPipeline: "X" }), modules: [MERGE_MODULE] }).modules![0]!.manifest,
        approve: true,
      });
      if (!saved.ok) throw new Error(saved.reason);
      return saved.module;
    }

    /**
     * Stamps an approval straight onto the row, as one given before
     * EO-498 stands: then, a case added afterwards left it in place. No
     * door does this now — any change to the cases withdraws it — but a
     * catalog can still hold such an approval, and the card's check of
     * when each case was written is what stands between it and Publish.
     */
    function approvedBeforeEo498(moduleId: string, at: number): void {
      handle.db.update(modulesTable).set({ approvedAt: at }).where(eq(modulesTable.id, moduleId)).run();
    }

    it("refuses the card when the code differs, and leaves the catalog's module as it was", async () => {
      allowAnHourPerRun();
      const held = alreadyThere("export default async () => ({ ok: true, result: 'merged' }); // force-pushes");
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain(`which the module "Old merge" (id: ${held.id}) already holds`);
      expect(rejections.join(" ")).toContain("give it another slug");
      const after = listModules(handle.db).find((module) => module.slug === MERGE_MODULE.slug)!;
      expect(after).toMatchObject({ id: held.id, code: held.code, name: "Old merge" });
      expect(listModuleTests(handle.db, held.id)).toEqual([]);
    });

    it("refuses the card when only the manifest differs", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      alreadyThere(MERGE_MODULE.code);

      const { cardIds, rejections } = turn(conversation, {
        message: "Here.",
        draft: releaseDraft({ newPipeline: "Release" }),
        modules: [{ ...MERGE_MODULE, manifest: { ...MERGE_MODULE.manifest, needs: { bin: ["gh"], env: [], network: true, item: false, comment: false, attach: false, create: false } } }],
      });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain("different code or a different manifest");
    });

    it("offers the card when it is the same module proposed again, tests and all, and publishes that one", async () => {
      allowAnHourPerRun();
      const held = alreadyThere(MERGE_MODULE.code);
      // The case was there when the module was approved, so that approval ran it.
      saveModuleTest(handle.db, { moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 1_000);
      approveModule(handle.db, held.id, 2_000);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

      expect(rejections).toEqual([]);
      const graph = assistDraftForPublish(handle.db, rowOf(conversation.id), cardIds[0]!);
      expect(graph.ok && graph.steps.find((step) => step.id === "release_merge")?.entryAction).toBe(held.id);
    });

    it("refuses the card when it shows a test case the catalog's module does not have, and writes none", async () => {
      allowAnHourPerRun();
      // Same code and manifest, approved — with no such case ever run.
      const held = alreadyThere(MERGE_MODULE.code);
      saveModuleTest(handle.db, { moduleId: held.id, description: "an older case", source: MERGE_MODULE.tests[0]!.source });
      approveModule(handle.db, held.id);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain('with the same code, but without this test case: "merges"');
      expect(listModuleTests(handle.db, held.id).map((test) => test.description)).toEqual(["an older case"]);
      expect(listModules(handle.db).find((module) => module.id === held.id)?.approvedAt).not.toBeNull();
    });

    /**
     * In the catalog is not the same as run for the approval. Adding a
     * case to an approved module withdraws the approval (EO-498), so the
     * card is offered over a module that reads as unapproved, and Publish
     * waits for a person to approve it — which runs the case.
     */
    it("offers the card when its test case was added after the module was approved, and Publish waits until it is approved again", async () => {
      allowAnHourPerRun();
      const held = alreadyThere(MERGE_MODULE.code);
      approveModule(handle.db, held.id, 2_000);
      saveModuleTest(handle.db, { moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 3_000);
      expect(listModules(handle.db).find((module) => module.id === held.id)?.approvedAt).toBeNull();
      const conversation = await openedOn("/settings");
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      expect(rejections).toEqual([]);
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({
        saved: false,
        problem: expect.stringContaining("Publish is waiting on"),
      });
      expect(pipelinesNamed("Release")).toEqual([]);

      approveModule(handle.db, held.id, 4_000);
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({ saved: true });
    });

    /**
     * An approval given before EO-498 can still stand over a case written
     * after it, and a card showing that case would be publishable on an
     * approval that never ran it — whether or not it passes.
     */
    it("refuses the card when its test case was added after an approval from before EO-498, until it is approved again", async () => {
      allowAnHourPerRun();
      const held = alreadyThere(MERGE_MODULE.code);
      saveModuleTest(handle.db, { moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 3_000);
      approvedBeforeEo498(held.id, 2_000);
      const conversation = await openedOn("/settings");
      const proposal = { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] };

      const refused = turn(conversation, proposal);
      expect(refused.cardIds).toEqual([]);
      expect(refused.rejections.join(" ")).toContain('added or changed after it was approved, so that approval cannot be shown to have run it: "merges"');
      expect(pipelinesNamed("Release")).toEqual([]);

      // A person approves it again, which runs every case it has now.
      approveModule(handle.db, held.id, 4_000);
      const offered = turn(conversation, proposal);
      expect(offered.rejections).toEqual([]);
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: offered.cardIds[0]! })).toMatchObject({ saved: true });
    });

    /**
     * The stamps are milliseconds. A case saved straight after an
     * approval can share its stamp without having been run by it, so an
     * equal stamp is not evidence of coverage and is refused.
     */
    it("refuses the card when its test case was saved after approval in the same millisecond", async () => {
      allowAnHourPerRun();
      const held = alreadyThere(MERGE_MODULE.code);
      saveModuleTest(handle.db, { moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 2_000);
      approvedBeforeEo498(held.id, 2_000);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain('so that approval cannot be shown to have run it: "merges"');
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("refuses Publish when a case on the card was rewritten after the approval the card was drawn under", async () => {
      allowAnHourPerRun();
      const held = alreadyThere(MERGE_MODULE.code);
      const seeded = saveModuleTest(handle.db, { moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 1_000);
      approveModule(handle.db, held.id, 2_000);
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      expect(cardIds).toHaveLength(1);

      // Rewritten after the approval, and back to the same words — under
      // an approval from before EO-498, which neither write withdrew.
      if (!seeded.ok) throw new Error(seeded.reason);
      saveModuleTest(handle.db, { id: seeded.test.id, moduleId: held.id, description: MERGE_MODULE.tests[0]!.description, source: "// rewritten" }, 2_500);
      saveModuleTest(handle.db, { id: seeded.test.id, moduleId: held.id, ...MERGE_MODULE.tests[0]! }, 3_000);
      approvedBeforeEo498(held.id, 2_000);

      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(published).toMatchObject({ saved: false, problem: expect.stringContaining("that approval cannot be shown to have run it") });
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("refuses Publish when a case on the card has since been deleted from the module", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const saved = listModules(handle.db).find((module) => module.slug === MERGE_MODULE.slug)!;
      deleteModuleTest(handle.db, listModuleTests(handle.db, saved.id)[0]!.id);
      approvedLater(saved.id);

      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(published).toMatchObject({ saved: false, problem: expect.stringContaining('without this test case: "merges"') });
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("refuses Publish when the module was edited after the card was drawn, even once it is approved again", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const saved = listModules(handle.db).find((module) => module.slug === MERGE_MODULE.slug)!;

      // Somebody rewrites it in Settings → Modules, and approves what they wrote.
      const edited = saveModule(handle.db, { id: saved.id, slug: saved.slug, name: saved.name, description: saved.description, code: `${saved.code} // and deletes the branch`, manifest: saved.manifest });
      expect(edited.ok).toBe(true);
      approvedLater(saved.id);

      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(published).toMatchObject({ saved: false, problem: expect.stringContaining("different code or a different manifest") });
      expect(pipelinesNamed("Release")).toEqual([]);
    });
  });

  /**
   * Waiting on a module is a state of the card, not a refusal (EO-399).
   * `assist:draft` answers the graph with the modules beside it; the gate
   * stays where it was, on the two channels that write.
   */
  describe("a draft waiting on a module nobody has approved", () => {
    const read = (conversationId: string, messageId: Uuid) => readAssistDraftForPublish(handle.db, { conversationId, messageId });

    /** A module already in the catalog, as the merge module, that nobody has approved. */
    function inTheCatalogUnapproved() {
      const saved = saveModule(handle.db, {
        slug: "catalog-merge",
        name: "Catalog merge",
        description: "Merges the release branch.",
        code: MERGE_MODULE.code,
        manifest: AssistOutputSchema.parse({ message: "x", draft: releaseDraft({ newPipeline: "X" }), modules: [MERGE_MODULE] }).modules![0]!.manifest,
      });
      if (!saved.ok) throw new Error(saved.reason);
      expect(saved.module.approvedAt).toBeNull();
      return saved.module;
    }

    it("answers a draft whose proposed module is unapproved with its graph and that module, and with neither once it is approved", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const saved = listModules(handle.db).find((module) => module.slug === "release-merge")!;

      const waiting = read(conversation.id, cardIds[0]!);
      expect(waiting).toMatchObject({
        pipelineId: null,
        newPipelineName: "Release",
        entryStepId: "release_merge",
        problem: null,
        waiting: [{ id: saved.id, slug: "release-merge", name: "Release merge", state: "unapproved" }],
        waitingProblem: expect.stringContaining('"Release merge"'),
      });
      // The picture: every step and route, not an empty graph.
      expect(waiting.steps.map((step) => step.name)).toEqual(["Merge", "Released"]);
      expect(waiting.routes).toHaveLength(1);

      approvedLater(saved.id);
      expect(read(conversation.id, cardIds[0]!)).toMatchObject({ problem: null, waiting: [], waitingProblem: null });
    });

    it("offers a draft naming an unapproved catalog module by its id as a card waiting on it, rather than a rejection", async () => {
      allowAnHourPerRun();
      const held = inTheCatalogUnapproved();
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }, { entryAction: held.id }) });

      expect(rejections).toEqual([]);
      expect(cardIds).toHaveLength(1);
      const waiting = read(conversation.id, cardIds[0]!);
      expect(waiting).toMatchObject({ problem: null, waiting: [{ id: held.id, slug: "catalog-merge", name: "Catalog merge", state: "unapproved" }] });
      expect(waiting.steps.find((step) => step.id === "release_merge")).toMatchObject({ entryAction: held.id, inputs: { ciWaitSeconds: 2400 } });

      // The gate has not moved: nothing is created while it waits.
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({
        saved: false,
        pipelineId: null,
        problem: expect.stringContaining('"Catalog merge"'),
      });
      expect(pipelinesNamed("Release")).toEqual([]);

      approvedLater(held.id);
      expect(read(conversation.id, cardIds[0]!).waiting).toEqual([]);
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({ saved: true });
      // Named without a version, so pinned to the newest approved one (EO-770).
      expect(listStepsForPipeline(handle.db, pipelinesNamed("Release")[0]!.id)[0]).toMatchObject({ entryAction: held.id, moduleVersion: 1 });
    });

    // A draft names a module, never a version (EO-770): it is published
    // pinning the newest approved version, so an edit to the module since
    // — which nobody has approved — neither holds the card nor runs.
    it("publishes a draft naming a catalog module whose newest edit is unapproved, pinned to its newest approved version", async () => {
      allowAnHourPerRun();
      const held = inTheCatalogUnapproved();
      approvedLater(held.id);
      const edited = saveModule(handle.db, { id: held.id, slug: held.slug, name: held.name, description: held.description, code: `${MERGE_MODULE.code}\n// edited`, manifest: held.manifest });
      if (!edited.ok) throw new Error(edited.reason);
      expect(edited.module.approvedAt).toBeNull();
      const conversation = await openedOn("/settings");

      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }, { entryAction: held.id }) });

      expect(read(conversation.id, cardIds[0]!).waiting).toEqual([]);
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({ saved: true });
      expect(listStepsForPipeline(handle.db, pipelinesNamed("Release")[0]!.id)[0]).toMatchObject({ entryAction: held.id, moduleVersion: 1 });
    });

    it("still refuses a draft naming by id a module that has been deleted", async () => {
      allowAnHourPerRun();
      const held = inTheCatalogUnapproved();
      archiveModule(handle.db, held.id);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }, { entryAction: held.id }) });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain("which has been deleted");
    });

    it("has pipeline:save refuse the waiting graph sent to it directly, and change no step", async () => {
      allowAnHourPerRun();
      const held = inTheCatalogUnapproved();
      const pipeline = createPipeline(handle.db, { projectId: null, name: "Release" });
      const conversation = await openedOn("/settings");
      const { cardIds, rejections } = turn(
        conversation,
        { message: "Here.", draft: releaseDraft({ pipelineId: pipeline.id }, { entryAction: held.id }), modules: [MERGE_MODULE] },
        [{ tool: PIPELINE_READ, pipelineId: pipeline.id }],
      );
      expect(rejections).toEqual([]);

      const waiting = read(conversation.id, cardIds[0]!);
      expect(waiting).toMatchObject({ pipelineId: pipeline.id, problem: null });
      // Both ways of depending on one: proposed beside the draft, and already in the catalog.
      expect(waiting.waiting.map((module) => [module.slug, module.state])).toEqual([
        ["release-merge", "unapproved"],
        ["catalog-merge", "unapproved"],
      ]);

      const saved = savePipeline(handle.db, undefined, { pipelineId: pipeline.id, steps: waiting.steps, routes: waiting.routes, entryStepId: waiting.entryStepId! });
      expect(saved.saved).toBe(false);
      expect(saved.problems.map((problem) => problem.message).join(" ")).toContain('runs v1 of "Catalog merge", which has not been approved');
      expect(listStepsForPipeline(handle.db, pipeline.id)).toEqual([]);
      expect(listRoutesForPipeline(handle.db, pipeline.id)).toEqual([]);
    });

    it("shows a proposed module deleted since the card was posted as gone, and keeps Publish refused", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const saved = listModules(handle.db).find((module) => module.slug === "release-merge")!;
      archiveModule(handle.db, saved.id);

      const waiting = read(conversation.id, cardIds[0]!);
      expect(waiting).toMatchObject({
        problem: null,
        waiting: [{ id: saved.id, slug: "release-merge", name: "Release merge", state: "gone" }],
        waitingProblem: expect.stringContaining("no longer in the module catalog"),
      });
      expect(waiting.steps).toHaveLength(2);

      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(published).toMatchObject({ saved: false, problem: expect.stringContaining("Ask for it again") });
      expect(pipelinesNamed("Release")).toEqual([]);
    });
  });

  /**
   * EO-581: one button on the draft card. Every module the draft needs
   * has its tests run, and then every approval and the publish land in
   * one transaction — or none of it does.
   */
  describe("Approve and publish", () => {
    const TAG_MODULE = {
      name: "Release tag",
      slug: "release-tag",
      description: "Tags the release once it is merged.",
      code: "export default async () => ({ ok: true, result: 'tagged' });",
      manifest: { name: "Release tag", description: "Tags the release once it is merged.", inputs: {}, results: ["tagged"] },
      why: "Tagging was the second half of the script.",
      tests: [{ description: "tags v1", source: "export default async function (harness) { await harness.run({}); }" }],
    };

    /** Merge, then tag, then a person: two modules the draft needs. */
    function twoModuleDraft(target: Record<string, string>) {
      const draft = releaseDraft(target);
      return {
        ...draft,
        steps: [
          draft.steps[0]!,
          { id: "release_tag", position: 1, name: "Tag", type: "module", ownerRole: null, entryAction: "release-tag", instructionsSummary: null, isTerminal: false, planMode: false },
          { ...draft.steps[1]!, position: 2 },
        ],
        routes: [
          { fromStepId: "release_merge", resultKey: "merged", label: "Merged", tone: "success", target: "release_tag", position: 0 },
          { fromStepId: "release_tag", resultKey: "tagged", label: "Tagged", tone: "success", target: "release_done", position: 0 },
        ],
      };
    }

    interface Scripted {
      cases?: { description: string; passed: boolean; failure?: string }[];
      lineCoverage?: number;
      /** The tests did not run at all, for this reason. */
      notRun?: string;
      /** Something that happens while this module's tests run. */
      meanwhile?: () => void;
    }

    /**
     * The test runner, as `approveModuleCommand` meets it: answers each
     * module by its slug, fingerprinted from what is saved when it starts.
     */
    function runner(script: Record<string, Scripted> = {}) {
      const ran: string[] = [];
      return {
        ran,
        run: async (moduleId: string): Promise<ModuleTestRunAnswer> => {
          const module = getModule(handle.db, moduleId)!;
          ran.push(module.slug);
          const said = script[module.slug] ?? {};
          if (said.notRun !== undefined) return { run: null, problem: said.notRun };
          const fingerprint = moduleTestFingerprint(module, listModuleTests(handle.db, moduleId));
          said.meanwhile?.();
          const cases: { description: string; passed: boolean; failure?: string }[] =
            said.cases ?? listModuleTests(handle.db, moduleId).map((test) => ({ description: test.description, passed: true }));
          const percent = said.lineCoverage ?? 100;
          return {
            fingerprint,
            problem: null,
            run: {
              ranAt: Date.now(),
              cases: cases.map((each, index) => ({ testId: `t${index}`, description: each.description, passed: each.passed, failure: each.failure ?? null, durationMs: 1, output: "" })),
              coverage: { lines: { covered: percent, total: 100, percent }, branches: { covered: 1, total: 1, percent: 100 } },
            },
          };
        },
      };
    }

    /** Nothing here is held on an organisation's record, so the record is never asked. */
    const noRecord = {
      updateConflict: async () => {
        throw new Error("asked the record about a pipeline it does not hold");
      },
    };

    const press = (tests: Pick<ModuleTestRunner, "run">, conversationId: string, messageId: Uuid, acknowledgeLowCoverage: string[] = []) =>
      approveAndPublishAssistDraft(handle.db, undefined, tests, noRecord, { conversationId, messageId, acknowledgeLowCoverage });

    const moduleNamed = (slug: string) => listModules(handle.db, true).find((module) => module.slug === slug)!;

    async function newDraftCard(): Promise<{ conversation: Item; cardId: Uuid }> {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: twoModuleDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE, TAG_MODULE] });
      expect(rejections).toEqual([]);
      return { conversation, cardId: cardIds[0]! };
    }

    async function existingDraftCard(): Promise<{ conversation: Item; cardId: Uuid; pipelineId: string }> {
      allowAnHourPerRun();
      const pipeline = createPipeline(handle.db, { projectId: null, name: "Release" });
      const conversation = await openedOn("/settings");
      const { cardIds, rejections } = turn(
        conversation,
        { message: "Here.", draft: twoModuleDraft({ pipelineId: pipeline.id }), modules: [MERGE_MODULE, TAG_MODULE] },
        [{ tool: PIPELINE_READ, pipelineId: pipeline.id }],
      );
      expect(rejections).toEqual([]);
      return { conversation, cardId: cardIds[0]!, pipelineId: pipeline.id };
    }

    describe("a draft carrying entry rules (EO-610)", () => {
      const rules = [{ kind: "description" }];

      it("sets them on the pipeline it creates", async () => {
        allowAnHourPerRun();
        const conversation = await openedOn("/settings");
        const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: { ...twoModuleDraft({ newPipeline: "Release" }), entryRules: rules }, modules: [MERGE_MODULE, TAG_MODULE] });
        expect(rejections).toEqual([]);

        const answer = await press(runner(), conversation.id, cardIds[0]!);

        expect(answer).toMatchObject({ saved: true, created: true, problem: null });
        expect(getPipeline(handle.db, answer.pipelineId!)?.entryRules).toEqual(rules);
      });

      it("sets them on a pipeline that exists, and files them in the version", async () => {
        allowAnHourPerRun();
        const pipeline = createPipeline(handle.db, { projectId: null, name: "Release" });
        const conversation = await openedOn("/settings");
        const { cardIds, rejections } = turn(
          conversation,
          { message: "Here.", draft: { ...twoModuleDraft({ pipelineId: pipeline.id }), entryRules: rules }, modules: [MERGE_MODULE, TAG_MODULE] },
          [{ tool: PIPELINE_READ, pipelineId: pipeline.id }],
        );
        expect(rejections).toEqual([]);

        const answer = await press(runner(), conversation.id, cardIds[0]!);

        expect(answer).toMatchObject({ saved: true, created: false, problem: null });
        expect(getPipeline(handle.db, pipeline.id)?.entryRules).toEqual(rules);
        expect(versionSnapshot(handle.db, currentVersion(handle.db, pipeline.id)!.id)?.entryRules).toEqual(rules);
      });

      it("leaves a pipeline's rules where they are when the draft says nothing of them", async () => {
        const { conversation, cardId, pipelineId } = await existingDraftCard();
        handle.db.update(pipelines).set({ entryRules: rules }).where(eq(pipelines.id, pipelineId)).run();

        const answer = await press(runner(), conversation.id, cardId);

        expect(answer).toMatchObject({ saved: true, problem: null });
        expect(getPipeline(handle.db, pipelineId)?.entryRules).toEqual(rules);
      });
    });

    it("runs every module's tests, approves them all and creates the pipeline, when every case passes", async () => {
      const { conversation, cardId } = await newDraftCard();
      const tests = runner();

      const answer = await press(tests, conversation.id, cardId);

      expect(answer).toMatchObject({ saved: true, created: true, renamed: false, problem: null, coverage: [] });
      expect(tests.ran).toEqual(["release-merge", "release-tag"]);
      expect(answer.modules.map((module) => [module.slug, module.outcome])).toEqual([
        ["release-merge", "passed"],
        ["release-tag", "passed"],
      ]);
      expect(moduleNamed("release-merge").approvedAt).not.toBeNull();
      expect(moduleNamed("release-tag").approvedAt).not.toBeNull();
      const [release] = pipelinesNamed("Release");
      expect(release?.id).toBe(answer.pipelineId);
      expect(listStepsForPipeline(handle.db, release!.id).map((step) => [step.id, step.entryAction])).toEqual([
        ["release_merge", moduleNamed("release-merge").id],
        ["release_tag", moduleNamed("release-tag").id],
        ["release_done", null],
      ]);
      expect(currentVersion(handle.db, release!.id)).toBeDefined();
    });

    it("approves them all and publishes into the pipeline that exists, filing a version", async () => {
      const { conversation, cardId, pipelineId } = await existingDraftCard();
      expect(currentVersion(handle.db, pipelineId)).toBeUndefined();

      const answer = await press(runner(), conversation.id, cardId);

      expect(answer).toMatchObject({ saved: true, created: false, pipelineId, problem: null });
      expect(moduleNamed("release-merge").approvedAt).not.toBeNull();
      expect(moduleNamed("release-tag").approvedAt).not.toBeNull();
      expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).toEqual(["release_merge", "release_tag", "release_done"]);
      expect(currentVersion(handle.db, pipelineId)).toBeDefined();
    });

    it("approves nothing and creates no pipeline when one module's case fails, naming the module and the case", async () => {
      const { conversation, cardId } = await newDraftCard();
      const tests = runner({ "release-tag": { cases: [{ description: "tags v1", passed: false, failure: "expected tagged, got failed" }] } });

      const answer = await press(tests, conversation.id, cardId);

      expect(answer).toMatchObject({ saved: false, pipelineId: null, created: false });
      // Every module ran, so the card can say how each went.
      expect(tests.ran).toEqual(["release-merge", "release-tag"]);
      expect(answer.problem).toContain("Nothing was approved and nothing was published.");
      expect(answer.problem).toContain('"Release tag" was not approved: 1 of 1 test case failed.');
      expect(answer.problem).toContain("tags v1: expected tagged, got failed");
      expect(answer.modules.find((module) => module.slug === "release-tag")).toMatchObject({ outcome: "refused", problem: expect.stringContaining("tags v1") });
      // The module that passed is not approved either.
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("approves nothing and writes no version of the pipeline that exists when one module's case fails", async () => {
      const { conversation, cardId, pipelineId } = await existingDraftCard();

      const answer = await press(runner({ "release-merge": { cases: [{ description: "merges", passed: false }] } }), conversation.id, cardId);

      expect(answer.saved).toBe(false);
      expect(answer.problem).toContain('"Release merge" was not approved');
      expect(answer.problem).toContain("- merges");
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(listStepsForPipeline(handle.db, pipelineId)).toEqual([]);
      expect(currentVersion(handle.db, pipelineId)).toBeUndefined();
    });

    it("approves nothing when a module's tests do not run, and says which", async () => {
      const { conversation, cardId } = await newDraftCard();

      const answer = await press(runner({ "release-merge": { notRun: "The module host is not available in this build." } }), conversation.id, cardId);

      expect(answer.saved).toBe(false);
      expect(answer.problem).toContain('"Release merge" was not approved: its tests did not run. The module host is not available in this build.');
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("approves nothing when a module changes while its own tests run", async () => {
      const { conversation, cardId } = await newDraftCard();
      const tag = moduleNamed("release-tag");
      // A save landing while the tag module's tests run: they are about the code before it.
      const tests = runner({
        "release-tag": {
          meanwhile: () => {
            const saved = saveModule(handle.db, { id: tag.id, slug: tag.slug, name: tag.name, description: tag.description, code: `${tag.code}\n// edited`, manifest: tag.manifest });
            if (!saved.ok) throw new Error(saved.reason);
          },
        },
      });

      const answer = await press(tests, conversation.id, cardId);

      expect(answer.saved).toBe(false);
      expect(answer.problem).toContain("changed while its tests were running");
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(pipelinesNamed("Release")).toEqual([]);
    });

    it("approves nothing when the pipeline's name is taken while the tests run", async () => {
      const { conversation, cardId } = await newDraftCard();
      // The name is taken while the tests run: the draft read again inside
      // the transaction is refused, after the first read had passed and
      // before any module is approved.
      const tests = runner({
        "release-tag": {
          meanwhile: () => {
            createPipeline(handle.db, { projectId: rowOf(conversation.id).projectId, name: "Release" });
          },
        },
      });

      const answer = await press(tests, conversation.id, cardId);

      expect(answer.saved).toBe(false);
      expect(answer.problem).toContain("already has a pipeline called");
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(pipelinesNamed("Release")).toHaveLength(1);
    });

    /**
     * Rollback proper: an approval is written inside the transaction, and
     * something later in the same transaction refuses. Every write before
     * the refusal has to go back with it — these fail if the approvals and
     * the publish are not one transaction.
     */
    describe("a refusal after an approval has been written", () => {
      /** A module in the catalog, unapproved, with one passing case, that a draft step names by its id. */
      function inTheCatalog(slug: string, result: string): string {
        const saved = saveModule(handle.db, {
          slug,
          name: slug,
          description: `Answers ${result}.`,
          code: `export default async () => ({ ok: true, result: '${result}' });`,
          manifest: { name: slug, description: `Answers ${result}.`, inputs: {}, needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false }, results: [result] },
        });
        if (!saved.ok) throw new Error(saved.reason);
        const test = saveModuleTest(handle.db, { moduleId: saved.module.id, description: `answers ${result}`, source: "export default async function (harness) { await harness.run({}); }" });
        if (!test.ok) throw new Error(test.reason);
        return saved.module.id;
      }

      it("takes back the approval already written when a later module changed after its tests passed", async () => {
        allowAnHourPerRun();
        // Three modules from the catalog, judged in the order the steps name them.
        const first = inTheCatalog("first-step", "first");
        const second = inTheCatalog("second-step", "second");
        const third = inTheCatalog("third-step", "third");
        const step = (id: string, position: number, moduleId: string) => ({
          id,
          position,
          name: id,
          type: "module",
          ownerRole: null,
          entryAction: moduleId,
          instructionsSummary: null,
          isTerminal: false,
          planMode: false,
        });
        const conversation = await openedOn("/settings");
        const { cardIds, rejections } = turn(conversation, {
          message: "Here.",
          draft: {
            rationale: "Three scripts in a row.",
            entryStepId: "one",
            target: { newPipeline: "Release" },
            steps: [
              step("one", 0, first),
              step("two", 1, second),
              step("three", 2, third),
              { id: "release_done", position: 3, name: "Released", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
            ],
            routes: [
              { fromStepId: "one", resultKey: "first", label: "First", tone: "success", target: "two", position: 0 },
              { fromStepId: "two", resultKey: "second", label: "Second", tone: "success", target: "three", position: 0 },
              { fromStepId: "three", resultKey: "third", label: "Third", tone: "success", target: "release_done", position: 0 },
            ],
          },
        });
        expect(rejections).toEqual([]);
        const secondModule = getModule(handle.db, second)!;
        // The second module passed its tests; it is edited while the third's run.
        // The card names it by id, so the draft read again still fits — the
        // transaction approves the first, then finds the second changed.
        const tests = runner({
          "third-step": {
            meanwhile: () => {
              const saved = saveModule(handle.db, { ...secondModule, code: `${secondModule.code}\n// edited` });
              if (!saved.ok) throw new Error(saved.reason);
            },
          },
        });

        const answer = await press(tests, conversation.id, cardIds[0]!);

        expect(tests.ran).toEqual(["first-step", "second-step", "third-step"]);
        expect(answer.saved).toBe(false);
        expect(answer.problem).toContain('"second-step" changed while the tests were running');
        // The first was approved inside the transaction, and is not now.
        expect(getModule(handle.db, first)!.approvedAt).toBeNull();
        expect(getModule(handle.db, second)!.approvedAt).toBeNull();
        expect(getModule(handle.db, third)!.approvedAt).toBeNull();
        expect(listModuleVersions(handle.db, first).every((version) => version.approvedAt === null)).toBe(true);
        expect(pipelinesNamed("Release")).toEqual([]);
      });

      /** `qa` defines `alignment`, the definition the draft below publishes with. */
      const ALIGNMENT = {
        role: "qa",
        action: "alignment",
        description: "Check the work against what was asked for.",
        results: [
          { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
          { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
        ],
      };

      /** Merge (a module), then a `qa` check on `alignment`, then a person — published with the definition. */
      function mergeThenCheck(target: Record<string, string>) {
        const draft = releaseDraft(target);
        return {
          ...draft,
          steps: [
            draft.steps[0]!,
            { id: "release_check", position: 1, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment", instructionsSummary: null, isTerminal: false, planMode: false },
            { ...draft.steps[1]!, position: 2 },
          ],
          routes: [
            { fromStepId: "release_merge", resultKey: "merged", label: "Merged", tone: "success", target: "release_check", position: 0 },
            { fromStepId: "release_check", resultKey: "aligned", label: "Aligned", tone: "success", target: "release_done", position: 0 },
            { fromStepId: "release_check", resultKey: "gaps_found", label: "Not aligned", tone: "danger", target: "user_attention", position: 1 },
          ],
        };
      }

      /**
       * The save itself refuses, after the module is approved: the draft
       * brings an action definition, and the agents section is managed
       * by the organisation. Nothing before the save reads that section,
       * so the module's approval is written first and has to be taken back.
       */
      async function refusedBySave(target: (pipelineId: string | null) => Record<string, string>, existing: boolean) {
        allowAnHourPerRun();
        const pipelineId = existing ? createPipeline(handle.db, { projectId: null, name: "Release" }).id : null;
        const conversation = await openedOn("/settings");
        const { cardIds, rejections } = turn(
          conversation,
          { message: "Here.", draft: mergeThenCheck(target(pipelineId)), modules: [MERGE_MODULE], actions: [ALIGNMENT] },
          pipelineId === null ? [] : [{ tool: PIPELINE_READ, pipelineId }],
        );
        expect(rejections).toEqual([]);
        const stopBeingAReplica = markReplica(handle.db, () => true);
        publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
        try {
          const tests = runner();
          const answer = await press(tests, conversation.id, cardIds[0]!);
          return { answer, tests, pipelineId };
        } finally {
          stopBeingAReplica();
        }
      }

      it("takes back the approval and the pipeline it created when the save refuses the graph", async () => {
        const { answer, tests } = await refusedBySave(() => ({ newPipeline: "Release" }), false);

        expect(tests.ran).toEqual(["release-merge"]);
        expect(answer).toMatchObject({ saved: false, pipelineId: null, created: false });
        expect(answer.problem).toContain("Nothing was approved and nothing was published");
        expect(answer.problem).toContain("The agents section is managed by your organisation.");
        const merge = moduleNamed("release-merge");
        expect(merge.approvedAt).toBeNull();
        expect(listModuleVersions(handle.db, merge.id).every((version) => version.approvedAt === null)).toBe(true);
        expect(pipelinesNamed("Release")).toEqual([]);
        expect(listActionDefinitions(handle.db)).toEqual([]);
      });

      it("takes back the approval and writes no version of the pipeline that exists when the save refuses the graph", async () => {
        const { answer, pipelineId } = await refusedBySave((id) => ({ pipelineId: id! }), true);

        expect(answer.saved).toBe(false);
        expect(answer.problem).toContain("The agents section is managed by your organisation.");
        expect(moduleNamed("release-merge").approvedAt).toBeNull();
        expect(listStepsForPipeline(handle.db, pipelineId!)).toEqual([]);
        expect(currentVersion(handle.db, pipelineId!)).toBeUndefined();
        expect(listActionDefinitions(handle.db)).toEqual([]);
      });
    });

    it("asks for a coverage figure on the card before anything is approved, and approves and publishes once it is confirmed", async () => {
      const { conversation, cardId } = await newDraftCard();
      const tests = runner({ "release-tag": { lineCoverage: 55 } });
      const tag = moduleNamed("release-tag");

      const asked = await press(tests, conversation.id, cardId);

      expect(asked).toMatchObject({ saved: false, coverage: [{ id: tag.id, name: "Release tag", lineCoverage: 55 }] });
      expect(asked.problem).toContain('"Release tag" (55%)');
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
      expect(moduleNamed("release-tag").approvedAt).toBeNull();
      expect(pipelinesNamed("Release")).toEqual([]);

      const confirmed = await press(tests, conversation.id, cardId, [tag.id]);

      expect(confirmed).toMatchObject({ saved: true, created: true, coverage: [] });
      expect(moduleNamed("release-merge").approvedAt).not.toBeNull();
      expect(moduleNamed("release-tag").approvedAt).not.toBeNull();
      expect(pipelinesNamed("Release")).toHaveLength(1);
    });

    it("refuses a draft one of whose modules has been deleted, without running anything", async () => {
      const { conversation, cardId } = await newDraftCard();
      archiveModule(handle.db, moduleNamed("release-tag").id);
      const tests = runner();

      const answer = await press(tests, conversation.id, cardId);

      expect(answer.saved).toBe(false);
      expect(answer.problem).toContain("no longer in the module catalog");
      expect(tests.ran).toEqual([]);
      expect(moduleNamed("release-merge").approvedAt).toBeNull();
    });

    it("is refused naming the pipelines section where an organisation manages it, running nothing", async () => {
      const { conversation, cardId } = await newDraftCard();
      const stopBeingAReplica = markReplica(handle.db, () => true);
      publishSection(handle.db, { section: "pipelines", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });
      const tests = runner();
      try {
        const answer = await handleIpcRequest(
          "assist:approveAndPublish",
          { conversationId: conversation.id, messageId: cardId },
          (payload) => approveAndPublishAssistDraft(handle.db, undefined, tests, noRecord, payload),
          // The lock `handlers.ts` asks of every channel, before the handler runs.
          { ...opts, sectionLock: (channel: IpcChannel, payload: unknown) => sectionLockFor(handle.db, channel, payload) },
        );

        expect(answer.ok).toBe(false);
        expect(JSON.stringify(answer)).toContain("pipelines");
        expect(tests.ran).toEqual([]);
        expect(moduleNamed("release-merge").approvedAt).toBeNull();
      } finally {
        stopBeingAReplica();
      }
    });
  });

  /**
   * A module that failed its tests on Approve is fixed where it was
   * proposed (EO-401): the corrected one goes in under the same slug.
   * Only over a module nobody has approved, that the assistant wrote —
   * every other slug the catalog holds is refused as it always was.
   */
  describe("a corrected module proposed again under its slug", () => {
    const FIXED_CODE = "export default async (ctx) => ({ ok: true, result: 'merged' }); // waits for CI";
    const CORRECTED = {
      ...MERGE_MODULE,
      name: "Release merge (fixed)",
      code: FIXED_CODE,
      manifest: { ...MERGE_MODULE.manifest, results: ["merged", "ci_failed"] },
      tests: [
        { description: "merges", source: "export default async function (harness) { await harness.run({ ci: 'green' }); }" },
        { description: "reports a red CI", source: "export default async function (harness) { await harness.run({ ci: 'red' }); }" },
      ],
    };
    const manifestOf = (module: unknown) => AssistOutputSchema.parse({ message: "x", modules: [module] }).modules![0]!.manifest;

    function messageOf(id: string) {
      return openAssist(handle.db).conversation.messages.find((message) => message.id === id)!;
    }
    function held() {
      return listModules(handle.db, true).find((module) => module.slug === MERGE_MODULE.slug)!;
    }
    /** A module already under the slug, written by somebody or something else. */
    function alreadyThere(input: { source: "user" | "import" | "architect"; approve?: boolean }) {
      const saved = saveModule(handle.db, {
        slug: MERGE_MODULE.slug,
        name: "Old merge",
        description: "Merges without waiting for CI.",
        code: "export default async () => ({ ok: true, result: 'merged' }); // force-pushes",
        manifest: manifestOf(MERGE_MODULE),
        source: input.source,
        ...(input.approve ? { approve: true } : {}),
      });
      if (!saved.ok) throw new Error(saved.reason);
      return saved.module;
    }

    it("replaces the code and manifest of an unapproved module the assistant wrote, keeps it unapproved, and files a version", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const before = held();
      expect(listModuleVersions(handle.db, before.id)).toHaveLength(1);

      const again = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(again.rejections).toEqual([]);
      expect(again.cardIds).toHaveLength(1);
      // The same row, not a second module beside it.
      expect(listModules(handle.db, true).filter((module) => module.slug === MERGE_MODULE.slug)).toHaveLength(1);
      expect(held()).toMatchObject({
        id: before.id,
        name: "Release merge (fixed)",
        code: FIXED_CODE,
        manifest: manifestOf(CORRECTED),
        approvedAt: null,
        archivedAt: null,
        source: "architect",
      });
      // The earlier code is in its history, under the version it was.
      const versions = listModuleVersions(handle.db, before.id);
      expect(versions.map((version) => [version.number, version.current, version.approved])).toEqual([
        [2, true, false],
        [1, false, false],
      ]);
      expect(getModuleVersion(handle.db, before.id, 1)?.code).toBe(MERGE_MODULE.code);
      expect(getModuleVersion(handle.db, before.id, 2)?.code).toBe(FIXED_CODE);
    });

    it("says the catalog changed when it replaced one", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const agent = assistAgent(handle.db)!;
      const output = AssistOutputSchema.parse({ message: "Fixed.", modules: [CORRECTED] });
      const run = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: newestQuestion(conversation) });
      updateRun(handle.db, run.id, { status: "succeeded", result: { raw: JSON.stringify(output), parsed: output } });

      expect(postAssistReply(handle.db, conversation, agent.id, run.id, output)).toEqual({ modulesSaved: true });
    });

    it("leaves the module with every case listed: one of a description it had replaces that case, and a case not listed is kept", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();
      const [merges] = listModuleTests(handle.db, module.id);
      // One somebody added to it since, which the correction says nothing about.
      const kept = saveModuleTest(handle.db, { moduleId: module.id, description: "leaves the tag alone", source: "export default async function () {}" });
      if (!kept.ok) throw new Error(kept.reason);

      expect(turn(conversation, { message: "Fixed.", modules: [CORRECTED] }).rejections).toEqual([]);

      const after = listModuleTests(handle.db, module.id);
      expect(after.map((test) => test.description).sort()).toEqual(["leaves the tag alone", "merges", "reports a red CI"]);
      // "merges" is the case it was, rewritten — not a second one beside it.
      expect(after.find((test) => test.description === "merges")).toMatchObject({ id: merges!.id, source: CORRECTED.tests[0]!.source });
      expect(after.find((test) => test.description === "reports a red CI")?.source).toBe(CORRECTED.tests[1]!.source);
      expect(after.find((test) => test.id === kept.test.id)).toMatchObject({ description: "leaves the tag alone", source: "export default async function () {}" });
    });

    it("replaces a case that was itself wrong, where the code did not change", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();
      const source = "export default async function (harness) { await harness.run({ ci: 'green' }); }";

      const again = turn(conversation, { message: "The case was wrong.", modules: [{ ...MERGE_MODULE, tests: [{ description: "merges", source }] }] });

      expect(again.rejections).toEqual([]);
      expect(listModuleTests(handle.db, module.id).map((test) => [test.description, test.source])).toEqual([["merges", source]]);
      expect(held()).toMatchObject({ id: module.id, code: MERGE_MODULE.code, approvedAt: null });
    });

    it("refuses over an approved module with different code, and leaves its code, manifest and approval as they were", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      approvedLater(held().id);
      const approved = held();
      const versions = listModuleVersions(handle.db, approved.id);
      const tests = listModuleTests(handle.db, approved.id);

      const again = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(again.cardIds).toEqual([]);
      expect(again.rejections).toHaveLength(1);
      expect(again.rejections[0]).toContain("No module was saved.");
      expect(again.rejections[0]).toContain("different code or a different manifest");
      // Against the row: nothing about it moved.
      expect(held()).toEqual(approved);
      expect(held().approvedAt).not.toBeNull();
      expect(listModuleVersions(handle.db, approved.id)).toEqual(versions);
      expect(listModuleTests(handle.db, approved.id)).toEqual(tests);
    });

    it("refuses over an approved module when only the manifest differs", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      approvedLater(held().id);
      const approved = held();

      const again = turn(conversation, { message: "Fixed.", modules: [{ ...MERGE_MODULE, manifest: CORRECTED.manifest }] });

      expect(again.cardIds).toEqual([]);
      expect(again.rejections[0]).toContain("different code or a different manifest");
      expect(held()).toEqual(approved);
    });

    it.each([
      { source: "user", approve: false },
      { source: "user", approve: true },
      { source: "import", approve: false },
      { source: "import", approve: true },
    ] as const)("refuses over a module whose source is $source (approved: $approve), and writes nothing", async (existing) => {
      const before = alreadyThere(existing);
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain(`which the module "Old merge" (id: ${before.id}) already holds`);
      expect(held()).toEqual(before);
      expect(listModuleTests(handle.db, before.id)).toEqual([]);
      expect(listModuleVersions(handle.db, before.id)).toHaveLength(1);
    });

    it("still refuses a slug a deleted module holds, even one the assistant wrote and nobody approved", async () => {
      const before = alreadyThere({ source: "architect" });
      archiveModule(handle.db, before.id, 5_000);
      const deleted = held();
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(cardIds).toEqual([]);
      expect(rejections[0]).toContain("which a deleted module");
      expect(held()).toEqual(deleted);
      expect(listModuleTests(handle.db, before.id)).toEqual([]);
    });

    it("writes none of a reply's modules when one of them is refused", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const replaceable = held();
      const person = saveModule(handle.db, { slug: "notify-release", name: "Notify", description: "Posts.", code: "export default async () => ({ ok: true, result: 'merged' });", manifest: manifestOf(MERGE_MODULE) });
      if (!person.ok) throw new Error(person.reason);

      const { cardIds, rejections } = turn(conversation, {
        message: "Both.",
        modules: [CORRECTED, { ...CORRECTED, slug: "notify-release", name: "Notify release" }],
      });

      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(held()).toEqual(replaceable);
    });

    it("marks the earlier card replaced, so only the new card is the one that approves it", async () => {
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      expect(messageOf(first.cardIds[0]!)).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: null });

      const second = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(messageOf(first.cardIds[0]!)).toMatchObject({ canApprove: false, approves: null, moduleSlug: MERGE_MODULE.slug, moduleReplaced: "below" });
      expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: MERGE_MODULE.slug, moduleReplaced: null });
    });

    it("does not mark a card replaced by a proposal that was refused, or by the same module proposed again", async () => {
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const same = turn(conversation, { message: "Again.", modules: [MERGE_MODULE] });
      expect(messageOf(first.cardIds[0]!).moduleReplaced).toBeNull();

      approvedLater(held().id);
      const refused = turn(conversation, { message: "Fixed.", modules: [CORRECTED] });

      expect(refused.cardIds).toEqual([]);
      expect(messageOf(first.cardIds[0]!).moduleReplaced).toBeNull();
      expect(messageOf(same.cardIds[0]!).moduleReplaced).toBeNull();
    });

    it("supersedes the earlier draft card when the draft is proposed again with the corrected module, and unlocks Publish once that is approved", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const module = held();

      const second = turn(conversation, { message: "Fixed.", draft: releaseDraft({ newPipeline: "Release" }), modules: [CORRECTED] });

      expect(second.rejections).toEqual([]);
      expect(held()).toMatchObject({ id: module.id, code: FIXED_CODE, approvedAt: null });
      // The earlier card is no longer a card anybody can publish from.
      expect(messageOf(first.cardIds[0]!)).toMatchObject({ canApprove: false, approves: null });
      expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "pipeline" });
      expect(readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: first.cardIds[0]! }).problem).toContain("superseded by a newer one");
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: first.cardIds[0]! })).toMatchObject({ saved: false });

      // The new card waits on the corrected module, and on nothing once it is approved.
      const read = () => readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: second.cardIds[0]! });
      expect(read()).toMatchObject({ problem: null, waiting: [{ id: module.id, slug: MERGE_MODULE.slug, name: "Release merge (fixed)", state: "unapproved" }] });
      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: second.cardIds[0]! })).toMatchObject({ saved: false });

      approvedLater(module.id);

      expect(read()).toMatchObject({ problem: null, waiting: [], waitingProblem: null });
      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: second.cardIds[0]! });
      expect(published).toMatchObject({ saved: true, problem: null });
      expect(listStepsForPipeline(handle.db, published.pipelineId!)[0]).toMatchObject({ entryAction: module.id });
    });

    it("marks a module's own card replaced when a draft carrying the corrected module is offered", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });

      const second = turn(conversation, { message: "With its pipeline.", draft: releaseDraft({ newPipeline: "Release" }), modules: [CORRECTED] });

      expect(second.rejections).toEqual([]);
      expect(messageOf(first.cardIds[0]!)).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: "below" });
    });

    /**
     * The corrected source being somewhere on the module is not the
     * correction having been made: the case it corrects is the oldest of
     * that description, and that one is still the failing one.
     */
    it("replaces the older of two cases sharing a description when the proposal lists the newer one's source", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();
      const [old] = listModuleTests(handle.db, module.id);
      const fixedSource = "export default async function (harness) { await harness.run({ ci: 'green' }); }";
      const fixed = saveModuleTest(handle.db, { moduleId: module.id, description: "merges", source: fixedSource }, Date.now() + 500);
      if (!fixed.ok) throw new Error(fixed.reason);
      expect(listModuleTests(handle.db, module.id).map((test) => test.source)).toEqual([MERGE_MODULE.tests[0]!.source, fixedSource]);

      const again = turn(conversation, { message: "Fixed.", modules: [{ ...MERGE_MODULE, tests: [{ description: "merges", source: fixedSource }] }] });

      expect(again.rejections).toEqual([]);
      expect(again.cardIds).toHaveLength(1);
      // The older case is that case rewritten; the other was not listed against anything, and is kept.
      expect(listModuleTests(handle.db, module.id).map((test) => [test.id, test.description, test.source])).toEqual([
        [old!.id, "merges", fixedSource],
        [fixed.test.id, "merges", fixedSource],
      ]);
      expect(held()).toMatchObject({ id: module.id, code: MERGE_MODULE.code, approvedAt: null });
    });

    it("adds the second copy when the correction lists twice a case the module has once", async () => {
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();
      const [merges] = listModuleTests(handle.db, module.id);
      const twice = { ...MERGE_MODULE, tests: [MERGE_MODULE.tests[0]!, MERGE_MODULE.tests[0]!] };

      const again = turn(conversation, { message: "Twice.", modules: [twice] });

      expect(again.rejections).toEqual([]);
      const after = listModuleTests(handle.db, module.id);
      expect(after.map((test) => [test.description, test.source])).toEqual([
        ["merges", MERGE_MODULE.tests[0]!.source],
        ["merges", MERGE_MODULE.tests[0]!.source],
      ]);
      // The one it had is still that case; the other is new.
      expect(after[0]!.id).toBe(merges!.id);
      expect(held()).toMatchObject({ id: module.id, code: MERGE_MODULE.code, approvedAt: null });

      // And once it has both, the same reply again writes nothing more.
      turn(conversation, { message: "Twice again.", modules: [twice] });
      expect(listModuleTests(handle.db, module.id)).toHaveLength(2);
    });

    it("stops an earlier card in another chat offering Approve, saying the module changed rather than pointing below", async () => {
      const elsewhere = await openedOn("/settings");
      const first = turn(elsewhere, { message: "Here.", modules: [MERGE_MODULE] });
      expect(messageOf(first.cardIds[0]!).moduleReplaced).toBeNull();

      // A new chat, where the correction is proposed.
      clearAssist(handle.db, undefined);
      const here = await openedOn("/settings");
      expect(here.id).not.toBe(elsewhere.id);
      const second = turn(here, { message: "Fixed.", modules: [CORRECTED] });
      expect(second.rejections).toEqual([]);
      expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleReplaced: null });

      const earlier = resumeAssist(handle.db, { conversationId: elsewhere.id }).conversation!.messages.find((message) => message.id === first.cardIds[0])!;
      expect(earlier).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: "elsewhere" });
    });

    /**
     * The code is the same, so the catalog's code cannot say this card
     * was replaced — and a case a person adds in Settings must not look
     * like it either. Told apart by the card in the other chat.
     */
    it("stops an earlier card in another chat offering Approve when the correction there changed only a test case", async () => {
      const elsewhere = await openedOn("/settings");
      const first = turn(elsewhere, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();
      const earlier = () => resumeAssist(handle.db, { conversationId: elsewhere.id }).conversation!.messages.find((message) => message.id === first.cardIds[0])!;

      clearAssist(handle.db, undefined);
      const here = await openedOn("/settings");
      expect(here.id).not.toBe(elsewhere.id);

      // A case a person adds in Settings is not a correction: the card still describes the module.
      saveModuleTest(handle.db, { moduleId: module.id, description: "leaves the tag alone", source: "export default async function () {}" }, Date.now() + 500);
      expect(earlier()).toMatchObject({ canApprove: true, approves: "module", moduleReplaced: null });
      resumeAssist(handle.db, { conversationId: here.id });

      const source = "export default async function (harness) { await harness.run({ ci: 'green' }); }";
      const second = turn(here, { message: "The case was wrong.", modules: [{ ...MERGE_MODULE, tests: [{ description: "merges", source }] }] });
      expect(second.rejections).toEqual([]);
      // Only the case moved.
      expect(held()).toMatchObject({ id: module.id, code: MERGE_MODULE.code, manifest: module.manifest, approvedAt: null });
      expect(listModuleTests(handle.db, module.id).find((test) => test.description === "merges")?.source).toBe(source);

      // The new card is the one that approves it.
      expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: MERGE_MODULE.slug, moduleReplaced: null });
      expect(earlier()).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: "elsewhere" });
    });

    it("stops the earlier card when the correction in another chat only added a case, on a draft card or after that chat was put away", async () => {
      allowAnHourPerRun();
      const elsewhere = await openedOn("/settings");
      const first = turn(elsewhere, { message: "Here.", modules: [MERGE_MODULE] });
      const earlier = () => resumeAssist(handle.db, { conversationId: elsewhere.id }).conversation!.messages.find((message) => message.id === first.cardIds[0])!;

      clearAssist(handle.db, undefined);
      const here = await openedOn("/settings");
      const added = { ...MERGE_MODULE, tests: [...MERGE_MODULE.tests, CORRECTED.tests[1]!] };
      const second = turn(here, { message: "With its pipeline.", draft: releaseDraft({ newPipeline: "Release" }), modules: [added] });
      expect(second.rejections).toEqual([]);
      expect(listModuleTests(handle.db, held().id).map((test) => test.description)).toEqual(["merges", "reports a red CI"]);

      expect(earlier().moduleReplaced).toBe("elsewhere");
      // Put away, the chat that corrected it still did.
      setItemArchived(handle.db, here.id, Date.now());
      expect(earlier().moduleReplaced).toBe("elsewhere");
    });

    /**
     * Nothing about this may hang on one stamp being later than another:
     * the card and the correction can carry the same millisecond, and
     * then only the order they were written in says which came first.
     */
    it("stops the earlier card when the test-only correction in another chat carries the same millisecond as that card", async () => {
      const at = Date.now() + 60_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(at);
      try {
        const elsewhere = await openedOn("/settings");
        const first = turn(elsewhere, { message: "Here.", modules: [MERGE_MODULE] });
        const module = held();

        clearAssist(handle.db, undefined);
        const here = await openedOn("/settings");
        expect(here.id).not.toBe(elsewhere.id);
        const source = "export default async function (harness) { await harness.run({ ci: 'green' }); }";
        const second = turn(here, { message: "The case was wrong.", modules: [{ ...MERGE_MODULE, tests: [{ description: "merges", source }] }] });
        expect(second.rejections).toEqual([]);

        // One millisecond for all of it: both cards, and the case the correction rewrote.
        const cardAt = (conversationId: string, id: string) => listCommentsForItem(handle.db, conversationId as Uuid).find((comment) => comment.id === id)!.createdAt;
        expect(cardAt(elsewhere.id, first.cardIds[0]!)).toBe(at);
        expect(cardAt(here.id, second.cardIds[0]!)).toBe(at);
        expect(listModuleTests(handle.db, module.id).map((test) => [test.source, test.updatedAt])).toEqual([[source, at]]);

        expect(messageOf(second.cardIds[0]!)).toMatchObject({ canApprove: true, approves: "module", moduleReplaced: null });
        const earlier = resumeAssist(handle.db, { conversationId: elsewhere.id }).conversation!.messages.find((message) => message.id === first.cardIds[0])!;
        expect(earlier).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: "elsewhere" });
      } finally {
        clock.mockRestore();
      }
    });

    it("leaves the earlier card as it was when another chat proposed the same module again", async () => {
      const elsewhere = await openedOn("/settings");
      const first = turn(elsewhere, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();

      clearAssist(handle.db, undefined);
      const here = await openedOn("/settings");
      saveModuleTest(handle.db, { moduleId: module.id, description: "leaves the tag alone", source: "export default async function () {}" }, Date.now() + 500);
      expect(turn(here, { message: "Again.", modules: [MERGE_MODULE] }).rejections).toEqual([]);

      const earlier = resumeAssist(handle.db, { conversationId: elsewhere.id }).conversation!.messages.find((message) => message.id === first.cardIds[0])!;
      expect(earlier.moduleReplaced).toBeNull();
    });

    it("stops a card offering Approve once the module is edited in Settings, and not when only a case is added there", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const module = held();

      saveModuleTest(handle.db, { moduleId: module.id, description: "leaves the tag alone", source: "export default async function () {}" });
      expect(messageOf(cardIds[0]!).moduleReplaced).toBeNull();

      const edited = saveModule(handle.db, { id: module.id, slug: module.slug, name: module.name, description: module.description, code: FIXED_CODE, manifest: module.manifest });
      expect(edited.ok).toBe(true);
      expect(messageOf(cardIds[0]!).moduleReplaced).toBe("elsewhere");
    });

    it("leaves a card for a module since deleted to say that itself", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      archiveModule(handle.db, held().id);

      expect(messageOf(cardIds[0]!).moduleReplaced).toBeNull();
    });

    it("marks the first of two cards for one slug in the same turn replaced by the second, which is what was saved", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Twice over.", modules: [MERGE_MODULE, CORRECTED] });

      expect(rejections).toEqual([]);
      expect(cardIds).toHaveLength(2);
      // The second was written over the first, in the one transaction.
      expect(listModules(handle.db, true).filter((module) => module.slug === MERGE_MODULE.slug)).toHaveLength(1);
      expect(held()).toMatchObject({ code: FIXED_CODE, approvedAt: null });
      expect(messageOf(cardIds[0]!)).toMatchObject({ moduleSlug: MERGE_MODULE.slug, moduleReplaced: "below" });
      expect(messageOf(cardIds[1]!)).toMatchObject({ canApprove: true, approves: "module", moduleSlug: MERGE_MODULE.slug, moduleReplaced: null });
    });

    it("writes nothing over the module when the draft beside it is refused", async () => {
      // Thirty minutes per run: the draft's 58-minute step is refused.
      setSetting(handle.db, GUARDS_KEY, { wallClockTimeoutMs: 30 * 60 * 1000 });
      const conversation = await openedOn("/settings");
      turn(conversation, { message: "Here.", modules: [MERGE_MODULE] });
      const before = held();

      const { cardIds, rejections } = turn(conversation, { message: "Fixed.", draft: releaseDraft({ newPipeline: "Release" }), modules: [CORRECTED] });

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain("longer than the run timeout");
      expect(held()).toEqual(before);
    });

    it("still refuses Publish on a card whose module was replaced from somewhere else after it was drawn", async () => {
      allowAnHourPerRun();
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: releaseDraft({ newPipeline: "Release" }), modules: [MERGE_MODULE] });
      const module = held();
      // Rewritten, as another chat's correction would — the card above describes the earlier code.
      const edited = saveModule(handle.db, { id: module.id, slug: module.slug, name: module.name, description: module.description, code: FIXED_CODE, manifest: module.manifest });
      expect(edited.ok).toBe(true);
      approvedLater(module.id);

      expect(publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! })).toMatchObject({
        saved: false,
        problem: expect.stringContaining("different code or a different manifest"),
      });
      expect(pipelinesNamed("Release")).toEqual([]);
    });
  });

  describe("naming an existing pipeline", () => {
    /** A second pipeline, Hotfix, with a graph of its own. */
    function hotfix(): string {
      const pipeline = createPipeline(handle.db, { projectId: null, name: "Hotfix" });
      replacePipelineGraph(
        handle.db,
        pipeline.id,
        [
          { id: "hotfix_fix", pipelineId: pipeline.id as Uuid, position: 0, name: "Fix", type: "agent", ownerRole: "implementer", entryAction: "implement", isTerminal: false },
          { id: "hotfix_done", pipelineId: pipeline.id as Uuid, position: 1, name: "Done", type: "user", isTerminal: true },
        ],
        [{ pipelineId: pipeline.id as Uuid, fromStepId: "hotfix_fix", resultKey: "done", label: "Done", tone: "success", target: "hotfix_done", position: 0 }],
        { entryStepId: "hotfix_fix" },
      );
      return pipeline.id;
    }

    function hotfixWithReview(pipelineId: string, extra: Record<string, unknown> = {}) {
      return {
        rationale: "A review step before Done.",
        entryStepId: "hotfix_fix",
        target: { pipelineId },
        steps: [
          { id: "hotfix_fix", position: 0, name: "Fix", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false, planMode: false, ...extra },
          { id: "hotfix_review", position: 1, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false, planMode: false },
          { id: "hotfix_done", position: 2, name: "Done", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
        ],
        routes: [
          { fromStepId: "hotfix_fix", resultKey: "done", label: "Done", tone: "success", target: "hotfix_review", position: 0 },
          { fromStepId: "hotfix_review", resultKey: "approved", label: "Approved", tone: "success", target: "hotfix_done", position: 0 },
          { fromStepId: "hotfix_review", resultKey: "changes_requested", label: "Changes", tone: "warning", target: "hotfix_fix", position: 1 },
          { fromStepId: "hotfix_review", resultKey: "needs_user_input", label: "Ask", tone: "info", target: "user_attention", position: 2 },
        ],
      };
    }

    it("publishes into that pipeline whichever screen it was asked from", async () => {
      const pipelineId = hotfix();
      // Asked on the Delivery board, about Hotfix.
      const conversation = await openedOn("/pipelines/default");
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: hotfixWithReview(pipelineId) }, [{ tool: PIPELINE_READ, pipelineId }]);
      expect(rejections).toEqual([]);

      const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(read).toMatchObject({ pipelineId, newPipelineName: null, problem: null });
      expect(read.steps.every((step) => step.pipelineId === pipelineId)).toBe(true);

      registerHandler("pipeline:save", (payload) => savePipeline(handle.db, undefined, payload), opts);
      await dispatchIpc("pipeline:save", { pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId });
      expect(listStepsForPipeline(handle.db, pipelineId).map((step) => step.id)).toContain("hotfix_review");
      // And not the board it was asked from.
      expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "hotfix_review")).toBe(false);
    });

    it("is refused unless the turn read that pipeline, even from a board it did read", async () => {
      const pipelineId = hotfix();
      const conversation = await openedOn("/pipelines/default");
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: hotfixWithReview(pipelineId) }, [{ tool: PIPELINE_READ, pipelineId: "default" }]);

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain(`\`${pipelineId}\``);
    });

    it("is refused for a pipeline that is not there", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: hotfixWithReview("no-such-pipeline") }, [
        { tool: PIPELINE_READ, pipelineId: "no-such-pipeline" },
      ]);

      expect(cardIds).toEqual([]);
      expect(rejections.join(" ")).toContain("there is no pipeline by that id");
    });

    // Tuning a step that already exists is offered rather than refused
    // since EO-520 — see `assistDraftTuning.test.ts`.
  });

  describe("a draft that brings the action definitions it needs (EO-426)", () => {
    const UNDEFINED_ACTION = 'its answer is not validated and will route as "done"';

    /** `qa` defines `alignment`, as the agent writes it beside a draft. */
    const ALIGNMENT = {
      role: "qa",
      action: "alignment",
      description: "Check the work against what was asked for.",
      results: [
        { key: "aligned", label: "Aligned", meaning: "Everything asked for is there." },
        { key: "gaps_found", label: "Gaps found", meaning: "Something asked for is missing." },
      ],
    };

    /** A two-step pipeline whose one working step is `qa` on `alignment`, routing `aligned` and `second`. */
    function qaDraft(target: Record<string, string>, second = "gaps_found") {
      return {
        rationale: "A pipeline that checks work against what was asked for.",
        entryStepId: "qa_gate_check",
        target,
        steps: [
          { id: "qa_gate_check", position: 0, name: "Check", type: "agent", ownerRole: "qa", entryAction: "alignment", instructionsSummary: null, isTerminal: false, planMode: false },
          { id: "qa_gate_done", position: 1, name: "Checked", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true, planMode: false },
        ],
        routes: [
          { fromStepId: "qa_gate_check", resultKey: "aligned", label: "Aligned", tone: "success", target: "qa_gate_done", position: 0 },
          { fromStepId: "qa_gate_check", resultKey: second, label: "Not aligned", tone: "danger", target: "user_attention", position: 1 },
        ],
      };
    }

    function cardBody(conversation: Item, cardId: Uuid): string {
      return listCommentsForItem(handle.db, conversation.id).find((comment) => comment.id === cardId)!.body;
    }

    it("lists each proposed definition with its result keys on the card, and saves none of them", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [ALIGNMENT] });

      expect(rejections).toEqual([]);
      const card = cardBody(conversation, cardIds[0]!);
      expect(card).toContain("**New action** qa / alignment — Check the work against what was asked for.");
      expect(card).toContain("Returns: `aligned` (Aligned), `gaps_found` (Gaps found)");
      expect(card).not.toContain(UNDEFINED_ACTION);
      expect(listActionDefinitions(handle.db)).toEqual([]);
    });

    it("offers the same draft without the definition under the undefined-action warning", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds } = turn(conversation, { message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }) });

      expect(cardBody(conversation, cardIds[0]!)).toContain(UNDEFINED_ACTION);
    });

    it("creates the pipeline and writes its definitions in one publish", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [ALIGNMENT] });

      // What the card's button reads first: the graph, with the definitions beside it.
      const drawn = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(drawn.actions).toMatchObject([{ role: "qa", action: "alignment", fields: {} }]);

      const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

      expect(published).toMatchObject({ saved: true, problem: null });
      expect(pipelinesNamed("QA gate")).toHaveLength(1);
      expect(getActionDefinition(handle.db, "qa", "alignment")!.results.map((result) => result.key)).toEqual(["aligned", "gaps_found"]);
    });

    it("marks a change to an existing definition, and publishing it replaces the definition with the graph", async () => {
      const conversation = await openedOn("/settings");
      const first = turn(conversation, { message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [ALIGNMENT] });
      const { pipelineId } = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: first.cardIds[0]! });

      const changed = { ...ALIGNMENT, results: [ALIGNMENT.results[0], { key: "blocked", label: "Blocked", meaning: "It cannot be checked yet." }] };
      const { cardIds, rejections } = turn(conversation, { message: "Here.", draft: qaDraft({ pipelineId: pipelineId! }, "blocked"), actions: [changed] }, [
        { tool: PIPELINE_READ, pipelineId: pipelineId! },
      ]);

      expect(rejections).toEqual([]);
      const card = cardBody(conversation, cardIds[0]!);
      expect(card).toContain("**Changed action** qa / alignment");
      expect(card).toContain("Adds: `blocked` · Removes: `gaps_found`");
      // Nothing changed by drawing the card.
      expect(getActionDefinition(handle.db, "qa", "alignment")!.results.map((result) => result.key)).toEqual(["aligned", "gaps_found"]);

      // Publish, as the chat's button does it: the graph read back, sent to `pipeline:save` with its definitions.
      const read = readAssistDraftForPublish(handle.db, { conversationId: conversation.id, messageId: cardIds[0]! });
      expect(read.problem).toBeNull();
      const saved = savePipeline(handle.db, undefined, { pipelineId: read.pipelineId!, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, actions: read.actions });

      expect(saved.saved).toBe(true);
      expect(getActionDefinition(handle.db, "qa", "alignment")!.results.map((result) => result.key)).toEqual(["aligned", "blocked"]);
      expect(listRoutesForPipeline(handle.db, pipelineId!).map((route) => route.resultKey).sort()).toEqual(["aligned", "blocked"]);
    });

    it("refuses a definition the save rules refuse with the reason, and posts no card", async () => {
      const conversation = await openedOn("/settings");

      const { cardIds, rejections } = turn(conversation, {
        message: "Here.",
        draft: qaDraft({ newPipeline: "QA gate" }),
        actions: [ALIGNMENT, { role: "implementer", action: "implement", results: [{ key: "done" }] }],
      });

      expect(cardIds).toEqual([]);
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toContain(`The implementer role's "implement" action cannot be redefined`);
      expect(listActionDefinitions(handle.db)).toEqual([]);
    });

    it("is refused naming the agents section where that section is managed, creating and writing nothing", async () => {
      const conversation = await openedOn("/settings");
      const { cardIds } = turn(conversation, { message: "Here.", draft: qaDraft({ newPipeline: "QA gate" }), actions: [ALIGNMENT] });
      const stopBeingAReplica = markReplica(handle.db, () => true);
      publishSection(handle.db, { section: "agents", publishedAt: Date.now(), publishedBy: null, publishedByName: "Dana" });

      try {
        const published = publishNewAssistPipeline(handle.db, undefined, { conversationId: conversation.id, messageId: cardIds[0]! });

        expect(published.saved).toBe(false);
        expect(published.problem).toContain("The agents section is managed by your organisation.");
        expect(pipelinesNamed("QA gate")).toEqual([]);
        expect(listActionDefinitions(handle.db)).toEqual([]);
      } finally {
        stopBeingAReplica();
      }
    });
  });
});
