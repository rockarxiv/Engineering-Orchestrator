import {
  MODULE_COVERAGE_BAR,
  TRIAL_PUBLISH_CARD_KIND,
  ipcContract,
  keptDefinitionsNote,
  assistPageRouteOf,
  assistPageSubjectOf,
  isChatHomeRoute,
  uuidv7,
  type AssistCard,
  type DiscussionView,
  type IpcChannel,
  type IpcPayload,
  type IpcResponse,
  type IpcResult,
  type PageDescriptor,
  type Item,
  type SectionLock,
  type Uuid,
  type EntryRule,
} from "@eo/core";
import { compareThreeWay } from "@eo/engine";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import {
  approveModule,
  createPipeline,
  dismissOpenMentionsForComment,
  getAttachment,
  getComment,
  getItem,
  getItemType,
  getModule,
  getPipeline,
  getProject,
  listActiveRuns,
  listCommentsForItem,
  listMentionsForComment,
  pipelineHasWebhookEntry,
  postComment,
  setSetting,
  updateItem,
  currentVersion,
  listRoutesForPipeline,
  listStepsForPipeline,
  openUpdateConflictForChat,
  publishedSectionRow,
  renameModule,
  type PipelineUpdateConflict,
} from "../db/repos/index.js";
import { resolveHeldUpdate, templateStepIdsProblem, updateHeldElsewhere, type ConflictPlace } from "../gallery/updateConflictDetail.js";
import { recordFor } from "../record/localRecord.js";
import type { ItemRecord } from "../record/record.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { appliedChangeNote } from "../roles/moduleChange.js";
import { assistCardOf, assistCardView, cardOutcome, fileCardOutcome, liveStep } from "../roles/assistCards.js";
import { isItemTypeCard, itemTypeCardDetail, itemTypeUpdatePayload } from "../roles/itemTypeCards.js";
import {
  applyAssistModuleChange,
  assistAgent,
  assistDraftForPublish,
  assistModuleChangeCard,
  isAssistModuleChangeCard,
  modulesWaitingReason,
  assistModuleCardSlug,
  assistModuleCardReplaced,
  clearAssistRoom,
  freshAssistRoom,
  isAssistDraftCard,
  isAssistProposal,
  listAssistThreads,
  newAssistRoom,
  openAssistRoom,
  recordAssistBoard,
  reorderAssistConversation,
  resumeAssistRoom,
  shownAssistConversation,
  assistChatProjectId,
} from "../roles/assist.js";
import { designCardView } from "../trials/designCard.js";
import { discardTrial } from "../trials/discard.js";
import { readTrialPublish } from "../trials/publishCard.js";
import { threadOf } from "../roles/conversationThread.js";
import { openBriefedChat } from "../roles/briefedChat.js";
import { ASSIST_SETTINGS_KEY, ASSIST_STEP } from "../roles/conversationSteps.js";
import { capabilitiesFor } from "../providers/capabilities.js";
import { sectionLockFor } from "../managed/locks.js";
import { savePipeline } from "./configCommands.js";
import { judgeModuleForApproval, stillAsJudged, type ModuleApprovalJudgement } from "./moduleCommands.js";
import { itemsArchivedWithPipeline, updatePipelineCommand } from "./pipelineCommands.js";
import { divergenceCommand } from "./suggestionCommands.js";
import { answerQuestionBatch, approvalOf, approveWorkProposal, approveWorkProposalThroughRecord, proposalAtLengthOf, proposalSummaryOf, proposedTypeOf } from "./conversationTurns.js";
import { answerableQuestionIds, approvableIds, conversationView, settingsFor, TURN_STOPPED, type ConversationKind } from "./conversationView.js";
import { deleteConversationItem } from "./deleteConversationItem.js";
import { assistDeltaSeq } from "./assistDeltas.js";
import { publishedPage } from "./currentView.js";
import { deliverToLiveRun, type EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";
import { ACTIVE_PROJECT_KEY, activeProjectId } from "./repositoryCommands.js";

/**
 * The assistant's half of the conversation machinery (EO-189).
 *
 * Thin: how a conversation renders is `conversationView.ts`, what a turn means
 * is `roles/assist.ts`, and what is left here is opening the room and
 * saying something in it.
 *
 * The one thing this file owns that no other room has is the
 * **page**, and it is down to one job.
 *
 * It used to name the room: `pageKeyFor` turned the descriptor into the
 * key one-thread-per-page was stored under. A chat is not about a page
 * (EO-193), so nothing is keyed and that function is gone. It used to
 * frame the turn as well, written onto the conversation and rendered
 * into a `## The page` section at dispatch; EO-192 removed that, because
 * a descriptor recorded at send time is a staler account of where
 * somebody is than the live screen the agent can just ask for.
 *
 * What is left is the pipeline. A draft that does not name its own
 * (`draft.target`, EO-381) carries a graph and nothing that says which
 * board it replaces, and with one thread spanning every screen the board
 * the person was on when they asked is the only other thing in the room
 * that names one — so the descriptor is resolved to a
 * pipeline id here and pinned to *that message* by `recordAssistBoard`,
 * which checks the board exists before believing in it. Pinned to the
 * message rather than kept as the conversation's current state, because
 * the conversation stays open across a walk: a turn asked for on a board must
 * still render and publish against that board after a follow-up has been
 * sent from Settings. It is never rendered into a prompt and no agent
 * ever reads it.
 *
 * The three channels below `sendToAssist` are the buttons the
 * conversation draws (EO-190), and each of them goes somewhere that already existed:
 * answering a batch is `conversationTurns.ts`, shared with the scenario
 * chat; approving a decomposition is `applyDiscussionProposal`, the same
 * function `work:submitPlan` builds through; and publishing a draft
 * hands the graph back for the person to save through `pipeline:save`.
 * A live turn can be stopped (`assist:stop`), as in Claude Desktop, and
 * leaving the conversation still does not end it.
 */

/** What makes this room the assistant's rather than one of the other two. */
const ASSIST: ConversationKind = {
  agent: assistAgent,
  fallbackName: "Assistant",
  isProposal: isAssistProposal,
  // The one room that has to answer this per card. Both kinds of gated
  // artefact can arrive from one turn here, and they are gated by
  // different paths — so the card says which button it gets, decided by
  // the posting order `postAssistReply` writes rather than by a panel
  // reading prose (EO-190).
  approves: (db, conversation, comment, thread) =>
    // Something only a person may do (EO-521): its own button, on its own
    // channel, asked first so nothing below mistakes it for work.
    assistCardOf(db, conversation, comment, thread) !== null
      ? "card"
      : isAssistDraftCard(db, conversation, comment.id, thread)
        ? "pipeline"
        : assistModuleCardSlug(db, conversation, comment, thread) !== null
          ? "module"
          : // A change to a module that exists (EO-418): its own button, on
            // its own channel. Asked before `approvalOf`, which would call a
            // card with no work proposal behind it `changes` and send its
            // click to `assist:approve`.
            isAssistModuleChangeCard(db, conversation, comment, thread)
            ? "moduleChange"
            : approvalOf(db, conversation, comment, thread),
  // Which module a card is for (EO-398). The card reads everything else
  // about it from the catalog, so this is the whole of what travels.
  moduleSlug: assistModuleCardSlug,
  // And whether the catalog still holds what that card proposed (EO-401).
  moduleReplaced: assistModuleCardReplaced,
  // And the other kind of module card (EO-418): a change to one that
  // exists, which is applied here and then approved here.
  moduleChange: assistModuleChangeCard,
  // And a card for something only a person may do (EO-521): which kind,
  // and what pressing it came to.
  card: assistCardView,
  // The same split, one question later (KAN-164). A draft is a graph and
  // has no type; anything else answers from the proposal itself, read
  // through the same reader approval uses. The
  // panel does not draw a picker — its card cannot tell a creation from
  // an amendment well enough to offer one — but the fact travels, so a
  // surface that grows one is not re-deriving it.
  proposedType: (db, conversation, comment, thread) =>
    isAssistDraftCard(db, conversation, comment.id, thread) ? null : proposedTypeOf(db, conversation, comment, thread),
  // What a work card lists (EO-407): the proposal `assist:approve` files,
  // as rows. A draft and a module card have no proposal behind them and
  // answer null, so they keep the cards they have.
  proposal: proposalSummaryOf,
  // From `conversationSteps`, which the supervisor reads the same key
  // back out of when it applies a per-conversation model to a run.
  settingsKey: ASSIST_SETTINGS_KEY,
  // The room drawn the way Claude Desktop draws a chat: its running turn
  // step by step, and each finished one folded above its answer.
  drawsTurns: true,
  // The window's spine, and a chat that grows without end: its view
  // carries the newest stretch and older pages are read on demand.
  pagesHistory: true,
};

/**
 * The chat as every assistant handler answers with it, numbered with the
 * last `assist:delta` it already includes (EO-553) — so the window it
 * lands in can tell which delta comes next.
 */
function toView(db: Db, conversation: Item): DiscussionView {
  const view = conversationView(db, conversation, ASSIST);
  return { ...view, deltaSeq: assistDeltaSeq(db, view) };
}

/**
 * The view `assist:open` would answer with for a chat now, for working
 * out its next delta (`assistDeltas.ts`); null for an item that is not
 * an assistant chat, or no longer exists. Unnumbered: the delta is what
 * moves the number.
 */
export function assistDeltaView(db: Db, conversationId: string): DiscussionView | null {
  const conversation = getItem(db, conversationId as Uuid);
  if (!conversation || conversation.stepId !== ASSIST_STEP) return null;
  return conversationView(db, conversation, ASSIST);
}

/**
 * The board a page descriptor names, or null when it names none.
 *
 * Asked of `@eo/core`'s route table rather than parsed out of the path,
 * so `/project` — the board with no pipeline in its address — resolves
 * to the same id the screen itself draws (EO-191). A route this build
 * does not know, and every screen that is not a board, answer null.
 */
function pipelineOnScreen(page: PageDescriptor): string | null {
  // The chat layout's home is not a screen about anything (EO-383).
  //
  // With the canvas popped out into its own window the conversation is
  // sent from `/chat`, which names no board, and would leave every draft
  // raised there with nothing to publish against. The board is in the
  // window beside it — which is the one publishing while it is out, so
  // it is precisely what was last published. Read here rather than sent
  // from there, because the conversation's window has no way to know
  // what the other window is showing, and invariant #5 says EO checks
  // rather than takes a renderer's word for a fact it holds itself.
  //
  // With the canvas *not* popped out, what was published is `/chat`
  // itself, and the answer is the "no board" it always was. Null when
  // nothing has been published — a desktop whose window is closed, a
  // browser that never publishes at all — which is the same "no board"
  // every other non-board screen answers.
  const screen = isChatHomeRoute(page.route) ? publishedPage() : page;
  if (screen === null) return null;
  // A pipeline's Changes view names its pipeline as its board does
  // (EO-524): "undo that" asked over a diff is a draft against it.
  const key = assistPageRouteOf(screen)?.key;
  return key === "pipeline" || key === "pipelineChanges" ? assistPageSubjectOf(screen) : null;
}

/**
 * The chat on show.
 *
 * Creating on read, unlike `architect:open`, because this is opened by
 * somebody deciding to talk rather than by a screen rendering — see
 * `openAssistRoom`, which is also what archives each chat that has gone
 * idle for longer than the configured expiry, and starts a fresh one when
 * the one on show was among them.
 *
 * The same chat wherever the room is opened from (EO-193) — so this
 * takes no page, and no id either: which chat is on show is kept in the
 * main process (EO-391), so every window that draws the conversation
 * agrees about it. The board a draft
 * would be published against is recorded by the thing that can actually
 * start a turn: `sendToAssist`, below.
 */
export function openAssist(db: Db, announce?: () => void): IpcResponse<"assist:open"> {
  return { conversation: toView(db, openedRoom(db, announce)) };
}

/**
 * The chat to talk in, with the list told when opening changed it.
 *
 * Opening is a read that sometimes writes: it archives each chat that
 * went idle, and starts one when there is none to show. The answer says
 * which chat is on show and nothing about the rest — so an idle chat that
 * was *not* on show is archived by an opening that hands back the same
 * conversation as before, and the rail, which draws `assist:list` from
 * a cache, would go on calling it open. `announce`
 * is the handler's push, called exactly when a chat was archived or
 * created.
 *
 * It cannot loop. The push has every surface open the room again, and
 * that opening finds nothing idle and a chat on show, so it writes
 * nothing and announces nothing.
 */
function openedRoom(db: Db, announce: (() => void) | undefined): Item {
  const opened = openAssistRoom(db, activeProjectId(db));
  if (!opened.resumed || (opened.swept ?? 0) > 0) announce?.();
  return opened.conversation;
}

/**
 * New chat: an empty chat on show, with nothing put away (EO-391).
 *
 * Navigation. The chat that was on show stays live, a turn running in it
 * runs to its end and answers there, and nothing waiting in it is
 * dismissed — which is the whole difference from Clear, and why this
 * takes no engine: there is no run for it to stop.
 */
export function newAssist(db: Db): IpcResponse<"assist:new"> {
  return { conversation: toView(db, newAssistRoom(db, activeProjectId(db)).conversation) };
}

/**
 * Fix with assistant (EO-533): the assistant chat about one held
 * template update, shown — started on the first press, the same one on
 * every press after.
 *
 * Asked of whichever record holds the conflict (`ItemRecord.
 * updateConflictChat`): this database for a pipeline of its own, the
 * organisation's record for one it holds — whose notice is in an admin's
 * inbox here while the conflict, its graphs and its chat are there.
 * Either way the chat is made once (`openUpdateConflictChat`): its first
 * message is EO's brief, posted by EO and mentioning this desktop's
 * assistant, so the mention is what dispatches the first turn — the path
 * a person's message takes, with nobody typing — and the pipeline is
 * pinned to it as the chat's subject. The chat is recorded on the
 * conflict, so pressing again — from this notice, another project's copy
 * of it, or another admin's desktop — shows that chat rather than a
 * second one. A chat since put away is brought back; one since removed
 * is started again.
 *
 * Refused with the sentence to show for a conflict no record this
 * desktop can ask holds, for one resolved before any chat was opened
 * for it, and where there is no assistant to talk to.
 */
export async function openUpdateConflictAssist(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:openUpdateConflict">,
  record: Pick<ItemRecord, "updateConflictChat"> = recordFor(db),
): Promise<IpcResponse<"assist:openUpdateConflict">> {
  const assistant = assistAgent(db);
  const answer = await record.updateConflictChat({
    conflictId: input.conflictId,
    answeredBy: assistant ? { kind: "here", agentId: assistant.id } : null,
    commentId: input.commentId,
    fallbackProjectId: activeProjectId(db),
  });
  if (!answer.ok) return { conversation: null, problem: answer.problem, projectId: null };
  const shown = resumeAssistRoom(db, answer.chat.id as Uuid);
  if ("problem" in shown) return { conversation: null, problem: shown.problem, projectId: null };
  const projectId = followChat(db, shown.conversation);
  // The first turn starts on the next tick, as a person's message does —
  // here only where it is this desktop's to answer.
  if (answer.firstTurn) engine?.notifyStateChange({ promptly: true });
  return { conversation: toView(db, shown.conversation), problem: null, projectId };
}

/**
 * Puts the window on the project a chat EO just showed is on (EO-765),
 * and answers with that project.
 *
 * A chat is shown on its own project's rail and nowhere else, so a chat
 * EO opens about a pipeline on another project — Fix with assistant on a
 * notice read while on this one — would be on show where the person is
 * not looking. Written here, before the answer, so that the room opened
 * next already answers with this chat; the renderer then switches
 * through `projects:setActive`, which is what asks every project-scoped
 * screen again.
 *
 * Not onto a project that is archived or gone: the window stays where it
 * is, and the answer says which project that is.
 */
function followChat(db: Db, conversation: Item): string | null {
  const projectId = assistChatProjectId(db, conversation);
  const project = projectId === null ? undefined : getProject(db, projectId);
  if (project && project.archivedAt === null) setSetting(db, ACTIVE_PROJECT_KEY, project.id);
  return activeProjectId(db);
}

/**
 * The end of first run for a template with no job (EO-664): a new
 * assistant chat with EO's brief for the first item, shown.
 *
 * Fix with assistant's mechanism (`openBriefedChat`): the brief is the
 * chat's first message, posted by EO and mentioning this desktop's
 * assistant, so the mention dispatches the first turn with nobody
 * typing, and the pipeline is pinned to it. What the brief says is the
 * gallery's (`firstItemBrief`); this is the chat it is said in.
 *
 * A new chat on every call, deliberately: it is pressed once, on the way
 * out of first run, and there is nothing for a second press to find.
 *
 * Refused where there is no assistant to talk to — nothing is written,
 * and the needs check shows the sentence.
 */
export function openBriefedAssist(
  db: Db,
  engine: EngineHandle | undefined,
  request: { projectId: Uuid; pipelineId: string; brief: string },
): { conversation: DiscussionView | null; problem: string | null } {
  const assistant = assistAgent(db);
  if (!assistant) return { conversation: null, problem: "There is no enabled system agent to talk to." };
  const chat = db.transaction(() => openBriefedChat(db, { projectId: request.projectId, pipelineId: request.pipelineId, brief: request.brief, asking: assistant.id }));
  const shown = resumeAssistRoom(db, chat.id as Uuid);
  if ("problem" in shown) return { conversation: null, problem: shown.problem };
  followChat(db, shown.conversation);
  // The first turn starts on the next tick, as a person's message does.
  engine?.notifyStateChange({ promptly: true });
  return { conversation: toView(db, shown.conversation), problem: null };
}

/**
 * Clear: archives the chat on show and leaves an empty one (EO-193).
 *
 * One click and no dialog, which the archive is what earns: everything
 * said in the thread and every run it hosted stay on the item, and the
 * item is readable in the archive. There is nothing to confirm because
 * there is nothing to lose.
 *
 * A turn still running *in that chat* is cancelled rather than left to
 * finish into a thread nobody will read again, and it is classified
 * `superseded` for `sendToAssist`'s reason: this already puts the
 * conversation away and writes its own sentence about it, so the
 * scheduler has no step to stand off afterwards. The mention that
 * started it is dismissed with it, so the Inbox does not keep an open
 * request against a conversation that has been put away, and the engine
 * note says so in the thread — invariant #8, and the archived thread is
 * where somebody reads back what happened.
 *
 * Every other live chat is left alone, a turn running in it included
 * (EO-391).
 *
 * Nothing is written when the thread is empty: `clearAssistRoom` hands
 * back the same one rather than burning an `ASK-` key on a conversation
 * nobody had.
 */
export function clearAssist(db: Db, engine: EngineHandle | undefined): IpcResponse<"assist:clear"> {
  const live = listActiveRuns(db);
  const cleared = clearAssistRoom(db, activeProjectId(db));
  stopTurnInPutAway(db, engine, live, cleared.expired);
  engine?.notifyStateChange();
  return { conversation: toView(db, cleared.conversation) };
}

/**
 * What was asked of the agent in the thread Clear just put away, ended
 * rather than left behind, and said so in it (invariant #8).
 *
 * Clear's alone since EO-391: showing another chat puts nothing away, so
 * it has nothing to end.
 *
 * A turn already running is cancelled rather than left to finish into a
 * thread nobody is looking at. A message whose turn has not started yet
 * — sent a moment before, still waiting on the scheduler — is the same
 * request one step earlier, and is dismissed with it: an archived thread
 * is never dispatched on, so its mention would sit open until somebody
 * went back to the thread weeks later and it started a turn about a
 * question nobody remembers asking.
 */
function stopTurnInPutAway(db: Db, engine: EngineHandle | undefined, live: ReturnType<typeof listActiveRuns>, archived: Item | undefined): void {
  if (!archived) return;
  const active = live.find((run) => run.itemId === archived.id);
  const waiting = listCommentsForItem(db, archived.id).filter((comment) =>
    listMentionsForComment(db, comment.id).some((mention) => mention.targetType === "agent" && mention.status === "open"),
  );
  for (const comment of waiting) dismissOpenMentionsForComment(db, comment.id);
  if (active) {
    if (active.initiationId) dismissOpenMentionsForComment(db, active.initiationId as Uuid);
    engine?.cancelRun(active.id, "superseded");
    postComment(db, { itemId: archived.id, author: { type: "engine" }, body: "Turn stopped: the thread was cleared.", kind: "note", runId: active.id });
  } else if (waiting.length > 0) {
    postComment(db, { itemId: archived.id, author: { type: "engine" }, body: "Not answered: the thread was cleared before a turn started.", kind: "note" });
  }
}

/** The chats a person has: the open ones in the order they keep them in, then the earlier ones (`listAssistThreads`). */
export function listAssist(db: Db): IpcResponse<"assist:list"> {
  const working = new Set(listActiveRuns(db).map((run) => run.itemId as string));
  return {
    conversations: listAssistThreads(db, activeProjectId(db)).map(({ conversation, title, lastActivityAt, shown }) => ({
      id: conversation.id,
      key: conversation.key,
      title,
      startedAt: conversation.createdAt,
      lastActivityAt,
      // Said of each chat on its own evidence (EO-391). It used to be
      // "the one not put away is it", which was true while there was one.
      live: conversation.archivedAt === null,
      shown,
      state: chatState(db, conversation, working),
    })),
  };
}

/**
 * What a chat is doing, for the rail's mark (`AssistChatSchema.state`):
 * working while a turn runs in it, waiting while a question or a card in
 * it is the person's to answer, idle otherwise. A chat put away is idle
 * whatever it holds — nothing in it can be answered.
 */
function chatState(db: Db, conversation: Item, working: ReadonlySet<string>): "working" | "waiting" | "idle" {
  if (conversation.archivedAt !== null) return "idle";
  if (working.has(conversation.id)) return "working";
  // The thread read once for both questions.
  const thread = threadOf(db, conversation.id);
  if (answerableQuestionIds(db, conversation, thread).size > 0 || approvableIds(db, conversation, ASSIST, thread).size > 0) return "waiting";
  return "idle";
}

/**
 * Moves an open chat to another place among the open chats
 * (`reorderAssistConversation`), and answers with the list as it now
 * stands — so the window that asked draws what was stored rather than
 * what it hoped for.
 */
export function reorderAssist(db: Db, input: IpcPayload<"assist:reorder">): IpcResponse<"assist:reorder"> {
  const { problem } = reorderAssistConversation(db, input.conversationId as Uuid, input.index);
  return { ...listAssist(db), problem };
}

/**
 * Shows another chat (`resumeAssistRoom`): a live one, or an earlier one
 * made live again. The chosen one is what every surface that opens the
 * room shows from now on.
 *
 * Nothing is stopped and nothing is dismissed (EO-391), so this holds no
 * engine: the chat that was on show stays live, its turn runs on, and a
 * message waiting in it is still answered.
 */
export function resumeAssist(db: Db, input: IpcPayload<"assist:resume">): IpcResponse<"assist:resume"> {
  const resumed = resumeAssistRoom(db, input.conversationId as Uuid);
  if ("problem" in resumed) return { conversation: toView(db, openAssistRoom(db, activeProjectId(db)).conversation), problem: resumed.problem };
  return { conversation: toView(db, resumed.conversation), problem: null };
}

/**
 * Removes a chat for good (EO-390): the one act in this room that
 * deletes, where Clear and going back only put a thread away.
 *
 * The deletion is `deleteConversationItem` — the one retiring Discussions
 * deleted its conversations through (EO-526) — a turn running in the
 * thread cancelled as `superseded`, the
 * item and everything filed under it gone in one cascade, its managed
 * attachment files removed after. Invariant #3's one exception covers
 * it: a person asking for the thread itself to be gone.
 *
 * What is this function's own is the refusal. An item id is an item id
 * and this channel is handed one straight, so anything that is not an
 * assistant thread — a story, a discussion, a thread already removed
 * from another window — is refused with the sentence the dialog shows,
 * and nothing is touched.
 *
 * Removing the chat on show leaves an empty one in its place, as Clear
 * does: every surface holding the room is holding the id of a
 * conversation that no longer exists, and is owed the one to show
 * instead. `conversation` is that chat; it is null when the one removed
 * was any other, live or not, because what the room shows did not
 * change.
 */
export async function removeAssist(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:remove">,
  attachmentStorage: AttachmentStorage,
): Promise<IpcResponse<"assist:remove">> {
  const target = removableAssist(db, input.conversationId);
  if (!target) return { removed: false, problem: NOT_REMOVABLE };
  const wasShown = shownAssistConversation(db, activeProjectId(db))?.id === target.id;

  await deleteConversationItem(db, engine, target, attachmentStorage);

  if (!wasShown) return { removed: true, conversation: null };
  return { removed: true, conversation: toView(db, freshAssistRoom(db, activeProjectId(db))) };
}

/** Why an id handed to remove a chat was refused: it is not one, or it has already gone. */
const NOT_REMOVABLE = "That is not one of your conversations with the assistant. It may already have been removed.";

/** The assistant thread an id names, or undefined when it names anything else or nothing. */
function removableAssist(db: Db, conversationId: string): Item | undefined {
  const target = getItem(db, conversationId as Uuid);
  return target && target.stepId === ASSIST_STEP ? target : undefined;
}

/**
 * Removes several chats for good in one call (EO-442): the rail's
 * multi-select, confirmed behind one warning.
 *
 * Each through `deleteConversationItem`, as `removeAssist` removes one,
 * and each refused on its own: an id that is not an assistant thread, or
 * is already gone, is answered with the sentence `assist:remove` gives
 * and nothing of it is touched, while the rest are still removed.
 *
 * Which chat was on show is read once, before anything goes. Read per
 * id it would drift — with the chat on show removed, the first live one
 * left answers as shown — and the room would be handed a fresh chat for
 * each. Exactly one is made, at the end, when the chat on show was among
 * those removed.
 */
export async function removeManyAssist(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:removeMany">,
  attachmentStorage: AttachmentStorage,
): Promise<IpcResponse<"assist:removeMany">> {
  const shownId = shownAssistConversation(db, activeProjectId(db))?.id;
  const removed: string[] = [];
  const refused: { conversationId: string; problem: string }[] = [];
  for (const conversationId of new Set(input.conversationIds)) {
    const target = removableAssist(db, conversationId);
    if (!target) {
      refused.push({ conversationId, problem: NOT_REMOVABLE });
      continue;
    }
    await deleteConversationItem(db, engine, target, attachmentStorage);
    removed.push(conversationId);
  }
  const shownRemoved = shownId !== undefined && removed.includes(shownId);
  return { removed, refused, conversation: shownRemoved ? toView(db, freshAssistRoom(db, activeProjectId(db))) : null };
}

/**
 * Says something to the system agent from a page.
 *
 * Posting a human comment that mentions it *is* the dispatch — the same
 * path an @-mention on any item takes, and the reason this room needs
 * no scheduling machinery of its own.
 *
 * Nothing about the page is *described* on the way through any more
 * (EO-192). It used to be, so that the turn about to be dispatched could
 * be given a section describing it — and the ordering mattered, because
 * a turn dispatched between the comment landing and the page being
 * written would have described somewhere the person had left. The race
 * is gone with the section: the agent reads the screen itself, at the
 * moment it asks.
 *
 * What is recorded is the board, pinned to the message about to be
 * posted, and only so that a graph *this* turn proposes is publishable
 * against the screen it was asked from. The id is minted here rather
 * than by `postComment` precisely so that it can be — and the record is
 * written first, for the old ordering's reason: the mention is what
 * wakes the supervisor, and a turn dispatched between the comment
 * landing and the board being written would find no board at all.
 *
 * Files come with the message (EO-194). The panel stages them through
 * `attachments:*` like every other composer, and what arrives here is a
 * list of ids — so the bytes are only promoted to managed storage if the
 * comment carrying them lands, and put back if it does not. The agent
 * needs nothing new to read them: `context.ts` renders an attachment's
 * metadata into the prompt and `attachment_read` serves the contents,
 * both keyed on the comment rather than on the room it was posted in.
 *
 * A message sent while a turn is running goes into that turn (EO-395),
 * through `deliverToLiveRun` — the path the ticket composer has used
 * since EO-176. The board is still recorded against it, as for any
 * message, though nothing reads that entry: a steered message starts no
 * turn, so a draft the running turn raises is published against the
 * board recorded for the message that started it.
 */
export async function sendToAssist(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:send">,
  attachmentStorage?: AttachmentStorage,
  announce?: () => void,
): Promise<IpcResponse<"assist:send">> {
  const existing = input.conversationId === null ? undefined : getItem(db, input.conversationId as Uuid);
  if (input.conversationId !== null && !existing) throw new Error("That conversation does not exist.");
  // An item id is an item id, and this channel takes one. Without
  // this, naming a piece of work would post a mention on it — a help
  // thread grafted onto somebody's story.
  // `architect:send` gets away with checking less because its rooms are
  // reached only through a pipeline id; this one is handed the id
  // straight.
  if (existing && existing.stepId !== ASSIST_STEP) throw new Error("That is not an assist conversation.");
  if (existing && existing.archivedAt !== null) throw new Error("That conversation is closed.");

  const agent = assistAgent(db);
  if (!agent) throw new Error("There is no enabled system agent to talk to.");
  // A screenshot with nothing typed under it is a message (EO-194), so
  // "empty" means empty of both — `discussions:send`'s rule, and the
  // sentence says which of the two is missing.
  const attachmentIds = input.attachmentIds ?? [];
  if (input.body.trim() === "" && attachmentIds.length === 0) throw new Error("A message needs text or an attachment.");
  if (attachmentIds.length > 0 && !attachmentStorage) throw new Error("Attachment storage is unavailable.");

  // Every refusal above this line, so a rejected send leaves nothing
  // behind. Opening the room *creates* it, and a thread started by a
  // stray keystroke is a conversation nobody had.
  const conversation = existing ?? openedRoom(db, announce);
  const commentId = uuidv7();
  const updated = recordAssistBoard(db, conversation, commentId, pipelineOnScreen(input.page));

  const activeRun = listActiveRuns(db).find((run) => run.itemId === updated.id);
  if (input.interrupt && activeRun && engine) {
    if (activeRun.initiationId) dismissOpenMentionsForComment(db, activeRun.initiationId as Uuid);
    // `superseded`, exactly as both other rooms' sends are: the
    // interrupt is the first half of sending, and the message below
    // starts the next turn (EO-175).
    engine.cancelRun(activeRun.id, "superseded");
  }

  // Staged bytes become managed ones only if the comment they belong to
  // lands: `prepare` copies them into place, a failed post puts them back
  // where they were, and `finish` clears the staging area once the row
  // exists. The same three calls `discussions:send` makes, in the same
  // order, because a half-committed attachment is a file on disk no row
  // points at.
  const prepared = (await attachmentStorage?.prepare(attachmentIds)) ?? [];
  try {
    postComment(db, {
      id: commentId,
      itemId: updated.id,
      author: { type: "human" },
      body: input.body.trim(),
      attachmentRecords: prepared,
      mentions: [{ type: "agent", agentId: agent.id }],
    });
  } catch (error) {
    await attachmentStorage?.rollback(prepared);
    throw error;
  }
  await attachmentStorage?.finish(prepared).catch((error: unknown) => console.error("[eo] could not clear staged assist attachments:", error));

  // Into the turn that is running, when there is one (EO-395). The
  // comment above is the record and stands whatever this answers
  // (invariant 4); what is decided here is only which turn reads it.
  // Always `"now"` — this room has no send-mode picker, so a message
  // sent while the assistant is working is meant for what it is doing.
  // Delivered, the mention above is dismissed by `deliverToLiveRun` and
  // no second turn starts; not delivered, the mention stays, the next
  // turn reads the message, and `note` is the sentence saying so
  // (invariant 8).
  //
  // Not after an interrupt: that run was told to stop two statements
  // ago, and this message is what starts the turn that replaces it.
  // And not when nothing was running, where the mention starting a turn
  // is the whole of what was asked for and there is nothing to report.
  const delivery =
    activeRun && engine && !input.interrupt
      ? await deliverToLiveRun(db, engine, { itemId: updated.id, commentId, body: input.body.trim(), requested: "now" }, "conversation")
      : null;

  // A person's send: the turn it asks for starts on the next tick, not after a debounce.
  engine?.notifyStateChange({ promptly: true });
  return { conversation: toView(db, updated), delivery };
}

/**
 * Warms the backend for the turn a person is typing (`assist:prewarm`).
 *
 * Only for a live assistant chat with nothing running in it: a message
 * typed during a turn goes into that turn, and there is nothing to warm.
 */
export async function prewarmAssist(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"assist:prewarm">): Promise<IpcResponse<"assist:prewarm">> {
  const conversation = getItem(db, input.conversationId as Uuid);
  const agent = assistAgent(db);
  if (!engine?.prewarmConversation || !conversation || conversation.stepId !== ASSIST_STEP || conversation.archivedAt !== null || !agent) return { warming: false };
  return { warming: await engine.prewarmConversation(conversation.id, agent.id as Uuid) };
}

/**
 * Takes back a message waiting for the next turn (`assist:withdraw`).
 *
 * Only a person's message with an open request to the assistant that is
 * not the one the running turn is answering; anything else answers
 * `withdrawn: false` and changes nothing.
 */
export function withdrawAssistMessage(db: Db, input: IpcPayload<"assist:withdraw">): IpcResponse<"assist:withdraw"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const comment = getComment(db, input.messageId as Uuid);
  const assistant = assistAgent(db);
  const running = listActiveRuns(db).find((run) => run.itemId === conversation.id);
  const waiting =
    comment !== undefined &&
    comment.itemId === conversation.id &&
    comment.authorType === "human" &&
    comment.id !== running?.initiationId &&
    listMentionsForComment(db, comment.id).some((mention) => mention.status === "open" && mention.targetType === "agent" && mention.targetId === assistant?.id);
  if (!waiting) return { withdrawn: false, conversation: toView(db, conversation) };
  dismissOpenMentionsForComment(db, comment.id);
  // Said in the thread (invariant 8), under the message: somebody reading
  // back finds why it was never answered, not just that it was not.
  postComment(db, { itemId: conversation.id, author: { type: "engine" }, kind: "note", parentId: comment.id, body: "Taken back before the assistant read it.", parseBodyMentions: false });
  return { withdrawn: true, conversation: toView(db, conversation) };
}

