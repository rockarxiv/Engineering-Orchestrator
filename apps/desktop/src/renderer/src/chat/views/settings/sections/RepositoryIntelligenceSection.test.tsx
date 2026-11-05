import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { RepositoryIndexGroup, RepositoryIndexView } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { RepositoryIntelligenceSection } from "./RepositoryIntelligenceSection";

/**
 * Settings → Repository Intelligence in the chat layout (EO-141, EO-148,
 * EO-154), asserted as `Settings.test.tsx` asserts the classic section —
 * above all, that the implementation's name never reaches the screen
 * outside Advanced.
 */

type Call = { channel: string; payload: unknown };

function index(overrides: Partial<RepositoryIndexView> = {}): RepositoryIndexView {
  return {
    id: "idx-1",
    workspaceId: "p1",
    itemId: "t1",
    itemKey: "EO-1",
    provider: "codewiki",
    indexPath: "/home/dev/.eo/worktrees/EO-1/.codewiki",
    status: "ready",
    indexedCommitSha: "abc123def456789",
    indexedAt: Date.UTC(2026, 7, 20, 9, 30),
    updatedAt: Date.UTC(2026, 7, 20, 9, 30),
    providerVersion: "0.2.1",
    errorMessage: null,
    lastSyncDurationMs: null,
    lastSyncChangedFiles: null,
    lastIndexDurationMs: null,
    indexSizeBytes: null,
    workspacePath: "/home/dev/.eo/worktrees/EO-1",
    inUse: false,
    ...overrides,
  };
}

function group(indexes: RepositoryIndexView[], name = "the repo"): RepositoryIndexGroup {
  return { repositoryId: "p1", repositoryName: name, indexes };
}

function renderSection(intelligence: { enabled?: boolean; repositories?: RepositoryIndexGroup[] } = {}) {
  const calls: Call[] = [];
  let config = { enabled: intelligence.enabled ?? false, provider: "codewiki" };
  let repositories = intelligence.repositories ?? [];
  const fallback = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "repositoryIntelligence:getConfig") return { ok: true, data: { ...config, repositories } };
    if (channel === "repositoryIntelligence:setConfig") {
      config = { ...config, ...(payload as Partial<typeof config>) };
      return { ok: true, data: { ...config, repositories } };
    }
    if (
      channel === "repositoryIntelligence:initializeRepositoryIndex" ||
      channel === "repositoryIntelligence:syncRepositoryIndex" ||
      channel === "repositoryIntelligence:rebuildRepositoryIndex"
    ) {
      const id = (payload as { id: string }).id;
      repositories = repositories.map((entry) => ({
        ...entry,
        indexes: entry.indexes.map((held) =>
          held.id === id ? { ...held, status: "ready" as const, errorMessage: null, indexedCommitSha: "fed987cba654321", indexedAt: Date.UTC(2026, 7, 21, 11, 0) } : held,
        ),
      }));
      return { ok: true, data: { ok: true, index: null, problem: null } };
    }
    return fallback(channel as never, payload as never);
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <RepositoryIntelligenceSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const sent = (calls: Call[], channel: string) => calls.filter((call) => call.channel === channel).map((call) => call.payload);

describe("the switch", () => {
  it("is off until someone turns it on, through its own channel", async () => {
    const calls = renderSection();
    const toggle = await screen.findByLabelText("Index repositories for agents");
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/nothing is downloaded/i)).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:setConfig")).toEqual([{ enabled: true }]));
    expect(sent(calls, "settings:set")).toEqual([]);
  });

  it("explains that it is disabled and offers to enable it", async () => {
    const calls = renderSection();
    expect(await screen.findByText(/repository intelligence is disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn on repository intelligence" }));
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:setConfig")).toEqual([{ enabled: true }]));
  });

  it("sends only the key it changed when the provider is picked", async () => {
    const calls = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "codewiki" } });
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:setConfig").at(-1)).toEqual({ provider: "codewiki" }));
  });
});

