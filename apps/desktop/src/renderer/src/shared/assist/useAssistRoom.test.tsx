import type { ReactNode } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { useProjects } from "../../query/useRepositories";
import { useAssistChats, useAssistRoom } from "./useAssistRoom";
import { usePageDescriptor } from "../view/ViewPublisher";

/**
 * What the renderer sends (EO-189, EO-193).
 *
 * Two properties, and both are about the payload rather than about
 * anything rendered — the panel is `AssistWidget.test.tsx`, and what
 * matters here is what crosses the boundary. A route and its parameters
 * leave this side, never a sentence about the page. And the room is not
 * chosen here at all any more: there is one thread, so opening carries
 * nothing and no navigation can swap the conversation somebody is
 * mid-sentence in.
 */
function wrapper(path: string) {
  const client = createQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

/**
 * A wrapper the test can walk around in, the way a person does with the
 * panel open. `Navigate` is rendered on demand rather than driven
 * through a router hook so the navigation happens in the tree the hook
 * is mounted in.
 */
function walkableWrapper(path: string) {
  const client = createQueryClient();
  return {
    goTo(next: string) {
      destination = next;
    },
    Wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="*" element={<>{destination === null ? null : <Navigate to={destination} replace />}{children}</>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>
    ),
  };
}

let destination: string | null = null;

beforeEach(() => {
  destination = null;
});

/**
 * The room does not open without somebody in it (EO-190).
 *
 * `useAssistRoom` reads the agents list before it opens anything,
 * because opening *creates* a conversation — so every case that expects a
 * thread has to staff the installation first.
 */
const SYSTEM_AGENT = {
  id: "019fb8c6-de92-7a41-9c33-4471f0c2b1df",
  name: "Assistant",
  role: "system",
  provider: "claude",
  model: null,
  enabled: true,
  archivedAt: null,
};

/** Answers `agents:list` with a staffed installation and hands everything else on. */
function staffed(inner: (channel: string, payload: unknown) => unknown) {
  return vi.fn((channel: string, payload: unknown) =>
    channel === "agents:list" ? Promise.resolve({ ok: true, data: { agents: [SYSTEM_AGENT] } }) : inner(channel, payload),
  );
}

const CONVERSATION = {
  id: "019fb8c6-de92-7a41-9c33-4471f0c2b1de",
  key: "ASK-1",
  startedAt: 0,
  closedAt: null,
  thinking: false,
  thinkingSince: null,
  liveOutput: "",
  liveActivity: [],
  settings: {
    agentId: "a",
    agentName: "Assistant",
    provider: "claude",
    model: null,
    defaultModel: null,
    reasoningEffort: null,
    defaultReasoningEffort: null,
  },
  messages: [],
};

describe("the descriptor the renderer sends", () => {
  it("is the route and its parameters, for an item page", () => {
    const { result } = renderHook(() => usePageDescriptor(), { wrapper: wrapper("/items/019f") });

    expect(result.current).toEqual({ route: "/items/:itemId", params: { itemId: "019f" } });
  });

  it("is the route alone for a screen", () => {
    const { result } = renderHook(() => usePageDescriptor(), { wrapper: wrapper("/settings") });

    expect(result.current).toEqual({ route: "/settings", params: {} });
  });

  it("hands an unlisted path over as itself rather than describing it", () => {
    const { result } = renderHook(() => usePageDescriptor(), { wrapper: wrapper("/project") });

    expect(result.current).toEqual({ route: "/project", params: {} });
  });
});

describe("the one room", () => {
  it("opens nothing until the widget is opened", async () => {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }));
    window.eo.ipc.invoke = invoke as never;

    renderHook(() => useAssistRoom(false), { wrapper: wrapper("/items/019f") });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens the one thread with no page at all, and sends the page with each message", async () => {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }));
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/items/019f") });

    await waitFor(() => expect(result.current.conversation).not.toBeNull());
    // Opening decides nothing about where the person is (EO-193). The
    // message does, and only for the board a graph it proposes could be
    // published against.
    expect(invoke).toHaveBeenCalledWith("assist:open", undefined);

    void result.current.send("move this to Review");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assist:send", {
        page: { route: "/items/:itemId", params: { itemId: "019f" } },
        conversationId: CONVERSATION.id,
        body: "move this to Review",
        attachmentIds: [],
        interrupt: false,
      }),
    );
  });

  /**
   * The property the whole story turns on, from the renderer's side: one
   * thread, whose page changed. A room keyed on the live route would
   * silently swap conversations underneath somebody mid-sentence — the
   * reply they were reading replaced by an empty thread, and their next
   * message landing somewhere that has never heard of the item. That
   * used to be held off by latching the page the panel opened on; there
   * is nothing left to latch, because nothing is keyed.
   */
  it("keeps the conversation when the person navigates, and sends the new page with it", async () => {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }));
    window.eo.ipc.invoke = invoke as never;

    const walkable = walkableWrapper("/items/019f");
    const { result, rerender } = renderHook(() => useAssistRoom(true), { wrapper: walkable.Wrapper });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    act(() => walkable.goTo("/settings"));
    rerender();

    // The same room. Nothing re-opened on Settings, and nothing could
    // have opened a different one if it had.
    await waitFor(() => expect(result.current.conversation?.id).toBe(CONVERSATION.id));
    expect(invoke.mock.calls.filter(([channel]) => channel === "assist:open")).toHaveLength(1);

    void result.current.send("and how long may a run take?");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("assist:send", {
        // The new page…
        page: { route: "/settings", params: {} },
        // …in the conversation they were already in.
        conversationId: CONVERSATION.id,
        body: "and how long may a run take?",
        attachmentIds: [],
        interrupt: false,
      }),
    );
  });

  /**
   * Closing and reopening somewhere else resumes the same conversation,
   * which is the half a person notices: they ask about an item, walk to
   * Settings, open the widget again, and the thread is the one they were
   * in rather than an empty room keyed on Settings.
   */
  it("resumes the same thread when the panel is closed and opened again somewhere else", async () => {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }));
    window.eo.ipc.invoke = invoke as never;

    const walkable = walkableWrapper("/items/019f");
    const { result, rerender } = renderHook(({ open }: { open: boolean }) => useAssistRoom(open), {
      wrapper: walkable.Wrapper,
      initialProps: { open: true },
    });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    rerender({ open: false });
    act(() => walkable.goTo("/settings"));
    rerender({ open: false });
    rerender({ open: true });

    await waitFor(() => expect(result.current.conversation?.id).toBe(CONVERSATION.id));
    // Every open call is the same call: there is no page to re-select a
    // room with.
    for (const [channel, payload] of invoke.mock.calls.filter(([channel]) => channel === "assist:open")) {
      expect({ channel, payload }).toEqual({ channel: "assist:open", payload: undefined });
    }
  });

  /**
   * Clear (EO-193). One click, and what comes back is on screen at once
   * rather than when a refetch gets round to it.
   */
  it("clears the thread and shows the empty one it was given", async () => {
    const emptied = { ...CONVERSATION, id: "a-fresh-thread", key: "ASK-2" };
    // Once it is cleared, opening finds the empty thread: the one with
    // anything in it has been archived.
    let cleared = false;
    const invoke = staffed((channel: string) => {
      if (channel === "assist:clear") cleared = true;
      return Promise.resolve({ ok: true, data: { conversation: cleared ? emptied : CONVERSATION } });
    });
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    act(() => result.current.clear());

    await waitFor(() => expect(result.current.conversation?.id).toBe(emptied.id));
    expect(invoke).toHaveBeenCalledWith("assist:clear", undefined);
  });

  /**
   * New chat (EO-391). Another chat on show, and the one left behind is
   * not cleared to get there.
   */
  it("starts a new chat without clearing the one it leaves, and shows the one it was given", async () => {
    const started = { ...CONVERSATION, id: "a-second-chat", key: "ASK-2" };
    let isNew = false;
    const invoke = staffed((channel: string) => {
      if (channel === "assist:new") isNew = true;
      return Promise.resolve({ ok: true, data: { conversation: isNew ? started : CONVERSATION } });
    });
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    act(() => result.current.startNew());

    await waitFor(() => expect(result.current.conversation?.id).toBe(started.id));
    expect(invoke).toHaveBeenCalledWith("assist:new", undefined);
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain("assist:clear");
  });

  /**
   * Nobody to talk to, so nothing is created.
   *
   * Opening the room creates a conversation (EO-188), so asking for one
   * on an installation with no enabled system agent would leave an
   * `ASK-` thread behind for a page where nothing could ever have been
   * said. The panel says so in a sentence instead.
   */
  it("opens no room at all when there is no enabled system agent", async () => {
    const invoke = vi.fn((channel: string) =>
      channel === "agents:list"
        ? Promise.resolve({ ok: true, data: { agents: [{ ...SYSTEM_AGENT, enabled: false }] } })
        : Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }),
    );
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });

    await waitFor(() => expect(result.current.available).toBe(false));
    expect(invoke.mock.calls.filter(([channel]) => channel === "assist:open")).toHaveLength(0);
    expect(result.current.conversation).toBeNull();
  });

  /** A retired agent is not an agent to talk to, whatever its checkbox says (EO-186). */
  it("counts a retired system agent as nobody", async () => {
    const invoke = vi.fn((channel: string) =>
      channel === "agents:list"
        ? Promise.resolve({ ok: true, data: { agents: [{ ...SYSTEM_AGENT, archivedAt: 1 }] } })
        : Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }),
    );
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });

    await waitFor(() => expect(result.current.available).toBe(false));
    expect(invoke.mock.calls.filter(([channel]) => channel === "assist:open")).toHaveLength(0);
  });

  /**
   * The refusal reaches the person by being thrown (EO-194).
   *
   * It used to be recorded as `problem` and drawn by the panel, above a
   * box the panel also had to remember not to clear. `Composer` owns both
   * halves of that: it keeps what was typed until the send resolves and
   * prints the reason underneath when it does not — so the sentence has
   * to come back as a rejection, and printing it here as well would say
   * the same thing twice about one keystroke.
   */
  it("throws the main process's own sentence when a send is refused, and keeps it out of `problem`", async () => {
    window.eo.ipc.invoke = staffed((channel: string) =>
      channel === "assist:send"
        ? Promise.resolve({ ok: false, error: { message: "There is no enabled system agent to talk to." } })
        : Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }),
    ) as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });

    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    await expect(result.current.send("hello")).rejects.toThrow("There is no enabled system agent to talk to.");
    expect(result.current.problem).toBeNull();
  });

  /**
   * A message sent mid-turn that missed the turn (EO-395).
   *
   * The main process says where it went, and the room holds that
   * sentence apart from `problem`: nothing failed, the message is in the
   * thread, and the composer must clear as it does for any send.
   */
  it("keeps the sentence saying a message was left for the next turn, and drops it on the next send", async () => {
    const note = "Assistant had already finished the turn when this arrived, so it was not read by it. It will be read by the next turn in this conversation.";
    const deliveries = [{ requested: "now", outcome: "next", note }, { requested: "now", outcome: "now", note: null }, null];
    window.eo.ipc.invoke = staffed((channel: string) =>
      Promise.resolve({ ok: true, data: channel === "assist:send" ? { conversation: CONVERSATION, delivery: deliveries.shift() } : { conversation: CONVERSATION } }),
    ) as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());
    expect(result.current.notice).toBeNull();

    await result.current.send("and the screenshot");
    await waitFor(() => expect(result.current.notice).toBe(note));
    expect(result.current.problem).toBeNull();

    // Delivered into the turn: nothing to correct, so nothing is said.
    await result.current.send("one more");
    await waitFor(() => expect(result.current.notice).toBeNull());

    // And an ordinary send, with no turn running, says nothing either.
    await result.current.send("a new question");
    expect(result.current.notice).toBeNull();
  });

  /** Staged files travel with the message they were staged for. */
  it("sends the staged attachment ids alongside the body", async () => {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation: CONVERSATION } }));
    window.eo.ipc.invoke = invoke as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/settings") });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());

    await result.current.send("what is in this screenshot?", ["019fb8c6-de92-7a41-9c33-4471f0c2b1a1"]);

    expect(invoke).toHaveBeenCalledWith("assist:send", {
      page: { route: "/settings", params: {} },
      conversationId: CONVERSATION.id,
      body: "what is in this screenshot?",
      attachmentIds: ["019fb8c6-de92-7a41-9c33-4471f0c2b1a1"],
      interrupt: false,
    });
  });
});

