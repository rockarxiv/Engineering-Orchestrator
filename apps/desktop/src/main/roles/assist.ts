import {
  type AssistDraft,
  type AssistModuleChange,
  type AssistOutput,
  AssistOutputSchema,
  type Comment,
  type CustomModule,
  developerType,
  type Item,
  type ModuleChangeCard,
  parsedResultOf,
  type PipelineStepView,
  type ParsedActionDefinitionDraft,
  proposedActionDraft,
  type ProposedModule,
  type AssistWaitingModule,
  builtinInputs,
  NO_WORKSPACE,
  type StepRouteView,
  ITEM_WORKSPACE,
  type Uuid,
  uuidv7,
  type EntryRule,
} from "@eo/core";
import { hasBlockingProblem } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  addModuleTests,
  getModuleTest,
  putModuleTests,
  moduleTestsWouldChange,
  createItem,
  getPipeline,
  getRun,
  getSetting,
  getItem,
  getModule,
  getModuleBySlug,
  getStep,
  getWorkspace,
  lastCommentAtByItem,
  listCommentsForItem,
  threadOpening,
  listModules,
  listPipelines,
  listRunEvents,
  listStepsForPipeline,
  listItemsOnStepIncludingArchived,
  listModuleTests,
  listProjects,
  archivedProjectOf,
  itemsOnArchivedProjects,
  pipelineVersionByNumber,
  postComment,
  projectWorkspaceList,
  saveModule,
  setSetting,
  setItemArchived,
  updateItem,
  versionSnapshot,
} from "../db/repos/index.js";
import { activeProjectId } from "../ipc/repositoryCommands.js";
import { chatPipelineProjectId } from "../ipc/pipelineHome.js";
import { registry } from "../registry.js";
import {
  draftStepResults,
  holdingPhrase,
  publishedStepInputs,
  renderDraft,
  itemCounts,
  settledStepSettings,
  validateDraft,
  withoutDraftSettings,
} from "./architect.js";
import { postAssistCard } from "./assistCards.js";
import { outputOf, runOf, threadOf, type ConversationThread } from "./conversationThread.js";
import { ASSIST_ACTION, ASSIST_SETTINGS_KEY, ASSIST_STEP } from "./conversationSteps.js";
import { postDiscussionQuestions, renderProposal } from "./discussion.js";
import { applyModuleChange, canonical, drawModuleChange, sameManifest, type AppliedModuleChange } from "./moduleChange.js";
import { PIPELINE_GRAPH_TOOL, PIPELINE_READ_SERVER, SCREEN_TOOL, pipelineReadVerdict, type PipelineNotRead } from "./pipelineRead.js";
import { PROPOSAL_KIND } from "./proposal.js";
import { scenarioTurnOn } from "./scenario.js";

/**
 * The assistant's room: one conversation, with the system agent.
 *
 * The shape the retired rooms had, Discussions and the Architecture panel
 * (EO-526) — a conversation is an item on an off-board step, a turn is a
 * run driven by an @-mention, and what the agent says comes back as
 * comments. Three things are this room's own, and they are the whole of
 * this file:
 *
 *   * which conversation you get. Discussions had one live thread per
 *     project and the architect one per pipeline; this has **as many
 *     as the person has open, and one of them shown** (EO-391). Every
 *     window shows the same chat wherever it is opened, and starting
 *     another or going back to an earlier one is navigation: it changes
 *     which chat is shown and nothing else. It was one per page until
 *     EO-193, and the reason it is not is EO-192: the page was preloaded
 *     into every turn, so a thread opened on an item carried that item's
 *     section and could not be walked to another screen. It was exactly
 *     one from then until EO-391, and the reason it no longer is is cost
 *     and interruption: a quick unrelated question landed on top of a
 *     long working session and replayed all of it to the model, and the
 *     only way out stopped the turn that session was running.
 *   * that a chat goes stale. Untouched for longer than the configured
 *     number of days it is archived, so a question asked next week does
 *     not silently carry last week's conversation into it. Each chat is
 *     judged on its own last word. Clear is the same act, asked for, of
 *     the chat being shown.
 *   * that a turn can carry both kinds of gated artefact. It is the one
 *     room where "add a QA step after Review" and "file that as a bug"
 *     are both ordinary things to say.
 *
 * Nothing here applies anything, exactly as `architect.ts` applies
 * nothing: a draft is published through the same `pipeline:save` every
 * other change goes through, and a proposal becomes items through
 * `applyDiscussionProposal`. A third way to write a graph or
 * a story DAG would be a second implementation of the two gates that
 * exist precisely because nobody downstream can check them for you.
 *
 * The channels are `ipc/assistCommands.ts` and the conversation is
 * `renderer/src/chat/ChatConversation.tsx`, with each turn drawn by
 * `chat/conversation/TurnView.tsx`; `ipc/conversationView.ts` renders a
 * conversation whatever it is about, so neither of them holds a second
 * opinion about what a card is or which question is still live.
 */

/**
 * The step and the action, re-exported so this stays the one file to
 * read about the assist room.
 *
 * They are declared in `conversationSteps.ts` because the dispatcher
 * needs them too and reaching into this file for them would close an
 * import cycle — see the note there.
 */
export { ASSIST_ACTION, ASSIST_STEP } from "./conversationSteps.js";

/**
 * Who answers here.
 *
 * The same row both other rooms resolve (EO-181) and the same resolver,
 * renamed rather than re-implemented: three copies of "the enabled agent
 * whose role is system" would be three places to forget `enabled`, and
 * an assist turn dispatched to a disabled agent is a run that cannot
 * start. Which action it is asked for still comes from the step the
 * item sits on, so sharing the resolver settles nothing about what
 * this room asks for.
 */
export { architectAgent as assistAgent } from "./architect.js";

/** `ASK-3` rather than `EO-53`, for the reason `DISC` and `ARCH` have their own sequences. */
export const ASSIST_KEY_PREFIX = "ASK";

/**
 * Where this room's own state lives in `items.spec`.
 *
 * The same key the per-conversation model and effort live under, holding
 * one object rather than two: `discussions:settings`-style writes merge
 * what they find, so what is written here survives a settings write and
 * the settings survive being read back beside it. The architect does the
 * same with its `pipelineId`.
 */
const SPEC_KEY = ASSIST_SETTINGS_KEY;

/**
 * Where the board each exchange was started from is held.
 *
 * The one thing left on the row about where the room is being used
 * from, and it is deliberately a list of *identifiers* rather than an
 * account of a screen. EO-192 removed the page from `spec` because it
 * was rendered into the prompt as `## The page`, where a record written
 * at send time is a description of somewhere the person may already have
 * left. Nothing here is ever rendered or read by an agent. It answers
 * one question nothing else in the room can: **which graph a draft card
 * is about.**
 *
 * A draft that names no pipeline carries steps and routes and nothing
 * that says which pipeline it replaces, and guessing from a step id that
 * happens to exist would offer a Publish button over the wrong board — so
 * with one thread spanning every screen, the board the person was on when
 * they asked is the only honest answer. A draft *can* name one since
 * EO-381 (`draft.target`), and then that wins: see `draftDestination`.
 *
 * **A log rather than a single value, and that is the whole point.** The
 * obvious shape — one `pipelineId` on the row, rewritten by each message
 * — is wrong in a way that only shows up mid-conversation: ask for a
 * graph on the Delivery board, walk to Settings and send a follow-up
 * while the first turn is still thinking (the panel stays open across a
 * walk, which is the entire premise of EO-193), and the first turn's
 * draft renders against Settings. It is refused, or worse, published
 * against whichever board the last message happened to come from. So a
 * board is pinned to the *exchange* that was started from it, and a turn
 * resolves the entry standing at its own initiating comment —
 * `assistBoardFor` below.
 *
 * The log only ever records a *change* of board (`onlyWhereItChanged`),
 * which is what keeps it small without anything being thrown away that a
 * turn could still ask for.
 */
const BOARDS_FIELD = "boards";

/**
 * Where what a module-change card was drawn against is kept, by card id
 * (EO-418): which module it is for, and the hashes of that module's code
 * and manifest at the moment the card was posted.
 *
 * It is also what makes a comment a change card at all. Every other card
 * in this room is found by its place in its run's posting order; this one
 * is found by its id being here, because it was written here in the same
 * breath as the card was posted and nothing else writes to it.
 */
const MODULE_CHANGES_FIELD = "moduleChanges";

/** One exchange, and the board it was started from. */
interface AssistBoard {
  /** The comment that started it — a person's message, or the answer that closed a question card. */
  from: string;
  /** The pipeline that screen was drawing, or null for a screen that is not a board. */
  pipelineId: string | null;
}

/**
 * How long a thread stays resumable, in days.
 *
 * A setting rather than a constant, and read where it is used rather
 * than at startup, which is `readGuards`' rule: changing it applies to
 * the next room opened instead of to the next launch of the app.
 *
 * Its own key rather than a fifth field on the `settings:get` preference
 * object, whose doc comment gives the reason — that object is written
 * whole by whichever screen is showing part of it, so a screen showing
 * Do Not Disturb would reset this on its way past. The same argument
 * `repositoryIntelligence/gate.ts` makes for two keys instead of one
 * bag.
 */
export const ASSIST_EXPIRY_DAYS_KEY = "engine.assistExpiryDays";

/**
 * Three days.
 *
 * Long enough that coming back to an item after a night and a morning
 * continues the conversation you were having, short enough that a
 * question asked next week starts clean. The number is a judgement, not
 * a fact, which is exactly why it is a setting.
 */
export const DEFAULT_ASSIST_EXPIRY_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The expiry as it stands right now.
 *
 * Anything stored that is not a positive, finite number reads as the
 * default. A junk row is not worth failing to open the room over, and
 * the alternatives are both worse: `NaN` days makes every comparison
 * false, so nothing would ever expire, and a negative one expires every
 * thread the instant it is created.
 */
export function readAssistExpiryDays(db: Db): number {
  const stored = getSetting<unknown>(db, ASSIST_EXPIRY_DAYS_KEY, DEFAULT_ASSIST_EXPIRY_DAYS);
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_ASSIST_EXPIRY_DAYS;
}

/** Writes it, and answers with what is stored now. Refuses nothing a person cannot already do by hand. */
export function writeAssistExpiryDays(db: Db, days: number): number {
  setSetting(db, ASSIST_EXPIRY_DAYS_KEY, days);
  return readAssistExpiryDays(db);
}

// ── The conversation ──────────────────────────────────────────

/**
 * Starts the conversation.
 *
 * A feature, deliberately and not cosmetically: `dispatchWorkspace`
 * hands feature-type items the repository itself rather than cutting a
 * worktree, and KAN-40/41 guarantee no branch and no pull request. That
 * read-only shape is exactly what a conversation needs. Inherited rather
 * than special-cased.
 */
export function openAssistConversation(db: Db, projectId: Uuid | null): Item {
  const created = createItem(db, {
    type: developerType("feature"),
    title: "Assistance",
    stepId: ASSIST_STEP,
    projectId,
    keyPrefix: ASSIST_KEY_PREFIX,
  });
  // A conversation has no thread to post a guard into — the thread is
  // what is being created — and the button that opens one has no
  // refusal channel. An installation whose project has no container type
  // cannot host a chat at all, which is a broken installation rather than
  // a request to decline, so the refusal becomes an exception.
  if (!created.ok) throw new Error(created.problem);
  return created.item;
}

/**
 * Where the chat on show is kept (EO-391): one id for each project
 * (EO-765), as an object from the project's id to its chat's.
 *
 * A setting rather than something each window remembers, because every
 * window that draws the chat layout's conversation opens the room with
 * `assist:open` and has to be handed the same chat. It is the one thing
 * "which chat" is decided by now that being live no longer singles one
 * out.
 *
 * Per project because a chat is: the rail lists the chats of the project
 * the person is on, so the one on show is one of those, and coming back
 * to a project comes back to the chat left open on it. A database from
 * before that stores a single id here, and it is read as the chat on
 * show of whichever project that chat is on — the id is only ever looked
 * for among one project's chats.
 */
export const SHOWN_ASSIST_KEY = "assist.shownConversationId";

/**
 * The project a chat counts as on (EO-765): its own, or — for one
 * opened before any project existed — the first project made. Asked of a
 * project the person is on as well, so that the two sides of every
 * comparison resolve alike: with no project yet both are null.
 *
 * Read rather than written onto the chat. Nothing else about a chat with
 * no project changes, and the rail is the one place that has to put it
 * somewhere.
 */
function chatProjectKey(projectId: Uuid | null, firstProjectId: Uuid | null): string {
  return projectId ?? firstProjectId ?? "";
}

function firstProjectId(db: Db): Uuid | null {
  return listProjects(db)[0]?.id ?? null;
}

/** The project a chat is listed on (`chatProjectKey`): its own, or the first one made, or none while there is no project. */
export function assistChatProjectId(db: Db, conversation: Item): Uuid | null {
  return conversation.projectId ?? firstProjectId(db);
}

/** Which of `conversations` count as on `projectId` (`chatProjectKey`). */
function onProject(db: Db, conversations: Item[], projectId: Uuid | null): Item[] {
  const first = firstProjectId(db);
  const wanted = chatProjectKey(projectId, first);
  return conversations.filter((item) => chatProjectKey(item.projectId, first) === wanted);
}

/**
 * Every live assistant chat, newest first — of every project, or of
 * `projectId` alone when one is given (EO-765). Which chats are live, not
 * where each is drawn — that is `orderedAssistConversations`.
 *
 * Several can be live at once (EO-391): each is its own item, and so its
 * own provider thread — `supervisor/threadReuse.ts` keys a resumable
 * session on the item and the agent, so nothing said in one is replayed
 * into another.
 *
 * Every project's is what the idle sweep weighs: each chat goes quiet on
 * its own last word, whichever project the person happens to be on.
 *
 * A chat on an archived project is not one of them (EO-347), though its
 * own row is not archived: nothing on an archived project is dispatched,
 * so it would take a message and never answer it. `listAssistThreads`
 * leaves it out and `resumeAssistRoom` refuses it, and this is the same
 * rule for everything that picks a chat without being told which — the
 * one on show, the empty one New chat and Clear reuse, the idle sweep.
 * It is not put away either: restoring the project brings it back as it
 * was.
 */
export function liveAssistConversations(db: Db, projectId?: Uuid | null): Item[] {
  const shelved = itemsOnArchivedProjects(db);
  const live = listItemsOnStepIncludingArchived(db, ASSIST_STEP)
    .filter((item) => item.stepId === ASSIST_STEP && item.archivedAt === null && !shelved.has(item.id))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  return projectId === undefined ? live : onProject(db, live, projectId);
}

/** What `SHOWN_ASSIST_KEY` holds, as one object whatever was written. */
function storedShown(db: Db): { byProject: Record<string, string>; legacy: string | null } {
  const stored = getSetting<unknown>(db, SHOWN_ASSIST_KEY, null);
  if (typeof stored === "string") return { byProject: {}, legacy: stored };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { byProject: {}, legacy: null };
  const byProject = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { byProject, legacy: null };
}

