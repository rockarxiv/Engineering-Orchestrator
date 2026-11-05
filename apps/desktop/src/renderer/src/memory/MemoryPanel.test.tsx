import type { ComponentType } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConsolidationView, MemoryListEntry, MemoryScope } from "@eo/core";
import { createQueryClient } from "../query/client";
import { MemoryPanel as ChatMemoryPanel } from "../chat/views/settings/sections/MemoryPanel";
import { consolidateNowBlocker, consolidationLine, retiredReasonLabel, splitMemory } from "./memoryPanel";

/**
 * The memory panel (EO-481): a scope's entries, newest first with their
 * sources, and every correction a person makes — add, edit, retire,
 * restore, and undoing a consolidation — each through its `memory:*`
 * command.
 *
 * What the panel decides is `memory/memoryPanel.ts`'s, tested on its
 * own below; the rest is the chat layout's panel. The `memory:*` channels
 * are answered by a small store kept here, so a write is seen to change
 * what the panel lists afterwards and not only to have been sent.
 */

type Call = { channel: string; payload: unknown };

const PROJECT: MemoryScope = { kind: "project", id: "p1" };
const WORKSPACE: MemoryScope = { kind: "workspace", id: "w1" };
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

function entry(id: string, body: string, overrides: Partial<MemoryListEntry> = {}): MemoryListEntry {
  return {
    id,
    scope: PROJECT,
    body,
    source: { type: "person", personId: null },
    createdAt: T0,
    updatedAt: T0,
    retiredAt: null,
    retiredReason: null,
    consolidationId: null,
    contradictsRepositoryFile: false,
    deliveries: 0,
    uses: 0,
    ...overrides,
  };
}

function consolidation(overrides: Partial<MemoryConsolidationView> = {}): MemoryConsolidationView {
  return {
    id: "c1",
    scope: PROJECT,
    trigger: "cap",
    status: "succeeded",
    startedAt: T0 + 5 * HOUR,
    finishedAt: T0 + 5 * HOUR + 60_000,
    restoredAt: null,
    retiredIds: [],
    writtenIds: [],
    note: null,
    ...overrides,
  };
}

/** What the main process keeps, for as long as one test runs: the `memory:*` channels over a list. */
function memoryStore(seed: MemoryListEntry[], consolidations: MemoryConsolidationView[] = [], refusal?: string) {
  let rows = [...seed];
  let runs = [...consolidations];
  let next = 0;
  const now = () => T0 + 10 * HOUR + ++next * 1000;
  const found = (id: string) => rows.find((row) => row.id === id);
  const put = (row: MemoryListEntry) => {
    rows = [...rows.filter((other) => other.id !== row.id), row];
    return row;
  };
  const answer = (channel: string, payload: unknown): unknown => {
    const p = payload as Record<string, unknown>;
    if (refusal !== undefined && channel !== "memory:list" && channel !== "memory:consolidations") return { ok: false, problem: refusal };
    switch (channel) {
      case "memory:list": {
        const scope = p.scope as MemoryScope;
        return { entries: rows.filter((row) => row.scope.kind === scope.kind && row.scope.id === scope.id) };
      }
      case "memory:consolidations":
        return { consolidations: runs, pending: null };
      case "memory:add": {
        const at = now();
        return { ok: true, entry: put(entry(`new-${next}`, String(p.body), { scope: p.scope as MemoryScope, createdAt: at, updatedAt: at })) };
      }
      case "memory:edit": {
        const old = found(String(p.id))!;
        const at = now();
        put({ ...old, retiredAt: at, retiredReason: "edited" });
        return { ok: true, entry: put(entry(`edit-${next}`, String(p.body), { scope: old.scope, createdAt: at, updatedAt: at })) };
      }
      case "memory:retire":
        return { ok: true, entry: put({ ...found(String(p.id))!, retiredAt: now(), retiredReason: "retired" }) };
      case "memory:restore":
        return { ok: true, entry: put({ ...found(String(p.id))!, retiredAt: null, retiredReason: null }) };
      case "memory:restoreConsolidation": {
        const run = runs.find((candidate) => candidate.id === p.consolidationId)!;
        const at = now();
        for (const id of run.retiredIds) put({ ...found(id)!, retiredAt: null, retiredReason: null });
        for (const id of run.writtenIds) put({ ...found(id)!, retiredAt: at, retiredReason: "consolidated" });
        const restored = { ...run, status: "restored" as const, restoredAt: at };
        runs = runs.map((candidate) => (candidate.id === run.id ? restored : candidate));
        return { ok: true, consolidation: restored, restored: run.retiredIds.length, retired: run.writtenIds.length };
      }
      case "items:get":
        return p.itemId === "item-7" ? { item: { id: "item-7", key: "SHOP-7" } } : null;
      default:
        return undefined;
    }
  };
  return answer;
}