describe("one thread from the pages read back and the view", () => {
  const said = (id: string, createdAt: number, body = id) => ({ id, body, createdAt }) as unknown as import("@eo/core").DiscussionMessage;

  it("keeps each message once, the view's copy where both have it, pages first", async () => {
    const { mergedMessages } = await import("./useAssistRoom");
    const merged = mergedMessages([said("a", 1), said("b", 2, "old copy")], [said("b", 2, "new copy"), said("d", 4)]);
    expect(merged.map((message) => `${message.id}:${message.body}`)).toEqual(["a:a", "b:new copy", "d:d"]);
  });
});

describe("reading a long chat back a page at a time", () => {
  const said = (id: string, createdAt: number) => ({ id, authorType: "human", authorName: "You", body: id, attachments: [], kind: "note", parentId: null, runId: null, options: null, canAnswer: false, createdAt, canApprove: false, approves: null, status: null });

  it("loses no message when the view moves on after a page has been read", async () => {
    let view = { ...CONVERSATION, messages: [said("n0", 10), said("n1", 11), said("n2", 12)], earlier: 2 };
    window.eo.ipc.invoke = staffed((channel, payload) => {
      if (channel === "assist:open") return Promise.resolve({ ok: true, data: { conversation: view } });
      if (channel === "assist:earlier") {
        expect(payload).toEqual({ conversationId: CONVERSATION.id, before: "n0", limit: 50 });
        return Promise.resolve({ ok: true, data: { messages: [said("o0", 1), said("o1", 2)], earlier: 0 } });
      }
      return Promise.resolve({ ok: true, data: {} });
    }) as never;

    const { result } = renderHook(() => useAssistRoom(true), { wrapper: wrapper("/chat") });
    await waitFor(() => expect(result.current.earlier.remaining).toBe(2));
    act(() => result.current.earlier.load());
    await waitFor(() => expect(result.current.earlier.remaining).toBe(0));

    // The chat grows and its newest stretch slides past n0 and n1.
    view = { ...CONVERSATION, messages: [said("n2", 12), said("n3", 13)], earlier: 4 };
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.conversation?.messages.map((message) => message.id)).toEqual(["n2", "n3"]));

    const { mergedMessages } = await import("./useAssistRoom");
    const thread = mergedMessages(result.current.earlier.messages, result.current.conversation!.messages);
    expect(thread.map((message) => message.id)).toEqual(["o0", "o1", "n0", "n1", "n2", "n3"]);
  });
});

