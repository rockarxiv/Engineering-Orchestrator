import { isThreadPerConversationAction, UNSCOPED_RUN, type Agent, type Run, type Uuid } from "@eo/core";
import { agentAttachmentsHash, EMPTY_ATTACHMENTS_HASH } from "../agentAttachments/fingerprint.js";
import type { Db } from "../db/client.js";
import { getItem, listRunsForItem } from "../db/repos/index.js";
import { promptHash } from "../roles/prompts.js";
import { skillRunScope } from "./workspaceResolution.js";

/**
 * What this dispatch is about to do, as far as thread reuse cares.
 *
 * An object rather than positional arguments because two of the three
 * are strings and transposing them would compile.
 */
export interface ThreadReuseQuery {
  itemId: Uuid;
  /** The agent as it is configured *now* — its provider and instructions are what a candidate is measured against. */
  agent: Agent;
  /**
   * The working directory this dispatch has already prepared.
   *
   * Part of the question rather than something read back off the prior
   * run: a Claude session only resumes from the cwd it started in, so a
   * thread born somewhere else is not resumable here however similar the
   * two look.
   */
  cwd: string;
}

/**
 * Whether there is a thread to resume, and when there is not, why not.
 *
 * Every outcome that is not a resume carries a sentence — there is no
 * silent "no" (invariant #8). The two no-resume outcomes are told apart
 * by kind rather than by a null, because they ask different things of
 * the caller:
 *
 * - `refused` — a thread existed and EO chose not to carry it over. The
 *   item has just paid for a full context assembly it might have been
 *   spared, and nobody can see why from the board. This is the reason a
 *   caller posts.
 * - `no-thread` — there was no thread to carry over in the first place:
 *   this agent has not run on this item, or its only runs are
 *   placeholders, dry runs, or still in flight. The sentence says which,
 *   so a caller that wants to log or surface it can, but it is describing
 *   EO doing the ordinary thing — posting it would put an engine comment
 *   on every item's first dispatch.
 *
 * A caller that genuinely wants a comment on every refusal without
 * exception can post `reason` from both; the split is there so that the
 * common path can stay quiet without the decision itself going silent.
 */
export type ThreadReuse =
  | { kind: "resume"; run: Run }
  | { kind: "refused"; reason: string }
  | { kind: "no-thread"; reason: string };

/** Neither backend can be handed a session that was never opened. */
function isGuardPlaceholder(run: Run): boolean {
  return run.status === "awaiting_input" && run.threadId === null;
}

/**
 * Why this run of the agent's is not even a candidate — no thread of the
 * item's history sits behind it — or null if it is one.
 *
 * Separate from `refusalFor` below because the two answer different
 * questions. Here nothing was refused: there is no conversation to weigh
 * up. Everything in `refusalFor` is a real thread EO decided against.
 *
 * Ordered most-specific-first so that a row matching two rules is
 * described by the one a person would recognise it as: a live dry run
 * reads as still running, and a guard placeholder reads as the guard
 * rather than as a run that never got a session.
 */
