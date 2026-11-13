import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import {
  EMPTY_SPEC_SHAPE,
  NO_GIT_STATE,
  developerRegistry,
  toRegistryView,
  type InboxItem,
  type ItemSummary,
  type RegistryView,
} from "@eo/core";
import { createQueryClient } from "./query/client";
import { registryKey } from "./query/hooks";
import { ItemReferenceProvider } from "./chat/conversation/ItemReferenceProvider";
import { ViewPublisher } from "./shared/view/ViewPublisher";
import { ChatRail } from "./chat/ChatRail";
import { ArchiveView } from "./chat/views/archive/ArchiveView";
import { InboxView } from "./chat/views/inbox/InboxView";
import { ItemsView } from "./chat/views/items/ItemsView";
import { RowsViewport } from "./chat/kit/testing";

/**
 * Vocabulary across the screens that span pipelines (EO-309,
 * `ARCHITECTURE.md`, "What a pack labels"), in the chat layout: the
 * rail's places, the archive, the inbox and the project's items view.
 *
 * Two projects, and the story is the difference between them.
 *
 * **The developer project is the acceptance criterion in its strongest
 * form**: "no visible string differs from today". The developer pack's
 * word for its collection is "Tickets", and its word for one of them is
 * "ticket"; asserted here as literals, screen by screen, rather than
 * against the vocabulary, because a test that computed the expected
 * word from the same function the screen computed it from would agree
 * with any answer.
 *
 * **The two-pack project is what the story is for.** A support pack
 * ships a "Case" beside the developer pack's "Story", and from that
 * moment there is no word that is both: the chrome neutralises to
 * "item", and every cross-pipeline row says which of the two it is.
 *
 * **The rows say the concrete type's label, not the pack's word.** The
 * scope and AC2 could be read either way — "shows the type label"
 * against "reads 'Case' or 'Ticket' beside its key" — and it was asked
 * and answered: label the concrete type. So a developer row in a mixed
 * project reads "Story". "Ticket" is the pack's word for the
 * *collection*, and it goes on the rail's place and the archive's tab
 * when the developer pack is the only one there.
 *
 * **And it goes beside the key on every surface**, including the items
 * view, whose rows already carry the type's slug further along and do
 * not use it for this. These are one row drawn several ways, and
 * somebody scanning for "which of these is a case" should find the
 * answer in the same place every time.
 *
 * Some of the claims are proven where the view they are about is
 * tested, and are not repeated here:
 *
 * - the board's cards carry no type label with one pack, and name it on
 *   every card with two — `chat/views/board/BoardView.test.tsx`, "the
 *   project's word on the board";
 * - the items view heads a two-pack project "Items" and reads each
 *   row's label beside its key — `chat/views/items/ItemsView.test.tsx`,
 *   "names each row's type beside its key, where the project's work
 *   goes by more than one name".
 */

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

const STEPS = [
  { id: "todo", pipelineId: "default", position: 0, name: "To Do", type: "agent", ownerRole: "implementer", entryAction: "implement", instructionsSummary: null, isTerminal: false },
  { id: "review", pipelineId: "default", position: 1, name: "Review", type: "agent", ownerRole: "reviewer", entryAction: "review", instructionsSummary: null, isTerminal: false },
];

const PIPELINES = [{ id: "default", projectId: "p1", name: "Delivery", icon: null, entryStepId: "todo", position: 0, archivedAt: null }];

/** `registry:get` for a project whose only pack is the one EO ships. */
const DEVELOPER: RegistryView = toRegistryView(developerRegistry());

/**
 * And for a project that also has a support pack.
 *
 * Built from the developer answer rather than beside it, so the two
 * differ in exactly one thing — a second pack's type and a second
 * pack's word — and nothing this file asserts can be an artefact of two
 * fixtures having drifted apart.
 */
const TWO_PACKS: RegistryView = {
  ...DEVELOPER,
  itemTypes: [
    ...DEVELOPER.itemTypes,
    { packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} },
  ],
  packs: [...(DEVELOPER.packs ?? []), { slug: "support", item: "Case", items: "Cases", results: {} }],
};

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
    repositoryId: null,
    repositoryName: null,
    projectId: "p1",
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
    updatedAt: NOW - 5 * 60_000,
    stepEnteredAt: NOW - 5 * 60_000,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    openDependencyGates: [],
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

/** The second pack's item: a case, on the same board as the story. */
const CASE = item({ id: "t2", key: "EO-2", type: "case", typeLabel: "Case", title: "Refund not received", stepId: "review", stepName: "Review" });

function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    commentId: "c1",
    itemId: "t1",
    itemKey: "EO-1",
    itemTitle: "Rate limit the API",
    itemTypeLabel: "Story",
    itemState: "todo",
    authorName: "Implementer",
    body: "Which limit should I use?",
    kind: "question",
    options: null,
    createdAt: NOW - 60_000,
    blocking: true,
    waitingOn: { who: "you" },
    preview: false,
    ...overrides,
  };
}