/**
 * The chat on show on `projectId`, however old it is, or none.
 *
 * The one `SHOWN_ASSIST_KEY` names for that project, while it is still
 * live there. Otherwise the project's newest live chat — never one on an
 * archived project, stored or not — which is what makes this need no
 * migration: on a database written before EO-391 nothing is stored, and
 * the one live thread there is simply is the newest. The same answer
 * covers a stored id whose chat has since been removed or put away by
 * another path.
 *
 * Separate from `openAssistRoom` because the two answer different
 * questions: this is "is there a chat on show", and that is "give me the
 * chat to talk in". Only the second one is allowed to write anything.
 */
export function shownAssistConversation(db: Db, projectId: Uuid | null): Item | undefined {
  const live = liveAssistConversations(db, projectId);
  const { byProject, legacy } = storedShown(db);
  const stored = byProject[chatProjectKey(projectId, firstProjectId(db))] ?? legacy;
  return (stored !== null ? live.find((item) => item.id === stored) : undefined) ?? live[0];
}

/**
 * Makes `conversation` the chat every surface shows on its project.
 * Changes nothing else, about it, about any other chat, or about which
 * chat is on show on another project.
 */
function show(db: Db, conversation: Item): Item {
  const first = firstProjectId(db);
  const { byProject, legacy } = storedShown(db);
  const next = { ...byProject };
  // A single id from before EO-765 is the chat on show of its own
  // project, and stays that when another project's is written.
  const was = legacy === null ? undefined : getItem(db, legacy as Uuid);
  if (was) next[chatProjectKey(was.projectId, first)] ??= was.id;
  next[chatProjectKey(conversation.projectId, first)] = conversation.id;
  setSetting(db, SHOWN_ASSIST_KEY, next);
  return conversation;
}

/**
 * Where the order of the open chats is kept (EO-438): the ids of the
 * chats that have been given a place, first to last.
 *
 * A setting for the reason `SHOWN_ASSIST_KEY` is one: the chat layout's
 * rail draws `assist:list` in every window that shows it, so where a
 * chat stands is the main process's to say and not something one window
 * remembers.
 *
 * One list for every project, and still each project's own order
 * (EO-765): a project's order is its chats' ids read from it, and
 * arranging one project's chats only writes over their own slots, so no
 * other project's chat moves.
 *
 * It is the person's order. Nothing that merely happens in a chat — a
 * message, a reply, being shown — writes here; the list used to be
 * sorted by last activity, and so rearranged itself under whoever was
 * using it. Two things write: a drag (`reorderAssistConversation`), and
 * a chat gone back to from Earlier, which joins at the bottom.
 */
export const ASSIST_ORDER_KEY = "assist.openOrder";

function storedAssistOrder(db: Db): string[] {
  const stored = getSetting<unknown>(db, ASSIST_ORDER_KEY, null);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

/**
 * The open chats on `projectId` in the order they are drawn (EO-438).
 *
 * The ones with a stored place, in that order, below the ones with none
 * — newest-started first. That second half is every automatic placement
 * that needs no write: a chat just started has no place and is the
 * newest, so it is at the top; and on a database from before the order
 * was stored nothing has a place, so the open chats read newest-started
 * first until something is dragged. A stored id whose chat has since
 * been removed or put away is simply not answered with.
 */
export function orderedAssistConversations(db: Db, projectId: Uuid | null): Item[] {
  const live = liveAssistConversations(db, projectId);
  const place = new Map(storedAssistOrder(db).map((id, index) => [id, index]));
  const placed = live.filter((item) => place.has(item.id)).sort((a, b) => place.get(a.id)! - place.get(b.id)!);
  return [...live.filter((item) => !place.has(item.id)), ...placed];
}

/**
 * Stores the open chats on `projectId` as `arrange` leaves them, every
 * one of them now with a place.
 *
 * Written whole, so that the order on screen is the order stored: a chat
 * that stood where it did only for being newer keeps standing there once
 * another has been moved around it.
 *
 * A chat on another project keeps its slot (EO-765), and so does one on
 * an archived project: neither is open here, and each is where it was
 * when it is next drawn. Anything else that is not open — removed, or
 * put away — is dropped, which is what makes a chat gone back to from
 * Earlier one with no place yet.
 */
function arrangeAssistConversations(db: Db, projectId: Uuid | null, arrange: (ids: string[]) => string[]): void {
  const open = orderedAssistConversations(db, projectId).map((item): string => item.id);
  const isOpen = new Set(open);
  const kept = new Set(
    listItemsOnStepIncludingArchived(db, ASSIST_STEP)
      .filter((item) => item.stepId === ASSIST_STEP && item.archivedAt === null)
      .map((item) => item.id as string),
  );
  const stored = storedAssistOrder(db);
  // Every slot there is: the open chats with no place yet, where they
  // are drawn, then what was stored and still exists.
  const slots = [...open.filter((id) => !stored.includes(id)), ...stored.filter((id) => kept.has(id))];
  const next = arrange(open);
  let taken = 0;
  setSetting(
    db,
    ASSIST_ORDER_KEY,
    slots.map((id) => (isOpen.has(id) ? next[taken++]! : id)),
  );
}

/**
 * Moves one open chat to `index` among the open chats of its project, as
 * a person dragging it there (EO-438). The others keep their relative
 * order, and no other project's chat moves (EO-765).
 *
 * `index` is clamped rather than refused — a list drawn a moment ago may
 * be one longer than the list there is now. Refused, with the sentence
 * the person reads and nothing written, for a chat that is not open:
 * dragging never changes whether a chat is put away.
 */
export function reorderAssistConversation(db: Db, conversationId: Uuid, index: number): { problem: string | null } {
  const target = liveAssistConversations(db).find((item) => item.id === conversationId);
  if (!target) return { problem: "That chat is not open any more, so it was not moved." };
  db.transaction(() =>
    arrangeAssistConversations(db, target.projectId, (ids) => {
      const rest = ids.filter((id) => id !== conversationId);
      rest.splice(Math.max(0, Math.min(Math.trunc(index), rest.length)), 0, conversationId);
      return rest;
    }),
  );
  return { problem: null };
}

/**
 * An empty chat on `projectId`, shown: a live one there nobody has said
 * anything in, or a new one when there is none.
 *
 * The first half is `clearAssistRoom`'s rule about empty threads applied
 * to several: New chat pressed twice, or pressed and then walked away
 * from, would otherwise leave an `ASK-` row behind each time that nobody
 * ever spoke in.
 *
 * Only an empty one that is what a new one would be: on the project the
 * person is on now. A chat belongs to the project it was opened on — it
 * is whose pipelines a draft raised in it is checked against — so an
 * empty chat left on another project is not the chat being asked for,
 * and one left on an archived project (which `liveAssistConversations`
 * does not answer with at all) would never be answered.
 */
function showEmptyAssistConversation(db: Db, projectId: Uuid | null): Item {
  const empty = liveAssistConversations(db, projectId).find((item) => listCommentsForItem(db, item.id).length === 0);
  return show(db, empty ?? openAssistConversation(db, projectId));
}

/**
 * Is this the chat a new one on `projectId` would be: on that project,
 * with nothing said in it?
 *
 * One predicate for every place that would rather show an empty chat
 * than make another, the chat already on show included.
 */
function isEmptyChatOn(db: Db, conversation: Item, projectId: Uuid | null): boolean {
  return onProject(db, [conversation], projectId).length === 1 && listCommentsForItem(db, conversation.id).length === 0;
}

/** The room's own object in `items.spec`, or an empty one. `null` is an object and an array is one too. */
function scopeOf(conversation: Item): Record<string, unknown> {
  const stored = conversation.spec?.[SPEC_KEY];
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
}

/** The boards recorded on this conversation, oldest first, ignoring anything that is not one. */
export function assistBoards(conversation: Item): AssistBoard[] {
  const stored = scopeOf(conversation)[BOARDS_FIELD];
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { from, pipelineId } = entry as Record<string, unknown>;
    if (typeof from !== "string" || from === "") return [];
    return [{ from, pipelineId: typeof pipelineId === "string" && pipelineId !== "" ? pipelineId : null }];
  });
}

/**
 * Pins the board a message was sent from to that message.
 *
 * Verified rather than believed: a pipeline id arrives from the renderer
 * as a route parameter, and one naming a board that is not there is
 * recorded as null. Invariant #5 — where EO can check a claim itself, it
 * must — and the failure it avoids is a Publish button over a graph that
 * would be validated against nothing.
 *
 * Recorded *against the comment*, never as the conversation's current
 * state, for the reason `BOARDS_FIELD` gives: a thread spans every
 * screen now, so "where this conversation is" is not a thing that
 * exists, and a turn has to be able to answer for where it was started
 * from however far the person has walked since.
 *
 * Null is recorded as carefully as an id is. "Asked from Settings" is a
 * fact about that exchange, and leaving it out would let the entry
 * before it answer for a question that was not asked on a board at all.
 *
 * Merged into whatever else this room keeps under its key rather than
 * written over it, so a model set for this thread survives.
 *
 * Merged onto the row *as it stands*, not onto the row it was handed. A
 * caller holding a conversation it read before the last message would
 * otherwise write back a log with that message missing from it, and what
 * would be lost is exactly the entry a turn still in flight is about to
 * ask for.
 */
export function recordAssistBoard(db: Db, conversation: Item, from: string, pipelineId: string | null): Item {
  const current = getItem(db, conversation.id) ?? conversation;
  const resolved = pipelineId !== null && getPipeline(db, pipelineId) ? pipelineId : null;
  const kept = onlyWhereItChanged(
    [...assistBoards(current).filter((board) => board.from !== from), { from, pipelineId: resolved }]
      // Chronological, which for uuidv7 is lexicographic — the same
      // ordering `assistBoardFor` reads them back in, and the same one
      // the ids were minted with.
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
  );

  const next = { ...scopeOf(current), [BOARDS_FIELD]: kept };
  return updateItem(db, current.id, { spec: { ...(current.spec ?? {}), [SPEC_KEY]: next } }) ?? current;
}

/**
 * The log, with every entry that says what the one before it says
 * dropped.
 *
 * Loss-free, and that is the whole argument for it: the lookup takes the
 * newest entry at or before a turn's initiating comment, so an entry
 * naming the same board as its predecessor is an entry no turn can get a
 * different answer from. Every turn — dispatched, in flight, or not yet
 * started — resolves exactly as it did before.
 *
 * **This is the pruning, and there is deliberately no other.** A fixed
 * cap on the number of entries was the obvious alternative and it is a
 * bug: the composer takes another message while a turn is thinking, so
 * somebody who asks for a graph on a board and then sends nine
 * follow-ups before it comes back would have the entry that turn was
 * about to be rendered against dropped out from under it — a Publish
 * button offered on a card and then refused when it is pressed. Nothing
 * a run can still reach may be dropped, and the only entries this drops
 * are ones nothing can reach a different answer through.
 *
 * What is left grows with the number of times somebody *walked between
 * boards* in one conversation, not with the number of messages they
 * sent: a whole afternoon's thread on one board is one entry. A thread
 * is put away by Clear or by the idle expiry, so even the pathological
 * reading of that — a person alternating between two boards every
 * message for a week — is bounded by a conversation's life.
 */
function onlyWhereItChanged(boards: AssistBoard[]): AssistBoard[] {
  return boards.filter((board, index) => index === 0 || board.pipelineId !== boards[index - 1]?.pipelineId);
}

/**
 * The board *this turn* was started from, or null when it was not
 * started from one.
 *
 * The entry standing at the run's initiating comment: the newest one
 * recorded at or before it. Ids are UUIDv7 and therefore sort by the
 * moment they were minted, so "at or before" is a string comparison
 * rather than a second pass over the comments.
 *
 * That is what makes a pending turn immune to where the person went
 * next. A follow-up sent from Settings appends a *later* entry, which
 * this lookup never reaches for an earlier turn — so a graph asked for
 * on the Delivery board is still rendered, and still published, against
 * the Delivery board, however many messages were sent from elsewhere
 * while that turn was thinking.
 *
 * At-or-before rather than exactly-at, because not every turn is started
 * by a message somebody typed: answering a question card starts one too,
 * and its initiating comment is the answer. Such a turn belongs to the
 * exchange it is part of, and the entry standing at that moment is that
 * exchange's board.
 *
 * Null for a run with no initiating comment at all. Every assist turn is
 * mention-driven and carries one, so this is the honest answer to a run
 * that came from somewhere else rather than a reason to guess.
 */
export function assistBoardFor(db: Db, conversation: Item, runId: Uuid | null): string | null {
  const initiationId = runId === null ? null : ((getRun(db, runId)?.initiationId as string | null) ?? null);
  if (initiationId === null) return null;

  return assistBoards(conversation).filter((board) => board.from <= initiationId).at(-1)?.pipelineId ?? null;
}

/**
 * When this thread last moved.
 *
 * The newest comment, or the conversation's own creation while nothing
 * has been said yet, or the moment somebody went back to it from the
 * list (`resumeAssistRoom`) — which is what makes the expiry below
 * "nothing has happened here for three days" rather than "this thread
 * was started three days ago".
 *
 * The difference is not academic. Age-since-creation cuts a conversation
 * somebody is in the middle of in half the moment it crosses the
 * threshold: you send a message, walk away, come back, and the
 * agent has lost the three exchanges you just had. Age-since-last-word
 * cannot do that, and still gives the pinned decision exactly what it
 * asked for — a week-old thread is not carried into a new question.
 *
 * Asked of many threads at once, with every thread's newest comment found
 * in one statement (EO-552) rather than by reading every comment of every
 * one of them to keep one number each.
 */
function lastSpokeAtEach(db: Db, conversations: readonly Item[]): Map<string, number> {
  const newest = lastCommentAtByItem(db, conversations.map((conversation) => conversation.id));
  return new Map(conversations.map((conversation) => [conversation.id as string, lastSpokeAmong(conversation, newest.get(conversation.id))]));
}

/** `lastSpokeAtEach` for one thread, given its newest comment's stamp — undefined while nothing has been said. */
function lastSpokeAmong(conversation: Item, newest: number | undefined): number {
  // Going back to a thread is the person picking it up, so it counts as
  // its last word: a week-old thread somebody just chose from the list is
  // not archived again the next time the room opens.
  return Math.max(conversation.createdAt, newest ?? 0, resumedAt(conversation));
}

/** Where `resumeAssistRoom` records when a thread was last gone back to, in the room's own object in `items.spec`. */
const RESUMED_FIELD = "resumedAt";

function resumedAt(conversation: Item): number {
  const stored = scopeOf(conversation)[RESUMED_FIELD];
  return typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
}

