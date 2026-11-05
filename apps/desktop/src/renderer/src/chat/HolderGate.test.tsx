import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../query/client";
import { HolderGate } from "./HolderGate";

/**
 * The takeover warning belongs to the item it was opened on (EO-368).
 *
 * The gate can stay mounted while the item under it changes — a list
 * that swaps the item it shows, a conversation column following a
 * different inbox row. A warning confirmed about Anna on one item must
 * never become a takeover of another item Anna also holds, which nobody
 * was warned about.
 */
const DESIGN = { id: "g-design", name: "Design" };
const ANNA = { id: "p-anna", name: "Anna" };

function mockIpc(): { channel: string; payload: unknown }[] {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "items:authority") return { ok: true, data: { authority: { group: DESIGN, holder: ANNA, you: "member" } } };
    if (channel === "items:takeOver") return { ok: true, data: { assigneeId: "p-dana", assigneeName: "Dana", commentId: "c1", problem: null } };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return calls;
}

describe("the takeover warning", () => {
  it("is forgotten when the item changes, so returning to the first item shows no warning to confirm", async () => {
    const calls = mockIpc();
    const client = createQueryClient();
    const view = (itemId: string) => (
      <QueryClientProvider client={client}>
        <HolderGate itemId={itemId}>
          <button type="button">Approve</button>
        </HolderGate>
      </QueryClientProvider>
    );
    const { rerender } = render(view("t1"));

    // Opened on t1, and not confirmed.
    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    expect(screen.getByRole("alertdialog", { name: "Take over from Anna" })).toBeInTheDocument();

    // Away to t2, and straight back to t1.
    rerender(view("t2"));
    await screen.findByRole("button", { name: "Take over" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    rerender(view("t1"));
    await screen.findByRole("button", { name: "Take over" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over from Anna" })).toBeNull();
    expect(calls.some((call) => call.channel === "items:takeOver")).toBe(false);
  });

  it("does not carry over to another item held by the same person", async () => {
    const calls = mockIpc();
    const client = createQueryClient();
    const view = (itemId: string) => (
      <QueryClientProvider client={client}>
        <HolderGate itemId={itemId}>
          <button type="button">Approve</button>
        </HolderGate>
      </QueryClientProvider>
    );
    const { rerender } = render(view("t1"));

    fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
    expect(screen.getByRole("alertdialog", { name: "Take over from Anna" })).toBeInTheDocument();

    // The same gate, now about a second item Anna also holds.
    rerender(view("t2"));
    await screen.findByRole("button", { name: "Take over" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Take over from Anna" })).toBeNull();
    expect(calls.some((call) => call.channel === "items:takeOver")).toBe(false);

    // Taking this one over needs its own warning, and names this item.
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Take over from Anna" })).getByRole("button", { name: "Take over from Anna" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.channel === "items:takeOver").map((call) => call.payload)).toEqual([{ itemId: "t2", fromPersonId: "p-anna" }]),
    );

    // …and going back to the first shows no warning left open there either.
    rerender(view("t1"));
    await screen.findByRole("button", { name: "Take over" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