function mockIpc(registry: RegistryView, items: ItemSummary[], inbox: InboxItem[]) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case "registry:get":
        return { ok: true, data: registry };
      case "items:list":
        return { ok: true, data: { items: [...items] } };
      case "items:listArchived":
        return { ok: true, data: { items: [...items] } };
      case "pipelineSteps:list":
        return { ok: true, data: { steps: STEPS, routes: [] } };
      case "pipelines:list":
        return { ok: true, data: { pipelines: PIPELINES } };
      case "projects:list":
        return { ok: true, data: { projects: [{ id: "p1", name: "EO", keyPrefix: "EO", jiraProjectId: null, repositoryIds: [], itemCount: items.length }], activeProjectId: "p1" } };
      case "jobs:list":
        return { ok: true, data: { jobs: [] } };
      case "agents:list":
        return { ok: true, data: { agents: [] } };
      case "settings:get":
        return { ok: true, data: { doNotDisturb: false } };
      case "inbox:list":
        return { ok: true, data: { items: inbox, summary: { openCount: inbox.length, blockingCount: inbox.length, everythingBlocked: inbox.length > 0 } } };
      default:
        return { ok: true, data: {} };
    }
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
}

/** Where the router is, so following a place can be seen to arrive. */
function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function mount(children: React.ReactNode, at: string): QueryClient {
  const client = createQueryClient();
  render(
    <RowsViewport>
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[at]}>
            <ViewPublisher>
              <ItemReferenceProvider>{children}</ItemReferenceProvider>
            </ViewPublisher>
            <CurrentRoute />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
  return client;
}

/**
 * Waits for the project's registry to have answered — this project's,
 * under the key `useRegistry` holds it by once the active project is
 * known, rather than the first answer asked before it was.
 *
 * Before it has, every screen's word is the core's "Items" on every
 * project — so a two-pack case that asserted "Items" without waiting
 * would pass on a screen that had not heard of either pack.
 */
async function registryArrived(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.getQueryCache().find({ queryKey: [...registryKey, "p1"] })?.state.status).toBe("success"));
}

/**
 * The places behind the rail's gear, opened once the registry has
 * answered.
 *
 * The rail has no row of its own for the project's items: they are the
 * first of the places behind "More places", and that entry is the one
 * whose word is the pack's rather than EO's. Nothing else on the rail
 * says a pack's word, so nothing on it shows when the registry has
 * arrived.
 */
async function openPlaces(client: QueryClient): Promise<HTMLElement> {
  await registryArrived(client);
  fireEvent.click(within(await screen.findByRole("navigation", { name: "Main" })).getByRole("button", { name: "More places" }));
  return screen.getByRole("menu", { name: "Places" });
}

/** The archive's one row, by its title. */
function archivedRow(title: string): HTMLElement {
  return screen.getByRole("link", { name: title }).closest("li")!;
}

/**
 * The line of an inbox row that carries its key.
 *
 * The row's button is a sibling of what is drawn, laid over the whole of
 * it, so the row is the button's parent and the key line is wherever the
 * key is.
 */
function inboxKeyLine(itemKey: string, title: string): HTMLElement {
  const row = screen.getByRole("button", { name: `Select ${itemKey}: ${title}` }).parentElement!;
  return within(row).getByText(itemKey).parentElement!;
}

