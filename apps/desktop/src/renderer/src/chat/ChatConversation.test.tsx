import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Markdown, MarkdownProps } from "@eo/ui";
import { createQueryClient } from "../query/client";
import { resetLiveDeltas } from "../shared/assist/liveDeltas";
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
