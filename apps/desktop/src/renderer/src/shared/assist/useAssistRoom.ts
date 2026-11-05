import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { isDispatchable, type DiscussionMessage, type DiscussionView, type IpcPayload, type IpcResponse } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { agentsKey } from "../../query/hooks";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { roomIdentity, useRoomPushes } from "../../query/useRoomPushes";
import { usePageDescriptor } from "../view/ViewPublisher";
import { useAssistDeltas } from "./assistDeltas";

/**
 * The renderer's half of the help widget's room.
 *
 * **One chat on show** (EO-193). Opening the widget anywhere shows the
 * same conversation, so there is one query key rather than one per page,
 * and walking from an item to the board to Settings does not open a
 * second room. There can be several live chats behind it (EO-391), and
 * which one is shown is the main process's to say: starting another or
 * switching changes what `assist:open` answers with, for every surface. It used to be keyed on the page, because EO-189 preloaded that
 * page into every turn; EO-192 ended that, and with it the reason to
 * fragment a conversation that should be continuous.
 *
 * What this hook sends is still **the route and its parameters, never a
 * description of the page**. The renderer has a query cache and a
 * router; it does not have the database, and a sentence it wrote about an
 * item is a sentence the agent would then act on. The descriptor is
 * down to one job in the main process — naming the board a graph raised
 * here would be published against — and what the agent reads about the
 * screen comes from `view:current`, published separately by
 * `ViewPublisher` and resolved on demand.
 *
 * `pageDescriptorFor` lives in `@eo/core` rather than in the renderer for
 * the reason everything crossing IPC does: the same route table has to
 * mean the same thing on both sides, and two of them would be one table
 * and a bug. `usePageDescriptor` is the publisher's, shared so the room
 * and the screen cannot disagree about which page a path is.
 *
 * The panel is `AssistPanel.tsx`, and this is the data underneath it:
 * whether there is anybody to talk to, opening the room, the transcript,
 * the live run, sending a message and clearing the thread. The three
 * channels only a card can call — answering a batch, approving a
 * decomposition, reading a draft back to publish — live with the buttons
 * that call them, where the problem each reports belongs to the card it
 * came from.
 */

/**
 * The one key the assistant thread is cached under.
 *
 * A constant, and that is the whole of "one thread": a key that varied
 * with the route would have the panel swap conversations underneath
 * somebody who walked to another screen mid-sentence.
 */
export const assistRoomKey = ["assist"] as const;

/**
 * The keys a card's own read is cached under (EO-550): a pipeline draft
 * (`assist:draft`) and an operation card (`assist:card`), by the message
 * the card is.
 *
 * Roots of their own, outside `assistRoomKey`, as the list of chats is:
 * the room is re-read whenever its chat moves, and every card in the
 * transcript being re-read with it was a fetch per card on every streamed
 * event. A card is refreshed by what changes it.
 */
export const assistDraftKey = (messageId: string) => ["assistDraft", messageId] as const;
export const assistCardKey = (messageId: string) => ["assistCard", messageId] as const;

/**
 * Draws the conversation a write answered with, at once (EO-548).
 *
 * `assist:send`, `assist:answer`, `assist:approve`, `assist:applyCard`
 * and `assist:applyChange` each answer with the chat as it stands after
 * the write. Thrown away and re-read through `assist:open`, it left a
 * second round trip between the press and the screen: a question card
 * live again with its picks, a proposal's button back to "Create", a sent
 * message gone from the box and not yet in the transcript. Written here
 * instead, the way Clear and New write theirs — and the caller still
 * invalidates after it, which stays the backstop.
 *
 * Only over the chat on show. A write names a chat; if another window
 * moved this room to a different one while it was in flight, or the
 * canvas approved a proposal in a chat that is not the one on show, its
 * answer is not what this room draws, and writing it would switch chats
 * underneath the person. Nothing cached yet is the same: there is no
 * room open to draw into.
 */
export function drawAssistReply(queryClient: QueryClient, conversation: DiscussionView): void {
  const shown = queryClient.getQueryData<IpcResponse<"assist:open">>(assistRoomKey);
  if (shown?.conversation.id !== conversation.id) return;
  queryClient.setQueryData<IpcResponse<"assist:open">>(assistRoomKey, { conversation });
}