describe("what it produced", () => {
  it("calls itself Repository Intelligence rather than naming what is underneath", async () => {
    renderSection({ enabled: true, repositories: [group([index({ status: "failed", errorMessage: "CodeWiki 0.2.1 publishes no build for Intel Macs." })])] });

    expect(await screen.findByLabelText("Index repositories for agents")).toBeInTheDocument();
    expect(screen.getAllByText("Repository Intelligence").length).toBeGreaterThan(0);
    expect(screen.queryByText(/codewiki/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(await screen.findByLabelText("Provider")).toHaveValue("codewiki");
    // The indexer's own account, verbatim, only here.
    expect(within(screen.getByLabelText("Advanced")).getByText("CodeWiki 0.2.1 publishes no build for Intel Macs.")).toBeInTheDocument();
  });

  it("shows the status, the indexed revision and when it was last updated, per repository", async () => {
    renderSection({ enabled: true, repositories: [group([index()])] });

    expect(await screen.findByText("the repo")).toBeInTheDocument();
    const card = screen.getByLabelText("Index for EO-1");
    expect(within(card).getByText("Ready")).toBeInTheDocument();
    expect(within(card).getByText("abc123def456")).toBeInTheDocument();
    expect(within(card).getByText(new Date(Date.UTC(2026, 7, 20, 9, 30)).toLocaleString())).toBeInTheDocument();
  });

  it("says a repository has no index rather than leaving it off the list", async () => {
    renderSection({ enabled: true, repositories: [group([])] });
    expect(await screen.findByText(/not indexed/i)).toBeInTheDocument();
  });

  it("names what went wrong in EO's words, and tells a never-built index from a stale one", async () => {
    const branded = "CodeWiki publishes no build for macOS on Intel, so EO could not index this checkout.";
    renderSection({
      enabled: true,
      repositories: [
        group([
          index({ id: "a", itemKey: "EO-1", status: "failed", errorMessage: branded, indexedCommitSha: null, indexedAt: null }),
          index({ id: "b", itemKey: "EO-2", status: "failed", errorMessage: "CodeWiki exited with status 3." }),
        ]),
      ],
    });

    const never = await screen.findByLabelText("Index for EO-1");
    expect(within(never).getByText("Index failed")).toBeInTheDocument();
    expect(within(never).getByText(/has not managed to build an index/i)).toBeInTheDocument();
    expect(within(never).getByText(/agents working on this ticket search the code instead of querying it/i)).toBeInTheDocument();
    expect(within(never).queryByText(branded)).toBeNull();

    const behind = screen.getByLabelText("Index for EO-2");
    expect(within(behind).getByText(/could not bring this index up to date/i)).toBeInTheDocument();
    expect(within(behind).getByText(/it still answers/i)).toBeInTheDocument();
  });
});

describe("upkeep", () => {
  it("refreshes through the sync channel and shows the new status without a restart", async () => {
    const calls = renderSection({ enabled: true, repositories: [group([index()])] });
    fireEvent.click(within(await screen.findByLabelText("Index for EO-1")).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:syncRepositoryIndex")).toEqual([{ id: "idx-1" }]));
    expect(await within(screen.getByLabelText("Index for EO-1")).findByText("fed987cba654")).toBeInTheDocument();
  });

  it("rebuilds a failed index through the rebuild channel", async () => {
    const calls = renderSection({ enabled: true, repositories: [group([index({ status: "failed" })])] });
    fireEvent.click(within(await screen.findByLabelText("Index for EO-1")).getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:rebuildRepositoryIndex")).toEqual([{ id: "idx-1" }]));
    expect(await within(screen.getByLabelText("Index for EO-1")).findByText("Ready")).toBeInTheDocument();
  });

  it("offers to build one that was never built", async () => {
    const calls = renderSection({ enabled: true, repositories: [group([index({ status: "not_indexed", indexedCommitSha: null, indexedAt: null })])] });
    fireEvent.click(within(await screen.findByLabelText("Index for EO-1")).getByRole("button", { name: "Index" }));
    await waitFor(() => expect(sent(calls, "repositoryIntelligence:initializeRepositoryIndex")).toEqual([{ id: "idx-1" }]));
  });

  it("keeps Rebuild live while a run is working in the checkout, and makes Refresh wait", async () => {
    renderSection({ enabled: true, repositories: [group([index({ inUse: true })])] });
    const card = await screen.findByLabelText("Index for EO-1");
    expect(within(card).getByRole("button", { name: "Rebuild" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(within(card).getByText(/rebuilding stops it first/i)).toBeInTheDocument();
  });

  it("offers no Refresh for a failed or stale index, nor any upkeep while a build is in flight", async () => {
    renderSection({
      enabled: true,
      repositories: [
        group([
          index({ id: "f", itemKey: "EO-1", status: "failed" }),
          index({ id: "s", itemKey: "EO-2", status: "stale" }),
          index({ id: "i", itemKey: "EO-3", status: "indexing" }),
        ]),
      ],
    });
    for (const key of ["EO-1", "EO-2", "EO-3"]) {
      const card = await screen.findByLabelText(`Index for ${key}`);
      expect(within(card).queryByRole("button", { name: "Refresh" })).toBeNull();
      expect(within(card).queryByRole("button", { name: "Index" })).toBeNull();
    }
    expect(within(screen.getByLabelText("Index for EO-2")).getByText(/could not bring it up to date when the work moved on/i)).toBeInTheDocument();
    expect(within(screen.getByLabelText("Index for EO-3")).getByText("Indexing repository…")).toBeInTheDocument();
  });
});
