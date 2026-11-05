import { ADMIN_MCP_SERVER_NAME, type Agent, type AssistReply, type DiscussionQuestion, type PipelineDraft, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  appendRunEvent,
  createRun,
  deleteItem,
  getItem,
  getSetting,
  listArchivedItems,
  listCommentsForItem,
  listMentionsForComment,
  listRoutesForPipeline,
  listRunsForItem,
  listStepsForPipeline,
  listItemsIncludingArchived,
  offBoardStepIds,
  postComment,
  setItemArchived,
  updateRun,
  updateItem,
} from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { findPendingResponses } from "../supervisor/manualDispatch.js";
import {
  ASSIST_ACTION,
  ASSIST_STEP,
  DEFAULT_ASSIST_EXPIRY_DAYS,
  assistAgent,
  assistBoardFor,
  ASSIST_ORDER_KEY,
  assistBoards,
  clearAssistRoom,
  listAssistThreads,
  liveAssistConversations,
  newAssistRoom,
  openAssistConversation,
  openAssistRoom,
  orderedAssistConversations,
  postAssistReply,
  readAssistDraft,
  readAssistExpiryDays,
  recordAssistBoard,
  reorderAssistConversation,
  resumeAssistRoom,
  shownAssistConversation,
  writeAssistExpiryDays,
} from "./assist.js";
import { PROPOSAL_KIND } from "./proposal.js";
import { createRoleWiring } from "../packs/developer/wiring.js";

let handle: DbHandle;
let agent: Agent;

const DAY = 24 * 60 * 60 * 1000;

/** The read that answers with a pipeline's graph, as Claude Code advertises it. */
const PIPELINE_READ = `mcp__${ADMIN_MCP_SERVER_NAME}__pipeline_get`;

/** One scripted read: the tool, and the board it asked that tool for. */
interface ScriptedRead {
  tool: string;
  pipelineId?: string;
}

/**
 * The one thread, opened.
 *
 * A helper rather than a call, because "which conversation you get" is
 * the thing this story changed: every case that used to name a page now
 * names none, and reading `openAssistRoom(handle.db, null)` twenty times
 * would hide how little is left to say.
 */
function open() {
  return openAssistRoom(handle.db, null);
}

/**
 * The thread, with somebody having asked something from `pipelineId`'s
 * board — or from a screen that is not one, for null.
 *
 * A message and not just a row, because a board is pinned to the message
 * it was asked from (EO-193): there is no such thing as "the board this
 * conversation is on" any more, only the board each exchange started
 * from.
 */
function askedFrom(pipelineId: string | null): Item {
  const conversation = open().conversation;
  return recordAssistBoard(handle.db, conversation, says(conversation, "what is here?"), pipelineId);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  agent = assistAgent(handle.db)!;
});

afterEach(() => {
  vi.useRealTimers();
  handle.close();
});

