import { uuidv7, type DiscussionView, type IpcPayload, type IpcResponse, type Item, type Uuid } from "@eo/core";
import type { AttachmentStorage } from "../attachments/storage.js";
import type { Db } from "../db/client.js";
import { dismissOpenMentionsForComment, getItem, listActiveRuns, postComment } from "../db/repos/index.js";
import type { ModuleTestRunner } from "../modules/moduleTestRunner.js";
import { SCENARIO_SETTINGS_KEY, SCENARIO_STEP } from "../roles/conversationSteps.js";
import { appliedChangeNote } from "../roles/moduleChange.js";
import {
  applyScenarioChange,
  clearScenarioRoom,
  isScenarioChangeCard,
  openScenarioRoom,
  scenarioAgent,
  scenarioApprovalWithdrawn,
  scenarioModule,
  scenarioModuleIdOf,
} from "../roles/scenario.js";
import { answerQuestionBatch } from "./conversationTurns.js";
import { approvableIds, conversationView, type ConversationKind } from "./conversationView.js";
import type { EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * A module's scenario chat, over IPC (EO-356).
 *
 * Thin, as `assistCommands.ts` is and for its reasons: how a conversation
 * renders is `conversationView.ts`, what a turn means is
 * `roles/scenario.ts`, and answering a card is `conversationTurns.ts`,
 * shared by every room. What is left here is which conversation a call
 * may touch — a scenario thread, about the module it names, not yet put
 * away — and the one button this room has that no other does: Apply.
 */

/** What makes this room the scenario chat rather than one of the other three. */
const SCENARIO: ConversationKind = {
  agent: scenarioAgent,
  fallbackName: "System agent",
  isProposal: isScenarioChangeCard,
  // Every card here is a change to something that already exists — the
  // module — so "Apply change" is the promise the button makes.
  approves: () => "changes",
  // A module change has no item type.
  proposedType: () => null,
  // EO's record that a case this room wrote withdrew the module's
  // approval, which the panel offers Approve under (EO-501).
  approvalWithdrawn: (_db, conversation, comment) => scenarioApprovalWithdrawn(conversation, comment),
  settingsKey: SCENARIO_SETTINGS_KEY,
  // Drawn as the assistant's chat is: the running turn step by step, and
  // each finished one folded above its answer.
  drawsTurns: true,
};

function toView(db: Db, conversation: Item): DiscussionView {
  return conversationView(db, conversation, SCENARIO);
}

/** The module a call names, or the refusal as an error the panel shows. */
function moduleFor(db: Db, moduleId: string) {
  const found = scenarioModule(db, moduleId);
  if (!found.ok) throw new Error(found.reason);
  return found.module;
}

/**
 * A scenario thread a card's button may write to.
 *
 * Checked, because these channels take an item id straight and an item
 * id is an item id: without it a story's id here would have an answer
 * comment, or a module save, written against somebody's work.
 */
function scenarioConversationForWrite(db: Db, conversationId: string): Item {
  const conversation = getItem(db, conversationId as Uuid);
  if (!conversation) throw new Error("That conversation does not exist.");
  if (conversation.stepId !== SCENARIO_STEP) throw new Error("That is not a scenario conversation.");
  if (conversation.archivedAt !== null) throw new Error("That conversation is closed.");
  return conversation;
}

/** The module's thread, resumed if it has one and started if it has not. */
export function openScenario(db: Db, input: IpcPayload<"scenario:open">): IpcResponse<"scenario:open"> {
  const module = moduleFor(db, input.moduleId);
  return { conversation: toView(db, openScenarioRoom(db, module, activeProjectId(db)).conversation) };
}

/**
 * Clear: archives the module's thread and leaves an empty one.
 *
 * `clearAssist`'s steps, in its order: a turn still running is cancelled
 * as `superseded` and the mention that started it dismissed, with a note
 * in the archived thread saying so (invariant #8).
 */
export function clearScenario(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"scenario:clear">): IpcResponse<"scenario:clear"> {
  const module = moduleFor(db, input.moduleId);
  const live = listActiveRuns(db);
  const cleared = clearScenarioRoom(db, module, activeProjectId(db));
  const archived = cleared.cleared;
  const active = archived ? live.find((run) => run.itemId === archived.id) : undefined;

  if (archived && active) {
    if (active.initiationId) dismissOpenMentionsForComment(db, active.initiationId as Uuid);
    engine?.cancelRun(active.id, "superseded");
    postComment(db, { itemId: archived.id, author: { type: "engine" }, body: "Turn stopped: the thread was cleared.", kind: "note", runId: active.id });
  }

  engine?.notifyStateChange();
  return { conversation: toView(db, cleared.conversation) };
}

/**
 * Says something to the system agent about a module.
 *
 * Posting a human comment that mentions it is the dispatch, as in every
 * other room. Files travel the way `assist:send` carries them: promoted
 * to managed storage only if the comment carrying them lands.
 */
export async function sendToScenario(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"scenario:send">,
  attachmentStorage?: AttachmentStorage,
): Promise<IpcResponse<"scenario:send">> {
  const existing = input.conversationId === null ? undefined : getItem(db, input.conversationId as Uuid);
  if (input.conversationId !== null && !existing) throw new Error("That conversation does not exist.");
  if (existing && existing.stepId !== SCENARIO_STEP) throw new Error("That is not a scenario conversation.");
  if (existing && existing.archivedAt !== null) throw new Error("That conversation is closed.");
  // A thread is about one module, and a message sent from one module's
  // page must not land in another's.
  if (existing && scenarioModuleIdOf(existing) !== input.moduleId) throw new Error("That conversation is about another module.");
  const module = moduleFor(db, input.moduleId);

  const agent = scenarioAgent(db);
  if (!agent) throw new Error("There is no enabled system agent to talk to.");
  const attachmentIds = input.attachmentIds ?? [];
  if (input.body.trim() === "" && attachmentIds.length === 0) throw new Error("A message needs text or an attachment.");
  if (attachmentIds.length > 0 && !attachmentStorage) throw new Error("Attachment storage is unavailable.");

  // Every refusal above this line: opening the room creates it.
  const conversation = existing ?? openScenarioRoom(db, module, activeProjectId(db)).conversation;

  const activeRun = listActiveRuns(db).find((run) => run.itemId === conversation.id);
  if (input.interrupt && activeRun && engine) {
    if (activeRun.initiationId) dismissOpenMentionsForComment(db, activeRun.initiationId as Uuid);
    engine.cancelRun(activeRun.id, "superseded");
  }

  const prepared = (await attachmentStorage?.prepare(attachmentIds)) ?? [];
  try {
    postComment(db, {
      id: uuidv7(),
      itemId: conversation.id,
      author: { type: "human" },
      body: input.body.trim(),
      attachmentRecords: prepared,
      mentions: [{ type: "agent", agentId: agent.id }],
    });
  } catch (error) {
    await attachmentStorage?.rollback(prepared);
    throw error;
  }
  await attachmentStorage?.finish(prepared).catch((error: unknown) => console.error("[eo] could not clear staged scenario attachments:", error));

  // A person's send: the turn it asks for starts on the next tick, not after a debounce.
  engine?.notifyStateChange({ promptly: true });
  return { conversation: toView(db, getItem(db, conversation.id) ?? conversation) };
}

/** Answers a batch of questions on a card — `conversationTurns.ts` does the answering. */
export function answerScenarioQuestions(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"scenario:answer">): IpcResponse<"scenario:answer"> {
  const conversation = scenarioConversationForWrite(db, input.conversationId);
  const agent = scenarioAgent(db);
  if (!agent) throw new Error("There is no enabled system agent to answer.");

  const batch = answerQuestionBatch(db, engine, conversation, agent, input.answers);
  return { ...batch, conversation: toView(db, getItem(db, conversation.id) ?? conversation) };
}

/**
 * Applies a change to the module that a card proposed — a person pressed
 * Apply.
 *
 * "Newest wins" first, by the rule every room's cards share, so a panel
 * left open on a superseded or already-applied card cannot write it.
 * Then `applyScenarioChange`, which is a module save: the code changes,
 * and the manifest when the card carried one, approval is withdrawn as
 * an edit in Settings withdraws it, and the module's tests are re-run
 * against what was saved.
 *
 * Either way it is said in the thread, under the card (invariant #8),
 * and the comment filed under it is what stops the card being
 * applicable again.
 */
export function applyScenarioChangeCommand(
  db: Db,
  engine: EngineHandle | undefined,
  runner: ModuleTestRunner,
  input: IpcPayload<"scenario:apply">,
): IpcResponse<"scenario:apply"> {
  const conversation = scenarioConversationForWrite(db, input.conversationId);
  const messageId = input.messageId as Uuid;

  if (!approvableIds(db, conversation, SCENARIO).has(messageId)) {
    return {
      applied: false,
      problem: "That change has been superseded or already applied. Read the newest one and apply that instead.",
      conversation: toView(db, conversation),
    };
  }

  const applied = applyScenarioChange(db, conversation, messageId);
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