describe("a project whose only pack is the developer pack", () => {
  /**
   * The rail, the archive tab and the project's list all name the same
   * collection, and on this project they name it what they always have.
   */
  it("calls its work what it always has, in the rail", async () => {
    mockIpc(DEVELOPER, [item()], []);

    const client = mount(<ChatRail onNewPipeline={() => {}} />, "/chat");

    const places = await openPlaces(client);
    fireEvent.click(within(places).getByRole("menuitem", { name: "Tickets" }));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items");
  });

  it("puts its work away under the word it files it under", async () => {
    mockIpc(DEVELOPER, [item()], []);

    mount(<ArchiveView />, "/archive");

    // The tab's count is a span of its own beside the word; jsdom joins
    // the two without a space a browser would not draw either.
    expect(await screen.findByRole("tab", { name: /^Tickets\s*1$/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Archived tickets" })).toBeInTheDocument();

    // And the row beneath it carries the key and the step, and nothing
    // between them: one pack means one word, and a "Story" under a tab
    // that already said "Tickets" is not information. The key line
    // rather than the whole row, because the rest of the row ends in a
    // date — a test about the runner's locale. This line is where a type
    // label would land, and its whole text is frozen here.
    const row = archivedRow("Rate limit the API");
    expect(within(row).queryByText("Story")).not.toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "EO-1" }).parentElement).toHaveTextContent(/^EO-1To Do$/);
  });

  // The heading alone is `ItemsView.test.tsx`'s "lists every item on the
  // project, under the project's word for them"; what is here is the
  // rest of the row, which nothing else holds on a one-pack project.
  it("heads the project's own list with the same word, and adds nothing beside the key", async () => {
    mockIpc(DEVELOPER, [item()], []);

    mount(<ItemsView />, "/items");

    expect(await screen.findByRole("heading", { name: "Tickets" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Every ticket on EO" })).toBeInTheDocument();
    // Nothing has appeared beside the key: one pack means one word, and
    // it is already on the heading above. The whole of what is beside
    // the key, so this would fail on anything added into it.
    expect(screen.getByText("EO-1").closest("[data-testid=item-key]")).toHaveTextContent(/^EO-1$/);
    // The row's details have always shown the slug, which is also what
    // the Type filter matches. Unchanged here.
    expect(within(screen.getByRole("listitem")).getByText("story")).toBeInTheDocument();
  });

  it("asks its questions in the same words, and its rows carry no second one", async () => {
    mockIpc(DEVELOPER, [item()], [inboxItem()]);

    mount(<InboxView />, "/inbox");

    await screen.findByText("Everything is waiting on you.");
    expect(screen.getByText("No ticket can move until you answer below — the agents have nothing else to work on.")).toBeInTheDocument();

    // The row's key line: the key, who asked, and who it waits on —
    // nothing between the key and the author.
    const line = inboxKeyLine("EO-1", "Rate limit the API");
    expect(within(line).queryByText("Story")).not.toBeInTheDocument();
    expect(line).toHaveTextContent(/^EO-1·Implementer·Waiting on you/);

    // The pane beside it, which the design counts as the inbox's row
    // template too: the same word, in the same three places.
    expect(screen.getByText("This ticket's run ended waiting for your reply. Nothing on it moves until you answer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ticket context")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open ticket" })).toBeInTheDocument();
  });

  // The board's cards: `chat/views/board/BoardView.test.tsx`, "leaves the
  // type off the cards when the project has one word for its work".
});

describe("a project that also has a support pack's Case", () => {
  it("gives up the developer word in the rail", async () => {
    mockIpc(TWO_PACKS, [item(), CASE], []);

    const client = mount(<ChatRail onNewPipeline={() => {}} />, "/chat");

    const places = await openPlaces(client);
    expect(within(places).queryByRole("menuitem", { name: "Tickets" })).not.toBeInTheDocument();
    fireEvent.click(within(places).getByRole("menuitem", { name: "Items" }));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items");
  });

  it("counts its archive in items, and says what each row is", async () => {
    mockIpc(TWO_PACKS, [item(), CASE], []);

    await registryArrived(mount(<ArchiveView />, "/archive"));

    expect(await screen.findByRole("tab", { name: /^Items\s*2$/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Archived items" })).toBeInTheDocument();

    // Beside the key, on the line that carries it.
    const keyLine = (title: string, key: string) => within(archivedRow(title)).getByRole("link", { name: key }).parentElement!;
    expect(within(keyLine("Rate limit the API", "EO-1")).getByText("Story")).toBeInTheDocument();
    expect(within(keyLine("Refund not received", "EO-2")).getByText("Case")).toBeInTheDocument();
  });

  // The board's cards: `chat/views/board/BoardView.test.tsx`, "names the
  // type on every card when it has two".

  it("names it on every inbox row", async () => {
    mockIpc(TWO_PACKS, [item(), CASE], [inboxItem({ itemId: "t2", itemKey: "EO-2", itemTitle: "Refund not received", itemTypeLabel: "Case" })]);

    await registryArrived(mount(<InboxView />, "/inbox"));

    await screen.findByRole("button", { name: "Select EO-2: Refund not received" });
    expect(within(inboxKeyLine("EO-2", "Refund not received")).getByText("Case")).toBeInTheDocument();

    // And the chrome around it has stopped using a word that would be
    // wrong for half the list — the banner, and the pane beside the row.
    expect(screen.getByText("No item can move until you answer below — the agents have nothing else to work on.")).toBeInTheDocument();
    expect(screen.getByText("This item's run ended waiting for your reply. Nothing on it moves until you answer.")).toBeInTheDocument();
    expect(screen.getByLabelText("Item context")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open item" })).toBeInTheDocument();
  });

  /**
   * The search-result surface, and the one place the label could
   * plausibly have lived somewhere of its own — every row already says
   * its type's slug, further along its details.
   *
   * It does not live there. The design asks for the label *beside the
   * key*, and `ItemsView.test.tsx` ("names each row's type beside its
   * key, where the project's work goes by more than one name") holds it
   * there, under a heading that says "Items". What is left to say here
   * is that the slug stays where it was, saying what it always said,
   * because that is what the Type filter matches and what the sort
   * orders by — and that the list itself has stopped saying "ticket".
   */
  it("keeps each row's slug in its details, beside the label at its key", async () => {
    mockIpc(TWO_PACKS, [item(), CASE], []);

    await registryArrived(mount(<ItemsView />, "/items"));

    const list = await screen.findByRole("list", { name: "Every item on EO" });
    const row = (title: string) => within(list).getByText(title).closest("li")!;

    expect(within(row("Rate limit the API")).getByText("story")).toBeInTheDocument();
    expect(within(row("Refund not received")).getByText("case")).toBeInTheDocument();
  });
});
