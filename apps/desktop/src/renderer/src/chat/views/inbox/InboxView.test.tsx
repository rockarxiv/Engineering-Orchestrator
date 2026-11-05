import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { developerRegistry, toRegistryView, type InboxItem, type InboxSummary } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { InboxView } from "./InboxView";
import { RowsViewport } from "../../kit/testing";

/**
 * The chat layout's inbox: the classic inbox's behaviour — its filters,
 * its publication, its replies and its links — in the chat layout's
 * drawing (`inbox/Inbox.test.tsx` is the model).
 */

const NOW = new Date("2026-01-01T12:00:00Z").getTime();

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    commentId: "c1",
    itemId: "t1",
    itemKey: "EO-1",
    itemTitle: "Rate limiting",
    itemTypeLabel: "Story",
    itemState: "todo",
    authorName: "Implementer",
    body: "Which limit should I use?",
    kind: "escalation",
    options: null,
    createdAt: NOW - 5 * 60_000,
    blocking: true,
    waitingOn: { who: "you" },
    preview: false,
    ...overrides,
  };
}

function summary(overrides: Partial<InboxSummary> = {}): InboxSummary {
  return { openCount: 1, blockingCount: 1, everythingBlocked: false, ...overrides };
}

function renderInbox(
  data: { items: InboxItem[]; summary: InboxSummary },
  onCall?: (channel: string, payload: unknown) => void,
  settings = { doNotDisturb: false },
  fits?: number,
) {
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    onCall?.(channel, payload);
    if (channel === "inbox:list") return { ok: true, data };
    if (channel === "settings:get") return { ok: true, data: settings };
    if (channel === "settings:set") return { ok: true, data: payload };
    if (channel === "comments:post") return { ok: true, data: { commentId: "new", resumedRun: true } };
    if (channel === "items:list") return { ok: true, data: { items: data.items.map((entry) => ({ id: entry.itemId, key: entry.itemKey })) } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
    if (channel === "registry:get") return { ok: true, data: toRegistryView(developerRegistry()) };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;

  render(
    <RowsViewport {...(fits === undefined ? {} : { fits })}>
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/inbox"]}>
            <ViewPublisher>
              <ItemReferenceProvider>
                <InboxView />
              </ItemReferenceProvider>
              <CurrentRoute />
            </ViewPublisher>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    </RowsViewport>,
  );
}

function lastPublished(calls: { channel: string; payload: unknown }[]): Record<string, unknown> {
  const publishes = calls.filter((call) => call.channel === "view:publish");
  return (publishes.at(-1)?.payload as Record<string, unknown>) ?? {};
}

/** The list of waiting rows: the first list in the "Waiting" card. */
function rowList() {
  return within(screen.getByRole("region", { name: "Waiting" })).getAllByRole("list")[0]!;
}

describe("the inbox in the chat layout", () => {
  it("mounts a screenful of a thousand waiting rows, not all of them (EO-565)", async () => {
    const items = Array.from({ length: 1000 }, (_, index) =>
      item({ commentId: `c${index}`, itemId: `t${index}`, itemKey: `EO-${index}`, itemTitle: `Row ${index}`, createdAt: NOW - index * 60_000 }),
    );
    renderInbox({ items, summary: summary({ openCount: 1000, blockingCount: 1000 }) }, undefined, undefined, 15);

    expect((await screen.findAllByText("Row 0")).length).toBeGreaterThan(0);
    const mounted = within(rowList()).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.queryByText("Row 999")).toBeNull();
  });

  it("is pleasant when empty, not alarming", async () => {
    renderInbox({ items: [], summary: summary({ openCount: 0, blockingCount: 0 }) });

    expect(await screen.findByText("Nothing needs you.")).toBeInTheDocument();
    expect(screen.getByText(/agents will ask here/)).toBeInTheDocument();
  });

  it("draws no classic chrome: no back, no forward, no breadcrumb", async () => {
    renderInbox({ items: [item()], summary: summary() });

    await screen.findAllByText("Rate limiting");
    expect(screen.queryByRole("button", { name: /^Back$|^Forward$/ })).toBeNull();
    expect(screen.queryByRole("navigation", { name: /breadcrumb/i })).toBeNull();
  });

  it("links a row's key without selecting the row", async () => {
    renderInbox({
      items: [item({ commentId: "c1", itemId: "t1", itemKey: "EO-1" }), item({ commentId: "c2", itemId: "t2", itemKey: "EO-2", createdAt: NOW - 60 * 60_000 })],
      summary: summary({ openCount: 2 }),
    });

    await screen.findAllByText("Rate limiting");
    const list = rowList();
    const link = await within(list).findByRole("link", { name: "EO-2" });
    const row = within(list).getByRole("button", { name: "Select EO-2: Rate limiting" });
    expect(link).toHaveAttribute("href", "/items/t2");
    expect(row).toHaveAttribute("aria-current", "false");

    fireEvent.pointerDown(link);
    fireEvent.click(link);

    expect(row).toHaveAttribute("aria-current", "false");
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t2");
  });

  it("links a key in a row's preview without selecting that row", async () => {
    renderInbox({
      items: [item({ commentId: "c1", itemId: "t1", itemKey: "EO-1" }), item({ commentId: "c2", itemId: "t2", itemKey: "EO-2", body: "EO-1 is blocked", createdAt: NOW - 60 * 60_000 })],
      summary: summary({ openCount: 2 }),
    });

    await screen.findAllByText("Rate limiting");
    const row = within(rowList()).getByRole("button", { name: "Select EO-2: Rate limiting" });
    const previewLink = await within(row.parentElement!).findByRole("link", { name: "EO-1" });

    fireEvent.click(previewLink);

    expect(row).toHaveAttribute("aria-current", "false");
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1");
  });

  it("counts Blocking from the run, not from the mention, and tells a blocking ask from an FYI", async () => {
    renderInbox({
      items: [item({ commentId: "c1", blocking: true }), item({ commentId: "c2", itemKey: "EO-2", blocking: false, createdAt: NOW - 60 * 60_000 })],
      summary: summary({ openCount: 2 }),
    });

    expect(await screen.findByRole("tab", { name: /Blocking\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Mentions\s*1/ })).toBeInTheDocument();
    expect(screen.getByText("blocking")).toBeInTheDocument();
    expect(screen.getByText(/ended waiting for your reply/)).toBeInTheDocument();
  });

  it("says who each row is waiting on, and narrows to the unclaimed ones", async () => {
    renderInbox({
      items: [
        item({ commentId: "c1", itemKey: "EO-1", waitingOn: { who: "you" } }),
        item({ commentId: "c2", itemKey: "EO-2", itemTitle: "Refund the order", waitingOn: { who: "person", personId: "p2", name: "Anna Ruiz" }, createdAt: NOW - 60 * 60_000 }),
        item({ commentId: "c3", itemKey: "EO-3", itemTitle: "Card declined", waitingOn: { who: "unclaimed" }, createdAt: NOW - 2 * 60 * 60_000 }),
      ],
      summary: summary({ openCount: 3 }),
    });

    await screen.findAllByText("Rate limiting");
    expect(screen.getByText("Waiting on you")).toBeInTheDocument();
    expect(screen.getByText("Waiting on Anna")).toBeInTheDocument();
    expect(screen.getByText("Unclaimed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Unassigned/ }));

    expect(within(rowList()).getByText("Card declined")).toBeInTheDocument();
    expect(within(rowList()).queryByText("Refund the order")).not.toBeInTheDocument();
  });

  it("filters by typed text across key, title and body", async () => {
    renderInbox({
      items: [item({ commentId: "c1", itemKey: "EO-1", itemTitle: "Rate limiting" }), item({ commentId: "c2", itemKey: "EO-2", itemTitle: "Durable comments" })],
      summary: summary({ openCount: 2 }),
    });

    fireEvent.change(await screen.findByLabelText("Filter inbox"), { target: { value: "durable" } });

    expect(within(rowList()).getByText("Durable comments")).toBeInTheDocument();
    expect(within(rowList()).queryByText("Rate limiting")).not.toBeInTheDocument();
  });

  it("answers without leaving the inbox, filed under the comment it answers", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox({ items: [item()], summary: summary() }, (channel, payload) => calls.push({ channel, payload }));

    fireEvent.change(await screen.findByLabelText("Reply to EO-1"), { target: { value: "100 a minute" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply and resume" }));

    await waitFor(() =>
      expect(calls.find((call) => call.channel === "comments:post")?.payload).toEqual({ itemId: "t1", body: "100 a minute", mentions: [], pinned: false, parentId: "c1" }),
    );
  });

  it("keeps an answered row closed to another reply until the inbox has been read again (EO-562)", async () => {
    let waiting = [item(), item({ commentId: "c2", itemId: "t2", itemKey: "EO-2", itemTitle: "Caching", createdAt: NOW - 60 * 60_000 })];
    let reread: (value: unknown) => void = () => {};
    let posted = false;
    renderInbox({ items: waiting, summary: summary({ openCount: 2 }) });
    const answered = window.eo.ipc.invoke;
    window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === "comments:post") {
        posted = true;
        return { ok: true, data: { commentId: "new", resumedRun: true } };
      }
      // The read asked for after the answer is held, so the gap is there to look at.
      if (channel === "inbox:list" && posted) return new Promise<never>((resolve) => (reread = resolve as (value: unknown) => void));
      return answered(channel as never, payload as never);
    }) as never;

    fireEvent.change(await screen.findByLabelText("Reply to EO-1"), { target: { value: "100 a minute" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply and resume" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled());
    await waitFor(() => expect((window.eo.ipc.invoke as ReturnType<typeof vi.fn>).mock.calls.some(([channel]) => channel === "inbox:list")).toBe(true));
    expect(screen.getByLabelText("Reply to EO-1")).toBeDisabled();
    expect(within(rowList()).getByRole("button", { name: "Select EO-1: Rate limiting" })).toHaveAttribute("aria-busy", "true");
    expect(within(rowList()).getByText("Sending reply…")).toBeInTheDocument();

    // Another row can still be answered meanwhile.
    fireEvent.click(within(rowList()).getByRole("button", { name: "Select EO-2: Caching" }));
    expect(await screen.findByLabelText("Reply to EO-2")).toBeEnabled();

    waiting = [waiting[1]!];
    await act(async () => reread({ ok: true, data: { items: waiting, summary: summary() } }));
    await waitFor(() => expect(within(rowList()).queryByRole("button", { name: "Select EO-1: Rate limiting" })).not.toBeInTheDocument());
    expect(within(rowList()).queryByText("Sending reply…")).not.toBeInTheDocument();
  });

  it("sends with ⌘↵", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox({ items: [item()], summary: summary() }, (channel, payload) => calls.push({ channel, payload }));

    const box = await screen.findByLabelText("Reply to EO-1");
    fireEvent.change(box, { target: { value: "per key" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(() => expect(calls.find((call) => call.channel === "comments:post")?.payload).toMatchObject({ body: "per key" }));
  });

  it("posts an option's choice once it is sent, with guidance after it", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox({ items: [item({ options: ["429", "503"] })], summary: summary() }, (channel, payload) => calls.push({ channel, payload }));

    fireEvent.click(await screen.findByRole("button", { name: "429" }));
    expect(screen.getByRole("button", { name: "429" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Add guidance for EO-1"), { target: { value: "for now" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply and resume" }));

    await waitFor(() => expect(calls.find((call) => call.channel === "comments:post")?.payload).toMatchObject({ body: "429\n\nfor now" }));
  });

  it("follows a key in an option without choosing it", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox(
      {
        items: [
          item({ commentId: "c1", itemId: "t1", itemKey: "EO-1", options: ["Wait for EO-2"] }),
          item({ commentId: "c2", itemId: "t2", itemKey: "EO-2", createdAt: NOW - 60 * 60_000 }),
        ],
        summary: summary({ openCount: 2 }),
      },
      (channel, payload) => calls.push({ channel, payload }),
    );

    const choices = await screen.findByRole("group", { name: "Choose a response" });
    const choice = within(choices).getByRole("button", { name: "Wait for EO-2" });
    const link = await within(choices).findByRole("link", { name: "EO-2" });
    fireEvent.click(link);

    expect(choice).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Reply and resume" })).toBeDisabled();
    expect(calls.some((call) => call.channel === "comments:post")).toBe(false);
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t2");
  });

  it("opens the item a row is about, as a tab of its own", async () => {
    renderInbox({ items: [item()], summary: summary() });

    fireEvent.click(await screen.findByRole("button", { name: "Open ticket" }));

    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t1");
  });

  it("shouts when the whole pipeline is waiting on you", async () => {
    renderInbox({ items: [item()], summary: summary({ everythingBlocked: true }) });

    const banner = (await screen.findByText("Everything is waiting on you.")).closest("[role=status]");
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent("No ticket can move until you answer below");
  });

  it("stays quiet when work can still proceed", async () => {
    renderInbox({ items: [item()], summary: summary({ everythingBlocked: false }) });

    await screen.findAllByText("Rate limiting");
    expect(screen.queryByText("Everything is waiting on you.")).not.toBeInTheDocument();
  });

  it("points at the oldest unanswered item, and only when there is more than one", async () => {
    renderInbox({
      items: [item({ commentId: "new", itemKey: "EO-9", createdAt: NOW - 60_000 }), item({ commentId: "old", itemKey: "EO-2", createdAt: NOW - 3 * 60 * 60_000 })],
      summary: summary({ openCount: 2 }),
    });

    expect((await screen.findByText(/Oldest unanswered:/)).textContent).toContain("EO-2");
  });

  it("toggles Do Not Disturb and persists it", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox({ items: [], summary: summary({ openCount: 0 }) }, (channel, payload) => calls.push({ channel, payload }));

    fireEvent.click(await screen.findByRole("button", { name: /Do Not Disturb off/ }));

    await waitFor(() => expect(calls.find((call) => call.channel === "settings:set")?.payload).toEqual({ doNotDisturb: true }));
  });

  it("shows Do Not Disturb as on when it is", async () => {
    renderInbox({ items: [], summary: summary({ openCount: 0 }) }, undefined, { doNotDisturb: true });

    expect(await screen.findByRole("button", { name: /Do Not Disturb on/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("marks a preview's row with the banner, and no other row", async () => {
    renderInbox({ items: [item({ preview: true }), item({ commentId: "c2", itemKey: "EO-2", createdAt: NOW - 60 * 60_000 })], summary: summary({ openCount: 0 }) });

    const banners = await screen.findAllByRole("note", { name: "Preview" });
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveTextContent("Preview. Nothing was sent, nothing cost money.");
  });
});

describe("what the inbox publishes", () => {
  const two = {
    items: [
      item({ commentId: "c1", itemId: "t1", itemKey: "EO-1", itemTitle: "Rate limiting", blocking: true }),
      item({ commentId: "c2", itemId: "t2", itemKey: "EO-2", itemTitle: "Sidebar", blocking: false, kind: "note", createdAt: NOW - 60_000 }),
    ],
    summary: summary({ openCount: 2 }),
  };

  it("publishes the tab, the text and the row that is open", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox(two, (channel, payload) => calls.push({ channel, payload }));
    await screen.findAllByText("Rate limiting");

    await waitFor(() => {
      expect(lastPublished(calls)["filter"]).toEqual({ text: "", facets: { category: "all" } });
      expect(lastPublished(calls)["selection"]).toEqual(["c2"]);
    });

    fireEvent.click(screen.getByRole("tab", { name: /Blocking/ }));
    await waitFor(() => {
      expect(lastPublished(calls)["filter"]).toEqual({ text: "", facets: { category: "blocking" } });
      expect(lastPublished(calls)["selection"]).toEqual(["c1"]);
    });
  });

  it("publishes the row somebody clicks", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox(two, (channel, payload) => calls.push({ channel, payload }));
    await screen.findAllByText("Rate limiting");

    fireEvent.click(screen.getByRole("button", { name: "Select EO-1: Rate limiting" }));

    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual(["c1"]));
  });

  it("selects nothing when there is nothing to select", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox({ items: [], summary: summary({ openCount: 0, blockingCount: 0 }) }, (channel, payload) => calls.push({ channel, payload }));

    await waitFor(() => expect(lastPublished(calls)["selection"]).toEqual([]));
  });

  it("draws a conflict notice's Fix with assistant as an action that opens the chat, not as an answer to reply with", async () => {
    const calls: { channel: string; payload: unknown }[] = [];
    renderInbox(
      {
        items: [
          item({
            commentId: "notice-1",
            itemKey: "SHOP-NOTES",
            itemTitle: "Project notes",
            authorName: "EO",
            kind: "note",
            blocking: false,
            body: "**Delivery** could not take the *Software feature to merge* template's update from 1.0 to 1.1.",
            options: [{ kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "conflict-1" } }],
          }),
        ],
        summary: summary({ blockingCount: 0 }),
      },
      (channel, payload) => calls.push({ channel, payload }),
    );

    const button = await screen.findByRole("button", { name: "Fix with assistant" });
    expect(screen.getAllByText(/could not take the/).length).toBeGreaterThan(0);
    // Not offered as an answer: there are none to choose from.
    expect(screen.queryByText("Choose a response")).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(calls.find((call) => call.channel === "assist:openUpdateConflict")?.payload).toEqual({ conflictId: "conflict-1", commentId: "notice-1" }));
    expect(calls.some((call) => call.channel === "comments:post")).toBe(false);
  });
});
