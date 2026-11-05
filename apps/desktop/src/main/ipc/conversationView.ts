import {
  answerArgsOf,
  answerOptions,
  liveMessageOf,
  TURN_STOPPED_NOTE,
  turnStepsOf,
  type Agent,
  type AssistCardView,
  type Comment,
  type DiscussionMessage,
  type DiscussionSettings,
  type DiscussionView,
  type Item,
  type LiveTurn,
  type TurnStep,
  type ModuleChangeCard,
  type ProposalSummary,
  type RunEvent,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { createdKeysIn } from "./approvalNote.js";
import {
  countRunActivity,
  getItemByKey,
  highestRunEventSeq,
  listActiveRuns,
  listAgents,
  listMentionsForComment,
  getRun,
  listRunEvents,
  listRunEventsAfter,
  listRunsForItem,
  trialStopByComment,
} from "../db/repos/index.js";
import { threadOf, type ConversationThread } from "../roles/conversationThread.js";
import { capabilitiesFor } from "../providers/capabilities.js";
import { liveDrafts } from "../supervisor/liveDrafts.js";

/**
 * Rendering a conversation, whatever it is a conversation about.
 *
 * EO's rooms — the assistant's chat and a module's scenario chat, and
 * Discussions and the Architecture panel until EO-526 removed them —
 * render identically because they *are* identical: an item on an
 * off-board step whose comments are the transcript, driven by
 * @-mentions, with question cards and one live run.
 *
 * What differs is four things, and they are exactly the fields of
 * `ConversationKind` below. Everything else — which questions are still
 * answerable, which proposal is still live, how a partial message is
 * glued back together while a run streams — is behaviour neither room
 * should be able to get subtly different from the other.
 *
 * Extracted rather than copied for that last reason above all. Two
 * implementations of "is this question still live" would drift, and the
 * failure would be silent: a card that stays clickable after it has been
 * answered, in one room only.
 *
 * Every question below is handed the thread the view read
 * (`ConversationThread`, EO-552): the conversation's comments, read once
 * per view, with the runs behind them fetched and parsed once however
 * many cards ask. A callback answers from it and reads nothing the view
 * has already read.
 */
export interface ConversationKind {
  /** Who answers in this room. Undefined when nobody is configured or enabled. */
  agent(db: Db): Agent | undefined;
  /** What to call them when the agent row has since been deleted. */
  fallbackName: string;
  /** Is this comment a live proposal of this room's kind? */
  isProposal(db: Db, comment: Comment, thread: ConversationThread): boolean;
  /**
   * What approving this card would do — see `DiscussionMessage.approves`.
   *
   * A constant for the architect, whose every card is a graph, and a
   * question everywhere a proposal can be. Asked of the room rather than
   * worked out by the panel drawing the card: what a card is comes from
   * the run behind it, which the renderer cannot read.
   *
   * Only consulted for a card that is approvable at all, so it never has
   * to answer for an ordinary message.
   */
  approves(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): "items" | "changes" | "pipeline" | "module" | "moduleChange" | "card";
  /**
   * The slug of the module this comment is a card for, or null — see
   * `DiscussionMessage.moduleSlug` (EO-398).
   *
   * Absent on a room that has no module cards, which is every room but
   * the assistant's. Asked of every comment rather than only of the
   * approvable ones, so it has to answer null cheaply for an ordinary
   * message.
   */
  moduleSlug?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): string | null;
  /**
   * Whether the module this card proposed has been replaced, and where
   * the newer one is — see `DiscussionMessage.moduleReplaced` (EO-401).
   * Asked only of a comment `moduleSlug` answered for.
   */
  moduleReplaced?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): "below" | "elsewhere" | null;
  /**
   * What a card proposing a change to an existing module says about
   * itself, or null — see `DiscussionMessage.moduleChange` (EO-418).
   *
   * Absent on a room whose change cards need nothing but their button,
   * which is the scenario chat's: its module is the one the room is
   * about, and its card is spent once applied. Asked of every comment,
   * as `moduleSlug` is, since an applied card is no longer approvable
   * and still has something to offer.
   */
  moduleChange?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): ModuleChangeCard | null;
  /**
   * What a card offering something only a person may do says about
   * itself, or null — see `DiscussionMessage.card` (EO-521).
   *
   * Absent on every room but the assistant's. Asked of every comment, as
   * `moduleChange` is, since a pressed card is no longer approvable and
   * still shows what came of it.
   */
  card?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): AssistCardView | null;
  /**
   * The module whose approval this comment records as withdrawn, or null
   * — see `DiscussionMessage.approvalWithdrawn` (EO-501).
   *
   * Absent on every room but the scenario chat, the one that writes a
   * module's test cases directly. Asked of every comment, so it has to
   * answer null cheaply for an ordinary message.
   */
  approvalWithdrawn?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): { moduleId: string } | null;
  /**
   * Which type this card would file, qualified, or null where the
   * question does not arise — see `DiscussionMessage.proposedType`.
   *
   * A room whose cards are never single items answers null for all of
   * them, which is the architect's whole answer: a graph has no type.
   */
  proposedType(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): string | null;
  /**
   * The work this card proposes, as rows, or null — see
   * `DiscussionMessage.proposal` (EO-407).
   *
   * Absent on a room whose cards are not drawn from one, which is every
   * room but the assistant's. Asked of every comment, as `moduleSlug` is,
   * so that a card which can no longer be approved still lists what it
   * proposed. Why it can no longer be approved is not this room's to
   * say: `conversationView` reads that off the thread.
   */
  proposal?(db: Db, conversation: Item, comment: Comment, thread: ConversationThread): Omit<ProposalSummary, "closed"> | null;
  /** Where this room's per-conversation model and effort live in `items.spec`. */
  settingsKey: string;
  /**
   * Whether this room draws turns the way Claude Desktop does — the
   * running turn step by step (`liveTurn`) and each finished one folded
   * (`turn`). Every conversation room does now; a room that did not draw
   * them would set this false and not pay the queries.
   */
  drawsTurns?: boolean;
  /**
   * Whether a view carries only the newest stretch of the thread
   * (`HISTORY_PAGE`), with older pages read on demand — the assistant's
   * chat, which is the window's spine and grows without end.
   */
  pagesHistory?: boolean;
}