/**
 * The key the list of chats is cached under.
 *
 * Its own, outside `assistRoomKey`: the room is refetched on every
 * streamed event of its own run, and the list reads every thread's
 * comments. It moves on far fewer things.
 */
export const assistThreadsKey = ["assistThreads"] as const;

/**
 * What the assistant's composer says while a turn is running (EO-395).
 *
 * One sentence for both surfaces that draw this room — the help widget
 * and the chat layout — because it describes what `assist:send` does,
 * which is the same wherever it was typed.
 */
export const SENT_INTO_THE_TURN = "The assistant is working. A message sent now goes to the turn that is running.";

/**
 * A message on its way (EO-549): what the person sent, drawn in the
 * transcript as sending until the conversation that holds it is on
 * screen. `known` is every message the chat had when it was sent, so the
 * stored copy is told apart from an earlier message with the same words.
 */
export interface PendingSend {
  conversationId: string | null;
  body: string;
  attachmentCount: number;
  known: ReadonlySet<string>;
}

/**
 * The pending message still to be drawn beside `messages`, or null once
 * the stored copy is among them — whichever arrives first, the reply to
 * the send or a refetch a push asked for, the bubble gives way to it
 * rather than standing beside it. The main process stores the body
 * trimmed, as the composer sends it.
 */
export function pendingToDraw(pending: PendingSend | null, conversationId: string | null, messages: readonly DiscussionMessage[]): PendingSend | null {
  if (!pending) return null;
  if (pending.conversationId !== null && pending.conversationId !== conversationId) return null;
  const body = pending.body.trim();
  const stored = messages.some(
    (message) => message.authorType === "human" && message.parentId === null && !pending.known.has(message.id) && message.body === body,
  );
  return stored ? null : pending;
}

export interface AssistRoom {
  /**
   * Is there an enabled system agent to talk to at all?
   *
   * Read before the room is opened, not after, and that ordering is the
   * point: opening *creates* a conversation (EO-188), so asking with no
   * agent configured would leave an `ASK-` thread behind on an
   * installation where nothing could ever have been said. The panel says
   * so in a sentence instead and offers no composer — the same shape the
   * run composer uses for a backend that cannot be spoken to.
   */
  available: boolean;
  /** The conversation, once it has been opened. */
  conversation: DiscussionView | null;
  loading: boolean;
  /** Why the last clear did not work — the main process's own sentence. */
  problem: string | null;
  /**
   * What became of the last message, when it is not what the composer
   * said would happen (EO-395).
   *
   * A message sent while a turn is running goes into that turn. When it
   * could not — the turn ended first, or the backend refused it — the
   * message is still in the thread and the next turn reads it, and this
   * is the main process's sentence saying so. Null when the message went
   * where it was aimed, and cleared by the next send.
   *
   * Not `problem`: nothing failed and nothing is lost, so it is not
   * drawn as an error.
   */
  notice: string | null;
  /**
   * Sends, with whatever files were staged alongside the message.
   *
   * **Rejects** when the send is refused, which is `Composer`'s own
   * contract rather than a lapse: the composer keeps what somebody typed
   * until this resolves and prints the reason under the box if it does
   * not, so a guard costs a sentence instead of a paragraph. It used to
   * answer with a boolean and record the sentence as `problem`, which was
   * the bare textarea's arrangement — the panel drew the reason itself
   * and cleared the box by hand (EO-194).
   *
   * The ids are staged attachments, `attachments:stage` having already
   * put the bytes somewhere. Nothing is committed until the comment
   * carrying them lands.
   */
  send: (body: string, attachmentIds?: string[]) => Promise<void>;
  sending: boolean;
  /** The message `send` is carrying, while it is on its way; null otherwise and once it has failed. */
  pending: PendingSend | null;
  /**
   * Archives this thread and leaves an empty one.
   *
   * No confirmation anywhere on this path, because nothing is destroyed:
   * the thread keeps its comments and its runs and is readable in the
   * archive. A dialog would be friction over something a person does
   * often and can undo by reading.
   */
  clear: () => void;
  clearing: boolean;
  /**
   * Starts a new chat and shows it, leaving this one as it is (EO-391).
   *
   * Not Clear: nothing is archived, a turn running here runs on and
   * answers here, and this chat is one click away in the list.
   */
  startNew: () => void;
  startingNew: boolean;
  /** Re-reads the thread, for a card whose button changed it. */
  refresh: () => void;
  /**
   * Stops the turn running in the chat on show (`assist:stop`) — the Stop
   * button and Escape. The thread keeps what it said and did, and the next
   * message continues the same conversation.
   */
  stop: () => void;
  stopping: boolean;
  /** Changes what the next turns in this chat run with (`assist:settings`). */
  updateSettings: (patch: Omit<IpcPayload<"assist:settings">, "conversationId">) => void;
  /** Starts a new chat holding this one up to a message, and shows it (`assist:fork`). */
  fork: (messageId: string) => void;
  /**
   * The chat's older messages, read a page at a time (`assist:earlier`):
   * the view carries the newest stretch, and these are what has been
   * fetched before it, oldest first. `remaining` is how many more there are.
   */
  earlier: { messages: DiscussionMessage[]; remaining: number; loading: boolean; load: () => void };
  /** Takes back a message waiting for the next turn (`assist:withdraw`). */
  withdraw: (messageId: string) => void;
  /**
   * Somebody is typing in this chat with nothing running in it: warm the
   * backend for the turn they are about to ask for (`assist:prewarm`).
   * Fire and forget — a warm-up that does not happen costs nothing.
   */
  prewarm: () => void;
}