function notACandidate(run: Run, agent: Agent, lostThreads: ReadonlySet<string>): string | null {
  // A conversation the backend has already said it does not have
  // (EO-93). First, because it is the one exclusion that is about this
  // particular thread rather than about the shape of the run holding it:
  // a person told that the last run was still running would go looking
  // for a live run, and find one whose session was cleaned up.
  //
  // Keyed on the thread id and not on the run, so the *older* runs
  // sharing that id are excluded too. Missing that is the whole bug: the
  // marked run is skipped, the one before it offers the same dead id,
  // and the resume fails again on every dispatch until the attempt limit
  // refuses the item for a reason that has nothing to do with the work.
  if (run.threadId !== null && lostThreads.has(run.threadId)) {
    return (
      `The conversation behind ${agent.name}'s last run on this ticket was no longer on the backend when EO tried ` +
      `to continue it — provider sessions are stored outside EO and can be cleaned up — so there is nothing to ` +
      `carry over. This run assembles the full context instead.`
    );
  }

  // A live run is still talking into its own thread. A fresh dispatch
  // joining in would put two runs in one conversation, each answering
  // prompts it cannot see the other half of. (`queued` needs no clause:
  // a run is created without a thread and only records one once the
  // provider emits `thread_started`, by which point it is `running`.)
  if (run.status === "running") {
    return (
      `${agent.name}'s last run on this ticket is still running, and a live run is still talking into its own ` +
      `conversation — a second run joining it would leave both answering half a thread. This run assembles the ` +
      `full context instead.`
    );
  }

  // Somebody ran that to watch it work. Its conversation is not the
  // item's history, and resuming it would quietly make it so.
  if (run.dryRun) {
    return (
      `${agent.name}'s last run on this ticket was a dry run. A dry run's conversation isn't the ticket's history, ` +
      `so it isn't carried over — this run assembles the full context instead.`
    );
  }

  // The attempt-limit guard refuses before any provider is reached, so
  // the row it leaves has no session behind it at all.
  if (isGuardPlaceholder(run)) {
    return (
      `${agent.name}'s last run on this ticket was refused by the attempt-limit guard before any backend was ` +
      `reached, so no conversation was ever started — this run assembles the full context instead.`
    );
  }

  // A parked run belongs to `resumeItem`: the person's reply is what
  // continues it, and that reply is the next thing its thread will hear.
  if (run.status === "awaiting_input") {
    return (
      `${agent.name}'s last run on this ticket is parked waiting on a reply, and that conversation belongs to the ` +
      `reply that unparks it — a fresh dispatch doesn't join it. This run assembles the full context instead.`
    );
  }

  // Anything else with no thread ended before a backend answered.
  if (run.threadId === null) {
    return (
      `${agent.name}'s last run on this ticket never opened a provider session — it ended before a backend ` +
      `answered — so there is no conversation to carry over. This run assembles the full context instead.`
    );
  }

  return null;
}

/** Nothing of this agent's has ever run here. The ordinary case, and still an answer. */
function neverRan(agent: Agent): string {
  return (
    `${agent.name} hasn't run on this ticket before, so there is no conversation to carry over — this run ` +
    `assembles the full context.`
  );
}

/**
 * Why this otherwise-eligible run's thread cannot be carried over, or
 * null if it can.
 *
 * Ordered by how much each answer invalidates: a backend that cannot
 * open the session at all makes what the session was told beside the
 * point, so the provider questions are asked first and only one reason
 * is ever produced for a run. Which matters — this string is posted, and
 * a person reading three refusals for one thread learns less than they
 * do from the first.
 */
