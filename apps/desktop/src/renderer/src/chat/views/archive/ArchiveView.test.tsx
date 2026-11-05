import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { NO_GIT_STATE, developerRegistry, toRegistryView, type ItemSummary, type PipelineView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { ArchiveView } from "./ArchiveView";
import { RowsViewport } from "../../kit/testing";

/** The chat layout's archive (`pipeline/Archive.test.tsx` is the model). */

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
    repositoryName: "api",
    projectId: "b1",
    title: "Rate limit the API",
    pipelineId: "default",
    stepId: "ready_to_merge",
    pipelineVersion: null,
    stepName: "ready_to_merge",
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
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderArchive(items: ItemSummary[], at = "/archive", pipelines: PipelineView[] = [], fits?: number) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "items:listArchived") return { ok: true, data: { items } };
    if (channel === "items:list") return { ok: true, data: { items: [] } };
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
    if (channel === "pipelines:list") return { ok: true, data: { pipelines } };
    if (channel === "items:setArchived") return { ok: true, data: { archived: false, problem: null } };
    if (channel === "registry:get") return { ok: true, data: toRegistryView(developerRegistry()) };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

  render(
    <RowsViewport {...(fits === undefined ? {} : { fits })}>
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={[at]}>
            <ViewPublisher>
              <ItemReferenceProvider>
                <ArchiveView />
              </ItemReferenceProvider>
              <Search />
            </ViewPublisher>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
  return calls;
}

function lastFacets(calls: { channel: string; payload: unknown }[]): Record<string, string> {
  const publishes = calls.filter((call) => call.channel === "view:publish");
  return (publishes.at(-1)?.payload as { filter?: { facets?: Record<string, string> } } | undefined)?.filter?.facets ?? {};
}

describe("the archive in the chat layout", () => {
  it("explains itself when nothing has been archived", async () => {
    renderArchive([]);

    expect(await screen.findByText(/Nothing archived yet/)).toBeInTheDocument();
  });

  it("mounts a screenful of a thousand archived rows, not all of them (EO-565)", async () => {
    renderArchive(
      Array.from({ length: 1000 }, (_, index) => item({ id: `t${index}`, key: `EO-${index}`, title: `Row ${index}` })),
      "/archive",
      [],
      15,
    );

    expect(await screen.findByRole("link", { name: "Row 0" })).toBeInTheDocument();
    const mounted = within(screen.getByRole("list", { name: /^Archived / })).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.queryByText("Row 999")).toBeNull();
  });

  it("lists what has been put away, each row linking to its item", async () => {
    renderArchive([item(), item({ id: "t2", key: "EO-2", title: "Cache the results" })]);

    expect(await screen.findByRole("link", { name: "Rate limit the API" })).toHaveAttribute("href", "/items/t1");
    expect(screen.getByText("Cache the results")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EO-1" })).toHaveAttribute("href", "/items/t1");
  });

  it("puts one back", async () => {
    const calls = renderArchive([item()]);

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "items:setArchived")?.payload).toEqual({ itemId: "t1", archived: false }));
  });

  it("holds only the row being restored, until the archive is read again (EO-562)", async () => {
    let shelf = [item(), item({ id: "t2", key: "EO-2", title: "Cache the results" })];
    let land: (value: unknown) => void = () => {};
    const calls = renderArchive(shelf);
    const answered = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "items:listArchived") return { ok: true, data: { items: shelf } };
      if (channel === "items:setArchived") {
        calls.push({ channel, payload });
        return new Promise<never>((resolve) => (land = resolve as (value: unknown) => void));
      }
      return answered(channel as never, payload as never);
    }) as never;

    const row = (title: string) => screen.getByRole("link", { name: title }).closest("li")!;
    await screen.findByRole("link", { name: "Rate limit the API" });
    const restore = within(row("Rate limit the API")).getByRole("button", { name: "Restore" });
    fireEvent.click(restore);
    fireEvent.click(restore);

    expect(await within(row("Rate limit the API")).findByRole("button", { name: "Restoring…" })).toBeDisabled();
    expect(within(row("Cache the results")).getByRole("button", { name: "Restore" })).toBeEnabled();
    expect(calls.filter((call) => call.channel === "items:setArchived")).toHaveLength(1);

    shelf = [item({ id: "t2", key: "EO-2", title: "Cache the results" })];
    await act(async () => land({ ok: true, data: { archived: false, problem: null } }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Rate limit the API" })).not.toBeInTheDocument());
    expect(within(row("Cache the results")).getByRole("button", { name: "Restore" })).toBeEnabled();
  });

  it("names the tab in the project's own word, and publishes the tab it is on", async () => {
    const calls = renderArchive([]);

    await screen.findByRole("tab", { name: /Tickets/ });
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "items" }));

    fireEvent.click(screen.getByRole("tab", { name: /Pipelines/ }));
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "pipelines" }));
  });

  it("lists the pipelines somebody deleted", async () => {
    renderArchive([], "/archive", [
      { id: "old", projectId: "b1", name: "Old flow", icon: null, entryStepId: "todo", position: 0, archivedAt: 1_700_000_000_000 } as PipelineView,
      { id: "live", projectId: "b1", name: "Still here", icon: null, entryStepId: "todo", position: 1, archivedAt: null } as PipelineView,
    ]);

    fireEvent.click(await screen.findByRole("tab", { name: /Pipelines/ }));

    expect(await screen.findByText("Old flow")).toBeInTheDocument();
    expect(screen.queryByText("Still here")).not.toBeInTheDocument();
  });
});

describe("the archive narrowed by the address", () => {
  it("shows only one step's rows, says so, and publishes the facet", async () => {
    const calls = renderArchive(
      [
        item({ id: "t1", key: "EO-1", stepId: "review", stepName: "Review", title: "Put away in review" }),
        item({ id: "t2", key: "EO-2", stepId: "todo", stepName: "To Do", title: "Put away elsewhere" }),
      ],
      "/archive?step=review",
    );

    expect(await screen.findByText("Put away in review")).toBeInTheDocument();
    expect(screen.queryByText("Put away elsewhere")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing only what Review holds — 1 archived item\. Restore it to move it on the board\./)).toBeInTheDocument();
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "items", step: "review" }));
  });

  it("explains an empty narrowed list, and widens again on request", async () => {
    renderArchive([item({ id: "t2", key: "EO-2", stepId: "todo", stepName: "To Do", title: "Put away elsewhere" })], "/archive?step=review");

    expect(await screen.findByText("Nothing on that step is in the archive.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing archived yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show the whole archive" }));

    expect(await screen.findByText("Put away elsewhere")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("");
  });

  it("shows only one job's rows and names the job", async () => {
    const origin = { jobId: "job-1", jobName: "Monday report", trigger: "schedule" as const, occurrenceId: "o1", firedAt: 1, costCents: 12 };
    const calls = renderArchive(
      [
        item({ id: "t1", key: "EO-1", title: "Monday report for 1 June", origin }),
        item({ id: "t2", key: "EO-2", title: "Filed by somebody else", origin: { ...origin, jobId: "job-2", jobName: "Nightly sweep" } }),
        item({ id: "t3", key: "EO-3", title: "Typed by hand" }),
      ],
      "/archive?job=job-1",
    );

    expect(await screen.findByText("Monday report for 1 June")).toBeInTheDocument();
    expect(screen.queryByText("Filed by somebody else")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing only what "Monday report" filed — 1 archived item\./)).toBeInTheDocument();
    await waitFor(() => expect(lastFacets(calls)).toEqual({ tab: "items", job: "job-1" }));
  });
});
