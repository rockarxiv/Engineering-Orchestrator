import type { ReactNode } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionMessage, DiscussionView } from "@eo/core";
import { createQueryClient } from "../../query/client";
import { applyAssistDelta, assistDeltaOutcome, type AssistDelta } from "./assistDeltas";
import { assistRoomKey, useAssistRoom } from "./useAssistRoom";

/**
 * An assistant chat's changes arriving as numbered deltas (EO-553).
 *
 * The room writes the next delta into its cache and reads itself again
 * — once — for anything else. What a delta holds is the main process's
 * (`main/ipc/assistDeltas.test.ts`); this is what the room does with it.
 */
const CHAT = "019fb8c6-de92-7a41-9c33-4471f0c2b1de";
const OTHER_CHAT = "019fb8c6-de92-7a41-9c33-4471f0c2b1e0";
const RUN = "019fb8c6-de92-7a41-9c33-4471f0c2b1f0";

function message(id: string, body: string, overrides: Partial<DiscussionMessage> = {}): DiscussionMessage {
  return {
    id,
    authorType: "agent",
    authorName: "Assistant",
    body,
    attachments: [],
    kind: "note",
    parentId: null,
    runId: RUN,
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: false,
    approves: null,
    moduleSlug: null,
    proposedType: null,
    status: null,
    ...overrides,
  };
}

function view(deltaSeq: number | undefined, messages: DiscussionMessage[] = [], id = CHAT): DiscussionView {
  return {
    id,
    key: "ASK-1",
    startedAt: 0,
    closedAt: null,
    thinking: true,
    thinkingSince: 1,
    activeRunId: RUN,
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
    messages,
    ...(deltaSeq === undefined ? {} : { deltaSeq }),
  } as DiscussionView;
}

/** A delta upserting `messages`, after which the view holds `ids` (by default nothing but them). */
function delta(seq: number, messages: DiscussionMessage[], ids: string[] = messages.map((one) => one.id), overrides: Partial<AssistDelta> = {}): AssistDelta {
  return { conversationId: CHAT, seq, messages, messageIds: ids, earlier: 0, resync: false, ...overrides };
}

const ASKED = message("019fb8c6-de92-7a41-9c33-4471f0c2b101", "Which board?", { authorType: "human", authorName: "You", runId: null });

describe("what one delta does to the view the room holds", () => {
  it("writes the next one in: a message it has in its place, a new one after the rest", () => {
    const base = view(3, [ASKED, message("m-2", "Thinking it over")]);

    const outcome = assistDeltaOutcome(base, delta(4, [message("m-2", "The Apollo board."), message("m-3", "Shall I file it?")], [ASKED.id, "m-2", "m-3"]));

    expect(outcome.kind).toBe("apply");
    if (outcome.kind !== "apply") return;
    expect(outcome.view.deltaSeq).toBe(4);
    expect(outcome.view.messages.map((one) => one.body)).toEqual(["Which board?", "The Apollo board.", "Shall I file it?"]);
  });

  it("reads the room again for a skipped number, a view with none, no view at all, or a resync", () => {
    expect(assistDeltaOutcome(view(3), delta(5, [])).kind).toBe("refetch");
    expect(assistDeltaOutcome(view(undefined), delta(1, [])).kind).toBe("refetch");
    expect(assistDeltaOutcome(undefined, delta(1, [])).kind).toBe("refetch");
    expect(assistDeltaOutcome(view(3), delta(4, [], [], { resync: true })).kind).toBe("refetch");
  });

  it("does nothing for another chat's, or for one the view already includes", () => {
    expect(assistDeltaOutcome(view(3, [], OTHER_CHAT), delta(4, [])).kind).toBe("ignore");
    expect(assistDeltaOutcome(view(3), delta(3, [])).kind).toBe("ignore");
    expect(assistDeltaOutcome(view(3), delta(2, [])).kind).toBe("ignore");
  });

  it("writes a message it already holds in again without moving it", () => {
    const base = view(1, [ASKED]);
    expect(applyAssistDelta(base, delta(2, [ASKED]))?.messages).toEqual([ASKED]);
  });

  it("lets go of a message the delta no longer names, and takes its count of older ones", () => {
    // The oldest of the stretch slid out of it, or left the thread: either
    // way the view `assist:open` would answer with now does not hold it.
    const base = view(1, [ASKED, message("m-2", "Two")]);

    const applied = applyAssistDelta(base, delta(2, [message("m-3", "Three")], ["m-2", "m-3"], { earlier: 1 }));

    expect(applied?.messages.map((one) => one.id)).toEqual(["m-2", "m-3"]);
    expect(applied?.earlier).toBe(1);
  });

  it("reads the room again for a delta naming a message it holds no copy of", () => {
    expect(assistDeltaOutcome(view(1, [ASKED]), delta(2, [], ["m-0", ASKED.id])).kind).toBe("refetch");
  });
});