function refusalFor(run: Run, agent: Agent, cwd: string, wantedHash: string, wantedAttachments: string): string | null {
  // A row predating A-07 recorded no backend at all. `resumeBlockedReason`
  // trusts one of these and resumes it, because there a person is waiting
  // on a reply and a wrong guess costs them their answer. Here the whole
  // prize is tokens, so an unknown backend is refused for the reason an
  // unrecorded prompt is: nothing is known, and nothing known is not the
  // same as a match. Said separately rather than folded in below, which
  // would post a comment about the "null" backend.
  if (run.provider === null) {
    return (
      `EO has no record of which backend issued the thread from ${agent.name}'s last run on this ticket — that run ` +
      `predates EO recording it — so there is no telling whether "${agent.provider}" could open it at all. ` +
      `The conversation couldn't be carried over; starting a fresh run instead.`
    );
  }

  // A session id means nothing outside the provider that issued it —
  // hand a Codex thread to the Claude CLI and it answers "No
  // conversation found with session ID". `resumeBlockedReason` in
  // runSupervisor says this on the human-reply path; the two sit on the
  // same board and must not contradict each other about what happened.
  if (run.provider !== agent.provider) {
    return (
      `${agent.name}'s last run on this ticket used the "${run.provider}" backend, and it now uses "${agent.provider}". ` +
      `A provider session can't be moved between backends, so the conversation couldn't be carried over — ` +
      `starting a fresh run instead. Nothing is lost: the new run is given the newest word from every step and everything you have said since, and can search the rest of the thread.`
    );
  }

  // Null is the absence of an answer, never a match: a run written
  // before EO recorded what it was handed (EO-87) says nothing about
  // its instructions, and "nothing is known" is not "they are the same".
  if (run.instructionsHash === null) {
    return (
      `EO has no record of the instructions ${agent.name}'s last run on this ticket was given — that run predates ` +
      `EO recording them — so there is no way to tell whether they still match. The conversation couldn't be carried ` +
      `over; this ticket starts fresh, on the instructions the agent has now.`
    );
  }

  // Neither backend re-sends instructions on resume: Claude's resume()
  // never re-sends systemPrompt, and Codex keeps the `baseInstructions`
  // its thread was started with (EO-385 — it would take different ones
  // on `thread/resume`, but only for that one turn, measured at 0.161.0,
  // so sending them is not a way to change a thread's mind). A reused
  // thread would therefore keep the role prompt it was born with, and
  // editing an agent's instructions would silently do nothing to every
  // item already in flight.
  if (run.instructionsHash !== wantedHash) {
    return (
      `${agent.name}'s instructions have changed since its last run on this ticket. A provider session keeps the ` +
      `instructions it was started with, so the conversation couldn't be carried over — this ticket is starting ` +
      `fresh, which is how it picks the new instructions up.`
    );
  }

  // The same rule as the two above, about the other half of what a
  // session is opened with (EO-106). Neither backend re-sends
  // configuration on resume any more than it re-sends instructions:
  // Claude's `mcpServers` and `plugins` are command-line arguments to the
  // process that started the session, and Codex's servers are in the
  // config object its opening invocation carried. So a reused thread
  // keeps the servers and skills it was born with, and attaching a
  // GitHub server to an agent mid-item would appear to work while
  // changing nothing at all — silently, until the thread happened to end.
  //
  // Null is where this parts company with `instructionsHash` above, and
  // the difference is a fact rather than a preference. Instructions
  // always existed, so a row that recorded none is a row with a gap in
  // it, and a gap is never a match. Nothing could be attached before
  // migration 0052 existed, so a row predating it is not missing an
  // answer — its thread was born with an empty tool surface, and that is
  // what it is read as. The consequence is worth stating plainly: a
  // dispatch that forgot to record this reads as "nothing was attached",
  // which is a refusal for any agent that has something attached, and a
  // resume only for one that has nothing. Both are the truthful answer
  // for a thread that predates the column.
  if ((run.agentAttachmentsHash ?? EMPTY_ATTACHMENTS_HASH) !== wantedAttachments) {
    return (
      `The MCP servers or skills attached to ${agent.name} have changed since its last run on this ticket. A ` +
      `provider session keeps the tools it was started with, so the conversation couldn't be carried over — this ` +
      `ticket is starting fresh, which is how it picks the new ones up.`
    );
  }

  // Correctness rather than caution, even though the git kind gives
  // every action on an item the same directory in practice: a Claude
  // session resumes only from the cwd it started in.
  if (run.cwd !== cwd) {
    const before = run.cwd === null ? "a directory EO did not record" : `"${run.cwd}"`;
    return (
      `${agent.name}'s last run on this ticket worked in ${before}, and this one works in "${cwd}". ` +
      `A provider session only resumes in the directory it started in, so the conversation couldn't be carried ` +
      `over — starting a fresh run instead.`
    );
  }

  return null;
}

/**
 * The same refusal as the attachment rule above, for the moment *after*
 * this file has already answered (EO-107).
 *
 * `findReusableThread` weighs a thread up before the dispatch assembles
 * its context, and assembling it yields the event loop — a person can
 * tick a box in between. The caller reads the fingerprint again at the
 * provider boundary and uses this when it has moved, so the two
 * refusals are one sentence with one place to edit rather than two that
 * drift.
 *
 * Worded for when it happens rather than for what changed: by this point
 * the thread was genuinely reusable and stopped being so while the run
 * was being prepared, which is a different and stranger thing to read
 * than "they have changed since its last run".
 */
export function staleAttachmentsRefusal(agent: Agent): string {
  return (
    `The MCP servers or skills attached to ${agent.name} changed while this run was being prepared. A provider ` +
    `session keeps the tools it was started with, so the conversation it was going to carry on couldn't be used — ` +
    `this run assembles the full context instead, which is how it picks the new ones up.`
  );
}