/** The shipped pipeline as a draft — the baseline every draft case edits, read rather than written out. */
function currentGraph(): PipelineDraft {
  return {
    rationale: "No change.",
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
}

/**
 * Runs one turn: records a succeeded `assist` run carrying `output`, then
 * posts what it came back with — the same two steps the supervisor and
 * `wiring.ts` take between them.
 *
 * `read` is the third thing a turn leaves behind, and it defaults to a
 * turn that asked for this board's graph and got an answer (EO-208): a
 * draft raised by a run whose log holds no such read is refused, so a
 * helper that logged nothing would quietly turn every draft case here
 * into a test of that refusal. The answer as well as the call, because
 * the gate wants both — asking is not being told. Null is how a case
 * asks for the run that read nothing.
 */
function turn(
  conversation: Item,
  output: AssistReply,
  read: ScriptedRead | null = { tool: PIPELINE_READ, pipelineId: "default" },
): { runId: Uuid; cardIds: Uuid[] } {
  // The comment that started it, as the mention path sets it — which is
  // what a turn answers for when it is asked which board it was started
  // from. The newest human comment is the one that woke the supervisor.
  const initiation = startedBy(conversation);
  const run = createRun(handle.db, {
    itemId: conversation.id,
    agentId: agent.id,
    action: ASSIST_ACTION,
    ...(initiation === undefined ? {} : { initiationId: initiation }),
  });
  // Written before the reply is posted, as the supervisor has it: the
  // event buffer is flushed before the terminal state is decided, so a
  // run's log is complete by the time `wiring.ts` posts its result.
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

/** The newest thing a person said here, which is what a turn would have been dispatched by. */
function startedBy(conversation: Item): Uuid | undefined {
  return listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.authorType === "human")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .at(-1)?.id;
}

function says(conversation: Item, body: string): Uuid {
  return postComment(handle.db, {
    itemId: conversation.id,
    author: { type: "human" },
    body,
    mentions: [{ type: "agent", agentId: agent.id }],
  }).id;
}

function bodies(conversation: Item, kind: string): string[] {
  return listCommentsForItem(handle.db, conversation.id)
    .filter((comment) => comment.kind === kind)
    .map((comment) => comment.body);
}

const question: DiscussionQuestion = {
  id: "scope",
  question: "Which pipeline should that story go on?",
  why: "Every step of the wrong pipeline is the wrong step.",
  options: ["Default", "Hotfix"],
};

describe("the conversation", () => {
  it("lives on its own off-board step, and there is one of it", () => {
    const { conversation, resumed } = open();

    expect(resumed).toBe(false);
    expect(conversation.stepId).toBe(ASSIST_STEP);
    // Nothing is keyed on a page any more (EO-193): the thread is about
    // the person's conversation, not about a screen.
    expect(conversation.spec?.["assist"]).toBeUndefined();
    // Derived from the step, so the conversation joins the hidden
    // pipeline without anyone naming it, and `ASK-` keeps chat numbers
    // out of the sequence people read and quote.
    expect(conversation.pipelineId).toBe("discussions");
    expect(conversation.key.startsWith("ASK-")).toBe(true);
    // Off-board is what keeps it off the board, out of the inbox and out
    // of the archive sweep — and what `findPendingResponses` requires
    // before it will read the action off the step at all.
    expect(offBoardStepIds(handle.db).has(ASSIST_STEP)).toBe(true);
  });

  /**
   * Keyed on the step, so the right output schema is selected. Dispatched
   * as `respond` it would come back as prose, and a draft could not be
   * read out of it at all.
   */
  it("dispatches as `assist` when the system agent is mentioned", () => {
    const { conversation } = open();
    says(conversation, "Move this to Review.");

    const pending = findPendingResponses(handle.db, [conversation.id]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action).toBe(ASSIST_ACTION);
    expect(pending[0]?.agentId).toBe(agent.id);
  });

  /**
   * A conversation left on the step Discussions used, should one ever
   * survive the startup deletion (EO-526), is no room at all: a mention
   * there is answered as any other mention is, never as a `discuss` turn.
   */
  it("dispatches a mention on the retired Discussions step as `respond`, not `discuss`", () => {
    const leftover = createTestItem(handle.db, { type: "feature", title: "Conversation", stepId: "discussion", keyPrefix: "DISC" });
    postComment(handle.db, {
      itemId: leftover.id,
      author: { type: "human" },
      body: "Plan this",
      mentions: [{ type: "agent", agentId: agent.id }],
    });

    expect(findPendingResponses(handle.db, [leftover.id])[0]?.action).toBe("respond");
  });
});

/**
 * One thread, whatever screen it is opened from (EO-193).
 *
 * The rule this story replaced was one per *page*, and it existed
 * because EO-189 preloaded that page into every turn. EO-192 removed the
 * preloading, so a thread is no longer about anywhere — and keying it on
 * a page only cut a conversation in half every time somebody walked from
 * an item to the board to check something.
 */
describe("one thread", () => {
  it("resumes the same conversation, with its history, wherever it is opened", () => {
    const first = open().conversation;
    says(first, "What is blocking this?");
    turn(first, { message: "EO-12 is not merged yet.", questions: [], proposals: [] });

    // Opened again from a different screen entirely — which used to be
    // the case that started a second thread.
    const again = openAssistRoom(handle.db, null);

    expect(again.resumed).toBe(true);
    expect(again.conversation.id).toBe(first.id);
    expect(again.expired).toBeUndefined();
    expect(listCommentsForItem(handle.db, again.conversation.id).map((comment) => comment.body)).toEqual([
      "What is blocking this?",
      "EO-12 is not merged yet.",
    ]);
    // One thread, not two: closing the widget and opening it again is not
    // a new conversation, and neither is walking to another screen.
    expect(listItemsIncludingArchived(handle.db).filter((item) => item.stepId === ASSIST_STEP)).toHaveLength(1);
  });

  /**
   * The board an exchange was started from is recorded, and it is the
   * only thing about a screen that is: a draft carries no pipeline of its
   * own, so without this a graph proposed on a board could not be
   * published against it. Verified rather than believed — a board that is
   * not there reads as no board at all (invariant #5).
   */
  it("pins the board to the message it was asked from, and only a board that exists", () => {
    const conversation = open().conversation;
    const onABoard = says(conversation, "add a QA step");
    const nowhere = says(conversation, "and how long may a run take?");

    expect(assistBoards(recordAssistBoard(handle.db, conversation, onABoard, "default"))).toEqual([
      { from: onABoard, pipelineId: "default" },
    ]);
    // A board this installation does not have is no board at all.
    expect(assistBoards(recordAssistBoard(handle.db, conversation, nowhere, "no-such-pipeline"))).toContainEqual({
      from: nowhere,
      pipelineId: null,
    });
    // Asking from Settings does not rub out where the earlier question
    // was asked from — that exchange is still on the board it was on.
    expect(assistBoards(getItem(handle.db, conversation.id)!)).toEqual([
      { from: onABoard, pipelineId: "default" },
      { from: nowhere, pipelineId: null },
    ]);
  });

  /** Merged into what the room already keeps, so a model set for this thread survives a walk. */
  it("keeps this conversation's own settings when a board is recorded", () => {
    const conversation = updateItem(handle.db, open().conversation.id, { spec: { assist: { model: "opus" } } })!;
    const asked = says(conversation, "add a QA step");

    const recorded = recordAssistBoard(handle.db, conversation, asked, "default");

    expect(recorded.spec?.["assist"]).toEqual({ model: "opus", boards: [{ from: asked, pipelineId: "default" }] });
  });

  /**
   * The reason a board belongs to a turn rather than to the room.
   *
   * The panel stays open across a walk — that is the whole premise of one
   * thread — so a person can ask for a graph on a board, wander off and
   * send a follow-up from Settings while the first turn is still
   * thinking. Read as "wherever the conversation is now", the first
   * turn's draft would render against Settings and be refused, or against
   * another board and be *published there*. Each turn answers for its
   * own exchange instead.
   */
  it("answers each turn with the board that turn was started from, not the newest one", () => {
    const conversation = open().conversation;
    const onABoard = says(conversation, "add a QA step after Review");
    recordAssistBoard(handle.db, conversation, onABoard, "default");
    const pending = createRun(handle.db, {
      itemId: conversation.id,
      agentId: agent.id,
      action: ASSIST_ACTION,
      initiationId: onABoard,
    });

    // The walk, mid-turn.
    const fromSettings = says(conversation, "and how long may a run take?");
    const after = recordAssistBoard(handle.db, conversation, fromSettings, null);
    const second = createRun(handle.db, {
      itemId: conversation.id,
      agentId: agent.id,
      action: ASSIST_ACTION,
      initiationId: fromSettings,
    });

    expect(assistBoardFor(handle.db, after, pending.id)).toBe("default");
    expect(assistBoardFor(handle.db, after, second.id)).toBeNull();
  });

  /**
   * Answering a question card starts a turn too, and its initiating
   * comment is the answer rather than anything somebody typed on a board.
   * It belongs to the exchange it is part of, so it inherits the board
   * standing at that moment — which is what "at or before" buys.
   */
  it("gives a turn started by an answer the board its exchange was started from", () => {
    const conversation = open().conversation;
    const asked = says(conversation, "add a QA step after Review");
    const recorded = recordAssistBoard(handle.db, conversation, asked, "default");
    // The answer to the question that turn came back with.
    const answered = says(conversation, "the reviewer owns it");
    const next = createRun(handle.db, {
      itemId: conversation.id,
      agentId: agent.id,
      action: ASSIST_ACTION,
      initiationId: answered,
    });

    expect(assistBoardFor(handle.db, recorded, next.id)).toBe("default");
  });

  /**
   * What keeps the log small, and the reason it is this and not a cap on
   * how many entries are kept.
   *
   * An entry naming the same board as the one before it answers no
   * question differently — the lookup takes the newest entry at or before
   * a turn's initiating comment — so dropping it costs nothing. Dropping
   * the *oldest* entries to make room costs the one thing that must never
   * be lost: the board a turn still in flight was started from.
   */
  it("records a change of board rather than a message, and drops nothing a turn could reach", () => {
    const conversation = open().conversation;
    const first = says(conversation, "add a QA step after Review");
    recordAssistBoard(handle.db, conversation, first, "default");

    // Four more questions from the same board say nothing new.
    for (const body of ["and after that?", "what about QA?", "who owns it?", "does it block merge?"]) {
      recordAssistBoard(handle.db, conversation, says(conversation, body), "default");
    }
    expect(assistBoards(getItem(handle.db, conversation.id)!)).toEqual([{ from: first, pipelineId: "default" }]);

    // Walking off the board does, and walking back on says something
    // new again.
    const away = says(conversation, "and how long may a run take?");
    recordAssistBoard(handle.db, conversation, away, null);
    const back = says(conversation, "back to the board");
    const log = assistBoards(recordAssistBoard(handle.db, conversation, back, "default"));

    expect(log).toEqual([
      { from: first, pipelineId: "default" },
      { from: away, pipelineId: null },
      { from: back, pipelineId: "default" },
    ]);
    // And every one of those questions still resolves to the board it was
    // asked from — the collapsed ones included.
    const pending = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION, initiationId: first });
    expect(assistBoardFor(handle.db, getItem(handle.db, conversation.id)!, pending.id)).toBe("default");
  });

  /** A run nobody initiated is answered honestly rather than with a guess. */
  it("answers no board for a run with no initiating comment", () => {
    const conversation = askedFrom("default");
    const orphan = createRun(handle.db, { itemId: conversation.id, agentId: agent.id, action: ASSIST_ACTION });

    expect(assistBoardFor(handle.db, conversation, orphan.id)).toBeNull();
  });
});