/**
 * A page of an assistant chat's older messages (`assist:earlier`).
 *
 * Any chat of the assistant's, put away or not — reading back is not
 * writing — and refused for an item that is not one.
 */
export function readEarlierAssist(db: Db, input: IpcPayload<"assist:earlier">): IpcResponse<"assist:earlier"> {
  const conversation = getItem(db, input.conversationId as Uuid);
  if (!conversation || conversation.stepId !== ASSIST_STEP) throw new Error("That is not an assist conversation.");
  const view = conversationView(db, conversation, ASSIST, { before: input.before, limit: input.limit });
  return { messages: view.messages, earlier: view.earlier ?? 0 };
}

/**
 * Stops the turn running in an assistant chat — the Stop button, and
 * Escape in the composer.
 *
 * `discussions:stop` for this room. The engine cancels the run, which
 * asks the backend to end its turn; the thread survives on the backend,
 * so the next message continues the same conversation with what was said
 * so far. The mention that started it is dismissed, so the turn is not
 * dispatched again by the next tick, and "Turn stopped." is posted under
 * the run so the thread says what happened (invariant 8) — and so the
 * work the turn did before it was stopped has a message to be folded
 * above, the way Claude Desktop keeps a stopped answer on screen.
 *
 * A chat with nothing running answers `stopped: false` and writes
 * nothing: the turn finished on its own between the click and this.
 */
