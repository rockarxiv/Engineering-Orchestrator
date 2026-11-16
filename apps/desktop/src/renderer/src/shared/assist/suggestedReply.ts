import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { IpcPushPayload } from "@eo/core";
import { bridge } from "../../ipc/bridge";

/**
 * The suggested next message of each assistant chat, as this window has
 * been told it (EO-809, `assist:suggestion`).
 *
 * Display-only and held nowhere else: not a comment, a message or a run
 * event, so a window that missed the push has none, and nothing asks for
 * it again. It is the latest turn's and goes as soon as anything moves
 * past that turn — a newer run starting in the chat (`runs:changed`), the
 * person sending anything (`clearSuggestedReply`), the chat no longer
 * being the one drawn (`useSuggestedReply`).
 *
 * Module state rather than React state, as `liveDeltas.ts` is: one
 * subscription per window however many surfaces draw the room.
 */
export interface SuggestedReply {
  /** The run whose turn it follows: drawn only under that run's reply. */
  runId: string;
  text: string;
}

const byConversation = new Map<string, SuggestedReply>();
const listeners = new Set<() => void>();
let version = 0;
let subscriptions: (() => void)[] = [];

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Takes one pushed suggestion. Exported for tests; the subscription is the real caller. */
export function applySuggestedReply(push: IpcPushPayload<"assist:suggestion">): void {
  byConversation.set(push.conversationId, { runId: push.runId, text: push.text });
  changed();
}

/** Forgets a chat's suggestion. */
export function clearSuggestedReply(conversationId: string): void {
  if (byConversation.delete(conversationId)) changed();
}

function ensureSubscribed(): void {
  if (subscriptions.length > 0) return;
  subscriptions = [
    bridge().subscribe("assist:suggestion", applySuggestedReply),
    // A newer turn starting in the chat: the reply the suggestion was
    // for is no longer the last word.
    bridge().subscribe("runs:changed", (push) => {
      if (push.status === "running" || push.status === "queued") clearSuggestedReply(push.itemId);
    }),
  ];
}

function subscribe(listener: () => void): () => void {
  ensureSubscribed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The suggestion for the chat being drawn, and the way to let go of it.
 * A chat that stops being the one drawn loses its suggestion.
 */
export function useSuggestedReply(conversationId: string | null | undefined): { suggestion: SuggestedReply | null; clear: () => void } {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (!conversationId) return undefined;
    return () => clearSuggestedReply(conversationId);
  }, [conversationId]);
  const clear = useCallback(() => {
    if (conversationId) clearSuggestedReply(conversationId);
  }, [conversationId]);
  return { suggestion: conversationId ? (byConversation.get(conversationId) ?? null) : null, clear };
}

/** For tests: back to an empty window. */
export function resetSuggestedReplies(): void {
  byConversation.clear();
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  changed();
}
