import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SPEC_SHAPE,
  NO_GIT_STATE,
  developerRegistry,
  toRegistryView,
  type InboxItem,
  type ItemSummary,
  type PipelineView,
  type RegistryView,
} from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { AskAssistantContext, type AskAssistant } from "../../askAssistant";
import { BoardView } from "./BoardView";

/**
 * The chat layout's board, held to what the classic board's suite holds
 * it to (`pipeline/PipelineDashboard.test.tsx`): the same IPC, the same
 * rules about drops, holds and hand-offs, the same words to the
 * assistant — drawn this layout's way, and moving by address rather than
 * by callbacks.
 */

interface TestDragEndEvent {
  active: { id: string };
  over: { id: string } | null;
}

const dnd = vi.hoisted(() => ({
  onDragEnd: null as ((event: TestDragEndEvent) => void) | null,
  onDragStart: null as ((event: { active: { id: string } }) => void) | null,
  onDragCancel: null as (() => void) | null,
}));

// The board's real drag handlers, driven without the layout APIs jsdom lacks.
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
    onDragCancel,
  }: {
    children: ReactNode;
    onDragStart: (event: { active: { id: string } }) => void;
    onDragEnd: (event: TestDragEndEvent) => void;
    onDragCancel: () => void;
  }) => {
    dnd.onDragEnd = onDragEnd;
    dnd.onDragStart = onDragStart;
    dnd.onDragCancel = onDragCancel;
    return children;
  },
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  MeasuringStrategy: { Always: 0, BeforeDragging: 1, WhileDragging: 2 },
  PointerSensor: class {},
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  useSensor: () => ({}),
  useSensors: () => [],
}));

function drop(activeId: string, overId: string | null) {
  act(() => dnd.onDragEnd?.({ active: { id: activeId }, over: overId === null ? null : { id: overId } }));
}

function pickUp(activeId: string) {
  act(() => dnd.onDragStart?.({ active: { id: activeId } }));
}

function cancelDrag() {
  act(() => dnd.onDragCancel?.());
}

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
  { id: "review", pipelineId: "default", position: 2, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false },
];

function pipeline(overrides: Partial<PipelineView> = {}): PipelineView {
  return { id: "merge", projectId: null, name: "Merge", icon: null, entryStepId: "mg_merge", position: 1, archivedAt: null, ...overrides };
}

const THIS_PIPELINE = pipeline({ id: "default", name: "Delivery", entryStepId: "todo", position: 0 });
const RELEASE = pipeline({ id: "release", name: "Release", entryStepId: "rl_cut", position: 2 });
const TWO = [THIS_PIPELINE, pipeline(), RELEASE];

const DEVELOPER: RegistryView = toRegistryView(developerRegistry());
const TWO_PACKS: RegistryView = {
  ...DEVELOPER,
  itemTypes: [
    ...DEVELOPER.itemTypes,
    { packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} },
  ],
  packs: [...(DEVELOPER.packs ?? []), { slug: "support", item: "Case", items: "Cases", results: {} }],
};

function repository(connected: boolean) {
  return {
    id: "p1",
    name: "acme-api",
    keyPrefix: "ACME",
    repoPath: "/tmp/acme-api",
    baseBranch: "trunk",
    testCommand: null,
    lintCommand: null,
    buildCommand: null,
    itemCount: 0,
    forge: { openPr: false, kind: null, remote: "origin", draft: false, templatePath: null },
    jira: {
      baseUrl: connected ? "https://acme.atlassian.net" : null,
      flavour: connected ? "cloud" : null,
      projectKey: connected ? "ACME" : null,
      email: null,
      featureIssueType: "Epic",
      storyIssueType: "Story",
      fields: null,
      createByDefault: true,
      credentialsConfigured: connected,
    },
  };
}

function mockIpc(
  options: {
    items?: ItemSummary[];
    states?: unknown[];
    pipelines?: PipelineView[];
    inboxItems?: InboxItem[];
    verification?: unknown[];
    version?: unknown;
    finishingOn?: { number: number; items: number }[];
    ghosts?: { stepId: string; name: string; version: number; holding: number }[];
    people?: { id: string; name: string }[];
    groups?: { id: string; name: string }[];
    queuedItemIds?: string[];
    registry?: RegistryView;
    /** Whether a webhook job files onto the pipeline, and whether it sends unread (EO-405). Absent is neither. */
    webhook?: { entry: boolean; unattended: boolean };
    /** A project with a repository, and whether its Jira is connected. Absent is a project with none. */
    jira?: boolean;
    modules?: unknown[];
    onMove?: (payload: unknown) => unknown;
    onHold?: (payload: unknown) => unknown;
    onResume?: (payload: unknown) => unknown;
    /** What `items:authority` answers for every card (EO-368). Absent is "nothing gated". */
    authority?: unknown;
    /** What `pipeline:templateStatus` answers (EO-536). Absent is a pipeline made from no template. */
    templateStatus?: unknown;
  } = {},
) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "items:list":
        return { ok: true, data: { items: [...(options.items ?? [item()])] } };
      case "items:listArchived":
        return { ok: true, data: { items: [] } };
      case "projects:list":
        return options.jira === undefined
          ? { ok: true, data: { projects: [], activeProjectId: null } }
          : { ok: true, data: { projects: [{ id: "b1", name: "acme", keyPrefix: "EO", jiraProjectId: "p1", repositoryIds: ["p1"], itemCount: 0 }], activeProjectId: "b1" } };
      case "repositories:list":
        return { ok: true, data: { repositories: options.jira === undefined ? [] : [repository(options.jira)] } };
      case "pipelineSteps:list":
        return {
          ok: true,
          data: {
            steps: options.states ?? STATES,
            routes: [],
            verification: options.verification ?? [],
            version: options.version ?? null,
            finishingOn: options.finishingOn ?? [],
            ghosts: options.ghosts ?? [],
            ...(options.webhook ? { webhook: options.webhook } : {}),
          },
        };
      case "pipelines:list":
        return { ok: true, data: { pipelines: [...(options.pipelines ?? [])] } };
      case "agents:list":
        return { ok: true, data: { agents: [] } };
      case "people:list":
        return { ok: true, data: { people: options.people ?? [], groups: options.groups ?? [], fromServer: false } };
      case "modules:list":
        return { ok: true, data: { modules: options.modules ?? [] } };
      case "items:move":
        return { ok: true, data: options.onMove?.(payload) ?? { moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null } };
      case "items:hold":
        return { ok: true, data: options.onHold?.(payload) ?? { held: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null } };
      case "items:resume":
        return { ok: true, data: options.onResume?.(payload) ?? { resumed: true, cancelledRunId: null, blockedByActiveRun: false } };
      case "inbox:list":
        return {
          ok: true,
          data: {
            items: options.inboxItems ?? [],
            summary: { openCount: options.inboxItems?.length ?? 0, blockingCount: 0, everythingBlocked: false },
          },
        };
      case "registry:get":
        return { ok: true, data: options.registry ?? DEVELOPER };
      case "sync:status":
        return {
          ok: true,
          data: {
            state: (options.queuedItemIds?.length ?? 0) > 0 ? "offline" : "solo",
            offlineSince: null,
            queued: options.queuedItemIds?.length ?? 0,
            queuedItemIds: options.queuedItemIds ?? [],
            problem: null,
          },
        };
      case "items:authority":
        return { ok: true, data: { authority: options.authority ?? null } };
      case "pipeline:templateStatus":
        return { ok: true, data: options.templateStatus ?? { origin: null, updated: null, waiting: null, problem: null } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  return invoke;
}

/** Where the board has sent the window. */
function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

/** The board on its own, or — given `ask` — inside a frame that has a conversation to hand the person to. */
function renderBoard(at = "/pipelines/default", ask: AskAssistant | null = null) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[at]}>
        <AskAssistantContext.Provider value={ask}>
          <ViewPublisher>
            <ItemReferenceProvider>
              <BoardView pipelineId="default" />
              <Where />
            </ItemReferenceProvider>
          </ViewPublisher>
        </AskAssistantContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;

function lastFilter(invoke: ReturnType<typeof vi.fn>): unknown {
  const publishes = invoke.mock.calls.filter((call: unknown[]) => call[0] === "view:publish");
  return (publishes.at(-1)?.[1] as { filter?: unknown } | undefined)?.filter;
}

const column = (name: string) => screen.findByRole("region", { name: new RegExp(`^${name} — `) });