export function stopAssistTurn(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"assist:stop">): IpcResponse<"assist:stop"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const run = listActiveRuns(db).find((entry) => entry.itemId === conversation.id);
  if (!run || !engine) return { stopped: false, conversation: toView(db, conversation) };
  const comments = listCommentsForItem(db, conversation.id);
  // Answered already, and only finishing its bookkeeping: there is
  // nothing left to stop, and "Turn stopped." under an answer would say
  // something that did not happen.
  if (comments.some((comment) => comment.runId === run.id && comment.authorType === "agent")) return { stopped: false, conversation: toView(db, conversation) };

  if (run.initiationId) dismissOpenMentionsForComment(db, run.initiationId as Uuid);
  // Every other open request to the assistant in this chat too: a message
  // sent while the turn ran and queued for the next one would otherwise
  // start that next turn the moment this one ends, which is not what a
  // person who pressed Stop asked for. Only requests to the assistant —
  // a mention of anybody else is not this turn's to settle.
  const assistant = assistAgent(db);
  let unanswered = 0;
  for (const comment of comments) {
    if (comment.authorType !== "human" || comment.id === run.initiationId) continue;
    const open = listMentionsForComment(db, comment.id).some((mention) => mention.status === "open" && mention.targetType === "agent" && mention.targetId === assistant?.id);
    if (!open) continue;
    dismissOpenMentionsForComment(db, comment.id);
    unanswered += 1;
  }
  engine.cancelRun(run.id);
  // Said, not left to be noticed (invariant 8): a message that was waiting
  // for the next turn will not get one.
  const body =
    unanswered === 0
      ? TURN_STOPPED
      : `${TURN_STOPPED}\n\n${unanswered === 1 ? "The message sent while it ran was" : `The ${unanswered} messages sent while it ran were`} not answered; send again to ask.`;
  postComment(db, { itemId: conversation.id, author: { type: "engine" }, body, kind: "note", runId: run.id });
  return { stopped: true, conversation: toView(db, conversation) };
}

/**
 * Chooses what the next turns in one assistant chat run with: a model,
 * a reasoning effort, and whether their reasoning is shown.
 *
 * `discussions:settings` for this room, with the reasoning switch beside
 * it. Written to the chat's own settings, which `conversationTurnOptions`
 * reads back at dispatch, so a turn already running is not changed —
 * Claude Desktop restarts nothing either; the next message picks it up.
 */
export function updateAssistSettings(db: Db, input: IpcPayload<"assist:settings">): IpcResponse<"assist:settings"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const agent = assistAgent(db);
  if (!agent) throw new Error("There is no enabled system agent to configure.");
  if (input.reasoningEffort) {
    const allowed = capabilitiesFor(agent.provider).reasoningEfforts;
    if (!allowed.includes(input.reasoningEffort)) throw new Error(`The ${agent.provider} backend does not offer reasoning effort "${input.reasoningEffort}".`);
  }
  const current = conversation.spec?.[ASSIST_SETTINGS_KEY];
  const settings = current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const next = {
    ...settings,
    ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.showReasoning !== undefined ? { showReasoning: input.showReasoning } : {}),
  };
  const updated = updateItem(db, conversation.id, { spec: { ...(conversation.spec ?? {}), [ASSIST_SETTINGS_KEY]: next } });
  return { settings: settingsFor(db, updated, ASSIST), conversation: toView(db, updated) };
}

/**
 * Starts a new chat holding this one's conversation up to a message, and
 * shows it — Claude Desktop's fork.
 *
 * The honest form of "go back and try that differently" in a thread that
 * is a record (invariant 3): nothing in the original moves. What was said
 * up to and including the message is posted again into a fresh chat,
 * under a first line naming where it came from, each message signed by
 * whoever said it. Everything comes across as a plain note — a question
 * as the words it asked, a card as what it said — because a live card in
 * two chats is two buttons for one decision, and approving the same work
 * twice is the outcome nobody wants. Files are named rather than copied.
 *
 * No mention is posted, so nothing is dispatched: the new chat waits for
 * the person, whose next message starts its first turn with the copied
 * thread as its context.
 */
export function forkAssistConversation(db: Db, input: IpcPayload<"assist:fork">): IpcResponse<"assist:fork"> {
  const source = getItem(db, input.conversationId as Uuid);
  if (!source || source.stepId !== ASSIST_STEP) throw new Error("That is not an assist conversation.");
  const inOrder = [...listCommentsForItem(db, source.id)].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const cut = inOrder.findIndex((comment) => comment.id === input.messageId);
  if (cut === -1) return { conversation: toView(db, source), problem: "That message is not in this conversation any more." };

  // One write: a fork that failed half way would be a chat on show with
  // half a conversation in it. On the project the chat is on, not the one
  // the window happens to be showing.
  const fork = db.transaction(() => {
    const opened = newAssistRoom(db, source.projectId ?? null).conversation;
    // Nothing copied is read for `@names` (`parseBodyMentions: false`): a
    // message that once asked an agent or a person for something would
    // otherwise ask again here, dispatching a turn or filling an inbox
    // from words that were already answered where they were said.
    postComment(db, { itemId: opened.id, author: { type: "engine" }, kind: "note", body: `Forked from ${source.key}.`, parseBodyMentions: false });
    for (const comment of inOrder.slice(0, cut + 1)) {
      const files = (comment.attachments ?? []).map((attachment) => attachment.name).filter(Boolean);
      const body = files.length > 0 ? `${comment.body}${comment.body ? "\n\n" : ""}Attached in ${source.key}: ${files.join(", ")}` : comment.body;
      if (body.trim() === "") continue;
      const author =
        comment.authorType === "agent" && comment.authorId
          ? ({ type: "agent", agentId: comment.authorId } as const)
          : comment.authorType === "human"
            ? ({ type: "human" } as const)
            : ({ type: "engine" } as const);
      postComment(db, { itemId: opened.id, author, kind: "note", body, parseBodyMentions: false });
    }
    return opened;
  });
  return { conversation: toView(db, getItem(db, fork.id) ?? fork), problem: null };
}

/**
 * The conversation a card's button acts on.
 *
 * Checked to be an assist thread for `sendToAssist`'s reason: these
 * channels take an item id straight, and an item id is an item id. A
 * story's id here would otherwise have a card read off it and an
 * approval comment written onto it.
 */