/** What opening the room did, so a caller can tell "resumed" from "started again". */
export interface OpenedAssistRoom {
  /** The conversation to talk in: the resumed one, or the fresh one. */
  conversation: Item;
  /** True when this is the thread that was already there. */
  resumed: boolean;
  /** The thread that had gone stale, as it stands now that it is archived. Absent when nothing expired. */
  expired?: Item;
  /**
   * How many chats this opening archived for being idle, the one on show
   * or not (EO-391). Absent when it archived none.
   *
   * For the caller that holds the push: a chat that was not on show can
   * be put away by an opening that answers with the very same chat, and
   * every list drawn from `assist:list` is still calling it open.
   */
  swept?: number;
}

/**
 * The chat to talk in on `projectId`: the one on show there, or a new
 * one.
 *
 * Creating on read, because this is opened by a person deciding to talk.
 * (The Architecture panel, retired in EO-526, was part of a screen and
 * rendered whenever anybody looked at it, so it created nothing until a
 * message was sent.)
 *
 * A stale chat is archived rather than deleted — invariant #3, and the
 * precedent every other catalogue in EO follows. Everything said in it,
 * and every run it hosted, stays exactly where it is; what archiving
 * buys is that the mention path can never dispatch against it again, so
 * a week-old thread cannot come back to life behind a new question.
 *
 * The expiry is an *idle* timeout, and it is each chat's own (EO-391):
 * every live chat is weighed on its own last word, the ones past the
 * window are archived, and the rest are not touched — so a chat spoken
 * in this morning is not put away because another went quiet last week.
 * When the one on show is among the stale, the room opens on a fresh
 * chat, as it did when there was one thread. `clearAssistRoom` below is
 * the same act asked for by hand.
 */
export function openAssistRoom(db: Db, projectId: Uuid | null): OpenedAssistRoom {
  const now = Date.now();
  const allowed = readAssistExpiryDays(db) * MS_PER_DAY;
  const shown = shownAssistConversation(db, projectId);
  // Every project's chats, not this one's: each goes quiet on its own
  // last word, whichever project the person is on (EO-765).
  const live = liveAssistConversations(db);
  const spoke = lastSpokeAtEach(db, live);
  const stale = live.filter((conversation) => now - spoke.get(conversation.id)! > allowed);
  // The ordinary opening writes nothing at all: this is read on every
  // push the room listens to.
  if (shown && stale.length === 0) return { conversation: shown, resumed: true };

  // Archived and replaced in one write. Halfway through — the old thread
  // archived and no new one created — is the one outcome nobody could
  // recover from at the keyboard: the panel would look as though the
  // conversation had simply vanished.
  return db.transaction(() => {
    for (const conversation of stale) setItemArchived(db, conversation.id, now);
    const swept = stale.length > 0 ? { swept: stale.length } : {};
    if (shown && !stale.some((conversation) => conversation.id === shown.id)) return { conversation: shown, resumed: true, ...swept };
    return {
      conversation: showEmptyAssistConversation(db, projectId),
      resumed: false,
      ...(shown ? { expired: getItem(db, shown.id) ?? shown } : {}),
      ...swept,
    };
  });
}

/**
 * New chat: an empty chat on show, and nothing put away (EO-391).
 *
 * What Clear is not. The chat that was on show stays live — a turn
 * running in it runs on and answers there, and a message waiting in it
 * is still answered — and it is one click in the list away. This is how
 * a quick unrelated question is asked without it landing on top of, and
 * replaying, a long working session.
 *
 * A chat nobody has said anything in, on the project the person is on,
 * is already what is being asked for, so that one is shown rather than a
 * second one made. An empty chat on another project is never it, and is
 * left as it is (EO-765).
 */
export function newAssistRoom(db: Db, projectId: Uuid | null): OpenedAssistRoom {
  const opened = openAssistRoom(db, projectId);
  if (isEmptyChatOn(db, opened.conversation, projectId)) return opened;
  return { conversation: db.transaction(() => showEmptyAssistConversation(db, projectId)), resumed: false };
}

/**
 * Clear: archives the chat on show and leaves an empty one (EO-193).
 *
 * The manual form of the expiry above, and archiving for the same
 * reason. Nothing is destroyed — the comments and the runs stay on the
 * item, which is now readable in the archive — which is what makes it
 * safe to do in one click with no dialog: there is nothing to confirm
 * because there is nothing to lose.
 *
 * Only the chat on show (EO-391), on the project the person is on
 * (EO-765). Every other live chat is left exactly as it is, a turn
 * running in it included.
 *
 * An empty thread is cleared by archiving nothing at all. Archiving one and
 * creating another leaves an `ASK-` row nobody ever said anything in and
 * burns a key on it, which is a graveyard rather than a record — and the
 * person gets exactly what they asked for either way: an empty thread.
 *
 * A live turn is *not* stopped here, and the caller is where that
 * happens: `roles/` does not hold the engine, and cancelling a run is
 * the engine's move. See `clearAssist` in `ipc/assistCommands.ts`.
 */
export function clearAssistRoom(db: Db, projectId: Uuid | null): OpenedAssistRoom {
  // The chat on show on the project the person is on (EO-765): another
  // project's is never the one Clear puts away.
  const shown = shownAssistConversation(db, projectId);
  if (!shown) return { conversation: db.transaction(() => showEmptyAssistConversation(db, projectId)), resumed: false };
  // Nothing to archive: it is already the empty thread Clear leaves.
  if (listCommentsForItem(db, shown.id).length === 0) return { conversation: show(db, shown), resumed: true };

  const now = Date.now();
  return db.transaction(() => {
    setItemArchived(db, shown.id, now);
    return {
      conversation: showEmptyAssistConversation(db, projectId),
      resumed: false,
      expired: getItem(db, shown.id) ?? shown,
    };
  });
}

/**
 * An empty chat on show, for a caller that has just removed the one that
 * was (`assist:remove`). Nothing is put away.
 */
export function freshAssistRoom(db: Db, projectId: Uuid | null): Item {
  return db.transaction(() => showEmptyAssistConversation(db, projectId));
}

/** One thread in the list a person goes back to (`assist:list`). */
export interface AssistThread {
  conversation: Item;
  /** The first thing the person said in it, cut to a line. */
  title: string;
  lastActivityAt: number;
  /** The chat every surface is showing on this project. At most one. */
  shown: boolean;
}

/** How long a thread's title is allowed to be before it is cut. */
const TITLE_LENGTH = 80;

/** What the live thread is called until somebody says something in it: the room's own name. */
export const EMPTY_ASSIST_TITLE = "Assistant";

/**
 * The chats on `projectId` (EO-765): every live one, in the order the
 * person keeps them in (`orderedAssistConversations`), and then every
 * put-away one somebody said something in, most recently active first.
 * Another project's chats, open or put away, are its own list's.
 *
 * The live ones are not sorted by activity (EO-438): opening a chat or a
 * message landing in one would move it, and nobody could rely on where
 * a chat was. `lastActivityAt` is still answered for each — it is what a
 * row says about itself, and what the idle expiry weighs.
 *
 * Archived ones included — the list is how a put-away thread is found
 * again. A live one is always in it, empty or not (EO-390): it is a chat
 * that is open, a row the rail draws either way, and what a person is
 * left in after New chat or after removing the one on show. Left out:
 *
 * - a put-away thread with no word from the person in it: one a stray
 *   open created is not a conversation anybody had;
 * - a thread on an archived project (EO-347): nothing there is
 *   dispatched, so going back to it would be talking to nobody.
 */
export function listAssistThreads(db: Db, projectId: Uuid | null): AssistThread[] {
  const shelved = itemsOnArchivedProjects(db);
  const shownId = shownAssistConversation(db, projectId)?.id;
  const place = new Map(orderedAssistConversations(db, projectId).map((item, index) => [item.id as string, index]));
  const conversations = onProject(
    db,
    listItemsOnStepIncludingArchived(db, ASSIST_STEP).filter((item) => item.stepId === ASSIST_STEP && !shelved.has(item.id)),
    projectId,
  );
  // Every thread's last word in one statement, and of each thread only
  // the two comments that can name it (EO-552): a put-away chat is a row
  // in a list, and reading all it ever said to draw that row was the
  // whole archive read on every refresh of the rail.
  const spoke = lastSpokeAtEach(db, conversations);
  return conversations
    .flatMap((conversation) => {
      const shown = conversation.id === shownId;
      const lastActivityAt = spoke.get(conversation.id)!;
      // The person's first word — or, in a chat EO opened with a brief of
      // its own (EO-533), that brief: it is what the chat is about, and
      // a put-away one stays findable before the person has said a thing.
      const opening = threadOpening(db, conversation.id);
      const opener = opening.first?.authorType === "engine" && opening.first.parentId === null ? opening.first : undefined;
      const first = opening.firstFromPerson ?? opener;
      if (!first) {
        return conversation.archivedAt === null ? [{ conversation, title: EMPTY_ASSIST_TITLE, lastActivityAt, shown }] : [];
      }
      const line = first.body.split("\n").find((candidate) => candidate.trim() !== "")?.trim() ?? "";
      const title = line === "" ? "Attachments" : line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
      return [{ conversation, title, lastActivityAt, shown }];
    })
    .sort((a, b) => {
      const [ours, theirs] = [place.get(a.conversation.id), place.get(b.conversation.id)];
      // Open before put away, the open ones by their place.
      if (ours !== undefined || theirs !== undefined) return (ours ?? Infinity) - (theirs ?? Infinity);
      return b.lastActivityAt - a.lastActivityAt || (a.conversation.id < b.conversation.id ? 1 : -1);
    });
}

/**
 * Shows another chat: a live one, or an earlier one made live again. It
 * is shown on its own project (EO-765): a caller showing a chat on a
 * project other than the one the window is on moves the window there.
 *
 * Navigation and nothing else (EO-391). The chat that was on show stays
 * live, with whatever is running or waiting in it, and no other chat is
 * touched. It used to be a swap — the live thread archived in the write
 * that un-archived the chosen one — because there was one live thread
 * (EO-193), and that is what made opening another chat interrupt the
 * work in the current one.
 *
 * Nothing is deleted (invariant #3). Refused, with the sentence the
 * person reads, for an id that is not an assistant thread and for one on
 * an archived project — nothing there is dispatched, so the thread would
 * take a message and never answer it. The chat already on show is handed
 * straight back.
 */
export function resumeAssistRoom(db: Db, conversationId: Uuid): OpenedAssistRoom | { problem: string } {
  const target = getItem(db, conversationId);
  if (!target || target.stepId !== ASSIST_STEP) return { problem: "That is not one of your conversations with the assistant." };
  const shelvedOn = archivedProjectOf(db, target.id);
  if (shelvedOn) return { problem: `That conversation is on ${shelvedOn.name}, which is archived. Restore the project to go back to it.` };
  if (target.archivedAt === null && shownAssistConversation(db, target.projectId)?.id === target.id) return { conversation: show(db, target), resumed: true };

  const now = Date.now();
  return db.transaction(() => {
    if (target.archivedAt !== null) {
      setItemArchived(db, target.id, null);
      // Back among the open chats, below the ones already there (EO-438):
      // it had no place, and taking one must not move a chat that has.
      arrangeAssistConversations(db, target.projectId, (ids) => [...ids.filter((id) => id !== target.id), target.id]);
    }
    // Read again for the spec: the row as it is now, not as the list saw it.
    const current = getItem(db, target.id)!;
    // Picking a chat up is its last word, live or not: one that sat
    // un-shown past the window is not archived by the opening that
    // follows this.
    const resumed = updateItem(db, current.id, { spec: { ...(current.spec ?? {}), [SPEC_KEY]: { ...scopeOf(current), [RESUMED_FIELD]: now } } });
    return { conversation: show(db, resumed ?? current), resumed: true };
  });
}

// ── What the agent said ───────────────────────────────────────

/**
 * Is this comment a live artefact from an `assist` turn? A card written during an assist run.
 *
 * `thread`, where the caller is drawing a whole chat, is what it has
 * already read (EO-552): the run is then fetched once for every card on it.
 */
export function isAssistProposal(db: Db, comment: Comment, thread?: ConversationThread): boolean {
  if (comment.kind !== PROPOSAL_KIND || comment.runId === null) return false;
  return runOf(db, comment.runId, thread)?.action === ASSIST_ACTION;
}

/**
 * Posts what an `assist` run came back with.
 *
 * Mentions nobody, and that is deliberate and load-bearing: a mention
 * would put every message from a help thread in the Inbox and light the
 * `!` marker on an item nobody can open. The person is
 * already looking at the panel.
 *
 * The order is load-bearing and not cosmetic: the message, then the
 * questions, then the proposals in the order the turn gave them, then
 * the draft last. Both kinds of card are `proposal` comments on the same
 * run, so their order is the only thing that says which is which —
 * `readAssistDraft` reads the last one and a proposal is found by its
 * index among the rest.
 *
 * A turn with `modules` and no draft ends in a card for each module
 * instead (EO-398), in the order the turn listed them — which is the
 * same rule read from the other end: `assistModuleCardSlug` finds a
 * module card by its place among the last comments of its run.
 *
 * A turn with a `change` ends in the card for that change (EO-418), and
 * writes nothing to the catalog: that card saves when a person presses
 * Apply, never when it is posted.
 *
 * A turn with a `card` ends in that card (EO-521) — an export, an
 * import, a delete or a discard for the person to press — and does
 * nothing else: see `assistCards.ts`.
 */