/**
 * What a conversation has to have cost before EO says anything about it
 * (EO-210).
 *
 * **Spend, not size.** The first cut of this tried to measure how full
 * the provider's window was and could not: `runs.tokens_in` is billed
 * input summed over every model turn of a dispatch — its own docstring
 * says "not the size of what EO assembled" — and on Claude `usageOf`
 * records the running total for the whole query, across subagents and
 * sidechains, re-reported on each result. A short thread that took
 * twenty tool-calling turns bills more than a long thread that took two,
 * so a threshold on that number announced compaction of conversations
 * that were nowhere near a window. Neither backend reports the size of a
 * session, so EO cannot know it, and a notice that claimed to is worse
 * than no notice: it is EO being confidently wrong in the one place it
 * had appointed itself the honest witness.
 *
 * What EO *can* add up exactly is what this conversation has been billed
 * — the sum of `tokens_in` over the runs sharing its thread — so that is
 * what the threshold is on and what the sentence says. It is the number
 * this story started from: two usage windows exhausted in a day.
 *
 * A million, and round on purpose. Reuse does not stop a thread being
 * re-sent to the model on every turn; it stops *EO* re-assembling it
 * into the prompt as well. So a conversation still costs roughly the
 * square of its length, and a million input tokens is around thirty
 * substantial turns — far past anything ordinary, and reached by exactly
 * the kind of thread that eats an afternoon. Firing late costs one long
 * conversation nobody was told about; firing early costs a comment in
 * every busy room, which is how a notice stops being read.
 */
export const THREAD_SPEND_NOTICE_TOKENS = 1_000_000;

/**
 * Billed input across these runs.
 *
 * A run whose backend reported nothing contributes nothing. That is an
 * undercount rather than a reading of zero, and it is the safe direction
 * for a threshold: it delays the notice on an installation whose
 * backend is quiet, where the alternative would be to guess a number and
 * announce a cost nobody was charged.
 */
function spendOf(runs: readonly Run[]): number {
  return runs.reduce((total, run) => total + (run.tokensIn ?? 0), 0);
}

/**
 * What EO says once a reused thread has become expensive enough to
 * mention (EO-210), or null while it has not.
 *
 * The honest gap this closes, stated as narrowly as EO can support it.
 * When EO assembles a context it drops the oldest comments and says so —
 * `## What is not here` on a seed, `droppedCommentCount` on a thread —
 * so an agent working from a partial record knows it is working from
 * one. A reused provider thread has no such sentence available: if the
 * provider summarises the session, EO is not told, and nothing anywhere
 * records that it happened.
 *
 * So EO says the two things it can stand behind. What this conversation
 * has been billed, which it has added up itself. And that it is no
 * longer the one deciding what the model keeps — **not** that anything
 * has been dropped, because EO cannot see the thread and must not claim
 * to. The comment thread is still the whole record either way
 * (invariant #4), which is what makes ending the conversation a cheap
 * answer rather than a loss.
 *
 * Once per thread, on the crossing. Spend only accumulates, so "the
 * total including the newest run has crossed and the total without it
 * had not" is exactly the one dispatch where the line was passed — no
 * flag, no column, and no second comment however long the conversation
 * runs afterwards.
 *
 * The last sentence turns on the action because the answer does. In a
 * room the person has a control — Clear archives the conversation and
 * the next message opens a new thread — and telling them about a cost
 * they can stop in one click is worth the sentence. On a work item
 * there is no such control, and inventing one would be worse than
 * saying nothing: the implementer's thread ends when the item does,
 * and what EO owes there is an accurate account rather than an
 * instruction.
 */
export function threadSpendNotice(db: Db, agent: Agent, resuming: Run, action: string): string | null {
  if (resuming.threadId === null) return null;

  // This thread's runs up to and including the one being continued. The
  // run this dispatch has just written is excluded by the id bound: it
  // has been billed nothing yet, and counting it would put a null in the
  // middle of an otherwise exact sum.
  const onThread = listRunsForItem(db, resuming.itemId).filter(
    (run) => run.agentId === agent.id && run.threadId === resuming.threadId && run.id <= resuming.id,
  );
  const spend = spendOf(onThread);
  if (spend < THREAD_SPEND_NOTICE_TOKENS) return null;
  if (spendOf(onThread.filter((run) => run.id !== resuming.id)) >= THREAD_SPEND_NOTICE_TOKENS) return null;

  const conversation = isThreadPerConversationAction(action);
  const turns = `${onThread.length} ${conversation ? "message" : "run"}${onThread.length === 1 ? "" : "s"}`;
  const whatToDo = conversation
    ? `Clear this conversation when the subject has moved on, and the next message starts a fresh one.`
    : `Nothing here needs doing: this thread ends when the ticket does, and a fresh run is given the newest word ` +
      `from every step it has been through.`;

  return (
    `${agent.name} has now been billed about ${Math.round(spend / 100_000) / 10}M input tokens on this thread, over ` +
    `${turns}. That is what the backend charged, not how large the conversation is — neither backend reports that, ` +
    `so EO cannot tell you how close this thread is to its limit. What EO can tell you is that it is no longer the ` +
    `one deciding what the model keeps: when EO trims a context it says what it left out, and a provider that ` +
    `summarises its own session says nothing to anybody, so there would be no "what is not here" to read. Nothing ` +
    `is lost from the ticket — every message here is a comment, and this thread is the record. ${whatToDo}`
  );
}

