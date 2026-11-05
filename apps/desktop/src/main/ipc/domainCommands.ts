import {
  acceptanceCriteriaOf,
  branchInGit,
  branchNameProblem,
  criteriaField,
  EMPTY_SPEC_SHAPE,
  formatIssues,
  gitStateOf,
  jiraStateOf,
  missingSpecFields,
  namedBranchOf,
  referenceProblem,
  editAwaitingHoldLine,
  specIssues,
  stepRefusalLine,
  uuidv7,
  type CommentDelivery,
  type GitItemState,
  type IpcPayload,
  type IpcResponse,
  type MemoryConsolidateNowResult,
  type MemoryScope,
  type MessageDelivery,
  type Run,
  type Item,
  type SpecShape,
  type StepAct,
  type StepRefusal,
  type Uuid,
} from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import {
  dismissOpenMentionForAgent,
  getAgent,
  getComment,
  getPipeline,
  getSetting,
  getStep,
  getItem,
  getItemType,
  getPerson,
  hasJiraPullPending,
  linkJiraKey,
  listActiveRuns,
  listAwaitingInputItemIds,
  listRunsForItem,
  listItemsIncludingArchived,
  postComment,
  resolveItemType,
  type ItemType,
  setCommentPinned,
  setJiraSync,
  setSetting,
  setItemArchived,
  setItemHeld,
  updateItem,

  boundGraphForItem,
  stepForItem,
  pipelineVersionsToKeep,
  setPipelineVersionsToKeep,
  moduleVersionsToKeep,
  setModuleVersionsToKeep,
  itemEntryRefusal,
} from "../db/repos/index.js";
import { archiveAfterDays, setArchiveAfterDays } from "../archive/sweep.js";
import { jiraPullMinutes, requestJiraPullDrain, setJiraPullMinutes } from "../packs/developer/jira/pullSchedule.js";
import { resolveDecisionRoute } from "./decisions.js";
import { settleSuggestion, suggestionMentions, suggestionRefusal } from "./suggestionCommands.js";
import { recordFor } from "../record/localRecord.js";
import type { ItemRecord, WorkOffer } from "../record/record.js";
import { refuseIfUntouchable } from "../roles/itemGuards.js";
import {
  applyDependencyChange,
  asksForDependencyChange,
  dependencyChangeHeader,
  judgeDependencyChange,
  summariseDependencyChange,
} from "../roles/itemDependencies.js";
import { branchPrefix, setBranchPrefix } from "../packs/developer/workspace/branchPrefix.js";
import { unansweredQuestions } from "../roles/clarificationQuestions.js";
import { answerSkipOffer } from "../jobs/answer.js";
import { answerSkillProposal } from "../memory/skillProposals.js";
import { actingAgentFor, standInBody, withOnYourBehalfNote } from "../trials/onBehalf.js";
import { agentStopAnswerRefusal, answerTrialStop } from "../trials/loop.js";
import { decisionRefusal, dispatchBlocker } from "@eo/engine";
import { stepNotInVersionMessage } from "@eo/core";
import { resolveAndValidateMentions } from "../supervisor/escalation.js";
import { archivedProjectBlocker, buildEligibilityInput } from "../supervisor/buildTickInput.js";
import { resumeOutlook, type ItemBlocker } from "../supervisor/dispatchBlockers.js";
import type { Cancellation, ResumeItemOptions, SteerResult, SteeredMessage } from "../supervisor/runSupervisor.js";
import { clearStop } from "../supervisor/stoppedByHand.js";
import { worksOnABranch } from "../supervisor/workspaceResolution.js";
import type { ItemLock } from "../supervisor/itemLock.js";
import { actingCaller, actingDevice, actingPersonId, humanAuthor, type ActingCaller } from "../identity/acting.js";
import { signedInPerson, signedInPersonId } from "../identity/viewer.js";
import { isReplica } from "../db/recordRole.js";
import { notifyAssignmentAsked } from "../db/assignmentEvents.js";
import { setReplicaAssignee } from "../db/repos/replicaRepo.js";
import { holdingIsProvisional } from "../db/repos/recordCommandsRepo.js";
import { writeAssignment, writeTakeover } from "../record/assignment.js";
import { planVersionMove, writeVersionMove } from "../record/versionMove.js";
import { notifyVersionMoveAsked } from "../db/versionMoveEvents.js";
import { holderView, judgeClaimOutright, judgeOnGroupStep } from "../record/stepAuthority.js";
import { getGroup } from "../db/repos/groupsRepo.js";
import { emitPush } from "./push.js";
import { clearEnginePausePreference, isEnginePausePreferred, persistEnginePause } from "../engineActivity.js";

/**
 * Tells every window this item changed. Returns its argument so it can
 * wrap a return inline.
 *
 * Here rather than in `handlers.ts`, which imports electron at module
 * scope and so cannot be imported by any main-process test — an emit
 * there would be untestable without module-mocking electron. `push.ts`
 * imports electron type-only and is already exercised against a fake
 * window, and each of these commands has exactly one caller, so nothing
 * is lost by putting the side effect down here where it can be checked.
 */
function announceItem<T>(itemId: Uuid, result: T): T {
  emitPush("items:changed", { itemId });
  return result;
}

/** What the command handlers need from the running engine, kept narrow so they stay testable without one. */
export interface EngineHandle {
  /**
   * `opts` carries who asked (EO-132). This handle's callers are people
   * — a posted reply — so they leave it at its default and a reply that
   * loses the item's lock is answered in the thread.
   */
  resumeItem: (itemId: Uuid, opts?: ResumeItemOptions) => Promise<void>;
  /**
   * Stops a run, and says on whose behalf (EO-175).
   *
   * The commands here that cancel as *part* of something else pass
   * `"superseded"`: each of them already routes, parks or removes the
   * item and writes its own sentence about it, so none of them wants
   * the scheduler standing off a step afterwards. Only `runs:cancel` —
   * somebody asking for the run to stop and for nothing else — leaves it
   * at the default.
   */
  cancelRun: (runId: string, cancellation?: Cancellation) => void;
  /**
   * Says something to a live run without stopping it (EO-176).
   *
   * Beside `cancelRun` because they are the two things a person can do
   * to a run in flight, and because saying which is which matters: this
   * one writes no run row, moves no item and classifies no
   * cancellation. `postHumanComment` is its only caller — the message is
   * a comment first, and this is the delivery.
   */
  steerRun: (runId: string, message: SteeredMessage) => Promise<SteerResult>;
  pause: (opts?: { cancelRunning?: boolean }) => void;
  resume: () => void;
  isPaused: () => boolean;
  /**
   * Why the scheduler will not pick this item up, asked of the engine
   * that would (EO-135, KAN-161).
   *
   * On the handle rather than computed here, because half the answer is
   * installed rather than written down: a pack supplies the gate that
   * turns an item away, and only the supervisor holds the fold. Built
   * here it would be the engine's rules minus the pack's — which reads
   * as "nothing is stopping it" about an item the next tick refuses.
   */
  dispatchBlockerFor: (itemId: Uuid) => ItemBlocker | null;
  activeRunCount: () => number;
  finishingRunCount: () => number;
  /** Starts the backend for the turn a person is typing in a conversation; see `RunSupervisor.prewarmConversation`. */
  prewarmConversation?: (itemId: Uuid, agentId: Uuid) => Promise<boolean>;
  /** `promptly` brings the tick forward for a person's own send in a conversation. */
  notifyStateChange: (options?: { promptly?: boolean }) => void;
  /**
   * One run at a time per item (EO-132).
   *
   * On the handle because the IPC side starts processes in an item's
   * worktree too — rebuilding a repository index spawns an indexer in
   * the checkout — and those have to take the same lock the
   * supervisor's own dispatches do rather than keep a second answer of
   * their own.
   */
  itemLock: ItemLock;
  /**
   * What this process, as the record, will let a device run (EO-324,
   * ARCHITECTURE.md, "The record").
   *
   * On the handle because a *record* has a caller the supervisor's own
   * tick is not: another device, asking over `record:work`. Both go
   * through the engine's own scheduler, so that the record's pick is
   * the pick — same guards, same caps, same pack contributions — rather
   * than a second one assembled beside it.
   */
  offerWork: (deviceId: string, capacity: number) => Promise<WorkOffer[]>;
  /**
   * A person asking for a memory scope to be consolidated now, and whether
   * one is queued or running (EO-589): the consolidator is the
   * supervisor's. Optional, so a handle built for a test need not have
   * them; absent, nothing consolidates in this process.
   */
  consolidateMemoryNow?: (scope: MemoryScope) => MemoryConsolidateNowResult;
  memoryConsolidationPending?: (scope: MemoryScope) => "queued" | "running" | null;
}

/**
 * A human comment, and the reply path that unblocks a parked run (ARCHITECTURE.md, "Escalation ends
 * the run").
 *
 * Posting resolves any open mention aimed at the human, so the answer
 * and the acknowledgement are one action. If the item's last run was
 * parked awaiting exactly this, it resumes on the same thread — which is
 * what makes replying in the UI feel like answering a colleague rather
 * than filing a form.
 */
