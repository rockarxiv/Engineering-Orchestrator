import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RunEventView, RunView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { groupRuns } from "../../../shared/transcript/grouping";
import { RunDetails, RunHeader, Transcript } from "./Transcript";
import { TranscriptEvent } from "./TranscriptEvent";

/**
 * The chat layout's transcript, held to the classic one
 * (`transcript/Transcript.test.tsx` is the model). The log is virtualised;
 * jsdom does no layout, so the list is drawn flat here to read its rows.
 */
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function FlatList(
      props: { data?: unknown[]; itemContent: (index: number, item: unknown) => ReactNode; computeItemKey?: (index: number, item: unknown) => string },
      ref: React.Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
      return (
        <div>
          {(props.data ?? []).map((item, index) => (
            <div key={props.computeItemKey ? props.computeItemKey(index, item) : index}>{props.itemContent(index, item)}</div>
          ))}
        </div>
      );
    }),
  };
});

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "r1",
    agentId: "a1",
    agentName: "Implementer",
    action: "implement",
    actionName: overrides.action ?? "implement",
    status: "running",
    attempt: 1,
    threadId: null,
    error: null,
    tokensIn: null,
    tokensOut: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    turns: null,
    turnsScope: null,
    costCents: null,
    startedAt: Date.now() - 65_000,
    endedAt: null,
    verificationOk: null,
    checks: [],
    steerable: true,
    ...overrides,
  };
}

const solo = (overrides: Partial<RunView> = {}) => groupRuns([run(overrides)])[0]!;

function event(seq: number, type = "output", payload: unknown = { text: `line ${seq}` }): RunEventView {
  return { seq, ts: 1000 + seq, type, payload };
}

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function wrap(children: ReactNode) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ItemReferenceProvider>{children}</ItemReferenceProvider>
          <CurrentRoute />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

/** One client per test: `mount` makes it, and a `rerender(wrap(...))` in the same test keeps it. */
let client = createQueryClient();

function mount(children: ReactNode) {
  client = createQueryClient();
  return render(wrap(children));
}

function mockLog(events: RunEventView[], extra: (channel: string, payload: unknown) => unknown = () => undefined) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const answer = extra(channel, payload);
    if (answer !== undefined) return answer;
    if (channel === "runs:listEvents") return { ok: true, data: { events, nextSeq: null } };
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
    if (channel === "items:list") return { ok: true, data: { items: [{ id: "t2", key: "EO-2" }] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "agents:list") return { ok: true, data: { agents: [{ id: "a1", name: "Implementer", role: "implementer", archivedAt: null }] } };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return calls;
}