/**
 * Clear (EO-193).
 *
 * The manual form of the expiry below, and archiving for the same
 * reason: nothing is destroyed, so nothing needs confirming.
 */
describe("clearing the thread", () => {
  it("archives what was said and hands back an empty thread", () => {
    const first = open().conversation;
    says(first, "Why is this waiting?");
    const { runId } = turn(first, { message: "It is waiting for EO-12.", questions: [], proposals: [] });

    const cleared = clearAssistRoom(handle.db, null);

    expect(cleared.conversation.id).not.toBe(first.id);
    expect(cleared.resumed).toBe(false);
    // Archived, not deleted (invariant #3): the comments and the run are
    // exactly where they were, and the thread is readable in the archive.
    expect(cleared.expired?.id).toBe(first.id);
    expect(cleared.expired?.archivedAt).not.toBeNull();
    expect(listCommentsForItem(handle.db, first.id).map((comment) => comment.body)).toEqual([
      "Why is this waiting?",
      "It is waiting for EO-12.",
    ]);
    expect(listRunsForItem(handle.db, first.id).map((run) => run.id)).toEqual([runId]);
    expect(listArchivedItems(handle.db).map((item) => item.id)).toContain(first.id);

    // And the next opening is the empty one rather than the archived one.
    expect(listCommentsForItem(handle.db, cleared.conversation.id)).toEqual([]);
    expect(openAssistRoom(handle.db, null).conversation.id).toBe(cleared.conversation.id);
  });

  it("does nothing at all to a thread nobody has spoken in", () => {
    const empty = open().conversation;

    const cleared = clearAssistRoom(handle.db, null);

    // The same thread, still live, and no `ASK-` key burnt on a
    // conversation nobody had.
    expect(cleared.conversation.id).toBe(empty.id);
    expect(cleared.expired).toBeUndefined();
    expect(listItemsIncludingArchived(handle.db).filter((item) => item.stepId === ASSIST_STEP)).toHaveLength(1);
  });

  it("starts a thread when there is none, rather than refusing", () => {
    const cleared = clearAssistRoom(handle.db, null);

    expect(cleared.conversation.stepId).toBe(ASSIST_STEP);
    expect(listCommentsForItem(handle.db, cleared.conversation.id)).toEqual([]);
  });
});