export function postAssistReply(db: Db, conversation: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): PostedAssistReply {
  const parsed = AssistOutputSchema.safeParse(parsedResult);
  if (!parsed.success) return { modulesSaved: false }; // already validated upstream; nothing to post if it somehow was not
  const initiationId = getRun(db, runId)?.initiationId as Uuid | null;

  postComment(db, {
    itemId: conversation.id,
    runId,
    author: { type: "agent", agentId },
    kind: "note",
    body: parsed.data.message,
    // Nobody, however the message is written — an agent typing "@user"
    // into its own prose must not become an open human mention.
    parseBodyMentions: false,
    // Resolve only the message this run actually saw. A follow-up sent
    // while the provider was working stays open and becomes the next
    // turn instead of being silently marked answered here.
    parentId: initiationId,
  });

  // One comment per question, so each is answered by a comment filed
  // under it — `postDiscussionQuestions`, which a scenario chat posts
  // its questions through too.
  postDiscussionQuestions(db, conversation, agentId, runId, parsed.data.questions);

  for (const proposal of parsed.data.proposals) {
    const rendered = renderProposal(db, conversation, proposal);
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      // An unbuildable proposal is posted as a rejection with nothing
      // behind it: there is nothing to approve, only something to redo.
      kind: rendered.ok ? PROPOSAL_KIND : "rejection",
      body: rendered.ok ? rendered.body : rendered.reason,
      parentId: initiationId,
      parseBodyMentions: false,
    });
  }

  // Something only a person may do (EO-521): a card whose button does it,
  // and nothing done. Last, and on its own — the schema refuses a card
  // beside a draft, modules, a change or work proposals — so it is the
  // last thing its run said, which is where `assistCardOf` reads it. The
  // one card that may come beside drafts, keeping one's own pipeline
  // (EO-534), is posted after them, below.
  const drafts = draftsOf(parsed.data);
  if (parsed.data.card && drafts.length === 0) {
    postAssistCard(db, conversation, agentId, runId, initiationId, parsed.data.card);
    return { modulesSaved: false };
  }

  // A change to a module that exists (EO-418): a card, and nothing saved.
  // Last, like the draft it never arrives beside — the schema refuses a
  // change with a `draft` or with `modules` — so the work proposals above
  // keep their places in the order `proposalOfComment` reads them by.
  if (parsed.data.change) {
    postModuleChange(db, conversation, agentId, runId, initiationId, parsed.data.change);
    return { modulesSaved: false };
  }

  if (drafts.length === 0) {
    return { modulesSaved: postProposedModules(db, conversation, agentId, runId, initiationId, parsed.data.modules ?? []) };
  }
  // One card per draft, the recommended one first and then each
  // alternative (EO-534), every one judged on its own: an alternative the
  // validator refuses is a rejection in its place, and the others are
  // still offered.
  let modulesSaved = false;
  const draftCardIds: Uuid[] = [];
  for (const [index, draft] of drafts.entries()) {
    const drawn = renderAssistDraft(db, conversation, parsed.data, draft, runId);
    // The modules the draft needs, saved unapproved with their tests now
    // that the card is going to be offered (EO-381) — and only then: a
    // draft refused above leaves nothing behind in the catalog. Saved here
    // rather than when Publish is pressed because approving them comes
    // first, and a person cannot approve a module that does not exist yet.
    // Only ever the first draft's: the schema refuses modules beside
    // alternatives.
    const saved = drawn.ok && index === 0 ? saveProposedModules(db, parsed.data.modules ?? []) : { refusal: null, saved: 0 };
    const rendered: RenderedDraft = saved.refusal === null ? drawn : { ok: false, reason: saved.refusal };
    const card = postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      // A draft that cannot be published is posted as a *rejection
      // carrying the reason* rather than as something with a Publish
      // button on it. Invariant #8 — nothing is dropped silently — and the
      // reason is what lets the next turn fix it instead of proposing the
      // same graph again.
      kind: rendered.ok ? PROPOSAL_KIND : "rejection",
      body: rendered.ok ? rendered.body : rendered.reason,
      parentId: initiationId,
      parseBodyMentions: false,
    });
    if (saved.saved > 0) modulesSaved = true;
    if (rendered.ok) draftCardIds.push(card.id as Uuid);
  }
  // Keeping one's own pipeline, beside the drafts that would resolve a
  // held template update another way (EO-534): last, where
  // `assistCardOf` reads a card.
  if (parsed.data.card) postAssistCard(db, conversation, agentId, runId, initiationId, parsed.data.card);
  return { modulesSaved, draftCardIds };
}

/** The drafts a turn proposed, in the order they are posted: `draft`, then each of its `alternatives` (EO-534). */
export function draftsOf(output: AssistOutput): AssistDraft[] {
  return output.draft === undefined ? [] : [output.draft, ...(output.alternatives ?? [])];
}

/**
 * Posts the modules a turn proposed on their own, one card each (EO-398).
 * True when any was written to the catalog.
 *
 * A module without a draft is a proposal like any other: saved
 * unapproved with its tests, under exactly the rules a draft's modules
 * are — `moduleCollision` first, then `saveProposedModules`, all or
 * none — and then offered. What is posted is a card per module rather
 * than one for the lot, because each is approved by its own button.
 *
 * The card's body names the module in prose and nothing more. It is what
 * a later turn reads back; the chat layout draws the card from the
 * catalog instead, so that what it says about approval is true at the
 * moment it is read rather than at the moment this was written.
 *
 * Refused, it is one rejection carrying the reason and nothing is saved
 * (invariant #8) — the reason is what lets the next turn fix the module
 * instead of proposing the same one again.
 */
function postProposedModules(
  db: Db,
  conversation: Item,
  agentId: Uuid,
  runId: Uuid,
  initiationId: Uuid | null,
  modules: readonly ProposedModule[],
): boolean {
  if (modules.length === 0) return false;

  const collision = moduleCollision(db, modules);
  const saved = collision === null ? saveProposedModules(db, modules, "module") : { refusal: standaloneCollision(collision), saved: 0 };
  if (saved.refusal !== null) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind: "rejection",
      body: saved.refusal,
      parentId: initiationId,
      parseBodyMentions: false,
    });
    return false;
  }

  for (const module of modules) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind: PROPOSAL_KIND,
      body: moduleCardBody(module),
      parentId: initiationId,
      parseBodyMentions: false,
    });
  }
  return saved.saved > 0;
}

// ── A change to a module that exists (EO-418) ─────────────────

/** The room's record of its change cards, by card id, or an empty one. */
function moduleChangesOf(conversation: Item): Record<string, unknown> {
  const recorded = scopeOf(conversation)[MODULE_CHANGES_FIELD];
  return recorded && typeof recorded === "object" && !Array.isArray(recorded) ? (recorded as Record<string, unknown>) : {};
}

/** Which module a recorded change card is for, or null when nothing usable is recorded under that id. */
function recordedChange(conversation: Item, commentId: string): { moduleId: string; base: unknown } | null {
  const entry = moduleChangesOf(conversation)[commentId];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const moduleId = (entry as Record<string, unknown>)["moduleId"];
  return typeof moduleId === "string" && moduleId !== "" ? { moduleId, base: entry } : null;
}

/**
 * Posts the card for a change to a module the catalog already holds.
 *
 * The route `modules` cannot be: that one saves when the card is posted,
 * which is why it is refused over a module somebody approved, wrote or
 * imported. This one saves nothing. The card is `drawModuleChange`'s —
 * the summary, a diff of the code and of the manifest against what is
 * saved at this moment, the test cases it adds, replaces or removes, and
 * what Apply will do — and what it was drawn against is recorded under
 * the card's id, so Apply can refuse a module that has moved on since,
 * or a case it removes that has been edited or deleted since.
 *
 * So any module in the catalog may be changed this way: approved or not,
 * whoever wrote it. The person reads the diff and presses Apply, and
 * that is the gate.
 *
 * A change that cannot be offered — the catalog holds no such module,
 * the manifest is not one, it removes a case the module does not hold or
 * would leave it with none, or it is the module as it already is — is
 * one rejection carrying the reason, with no Apply (invariant #8).
 */
function postModuleChange(db: Db, conversation: Item, agentId: Uuid, runId: Uuid, initiationId: Uuid | null, change: AssistModuleChange): void {
  const drawn = drawModuleChange(db, getModule(db, change.moduleId), change, { tests: change.tests, removeTests: change.removeTests, requireCases: true });
  if (!drawn.ok) {
    postComment(db, {
      itemId: conversation.id,
      runId,
      author: { type: "agent", agentId },
      kind: "rejection",
      body: drawn.reason,
      parentId: initiationId,
      parseBodyMentions: false,
    });
    return;
  }

  const id = uuidv7();
  const current = getItem(db, conversation.id) ?? conversation;
  updateItem(db, current.id, {
    spec: {
      ...(current.spec ?? {}),
      [SPEC_KEY]: { ...scopeOf(current), [MODULE_CHANGES_FIELD]: { ...moduleChangesOf(current), [id]: { moduleId: change.moduleId, ...drawn.base } } },
    },
  });

  postComment(db, {
    id,
    itemId: conversation.id,
    runId,
    author: { type: "agent", agentId },
    kind: PROPOSAL_KIND,
    body: drawn.body,
    parentId: initiationId,
    parseBodyMentions: false,
  });
}

/** The `eo_admin` tools that write one test case, which the help chat leaves to the card on an approved module. */
const MODULE_TEST_WRITES: ReadonlySet<string> = new Set(["module_test_save", "module_test_delete"]);

/**
 * Why `eo_admin` refuses this test-case write, or null to let it through
 * (EO-499).
 *
 * Any change to an approved module's test cases withdraws its approval
 * (EO-498), and in the help chat such a change is the person's to apply,
 * on a card that says so before they do — the same card a change to the
 * code is. `module_test_save` and `module_test_delete` write at once, so
 * on an approved module they are refused, before anything is written,
 * with the route that is open: return the change as `change`.
 *
 * Stated about the module rather than the chat, for the reason
 * `scenarioModuleWriteRefusal` gives: the admin host cannot tell which
 * run a call comes from. A scenario chat's job is to write and run a
 * case, so while a scenario turn about this module is running these
 * calls go through (that chat tells the person itself). A module that is
 * not approved has no approval to lose, and is written as before.
 *
 * Composed with `scenarioModuleWriteRefusal` in the admin host's
 * `refuseCall`; the two refuse different tools.
 */
export function approvedModuleTestWriteRefusal(db: Db, tool: string, args: unknown): string | null {
  if (!MODULE_TEST_WRITES.has(tool)) return null;
  const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

  // Save names its module; delete names only the case, whose module it is.
  let moduleId: unknown = given["moduleId"];
  if (tool === "module_test_delete") {
    const caseId = given["id"];
    moduleId = typeof caseId === "string" && caseId !== "" ? getModuleTest(db, caseId)?.moduleId : undefined;
  }
  if (typeof moduleId !== "string" || moduleId === "") return null;

  const module = getModule(db, moduleId);
  if (!module || module.archivedAt !== null || module.approvedAt === null) return null;
  // Running, not merely queued: a queued turn has made no call yet.
  if (scenarioTurnOn(db, module.id, "running")) return null;

  return (
    `EO refused ${tool}: ${module.name} is approved, and any change to an approved module's test cases withdraws its approval, ` +
    "so in this chat it is made on a card the person applies, not written directly. Nothing has been written. " +
    `Return the change as \`change\` instead — \`moduleId\` "${module.id}", its code exactly as it is saved, the cases to add or replace in ` +
    "`tests` and the ids of the cases to remove in `removeTests` — and say in your message that applying it withdraws the module's approval " +
    "and that the card is where it is applied and approved again."
  );
}

/** The change a card proposed, as its run wrote it, or null when this comment is not a change card. */
function assistChangeOf(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): { change: AssistModuleChange; base: unknown } | null {
  if (!isAssistProposal(db, comment, thread)) return null;
  const recorded = recordedChange(conversation, comment.id);
  if (recorded === null) return null;

  const change = outputOf(db, comment.runId, AssistOutputSchema, thread)?.change ?? null;
  // The card's own module, asked rather than assumed: the record and the
  // run were written together, and a card whose two halves disagree is
  // not one to put a button on.
  if (change === null || change.moduleId !== recorded.moduleId) return null;
  return { change, base: recorded.base };
}

/** Is this comment the card for a change to an existing module? */
export function isAssistModuleChangeCard(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): boolean {
  return assistChangeOf(db, conversation, comment, thread) !== null;
}

/**
 * What a change card says about itself to the panel drawing it, or null
 * for a comment that is not one — see `DiscussionMessage.moduleChange`.
 *
 * `applied` is the approval filed under the card, which is what Apply
 * leaves there. `describesSaved` is whether the catalog's module still
 * holds the code and manifest this card saved: the card offers Approve
 * once applied, Approve approves whatever the catalog holds, and a module
 * edited again since is one this card never showed.
 */
export function assistModuleChangeCard(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): ModuleChangeCard | null {
  const found = assistChangeOf(db, conversation, comment, thread);
  if (found === null) return null;
  const { change } = found;

  const applied = (thread ?? threadOf(db, conversation.id)).under(comment.id).some((entry) => entry.kind === "approval");
  const module = getModule(db, change.moduleId);
  const describesSaved =
    module !== undefined &&
    module.archivedAt === null &&
    module.code === change.code &&
    (change.manifest === null || sameManifest(module.manifest, change.manifest));
  return { moduleId: change.moduleId, applied, describesSaved };
}

/**
 * Saves what a change card proposed — the person having pressed Apply.
 *
 * Re-read from the run rather than from anything a panel kept, so what
 * is saved is what the card showed. `applyModuleChange` does the rest,
 * exactly as it does for the scenario chat: refused when the module's
 * code or manifest is no longer what the card was drawn against, and
 * otherwise one transaction — the card's code and manifest onto that
 * module, the cases it removes deleted, and the test cases it listed
 * matched by description, its slug and its source left as they were.
 *
 * Whether this card may still be applied at all — newest wins, not yet
 * applied — is the caller's, through `approvableIds`.
 */
export function applyAssistModuleChange(db: Db, conversation: Item, commentId: Uuid): AppliedModuleChange {
  const comment = listCommentsForItem(db, conversation.id).find((entry) => entry.id === commentId);
  const found = comment ? assistChangeOf(db, conversation, comment) : null;
  if (found === null) return { ok: false, reason: "That card is not a change to a module." };

  const module = getModule(db, found.change.moduleId);
  if (!module) return { ok: false, reason: "That module no longer exists, so there is nothing to apply this to." };
  if (module.archivedAt !== null) return { ok: false, reason: `${module.name} has been deleted, so there is nothing to apply this to.` };

  return applyModuleChange(db, module, found.change, found.base, { tests: found.change.tests, removeTests: found.change.removeTests, requireCases: true });
}

/**
 * `moduleCollision`'s reason, for a module that came without a draft.
 *
 * The rules are that function's and are not restated; its sentences were
 * written for a draft card, so they speak of a draft and of a step's
 * `entryAction`. A module on its own has neither, and an agent told to
 * "propose the draft again" when it proposed none would go and write
 * one. So the refusal opens by saying what happened here and closes by
 * saying which half of the advice applies.
 */
function standaloneCollision(collision: string): string {
  return [
    "No module was saved.",
    "",
    collision,
    "",
    "This module was proposed on its own, with no draft: where that says the draft is not offered, it is this module that is not, " +
      "and there is no step to rename anything in. To offer a different module, give it another slug and propose it again in `modules`.",
  ].join("\n");
}

/**
 * What a module card says in prose (EO-398).
 *
 * The same facts `renderDraft` gives a draft's module, for the same
 * reason — what it needs is the part a person can judge without reading
 * JavaScript — and then where it stands: saved, and run by nothing until
 * somebody approves it.
 */
function moduleCardBody(module: ProposedModule): string {
  const needs = [...module.manifest.needs.bin, ...module.manifest.needs.env, ...(module.manifest.needs.network ? ["network"] : [])];
  return [
    `**New module** ${module.name} (\`${module.slug}\`) — ${module.description}`,
    "",
    `Needs: ${needs.length > 0 ? needs.join(", ") : "nothing outside the worktree"} · returns ${module.manifest.results.join(", ")}`,
    "",
    `Why a module: ${module.why}`,
    "",
    `Tests: ${module.tests.map((test) => test.description).join("; ")}`,
    "",
    "Saved, and not approved: no step runs it until a person has read its code and approved it, which runs these tests. " +
      "It is approved on its card in the chat, or in Settings → Modules.",
  ].join("\n");
}