/**
 * The room is re-read only for its own chat and its own run (EO-550).
 *
 * `runs:progress` fires up to five times a second for every running
 * agent. Each one used to re-read the room — and, because every card's
 * own read sat under the room's key, every card in it — cancelling the
 * read in flight each time. Each test below emits pushes as the main
 * process does and counts the `assist:open` calls they cause.
 */
describe("the pushes the room is re-read for", () => {
  const OWN_RUN = "019fb8c6-de92-7a41-9c33-4471f0c2b1f0";
  const OTHER_RUN = "019fb8c6-de92-7a41-9c33-4471f0c2b1f1";
  const OTHER_ITEM = "019fb8c6-de92-7a41-9c33-4471f0c2b1f2";
  const WORKING = { ...CONVERSATION, thinking: true, thinkingSince: 1, activeRunId: OWN_RUN };

  let listeners: Map<string, Set<(payload: unknown) => void>>;
  function emit(channel: string, payload: unknown) {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  }

  beforeEach(() => {
    listeners = new Map();
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(callback);
      listeners.set(channel, set);
      return () => set.delete(callback);
    }) as never;
  });

  async function openRoom(conversation: object = WORKING) {
    const invoke = staffed(() => Promise.resolve({ ok: true, data: { conversation } }));
    window.eo.ipc.invoke = invoke as never;
    const client = createQueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={["/chat"]}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
    const { result } = renderHook(() => useAssistRoom(true), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.conversation).not.toBeNull());
    const opens = () => invoke.mock.calls.filter(([channel]) => channel === "assist:open").length;
    await waitFor(() => expect(client.isFetching()).toBe(0));
    return { client, result, opens };
  }

  /** Emits, then gives any refetch it asked for time to reach the bridge. */
  async function after(push: () => void) {
    await act(async () => {
      push();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("is not re-read for progress on a run that is not the chat's", async () => {
    const { opens } = await openRoom();
    const before = opens();

    await after(() => emit("runs:progress", { runId: OTHER_RUN }));

    expect(opens()).toBe(before);
  });

  it("is re-read for progress on the chat's own run", async () => {
    const { opens } = await openRoom();
    const before = opens();

    await after(() => emit("runs:progress", { runId: OWN_RUN }));

    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("is not re-read for progress at all while nothing runs in it", async () => {
    const { opens } = await openRoom(CONVERSATION);
    const before = opens();

    await after(() => emit("runs:progress", { runId: OWN_RUN }));

    expect(opens()).toBe(before);
  });

  it("is not re-read for another item's change, and is for its own or for an unnamed one", async () => {
    const { opens } = await openRoom();
    const before = opens();

    await after(() => emit("items:changed", { itemId: OTHER_ITEM }));
    expect(opens()).toBe(before);

    await after(() => emit("items:changed", { itemId: CONVERSATION.id }));
    await waitFor(() => expect(opens()).toBe(before + 1));

    await after(() => emit("items:changed", {}));
    await waitFor(() => expect(opens()).toBe(before + 2));
  });

  it("is re-read when a run starts or ends on its own chat, and not on another item", async () => {
    const { opens } = await openRoom(CONVERSATION);
    const before = opens();

    await after(() => emit("runs:changed", { runId: OTHER_RUN, itemId: OTHER_ITEM, status: "running" }));
    expect(opens()).toBe(before);

    await after(() => emit("runs:changed", { runId: OWN_RUN, itemId: CONVERSATION.id, status: "running" }));
    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("knows its run from the live turn when the view does not name it", async () => {
    const { opens } = await openRoom({ ...WORKING, activeRunId: undefined, liveTurn: { runId: OWN_RUN, startedAt: 1, steps: [], drafts: [], lastDraftId: 0, answer: "" } });
    const before = opens();

    await after(() => emit("runs:progress", { runId: OTHER_RUN }));
    expect(opens()).toBe(before);
    await after(() => emit("runs:progress", { runId: OWN_RUN }));
    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  /**
   * A draft card, an operation card and an open proposal each read their
   * own data, under roots of their own. Re-reading the room — by a push
   * about it, or by `refresh` after a card's button — leaves them alone.
   */
  it("leaves the cards' and proposals' own reads alone when the room is re-read", async () => {
    const { assistCardKey, assistDraftKey } = await import("./useAssistRoom");
    const { proposalKey } = await import("../../chat/views/proposal/useProposal");
    const { client, result, opens } = await openRoom();
    const cards = [assistDraftKey("m1"), assistCardKey("m2"), proposalKey("m3")];
    for (const key of cards) client.setQueryData(key, { cached: true });
    const before = opens();

    await after(() => emit("runs:progress", { runId: OWN_RUN }));
    await after(() => result.current.refresh());

    await waitFor(() => expect(opens()).toBe(before + 2));
    for (const key of cards) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });
});

/**
 * Switching project (EO-765). Each project has its own chats and its own
 * chat on show, so the room and the rail must never go on holding, or
 * sending into, the chat of the project being left — not while the
 * switch is under way, and not when a read begun before it answers late.
 */
describe("switching project", () => {
  const CHAT_ON = { a: { ...CONVERSATION, id: "chat-on-a", key: "ASK-1" }, b: { ...CONVERSATION, id: "chat-on-b", key: "ASK-2" } };
  const PROJECTS = [
    { id: "a", name: "Shop", archivedAt: null },
    { id: "b", name: "Blog", archivedAt: null },
  ];

  function deferred(): { promise: Promise<void>; release: () => void } {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /**
   * The main process, as far as these hooks ask it: which project is
   * active, and each project's one chat. `holdSwitch` keeps
   * `projects:setActive` from answering until released; `holdFirstOpen`
   * does the same to the first `assist:open`, which still answers with
   * the chat of the project active when it was asked; `holdFirstSend` and
   * `holdNew` to the first `assist:send` and every `assist:new`, likewise.
   * `holdRereadsOnB` holds every `assist:open` on B after the first, so a
   * wrong chat written into the room stays there to be seen.
   */
  function mainProcess(
    options: { holdSwitch?: Promise<void>; holdFirstOpen?: Promise<void>; holdFirstSend?: Promise<void>; holdNew?: Promise<void>; holdRereadsOnB?: Promise<void> } = {},
  ) {
    let active: "a" | "b" = "a";
    let opens = 0;
    let opensOnB = 0;
    let sends = 0;
    const invoke = staffed(async (channel, payload) => {
      if (channel === "projects:list") return { ok: true, data: { projects: PROJECTS, activeProjectId: active } };
      if (channel === "projects:setActive") {
        await options.holdSwitch;
        active = (payload as { id: "a" | "b" }).id;
        return { ok: true, data: { activeProjectId: active } };
      }
      if (channel === "assist:open") {
        const askedOn = active;
        opens += 1;
        if (opens === 1) await options.holdFirstOpen;
        if (askedOn === "b" && ++opensOnB > 1) await options.holdRereadsOnB;
        return { ok: true, data: { conversation: CHAT_ON[askedOn] } };
      }
      if (channel === "assist:list") {
        const chat = CHAT_ON[active];
        return { ok: true, data: { conversations: [{ id: chat.id, key: chat.key, title: chat.key, startedAt: 0, lastActivityAt: 0, live: true, shown: true, state: "idle" }] } };
      }
      if (channel === "assist:send") {
        const { conversationId } = payload as { conversationId: string | null };
        const askedOn = active;
        sends += 1;
        if (sends === 1) await options.holdFirstSend;
        return { ok: true, data: { conversation: conversationId === CHAT_ON.a.id ? CHAT_ON.a : CHAT_ON[askedOn], delivery: { note: `Delivered on ${askedOn}.` } } };
      }
      if (channel === "assist:new") {
        const askedOn = active;
        await options.holdNew;
        return { ok: true, data: { conversation: CHAT_ON[askedOn] } };
      }
      return { ok: true, data: {} };
    });
    window.eo.ipc.invoke = invoke as never;
    return invoke;
  }

  /** Every chat the room has drawn, render by render, so a flash of one is seen as well as a chat that stays. */
  let drawn: (string | null)[] = [];

  function mounted() {
    drawn = [];
    return renderHook(
      () => {
        const room = useAssistRoom(true);
        drawn.push(room.conversation?.id ?? null);
        return { projects: useProjects(), room, chats: useAssistChats(true) };
      },
      { wrapper: wrapper("/chat") },
    );
  }

  /** What the room drew from the first time it showed B's chat on. */
  const drawnSinceB = () => drawn.slice(drawn.indexOf(CHAT_ON.b.id));

  const sentTo = (invoke: ReturnType<typeof mainProcess>) =>
    invoke.mock.calls.filter(([channel]) => channel === "assist:send").map(([, payload]) => (payload as { conversationId: string | null }).conversationId);

  it("drops the left project's chat and rail at once, refuses a send until the switch is through, and sends into the new project's chat after", async () => {
    const hold = deferred();
    const invoke = mainProcess({ holdSwitch: hold.promise });
    const { result } = mounted();
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.a.id));
    await waitFor(() => expect(result.current.chats.chats.map((chat) => chat.id)).toEqual([CHAT_ON.a.id]));

    act(() => result.current.projects.setActive("b"));

    // Nothing of A's left to read or write in while the switch is under way.
    await waitFor(() => expect(result.current.room.conversation).toBeNull());
    expect(result.current.room.ready).toBe(false);
    expect(result.current.chats.chats).toEqual([]);
    await expect(result.current.room.send("Draft a release pipeline.")).rejects.toThrow(/switching project/i);
    expect(sentTo(invoke)).toEqual([]);

    hold.release();

    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id));
    await waitFor(() => expect(result.current.chats.chats.map((chat) => chat.id)).toEqual([CHAT_ON.b.id]));
    expect(result.current.room.ready).toBe(true);
    await act(() => result.current.room.send("Draft a release pipeline."));
    expect(sentTo(invoke)).toEqual([CHAT_ON.b.id]);
  });

  it("sends a message straight after the switch into the new project's chat, never the old one's", async () => {
    const invoke = mainProcess();
    const { result } = mounted();
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.a.id));

    act(() => result.current.projects.setActive("b"));
    await waitFor(() => expect(result.current.projects.activeProjectId).toBe("b"));
    await waitFor(() => expect(result.current.room.ready).toBe(true));
    // As soon as the composer takes anything again: B's chat, or no chat
    // named — which the main process answers with B's — never A's.
    await act(() => result.current.room.send("Draft a release pipeline."));

    expect(sentTo(invoke)).toHaveLength(1);
    expect(sentTo(invoke)[0]).not.toBe(CHAT_ON.a.id);
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id));
  });

  it("never takes the left project's chat from a read that answers after the switch", async () => {
    const hold = deferred();
    mainProcess({ holdFirstOpen: hold.promise });
    const { result } = mounted();
    // The first read of the room is asked on A, and has not answered.
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalledWith("assist:open", undefined));
    expect(result.current.room.conversation).toBeNull();

    act(() => result.current.projects.setActive("b"));
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id));

    // A's answer arrives late.
    hold.release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id);
  });

  /**
   * A write's reply is the project it was sent on's, however late it
   * lands: the reviewer's case, a message sent to no chat in particular
   * while A's room was still opening, answered with A's chat after the
   * window is on B and B's room is read.
   */
  it("never draws, or sends the next message into, the left project's chat from a send answered after the switch", async () => {
    const opening = deferred();
    const answering = deferred();
    const invoke = mainProcess({ holdFirstOpen: opening.promise, holdFirstSend: answering.promise });
    const { result } = mounted();
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalledWith("assist:open", undefined));
    expect(result.current.room.conversation).toBeNull();

    // Sent on A with no chat named, as the composer does before the room has opened.
    let sent!: Promise<void>;
    act(() => {
      sent = result.current.room.send("Draft a release pipeline.");
    });
    await waitFor(() => expect(sentTo(invoke)).toEqual([null]));
    expect(result.current.room.pending?.body).toBe("Draft a release pipeline.");

    act(() => result.current.projects.setActive("b"));
    await waitFor(() => expect(result.current.projects.activeProjectId).toBe("b"));
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id));
    // A's message is not drawn on B's room while it is on its way.
    expect(result.current.room.pending).toBeNull();

    // A's answer, with A's chat, lands after B's room is on show.
    answering.release();
    opening.release();
    await act(() => sent);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id);
    expect(drawnSinceB()).not.toContain(CHAT_ON.a.id);
    expect(result.current.room.notice).toBeNull();
    await act(() => result.current.room.send("And publish it."));
    expect(sentTo(invoke)).toEqual([null, CHAT_ON.b.id]);
  });

  it("never shows the left project's new chat when New chat answers after the switch", async () => {
    const answering = deferred();
    // B's room is read once; the backstop read after New chat would put
    // B back over a wrong write, and is held so it cannot hide one.
    mainProcess({ holdNew: answering.promise, holdRereadsOnB: new Promise<void>(() => {}) });
    const { result } = mounted();
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.a.id));

    act(() => result.current.room.startNew());
    await waitFor(() => expect(window.eo.ipc.invoke).toHaveBeenCalledWith("assist:new", undefined));
    act(() => result.current.projects.setActive("b"));
    await waitFor(() => expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id));

    answering.release();
    await waitFor(() => expect(result.current.room.startingNew).toBe(false));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.current.room.conversation?.id).toBe(CHAT_ON.b.id);
    // Not even for a moment before the backstop read put B back.
    expect(drawnSinceB()).not.toContain(CHAT_ON.a.id);
  });
});
