import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Markdown, MarkdownProps } from "@eo/ui";
import { createQueryClient } from "../query/client";
import { resetLiveDeltas } from "../shared/assist/liveDeltas";
import { resetSuggestedReplies } from "../shared/assist/suggestedReply";
import { ChatConversation } from "./ChatConversation";

/**
 * What a streamed word draws again (EO-551).
 *
 * `runs:delta` arrives about once a frame while a turn writes. Each one
 * must draw the live turn and nothing else: not the finished messages
 * above it, their actions, their cards or their markdown. The render
 * counter is Markdown itself — every finished row draws its words
 * through it, so a row drawn again is a source drawn again.
 */
const drawn = vi.hoisted(() => [] as string[]);

vi.mock("@eo/ui", async (importOriginal) => {
  // Named, not `typeof import("@eo/ui")`: the renderer takes only what `oneLayout.test.ts` allows.
  const actual = await importOriginal<{ Markdown: typeof Markdown }>();
  const Counted = (props: MarkdownProps) => {
    drawn.push(props.children);
    return <actual.Markdown {...props} />;
  };
  return { ...actual, Markdown: Counted };
});

const timesDrawn = (source: string) => drawn.filter((children) => children === source).length;

const SYSTEM_AGENT = { id: "019fb8c6-de92-7a41-9c33-4471f0c2b100", name: "Assistant", role: "system", provider: "claude", model: null, enabled: true, archivedAt: null };
const CHAT = "019fb8c6-de92-7a41-9c33-4471f0c2b1de";

function message(overrides: Record<string, unknown>) {
  return {
    id: "m",
    authorType: "agent",
    authorName: "Assistant",
    body: "",
    attachments: [],
    kind: "note",
    parentId: null,
    runId: null,
    options: null,
    canAnswer: false,
    createdAt: 1,
    canApprove: false,
    approves: null,
    status: null,
    ...overrides,
  };
}

const ASKED = "What is **waiting** on me?";
const ANSWERED = "Two approvals:\n\n- the weekly report\n- the Contoso renewal";
const FOLLOW_UP = "And the invoices?";

/** A conversation mid-turn, read afresh each time: new objects, as a reply off the wire is. */
function running({ steps = [] as unknown[], answered = ANSWERED } = {}) {
  return {
    id: CHAT,
    key: "ASK-1",
    startedAt: 0,
    closedAt: null,
    thinking: true,
    thinkingSince: Date.now(),
    liveOutput: "",
    liveActivity: [],
    settings: { agentId: SYSTEM_AGENT.id, agentName: "Assistant", provider: "claude", model: null, defaultModel: null, reasoningEffort: null, defaultReasoningEffort: null },
    messages: [
      message({ id: "h1", authorType: "human", authorName: "You", body: ASKED, createdAt: 1 }),
      message({ id: "a1", body: answered, runId: "run-0", createdAt: 2 }),
      message({ id: "h2", authorType: "human", authorName: "You", body: FOLLOW_UP, createdAt: 3, status: "processing" }),
    ],
    liveTurn: { runId: "run-1", startedAt: Date.now(), steps, drafts: [{ id: 1, stream: "text", text: "There are" }], lastDraftId: 1, answer: "" },
  };
}

let listeners: Map<string, ((payload: unknown) => void)[]>;
let conversation: ReturnType<typeof running>;

function push(channel: string, payload: unknown) {
  act(() => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  });
}

function open() {
  const fallback = window.eo.ipc.invoke as (channel: string, payload?: unknown) => Promise<unknown>;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === "agents:list") return { ok: true, data: { agents: [SYSTEM_AGENT] } };
    if (channel === "assist:open") return { ok: true, data: { conversation } };
    return fallback(channel, payload);
  }) as never;
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: (payload: unknown) => void) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
    return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((listener) => listener !== callback));
  }) as never;
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={["/chat"]}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return render(<ChatConversation narrow={false} />, { wrapper });
}

beforeEach(() => {
  drawn.length = 0;
  listeners = new Map();
  conversation = running();
});

afterEach(() => {
  resetLiveDeltas();
  resetSuggestedReplies();
});

