import { TERMINAL_TARGET, TRIAL_STOP_CHOICES, trialStopChoiceOf, uuidv7, type Comment, type GuardConfigView, type Item, type PipelineStep, type TrialExpectedOutcome, type TrialStopChoice, type Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { onCommentPosted, type CommentContext } from "../db/commentEvents.js";
import {
  answerTrialStops,
  boundGraphForItem,
  getItem,
  getPipeline,
  getRun,
  getStep,
  getTrialPipeline,
  listMentionsForComment,
  listRoutesForPipeline,
  listTrialOutcomes,
  listTrialRounds,
  newestTrialRound,
  openTrialStop,
  postComment,
  readTrialPlan,
  recordTrialOutcome,
  recordTrialRound,
  recordTrialStop,
  trialKeptGoing,
  trialOutcomeForRun,
  trialSpendCentsSince,
  trialStopByComment,
  type TrialEvent,
  type TrialGuard,
  type TrialOutcome,
  type TrialPipeline,
  type TrialRound,
  type TrialStop,
} from "../db/repos/index.js";
import { onTransitionApplied, type AppliedTransition } from "../db/transitionEvents.js";
import { readGuards } from "../ipc/configCommands.js";
import type { EngineHandle } from "../ipc/domainCommands.js";
import { assistAgent } from "../roles/assist.js";
import { ASSIST_STEP } from "../roles/conversationSteps.js";
import { isAttemptLimitStop } from "../supervisor/attemptLimit.js";
import { discardTrial } from "./discard.js";

/**
 * A draft's test-fix loop (EO-586, ARCHITECTURE.md, "Trial pipelines").
 *
 * The loop is a sequence of assistant turns, never one turn waiting on a
 * build (invariant #9). What connects them is this file: when a trial
 * item gets somewhere the assistant has to read — reaches a terminal
 * step, parks for attention, fails past its attempts, or arrives on a
 * person's step — EO posts a comment on the conversation the trial came
 * from that mentions the system agent, exactly as `openUpdateConflictChat`
 * posts its brief, and that mention starts the next turn there. Never on
 * the trial item: the assistant's turn belongs to the conversation, which
 * holds the draft and everything the person said.
 *
 * EO reads the event, not the assistant: which item, which step, which
 * result, what was expected, and whether that is where it ended
 * (invariant #5). And EO keeps the loop inside its guardrails: a round is
 * started through `startTrialRound`, which refuses one past the rounds
 * allowed, past the draft's budget, or after the same step failed the
 * same way twice running — with a comment mentioning the person and
 * three answers (invariant #8).
 */

/** What waking the assistant needs beyond the database: something to tell there is a turn to start. */
export interface Waker {
  engine?: Pick<EngineHandle, "notifyStateChange"> | undefined;
}

/** What the loop needs beyond the database: something to tell when there is work, and what discarding takes. */
export interface TrialLoopDeps {
  engine?: EngineHandle;
  attachmentStorage?: AttachmentStorage;
  worktreeRoot?: string;
}

/**
 * Starts listening (EO-586): to every move, for a trial item reaching a
 * terminal step or a person's step; to every comment, for a trial item
 * parking or failing past its attempts. Hooked at the write, as the
 * record's outbound queue is, so no path that moves an item or parks one
 * can forget to wake the assistant. Returns a disposer.
 *
 * A person answering a guardrail stop is not read here: a comment does
 * not say who asked for it to be written — the system agent's own
 * `comment_post` lands as the person's off a trial item (EO-514) — so the
 * answer is read where the caller is known, `postHumanComment`, through
 * `answerTrialStop`.
 */
export function installTrialLoop(db: Db, deps: TrialLoopDeps = {}): () => void {
  installed.set(db, deps);
  const stopMoves = onTransitionApplied(db, (transition) => wakeOnMove(db, deps, transition));
  const stopComments = onCommentPosted(db, (comment, context) => onComment(db, deps, comment, context));
  return () => {
    if (installed.get(db) === deps) installed.delete(db);
    stopMoves();
    stopComments();
  };
}

/** What each database's loop was installed with — what a write that cannot be handed it reaches. */
const installed = new WeakMap<Db, TrialLoopDeps>();

/**
 * What the loop on this database was installed with (EO-587), or nothing
 * where none is: the engine to tell there is work, for a write deep in a
 * reply's posting — a draft revised mid-loop starting the next round —
 * that nobody could hand it to.
 */
export function trialLoopDeps(db: Db): TrialLoopDeps {
  return installed.get(db) ?? {};
}

function onComment(db: Db, deps: TrialLoopDeps, comment: Comment, context: CommentContext): void {
  // A copy of a comment written elsewhere: the machine that wrote it
  // read it, and a replica waking its own assistant would be a second
  // turn answering the same event.
  if (context.staysHere || comment.authorType === "human") return;
  wakeOnPark(db, deps, comment, context.endsRun === true);
}

/** The trial item, and its trial, a write is about — or null when it is about anything else. */
function trialItemOf(db: Db, itemId: Uuid): { item: Item; trial: TrialPipeline } | null {
  const item = getItem(db, itemId);
  if (item === undefined || item.trialAt === null || item.pipelineId === null) return null;
  const trial = getTrialPipeline(db, item.pipelineId);
  return trial === undefined ? null : { item, trial };
}

/** A step as the item's own version has it, else as it stands. */
function stepOf(db: Db, item: Item, stepId: string): PipelineStep | undefined {
  return boundGraphForItem(db, item)?.steps.find((step) => step.id === stepId) ?? getStep(db, stepId);
}

function wakeOnMove(db: Db, deps: TrialLoopDeps, transition: AppliedTransition): void {
  const found = trialItemOf(db, transition.itemId);
  if (found === null) return;
  const step = stepOf(db, found.item, transition.toStepId);
  if (step === undefined) return;
  const event: TrialEvent | null = step.isTerminal ? "terminal" : step.type === "user" ? "person_step" : null;
  if (event === null) return;
  wake(db, deps, { ...found, event, step, result: resultOfMove(db, found.item, transition, step), detail: null, runId: null });
}

/**
 * Wakes the assistant for a trial item arriving on its trial's entry step
 * as it is filed (EO-586): no move puts it there, so no transition says
 * so, and an entry step that is a person's would otherwise wait for a
 * press nobody was told to make. Called by `fileTrialItem`.
 */
export function wakeOnFiling(db: Db, deps: Waker, itemId: Uuid): void {
  const found = trialItemOf(db, itemId);
  if (found === null || found.item.stepId === null) return;
  const step = stepOf(db, found.item, found.item.stepId);
  if (step === undefined || step.type !== "user") return;
  wake(db, deps, { ...found, event: "person_step", step, result: "filed on it as the trial's first step", detail: null, runId: null });
}

/**
 * A trial item parking for attention: an escalation or a question
 * mentioning the person, or any comment that ends its run waiting on the
 * person (`endsRun` — an agent's blocking output). An output that does
 * not block is the work itself, whoever it mentions, and wakes nothing.
 */
function wakeOnPark(db: Db, deps: TrialLoopDeps, comment: Comment, endsRun: boolean): void {
  if (comment.kind !== "escalation" && comment.kind !== "question" && !endsRun) return;
  const found = trialItemOf(db, comment.itemId);
  if (found === null) return;
  if (!listMentionsForComment(db, comment.id).some((mention) => mention.targetType === "human")) return;
  // One park is one wake: a run that asks three questions has parked once.
  if (comment.runId !== null && trialOutcomeForRun(db, found.item.id, comment.runId)) return;
  const step = found.item.stepId === null ? undefined : stepOf(db, found.item, found.item.stepId);
  if (step === undefined) return;
  const attempts = comment.kind === "escalation" && comment.authorType === "engine" && isAttemptLimitStop(comment.body);
  wake(db, deps, {
    ...found,
    event: attempts ? "attempts" : "parked",
    step,
    result: attempts ? "failed past its attempts" : comment.kind === "question" ? "parked: asked a question" : comment.kind === "output" ? "parked: its output waits for you" : "parked: asked for attention",
    detail: comment.body,
    runId: comment.runId,
  });
}

/**
 * The result a move was made on (EO-586). The move says so itself where
 * whoever made it knew (`AppliedTransition.resultKey`): the supervisor
 * for a run's result, routed however a pack read the answer; a press;
 * a mocked step. Short of that, the one route from the step it left to
 * the step it reached, or the `result` a run's stored answer names
 * exactly (`parsed.result`). Nothing else in an answer is read as a
 * result — a summary that happens to spell a key is prose — and where
 * nothing settles it the note says which keys it could have been.
 */
function resultOfMove(db: Db, item: Item, transition: AppliedTransition, to: PipelineStep): string {
  if (transition.resultKey !== undefined && transition.resultKey !== null) return transition.resultKey;
  if (transition.fromStepId === null) return transition.reason ?? "moved";
  const routes = (boundGraphForItem(db, item)?.routes ?? listRoutesForPipeline(db, to.pipelineId)).filter(
    (route) => route.fromStepId === transition.fromStepId && (route.target === to.id || (route.target === TERMINAL_TARGET && to.isTerminal)),
  );
  if (routes.length === 1) return routes[0]!.resultKey;
  const reported = transition.runId === null ? null : explicitResult(getRun(db, transition.runId)?.result ?? null);
  const byRun = routes.find((route) => route.resultKey === reported);
  if (byRun !== undefined) return byRun.resultKey;
  const pressed = /^decided "(.*?)"/.exec(transition.reason ?? "")?.[1];
  const byPress = routes.find((route) => route.label === pressed);
  if (byPress !== undefined) return byPress.resultKey;
  if (routes.length > 1) return `one of ${routes.map((route) => route.resultKey).join(", ")}`;
  return transition.reason === null ? "moved without a declared result" : transition.reason;
}

/** The `result` a run's stored answer (`{ raw, parsed }`) names, or null where it names none. */
function explicitResult(result: Record<string, unknown> | null): string | null {
  const parsed = result?.["parsed"];
  if (parsed === null || typeof parsed !== "object") return null;
  const named = (parsed as Record<string, unknown>)["result"];
  return typeof named === "string" ? named : null;
}

interface WakeInput {
  item: Item;
  trial: TrialPipeline;
  event: TrialEvent;
  step: PipelineStep;
  result: string;
  /** What the item said when it parked, quoted under the facts. */
  detail: string | null;
  runId: Uuid | null;
}

/**
 * Whether an outcome is a failure, as EO judges it against the expected
 * outcome (invariant #5). Where one was set, anything that is not that
 * step has failed — except arriving on a person's step on the way, which
 * is not an end. Where none was, only a park and a run out of attempts
 * are: there is nothing else to fail.
 */
function failedAgainst(event: TrialEvent, step: PipelineStep, expected: TrialExpectedOutcome | undefined): boolean {
  if (expected !== undefined) return step.id !== expected.stepId && event !== "person_step";
  return event === "parked" || event === "attempts";
}

const HEADLINES: Record<TrialEvent, string> = {
  terminal: "A test item reached the end of the trial",
  parked: "A test item is waiting for attention",
  attempts: "A test item failed past its attempts",
  person_step: "A test item is on a person's step",
};

const NEXT: Record<TrialEvent, string> = {
  terminal:
    "Read its thread. If it did not end where it was expected to, change the draft and start another round; when every test item has, the draft is ready for the publish card: return `{ \"kind\": \"trialPublish\" }`.",
  parked:
    "Read what it asked. Answer it on the person's behalf only from what they told you, the test items and the repository; anything else — a credential, more tools, a wider grant — goes to the person.",
  attempts: "Read why its runs failed, change the draft, and start another round.",
  person_step: "Press one of the step's results on the person's behalf, so that across the trials every result it declares is pressed at least once.",
};

function wake(db: Db, deps: Waker, input: WakeInput): void {
  const conversation = getItem(db, input.trial.conversationId);
  // The conversation is gone: deleting one discards its trials, so this
  // is a trial on its way out, and there is nobody to tell.
  if (conversation === undefined) return;
  const plan = readTrialPlan(db, input.trial.id);
  const expected = plan?.expected.find((entry) => entry.itemId === input.item.id);
  const failed = failedAgainst(input.event, input.step, expected);
  const round = newestTrialRound(db, input.trial.id) ?? null;
  const agent = assistAgent(db);
  const open = conversation.archivedAt === null && conversation.stepId === ASSIST_STEP;

  const expectedStep = expected === undefined ? undefined : stepOf(db, input.item, expected.stepId);
  const lines = [
    `**${HEADLINES[input.event]}**${round === null ? "" : ` — round ${round.number}`}.`,
    "",
    `- Item: ${input.item.key} "${input.item.title}"`,
    `- Step: "${input.step.name}"`,
    `- Result: ${input.result}`,
    `- Expected outcome: ${expected === undefined ? "none was set for this test item" : `end on "${expectedStep?.name ?? expected.stepId}"${expected.criteria ? `, and: ${expected.criteria}` : ""}`}`,
    `- EO's reading: ${verdict(input.event, failed, expected === undefined ? null : input.step.id === expected.stepId)}`,
  ];
  if (input.detail !== null && input.detail.trim() !== "") lines.push("", quoted(input.detail));
  lines.push("", NEXT[input.event]);
  if (agent === undefined || !open) {
    lines.push("", open ? "There is no enabled system agent to wake, so nothing reads this until one is enabled." : "This conversation is closed, so no assistant turn was started for it.");
  }

  const commentId = uuidv7();
  postComment(db, {
    id: commentId,
    itemId: conversation.id,
    author: { type: "engine" },
    kind: "note",
    body: lines.join("\n"),
    // The mention is what starts the turn, as the conflict brief's does.
    mentions: agent !== undefined && open ? [{ type: "agent", agentId: agent.id }] : [],
    parseBodyMentions: false,
  });
  recordTrialOutcome(db, {
    trialPipelineId: input.trial.id,
    roundId: round?.id ?? null,
    itemId: input.item.id,
    event: input.event,
    stepId: input.step.id,
    result: input.result,
    failed,
    runId: input.runId,
    commentId,
  });
  deps.engine?.notifyStateChange();
}

/**
 * What EO makes of where the item is. `atExpected` is null where no
 * expected outcome was set, else whether this is the expected step.
 */
function verdict(event: TrialEvent, failed: boolean, atExpected: boolean | null): string {
  if (event === "person_step") {
    // Arriving on a person's step is not an end unless it is the one expected.
    return atExpected === true ? "this is the step it was expected to end on." : "not an end yet — it waits here for a press, and has not reached its expected outcome.";
  }
  if (atExpected === null) return failed ? "it has stopped short of an end, which fails it." : "no expected outcome was set, so EO has nothing to judge it against.";
  return failed ? "it is not where it was expected to end, so this test item has failed." : "it is where it was expected to end.";
}

function quoted(text: string): string {
  const cut = text.length > 800 ? `${text.slice(0, 800)}…` : text;
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** What starting a round answers with. */
export type StartTrialRoundResult = { ok: true; round: TrialRound } | { ok: false; problem: string; stop: TrialStop | null };

/** A guardrail that tripped, and why in words. */
interface Tripped {
  guard: TrialGuard;
  why: string;
}

/**
 * Starts the next round of a trial's test items (EO-586) — the door every
 * round goes through, so the guardrails hold however the round is asked
 * for. Refused, and the loop stopped with a comment on the conversation
 * mentioning the person, when:
 *
 *   * the rounds allowed (`trialRoundsPerDraft`, 8 by default) have
 *     already started;
 *   * the draft's budget (`trialBudgetCentsPerDraft`, unset by default)
 *     is spent;
 *   * the same step failed with the same result in each of the last two
 *     rounds (`trialStopOnRepeatedFailure`, on by default): the fix
 *     between them did not reach what was failing.
 *
 * Each counts from the person's last "keep going". While a stop waits on
 * the person, every round is refused, saying so, without a second comment.
 *
 * What a round runs on the trial's items is the caller's; this decides
 * whether it may, and records it.
 */
export function startTrialRound(db: Db, input: { trialPipelineId: string; startedBy?: string }, guards: GuardConfigView = readGuards(db)): StartTrialRoundResult {
  const trial = getTrialPipeline(db, input.trialPipelineId);
  if (trial === undefined) return { ok: false, problem: "That is not a trial pipeline, so no round was started.", stop: null };

  const waiting = openTrialStop(db, trial.id);
  if (waiting !== undefined) {
    return {
      ok: false,
      problem: "This draft's testing is stopped until the person answers — keep going, publish anyway or discard. No round was started.",
      stop: waiting,
    };
  }

  const keptGoing = trialKeptGoing(db, trial.id);
  // Every round numbered past the one the loop was on when the person
  // said to keep going: by number, so a round started in the answer's own
  // millisecond still counts.
  const rounds = listTrialRounds(db, trial.id).filter((round) => round.number > keptGoing.afterRound);
  const tripped = roundsTripped(rounds, guards) ?? budgetTripped(db, trial, keptGoing.at, guards) ?? repeatedTripped(db, trial, rounds, guards);
  if (tripped !== null) {
    const stop = stopLoop(db, trial, tripped, rounds);
    return { ok: false, problem: `No round was started: ${tripped.why}. The person has been asked whether to keep going, publish anyway or discard.`, stop };
  }
  return { ok: true, round: recordTrialRound(db, { trialPipelineId: trial.id, startedBy: input.startedBy ?? "human" }) };
}

function roundsTripped(rounds: readonly TrialRound[], guards: GuardConfigView): Tripped | null {
  if (rounds.length < guards.trialRoundsPerDraft) return null;
  return { guard: "rounds", why: `${rounds.length} round${rounds.length === 1 ? " has" : "s have"} run, which is as many as one draft is allowed (${guards.trialRoundsPerDraft})` };
}

function budgetTripped(db: Db, trial: TrialPipeline, since: number, guards: GuardConfigView): Tripped | null {
  const budget = guards.trialBudgetCentsPerDraft;
  if (budget === null) return null;
  const spent = trialSpendCentsSince(db, trial.id, since);
  if (spent < budget) return null;
  return { guard: "budget", why: `testing this draft has cost ${cents(spent)}, and its budget is ${cents(budget)}` };
}

function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

/** The failures of one round: each item's newest outcome in it, where that is a failure. */
function failuresIn(outcomes: readonly TrialOutcome[], roundId: string): TrialOutcome[] {
  const newest = new Map<string, TrialOutcome>();
  for (const outcome of outcomes) if (outcome.roundId === roundId) newest.set(outcome.itemId, outcome);
  return [...newest.values()].filter((outcome) => outcome.failed);
}

const failureKey = (outcome: Pick<TrialOutcome, "stepId" | "result">): string => `${outcome.stepId}\u0000${outcome.result}`;

function repeatedTripped(db: Db, trial: TrialPipeline, rounds: readonly TrialRound[], guards: GuardConfigView): Tripped | null {
  if (!guards.trialStopOnRepeatedFailure || rounds.length < 2) return null;
  const outcomes = listTrialOutcomes(db, trial.id);
  const [before, last] = rounds.slice(-2) as [TrialRound, TrialRound];
  const earlier = new Set(failuresIn(outcomes, before.id).map(failureKey));
  const again = failuresIn(outcomes, last.id).find((outcome) => earlier.has(failureKey(outcome)));
  if (again === undefined) return null;
  const step = getStep(db, again.stepId)?.name ?? again.stepId;
  return { guard: "repeated_failure", why: `"${step}" failed with the same result (${again.result}) in rounds ${before.number} and ${last.number}, so the change between them did not reach it` };
}

/**
 * Stops the loop (EO-586): a comment on the conversation mentioning the
 * person, saying which guardrail stopped it and what still fails, with
 * the three answers as its options — and the stop recorded, so the
 * answer can be read when it comes (`answerStop`).
 */
function stopLoop(db: Db, trial: TrialPipeline, tripped: Tripped, rounds: readonly TrialRound[]): TrialStop {
  const name = getPipeline(db, trial.id)?.name ?? "this draft";
  const lines = [`**Testing "${name}" has stopped**: ${tripped.why}.`, "", ...stillFailing(db, trial, rounds)];
  lines.push(
    "",
    "Keep going, publish anyway, or discard?",
    "- **Keep going** — the assistant carries on, and these guardrails count again from your answer.",
    "- **Publish anyway** — the assistant brings the publish card, which says which test items did not end where they were expected to.",
    "- **Discard** — the trial and its test items are deleted. The pipeline it would replace is unchanged.",
  );
  const commentId = uuidv7();
  postComment(db, {
    id: commentId,
    itemId: trial.conversationId,
    author: { type: "engine" },
    kind: "escalation",
    body: lines.join("\n"),
    mentions: [{ type: "human" }],
    parseBodyMentions: false,
    options: [...TRIAL_STOP_CHOICES],
  });
  return recordTrialStop(db, { trialPipelineId: trial.id, guard: tripped.guard, commentId });
}

/** What still fails, from the newest round that has anything to say. */
function stillFailing(db: Db, trial: TrialPipeline, rounds: readonly TrialRound[]): string[] {
  const outcomes = listTrialOutcomes(db, trial.id);
  const round = [...rounds].reverse().find((candidate) => outcomes.some((outcome) => outcome.roundId === candidate.id));
  if (round === undefined) return ["No test item has ended in a round yet, so nothing is known to fail."];
  const failures = failuresIn(outcomes, round.id);
  if (failures.length === 0) return [`Nothing failed in round ${round.number}.`];
  const expectedFor = new Map((readTrialPlan(db, trial.id)?.expected ?? []).map((entry) => [entry.itemId, entry]));
  return [
    `What still fails, as of round ${round.number}:`,
    ...failures.map((outcome) => {
      const item = getItem(db, outcome.itemId as Uuid);
      const label = item === undefined ? outcome.itemId : `${item.key} "${item.title}"`;
      const step = getStep(db, outcome.stepId)?.name ?? outcome.stepId;
      const expected = expectedFor.get(outcome.itemId);
      const wanted = expected === undefined ? "" : ` — expected to end on "${getStep(db, expected.stepId)?.name ?? expected.stepId}"`;
      return `- ${label}: "${step}", ${outcome.result}${wanted}`;
    }),
  ];
}

/**
 * Why an agent may not file this reply, or null where it may (EO-586):
 * a reply under a guardrail stop is the person's answer to it, and the
 * assistant cannot answer its own guardrail (invariant #11). Asked by
 * `postHumanComment` before anything is written, for a comment an
 * agent asked for (`actingAgentId`) — which off a trial item would
 * otherwise be filed as the person's.
 */
export function agentStopAnswerRefusal(db: Db, parentId: string | null | undefined): string | null {
  if (parentId === null || parentId === undefined || trialStopByComment(db, parentId) === undefined) return null;
  return "Only the person can answer a stop on testing a draft — keep going, publish anyway or discard. Nothing was posted; ask them in the conversation.";
}

/**
 * The person answering a stop (EO-586): a reply under the stop comment,
 * pressed from its options or typed, as `postHumanComment` files it for
 * a caller that is not an agent. Only the person's word does this — the
 * assistant cannot answer its own guardrail (invariant #11) — and every
 * answer ends in a comment (invariant #8). A reply under anything else
 * is not this function's, and it does nothing.
 *
 *   * Keep going: every guardrail counts again from now, and the
 *     assistant is woken to carry on.
 *   * Publish anyway: the assistant is woken to bring the publish card.
 *   * Discard: the trial and its items are deleted through the item-delete
 *     path (`discardTrial`), and the conversation is told.
 */
export function answerTrialStop(db: Db, deps: TrialLoopDeps, reply: Pick<Comment, "parentId" | "body">): void {
  if (reply.parentId === null) return;
  const stop = trialStopByComment(db, reply.parentId);
  if (stop === undefined) return;
  const trial = getTrialPipeline(db, stop.trialPipelineId);
  if (trial === undefined) return;
  const note = (body: string, wakes: boolean): void => {
    const agent = wakes ? assistAgent(db) : undefined;
    postComment(db, {
      itemId: trial.conversationId,
      ...(wakes ? {} : { parentId: stop.commentId as Uuid }),
      author: { type: "engine" },
      kind: "note",
      body,
      mentions: agent === undefined ? [] : [{ type: "agent", agentId: agent.id }],
      parseBodyMentions: false,
    });
    deps.engine?.notifyStateChange();
  };

  if (stop.answeredAt !== null) {
    note(`This stop was already answered with "${stop.choice}", so nothing more was done.`, false);
    return;
  }
  const choice = trialStopChoiceOf(reply.body);
  if (choice === null) {
    note(`That is not one of the answers, so testing is still stopped. Answer ${TRIAL_STOP_CHOICES.map((option) => `"${option}"`).join(", ")}.`, false);
    return;
  }

  answerTrialStops(db, trial.id, choice);
  const name = getPipeline(db, trial.id)?.name ?? "the draft";
  const said: Record<Exclude<TrialStopChoice, "Discard">, string> = {
    "Keep going": `**The person chose to keep going** with testing "${name}". The guardrails count again from now: rounds, the draft's spend and repeated failures. Change the draft and start the next round.`,
    "Publish anyway": `**The person chose to publish "${name}" anyway.** Bring the publish card — return \`{ "kind": "trialPublish" }\` — and say plainly which test items did not end where they were expected to.`,
  };
  if (choice !== "Discard") {
    note(said[choice], true);
    return;
  }
  if (deps.attachmentStorage === undefined) {
    note("The person chose to discard this trial, and it could not be discarded here. Discard it from the conversation instead.", false);
    return;
  }
  const attachmentStorage = deps.attachmentStorage;
  void discardTrial(db, deps.engine, attachmentStorage, { trialPipelineId: trial.id }, deps.worktreeRoot).then(
    (discarded) =>
      note(
        discarded.ok
          ? `**The person chose to discard "${name}".** The trial and its ${discarded.deletedItemIds.length} test item${discarded.deletedItemIds.length === 1 ? "" : "s"} have been deleted; the pipeline it would have replaced is unchanged.`
          : `The person chose to discard this trial, and it could not be: ${discarded.problem}`,
        discarded.ok,
      ),
    (error: unknown) => note(`The person chose to discard this trial, and discarding it failed: ${error instanceof Error ? error.message : String(error)}`, false),
  );
}
