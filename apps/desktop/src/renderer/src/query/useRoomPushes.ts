import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DiscussionView, IpcPushPayload } from "@eo/core";
import { bridge } from "../ipc/bridge";

/**
 * Which chat a room is showing, as far as the pushes that refresh it are
 * concerned (EO-550): the conversation's item, and the run working in it
 * now. Both null before the room has been opened.
 */
export interface RoomIdentity {
  conversationId: string | null;
  runId: string | null;
  /**
   * Whether the chat's own changes reach the room as numbered deltas
   * (EO-553): the view carries a `deltaSeq`, and `useAssistDeltas`
   * writes them in. An assistant chat's, and no scenario's.
   */
  deltas: boolean;
}

/** The identity of the conversation on show, or of none. */
export function roomIdentity(view: DiscussionView | null): RoomIdentity {
  if (!view) return { conversationId: null, runId: null, deltas: false };
  // `activeRunId` names the run whenever one is working; `liveTurn` is the
  // older reading, kept for a view from before it was carried.
  return { conversationId: view.id, runId: view.activeRunId ?? view.liveTurn?.runId ?? null, deltas: view.deltaSeq !== undefined };
}

/** The three pushes a chat room is kept live by. */
export type RoomPush =
  | { channel: "items:changed"; payload: IpcPushPayload<"items:changed"> }
  | { channel: "runs:changed"; payload: IpcPushPayload<"runs:changed"> }
  | { channel: "runs:progress"; payload: IpcPushPayload<"runs:progress"> };

/**
 * Whether a push is about the chat a room shows (EO-550).
 *
 * The pushes are doorbells for the whole installation. `runs:progress`
 * fires up to five times a second for every running agent, and a room
 * re-read for each was a chat rebuilt from its whole thread many times a
 * second for runs it does not draw, every re-read cancelling the one in
 * flight. Each push already says what it is about, so the room listens
 * only to its own:
 *
 * - `runs:progress` — only the run working in this chat.
 * - `runs:changed` — a run on this chat's item (a turn starting or
 *   ending), or the run it already knows.
 * - `items:changed` — this chat's item; or no item named, which is the
 *   main process saying "something changed" without saying what, and
 *   stays a refresh. Not this chat's item when its changes arrive as
 *   deltas (EO-553): the main process follows every `items:changed`
 *   naming the chat with an `assist:delta`, which writes the change in or
 *   asks again itself — a turn posting five messages is not five reads.
 *
 * Before the room has been opened there is nothing to refresh but the
 * open itself, which is already reading the latest; only an item-less
 * `items:changed` still asks again, as it always did.
 */
export function pushConcernsRoom(room: RoomIdentity, push: RoomPush): boolean {
  switch (push.channel) {
    case "items:changed":
      return push.payload.itemId === undefined || (room.conversationId !== null && push.payload.itemId === room.conversationId && !room.deltas);
    case "runs:changed":
      return (room.conversationId !== null && push.payload.itemId === room.conversationId) || (room.runId !== null && push.payload.runId === room.runId);
    case "runs:progress":
      return room.runId !== null && push.payload.runId === room.runId;
  }
}

/**
 * Re-reads a chat room on the pushes about it, and on no others.
 *
 * Invalidates `queryKey` exactly: nothing cached beneath a room's key is
 * the room, and a card's own read is refreshed by what changes it.
 *
 * The identity is read through a ref, so the room moving to another chat
 * or another run does not tear down and resubscribe three listeners.
 */
export function useRoomPushes(queryKey: readonly unknown[], room: RoomIdentity, enabled = true): void {
  const queryClient = useQueryClient();
  const identity = useRef(room);
  identity.current = room;
  // By value, for `useInvalidateOnPush`'s reason: callers pass a fresh array.
  const serializedKey = JSON.stringify(queryKey);

  useEffect(() => {
    if (!enabled) return undefined;
    const key = JSON.parse(serializedKey) as unknown[];
    const consider = (push: RoomPush) => {
      if (pushConcernsRoom(identity.current, push)) void queryClient.invalidateQueries({ queryKey: key, exact: true });
    };
    const unsubscribe = [
      bridge().subscribe("items:changed", (payload) => consider({ channel: "items:changed", payload })),
      bridge().subscribe("runs:changed", (payload) => consider({ channel: "runs:changed", payload })),
      bridge().subscribe("runs:progress", (payload) => consider({ channel: "runs:progress", payload })),
    ];
    return () => unsubscribe.forEach((stop) => stop());
  }, [queryClient, serializedKey, enabled]);
}
