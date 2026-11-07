import { uuidv7, type Item, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem, postComment } from "../db/repos/index.js";
import { openAssistConversation, recordAssistBoard } from "./assist.js";

/**
 * A new assistant chat that EO starts with a brief of its own: Fix with
 * assistant on a held template update (EO-533), and the end of first run
 * for a template with no job (EO-664).
 *
 * The brief is the chat's first message, posted by EO. Where it asks an
 * agent, the mention is what dispatches the first turn — the path a
 * person's message takes, with nobody typing. The pipeline is pinned to
 * the brief first (`recordAssistBoard`), because the mention is what
 * wakes the supervisor and a turn dispatched before the board is written
 * would have no pipeline to raise anything against.
 *
 * Not a transaction of its own: each caller writes something beside it
 * that must land with it, and wraps both. Nothing here shows the chat or
 * wakes the engine; the caller does both.
 */
export function openBriefedChat(db: Db, input: { projectId: Uuid | null; pipelineId: string; brief: string; asking: string | null }): Item {
  const started = openAssistConversation(db, input.projectId);
  const briefId = uuidv7();
  const pinned = recordAssistBoard(db, started, briefId, input.pipelineId);
  postComment(db, {
    id: briefId,
    itemId: pinned.id,
    author: { type: "engine" },
    kind: "note",
    body: input.brief,
    mentions: input.asking === null ? [] : [{ type: "agent", agentId: input.asking as Uuid }],
    parseBodyMentions: false,
  });
  return getItem(db, pinned.id) ?? pinned;
}
