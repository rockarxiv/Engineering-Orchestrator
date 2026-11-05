import { uuidv7, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getComment, getItem, getPipeline, getUpdateConflict, handUpdateConflictTurn, postComment, setUpdateConflictChat } from "../db/repos/index.js";
import { updateConflictBrief } from "../gallery/templateUpdates.js";
import { openAssistConversation, recordAssistBoard } from "./assist.js";
import { ASSIST_STEP } from "./conversationSteps.js";

/**
 * The assistant chat about one held template update (EO-533), on the
 * tables of whichever installation holds the conflict: a desktop for its
 * own pipelines, the organisation's record for the pipelines it holds.
 *
 * The first ask makes it: a new chat whose first message is EO's brief
 * (`updateConflictBrief`), posted by EO and mentioning the assistant, so
 * the mention dispatches the first turn as a person's message would. The
 * pipeline is pinned to that message as the board a draft raised in
 * answer is published against (`recordAssistBoard`). The chat is
 * recorded on the conflict, and every later ask — from any copy of the
 * notice, on any desktop — is answered with that one chat while it
 * exists. One since removed is made again.
 *
 * Who answers the brief is decided once, durably. On a desktop's own
 * conflict the brief asks its assistant directly. On the organisation's
 * record the chat is copied to every admin's desktop, and mention
 * dispatch is each machine's own — a brief asking an assistant there
 * would be answered by every desktop that pulled it. So the record's
 * brief asks nobody, and the first turn is handed to one device, the
 * first to press (`handUpdateConflictTurn`); that desktop asks its own
 * assistant on its copy (`askAgentAbout`), after pinning the pipeline.
 *
 * Nothing here shows the chat: which chat is on show is a desktop's own
 * setting, and the record has no window. The caller shows it.
 */

/**
 * Who answers the brief: this installation's assistant, by id; a device,
 * which asks its own once it is handed the turn (on the record); or
 * nobody — an asker with no assistant, which only an existing chat can be
 * answered for.
 */
export type ConflictChatAnswerer = { kind: "here"; agentId: string } | { kind: "device"; deviceId: string } | null;

export interface UpdateConflictChatRequest {
  conflictId: string;
  answeredBy: ConflictChatAnswerer;
  /** The notice pressed, which places the chat of a pipeline no project has adopted. */
  commentId: string | null;
  /** Where to place it when neither the pipeline nor the notice says: the project on screen on a desktop, none on the record. */
  fallbackProjectId: Uuid | null;
}

export type UpdateConflictChatAnswer =
  | {
      ok: true;
      chat: Item;
      /** True when this ask made the chat. */
      started: boolean;
      /**
       * True when the brief's first turn is the asker's to dispatch: the
       * brief was just written asking this installation's assistant, or
       * the record handed the turn to the asking device. Never true for
       * two devices.
       */
      firstTurn: boolean;
    }
  | { ok: false; problem: string };

/** What a desktop answers about a conflict neither it nor its organisation's record holds. */
export const UPDATE_CONFLICT_NOT_HELD = "That template update is not held here any more.";

export function openUpdateConflictChat(db: Db, request: UpdateConflictChatRequest): UpdateConflictChatAnswer {
  const conflict = getUpdateConflict(db, request.conflictId);
  if (!conflict) return { ok: false, problem: UPDATE_CONFLICT_NOT_HELD };

  const answeredBy = request.answeredBy;
  const handed = (): boolean => answeredBy?.kind === "device" && handUpdateConflictTurn(db, conflict.id, answeredBy.deviceId);

  const existing = conflict.chatId === null ? undefined : getItem(db, conflict.chatId as Uuid);
  if (existing && existing.stepId === ASSIST_STEP) return { ok: true, chat: existing, started: false, firstTurn: handed() };

  if (conflict.resolvedAt !== null) return { ok: false, problem: "That template update has already been resolved." };
  if (answeredBy === null) return { ok: false, problem: "There is no enabled system agent to talk to." };
  if (!getPipeline(db, conflict.pipelineId)) return { ok: false, problem: "That pipeline no longer exists." };

  const chat = db.transaction(() => {
    const started = openAssistConversation(db, chatProjectFor(db, conflict.pipelineId, request));
    const briefId = uuidv7();
    // The board first, for `sendToAssist`'s reason: the mention below is
    // what wakes the supervisor, and a turn dispatched before the board
    // is written would have no pipeline to raise a draft against.
    const pinned = recordAssistBoard(db, started, briefId, conflict.pipelineId);
    postComment(db, {
      id: briefId,
      itemId: pinned.id,
      author: { type: "engine" },
      kind: "note",
      body: updateConflictBrief(db, conflict),
      // Asking this installation's assistant, where it is the one to
      // answer; asking nobody on the record, where the turn is handed to
      // a device instead.
      mentions: answeredBy.kind === "here" ? [{ type: "agent", agentId: answeredBy.agentId as Uuid }] : [],
      parseBodyMentions: false,
    });
    setUpdateConflictChat(db, conflict.id, pinned.id);
    return getItem(db, pinned.id) ?? pinned;
  });
  return { ok: true, chat, started: true, firstTurn: answeredBy.kind === "here" || handed() };
}

/** The project a conflict's chat is placed on: the pipeline's, else the pressed notice's, else the fallback. */
function chatProjectFor(db: Db, pipelineId: string, request: UpdateConflictChatRequest): Uuid | null {
  const owner = getPipeline(db, pipelineId)?.projectId ?? null;
  if (owner !== null) return owner as Uuid;
  const notice = request.commentId === null ? undefined : getComment(db, request.commentId as Uuid);
  const noticeProject = notice ? (getItem(db, notice.itemId)?.projectId ?? null) : null;
  return (noticeProject as Uuid | null) ?? request.fallbackProjectId;
}