/**
 * Several live chats, and one of them on show (EO-391).
 *
 * The room's own half: which chat is which. That nothing is stopped or
 * dismissed on the way is `ipc/assistCommands.test.ts`'s, where the
 * engine is.
 */
describe("several live chats", () => {
  it("keeps the chat that was on show live when a new one is started", () => {
    const first = open().conversation;
    says(first, "Rework the release pipeline.");

    const started = newAssistRoom(handle.db, null);

    expect(started.resumed).toBe(false);
    expect(started.expired).toBeUndefined();
    expect(started.conversation.id).not.toBe(first.id);
    expect(getItem(handle.db, first.id)?.archivedAt).toBeNull();
    expect(liveAssistConversations(handle.db).map((item) => item.id).sort()).toEqual([first.id, started.conversation.id].sort());
    // The new one is what every opening answers with from here.
    expect(openAssistRoom(handle.db, null).conversation.id).toBe(started.conversation.id);
    expect(shownAssistConversation(handle.db)?.id).toBe(started.conversation.id);
  });

  it("shows another live chat without writing to the one left behind", () => {
    const first = open().conversation;
    says(first, "Rework the release pipeline.");
    const second = newAssistRoom(handle.db, null).conversation;
    says(second, "What does Hold do?");
    const left = getItem(handle.db, second.id);

    const back = resumeAssistRoom(handle.db, first.id);

    expect(back).toMatchObject({ resumed: true, conversation: { id: first.id } });
    expect("expired" in back).toBe(false);
    expect(getItem(handle.db, second.id)).toEqual(left);
    expect(openAssistRoom(handle.db, null).conversation.id).toBe(first.id);
    expect(liveAssistConversations(handle.db)).toHaveLength(2);
  });

  /**
   * No migration (EO-391): a database written while there was one live
   * thread stores no id for the chat on show, and that thread is simply
   * the one shown.
   */
  it("shows the live thread of a database that never stored which one", () => {
    const only = openAssistConversation(handle.db, null);
    says(only, "From before there were several.");

    expect(shownAssistConversation(handle.db)?.id).toBe(only.id);
    const opened = openAssistRoom(handle.db, null);
    expect(opened).toMatchObject({ resumed: true, conversation: { id: only.id } });
    expect(getItem(handle.db, only.id)?.archivedAt).toBeNull();
  });

  it("falls back to the newest live chat when the one stored has been put away by another path", () => {
    const first = open().conversation;
    says(first, "Rework the release pipeline.");
    const second = newAssistRoom(handle.db, null).conversation;
    says(second, "What does Hold do?");
    setItemArchived(handle.db, second.id, Date.now());

    expect(shownAssistConversation(handle.db)?.id).toBe(first.id);
  });

  it("marks every live chat in the list, and exactly one as shown", () => {
    const first = open().conversation;
    says(first, "Rework the release pipeline.");
    const second = newAssistRoom(handle.db, null).conversation;
    says(second, "What does Hold do?");
    clearAssistRoom(handle.db, null);

    const listed = listAssistThreads(handle.db).map((thread) => [thread.title, thread.conversation.archivedAt === null, thread.shown]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ["Rework the release pipeline.", true, false],
        ["What does Hold do?", false, false],
        ["Assistant", true, true],
      ]),
    );
    expect(listed).toHaveLength(3);
  });
});

/**
 * Where each open chat stands (EO-438).
 *
 * The order is the person's and it is stored. The list used to be sorted
 * by last activity, and `resumeAssistRoom` stamps one on every switch —
 * so opening a chat moved it to the top and pushed the others down.
 */