describe("the board's columns", () => {
  it("draws one per step, in position order, and a new step is a new column", async () => {
    mockIpc({
      states: [...STATES, { id: "qa", pipelineId: "default", position: 3, name: "QA", type: "agent", ownerRole: "tester", entryAction: "test", instructionsSummary: null, isTerminal: false }],
    });
    renderBoard();

    await screen.findByRole("heading", { level: 2, name: "QA" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["To Do", "Pending Approval", "Review", "QA"]);
  });

  it("says who owns each, and marks a human step as yours", async () => {
    mockIpc();
    renderBoard();

    const todo = await column("To Do");
    expect(within(todo).getByText("implementer")).toBeInTheDocument();
    expect(screen.getByTitle(/Human-owned/)).toBeInTheDocument();
  });

  it("draws each column as a raised panel headed by its name, count and kind chip, and each card raised on it (EO-680)", async () => {
    mockIpc({
      states: [
        { id: "worktree", pipelineId: "default", position: -1, name: "Worktree", type: "builtin", ownerRole: null, entryAction: "create_worktree", instructionsSummary: null, isTerminal: false },
        ...STATES,
        { id: "merge", pipelineId: "default", position: 3, name: "Merge", type: "module", ownerRole: null, entryAction: "merge_branch", instructionsSummary: null, isTerminal: false },
        { id: "done", pipelineId: "default", position: 4, name: "Done", type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true },
      ],
      items: [item({ id: "t1", title: "On to do", stepId: "todo", stepName: "To Do" })],
      version: { id: "v7", pipelineId: "default", number: 7, createdAt: 1, createdBy: "p1", createdByName: "Dana" },
      finishingOn: [{ number: 6, items: 1 }],
      ghosts: [{ stepId: "qa", name: "QA", version: 6, holding: 1 }],
    });
    renderBoard();

    const todo = await column("To Do");
    await within(todo).findByText("On to do");
    const chip = (name: string, region: HTMLElement) => {
      const head = within(region).getByRole("heading", { level: 2, name }).parentElement!;
      return [...head.querySelectorAll("[data-step-kind]")];
    };
    for (const [name, text, title] of [
      ["Worktree", "EO", "built in · create_worktree"],
      ["To Do", "agent", "agent · implementer"],
      ["Pending Approval", "person", "you"],
      ["Merge", "script", "module · merge_branch"],
    ] as const) {
      const region = await column(name);
      expect(region.className, name).toContain("rounded-[14px]");
      expect(within(region).getByRole("heading", { level: 2, name }).className).toContain("text-[15px]");
      const chips = chip(name, region);
      expect(chips, name).toHaveLength(1);
      expect(chips[0]).toHaveTextContent(text);
      expect(chips[0]).toHaveAttribute("title", title);
    }
    // An end has no kind.
    expect(chip("Done", await column("Done"))).toHaveLength(0);

    // A column an agent, a person or a script owns is a lane in its kind's colour (EO-685):
    // a 3px cap and its mono owner line leaning 35% toward it, on the same neutral raised
    // surface and hairline as EO's own column, with no fill or outline tint (EO-694).
    for (const [name, colour, cap, owner] of [
      ["To Do", "--color-kind-agent", "border-t-kind-agent", "implementer"],
      ["Pending Approval", "--color-paused", "border-t-paused", "you"],
      ["Merge", "--color-kind-script", "border-t-kind-script", "merge_branch"],
    ] as const) {
      const region = await column(name);
      const classes = region.className.split(" ");
      expect(classes, name).toEqual(
        expect.arrayContaining([
          "border-t-[3px]",
          cap,
          "bg-canvas-raised",
          "border-line",
        ]),
      );
      expect(region.className, name).not.toContain("color-mix");
      const line = within(region).getByText(owner);
      expect(line.className, name).toContain("font-mono");
      expect(line.className, name).toContain(`text-[color:color-mix(in_oklab,var(--color-ink-subtle),var(${colour})_35%)]`);
    }
    // EO's own column and the end keep the neutral raised panel: no cap, no tint.
    for (const name of ["Worktree", "Done"]) {
      const classes = (await column(name)).className;
      expect(classes.split(" "), name).toEqual(expect.arrayContaining(["bg-canvas-raised", "border-line"]));
      expect(classes, name).not.toContain("border-t-");
      expect(classes, name).not.toContain("color-mix");
    }
    expect(within(await column("Worktree")).getByText("create_worktree").className).toContain("text-ink-subtle");
    // The count sits between the name and the chip.
    const head = within(todo).getByRole("heading", { level: 2, name: "To Do" }).parentElement!;
    expect([...head.children].map((child) => child.textContent)).toEqual(["To Do", "1", "agent"]);
    // The action line under it, in mono.
    expect(within(todo).getByText("implementer").className).toContain("font-mono");

    // A card is one step up from its column, on a hairline.
    const card = within(todo).getByText("On to do").closest("article")!;
    expect(card.className).toContain("bg-canvas-hover");
    expect(card.className).toContain("border-line");
    expect(within(card).getByText("On to do").className).toContain("text-[13.5px]");

    // The removed step's column and an empty column's placeholder stay dashed.
    expect((await screen.findByRole("region", { name: "QA (v6) · 1 finishing" })).className).toContain("border-dashed");
    expect(within(await column("Review")).getByText("Empty").className).toContain("border-dashed");
  });

  it("puts each item in its own column, newest first, and counts in the project's word", async () => {
    mockIpc({
      items: [
        item({ id: "0190b1b2-c3d4-7000-8000-000000000002", key: "EO-2", title: "Second" }),
        item({ id: "0190a1b2-c3d4-7000-8000-000000000001", key: "EO-1", title: "First" }),
        item({ id: "0190c1b2-c3d4-7000-8000-000000000003", key: "EO-3", title: "Third" }),
        item({ id: "t4", key: "EO-4", title: "Reviewing", stepId: "review" }),
      ],
    });
    renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do — 3 tickets" });
    await within(todo).findByText("EO-3");
    expect(within(todo).getAllByRole("button", { name: /^Open EO-/ }).map((card) => card.getAttribute("aria-label"))).toEqual([
      "Open EO-3: Third",
      "Open EO-2: Second",
      "Open EO-1: First",
    ]);
    expect(within(screen.getByRole("region", { name: "Review — 1 ticket" })).getByText("Reviewing")).toBeInTheDocument();
  });

  it("leaves another pipeline's work off the board, the rail and the running count", async () => {
    mockIpc({
      items: [
        item({ latestRunStatus: "running" }),
        item({ id: "t2", key: "EO-2", title: "Elsewhere", pipelineId: "other", stepId: "other_step", latestRunStatus: "awaiting_input" }),
      ],
    });
    renderBoard();

    expect(await screen.findByText("1 agent running")).toBeInTheDocument();
    expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();
  });

  it("explains a pipeline with no steps rather than drawing nothing, and points to the assistant rather than a configure screen", async () => {
    mockIpc({ states: [], items: [] });
    const ask = vi.fn();
    renderBoard("/pipelines/default", ask);

    expect(await screen.findByText("This pipeline has no steps yet.")).toBeInTheDocument();
    expect(screen.getByText(/to the assistant/)).toBeInTheDocument();
    expect(screen.queryByText(/configure/i)).toBeNull();
    expect(screen.queryByRole("link", { name: "Configure" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask the assistant" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("goes to the chat from an empty board when no conversation is beside it", async () => {
    mockIpc({ states: [], items: [] });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: "Ask the assistant" }));
    expect(where()).toBe("/chat");
  });

  it("says when a module column is not fully tested", async () => {
    mockIpc({
      states: [...STATES, { id: "merge", pipelineId: "default", position: 3, name: "Merge", type: "module", ownerRole: null, entryAction: "mod-merge", instructionsSummary: null, isTerminal: false }],
      modules: [{ id: "mod-merge", slug: "merge-pr", name: "Merge pull request", testRun: null, testsStale: false, testCount: 0 }],
    });
    renderBoard();

    const merge = await column("Merge");
    expect(await within(merge).findByRole("note", { name: "Not fully tested: no tests" })).toBeInTheDocument();
    expect(screen.getAllByRole("note", { name: /Not fully tested/ })).toHaveLength(1);
  });
});

describe("a long column (EO-634)", () => {
  /** `count` cards on `stepId`, ids `${prefix}00`… so the highest number is the newest. */
  const many = (count: number, overrides: Partial<ItemSummary> = {}, prefix = "c") =>
    Array.from({ length: count }, (_, index) => {
      const number = String(index).padStart(2, "0");
      return item({ id: `${prefix}${number}`, key: `EO-${prefix}${number}`, title: `Card ${prefix}${number}`, ...overrides });
    });

  /** The cards a column shows, top to bottom, by title. */
  const titlesIn = (region: HTMLElement) =>
    within(region)
      .queryAllByRole("button", { name: /^Open EO-/ })
      .map((card) => card.getAttribute("aria-label")?.replace(/^Open [^:]+: /, ""));

  it("shows the four newest, then four more a press, saying how many the next press adds, until all are shown", async () => {
    mockIpc({ items: many(10) });
    renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do — 10 tickets" });
    await within(todo).findByText("Card c09");
    expect(titlesIn(todo)).toEqual(["Card c09", "Card c08", "Card c07", "Card c06"]);
    // The head counts all ten, not the four shown.
    expect(within(todo).getByText("10")).toBeInTheDocument();

    fireEvent.click(within(todo).getByRole("button", { name: "Show 4 more" }));
    expect(titlesIn(todo)).toHaveLength(8);
    expect(within(todo).queryByRole("button", { name: "Show 4 more" })).toBeNull();

    fireEvent.click(within(todo).getByRole("button", { name: "Show 2 more" }));
    expect(titlesIn(todo)).toEqual(many(10).map((card) => card.title).reverse());
    expect(within(todo).queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
    expect(screen.getByRole("region", { name: "To Do — 10 tickets" })).toBe(todo);
  });

  it("shows a column of four or fewer whole, with no Show more", async () => {
    mockIpc({ items: [...many(4), ...many(1, { stepId: "review", stepName: "Review" }, "r")] });
    renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do — 4 tickets" });
    await within(todo).findByText("Card c03");
    expect(titlesIn(todo)).toHaveLength(4);
    expect(titlesIn(await column("Review"))).toEqual(["Card r00"]);
    expect(screen.queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("does the same for a removed step's column", async () => {
    mockIpc({
      version: { id: "v7", pipelineId: "default", number: 7, createdAt: 1, createdBy: "p1", createdByName: "Dana" },
      finishingOn: [{ number: 6, items: 6 }],
      ghosts: [{ stepId: "qa", name: "QA", version: 6, holding: 6 }],
      items: many(6, { stepId: "qa", stepName: "QA", pipelineVersion: 6 }),
    });
    renderBoard();

    const ghost = await screen.findByRole("region", { name: "QA (v6) · 6 finishing" });
    await within(ghost).findByText("Card c05");
    expect(titlesIn(ghost)).toEqual(["Card c05", "Card c04", "Card c03", "Card c02"]);
    fireEvent.click(within(ghost).getByRole("button", { name: "Show 2 more" }));
    expect(titlesIn(ghost)).toHaveLength(6);
    expect(within(ghost).queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
  });

  it("counts only the cards that match the filter", async () => {
    mockIpc({ items: [...many(6, {}, "a").map((card) => ({ ...card, title: `Alpha ${card.id}` })), ...many(5, {}, "b")] });
    renderBoard();

    const todo = await screen.findByRole("region", { name: "To Do — 11 tickets" });
    await within(todo).findByRole("button", { name: "Show 4 more" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the board" }), { target: { value: "alpha" } });

    const narrowed = await screen.findByRole("region", { name: "To Do — 6 tickets" });
    await waitFor(() => expect(titlesIn(narrowed)).toEqual(["Alpha a05", "Alpha a04", "Alpha a03", "Alpha a02"]));
    fireEvent.click(within(narrowed).getByRole("button", { name: "Show 2 more" }));
    expect(titlesIn(narrowed)).toHaveLength(6);
  });

  it("shows a card moved into it straight away, however far down it sorts", async () => {
    // The oldest card on the board, moved onto a column of five newer ones.
    const list = [item({ id: "a00", key: "EO-1", title: "Moved here" }), ...many(5, { stepId: "review", stepName: "Review" })];
    mockIpc({
      items: list,
      onMove: () => {
        list[0] = item({ id: "a00", key: "EO-1", title: "Moved here", stepId: "review", stepName: "Review" });
        return { moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null };
      },
    });
    renderBoard();

    await screen.findByText("Moved here");
    drop("a00", "review");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Read again from the record, and still there, below the four newest.
    const review = await screen.findByRole("region", { name: "Review — 6 tickets" });
    await waitFor(() => expect(within(review).getByText("Moved here").closest("article")).toHaveAttribute("aria-busy", "false"));
    expect(titlesIn(review)).toEqual(["Card c04", "Card c03", "Card c02", "Card c01", "Moved here"]);
    expect(within(review).getByRole("button", { name: "Show 1 more" })).toBeInTheDocument();
  });

  it("shows four again once the board is left and opened again", async () => {
    mockIpc({ items: many(6) });
    const first = renderBoard();
    const todo = await column("To Do");
    fireEvent.click(await within(todo).findByRole("button", { name: "Show 2 more" }));
    expect(titlesIn(todo)).toHaveLength(6);
    first.unmount();

    renderBoard();
    const again = await column("To Do");
    await within(again).findByText("Card c05");
    expect(titlesIn(again)).toHaveLength(4);
    expect(within(again).getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
  });
});

describe("a card", () => {
  it("opens its item, and its key links there without opening or lifting the card", async () => {
    mockIpc();
    renderBoard();

    const link = await within(await column("To Do")).findByRole("link", { name: "EO-1" });
    expect(link).toHaveAttribute("href", "/items/t1");

    fireEvent.click(screen.getByRole("button", { name: "Open EO-1: Rate limit the API" }));
    expect(where()).toBe("/items/t1");
  });

  it("marks one waiting on you, and only that one", async () => {
    mockIpc({ items: [item({ needsAttention: true }), item({ id: "t2", key: "EO-2", title: "Calm" })] });
    renderBoard();

    expect(await screen.findAllByLabelText("Waiting on you")).toHaveLength(1);
  });

  it("says where the work happens: a branch, a read of the base, or no disk", async () => {
    mockIpc({
      items: [
        item({ workspace: { kind: "git-worktree", mode: "isolated", label: "eo/EO-1" } }),
        item({ id: "t2", key: "EO-2", workspace: { kind: "git-worktree", mode: "read", label: "main" } }),
        item({ id: "t3", key: "EO-3", workspace: { kind: "none", mode: null, label: null } }),
      ],
    });
    renderBoard();

    expect(await screen.findByText("eo/EO-1")).toBeInTheDocument();
    expect(screen.getByTitle("reads the repository, changes nothing")).toHaveTextContent("main");
    expect(screen.getByText("no disk")).toBeInTheDocument();
  });

  it("surfaces blocked dependencies, the run's state and an urgent priority", async () => {
    mockIpc({ items: [item({ openDependencyCount: 2, latestRunStatus: "awaiting_input", priority: 2 })] });
    renderBoard();

    const todo = await column("To Do");
    expect(within(todo).getByTitle(/Blocked by 2/)).toBeInTheDocument();
    expect(within(todo).getByText("Paused")).toBeInTheDocument();
    expect(within(todo).getByText("Urgent")).toBeInTheDocument();
  });

  it("names the agent that picked it up, or says nobody has", async () => {
    mockIpc({ items: [item({ assigneeName: "Nova", latestRunStatus: "running" }), item({ id: "t2", key: "EO-2", stepId: "review" })] });
    renderBoard();

    expect(await screen.findByText("Nova")).toBeInTheDocument();
    expect(within(await column("Review")).getByText("Unassigned")).toBeInTheDocument();
  });

  it("shows a person who has it by first name, and offers no Claim then", async () => {
    mockIpc({ items: [item({ stepId: "pending_approval", assigneePerson: { id: "p2", name: "Anna Ruiz" } })] });
    renderBoard();

    expect(await screen.findByText("Anna")).toBeInTheDocument();
    expect(screen.getByTitle("Anna Ruiz has this")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Claim/ })).not.toBeInTheDocument();
  });

  it("offers no Claim to somebody outside the group a step waits on (EO-368)", async () => {
    const invoke = mockIpc({
      items: [item({ stepId: "pending_approval", claimable: true })],
      authority: { group: { id: "g-design", name: "Design" }, holder: null, you: "outsider" },
    });
    renderBoard();

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "items:authority")).toBe(true));
    // Let the answer land, so this is the answer's doing and not the wait's.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.getAllByText("EO-1").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Claim/ })).not.toBeInTheDocument();
  });

  it("offers Claim to a member of that group", async () => {
    mockIpc({
      items: [item({ stepId: "pending_approval", claimable: true })],
      authority: { group: { id: "g-design", name: "Design" }, holder: null, you: "member" },
    });
    renderBoard();

    expect(await screen.findByRole("button", { name: "Claim EO-1" })).toBeInTheDocument();
  });

  it("claims one nobody has taken, without opening it", async () => {
    const invoke = mockIpc({ items: [item({ stepId: "pending_approval", claimable: true })] });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: "Claim EO-1" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:claim", { itemId: "t1" }));
    expect(where()).toBe("/pipelines/default");
  });

  it("sends one claim for a double click, and says Claiming… until it lands (EO-562)", async () => {
    const invoke = mockIpc({ items: [item({ stepId: "pending_approval", claimable: true })] });
    let land: (value: unknown) => void = () => {};
    const answered = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel: string, payload: unknown) =>
      channel === "items:claim" ? new Promise<never>((resolve) => (land = resolve as (value: unknown) => void)) : answered(channel, payload),
    );
    renderBoard();

    const button = await screen.findByRole("button", { name: "Claim EO-1" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.doubleClick(button);

    const pending = await screen.findByRole("button", { name: "Claiming EO-1" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveTextContent("Claiming…");
    expect(invoke.mock.calls.filter((call: unknown[]) => call[0] === "items:claim")).toHaveLength(1);

    await act(async () => land({ ok: true, data: {} }));
    expect(await screen.findByRole("button", { name: "Claim EO-1" })).toBeEnabled();
    expect(invoke.mock.calls.filter((call: unknown[]) => call[0] === "items:claim")).toHaveLength(1);
  });

  it("names what filed it on its hover, with the cost — nought included — and nothing for a person's", async () => {
    mockIpc({
      items: [
        item({ origin: { jobId: "j1", jobName: "Monday report", trigger: "schedule", occurrenceId: "o1", firedAt: 1, costCents: 0 } }),
        item({ id: "t2", key: "EO-2", title: "Typed by hand" }),
      ],
    });
    renderBoard();

    expect((await screen.findByText("Rate limit the API")).closest("article")).toHaveAttribute("title", 'From job "Monday report" · 0¢');
    expect(screen.getByText("Typed by hand").closest("article")).not.toHaveAttribute("title");
  });

  it("carries its parent as a linked tag", async () => {
    mockIpc({ items: [item({ parentId: "f1", parentKey: "EO-7", parentTitle: "Rate limiting" })] });
    renderBoard();

    expect(await screen.findByTitle("Part of Rate limiting")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EO-7" })).toHaveAttribute("href", "/items/f1");
  });

  it("wears the preview banner, the queued mark and the older version's chip only where they apply", async () => {
    mockIpc({
      items: [item({ preview: true }), item({ id: "t2", key: "EO-2", title: "Moved offline", pipelineVersion: 6 }), item({ id: "t3", key: "EO-3", title: "Settled" })],
      queuedItemIds: ["t2"],
    });
    renderBoard();

    expect(await screen.findByRole("note", { name: "Preview" })).toHaveTextContent("Preview. Nothing was sent, nothing cost money.");
    const moved = (await screen.findByText("Moved offline")).closest("article")!;
    await waitFor(() => expect(within(moved).getByText("queued")).toBeInTheDocument());
    expect(moved).toHaveClass("border-dashed");
    expect(within(moved).getByText("v6")).toBeInTheDocument();
    const settled = screen.getByText("Settled").closest("article")!;
    expect(settled).not.toHaveClass("border-dashed");
    expect(settled.textContent).not.toContain("v6");
  });
});

describe("a card on a step that keeps checking (EO-699)", () => {
  const NOW = new Date("2026-01-01T12:00:00Z").getTime();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const watching = (overrides: Partial<NonNullable<ItemSummary["watch"]>> = {}): ItemSummary["watch"] => ({
    stepId: "todo",
    startedAt: NOW - 3 * 24 * HOUR,
    lastCheckedAt: NOW - 20 * HOUR,
    nextCheckAt: NOW + 4 * HOUR,
    giveUpAt: null,
    checks: 3,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says when it checks next instead of Done, and counts down on its own", async () => {
    mockIpc({ items: [item({ title: "Watching", latestRunStatus: "succeeded", watch: watching({ nextCheckAt: NOW + 3 * MINUTE }) })] });
    renderBoard();

    const card = (await screen.findByText("Watching")).closest("article")!;
    expect(within(card).getByText("Next check in 3m")).toBeInTheDocument();
    expect(within(card).getByText("Last check 20h ago · OK")).toBeInTheDocument();
    expect(within(card).queryByText("Done")).not.toBeInTheDocument();
    expect(within(card).getByText("Next check in 3m").parentElement!.title).toMatch(/^Last checked /);

    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });
    expect(within(card).getByText("Next check in 2m")).toBeInTheDocument();
    expect(within(card).getByText("Last check 20h ago · OK")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(within(card).getByText("Checking now")).toBeInTheDocument();
  });

  it("says it has not checked yet, that it is checking, and that checks are failing", async () => {
    mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", title: "Fresh", latestRunStatus: null, watch: watching({ lastCheckedAt: null, nextCheckAt: NOW + 3 * MINUTE, checks: 0 }) }),
        item({ id: "t2", key: "EO-2", title: "Busy", latestRunStatus: "running", watch: watching({ lastCheckedAt: NOW - HOUR }) }),
        item({ id: "t3", key: "EO-3", title: "Broken", latestRunStatus: "failed", watch: watching({ nextCheckAt: NOW + 5 * MINUTE, consecutiveFailures: 2, lastError: "rate limit exceeded" }) }),
      ],
    });
    renderBoard();

    const fresh = (await screen.findByText("Fresh")).closest("article")!;
    expect(within(fresh).getByText("Next check in 3m")).toBeInTheDocument();
    expect(within(fresh).getByText("Not checked yet")).toBeInTheDocument();

    const busy = screen.getByText("Busy").closest("article")!;
    expect(within(busy).getByText("Checking now")).toBeInTheDocument();
    expect(within(busy).getByText("Last check 1h ago · OK")).toBeInTheDocument();
    expect(within(busy).getByText("Checking now").parentElement!.querySelector(".bg-running")).not.toBeNull();

    const broken = screen.getByText("Broken").closest("article")!;
    expect(within(broken).getByText("Check failed · retrying in 5m").parentElement!.querySelector(".bg-paused")).not.toBeNull();
    const detail = within(broken).getByText("2 in a row · rate limit exceeded");
    expect(detail.className.split(" ")).toContain("truncate");
  });

  it("keeps a card on a step that runs once as it was, and a watching card's surface as its work state says", async () => {
    mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", title: "Once", latestRunStatus: "succeeded" }),
        item({ id: "t2", key: "EO-2", title: "Watching", latestRunStatus: "succeeded", watch: watching() }),
      ],
    });
    renderBoard();

    const once = (await screen.findByText("Once")).closest("article")!;
    const watched = screen.getByText("Watching").closest("article")!;
    expect(within(once).getByText("Done")).toBeInTheDocument();
    expect(within(once).queryByText(/Next check|Last check/)).not.toBeInTheDocument();
    expect(watched.className).toBe(once.className);
  });
});