export async function postHumanComment(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"comments:post">,
  attachmentStorage?: AttachmentStorage,
): Promise<IpcResponse<"comments:post">> {
  const itemId = input.itemId as Uuid;
  const attachmentIds = input.attachmentIds ?? [];
  if (input.body.trim() === "" && attachmentIds.length === 0) throw new Error("A comment needs text or an attachment.");
  if (attachmentIds.length > 0 && !attachmentStorage) throw new Error("Attachment storage is unavailable.");

  const resolution = resolveAndValidateMentions(db, input.mentions);
  if (!resolution.ok) throw new Error(resolution.error);

  // The system agent writing on a trial item, standing in for the person
  // (EO-585): an agent comment under its own name, with the note saying
  // it spoke on the person's behalf. Anywhere else its words go in as
  // they always have — as the person's, which is what a reply to a
  // skill proposal relies on (EO-514).
  const standIn = actingAgentFor(db, input.actingAgentId);
  if ("problem" in standIn) throw new Error(standIn.problem);
  // A reply under a guardrail stop on testing a draft is the person's
  // answer to it (EO-586). An agent's would be filed as the person's off a
  // trial item, so it is refused here, where it is still known whose it is.
  if (standIn.agent !== null) {
    const refusal = agentStopAnswerRefusal(db, input.parentId);
    if (refusal !== null) throw new Error(refusal);
  }
  const onTrial = standIn.agent !== null && (getItem(db, itemId)?.trialAt ?? null) !== null;
  const standInAgent = onTrial ? standIn.agent : null;

  const commentId = uuidv7();
  const prepared = await attachmentStorage?.prepare(attachmentIds) ?? [];
  let comment: ReturnType<typeof postComment>;
  try {
    comment = postComment(db, {
      id: commentId,
      itemId,
      // Whose words these are (EO-326, ARCHITECTURE.md, "Identity"). Null on a desktop, where
      // there is only one person it could be; the admin's person id on a
      // comment they left on another team's item, which is the whole of
      // what the story's audit line asks for.
      author: standInAgent === null ? humanAuthor(actingCaller(db, input.actingDeviceId)) : { type: "agent", agentId: standInAgent.id },
      body: standInAgent === null ? input.body.trim() : withOnYourBehalfNote(input.body.trim(), input.parentId ? "answered" : "wrote"),
      mentions: resolution.targets,
      pinned: input.pinned,
      attachmentRecords: prepared,
      // A reply is filed under the comment it answers (D-05). Which run
      // it unblocks is unchanged — that is decided below, by what is
      // waiting, not by where the answer is filed.
      parentId: (input.parentId as Uuid | null) ?? null,
    });
  } catch (error) {
    await attachmentStorage?.rollback(prepared);
    throw error;
  }
  await attachmentStorage?.finish(prepared).catch((error: unknown) => console.error("[eo] could not clear staged comment attachments:", error));

  // The delivery, after the record and never instead of it (EO-176).
  // The comment above is what was said; this only decides which turn
  // reads it, and every answer it can give leaves that comment standing.
  const delivery = input.delivery === undefined
    ? null
    : await deliverToLiveRun(db, engine, { itemId, commentId: comment.id, body: comment.body, requested: input.delivery });

  // "Run it now" on a skipped occurrence (EO-306). Before the resume
  // path below, because a job thread has no run to resume and this is
  // the only thing a reply on one can be waiting to do — and after the
  // comment is written, so the answer is in the thread beside the
  // occurrence it caused rather than after it.
  const ranJob = answerSkipOffer(db, comment);
  if (ranJob?.item) {
    emitPush("items:changed", { itemId: ranJob.item.id });
    engine?.notifyStateChange();
  }

  // Save or Discard on a skill a memory consolidation proposed (EO-483),
  // or Propose again on one that was discarded (EO-512).
  // The person's press is the whole gate: nothing of a proposal is saved
  // or attached until this, and it answers in the thread either way. A
  // reply the system agent posts over `eo_admin` arrives here too, as
  // the person's, and is acted on deliberately — see `answerSkillProposal`
  // (EO-514).
  // Keep going, publish anyway or discard, under a stop on testing a
  // draft (EO-586): the person's answer, read here because only here is it
  // known to be the person's — an agent's was refused above.
  if (standIn.agent === null) answerTrialStop(db, { ...(engine ? { engine } : {}), ...(attachmentStorage ? { attachmentStorage } : {}) }, comment);

  const proposal = answerSkillProposal(db, comment);
  if (proposal !== null) {
    emitPush("items:changed", { itemId });
    // The Skills screen, the agents' attachments and the memory panel.
    if (proposal.outcome === "saved") emitPush("config:changed", {});
  }

  // Check *after* posting: the reply is what the run is waiting for, so
  // it has to be in the thread before the agent reads it back.
  //
  // `listAwaitingInputItemIds` rather than "some run is awaiting
  // input", because `resumeItem` never clears the parked row — it
  // creates a *new* run and leaves the old one at `awaiting_input`
  // forever. With the resume no longer awaited (below), the naive check
  // would see that stale row on a second reply and start a second
  // concurrent run on the same provider thread, which is invariant 10
  // twice over. This helper means "the *latest* run is parked", which is
  // the scheduler's own definition of the same thing.
  const awaiting = listAwaitingInputItemIds(db).has(itemId);
  // ...but not while the agent is still owed an answer (KAN-29). This
  // line used to be `awaiting && engine` alone, which meant *any*
  // comment resumed the run: an agent that asked three questions was
  // sent back after the first was answered, holding one answer and two
  // open questions with no way to say so. It guessed, or asked again.
  const stillAsking = unansweredQuestions(db, itemId).length > 0;
  if (awaiting && !stillAsking && engine) {
    // Started, not awaited. Resuming runs an agent to completion —
    // minutes — and the caller is a person who has just pressed Post.
    // This used to be awaited, which held the IPC response open for the
    // whole run: the renderer's only refresh for a posted comment is
    // this promise resolving, so a reply stayed invisible until the run
    // ended or the screen was remounted. That is the bug this fixes.
    void engine.resumeItem(itemId).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[eo] resuming ${itemId} after a reply failed:`, error);
      // Invariant 8: nothing drops work on the floor silently. Now that
      // nobody is awaiting this promise, a comment is the only way the
      // failure can reach the person who wrote the reply.
      postComment(db, {
        itemId,
        author: { type: "engine" },
        kind: "note",
        body: `Could not pick this ticket back up after your reply: ${reason}\n\nReply again to retry.`,
      });
    });
    return { commentId: comment.id, resumedRun: true, delivery };
  }

  engine?.notifyStateChange();
  return { commentId: comment.id, resumedRun: false, delivery };
}

/**
 * Hands a just-posted comment to the agent working on the item right
 * now, and reports honestly which turn ended up with it (EO-176).
 *
 * **The person is told once, here, and in a sentence.** A steered
 * message that arrived a moment too late is not a failure — the message
 * is safe, the next turn reads it — but "sent" and "sent, and read by
 * somebody else in twenty minutes" are different enough that letting
 * them look identical would be EO quietly deciding what somebody meant.
 * Invariant #8 in its ordinary form: nothing drops work on the floor
 * without saying so.
 *
 * **A delivered message must not then wake a second run.** The mention
 * aimed at the agent that got it is dismissed — the move
 * `sendDiscussionMessage` already makes for the same reason: leave it
 * open and the agent that has *just been told this* is dispatched to
 * answer it again the moment the current run ends. Only that one, and
 * only on success; a queued message keeps its mention, because there the
 * mention is the thing that starts the next turn.
 *
 * **Shared with the assistant chat since EO-395**, which is why it is
 * exported and why it takes the word for what the person is looking at.
 * `assist:send` posts its comment and then comes here exactly as
 * `comments:post` does, so there is one answer to "what became of a
 * message sent mid-turn" and the two cannot drift. Only the noun
 * differs: somebody typing into the assistant has never seen a ticket,
 * and a sentence telling them about "the next run on this ticket" would
 * be describing a screen they are not on.
 *
 * **The answer does not wait on the backend (EO-558).** A steer the
 * backend has not taken within `STEER_REPLY_WITHIN_MS` is reported
 * `pending` and finishes on its own: landed, it dismisses the mention
 * exactly as above and says the item changed; missed or failed, it
 * leaves the mention open, which is what makes the next turn read it.
 *
 * The files posted with the message are not passed: `steerRun` reads
 * them off the comment, so every caller of this delivers them.
 */
export async function deliverToLiveRun(
  db: Db,
  engine: EngineHandle | undefined,
  message: { itemId: Uuid; commentId: Uuid; body: string; requested: MessageDelivery },
  where: "ticket" | "conversation" = "ticket",
): Promise<CommentDelivery> {
  const { requested } = message;
  const nextRun = where === "ticket" ? "the next run on this ticket" : "the next turn in this conversation";
  const queued = (note: string | null): CommentDelivery => ({ requested, outcome: "next", note });

  // Not a module dry run. That is a live row too, but it borrows the
  // item's worktree so a person can watch a module work and speaks for
  // nothing on the board (KAN-106) — a comment on the item is not for
  // it. It is also the one live run the supervisor holds no buffer for,
  // so a message written into it would be numbered off the disk while
  // the dry run's own buffer was still counting in memory.
  const activeRun = listActiveRuns(db).find((run) => run.itemId === message.itemId && !run.dryRun);
  if (!activeRun || !engine) {
    return queued(
      requested === "next"
        ? null // asked for the next turn and got it; there is nothing to correct
        : `Nothing is running on this ${where}, so there was no turn to say this into. It will be read by ${nextRun}.`,
    );
  }

  const undelivered = (result: Exclude<SteerResult, "steered">): CommentDelivery =>
    queued(
      result === "queued"
        ? null
        : result === "unsupported"
          ? `${agentOnRun(db, activeRun)} runs on a backend that cannot be spoken to mid-turn, so this was not delivered into the turn that is going. It will be read by ${nextRun}.`
          : result === "no-live-run"
            // Deliberately not "that run finished". A run row is live for
            // a while before a turn exists to say anything into — a
            // dispatch spends its preflight there — and live for a while
            // after one ends; it also covers a run that was never an agent
            // conversation at all, a built-in step or a module. Naming any
            // one of those would be EO inventing a detail to sound
            // precise. What the sentence can promise, it now keeps: the
            // supervisor records the message against that run, so the next
            // turn is given it (see `steerRun`).
            ? `That run has no live turn to say this into — it may still be starting up, or it may have just finished — so it will be read by ${nextRun}.`
            : `${agentOnRun(db, activeRun)} had already finished the turn when this arrived, so it was not read by it. It will be read by ${nextRun}.`,
    );

  // What the backend's answer means, whenever it comes. Run in the
  // promise's own continuation rather than after the race below, so a
  // steer that lands after the person was answered still closes its
  // mention exactly as one that landed before.
  const settled = (result: SteerResult): CommentDelivery => {
    if (result === "steered") {
      // Only the mention aimed at the agent that has just been told, and
      // that narrowness matters twice over. A `@user` mention on the same
      // comment is what raises `!` on the item (invariant #6) and is not
      // this agent's to close; a mention of some *other* agent has not
      // been delivered to anybody and still has a run to start.
      if (activeRun.agentId !== null) dismissOpenMentionForAgent(db, message.commentId, activeRun.agentId);
      return { requested, outcome: "now", note: null };
    }
    return undelivered(result);
  };
  const delivering = engine.steerRun(activeRun.id, { commentId: message.commentId, body: message.body, delivery: requested }).then(settled);

  // Bounded (EO-558). A Codex steer waits, with no limit of its own,
  // for the turn to have started; a Claude one waits on the SDK. The
  // comment is already the record, so the person is answered once the
  // wait is longer than a reply should take, and told the delivery is
  // still under way. Nothing about the message depends on the answer:
  // until a steer lands, the mention stays open, and the open mention is
  // what makes the next turn read it if this one never does (EO-395).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), STEER_REPLY_WITHIN_MS);
  });
  const answer = await Promise.race([delivering, late]).finally(() => clearTimeout(timer));
  if (answer !== "late") return answer;

  void delivering.then(
    (delivery) => {
      // The reply said "still being passed on"; the screen it left
      // behind shows the message as waiting. A steer that landed has
      // closed the mention since, and the chat has to hear about it.
      if (delivery.outcome === "now") emitPush("items:changed", { itemId: message.itemId });
    },
    (error: unknown) => {
      // Nobody is awaiting this any more. The mention is still open, so
      // the message is read by the next turn; this is only the account.
      console.error(`[eo] delivering comment ${message.commentId} into run ${activeRun.id} failed after the reply:`, error);
    },
  );
  return {
    requested,
    outcome: "pending",
    note:
      requested === "now"
        ? `Still being passed to the turn that is running. If that turn ends before it is read, it will be read by ${nextRun}.`
        : null,
  };
}

/**
 * How long a post waits on the backend to take a message into the
 * running turn before answering the person anyway (EO-558). A steer that
 * is going to land promptly does so well inside this; one that has not
 * is reported `pending` and finishes in the background.
 */
export const STEER_REPLY_WITHIN_MS = 1_000;

/** Who a person was writing to, for the sentence that has to say what became of it. */
function agentOnRun(db: Db, run: Run): string {
  return run.agentId === null ? "EO" : (getAgent(db, run.agentId)?.name ?? "That agent");
}

/**
 * Why this step and this pipeline cannot both be the destination, in words
 * a person can read, or null when they agree (EO-70).
 *
 * `transitionItem` asks the same question and refuses by throwing, which
 * is right for the one function allowed to write both columns — but a
 * throw reaches a caller as "Internal error" off a packaged build, and it
 * would arrive after this command had already posted the mover's note and
 * cancelled a run for a move that never happened. So the pair is resolved
 * here, before anything is written, and the answer names both halves.
 *
 * Names rather than ids throughout: a step or pipeline somebody created
 * has a uuid for an id, and a sentence full of uuids is not readable.
 */

/**
 * Why this item may not be moved there, when its own version has no
 * such step (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Null whenever there is nothing in the way, which is every item on its
 * pipeline's current version and every move that hands work to another
 * pipeline — that is entering a pipeline, and entering binds the item to
 * the version it arrives on.
 *
 * `pipelineMismatch`'s shape one field over, and its arrangement: the
 * repository throws under this, because a move that reaches the writer
 * has already been asked about; this is the answer a person or a client
 * can act on.
 *
 * A move never rebinds the item to make the step fit. The explicit way
 * to rebind is `item_move_to_version` (`items:moveToVersion`, EO-567),
 * which somebody asks for by naming the version — and which keeps the
 * step, so "put it on v3 and then on the step v3 added" is two requests
 * a person made rather than one EO inferred from a drag.
 */
function versionRefusal(db: Db, item: Item, toStepId: string, toPipelineId: Uuid | null): string | null {
  if (toPipelineId !== null && toPipelineId !== item.pipelineId) return null;
  const bound = boundGraphForItem(db, item);
  if (bound === null || bound.steps.some((step) => step.id === toStepId)) return null;
  return stepNotInVersionMessage({ stepName: getStep(db, toStepId)?.name ?? toStepId, number: bound.number });
}

function pipelineMismatch(db: Db, toStepId: string, toPipelineId: Uuid): string | null {
  const nameOfPipeline = (id: string) => getPipeline(db, id)?.name ?? id;
  const destination = nameOfPipeline(toPipelineId);
  const step = getStep(db, toStepId);
  if (!step) {
    return `EO has no step "${toStepId}", so it cannot be where a ticket enters "${destination}". Nothing moved.`;
  }
  if (step.pipelineId === toPipelineId) return null;
  return (
    `"${step.name}" is a step of "${nameOfPipeline(step.pipelineId)}", not of "${destination}". A ticket's step and ` +
    `its pipeline have to name the same place — one written without the other leaves the ticket on a step its own ` +
    `pipeline does not have, where no scheduler tick can see it — so nothing moved. Name a step "${destination}" ` +
    `actually has, or leave the pipeline out to move the ticket within the one it is already on.`
  );
}