describe("the order of the open chats", () => {
  const start = new Date("2026-08-01T09:00:00Z").getTime();
  let clock = start;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    clock = start;
    vi.setSystemTime(clock);
  });

  /** A minute passes: no two chats are started, and no two things said, at the same moment. */
  function later(): void {
    clock += 60_000;
    vi.setSystemTime(clock);
  }

  /** A new chat with something said in it, started after everything before it. */
  function chat(body: string): Item {
    later();
    const started = newAssistRoom(handle.db, null).conversation;
    says(started, body);
    return started;
  }

  const order = () => orderedAssistConversations(handle.db).map((item) => item.id);
  /** What `assist:list` is built from: the open chats, then the put-away ones. */
  const listed = (live: boolean) =>
    listAssistThreads(handle.db)
      .filter((thread) => (thread.conversation.archivedAt === null) === live)
      .map((thread) => thread.conversation.id);

  it("puts a new chat at the top and leaves the others as they were", () => {
    const a = chat("Rework the release pipeline.");
    const b = chat("What does Hold do?");
    reorderAssistConversation(handle.db, a.id, 0);
    expect(order()).toEqual([a.id, b.id]);

    const c = chat("Why is the weekly report late?");

    expect(order()).toEqual([c.id, a.id, b.id]);
    expect(listed(true)).toEqual([c.id, a.id, b.id]);
  });

  it("does not move a chat for being shown, spoken in or answered", () => {
    const a = chat("Rework the release pipeline.");
    const b = chat("What does Hold do?");
    const c = chat("Why is the weekly report late?");
    const before = order();
    expect(before).toEqual([c.id, b.id, a.id]);

    later();
    expect(resumeAssistRoom(handle.db, a.id)).toMatchObject({ conversation: { id: a.id } });
    expect(listed(true)).toEqual(before);
    later();
    says(a, "And the hotfix one?");
    turn(a, { message: "That one too.", questions: [], proposals: [] });
    expect(listed(true)).toEqual(before);
    later();
    resumeAssistRoom(handle.db, b.id);
    expect(listed(true)).toEqual(before);

    // The activity is still there to be read, and still newest in the chat just spoken in.
    const activity = new Map(listAssistThreads(handle.db).map((thread) => [thread.conversation.id, thread.lastActivityAt]));
    expect(activity.get(a.id)).toBeGreaterThan(activity.get(c.id)!);
    // Nothing above was a person arranging anything, so nothing was stored.
    expect(getSetting<unknown>(handle.db, ASSIST_ORDER_KEY, null)).toBeNull();
  });

  /** No migration: a database from before the order was stored has no order, and reads newest-started first. */
  it("lists the open chats of a database that never stored an order newest-started first, until one is moved", () => {
    const made = ["Rework the release pipeline.", "What does Hold do?", "Why is the weekly report late?"].map((body) => {
      later();
      const conversation = openAssistConversation(handle.db, null);
      says(conversation, body);
      return conversation;
    });
    const [oldest, middle, newest] = made as [Item, Item, Item];
    expect(order()).toEqual([newest.id, middle.id, oldest.id]);

    later();
    resumeAssistRoom(handle.db, oldest.id);
    later();
    says(oldest, "Still about the release.");
    expect(listed(true)).toEqual([newest.id, middle.id, oldest.id]);

    expect(reorderAssistConversation(handle.db, oldest.id, 1)).toEqual({ problem: null });
    expect(listed(true)).toEqual([newest.id, oldest.id, middle.id]);
  });

  it("moves one chat to the place asked for and keeps the others in their order", () => {
    const a = chat("One");
    const b = chat("Two");
    const c = chat("Three");
    const d = chat("Four");
    expect(order()).toEqual([d.id, c.id, b.id, a.id]);

    reorderAssistConversation(handle.db, d.id, 2);
    expect(order()).toEqual([c.id, b.id, d.id, a.id]);
    reorderAssistConversation(handle.db, a.id, 0);
    expect(order()).toEqual([a.id, c.id, b.id, d.id]);
    // Past the end is the end.
    reorderAssistConversation(handle.db, c.id, 99);
    expect(order()).toEqual([a.id, b.id, d.id, c.id]);

    // Stored, not remembered: it is what the next reader of the database finds.
    expect(getSetting<unknown>(handle.db, ASSIST_ORDER_KEY, null)).toEqual([a.id, b.id, d.id, c.id]);
    // And it holds through everything that used to reorder the list.
    later();
    resumeAssistRoom(handle.db, d.id);
    later();
    says(b, "And another thing.");
    expect(listed(true)).toEqual([a.id, b.id, d.id, c.id]);
  });

  it("puts a chat gone back to from the earlier ones last, and moves none of the open ones", () => {
    const a = chat("One");
    const b = chat("Two");
    const c = chat("Three");
    reorderAssistConversation(handle.db, a.id, 0);
    later();
    setItemArchived(handle.db, b.id, Date.now());
    expect(order()).toEqual([a.id, c.id]);
    expect(listed(false)).toEqual([b.id]);

    later();
    resumeAssistRoom(handle.db, b.id);

    expect(listed(true)).toEqual([a.id, c.id, b.id]);
    expect(listed(false)).toEqual([]);
  });

  it("puts one gone back to last on a database that never stored an order, too", () => {
    const a = chat("One");
    const b = chat("Two");
    const c = chat("Three");
    later();
    // The newest is the one put away: started last, it would be first by any reading but this one.
    setItemArchived(handle.db, c.id, Date.now());
    expect(getSetting<unknown>(handle.db, ASSIST_ORDER_KEY, null)).toBeNull();

    later();
    resumeAssistRoom(handle.db, c.id);

    expect(listed(true)).toEqual([b.id, a.id, c.id]);
  });

  it("closes the gap when a chat is removed from the middle, and still puts the next new one first", () => {
    const a = chat("One");
    const b = chat("Two");
    const c = chat("Three");
    reorderAssistConversation(handle.db, a.id, 1);
    expect(order()).toEqual([c.id, a.id, b.id]);

    deleteItem(handle.db, a.id);
    expect(listed(true)).toEqual([c.id, b.id]);

    const d = chat("Four");
    expect(listed(true)).toEqual([d.id, c.id, b.id]);
    reorderAssistConversation(handle.db, d.id, 2);
    expect(listed(true)).toEqual([c.id, b.id, d.id]);
    // The removed chat's id went with it.
    expect(getSetting<unknown>(handle.db, ASSIST_ORDER_KEY, null)).toEqual([c.id, b.id, d.id]);
  });

  it("refuses to move a chat that is put away, and leaves the earlier ones most recently active first", () => {
    const a = chat("One");
    const b = chat("Two");
    const c = chat("Three");
    later();
    setItemArchived(handle.db, a.id, Date.now());
    setItemArchived(handle.db, b.id, Date.now());
    later();
    says(a, "Said last, so listed first.");

    expect(reorderAssistConversation(handle.db, b.id, 0)).toEqual({ problem: "That chat is not open any more, so it was not moved." });
    expect(getItem(handle.db, b.id)?.archivedAt).not.toBeNull();
    expect(listed(true)).toEqual([c.id]);
    expect(listed(false)).toEqual([a.id, b.id]);
  });
});