function assistConversationForWrite(db: Db, conversationId: string): Item {
  const conversation = getItem(db, conversationId as Uuid);
  if (!conversation) throw new Error("That conversation does not exist.");
  if (conversation.stepId !== ASSIST_STEP) throw new Error("That is not an assist conversation.");
  if (conversation.archivedAt !== null) throw new Error("That conversation is closed.");
  return conversation;
}

/**
 * Answers a batch of questions the panel put on a card.
 *
 * `conversationTurns.ts` does the answering, shared with both other
 * rooms. What is left here is the same two things every room owns: which
 * conversation may be written to, and who answers in it.
 */
export function answerAssistQuestions(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:answer">,
): IpcResponse<"assist:answer"> {
  const conversation = assistConversationForWrite(db, input.conversationId);

  const agent = assistAgent(db);
  if (!agent) throw new Error("There is no enabled system agent to answer.");

  const batch = answerQuestionBatch(db, engine, conversation, agent, input.answers);
  return { ...batch, conversation: toView(db, getItem(db, conversation.id) ?? conversation) };
}

/**
 * Creates the work a decomposition card proposes.
 *
 * `applyDiscussionProposal`, which is the point: the assistant's room is
 * a surface a proposal can appear on and not a second way of building one.
 * Every rule that path carries — the cycle check over the merged graph,
 * the placement rules, all of it in one transaction — applies here
 * unchanged, and the refusal is posted into the thread either way so
 * nothing is dropped silently (invariant #8).
 *
 * A pipeline draft is refused by name rather than by falling through to
 * "that proposal is no longer readable": the two cards look identical in
 * the thread, and a person who clicked the wrong button deserves to be
 * told which one they wanted.
 */
export function approveAssistProposal(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:approve">,
): IpcResponse<"assist:approve"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const refusal = assistApprovalRefusal(db, conversation, messageId);
  if (refusal !== null) return refusedApproval(db, conversation, refusal);

  const applied = approveWorkProposal(db, engine, conversation, messageId, undefined, input.addedFields);
  return { ...applied, conversation: toView(db, getItem(db, conversation.id) ?? conversation) };
}

/**
 * `approveAssistProposal`, on a desktop that may have to ask the record
 * (EO-600) — what `assist:approve` answers. The same refusals first; then
 * a reorder card on an item the organisation's record holds is asked of
 * the record, and every other card is approved here as it always was.
 */
export async function approveAssistProposalThroughRecord(
  db: Db,
  engine: EngineHandle | undefined,
  record: Pick<ItemRecord, "changeDependencies">,
  input: IpcPayload<"assist:approve">,
): Promise<IpcResponse<"assist:approve">> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const refusal = assistApprovalRefusal(db, conversation, messageId);
  if (refusal !== null) return refusedApproval(db, conversation, refusal);

  const applied = await approveWorkProposalThroughRecord(db, engine, record, conversation, messageId, undefined, input.addedFields);
  return { ...applied, conversation: toView(db, getItem(db, conversation.id) ?? conversation) };
}

function refusedApproval(db: Db, conversation: Item, problem: string): IpcResponse<"assist:approve"> {
  return { applied: false, problem, createdKeys: [], changedKeys: [], conversation: toView(db, conversation) };
}

/** Why this card may not be approved through `assist:approve`, or null when it may. */
function assistApprovalRefusal(db: Db, conversation: Item, messageId: Uuid): string | null {
  // Not an exception: a panel left open on a superseded card is an
  // ordinary thing, and the honest answer is why rather than a crash.
  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    return "That proposal has been superseded or already applied. Read the newest one and approve that instead.";
  }
  if (isAssistDraftCard(db, conversation, messageId)) {
    return "That card is a pipeline draft. Publish it rather than approving it — it changes the pipeline, not the work in it.";
  }

  // The same courtesy, for the third kind of card (EO-398). A module is
  // approved through `modules:approve`, which runs its tests; nothing in
  // this channel can approve one, and falling through would file a
  // rejection about an unreadable proposal under a card that is fine.
  const card = listCommentsForItem(db, conversation.id).find((comment) => comment.id === messageId);
  if (card && assistModuleCardSlug(db, conversation, card) !== null) {
    return "That card is a module. Approve it with the Approve button on the card, or in Settings → Modules — approving runs its tests.";
  }

  // And for the fourth (EO-418): a change to a module is applied through
  // `assist:applyChange`, which is a module save and held to that lock.
  if (card && isAssistModuleChangeCard(db, conversation, card)) {
    return "That card is a change to a module. Apply it with the Apply change button on the card.";
  }

  // And for the fifth (EO-521): a card for something only a person may do
  // is carried out through `assist:applyCard`, by the channel it names.
  if (card && assistCardOf(db, conversation, card) !== null) {
    return "That card is not work to create. Press the button on the card itself in the chat.";
  }

  return null;
}

/**
 * Applies a change to an existing module that a card proposed — a person
 * pressed Apply (EO-418).
 *
 * `applyScenarioChangeCommand`, for this room, step for step: "newest
 * wins" first, by the rule every room's cards share, so a panel left
 * open on a superseded or already-applied card cannot write it; then the
 * save, which is `applyAssistModuleChange`; then the module's tests are
 * re-run against what was saved and the catalog announced as changed, so
 * a list already on screen shows the module as it now is.
 *
 * Either way it is said in the thread, under the card (invariant #8):
 * what was saved and whether approval was withdrawn, or why nothing was.
 * The comment filed under it is what stops the card being applicable
 * again — and, when it is an approval, what the card reads to offer
 * Approve in Apply's place.
 */
export function applyAssistModuleChangeCommand(
  db: Db,
  engine: EngineHandle | undefined,
  runner: Pick<ModuleTestRunner, "schedule">,
  input: IpcPayload<"assist:applyChange">,
): IpcResponse<"assist:applyChange"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;

  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    return {
      applied: false,
      problem: "That change has been superseded or already applied. Read the newest one and apply that instead.",
      conversation: toView(db, conversation),
    };
  }

  const applied = applyAssistModuleChange(db, conversation, messageId);
  postComment(db, {
    itemId: conversation.id,
    author: { type: "human" },
    kind: applied.ok ? "approval" : "rejection",
    parentId: messageId,
    body: appliedChangeNote(applied),
  });

  if (applied.ok) {
    runner.schedule(applied.module.id);
    emitPush("config:changed", {});
  }
  engine?.notifyStateChange();

  return {
    applied: applied.ok,
    problem: applied.ok ? null : applied.reason,
    conversation: toView(db, getItem(db, conversation.id) ?? conversation),
  };
}

/**
 * A work proposal at full length, by the message its card is (EO-408).
 *
 * What the canvas draws a proposed item from, and what the view resolver
 * reads to tell the assistant which proposed item is open. The card's own
 * message supplies the rows, `canApprove` and why it is closed — read
 * through `toView`, so this cannot say anything about a card that the
 * card itself does not — and the proposal behind it supplies what a row
 * has no room for.
 *
 * Found by the message alone, in whichever assistant conversation holds
 * it, shown or not, live or put away: the view is an address, and reading
 * a proposal writes nothing. Null for anything that is not a work card in
 * an assistant conversation.
 */
export function readAssistProposal(db: Db, input: IpcPayload<"assist:proposal">): IpcResponse<"assist:proposal"> {
  const comment = getComment(db, input.messageId as Uuid);
  const conversation = comment ? getItem(db, comment.itemId) : undefined;
  if (!comment || !conversation || conversation.stepId !== ASSIST_STEP) return { proposal: null };

  const message = toView(db, conversation).messages.find((entry) => entry.id === comment.id);
  const summary = message?.proposal ?? null;
  const atLength = proposalAtLengthOf(db, conversation, comment);
  if (!message || summary === null || atLength === null) return { proposal: null };

  let next = 0;
  return {
    proposal: {
      conversationId: conversation.id,
      canApprove: message.canApprove,
      container: summary.container,
      // A description per new item, in the rows' own order; an amendment's row has none.
      rows: summary.rows.map((row) => {
        if (row.kind !== "new") return row;
        const at = next++;
        return { ...row, description: atLength.descriptions[at] ?? "", addedFields: atLength.addedFields[at] ?? [] };
      }),
      closed: summary.closed,
      landsOn: atLength.landsOn,
    },
  };
}

/**
 * The graph behind a draft card, for the person to publish.
 *
 * Nothing is written here. It answers with what `pipeline:save` takes and
 * the conversation calls that channel — so there stays one path that
 * writes a graph and a person is always on it.
 *
 * Guarded by the same "newest wins" rule an approvable card gets, so a
 * panel left open on a superseded draft cannot publish a graph the agent
 * has since revised.
 */
export function readAssistDraftForPublish(db: Db, input: IpcPayload<"assist:draft">, place: ConflictPlace = {}): IpcResponse<"assist:draft"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const nothing = noDraftToPublish;

  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    return nothing("That draft has been superseded by a newer one. Read the latest and publish that instead.");
  }

  const read = assistDraftForPublish(db, conversation, messageId);
  if (!read.ok) return nothing(read.reason);

  // The whole of Publish is authorised before any of it is written
  // (EO-520). A draft that renames the pipeline or changes its icon is
  // two writes — the graph through `pipeline:save`, then the name and
  // icon through `pipelines:update` — and the two channels are not always
  // locked alike: on a replica whose organisation publishes pipelines, a
  // pipeline this machine has diverged may have its graph saved, while
  // `pipelines:update` stays locked. Asked here, of the payload the
  // second call will send, by the same `sectionLockFor` that call will
  // meet, so a draft that could only be half applied is refused before
  // its graph is touched rather than after.
  if (read.pipelineId !== null && (read.rename !== null || read.icon !== null)) {
    const lock = sectionLockFor(db, "pipelines:update", { id: read.pipelineId });
    if (lock !== null) return nothing(metadataLockedReason(lock, read.rename, read.icon));
  }

  // A draft resolving a held update says which of its steps are the
  // template's under fresh ids (EO-534); one that cannot be believed is
  // refused before anything is published, rather than after.
  const held = heldUpdateFor(db, conversation, read.pipelineId, place);
  const unbelieved = held === undefined ? null : templateStepIdsProblem(db, held, read.steps, read.templateStepIds);
  if (unbelieved !== null) return nothing(unbelieved);

  const answer = {
    pipelineId: read.pipelineId,
    newPipelineName: read.newPipelineName,
    steps: read.steps,
    routes: read.routes,
    entryStepId: read.entryStepId,
    ...(read.entryRules === undefined ? {} : { entryRules: read.entryRules }),
    problem: null,
    // Beside the graph, not instead of it (EO-399): a draft waiting on a
    // module is a card with something left to do on it, not a refusal.
    waiting: read.waiting,
    waitingProblem: read.waiting.length > 0 ? modulesWaitingReason(read.waiting) : null,
    // The definitions it is published with (EO-426), for the caller to
    // send on to `pipeline:save` beside the graph. Nothing here saved them.
    actions: read.actions,
    // What it does to the pipeline itself (EO-520), for the caller to
    // apply with the graph: the version it restores goes to
    // `pipeline:save`, and a new name or icon to `pipelines:update` once
    // the graph has saved.
    rename: read.rename,
    icon: read.icon,
    restoredFrom: read.restoredFrom,
    // The held template update this chat was opened for (EO-534), where
    // the draft is for its pipeline: publishing it resolves the update,
    // which the caller says with `assist:draftPublished`. One held on the
    // organisation's record is found by `readAssistDraftForPublishWithRecord`.
    updateConflictId: held?.id ?? null,
    updateConflictOnRecord: false,
    trial: null,
  };
  // A design card (EO-587): the turn planned a test with real runs, and
  // the card offers Approve design rather than Publish.
  const comment = getComment(db, messageId);
  return { ...answer, trial: comment === undefined ? null : designCardView(db, conversation, comment, answer) };
}

/**
 * `readAssistDraftForPublish`, and the record asked too (EO-534): a
 * draft raised in the chat about a template update the organisation's
 * record holds is Published on the record (`assist:publishOnRecord`),
 * not into this desktop's copy. Which chat that is, is the record's to
 * say — it holds the conflict and the chat its Fix with assistant
 * opened — so it is asked, for a pipeline it holds, whenever the draft
 * is read.
 */
export async function readAssistDraftForPublishWithRecord(
  db: Db,
  record: Pick<ItemRecord, "updateConflict">,
  input: IpcPayload<"assist:draft">,
  place: ConflictPlace = {},
): Promise<IpcResponse<"assist:draft">> {
  const read = readAssistDraftForPublish(db, input, place);
  if (read.problem !== null || read.pipelineId === null || read.updateConflictId !== null || !updateHeldElsewhere(db, read.pipelineId, place)) return read;
  const asked = await record.updateConflict({ pipelineId: read.pipelineId, onTheRecord: place.onTheRecord === true });
  const conflict = asked.conflict;
  // Not knowing is not "nothing is held" (EO-534). With the record out of
  // reach, or this desktop signed out of it, nobody can say whether this
  // draft resolves the organisation's held update — and publishing it into
  // this copy alone would leave that update held, or be refused by the
  // section's lock. So Publish waits, saying why.
  if (conflict === null && asked.authoritative !== true) {
    return noDraftToPublish(
      "This draft is for a pipeline your organisation's record holds, and EO could not ask the record whether it resolves a held template update, so nothing was published. " +
        `Try again once the record can be reached: ${asked.problem ?? "it did not answer."}`,
    );
  }
  if (conflict === null || conflict.chatId !== input.conversationId) return read;
  return { ...read, updateConflictId: conflict.conflictId, updateConflictOnRecord: true };
}

/** `assist:draft`'s answer with nothing to publish, and why. */
function noDraftToPublish(problem: string): IpcResponse<"assist:draft"> {
  return {
    pipelineId: null,
    newPipelineName: null,
    steps: [],
    routes: [],
    entryStepId: null,
    problem,
    waiting: [],
    waitingProblem: null,
    actions: [],
    rename: null,
    icon: null,
    restoredFrom: null,
    updateConflictId: null,
    updateConflictOnRecord: false,
    trial: null,
  };
}

