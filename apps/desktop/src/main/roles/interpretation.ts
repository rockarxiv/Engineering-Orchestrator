import {
  InterpretOutputSchema,
  INTERPRET_ACTION,
  isDispatchable,
  parsedResultOf,
  type Agent,
  type Comment,
  type InterpretOutput,
  type Run,
  type Item,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getComment, getRun, listAgents, listRunsForItem, postComment, stepForItem } from "../db/repos/index.js";
import { newestAnswerToLastAsk } from "./answers.js";
import { isStandInReply, standInAgentIds } from "../trials/onBehalf.js";

/**
 * Handing a free-text reply to the system agent (EO-184).
 *
 * A builtin or a module that stops and asks hears the answer by finding
 * a matching comment in the thread. Click one of the buttons it offered
 * and that works. Type a sentence and nothing understands it: the step
 * re-runs from the top, hand-parses the thread with a matcher its author
 * wrote, finds nothing, and asks the identical question again.
 *
 * So the sentence goes to the one agent that can read it, and what comes
 * back is either an answer the step can use — posted where the step
 * already looks — or a report of what the agent did instead.
 *
 * The cost argument, which is the reason this is not simply "run an
 * agent": `builtins.ts` argues that non-agent steps are deliberately not
 * agents, because there is no judgement in `git worktree add` and paying
 * a model for it adds a way to go wrong and nothing that can go right.
 * That still holds for the *work*. It does not hold for reading the
 * reply, which is the only part of this with judgement in it — and a
 * reply that matches an offered option verbatim is not even that, so it
 * never reaches here.
 */

/** The role EO-181 gives the agent that reads a reply for a step. */
const SYSTEM_ROLE = "system";

/**
 * The agent an interpretation is dispatched to.
 *
 * The same row Discussions and the architect panel resolve, by the same
 * rule (EO-181) — first enabled agent holding the role. Disabled, or
 * absent because somebody deleted it, means no interpretation happens
 * and the reply takes the path it took before this existed: the step
 * runs again and asks again. Nothing is dropped, so nothing has to be
 * said (invariant #8).
 */
function systemAgent(db: Db): Agent | undefined {
  return listAgents(db).find((agent) => agent.role === SYSTEM_ROLE && isDispatchable(agent));
}

/** A reply waiting to be read for a step, and who will read it. */
export interface PendingInterpretation {
  /** The person's comment. Also the run's initiation id, which is what makes it once-only. */
  commentId: Uuid;
  agentId: Uuid;
}

/**
 * Should this reply be handed to the system agent rather than to the
 * step that asked?
 *
 * **The single decision.** `resumeItemHeld` asks it to decide whether
 * to re-run the parked step or leave the item parked, and
 * `findPendingInterpretations` asks it to decide whether to dispatch —
 * so a version of this in each of them could disagree, and the
 * disagreement is an item that parks forever with nothing dispatched
 * for it.
 *
 * Three things have to hold, and each of them is a "no" that costs
 * nothing:
 *
 * - **The reply is a sentence, not a button.** A reply equal to one of
 *   the options the ask carried — normalised the way `unwrapAnswer`
 *   normalises everything else — is what the step already understands.
 *   No model call, no cost, and the behaviour of a button press is
 *   exactly what it was.
 * - **A person wrote it.** The newest answer can be the system agent's
 *   own reading, filed under the reply it read (EO-183). Reading *that*
 *   would be the agent interpreting itself.
 * - **It has not been interpreted before.** One interpret run per reply
 *   comment id, whatever came of it. This is what stops an
 *   interpret-then-refuse loop: if the step will not take the reading,
 *   it asks again and waits for a person, rather than paying for a
 *   second opinion on the same sentence.
 */
export function pendingInterpretation(db: Db, item: Item, parkedRun: Run, enabled: boolean): PendingInterpretation | null {
  if (!enabled) return null;
  // Only a step that runs EO's own code, and only while the item is
  // still on the one that parked. An agent step has its own thread and
  // its own way of hearing a reply; an item somebody has moved is not
  // waiting on this question any more.
  if (parkedRun.agentId !== null) return null;
  const step = stepForItem(db, item);
  if (step === undefined || (step.type !== "builtin" && step.type !== "module")) return null;
  if (step.entryAction !== parkedRun.action) return null;

  const newest = newestAnswerToLastAsk(db, item.id);
  if (newest === null || newest.matched !== null) return null;
  if (newest.comment.authorType !== "human") return null;
  if (interpretationOf(db, item.id, newest.comment.id) !== undefined) return null;

  const agent = systemAgent(db);
  return agent === undefined ? null : { commentId: newest.comment.id, agentId: agent.id };
}

/** The interpret run dispatched for this reply, whatever became of it. */
function interpretationOf(db: Db, itemId: Uuid, commentId: Uuid): Run | undefined {
  return listRunsForItem(db, itemId).find((run) => run.action === INTERPRET_ACTION && run.initiationId === commentId);
}