describe("TranscriptEvent", () => {
  it("renders each kind distinctly", () => {
    mockLog([]);
    const { rerender } = mount(<TranscriptEvent event={event(1, "output", { text: "hello world" })} />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
    rerender(wrap(<TranscriptEvent event={event(2, "file_edit", { path: "src/a.ts" })} />));
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    rerender(wrap(<TranscriptEvent event={event(3, "usage", { tokensIn: 120, tokensOut: 40 })} />));
    expect(screen.getByText("120 in / 40 out")).toBeInTheDocument();
    rerender(wrap(<TranscriptEvent event={event(4, "error", { message: "it broke" })} />));
    expect(screen.getByText("it broke")).toBeInTheDocument();
    rerender(wrap(<TranscriptEvent event={event(5, "quota", { provider: "claude", window: "seven_day_opus", utilization: 83, status: "allowed_warning" })} />));
    expect(screen.getByText(/claude seven_day_opus: 83% used/)).toBeInTheDocument();
  });

  it("shows a mid-run outcome payload as the progress it is, not as a branch", () => {
    const text = JSON.stringify({ outcome: { branch: "in_progress", summary: "...starting...", files_changed: [], tests_run: false, handoff: "Work in progress." } });
    render(<TranscriptEvent event={event(3, "output", { text })} />);
    expect(screen.getByText(/\.\.\.starting\.\.\./)).toBeInTheDocument();
    expect(screen.queryByText(/in_progress/)).not.toBeInTheDocument();
  });

  it("shows what a person said mid-run, and whether the agent got it", () => {
    mockLog([]);
    const { rerender } = mount(<TranscriptEvent event={event(5, "human_message", { body: "Use the middleware.", delivered: true })} />);
    expect(screen.getByText(/You said, mid-turn:/)).toBeInTheDocument();
    rerender(wrap(<TranscriptEvent event={event(6, "human_message", { body: "Check the retry maths.", delivered: false })} />));
    expect(screen.getByText(/queued for the next turn/)).toBeInTheDocument();
  });

  it("shows a wind-down as an aside rather than a failure", () => {
    mockLog([]);
    mount(<TranscriptEvent event={event(7, "wind_down", { message: "Claude run ended: error_during_execution" })} />);
    expect(screen.getByText(/Ended here to wait for a reply/)).toBeInTheDocument();
    expect(screen.getByText(/error_during_execution/)).toBeInTheDocument();
  });

  it("links item keys in errors, and leaves unknown keys plain", async () => {
    mockLog([]);
    mount(<TranscriptEvent event={event(8, "error", { message: "EO-2 failed after GONE-9" })} />);

    const link = await screen.findByRole("link", { name: "EO-2" });
    expect(link).toHaveAttribute("href", "/items/t2");
    expect(screen.queryByRole("link", { name: "GONE-9" })).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t2");
  });

  it("keeps a tool's arguments and answer collapsed until asked for", () => {
    const { rerender } = render(<TranscriptEvent event={event(5, "tool_call", { name: "comment", args: { body: "a long argument" } })} />);
    expect(screen.queryByText(/a long argument/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /comment/ }));
    expect(screen.getByText(/a long argument/)).toBeInTheDocument();

    rerender(<TranscriptEvent key="result" event={event(6, "tool_result", { name: "Bash", ok: false, output: "1 failed", exitCode: 1 })} />);
    expect(screen.getByText(/exit 1/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Bash returned/ }));
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it("shows the agent being redirected, with what it was told one click away", () => {
    render(<TranscriptEvent event={event(10, "search_interception", { kind: "symbol", needle: "transitionItem", suggestion: "Use `idx_symbol`." })} />);
    expect(screen.queryByText(/idx_symbol/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /transitionItem/ }));
    expect(screen.getByText(/idx_symbol/)).toBeInTheDocument();
  });

  it("says which skills a run was given and which it loaded (EO-715)", () => {
    render(<TranscriptEvent event={event(11, "skills_delivered", { type: "skills_delivered", skillIds: ["s-1", "s-2"], slugs: ["house-style", "review"] })} />);
    expect(screen.getByText(/Given the skills/)).toHaveTextContent("Given the skills house-style, review");
    render(<TranscriptEvent event={event(12, "skill_loaded", { type: "skill_loaded", skillId: "s-1", slug: "house-style" })} />);
    expect(screen.getByText(/Loaded the skill/)).toHaveTextContent("Loaded the skill house-style");
  });

  it("shows an unrecognised event rather than swallowing it", () => {
    render(<TranscriptEvent event={event(6, "some_future_kind", { detail: "surprise" })} />);
    expect(screen.getByText(/some_future_kind/)).toBeInTheDocument();
    expect(screen.getByText(/surprise/)).toBeInTheDocument();
  });
});