describe("the room, as deltas arrive", () => {
  const SYSTEM_AGENT = { id: "019fb8c6-de92-7a41-9c33-4471f0c2b1df", name: "Assistant", role: "system", provider: "claude", model: null, enabled: true, archivedAt: null };

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

  /** Mounts the room with `assist:open` answered by `open`, one call at a time. */
  function mount(open: (call: number) => Promise<unknown>) {
    let calls = 0;
    const invoke = vi.fn((channel: string) => {
      if (channel === "agents:list") return Promise.resolve({ ok: true, data: { agents: [SYSTEM_AGENT] } });
      if (channel === "assist:open") return open(calls++).then((conversation) => ({ ok: true, data: { conversation } }));
      return new Promise(() => {});
    });
    window.eo.ipc.invoke = invoke as never;
    const client = createQueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={["/chat"]}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
    const { result } = renderHook(() => useAssistRoom(true), { wrapper: Wrapper });
    const opens = () => invoke.mock.calls.filter(([channel]) => channel === "assist:open").length;
    return { client, result, opens };
  }

  /** Mounts the room on `base`, and waits until the first open has settled. */
  async function openRoom(base: DiscussionView) {
    const mounted = mount((call) => (call === 0 ? Promise.resolve(base) : new Promise(() => {})));
    await waitFor(() => expect(mounted.result.current.conversation).not.toBeNull());
    await waitFor(() => expect(mounted.client.isFetching()).toBe(0));
    return mounted;
  }

  /** Emits, then gives any refetch it asked for time to reach the bridge. */
  async function after(push: () => void) {
    await act(async () => {
      push();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("draws the next delta from the push alone, with no assist:open for it", async () => {
    const { result, client, opens } = await openRoom(view(0, [ASKED]));
    const before = opens();

    await after(() => emit("assist:delta", delta(1, [message("m-2", "The Apollo board.")], [ASKED.id, "m-2"])));

    await waitFor(() => expect(result.current.conversation?.messages.map((one) => one.body)).toEqual(["Which board?", "The Apollo board."]));
    expect(client.getQueryData<{ conversation: DiscussionView }>(assistRoomKey)?.conversation.deltaSeq).toBe(1);
    expect(opens()).toBe(before);
  });

  it("reads the room again exactly once when a number is skipped", async () => {
    let answered = 0;
    const mounted = mount((call) => {
      answered = call;
      return Promise.resolve(call === 0 ? view(0, [ASKED]) : view(2, [ASKED, message("m-2", "One"), message("m-3", "Two")]));
    });
    await waitFor(() => expect(mounted.result.current.conversation).not.toBeNull());
    await waitFor(() => expect(mounted.client.isFetching()).toBe(0));
    const before = mounted.opens();

    await after(() => emit("assist:delta", delta(2, [message("m-3", "Two")])));

    await waitFor(() => expect(mounted.opens()).toBe(before + 1));
    await waitFor(() => expect(mounted.result.current.conversation?.messages).toHaveLength(3));
    // And the view it brought back settles it: nothing is read a third time.
    await after(() => undefined);
    expect(mounted.opens()).toBe(before + 1);
    expect(answered).toBe(1);
  });

  it("reads the room again exactly once for a delta that arrives before any view", async () => {
    // The first open is still on its way when the delta lands, and comes
    // back from before it.
    let release: (base: DiscussionView) => void = () => undefined;
    const mounted = mount((call) =>
      call === 0 ? new Promise<DiscussionView>((resolve) => (release = resolve)) : Promise.resolve(view(1, [ASKED, message("m-2", "The Apollo board.")])),
    );
    await waitFor(() => expect(mounted.opens()).toBe(1));

    await after(() => emit("assist:delta", delta(1, [message("m-2", "The Apollo board.")], [ASKED.id, "m-2"])));
    await act(async () => {
      release(view(0, [ASKED]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await waitFor(() => expect(mounted.opens()).toBe(2));
    await waitFor(() => expect(mounted.result.current.conversation?.messages).toHaveLength(2));
    await after(() => undefined);
    expect(mounted.opens()).toBe(2);
  });

  it("is not read again once per message of a turn that posts several", async () => {
    const { result, opens } = await openRoom(view(0, [ASKED]));
    const before = opens();

    // What the main process sends for each message the turn posts: the
    // chat's `items:changed`, and the delta that follows it.
    const said = ["Looking at the board.", "Two items match.", "Shall I file the third?"];
    for (const [index, body] of said.entries()) {
      await after(() => {
        emit("items:changed", { itemId: CHAT });
        emit("assist:delta", delta(index + 1, [message(`m-${String(index)}`, body)], [ASKED.id, ...said.slice(0, index + 1).map((_, at) => `m-${String(at)}`)]));
      });
    }

    await waitFor(() => expect(result.current.conversation?.messages.map((one) => one.body)).toEqual(["Which board?", ...said]));
    expect(opens()).toBe(before);
  });

  it("is still read again for its own item's change while its view carries no number", async () => {
    const { opens } = await openRoom(view(undefined, [ASKED]));
    const before = opens();

    await after(() => emit("items:changed", { itemId: CHAT }));

    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("does nothing with another chat's delta", async () => {
    const { result, opens } = await openRoom(view(0, [ASKED]));
    const before = opens();

    await after(() => emit("assist:delta", { ...delta(1, [message("m-2", "Elsewhere")]), conversationId: OTHER_CHAT }));

    expect(opens()).toBe(before);
    expect(result.current.conversation?.messages).toEqual([ASKED]);
  });

  it("reads itself once more when a view older than a delta it drew is written over it", async () => {
    const { client, opens } = await openRoom(view(0, [ASKED]));
    await after(() => emit("assist:delta", delta(1, [message("m-2", "The Apollo board.")], [ASKED.id, "m-2"])));
    const before = opens();

    // A reply built before that delta, landing after it.
    await after(() => client.setQueryData(assistRoomKey, { conversation: view(0, [ASKED]) }));

    await waitFor(() => expect(opens()).toBe(before + 1));
  });

  it("still reads itself again for an older view written over it after a gap was already caught up", async () => {
    // A gap at 2, read again, and the view that came back holds 2. Then a
    // reply built before all of it lands: the room must not go on drawing
    // that because a read was once asked for at 2.
    const mounted = mount((call) => Promise.resolve(call === 0 ? view(0, [ASKED]) : view(2, [ASKED, message("m-2", "One"), message("m-3", "Two")])));
    await waitFor(() => expect(mounted.result.current.conversation).not.toBeNull());
    await waitFor(() => expect(mounted.client.isFetching()).toBe(0));
    await after(() => emit("assist:delta", delta(2, [message("m-3", "Two")])));
    await waitFor(() => expect(mounted.result.current.conversation?.deltaSeq).toBe(2));
    await waitFor(() => expect(mounted.client.isFetching()).toBe(0));
    const before = mounted.opens();

    await after(() => mounted.client.setQueryData(assistRoomKey, { conversation: view(0, [ASKED]) }));

    await waitFor(() => expect(mounted.opens()).toBe(before + 1));
    await waitFor(() => expect(mounted.result.current.conversation?.deltaSeq).toBe(2));
  });

  it("asks only once when the room comes back behind a delta it can never catch up with", async () => {
    // A main process that started again counts from 0: the room heard 7,
    // and every read answers 0. One read, and no loop.
    const mounted = mount(() => Promise.resolve(view(0, [ASKED])));
    await waitFor(() => expect(mounted.result.current.conversation).not.toBeNull());
    await waitFor(() => expect(mounted.client.isFetching()).toBe(0));
    const before = mounted.opens();

    await after(() => emit("assist:delta", delta(7, [])));
    await waitFor(() => expect(mounted.opens()).toBe(before + 1));
    await after(() => undefined);
    await after(() => undefined);

    expect(mounted.opens()).toBe(before + 1);
  });
});