/**
 * Is anything working on this item right now (EO-175)?
 *
 * The runs table cannot answer it. A dispatch takes several seconds
 * between the scheduler deciding on it and its run row existing — auth,
 * a worktree, a context assembly — and for the whole of that window the
 * table says the item is idle while a run is being prepared against
 * it. That is the window EO-173 was watched in: the move found no row,
 * said nothing, and let the dispatch write a run for the step the item
 * had just left.
 *
 * The lock is the only thing that knows, because claiming the item is
 * the first thing a dispatch does and giving it back is the last. With
 * the preflight recheck in place the move can still go through — the
 * doomed dispatch turns itself back on its own — but the person is asked
 * first, in the wording every blocked action in EO already answers with,
 * instead of losing a silent race.
 *
 * The row is still consulted, and not only so these commands answer the
 * same way when they are called without an engine. The lock lives in
 * memory: a run left `queued` by a process that died is a claim nobody
 * holds, and until reconciliation has dealt with it the honest answer to
 * a person is still that something is on this item.
 */
function busy(engine: EngineHandle | undefined, itemId: Uuid, activeRun: Run | undefined): boolean {
  return (engine?.itemLock.isHeld(itemId) ?? false) || activeRun !== undefined;
}

/**
 * A human dragging a card to another column (U-02), or handing the item
 * to another pipeline altogether (EO-70).
 *
 * This is an override, so it is recorded like any other transition —
 * `actor: "human"`, its own transitions row — rather than quietly
 * setting a field. The engine owns transitions (invariant #1) and this
 * still goes through the one function allowed to write items.stepId,
 * which is also the only one that can write `pipelineId` beside it
 * without the two ever being apart.
 *
 * If an agent is mid-run on the item, the move is refused unless the
 * caller explicitly said to cancel it. Moving an item out from under a
 * running agent throws away work in progress, and doing that on a
 * mis-drag would be a genuinely bad surprise — so the UI has to confirm
 * first, and the refusal is what makes it.
 */
export function moveItem(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"items:move">): IpcResponse<"items:move"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${input.itemId} not found`);

  // Off a step that waits on a group, only the person holding the item
  // may move it (EO-368) — asked first, because nothing about where it is
  // going matters to somebody who may not move it at all.
  const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "move");
  if (notTheirs !== null) return { moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: notTheirs };

  const toPipelineId = input.toPipelineId === undefined ? null : (input.toPipelineId as Uuid);

  // Before the active-run guard, deliberately: a pair that cannot be moved
  // to is a fact about the request, not about the item. Asking first
  // would have a caller cancel a running agent to be told afterwards that
  // the move was never possible.
  if (toPipelineId !== null) {
    const problem = pipelineMismatch(db, input.toStepId, toPipelineId) ?? itemEntryRefusal(db, item, toPipelineId, input.toStepId);
    if (problem !== null) return { moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem };
  }

  // And a step the item's own version does not have (EO-327, ARCHITECTURE.md, "Publish, lock and
  // versions"), for
  // the same reason and in the same place. The board draws the columns
  // the pipeline has *now*, so a card finishing on v6 can be dragged
  // onto a column v7 added — and there it would run by a definition its
  // version never agreed to and then have no route out. Refused rather
  // than repaired: re-binding the item to v7 would be EO deciding that a
  // drag meant "start this again under the new rules".
  // Somebody who does mean that says so with `item_move_to_version`
  // (EO-567), and then makes this move.
  //
  // Typed, before the run guard, for `pipelineMismatch`'s reason: a
  // destination that was never possible must not cost somebody a
  // running agent to find out about.
  const outsideVersion = versionRefusal(db, item, input.toStepId, toPipelineId);
  if (outsideVersion !== null) return { moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: outsideVersion };

  const activeRun = listRunsForItem(db, itemId).find((run) => run.status === "running" || run.status === "queued");

  if (busy(engine, itemId, activeRun) && !input.cancelActiveRun) {
    return { moved: false, cancelledRunId: null, blockedByActiveRun: true, commentId: null, problem: null };
  }

  // Steps are named for people and identified by uuid. Reading the id back
  // was legible while ids were slugs (`ready_to_merge`); a step somebody
  // created reads as a uuid, and this comment is permanent.
  const nameOf = (stepId: string | null) => (stepId === null ? "no pipeline" : (getStep(db, stepId)?.name ?? stepId));

  // The person's own words go in before the transition, so the thread
  // reads in the order things happened and the comment sits in front of
  // whichever agent the move dispatches (ARCHITECTURE.md, "Moving an item by hand").
  const acting = actingCaller(db, input.actingDeviceId);
  const note = input.comment.trim();
  const commentId = note === "" ? null : postComment(db, { itemId, author: humanAuthor(acting), body: note }).id;

  if (activeRun) {
    engine?.cancelRun(activeRun.id, "superseded");
    postComment(db, {
      itemId,
      runId: activeRun.id,
      author: { type: "engine" },
      body: `Run cancelled: you moved this ticket from "${nameOf(item.stepId)}" to "${nameOf(input.toStepId)}" while an agent was working on it.`,
    });
  }

  // The pipeline goes with the step or not at all: the transition
  // writes both columns in one transaction, and passing it only when one
  // was named is what keeps an ordinary in-pipeline move reading exactly
  // as it did — that column untouched.
  //
  // A command the record applies rather than a write of our own
  // (EO-322): a person dragging a card on a desktop is asking for a
  // move, and the record is the one writer of where an item sits
  // (invariant #1). In solo mode that record is in this process and
  // over this same database, so nothing about this move has changed —
  // which is the point of doing the split here rather than when there
  // is a server to force it.
  recordFor(db).applyTransition({
    itemId,
    toStepId: input.toStepId,
    ...(toPipelineId === null ? {} : { toPipelineId }),
    actor: "human",
    // Which machine asked, and therefore which person (EO-326, ARCHITECTURE.md, "Identity").
    // `actor` says what *kind* of thing moved it and cannot say who —
    // this is the column that joins a move to a name, and it is what
    // makes "your move was superseded by Dana's" answerable. Undefined
    // on a desktop, where the transition has always recorded no device
    // because there is only the one.
    ...actingDevice(acting),
    reason: "moved on the project",
  });
  engine?.notifyStateChange(); // the new column may be dispatchable right now

  return announceItem(itemId, { moved: true, cancelledRunId: activeRun?.id ?? null, blockedByActiveRun: false, commentId, problem: null });
}

/**
 * Binding an item to another version of the pipeline it is on (EO-567,
 * ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The explicit request `versionRefusal` points at: a person, or the
 * system agent on their behalf, naming the version the item should
 * finish on. Not a move — the step, the pipeline, the assignee and the
 * branch stay as they are and no transition is written — so it goes
 * nowhere near `transitionItem` (invariant #1). What changes is which
 * graph the item is routed and dispatched by from here on.
 *
 * Every refusal is settled before anything is written, and the request's
 * own facts before the run guard, `moveItem`'s order and for its reason.
 *
 * On an item the organisation's record holds, the record decides
 * (EO-322): this asks it, by a command it applies, and writes nothing
 * here. The binding and the comment come back on the next pull, which is
 * also how they reach every other desktop.
 */
export function moveItemToVersion(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"items:moveToVersion">,
): IpcResponse<"items:moveToVersion"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${input.itemId} not found`);

  const plan = planVersionMove(db, item, input.version);
  if (!plan.ok) return { moved: false, queued: false, fromVersion: plan.from, toVersion: null, commentId: null, problem: plan.problem };

  const activeRun = listRunsForItem(db, itemId).find((run) => run.status === "running" || run.status === "queued");
  if (busy(engine, itemId, activeRun)) {
    return {
      moved: false,
      queued: false,
      fromVersion: plan.from,
      toVersion: null,
      commentId: null,
      problem:
        `An agent is working on ${item.key} right now, and moving it to version ${input.version} would change the rules ` +
        "under that run. Wait for it to finish, or cancel it, and ask again.",
    };
  }

  if (isReplica(db, itemId)) {
    const commentId = uuidv7() as Uuid;
    notifyVersionMoveAsked(db, { itemId, version: input.version, commentId, note: input.comment });
    return announceItem(itemId, { moved: true, queued: true, fromVersion: plan.from, toVersion: plan.to.number, commentId, problem: null });
  }

  const acting = actingCaller(db, input.actingDeviceId);
  const comment = writeVersionMove(db, {
    item,
    move: plan,
    by: acting.person?.name ?? "the organisation's operator",
    note: input.comment,
  });
  engine?.notifyStateChange(); // its own version may dispatch it where the old one did not

  return announceItem(itemId, { moved: true, queued: false, fromVersion: plan.from, toVersion: plan.to.number, commentId: comment.id, problem: null });
}

/**
 * A person deciding on a human step (EO-310, ARCHITECTURE.md, "Results and routes", "The item").
 *
 * The gesture this whole phase is about. `moveItem` above names a
 * *destination* — it is a drag, and a drag commands the move
 * directly, never through `resolveRoute`. This names an **answer**: the step
 * declares "approved" and "send back", the routes say where each one
 * goes, and the engine resolves the pair exactly as it resolves an
 * agent's verdict. A marketing manager approving a post is then the same
 * kind of event as a reviewer approving a change, which is what makes
 * "send it back, the Q3 number is wrong" something that can travel.
 *
 * Every refusal names which of them it is, because each has a different
 * next move: the wrong step, a key the step does not declare, a reason
 * nobody wrote, a run in flight, or wiring that goes nowhere. They are
 * settled before anything is written, so a refusal never leaves a
 * comment behind for a decision that did not happen.
 *
 * The order of the two writes is `moveItem`'s and for its reason
 * (ARCHITECTURE.md, "Moving an item by hand"): the person's words go in *before* the transition, so
 * the
 * thread reads in the order things happened and the comment sits in
 * front of whichever agent the decision dispatches. Which is the whole
 * value of a send-back — the implementer is dispatched again, and
 * without the reason in front of it, it has nothing to go on but the
 * fact that the item came back.
 */