function renderPanel(
  Panel: ComponentType<{ scope: MemoryScope; name: string }>,
  options: { entries?: MemoryListEntry[]; consolidations?: MemoryConsolidationView[]; scope?: MemoryScope; refusal?: string } = {},
) {
  const calls: Call[] = [];
  const fallback = window.eo.ipc.invoke;
  const answer = memoryStore(options.entries ?? [], options.consolidations ?? [], options.refusal);
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    const data = answer(channel, payload);
    if (data !== undefined) return { ok: true, data };
    return fallback(channel as never, payload as never);
  }) as never;
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Panel scope={options.scope ?? PROJECT} name="Shop" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const on = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

/** Opens the panel, which is closed until asked for, and answers its region. */
async function open(): Promise<HTMLElement> {
  const region = await screen.findByRole("region", { name: "Memory of Shop" });
  fireEvent.click(within(region).getByRole("button", { name: "Show the memory of Shop" }));
  return region;
}

const activeBodies = (region: HTMLElement) =>
  within(within(region).getByRole("list", { name: "Active memory" }))
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label"));

describe.each([
  ["chat-centric", ChatMemoryPanel],
] as const)("the memory panel in the %s layout", (_layout, Panel) => {
  it("lists the active entries newest first, each with its source, and an agent's entry links to its item", async () => {
    renderPanel(Panel, {
      entries: [
        entry("old", "Run pnpm build before the e2e suite.", { createdAt: T0 }),
        entry("agent", "Migrations need a journal entry.", { createdAt: T0 + 2 * HOUR, source: { type: "run", runId: "run-1", itemId: "item-7" } }),
        entry("mid", "The staging database is read-only on Fridays.", { createdAt: T0 + HOUR }),
        entry("gone", "Retired long ago.", { retiredAt: T0 + 3 * HOUR, retiredReason: "retired" }),
      ],
    });
    const region = await open();
    expect(await within(region).findByText("3 active entries")).toBeInTheDocument();
    expect(activeBodies(region)).toEqual(["Migrations need a journal entry.", "The staging database is read-only on Fridays.", "Run pnpm build before the e2e suite."]);

    const agentRow = within(region).getByRole("listitem", { name: "Migrations need a journal entry." });
    const item = await within(agentRow).findByRole("link", { name: "SHOP-7" });
    expect(item).toHaveAttribute("href", "/items/item-7");
    expect(within(agentRow).getByRole("link", { name: "its runs" })).toHaveAttribute("href", "/items/item-7/runs");
    const personRow = within(region).getByRole("listitem", { name: "Run pnpm build before the e2e suite." });
    expect(within(personRow).getByText("Written by a person")).toBeInTheDocument();
    // Retired entries are not among the active ones; they wait below.
    expect(within(region).queryByRole("listitem", { name: "Retired long ago." })).toBeNull();
  });

  it("marks an extracted entry, and one consolidation flagged as contradicting the workspace's own file", async () => {
    renderPanel(Panel, {
      scope: WORKSPACE,
      entries: [
        entry("x", "Use the fake clock in scheduler tests.", { scope: WORKSPACE, source: { type: "run", runId: "r", itemId: "item-7", extracted: true } }),
        entry("c", "Node 22 is required now, not 20.", { scope: WORKSPACE, createdAt: T0 + HOUR, contradictsRepositoryFile: true }),
        entry("n", "A plain note.", { scope: WORKSPACE, createdAt: T0 - HOUR, source: { type: "run", runId: "r2", itemId: "item-7" } }),
      ],
    });
    const region = await open();
    const extracted = await within(region).findByRole("listitem", { name: "Use the fake clock in scheduler tests." });
    expect(within(extracted).getByText("Extracted")).toBeInTheDocument();
    expect(within(extracted).queryByText("Contradicts CLAUDE.md or AGENTS.md")).toBeNull();
    const contradicting = within(region).getByRole("listitem", { name: "Node 22 is required now, not 20." });
    expect(within(contradicting).getByText("Contradicts CLAUDE.md or AGENTS.md")).toBeInTheDocument();
    const plain = within(region).getByRole("listitem", { name: "A plain note." });
    expect(within(plain).queryByText("Extracted")).toBeNull();
  });

  it("shows how many runs each active entry was given to and how many used it (EO-597)", async () => {
    renderPanel(Panel, {
      entries: [
        entry("ignored", "Given often, never used.", { deliveries: 14, uses: 0 }),
        entry("useful", "Given and used.", { createdAt: T0 + HOUR, deliveries: 3, uses: 2 }),
        entry("new", "Never given yet.", { createdAt: T0 + 2 * HOUR }),
      ],
    });
    const region = await open();
    const usage = (body: string) => within(within(region).getByRole("listitem", { name: body })).getByLabelText("Usage").textContent;
    await within(region).findByText("3 active entries");
    expect(usage("Given often, never used.")).toBe("Given to 14 runs, used by 0");
    expect(usage("Given and used.")).toBe("Given to 3 runs, used by 2");
    expect(usage("Never given yet.")).toBe("Not given to a run yet");
  });

  it("keeps the contradiction warning on a flagged entry once it is retired, beside its Restore", async () => {
    const calls = renderPanel(Panel, {
      scope: WORKSPACE,
      entries: [entry("c", "Node 22 is required now, not 20.", { scope: WORKSPACE, contradictsRepositoryFile: true })],
    });
    const region = await open();
    const row = await within(region).findByRole("listitem", { name: "Node 22 is required now, not 20." });
    fireEvent.click(within(row).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(on(calls, "memory:retire")).toEqual([{ id: "c" }]));

    fireEvent.click(await within(region).findByRole("button", { name: "Show retired (1)" }));
    const retired = within(region).getByRole("list", { name: "Retired memory" });
    const flagged = within(retired).getByRole("listitem", { name: "Node 22 is required now, not 20." });
    expect(within(flagged).getByText("Contradicts CLAUDE.md or AGENTS.md")).toBeInTheDocument();
    expect(within(flagged).getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("adds an entry by hand through memory:add", async () => {
    const calls = renderPanel(Panel);
    const region = await open();
    expect(await within(region).findByText(/No active entries/)).toBeInTheDocument();
    fireEvent.change(within(region).getByRole("textbox", { name: "New memory entry" }), { target: { value: "Releases go out on Tuesdays." } });
    fireEvent.click(within(region).getByRole("button", { name: "Add entry" }));
    await waitFor(() => expect(on(calls, "memory:add")).toEqual([{ scope: PROJECT, body: "Releases go out on Tuesdays." }]));
    expect(await within(region).findByRole("listitem", { name: "Releases go out on Tuesdays." })).toBeInTheDocument();
    expect(within(region).getByRole("textbox", { name: "New memory entry" })).toHaveValue("");
  });

  it("edits an entry through memory:edit, keeping what it said before among the retired", async () => {
    const calls = renderPanel(Panel, { entries: [entry("e1", "Tests run with pnpm test.")] });
    const region = await open();
    const row = await within(region).findByRole("listitem", { name: "Tests run with pnpm test." });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "Edit memory entry" }), { target: { value: "Tests run with pnpm test -- --run." } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(on(calls, "memory:edit")).toEqual([{ id: "e1", body: "Tests run with pnpm test -- --run." }]));
    await waitFor(() => expect(activeBodies(region)).toEqual(["Tests run with pnpm test -- --run."]));

    fireEvent.click(within(region).getByRole("button", { name: "Show retired (1)" }));
    const retired = within(region).getByRole("list", { name: "Retired memory" });
    const before = within(retired).getByRole("listitem", { name: "Tests run with pnpm test." });
    expect(within(before).getByText(/Replaced by an edit/)).toBeInTheDocument();
  });

  it("retires an entry through memory:retire, and restores it through memory:restore", async () => {
    const calls = renderPanel(Panel, { entries: [entry("e1", "Keep PRs under 400 lines."), entry("e2", "Squash on merge.", { createdAt: T0 + HOUR })] });
    const region = await open();
    const row = await within(region).findByRole("listitem", { name: "Keep PRs under 400 lines." });
    fireEvent.click(within(row).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(on(calls, "memory:retire")).toEqual([{ id: "e1" }]));
    await waitFor(() => expect(activeBodies(region)).toEqual(["Squash on merge."]));

    fireEvent.click(within(region).getByRole("button", { name: "Show retired (1)" }));
    const retired = within(region).getByRole("list", { name: "Retired memory" });
    const gone = within(retired).getByRole("listitem", { name: "Keep PRs under 400 lines." });
    fireEvent.click(within(gone).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(on(calls, "memory:restore")).toEqual([{ id: "e1" }]));
    await waitFor(() => expect(activeBodies(region)).toEqual(["Squash on merge.", "Keep PRs under 400 lines."]));
  });

  it("shows each consolidation as one row with its time and what it replaced, and its Restore brings the earlier set back", async () => {
    const agent = { type: "run" as const, runId: "r", itemId: null };
    const calls = renderPanel(Panel, {
      entries: [
        entry("a", "Lint before pushing.", { source: agent, retiredAt: T0 + 5 * HOUR, retiredReason: "consolidated", consolidationId: "c1" }),
        entry("b", "Run eslint first.", { source: agent, retiredAt: T0 + 5 * HOUR, retiredReason: "consolidated", consolidationId: "c1" }),
        entry("c", "Push only after pnpm lint.", { source: agent, retiredAt: T0 + 5 * HOUR, retiredReason: "consolidated", consolidationId: "c1" }),
        entry("merged", "Run pnpm lint before pushing.", { source: agent, createdAt: T0 + 5 * HOUR, consolidationId: "c1" }),
      ],
      consolidations: [
        consolidation({ retiredIds: ["a", "b", "c"], writtenIds: ["merged"] }),
        consolidation({ id: "c0", status: "failed", startedAt: T0, finishedAt: T0 + 1000, note: "The side call timed out." }),
      ],
    });
    const region = await open();
    const rows = within(await within(region).findByRole("list", { name: "Consolidations" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [latest, failed] = rows as [HTMLElement, HTMLElement];
    expect(within(latest).getByText(new Date(T0 + 5 * HOUR + 60_000).toLocaleString())).toBeInTheDocument();
    expect(within(latest).getByText("Replaced 3 entries with 1")).toBeInTheDocument();
    // A failed one changed nothing, so it offers nothing to undo.
    expect(within(failed).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(failed).getByText("The side call timed out.")).toBeInTheDocument();

    expect(activeBodies(region)).toEqual(["Run pnpm lint before pushing."]);
    fireEvent.click(within(latest).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(on(calls, "memory:restoreConsolidation")).toEqual([{ consolidationId: "c1" }]));
    await waitFor(() => expect(activeBodies(region).sort()).toEqual(["Lint before pushing.", "Push only after pnpm lint.", "Run eslint first."]));
    const after = within(within(region).getByRole("list", { name: "Consolidations" })).getAllByRole("listitem")[0]!;
    expect(within(after).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(after).getByText(/restored/)).toBeInTheDocument();
  });

  it("says why a write was refused, where it was pressed", async () => {
    renderPanel(Panel, { entries: [entry("e1", "One fact.")], refusal: "That entry is already retired." });
    const region = await open();
    fireEvent.click(within(await within(region).findByRole("listitem", { name: "One fact." })).getByRole("button", { name: "Retire" }));
    expect(await within(region).findByText("That entry is already retired.")).toBeInTheDocument();
  });

  it("is closed until asked for, and says how many entries it holds", async () => {
    renderPanel(Panel, { entries: [entry("e1", "One fact.")] });
    const region = await screen.findByRole("region", { name: "Memory of Shop" });
    expect(await within(region).findByText("1 active entry")).toBeInTheDocument();
    expect(within(region).queryByRole("list", { name: "Active memory" })).toBeNull();
  });
});

/**
 * Consolidate now (EO-589): beside the history, at the top of the section
 * above Add entry and the entries (EO-591), disabled with the reason
 * while one of the scope's is queued or running, while EO is paused, and
 * where no agent wrote anything; pressed, it shows EO's answer, and the
 * history is read again when the consolidation ends.
 */
describe("Consolidate now in the memory panel", () => {
  const agent = { type: "run" as const, runId: "r", itemId: null };

  /** The panel over a main process whose consolidation state the test drives, and the `memory:changed` push it sends. */
  function renderWith(options: {
    scope?: MemoryScope;
    entries: MemoryListEntry[];
    pending?: "queued" | "running" | null;
    paused?: boolean;
    consolidations?: MemoryConsolidationView[];
  }) {
    const state = { pending: options.pending ?? null, paused: options.paused ?? false, consolidations: options.consolidations ?? [] };
    const calls: Call[] = [];
    const listeners: ((push: unknown) => void)[] = [];
    const answer = memoryStore(options.entries);
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      calls.push({ channel, payload });
      if (channel === "memory:consolidations") return { ok: true, data: { consolidations: state.consolidations, pending: state.pending } };
      if (channel === "engine:status") return { ok: true, data: { paused: state.paused, activeRunCount: 0 } };
      if (channel === "memory:consolidateNow") {
        state.pending = "running";
        return { ok: true, data: { outcome: "started", message: 'Consolidation of the project "Shop" has started.' } };
      }
      return { ok: true, data: answer(channel, payload) };
    }) as never;
    window.eo.ipc.subscribe = vi.fn((channel: string, callback: (push: unknown) => void) => {
      if (channel === "memory:changed") listeners.push(callback);
      return () => {};
    }) as never;
    const { unmount } = render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ChatMemoryPanel scope={options.scope ?? PROJECT} name="Shop" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const push = (scope: MemoryScope) => {
      for (const listener of listeners) listener({ scope });
    };
    return { calls, state, push, unmount };
  }

  const button = (region: HTMLElement) => within(region).getByRole("button", { name: "Consolidate now" });

  it.each([
    ["project", PROJECT],
    ["workspace", WORKSPACE],
  ] as const)("is offered on a %s's memory and, pressed, asks memory:consolidateNow and shows the answer", async (_kind, scope) => {
    const { calls } = renderWith({ scope, entries: [entry("a", "Lint first.", { scope, source: agent })] });
    const region = await open();
    await waitFor(() => expect(button(region)).toBeEnabled());
    fireEvent.click(button(region));
    await waitFor(() => expect(on(calls, "memory:consolidateNow")).toEqual([{ scope }]));
    expect(await within(region).findByRole("status")).toHaveTextContent('Consolidation of the project "Shop" has started.');
    // Now running: disabled, with the reason.
    await waitFor(() => expect(button(region)).toBeDisabled());
    expect(within(region).getByText(`A consolidation of this ${scope.kind} is running.`)).toBeInTheDocument();
  });

  it("is disabled with the reason while one is queued, while one is running, while EO is paused, and on a scope with no agent-written entries", async () => {
    const cases: { options: Parameters<typeof renderWith>[0]; reason: string }[] = [
      { options: { entries: [entry("a", "A.", { source: agent })], pending: "queued" }, reason: "A consolidation of this project is queued, and starts once nothing is ahead of it." },
      { options: { entries: [entry("a", "A.", { source: agent })], pending: "running" }, reason: "A consolidation of this project is running." },
      { options: { entries: [entry("a", "A.", { source: agent })], paused: true }, reason: "EO is paused, and no consolidation starts while it is." },
      {
        options: { entries: [entry("p", "A person's.", {}), entry("r", "Retired agent note.", { source: agent, retiredAt: T0, retiredReason: "retired" })] },
        reason: "No active entry in this project was written by an agent, so there is nothing to consolidate.",
      },
    ];
    for (const { options, reason } of cases) {
      const { calls, unmount } = renderWith(options);
      const region = await open();
      expect(await within(region).findByText(reason)).toBeInTheDocument();
      expect(button(region)).toBeDisabled();
      expect(button(region)).toHaveAttribute("title", reason);
      fireEvent.click(button(region));
      expect(on(calls, "memory:consolidateNow")).toEqual([]);
      unmount();
    }
  });

  it.each([
    ["project", PROJECT],
    ["workspace", WORKSPACE],
  ] as const)(
    "on a %s with many active entries, sits at the top with the newest consolidation's status: above Add entry and the entries, the history after it newest first (EO-591)",
    async (_kind, scope) => {
      const entries = Array.from({ length: 150 }, (_, index) => entry(`e${String(index)}`, `Fact ${String(index)}.`, { scope, source: agent, createdAt: T0 + index * 1000 }));
      renderWith({
        scope,
        entries,
        consolidations: [
          consolidation({ id: "newest", scope, retiredIds: ["x", "y", "z"], writtenIds: ["w"], startedAt: T0 + 9 * HOUR, finishedAt: T0 + 9 * HOUR + 60_000 }),
          consolidation({ id: "older", scope, status: "failed", startedAt: T0 + 2 * HOUR, finishedAt: T0 + 2 * HOUR + 1000, note: "The call took longer than its 180000 ms and was stopped." }),
        ],
      });
      const region = await open();
      await waitFor(() => expect(within(region).getAllByRole("listitem", { name: /^Fact / })).toHaveLength(150));
      const history = within(await within(region).findByRole("list", { name: "Consolidations" })).getAllByRole("listitem");
      expect(history).toHaveLength(2);
      const [newest, older] = history as [HTMLElement, HTMLElement];
      expect(within(newest).getByText("Replaced 3 entries with 1")).toBeInTheDocument();
      expect(within(older).getByText("Failed; memory was left as it was")).toBeInTheDocument();

      const inOrder = [
        button(region),
        newest,
        older,
        within(region).getByRole("textbox", { name: "New memory entry" }),
        within(region).getByRole("button", { name: "Add entry" }),
        within(region).getByRole("list", { name: "Active memory" }),
      ];
      for (let at = 1; at < inOrder.length; at += 1) {
        // Each follows the one before it in the document.
        expect(inOrder[at - 1]!.compareDocumentPosition(inOrder[at]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    },
  );

  it("reads the history again when the consolidation ends, and offers the button again", async () => {
    const { state, push } = renderWith({ entries: [entry("a", "Lint first.", { source: agent })], pending: "running" });
    const region = await open();
    await waitFor(() => expect(button(region)).toBeDisabled());

    // It ends: a row in the history, nothing pending, and the push saying so.
    state.pending = null;
    state.consolidations = [consolidation({ trigger: "manual", retiredIds: ["x", "y"], writtenIds: ["z"] })];
    push({ kind: "workspace", id: "someone-else" });
    push(PROJECT);
    const rows = within(await within(region).findByRole("list", { name: "Consolidations" })).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Replaced 2 entries with 1")).toBeInTheDocument();
    await waitFor(() => expect(button(region)).toBeEnabled());
  });
});

describe("what the panel says", () => {
  it("orders active entries newest first and retired ones by when they were retired", () => {
    const lists = splitMemory([
      entry("a", "a", { createdAt: 1 }),
      entry("r1", "r1", { retiredAt: 5 }),
      entry("b", "b", { createdAt: 3 }),
      entry("r2", "r2", { retiredAt: 9 }),
    ]);
    expect(lists.active.map((row) => row.id)).toEqual(["b", "a"]);
    expect(lists.retired.map((row) => row.id)).toEqual(["r2", "r1"]);
  });

  it("says why a retired entry is not delivered, a note superseding it included (EO-594)", () => {
    expect(retiredReasonLabel("superseded")).toBe("Superseded by a newer note");
    expect(retiredReasonLabel("edited")).toBe("Replaced by an edit");
    expect(retiredReasonLabel("retired")).toBe("Retired");
  });

  it("says why Consolidate now cannot be pressed, the scope's pending one first", () => {
    const base = { where: "workspace" as const, pending: null, paused: false, agentEntries: 2 };
    expect(consolidateNowBlocker(base)).toBeNull();
    expect(consolidateNowBlocker({ ...base, pending: "running", paused: true, agentEntries: 0 })).toBe("A consolidation of this workspace is running.");
    expect(consolidateNowBlocker({ ...base, paused: true, agentEntries: 0 })).toBe("EO is paused, and no consolidation starts while it is.");
    expect(consolidateNowBlocker({ ...base, agentEntries: 0 })).toBe("No active entry in this workspace was written by an agent, so there is nothing to consolidate.");
  });

  it("offers Restore only on a consolidation that succeeded and has not been undone", () => {
    expect(consolidationLine(consolidation({ retiredIds: ["a"], writtenIds: [] })).summary).toBe("Replaced 1 entry with 0");
    expect(consolidationLine(consolidation()).canRestore).toBe(true);
    for (const status of ["running", "failed", "skipped", "restored"] as const) {
      expect(consolidationLine(consolidation({ status, restoredAt: status === "restored" ? T0 : null })).canRestore).toBe(false);
    }
  });

  it("says a container's memory ended with its work, what it kept for the project, and offers Restore on it (EO-596)", () => {
    const ended = consolidation({ scope: { kind: "container", id: "c1" }, trigger: "container_done", retiredIds: ["a", "b", "c"], writtenIds: ["d"] });
    expect(consolidationLine(ended).summary).toBe("Work finished: kept 1 of 3 entries as project memory, retired the rest");
    expect(consolidationLine(ended).canRestore).toBe(true);
    expect(consolidationLine({ ...ended, status: "restored", restoredAt: T0 }).summary).toMatch(/^Work finished: kept 1 of 3 entries as project memory, retired the rest; restored /);
    expect(consolidateNowBlocker({ where: "container", pending: null, paused: false, agentEntries: 0 })).toBe(
      "No active entry in this container was written by an agent, so there is nothing to consolidate.",
    );
  });
});
