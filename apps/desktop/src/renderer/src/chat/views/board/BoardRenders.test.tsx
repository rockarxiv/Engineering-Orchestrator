import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_GIT_STATE, developerRegistry, toRegistryView, type ItemSummary } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { itemsKey } from "../../../query/hooks";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { BoardView } from "./BoardView";

/**
 * How much of the board a change redraws (EO-565): the card that changed,
 * and no other.
 *
 * Every card asks whether its reader may act on it (`useItemAuthority`,
 * once for the card and once for its assignee line), so counting those
 * asks per item counts each card's renders without touching the card.
 */

const counts = vi.hoisted(() => ({ cards: new Map<string, number>(), vocabulary: 0 }));

vi.mock("../../../shared/admin/authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/admin/authority")>();
  return {
    ...actual,
    useItemAuthority: (itemId: string | null | undefined) => {
      if (itemId != null) counts.cards.set(itemId, (counts.cards.get(itemId) ?? 0) + 1);
      return actual.useItemAuthority(itemId);
    },
  };
});

vi.mock("../../../query/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../query/hooks")>();
  return {
    ...actual,
    useChromeVocabulary: () => {
      counts.vocabulary += 1;
      return actual.useChromeVocabulary();
    },
  };
});

// The board's drag layer, without the layout APIs jsdom lacks.
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  MeasuringStrategy: { Always: 0, BeforeDragging: 1, WhileDragging: 2 },
  PointerSensor: class {},
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  useSensor: () => ({}),
  useSensors: () => [],
}));

function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "t1",
    key: "EO-1",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: "p1",
    repositoryName: null,
    projectId: null,
    title: "Rate limit the API",
    pipelineId: "default",
    stepId: "todo",
    pipelineVersion: null,
    stepName: "To Do",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1,
    stepEnteredAt: 1,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

const STATES = [
  { id: "todo", pipelineId: "default", position: 0, name: "To Do", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false },
  { id: "pending_approval", pipelineId: "default", position: 1, name: "Pending Approval", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: false },
];

/**
 * The record, answered afresh on every read the way IPC answers — new
 * objects each time, so a card that keeps its object across a read does
 * so because the query shared it, not because the test handed it back.
 */
function serve(record: { items: ItemSummary[] }, claim: () => Promise<unknown> = async () => ({ claimed: true, problem: null })) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case "items:list":
        return { ok: true, data: { items: structuredClone(record.items) } };
      case "pipelineSteps:list":
        return { ok: true, data: { steps: STATES, routes: [], verification: [], version: null, finishingOn: [], ghosts: [] } };
      case "registry:get":
        return { ok: true, data: toRegistryView(developerRegistry()) };
      case "projects:list":
        return { ok: true, data: { projects: [], activeProjectId: null } };
      case "items:claim":
        return { ok: true, data: await claim() };
      case "people:list":
        return { ok: true, data: { people: [], groups: [], fromServer: false } };
      case "items:authority":
        return { ok: true, data: { authority: null } };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
}