/**
 * What posting a reply did besides post it (EO-381).
 *
 * `modulesSaved` is true when the card's modules were written to the
 * catalog. The caller announces that — `roles/` holds no push — because
 * a person already on Settings → Modules is looking at a cached list,
 * and the module they are being asked to approve has to appear in it.
 */
export interface PostedAssistReply {
  modulesSaved: boolean;
  /** The draft cards the reply posted, in order — a draft refused in its place is no card (EO-587). */
  draftCardIds?: Uuid[];
}

type RenderedDraft = { ok: true; body: string } | { ok: false; reason: string };

/**
 * The pipeline id a draft for a pipeline that does not exist yet is
 * judged against (EO-381).
 *
 * No row has it, which is the point: every read keyed on it — the steps
 * it holds, what hands work to it, whether a webhook reaches it — answers
 * "nothing", which is exactly what a pipeline nobody has created holds.
 * It is never written: `assist:publishNew` creates the pipeline first and
 * stamps the real id on the graph before saving it.
 */
const NOT_YET_CREATED = "";

/**
 * Which pipeline a draft raised here is about (EO-381).
 *
 * `existing` names a pipeline that is there; `new` names one Publish
 * would create; `none` is a draft that names nothing and was not asked
 * for from a board, which has nothing to be published against.
 */
type DraftDestination = { kind: "existing"; pipelineId: string } | { kind: "new"; name: string } | { kind: "none" };

/**
 * Where a draft goes: the pipeline it names, or else the board its turn
 * was started from.
 *
 * The draft's own `target` first, because it is the one thing in the
 * room that says which pipeline a graph is for rather than where the
 * person happened to be standing (EO-381). A pipeline the person is not
 * looking at can be changed from the chat, and one that does not exist
 * yet can be proposed. With no target the answer is `assistBoardFor`,
 * exactly as before the field existed.
 *
 * A named pipeline is checked to be there, and not archived, for
 * `recordAssistBoard`'s reason: an id an agent wrote is a claim, and
 * invariant #5 says EO checks one it can check. Refused with a sentence
 * rather than answered `none`, because "you named a pipeline that is not
 * there" and "you named none" have different fixes.
 */
function draftDestination(db: Db, conversation: Item, runId: Uuid | null, draft: AssistDraft): DraftDestination | { kind: "refused"; reason: string } {
  const target = draft.target;
  if (target?.newPipeline !== undefined) return { kind: "new", name: target.newPipeline };
  if (target?.pipelineId !== undefined) {
    const named = getPipeline(db, target.pipelineId);
    if (!named || named.archivedAt !== null) {
      return {
        kind: "refused",
        reason:
          `That graph names pipeline \`${target.pipelineId}\` as its target, and there is ${named ? "no live pipeline by that id — it has been deleted" : "no pipeline by that id"}. ` +
          "Read the pipelines that exist with `pipelines_list`, then propose the graph again naming one of them by its id — or name a new one with `newPipeline`.",
      };
    }
    return { kind: "existing", pipelineId: named.id };
  }
  const board = assistBoardFor(db, conversation, runId);
  return board === null ? { kind: "none" } : { kind: "existing", pipelineId: board };
}

/** The id a destination is judged against: its own, or the placeholder no row holds. */
function judgedAgainst(destination: { kind: "existing"; pipelineId: string } | { kind: "new"; name: string }): string {
  return destination.kind === "existing" ? destination.pipelineId : NOT_YET_CREATED;
}

/**
 * A live pipeline the project can see that already has this name.
 *
 * `pipeline_manage`'s rule, applied here for its reason: work is placed
 * on a pipeline by name, matched trimmed and case-insensitively, so two
 * of the same name is work that could land on either. "The project can
 * see" is `listPipelines`' own: its own pipelines (EO-766) — and every
 * pipeline, when there is no project at all.
 * Archived ones hold no name, as there.
 */
function pipelineNamed(db: Db, projectId: Uuid | null, name: string): { id: string; name: string } | undefined {
  const wanted = name.trim().toLowerCase();
  return listPipelines(db, projectId ?? undefined).find((pipeline) => pipeline.name.trim().toLowerCase() === wanted);
}

/**
 * What stops a draft raised here, beyond what `validateDraft` judges
 * (EO-381). Null when nothing does.
 *
 * Each a refusal rather than a quiet correction, because each is the
 * agent asking for something it cannot have and the card is where it
 * learns that (invariant #8):
 *
 *   * a new pipeline whose name the project already has, or a rename to
 *     one (EO-520) — refused as `pipeline_manage` refuses it;
 *   * a new pipeline whose step ids are already taken. A step id is a
 *     key across every pipeline, so publishing one would fail on the
 *     database rather than say anything a person could act on;
 *   * a restore of a version the pipeline does not keep (EO-520), or of
 *     any version at all for a pipeline that does not exist yet;
 *   * a step pointed at a workspace this project does not have (EO-520),
 *     which `pipeline:save` refuses too — the card should not offer what
 *     the button will refuse;
 *   * "Needs a reason" on a branch out of a step nobody decides on
 *     (EO-520): only a person's step offers its results to a person;
 *   * inputs that a step's module or builtin does not declare (EO-516),
 *     or inputs on a step that runs neither. Nothing would read them, and
 *     dropping them on the way to Publish would leave a step that looks
 *     configured and is not.
 *
 * A time limit, inputs or keep checking on a step that already exists
 * are not refused any more (EO-520): the pipeline editor has gone
 * (EO-525), and the help chat is where they are tuned. Each is shown on the card as
 * old → new, and a time limit is judged against the run timeout by
 * `validateDraft`, which names the step.
 *
 * Asked when the card is drawn and again when it is published, since
 * somebody can create a pipeline of that name in between.
 */
function draftRefusal(
  db: Db,
  conversation: Item,
  destination: { kind: "existing"; pipelineId: string } | { kind: "new"; name: string },
  draft: AssistDraft,
  modules: readonly ProposedModule[],
  /** Asked of a card already posted, rather than of a reply about to be (EO-399). See `moduleCollision`. */
  posted = false,
): string | null {
  if (destination.kind === "new") {
    const clash = pipelineNamed(db, chatPipelineProjectId(db, conversation.projectId), destination.name);
    if (clash) {
      return (
        `Nothing would be created: this project already has a pipeline called "${clash.name}" (id: ${clash.id}), and work is placed on a ` +
        `pipeline by name. Pick another name for \`newPipeline\`, or name that pipeline with \`pipelineId: "${clash.id}"\` to change it.`
      );
    }
    const taken = draft.steps.filter((step) => getStep(db, step.id) !== undefined).map((step) => `\`${step.id}\``);
    if (taken.length > 0) {
      return (
        `A new pipeline cannot reuse step ids another pipeline already has: ${taken.join(", ")}. A step id is unique across every ` +
        "pipeline in EO, so mint fresh ones for this graph — `release_build`, say, rather than `build` — and propose it again."
      );
    }
  }

  const collision = moduleCollision(db, modules, posted);
  if (collision !== null) return collision;

  if (destination.kind === "existing" && draft.name !== undefined) {
    const pipeline = getPipeline(db, destination.pipelineId);
    const clash = pipeline && draft.name !== pipeline.name ? pipelineNamed(db, pipeline.projectId ?? chatPipelineProjectId(db, conversation.projectId), draft.name) : undefined;
    if (clash && clash.id !== destination.pipelineId) {
      return (
        `This draft renames the pipeline to "${draft.name}", and this project already has a pipeline called "${clash.name}" (id: ${clash.id}). ` +
        "Work is placed on a pipeline by name, so two of the same name make that ambiguous. Pick another `name`, or leave it out to keep the name it has, and propose the graph again."
      );
    }
  }

  if (draft.restoredFrom !== undefined) {
    const refused = restoreRefusal(db, destination, draft.restoredFrom);
    if (refused !== null) return refused;
  }

  const workspace = workspaceRefusal(db, conversation, destination, draft);
  if (workspace !== null) return workspace;

  const stepsById = new Map(draft.steps.map((step) => [step.id, step]));
  const notDecided = draft.routes.filter((route) => route.requiresComment !== undefined && stepsById.get(route.fromStepId)?.type !== "user");
  if (notDecided.length > 0) {
    const names = [...new Set(notDecided.map((route) => stepsById.get(route.fromStepId)?.name ?? route.fromStepId))];
    return (
      `${names.map((name) => `**${name}**`).join(", ")} ${names.length === 1 ? "is not a person's step" : "are not people's steps"}, so a branch out of ${names.length === 1 ? "it" : "them"} ` +
      "has nobody to ask for a reason: `requiresComment` (\"Needs a reason\") is set only on a branch out of a `user` step. Leave it off the others and propose the graph again."
    );
  }

  const catalog = moduleCatalogFor(db, modules);
  for (const step of draft.steps) {
    if (step.inputs === undefined || Object.keys(step.inputs).length === 0) continue;
    if (step.type === "builtin") {
      // The registry's declaration (EO-507), held as a module's manifest
      // is: a value for a name the function does not declare is one its
      // runner never reads. A function nothing declares is
      // `validateDraft`'s to name.
      const declares = builtinInputs(registry, step.entryAction);
      if (declares === null) continue;
      const undeclared = Object.keys(step.inputs).filter((name) => !(name in declares));
      if (undeclared.length > 0) {
        const declared = Object.keys(declares);
        return (
          `**${step.name}** sets ${undeclared.map((name) => `\`${name}\``).join(", ")}, which \`${step.entryAction}\` does not declare, so nothing would read ` +
          `${undeclared.length === 1 ? "it" : "them"}. It declares ${declared.length === 0 ? "no inputs at all" : declared.map((name) => `\`${name}\``).join(", ")}. ` +
          "Set only what the function declares, and propose the graph again."
        );
      }
      continue;
    }
    if (step.type !== "module") {
      return `**${step.name}** sets \`inputs\`, which only a module or builtin step has: inputs are what a module declares in its manifest, or a builtin in EO's registry. Leave them off and propose the graph again.`;
    }
    const module = step.entryAction === null ? undefined : catalog.get(step.entryAction);
    if (!module) continue; // `validateDraft` names a module step that runs nothing it knows
    const undeclared = Object.keys(step.inputs).filter((name) => !(name in module.manifest.inputs));
    if (undeclared.length > 0) {
      const declared = Object.keys(module.manifest.inputs);
      return (
        `**${step.name}** sets ${undeclared.map((name) => `\`${name}\``).join(", ")}, which "${module.name}" does not declare, so nothing would read ` +
        `${undeclared.length === 1 ? "it" : "them"}. It declares ${declared.length === 0 ? "no inputs at all" : declared.map((name) => `\`${name}\``).join(", ")}. ` +
        "Set only what the module declares, or declare the input in the module's manifest, and propose the graph again."
      );
    }
  }
  return null;
}

/**
 * Why a draft cannot restore version `number` (EO-520), or null where it
 * can.
 *
 * Asked when the card is drawn as well as at Publish, where
 * `savePipeline` refuses a version it no longer keeps: the card should
 * not say "restores v3" about a version that is not there. The owners
 * themselves are read at Publish, from the version's own document —
 * nothing the draft says about a person or a group is ever believed.
 */
function restoreRefusal(db: Db, destination: { kind: "existing"; pipelineId: string } | { kind: "new"; name: string }, number: number): string | null {
  if (destination.kind === "new") {
    return "This draft restores a version of a pipeline that does not exist yet, and a new pipeline has no versions. Leave `restoredFrom` out, or name the pipeline it is a version of in `target`.";
  }
  const version = pipelineVersionByNumber(db, destination.pipelineId, number);
  if (version === undefined || versionSnapshot(db, version.id) === undefined) {
    return (
      `This draft restores v${number}, which this pipeline ${version === undefined ? "has never had" : "no longer keeps"}, so who its person steps waited on cannot be put back. ` +
      "Read the versions it keeps with `pipeline_versions`, and propose the graph of one of those."
    );
  }
  return null;
}

/**
 * A step a draft points at a workspace the pipeline's project does not
 * hold (EO-520), as a sentence naming the step. Null when none is.
 *
 * `pipeline:save` refuses the same graph (`foreignWorkspaceProblems`), and
 * judges it against the same project: the pipeline's own, or the one in
 * use where the pipeline has none — and, for a pipeline Publish creates,
 * the conversation's, which is the project it is created on.
 */
function workspaceRefusal(
  db: Db,
  conversation: Item,
  destination: { kind: "existing"; pipelineId: string } | { kind: "new"; name: string },
  draft: AssistDraft,
): string | null {
  const named = draft.steps.filter((step) => step.workspaceId !== undefined && step.workspaceId !== ITEM_WORKSPACE && step.workspaceId !== NO_WORKSPACE);
  if (named.length === 0) return null;
  const projectId = destination.kind === "existing" ? (getPipeline(db, destination.pipelineId)?.projectId ?? activeProjectId(db)) : chatPipelineProjectId(db, conversation.projectId);
  const held = projectId === null ? [] : projectWorkspaceList(db, projectId);
  const stranger = named.find((step) => !held.some((workspace) => workspace.id === step.workspaceId));
  if (stranger === undefined) return null;
  const known = getWorkspace(db, stranger.workspaceId as Uuid);
  return (
    `**${stranger.name}** is set to work on \`${stranger.workspaceId}\`, ` +
    (known ? `which belongs to another project — work on this pipeline would happen on a disk nobody looking at it can see. ` : "which is not a workspace EO has. ") +
    `Set \`workspaceId\` to one of this project's workspaces from \`workspace_list\`, \`"${NO_WORKSPACE}"\` for no disk, or \`"${ITEM_WORKSPACE}"\` for the item's own, and propose the graph again.`
  );
}

/**
 * A proposed module whose slug the catalog already holds as something
 * else (EO-381). Null when none does.
 *
 * The card describes the module the turn proposed — its needs, its
 * results, its tests — and a step names it by slug, which Publish
 * resolves to whatever the catalog holds under that slug. If that is
 * different code, the person would read one module, find the other
 * already approved, and publish a step running code no card described.
 * So the three have to be one module: what is displayed, what is
 * approved, and what runs.
 *
 * The same module proposed again — code, manifest, and no test case the
 * catalog's does not already have, or has had only since it was last
 * approved — is not a collision, and is what makes a second draft of the same pipeline
 * ordinary. Anything else is refused, including a slug a deleted module
 * still holds, which the catalog would not let be saved again.
 *
 * One exception (EO-401): a module `isReplaceable` — unapproved, written
 * by the assistant, not deleted — is not compared at all. The proposal is
 * written over it by `saveProposedModules`, so the three are one module
 * again by the time the card is offered.
 *
 * Asked again at Publish, with the catalog as it stands then: a module
 * edited after the card was drawn is no longer the module on the card.
 *
 * `posted` is that second asking, of a card that was offered. One thing
 * reads differently there (EO-399): a slug a deleted module holds. Before
 * the card is posted that is a slug the proposal cannot be saved under,
 * and the reply is refused. Afterwards it can only be the card's own
 * module, deleted since — the refusal above is why no card exists for any
 * other — and that is not a collision but a module the draft is waiting
 * on and will not get: `draftWaitingModules` reports it as gone, and the
 * card says so in its own words rather than in a sentence about slugs
 * addressed to an agent.
 */