/**
 * Publish on a draft resolving a template update the organisation's
 * record holds (EO-534).
 *
 * The record's pipeline is what was compared and what replicas follow,
 * so the draft is published there: its graph, read again from the run
 * here as `assist:draft` reads it, goes to the record with the chat it
 * came from and its template step ids (`ItemRecord.resolveUpdateConflict`),
 * and the record saves it, resolves the update, moves the base and
 * closes its notice — or refuses, and nothing is written anywhere.
 *
 * Where the organisation publishes the pipelines section, this desktop's
 * copy follows the record's on the next pull. Where it does not, this
 * desktop keeps a copy of its own, which the record's graph never
 * overwrites, so the same graph is saved into it here once the record
 * has taken it.
 */
export async function publishOnRecord(
  db: Db,
  engine: EngineHandle | undefined,
  record: Pick<ItemRecord, "updateConflict" | "resolveUpdateConflict">,
  input: IpcPayload<"assist:publishOnRecord">,
): Promise<IpcResponse<"assist:publishOnRecord">> {
  const refuse = (problem: string): IpcResponse<"assist:publishOnRecord"> => ({ saved: false, resolved: false, problem });
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  if (!approvableIds(db, conversation, ASSIST).has(messageId)) return refuse("That draft has been superseded by a newer one. Read the latest and publish that instead.");
  const read = assistDraftForPublish(db, conversation, messageId);
  if (!read.ok) return refuse(read.reason);
  if (read.waiting.length > 0) return refuse(modulesWaitingReason(read.waiting));
  if (read.pipelineId === null) return refuse("That draft creates a pipeline, so there is no held template update for it to resolve.");
  // The record is sent the graph and nothing beside it: a name, an icon
  // or an action definition the card also carried would be half of the
  // card published, and the person pressed Publish on all of it.
  if (read.rename !== null || read.icon !== null || read.actions.length > 0 || read.restoredFrom !== null) {
    return refuse(
      "This draft resolves a template update your organisation's record holds, and it also renames the pipeline, changes its icon, restores a version or brings action definitions. " +
        "Only the graph can be published on the record, so nothing was published. Ask for the draft again with the graph alone.",
    );
  }

  const answer = await record.resolveUpdateConflict({
    pipelineId: read.pipelineId,
    resolution: "published",
    chatId: conversation.id,
    graph: { steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, ...entryRulesOf(read) },
    templateStepIds: read.templateStepIds,
    onTheRecord: false,
    createdBy: null,
  });
  if (!answer.resolved) return { saved: answer.version !== null, resolved: false, problem: answer.problem };

  // This desktop's own copy, where it keeps one (an unpublished section).
  if (publishedSectionRow(db, "pipelines") === undefined) {
    const saved = savePipeline(db, engine, { pipelineId: read.pipelineId, steps: read.steps, routes: read.routes, entryStepId: read.entryStepId, ...entryRulesOf(read) });
    if (!saved.saved) {
      const reasons = saved.problems.filter((problem) => problem.severity === "error").map((problem) => problem.message).join(" ");
      return { saved: true, resolved: true, problem: `Published on your organisation's record, and the update is resolved there; this desktop's copy could not take it: ${reasons}` };
    }
  }
  return { saved: true, resolved: true, problem: null };
}

/**
 * The open template update conflict a chat was opened for, where it holds
 * this pipeline (EO-534) — one this database holds, and is the one to
 * hold. A pipeline the organisation's record holds now has its update
 * there, whatever this desktop recorded before (`updateHeldElsewhere`).
 */
function heldUpdateFor(db: Db, conversation: Item, pipelineId: string | null, place: ConflictPlace = {}): PipelineUpdateConflict | undefined {
  if (pipelineId === null || updateHeldElsewhere(db, pipelineId, place)) return undefined;
  const held = openUpdateConflictForChat(db, conversation.id);
  return held?.pipelineId === pipelineId ? held : undefined;
}

/**
 * A draft card's graph has been published (EO-534): where it was raised
 * in the chat that holds a template update conflict, for that pipeline,
 * the conflict is resolved and the pipeline's base moves to the held
 * template version — `resolveHeldUpdate`, which closes the notice too.
 *
 * Checked, not believed (invariant #5). The renderer saying "I published
 * it" is a claim; what makes it true is the pipeline. So it must have
 * filed a version since the card was posted, and its graph must be the
 * card's on every key the comparison reads — a draft read and then
 * refused, or published and edited again before this was asked, resolves
 * nothing.
 */
export function assistDraftPublished(db: Db, input: IpcPayload<"assist:draftPublished">, place: ConflictPlace = {}): IpcResponse<"assist:draftPublished"> {
  const conversation = assistConversationForRead(db, input.conversationId);
  const comment = conversation === undefined ? undefined : getComment(db, input.messageId as Uuid);
  if (conversation === undefined || comment === undefined || comment.itemId !== conversation.id || !isAssistDraftCard(db, conversation, comment.id)) {
    return { resolved: false, problem: "That message is not a draft card." };
  }
  const read = assistDraftForPublish(db, conversation, comment.id);
  const held = heldUpdateFor(db, conversation, read.ok ? read.pipelineId : null, place);
  if (held === undefined) return { resolved: false, problem: null };
  if (!read.ok) return { resolved: false, problem: `The template update is still held: ${read.reason}` };

  const version = currentVersion(db, held.pipelineId);
  if (version === undefined || version.createdAt < comment.createdAt) {
    return { resolved: false, problem: "The template update is still held: this draft has not been published since it was offered." };
  }
  const published = { steps: read.steps, routes: read.routes };
  const live = { steps: listStepsForPipeline(db, held.pipelineId).filter((step) => !step.offBoard), routes: listRoutesForPipeline(db, held.pipelineId) };
  if (compareThreeWay(published, live, published).changes.length > 0) {
    return { resolved: false, problem: "The template update is still held: the pipeline as it stands is not this draft." };
  }
  const unbelieved = templateStepIdsProblem(db, held, read.steps, read.templateStepIds);
  if (unbelieved !== null) return { resolved: false, problem: `The template update is still held: ${unbelieved}` };
  const resolved = resolveHeldUpdate(db, held, "published", { templateStepIds: read.templateStepIds });
  return resolved.ok ? { resolved: true, problem: null } : { resolved: false, problem: `The template update is still held: ${resolved.problem}` };
}

/**
 * Why a draft's rename or icon cannot be published here (EO-520), naming
 * the section and who published it, and what the person can do instead.
 */
function metadataLockedReason(lock: SectionLock, rename: string | null, icon: string | null): string {
  const by = lock.publishedBy === null ? "" : ` ${lock.publishedBy} published it.`;
  const what = rename !== null && icon !== null ? "renames the pipeline and changes its icon" : rename !== null ? "renames the pipeline" : "changes the pipeline's icon";
  return (
    `The ${lock.section} section is managed by your organisation.${by} This draft ${what}, which this machine cannot change, so nothing was published — ` +
    "not the graph either, since half of the card is not what Publish was pressed on. Ask for the draft again without the new name or icon to publish the rest."
  );
}

/**
 * Publishes a draft card that creates a pipeline (EO-381).
 *
 * The pipeline is created here, when the person presses Publish, and not
 * before — a card nobody publishes leaves no empty board behind. Created
 * and filled in one transaction, through `savePipeline`, the function
 * `pipeline:save` itself calls: so the graph is judged exactly as the
 * configuration screen's Publish judges one, and a graph it refuses
 * rolls the pipeline back with it rather than leaving an empty board
 * named for a release that never happened.
 *
 * Everything the read path checks is checked again on the way: the card
 * is still the newest, the name is still free on the project, every
 * module it proposed has been approved. Between the card being drawn and
 * the button being pressed is exactly when somebody could have created a
 * pipeline of that name.
 *
 * Which project it belongs to is the conversation's — the project the
 * thread was opened on, and the one the name was checked against when
 * the card was drawn — so the check and the write cannot disagree about
 * which project's names they mean.
 */
export function publishNewAssistPipeline(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"assist:publishNew">,
): IpcResponse<"assist:publishNew"> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const refuse = (problem: string): IpcResponse<"assist:publishNew"> => ({ saved: false, pipelineId: null, problem });

  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    return refuse("That draft has been superseded by a newer one. Read the latest and publish that instead.");
  }

  const graph = assistDraftForPublish(db, conversation, messageId);
  if (!graph.ok) return refuse(graph.reason);
  // The gate, here as well as in `savePipeline` below (EO-399): the read
  // path now answers a waiting draft with its graph, so this is where a
  // new pipeline is kept from being created for one — named by module,
  // before anything is written.
  if (graph.waiting.length > 0) return refuse(modulesWaitingReason(graph.waiting));
  if (graph.newPipelineName === null) {
    return refuse("That draft changes a pipeline that already exists rather than creating one, so there is nothing to create.");
  }
  const name = graph.newPipelineName;

  try {
    return db.transaction(() => {
      const pipelineId = createAndSavePipeline(db, engine, conversation.projectId, name, graph);
      return { saved: true, pipelineId, problem: null };
    });
  } catch (error) {
    if (!(error instanceof PublishRefused)) throw error;
    return refuse(`Nothing was created: ${error.message}`);
  }
}

/** A graph `savePipeline` refused; carries the validator's words out of the transaction. */
class PublishRefused extends Error {}

/** What publishing a draft writes, whichever read it came from. */
interface PublishedGraph {
  steps: IpcPayload<"pipeline:save">["steps"];
  routes: IpcPayload<"pipeline:save">["routes"];
  entryStepId: string | null;
  entryRules?: EntryRule[] | undefined;
  actions: NonNullable<IpcPayload<"pipeline:save">["actions"]>;
  icon: string | null;
}

/** A draft's entry rules as `pipeline:save` takes them: left out where it sets none, so the pipeline keeps its own. */
function entryRulesOf(graph: { entryRules?: EntryRule[] | undefined }): { entryRules?: EntryRule[] } {
  return graph.entryRules === undefined ? {} : { entryRules: graph.entryRules };
}

/**
 * Creates the pipeline a draft names and saves its graph into it, through
 * `savePipeline` (EO-381). Must run inside the caller's transaction: a
 * graph the save refuses throws `PublishRefused`, which is what takes the
 * created pipeline back with it.
 */
function createAndSavePipeline(db: Db, engine: EngineHandle | undefined, projectId: Uuid | null, name: string, graph: PublishedGraph): string {
  // With the icon the draft gave it (EO-520), if it gave one.
  const pipeline = createPipeline(db, { projectId, name, icon: graph.icon, position: Date.now() });
  const saved = savePipeline(db, engine, {
    pipelineId: pipeline.id,
    steps: graph.steps.map((step) => ({ ...step, pipelineId: pipeline.id })),
    routes: graph.routes.map((route) => ({ ...route, pipelineId: pipeline.id })),
    entryStepId: graph.entryStepId ?? "",
    ...entryRulesOf(graph),
    // The definitions the card proposed (EO-426), written by the
    // same call that writes the graph — and so taken back with the
    // pipeline when it is refused.
    ...(graph.actions.length > 0 ? { actions: graph.actions } : {}),
  });
  // Thrown, so the transaction takes the pipeline back with it.
  if (!saved.saved) throw new PublishRefused(errorsOf(saved));
  return pipeline.id;
}

/** The blocking half of what `savePipeline` refused with, as one sentence. */
function errorsOf(saved: IpcResponse<"pipeline:save">): string {
  return saved.problems
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message)
    .join(" ");
}

// ── Approve and publish (EO-581) ──────────────────────────────────────

type ApproveAndPublishAnswer = IpcResponse<"assist:approveAndPublish">;
type ModuleOutcome = ApproveAndPublishAnswer["modules"][number];

/**
 * Approve and publish: the one button on a draft card that needs modules
 * nobody has approved (EO-581).
 *
 * It replaces an Approve per module and a Publish that waited on them
 * (EO-399). Those were separate acts, so a person could approve two of
 * three modules, find the third failing, and be left with modules
 * approved for live work behind a pipeline that was never published. Here
 * the approvals and the publish are one act, and stand or fall together.
 *
 * Two halves, because a test run is awaited and a SQLite transaction is
 * not something an await can sit inside:
 *
 *   1. **Judge.** Every unapproved module the draft needs has its tests
 *      run now, through the runner `modules:approve` uses, and is held to
 *      `judgeModuleForApproval` — `approveModuleCommand`'s own rule. Every
 *      module is run, so a refusal names every module and case that
 *      failed rather than the first. Any refusal, and nothing is written.
 *      Coverage under the bar that the person has not confirmed comes
 *      back as a question for the card, again with nothing written.
 *   2. **Write.** One transaction: the draft read again (still the
 *      newest card, still fitting, still needing exactly the modules that
 *      were judged), each module checked to be what its tests ran against
 *      and approved, then the pipeline published — created for a new one
 *      (`createAndSavePipeline`, as `assist:publishNew`), saved into the
 *      one that exists (`savePipeline`, as `pipeline:save`) with the name
 *      and icon the card gives it, and the held template update its chat
 *      resolves (EO-534). A save that refuses throws, and every approval
 *      goes back with it.
 *
 * A draft resolving an update the organisation's record holds is
 * published on the record (`assist:publishOnRecord`), which no local
 * transaction can include, so it is refused here with what to do instead.
 *
 * Secrets of steps nothing can reach any more are discarded after the
 * commit, by `onStepsRemoved`, for `pipeline:save`'s reason: a file
 * operation inside a transaction is one SQLite cannot roll back.
 */