describe("RunHeader", () => {
  it("reports the facts from the runs row", () => {
    render(<RunHeader group={solo({ status: "succeeded", attempt: 2, tokensIn: 1500, tokensOut: 300, costCents: 250, endedAt: Date.now() })} />);
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("attempt 2")).toBeInTheDocument();
    expect(screen.getByText("1.5k in / 300 out")).toBeInTheDocument();
    expect(screen.getByText("2.50 USD")).toBeInTheDocument();
  });

  it("names a module run by the module, not its id", () => {
    render(<RunHeader group={solo({ agentId: null, agentName: "EO", action: "019a0000-0000-7000-8000-000000000001", actionName: "Deploy to staging" })} />);

    expect(screen.getByText("Deploy to staging")).toBeInTheDocument();
    expect(screen.queryByText(/019a0000/)).not.toBeInTheDocument();
  });

  it("says the cached share and model turns, and nothing when they are unknown", () => {
    const { rerender } = render(<RunHeader group={solo({ tokensIn: 1_200_000, tokensOut: 8_400, cacheReadTokens: 1_080_000, turns: 27 })} />);
    expect(screen.getByText("1.2M in / 8.4k out · 90% cached · 27 model turns")).toBeInTheDocument();
    rerender(<RunHeader group={solo({ tokensIn: 1500, tokensOut: 300 })} />);
    expect(screen.queryByText(/cached/)).not.toBeInTheDocument();
    expect(screen.queryByText(/USD/)).not.toBeInTheDocument();
  });

  it("offers cancel only while the run is active", () => {
    const { rerender } = render(<RunHeader group={solo({ status: "running" })} onCancel={() => {}} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    rerender(<RunHeader group={solo({ status: "succeeded" })} onCancel={() => {}} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("keeps counting while the run is live", async () => {
    vi.useFakeTimers();
    try {
      render(<RunHeader group={solo({ status: "running", startedAt: Date.now() - 10_000, endedAt: null })} />);
      expect(screen.getByText("10s")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByText("15s")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a resumed run as one conversation, counting working time only", () => {
    const group = groupRuns([
      run({ id: "r1", threadId: "th-1", attempt: 1, status: "awaiting_input", tokensIn: 100, tokensOut: 10, costCents: 40, startedAt: 1_000, endedAt: 4_000 }),
      run({ id: "r2", threadId: "th-1", attempt: 2, status: "succeeded", tokensIn: 250, tokensOut: 30, costCents: 60, startedAt: 9_000, endedAt: 11_000 }),
    ])[0]!;
    render(<RunHeader group={group} />);
    expect(screen.getByText("2 turns")).toBeInTheDocument();
    expect(screen.getByText("350 in / 40 out")).toBeInTheDocument();
    expect(screen.getByText("1.00 USD")).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
  });
});

describe("Transcript", () => {
  it("draws what the agent said, and folds what it did behind one line", async () => {
    mockLog([event(0, "output", { text: "Reading the invoice." }), event(1, "tool_call", { name: "Read", args: {} }), event(2, "tool_call", { name: "Grep", args: {} }), event(3, "output", { text: "Done." })]);
    mount(<Transcript group={solo({ status: "succeeded" })} />);

    expect(await screen.findByText("Reading the invoice.")).toBeInTheDocument();
    const fold = screen.getByRole("button", { name: "2 tool calls" });
    expect(screen.queryByText("Grep")).not.toBeInTheDocument();
    fireEvent.click(fold);
    expect(screen.getByText("Grep")).toBeInTheDocument();
  });

  it("shows why a run stopped, a parked run as a question rather than a failure", async () => {
    mockLog([]);
    mount(<Transcript group={solo({ status: "awaiting_input", error: "EO-31 and EO-32 are both still open." })} />);
    const shown = await screen.findByText(/both still open/);
    expect(shown.closest("[data-tone]")).toHaveAttribute("data-tone", "paused");
  });

  it("says nothing about stopping when the run recorded nothing", async () => {
    mockLog([event(0)]);
    mount(<Transcript group={solo({ status: "succeeded" })} />);
    await screen.findByText("line 0");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("links item keys in a transcript-loading error", async () => {
    mockLog([], (channel) => (channel === "runs:listEvents" ? { ok: false, error: { message: "Could not load EO-2" } } : undefined));
    mount(<Transcript group={solo({ status: "failed" })} />);
    expect(await screen.findByRole("link", { name: "EO-2" })).toHaveAttribute("href", "/items/t2");
  });

  it("cancels the run through the engine", async () => {
    const calls = mockLog([event(0)], (channel) => (channel === "runs:cancel" ? { ok: true, data: { cancelled: true } } : undefined));
    mount(<Transcript group={solo({ status: "running" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls.some((call) => call.channel === "runs:cancel")).toBe(true));
  });

  it("takes a message into the running turn, from the page you watch it on (EO-176)", async () => {
    const calls = mockLog([event(0)], (channel) =>
      channel === "comments:post" ? { ok: true, data: { commentId: "c1", resumedRun: false, delivery: { requested: "now", outcome: "now", note: null } } } : undefined,
    );
    mount(<Transcript group={solo({ status: "running" })} itemId="t1" />);

    fireEvent.change(await screen.findByLabelText("Write a comment"), { target: { value: "Use the middleware." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((call) => call.channel === "comments:post")?.payload).toMatchObject({ itemId: "t1", body: "Use the middleware.", delivery: "now" }));
    expect(calls.some((call) => call.channel === "runs:cancel")).toBe(false);
  });

  it("offers no box on a run that has finished", async () => {
    mockLog([event(0)]);
    mount(<Transcript group={solo({ status: "succeeded" })} itemId="t1" />);
    await screen.findByText("line 0");
    expect(screen.queryByLabelText("Write a comment")).not.toBeInTheDocument();
  });
});

describe("a step's transcript while its run is going", () => {
  const liveTurn = (text: string) => ({
    ok: true,
    data: { turn: { runId: "r1", startedAt: 0, steps: [], drafts: [{ id: 1, stream: "text", text }], lastDraftId: 1, answer: "" } },
  });

  it("draws the agent's words as they are written, below what it has done", async () => {
    mockLog([event(1, "thread_started", { threadId: "th" })], (channel) =>
      channel === "runs:live" ? liveTurn("Reading the rate limiter to see where the window resets.") : undefined,
    );
    mount(<Transcript group={solo({ status: "running" })} itemId="t1" />);
    expect(await screen.findByLabelText("Live agent output")).toHaveTextContent("Reading the rate limiter to see where the window resets.");
  });

  it("does not draw a structured result as it is written: its fields are shown when it lands", async () => {
    const calls = mockLog([event(1, "thread_started", { threadId: "th" })], (channel) =>
      channel === "runs:live" ? liveTurn('{"outcome": {"branch": "eo/EO-1", "summary": "Added the li') : undefined,
    );
    mount(<Transcript group={solo({ status: "running" })} itemId="t1" />);
    await waitFor(() => expect(calls.some((call) => call.channel === "runs:live")).toBe(true));
    // Past the answer landing and being drawn, not only past the request.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.queryByLabelText("Live agent output")).toBeNull();
  });

  it("asks for nothing live once the run has finished", async () => {
    const calls = mockLog([event(0)]);
    mount(<Transcript group={solo({ status: "succeeded" })} itemId="t1" />);
    await screen.findByText("line 0");
    expect(calls.some((call) => call.channel === "runs:live")).toBe(false);
    expect(screen.queryByLabelText("Live agent output")).toBeNull();
  });
});

describe("RunDetails", () => {
  it("reports the engine's verdict, the files changed and every session", async () => {
    mockLog([event(0, "file_edit", { path: "src/a.ts" }), event(1, "file_edit", { path: "src/a.ts" })]);
    mount(<RunDetails group={solo({ status: "succeeded", verificationOk: false, threadId: "sess_01J2" })} />);

    const details = screen.getByRole("complementary", { name: "Run details" });
    expect(within(details).getByText("Checks failed")).toBeInTheDocument();
    expect(await within(details).findByText("src/a.ts")).toBeInTheDocument();
    expect(within(details).getByRole("region", { name: "Changes (1)" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Sessions" })).getByText("sess_01J2")).toBeInTheDocument();
  });

  it("says so plainly when nothing verified the run, and nothing has a session", () => {
    mockLog([]);
    mount(<RunDetails group={solo({ verificationOk: null })} />);
    expect(screen.getByText("Not verified.")).toBeInTheDocument();
    expect(screen.getByText("No session yet.")).toBeInTheDocument();
  });
});