function moduleCollision(db: Db, modules: readonly ProposedModule[], posted = false): string | null {
  for (const proposed of modules) {
    const held = getModuleBySlug(db, proposed.slug);
    if (!held) continue;
    if (held.archivedAt !== null) {
      if (posted) continue;
      return (
        `"${proposed.name}" is proposed under the slug \`${proposed.slug}\`, which a deleted module ("${held.name}") still holds, so it cannot ` +
        "be saved under it. Give the module another slug, use that slug in the step's `entryAction`, and propose the draft again."
      );
    }
    // A module nobody has approved, that the assistant wrote, is replaced
    // by the proposal rather than compared with it (EO-401) — and only
    // before the card is posted: asked of a card already offered, a
    // module that no longer matches it is a card describing something
    // the catalog does not hold, exactly as before.
    if (!posted && isReplaceable(held)) continue;
    if (held.code !== proposed.code || canonical(held.manifest) !== canonical(proposed.manifest)) {
      return (
        `"${proposed.name}" is proposed under the slug \`${proposed.slug}\`, which the module "${held.name}" (id: ${held.id}) already holds ` +
        "with different code or a different manifest. Publishing would run the catalog's module rather than the one this card " +
        "describes, so the draft is not offered. To use the module that exists, leave it out of `modules` and name it in the step's " +
        `\`entryAction\` by its id; to propose a different one, give it another slug. If it should replace "${held.name}", that is a ` +
        "change to a module that exists, and it has its own route: in a reply of its own, with no `draft` and no `modules`, return " +
        `\`change\` with \`moduleId\` "${held.id}", the module's whole \`code\` and its whole \`manifest\`. The person sees it as a diff and ` +
        "applies it on the card."
      );
    }
    // The same code is not yet the same module: a module is approved by
    // running its tests (EO-353), so the cases on the card are part of
    // what the person is told they are agreeing to. One the catalog's
    // module does not have was never run for its approval — and writing
    // it in beside an approval already given would leave a module
    // approved against cases nobody ran. So the card's cases all have to
    // be there already, word for word.
    const keyOf = (test: { description: string; source: string }) => canonical([test.description, test.source]);
    // When each case the module has was last written. The newest, where
    // two say the same thing: the question below is whether an approval
    // could have missed one.
    const has = new Map<string, number>();
    for (const test of listModuleTests(db, held.id)) has.set(keyOf(test), Math.max(has.get(keyOf(test)) ?? 0, test.updatedAt));
    const absent = proposed.tests.filter((test) => !has.has(keyOf(test)));
    if (absent.length > 0) {
      return (
        `"${proposed.name}" is proposed under the slug \`${proposed.slug}\`, which the module "${held.name}" (id: ${held.id}) already holds ` +
        `with the same code, but without ${absent.length === 1 ? "this test case" : "these test cases"}: ${absent.map((test) => `"${test.description}"`).join(", ")}. ` +
        "The card would show tests that were never run to approve that module, so the draft is not offered. To use the module as " +
        "it is, leave it out of `modules` and name it in the step's `entryAction` by its id. To add the cases, return them as a change " +
        `to that module, in a reply of its own with no \`draft\` and no \`modules\`: \`change\` with \`moduleId\` "${held.id}", its code exactly ` +
        "as it is saved and the cases in `tests` — the person applies it on the card and approves the module again with them — or " +
        "propose the module under another slug."
      );
    }
    // And being there is not yet having been run. Adding or changing a
    // case withdraws an approval now (EO-498), but an approval given
    // before that rule can still stand over a case written after it —
    // one that approval never ran, and that may not pass. A card showing it beside
    // a module that reads as approved would be publishable on the
    // strength of tests nobody has seen pass. Held to the approval
    // itself: every case on the card has to have been written *before*
    // the module was last approved. Strictly before — the two stamps are
    // milliseconds, so a case saved in the same one as the approval may
    // as easily have landed just after it as just before, and an
    // approval that cannot be shown to have run a case is not treated as
    // having run it. Approving runs the tests first and takes far longer
    // than a millisecond, so a case that really was covered is never
    // caught by this. An unapproved module has no
    // such question — approving it is what runs them all, and Publish
    // waits for that.
    const approvedAt = held.approvedAt;
    const unrun = approvedAt === null ? [] : proposed.tests.filter((test) => (has.get(keyOf(test)) ?? 0) >= approvedAt);
    if (unrun.length > 0) {
      return (
        `"${proposed.name}" is proposed under the slug \`${proposed.slug}\`, which the module "${held.name}" (id: ${held.id}) already holds, ` +
        `approved — but ${unrun.length === 1 ? "this test case was" : "these test cases were"} added or changed after it was approved, so that approval ` +
        `cannot be shown to have run ${unrun.length === 1 ? "it" : "them"}: ${unrun.map((test) => `"${test.description}"`).join(", ")}. The draft is not offered on an approval ` +
        "that does not cover the tests the card shows. The person approves the module again in Settings → Modules, which runs every " +
        "case; or leave it out of `modules` and name it in the step's `entryAction` by its id, to use it as approved."
      );
    }
  }
  return null;
}

/**
 * May a proposal be written over this module (EO-401)?
 *
 * Only when nothing is lost by it, which is three things at once:
 *
 *   * **nobody has approved it.** An approved module is a body of code a
 *     person read and accepted, and an agent proposing again must never
 *     overwrite one — that is what the approval gate exists to prevent;
 *   * **the assistant wrote it.** A module a person wrote or imported is
 *     theirs, approved or not, and is changed by a change card the
 *     person applies (`postModuleChange`, EO-418) — never by a proposal
 *     that saves as it is posted;
 *   * **it is still in the catalog.** A deleted module holds its slug and
 *     is not brought back by a proposal.
 *
 * This is what lets a module that failed its tests on Approve be fixed
 * where it was proposed: the corrected one goes in under the same slug,
 * instead of under a new one with the broken one left behind.
 */
function isReplaceable(held: CustomModule): boolean {
  return held.approvedAt === null && held.archivedAt === null && held.source === "architect";
}

/**
 * Does a proposal say anything about a module's code, manifest or tests
 * that the module does not already say?
 *
 * False for the same module proposed again, which is left exactly as it
 * is. A test case counts: a module can fail approval on a case that was
 * wrong rather than on its code, and the corrected case under the same
 * description is as much a correction as a changed line.
 */
function differsFrom(db: Db, held: CustomModule, proposed: ProposedModule): boolean {
  if (held.code !== proposed.code || canonical(held.manifest) !== canonical(proposed.manifest)) return true;
  // Asked of the function that writes them, not worked out again here:
  // a case is matched to the module's oldest of its description, so a
  // proposal can have something to correct even where the module already
  // holds a case saying the same thing, and can list one case twice.
  return moduleTestsWouldChange(db, held.id, proposed.tests);
}

/**
 * The modules a draft's steps can name, by what they would name them by:
 * an existing module by its id, and one this turn proposes by its slug,
 * which is all a module that does not exist yet has — `validateDraft`
 * presents it the same way.
 */
function moduleCatalogFor(db: Db, proposed: readonly ProposedModule[]): Map<string, { name: string; manifest: CustomModule["manifest"] }> {
  return new Map<string, { name: string; manifest: CustomModule["manifest"] }>([
    ...listModules(db, true).map((module): [string, { name: string; manifest: CustomModule["manifest"] }] => [module.id, module]),
    ...proposed.map((module): [string, { name: string; manifest: CustomModule["manifest"] }] => [module.slug, module]),
  ]);
}

/**
 * Saves the modules a draft card proposes, unapproved and with their
 * tests (EO-381). Answers with how many it wrote, or why it wrote none.
 *
 * Done here because this room's card has no Apply — only Publish, which
 * the modules have to be approved before. Two rules:
 *
 *   * **unapproved.** Approving is a person reading the code, and its
 *     tests passing when they click (KAN-106, EO-353). Nothing here can
 *     approve anything;
 *   * **a slug the catalog already has is left exactly as it is.** That
 *     module may already have been read and approved, and overwriting
 *     approved code because an agent proposed it again is the one thing
 *     the approval gate exists to prevent. By the time this runs that
 *     can only be the *same* module — `moduleCollision` refuses a
 *     proposal whose slug is held by different code — so skipping it
 *     changes nothing about what the card describes;
 *   * **except a module nobody has approved, that the assistant wrote**
 *     (EO-401, `isReplaceable`). That one is replaced: the proposal's
 *     code, manifest and test cases are written onto it, a version is
 *     filed, and it stays unapproved. Nothing a person read is lost, and
 *     it is how a module that failed its tests on Approve gets fixed.
 *
 * All or none, in one transaction, for `modules:save`'s reason: a module
 * saved without the cases it arrived with cannot be approved, and the
 * card naming the rest would be offered over a catalog half-written.
 */
function saveProposedModules(
  db: Db,
  modules: readonly ProposedModule[],
  /** What was proposed, for the refusal's wording: a draft with modules, or modules on their own (EO-398). */
  proposed: "draft" | "module" = "draft",
): { refusal: string | null; saved: number } {
  if (modules.length === 0) return { refusal: null, saved: 0 };
  let written = 0;
  try {
    db.transaction(() => {
      for (const proposed of modules) {
        const held = getModuleBySlug(db, proposed.slug);
        if (held) {
          // The same module, or one `moduleCollision` let through because
          // it may be replaced. Asked again here rather than taken on
          // trust, since this is the line that writes over a module.
          if (!isReplaceable(held) || !differsFrom(db, held, proposed)) continue;
          // Code, manifest and cases onto that module, in this
          // transaction (EO-401). `saveModule` files the version, so the
          // code it had is in its history, and leaves it unapproved.
          const replaced = saveModule(db, {
            id: held.id,
            slug: held.slug,
            name: proposed.name,
            description: proposed.description,
            code: proposed.code,
            manifest: proposed.manifest,
            originalScript: proposed.originalScript,
            source: "architect",
          });
          if (!replaced.ok) throw new ModuleRefused(`"${proposed.name}" could not be saved: ${replaced.reason}`);
          for (const put of putModuleTests(db, held.id, proposed.tests)) {
            if (!put.ok) throw new ModuleRefused(`a test case for "${proposed.name}" could not be saved: ${put.reason}`);
          }
          written += 1;
          continue;
        }
        const saved = saveModule(db, {
          slug: proposed.slug,
          name: proposed.name,
          description: proposed.description,
          code: proposed.code,
          manifest: proposed.manifest,
          originalScript: proposed.originalScript,
          source: "architect",
        });
        if (!saved.ok) throw new ModuleRefused(`"${proposed.name}" could not be saved: ${saved.reason}`);
        for (const added of addModuleTests(db, saved.module.id, proposed.tests)) {
          if (!added.ok) throw new ModuleRefused(`a test case for "${proposed.name}" could not be saved: ${added.reason}`);
        }
        written += 1;
      }
    });
  } catch (error) {
    if (!(error instanceof ModuleRefused)) throw error;
    return {
      refusal:
        proposed === "draft"
          ? `This draft was not offered, because ${error.message}. No module was saved. Fix it and propose the draft again.`
          : `Nothing was offered, because ${error.message}. No module was saved. Fix it and propose it again in \`modules\`.`,
      saved: 0,
    };
  }
  return { refusal: null, saved: written };
}

/** A proposed module the catalog would not take; carries why, out of the transaction. */
class ModuleRefused extends Error {}

/**
 * The card a person reads before publishing a draft raised here.
 *
 * The architect's renderer, given the architect's shape. That function
 * validates the graph against the pipeline as it stands and renders the
 * diff, and a second implementation of either would be a card that
 * disagrees with the Publish button about what is publishable — the one
 * outcome worse than no card at all.
 *
 * `agents` and `runtimes` are empty because an assist turn cannot
 * propose them: staffing a new role or installing a runtime is work for
 * the configuration screen, where the whole inventory is on show.
 * `modules` it can (EO-381) — a pipeline built from the chat would
 * otherwise need its modules written outside any card — and they are
 * rendered and validated by the same function.
 *
 * Which pipeline it is rendered against is `draftDestination`: the one
 * the draft names, or else the board *this turn* was started from, not
 * wherever the person has since walked. A draft naming nothing from
 * somewhere that is not a board gets a rejection carrying the reason
 * rather than a card with a button on it.
 *
 * Then, for a pipeline that exists, whether this turn read *that*
 * pipeline (EO-208), which is the check `pipelineRead.ts` carries the
 * reasoning for: a draft is the whole graph, so omission is deletion,
 * and a run that read nothing has proposed removing whatever it happened
 * not to think of. Verified from `run_events` rather than believed
 * (invariant #5). That pipeline and not merely some pipeline — the
 * screen is live and the panel survives a navigation, so a turn can read
 * an item page or another pipeline while the draft is about this one. A
 * pipeline the draft would create has nothing to read and nothing a
 * draft could delete from it, so the check has nothing to ask.
 *
 * Before `renderDraft` rather than after, because the two refuse
 * different things. `validateDraft` judges the graph — it is what caught
 * EO-208's proposal, naming the two steps it would have emptied — and it
 * is judging a graph that was invented rather than derived, so the
 * account it gives is of the symptom. This says what actually went
 * wrong, and it says it even for the invented graph that happens to
 * validate.
 */
function renderAssistDraft(db: Db, conversation: Item, output: AssistOutput, draft: AssistDraft, runId: Uuid): RenderedDraft {
  const destination = draftDestination(db, conversation, runId, draft);
  if (destination.kind === "refused") return { ok: false, reason: destination.reason };
  if (destination.kind === "none") {
    return {
      ok: false,
      reason:
        "That graph was not raised on a pipeline's board, and it names no pipeline, so there is nothing here to publish it against. " +
        "Name the pipeline in the draft's `target` — an existing one by `pipelineId`, or `newPipeline` with a name to create one — " +
        "and propose it again.",
    };
  }

  if (destination.kind === "existing") {
    const verdict = pipelineReadVerdict(listRunEvents(db, runId), destination.pipelineId);
    if (verdict.kind !== "read") {
      return { ok: false, reason: underivedDraftRefusal(db, destination.pipelineId, draft, verdict) };
    }
  }

  const modules = output.modules ?? [];
  const refused = draftRefusal(db, conversation, destination, draft, modules);
  if (refused !== null) return { ok: false, reason: refused };

  return renderDraft(
    db,
    judgedAgainst(destination),
    // The definitions the draft's steps rely on (EO-426), validated and
    // listed by the same renderer and saved by nobody until Publish.
    { message: output.message, questions: output.questions, draft, agents: [], runtimes: [], modules, actions: (output.actions ?? []).map(proposedActionDraft) },
    // A step naming a module that is in the catalog and not yet approved
    // is offered as a card that waits on it (EO-399), as one naming a
    // module this reply proposed always was.
    { ...(destination.kind === "new" ? { newPipelineName: destination.name } : {}), unapprovedModulesAsPresent: true },
  );
}