export async function approveAndPublishAssistDraft(
  db: Db,
  engine: EngineHandle | undefined,
  runner: Pick<ModuleTestRunner, "run">,
  record: Pick<ItemRecord, "updateConflict">,
  input: IpcPayload<"assist:approveAndPublish">,
  options: { place?: ConflictPlace; onStepsRemoved?: (stepIds: string[]) => void } = {},
): Promise<ApproveAndPublishAnswer> {
  const place = options.place ?? {};
  const asked = { conversationId: input.conversationId, messageId: input.messageId };
  const refuse = (problem: string, modules: ModuleOutcome[] = [], coverage: ApproveAndPublishAnswer["coverage"] = []): ApproveAndPublishAnswer => ({
    saved: false,
    pipelineId: null,
    created: false,
    renamed: false,
    problem,
    modules,
    coverage,
  });
  const conversation = assistConversationForWrite(db, input.conversationId);

  const read = await readAssistDraftForPublishWithRecord(db, record, asked, place);
  if (read.problem !== null) return refuse(read.problem);
  if (read.updateConflictOnRecord) {
    return refuse(
      "This draft resolves a template update your organisation's record holds, which is published on the record rather than here, so its modules cannot be approved in the same step. " +
        "Nothing was approved or published. Approve the modules in Settings → Modules, then publish the draft.",
    );
  }
  const gone = read.waiting.filter((module) => module.state === "gone" || module.id === null);
  if (gone.length > 0) return refuse(modulesWaitingReason(gone));

  // 1. Judge every module, in the order the card lists them.
  const acknowledged = new Set(input.acknowledgeLowCoverage);
  const judged: Extract<ModuleApprovalJudgement, { ready: true }>[] = [];
  const outcomes: ModuleOutcome[] = [];
  for (const module of read.waiting) {
    const id = module.id!;
    const judgement = await judgeModuleForApproval(db, runner, id, acknowledged.has(id));
    if (judgement.ready) {
      judged.push(judgement);
      outcomes.push({ id, slug: module.slug, name: module.name, outcome: "passed", problem: null, lineCoverage: judgement.lineCoverage });
    } else {
      const { answer } = judgement;
      outcomes.push({
        id,
        slug: module.slug,
        name: module.name,
        outcome: answer.coverageAcknowledgementNeeded ? "coverage" : "refused",
        problem: answer.problem,
        lineCoverage: answer.lineCoverage,
      });
    }
  }

  const refused = outcomes.filter((outcome) => outcome.outcome === "refused");
  if (refused.length > 0) {
    return refuse(["Nothing was approved and nothing was published.", ...refused.map((outcome) => outcome.problem ?? `"${outcome.name}" was not approved.`)].join("\n"), outcomes);
  }
  const coverage = outcomes.flatMap((outcome) => (outcome.outcome === "coverage" ? [{ id: outcome.id, name: outcome.name, lineCoverage: outcome.lineCoverage ?? 0 }] : []));
  if (coverage.length > 0) {
    const named = coverage.map((module) => `"${module.name}" (${module.lineCoverage}%)`).join(", ");
    return refuse(
      `Every test case passed, but line coverage of ${named} is under the ${MODULE_COVERAGE_BAR}% bar. Nothing has been approved or published: confirm the figure to approve and publish anyway.`,
      outcomes,
      coverage,
    );
  }

  // 2. Write, all of it or none of it.
  const removed: string[] = [];
  let written: { pipelineId: string; created: boolean; renamed: boolean; resolveConflict: boolean };
  try {
    written = db.transaction(() => {
      // Read again inside the transaction: the tests took time, and the
      // card, the catalog or the pipeline may have moved meanwhile.
      const again = readAssistDraftForPublish(db, asked, place);
      if (again.problem !== null) throw new PublishRefused(again.problem);
      const judgedIds = new Set(judged.map((judgement) => judgement.module.id as string));
      const unjudged = again.waiting.filter((module) => module.state === "gone" || module.id === null || !judgedIds.has(module.id));
      if (unjudged.length > 0) {
        throw new PublishRefused(
          `The draft now needs ${unjudged.map((module) => `"${module.name}"`).join(", ")}, whose tests did not run with the others. Press Approve and publish again.`,
        );
      }
      for (const judgement of judged) {
        if (!stillAsJudged(db, judgement)) {
          throw new PublishRefused(
            `"${judgement.module.name}" changed while the tests were running, so that run is not about what is saved now. Press Approve and publish again to test what is saved.`,
          );
        }
        // One approved elsewhere while the tests ran keeps that approval.
        if (getModule(db, judgement.module.id)?.approvedAt === null) approveModule(db, judgement.module.id);
      }

      if (again.newPipelineName !== null) {
        const pipelineId = createAndSavePipeline(db, engine, conversation.projectId, again.newPipelineName, again);
        return { pipelineId, created: true, renamed: false, resolveConflict: false };
      }
      if (again.pipelineId === null) throw new PublishRefused("That draft names no pipeline to publish into.");
      const saved = savePipeline(
        db,
        engine,
        {
          pipelineId: again.pipelineId,
          steps: again.steps,
          routes: again.routes,
          entryStepId: again.entryStepId ?? "",
          ...entryRulesOf(again),
          ...(again.actions.length > 0 ? { actions: again.actions } : {}),
          ...(again.restoredFrom !== null ? { restoredFrom: again.restoredFrom } : {}),
        },
        (stepIds) => removed.push(...stepIds),
      );
      if (!saved.saved) throw new PublishRefused(errorsOf(saved));
      // The name and icon the card gives the pipeline (EO-520), by the
      // command `pipelines:update` runs, whose lock was asked above.
      const renamed = again.rename !== null || again.icon !== null;
      if (renamed) {
        updatePipelineCommand(db, { id: again.pipelineId, ...(again.rename !== null ? { name: again.rename } : {}), ...(again.icon !== null ? { icon: again.icon } : {}) });
      }
      return { pipelineId: again.pipelineId, created: false, renamed, resolveConflict: again.updateConflictId !== null };
    });
  } catch (error) {
    if (!(error instanceof PublishRefused)) throw error;
    return refuse(`Nothing was approved and nothing was published: ${error.message}`, outcomes);
  }

  if (removed.length > 0) options.onStepsRemoved?.(removed);
  // Published, it resolves the template update its chat holds (EO-534) —
  // after the commit and checked, as `assist:draftPublished` is.
  const resolved = written.resolveConflict ? assistDraftPublished(db, asked, place) : null;
  return {
    saved: true,
    pipelineId: written.pipelineId,
    created: written.created,
    renamed: written.renamed,
    problem: resolved?.problem ?? null,
    modules: outcomes,
    coverage: [],
  };
}

// ── Publish after trials (EO-588) ─────────────────────────────────────

type PublishTrialAnswer = IpcResponse<"assist:publishTrial">;

/** What publishing a trial needs beyond the database: what discarding the trial afterwards takes. */
export interface PublishTrialDeps {
  attachmentStorage?: AttachmentStorage | undefined;
  worktreeRoot?: string | undefined;
}

/**
 * Publish on the publish card after a draft's trials (EO-588) — the
 * person pressed it. `approveAndPublishAssistDraft`'s two halves, for the
 * draft the conversation has been testing rather than a draft card:
 *
 *   1. **Judge.** The card is read (`readTrialPublish`) and refused, with
 *      nothing run, for anything that keeps it from being pressed — a
 *      design change waiting for the person, a stop waiting for their
 *      answer, a test item of the newest round that did not end where it
 *      was expected to without the person having chosen Publish anyway.
 *      Then every module the published graph runs has its tests run and
 *      is held to `judgeModuleForApproval` — one approved before as well,
 *      since publishing puts it onto live work again. Any refusal, and
 *      nothing is written.
 *   2. **Write.** One transaction: the press asked again — the
 *      conversation still open and the card still the newest, since a
 *      reply can replace it while the tests are awaited — the card read
 *      again, each module
 *      checked to be what its tests ran against and approved — a draft
 *      copy first given the name of the module it takes the place of —
 *      and the graph published, every module step running what the trial
 *      ran: as a new version of the pipeline it changes, through
 *      `savePipeline`, or as a new pipeline (`createAndSavePipeline`).
 *      The live module a copy was made of is left as it is: items already
 *      on the pipeline finish on the version they entered on, which runs
 *      it, and so does any other pipeline that names it.
 *
 * Then, after the commit, what came of it is filed under the card — read
 * from the trial before it goes — and the trial and its test items are
 * discarded through the item-delete path (invariant #3's one exception).
 */
export async function publishTrialCommand(
  db: Db,
  engine: EngineHandle | undefined,
  runner: Pick<ModuleTestRunner, "run">,
  deps: PublishTrialDeps,
  input: IpcPayload<"assist:publishTrial">,
  options: { onStepsRemoved?: (stepIds: string[]) => void } = {},
): Promise<PublishTrialAnswer> {
  const refuse = (problem: string, modules: ModuleOutcome[] = [], coverage: PublishTrialAnswer["coverage"] = []): PublishTrialAnswer => ({
    saved: false,
    pipelineId: null,
    created: false,
    problem,
    modules,
    coverage,
  });
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const comment = getComment(db, messageId);
  if (comment === undefined || comment.itemId !== conversation.id || assistCardOf(db, conversation, comment)?.kind !== TRIAL_PUBLISH_CARD_KIND) {
    return refuse("That message is not a publish card.");
  }
  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    return refuse(cardOutcome(db, conversation, messageId) !== null ? "That card has already been pressed." : "That card has been superseded by a newer reply. Read the latest and press that one instead.");
  }

  const read = readTrialPublish(db, conversation);
  if (!read.ok) return refuse(read.problem);
  if (read.view.problem !== null) return refuse(`Nothing was approved and nothing was published: ${read.view.problem}`);
  const { graph } = read;
  // The whole of Publish is authorised before any of it is written, as a
  // draft card's is (EO-520): a rename that could not be applied is half
  // of what was pressed.
  if (graph.pipelineId !== null && (graph.rename !== null || graph.icon !== null)) {
    const lock = sectionLockFor(db, "pipelines:update", { id: graph.pipelineId });
    if (lock !== null) return refuse(metadataLockedReason(lock, graph.rename, graph.icon));
  }

  if (pressing.has(messageId)) return refuse("That card is already being pressed.");
  pressing.add(messageId);
  try {
    // 1. Judge every module the published graph runs, in the order the
    // card lists them — one approved before included: it goes onto live
    // work again with this pipeline, so its tests have to pass now.
    const acknowledged = new Set(input.acknowledgeLowCoverage);
    const judged: Extract<ModuleApprovalJudgement, { ready: true }>[] = [];
    const outcomes: ModuleOutcome[] = [];
    for (const module of read.view.modules) {
      const judgement = await judgeModuleForApproval(db, runner, module.id, acknowledged.has(module.id));
      if (judgement.ready) {
        judged.push(judgement);
        outcomes.push({ id: module.id, slug: module.slug, name: module.name, outcome: "passed", problem: null, lineCoverage: judgement.lineCoverage });
      } else {
        const { answer } = judgement;
        outcomes.push({
          id: module.id,
          slug: module.slug,
          name: module.name,
          outcome: answer.coverageAcknowledgementNeeded ? "coverage" : "refused",
          problem: answer.problem,
          lineCoverage: answer.lineCoverage,
        });
      }
    }
    const refused = outcomes.filter((outcome) => outcome.outcome === "refused");
    if (refused.length > 0) {
      return refuse(["Nothing was approved and nothing was published.", ...refused.map((outcome) => outcome.problem ?? `"${outcome.name}" was not approved.`)].join("\n"), outcomes);
    }
    const coverage = outcomes.flatMap((outcome) => (outcome.outcome === "coverage" ? [{ id: outcome.id, name: outcome.name, lineCoverage: outcome.lineCoverage ?? 0 }] : []));
    if (coverage.length > 0) {
      const named = coverage.map((module) => `"${module.name}" (${module.lineCoverage}%)`).join(", ");
      return refuse(
        `Every test case passed, but line coverage of ${named} is under the ${MODULE_COVERAGE_BAR}% bar. Nothing has been approved or published: confirm the figure to approve and publish anyway.`,
        outcomes,
        coverage,
      );
    }

    // 2. Write, all of it or none of it.
    const removed: string[] = [];
    let written: { pipelineId: string; created: boolean; name: string; replaced: { copy: string; original: string }[]; approved: string[] };
    try {
      written = db.transaction(() => {
        // Read again: the tests took time, and the trial, the catalog or
        // the pipeline may have moved meanwhile.
        // The press itself, asked again: the tests were awaited, and a
        // newer reply may have replaced this card, or the conversation
        // been closed, while they ran.
        const still = getItem(db, conversation.id);
        if (still === undefined || still.archivedAt !== null || still.stepId !== ASSIST_STEP) throw new PublishRefused("The conversation was closed while the tests were running.");
        if (!approvableIds(db, still, ASSIST).has(messageId)) {
          throw new PublishRefused(
            cardOutcome(db, still, messageId) !== null
              ? "That card was pressed elsewhere while the tests were running."
              : "That card was superseded by a newer reply while the tests were running. Read the latest and press that one instead.",
          );
        }
        const again = readTrialPublish(db, still);
        if (!again.ok) throw new PublishRefused(again.problem);
        if (again.live.trial.id !== read.live.trial.id) throw new PublishRefused("The draft under test changed while the tests were running. Read the card again.");
        if (again.view.problem !== null) throw new PublishRefused(again.view.problem);
        const judgedIds = new Set(judged.map((judgement) => judgement.module.id as string));
        const unjudged = again.view.modules.filter((module) => !judgedIds.has(module.id));
        if (unjudged.length > 0) {
          throw new PublishRefused(`The draft now runs ${unjudged.map((module) => `"${module.name}"`).join(", ")}, whose tests did not run with the others. Press Publish again.`);
        }
        for (const judgement of judged) {
          if (!stillAsJudged(db, judgement)) {
            throw new PublishRefused(
              `"${judgement.module.name}" changed while the tests were running, so that run is not about what is saved now. Press Publish again to test what is saved.`,
            );
          }
        }
        // A draft copy takes the place of the module it copied on this
        // pipeline, under that module's name — renamed before it is
        // approved, so the version approval records carries the name.
        const replaced: { copy: string; original: string }[] = [];
        for (const module of again.view.modules) {
          if (module.replaces === null) continue;
          if (module.name !== module.replaces.name) renameModule(db, module.id, module.replaces.name);
          replaced.push({ copy: module.name, original: module.replaces.name });
        }
        const approved: string[] = [];
        for (const judgement of judged) {
          if (getModule(db, judgement.module.id)?.approvedAt !== null) continue;
          approveModule(db, judgement.module.id);
          approved.push(getModule(db, judgement.module.id)?.name ?? judgement.module.name);
        }

        const published = again.graph;
        if (published.newPipelineName !== null) {
          const pipelineId = createAndSavePipeline(db, engine, conversation.projectId, published.newPipelineName, published);
          return { pipelineId, created: true, name: published.newPipelineName, replaced, approved };
        }
        if (published.pipelineId === null) throw new PublishRefused("That draft names no pipeline to publish into.");
        const saved = savePipeline(
          db,
          engine,
          {
            pipelineId: published.pipelineId,
            steps: published.steps,
            routes: published.routes,
            entryStepId: published.entryStepId,
            ...entryRulesOf(published),
            ...(published.restoredFrom !== null ? { restoredFrom: published.restoredFrom } : {}),
          },
          (stepIds) => removed.push(...stepIds),
        );
        if (!saved.saved) throw new PublishRefused(errorsOf(saved));
        if (published.rename !== null || published.icon !== null) {
          updatePipelineCommand(db, { id: published.pipelineId, ...(published.rename !== null ? { name: published.rename } : {}), ...(published.icon !== null ? { icon: published.icon } : {}) });
        }
        return { pipelineId: published.pipelineId, created: false, name: again.view.pipelineName, replaced, approved };
      });
    } catch (error) {
      if (!(error instanceof PublishRefused)) throw error;
      return refuse(`Nothing was approved and nothing was published: ${error.message}`, outcomes);
    }
    if (removed.length > 0) options.onStepsRemoved?.(removed);

    // What was proven, said under the card before the trial it was read
    // from goes — the card has nothing else to show once it has.
    const version = currentVersion(db, written.pipelineId)?.number;
    const notPassed = read.view.items.filter((item) => item.verdict !== "passed");
    const lines = [
      `**Published ${written.name}**${written.created ? " as a new pipeline" : version === undefined ? "" : ` as version ${version}`}, as it was tested in round ${read.view.round ?? "?"}.`,
      ...(judged.length === 0 ? [] : [`Every module's tests passed: ${judged.map((judgement) => `"${getModule(db, judgement.module.id)?.name ?? judgement.module.name}"`).join(", ")}.`]),
      ...(written.approved.length === 0 ? [] : [`Approved for live work: ${written.approved.map((name) => `"${name}"`).join(", ")}.`]),
      ...written.replaced.map((entry) => `The tested copy of "${entry.original}" takes its place on this pipeline; "${entry.original}" itself is unchanged.`),
      ...(written.created ? [] : ["Items already on it finish on the version they entered on."]),
      ...(notPassed.length === 0
        ? []
        : [`Published anyway: ${notPassed.map((item) => `${item.itemKey} "${item.title}"`).join(", ")} did not end where ${notPassed.length === 1 ? "it was" : "they were"} expected to.`]),
    ];
    let problem: string | null = null;
    if (deps.attachmentStorage === undefined) {
      problem = "The trial could not be discarded here. Discard it from the conversation.";
    } else {
      const discarded = await discardTrial(db, engine, deps.attachmentStorage, { trialPipelineId: read.live.trial.id }, deps.worktreeRoot);
      if (!discarded.ok) problem = `The trial could not be discarded: ${discarded.problem}`;
      else lines.push(`The trial and its ${discarded.deletedItemIds.length === 1 ? "test item have" : `${discarded.deletedItemIds.length} test items have`} been deleted.`);
    }
    if (problem !== null) lines.push(problem);
    fileCardOutcome(db, conversation, messageId, { done: true, said: lines.join("\n") });
    engine?.notifyStateChange();
    return { saved: true, pipelineId: written.pipelineId, created: written.created, problem, modules: outcomes, coverage: [] };
  } finally {
    pressing.delete(messageId);
  }
}