/**
 * What an interpretation decided, or null where the run has none.
 *
 * Read off the validated half of the result (ARCHITECTURE.md, "A run"), so a run that failed
 * validation, was cancelled, or asked the person a question of its own
 * has decided nothing — and a caller asking "should the step run again?"
 * gets `false` rather than a guess.
 */
function outcomeOf(run: Run): InterpretOutput | null {
  if (run.status !== "succeeded" || run.result === null) return null;
  const parsed = InterpretOutputSchema.safeParse(parsedResultOf(run.result));
  return parsed.success ? parsed.data : null;
}

/**
 * Does this interpretation ask for the parked step to be run again?
 *
 * `answered` always does — the answer it posted is only worth posting if
 * something reads it. `acted` says for itself: the agent may have
 * cleared the obstacle, in which case running again is the whole point,
 * or it may have moved the work itself, in which case running the step
 * again would undo or duplicate what it just did. `unusable` never does:
 * the reply could not be read, and re-running would produce the same
 * question the person has already answered once.
 */
function resumesTheStep(outcome: InterpretOutput): boolean {
  if (outcome.status === "answered") return true;
  return outcome.status === "acted" && outcome.retry;
}

/**
 * Which replies on this item the interpreter has taken off the step's
 * hands, and which of its own comments hand the item back.
 *
 * Both halves are what `deferredReplyItemIds` needs to stop treating a
 * reply as unread work for the step. The scheduler offers a parked
 * item to `resumeItem` while a human comment sits newer than the run
 * that parked, and re-running the step is how that offer is normally
 * consumed. An interpretation consumes it instead — so without this the
 * scheduler would re-run the very step the interpretation was dispatched
 * *rather than* running, on every tick, forever.
 */
export interface InterpretationsOnItem {
  /** Reply comment ids an interpretation has already read. */
  read: Set<string>;
  /** Ids of interpret runs whose outcome asks for the step to run again. */
  resuming: Set<string>;
  /**
   * The agents whose answer on this item is the person's (EO-585): the
   * system agent on a trial item, none anywhere else. See `isStandInReply`.
   */
  standIns?: ReadonlySet<string>;
}

export function interpretationsOn(db: Db, itemId: Uuid): InterpretationsOnItem {
  const read = new Set<string>();
  const resuming = new Set<string>();
  for (const run of listRunsForItem(db, itemId)) {
    if (run.action !== INTERPRET_ACTION) continue;
    const outcome = outcomeOf(run);
    // A run that decided nothing has read nothing: a failed or cancelled
    // interpretation must hand the reply back to the step, which is
    // exactly the behaviour that existed before this feature.
    if (outcome === null) continue;
    if (run.initiationId !== null) read.add(run.initiationId);
    if (resumesTheStep(outcome)) resuming.add(run.id);
  }
  return { read, resuming, standIns: standInAgentIds(db, itemId) };
}

/**
 * Is this comment still waiting to be read by the step that asked?
 *
 * The question `deferredReplyItemIds` is really asking, now that a
 * reply has two possible readers. A person's reply is waiting unless the
 * interpreter has it — either already read (above) or about to be, which
 * is what `pending` carries. An agent's comment is waiting only when it
 * is an interpretation that asked for the step to run again; every other
 * comment an agent writes on a parked item is commentary.
 */
const NOBODY: ReadonlySet<string> = new Set();

export function awaitsTheStep(comment: Comment, state: InterpretationsOnItem, pending: PendingInterpretation | null): boolean {
  // An output is a deliverable, not a reply (EO-298). A person editing
  // what the ticket produced has corrected a document; they have not
  // answered the question the step parked on, and resuming the run on
  // the strength of it would run the step against a reply nobody made.
  // It says so with silence rather than with an interpretation, because
  // there is no sentence here for anybody to read.
  if (comment.kind === "output") return false;
  // A person's reply — or the system agent's in their place on a trial
  // item (EO-585), which the step reads exactly as it would theirs.
  if (comment.authorType === "human" || isStandInReply(comment, state.standIns ?? NOBODY)) {
    return comment.id !== pending?.commentId && !state.read.has(comment.id);
  }
  return comment.runId !== null && state.resuming.has(comment.runId);
}

/**
 * Every word an interpretation writes is the model's, so none of it
 * opens a mention.
 *
 * `postComment` parses `@name` out of a body by default, and a mention
 * is not decoration: an open one is the scheduler's second entry point,
 * so it dispatches a run. Every string this file posts comes from the
 * model — the answer it chose, the summary of what it did, the problem
 * it reports — which would make "I asked @implementer to look" a
 * dispatch rather than a sentence, on an item the interpretation may
 * have just decided to leave parked.
 *
 * False everywhere here, not only where a stray `@` seems likely. The
 * distinction that matters is *who wrote the text*, not what it happens
 * to say today: a person's `@` is an address, and generated prose that
 * looks like one is a coincidence EO must not act on. Mentions this file
 * does intend are passed explicitly in `mentions`, which this does not
 * touch.
 */
const NOT_AN_ADDRESS_BOOK = false;