/**
 * What a draft derived from nothing is refused with.
 *
 * Three things, and the middle one is why this is prose rather than a
 * constant. **What was thrown away**, named: the steps of that board the
 * graph does not mention and what each is holding, because "EO refused a
 * draft" and "EO refused a draft that would have emptied Worktree and
 * Done" are different facts to read in a thread a week later, and only
 * the second lets somebody tell an agent that proposed nothing from one
 * whose proposal EO threw away (invariant #8).
 *
 * **Why**, in the terms the next turn can act on — that omission is
 * deletion, so a graph nobody derived is a deletion nobody decided. The
 * opening sentence is the verdict's, because "you read nothing" and "you
 * read somebody else's board" have different fixes and an agent told the
 * wrong one would go and write the same graph again.
 *
 * **What to do instead**: the read that answers with this board's graph,
 * named the way `packages/engine/src/context.ts` names a tool and for
 * the reason set out there (invariant #12). The server is the part of a
 * tool id every backend agrees on; the punctuation around it is the
 * harness's, and prose that spelled one backend's would send the other
 * one looking for a door that is not there. The board's own id is in the
 * sentence, because the tool takes one and an agent that has to guess it
 * will guess.
 */
function underivedDraftRefusal(db: Db, pipelineId: string, draft: AssistDraft, verdict: PipelineNotRead): string {
  const proposed = new Set(draft.steps.map((step) => step.id));
  const counts = itemCounts(db);
  const dropped = listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard && !proposed.has(step.id));

  // What went wrong, in the terms the next turn can act on. "You read
  // nothing" and "you read another board" are different mistakes and
  // have different fixes, and a turn told the wrong one would go and
  // make the same graph again.
  const opening =
    verdict.kind === "nothing"
      ? "That graph was thrown away rather than offered, because nothing in this turn read the pipeline it would replace. " +
        "Remembering it from earlier in this conversation is not the same thing: this room is one thread now, so you may " +
        "well be holding a graph from a previous turn — and the person can have published a draft or moved a step since, " +
        "which is exactly what a stale graph would propose deleting."
      : verdict.kind === "elsewhere"
        ? `That graph was thrown away rather than offered: this turn read \`${verdict.what}\`, which is not the board the graph would replace.`
        : `That graph was thrown away rather than offered. Reading the screen is not enough to publish a graph over a board: ` +
          `\`${SCREEN_TOOL}\` answers about wherever the person is at the moment you call it, and they can walk to another ` +
          "pipeline while you are working — so it cannot establish which board you were shown.";

  return [
    opening,
    "",
    "A draft is the whole board: every step it does not name is a step it removes. So a graph written without reading " +
      "the current one is a proposal to delete whatever it happened not to think of — which reads exactly like a " +
      "considered decision to delete it, and is not one.",
    "",
    dropped.length === 0
      ? `As written it drops no step of that board, but nothing here established that: ${draft.steps.length} step${
          draft.steps.length === 1 ? "" : "s"
        } were proposed against a board whose graph this turn did not read.`
      : `It would have removed ${dropped.map((step) => `**${step.name}**${holdingPhrase(counts, step.id)}`).join(", ")}.`,
    "",
    `Read **this** graph first: \`${PIPELINE_GRAPH_TOOL}\` for \`${pipelineId}\`. It takes the board's id, so what comes ` +
      `back cannot be about anywhere else — which is why it is the read EO accepts here. It is on the MCP server EO ` +
      `registers as \`${PIPELINE_READ_SERVER}\`; every backend spells a tool id its own way, so find it by that server ` +
      "name rather than by any punctuation around it. Then propose the graph again from what it says.",
  ].join("\n");
}

// ── Reading a draft back ──────────────────────────────────────

/**
 * Everything the agent posted on this comment's run, in posting order.
 *
 * What "which card is the draft" is read from (`assistDraftSlot`).
 * `postAssistReply` writes the message, then the questions, then the
 * proposals in order, and the drafts **last** — so the drafts are the
 * last comments of their run, whatever kind each turned out to be, with
 * only a card keeping one's own pipeline after them (EO-534).
 *
 * The last comments rather than the last *proposal* cards, and the
 * difference is a bug this had before it had a caller. A draft that
 * cannot be published is posted as a rejection carrying the reason — a
 * turn on Settings that proposed a graph, say — and then the last
 * proposal card on the run is a decomposition. Reading position among
 * proposal cards called that decomposition the draft: it was offered a
 * Publish button, refused by the approve path as "a pipeline draft", and
 * refused by the publish path for having no pipeline. The card was
 * unusable both ways, which is the one outcome worse than no button.
 *
 * Agent comments only, so an engine note filed against the same run —
 * "Turn stopped.", a guard's sentence — cannot displace the draft from
 * the end of its own turn.
 */
function agentCommentsOfRun(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): readonly Comment[] {
  return (thread ?? threadOf(db, conversation.id)).agentCommentsOf(comment.runId);
}

/**
 * The slug of the module this comment is a card for, or null when it is
 * not a module card (EO-398).
 *
 * `postAssistReply`'s order, read back: a turn that proposed modules and
 * no draft ends in one card per module, in the order it listed them. So
 * the cards are the last comments the agent posted on that run, as many
 * as there are modules, and which module a card is for is its place
 * among them. A turn whose modules were refused ends in a rejection
 * instead, and then none of its comments is a card — asked rather than
 * assumed, because the work proposals posted before it are `proposal`
 * comments too.
 *
 * Answered whether or not the card is still the newest thing said. What
 * a module card shows is the catalog, and that does not stop being true
 * when the conversation moves on.
 */
export function assistModuleCardSlug(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): string | null {
  return assistModuleCardModule(db, conversation, comment, thread)?.slug ?? null;
}

/** The module a card proposed, as its run wrote it — `assistModuleCardSlug`'s rule, answering with the whole entry. */
function assistModuleCardModule(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): ProposedModule | null {
  if (!isAssistProposal(db, comment, thread)) return null;

  // The run's result first, the thread only for a run that proposed
  // modules: most cards are not module cards, and a caller with no thread
  // should not read one to learn that.
  const output = outputOf(db, comment.runId, AssistOutputSchema, thread);
  if (output === null || output.draft) return null;
  const modules = output.modules ?? [];
  if (modules.length === 0) return null;

  const said = agentCommentsOfRun(db, conversation, comment, thread);
  const cards = said.slice(-modules.length);
  if (cards.length !== modules.length || cards.some((card) => card.kind !== PROPOSAL_KIND)) return null;
  return modules[cards.findIndex((card) => card.id === comment.id)] ?? null;
}

/**
 * Does this module card still describe the module the catalog holds
 * (EO-401)? Null when it does; otherwise where the module that replaced
 * it is to be found.
 *
 * A module card draws the catalog, and Approve on it approves whatever
 * the catalog holds under the slug. Once a corrected module has been
 * written over the one this card proposed, that is code this card never
 * described — so the card stops offering Approve, like any older
 * proposal. Two questions, asked in this order:
 *
 *   * **is there a later card here for the same slug that says something
 *     else?** — different code, a different manifest or different test
 *     cases, on a module card or on a draft card carrying the module.
 *     Then the newer one is `below`, and that is the card to approve
 *     from. "Later" includes later in the same turn: a reply that lists
 *     one slug twice writes the second over the first, and posts a card
 *     for each. A turn that was refused wrote nothing and replaces
 *     nothing, and the same module proposed again leaves both cards
 *     telling the truth;
 *   * **does the catalog still hold the code and manifest this card
 *     proposed?** If not, and nothing here replaced it, it was replaced
 *     `elsewhere`: by a correction proposed in another chat, or an edit
 *     in Settings → Modules. There is no newer card to point at, but the
 *     card is no more entitled to an Approve button for that.
 *
 *   * **did a card in another chat correct only its test cases?** The
 *     code is then the same and the second question cannot see it, but
 *     Approve here would run cases this card never showed. Answered
 *     from that chat's card rather than from the catalog's cases
 *     (`correctedInAnotherChat`), because the catalog cannot tell a
 *     correction from a case a person added in Settings → Modules — and
 *     that one has not changed what this card described. Also
 *     `elsewhere`.
 *
 * Asked every time rather than recorded when the replacement is written,
 * so it is right whichever conversation the correction arrived in. A
 * module that has been deleted is not this: the card says so itself.
 */
export function assistModuleCardReplaced(db: Db, conversation: Item, comment: Comment, thread?: ConversationThread): "below" | "elsewhere" | null {
  const mine = assistModuleCardModule(db, conversation, comment, thread);
  if (mine === null) return null;
  const said = (module: ProposedModule) => canonical([module.code, module.manifest, module.tests.map((test) => [test.description, test.source])]);

  const here = thread ?? threadOf(db, conversation.id);
  const later = here.comments.filter((entry) => entry.authorType === "agent" && postedAfter(entry, comment));
  for (const entry of later) {
    const theirs = assistModuleCardModule(db, conversation, entry, here) ?? draftCardModule(db, conversation, entry, mine.slug, here);
    if (theirs && theirs.slug === mine.slug && said(theirs) !== said(mine)) return "below";
  }

  const held = getModuleBySlug(db, mine.slug);
  if (!held || held.archivedAt !== null) return null;
  if (held.code !== mine.code || canonical(held.manifest) !== canonical(mine.manifest)) return "elsewhere";
  return correctedInAnotherChat(db, conversation, comment, held, mine, said) ? "elsewhere" : null;
}

/** Was `entry` posted after `than`? By the stamp, and by the id where the stamps are one millisecond — ids are minted in creation order. */
function postedAfter(entry: Pick<Comment, "id" | "createdAt">, than: Pick<Comment, "id" | "createdAt">): boolean {
  return entry.createdAt > than.createdAt || (entry.createdAt === than.createdAt && entry.id > than.id);
}

/**
 * Did a card posted since, in another chat, propose this module with
 * something this card did not say — and is that the newest word on it?
 *
 * The case `assistModuleCardReplaced` cannot answer from the catalog: a
 * correction to the test cases alone leaves the code and manifest as
 * this card proposed them. So the other chats' cards are read, as this
 * chat's are, and the newest one for the slug is compared with this
 * card. The newest, rather than any: a correction that was itself put
 * back to what this card says leaves this card describing the module.
 *
 * Every chat with the assistant, put-away ones included — a correction
 * wrote to the catalog whether or not its chat is still open.
 *
 * Only looked for when the module's cases are not exactly the ones this
 * card listed, counted. While they are, the catalog is what the card
 * described, whatever any other card went on to say, and there is
 * nothing to look for — which keeps a conversation of untouched modules
 * from reading every other chat each time it is drawn. A case a person
 * adds in Settings makes them differ too, and then no card is found and
 * the answer is no.
 *
 * Nothing here reads a clock against a clock. Which card is later is
 * `postedAfter`, and where two were posted in one millisecond that is
 * their ids, which `uuidv7` mints in creation order.
 */
function correctedInAnotherChat(
  db: Db,
  conversation: Item,
  comment: Comment,
  held: CustomModule,
  mine: ProposedModule,
  said: (module: ProposedModule) => string,
): boolean {
  const cases = (tests: readonly { description: string; source: string }[]) => canonical(tests.map((test) => canonical([test.description, test.source])).sort());
  if (cases(listModuleTests(db, held.id)) === cases(mine.tests)) return false;

  let newest: { card: Comment; module: ProposedModule } | undefined;
  for (const other of listItemsOnStepIncludingArchived(db, ASSIST_STEP)) {
    if (other.stepId !== ASSIST_STEP || other.id === conversation.id) continue;
    // That chat's thread read once for all of its cards, not once per card.
    const theirThread = threadOf(db, other.id);
    for (const entry of theirThread.comments) {
      if (entry.authorType !== "agent" || entry.kind !== PROPOSAL_KIND || !postedAfter(entry, comment)) continue;
      if (newest && !postedAfter(entry, newest.card)) continue;
      const theirs = assistModuleCardModule(db, other, entry, theirThread) ?? draftCardModule(db, other, entry, mine.slug, theirThread);
      if (theirs && theirs.slug === mine.slug) newest = { card: entry, module: theirs };
    }
  }
  return newest !== undefined && said(newest.module) !== said(mine);
}

/** The module of this slug a draft card carries — the last listed, which is the one written last. Undefined on anything but a draft card. */
function draftCardModule(db: Db, conversation: Item, comment: Comment, slug: string, thread?: ConversationThread): ProposedModule | undefined {
  const here = thread ?? threadOf(db, conversation.id);
  if (comment.runId === null || !isAssistDraftCard(db, conversation, comment.id, here)) return undefined;
  return (here.output(comment.runId, AssistOutputSchema)?.modules ?? []).filter((module) => module.slug === slug).at(-1);
}

/**
 * Is this card the pipeline draft its turn proposed, rather than work?
 *
 * What the panel asks so that a card gets the button that fits it —
 * Publish for a graph, Create item for a decomposition. Answered here
 * rather than in the renderer because the answer is the posting order
 * above, and a renderer deriving it from the body of a comment would be
 * guessing at something EO knows.
 *
 * A run that returned no draft has no draft card, however many proposals
 * it posted: without that clause the last of three decompositions would
 * be offered a Publish button.
 */
export function isAssistDraftCard(db: Db, conversation: Item, commentId: Uuid, thread?: ConversationThread): boolean {
  const here = thread ?? threadOf(db, conversation.id);
  const comment = here.find(commentId);
  if (!comment || !isAssistProposal(db, comment, here)) return false;
  return assistDraftSlot(db, conversation, comment, here) !== null;
}

/**
 * Which of its turn's drafts a comment is the card for (EO-534), or null
 * where it is not one.
 *
 * `postAssistReply`'s order, read back: a turn's drafts are posted last,
 * one comment each — `draft`, then each of its `alternatives` — with
 * only a card keeping one's own pipeline after them. So the drafts are
 * the comments just before that card, or the last ones the run said
 * where there is none, and which draft a card is is its place among
 * them. Every draft posts exactly one comment, a card or the rejection
 * saying why it is not one, so the places hold whichever were refused.
 */