function renderBoard(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/pipelines/default"]}>
        <ViewPublisher>
          <ItemReferenceProvider>
            <BoardView pipelineId="default" />
          </ItemReferenceProvider>
        </ViewPublisher>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every card's renders so far, by item id. */
const snapshot = () => new Map(counts.cards);

/** Let every pending read and render settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

/** Press the column's Show more until it has shown everything (EO-634). */
async function showEveryCard() {
  for (let more = screen.queryByRole("button", { name: /^Show \d+ more$/ }); more; more = screen.queryByRole("button", { name: /^Show \d+ more$/ })) {
    fireEvent.click(more);
    await settle();
  }
}

beforeEach(() => {
  counts.cards.clear();
  counts.vocabulary = 0;
});

describe("a board redraws only what changed (EO-565)", () => {
  it("redraws the card whose item changed, and no other card", async () => {
    const record = {
      items: [item({ id: "a", key: "EO-1", title: "Alpha" }), item({ id: "b", key: "EO-2", title: "Bravo" }), item({ id: "c", key: "EO-3", title: "Charlie" })],
    };
    serve(record);
    const client = createQueryClient();
    renderBoard(client);
    await screen.findByText("Charlie");
    await settle();
    const before = snapshot();

    // Somebody else renames Bravo; the board reads the record again.
    record.items = record.items.map((entry) => (entry.id === "b" ? { ...entry, title: "Bravo, renamed" } : entry));
    await act(() => client.invalidateQueries({ queryKey: itemsKey }));
    await screen.findByText("Bravo, renamed");
    await settle();

    expect(counts.cards.get("b")).toBeGreaterThan(before.get("b") ?? 0);
    expect(counts.cards.get("a")).toBe(before.get("a"));
    expect(counts.cards.get("c")).toBe(before.get("c"));
  });

  it("redraws the card being claimed, and not the card beside it", async () => {
    let land: (value: unknown) => void = () => {};
    const record = {
      items: [
        item({ id: "a", key: "EO-1", title: "Alpha", stepId: "pending_approval", claimable: true }),
        item({ id: "b", key: "EO-2", title: "Bravo", stepId: "pending_approval", claimable: true }),
      ],
    };
    serve(record, () => new Promise((resolve) => (land = resolve)));
    renderBoard(createQueryClient());
    fireEvent.click(await screen.findByRole("button", { name: "Claim EO-1" }));
    await screen.findByRole("button", { name: "Claiming EO-1" });
    await settle();
    const before = snapshot();

    await act(async () => land({ claimed: true, problem: null }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claiming EO-1" })).toBeNull());
    await settle();

    expect(counts.cards.get("a")).toBeGreaterThan(before.get("a") ?? 0);
    expect(counts.cards.get("b")).toBe(before.get("b"));
  });

  describe("the time on a card (EO-570)", () => {
    const NOW = new Date("2026-01-01T12:00:00Z").getTime();
    const MINUTE = 60_000;

    beforeEach(() => {
      // The clock and its interval only: the reads and renders settle on
      // real timeouts, as they do in every other test here.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("counts from when the item entered its step, not from its last edit", async () => {
      serve({ items: [item({ id: "a", key: "EO-1", title: "Alpha", stepEnteredAt: NOW - 4 * MINUTE, updatedAt: NOW - MINUTE })] });
      renderBoard(createQueryClient());
      await screen.findByText("Alpha");

      expect(screen.getByText("4m")).toBeInTheDocument();
      expect(screen.queryByText("1m")).toBeNull();
    });

    it("advances a minute later with no push, redrawing the time and not the card", async () => {
      serve({
        items: [
          item({ id: "a", key: "EO-1", title: "Alpha", stepEnteredAt: NOW - 4 * MINUTE }),
          item({ id: "b", key: "EO-2", title: "Bravo", stepEnteredAt: NOW - 2 * 60 * MINUTE }),
        ],
      });
      renderBoard(createQueryClient());
      await screen.findByText("Alpha");
      await settle();
      expect(screen.getByText("4m")).toBeInTheDocument();
      const before = snapshot();

      act(() => {
        vi.advanceTimersByTime(MINUTE);
      });

      expect(screen.getByText("5m")).toBeInTheDocument();
      expect(screen.queryByText("4m")).toBeNull();
      expect(screen.getByText("2h")).toBeInTheDocument();
      expect(counts.cards.get("a")).toBe(before.get("a"));
      expect(counts.cards.get("b")).toBe(before.get("b"));
    });
  });

  it("reads the project's words once for the board, not once per card", async () => {
    serve({ items: Array.from({ length: 30 }, (_, index) => item({ id: `t${index}`, key: `EO-${index}`, title: `Card ${index}` })) });
    renderBoard(createQueryClient());
    await screen.findByRole("button", { name: /^Show \d+ more$/ });
    await showEveryCard();
    await screen.findByText("Card 29");
    await settle();

    // Every card is drawn, and the words were asked for fewer times than
    // there are cards: by the board, each time it rendered.
    expect(counts.cards.size).toBe(30);
    expect(counts.vocabulary).toBeLessThan(30);
  });

  it("redraws no card already shown when a column shows more (EO-634)", async () => {
    serve({
      items: [
        ...Array.from({ length: 6 }, (_, index) => item({ id: `t${index}`, key: `EO-${index}`, title: `Card ${index}` })),
        item({ id: "r1", key: "EO-90", title: "Elsewhere", stepId: "pending_approval" }),
      ],
    });
    renderBoard(createQueryClient());
    await screen.findByText("Card 5");
    await settle();
    const before = snapshot();
    expect([...before.keys()].sort()).toEqual(["r1", "t2", "t3", "t4", "t5"]);

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    await screen.findByText("Card 0");
    await settle();

    // The two it revealed were drawn; nothing already on the board was again.
    expect(counts.cards.get("t1")).toBeGreaterThan(0);
    expect(counts.cards.get("t0")).toBeGreaterThan(0);
    for (const [id, renders] of before) expect(counts.cards.get(id)).toBe(renders);
  });
});