describe("a streamed turn in the conversation (EO-551)", () => {
  it("draws the words as they arrive and draws none of the finished rows again", async () => {
    open();
    const live = await screen.findByRole("article", { name: "Live agent response" });
    expect(await within(live).findByText("There are")).toBeInTheDocument();
    expect(screen.getByText("Contoso renewal", { exact: false })).toBeInTheDocument();
    const before = { asked: timesDrawn(ASKED), answered: timesDrawn(ANSWERED), followUp: timesDrawn(FOLLOW_UP) };
    expect(before.asked).toBeGreaterThan(0);
    expect(before.answered).toBeGreaterThan(0);
    expect(before.followUp).toBeGreaterThan(0);

    let written = "There are";
    for (const piece of [" two", " invoices", " waiting", " on", " you."]) {
      push("runs:delta", { runId: "run-1", itemId: CHAT, draft: { id: 1, stream: "text" }, offset: written.length, text: piece });
      written += piece;
    }

    await waitFor(() => expect(within(live).getByText("There are two invoices waiting on you.")).toBeInTheDocument());
    expect({ asked: timesDrawn(ASKED), answered: timesDrawn(ANSWERED), followUp: timesDrawn(FOLLOW_UP) }).toEqual(before);
  });

  it("draws a finished row again only when its own message changed, however often the conversation is read", async () => {
    open();
    const live = await screen.findByRole("article", { name: "Live agent response" });
    await within(live).findByText("There are");
    const before = { asked: timesDrawn(ASKED), answered: timesDrawn(ANSWERED), followUp: timesDrawn(FOLLOW_UP) };

    // The turn moves on: the conversation is read again, every message in it a new object with the same words.
    conversation = running({ steps: [{ kind: "text", seq: 0, text: "Reading the inbox first." }] });
    push("runs:progress", { runId: "run-1", itemId: CHAT });
    expect(await within(live).findByText("Reading the inbox first.")).toBeInTheDocument();
    expect({ asked: timesDrawn(ASKED), answered: timesDrawn(ANSWERED), followUp: timesDrawn(FOLLOW_UP) }).toEqual(before);

    // One message is not the same: that row, and only that row, is drawn again.
    const corrected = "Three approvals:\n\n- the weekly report\n- the Contoso renewal\n- the Fabrikam lease";
    conversation = running({ steps: [{ kind: "text", seq: 0, text: "Reading the inbox first." }], answered: corrected });
    push("runs:progress", { runId: "run-1", itemId: CHAT });
    expect(await screen.findByText("Fabrikam lease", { exact: false })).toBeInTheDocument();
    expect(timesDrawn(corrected)).toBeGreaterThan(0);
    expect({ asked: timesDrawn(ASKED), followUp: timesDrawn(FOLLOW_UP) }).toEqual({ asked: before.asked, followUp: before.followUp });
  });
});

describe("an answer still being written after its message (EO-803)", () => {
  it("says so with a size that grows as deltas arrive, and stops saying so when the turn ends", async () => {
    const opening = '{"outcome":{"message":"Here is the module.","change":{"source":"';
    conversation = { ...running(), liveTurn: { ...running().liveTurn, drafts: [{ id: 1, stream: "text", text: '{"outcome":{"message":"Here is' }] } };
    open();
    const live = await screen.findByRole("article", { name: "Live agent response" });
    await within(live).findByText("Here is", { exact: false });
    expect(within(live).queryByRole("status")).toBeNull();

    let written = '{"outcome":{"message":"Here is';
    const send = (piece: string) => {
      push("runs:delta", { runId: "run-1", itemId: CHAT, draft: { id: 1, stream: "text" }, offset: written.length, text: piece });
      written += piece;
    };
    send(opening.slice(written.length));
    send("x".repeat(3000));
    await waitFor(() => expect(within(live).getByRole("status")).toHaveTextContent("Still writing the answer · 3.0 KB so far"));
    send("y".repeat(3000));
    await waitFor(() => expect(within(live).getByRole("status")).toHaveTextContent("Still writing the answer · 5.9 KB so far"));

    // The turn ends: the conversation is read again with its answer posted and nothing running.
    conversation = { ...running(), thinking: false, liveTurn: null as never };
    push("runs:progress", { runId: "run-1", itemId: CHAT });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Live agent response" })).toBeNull());
    expect(screen.queryByText(/Still writing the answer/)).toBeNull();
  });
});