export function decideItem(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"items:decide">): IpcResponse<"items:decide"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${input.itemId} not found`);

  const refuse = (problem: string): IpcResponse<"items:decide"> => ({
    decided: false,
    toStepId: null,
    toStepName: null,
    toPipelineId: null,
    commentId: null,
    problem,
  });

  // The system agent pressing it rather than the person (EO-585): the
  // id is the administrative host's, stamped from the turn's credential.
  const standIn = actingAgentFor(db, input.actingAgentId);
  if ("problem" in standIn) return refuse(standIn.problem);
  const agent = standIn.agent;

  // On a step that waits on a group only the holder decides (EO-368) —
  // and the system agent, pressing it on live work, decides with the
  // authority of the person it acts for and no more. On a trial item it
  // stands in for whoever the step would ask, so no hold binds it; the
  // record applies the same rule (`serveRecord.ts`).
  const standingIn = agent !== null && item.trialAt !== null;
  const notTheirs = standingIn ? null : refusedOnGroupStep(db, item, input.actingDeviceId, "decision");
  if (notTheirs !== null) return refuse(notTheirs);

  const step = stepForItem(db, item);
  // The step, the key and the missing reason, judged in the engine
  // (invariant #2): what may be decided is a property of the step's own
  // declaration, and nothing about it needs a database.
  const refusal = decisionRefusal({ step, resultKey: input.resultKey, comment: input.comment });
  if (refusal !== null) return refuse(refusal);
  // Narrowed by the guard above, which refuses every case where there is
  // no user step and no declared result to have matched.
  const decided = step!.results.find((result) => result.key === input.resultKey)!;

  // A user step is never dispatched, so an item sitting on one normally
  // has nothing in flight — but a person can put an agent on any item by
  // mentioning it (`manualDispatch`), and deciding under that run would
  // move the item out from under work in progress. `moveItem` offers to
  // cancel; this refuses outright, because a decision is not a correction
  // of a run and nothing about approving something says "and throw that
  // away".
  const activeRun = listRunsForItem(db, itemId).find((run) => run.status === "running" || run.status === "queued");
  if (busy(engine, itemId, activeRun)) {
    return refuse(
      "An agent is working on this item right now, and deciding would move it out from under that run. Wait for it to " +
        "finish, or cancel it, and decide again. Nothing has changed.",
    );
  }

  // A suggestion is decided like anything else, and approving one
  // publishes (EO-331, ARCHITECTURE.md, "Divergence and suggestions"). Asked before the route and
  // before any
  // write, so that a change EO cannot apply is a refusal on the button
  // rather than an item settled about a publish that never happened.
  const unpublishable = suggestionRefusal(db, item, input.resultKey);
  if (unpublishable !== null) return refuse(unpublishable);

  const outcome = resolveDecisionRoute(db, item, step!, input.resultKey);
  // A decision that hands the item to another pipeline is entering it
  // like any other way in (EO-610). A person is here, so they are told on
  // the button rather than parked on: the item is already on their step.
  if (outcome.kind === "step") {
    const refused = itemEntryRefusal(db, item, outcome.pipelineId, outcome.stepId);
    if (refused !== null) return refuse(refused);
  }
  if (outcome.kind === "user_attention") {
    return refuse(
      `"${decided.label}" is routed to a person's attention, which is where this item already is — taking it would ` +
        "leave the item exactly where it stands. Ask the assistant to point that result at a step. Nothing has changed.",
    );
  }
  if (outcome.kind !== "step") {
    return refuse(
      `"${decided.label}" has nowhere to go: ${outcome.reason === "no_terminal" ? "it finishes the pipeline, and no step is marked terminal" : "nothing routes it out of this step"}. ` +
        "Ask the assistant to route it. Nothing has changed.",
    );
  }

  // The person's own words first, and as a decision rather than a note:
  // `approval` where the result approves and `rejection` where it sends
  // work back, so a thread re-read a month later says which happened
  // without anyone parsing the prose. The tone is what says which — it
  // is the one thing on a result that already means "this is the good
  // outcome", and the alternative, a second flag beside it, would be the
  // same fact twice and free to disagree with the colour of the button.
  const acting = actingCaller(db, input.actingDeviceId);
  const note = input.comment.trim();
  // Addressed to the author where this is a suggestion (EO-331, the original design):
  // "Send back with a comment reaches the author's inbox", and a
  // comment with no mention reaches nobody's. Empty for every other
  // item, which is every item EO had before suggestions existed.
  const audience = suggestionMentions(db, item, acting);
  // The system agent's press is always in the thread, under its own name
  // (EO-585): a person reading it later has to be able to tell that it
  // was not them, and the transition's actor is not something a thread
  // shows. With no words of its own it says what it pressed; on a trial
  // item it says, too, that it pressed it on the person's behalf. Its
  // words are judged above exactly as a person's are — the note is added
  // after, so a result that needs a reason still refuses an empty one.
  const body = agent === null ? note : standInBody(item, note === "" ? `Decided "${decided.label}".` : note, "decided");
  const commentId =
    body === ""
      ? null
      : postComment(db, {
          itemId,
          author: agent === null ? humanAuthor(acting) : { type: "agent", agentId: agent.id },
          kind: decided.tone === "success" ? "approval" : "rejection",
          body,
          ...(audience.length === 0 ? {} : { mentions: audience }),
        }).id;

  // What approving one *does*, after the person's words and before the
  // move: apply the document and publish it (ARCHITECTURE.md, "Divergence and suggestions").
  // Nothing for any
  // other item, and nothing for a send-back — the comment above is the
  // whole of that one.
  settleSuggestion(db, item, input.resultKey, acting);

  const toStep = getStep(db, outcome.stepId);
  // The record applies it, exactly as it applies the drag above.
  recordFor(db).applyTransition({
    itemId,
    toStepId: outcome.stepId,
    // Both halves together, always — a decision may hand the item to
    // another pipeline (EO-58), and `resolveRoute` answers with the
    // pipeline precisely so the move is never written half-way.
    toPipelineId: outcome.pipelineId,
    // The system agent's own id where it pressed it (EO-585) — never
    // "human" for a press the person did not make.
    // The result pressed (EO-586): two of a step's results may lead to
    // the same step, and whatever listens to the move is told which.
    resultKey: input.resultKey,
    actor: agent?.id ?? "human",
    // As on the drag above: who decided, through the device that asked.
    ...actingDevice(acting),
    // `decided ` first either way: it is how a queued command is told
    // apart from a drag (`actOf`, record/drain.ts).
    reason: agent === null ? `decided "${decided.label}"` : `decided "${decided.label}" on the person's behalf`,
  });
  engine?.notifyStateChange(); // the step it arrived on may be dispatchable right now

  return announceItem(itemId, {
    decided: true,
    toStepId: outcome.stepId,
    toStepName: toStep?.name ?? null,
    toPipelineId: outcome.pipelineId,
    commentId,
    problem: null,
  });
}

/**
 * Parks an item on its current step (EO-45).
 *
 * This deliberately follows `moveItem`'s active-run guard and comment
 * ordering. The difference is the write: a hold changes only `heldAt`,
 * never pipeline state, so resuming exposes the same work to the next
 * scheduler tick without a transition in between.
 */
export function holdItem(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"items:hold">): IpcResponse<"items:hold"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${input.itemId} not found`);

  const activeRun = listRunsForItem(db, itemId).find((run) => run.status === "running" || run.status === "queued");
  if (busy(engine, itemId, activeRun) && !input.cancelActiveRun) {
    return { held: false, cancelledRunId: null, blockedByActiveRun: true, commentId: null };
  }

  // The person's words are first in the thread, before cancellation,
  // storage or EO's own explanation (invariant #4).
  const note = input.comment.trim();
  const commentId = note === "" ? null : postComment(db, { itemId, author: { type: "human" }, body: note }).id;

  if (activeRun) engine?.cancelRun(activeRun.id, "superseded");
  setItemHeld(db, itemId, Date.now());

  const stepName = item.stepId === null ? "no pipeline" : (getStep(db, item.stepId)?.name ?? item.stepId);
  postComment(db, {
    itemId,
    runId: activeRun?.id ?? null,
    author: { type: "engine" },
    body: activeRun
      ? `Run cancelled because you put this ticket on hold at "${stepName}". It will stay on this step until you resume it.`
      : `Ticket put on hold at "${stepName}". It will stay on this step until you resume it.`,
  });

  engine?.notifyStateChange();
  return announceItem(itemId, { held: true, cancelledRunId: activeRun?.id ?? null, blockedByActiveRun: false, commentId });
}

/**
 * Clears a hold while preserving the item's pipeline and step.
 *
 * The active-run guard is `moveItem`'s, unchanged. Holding an item
 * either refuses or cancels the run in flight, so in practice a held
 * item has none — but `cancelRun` is asynchronous and a run can be
 * queued against an item by other means, and resuming into one would let
 * the very next tick dispatch a second agent onto work already underway.
 * Refusing is the safe default; cancelling stays the caller's decision.
 */
export function resumeHeldItem(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"items:resume">): IpcResponse<"items:resume"> {
  const itemId = input.itemId as Uuid;
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${input.itemId} not found`);

  const activeRun = listRunsForItem(db, itemId).find((run) => run.status === "running" || run.status === "queued");
  if (activeRun && !input.cancelActiveRun) {
    return { resumed: false, cancelledRunId: null, blockedByActiveRun: true };
  }

  if (activeRun) engine?.cancelRun(activeRun.id, "superseded");
  setItemHeld(db, itemId, null);
  // Resuming is a person handing the item back to the scheduler, and
  // it is the one re-authorisation that leaves the item exactly where
  // it stood — same step, same initiation — so a cancellation taken
  // before the hold would otherwise still be standing off it (EO-175).
  // A move needs nothing of the sort: it puts the item in a new
  // initiation by being a move.
  clearStop(db, itemId);

  const stepName = item.stepId === null ? "no pipeline" : (getStep(db, item.stepId)?.name ?? item.stepId);
  // What happens next, checked rather than assumed (EO-135, invariant #8).
  // The hold is already cleared above, so this reads the board the
  // scheduler will read on its next tick — and it asks the same function
  // the scheduler decides with, so the acknowledgement and the outcome
  // cannot disagree. #142 is what the unconditional promise cost: a
  // item reported as live that nothing was ever going to pick up.
  // Asked of the engine, so the rules the pack installed are part of the
  // answer (KAN-161). With no engine at all there is no installation to
  // ask and the core's own rules are the whole of it — which is a test,
  // or a process that never composed one.
  const blocker = engine
    ? engine.dispatchBlockerFor(itemId)
    : (archivedProjectBlocker(db, itemId) ?? dispatchBlocker(buildEligibilityInput(db, false), itemId));
  const outlook = resumeOutlook(stepName, blocker);
  postComment(db, {
    itemId,
    runId: activeRun?.id ?? null,
    author: { type: "engine" },
    body: activeRun
      ? `Run cancelled because you resumed this ticket at "${stepName}" while that run was still in flight. ${outlook}`
      : `Ticket resumed at "${stepName}". ${outlook}`,
  });

  engine?.notifyStateChange();
  return announceItem(itemId, { resumed: true, cancelledRunId: activeRun?.id ?? null, blockedByActiveRun: false });
}

/**
 * Taking an item (EO-305, the original design).
 *
 * "A claim is an assignee change plus a comment, not a transition." Both
 * halves matter. The change is one column, so the item does not move and
 * no run is disturbed — which is why this has none of `items:move`'s
 * active-run guard: an agent working on the step below is unaffected by
 * somebody putting their name on the card. The comment is invariant #4:
 * who picked up a piece of work is exactly the kind of thing that must
 * not happen silently, and the thread is the only place EO says anything.
 *
 * The caller is the local person in solo mode, and the person the door
 * stamped on a server. On a signed-in desktop the item's holder is the
 * record's to decide, so the claim is *asked* — see `askTheRecord` —
 * and it never gains a parameter naming the claimant, because a claim
 * whose payload could name somebody else is `items:assign`.
 */
export function claimItem(db: Db, input: IpcPayload<"items:claim">): IpcResponse<"items:claim"> {
  const itemId = input.itemId as Uuid;
  if (isReplica(db, itemId)) return askTheRecord(db, itemId, { how: "claim" });
  // On the record, answering a browser (EO-368): only a member of the
  // step's group may claim, and an item somebody else holds is theirs —
  // the way forward from there is a takeover, after a warning.
  const acting = actingCaller(db, input.actingDeviceId);
  if (acting.served) {
    const item = getItem(db, itemId);
    if (!item) throw new Error(`ticket ${itemId} not found`);
    const refusal = judgeClaimOutright(db, item, acting.person?.id ?? null);
    if (refusal !== null) {
      const said = sayNotPermitted(db, item, acting, "claim", refusal);
      return { assigneeId: refusal.holder?.id ?? null, assigneeName: refusal.holder?.name ?? null, commentId: said.commentId, problem: said.line };
    }
  }
  return { ...assignTo(db, itemId, actingPersonId(db, input.actingDeviceId), "claim"), problem: null };
}

/**
 * Taking an item over from the person who holds it, on a step that waits
 * on a group (EO-368).
 *
 * What a member who does not hold the item sends once they have seen the
 * warning naming the holder and confirmed it. `fromPersonId` is that
 * holder, and it is a condition: if the item has changed hands since,
 * nothing is taken and the answer — and an inbox row — names who holds it
 * now. Applied, it leaves "Dana took this over from Anna." on the thread
 * with a mention of Anna, so the person who lost it hears.
 *
 * On a signed-in desktop it is asked of the record, like a claim.
 */
