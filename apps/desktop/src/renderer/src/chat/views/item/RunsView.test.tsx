import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RunView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { RunsView } from "./RunsView";

/** The runs of an item (the classic `RunList` and its tests are the model). */
vi.mock("react-virtuoso", async () => {
  const React = await import("react");
  return {
    Virtuoso: React.forwardRef(function FlatList(props: { data?: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
      return <div>{(props.data ?? []).map((item, index) => <div key={index}>{props.itemContent(index, item)}</div>)}</div>;
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

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function renderRuns(runs: () => RunView[], onCall?: (channel: string, payload: unknown) => void) {
  // Every listener, not the last: the view refetches on this push, and a
  // running run's live words (the transcript's) listen to it as well.
  const runsChangedListeners: ((push: unknown) => void)[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    onCall?.(channel, payload);
    if (channel === "items:get") {
      return { ok: true, data: { item: { id: "t1", key: "EO-1", title: "Rate limit the API", projectId: null }, runs: runs(), comments: [], transitions: [], dependsOn: [], decision: [] } };
    }
    if (channel === "runs:listEvents") return { ok: true, data: { events: [], nextSeq: null } };
    return { ok: true, data: {} };
  }) as never;
  const itemsChangedListeners: ((push: unknown) => void)[] = [];
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: (push: unknown) => void) => {
    if (channel === "runs:changed") runsChangedListeners.push(callback);
    if (channel === "items:changed") itemsChangedListeners.push(callback);
    return () => {};
  }) as never;

  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/items/t1/runs"]}>
          <ViewPublisher>
            <ItemReferenceProvider>
              <RunsView itemId="t1" />
            </ItemReferenceProvider>
          </ViewPublisher>
          <CurrentRoute />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  // What the main process sends: the run, its item and where it stands now.
  return {
    pushRunsChanged: (push: unknown = { runId: "r1", itemId: "t1", status: "succeeded" }) => runsChangedListeners.forEach((listener) => listener(push)),
    pushItemsChanged: (push: unknown) => itemsChangedListeners.forEach((listener) => listener(push)),
  };
}

describe("the runs view", () => {
  it("keeps a run's status live even when the item view never mounted", async () => {
    let served = 0;
    const { pushRunsChanged } = renderRuns(() => {
      served += 1;
      return [run({ status: served === 1 ? "running" : "succeeded" })];
    });

    const nav = await screen.findByRole("navigation", { name: "Runs" });
    expect(within(nav).getByText("running")).toBeInTheDocument();
    pushRunsChanged();
    await waitFor(() => expect(within(nav).getByText("succeeded")).toBeInTheDocument());
    expect(served).toBe(2);
  });

  it("is read again for its own item's pushes and item-less ones, and no other item's (EO-560)", async () => {
    const asked: string[] = [];
    const { pushRunsChanged, pushItemsChanged } = renderRuns(
      () => [run()],
      (channel) => asked.push(channel),
    );
    await screen.findByRole("navigation", { name: "Runs" });
    const reads = () => asked.filter((channel) => channel === "items:get").length;
    expect(reads()).toBe(1);

    // Another item's comment and another item's run: nothing here changed.
    act(() => {
      pushItemsChanged({ itemId: "t2" });
      pushRunsChanged({ runId: "r9", itemId: "t2", status: "succeeded" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads()).toBe(1);

    act(() => pushItemsChanged({ itemId: "t1" }));
    await waitFor(() => expect(reads()).toBe(2));
    // Naming no item is "something changed", and stays a refresh.
    act(() => pushItemsChanged({}));
    await waitFor(() => expect(reads()).toBe(3));
  });

  it("lists a resumed run once, not once per turn", async () => {
    renderRuns(() => [
      run({ id: "r1", action: "intake", threadId: "th-1", attempt: 1, status: "awaiting_input", startedAt: 1_000, endedAt: 2_000 }),
      run({ id: "r2", action: "intake", threadId: "th-1", attempt: 2, status: "succeeded", startedAt: 3_000, endedAt: 4_000 }),
      run({ id: "r3", action: "refine", threadId: "th-2", attempt: 1, status: "running", startedAt: 5_000, endedAt: null }),
    ]);

    const rows = within(await screen.findByRole("navigation", { name: "Runs" })).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("intake")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("succeeded")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("2 turns")).toBeInTheDocument();
  });

  it("lists a module run by the module's name, never its id", async () => {
    renderRuns(() => [run({ id: "r1", agentId: null, agentName: "EO", action: "019a0000-0000-7000-8000-000000000001", actionName: "Deploy to staging" })]);

    expect(await screen.findByRole("button", { name: /Deploy to staging/ })).toBeInTheDocument();
    expect(screen.queryByText(/019a0000/)).not.toBeInTheDocument();
  });

  it("publishes the run on screen, and the one somebody clicks instead", async () => {
    const publishes: unknown[] = [];
    renderRuns(
      () => [run({ id: "r1", action: "implement" }), run({ id: "r2", action: "review", startedAt: 3_000 })],
      (channel, payload) => {
        if (channel === "view:publish") publishes.push((payload as { selection?: unknown }).selection);
      },
    );

    const nav = await screen.findByRole("navigation", { name: "Runs" });
    await waitFor(() => expect(publishes.at(-1)).toEqual(["r1"]));
    fireEvent.click(within(nav).getByText("review"));
    await waitFor(() => expect(publishes.at(-1)).toEqual(["r2"]));
  });

  it("shows the selected run's details beside its transcript", async () => {
    renderRuns(() => [run({ status: "succeeded", verificationOk: false, threadId: "sess_01J2", endedAt: Date.now() })]);

    const details = await screen.findByRole("complementary", { name: "Run details" });
    expect(within(details).getByText("Checks failed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Transcript" })).toBeInTheDocument();
  });

  it("says so when nothing has run yet, in the project's word", async () => {
    renderRuns(() => []);
    expect(await screen.findByText(/No runs yet for this/)).toBeInTheDocument();
  });

  it("goes back to the item from its own switch, without a classic page in between", async () => {
    renderRuns(() => [run()]);

    const tabs = await screen.findByRole("tablist", { name: "Item or runs" });
    expect(within(tabs).getByRole("tab", { name: /Runs/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("link", { name: /full page/i })).not.toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole("tab", { name: "Item" }));
    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent(/^\/items\/t1$/));
  });
});