export function settingsFor(db: Db, conversation: Item, kind: ConversationKind): DiscussionSettings {
  const agent = kind.agent(db);
  if (!agent) {
    return {
      agentId: "",
      agentName: kind.fallbackName,
      provider: "unavailable",
      model: null,
      defaultModel: null,
      reasoningEffort: null,
      defaultReasoningEffort: null,
    };
  }

  const saved = conversation.spec?.[kind.settingsKey];
  const settings = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  const effortKey = agent.provider === "claude" ? "effort" : "reasoningEffort";
  return {
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    model: typeof settings["model"] === "string" ? settings["model"] : null,
    defaultModel: agent.model,
    reasoningEffort: typeof settings["reasoningEffort"] === "string" ? settings["reasoningEffort"] : null,
    defaultReasoningEffort: typeof agent.config[effortKey] === "string" ? (agent.config[effortKey] as string) : null,
    reasoningEfforts: [...capabilitiesFor(agent.provider).reasoningEfforts],
    showReasoning: settings["showReasoning"] !== false,
    configurable: capabilitiesFor(agent.provider).modelsAreLive || capabilitiesFor(agent.provider).reasoningEfforts.length > 0,
  };
}

/**
 * Which proposal, if any, is still live.
 *
 * Only the newest one, and only while nothing has been filed under it:
 * between reading a proposal and clicking approve the agent may have
 * revised it, and applying the older one is the outcome nobody could
 * have intended.
 *
 * An applied proposal is recognised by the approval comment filed under
 * it, so approving twice is not possible even if two windows are open.
 */
export function approvableIds(db: Db, conversation: Item, kind: ConversationKind, thread?: ConversationThread): Set<string> {
  if (conversation.archivedAt !== null) return new Set();
  const here = thread ?? threadOf(db, conversation.id);
  const comments = here.comments;
  const answered = new Set(comments.map((comment) => comment.parentId).filter((id): id is Uuid => id !== null));

  const newest = comments
    .filter((comment) => kind.isProposal(db, comment, here))
    .filter((comment) => !answered.has(comment.id))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

  // Every proposal from the newest run stays live, not just one: a single
  // turn can legitimately propose three things, and they are approved one
  // at a time.
  const newestRunId = newest[0]?.runId;
  return new Set(newest.filter((comment) => comment.runId === newestRunId).map((comment) => comment.id));
}