/**
 * For this agent, on this item, in this working directory: is there a
 * thread worth resuming (EO-86)?
 *
 * The one place that decides. A thread is keyed on (item, agent) and
 * not on the action, which is what lets the implementer's conversation
 * survive a review bounce and a direct mention alike — so `action` is
 * deliberately absent from the question.
 *
 * What is *not* asked here: whether the agent has thread reuse turned
 * on. That is the caller's switch (`reusesThreadPerItem`), and folding
 * it in would mean this function answered "no thread" for an agent that
 * plainly has one, which is a worse thing to read in a test failure.
 *
 * Two things deliberately do not disqualify a run: it failed or was
 * cancelled, and the agent has changed model since. Breaking on the
 * first would lose the saving exactly where retries are most likely —
 * and the in-run correction retry already resumes failed threads today.
 * Breaking on the second would be conservatism: both SDKs take a model
 * override on resume.
 */
export function findReusableThread(db: Db, query: ThreadReuseQuery): ThreadReuse {
  const { itemId, agent, cwd } = query;
  const wantedHash = promptHash(agent.instructions);
  // The tool surface this dispatch would open a session with (EO-106).
  // Read once here rather than per candidate: it is the same answer for
  // every row, and it is a database read.
  //
  // Narrowed to the skills this item's run would be given (EO-470): a
  // skill scoped to this project or this step's workspace is part of the
  // surface, one scoped elsewhere is not. Worked out from the item by the
  // same function the dispatch uses, so the two cannot disagree.
  const item = getItem(db, itemId);
  const wantedAttachments = agentAttachmentsHash(db, agent.id, item ? skillRunScope(db, item) : UNSCOPED_RUN);

  const mine = listRunsForItem(db, itemId)
    // Whoever else has run on this item has their own conversation,
    // and this agent's runs elsewhere are about another item — neither
    // is history this dispatch could continue, so neither is worth an
    // account of itself. From here they look like never having run.
    .filter((run) => run.agentId === agent.id)
    // Newest first. `listRunsForItem` orders by id ascending and ids
    // are uuidv7, minted monotonically, so newest-by-id is
    // newest-by-creation. Deliberately not `started_at`, which is a
    // millisecond and ties — two runs on one tick are exactly the case
    // ids resolve.
    .reverse();

  // Every thread of this agent's that a resume has already found gone
  // (EO-93). Collected up front rather than asked per run, because the
  // marker sits on whichever run discovered the loss and it disqualifies
  // every run sharing that thread id, including the ones before it.
  const lostThreads = new Set(
    mine.flatMap((run) => (run.threadLost && run.threadId !== null ? [run.threadId] : [])),
  );

  // The newest of each kind of answer. The newest run is the
  // conversation the agent would have expected to carry on, so it is the
  // one a person is owed an account of.
  let refusal: string | null = null;
  let absence: string | null = null;

  for (const run of mine) {
    const excluded = notACandidate(run, agent, lostThreads);
    if (excluded !== null) {
      absence ??= excluded;
      continue;
    }
    const reason = refusalFor(run, agent, cwd, wantedHash, wantedAttachments);
    if (reason === null) return { kind: "resume", run };
    refusal ??= reason;
  }

  // A refusal outranks an absence even when the absence is newer: a
  // thread EO decided against is the thing worth saying, and "the last
  // run was a dry run" would leave the person wondering why the real one
  // before it wasn't used.
  if (refusal !== null) return { kind: "refused", reason: refusal };
  return { kind: "no-thread", reason: absence ?? neverRan(agent) };
}