/**
 * State on work (EO-687): how the work on a column is going, as a load
 * strip and a line of counts under its head, and as each card's tint
 * and edge. Failed, waiting, in review, running, idle — in that order.
 */
describe("how the work on a column is going (EO-687)", () => {
  const strip = (region: HTMLElement) =>
    [...region.querySelector("[data-load-strip]")!.children].map((segment) => [segment.getAttribute("data-state"), (segment as HTMLElement).style.flexGrow]);
  const summary = (region: HTMLElement) => [...within(region).getByLabelText("By state").children].map((entry) => entry.textContent);

  it("shows a load strip and a summary that match the column's cards, and an empty strip and no summary on an empty column", async () => {
    mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", title: "Broke", latestRunStatus: "failed" }),
        item({ id: "t2", key: "EO-2", title: "Asked", latestRunStatus: "awaiting_input" }),
        item({ id: "t3", key: "EO-3", title: "Escalated", needsAttention: true }),
        item({ id: "t4", key: "EO-4", title: "Working", latestRunStatus: "running" }),
        item({ id: "t5", key: "EO-5", title: "Not yet" }),
        item({ id: "t6", key: "EO-6", title: "Judged", stepId: "review", stepName: "Review", latestRunStatus: "running" }),
      ],
    });
    renderBoard();

    // Counts every item on the step, the fifth past "Show more" too.
    const todo = await column("To Do");
    await within(todo).findByText("Not yet");
    expect(within(todo).queryByText("Broke")).not.toBeInTheDocument();
    expect(strip(todo)).toEqual([
      ["danger", "1"],
      ["paused", "2"],
      ["running", "1"],
      ["idle", "1"],
    ]);
    expect(summary(todo)).toEqual(["1 failed", "2 waiting", "1 running", "1 idle"]);
    const head = within(todo).getByRole("heading", { level: 2, name: "To Do" }).closest("header")!;
    expect(head).toContainElement(within(todo).getByLabelText("By state"));
    const line = within(todo).getByLabelText("By state");
    expect(line.className.split(" ")).toEqual(expect.arrayContaining(["text-[11px]", "text-ink-muted"]));
    expect([...line.children].map((entry) => entry.firstElementChild!.className.split(" ").find((token) => token.startsWith("bg-")))).toEqual([
      "bg-danger",
      "bg-paused",
      "bg-running",
      "bg-idle",
    ]);
    const bar = todo.querySelector("[data-load-strip]")!;
    expect(bar.className.split(" ")).toContain("h-[4px]");
    expect([...bar.children].map((segment) => segment.className.split(" ").find((token) => token.startsWith("bg-")))).toEqual([
      "bg-danger",
      "bg-paused",
      "bg-running",
      "bg-idle",
    ]);

    // A running review is in review.
    const review = await column("Review");
    expect(strip(review)).toEqual([["reviewing", "1"]]);
    expect(summary(review)).toEqual(["1 in review"]);

    // An empty column: one bar in the line colour, and nothing to count.
    const empty = await column("Pending Approval");
    expect(strip(empty)).toEqual([["empty", ""]]);
    expect(empty.querySelector("[data-load-strip]")!.firstElementChild!.className.split(" ")).toEqual(expect.arrayContaining(["bg-line", "flex-1"]));
    expect(within(empty).queryByLabelText("By state")).not.toBeInTheDocument();
  });

  it("tints a running, an in-review, a waiting and a failed card with a 1px edge in its state, and leaves an idle one plain", async () => {
    mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", title: "Broke", latestRunStatus: "failed" }),
        item({ id: "t2", key: "EO-2", title: "Escalated", needsAttention: true }),
        item({ id: "t3", key: "EO-3", title: "Working", latestRunStatus: "running" }),
        item({ id: "t4", key: "EO-4", title: "Not yet" }),
        item({ id: "t5", key: "EO-5", title: "Judged", stepId: "review", stepName: "Review" }),
      ],
    });
    renderBoard();

    const card = async (title: string) => (await screen.findByText(title)).closest("article")!;
    for (const [title, colour, mix] of [
      ["Broke", "--color-danger", 14],
      ["Escalated", "--color-paused", 11],
      ["Judged", "--color-reviewing", 11],
      ["Working", "--color-running", 11],
    ] as const) {
      const classes = (await card(title)).className.split(" ");
      expect(classes, title).toEqual(
        expect.arrayContaining([
          "border",
          `bg-[color:color-mix(in_oklab,var(--color-canvas-hover),var(${colour})_${mix}%)]`,
          `border-[color:color-mix(in_oklab,var(--color-line),var(${colour})_60%)]`,
        ]),
      );
      expect(classes, title).not.toContain("bg-canvas-hover");
      expect(classes, title).not.toContain("border-line");
    }
    const idle = (await card("Not yet")).className;
    expect(idle.split(" ")).toEqual(expect.arrayContaining(["border", "border-line", "bg-canvas-hover", "hover:bg-canvas-active"]));
    expect(idle).not.toContain("color-mix");

    // Nothing keeps the old inset ring or a left bar.
    for (const title of ["Broke", "Escalated", "Judged", "Working", "Not yet"]) {
      const classes = (await card(title)).className;
      expect(classes, title).not.toContain("shadow-[inset");
      expect(classes, title).not.toMatch(/border-l-/);
    }
    // Waiting on you is still said, to a screen reader.
    expect(within(await card("Escalated")).getByLabelText("Waiting on you")).toBeInTheDocument();
  });

  it("writes a branch in the subtle ink and a high priority in ink, with an arrow, not amber", async () => {
    mockIpc({ items: [item({ priority: 1, workspace: { kind: "git-worktree", mode: "isolated", label: "eo/EO-1" } })] });
    renderBoard();

    const branch = (await screen.findByText("eo/EO-1")).parentElement!;
    expect(branch.className.split(" ")).toEqual(expect.arrayContaining(["font-mono", "text-ink-subtle"]));
    expect(branch.className).not.toContain("text-reviewing");

    const high = screen.getByText("High");
    expect(high.className.split(" ")).toEqual(expect.arrayContaining(["text-ink", "font-semibold"]));
    expect(high.className).not.toContain("text-paused");
    expect(high.querySelector("svg")).not.toBeNull();
  });
});