/**
 * Which questions the card may still collect answers for.
 *
 * "Newest wins", the same rule `approvableIds` applies, plus one more
 * that only questions need: a question is live until *something* answers
 * it, and typing an ordinary message counts. Someone who reads three
 * questions and replies in their own words has answered them their way,
 * and leaving the card sitting there afterwards would be asking again
 * for something already given.
 */
export function answerableQuestionIds(db: Db, conversation: Item, thread?: ConversationThread): Set<string> {
  if (conversation.archivedAt !== null) return new Set();

  // Ordered by (createdAt, id) rather than by time alone: a batch is
  // posted in one loop, so its comments routinely share a millisecond,
  // and uuidv7 ids are what still put them in order when they do. The
  // thread is held in that order (`threadOf`).
  const inOrder = (thread ?? threadOf(db, conversation.id)).comments;
  const questions = inOrder.filter((comment) => comment.kind === "question" && comment.authorType === "agent");
  const newest = questions.at(-1);
  if (!newest) return new Set();

  const batch = questions.filter((question) => question.runId === newest.runId);
  const movedOn = inOrder
    .slice(inOrder.indexOf(newest) + 1)
    .some((comment) => comment.authorType === "human" && comment.parentId === null);
  if (movedOn) return new Set();

  const answered = new Set(inOrder.filter((comment) => comment.authorType === "human" && comment.parentId).map((comment) => comment.parentId));
  return new Set(batch.filter((question) => !answered.has(question.id)).map((question) => question.id));
}

/**
 * Which of EO's own comments offer answers the person has not given yet
 * (EO-586): a guardrail stopping a draft's test-fix loop asks "keep
 * going, publish anyway, or discard?" with its options, and the chat
 * draws them as buttons.
 *
 * A stop is answered when a valid answer settled it (`trial_stops`), not
 * when any reply was filed under it: a reply that is none of the three
 * leaves testing stopped, and the buttons with it. Any other comment of
 * EO's offering answers is answered by the first reply under it.
 */
function answerableEngineIds(db: Db, conversation: Item, thread: ConversationThread): Set<string> {
  if (conversation.archivedAt !== null) return new Set();
  const answered = new Set(thread.comments.filter((comment) => comment.authorType === "human" && comment.parentId !== null).map((comment) => comment.parentId));
  const open = (comment: Comment): boolean => {
    const stop = trialStopByComment(db, comment.id);
    return stop === undefined ? !answered.has(comment.id) : stop.answeredAt === null;
  };
  return new Set(thread.comments.filter((comment) => comment.authorType === "engine" && answerOptions(comment.options).length > 0 && open(comment)).map((comment) => comment.id));
}

/** Which module a comment is a card for, and whether that module has since been replaced. */
function moduleCardOf(
  db: Db,
  conversation: Item,
  kind: ConversationKind,
  comment: Comment,
  thread: ConversationThread,
): Pick<DiscussionMessage, "moduleSlug" | "moduleReplaced"> {
  const moduleSlug = kind.moduleSlug?.(db, conversation, comment, thread) ?? null;
  return { moduleSlug, moduleReplaced: moduleSlug === null ? null : (kind.moduleReplaced?.(db, conversation, comment, thread) ?? null) };
}

/**
 * The rows of a work card, with why it offers no button when it does not
 * (EO-407).
 *
 * The reason is read from what `approvableIds` reads — the comments filed
 * under the card. An approval there is the work having been created; a
 * rejection is the approval path turning it away; anything else, or
 * nothing, is a card a newer one replaced. A closed conversation closes
 * every card in it and is a reason about none of them — except one that
 * was approved first, which stays approved and keeps naming what it made.
 */
function proposalOf(
  db: Db,
  conversation: Item,
  kind: ConversationKind,
  comment: Comment,
  thread: ConversationThread,
  approvable: ReadonlySet<string>,
): ProposalSummary | null {
  const summary = kind.proposal?.(db, conversation, comment, thread) ?? null;
  if (summary === null) return null;
  if (approvable.has(comment.id)) return { ...summary, closed: null };
  const under = thread.under(comment.id);
  const approval = under.find((entry) => entry.kind === "approval");
  // Before the conversation is asked about: an approval happened whether
  // or not the chat was put away afterwards, and the items it made are
  // still what its rows became (EO-408).
  if (approval !== undefined) return { ...summary, rows: withCreated(db, summary, approval), closed: "applied" };
  if (conversation.archivedAt !== null) return { ...summary, closed: null };
  return { ...summary, closed: under.some((entry) => entry.kind === "rejection") ? "refused" : "superseded" };
}