/**
 * The suggested reply (EO-809): drawn in the empty box under the reply of
 * the run it follows, and gone as soon as the chat moves past that reply.
 */
describe("a suggested reply in the conversation", () => {
  /** The chat once the turn has answered: nothing running, the reply the last word. */
  function answered(extra: Record<string, unknown>[] = []) {
    return {
      ...running(),
      thinking: false,
      thinkingSince: null,
      liveTurn: null,
      messages: [message({ id: "h1", authorType: "human", authorName: "You", body: ASKED, createdAt: 1 }), message({ id: "a1", body: ANSWERED, runId: "run-0", createdAt: 2 }), ...extra],
    } as unknown as ReturnType<typeof running>;
  }

  const box = () => screen.getByLabelText("Message the assistant");

  it("is drawn grey in the empty box when it follows the latest reply", async () => {
    conversation = answered();
    open();
    await screen.findByText("Contoso renewal", { exact: false });
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "approve the renewal" });
    expect(box()).toHaveAttribute("placeholder", "approve the renewal");
  });

  it("is never drawn for an older turn's reply, nor another chat's", async () => {
    conversation = answered();
    open();
    await screen.findByText("Contoso renewal", { exact: false });
    push("assist:suggestion", { conversationId: CHAT, runId: "run-older", text: "approve the renewal" });
    push("assist:suggestion", { conversationId: "another-chat", runId: "run-0", text: "file it on Delivery" });
    expect(box()).not.toHaveAttribute("placeholder", "approve the renewal");
    expect(box()).not.toHaveAttribute("placeholder", "file it on Delivery");
  });

  it("goes when a newer turn starts in the chat", async () => {
    conversation = answered();
    open();
    await screen.findByText("Contoso renewal", { exact: false });
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "approve the renewal" });
    push("runs:changed", { runId: "run-1", itemId: CHAT, status: "running" });
    expect(box()).not.toHaveAttribute("placeholder", "approve the renewal");
  });

  it("goes when the person sends anything, and a late one for the reply before is not drawn", async () => {
    conversation = answered();
    open();
    await screen.findByText("Contoso renewal", { exact: false });
    const fallback = window.eo.ipc.invoke as (channel: string, payload?: unknown) => Promise<unknown>;
    const sent = answered([message({ id: "h2", authorType: "human", authorName: "You", body: FOLLOW_UP, createdAt: 3, status: "queued" })]);
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:send") return { ok: true, data: { conversation: sent, delivery: null } };
      if (channel === "assist:open") return { ok: true, data: { conversation: sent } };
      return fallback(channel, payload);
    }) as never;
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "approve the renewal" });

    act(() => {
      fireEvent.change(box(), { target: { value: FOLLOW_UP } });
    });
    act(() => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await screen.findAllByText(FOLLOW_UP);
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "approve the renewal" });
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(box()).not.toHaveAttribute("placeholder", "approve the renewal");
  });

  it("is not drawn over answers the reply offers as buttons", async () => {
    conversation = answered([message({ id: "e1", authorType: "engine", authorName: "EO", body: "Testing stopped.\n\nKeep going?", runId: "run-0", createdAt: 3, canAnswer: true, options: ["Keep going", "Discard"] })]);
    open();
    await screen.findByText("Keep going?");
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "keep going" });
    expect(box()).not.toHaveAttribute("placeholder", "keep going");
  });

  it("does not come back once the person answers the reply's buttons", async () => {
    conversation = answered([message({ id: "e1", authorType: "engine", authorName: "EO", body: "Testing stopped.\n\nKeep going?", runId: "run-0", createdAt: 3, canAnswer: true, options: ["Keep going", "Discard"] })]);
    open();
    await screen.findByText("Keep going?");
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "keep going" });

    // The pick is a reply under the buttons' message, and the refetch
    // after it no longer offers them: nothing newer by the person at the
    // top level, and no buttons in the way.
    const fallback = window.eo.ipc.invoke as (channel: string, payload?: unknown) => Promise<unknown>;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "comments:post") {
        conversation = answered([
          message({ id: "e1", authorType: "engine", authorName: "EO", body: "Testing stopped.\n\nKeep going?", runId: "run-0", createdAt: 3, canAnswer: false, options: ["Keep going", "Discard"] }),
          message({ id: "h3", authorType: "human", authorName: "You", body: "Keep going", parentId: "e1", createdAt: 4 }),
        ]);
        return { ok: true, data: {} };
      }
      return fallback(channel, payload);
    }) as never;
    fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard" })).toBeNull());

    expect(box()).not.toHaveAttribute("placeholder", "keep going");
  });

  it("is not drawn over a question card waiting to be answered", async () => {
    conversation = answered([message({ id: "q1", body: "Which board?", kind: "question", runId: "run-0", createdAt: 3, canAnswer: true, options: [] })]);
    open();
    await screen.findByText("Which board?", { exact: false });
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "the Delivery board" });
    expect(box()).not.toHaveAttribute("placeholder", "the Delivery board");
  });
});