export function takeOverItem(db: Db, input: IpcPayload<"items:takeOver">): IpcResponse<"items:takeOver"> {
  const itemId = input.itemId as Uuid;
  if (isReplica(db, itemId)) return askTheRecord(db, itemId, { how: "takeover", fromPersonId: input.fromPersonId as Uuid });
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${itemId} not found`);

  const acting = actingCaller(db, input.actingDeviceId);
  const taker = acting.person;
  const refusal = judgeOnGroupStep(db, item, taker?.id ?? null, "takeover", input.fromPersonId);
  if (refusal !== null) {
    const said = sayNotPermitted(db, item, acting, "takeover", refusal);
    return { assigneeId: refusal.holder?.id ?? null, assigneeName: refusal.holder?.name ?? null, commentId: said.commentId, problem: said.line };
  }
  const previous = holderView(db, item.assigneeId);
  // Nothing gates the step, or the item is already theirs: there is no
  // holder to take it from. Said rather than done, because a takeover is
  // only ever offered where the step waits on a group and somebody else
  // holds the item — anything else reaching here is a stale screen.
  if (taker === null || previous === null || previous.id !== input.fromPersonId || previous.id === taker.id) {
    return {
      assigneeId: previous?.id ?? null,
      assigneeName: previous?.name ?? null,
      commentId: null,
      problem: "There is nobody to take this over from: only an item somebody else holds, on a step that waits on a group, can be taken over.",
    };
  }
  const comment = writeTakeover(db, { itemId, person: taker, previous });
  return announceItem(itemId, { assigneeId: taker.id, assigneeName: taker.name, commentId: comment.id, problem: null });
}

/**
 * Whether the person asking may change this item where it stands, said
 * where they will see it when they may not (EO-368).
 *
 * Asked only of a request the record answers for a browser — the door
 * stamped who is asking. A desktop's own request is its one person on
 * their own installation (solo mode, nothing refused), or a replica's,
 * whose moves and decisions the record judges when they arrive.
 *
 * Answers the sentence for the caller's `problem`, or null to go ahead.
 */
function refusedOnGroupStep(db: Db, item: Item, actingDeviceId: string | null | undefined, act: StepAct): string | null {
  const acting = actingCaller(db, actingDeviceId);
  if (!acting.served || isReplica(db, item.id)) return null;
  const refusal = judgeOnGroupStep(db, item, acting.person?.id ?? null, "change");
  return refusal === null ? null : sayNotPermitted(db, item, acting, act, refusal).line;
}

/**
 * An edit on a signed-in desktop to an item on a step that waits on a
 * group, by somebody who does not hold it (EO-368).
 *
 * The odd one out, and deliberately. A move and a decision are commands
 * the record applies, so the record judges them when they arrive. An
 * edit to an item's text is not — nothing carries it to the record — so
 * there is no answer coming back to undo it with, and an edit made here
 * would sit on this machine's copy disagreeing with everybody's. So this
 * machine asks the one question it can answer for itself: does the person
 * signed in here hold the item? Membership needs the record and does not
 * need asking — a holder claimed it as a member.
 *
 * Told the way the record's refusals are told: an escalation mentioning
 * the person here, kept on this machine.
 */
function refusedEditOnReplica(db: Db, item: Item): string | null {
  if (!isReplica(db, item.id)) return null;
  const step = stepForItem(db, item);
  if (step === undefined || step.type !== "user" || step.ownerGroupId === null) return null;
  const you = signedInPersonId(db);
  // The organisation's groups are not copied to a desktop wholesale; a
  // step pointed at one from the picker adopted its row, and anything
  // else is named for what it is.
  const groupName = getGroup(db, step.ownerGroupId)?.name ?? "its group";
  // Shown as theirs, but only because this machine asked: a claim or a
  // takeover still queued may yet be refused, and an edit — which never
  // reaches the record — could not be undone with it. So a provisional
  // hold authorises nothing; the record's confirmation does.
  const yours = item.assigneeId !== null && item.assigneeId === you;
  if (yours && !holdingIsProvisional(db, item.id)) return null;
  const line = yours
    ? editAwaitingHoldLine(item.key, groupName)
    : stepRefusalLine(item.key, "edit", { why: item.assigneeId === null ? "unclaimed" : "heldBy", groupName, holder: holderView(db, item.assigneeId) });
  postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body: line,
    mentions: [{ type: "human" }],
    parseBodyMentions: false,
    staysHere: true,
  });
  return line;
}

/**
 * A refusal on a group-owned human step, said on the item (EO-368,
 * invariants #4 and #8): an escalation mentioning the person refused, so
 * it reaches their inbox, saying why and naming the group or the holder.
 * The same sentence the desktop says when the record refuses its queued
 * command (`record/drain.ts`).
 *
 * A caller who is nobody — the operator's key — is told in the answer
 * and on the thread, and mentioned nowhere: there is no inbox to reach.
 */
function sayNotPermitted(db: Db, item: Item, acting: ActingCaller, act: StepAct, refusal: StepRefusal): { line: string; commentId: Uuid } {
  const line = stepRefusalLine(item.key, act, refusal, acting.person?.id ?? null);
  const comment = postComment(db, {
    itemId: item.id,
    author: { type: "engine" },
    kind: "escalation",
    body: line,
    mentions: acting.person === null ? [] : [{ type: "human", personId: acting.person.id }],
    parseBodyMentions: false,
  });
  return { line, commentId: comment.id };
}

/**
 * Handing an item to somebody (EO-305, ARCHITECTURE.md, "The board").
 *
 * The same write as a claim, said differently in the thread, because
 * they are different events: "Anna claimed this" is Anna deciding, and
 * "this was assigned to Anna" is somebody else deciding for her. A
 * thread that recorded both as a claim would lose which happened, and
 * that is the part a person re-reading the item wants.
 *
 * Gating *who* may assign, and gating a decision on being the assignee,
 * is 7b's with groups — the phase note says so. Until there is more than
 * one person and a server that knows which of them is asking, there is
 * nobody to refuse.
 */
export function assignItem(db: Db, input: IpcPayload<"items:assign">): IpcResponse<"items:assign"> {
  const itemId = input.itemId as Uuid;
  if (isReplica(db, itemId)) return askTheRecord(db, itemId, { how: "assign", personId: input.personId as Uuid });
  const acting = actingCaller(db, input.actingDeviceId);
  // Named only where naming adds something. On a desktop the assigner is
  // the one person there is, and "by you" on every row would be the app
  // telling somebody what they had just done.
  return assignTo(db, itemId, input.personId as Uuid, "assign", acting.served ? acting.person?.name : undefined);
}

/**
 * The write both channels make, and the sentence each leaves behind.
 *
 * Unknown ids throw rather than returning a refusal: the screens that
 * call this pick from the board and from the people EO knows, so an id
 * naming nothing is a bug in the caller rather than a case a person can
 * do anything about (working agreement: throw only for programmer
 * error). A guard that a *person* can trip — assigning work on a step
 * nobody is waiting on, say — is 7b's, and would end in a comment.
 */
function assignTo(
  db: Db,
  itemId: Uuid,
  personId: Uuid,
  how: "claim" | "assign",
  /**
   * Who did the assigning, where EO can name them (EO-326, the original design).
   *
   * "Assigned to Anna" is the sentence a solo desktop has always left,
   * and it is still the whole truth there: one person, and naming them
   * would be telling them about themselves. On a server it is half of
   * one — an admin handing another team's item to somebody is exactly
   * the event whose missing half a person re-reading the thread wants.
   */
  by?: string,
): { assigneeId: string; assigneeName: string; commentId: string } {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${itemId} not found`);
  const person = getPerson(db, personId);
  if (!person) throw new Error(`no person ${personId} — an item cannot be assigned to somebody EO has no row for`);

  const comment = writeAssignment(db, { itemId, person, how, ...(by === undefined ? {} : { by }) });

  return announceItem(itemId, { assigneeId: person.id, assigneeName: person.name, commentId: comment.id });
}

/**
 * A claim or an assignment on an item whose record is elsewhere
 * (EO-367, ARCHITECTURE.md, "The record").
 *
 * A move's shape, applied to who holds the item: shown here at once,
 * queued for the record (`record/outbound.ts` hears `notifyAssignmentAsked`),
 * and provisional until the record answers. The record decides. It
 * resolves who is claiming from the device the command arrived on, so the
 * holder is the signed-in person on every machine and never the local
 * "you" row; it refuses a claim on an item somebody else already holds,
 * and the device tells the person whose claim lost (`record/drain.ts`).
 *
 * **No comment is written here.** The sentence is the record's ("Claimed
 * by Anna."), written when it applies the claim, under the id minted
 * here, and it reaches this thread on the next pull like every other
 * machine's. A copy written here first would be "Claimed by you." on the
 * thread for ever, and on the machine whose claim lost it would be a
 * sentence about something that never happened.
 *
 * The assignee shown meanwhile is the person being asked for, under the
 * record's own id: the signed-in person for a claim, the colleague picked
 * for an assignment. Where this machine cannot name them — a claim on a
 * moved project after signing out, or a colleague the organisation's list
 * could not be asked about (`knowAssignee` asks it first) — it shows
 * **nobody new**: the card keeps what the record last said, is drawn as
 * queued, and the command goes up anyway for the record to decide. Never
 * the local "you", which is the one answer a managed claim must not get.
 * And if the record refuses, `drain.ts` puts its holder back.
 */
function askTheRecord(
  db: Db,
  itemId: Uuid,
  asked: { how: "claim" } | { how: "assign"; personId: Uuid } | { how: "takeover"; fromPersonId: Uuid },
): { assigneeId: string | null; assigneeName: string | null; commentId: string; problem: null } {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`ticket ${itemId} not found`);
  // A takeover is the signed-in person taking it, exactly as a claim is.
  const person = asked.how === "assign" ? (getPerson(db, asked.personId) ?? null) : signedInPerson(db);

  if (person !== null) setReplicaAssignee(db, itemId, person);
  const commentId = uuidv7() as Uuid;
  notifyAssignmentAsked(
    db,
    asked.how === "claim"
      ? { how: "claim", itemId, commentId }
      : asked.how === "assign"
        ? { how: "assign", itemId, personId: asked.personId, commentId }
        : { how: "takeover", itemId, fromPersonId: asked.fromPersonId, commentId },
  );

  return announceItem(itemId, {
    assigneeId: person?.id ?? (asked.how === "assign" ? asked.personId : null),
    assigneeName: person?.name ?? null,
    commentId,
    problem: null,
  });
}

export function setPinned(db: Db, input: IpcPayload<"comments:setPinned">): IpcResponse<"comments:setPinned"> {
  const commentId = input.commentId as Uuid;

  // Looked up before the write rather than after it. `setCommentPinned`
  // is an UPDATE by id: an id nothing matches touches no rows and says
  // so to nobody, so reporting the pin without checking would tell a
  // caller that a comment EO has never held is now the one every agent
  // reads first.
  const comment = getComment(db, commentId);
  if (!comment) return { pinned: input.pinned, found: false };

  setCommentPinned(db, commentId, input.pinned);

  // Pinning changes what every later agent reads, so it is worth
  // announcing even though it writes no comment of its own.
  return announceItem(comment.itemId, { pinned: input.pinned, found: true });
}

/**
 * What the thread says about a link that changed (EO-125, invariant 8).
 *
 * Three sentences for three changes, and each says what the item is
 * about to do next (EO-127): an attached item reads its issue in, on
 * the pull schedule's next tick, and the reader wants to know that
 * before the title changes under them rather than after. Saying so is
 * also what makes the note that follows — `reconcileFields`' record of
 * what Jira replaced — legible instead of alarming.
 *
 * An item whose sync is off gets the opposite sentence rather than
 * silence. Attaching is exactly where somebody expects the issue to
 * arrive, so the one case where it will not is the one worth naming.
 *
 * A relink names both issues. "This item now mirrors KAN-9" alone
 * leaves no record of what it mirrored yesterday, which is precisely
 * what a person reading the thread after a wrong key is looking for.
 *
 * An engine note, so none of this is mirrored back to the issue
 * (EO-75) — EO telling Jira about EO's own bookkeeping.
 */
function noteJiraLink(db: Db, itemId: Uuid, before: string | null, after: string | null, pulling: boolean): void {
  // What is about to arrive, said once and used by both attach
  // branches. Blank when sync is off, because then nothing is.
  const backfill = pulling
    ? ` ${after}'s comments and attachments are being brought in now, and its summary, description and acceptance criteria replace what this ticket holds — a note will record whatever they replaced.`
    : ` Nothing is being brought in from ${after}: this ticket's Jira sync is off, so switching it on is what asks for the issue's comments, attachments and text.`;

  const body =
    after === null
      ? `This ticket no longer mirrors ${before}. Jira pushes still queued for it were dropped, and nothing here reaches Jira — or comes back from it — until a key is attached again.`
      : before === null
        ? `This ticket now mirrors ${after}.${backfill}`
        : `This ticket now mirrors ${after} and no longer ${before}.${backfill}`;

  postComment(db, { itemId, author: { type: "engine" }, kind: "note", body });
}

/** What a switch thrown on a feature did to the stories under it. */
interface SyncCascade {
  /** How many stories are under it at all — 0 means say nothing about stories. */
  children: number;
  /** How many of them this actually changed, which is what the note names. */
  changed: number;
}

/**
 * Carries the switch down to a feature's stories (EO-125).
 *
 * `jira_sync` is stored per item and there is no dynamic inheritance
 * (the pinned decision on EO-121): what an item does is readable off
 * its own row, so "this feature is quiet now" has to be written onto
 * each story rather than inferred from the parent at read time.
 *
 * "This feature" is read exactly as `pullItem` reads it: its direct
 * children, archived ones included. Archived because an archived story
 * still holds its key and `pullProject` still pulls it, so leaving it
 * loud is leaving an item talking to Jira after someone silenced the
 * feature it belongs to. Direct because that is the shape a feature has
 * — and running it over any item rather than only a feature is the
 * same choice `pullItem` makes: a story has no children, so the walk
 * is empty and there is no type test to keep in step.
 */
function cascadeJiraSync(db: Db, item: Item, enabled: boolean): SyncCascade {
  const children = listItemsIncludingArchived(db).filter((entry) => entry.parentId === item.id);
  let changed = 0;
  for (const child of children) {
    if (jiraStateOf(child).sync === enabled) continue;
    if (setJiraSync(db, child.id, enabled).ok) changed += 1;
  }
  return { children: children.length, changed };
}