/**
 * The assistant thread.
 *
 * `open` gates the query because opening the room *creates* it (EO-188):
 * a thread opened by every screen anybody navigated past would be a
 * catalogue of conversations nobody had. Nothing is created until
 * somebody opens the widget, which is somebody deciding to talk.
 *
 * Opening carries no page at all now: there is one room, so there is
 * nothing for a descriptor to select and no latch to protect it. What
 * still carries one is `send`, and only for the board a graph raised by
 * that turn could be published against.
 */
export function useAssistRoom(open: boolean): AssistRoom {
  const page = usePageDescriptor();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Only while the panel is open: this is the app-wide agents list, kept
  // fresh by whichever screen needs it, and the widget has no business
  // fetching it on every route for a button nobody has pressed.
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined), enabled: open });
  useInvalidateOnPush("config:changed", agentsKey);

  // `isDispatchable`, not `enabled`: a retired agent is disabled for
  // dispatch however its checkbox reads (EO-186), and the same predicate
  // the scheduler uses is the one that decides whether this room has
  // anybody in it.
  const available = (agents.data?.agents ?? []).some((agent) => agent.role === "system" && isDispatchable(agent));

  const room = useQuery({
    queryKey: assistRoomKey,
    queryFn: () => ipcQuery("assist:open", undefined),
    enabled: open && available,
  });

  const view = room.data?.conversation ?? null;

  // The same three pushes the scenario room listens to — a turn writes
  // comments, starts and finishes a run, and streams output as it thinks
  // — and only those about this chat and its own run (EO-550).
  useRoomPushes(assistRoomKey, roomIdentity(view));
  // And the chat's own changes, which arrive as numbered deltas and are
  // written in rather than read again (EO-553): `items:changed` for this
  // chat is not one of the pushes above once the view carries a number.
  useAssistDeltas(assistRoomKey);
  // Stable, so a surface can hand it on to the live words without
  // re-arming their effects on every render.
  const refresh = useCallback(() => void queryClient.invalidateQueries({ queryKey: assistRoomKey }), [queryClient]);

  const send = useMutation({
    mutationFn: ({ body, attachmentIds, conversationId }: { body: string; attachmentIds: string[]; conversationId: string | null; known: ReadonlySet<string> }) =>
      // `page` is where the person is *now*, which is not necessarily
      // where this thread began: the panel does not close when you
      // navigate. It decides which board a graph proposed by the turn
      // this message starts could be published against, and nothing else
      // — where the person is now is `view_current`'s to answer, live
      // (EO-192).
      //
      // `interrupt: false` always, and no delivery mode beside it: a
      // message sent while a turn is running is delivered into that turn
      // by the main process (EO-395), which is the only behaviour this
      // room offers. The answer says whether it got there.
      ipcQuery("assist:send", { page, conversationId, body, attachmentIds, interrupt: false }),
    onSuccess: (result, { conversationId }) => {
      setProblem(null);
      setNotice(result.delivery?.note ?? null);
      // The message in the transcript as the box lets go of it, rather
      // than a refetch later (EO-548). A send to no chat in particular
      // started the one on show, so there is nothing to compare against.
      if (conversationId === null) queryClient.setQueryData<IpcResponse<"assist:open">>(assistRoomKey, { conversation: result.conversation });
      else drawAssistReply(queryClient, result.conversation);
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
    },
    // A refused send is the composer's to report, under the box that
    // still holds the message, so nothing is recorded here. The room is
    // read again all the same: the likeliest refusal is "That
    // conversation is closed." — another window put this thread away or
    // went back to an earlier one — and the retry should go to the
    // thread that is live now rather than refuse the same way forever.
    onError: () => void queryClient.invalidateQueries({ queryKey: assistRoomKey }),
  });

  const clear = useMutation({
    mutationFn: () => ipcQuery("assist:clear", undefined),
    onSuccess: (result) => {
      setProblem(null);
      // Written straight into the cache as well as invalidated: the
      // empty thread is the answer, and waiting for a refetch to say so
      // would leave the transcript somebody just cleared on screen.
      queryClient.setQueryData(assistRoomKey, result);
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const startNew = useMutation({
    mutationFn: () => ipcQuery("assist:new", undefined),
    onSuccess: (result) => {
      setProblem(null);
      // Straight into the cache, for Clear's reason: the empty chat is
      // the answer, and the one left behind should not stay on screen
      // until a refetch says so.
      queryClient.setQueryData(assistRoomKey, result);
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  // Older pages, for the chat on show only: another chat starts again
  // from its own newest stretch.
  const [older, setOlder] = useState<{ conversationId: string; messages: DiscussionMessage[]; remaining: number } | null>(null);
  useEffect(() => {
    setOlder((current) => (current && current.conversationId === view?.id ? current : null));
  }, [view?.id]);
  // Once a page has been read back, every message the view carries is kept
  // too: the view is the newest hundred and slides forward as the chat
  // grows, and a message that slid out of it would otherwise be in neither
  // the view nor the pages. Kept as it was last seen; the view's own copy
  // still wins wherever both have one.
  useEffect(() => {
    if (!view) return;
    setOlder((current) => {
      if (!current || current.conversationId !== view.id) return current;
      const known = new Set(current.messages.map((message) => message.id));
      const slid = view.messages.filter((message) => !known.has(message.id));
      return slid.length === 0 ? current : { ...current, messages: [...current.messages, ...slid] };
    });
  }, [view]);
  const earlier = useMutation({
    mutationFn: (payload: IpcPayload<"assist:earlier">) => ipcQuery("assist:earlier", payload),
    onSuccess: (result, payload) => {
      setOlder((current) => {
        const kept = current?.conversationId === payload.conversationId ? current.messages : (view?.id === payload.conversationId ? view.messages : []);
        const known = new Set(kept.map((message) => message.id));
        return { conversationId: payload.conversationId, messages: [...result.messages.filter((message) => !known.has(message.id)), ...kept], remaining: result.earlier };
      });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });
  const withdraw = useMutation({
    mutationFn: (payload: IpcPayload<"assist:withdraw">) => ipcQuery("assist:withdraw", payload),
    onSuccess: (result) => {
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      if (result.withdrawn) setNotice("Taken back: the assistant will not answer that message.");
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });
  const olderHere = older && older.conversationId === view?.id ? older : null;
  const remaining = olderHere ? olderHere.remaining : (view?.earlier ?? 0);

  const stop = useMutation({
    mutationFn: (conversationId: string) => ipcQuery("assist:stop", { conversationId }),
    onSuccess: (result) => {
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const settings = useMutation({
    mutationFn: (payload: IpcPayload<"assist:settings">) => ipcQuery("assist:settings", payload),
    onSuccess: (result) => {
      setProblem(null);
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const fork = useMutation({
    mutationFn: (payload: IpcPayload<"assist:fork">) => ipcQuery("assist:fork", payload),
    onSuccess: (result) => {
      setProblem(result.problem);
      // The new chat is the one on show: written straight in, for the
      // reason a new chat is, and the list learns it has another.
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  return {
    available,
    conversation: view,
    loading: agents.isLoading || room.isLoading,
    problem,
    notice,
    send: async (body: string, attachmentIds: string[] = []) => {
      const known = new Set([...(olderHere?.messages ?? []), ...(view?.messages ?? [])].map((message) => message.id));
      await send.mutateAsync({ body, attachmentIds, conversationId: view?.id ?? null, known });
    },
    sending: send.isPending,
    // The mutation's own variables while it is in flight: gone the moment
    // it settles, so a failed send leaves no bubble behind.
    pending:
      send.isPending && send.variables
        ? { conversationId: send.variables.conversationId, body: send.variables.body, attachmentCount: send.variables.attachmentIds.length, known: send.variables.known }
        : null,
    clear: () => clear.mutate(),
    clearing: clear.isPending,
    startNew: () => startNew.mutate(),
    startingNew: startNew.isPending,
    refresh,
    stop: () => {
      if (view) stop.mutate(view.id);
    },
    stopping: stop.isPending,
    updateSettings: (patch) => {
      if (view) settings.mutate({ conversationId: view.id, ...patch });
    },
    fork: (messageId) => {
      if (view) fork.mutate({ conversationId: view.id, messageId });
    },
    prewarm: () => {
      if (!view || view.thinking) return;
      void ipcQuery("assist:prewarm", { conversationId: view.id }).catch(() => undefined);
    },
    withdraw: (messageId) => {
      if (view) withdraw.mutate({ conversationId: view.id, messageId });
    },
    earlier: {
      messages: olderHere?.messages ?? [],
      remaining,
      loading: earlier.isPending,
      load: () => {
        const oldest = olderHere?.messages[0] ?? view?.messages[0];
        // Drawn in order; the oldest the window holds is what the next page comes before.
        if (view && oldest && remaining > 0 && !earlier.isPending) earlier.mutate({ conversationId: view.id, before: oldest.id, limit: 50 });
      },
    },
  };
}

/** A live chat, as the panel's switcher knows it. */
export interface AssistChat {
  id: string;
  title: string;
  /** The one on show. */
  shown: boolean;
}

/**
 * The live chats, and showing another of them (EO-391).
 *
 * For a surface with no rail beside it: the help widget and the
 * assistant's own window have nowhere else to switch from. Live ones
 * only — a put-away chat is gone back to from the chat layout's list,
 * which is where the whole history is drawn.
 *
 * In the order `assist:list` answers them in, which is the order the
 * rail draws them in and the person set there (EO-438). Nothing here
 * reorders: a select is not something to drag.
 *
 * Switching is navigation. It changes which chat every surface shows and
 * nothing about either chat.
 */
export function useAssistChats(open: boolean): { chats: AssistChat[]; show: (conversationId: string) => void; switching: boolean; problem: string | null } {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const threads = useQuery({ queryKey: assistThreadsKey, queryFn: () => ipcQuery("assist:list", undefined), enabled: open });
  // A chat started, shown, put away or removed in any window pushes the
  // first; one moved in the rail, the second (EO-439).
  useInvalidateOnPush("items:changed", assistThreadsKey);
  useInvalidateOnPush("assist:changed", assistThreadsKey);

  const show = useMutation({
    mutationFn: (conversationId: string) => ipcQuery("assist:resume", { conversationId }),
    onSuccess: (result) => {
      setProblem(result.problem);
      queryClient.setQueryData(assistRoomKey, { conversation: result.conversation });
      void queryClient.invalidateQueries({ queryKey: assistRoomKey });
      void queryClient.invalidateQueries({ queryKey: assistThreadsKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  return {
    chats: (threads.data?.conversations ?? []).filter((thread) => thread.live).map(({ id, title, shown }) => ({ id, title, shown })),
    show: (conversationId: string) => show.mutate(conversationId),
    switching: show.isPending,
    problem,
  };
}

/**
 * The messages read back so far and the view's, as one thread: each once,
 * the view's copy where both have it (it is the newer).
 */
export function mergedMessages(older: readonly DiscussionMessage[], newest: readonly DiscussionMessage[]): DiscussionMessage[] {
  // No sort: the pages are older than the view by construction, in the
  // order they were read, and the view's order is the main process's.
  const live = new Set(newest.map((message) => message.id));
  return [...older.filter((message) => !live.has(message.id)), ...newest];
}