/**
 * Expiry, an idle timeout on each chat (EO-193, EO-391).
 *
 * The setting survives with its meaning narrowed rather than being
 * dropped: the reason it existed — a question asked next week should not
 * silently carry last week's conversation into it — is a reason about a
 * thread, not about a page, and it is if anything stronger now that the
 * one thread is the only one there is.
 */
describe("expiry", () => {
  /**
   * The clock is moved rather than slept through: three days of real time
   * is not a test, and rewriting `created_at` behind the reader's back
   * would test SQL rather than the rule.
   */
  function at(when: number, run: () => void): void {
    vi.setSystemTime(when);
    run();
  }

  it("archives a stale thread rather than resuming it, and keeps everything said in it", () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-01T09:00:00Z").getTime();
    let stale: Item | undefined;

    at(start, () => {
      stale = open().conversation;
      says(stale, "Why is this waiting?");
      turn(stale, { message: "It is waiting for EO-12.", questions: [], proposals: [] });
    });

    let fresh: Item | undefined;
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY, () => {
      const opened = open();
      fresh = opened.conversation;

      expect(opened.resumed).toBe(false);
      expect(opened.expired?.id).toBe(stale!.id);
      // Archived, not deleted (invariant #3): what was said and what it
      // cost stay exactly where they were, and archiving is what stops
      // the mention path ever dispatching against it again.
      expect(opened.expired?.archivedAt).toBe(Date.now());
    });

    expect(fresh?.id).not.toBe(stale!.id);
    expect(listCommentsForItem(handle.db, stale!.id).map((comment) => comment.body)).toEqual([
      "Why is this waiting?",
      "It is waiting for EO-12.",
    ]);
    expect(listRunsForItem(handle.db, stale!.id)).toHaveLength(1);
    // And the fresh one starts empty rather than inheriting any of it.
    expect(listCommentsForItem(handle.db, fresh!.id)).toEqual([]);
    expect(shownAssistConversation(handle.db)?.id).toBe(fresh!.id);
  });

  /**
   * The half that decides between "started three days ago" and "nothing
   * said for three days".
   *
   * Age-since-creation would cut a conversation somebody is in the middle
   * of in half: you talk for a while, close the widget, reopen it, and
   * the agent has lost everything you just said.
   */
  it("keeps a thread that was started days ago but spoken in since", () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-01T09:00:00Z").getTime();
    let conversation: Item | undefined;

    at(start, () => {
      conversation = open().conversation;
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS - 1) * DAY, () => {
      says(conversation!, "Still thinking about this one.");
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY, () => {
      const opened = open();
      expect(opened.resumed).toBe(true);
      expect(opened.conversation.id).toBe(conversation!.id);
    });
  });

  /**
   * Read where it is used, which is `readGuards`' rule: a change applies
   * to the next room opened rather than to the next launch of the app.
   * Both directions, because a setting that only ever loosens is a
   * setting nobody can tighten without restarting.
   */
  it("reads the expiry at use, so changing it applies without a restart", () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-01T09:00:00Z").getTime();
    let conversation: Item | undefined;

    at(start, () => {
      conversation = open().conversation;
    });

    at(start + 4 * DAY, () => {
      // A week, set now, on a database that has been open all along.
      expect(writeAssistExpiryDays(handle.db, 7)).toBe(7);
      expect(open().conversation.id).toBe(conversation!.id);

      // And tightened again, with nothing restarted in between.
      writeAssistExpiryDays(handle.db, 3);
      const opened = open();
      expect(opened.resumed).toBe(false);
      expect(opened.expired?.id).toBe(conversation!.id);
    });
  });

  /**
   * Each chat on its own last word (EO-391). With one thread the idle
   * timeout was a rule about "the" thread; with several, a chat spoken in
   * this morning must not be put away because another went quiet.
   */
  it("archives the chat that went idle and leaves the ones within the window alone", () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-01T09:00:00Z").getTime();
    let idle: Item | undefined;
    let busy: Item | undefined;

    at(start, () => {
      idle = open().conversation;
      says(idle, "Why is this waiting?");
      busy = newAssistRoom(handle.db, null).conversation;
      says(busy, "Rework the release pipeline.");
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS - 1) * DAY, () => {
      says(busy!, "And add a QA step.");
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY, () => {
      const opened = open();

      // The one on show is within the window, so it is what opens.
      expect(opened.resumed).toBe(true);
      expect(opened.conversation.id).toBe(busy!.id);
      // Said to the caller, which is what tells every cached list: the
      // answer alone is the same chat it was before.
      expect(opened.swept).toBe(1);
      expect(getItem(handle.db, busy!.id)?.archivedAt).toBeNull();
      // And the idle one was put away on the way, with what was said in it.
      expect(getItem(handle.db, idle!.id)?.archivedAt).toBe(Date.now());
      expect(listCommentsForItem(handle.db, idle!.id).map((comment) => comment.body)).toEqual(["Why is this waiting?"]);
      expect(liveAssistConversations(handle.db).map((item) => item.id)).toEqual([busy!.id]);
    });
  });

  it("opens a fresh chat when the one on show went idle, without archiving another that did not", () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-01T09:00:00Z").getTime();
    let other: Item | undefined;
    let shown: Item | undefined;

    at(start, () => {
      other = open().conversation;
      says(other, "Rework the release pipeline.");
      shown = newAssistRoom(handle.db, null).conversation;
      says(shown, "What does Hold do?");
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS - 1) * DAY, () => {
      says(other!, "And add a QA step.");
    });
    at(start + (DEFAULT_ASSIST_EXPIRY_DAYS + 1) * DAY, () => {
      const opened = open();

      expect(opened.resumed).toBe(false);
      expect(opened.expired?.id).toBe(shown!.id);
      expect(listCommentsForItem(handle.db, opened.conversation.id)).toEqual([]);
      expect(getItem(handle.db, shown!.id)?.archivedAt).toBe(Date.now());
      expect(getItem(handle.db, other!.id)?.archivedAt).toBeNull();
      expect(shownAssistConversation(handle.db)?.id).toBe(opened.conversation.id);
    });
  });

  it("falls back to three days when nothing is stored, or what is stored is not a number of days", () => {
    // A junk row is not worth failing to open the room over, and both
    // ways of taking one literally are worse: NaN makes every comparison
    // false so nothing ever expires, and a negative expires every thread
    // the moment it is created.
    expect(readAssistExpiryDays(handle.db)).toBe(DEFAULT_ASSIST_EXPIRY_DAYS);
    expect(DEFAULT_ASSIST_EXPIRY_DAYS).toBe(3);

    for (const nonsense of [0, -1, Number.NaN, "soon", { days: 7 }]) {
      writeAssistExpiryDays(handle.db, nonsense as unknown as number);
      expect(readAssistExpiryDays(handle.db)).toBe(DEFAULT_ASSIST_EXPIRY_DAYS);
    }
  });
});