/**
 * How far the switch reached, in a number every time (EO-125).
 *
 * A feature always says how many stories it changed, zero included.
 * "This feature is quiet now" is a claim about its stories as much as
 * about itself, and the reader of the note cannot see how many there
 * are — so silence about the cascade reads as "the stories were dealt
 * with" whether they were, were already there, or do not exist. A
 * feature with none is an ordinary thing: a plan whose stories have not
 * been written yet, or one whose stories have since been deleted.
 *
 * A story says nothing, and that is not the same case. Its walk is
 * empty because a story has no stories under it, which nobody doubted —
 * "0 stories under it" on every item on the board would be noise
 * standing in for a fact. The test lives here rather than in
 * `cascadeJiraSync`, which stays the walk `pullItem` does: what an
 * item *says* about its children and what it *does* to them are
 * different questions, and only the first one has an audience.
 *
 * Whether an item is one that *has* children is the type's container
 * flag (KAN-146), not the word `feature`: a project whose container is
 * an Epic owes the same count, and a leaf type somebody invented owes
 * the same silence.
 */
function cascadeSentence(item: Item, enabled: boolean, cascade: SyncCascade): string {
  const direction = enabled ? "on" : "off";
  if (!item.container && cascade.children === 0) return "";
  if (cascade.children === 0) return ` It has no stories under it, so 0 were switched ${direction} with it.`;
  if (cascade.changed === 0) return ` 0 stories under it were switched ${direction} with it — every one was already ${direction}.`;
  const counted = cascade.changed === 1 ? `1 story under it was` : `${cascade.changed} stories under it were`;
  return ` ${counted} switched ${direction} with it.`;
}

/**
 * What the thread says about the switch (EO-125, invariant 8).
 *
 * On the feature and not on each story, which is the pinned decision on
 * EO-121: a plan of twelve stories would otherwise post twelve identical
 * notes for one action. The count is what makes that honest — a feature
 * note that did not say how far the switch reached would hide eleven
 * items going quiet.
 */
function noteJiraSync(db: Db, item: Item, enabled: boolean, cascade: SyncCascade): void {
  const key = jiraStateOf(item).key;
  const state = enabled
    ? key === null
      ? "Jira sync is on. Nothing is mirrored until a Jira key is attached."
      : // Not "a pull will": switching on marks the item and the pull
        // schedule reads it in on its next tick (EO-127), which is what
        // catches up on everything written in Jira while it was off.
        `Jira sync is on, so this ticket talks to ${key} again — status, comments and attachments are pushed there, and whatever was written on the issue while it was off is being brought in now.`
    : key === null
      ? "Jira sync is off, so this ticket will not be pushed to Jira or pulled from it."
      : `Jira sync is off, so nothing here reaches ${key} and nothing comes back from it. The key stays attached: switching sync on resumes against the same issue.`;

  postComment(db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: `${state}${cascadeSentence(item, enabled, cascade)}` });
}

/** Whether anything moved, or the one sentence saying why nothing did. */
type JiraEditResult = { ok: true; changed: boolean } | { ok: false; problem: string };

/**
 * The Jira half of an edit: the link, the switch, and the notes both
 * leave behind (EO-125).
 *
 * `linkJiraKey` and `setJiraSync` do the writing and the refusing — the
 * checks live once, in the repo, so a key refused on an edit and the
 * same key refused at submission explain themselves the same way. What
 * is here is what only this layer knows: which of the two was asked
 * for, what changed as a result, and what the item should therefore
 * say.
 *
 * Nothing calls Jira. Attaching is a local write (the pinned decision on
 * EO-121), so an unreachable Jira never costs somebody an edit.
 */
function applyJiraEdit(db: Db, item: Item, input: IpcPayload<"items:update">): JiraEditResult {
  let current = item;
  let changed = false;

  if (input.jiraKey !== undefined) {
    const linked = linkJiraKey(db, current.id, input.jiraKey);
    if (!linked.ok) return { ok: false, problem: linked.problem };
    // Only a key that moved is a change. Sending the key an item
    // already holds is a form resubmitted unchanged, and `linkJiraKey`
    // writes nothing for it — so neither does the thread.
    if (jiraStateOf(linked.item).key !== jiraStateOf(current).key) {
      // The switch this same edit may be throwing, ahead of the half
      // that throws it (EO-127). One call attaching a key and silencing
      // the item ends with no marker, so a note written off the row
      // as it stands mid-edit would promise a backfill that the next
      // statement takes away.
      const after = jiraStateOf(linked.item);
      const pulling = after.key !== null && (input.jiraSync ?? after.sync);
      noteJiraLink(db, current.id, jiraStateOf(current).key, after.key, pulling);
      changed = true;
    }
    current = linked.item;
  }

  if (input.jiraSync !== undefined) {
    const enabled = input.jiraSync;
    // The switch and the cascade are judged separately: a feature
    // already off can still hold a story somebody switched back on by
    // hand, and "off" asked for again is what puts it right.
    const self = jiraStateOf(current).sync === enabled ? null : setJiraSync(db, current.id, enabled);
    if (self !== null && !self.ok) return { ok: false, problem: self.problem };
    const cascade = cascadeJiraSync(db, current, enabled);

    if (self !== null || cascade.changed > 0) {
      noteJiraSync(db, current, enabled, cascade);
      changed = true;
    }
  }

  return { ok: true, changed };
}

/**
 * What a caller meant by the criteria they sent (EO-166).
 *
 * Trimmed, and blank entries dropped, because the app's editor is a
 * textarea of one criterion per line: a trailing newline is how typing
 * works, not an empty criterion somebody wants recorded. Order is kept
 * — criteria are a list a reviewer works down, not a set.
 */