describe("the project's word on the board", () => {
  it("leaves the type off the cards when the project has one word for its work", async () => {
    mockIpc();
    renderBoard();

    const card = (await screen.findByText("Rate limit the API")).closest("article")!;
    expect(within(card).queryByText("Story")).not.toBeInTheDocument();
  });

  it("names the type on every card when it has two", async () => {
    mockIpc({ registry: TWO_PACKS, items: [item(), item({ id: "t2", key: "EO-2", type: "case", typeLabel: "Case", title: "Refund not received", stepId: "review" })] });
    renderBoard();

    await waitFor(() => expect(within(screen.getByText("Rate limit the API").closest("article")!).getByText("Story")).toBeInTheDocument());
    expect(within(screen.getByText("Refund not received").closest("article")!).getByText("Case")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter items…")).toBeInTheDocument();
  });
});

describe("moving a card to another column", () => {
  it("confirms before moving, and carries the optional comment", async () => {
    const invoke = mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");

    const dialog = screen.getByRole("dialog", { name: "Move EO-1 to Review?" });
    expect(within(dialog).queryByText(/Active work will be cancelled/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("items:move", expect.anything());

    fireEvent.change(within(dialog).getByLabelText("Comment to post with the move"), { target: { value: "Please check the retry path." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move ticket" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("items:move", { itemId: "t1", toStepId: "review", cancelActiveRun: false, comment: "Please check the retry path." }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each(["running", "queued"])("warns, and cancels a %s run only on the destructive button", async (latestRunStatus) => {
    const invoke = mockIpc({ items: [item({ latestRunStatus })] });
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");

    const dialog = screen.getByRole("dialog", { name: "Move EO-1 to Review?" });
    expect(within(dialog).getByText(/Active work will be cancelled/)).toBeInTheDocument();
    expect(within(dialog).getByText(/work it has not committed may be lost/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel the run and move" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:move", { itemId: "t1", toStepId: "review", cancelActiveRun: true, comment: "" }));
  });

  it("treats a run awaiting input as nothing to cancel", async () => {
    const invoke = mockIpc({ items: [item({ latestRunStatus: "awaiting_input" })] });
    renderBoard();

    await screen.findAllByText("EO-1");
    drop("t1", "review");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).getByRole("button", { name: "Move ticket" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:move", expect.objectContaining({ cancelActiveRun: false })));
  });

  it.each(["Cancel", "Close dialog"])("moves nothing when dismissed with %s", async (button) => {
    const invoke = mockIpc({ items: [item({ latestRunStatus: "running" })] });
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: button }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("items:move", expect.anything());
  });

  it("does nothing for a drop on the card's own column, or on nothing", async () => {
    mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "todo");
    drop("t1", null);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("means a card's column when dropped on a card", async () => {
    mockIpc({ items: [item(), item({ id: "t2", key: "EO-2", stepId: "review", title: "Other" })] });
    renderBoard();

    await screen.findByText("EO-2");
    drop("t1", "t2");

    expect(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).toBeInTheDocument();
  });
});

describe("a dropped card while its move is confirmed (EO-564)", () => {
  /** The card titled `title`, found in the column named `name`, or null. */
  async function cardIn(name: string, title = "Rate limit the API") {
    return within(await column(name)).queryByText(title)?.closest("article") ?? null;
  }

  /** A move that answers only when the test lets it. */
  function holdTheMove(invoke: ReturnType<typeof mockIpc>, answer: () => { ok: boolean; data?: unknown; error?: unknown }) {
    let release = () => {};
    const landed = new Promise<void>((resolve) => (release = resolve));
    // Every call still reaches `invoke`, so it records them; only the move's answer waits.
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      const answered = await invoke(channel, payload);
      if (channel !== "items:move") return answered;
      await landed;
      return answer();
    }) as never;
    return () => act(() => release());
  }

  it("is drawn in the column it was dropped on, marked as moving, from the drop until the move lands", async () => {
    const list = [item()];
    const invoke = mockIpc({ items: list });
    const release = holdTheMove(invoke, () => {
      // The record has it on Review by the time the move answers.
      list[0] = item({ stepId: "review", stepName: "Review" });
      return { ok: true, data: { moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null } };
    });
    renderBoard();

    await screen.findByText("EO-1");
    expect(await cardIn("To Do")).not.toBeNull();
    drop("t1", "review");

    // The dialog is open and nothing has been sent, but the card is where it was dropped.
    const dialog = screen.getByRole("dialog", { name: "Move EO-1 to Review?" });
    expect(await cardIn("To Do")).toBeNull();
    const moving = (await cardIn("Review"))!;
    expect(moving).toHaveAttribute("aria-busy", "true");
    expect(within(moving).getByText("moving…")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("items:move", expect.anything());

    // Applying: still there, still marked.
    fireEvent.click(within(dialog).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:move", expect.objectContaining({ itemId: "t1", toStepId: "review" })));
    expect(within(dialog).getByRole("button", { name: "Moving…" })).toBeDisabled();
    expect(await cardIn("To Do")).toBeNull();
    expect(await cardIn("Review")).toHaveAttribute("aria-busy", "true");

    // Landed: the record has it on Review, and it is no longer marked.
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(async () => expect(await cardIn("Review")).toHaveAttribute("aria-busy", "false"));
    expect(within((await cardIn("Review"))!).queryByText("moving…")).not.toBeInTheDocument();
    expect(await cardIn("To Do")).toBeNull();
  });

  it.each(["Cancel", "Close dialog"])("goes back to its own column when the dialog is dismissed with %s", async (button) => {
    mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");
    expect(await cardIn("Review")).not.toBeNull();

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: button }));

    expect(await cardIn("Review")).toBeNull();
    const back = (await cardIn("To Do"))!;
    expect(back).toHaveAttribute("aria-busy", "false");
    expect(within(back).queryByText("moving…")).not.toBeInTheDocument();
  });

  it("goes back to its own column when the move is refused, and the dialog says why", async () => {
    const problem = "Review is not a step this item can be moved to.";
    const invoke = mockIpc();
    const release = holdTheMove(invoke, () => ({ ok: true, data: { moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem } }));
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:move", expect.anything()));
    expect(await cardIn("Review")).not.toBeNull();

    release();

    expect(await within(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).findByText(problem)).toBeInTheDocument();
    expect(await cardIn("Review")).toBeNull();
    expect(await cardIn("To Do")).toHaveAttribute("aria-busy", "false");
  });

  it("is drawn where it was dropped again for each retry, and goes back each time it is not moved", async () => {
    const problem = "Review is not a step this item can be moved to.";
    const list = [item()];
    const invoke = mockIpc({ items: list });
    // Each attempt waits on its own release; the answers are refused, failed, then moved.
    const answers: (() => { ok: boolean; data?: unknown; error?: unknown })[] = [
      () => ({ ok: true, data: { moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem } }),
      () => ({ ok: false, error: { code: "INTERNAL", message: "The database is locked." } }),
      () => {
        list[0] = item({ stepId: "review", stepName: "Review" });
        return { ok: true, data: { moved: true, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem: null } };
      },
    ];
    let release = () => {};
    window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
      const answered = await invoke(channel, payload);
      if (channel !== "items:move") return answered;
      await new Promise<void>((resolve) => (release = resolve));
      return answers.shift()!();
    }) as never;
    const moves = () => invoke.mock.calls.filter((call) => call[0] === "items:move").length;
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");
    // The one dialog, kept open across every attempt.
    const dialog = screen.getByRole("dialog", { name: "Move EO-1 to Review?" });

    // First attempt: refused.
    fireEvent.click(within(dialog).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(moves()).toBe(1));
    expect(await cardIn("Review")).toHaveAttribute("aria-busy", "true");
    act(() => release());
    expect(await within(dialog).findByText(problem)).toBeInTheDocument();
    expect(await cardIn("Review")).toBeNull();
    expect(await cardIn("To Do")).toHaveAttribute("aria-busy", "false");

    // Retry: drawn in Review again, marked, while it applies — then it fails and goes back.
    fireEvent.click(within(dialog).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(moves()).toBe(2));
    expect(await cardIn("To Do")).toBeNull();
    const retrying = (await cardIn("Review"))!;
    expect(retrying).toHaveAttribute("aria-busy", "true");
    expect(within(retrying).getByText("moving…")).toBeInTheDocument();
    act(() => release());
    expect(await within(dialog).findByText("The database is locked.")).toBeInTheDocument();
    expect(await cardIn("Review")).toBeNull();
    expect(await cardIn("To Do")).toHaveAttribute("aria-busy", "false");

    // Third attempt: drawn in Review while it applies, and it lands.
    fireEvent.click(within(dialog).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(moves()).toBe(3));
    expect(await cardIn("To Do")).toBeNull();
    expect(await cardIn("Review")).toHaveAttribute("aria-busy", "true");
    act(() => release());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(async () => expect(await cardIn("Review")).toHaveAttribute("aria-busy", "false"));
    expect(await cardIn("To Do")).toBeNull();
  });

  it("goes back to its own column when the move fails, and the dialog says why", async () => {
    const invoke = mockIpc();
    const release = holdTheMove(invoke, () => ({ ok: false, error: { code: "INTERNAL", message: "The database is locked." } }));
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "review");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).getByRole("button", { name: "Move ticket" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:move", expect.anything()));
    expect(await cardIn("Review")).not.toBeNull();

    release();

    expect(await within(screen.getByRole("dialog", { name: "Move EO-1 to Review?" })).findByText("The database is locked.")).toBeInTheDocument();
    expect(await cardIn("Review")).toBeNull();
    expect(await cardIn("To Do")).toHaveAttribute("aria-busy", "false");
  });
});

describe("handing a card to another pipeline (EO-71)", () => {
  const chooser = () => screen.getByLabelText("Pipeline to send the ticket to");

  it("asks which pipeline in the dialog, offering every one but this and any nothing enters", async () => {
    mockIpc({ pipelines: [...TWO, pipeline({ id: "docs", name: "Docs", entryStepId: null })] });
    renderBoard();

    await screen.findByText("EO-1");
    fireEvent.click(screen.getByRole("button", { name: "Send EO-1 to another pipeline" }));

    const dialog = screen.getByRole("dialog", { name: "Send EO-1 to another pipeline?" });
    expect(chooser()).toHaveValue("");
    expect(Array.from(chooser().querySelectorAll("option")).map((option) => option.textContent)).toEqual(["Choose a pipeline…", "Merge", "Release"]);
    expect(within(dialog).getByRole("button", { name: "Send ticket" })).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("preselects the only destination there is", async () => {
    mockIpc({ pipelines: [THIS_PIPELINE, pipeline()] });
    renderBoard();

    await screen.findByText("EO-1");
    fireEvent.click(screen.getByRole("button", { name: "Send EO-1 to another pipeline" }));

    expect(screen.getByRole("dialog", { name: "Send EO-1 to Merge?" })).toBeInTheDocument();
    expect(chooser()).toHaveValue("merge");
  });

  it("lands the item where the chosen pipeline takes work in, with the comment", async () => {
    const invoke = mockIpc({ pipelines: TWO });
    renderBoard();

    await screen.findByText("EO-1");
    fireEvent.click(screen.getByRole("button", { name: "Send EO-1 to another pipeline" }));
    fireEvent.change(chooser(), { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Comment to post with the move"), { target: { value: "Looks right to me." } });
    fireEvent.click(screen.getByRole("button", { name: "Send ticket" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("items:move", { itemId: "t1", toStepId: "rl_cut", toPipelineId: "release", cancelActiveRun: false, comment: "Looks right to me." }),
    );
  });

  it("offers nothing when there is nowhere to send it", async () => {
    mockIpc({ pipelines: [THIS_PIPELINE, pipeline({ entryStepId: null })] });
    renderBoard();

    await screen.findByText("EO-1");
    expect(screen.queryByRole("button", { name: /to another pipeline$/ })).not.toBeInTheDocument();
    pickUp("t1");
    expect(within(screen.getByRole("complementary", { name: "Paused tasks" })).queryByRole("region", { name: "Send to another pipeline" })).not.toBeInTheDocument();
  });

  it("keeps the comment and the choice, and asks the harder question, when a run started meanwhile", async () => {
    let blocked = true;
    const invoke = mockIpc({
      pipelines: TWO,
      onMove: () => {
        const answer = { moved: !blocked, cancelledRunId: null, blockedByActiveRun: blocked, commentId: null, problem: null };
        blocked = false;
        return answer;
      },
    });
    renderBoard();

    await screen.findByText("EO-1");
    fireEvent.click(screen.getByRole("button", { name: "Send EO-1 to another pipeline" }));
    fireEvent.change(chooser(), { target: { value: "release" } });
    fireEvent.change(screen.getByLabelText("Comment to post with the move"), { target: { value: "Ship it." } });
    fireEvent.click(screen.getByRole("button", { name: "Send ticket" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the run and send" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("items:move", { itemId: "t1", toStepId: "rl_cut", toPipelineId: "release", cancelActiveRun: true, comment: "Ship it." }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and says why when the move is refused", async () => {
    const problem = '"Merge It" is a step of "Merge", not of "Release".';
    mockIpc({ pipelines: [THIS_PIPELINE, pipeline()], onMove: () => ({ moved: false, cancelledRunId: null, blockedByActiveRun: false, commentId: null, problem }) });
    renderBoard();

    await screen.findByText("EO-1");
    fireEvent.click(screen.getByRole("button", { name: "Send EO-1 to another pipeline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send ticket" }));

    expect(await within(screen.getByRole("dialog", { name: "Send EO-1 to Merge?" })).findByText(problem)).toBeInTheDocument();
  });

  it("offers a hand-off target beside the hold one for the length of a drag, opening the same dialog", async () => {
    mockIpc({ pipelines: TWO });
    renderBoard();

    await screen.findByText("EO-1");
    pickUp("t1");
    const rail = screen.getByRole("complementary", { name: "Paused tasks" });
    expect(within(rail).getByText("Drop a task here to hold it")).toBeInTheDocument();
    expect(within(rail).getByRole("region", { name: "Send to another pipeline" })).toBeInTheDocument();

    drop("t1", "pipeline-hand-off");
    expect(screen.getByRole("dialog", { name: "Send EO-1 to another pipeline?" })).toBeInTheDocument();
    expect(chooser()).toHaveValue("");
  });
});

/**
 * Asserts the text sits in a three-line clamp nothing lifts: Tailwind's
 * line-clamp-3 sets display:-webkit-box, and a display utility beside it
 * (`block`, `flex`, …) overrides that and lets the text run on (EO-692).
 */
function expectClamped(text: HTMLElement) {
  const clamp = text.closest(".line-clamp-3");
  expect(clamp, "the text is inside a line-clamp-3").not.toBeNull();
  const display = ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "table", "flow-root"];
  expect(clamp!.className.split(/\s+/).filter((token) => display.includes(token))).toEqual([]);
}

describe("the paused rail", () => {
  it("lists work waiting on a person, with why and who is waiting, and links keys in the reason without opening the card", async () => {
    mockIpc({
      items: [item({ latestRunStatus: "awaiting_input", title: "Durable comments" }), item({ id: "t2", key: "EO-2", title: "Dependency" })],
      inboxItems: [
        {
          commentId: "c1",
          itemId: "t1",
          itemKey: "EO-1",
          itemTypeLabel: "Story",
          itemTitle: "Durable comments",
          itemState: "todo",
          authorName: "Implementer",
          body: "Waiting on EO-2",
          kind: "question",
          options: null,
          createdAt: 1,
          blocking: true,
          waitingOn: { who: "you" },
          preview: false,
        },
      ],
    });
    renderBoard();

    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    expect(within(rail).getByRole("heading", { name: "Paused" })).toBeInTheDocument();
    expect(within(rail).getByText("1")).toBeInTheDocument();
    expect(within(rail).getByText(/Paused .* ago/)).toBeInTheDocument();
    expect(await within(rail).findByText("you — Implementer is waiting")).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: "Resume EO-1" })).not.toBeInTheDocument();

    const reasonLink = await within(rail).findByRole("link", { name: "EO-2" });
    expect(reasonLink).toHaveAttribute("href", "/items/t2");
    fireEvent.click(reasonLink);
    expect(within(rail).getByRole("link", { name: "View all paused tasks" })).toHaveAttribute("href", "/inbox");
  });

  it("clamps a long reason to three lines, so the rail cannot squeeze the board (EO-692)", async () => {
    const body = `Could not start: branch 'eo/rate-limit' is already checked out at ${"/home/someone/.eo/worktrees/a-very-long-path".repeat(12)}`;
    mockIpc({
      items: [item({ latestRunStatus: "awaiting_input" })],
      inboxItems: [
        {
          commentId: "c1",
          itemId: "t1",
          itemKey: "EO-1",
          itemTypeLabel: "Story",
          itemTitle: "Rate limit the API",
          itemState: "todo",
          authorName: "EO",
          body,
          kind: "question",
          options: null,
          createdAt: 1,
          blocking: true,
          waitingOn: { who: "you" },
          preview: false,
        },
      ],
    });
    renderBoard();

    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    expectClamped(await within(rail).findByText(body));
  });

  /**
   * The rail beside the board is drawn as one of its columns (EO-681):
   * the same raised, hairline-outlined panel and the same heading, and
   * its cards titled the way a board card is — by the same classes, so
   * the two cannot drift apart.
   */
  it("is drawn as a board column, its cards titled as a board card's are", async () => {
    mockIpc({
      items: [
        item({ id: "t1", latestRunStatus: "awaiting_input", title: "Durable comments" }),
        item({ id: "t3", key: "EO-3", title: "On to do", stepId: "todo", stepName: "To Do" }),
      ],
    });
    renderBoard();

    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    const todo = await column("To Do");
    const panel = within(rail).getByRole("heading", { level: 2, name: "Paused" }).closest("div")!.parentElement!;
    for (const token of ["rounded-[14px]", "border"]) {
      expect(todo.className.split(" "), token).toContain(token);
      expect(panel.className.split(" "), token).toContain(token);
    }
    // Its colours are its own: amber-edged (EO-688, held by the next test), as To Do's are its agent's lane (EO-685).
    const tokens = (element: Element) => element.className.split(" ").filter((token) => token.startsWith("text-[") || token.startsWith("font-"));
    expect(tokens(within(rail).getByRole("heading", { level: 2, name: "Paused" }))).toEqual(tokens(within(todo).getByRole("heading", { level: 2, name: "To Do" })));

    const boardTitle = await within(todo).findByText("On to do");
    const railTitle = within(rail).getByText("Durable comments");
    expect(tokens(railTitle)).toEqual(["text-[13.5px]", "font-medium"]);
    expect(tokens(railTitle)).toEqual(tokens(boardTitle));
    // Its card is one step up from the panel, on a hairline, as a board card is.
    const railCard = railTitle.closest("article")!;
    const boardCard = boardTitle.closest("article")!;
    for (const token of ["border", "border-line", "bg-canvas-hover", "hover:bg-canvas-active"]) {
      expect(boardCard.className.split(" "), token).toContain(token);
      expect(railCard.className.split(" "), token).toContain(token);
    }
  });

  /**
   * Waiting on you owns its region (EO-688): one amber-tinted, amber-edged
   * panel with its count in amber, and inside it the amber is a dot before
   * each paused or held line and the icons, never the words.
   */
  it("is one amber-edged panel whose paused and held lines are ink, each after an amber dot", async () => {
    mockIpc({
      items: [
        item({ id: "t1", latestRunStatus: "awaiting_input", title: "Asked" }),
        item({ id: "t2", key: "EO-2", title: "Parked", heldAt: Date.now() }),
      ],
    });
    renderBoard();

    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    const heading = within(rail).getByRole("heading", { level: 2, name: "Paused" });
    const panel = heading.closest("div")!.parentElement!;
    const classes = panel.className.split(" ");
    expect(classes).toContain("bg-[color:color-mix(in_oklab,var(--color-canvas-raised),var(--color-paused)_7%)]");
    expect(classes).toContain("border-[color:color-mix(in_oklab,var(--color-line),var(--color-paused)_45%)]");
    expect(classes).not.toContain("bg-canvas-raised");
    expect(classes).not.toContain("border-line");

    const count = within(rail).getByText("2");
    expect(count.className.split(" ")).toEqual(expect.arrayContaining(["text-paused", "font-semibold"]));

    for (const line of [within(rail).getByText(/^Paused .* ago$/), within(rail).getByText(/^Held by you .* ago$/)]) {
      expect(line.className.split(" ")).toContain("text-ink-muted");
      const dot = line.firstElementChild!;
      expect(dot).toHaveAttribute("data-paused-dot");
      expect(dot).toHaveAttribute("aria-hidden", "true");
      expect(dot.className.split(" ")).toEqual(expect.arrayContaining(["h-1.5", "w-1.5", "rounded-full", "bg-paused"]));
    }

    // No words in the rail are amber; only the icons and the dots are.
    for (const element of rail.querySelectorAll(".text-paused")) {
      if (element === count) continue;
      expect(element.tagName.toLowerCase(), element.outerHTML).toBe("svg");
    }
    expect(within(rail).getByText("Held").className.split(" ")).toContain("text-ink-muted");

    // Neither card keeps the 2px amber left bar.
    for (const title of ["Asked", "Parked"]) {
      const card = within(rail).getByText(title).closest("article")!;
      expect(card.className).not.toMatch(/border-l-/);
    }
  });

  describe("how long ago (EO-570)", () => {
    const NOW = new Date("2026-01-01T12:00:00Z").getTime();
    const MINUTE = 60_000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("advances on its own, from when it paused and from when it was held", async () => {
      mockIpc({
        items: [
          item({ latestRunStatus: "awaiting_input", title: "Asked", updatedAt: NOW - 4 * MINUTE, stepEnteredAt: NOW - 30 * MINUTE }),
          item({ id: "t2", key: "EO-2", title: "Parked", heldAt: NOW - 9 * MINUTE, updatedAt: NOW - MINUTE }),
        ],
      });
      renderBoard();

      const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
      expect(within(rail).getByText("Paused 4m ago")).toBeInTheDocument();
      expect(within(rail).getByText("Held by you 9m ago")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(MINUTE);
      });

      expect(within(rail).getByText("Paused 5m ago")).toBeInTheDocument();
      expect(within(rail).getByText("Held by you 10m ago")).toBeInTheDocument();
    });
  });

  it("is not there while nothing is paused, appears for a drag, and goes when the drag ends or is cancelled", async () => {
    mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();

    pickUp("t1");
    expect(screen.getByRole("complementary", { name: "Paused tasks" })).toBeInTheDocument();
    drop("t1", "todo");
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();

    pickUp("t1");
    cancelDrag();
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();
  });

  it("comes back for a drag after being hidden, and stays hidden after it", async () => {
    mockIpc({ items: [item({ latestRunStatus: "awaiting_input" }), item({ id: "t2", key: "EO-2", title: "Second" })] });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: "Hide paused tasks" }));
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();
    pickUp("t2");
    expect(screen.getByRole("complementary", { name: "Paused tasks" })).toBeInTheDocument();
    drop("t2", "todo");
    expect(screen.queryByRole("complementary", { name: "Paused tasks" })).not.toBeInTheDocument();
  });

  it("holds a card dropped on it once confirmed, and shows the note it was held with", async () => {
    const items = [item()];
    const invoke = mockIpc({
      items,
      onHold: () => {
        items[0] = item({ heldAt: Date.now() });
        return { held: true, cancelledRunId: null, blockedByActiveRun: false, commentId: "c1" };
      },
    });
    renderBoard();

    await screen.findByText("EO-1");
    pickUp("t1");
    drop("t1", "paused-rail");
    const dialog = screen.getByRole("dialog", { name: "Hold EO-1?" });
    expect(invoke).not.toHaveBeenCalledWith("items:hold", expect.anything());
    fireEvent.change(within(dialog).getByLabelText("Comment to post with the hold"), { target: { value: "Waiting on the API decision." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Hold ticket" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:hold", { itemId: "t1", cancelActiveRun: false, comment: "Waiting on the API decision." }));
    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    await waitFor(() => expect(within(rail).getByText("Your note")).toBeInTheDocument());
    expectClamped(within(rail).getByText("Waiting on the API decision."));
    expect(within(rail).getByText("Held")).toBeInTheDocument();
    expect(within(await column("To Do")).queryByText("EO-1")).not.toBeInTheDocument();
  });

  it("re-asks as the destructive hold when a run started between the drop and the click", async () => {
    let blocked = true;
    const invoke = mockIpc({
      onHold: () => {
        const answer = { held: !blocked, cancelledRunId: null, blockedByActiveRun: blocked, commentId: null };
        blocked = false;
        return answer;
      },
    });
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "paused-rail");
    fireEvent.click(screen.getByRole("button", { name: "Hold ticket" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel the run and hold" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:hold", expect.objectContaining({ cancelActiveRun: true })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does nothing when a held card is dropped back on it", async () => {
    mockIpc({ items: [item({ heldAt: 5 })] });
    renderBoard();

    await screen.findByText("EO-1");
    drop("t1", "paused-rail");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("resumes a held card where it is, and says so when a run refuses", async () => {
    const invoke = mockIpc({
      items: [item({ heldAt: Date.now() })],
      onResume: () => ({ resumed: false, cancelledRunId: null, blockedByActiveRun: true }),
    });
    renderBoard();

    const rail = await screen.findByRole("complementary", { name: "Paused tasks" });
    expect(within(rail).getByText("Staying on To Do until you resume it.")).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Resume EO-1" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("items:resume", { itemId: "t1", cancelActiveRun: false }));
    expect(await within(rail).findByText(/A run is in flight on this ticket/)).toBeInTheDocument();
  });
});

describe("narrowing the board", () => {
  it("narrows to a step from the address, says so, publishes it, and widens again", async () => {
    const invoke = mockIpc({
      items: [
        item({ id: "t1", key: "EO-1", stepId: "review", title: "In review" }),
        item({ id: "t2", key: "EO-2", stepId: "review", title: "Also in review" }),
        item({ id: "t3", key: "EO-3", stepId: "todo", title: "Not started" }),
      ],
    });
    renderBoard("/pipelines/default?step=review");

    await screen.findByText("EO-1");
    expect(screen.queryByText("EO-3")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing only what Review holds/)).toHaveTextContent("Showing only what Review holds — 2 items.");
    await waitFor(() => expect(lastFilter(invoke)).toEqual({ text: "", facets: { step: "review" } }));

    fireEvent.click(screen.getByRole("button", { name: "Show the whole board" }));
    expect(where()).toBe("/pipelines/default");
    expect(await screen.findByText("EO-3")).toBeInTheDocument();
    await waitFor(() => expect(lastFilter(invoke)).toEqual({ text: "", facets: {} }));
  });

  it("explains an empty board narrowed to a step that is gone", async () => {
    mockIpc();
    renderBoard("/pipelines/default?step=no-such-step");

    expect(await screen.findByText(/Showing only what a step that is no longer here holds — 0 items\./)).toBeInTheDocument();
  });

  it("narrows to exactly a job's items, names the job, and publishes it", async () => {
    const filed = (id: string, jobId: string, jobName: string, title: string) =>
      item({ id, key: id.toUpperCase(), title, origin: { jobId, jobName, trigger: "schedule", occurrenceId: `o-${id}`, firedAt: 1, costCents: 12 } });
    const invoke = mockIpc({ items: [filed("t1", "job-1", "Monday report", "For 1 June"), filed("t2", "job-2", "Nightly sweep", "Sweep"), item({ id: "t4", key: "EO-4", title: "By hand" })] });
    renderBoard("/pipelines/default?job=job-1");

    await screen.findByText("For 1 June");
    expect(screen.queryByText("Sweep")).not.toBeInTheDocument();
    expect(screen.queryByText("By hand")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing only what "Monday report" filed — 1 item\./)).toBeInTheDocument();
    await waitFor(() => expect(lastFilter(invoke)).toEqual({ text: "", facets: { job: "job-1" } }));
  });

  it("filters by its own search field, and tells the assistant what it is showing", async () => {
    const invoke = mockIpc({ items: [item(), item({ id: "t2", key: "EO-2", title: "Refund the order" })] });
    renderBoard();

    await screen.findByText("Refund the order");
    await waitFor(() => expect(lastFilter(invoke)).toEqual({ text: "", facets: {} }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter the board" }), { target: { value: "rate" } });

    await waitFor(() => expect(screen.queryByText("Refund the order")).not.toBeInTheDocument());
    expect(screen.getByText("Rate limit the API")).toBeInTheDocument();
    await waitFor(() => expect(lastFilter(invoke)).toEqual({ text: "rate", facets: {} }));
  });
});

describe("the column heads", () => {
  const checked = (stepId: string, checks: string[]) => ({ stepId, checks, verifiesAction: checks.length > 0, kindVerifies: true, waitsOn: null });
  const unchecked = (stepId: string, waitsOn: string | null = null) => ({ stepId, checks: [], verifiesAction: false, kindVerifies: false, waitsOn });

  it("say nothing about checks where every step stands on a workspace EO vouches for", async () => {
    mockIpc({ verification: [checked("todo", ["commits", "tests ran"]), unchecked("pending_approval"), checked("review", [])] });
    renderBoard();

    await screen.findByText("EO-1");
    expect(screen.queryByText("EO checks: commits, tests ran")).not.toBeInTheDocument();
  });

  it("all say where they stand once one step works nowhere, and name who approves", async () => {
    mockIpc({
      states: [...STATES, { id: "ask", pipelineId: "default", position: 3, name: "Ask", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false }],
      verification: [checked("todo", ["commits", "tests ran"]), unchecked("pending_approval", "Anna Ruiz"), checked("review", []), unchecked("ask")],
    });
    renderBoard();

    expect(await screen.findByText("EO checks: commits, tests ran")).toBeInTheDocument();
    expect(screen.getByText("Anna Ruiz · approves here")).toBeInTheDocument();
  });

  it("say how often a step that keeps checking checks and when it gives up (EO-456)", async () => {
    mockIpc({
      states: [
        ...STATES,
        { id: "wait", pipelineId: "default", position: 3, name: "Wait", type: "builtin", ownerRole: null, entryAction: "wait_until", instructionsSummary: null, isTerminal: false, watch: { everyMinutes: 1, giveUpAfterHours: 2 } },
      ],
    });
    renderBoard();

    expect(await screen.findByText("Checks every minute · gives up after 2 hours")).toBeInTheDocument();
    expect(screen.getAllByText(/^Checks every/)).toHaveLength(1);
  });

  it("say a step that never gives up never does, instead of a time (EO-571)", async () => {
    mockIpc({
      states: [
        ...STATES,
        {
          id: "wait",
          pipelineId: "default",
          position: 3,
          name: "Wait",
          type: "builtin",
          ownerRole: null,
          entryAction: "wait_until",
          instructionsSummary: null,
          isTerminal: false,
          watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true },
        },
      ],
    });
    renderBoard();

    expect(await screen.findByText("Checks every 5 minutes · never gives up")).toBeInTheDocument();
    expect(screen.queryByText(/gives up after/)).not.toBeInTheDocument();
  });

  it("offer who waits at a human step, and send a group as a group and a person as a person", async () => {
    const invoke = mockIpc({ people: [{ id: "p1", name: "Anna Ruiz" }], groups: [{ id: "g1", name: "Support team" }] });
    renderBoard();

    const picker = await screen.findByLabelText("Who waits at Pending Approval");
    await waitFor(() => expect([...picker.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Nobody in particular", "Anna Ruiz", "Support team"]));
    expect(screen.queryByLabelText("Who waits at To Do")).not.toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "g1" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("steps:setOwner", { stepId: "pending_approval", personId: null, groupId: "g1" }));
    fireEvent.change(picker, { target: { value: "p1" } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("steps:setOwner", { stepId: "pending_approval", personId: "p1", groupId: null }));
  });
});

describe("a board whose pipeline has moved on", () => {
  const UPDATED = {
    version: { id: "v7", pipelineId: "default", number: 7, createdAt: 1, createdBy: "p1", createdByName: "Dana" },
    finishingOn: [{ number: 6, items: 3 }],
  };

  it("says what changed and opens the Changes view on the versions still finishing", async () => {
    mockIpc(UPDATED);
    renderBoard();

    expect(await screen.findByText("Pipeline updated to v7 by Dana · 3 items finish on v6")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View changes" })).toHaveAttribute("href", "/pipelines/default/changes?from=6&to=7");
  });

  it("compares from the oldest version anything is still finishing on", async () => {
    mockIpc({ ...UPDATED, finishingOn: [{ number: 6, items: 1 }, { number: 4, items: 2 }] });
    renderBoard();

    expect(await screen.findByRole("link", { name: "View changes" })).toHaveAttribute("href", "/pipelines/default/changes?from=4&to=7");
  });

  it("draws no banner while nothing is finishing on an older version", async () => {
    mockIpc({ version: UPDATED.version });
    renderBoard();

    await screen.findByText("Rate limit the API");
    expect(screen.queryByText(/Pipeline updated/)).toBeNull();
  });

  it("draws a column for a step only an older version has, with what it holds", async () => {
    mockIpc({ ...UPDATED, ghosts: [{ stepId: "qa", name: "QA", version: 6, holding: 1 }], items: [item({ id: "t9", key: "EO-9", title: "Finishing on QA", stepId: "qa", pipelineVersion: 6 })] });
    renderBoard();

    const ghost = await screen.findByRole("region", { name: "QA (v6) · 1 finishing" });
    expect(within(ghost).getByText("Finishing on QA")).toBeInTheDocument();
  });
});

describe("the board's head", () => {
  it("switches to the graph, and offers no way to the configure screen", async () => {
    mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    const views = screen.getByRole("navigation", { name: "Pipeline views" });
    expect(within(views).getAllByRole("link").map((link) => link.textContent)).toEqual(["Board", "Graph"]);
    expect(within(views).getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Configure" })).toBeNull();
    fireEvent.click(within(views).getByRole("link", { name: "Graph" }));
    expect(where()).toBe("/pipelines/default?view=graph");
  });

  it("carries no Plan button and no add-work caret", async () => {
    mockIpc({ jira: true });
    renderBoard("/pipelines/default", vi.fn());

    await screen.findByText("EO-1");
    expect(screen.queryByRole("button", { name: "Plan in chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan with PO" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More ways to add work" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Import from Jira" })).toBeNull();
  });

  it("says where the work happens and how much is running", async () => {
    mockIpc({ jira: false, items: [item({ latestRunStatus: "running" }), item({ id: "t2", key: "EO-2", latestRunStatus: "running" })] });
    renderBoard();

    expect(await screen.findByText("2 agents running")).toBeInTheDocument();
    expect(await screen.findByText("acme-api")).toBeInTheDocument();
    expect(screen.getByText("trunk")).toBeInTheDocument();
  });

  it("disables Import from Jira, and says why, while no Jira project is connected", async () => {
    mockIpc({ jira: false });
    renderBoard();

    await screen.findByText("acme-api");
    const importing = screen.getByRole("button", { name: "Import from Jira" });
    expect(importing).toBeDisabled();
    expect(importing).toHaveAttribute("title", "No Jira project is connected");
    fireEvent.click(importing);
    expect(screen.queryByRole("dialog", { name: "Pick from Jira" })).toBeNull();
  });

  it("opens the Jira picker from its own button in the head", async () => {
    mockIpc({ jira: true });
    renderBoard();

    await screen.findByText("acme-api");
    const importing = screen.getByRole("button", { name: "Import from Jira" });
    await waitFor(() => expect(importing).toBeEnabled());
    expect(importing).not.toHaveAttribute("title");
    expect(importing.closest("header")).not.toBeNull();
    fireEvent.click(importing);

    expect(await screen.findByRole("dialog", { name: "Pick from Jira" })).toBeInTheDocument();
  });
});

/**
 * A pipeline that sends what a webhook delivers without a person reading
 * it first says so on the board (EO-405) — the chat layout's header,
 * beside the name, as a fact in muted ink.
 */
describe("a pipeline that sends webhook items unread", () => {
  it("states it in the board's header", async () => {
    mockIpc({ pipelines: [THIS_PIPELINE], webhook: { entry: true, unattended: true } });
    renderBoard();

    const statement = await screen.findByText("webhook items sent on unread");
    expect(statement).toBeVisible();
    expect(statement).toHaveAttribute("title", expect.stringContaining("without a person reading them first"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing there while the setting is off, webhook or no webhook", async () => {
    for (const webhook of [{ entry: true, unattended: false }, undefined]) {
      mockIpc({ pipelines: [THIS_PIPELINE], ...(webhook ? { webhook } : {}) });
      const { unmount } = renderBoard();

      await column("Review");
      expect(screen.queryByText(/webhook items/i)).toBeNull();
      unmount();
    }
  });
});

describe("the board's head, for a pipeline made from a template (EO-536)", () => {
  const ORIGIN = { slug: "software-feature-to-merge", title: "Software feature to merge", version: "1.0" };

  it("names the template and its version beside the pipeline's name", async () => {
    mockIpc({ templateStatus: { origin: ORIGIN, updated: null, waiting: null, problem: null } });
    renderBoard();

    const chip = await screen.findByText("From Software feature to merge v1.0");
    expect(chip.closest("header")).not.toBeNull();
  });

  it("says nothing for a pipeline with no origin", async () => {
    mockIpc();
    renderBoard();

    await screen.findByText("EO-1");
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText(/^Update/)).toBeNull();
  });

  it("says Updated to vN with its release notes a click away", async () => {
    mockIpc({ templateStatus: { origin: { ...ORIGIN, version: "1.1" }, updated: { version: "1.1", pipelineVersion: 3, at: 1, notes: "Adds Watching pull request." }, waiting: null, problem: null } });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: /^Updated to v1\.1/ }));
    expect(within(await screen.findByRole("dialog")).getByLabelText("Release notes")).toHaveTextContent("Adds Watching pull request.");
  });

  it("says Update waiting with its count, and opens the conflict's chat once there is one", async () => {
    const invoke = mockIpc({
      templateStatus: {
        origin: ORIGIN,
        updated: null,
        waiting: { conflictId: "c-1", fromVersion: "1.0", toVersion: "1.1", conflicts: 1, problems: 0, chatId: "chat-1", notice: { itemId: "thread-1", commentId: "n-1" } },
        problem: null,
      },
    });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: "Update waiting: 1 conflict — open the assistant chat about it" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("assist:openUpdateConflict", { conflictId: "c-1", commentId: "n-1" }));
  });
});