export function assistDraftSlot(
  db: Db,
  conversation: Item,
  comment: Comment,
  thread?: ConversationThread,
): { draft: AssistDraft; index: number; output: AssistOutput } | null {
  if (comment.runId === null) return null;
  const output = outputOf(db, comment.runId, AssistOutputSchema, thread);
  if (output === null) return null;
  const drafts = draftsOf(output);
  if (drafts.length === 0) return null;

  const said = agentCommentsOfRun(db, conversation, comment, thread);
  const slots = (output.card === null ? said : said.slice(0, -1)).slice(-drafts.length);
  if (slots.length !== drafts.length) return null;
  const index = slots.findIndex((entry) => entry.id === comment.id);
  const draft = drafts[index];
  return draft === undefined ? null : { draft, index, output };
}

export type ReadAssistDraftResult =
  | {
      ok: true;
      /** The pipeline it changes. Null when it creates one. */
      pipelineId: string | null;
      /** The pipeline it creates on Publish (EO-381). Null when it changes one that exists. */
      newPipelineName: string | null;
      draft: AssistDraft;
      /** The modules the card proposed, saved unapproved when it was posted (EO-381). */
      modules: ProposedModule[];
      /** The modules it cannot be published without yet (EO-399). Empty when nothing is in the way. */
      waiting: AssistWaitingModule[];
      /** The action definitions the card proposed (EO-426). Written by Publish with the graph, and not before. */
      actions: ParsedActionDefinitionDraft[];
    }
  | { ok: false; reason: string };

/**
 * The structured graph behind a draft comment, for a person to publish.
 *
 * Handed back rather than applied, which is the whole design here and
 * not an omission: the person publishes through the same `pipeline:save`
 * they would have used editing by hand, and one publish path that is
 * already validated and transactional is worth more than a second that
 * agrees with it today.
 *
 * Re-read from the run rather than from anything a renderer kept: what
 * gets published has to be what was displayed, and a panel can sit open
 * for an hour. Re-validated for the
 * same reason — the pipeline can change underneath a card, and a
 * pipeline of the same name can be created underneath one that would
 * create it.
 */
export function readAssistDraft(db: Db, conversation: Item, commentId: Uuid): ReadAssistDraftResult {
  const comments = listCommentsForItem(db, conversation.id);
  const comment = comments.find((entry) => entry.id === commentId);
  if (!comment || !isAssistProposal(db, comment)) {
    return { ok: false, reason: "That is not a draft, so there is nothing to publish." };
  }

  const run = comment.runId ? getRun(db, comment.runId) : undefined;
  const parsed = AssistOutputSchema.safeParse(parsedResultOf(run?.result ?? null));
  if (!parsed.success || !parsed.data.draft) {
    return { ok: false, reason: "The run behind this draft no longer has a readable result." };
  }

  // The drafts are the last things their run said — see `postAssistReply`,
  // where that order is set, and `assistDraftSlot` for which one this
  // card is. Asked rather than assumed, because a turn may legitimately
  // have proposed work as well, and reading one of those as a graph would
  // hand the editor something it cannot publish.
  const slot = assistDraftSlot(db, conversation, comment);
  if (slot === null) {
    return { ok: false, reason: "That card is a proposal rather than a pipeline draft." };
  }
  const draft = slot.draft;
  const modules = parsed.data.modules ?? [];

  // The card's own run, so publishing an hour later reaches the same
  // pipeline the card was rendered against — however many messages have
  // been sent from elsewhere in between.
  const destination = draftDestination(db, conversation, comment.runId, draft);
  if (destination.kind === "refused") return { ok: false, reason: destination.reason };
  if (destination.kind === "none") {
    return { ok: false, reason: "That draft was not raised on a pipeline's board, so there is nothing here to publish it against." };
  }

  const refused = draftRefusal(db, conversation, destination, draft, modules, true);
  if (refused !== null) return { ok: false, reason: refused };

  // For shape, with a module that is waiting for approval treated as
  // present (EO-399): that the draft waits is said beside the graph, in
  // `waiting`, and is not a reason the graph no longer fits.
  const actions = (parsed.data.actions ?? []).map(proposedActionDraft);
  const problems = validateDraft(db, judgedAgainst(destination), draft, modules, { unapprovedModulesAsPresent: true, actions });
  if (hasBlockingProblem(problems)) {
    return {
      ok: false,
      reason: `This draft no longer fits the pipeline as it stands: ${problems
        .filter((problem) => problem.severity === "error")
        .map((problem) => problem.message)
        .join(" ")}`,
    };
  }

  return {
    ok: true,
    pipelineId: destination.kind === "existing" ? destination.pipelineId : null,
    newPipelineName: destination.kind === "new" ? destination.name : null,
    draft,
    modules,
    waiting: draftWaitingModules(db, draft, modules),
    actions,
  };
}

/**
 * The modules a draft cannot be published without yet (EO-399).
 *
 * A draft depends on a module nobody has approved in two ways, and both
 * are here:
 *
 *   * one the same reply proposed, which a step names by its slug. It was
 *     saved unapproved when the card was posted. Waiting until somebody
 *     approves it — or gone, if it has been deleted since, and then there
 *     is nothing to approve and the draft has to be asked for again;
 *   * one already in the catalog, which a step names by its id, and which
 *     nobody has approved. Waiting in exactly the same way.
 *
 * A step naming by id a module that has been *deleted* is not here: the
 * validator refuses that graph, as it always did, since nothing a person
 * can do to the catalog makes it publishable.
 *
 * Read from the catalog as it stands, every time it is asked, so
 * approving the last one is what empties this — however it came to be
 * approved.
 */
function draftWaitingModules(db: Db, draft: AssistDraft, proposed: readonly ProposedModule[]): AssistWaitingModule[] {
  const catalog = listModules(db, true);
  const bySlug = new Map(catalog.map((module) => [module.slug, module]));
  const byId = new Map(catalog.map((module) => [module.id as string, module]));
  const waiting = new Map<string, AssistWaitingModule>();

  for (const module of proposed) {
    const saved = bySlug.get(module.slug);
    if (!saved || saved.archivedAt !== null) {
      waiting.set(module.slug, { id: saved?.id ?? null, slug: module.slug, name: saved?.name ?? module.name, state: "gone" });
    } else if (saved.approvedAt === null) {
      waiting.set(module.slug, { id: saved.id, slug: saved.slug, name: saved.name, state: "unapproved" });
    }
  }

  const proposedSlugs = new Set(proposed.map((module) => module.slug));
  for (const step of draft.steps) {
    if (step.type !== "module" || step.entryAction === null || proposedSlugs.has(step.entryAction)) continue;
    const named = byId.get(step.entryAction);
    if (!named || named.archivedAt !== null || named.approvedAt !== null) continue;
    waiting.set(named.slug, { id: named.id, slug: named.slug, name: named.name, state: "unapproved" });
  }
  return [...waiting.values()];
}

// ── The graph a person publishes ──────────────────────────────

export type AssistPublishableGraph =
  | {
      ok: true;
      /** The pipeline it is saved into. Null when Publish creates one, and then every step and route carries `""` for it. */
      pipelineId: string | null;
      /** The pipeline Publish creates (EO-381). Null when it changes one that exists. */
      newPipelineName: string | null;
      steps: PipelineStepView[];
      routes: StepRouteView[];
      entryStepId: string;
      /**
       * The modules this graph runs that nobody has approved, or that are
       * gone (EO-399). Not empty means the graph is what the card shows
       * and not yet something to save: whoever writes one checks this.
       */
      waiting: AssistWaitingModule[];
      /**
       * The action definitions this graph is published with (EO-426):
       * sent to `pipeline:save` beside it, which writes both or neither.
       */
      actions: ParsedActionDefinitionDraft[];
      /** The name Publish renames the pipeline to (EO-520). Null when the draft keeps the name, and always for a pipeline Publish creates, which `newPipelineName` names. */
      rename: string | null;
      /** The icon Publish gives the pipeline (EO-520). Null when the draft leaves it alone. */
      icon: string | null;
      /** Which of this graph's steps is which step of a held template version, where the draft gave one a fresh id (EO-534). Empty everywhere else. */
      templateStepIds: Record<string, string>;
      /** The version this graph restores (EO-520), sent to `pipeline:save` as `restoredFrom` so it puts back who that version's person steps waited on. */
      restoredFrom: number | null;
      /** The entry rules it sets (EO-610). Undefined leaves the pipeline's alone. */
      entryRules: EntryRule[] | undefined;
    }
  | { ok: false; reason: string };

/**
 * A draft raised here, as the graph `pipeline:save` takes.
 *
 * The conversation has no editor behind it, and that is the only reason
 * this exists. An editor holds every step's configured inputs (EO-78) and
 * wall clock (EO-162) and carries them across; here there is a card and
 * a Publish button, so the carry-across has to happen against the pipeline
 * as it stands rather than being invented by a renderer that has never
 * read those values.
 *
 * The rules are the editor's, deliberately the same three:
 *
 *   * a step keeps what it had, so publishing a graph does not wipe a
 *     number somebody tuned;
 *   * minus anything the module it now runs does not declare, because a
 *     value for an input that module has never heard of is not that
 *     module's anything;
 *   * and a step that is no longer a module step loses its timeout,
 *     which is what the validator demands of one filed against a kind
 *     that cannot use it.
 *
 * A step the draft invented has nothing to keep, so it gets what the
 * draft set for it (EO-381) — its time limit and its inputs — and EO's
 * defaults for anything the draft left out.
 *
 * A draft that runs a module nobody has approved is answered all the
 * same, with the modules it is waiting on beside the graph (EO-399).
 * Waiting is a state of the card rather than an error: the card keeps its
 * picture, lists those modules with Approve on each, and unlocks Publish
 * when the last is approved. This is not where a graph is kept from
 * being published — `publishNewAssistPipeline` refuses one that is
 * waiting, and `pipeline:save` refuses a step running an unapproved
 * module whoever sends it. A proposed module is named in the draft by
 * its slug — it had no id when the draft was written — and is translated
 * to the id it has now, which is what `pipeline_steps.entry_action`
 * holds.
 *
 * Route ids are generated here only because the schema wants one:
 * `replacePipelineGraph` regenerates every one of them on save, so
 * nothing downstream ever reads these.
 */
export function assistDraftForPublish(db: Db, conversation: Item, commentId: Uuid): AssistPublishableGraph {
  const read = readAssistDraft(db, conversation, commentId);
  if (!read.ok) return read;

  const catalog = listModules(db, true);
  const bySlug = new Map(catalog.map((module) => [module.slug, module]));

  const pipelineId = read.pipelineId ?? NOT_YET_CREATED;
  const before = new Map(read.pipelineId === null ? [] : listStepsForPipeline(db, read.pipelineId).map((step) => [step.id, step]));
  const proposedSlugs = new Set(read.modules.map((module) => module.slug));

  return {
    ok: true,
    pipelineId: read.pipelineId,
    newPipelineName: read.newPipelineName,
    steps: read.draft.steps.map((draftStep) => {
      // The settings are `settledStepSettings`' to decide, never the
      // draft's to spread in: what it says, or else what the step has.
      const step = withoutDraftSettings(draftStep);
      const entryAction =
        step.type === "module" && step.entryAction !== null && proposedSlugs.has(step.entryAction)
          ? (bySlug.get(step.entryAction)?.id ?? step.entryAction)
          : step.entryAction;
      const existing = before.get(step.id);
      // Every setting the draft names, and the step's own for every one
      // it leaves out (EO-520) — so publishing a draft that only rewired
      // round a step does not wipe a number somebody tuned (EO-78,
      // EO-162), turn off a pull request watch (EO-456), or move a step
      // off the disk somebody pointed it at or make a "Reads only" step
      // cut branches (EO-296, EO-301). A step the draft invented has
      // nothing to keep: it gets what the draft set, and EO's defaults —
      // the item's own workspace, a branch of its own, run once.
      const settled = settledStepSettings(draftStep, existing);
      return {
        ...step,
        entryAction,
        pipelineId,
        ...settled,
        // Minus anything the module or builtin it now runs does not
        // declare (EO-78, EO-507, EO-516) — by the function the card's
        // input list is drawn with, so the card shows what this drops.
        inputs: publishedStepInputs({ type: step.type, entryAction }, settled.inputs, catalog, []),
        // What a person may decide here, derived from the branches the
        // draft drew out of this step (EO-310) — `toDomainSteps` in
        // `roles/architect.ts` does the same, for the same reason: on a
        // human step a branch *is* the offer, and a published graph whose
        // user step routed a result it did not declare is one
        // `validatePipeline` refuses.
        //
        // What the step already declared wins on every key it still
        // routes, so the words somebody wrote on a button survive a draft
        // that only rewired around it — and "Needs a reason" is the
        // draft's wherever its branch says it (EO-520).
        results: draftStepResults(step, read.draft.routes, existing?.results ?? []),
      };
    }),
    // "Needs a reason" is the result's, carried above, not the route's.
    routes: read.draft.routes.map(({ requiresComment: _requiresComment, ...route }) => ({ ...route, id: uuidv7(), pipelineId })),
    entryStepId: read.draft.entryStepId,
    waiting: read.waiting,
    actions: read.actions,
    // What the card says about the pipeline itself (EO-520), applied by
    // the same Publish: the name only where it changes one.
    rename: read.pipelineId !== null && read.draft.name !== undefined && read.draft.name !== getPipeline(db, read.pipelineId)?.name ? read.draft.name : null,
    icon: read.draft.icon ?? null,
    templateStepIds: read.draft.templateStepIds ?? {},
    restoredFrom: read.draft.restoredFrom ?? null,
    entryRules: read.draft.entryRules,
  };
}

/**
 * Why Publish is waiting on a draft's modules, naming each (EO-381).
 *
 * The sentence for a surface that cannot list them: what
 * `assist:publishNew` refuses with. The chat layout's card shows the
 * modules themselves and never this (EO-399).
 *
 * Two states, said apart because they send a person to different places:
 * a module waiting for approval is approved in Settings → Modules, and
 * one that is gone — deleted since the card was posted — has to be asked
 * for again.
 */
export function modulesWaitingReason(waiting: readonly AssistWaitingModule[]): string {
  const unapproved = waiting.filter((module) => module.state === "unapproved");
  const missing = waiting.filter((module) => module.state === "gone");
  const named = (modules: readonly AssistWaitingModule[]) => modules.map((module) => `"${module.name}"`).join(", ");

  const sentences: string[] = [];
  if (unapproved.length > 0) {
    sentences.push(
      `Publish is waiting on ${named(unapproved)}, which ${unapproved.length === 1 ? "has" : "have"} not been approved. ` +
        "A module runs only once a person has read it and approved it — approving runs its tests, and every one has to pass. " +
        `Approve ${unapproved.length === 1 ? "it" : "them"} in Settings → Modules, then publish.`,
    );
  }
  if (missing.length > 0) {
    sentences.push(`${named(missing)} ${missing.length === 1 ? "is" : "are"} no longer in the module catalog, so this draft cannot be published. Ask for it again.`);
  }
  return sentences.join(" ");
}