// ── Cards for what only a person may do (EO-521) ──────────────────────

/**
 * What a card's two channels reach beyond the database.
 *
 * `dispatch` is the registry's `dispatchIpc`: a card is carried out by
 * calling the channel the pipeline editor called, the way the renderer
 * calls it — the same validation, the same lock, the same pushes — and
 * not by a second path assembled from the command functions beneath it
 * (see `registry.ts`). `readAttachment` is the attachment store's read,
 * since an import card's document is a file somebody attached.
 */
export interface AssistCardDoors {
  dispatch: (channel: IpcChannel, payload: unknown) => Promise<IpcResult<unknown>>;
  readAttachment: (path: string) => Promise<Buffer | null>;
}

/** An assistant conversation, live or put away, for a read that writes nothing. */
function assistConversationForRead(db: Db, conversationId: string): Item | undefined {
  const conversation = getItem(db, conversationId as Uuid);
  return conversation?.stepId === ASSIST_STEP ? conversation : undefined;
}

/** A channel's answer, narrowed by the contract's own schema, or the refusal's sentence. */
async function dispatched<K extends IpcChannel>(doors: AssistCardDoors, channel: K, payload: IpcPayload<K>): Promise<{ ok: true; data: IpcResponse<K> } | { ok: false; reason: string }> {
  const answer = await doors.dispatch(channel, payload);
  if (!answer.ok) return { ok: false, reason: answer.error.message };
  return { ok: true, data: ipcContract[channel].response.parse(answer.data) as IpcResponse<K> };
}

/**
 * The pipeline document an import card names: the file, read from this
 * chat's own attachments and nowhere else. A reason when it cannot be.
 */
async function attachedDocument(db: Db, doors: AssistCardDoors, conversation: Item, attachmentId: string): Promise<{ ok: true; name: string; text: string } | { ok: false; reason: string }> {
  const attachment = getAttachment(db, attachmentId as Uuid);
  if (attachment === undefined || attachment.itemId !== conversation.id) {
    return { ok: false, reason: "The file this card was about is no longer attached to this chat." };
  }
  const bytes = await doors.readAttachment(attachment.path);
  if (bytes === null) return { ok: false, reason: `${attachment.name} can no longer be read from this machine.` };
  return { ok: true, name: attachment.name, text: bytes.toString("utf8") };
}

/**
 * What a card shows, read now (EO-521) — the pipeline it names and what
 * pressing it would do to that pipeline, or what an attached pipeline file
 * would need here.
 *
 * From the database and the file, never from the agent: the card named a
 * pipeline or an attachment and nothing else. An import's needs are
 * `pipelines:importPreflight`'s own answer, asked with the document so no
 * file picker opens, which is every line ImportPreflight drew in the
 * editor and every slug that collides with a module here.
 *
 * Writes nothing, and answers for a card that has been pressed, been
 * superseded or sits in a chat that was put away, so the card keeps
 * saying what it was about.
 */
export async function readAssistCardCommand(db: Db, doors: AssistCardDoors, input: IpcPayload<"assist:card">): Promise<IpcResponse<"assist:card">> {
  const nothing = (problem: string): IpcResponse<"assist:card"> => ({ card: null, problem });
  const conversation = assistConversationForRead(db, input.conversationId);
  const comment = conversation === undefined ? undefined : getComment(db, input.messageId as Uuid);
  const card = conversation !== undefined && comment !== undefined && comment.itemId === conversation.id ? assistCardOf(db, conversation, comment) : null;
  if (conversation === undefined || card === null) return nothing("That message is not a card.");

  // The publish card after a draft's trials (EO-588): read from the trial.
  if (card.kind === TRIAL_PUBLISH_CARD_KIND) {
    const read = readTrialPublish(db, conversation);
    return read.ok ? { card: { kind: card.kind, ...read.view }, problem: null } : nothing(read.problem);
  }

  if (card.kind === "pipelineImport") {
    const file = await attachedDocument(db, doors, conversation, card.attachmentId);
    if (!file.ok) return nothing(file.reason);
    // Against the chat's own project — `null` included — which is where
    // Import will put it, never whichever project happens to be active.
    const checked = await dispatched(doors, "pipelines:importPreflight", { document: file.text, into: { projectId: conversation.projectId } });
    if (!checked.ok) return nothing(checked.reason);
    if (checked.data.preflight === null) return nothing(`${file.name} is not a pipeline EO can import: ${checked.data.problem ?? "it could not be read."}`);
    return { card: { kind: card.kind, attachmentName: file.name, preflight: checked.data.preflight }, problem: null };
  }

  // A project's item type (EO-523): the type as it is and as it would
  // be, and what the channel would refuse the press with now.
  if (isItemTypeCard(card)) {
    const read = itemTypeCardDetail(db, card);
    return "problem" in read ? nothing(read.problem) : { card: read.detail, problem: null };
  }

  if (card.kind === "stepSecret" || card.kind === "stepVariable") {
    const found = liveStep(db, card.stepId);
    if (found === null) return nothing("The step this card was about is no longer on its pipeline.");
    const held = await stepValueHeld(doors, card);
    if (!held.ok) return nothing(held.reason);
    return {
      card: {
        kind: card.kind,
        pipelineId: found.pipeline.id,
        pipelineName: found.pipeline.name,
        stepId: found.step.id,
        stepName: found.step.name,
        name: card.name,
        action: card.action,
        ...held.standing,
      },
      problem: null,
    };
  }

  const pipeline = getPipeline(db, card.pipelineId);
  if (pipeline === undefined) return nothing("The pipeline this card was about no longer exists.");
  switch (card.kind) {
    case "pipelineExport":
      return { card: { kind: card.kind, pipelineId: pipeline.id, pipelineName: pipeline.name }, problem: null };
    case "pipelineDelete":
      return { card: { kind: card.kind, pipelineId: pipeline.id, pipelineName: pipeline.name, itemCount: itemsArchivedWithPipeline(db, pipeline.id) }, problem: null };
    case "pipelineDiscardEdits": {
      const diverged = divergenceCommand(db, { pipelineId: pipeline.id });
      return {
        card: { kind: card.kind, pipelineId: pipeline.id, pipelineName: pipeline.name, line: diverged.line, version: diverged.available ?? diverged.basedOn },
        problem: null,
      };
    }
    case "pipelineWebhookUnattended":
      return {
        card: {
          kind: card.kind,
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          unattended: card.unattended,
          current: pipeline.webhookUnattended,
          entry: pipelineHasWebhookEntry(db, pipeline.id),
          // The lock `pipelines:setWebhookUnattended` will meet, asked the
          // way that channel's door asks it — so the card says before the
          // press what the press would be refused with.
          managed: sectionLockFor(db, "pipelines:setWebhookUnattended", { pipelineId: pipeline.id }) !== null,
        },
        problem: null,
      };
    case "pipelineKeepMine": {
      // Read now (EO-534): a conflict resolved since — a draft published,
      // a newer version superseding it — leaves nothing to keep it from.
      // Through the channel, so an update the organisation's record holds
      // is read there.
      const read = await dispatched(doors, "pipeline:updateConflict", { pipelineId: pipeline.id });
      const held = read.ok ? read.data.conflict : null;
      return {
        card: {
          kind: card.kind,
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          held: held === null ? null : { templateTitle: held.templateTitle, fromVersion: held.fromVersion, toVersion: held.toVersion },
        },
        problem: null,
      };
    }
  }
}

/** Where a name stands for one step, as a card for it says (EO-522) — see `AssistCardDetail`'s step cards. */
interface StepValueStanding {
  set: boolean;
  setAsOther: boolean;
  shared: "secret" | "variable" | null;
  organisation: boolean;
}

/**
 * Where a card's name stands for its step (EO-522): whether the step has
 * its own value of the card's kind or of the other, what the shared list
 * holds under the name, and whether the organisation sets it.
 *
 * Read across both lists, because that is how `environmentFor` gives a
 * run a name — the organisation's value first, then the step's own entry
 * of either kind, then the shared one of either kind. Through the
 * channels the editor's lists read, as names and booleans. A variable's
 * list hands its values back, since a variable is not secret; they are
 * looked at here and go no further, because the card says whether a
 * value is set and never what it is.
 */
async function stepValueHeld(
  doors: AssistCardDoors,
  card: Extract<AssistCard, { kind: "stepSecret" | "stepVariable" }>,
): Promise<{ ok: true; standing: StepValueStanding } | { ok: false; reason: string }> {
  const secrets = await dispatched(doors, "moduleSecrets:list", { stepId: card.stepId });
  if (!secrets.ok) return secrets;
  const variables = await dispatched(doors, "environmentVariables:list", { stepId: card.stepId });
  if (!variables.ok) return variables;

  const { overrides, names, references, stored, organisation } = secrets.data;
  const referenced = (scope: "shared" | "step") => references.some((reference) => reference.scope === scope && reference.name === card.name);
  // Any entry counts, readable or not: an unreadable value or a dangling
  // reference is still what the step is given for the name — nothing.
  const secret = {
    step: overrides.includes(card.name) || stored.step.includes(card.name) || referenced("step"),
    shared: names.includes(card.name) || stored.shared.includes(card.name) || referenced("shared"),
  };
  const named = variables.data.variables.filter((variable) => variable.name === card.name);
  const variable = { step: named.some((entry) => entry.scope === "step"), shared: named.some((entry) => entry.scope === "shared") };

  const mine = card.kind === "stepSecret" ? secret : variable;
  const other = card.kind === "stepSecret" ? variable : secret;
  return {
    ok: true,
    standing: {
      set: mine.step,
      setAsOther: other.step,
      shared: secret.shared ? "secret" : variable.shared ? "variable" : null,
      organisation: organisation.includes(card.name),
    },
  };
}

/** What a run of the step is given for a card's name now, in a sentence — said under a card once it has been pressed. */
function standingSentence(card: Extract<AssistCard, { kind: "stepSecret" | "stepVariable" }>, standing: StepValueStanding): string {
  if (standing.organisation) return `Your organisation sets ${card.name}, so its value is still what a run of this step is given.`;
  if (standing.set || standing.setAsOther) return "";
  if (standing.shared !== null) return `The step now uses the shared ${standing.shared === "secret" ? "secret" : "environment variable"} ${card.name}.`;
  return `The step now has no value for ${card.name}.`;
}