/**
 * What an interpretation leaves in the thread (EO-184).
 *
 * Called from `onRunSucceeded`, so everything here is a comment and
 * nothing here is a transition: an interpretation is not a stage, it
 * moves no item, and `resultKeyFor` returns null for it. Whether the
 * step then runs again is decided from the same result by the
 * supervisor, once this run has ended and given the item back —
 * invariant #9 holds either way, because the run is over before anything
 * resumes.
 */
export function postInterpretation(db: Db, item: Item, agentId: Uuid, runId: Uuid, parsedResult: unknown): void {
  const parsed = InterpretOutputSchema.safeParse(parsedResult);
  // A-02 validated this before the supervisor asked, so an unreadable
  // result means something is wrong upstream. Saying so beats silence:
  // the person replied and is owed an account of what came of it.
  if (!parsed.success) {
    postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "agent", agentId },
      kind: "escalation",
      body: "I read your reply but could not put my reading of it in a usable shape, so nothing has been done with it. Answer again, or use one of the options above.",
      mentions: [{ type: "human" }],
      parseBodyMentions: NOT_AN_ADDRESS_BOOK,
    });
    return;
  }

  const outcome = parsed.data;

  if (outcome.status === "answered") {
    // Threaded under the person's own reply, which is what makes it
    // visible to a waiting step: `answersSinceLastAsk` counts a system
    // agent's comment as an answer only when it is filed under one
    // (EO-183). The body is the answer and nothing else — a step matches
    // it against what it offered, and a sentence of explanation wrapped
    // around it is exactly what would make that match fail.
    const decision = postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "agent", agentId },
      parentId: replyBeingRead(db, item.id, runId),
      kind: "decision",
      body: outcome.answer,
      parseBodyMentions: NOT_AN_ADDRESS_BOOK,
    });

    // The reasoning, if there was any, filed under the answer rather
    // than beside it. Under the *person's* comment it would be read as a
    // second, newer answer — and "newest wins" would then hand the step
    // an explanation instead of the answer it is waiting for.
    if (outcome.note !== undefined && outcome.note.trim() !== "") {
      postComment(db, {
        itemId: item.id,
        runId,
        author: { type: "agent", agentId },
        parentId: decision.id,
        kind: "note",
        body: outcome.note,
        parseBodyMentions: NOT_AN_ADDRESS_BOOK,
      });
    }
    return;
  }

  if (outcome.status === "acted") {
    // Deliberately not threaded under the reply: this is not an answer
    // to the step's question, and a step reading it as one would act on
    // a summary of work instead of on a choice it offered.
    postComment(db, {
      itemId: item.id,
      runId,
      author: { type: "agent", agentId },
      kind: "note",
      body: outcome.retry
        ? `${outcome.summary}\n\nRunning "${stepName(db, item)}" again.`
        : `${outcome.summary}\n\nNot running "${stepName(db, item)}" again — reply if you want it retried.`,
      parseBodyMentions: NOT_AN_ADDRESS_BOOK,
    });
    return;
  }

  // Nothing was dropped on the floor: the reply could not be read, and
  // the person is told so and asked again (invariant #8). An escalation
  // rather than a note, because this is a question — and the run has
  // already ended, so nothing is being held open for the answer
  // (invariant #9).
  postComment(db, {
    itemId: item.id,
    runId,
    author: { type: "agent", agentId },
    kind: "escalation",
    body: `I could not use your reply for this: ${outcome.problem}`,
    // The person is still mentioned — this is a question addressed to
    // them, and an explicit mention is passed beside the body rather
    // than parsed out of it, so the rule above takes nothing away.
    mentions: [{ type: "human" }],
    parseBodyMentions: NOT_AN_ADDRESS_BOOK,
  });
}

/**
 * The comment this run was dispatched to read.
 *
 * The run's own initiation id, which `findPendingInterpretations` set to
 * the reply. Read back off the row rather than searched for again, so
 * the answer is filed under the comment that was actually interpreted
 * even if somebody has said something else in the meantime.
 *
 * Checked rather than trusted, because an initiation id is not always a
 * comment: every other path that mints one can put a synthetic string
 * there (`reauthorized:<run>`), and an id naming no row would fail the
 * `comments.parent_id` foreign key — turning a good reading into a
 * thrown error on the way to the thread. It also has to be a *person's*
 * comment on this item, since that is the only thing a waiting step
 * counts an answer as being filed under (EO-183).
 */
function replyBeingRead(db: Db, itemId: Uuid, runId: Uuid): Uuid | null {
  const initiation = getRun(db, runId)?.initiationId;
  const named = initiation == null ? undefined : getComment(db, initiation as Uuid);
  if (named && named.itemId === itemId && named.authorType === "human") return named.id;

  // Defensive: nothing usable on the row, so fall back to the reply this
  // would have been dispatched for. An unparented comment is still
  // better than no comment, even though no step will read it as an
  // answer.
  const newest = newestAnswerToLastAsk(db, itemId)?.comment;
  return newest?.authorType === "human" ? newest.id : null;
}

/** What the step is called, for a sentence about it. */
function stepName(db: Db, item: Item): string {
  const step = stepForItem(db, item);
  return step?.name ?? "this step";
}