function tidyCriteria(sent: string[]): string[] {
  return sent.map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * Why these criteria may not be written, or null when they may.
 *
 * Every check here happens before a single write — this one's and
 * `applyJiraEdit`'s alike. `ticket_update` promises a refused edit
 * changed nothing at all, and a call that attached a key and *then*
 * discovered the criteria were refused would have made that a lie.
 */
function refuseCriteriaEdit(db: Db, item: Item, input: IpcPayload<"items:update">, edit: CriteriaEdit, criteria: string[]): string | null {
  // An empty list is not how criteria are cleared, and not silently
  // ignored either. `work:submitItem` refuses a story with no
  // acceptance criteria — they are what EO checks the implementer's
  // claim against — so an edit that could empty them would produce a
  // item EO would never have accepted in the first place. Somebody
  // who means "leave them alone" omits the field.
  if (criteria.length === 0) {
    return "An empty list is not an edit — acceptance criteria are what EO checks the implementer's claim against. Send the criteria you mean, or leave them out of the call to keep the ones the ticket has.";
  }

  // The key and the switch this call itself may be throwing, read off
  // the payload rather than the row: `applyJiraEdit` has not run yet
  // (nothing may be written before every refusal is known), so the row
  // still shows the state the item is leaving. Detaching or silencing
  // the item in the same call is a caller saying it should stop
  // following the issue, and criteria are theirs to write from then on.
  const held = jiraStateOf(item);
  const endsMirroring = input.jiraKey === undefined ? held.key : input.jiraKey;
  if (endsMirroring !== null && (input.jiraSync ?? held.sync)) {
    // Refused rather than pushed, and this is the deliberate half of
    // EO-166's Jira criterion. An item's criteria live in its Jira
    // description (`toJiraDescription`), Jira owns that text
    // (`reconcileFields` — Jira wins, and says in the thread what it
    // replaced), and EO has no field write at all: `JiraClient` creates
    // issues, transitions them, comments and attaches, and the outbox
    // carries nothing else. Writing the edit locally would leave a
    // item quietly disagreeing with the issue it mirrors until the
    // next pull silently undid it — the worse bug of the two.
    return (
      `${item.key} mirrors ${endsMirroring}, whose description is where these criteria live, and EO writes no field back to Jira — ` +
      `an edit here would last only until the next pull replaced it with the issue's own. Change them on ${endsMirroring} and EO reads ` +
      `them back within the minute, or switch this ticket's Jira sync off first if it should stop following that issue.`
    );
  }

  // The same rule an amendment proposed in a conversation is held to,
  // called rather than restated (`roles/itemGuards.ts`, which carries
  // the reasoning): archived, finished, in review, or held by a running
  // agent all refuse a content change.
  //
  // `missing-criteria` only when that is the whole of what this call
  // does (EO-213): the item declares none, this supplies some, and
  // nothing else about the work changes. The exception exists so a
  // person can answer the escalation a refused review posted, and
  // answering it is exactly one field — so a call that also renamed the
  // item or rewrote its description would be using the one edit EO
  // asked for as a way past the rule protecting the rest, and is
  // refused as the content change it is. Priority may ride along, being
  // allowed anywhere non-terminal in its own right.
  //
  // A field of the item's *spec* riding along counts as changing
  // something else, for the same reason a title does (KAN-147): a bug's
  // `expected` or a `Case`'s customer is what the work is judged and
  // done against, and the one edit EO asked for must not become a way
  // past the rule protecting the rest.
  const answersTheRefusal =
    edit.before.length === 0 &&
    input.title === undefined &&
    input.body === undefined &&
    input.type === undefined &&
    !editsOtherSpecFields(input, edit);
  return refuseIfUntouchable(db, item, answersTheRefusal ? "missing-criteria" : "content");
}

/**
 * The criteria this call is about: which fields hold them, where a
 * changed list is written, and what the caller sent (EO-166, KAN-147).
 *
 * **Two doors.** `acceptanceCriteria` is the one the ticket screen and
 * `ticket_update` have always used; `spec` is the one the detail's spec
 * editor opened, and a type's criteria are one of its spec fields like
 * any other — so a caller can put them there, and nothing stops an agent
 * doing exactly that. They go through the same guard and leave the same
 * record either way. The alternative — refusing criteria sent as a spec
 * field — would be a second contract for one field, and the one act
 * reading as two different kinds of event depending on the door is
 * precisely what `noteCriteriaEdit` exists to prevent.
 *
 * **Two types.** A call may reclassify and edit in one breath, and then
 * *which* property holds the criteria has two answers: the type the item
 * is, and the type it is becoming. Both are recognised, because
 * recognising only one leaves the other as an ordinary spec field — so a
 * call that reclassified an item and sent the criteria under the
 * *target* type's field name would have moved the review target with no
 * Jira check, no lifecycle check and no record of it, and one sending
 * them under the name the item is leaving would do the same in the other
 * direction. A field that holds criteria for either type is criteria.
 *
 * Where a changed list is *written* is the type the item will have when
 * the call is done, because that is the field everything downstream will
 * read them by: writing them under the name the item is leaving would
 * leave a story whose criteria are in a property a story does not have.
 * What they *were* is read by the name it has now, which is what the
 * record in the thread is about.
 *
 * A value that is not a list of strings reads as none: `refuseCriteriaEdit`
 * turns an empty list down in its own words, which is the right answer
 * for `{ acceptance_criteria: "a string" }` too. Nothing here writes
 * anything; what it returns is what the guarded path is given.
 */
interface CriteriaEdit {
  /** Every spec property that holds criteria for this call — the item's type's, and the target's. */
  names: string[];
  /** The property the item's criteria live in now: the field of the type it is. */
  currentName: string;
  /** The property a written list goes to: the field of the type the item will have. */
  writeName: string;
  /** What the item declares now, by the name it has now. */
  before: string[];
  /** What the call is sending, or null when it sends none. */
  sent: string[] | null;
  /** The fields that carried them. More than one is one field said twice. */
  sentIn: string[];
}

function criteriaNameOf(shape: SpecShape): string {
  return criteriaField(shape)?.name ?? "acceptance_criteria";
}

function criteriaEditFor(db: Db, item: Item, input: IpcPayload<"items:update">, target: ItemType | null): CriteriaEdit {
  const current = shapeOf(db, item);
  const currentName = criteriaNameOf(current);
  const targetName = target === null ? null : criteriaNameOf(target.specShape);
  const names = [...new Set([currentName, ...(targetName === null ? [] : [targetName])])];

  const sentIn = [
    ...(input.acceptanceCriteria === undefined ? [] : ["acceptanceCriteria"]),
    ...names.filter((name) => input.spec?.[name] !== undefined),
  ];

  const sentAsSpec = names.map((name) => input.spec?.[name]).find((value) => value !== undefined);
  const fromSpec = Array.isArray(sentAsSpec) ? sentAsSpec.filter((entry): entry is string => typeof entry === "string") : [];

  return {
    names,
    currentName,
    writeName: targetName ?? currentName,
    before: acceptanceCriteriaOf(item, current),
    sent: sentIn.length === 0 ? null : tidyCriteria(input.acceptanceCriteria ?? fromSpec),
    sentIn,
  };
}

/** Whether a call edits any spec field that is not a criteria one — which is a content change. */
function editsOtherSpecFields(input: IpcPayload<"items:update">, edit: CriteriaEdit): boolean {
  return Object.keys(input.spec ?? {}).some((name) => !edit.names.includes(name));
}

/**
 * The shape of the type this item is, or the empty one when its row has
 * gone (KAN-147).
 *
 * An item whose type was deleted in another window is an item to read,
 * not an exception to throw — and a shape that demands nothing is what
 * every reader here does with it: the criteria fall back to the
 * conventional name, and an edit is held to nothing it cannot check.
 */
function shapeOf(db: Db, item: Item): SpecShape {
  return getItemType(db, item.typeId)?.specShape ?? EMPTY_SPEC_SHAPE;
}

/**
 * What the criteria were, kept where a reviewer will see it (EO-166).
 *
 * Criteria are the definition of done, so changing them moves the
 * target somebody else is judged against. `reconcileFields` already
 * holds Jira to this — an overwrite is never silent, what it replaced
 * goes into the thread — and an edit made in EO is no different. It is
 * `decision` rather than `note` for the same reason `applyAmendment`'s
 * is: this is the other door onto that act, and one act should not read
 * as two different kinds of event depending on which door it came in
 * by.
 */
function noteCriteriaEdit(db: Db, itemId: Uuid, before: string[]): void {
  postComment(db, {
    itemId,
    author: { type: "engine" },
    kind: "decision",
    body: [
      "Acceptance criteria were edited on this ticket.",
      "",
      ...(before.length === 0 ? ["EO had none recorded before this."] : ["**They were:**", "", ...before.map((line) => `> - ${line}`)]),
    ].join("\n"),
  });
}

/**
 * What an `items:update` call does to the base branch (EO-364), or to
 * the existing branch it works on (EO-365).
 *
 * `absent` is a call that did not mention it. `unchanged` is one that
 * sent what the item already holds, which still counts as having asked
 * for something — as criteria sent unchanged do — so the call is not
 * answered as a request for nothing.
 */
type BranchFieldEdit = { kind: "absent" } | { kind: "unchanged" } | { kind: "write"; value: string | null } | { kind: "refused"; problem: string };

/**
 * Judges a base-branch or existing-branch edit before anything is
 * written (EO-364, EO-365). The two are one rule, because both are
 * instructions about a branch that does not exist in git yet.
 *
 * The four refusals, in the order a person would want to hear them:
 *
 * - **A branch already in git.** Where a branch starts is in git history
 *   the moment it is cut, so a base changed afterwards would only make
 *   EO's account of the branch wrong — and the next pull request would
 *   open against somewhere the branch never came from. A branch a person
 *   named is in git once Worktree has checked it out for the item, and
 *   swapping it after that would leave a worktree on one branch and the
 *   item naming another. The refusal names the branch, because that is
 *   what a person would go and look at.
 * - **A run in flight with no branch yet.** The step holding the item may
 *   be cutting it right now, from whatever the item said when it was
 *   dispatched; an edit landing in between would be a base the branch
 *   never had.
 * - **A name git would not accept**, in `branchNameProblem`'s words.
 * - **An item that does not work on a branch** of a git repository: a
 *   folder, scratch, no disk, or a step that only reads. There is no
 *   branch for a base to start or to check out, so no `git` row is
 *   written for one.
 *
 * Clearing is allowed wherever setting is, and also on an item that has
 * since moved somewhere no branch is cut — taking a stale instruction
 * off is never the thing to refuse. A blank name is read as clearing,
 * because an emptied box is how a person says it.
 */
function judgeBranchFieldEdit(db: Db, item: Item, sent: string | null | undefined, field: "base" | "existing"): BranchFieldEdit {
  if (sent === undefined) return { kind: "absent" };
  const next = sent === null || sent.trim() === "" ? null : sent.trim();
  const state = gitStateOf(item);
  const current = field === "base" ? state.baseBranch : namedBranchOf(state);
  if (next === current) return { kind: "unchanged" };

  const inGit = branchInGit(state);
  if (inGit !== null) {
    const how = state.namedBranch ? "checked out for it" : "cut";
    return {
      kind: "refused",
      problem:
        field === "base"
          ? `${item.key}'s branch \`${inGit}\` has already been ${how}, so where it starts is in git history and its base branch can no longer be changed.`
          : `${item.key}'s branch \`${inGit}\` has already been ${how}, so the branch it works on can no longer be changed.`,
    };
  }
  if (listActiveRuns(db).some((run) => run.itemId === item.id)) {
    return {
      kind: "refused",
      problem: `${item.key} is being worked on right now, and its branch may be being cut as you ask. Try again once the run has finished.`,
    };
  }
  if (next !== null) {
    const problem = branchNameProblem(next);
    if (problem !== null) return { kind: "refused", problem };
    if (!worksOnABranch(db, item)) {
      return {
        kind: "refused",
        problem:
          field === "base"
            ? `${item.key} does not work on a branch of a git repository where it is, so there is no branch for a base to start.`
            : `${item.key} does not work on a branch of a git repository where it is, so there is no branch for it to work on.`,
      };
    }
  }
  return { kind: "write", value: next };
}

/**
 * Judges a Reference edit before anything is written (EO-637).
 *
 * Trimmed, and a blank one is clearing — an emptied box is how a person
 * says it. The only refusal is a value that could not stand in a git
 * branch name, in `referenceProblem`'s words. Nothing else is asked: it
 * is a label rather than a link, so another item holding the same value
 * is no reason to refuse, and nothing is queued for any tracker.
 */
function judgeReferenceEdit(item: Item, sent: string | null | undefined): BranchFieldEdit {
  if (sent === undefined) return { kind: "absent" };
  const next = sent === null || sent.trim() === "" ? null : sent.trim();
  if (next === gitStateOf(item).reference) return { kind: "unchanged" };
  const problem = next === null ? null : referenceProblem(next);
  return problem === null ? { kind: "write", value: next } : { kind: "refused", problem };
}

export function updateItemText(db: Db, input: IpcPayload<"items:update">): IpcResponse<"items:update"> {
  const itemId = input.itemId as Uuid;
  // Read before anything is written, because the Jira half needs the
  // key this item is leaving and the switch it is coming from. A
  // item deleted in another window is something a person did, so it
  // comes back as a refusal in `linkJiraKey`'s own words rather than as
  // a thrown error.
  const item = getItem(db, itemId);
  if (!item) return { updated: false, problem: "That ticket no longer exists." };

  // On a step that waits on a group only the person holding the item may
  // edit it (EO-368). On the record answering a browser, the record's
  // rule; on a signed-in desktop, the one half of it this machine can
  // answer — see `refusedEditOnReplica`.
  const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "edit") ?? refusedEditOnReplica(db, item);
  if (notTheirs !== null) return { updated: false, problem: notTheirs };

  // The type first, and before every other refusal: it is the cheapest
  // of them — a slug this project has no row for (KAN-129) has to leave
  // the item exactly as it was, the Jira link included — and the two
  // guards below need to know which type the item is about to be.
  // Resolved here rather than in `updateItem` because this is where the
  // person who typed it is listening.
  const reclassification = input.type === undefined ? null : resolveItemType(db, item.projectId, input.type);
  if (reclassification !== null && !reclassification.ok) return { updated: false, problem: reclassification.problem };
  const target = reclassification !== null && reclassification.ok ? reclassification.type : null;

  // Judged before anything at all is written, `applyJiraEdit` included
  // (EO-166): a refusal has to leave the item exactly as it was, and
  // half of this call's answer depends on where the Jira half is about
  // to leave the link.
  //
  // Criteria sent as a spec field go through this same guard (KAN-147),
  // under the name *either* type gives them — see `criteriaEditFor`. A
  // door without the guard would let an edit move the review target on
  // an item in review, mirroring a Jira issue, or held by the agent
  // working on it.
  const edit = criteriaEditFor(db, item, input, target);
  const criteria = edit.sent;
  if (criteria !== null) {
    // A call that says two things about one field is answered rather
    // than resolved: whichever EO picked, the caller asked for the other
    // half too. Reclassifying makes this reachable a second way — the
    // field the item has and the field it is getting are one field, said
    // twice.
    if (edit.sentIn.length > 1) {
      return {
        updated: false,
        problem:
          `This call sends acceptance criteria more than once — as ${edit.sentIn.map((name) => `\`${name}\``).join(" and ")} — and they are one field. Send it once.`,
      };
    }
    const refusal = refuseCriteriaEdit(db, item, input, edit, criteria);
    if (refusal !== null) return { updated: false, problem: refusal };
  }

  // And every *other* spec field is a content change, held to the rule a
  // title or a body is held to (KAN-147). Without this an in-review or
  // agent-held item's own fields — a bug's `expected`, a `Case`'s
  // customer — could be rewritten under the work being done against
  // them, which is the thing `refuseIfUntouchable` exists to stop.
  if (editsOtherSpecFields(input, edit)) {
    const refusal = refuseIfUntouchable(db, item, "content");
    if (refusal !== null) return { updated: false, problem: refusal };
  }

  // The base branch, judged before the first write for the same reason
  // the criteria are (EO-364): a refusal leaves the item exactly as it
  // was, the Jira link included.
  const baseEdit = judgeBranchFieldEdit(db, item, input.baseBranch, "base");
  if (baseEdit.kind === "refused") return { updated: false, problem: baseEdit.problem };
  // The existing branch, on the same terms and for the same reason
  // (EO-365).
  const existingEdit = judgeBranchFieldEdit(db, item, input.existingBranch, "existing");
  if (existingEdit.kind === "refused") return { updated: false, problem: existingEdit.problem };
  // The Reference, on the same terms (EO-637): refused whole, before the
  // first write, so nothing else sent with it lands either.
  const referenceEdit = judgeReferenceEdit(item, input.reference);
  if (referenceEdit.kind === "refused") return { updated: false, problem: referenceEdit.problem };

  // What it waits for (EO-600), judged whole before the first write for
  // the reason the criteria are: a refusal — a key naming nothing, a
  // cycle once the additions are merged into the live graph — leaves the
  // item exactly as it was, its other fields and its Jira link included.
  // The rule is the reorder card's, shared (`itemDependencies.ts`). On a
  // project the organisation's record holds the record makes the change,
  // through `updateItemFields`; one arriving here anyway is refused
  // rather than written to a replica the record would never hear from.
  const dependencyRequest = { add: input.addDependsOn ?? [], remove: input.removeDependsOn ?? [] };
  const asksDependencies = asksForDependencyChange(dependencyRequest);
  if (asksDependencies && isReplica(db, item.id)) return { updated: false, problem: dependenciesOnTheRecordLine(item.key) };
  const dependencies = judgeDependencyChange(db, item, dependencyRequest);
  if (!dependencies.ok) return { updated: false, problem: dependencies.reason };

  // Jira next, because it is the other half that can be refused: a key
  // another item holds has to leave this one exactly as it was, title
  // and body included.
  const jira = applyJiraEdit(db, item, input);
  if (!jira.ok) return { updated: false, problem: jira.problem };

  const patch: { title?: string; body?: string; priority?: number; typeId?: Uuid; spec?: Record<string, unknown>; git?: Partial<GitItemState> } = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  // The scheduler has sorted by this since E-02; until now nothing could
  // set it, so every item was 0 and the sort had nothing to sort (U-13).
  if (input.priority !== undefined) patch.priority = input.priority;
  // Reclassifying a bug/story short-circuit before approving it (KAN-37).
  if (target !== null) patch.typeId = target.id;
  // Merged into the `git` extension by `updateItem`, which deletes the
  // row again when clearing leaves it saying nothing (EO-364).
  //
  // An existing branch is the `branch` itself, marked as the person's
  // (EO-365): dispatch already checks out a stored branch rather than
  // cutting one. Clearing it takes the name off and leaves EO to cut its
  // own, exactly as if none had been named.
  if (baseEdit.kind === "write" || existingEdit.kind === "write" || referenceEdit.kind === "write") {
    patch.git = {
      ...(baseEdit.kind === "write" ? { baseBranch: baseEdit.value } : {}),
      ...(existingEdit.kind === "write" ? { branch: existingEdit.value, namedBranch: existingEdit.value !== null, attachedAt: null } : {}),
      ...(referenceEdit.kind === "write" ? { reference: referenceEdit.value } : {}),
    };
  }

  // The spec is written once, from two kinds of edit (KAN-147).
  //
  // **The criteria.** Whole-list, and merged into the spec rather than
  // over it: `spec` also carries `touches` and a bug's four fields, and
  // a criteria edit is about none of them. Under the name this item's
  // type gives them, so an edit writes the field the type declares
  // rather than an `acceptance_criteria` a pack's own type may never
  // have had. When that is written, and when it is left alone, is the
  // paragraph below.
  //
  // **The type's other fields**, as the detail's spec editor sends them.
  // Merged over what is there rather than replacing it, because the
  // editor draws the fields this *type* declares and an item may carry
  // more than that — one reclassified before approval, one imported from
  // Jira — and a form showing four fields must not delete a fifth it
  // never showed. The criteria key is taken off what the caller sent:
  // whatever door it arrived at, the criteria half above is the only
  // thing that writes it, so there is one writer and one record.
  const criteriaBefore = edit.before;
  // Identical criteria are a form resubmitted unchanged — nothing to
  // write, and nothing to say in the thread, the same as a Jira key sent
  // again. **Unless the field they belong in has moved**: reclassifying
  // between two types that name their criteria differently means the
  // same list has to land in a different property, and comparing only
  // the lists would leave it where the type the item is *leaving* keeps
  // them. The item would come out of the call declaring nothing its own
  // type could read, which is an item no review can start on — the
  // silent version of an edit that refused.
  //
  // Only a list the call actually sent moves. A reclassification that
  // mentions no criteria leaves them where they are, because carrying
  // them across would be EO rewriting a field nobody asked about — and
  // on an item mirroring a Jira issue that write is the one
  // `refuseCriteriaEdit` exists to refuse, so it would have to refuse a
  // reclassification over a field the caller never named. What that
  // leaves is visible rather than silent: the item declares none, and
  // the review refuses to start with the escalation that asks for them.
  const movesFields = edit.writeName !== edit.currentName;
  const listChanged = criteria !== null && criteria.join("\n") !== criteriaBefore.join("\n");
  const writesCriteria = criteria !== null && (listChanged || movesFields);

  // Every name that holds criteria comes off what the caller sent, not
  // just the one being written: a reclassification recognises two, and
  // leaving the other in `otherFields` would be the second writer this
  // exists to prevent.
  const otherFields = Object.fromEntries(Object.entries(input.spec ?? {}).filter(([name]) => !edit.names.includes(name)));
  const editsSpec = writesCriteria || Object.keys(otherFields).length > 0;

  const merged = {
    ...(item.spec ?? {}),
    ...otherFields,
    ...(writesCriteria ? { [edit.writeName]: criteria } : {}),
  };
  // The property the criteria are leaving goes with them, rather than
  // staying as a second copy of the list. One item declares its criteria
  // in one place — the field its type names — or a later edit would
  // correct one copy while a reclassification back found the other,
  // older one.
  if (writesCriteria && movesFields) delete merged[edit.currentName];

  // What the item will hold, held to the shape it will have.
  //
  // **Whenever either side of that moves**, which is why this is outside
  // the `editsSpec` branch (KAN-147). A reclassification writes no spec
  // at all and still changes what a valid one is: `{ type: "case" }` on
  // a story would leave the customer a Case demands unwritten, and the
  // item would sit there as a Case its own type rejects. The fields it
  // keeps are as much part of the answer as the fields this call sends.
  //
  // Every issue the shape has, as the hand-over door reads them: a field
  // the type demands and this would leave empty is a list of things to
  // supply, and anything else — a key nobody declared on a closed shape,
  // a value outside the bounds a type set — is the rule that was broken,
  // in the validator's own words.
  const editedType = target ?? getItemType(db, item.typeId);
  if ((editsSpec || target !== null) && editedType !== undefined) {
    const issues = specIssues(editedType.specShape, merged);
    if (issues.length > 0) {
      const missing = missingSpecFields(editedType.specShape, merged);
      return {
        updated: false,
        problem:
          missing.length > 0
            ? `A ${editedType.slug} needs ${missing.map((field) => field.phrase).join(", ")}.`
            : `A ${editedType.slug} does not accept this:\n${formatIssues(issues)}`,
      };
    }
  }

  if (editsSpec) patch.spec = merged;

  const askedForJira = input.jiraKey !== undefined || input.jiraSync !== undefined;
  // Nothing named, nothing done — and not a refusal either: there is no
  // problem to report about a request that asked for nothing. Criteria
  // sent unchanged count as named: the caller asked for a field and the
  // item holds what they asked for, which is `applyJiraEdit`'s answer
  // to the same question.
  if (Object.keys(patch).length === 0 && !askedForJira && criteria === null && baseEdit.kind === "absent" && existingEdit.kind === "absent" && referenceEdit.kind === "absent" && !asksDependencies) {
    return { updated: false, problem: null };
  }

  if (Object.keys(patch).length > 0) updateItem(db, itemId, patch);
  // After the write, so the thread reads in the order things happened,
  // and only when they actually moved.
  // Only when the list itself changed. A list that merely moved to the
  // property its new type names is the reclassification's own doing and
  // says nothing new about what the work is judged against — "they were"
  // followed by the same words would be a record of nothing.
  if (listChanged) noteCriteriaEdit(db, itemId, criteriaBefore);
  // A key just attached, or a switch just thrown back on, leaves an
  // issue to read (EO-127). The marker is what makes that happen at
  // all; this only makes it happen now rather than within the minute,
  // and it asks the marker rather than the payload so it cannot
  // disagree with what was actually written.
  if (askedForJira && hasJiraPullPending(db)) requestJiraPullDrain();
  // Last, and in one transaction of its own with its one comment: every
  // refusal this call could meet has been met by now, so the change
  // lands whole or the call was already refused.
  const applied = asksDependencies ? applyDependencyChange(db, dependencies.plan, dependencyChangeHeader(item.key, whoAsked(db, input.actingDeviceId))) : null;
  return announceItem(itemId, { updated: true, problem: null, ...(applied === null ? {} : { dependencies: summariseDependencyChange(applied) }) });
}

/**
 * `items:update`, sent to whichever record owns the item where the call
 * changes what it waits for (EO-600, ARCHITECTURE.md, "The record").
 *
 * Everything else is `updateItemText`, on this database, as it always
 * was — an edit to an item's text is this machine's (see
 * `refusedEditOnReplica`). But the edges of a project the organisation's
 * record holds are the record's: the scheduler that reads them is there,
 * and a cycle is a question about the whole graph. So the change is
 * asked of the record, which judges and writes it whole, and a record
 * that cannot be reached changes nothing and says so.
 *
 * A call that changes the edges *and* other fields of such an item is
 * refused, naming them. The two halves would be written on two machines,
 * and nothing could make them land together — so a refusal of the second
 * would leave the first applied, which is the half-done call this
 * channel promises never to make.
 */
export async function updateItemFields(
  db: Db,
  record: Pick<ItemRecord, "changeDependencies">,
  input: IpcPayload<"items:update">,
): Promise<IpcResponse<"items:update">> {
  const itemId = input.itemId as Uuid;
  const add = input.addDependsOn ?? [];
  const remove = input.removeDependsOn ?? [];
  if (!asksForDependencyChange({ add, remove }) || !isReplica(db, itemId)) return updateItemText(db, input);

  const item = getItem(db, itemId);
  if (!item) return { updated: false, problem: "That ticket no longer exists." };

  const others = Object.entries(input)
    .filter(([name, value]) => value !== undefined && !["itemId", "actingDeviceId", "addDependsOn", "removeDependsOn"].includes(name))
    .map(([name]) => `\`${name}\``);
  if (others.length > 0) {
    return {
      updated: false,
      problem: `${dependenciesOnTheRecordLine(item.key)} Send addDependsOn and removeDependsOn in a call of their own, and ${others.join(", ")} in another.`,
    };
  }

  // The edit rule `updateItemText` opens with, for the same person.
  const notTheirs = refusedOnGroupStep(db, item, input.actingDeviceId, "edit") ?? refusedEditOnReplica(db, item);
  if (notTheirs !== null) return { updated: false, problem: notTheirs };

  const answer = await record.changeDependencies({ itemId, add, remove, by: whoAsked(db, input.actingDeviceId) });
  if (!answer.ok) return { updated: false, problem: answer.problem };
  if (answer.dependencies === null) return { updated: false, problem: null };
  return announceItem(itemId, { updated: true, problem: null, dependencies: answer.dependencies });
}