/**
 * An approved card's rows, each naming the item it became (EO-408).
 *
 * The approval names what it created in the order it created them: the
 * container first when the proposal has one, then one item per row
 * (`applyDiscussionProposal`). So a row's item is the key at its own
 * place, after the container's. A key whose item has been deleted since
 * leaves its row unlinked rather than pointing at nothing.
 */
function withCreated(db: Db, summary: Omit<ProposalSummary, "closed">, approval: Comment): ProposalSummary["rows"] {
  const keys = createdKeysIn(approval.body).slice(summary.container === null ? 0 : 1);
  let next = 0;
  return summary.rows.map((row) => {
    if (row.kind !== "new") return row;
    const key = keys[next++];
    const item = key === undefined ? undefined : getItemByKey(db, key);
    return { ...row, created: item ? { itemId: item.id, key: item.key } : null };
  });
}

/**
 * How many of a long conversation's newest messages a view carries, where
 * the room pages its history (`ConversationKind.pagesHistory`); the rest is
 * read a page at a time, newest first, as the person scrolls back.
 */
export const HISTORY_PAGE = 100;

export function conversationView(db: Db, conversation: Item, kind: ConversationKind, page_?: { before?: string; limit?: number }): DiscussionView {
  const agentsById = new Map(listAgents(db).map((agent) => [agent.id as string, agent]));
  // The thread, read once (EO-552): every question below is asked of it,
  // the card-kind callbacks' included, rather than each reading it again.
  const thread = threadOf(db, conversation.id);
  const comments = thread.comments;
  const approvable = approvableIds(db, conversation, kind, thread);
  const answerable = new Set([...answerableQuestionIds(db, conversation, thread), ...answerableEngineIds(db, conversation, thread)]);
  const activeRuns = listActiveRuns(db);
  const activeRun = activeRuns.find((run) => run.itemId === conversation.id);
  forgetEndedRuns(db, activeRuns);
  const activeEvents = activeRun ? liveRunEvents(db, activeRun.id) : [];
  const alreadyPosted = activeRun ? thread.agentCommentsOf(activeRun.id).length > 0 : false;

  // Glued back together before being read, not chunk by chunk: a message
  // arrives in pieces, and no single piece is parseable JSON.
  const liveOutput = alreadyPosted
    ? ""
    : liveMessageOf(
        activeEvents
          .filter((event) => event.type === "output")
          .map((event) => (event.payload as { text?: unknown } | null)?.text)
          .filter((text): text is string => typeof text === "string"),
      );
  const liveActivity = activeEvents
    .flatMap((event) => {
      if (event.type === "file_edit") {
        const path = (event.payload as { path?: unknown } | null)?.path;
        return typeof path === "string" ? [`Edited ${path}`] : [];
      }
      if (event.type === "tool_call") {
        const name = (event.payload as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [`Used ${name}`] : [];
      }
      return [];
    })
    .slice(-4);

  // The page this view carries: everything, or — in a room that pages its
  // history — the newest messages before `before` (the oldest one the
  // window already has), so a long thread is not mapped whole on every
  // refresh. Only the page is mapped; what decides which cards and
  // questions are still live is read from the whole thread above.
  const inOrder = comments;
  const cutAt = page_?.before === undefined ? -1 : inOrder.findIndex((comment) => comment.id === page_.before);
  // A page asked for before a message the thread does not hold is an
  // empty page, not the newest one again under a wrong count.
  const upTo = page_?.before === undefined ? inOrder : cutAt === -1 ? [] : inOrder.slice(0, cutAt);
  const limit = page_?.limit ?? (kind.pagesHistory ? HISTORY_PAGE : Infinity);
  const page = upTo.length > limit ? upTo.slice(upTo.length - limit) : upTo;
  // Anchored over the whole thread, then read for the page: a turn whose
  // replies straddle a page edge folds once, above its first reply, on
  // whichever page that falls.
  const turns = kind.drawsTurns ? turnSummaries(db, conversation.id, inOrder, new Set(page.map((comment) => comment.id as string))) : new Map<string, NonNullable<DiscussionMessage["turn"]>>();

  return {
    id: conversation.id,
    key: conversation.key,
    startedAt: conversation.createdAt,
    closedAt: conversation.archivedAt,
    thinking: activeRun !== undefined,
    thinkingSince: activeRun?.startedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    liveOutput,
    liveActivity,
    liveTurn: kind.drawsTurns && activeRun && !alreadyPosted ? liveTurnOf(activeRun.id, activeRun.startedAt ?? null, activeEvents) : null,
    settings: settingsFor(db, conversation, kind),
    messages: page.map(toMessage),
    earlier: upTo.length - page.length,
  };

  function toMessage(comment: Comment): DiscussionMessage {
    return {
      id: comment.id,
      authorType: comment.authorType,
      authorName:
        comment.authorType === "human"
          ? "You"
          : comment.authorType === "engine"
            ? "EO"
            : // A module can be told to comment on any key, a feature's
              // included (EO-75), so this view has to name one. Without
              // the branch it fell through to `fallbackName` and a
              // module's note was signed "Product owner".
              comment.authorType === "module"
              ? "A module"
              : ((comment.authorId ? agentsById.get(comment.authorId)?.name : undefined) ?? kind.fallbackName),
      body: comment.body,
      attachments: (comment.attachments ?? []).flatMap((attachment) =>
        attachment.id && attachment.itemId && attachment.commentId
          ? [{ id: attachment.id, itemId: attachment.itemId, commentId: attachment.commentId, kind: attachment.kind, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }]
          : [],
      ),
      kind: comment.kind,
      parentId: comment.parentId,
      // The turn that posted it. What lets the card group questions by
      // the batch they were asked in (EO-338) rather than pooling every
      // question the thread ever held into one block.
      runId: comment.runId,
      options: comment.options ?? null,
      canAnswer: answerable.has(comment.id),
      createdAt: comment.createdAt,
      canApprove: approvable.has(comment.id),
      approves: approvable.has(comment.id) ? kind.approves(db, conversation, comment, thread) : null,
      proposedType: approvable.has(comment.id) ? kind.proposedType(db, conversation, comment, thread) : null,
      ...moduleCardOf(db, conversation, kind, comment, thread),
      moduleChange: kind.moduleChange?.(db, conversation, comment, thread) ?? null,
      card: kind.card?.(db, conversation, comment, thread) ?? null,
      approvalWithdrawn: kind.approvalWithdrawn?.(db, conversation, comment, thread) ?? null,
      proposal: proposalOf(db, conversation, kind, comment, thread, approvable),
      status:
        comment.authorType === "human" && listMentionsForComment(db, comment.id).some((mention) => mention.status === "open")
          ? activeRun?.initiationId === comment.id
            ? "processing"
            : "queued"
          : null,
      turn: turns.get(comment.id) ?? null,
    };
  }
}

/**
 * The stored events of each run a view has drawn while it ran, oldest
 * first (EO-552).
 *
 * A chat is drawn again on every push while its turn streams, and one
 * turn can be thousands of events and megabytes of payload — reading it
 * whole each time was the run read again per event. `run_events` is
 * append-only (invariant #3), so what was read stays true: each view
 * reads only the events after the last one held.
 *
 * Only an unbroken run of sequences from 0 is held. A sequence missing
 * from the middle — a sync from another machine landing out of order —
 * would be skipped for ever by a reader that only looks past the end, so
 * whatever lies beyond a gap is read again each time, as the whole run
 * used to be, until the gap fills.
 *
 * Kept only while the run is live: a view forgets every run no longer
 * running (`forgetEndedRuns`), and the cap is the backstop for runs
 * nobody draws again. Per database, since a run id names a run in one.
 */
const liveEventsByDb = new WeakMap<Db, Map<string, RunEvent[]>>();

function liveEventsOf(db: Db): Map<string, RunEvent[]> {
  let held = liveEventsByDb.get(db);
  if (!held) liveEventsByDb.set(db, (held = new Map()));
  return held;
}

/** How many runs' events `liveEvents` holds at most. Concurrency is 1 (invariant 10); this is room to spare, not a working set. */
export const LIVE_EVENT_RUNS = 8;

/** Every stored event of this live run, reading only those after what was already held. */
function liveRunEvents(db: Db, runId: Uuid): RunEvent[] {
  const liveEvents = liveEventsOf(db);
  const held = liveEvents.get(runId) ?? [];
  const fresh = listRunEventsAfter(db, runId, held.length - 1);
  let contiguous = 0;
  while (contiguous < fresh.length && fresh[contiguous]!.seq === held.length + contiguous) contiguous += 1;
  const kept = contiguous === 0 ? held : held.concat(fresh.slice(0, contiguous));
  liveEvents.delete(runId);
  liveEvents.set(runId, kept);
  while (liveEvents.size > LIVE_EVENT_RUNS) liveEvents.delete(liveEvents.keys().next().value!);
  return contiguous === fresh.length ? kept : kept.concat(fresh.slice(contiguous));
}

/** Lets go of every held run that is no longer running. */
function forgetEndedRuns(db: Db, active: readonly { id: string }[]): void {
  const liveEvents = liveEventsOf(db);
  if (liveEvents.size === 0) return;
  const running = new Set(active.map((run) => run.id));
  for (const runId of [...liveEvents.keys()]) if (!running.has(runId)) liveEvents.delete(runId);
}

/** How many runs' events are held, for a test. */
export function heldLiveRuns(db: Db): number {
  return liveEventsOf(db).size;
}

/**
 * The running turn as Claude Desktop draws it: every step stored so far,
 * then the blocks still being written (`liveDrafts`).
 *
 * The drafts are asked for against what the database holds now, so a
 * block whose finished event is still in the supervisor's write buffer is
 * drawn as its draft until the row lands — the words never blink out
 * between being a draft and being a step.
 */
function liveTurnOf(runId: Uuid, startedAt: number | null, events: readonly RunEvent[]): LiveTurn {
  return {
    runId,
    startedAt,
    steps: turnStepsOf(events),
    // The highest sequence stored is the last of the events just read:
    // they are every stored event of the run, in sequence order.
    drafts: liveDrafts.snapshot(runId, events.at(-1)?.seq ?? -1),
    lastDraftId: liveDrafts.lastId(runId),
    answer: storedAnswer(events),
  };
}

/**
 * The answer's message as far as it is stored, before the comment lands.
 *
 * Both backends' ways of answering (invariant 12): Claude calls the
 * structured-output tool, and Codex writes the answer's JSON as its last
 * message. Without the second, a Codex answer vanished from the screen
 * between its draft being stored and its comment being posted.
 */
function storedAnswer(events: readonly RunEvent[]): string {
  const answerArgs = answerArgsOf(events);
  if (answerArgs !== undefined) return liveMessageOf([JSON.stringify(answerArgs)]);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type !== "output") continue;
    const text = (event.payload as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    const body = text.trim().replace(/^```(?:json)?\s*/i, "");
    return body.startsWith("{") ? liveMessageOf([text]) : "";
  }
  return "";
}

/**
 * The steps one run took, for a finished turn's fold (`runs:steps`).
 *
 * A run that is still going is read the same way, which is what the live
 * turn above is made of; nothing here knows the difference.
 */
export function runSteps(db: Db, runId: string): TurnStep[] {
  return turnStepsOf(listRunEvents(db, runId as Uuid));
}

/**
 * A running run's words not yet stored, for a step's transcript
 * (`runs:live`); null once it has ended.
 *
 * Drafts only. The transcript reads the run's stored events itself, and
 * asks this again each time one arrives — so reading every event here to
 * build steps nobody draws would be the whole run, read again, per event.
 */
export function runLiveTurn(db: Db, runId: string): LiveTurn | null {
  const run = getRun(db, runId as Uuid);
  if (!run || run.status !== "running") return null;
  return {
    runId: run.id,
    startedAt: run.startedAt,
    steps: [],
    drafts: liveDrafts.snapshot(run.id, highestRunEventSeq(db, run.id)),
    lastDraftId: liveDrafts.lastId(run.id),
    answer: "",
  };
}

/**
 * What a finished run did, counted once: a run that has ended cannot do
 * any more, so its line is kept rather than counted again on every
 * refresh of the chat — which happens on every push while another turn
 * streams.
 *
 * The most recently drawn `FINISHED_TURNS` of them (EO-552), not every
 * run any chat has ever shown: the process lives for weeks, and a line
 * that fell out is counted again — one query — the next time its turn is
 * on screen.
 */
const finishedTurns = new Map<string, Omit<NonNullable<DiscussionMessage["turn"]>, "runId">>();

/** How many finished turns' lines are kept. Two pages of a long chat. */
export const FINISHED_TURNS = 200;

/** A kept line, marked as the most recently used. */
function finishedTurn(runId: string): Omit<NonNullable<DiscussionMessage["turn"]>, "runId"> | undefined {
  const line = finishedTurns.get(runId);
  if (line === undefined) return undefined;
  finishedTurns.delete(runId);
  finishedTurns.set(runId, line);
  return line;
}

function keepFinishedTurn(runId: string, line: Omit<NonNullable<DiscussionMessage["turn"]>, "runId">): void {
  finishedTurns.delete(runId);
  finishedTurns.set(runId, line);
  while (finishedTurns.size > FINISHED_TURNS) finishedTurns.delete(finishedTurns.keys().next().value!);
}

/** How many finished turns' lines are kept, for a test. */
export function keptFinishedTurns(): number {
  return finishedTurns.size;
}

/**
 * The line each finished turn is folded behind, keyed by the message it
 * is drawn above: the turn's first reply — or, for a turn that never
 * replied because a person stopped it, the engine's "Turn stopped.",
 * which is where its partial work is found again.
 *
 * Only runs that did something worth a line: a turn that answered
 * straight away has nothing to fold, and a line reading "Worked for 3s"
 * over every short reply is noise.
 */
function turnSummaries(db: Db, conversationId: Uuid, comments: readonly Comment[], onPage: ReadonlySet<string>): Map<string, NonNullable<DiscussionMessage["turn"]>> {
  const replyByRun = new Map<string, Comment>();
  const stoppedByRun = new Map<string, Comment>();
  for (const comment of [...comments].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))) {
    if (comment.runId === null) continue;
    if (comment.authorType === "agent" && !replyByRun.has(comment.runId)) replyByRun.set(comment.runId, comment);
    if (comment.authorType === "engine" && comment.body.startsWith(TURN_STOPPED) && !stoppedByRun.has(comment.runId)) stoppedByRun.set(comment.runId, comment);
  }
  const anchors = new Map<string, Comment>(stoppedByRun);
  for (const [runId, reply] of replyByRun) anchors.set(runId, reply);
  for (const [runId, anchor] of anchors) if (!onPage.has(anchor.id)) anchors.delete(runId);
  if (anchors.size === 0) return new Map();

  // Every kept line taken out first: counting the rest keeps new lines,
  // and with the cache full that lets go of the oldest — which must not
  // be one this view was about to answer from.
  const kept = new Map<string, Omit<NonNullable<DiscussionMessage["turn"]>, "runId">>();
  for (const runId of anchors.keys()) {
    const line = finishedTurn(runId);
    if (line) kept.set(runId, line);
  }
  const uncounted = [...anchors.keys()].filter((runId) => !kept.has(runId));
  // Read only when some run still has to be counted: a chat whose turns
  // have all finished is answered from the cache, with no query at all.
  const runs = uncounted.length === 0 ? new Map<string, ReturnType<typeof listRunsForItem>[number]>() : new Map(listRunsForItem(db, conversationId).map((run) => [run.id as string, run]));
  const counts = countRunActivity(db, uncounted as Uuid[]);
  const summaries = new Map<string, NonNullable<DiscussionMessage["turn"]>>();
  for (const [runId, comment] of anchors) {
    let line = kept.get(runId);
    if (!line) {
      const count = counts.get(runId) ?? { toolCalls: 0, filesEdited: 0, reasoned: false };
      const run = runs.get(runId);
      const durationMs = run?.startedAt != null && run.endedAt != null ? Math.max(0, run.endedAt - run.startedAt) : null;
      line = { durationMs, ...count };
      if (run?.endedAt != null) keepFinishedTurn(runId, line);
    }
    if (line.toolCalls === 0 && line.filesEdited === 0 && !line.reasoned && !comment.body.startsWith(TURN_STOPPED)) continue;
    summaries.set(comment.id, { runId, ...line });
  }
  return summaries;
}

/** What the engine posts under a turn a person stopped (`stopAssistTurn`). */
export const TURN_STOPPED = TURN_STOPPED_NOTE;