describe("a turn", () => {
  it("posts the message mentioning nobody, and each question as its own card", () => {
    const conversation = askedFrom(null);
    turn(conversation, { message: "Two ways to do that.", questions: [question], proposals: [] });

    const [note] = listCommentsForItem(handle.db, conversation.id).filter(
      (comment) => comment.kind === "note" && comment.authorType === "agent",
    );
    expect(note?.body).toBe("Two ways to do that.");
    // A mention would put every message from a help thread in the Inbox
    // and light `!` on an item nobody can open.
    expect(listMentionsForComment(handle.db, note!.id)).toEqual([]);

    const [card] = listCommentsForItem(handle.db, conversation.id).filter((comment) => comment.kind === "question");
    expect(card?.body).toContain("Which pipeline should that story go on?");
    expect(card?.options).toEqual(["Default", "Hotfix"]);
    expect(card?.parentId).toBeNull();
  });

  /**
   * AC: a decomposition is not applied here.
   *
   * It is posted as a card a person accepts, and accepting it goes
   * through the approval path Discussions already has. A third way to
   * write a story DAG would be a second implementation of the one gate
   * nobody downstream can check for you.
   */
  it("posts a decomposition as a card and creates no items", () => {
    const { conversation } = open();
    const before = listItemsIncludingArchived(handle.db).map((item) => item.id);

    const { cardIds } = turn(conversation, {
      message: "That is really three stories.",
      questions: [],
      proposals: [
        {
          action: "new_feature",
          title: "Rate limiting",
          understanding: "Cap what one key can do per minute.",
          decisions: [],
          stories: [
            { title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts are per key"], depends_on: [], touches: [] },
            { title: "Refuse over the cap", body: "429 with a header.", acceptance_criteria: ["over the cap is refused"], depends_on: [0], touches: [] },
          ],
        },
      ],
    });

    expect(cardIds).toHaveLength(1);
    expect(bodies(conversation, PROPOSAL_KIND)[0]).toContain("Rate limiting");
    // Nothing has been created: the card is the whole of what happened.
    expect(listItemsIncludingArchived(handle.db).map((item) => item.id)).toEqual(before);
  });

  /**
   * AC: a draft is not applied either — it is handed back for a person to
   * publish through the same `pipeline:save` the configuration screen
   * uses.
   */
  it("posts a draft as a card, changes no pipeline, and hands the graph back", () => {
    const conversation = askedFrom("default");
    const before = listStepsForPipeline(handle.db, "default");

    const draft = currentGraph();
    const { cardIds } = turn(conversation, {
      message: "Here is what that would look like.",
      questions: [],
      proposals: [],
      draft: {
        ...draft,
        rationale: "Rename the last step.",
        steps: draft.steps.map((step) => (step.id === "ready_to_merge" ? { ...step, name: "Shipped" } : step)),
      },
    });

    expect(cardIds).toHaveLength(1);
    expect(bodies(conversation, PROPOSAL_KIND)[0]).toContain("Rename the last step.");
    // The pipeline is untouched. Publishing is a person's move.
    expect(listStepsForPipeline(handle.db, "default")).toEqual(before);

    const read = readAssistDraft(handle.db, conversation, cardIds[0]!);
    expect(read.ok).toBe(true);
    expect(read.ok && read.pipelineId).toBe("default");
    expect(read.ok && read.draft.steps.find((step) => step.id === "ready_to_merge")?.name).toBe("Shipped");
  });

  /**
   * The removal rule, in the other room (EO-209).
   *
   * `PipelineDraftSchema` is imported here rather than restated, and
   * `renderAssistDraft` hands the graph to the architect's own renderer
   * — so this pair is not a second implementation being checked but the
   * claim that there is only one. A rule that held in the Architecture
   * panel and not in the widget would be a draft judged by where it was
   * raised, and an agent would learn which room to drop a step in.
   */
  function dropIndex(removes: string[]): PipelineDraft {
    const draft = currentGraph();
    return {
      ...draft,
      rationale: "The index step is not worth a column here.",
      removes,
      steps: draft.steps.filter((step) => step.id !== "repository_index"),
      routes: draft.routes
        .filter((route) => route.fromStepId !== "repository_index")
        .map((route) => (route.target === "repository_index" ? { ...route, target: "todo" } : route)),
    };
  }

  it("refuses a draft raised here that drops a step without declaring it", () => {
    const conversation = askedFrom("default");

    const { cardIds } = turn(conversation, { message: "Here is the graph.", questions: [], proposals: [], draft: dropIndex([]) });

    expect(cardIds).toEqual([]);
    expect(bodies(conversation, "rejection")[0]).toContain("Dropped without being declared: **Index**, holding nothing");
    // Nothing was published either way, and the step is still there to
    // put back into the next draft.
    expect(listStepsForPipeline(handle.db, "default").some((step) => step.id === "repository_index")).toBe(true);
  });

  it("takes the same removal here once it is declared", () => {
    const conversation = askedFrom("default");

    const { cardIds } = turn(conversation, {
      message: "Here is the graph.",
      questions: [],
      proposals: [],
      draft: dropIndex(["repository_index"]),
    });

    expect(cardIds).toHaveLength(1);
    expect(bodies(conversation, PROPOSAL_KIND)[0]).toContain("**Removed**");
    expect(bodies(conversation, "rejection")).toEqual([]);
  });

  /**
   * A draft has to be published against a pipeline, and the board the
   * widget is being used from is the only thing in the room that names
   * one — all the more so with one thread spanning every screen (EO-193).
   * Refused with the reason rather than dropped (invariant #8), and as a
   * rejection rather than as something with a button on it.
   */
  it("refuses a draft raised somewhere that is not a board", () => {
    const conversation = askedFrom(null);
    const { cardIds } = turn(conversation, {
      message: "That would need a new step.",
      questions: [],
      proposals: [],
      draft: { ...currentGraph(), rationale: "Add QA." },
    });

    expect(cardIds).toEqual([]);
    expect(bodies(conversation, "rejection")[0]).toContain("not raised on a pipeline's board");
  });

  it("refuses to read a proposal back as though it were a draft", () => {
    const conversation = askedFrom("default");
    const { cardIds } = turn(conversation, {
      message: "Filed.",
      questions: [],
      proposals: [{ action: "amend", item: "EO-1", why: "The title is wrong.", title: "A better title" }],
    });

    // There is no EO-1 in this database, so the amendment renders as a
    // rejection — which is itself the point: there is no card, and
    // nothing to read back.
    expect(cardIds).toEqual([]);
    expect(readAssistDraft(handle.db, conversation, listCommentsForItem(handle.db, conversation.id)[0]!.id).ok).toBe(false);
  });

  /**
   * Invariant #1's half that matters here. A conversation is not a stage
   * with something after it, so `assist` must resolve to no route at all
   * — otherwise every turn would try to advance the chat through the
   * hidden pipeline it lives on.
   */
  it("resolves no next step for an assist run", () => {
    const { conversation } = open();
    const wiring = createRoleWiring(handle.db);
    const step = listStepsForPipeline(handle.db, "discussions").find((entry) => entry.id === ASSIST_STEP)!;

    const next = wiring.resolveNextState(step, [step], { message: "Hi", questions: [], proposals: [] }, ASSIST_ACTION, conversation);

    expect(next).toBeNull();
  });
});