/** Why a record-held item's edges are not changed alongside anything else. */
function dependenciesOnTheRecordLine(itemKey: string): string {
  return `${itemKey} is on a project your organisation's record holds, and what it waits for is changed there, apart from anything else about it.`;
}

/** Who asked, by name, for the comment a change leaves — `moveItemToVersion`'s rule. */
function whoAsked(db: Db, actingDeviceId: string | null | undefined): string {
  return actingCaller(db, actingDeviceId).person?.name ?? "the organisation's operator";
}

/**
 * Stop this run, and nothing else.
 *
 * Which is why it leaves `cancellation` at its default: this channel is
 * the whole of what was asked for, so EO stops with it rather than
 * offering the same step again on the next tick (EO-175). It carries no
 * item and no destination — the item stays exactly where it is — and
 * that is the difference between it and every other caller of
 * `cancelRun`.
 */
export function cancelRun(engine: EngineHandle | undefined, input: IpcPayload<"runs:cancel">): IpcResponse<"runs:cancel"> {
  if (!engine) return { cancelled: false };
  engine.cancelRun(input.runId);
  return { cancelled: true };
}

export function pauseEngine(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"engine:pause">): IpcResponse<"engine:pause"> {
  persistEnginePause(db);
  engine?.pause({ cancelRunning: input.cancelRunning });
  return { paused: engine?.isPaused() ?? true, activeRunCount: engine?.activeRunCount() ?? 0, finishingRunCount: engine?.finishingRunCount() ?? 0 };
}

export function resumeEngine(db: Db, engine: EngineHandle | undefined): IpcResponse<"engine:resume"> {
  clearEnginePausePreference(db);
  engine?.resume();
  return { paused: engine?.isPaused() ?? false, activeRunCount: engine?.activeRunCount() ?? 0, finishingRunCount: engine?.finishingRunCount() ?? 0 };
}

/** Do Not Disturb, persisted so it survives a relaunch (U-04). */
export const DND_KEY = "notifications.doNotDisturb";

export async function readSettings(db: Db): Promise<IpcResponse<"settings:get">> {
  return {
    doNotDisturb: getSetting(db, DND_KEY, false),
    archiveAfterDays: archiveAfterDays(db),
    jiraPullMinutes: jiraPullMinutes(db),
    // Async only because a never-configured prefix derives and persists
    // one from git config on this first read (EO-15) — every read after
    // that is a plain lookup, same as the settings above it.
    branchPrefix: await branchPrefix(db),
    // How many versions of each pipeline are kept (EO-359).
    pipelineVersionsToKeep: pipelineVersionsToKeep(db),
    // And of each module, separately (EO-360).
    moduleVersionsToKeep: moduleVersionsToKeep(db),
  };
}

export async function writeSettings(db: Db, input: IpcPayload<"settings:set">): Promise<IpcResponse<"settings:set">> {
  // Only what was sent. `undefined` means "not mine to change" — the
  // inbox's Do Not Disturb toggle must not reset the archive delay.
  // `archiveAfterDays: null` is a real value meaning off, so the check
  // is on the key rather than on falsiness.
  if (input.doNotDisturb !== undefined) setSetting(db, DND_KEY, input.doNotDisturb);
  if (input.archiveAfterDays !== undefined) setArchiveAfterDays(db, input.archiveAfterDays);
  if (input.jiraPullMinutes !== undefined) setJiraPullMinutes(db, input.jiraPullMinutes);
  if (input.branchPrefix !== undefined) setBranchPrefix(db, input.branchPrefix);
  if (input.pipelineVersionsToKeep !== undefined) setPipelineVersionsToKeep(db, input.pipelineVersionsToKeep);
  if (input.moduleVersionsToKeep !== undefined) setModuleVersionsToKeep(db, input.moduleVersionsToKeep);
  return readSettings(db);
}

/**
 * Puts an item away or brings it back (KAN-33).
 *
 * Archiving by hand is allowed on any item, unlike the sweep, which
 * only ever considers finished work. Someone who wants an abandoned
 * item off the project would otherwise have to delete it, which throws
 * away the record they may well want to keep.
 */
export function setArchived(db: Db, input: IpcPayload<"items:setArchived">): IpcResponse<"items:setArchived"> {
  const itemId = input.itemId as Uuid;
  if (!getItem(db, itemId)) return { archived: false, problem: "That ticket no longer exists." };

  setItemArchived(db, itemId, input.archived ? Date.now() : null);
  return { archived: input.archived, problem: null };
}

export function engineStatus(db: Db, engine: EngineHandle | undefined): IpcResponse<"engine:status"> {
  return {
    paused: engine?.isPaused() ?? isEnginePausePreferred(db),
    activeRunCount: engine?.activeRunCount() ?? 0,
    finishingRunCount: engine?.finishingRunCount() ?? 0,
  };
}