/**
 * What the person did with a suggested reply that was shown (EO-895):
 * reported over `assist:suggestionUsed`, each action once per suggestion.
 */
describe("what the person did with a suggested reply", () => {
  function answered(extra: Record<string, unknown>[] = []) {
    return {
      ...running(),
      thinking: false,
      thinkingSince: null,
      liveTurn: null,
      messages: [message({ id: "h1", authorType: "human", authorName: "You", body: ASKED, createdAt: 1 }), message({ id: "a1", body: ANSWERED, runId: "run-0", createdAt: 2 }), ...extra],
    } as unknown as ReturnType<typeof running>;
  }

  const box = () => screen.getByLabelText("Message the assistant");
  const SUGGESTED = "approve the renewal";

  /** The chat with a suggestion drawn in its box, every `assist:suggestionUsed` it reports, and what it sends. */
  async function shown() {
    conversation = answered();
    const view = open();
    await screen.findByText("Contoso renewal", { exact: false });
    const uses: unknown[] = [];
    const sends: unknown[] = [];
    const fallback = window.eo.ipc.invoke as (channel: string, payload?: unknown) => Promise<unknown>;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === "assist:suggestionUsed") {
        uses.push(payload);
        return { ok: true, data: { recorded: true } };
      }
      if (channel === "assist:send") {
        sends.push(payload);
        return { ok: true, data: { conversation: answered([message({ id: "h2", authorType: "human", authorName: "You", body: (payload as { body: string }).body, createdAt: 3, status: "queued" })]), delivery: null } };
      }
      return fallback(channel, payload);
    }) as never;
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: SUGGESTED });
    expect(box()).toHaveAttribute("placeholder", SUGGESTED);
    return { view, uses, sends };
  }

  const of = (action: string, extra: Record<string, unknown> = {}) => ({ conversationId: CHAT, runId: "run-0", action, ...extra });

  it("reports shown once however often the box is drawn again", async () => {
    const { view, uses } = await shown();
    // Drawn again: a refetch, a pushed word for another run, a redraw of the whole room.
    push("runs:changed", { runId: "run-9", itemId: "another-chat", status: "running" });
    view.rerender(<ChatConversation narrow={false} />);
    view.rerender(<ChatConversation narrow={false} />);
    expect(box()).toHaveAttribute("placeholder", SUGGESTED);
    expect(uses).toEqual([of("shown")]);
  });

  it.each(["Tab", "ArrowRight"])("reports %s as accepted, and the accepted text sent unchanged as sent from it, unedited", async (key) => {
    const { uses, sends } = await shown();
    act(() => {
      fireEvent.keyDown(box(), { key });
    });
    expect(box()).toHaveValue(SUGGESTED);
    act(() => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(uses).toEqual([of("shown"), of("accepted"), of("sent", { edited: false })]);
  });

  it("reports an accepted suggestion changed before it was sent as sent from it, edited", async () => {
    const { uses, sends } = await shown();
    act(() => {
      fireEvent.keyDown(box(), { key: "Tab" });
    });
    act(() => {
      fireEvent.change(box(), { target: { value: `${SUGGESTED} and the invoices` } });
    });
    act(() => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(uses).toEqual([of("shown"), of("accepted"), of("sent", { edited: true })]);
  });

  it("reports a suggestion typed over as dismissed, and nothing accepted or sent from it", async () => {
    const { uses, sends } = await shown();
    act(() => {
      fireEvent.change(box(), { target: { value: FOLLOW_UP } });
    });
    act(() => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(uses).toEqual([of("shown"), of("dismissed", { by: "typed_over" })]);
  });

  it("reports a suggestion a newer run in the chat took away as dismissed, and no accepted", async () => {
    const { uses } = await shown();
    push("runs:changed", { runId: "run-1", itemId: CHAT, status: "running" });
    expect(box()).not.toHaveAttribute("placeholder", SUGGESTED);
    act(() => {
      fireEvent.keyDown(box(), { key: "Tab" });
    });
    expect(uses).toEqual([of("shown"), of("dismissed", { by: "newer_turn" })]);
  });

  it("reports a suggestion shown in a chat the person left as dismissed", async () => {
    const { view, uses } = await shown();
    view.unmount();
    expect(uses).toEqual([of("shown"), of("dismissed", { by: "left" })]);
  });

  it("reports nothing of a suggestion that was never shown", async () => {
    conversation = answered([message({ id: "q1", body: "Which board?", kind: "question", runId: "run-0", createdAt: 3, canAnswer: true, options: [] })]);
    const view = open();
    await screen.findByText("Which board?", { exact: false });
    const invoke = window.eo.ipc.invoke as ReturnType<typeof vi.fn>;
    push("assist:suggestion", { conversationId: CHAT, runId: "run-0", text: "the Delivery board" });
    push("runs:changed", { runId: "run-1", itemId: CHAT, status: "running" });
    view.unmount();
    expect(invoke.mock.calls.filter(([channel]) => channel === "assist:suggestionUsed")).toEqual([]);
  });
});

describe("a reply's work proposals in the conversation (EO-864)", () => {
  const proposal = (id: string, runId: string, createdAt: number) =>
    message({
      id,
      runId,
      createdAt,
      kind: "decision",
      body: `The prose of ${id}.`,
      canApprove: true,
      approves: "items",
      proposal: { container: null, rows: [{ kind: "new", title: `Work of ${id}`, typeLabel: "Story", acceptanceCriteria: [], waitsOn: [], under: null }], closed: null },
    });

  it("draws each reply's proposals as its own block, and one reply's single proposal as the card alone", async () => {
    conversation = {
      ...running(),
      thinking: false,
      liveTurn: null as never,
      messages: [
        message({ id: "h1", authorType: "human", authorName: "You", body: ASKED, createdAt: 1 }),
        proposal("a1", "run-a", 2),
        proposal("a2", "run-a", 3),
        message({ id: "h2", authorType: "human", authorName: "You", body: FOLLOW_UP, createdAt: 4 }),
        proposal("b1", "run-b", 5),
        proposal("b2", "run-b", 6),
        proposal("b3", "run-b", 7),
        message({ id: "h3", authorType: "human", authorName: "You", body: "One more", createdAt: 8 }),
        proposal("c1", "run-c", 9),
      ],
    };
    open();

    await waitFor(() => expect(screen.getAllByRole("group", { name: "Proposals from the assistant" })).toHaveLength(2));
    const [first, second] = screen.getAllByRole("group", { name: "Proposals from the assistant" });
    expect(within(first!).getByText("1 of 2")).toBeInTheDocument();
    expect(within(second!).getByText("1 of 3")).toBeInTheDocument();
    // The single proposal is the card alone, outside any block.
    const alone = screen.getByRole("link", { name: /Work of c1/ });
    expect(alone.closest('[role="group"]')).toBeNull();
  });
});
