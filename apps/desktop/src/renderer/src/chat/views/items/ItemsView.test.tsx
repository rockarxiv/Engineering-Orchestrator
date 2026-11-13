import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SPEC_SHAPE, NO_GIT_STATE, developerRegistry, toRegistryView, type ItemSummary, type PipelineView, type RegistryView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { ItemsView } from "./ItemsView";
import { RowsViewport } from "../../kit/testing";

/** Every item on the project (the classic `ItemList` and its tests are the model). */

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
    repositoryId: "r1",
    repositoryName: "api",
    projectId: "p1",
    title: "Rate limit the API",
    pipelineId: "pipe-1",
    stepId: "step-impl",
    pipelineVersion: null,
    stepName: "Implementer",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1_700_000_000_000,
    stepEnteredAt: 1_700_000_000_000,
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

const PIPELINES: PipelineView[] = [
  { id: "pipe-1", projectId: "p1", name: "Delivery", icon: null, entryStepId: "step-impl", position: 0, archivedAt: null },
  { id: "pipe-2", projectId: "p1", name: "Reports", icon: null, entryStepId: "step-draft", position: 1, archivedAt: null },
];

const DEVELOPER: RegistryView = toRegistryView(developerRegistry());

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function renderList(
  items: ItemSummary[],
  options: { registry?: RegistryView; onCall?: (channel: string, payload: unknown) => void; jira?: boolean; fits?: number } = {},
) {
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    options.onCall?.(channel, payload);
    if (channel === "items:list") return { ok: true, data: { items } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "pipelines:list") return { ok: true, data: { pipelines: PIPELINES } };
    if (channel === "projects:list")
      return { ok: true, data: { projects: [{ id: "p1", name: "EO", keyPrefix: "EO", jiraProjectId: null, repositoryIds: ["r1"], itemCount: items.length }], activeProjectId: "p1" } };
    if (channel === "registry:get") return { ok: true, data: options.registry ?? DEVELOPER };
    if (channel === "repositories:list")
      return {
        ok: true,
        data: {
          repositories: [
            {
              id: "r1",
              name: "api",
              keyPrefix: "EO",
              repoPath: "/tmp/a",
              baseBranch: "main",
              testCommand: null,
              lintCommand: null,
              buildCommand: null,
              itemCount: 1,
              jira: { baseUrl: null, flavour: null, projectKey: options.jira ? "KAN" : null, email: null, featureIssueType: null, storyIssueType: null, fields: null, createByDefault: true, credentialsConfigured: options.jira ?? false },
            },
          ],
        },
      };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

  render(
    <RowsViewport {...(options.fits === undefined ? {} : { fits: options.fits })}>
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items"]}>
            <ViewPublisher>
              <ItemReferenceProvider>
                <ItemsView />
              </ItemReferenceProvider>
            </ViewPublisher>
            <CurrentRoute />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
}

/** The rows' titles, in order. */
function titles(): string[] {
  const list = screen.getByRole("list", { name: /Every ticket on/ });
  return within(list)
    .getAllByRole("listitem")
    .map((row) => row.querySelector("a")?.textContent ?? "");
}

describe("the items view", () => {
  it("mounts a screenful of a thousand rows, not all of them (EO-565)", async () => {
    renderList(
      Array.from({ length: 1000 }, (_, index) => item({ id: `t${index}`, key: `EO-${index}`, title: `Row ${index}`, updatedAt: 1_700_000_000_000 + index })),
      { fits: 15 },
    );

    // Newest first: the top of the list is mounted, the bottom is not.
    expect(await screen.findByText("Row 999")).toBeInTheDocument();
    const mounted = within(screen.getByRole("list", { name: /^Every / })).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.queryByText("Row 0")).toBeNull();
  });

  describe("the time column (EO-570)", () => {
    const NOW = new Date("2026-01-01T12:00:00Z").getTime();
    const MINUTE = 60_000;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("advances on its own, from when the item last changed", async () => {
      renderList([item({ title: "Ticking", updatedAt: NOW - 4 * MINUTE, stepEnteredAt: NOW - 30 * MINUTE })]);
      const row = (await screen.findByText("Ticking")).closest("li")!;
      expect(within(row).getByText("4m")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(MINUTE);
      });

      expect(within(row).getByText("5m")).toBeInTheDocument();
    });
  });

  it("lists every item on the project, under the project's word for them, and opens one", async () => {
    renderList([item(), item({ id: "t2", key: "EO-2", title: "Weekly report", pipelineId: "pipe-2", stepName: "Draft" })]);

    expect(await screen.findByRole("heading", { name: "Tickets" })).toBeInTheDocument();
    expect(await screen.findByText("Weekly report")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Rate limit the API"));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1");
  });

  it("searches on what the row shows, from its own search field", async () => {
    renderList([item({ git: { ...NO_GIT_STATE, branch: "eo/EO-1-rate-limit" } }), item({ id: "t2", key: "EO-2", title: "Cache the results" })]);

    fireEvent.change(await screen.findByRole("searchbox", { name: "Search" }), { target: { value: "rate-limit" } });
    await waitFor(() => expect(screen.queryByText("Cache the results")).not.toBeInTheDocument());
    expect(screen.getByText("Rate limit the API")).toBeInTheDocument();
  });

  it("combines filters, counts what shows, and clears them all", async () => {
    renderList([
      item({ repositoryId: "r2", repositoryName: "web", latestRunStatus: "running" }),
      item({ id: "t2", key: "EO-2", title: "Cache the results", repositoryId: "r2", repositoryName: "web" }),
      item({ id: "t3", key: "EO-3", title: "Retry on 429", latestRunStatus: "running" }),
    ]);

    await screen.findByText("Retry on 429");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "r2" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "running" } });
    await waitFor(() => expect(screen.queryByText("Retry on 429")).not.toBeInTheDocument());
    expect(screen.queryByText("Cache the results")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(await screen.findByText("Retry on 429")).toBeInTheDocument();
  });

  it("narrows to what is waiting on you", async () => {
    renderList([item({ needsAttention: true }), item({ id: "t2", key: "EO-2", title: "Cache the results" })]);

    fireEvent.click(await screen.findByRole("button", { name: "Waiting on you" }));
    await waitFor(() => expect(screen.queryByText("Cache the results")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Waiting on you" })).toHaveAttribute("aria-pressed", "true");
  });

  it("filters by the container a piece of work belongs to, under that container's name", async () => {
    renderList([item({ parentId: "f1", parentTitle: "Rate limiting" }), item({ id: "t2", key: "EO-2", title: "Cache the results" })]);

    await screen.findByText("Cache the results");
    fireEvent.change(await screen.findByLabelText("Feature"), { target: { value: "f1" } });
    await waitFor(() => expect(screen.queryByText("Cache the results")).not.toBeInTheDocument());
  });

  it("orders newest first, by any column, and reverses", async () => {
    renderList([item({ title: "Beta", updatedAt: 3 }), item({ id: "t2", key: "EO-2", title: "Alpha", updatedAt: 1 }), item({ id: "t3", key: "EO-3", title: "Gamma", updatedAt: 2 })]);

    await waitFor(() => expect(titles()[0]).toContain("Beta"));
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "title" } });
    await waitFor(() => expect(titles().map((title) => title.includes("Alpha"))).toEqual([true, false, false]));
    fireEvent.click(screen.getByRole("button", { name: /reverse the order/ }));
    await waitFor(() => expect(titles()[0]).toContain("Gamma"));
  });

  it("publishes the filter and the ordering exactly as the classic list does", async () => {
    const publishes: { filter?: unknown; sort?: unknown }[] = [];
    renderList([item()], { onCall: (channel, payload) => channel === "view:publish" && publishes.push(payload as { filter?: unknown; sort?: unknown }) });

    fireEvent.change(await screen.findByRole("searchbox", { name: "Search" }), { target: { value: "rate" } });
    fireEvent.click(screen.getByRole("button", { name: "Waiting on you" }));

    await waitFor(() =>
      expect(publishes.at(-1)).toMatchObject({
        filter: {
          text: "rate",
          facets: { type: "all", parent: "all", pipeline: "all", step: "all", repository: "all", status: "all", attention: "true" },
        },
        sort: "updated:desc",
      }),
    );
  });

  it("says so when the filters exclude everything, and explains an empty project", async () => {
    renderList([]);
    expect(await screen.findByText(/No tickets on this project yet/)).toBeInTheDocument();
  });

  it("says nothing matches rather than looking empty", async () => {
    renderList([item()]);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search" }), { target: { value: "nothing matches this" } });
    expect(await screen.findByText("Nothing matches these filters.")).toBeInTheDocument();
  });

  it("names each row's type beside its key, where the project's work goes by more than one name", async () => {
    const twoPacks: RegistryView = {
      ...DEVELOPER,
      itemTypes: [...DEVELOPER.itemTypes, { packSlug: "support", slug: "case", label: "Case", plural: "Cases", container: false, specShape: EMPTY_SPEC_SHAPE, actionOverrides: {} }],
      packs: [...(DEVELOPER.packs ?? []), { slug: "support", item: "Case", items: "Cases", results: {} }],
    };
    renderList([item(), item({ id: "t2", key: "EO-2", type: "case", typeLabel: "Case", title: "Refund not received" })], { registry: twoPacks });

    expect(await screen.findByRole("heading", { name: "Items" })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByText("EO-2").closest("[data-testid=item-key]")!).getByText("Case")).toBeInTheDocument());
    expect(within(screen.getByText("EO-1").closest("[data-testid=item-key]")!).getByText("Story")).toBeInTheDocument();
  });

  it("plans in the conversation, and imports from Jira only where Jira is set up", async () => {
    renderList([item()]);
    await screen.findByText("Rate limit the API");
    expect(screen.queryByRole("button", { name: "Import from Jira" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/chat");
  });

  it("offers the Jira import on a project whose repository is connected", async () => {
    renderList([item()], { jira: true });
    expect(await screen.findByRole("button", { name: "Import from Jira" })).toBeInTheDocument();
  });
});
