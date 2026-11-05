import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DiscussionMessage, DiscussionView, IpcPushPayload, IpcResponse } from "@eo/core";
import { bridge } from "../../ipc/bridge";

/**
 * The assistant room's half of `assist:delta` (EO-553).
 *
 * A turn that posts several messages used to have the room read again
 * through `assist:open` for each, every read rebuilding the chat from its
 * thread. The main process now sends what changed, numbered per chat,
 * and the room writes it into its cache when it is the next one — the
 * way `runs:delta` already carries the words a turn is writing.
 *
 * Anything else reads the room again, once: a number skipped, a delta
 * arriving before there is a view to apply it to, a view carrying no
 * number, or a change the main process says a list of messages cannot
 * carry (`resync`). That is the backstop it always was, and focus and
 * reconnection refetch the room as they did.
 */
export type AssistDelta = IpcPushPayload<"assist:delta">;

/** What a delta does to the room: written in, nothing (not this chat, or already in it), or the room read again. */
export type AssistDeltaOutcome = { kind: "apply"; view: DiscussionView } | { kind: "ignore" } | { kind: "refetch" };

/**
 * A delta written into a view: the messages the view now carries, in
 * order, each the delta's copy where it has one and the view's where it
 * does not, and the count of older ones beyond them. Null when it names a
 * message neither holds, which this view cannot place.
 */
export function applyAssistDelta(view: DiscussionView, delta: AssistDelta): DiscussionView | null {
  const known = new Map(view.messages.map((message) => [message.id, message]));
  for (const message of delta.messages) known.set(message.id, message);
  const messages: DiscussionMessage[] = [];
  for (const id of delta.messageIds) {
    const message = known.get(id);
    if (!message) return null;
    messages.push(message);
  }
  return { ...view, messages, earlier: delta.earlier, deltaSeq: delta.seq };
}

/**
 * What one delta does to the view the room holds.
 *
 * - No view yet: the room is read again — which chat is on show is not
 *   known, and this may be it.
 * - Another chat's: nothing; it is not the room.
 * - A number the view already includes: nothing. A reply that answered
 *   with the chat after the change gets there first as often as not.
 * - The next number: written in, unless it is a `resync` or names a
 *   message the view cannot place.
 * - Anything else — a gap, a view with no number, a `resync` — the room
 *   is read again.
 */
export function assistDeltaOutcome(base: DiscussionView | null | undefined, delta: AssistDelta): AssistDeltaOutcome {
  if (!base) return { kind: "refetch" };
  if (base.id !== delta.conversationId) return { kind: "ignore" };
  if (base.deltaSeq === undefined) return { kind: "refetch" };
  if (delta.seq <= base.deltaSeq) return { kind: "ignore" };
  if (delta.seq !== base.deltaSeq + 1 || delta.resync) return { kind: "refetch" };
  const view = applyAssistDelta(base, delta);
  return view ? { kind: "apply", view } : { kind: "refetch" };
}

/** How many chats' newest heard number is kept; a chat dropped from it is only not healed as quickly. */
const HEARD_CHATS = 50;

/**
 * Writes the room's `assist:delta`s into its cache under `queryKey`.
 *
 * A read again is asked for once and never stacked: when one is already
 * on its way it is left to answer, and if what it brings back is older
 * than the newest delta heard for that chat — it set off before the
 * change — the room is read once more. The same check catches a view
 * written over a newer one, a reply built before a delta landing after
 * it. Once per number until the room has caught up with it, so a main
 * process that started again, and counts from 0, cannot have the room
 * read in a loop — and once it has caught up, an older view written over
 * it later is asked about again.
 */
export function useAssistDeltas(queryKey: readonly unknown[]): void {
  const queryClient = useQueryClient();
  // By value, for `useInvalidateOnPush`'s reason: callers pass a fresh array.
  const serializedKey = JSON.stringify(queryKey);

  useEffect(() => {
    const key = JSON.parse(serializedKey) as unknown[];
    /** The newest delta heard, per chat. */
    const heard = new Map<string, number>();
    /** The heard number a read again was last asked for, per chat. */
    const asked = new Map<string, number>();

    const shown = (): DiscussionView | undefined => queryClient.getQueryData<IpcResponse<"assist:open">>(key)?.conversation;
    const fetching = (): boolean => queryClient.isFetching({ queryKey: key, exact: true }) > 0;
    const readAgain = (conversationId: string): void => {
      asked.set(conversationId, heard.get(conversationId) ?? 0);
      // Exactly the room, as `useRoomPushes` invalidates it: nothing
      // cached beneath its key is the room.
      void queryClient.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
    };

    const settle = (): void => {
      const view = shown();
      if (!view) return;
      const newest = heard.get(view.id);
      if (newest === undefined) return;
      if (view.deltaSeq !== undefined && view.deltaSeq >= newest) {
        // Caught up: the next view written over this one that is older
        // than it is a new reason to ask, not the one already answered.
        asked.delete(view.id);
        return;
      }
      if (fetching() || asked.get(view.id) === newest) return;
      readAgain(view.id);
    };

    const hear = (delta: AssistDelta): void => {
      const newest = Math.max(heard.get(delta.conversationId) ?? 0, delta.seq);
      // Most recently heard last, so the cap lets go of the quietest chat.
      heard.delete(delta.conversationId);
      heard.set(delta.conversationId, newest);
      while (heard.size > HEARD_CHATS) heard.delete(heard.keys().next().value!);
      const outcome = assistDeltaOutcome(shown(), delta);
      if (outcome.kind === "apply") queryClient.setQueryData<IpcResponse<"assist:open">>(key, { conversation: outcome.view });
      // A read already on its way answers for this one; `settle` reads
      // once more if it set off too early.
      else if (outcome.kind === "refetch" && !fetching()) readAgain(delta.conversationId);
    };

    const unsubscribe = [
      bridge().subscribe("assist:delta", hear),
      // Every query is refetched on a reconnection, and the numbers it
      // comes back with may have started again.
      bridge().subscribeRefetch(() => {
        heard.clear();
        asked.clear();
      }),
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && JSON.stringify(event.query.queryKey) === serializedKey) settle();
      }),
    ];
    return () => unsubscribe.forEach((stop) => stop());
  }, [queryClient, serializedKey]);
}
