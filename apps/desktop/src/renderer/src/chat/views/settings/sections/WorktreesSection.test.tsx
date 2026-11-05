import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { HeldWorktreeView } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { ItemReferenceProvider } from "../../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../../query/client";
import { WorktreesSection } from "./WorktreesSection";

/** Settings → Git & worktrees in the chat layout, as `Settings.test.tsx` asserts the classic section. */

type Call = { channel: string; payload: unknown };

function worktree(overrides: Partial<HeldWorktreeView> = {}): HeldWorktreeView {
  return {
    itemKey: "EO-1",
    path: "/home/dev/.eo/worktrees/EO-1",
    branch: "eo/EO-1",
    sizeBytes: 4 * 1024 * 1024,
    uncommittedChanges: 0,
    itemState: "ready_to_merge",
    inUse: false,
    repositoryId: "p1",
    repositoryName: "the repo",
    ...overrides,
  };
}

function renderWorktrees(
  held: { worktrees: HeldWorktreeView[]; problem: string | null },
  release: { released: boolean; reason: string | null } = { released: true, reason: null },
  repositories: { id: string; name: string }[] = [{ id: "p1", name: "the repo" }],
) {
  const calls: Call[] = [];
  const fallback = window.eo.ipc.invoke;
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "worktrees:list") return { ok: true, data: held };
    if (channel === "worktrees:release") return { ok: true, data: release };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "items:list") {
      return { ok: true, data: { items: held.worktrees.filter((entry) => entry.itemState !== null).map((entry) => ({ id: `id-${entry.itemKey}`, key: entry.itemKey })) } };
    }
    if (channel === "projects:list") {
      return { ok: true, data: { projects: [{ id: "b1", name: "repo", keyPrefix: "EO", repositoryIds: repositories.map((entry) => entry.id), itemCount: 0, archivedAt: null }], activeProjectId: "b1" } };
    }
    if (channel === "repositories:list") return { ok: true, data: { repositories } };
    return fallback(channel as never, payload as never);
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        {/* The app's catalog of keys, which links them, as the app wraps every screen in. */}
        <ItemReferenceProvider>
          <WorktreesSection />
        </ItemReferenceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const released = (calls: Call[]) => calls.filter((call) => call.channel === "worktrees:release").map((call) => call.payload);

describe("the worktrees section", () => {
  it("shows what each checkout costs and what it totals, with a link to its item", async () => {
    renderWorktrees({ worktrees: [worktree({ itemKey: "EO-1" }), worktree({ itemKey: "EO-2", sizeBytes: 6 * 1024 * 1024 })], problem: null });

    expect(await screen.findByRole("link", { name: "EO-1" })).toHaveAttribute("href", "/items/id-EO-1");
    const panel = screen.getByLabelText("Worktrees");
    expect(within(panel).getByText("4.0 MB")).toBeInTheDocument();
    expect(within(panel).getByText(/10 MB across 2 checkouts/)).toBeInTheDocument();
  });

  it("releases a clean checkout in one click, without forcing", async () => {
    const calls = renderWorktrees({ worktrees: [worktree()], problem: null });
    fireEvent.click(await screen.findByRole("button", { name: "Release" }));
    await waitFor(() => expect(released(calls)).toEqual([{ itemKey: "EO-1", repositoryId: "p1", force: false }]));
  });

  it("makes discarding uncommitted work a second, differently-worded click", async () => {
    const calls = renderWorktrees({ worktrees: [worktree({ uncommittedChanges: 3 })], problem: null });

    await screen.findByText("3 uncommitted changes");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(released(calls)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Discard changes and release" }));
    await waitFor(() => expect(released(calls)).toEqual([{ itemKey: "EO-1", repositoryId: "p1", force: true }]));
  });

  it("can step back from the discard", async () => {
    const calls = renderWorktrees({ worktrees: [worktree({ uncommittedChanges: 1 })], problem: null });
    await screen.findByText("1 uncommitted change");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument();
    expect(released(calls)).toEqual([]);
  });

  it("offers no release for a checkout an agent is working in", async () => {
    renderWorktrees({ worktrees: [worktree({ inUse: true })], problem: null });
    await screen.findByText("in use");
    expect(within(screen.getByLabelText("Worktrees")).queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
  });

  it("shows why the list is empty rather than looking broken", async () => {
    renderWorktrees({ worktrees: [], problem: "No repository is configured yet, so there are no worktrees." });
    expect(await within(screen.getByLabelText("Worktrees")).findByText(/No repository is configured/)).toBeInTheDocument();
  });

  it("says when nothing is held", async () => {
    renderWorktrees({ worktrees: [], problem: null });
    expect(await screen.findByText("Nothing is held right now.")).toBeInTheDocument();
  });

  it("keeps a retained checkout's deleted item key as plain text", async () => {
    renderWorktrees({ worktrees: [worktree({ itemKey: "GONE-1", itemState: null })], problem: null });
    expect(await screen.findByText("GONE-1")).toBeInTheDocument();
    expect(screen.getByText("no ticket")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "GONE-1" })).not.toBeInTheDocument();
  });

  it("reports a refused release instead of silently doing nothing, with the key linked", async () => {
    renderWorktrees({ worktrees: [worktree()], problem: null }, { released: false, reason: "EO-1 has a run in progress — cancel it first, or wait for it to finish." });
    fireEvent.click(await screen.findByRole("button", { name: "Release" }));

    const report = await screen.findByText(/has a run in progress/);
    await waitFor(() => expect(within(report).getByRole("link", { name: "EO-1" })).toHaveAttribute("href", "/items/id-EO-1"));
  });

  it("asks which repository when the project spans several", async () => {
    const calls = renderWorktrees({ worktrees: [], problem: null }, undefined, [
      { id: "p1", name: "web" },
      { id: "p2", name: "api" },
    ]);
    const picker = await screen.findByLabelText("Repository");
    expect(picker).toHaveValue("p1");
    fireEvent.change(picker, { target: { value: "p2" } });
    await waitFor(() => expect(calls.some((call) => call.channel === "worktrees:list" && (call.payload as { repositoryId: string }).repositoryId === "p2")).toBe(true));
  });
});
