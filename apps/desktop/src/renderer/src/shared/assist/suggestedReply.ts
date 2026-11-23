import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { IpcPushPayload, SuggestedReplyDismissal, SuggestedReplyUse } from "@eo/core";
import { bridge } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";

/**
 * The suggested next message of each assistant chat, as this window has
 * been told it (EO-809, `assist:suggestion`).
 *
 * Display-only and held nowhere else: not a comment, a message or a run
 * event, so a window that missed the push has none, and nothing asks for
 * it again. It is the latest turn's and goes as soon as anything moves
 * past that turn — a newer run starting in the chat (`runs:changed`), the
 * person sending anything (`clearSuggestedReply`), the chat no longer
 * being the one drawn (`useSuggestedReply`). A push for a chat no
 * surface is drawing is dropped, so a late one cannot outlive the leaving.
 *
 * Module state rather than React state, as `liveDeltas.ts` is: one
 * subscription per window however many surfaces draw the room.
 *
 * What the person does with one that was shown is reported to the main
 * process (EO-895, `assist:suggestionUsed`): shown, accepted into the
 * box, sent from it (edited or not), or dismissed — typed over, a newer
 * run in the chat, or the chat left. Each at most once per suggestion,
 * here as well as where it is stored, so a redraw reports nothing twice.
 */
export interface SuggestedReply {
  /** The run whose turn it follows: drawn only under that run's reply. */
  runId: string;
  text: string;
}

const byConversation = new Map<string, SuggestedReply>();
/** The chats some surface is drawing now, counted: a push for any other is too late to show. */
const drawing = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let subscriptions: (() => void)[] = [];
/** The suggestion each chat has drawn in its box and nobody has taken or dismissed yet, by the run it follows. */
const shownFor = new Map<string, string>();
/** The suggestion each chat took into its box, waiting for the message it becomes. */
const acceptedFor = new Map<string, SuggestedReply>();
/** Every action reported from this window, `runId:action`: none twice. */
const reported = new Set<string>();

/** Tells the main process, once. A report that fails is not worth a word to the person: nothing they did depends on it. */
function report(use: SuggestedReplyUse): void {
  const key = `${use.runId}:${use.action}`;
  if (reported.has(key)) return;
  reported.add(key);
  void ipcQuery("assist:suggestionUsed", use).catch(() => undefined);
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Takes one pushed suggestion. Exported for tests; the subscription is the real caller. */
export function applySuggestedReply(push: IpcPushPayload<"assist:suggestion">): void {
  // A chat nobody is drawing was left, and leaving it let go of its turn's
  // suggestion: one arriving afterwards would otherwise wait here and
  // appear when the person came back, past the reply it was for.
  if (!drawing.has(push.conversationId)) return;
  byConversation.set(push.conversationId, { runId: push.runId, text: push.text });
  changed();
}

/**
 * Forgets a chat's suggestion. One that was shown and not taken is
 * reported dismissed, by `by`; without one, nothing is reported.
 */
export function clearSuggestedReply(conversationId: string, by?: SuggestedReplyDismissal): void {
  const shown = shownFor.get(conversationId);
  if (shown !== undefined && by !== undefined) {
    shownFor.delete(conversationId);
    report({ conversationId, runId: shown, action: "dismissed", by });
  }
  if (byConversation.delete(conversationId)) changed();
}

/** The chat's suggestion was drawn in its box (EO-895): reported once, however often it is drawn. */
export function suggestedReplyShown(conversationId: string): void {
  const suggestion = byConversation.get(conversationId);
  if (!suggestion) return;
  shownFor.set(conversationId, suggestion.runId);
  report({ conversationId, runId: suggestion.runId, action: "shown" });
}

/** The chat's shown suggestion was taken into the box (EO-895): it leaves the store, and the message sent next is weighed against it. */
export function acceptSuggestedReply(conversationId: string): void {
  const suggestion = byConversation.get(conversationId);
  if (!suggestion) return;
  if (shownFor.get(conversationId) === suggestion.runId) {
    shownFor.delete(conversationId);
    acceptedFor.set(conversationId, suggestion);
    report({ conversationId, runId: suggestion.runId, action: "accepted" });
  }
  if (byConversation.delete(conversationId)) changed();
}

/** A message is being sent in the chat: one that follows a taken suggestion is reported sent from it, and whether its text changed. */
export function sentSuggestedReply(conversationId: string, body: string): void {
  const accepted = acceptedFor.get(conversationId);
  if (!accepted) return;
  acceptedFor.delete(conversationId);
  report({ conversationId, runId: accepted.runId, action: "sent", edited: body.trim() !== accepted.text.trim() });
}

function ensureSubscribed(): void {
  if (subscriptions.length > 0) return;
  subscriptions = [
    bridge().subscribe("assist:suggestion", applySuggestedReply),
    // A newer turn starting in the chat: the reply the suggestion was
    // for is no longer the last word.
    bridge().subscribe("runs:changed", (push) => {
      if (push.status === "running" || push.status === "queued") clearSuggestedReply(push.itemId, "newer_turn");
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

/** The suggestion of the chat being drawn, and what the composer reports of it. */
export interface SuggestedReplyHandle {
  suggestion: SuggestedReply | null;
  /** Lets go of it; `by` says it was dismissed, for one that was shown. */
  clear: (by?: SuggestedReplyDismissal) => void;
  /** Drawn in the empty box. */
  shown: () => void;
  /** Taken into the box with Tab or Right arrow. */
  accept: () => void;
  /** A message is being sent: from the taken suggestion, edited or not, if one was taken. */
  sent: (body: string) => void;
}

/**
 * The suggestion for the chat being drawn, and the way to let go of it.
 * A chat that stops being the one drawn loses its suggestion, and one
 * shown in it and not taken is dismissed by the leaving.
 */
export function useSuggestedReply(conversationId: string | null | undefined): SuggestedReplyHandle {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (!conversationId) return undefined;
    drawing.set(conversationId, (drawing.get(conversationId) ?? 0) + 1);
    return () => {
      const left = (drawing.get(conversationId) ?? 1) - 1;
      if (left > 0) drawing.set(conversationId, left);
      else drawing.delete(conversationId);
      clearSuggestedReply(conversationId, "left");
      // A taken suggestion's text went with the box it was in.
      acceptedFor.delete(conversationId);
    };
  }, [conversationId]);
  const clear = useCallback(
    (by?: SuggestedReplyDismissal) => {
      if (conversationId) clearSuggestedReply(conversationId, by);
    },
    [conversationId],
  );
  const shown = useCallback(() => {
    if (conversationId) suggestedReplyShown(conversationId);
  }, [conversationId]);
  const accept = useCallback(() => {
    if (conversationId) acceptSuggestedReply(conversationId);
  }, [conversationId]);
  const sent = useCallback(
    (body: string) => {
      if (conversationId) sentSuggestedReply(conversationId, body);
    },
    [conversationId],
  );
  return { suggestion: conversationId ? (byConversation.get(conversationId) ?? null) : null, clear, shown, accept, sent };
}

/** For tests: back to an empty window. */
export function resetSuggestedReplies(): void {
  byConversation.clear();
  drawing.clear();
  shownFor.clear();
  acceptedFor.clear();
  reported.clear();
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  changed();
}
