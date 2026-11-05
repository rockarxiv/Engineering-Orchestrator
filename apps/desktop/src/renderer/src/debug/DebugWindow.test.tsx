import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEBUG_SENT_EVENT, type DebugAgent, type DebugRun, type DebugSent, type RunEventView } from "@eo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../query/client";
import { DebugWindow } from "./DebugWindow";
import { debugBridge } from "./testing";

// The transcript's log is virtualised, and a virtual list measures a
// viewport jsdom does not have — it would render no rows at all. Every
// row is drawn instead, through the same `itemContent` the real list
// calls, so what is on screen here is the transcript's own components.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => (
    <div data-testid="log">
      {data.map((item, index) => (
        <div key={index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

/**
 * The debug window (EO-392).
 *
 * Rendered against a stand-in main process that serves `debug:runs`
 * and pages `runs:listEvents` exactly as the real handlers do, so the
 * window is exercised the way it runs: one log per run, split into what
 * was sent and what the agent did.
 */

const SECRET = "ghp_window_secret_value";

function run(overrides: Partial<DebugRun> = {}): DebugRun {
  return {
    id: "r1",
    agentId: "a-impl",
    agentName: "Implementer",
    action: "implement",
    actionName: overrides.action ?? "implement",
    status: "succeeded",
    attempt: 1,
    threadId: "thread-1",
    error: null,
    tokensIn: 12_400,
    tokensOut: 800,
    cacheReadTokens: 6_200,
    cacheWriteTokens: null,
    turns: 4,
    turnsScope: "turn",
    costCents: 37,
    startedAt: Date.UTC(2026, 9, 10, 9, 0),
    endedAt: Date.UTC(2026, 9, 10, 9, 2),
    verificationOk: null,
    checks: [],
    steerable: true,
    itemId: "i1",
    itemKey: "EO-1",
    itemTitle: "Add a limiter",
    provider: "claude",
    cwd: "/tmp/wt/EO-1",
    ...overrides,
  };
}

function sent(overrides: Partial<DebugSent> = {}): DebugSent {
  return {
    purpose: "dispatch",
    thread: { mode: "new", threadId: null, refusal: null },
    instructions: { sent: true, text: "You are the implementer.\n  Indentation and «marks» kept." },
    prompt: "EO-1: do the thing\n\n## Acceptance criteria\n- one",
    session: {
      backend: "claude",
      described: true,
      instructionsSlot: "systemPrompt",
      model: "claude-test-model",
      reasoningEffort: "high",
      cwd: "/tmp/wt/EO-1",
      policy: [{ name: "permissionMode", value: "bypassPermissions" }],
      outputSchema: "implement",
      mcpServers: ["repo", "eo", "github"],
      allowedTools: ["Read", "mcp__eo__comment"],
      skills: ["deep-review"],
      inheritsAmbientConfig: false,
      attachments: [],
    },
    ...overrides,
  };
}

const event = (seq: number, type: string, payload: unknown): RunEventView => ({ seq, ts: 1_000 + seq, type, payload });

function agent(overrides: Partial<DebugAgent> = {}): DebugAgent {
  const runs = overrides.runs ?? [run()];
  return { agentId: "a-impl", name: "Implementer", role: "implementer", provider: "claude", live: false, totalRuns: runs.length, ...overrides, runs };
}

function mount(agents: DebugAgent[] | (() => DebugAgent[]), logs: Record<string, RunEventView[]>, mode = true) {
  const bridge = debugBridge({
    "debug:getMode": () => ({ enabled: mode }),
    // A fresh answer each time it is asked, as main gives: the same
    // array handed back twice would be "nothing changed" to the cache.
    "debug:runs": () => ({ agents: typeof agents === "function" ? agents() : agents }),
    "runs:listEvents": (payload) => {
      const { runId, fromSeq = 0 } = payload as { runId: string; fromSeq?: number };
      return { events: (logs[runId] ?? []).filter((entry) => entry.seq >= fromSeq), nextSeq: null };
    },
  });
  window.eo = bridge.eo;
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        {/* No router and no item catalogue, because the real window has
            neither: `App.tsx` draws this in place of the routed tree. */}
        <DebugWindow />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...bridge, logs, unmount: view.unmount };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the tabs", () => {
  it("draws one tab per agent, in the order it is given them — live agents first", async () => {
    mount(
      [
        agent({ agentId: "a-sys", name: "Assistant", role: "system", live: true, runs: [run({ id: "r9", agentId: "a-sys", status: "running", action: "assist" })] }),
        agent(),
      ],
      {},
    );

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Assistantrunning1", "Implementer1"]);
    // The first tab is the open one: the agent working right now.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("lists the selected agent's runs newest first, and switches agent on a click", async () => {
    mount(
      [
        agent({ runs: [run({ id: "r2", action: "refine", itemKey: "EO-2" }), run({ id: "r1" })] }),
        agent({ agentId: "a-rev", name: "Reviewer", role: "reviewer", runs: [run({ id: "r3", agentId: "a-rev", action: "review", itemKey: "EO-3" })] }),
      ],
      {},
    );

    const runs = within(await screen.findByRole("navigation", { name: "Runs" }));
    expect(runs.getAllByRole("button").map((button) => button.textContent)).toEqual([expect.stringContaining("refine"), expect.stringContaining("implement")]);

    fireEvent.click(screen.getByRole("tab", { name: /Reviewer/ }));
    expect(within(screen.getByRole("navigation", { name: "Runs" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Runs" })).toHaveTextContent("EO-3");
  });

  it("says how many older runs a bounded tab is not listing, and counts them all on the tab", async () => {
    mount([agent({ totalRuns: 73, runs: [run({ id: "r2" }), run({ id: "r1" })] })], {});

    expect(await screen.findByRole("tab", { name: /Implementer/ })).toHaveTextContent("73");
    expect(screen.getByRole("navigation", { name: "Runs" })).toHaveTextContent("71 older runs are not listed here.");
  });

  it("shows the project the board was switched to, without being reopened", async () => {
    // `projects:setActive` says `config:changed` and nothing else, so
    // that is the push an open window has to hear.
    let served: DebugAgent[] = [agent()];
    const bridge = mount(() => served, {});
    expect(await screen.findByRole("tab", { name: /Implementer/ })).toBeInTheDocument();

    served = [agent({ agentId: "a-rev", name: "Reviewer", role: "reviewer", runs: [run({ id: "r7", agentId: "a-rev", action: "review", itemKey: "OTHER-4" })] })];
    act(() => bridge.push("config:changed"));

    expect(await screen.findByRole("tab", { name: /Reviewer/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Implementer/ })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Runs" })).toHaveTextContent("OTHER-4");
  });

  it("says no run has been recorded, and how one comes to be, when main lists none", async () => {
    mount([], {});
    expect(await screen.findByText("No run in this project has been recorded. Runs started while debug mode is on appear here.")).toBeInTheDocument();
    expect(screen.queryByText("No agent has run in this project yet.")).not.toBeInTheDocument();
  });

  it("shows a run, and its agent's tab, once its first send is recorded — without being reopened", async () => {
    // Main lists recorded runs only (EO-394), so a run dispatched with
    // debug mode on is not in the answer until its `debug_sent` row is
    // written — and the supervisor says `runs:progress` as it writes it.
    let served: DebugAgent[] = [];
    const bridge = mount(() => served, { r1: [event(0, DEBUG_SENT_EVENT, sent())] });
    expect(await screen.findByText(/No run in this project has been recorded\./)).toBeInTheDocument();

    served = [agent({ live: true, runs: [run({ status: "running", endedAt: null })] })];
    act(() => bridge.push("runs:progress", { runId: "r1" }));

    expect(await screen.findByRole("tab", { name: /Implementer/ })).toHaveTextContent("Implementerrunning1");
    expect(screen.getByRole("navigation", { name: "Runs" })).toHaveTextContent("EO-1");
    expect(await screen.findByText("Started a new provider thread.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/No run in this project has been recorded\./)).not.toBeInTheDocument();
  });
});

describe("what was sent", () => {
  it("shows the instructions and the prompt verbatim, each with a copy button", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const record = sent();
    mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, record), event(1, "output", { text: "working" })] });

    const section = within(await screen.findByRole("region", { name: "What was sent" }));
    // Whitespace and all: the text node is the recorded string.
    const blocks = await waitFor(() => {
      const found = section.getAllByText((_text, node) => node?.tagName === "PRE");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(blocks[0]?.textContent).toBe(record.instructions.text);
    expect(blocks[1]?.textContent).toBe(record.prompt);

    fireEvent.click(section.getByRole("button", { name: "Copy instructions" }));
    fireEvent.click(section.getByRole("button", { name: "Copy prompt" }));
    expect(writeText.mock.calls.map((call) => call[0])).toEqual([record.instructions.text, record.prompt]);
    expect(section.getByRole("button", { name: "Copy session" })).toBeInTheDocument();
  });

  it("cancels a copy button's reset when the window goes, rather than setting state after it", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async (_text: string) => {}) }, configurable: true });
    const setTimer = vi.spyOn(window, "setTimeout");
    const clearTimer = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent())] });
      const section = within(await screen.findByRole("region", { name: "What was sent" }));
      fireEvent.click(await section.findByRole("button", { name: "Copy prompt" }));
      expect(section.getByRole("button", { name: "Copy prompt" })).toHaveTextContent("Copied");

      const index = setTimer.mock.calls.findIndex((call) => call[1] === 1500);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = setTimer.mock.results[index]?.value as unknown;
      unmount();
      expect(clearTimer).toHaveBeenCalledWith(timer);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  it("says a fresh thread is one, with the id the backend then issued", async () => {
    mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent())] });

    const section = within(await screen.findByRole("region", { name: "What was sent" }));
    expect(await section.findByText("Started a new provider thread.", { exact: false })).toHaveTextContent("Thread id: thread-1");
    expect(section.getByText("The full assembled context.")).toBeInTheDocument();
    expect(section.getByText(/Sent as the thread's instructions \(systemPrompt\)\./)).toBeInTheDocument();
  });

  it("says a resumed thread is one, names it, and shows the follow-up with the instructions the thread kept", async () => {
    mount([agent()], {
      r1: [
        event(
          0,
          DEBUG_SENT_EVENT,
          sent({ thread: { mode: "resumed", threadId: "thread-7", refusal: null }, instructions: { sent: false, text: "You are the implementer." }, prompt: "And the free tier?" }),
        ),
      ],
    });

    const section = within(await screen.findByRole("region", { name: "What was sent" }));
    expect(await section.findByText("Resumed an existing provider thread.", { exact: false })).toHaveTextContent("Thread id: thread-7");
    expect(section.getByText("Not sent on this turn. A resumed thread keeps the instructions it was started with, which are these.")).toBeInTheDocument();
    expect(section.getByText("You are the implementer.")).toBeInTheDocument();
    expect(section.getByText("The follow-up only: the thread already holds everything before it.")).toBeInTheDocument();
    expect(section.getByText("And the free tier?")).toBeInTheDocument();
  });

  it("says so when a resumed thread's instructions can no longer be shown", async () => {
    mount([agent()], {
      r1: [event(0, DEBUG_SENT_EVENT, sent({ thread: { mode: "resumed", threadId: "thread-7", refusal: null }, instructions: { sent: false, text: null }, prompt: "Carry on." }))],
    });

    expect(await screen.findByText(/EO\s+can no longer show those/)).toBeInTheDocument();
  });

  it("shows why an earlier thread was not reused", async () => {
    mount([agent()], {
      r1: [event(0, DEBUG_SENT_EVENT, sent({ thread: { mode: "new", threadId: null, refusal: "Implementer's instructions have changed since its last run." } }))],
    });

    const refusal = await screen.findByText("An earlier thread was not reused:", { exact: false });
    expect(refusal).toHaveTextContent("Implementer's instructions have changed since its last run.");
  });

  it("names the session — backend, model, effort, directory, policy, servers, tools and skills", async () => {
    mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent())] });

    const section = await screen.findByRole("region", { name: "What was sent" });
    await within(section).findByText("Session");
    for (const [name, value] of [
      ["Backend", "claude"],
      ["Model", "claude-test-model — named by EO; the backend has not reported its own"],
      ["Reasoning effort", "high"],
      ["Working directory", "/tmp/wt/EO-1"],
      ["permissionMode", "bypassPermissions"],
      ["Output schema", "implement"],
      ["MCP servers", "repo, eo, github"],
      ["Tool allowlist", "Read, mcp__eo__comment"],
      ["Skills", "deep-review"],
    ] as const) {
      expect(within(section).getByText(name).nextElementSibling).toHaveTextContent(value);
    }
  });

  describe("the model that actually ran", () => {
    const unnamed = () => sent({ session: { ...sent().session, model: null } });
    const modelOf = async () => within(await screen.findByRole("region", { name: "What was sent" })).findByText("Model");

    it("names the backend's default once the backend reports it, for an agent with no model configured", async () => {
      mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, unnamed()), event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "claude-default-9" })] });

      await waitFor(async () => expect((await modelOf()).nextElementSibling).toHaveTextContent("claude-default-9 — the backend's default; EO named none"));
    });

    it("says it has not been reported yet rather than calling it a default, until the backend speaks", async () => {
      const bridge = mount([agent({ live: true, runs: [run({ status: "running", endedAt: null })] })], { r1: [event(0, DEBUG_SENT_EVENT, unnamed())] });
      expect((await modelOf()).nextElementSibling).toHaveTextContent("not reported by the backend yet — EO named none");

      // And then it does, mid-run.
      bridge.logs["r1"]!.push(event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "gpt-default-7" }));
      act(() => bridge.push("runs:progress", { runId: "r1" }));

      await waitFor(async () => expect((await modelOf()).nextElementSibling).toHaveTextContent("gpt-default-7 — the backend's default; EO named none"));
    });

    it("shows the backend's answer when it ran something other than what EO named", async () => {
      mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent()), event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "claude-other" })] });

      await waitFor(async () => expect((await modelOf()).nextElementSibling).toHaveTextContent("claude-other — reported by the backend; EO named claude-test-model"));
    });

    it("shows the model a rerouted turn ended on, not the one its thread opened on", async () => {
      // Codex's `model/rerouted`: the thread opens on one model and the
      // turn is moved to another, which the usage reading at its end names.
      mount([agent({ runs: [run({ provider: "codex" })] })], {
        r1: [
          event(0, DEBUG_SENT_EVENT, unnamed()),
          event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "gpt-opened" }),
          event(2, "output", { text: "working" }),
          event(3, "usage", { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 2, model: "gpt-rerouted" }),
        ],
      });

      await waitFor(async () =>
        expect((await modelOf()).nextElementSibling).toHaveTextContent("gpt-rerouted — the backend moved the turn here; the thread opened on gpt-opened, and EO named none"),
      );
    });

    it("shows the reroute arriving live, replacing the model the thread opened on", async () => {
      const bridge = mount([agent({ live: true, runs: [run({ status: "running", endedAt: null })] })], {
        r1: [event(0, DEBUG_SENT_EVENT, sent()), event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "claude-test-model" })],
      });
      await waitFor(async () => expect((await modelOf()).nextElementSibling).toHaveTextContent(/^claude-test-model$/));

      bridge.logs["r1"]!.push(event(2, "usage", { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 2, model: "other-model" }));
      act(() => bridge.push("runs:progress", { runId: "r1" }));

      await waitFor(async () =>
        expect((await modelOf()).nextElementSibling).toHaveTextContent("other-model — the backend moved the turn here; the thread opened on claude-test-model"),
      );
    });

    it("keeps one model's line plain when the turn ends on the model it opened on", async () => {
      mount([agent()], {
        r1: [
          event(0, DEBUG_SENT_EVENT, unnamed()),
          event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "gpt-same" }),
          event(2, "usage", { type: "usage", scope: "turn", tokensIn: 10, tokensOut: 2, model: "gpt-same" }),
        ],
      });

      await waitFor(async () => expect((await modelOf()).nextElementSibling).toHaveTextContent("gpt-same — the backend's default; EO named none"));
    });

    it("gives each send its own thread's report, a correction included", async () => {
      mount([agent()], {
        r1: [
          event(0, DEBUG_SENT_EVENT, unnamed()),
          event(1, "thread_started", { type: "thread_started", threadId: "thread-1", model: "model-a" }),
          event(2, DEBUG_SENT_EVENT, { ...unnamed(), purpose: "correction" }),
          event(3, "thread_started", { type: "thread_started", threadId: "thread-1", model: "model-b" }),
        ],
      });

      expect(await screen.findByRole("article", { name: "Send 1" })).toHaveTextContent("model-a — the backend's default");
      expect(screen.getByRole("article", { name: "Send 2" })).toHaveTextContent("model-b — the backend's default");
    });
  });

  it("shows every send of a run, a correction after the dispatch", async () => {
    mount([agent()], {
      r1: [
        event(0, DEBUG_SENT_EVENT, sent()),
        event(1, "output", { text: "first answer" }),
        event(2, DEBUG_SENT_EVENT, sent({ purpose: "correction", thread: { mode: "resumed", threadId: "thread-1", refusal: null }, instructions: { sent: false, text: null }, prompt: "Please return a corrected result." })),
      ],
    });

    expect(await screen.findByRole("article", { name: "Send 1" })).toHaveTextContent("Send 1 of 2");
    expect(screen.getByRole("article", { name: "Send 2" })).toHaveTextContent("Correction, inside the run");
    expect(screen.getByRole("article", { name: "Send 2" })).toHaveTextContent("Please return a corrected result.");
  });

  it("says a recorded send that does not parse could not be read, and still shows the run's activity", async () => {
    // Main lists only runs with a `debug_sent` row (EO-394), so this is
    // the one way a listed run has nothing in this column: the row is
    // there and is not a record this build can read.
    mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, { purpose: "dispatch", prompt: 7 }), event(1, "output", { text: "did the work anyway" })] });

    const section = within(await screen.findByRole("region", { name: "What was sent" }));
    expect(await section.findByText("The record of what was sent to this run could not be read.")).toBeInTheDocument();
    expect(section.queryByRole("article")).not.toBeInTheDocument();
    expect(await screen.findByText("did the work anyway")).toBeInTheDocument();
  });

  it("never says a run was not recorded: with a readable send or without one", async () => {
    mount(
      [agent({ runs: [run({ id: "r2", itemKey: "EO-2" }), run({ id: "r1" })] })],
      { r2: [event(0, DEBUG_SENT_EVENT, sent())], r1: [event(0, DEBUG_SENT_EVENT, "not a record")] },
    );

    await screen.findByText("Started a new provider thread.", { exact: false });
    expect(screen.queryByText(/Not recorded/)).not.toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("navigation", { name: "Runs" })).getAllByRole("button")[1]!);
    await screen.findByText("The record of what was sent to this run could not be read.");
    expect(screen.queryByText(/Not recorded/)).not.toBeInTheDocument();
    expect(screen.queryByText(/debug mode was off when this run started/)).not.toBeInTheDocument();
  });

  it("has no secret to show: a recorded send that names a server shows the name and nothing else", async () => {
    // What the capture records is names (`providerParity.test.ts` holds
    // both adapters to that against a server with a known secret). This
    // is the window's half: it draws the record's fields and has no
    // other source — it asks main for runs and events, never for a
    // server's configuration.
    const bridge = mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent())] });

    await screen.findByText("Session");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(new Set(bridge.calls.map((call) => call.channel))).toEqual(new Set(["debug:getMode", "debug:runs", "runs:listEvents"]));
    expect(screen.getByText("Names only. Server commands, environment values, headers and tokens are never recorded.")).toBeInTheDocument();
  });
});