/**
 * Carries out a card — a person pressed its button (EO-521).
 *
 * `applyAssistModuleChangeCommand`'s order: "newest wins" first, by the
 * rule every card in this room shares, so a chat left open on a card a
 * later turn replaced, or one already pressed in another window, cannot
 * act on it; then the card is read again from its run, so what is done
 * is what the card showed; then it is done, through the channel it names.
 *
 * Done or refused, it is said under the card (invariant #8) and the card
 * is spent: the sentence filed there is what the card shows from then on,
 * and what keeps it from being pressed twice. The one press that files
 * nothing is an Export whose save dialog the person closed — they chose
 * nothing, so nothing happened and the card is theirs to press again.
 */
export async function applyAssistCardCommand(
  db: Db,
  engine: EngineHandle | undefined,
  doors: AssistCardDoors,
  input: IpcPayload<"assist:applyCard">,
): Promise<IpcResponse<"assist:applyCard">> {
  const conversation = assistConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;
  const unchanged = (problem: string | null): IpcResponse<"assist:applyCard"> => ({ applied: false, problem, said: null, conversation: toView(db, conversation) });

  if (!approvableIds(db, conversation, ASSIST).has(messageId)) {
    const outcome = cardOutcome(db, conversation, messageId);
    return unchanged(outcome !== null ? "That card has already been pressed." : "That card has been superseded by a newer reply. Read the latest and press that one instead.");
  }
  const comment = getComment(db, messageId);
  const card = comment === undefined ? null : assistCardOf(db, conversation, comment);
  if (card === null) return unchanged("That message is not a card.");
  // Its own button, with the module tests and the coverage question
  // Approve and publish has (EO-588): nothing is filed here, so the card
  // stays to press.
  if (card.kind === TRIAL_PUBLISH_CARD_KIND) return unchanged("Publish on this card is its own button, which runs the modules' tests first. Press it there.");

  // A card that sets a step's value is pressed with the value typed on
  // it. Without one there is nothing to set, and nothing is filed: the
  // card stays to fill in (EO-522).
  if ((card.kind === "stepSecret" || card.kind === "stepVariable") && card.action === "set" && (input.value ?? "") === "") {
    return unchanged(`Type the value for ${card.name} on the card first.`);
  }

  // Asked and claimed before the first await, so a second press — another
  // window, while the first waits on its save dialog — cannot pass the
  // check above before the first has filed anything.
  if (pressing.has(messageId)) return unchanged("That card is already being pressed.");
  pressing.add(messageId);
  let outcome: { done: boolean; said: string } | null;
  try {
    outcome = await carryOut(db, doors, conversation, card, { choices: input.choices, value: input.value });
  } finally {
    pressing.delete(messageId);
  }
  if (outcome === null) return unchanged(null);

  fileCardOutcome(db, conversation, messageId, outcome);
  engine?.notifyStateChange();
  return {
    applied: outcome.done,
    problem: outcome.done ? null : outcome.said,
    said: outcome.said,
    conversation: toView(db, getItem(db, conversation.id) ?? conversation),
  };
}

/** The cards whose button is being carried out right now, by message id. */
const pressing = new Set<string>();

/** What doing a card came to, in the sentence filed under it, or null for a save dialog the person closed. */
async function carryOut(
  db: Db,
  doors: AssistCardDoors,
  conversation: Item,
  card: AssistCard,
  { choices, value }: { choices: Record<string, "reuse" | "import">; value: string | undefined },
): Promise<{ done: boolean; said: string } | null> {
  // Pressed through `assist:publishTrial`, never here (EO-588).
  if (card.kind === TRIAL_PUBLISH_CARD_KIND) return null;
  if (card.kind === "stepSecret" || card.kind === "stepVariable") return carryOutStepValue(db, doors, card, value);
  if (isItemTypeCard(card)) return carryOutItemType(db, doors, card);
  if (card.kind === "pipelineImport") {
    const file = await attachedDocument(db, doors, conversation, card.attachmentId);
    if (!file.ok) return { done: false, said: `Nothing was imported: ${file.reason}` };
    // Into the project the chat was opened on — the one its card was
    // read against — as a draft that creates a pipeline is (EO-381). Named
    // in `into`, so a chat with no project imports into none rather than
    // into the active one.
    const imported = await dispatched(doors, "pipelines:import", { document: file.text, choices, projectId: null, into: { projectId: conversation.projectId } });
    if (!imported.ok) return { done: false, said: `Nothing was imported: ${imported.reason}` };
    if (!imported.data.imported || imported.data.pipelineId === null) return { done: false, said: `Nothing was imported: ${imported.data.problem ?? "EO refused it."}` };
    return { done: true, said: importedNote(db, imported.data) };
  }

  const name = getPipeline(db, card.pipelineId)?.name ?? "The pipeline";
  switch (card.kind) {
    case "pipelineExport": {
      const exported = await dispatched(doors, "pipelines:export", { pipelineId: card.pipelineId, destination: "file" });
      if (!exported.ok) return { done: false, said: `Nothing was exported: ${exported.reason}` };
      if (exported.data.written && exported.data.path !== null) return { done: true, said: `Exported ${name} to ${exported.data.path}.` };
      if (exported.data.problem !== null) return { done: false, said: `Nothing was exported: ${exported.data.problem}` };
      return null;
    }
    case "pipelineDelete": {
      const deleted = await dispatched(doors, "pipelines:delete", { id: card.pipelineId });
      if (!deleted.ok) return { done: false, said: `${name} was not deleted: ${deleted.reason}` };
      if (deleted.data.blockedByActiveRun) {
        return { done: false, said: `${name} was not deleted: a run is working on one of its items. Let it finish, or stop it, and ask again.` };
      }
      if (!deleted.data.deleted) return { done: false, said: `${name} was not deleted.` };
      const count = deleted.data.archivedItemCount;
      return { done: true, said: `Deleted ${name}. It is in the Archive${count === 0 ? "" : `, with the ${count === 1 ? "item" : `${count} items`} that ${count === 1 ? "was" : "were"} on it`}.` };
    }
    case "pipelineDiscardEdits": {
      const discarded = await dispatched(doors, "pipelines:discardEdits", { pipelineId: card.pipelineId });
      if (!discarded.ok) return { done: false, said: `Your edits to ${name} were not discarded: ${discarded.reason}` };
      if (!discarded.data.discarded) return { done: false, said: `Your edits to ${name} were not discarded: ${discarded.data.problem ?? "EO refused it."}` };
      const version = discarded.data.version === null ? "" : ` It is back on v${discarded.data.version}.`;
      return { done: true, said: `Discarded this machine's edits to ${name}.${version} Your organisation's updates apply to it again.` };
    }
    case "pipelineWebhookUnattended": {
      // The channel the editor's switch called: the pipelines lock, the
      // no-webhook refusal and the push all come with it (EO-405).
      const changed = await dispatched(doors, "pipelines:setWebhookUnattended", { pipelineId: card.pipelineId, unattended: card.unattended });
      if (!changed.ok) return { done: false, said: `${name} was not changed: ${changed.reason}` };
      if (changed.data.refused !== null) return { done: false, said: `${name} was not changed: ${changed.data.refused}` };
      return {
        done: true,
        said: card.unattended
          ? `${name} now sends webhook items on without a person reading them first. Publishing reports that as a warning rather than refusing.`
          : `${name} no longer sends webhook items on unread. Publishing is refused again while a step that sends can be reached before a person approves.`,
      };
    }
    case "pipelineKeepMine": {
      // Through the channel, so its push reaches every window's inbox,
      // where the notice this closes is drawn (EO-534).
      const kept = await dispatched(doors, "pipeline:keepOwnVersion", { pipelineId: card.pipelineId });
      if (!kept.ok) return { done: false, said: `${name} was not marked resolved: ${kept.reason}` };
      if (!kept.data.kept) return { done: false, said: `${name} was not marked resolved: ${kept.data.problem ?? "EO refused it."}` };
      return {
        done: true,
        said: `Kept ${name} as it is and skipped the template update to ${kept.data.toVersion ?? "its new version"}. Nothing in the pipeline changed; the next template version is compared with this one.`,
      };
    }
  }
}

/**
 * Sets or clears a step's own secret or variable (EO-522), through the
 * channel the editor's list called.
 *
 * The value is the person's, typed on the card, and it goes to that
 * channel and nowhere else. The sentence filed under the card names the
 * step and the variable and never the value — it is what the chat shows
 * and what the agent's next turn reads.
 */
async function carryOutStepValue(
  db: Db,
  doors: AssistCardDoors,
  card: Extract<AssistCard, { kind: "stepSecret" | "stepVariable" }>,
  value: string | undefined,
): Promise<{ done: boolean; said: string } | null> {
  const found = liveStep(db, card.stepId);
  if (found === null) return { done: false, said: `Nothing was ${card.action === "set" ? "set" : "cleared"}: that step is no longer on its pipeline.` };
  const what = card.kind === "stepSecret" ? `The secret ${card.name}` : `The environment variable ${card.name}`;
  const where = `the ${found.step.name} step of ${found.pipeline.name}`;

  if (card.action === "clear") {
    const cleared =
      card.kind === "stepSecret"
        ? await dispatched(doors, "moduleSecrets:clear", { name: card.name, stepId: card.stepId })
        : await dispatched(doors, "environmentVariables:clear", { name: card.name, stepId: card.stepId });
    if (!cleared.ok) return { done: false, said: `${what} was not cleared on ${where}: ${cleared.reason}` };
    if (!cleared.data.cleared) return { done: false, said: `${what} was not cleared on ${where}.` };
    return { done: true, said: [`${what} was cleared on ${where}.`, await afterwards(doors, card)].filter(Boolean).join(" ") };
  }

  // Asked before anything is claimed (see `applyAssistCardCommand`);
  // here only so this function cannot be reached round that check.
  if (value === undefined || value === "") return null;
  const saved =
    card.kind === "stepSecret"
      ? await dispatched(doors, "moduleSecrets:set", { name: card.name, value, stepId: card.stepId })
      : await dispatched(doors, "environmentVariables:set", { name: card.name, value, stepId: card.stepId });
  if (!saved.ok) return { done: false, said: `${what} was not set on ${where}: ${saved.reason}` };
  if (!saved.data.saved) return { done: false, said: `${what} was not set on ${where}: ${saved.data.problem ?? "EO refused it."}` };
  return {
    done: true,
    said: [`${what} was set on ${where}. The value is kept on this machine, and it is not shown here.`, await afterwards(doors, card)].filter(Boolean).join(" "),
  };
}

/** Where the name stands once the press is done, or nothing where that cannot be read — the press itself has already happened. */
async function afterwards(doors: AssistCardDoors, card: Extract<AssistCard, { kind: "stepSecret" | "stepVariable" }>): Promise<string> {
  const held = await stepValueHeld(doors, card);
  return held.ok ? standingSentence(card, held.standing) : "";
}

/**
 * Adds, changes or removes an item type (EO-523), through the channel the
 * editor's Types section called — so its refusals are the ones filed
 * under the card: a pack's type reshaped or removed, items filed under
 * the type, a name already taken.
 */
async function carryOutItemType(
  db: Db,
  doors: AssistCardDoors,
  card: Extract<AssistCard, { kind: "itemTypeCreate" | "itemTypeUpdate" | "itemTypeDelete" }>,
): Promise<{ done: boolean; said: string }> {
  if (card.kind === "itemTypeCreate") {
    const name = card.label.trim();
    // Into the project the card names, never whichever one is active.
    const created = await dispatched(doors, "itemTypes:create", {
      projectId: card.projectId,
      label: card.label,
      plural: card.plural,
      container: card.container,
      fields: card.fields,
    });
    if (!created.ok) return { done: false, said: `“${name}” was not added: ${created.reason}` };
    if (created.data.type === null) return { done: false, said: `“${name}” was not added: ${created.data.problem ?? "EO refused it."}` };
    const project = getProject(db, card.projectId as Uuid)?.name ?? "the project";
    return { done: true, said: `Added the item type “${created.data.type.label}” to ${project}. Items of it are filed as \`${created.data.type.slug}\`.` };
  }

  const existing = getItemType(db, card.itemTypeId as Uuid);
  if (existing === undefined) return { done: false, said: "Nothing was changed: that item type is not here any more." };
  if (card.kind === "itemTypeDelete") {
    const deleted = await dispatched(doors, "itemTypes:delete", { id: existing.id });
    if (!deleted.ok) return { done: false, said: `“${existing.label}” was not deleted: ${deleted.reason}` };
    if (!deleted.data.deleted) return { done: false, said: `“${existing.label}” was not deleted: ${deleted.data.problem ?? "EO refused it."}` };
    return { done: true, said: `Deleted the item type “${existing.label}”.` };
  }

  const updated = await dispatched(doors, "itemTypes:update", itemTypeUpdatePayload(existing, card));
  if (!updated.ok) return { done: false, said: `“${existing.label}” was not changed: ${updated.reason}` };
  if (updated.data.type === null) return { done: false, said: `“${existing.label}” was not changed: ${updated.data.problem ?? "EO refused it."}` };
  return { done: true, said: `Saved the item type “${updated.data.type.label}” (${updated.data.type.plural}).` };
}

/** What an import brought, in the words the editor's Import used. */
function importedNote(db: Db, imported: IpcResponse<"pipelines:import">): string {
  const name = imported.pipelineId === null ? undefined : getPipeline(db, imported.pipelineId)?.name;
  const them = imported.unapprovedModules.length === 1 ? "it" : "them";
  return [
    `Imported ${name ?? "the pipeline"}.`,
    imported.unapprovedModules.length > 0
      ? `${imported.unapprovedModules.join(", ")} arrived unapproved — read and approve ${them} under Settings → Modules before this pipeline will publish. Approving runs a module's tests, and every one has to pass.`
      : "",
    keptDefinitionsNote(imported.keptDefinitions),
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
}
