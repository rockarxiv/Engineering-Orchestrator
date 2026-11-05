import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { developerRegistry, toRegistryView, type OpenMentionView } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { MentionsView } from "./MentionsView";
import { RowsViewport } from "../../kit/testing";

/** The administrator's survey, in the chat layout (`admin/OpenMentions.test.tsx` is the model). */

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function mention(overrides: Partial<OpenMentionView> = {}): OpenMentionView {
  return {
    commentId: "c1",
    itemId: "t1",
    itemKey: "SUP-31",
    itemTitle: "A customer is stuck",
    itemTypeLabel: "Case",
    itemState: "approve",
    authorName: "Nova",
    body: "Which refund window applies here?",
    kind: "question",
    options: null,
    createdAt: NOW - 30 * 60_000,
    blocking: false,
    waitingOn: { who: "person", personId: "p-anna", name: "Anna Ruiz" },
    preview: false,
    projectId: "proj-support",
    projectName: "Support",
    ...overrides,
  };
}

function renderMentions(mentions: OpenMentionView[], fits?: number) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "mentions:open") return { ok: true, data: { mentions } };
    if (channel === "items:list") return { ok: true, data: { items: [] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "registry:get") return { ok: true, data: toRegistryView(developerRegistry()) };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

  render(
    <RowsViewport {...(fits === undefined ? {} : { fits })}>
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/mentions"]}>
            <ItemReferenceProvider>
              <MentionsView />
            </ItemReferenceProvider>
            <CurrentRoute />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("all open mentions in the chat layout", () => {
  it("mounts a screenful of a thousand mentions, not all of them (EO-565)", async () => {
    renderMentions(
      Array.from({ length: 1000 }, (_, index) => mention({ commentId: `c${index}`, itemId: `t${index}`, itemKey: `SUP-${index}`, itemTitle: `Row ${index}` })),
      15,
    );

    expect(await screen.findByRole("heading", { name: /Waiting on Anna · 1000/ })).toBeInTheDocument();
    expect(screen.getByText("Row 0")).toBeInTheDocument();
    const mounted = within(screen.getByRole("list", { name: /Waiting on Anna/ })).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.queryByText("Row 999")).toBeNull();
  });

  it("lists a mention waiting on Anna, under her name, with its project", async () => {
    renderMentions([mention()]);

    expect(await screen.findByRole("heading", { name: /Waiting on Anna/ })).toBeInTheDocument();
    expect(screen.getByText("A customer is stuck")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
    expect(screen.getByText("30m ago")).toBeInTheDocument();
  });

  it("gathers one person's rows under one heading", async () => {
    renderMentions([
      mention({ commentId: "c1", itemId: "t1" }),
      mention({ commentId: "c2", itemId: "t2", itemKey: "SUP-32", itemTitle: "A second customer" }),
      mention({ commentId: "c3", itemId: "t3", itemKey: "MKT-4", itemTitle: "The Q3 number is wrong", projectName: "Marketing", waitingOn: { who: "person", personId: "p-sam", name: "Sam Oyelaran" } }),
    ]);

    expect(await screen.findByRole("heading", { name: /Waiting on Anna · 2/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Waiting on Sam · 1/ })).toBeInTheDocument();
  });

  it("opens the item a row is about", async () => {
    renderMentions([mention()]);

    fireEvent.click(await screen.findByRole("button", { name: "Open SUP-31: A customer is stuck" }));

    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1");
  });

  it("links the key on a row to its item", async () => {
    renderMentions([mention()]);

    expect(await screen.findByRole("link", { name: "SUP-31" })).toHaveAttribute("href", "/items/t1");
  });

  it("filters by person, project or text", async () => {
    renderMentions([
      mention({ commentId: "c1", itemId: "t1" }),
      mention({ commentId: "c3", itemId: "t3", itemKey: "MKT-4", itemTitle: "The Q3 number is wrong", projectName: "Marketing", waitingOn: { who: "person", personId: "p-sam", name: "Sam Oyelaran" } }),
    ]);

    fireEvent.change(await screen.findByLabelText("Filter open mentions"), { target: { value: "marketing" } });

    expect(screen.getByText("The Q3 number is wrong")).toBeInTheDocument();
    expect(screen.queryByText("A customer is stuck")).not.toBeInTheDocument();
  });

  it("says so when nothing is outstanding", async () => {
    renderMentions([]);

    expect(await screen.findByText("Nothing is waiting on anybody.")).toBeInTheDocument();
  });

  it("marks what is blocking a run", async () => {
    renderMentions([mention({ blocking: true })]);

    const row = (await screen.findByRole("button", { name: /A customer is stuck/ })).parentElement!;
    expect(within(row).getByText("Blocking")).toBeInTheDocument();
  });
});