describe("what the agent is doing", () => {
  it("draws the run's events with the transcript's own components, and leaves the record of the send out of them", async () => {
    mount([agent()], {
      r1: [event(0, DEBUG_SENT_EVENT, sent()), event(1, "output", { text: "Reading the limiter." }), event(2, "error", { message: "exit 1", retryable: false })],
    });

    const activity = within(await screen.findByRole("region", { name: "What the agent is doing" }));
    expect(await activity.findByText("Reading the limiter.")).toBeInTheDocument();
    expect(activity.getByText("exit 1")).toBeInTheDocument();
    // The send is the other column's, in full — not a line in this one.
    expect(activity.queryByText(/recorded by debug mode/)).not.toBeInTheDocument();
  });

  it("shows new activity as it is recorded, without the window being reloaded", async () => {
    const live = run({ status: "running", endedAt: null });
    const bridge = mount([agent({ live: true, runs: [live] })], { r1: [event(0, DEBUG_SENT_EVENT, sent()), event(1, "output", { text: "Starting." })] });

    const activity = within(await screen.findByRole("region", { name: "What the agent is doing" }));
    expect(await activity.findByText("Starting.")).toBeInTheDocument();
    expect(activity.getByText("live")).toBeInTheDocument();

    // The run goes on: main appends to the log and says "there is more".
    bridge.logs["r1"]!.push(event(2, "output", { text: "Halfway through." }));
    act(() => bridge.push("runs:progress", { runId: "r1" }));

    expect(await activity.findByText("Halfway through.")).toBeInTheDocument();
    // Paged forward from the cursor, not read again from the start.
    expect(bridge.asked("runs:listEvents").at(-1)?.payload).toMatchObject({ runId: "r1", fromSeq: 2 });
  });

  it("shows the tokens the run has reported so far", async () => {
    mount([agent()], { r1: [event(0, DEBUG_SENT_EVENT, sent())] });

    expect(await screen.findByText(/12k in \/ 800 out/)).toHaveTextContent("50% cached");
    expect(screen.getByText("0.37 USD")).toBeInTheDocument();
  });
});

describe("read-only", () => {
  it("offers nothing that changes a run: no cancel, no composer, only selection and copy", async () => {
    const live = run({ status: "running", endedAt: null });
    mount([agent({ live: true, runs: [live] })], { r1: [event(0, DEBUG_SENT_EVENT, sent()), event(1, "output", { text: "Starting." })] });

    await screen.findByText("Starting.");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
    expect(buttons.filter((label) => !label.startsWith("Copy") && !label.includes("implement"))).toEqual([]);
  });

  it("says when debug mode has been switched off, so an empty record is not a puzzle", async () => {
    mount([agent()], { r1: [] }, false);

    expect(await screen.findByText("Debug mode is off — new runs are not being recorded.")).toBeInTheDocument();
  });
});
