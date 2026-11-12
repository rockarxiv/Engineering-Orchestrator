import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import type { CommentOption } from "@eo/core";
import { createQueryClient } from "../query/client";
import { assistRoomKey } from "../shared/assist/useAssistRoom";
import { CommentActions } from "./CommentActions";

/**
 * A comment's actions (EO-533): buttons that open something rather than
 * answer — the conflict notice's Fix with assistant.
 */

const FIX: CommentOption = { kind: "open", label: "Fix with assistant", opens: { type: "updateConflictChat", conflictId: "conflict-1" } };
const CHAT = { id: "chat-1", key: "ASK-7", messages: [] };

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function renderActions(
  options: CommentOption[] | null,
  answer: { conversation: unknown; problem: string | null; projectId?: string | null } = { conversation: CHAT, problem: null },
  activeProjectId: string | null = null,
) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "assist:openUpdateConflict") return { ok: true, data: answer };
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId } };
    if (channel === "projects:setActive") return { ok: true, data: { activeProjectId: (payload as { id: string }).id } };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  const client = createQueryClient();
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/items/thread"]}>
          <CommentActions options={options} commentId="notice-1" />
          <CurrentRoute />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { calls, client };
}

describe("a comment's actions", () => {
  it("draws nothing for a comment whose options are all answers", () => {
    renderActions(["Yes", "No"]);

    expect(screen.queryByRole("group", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws Fix with assistant as a button, and nothing for the answers beside it", () => {
    renderActions(["Yes", FIX]);

    expect(screen.getByRole("button", { name: "Fix with assistant" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("opens the conflict's chat, puts it on show and goes to the chat — posting no reply", async () => {
    const { calls, client } = renderActions([FIX]);

    fireEvent.click(screen.getByRole("button", { name: "Fix with assistant" }));

    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent("/chat"));
    expect(calls.filter((call) => call.channel === "assist:openUpdateConflict").map((call) => call.payload)).toEqual([{ conflictId: "conflict-1", commentId: "notice-1" }]);
    expect(calls.some((call) => call.channel === "comments:post")).toBe(false);
    expect(client.getQueryData(assistRoomKey)).toEqual({ conversation: CHAT });
  });

  /** EO-765: the chat is in its own project's rail, so the window switches there. */
  it("switches the window to the chat's project when it is on another one", async () => {
    const { calls } = renderActions([FIX], { conversation: CHAT, problem: null, projectId: "shop" }, "blog");
    await waitFor(() => expect(calls.some((call) => call.channel === "projects:list")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Fix with assistant" }));

    await waitFor(() => expect(calls.filter((call) => call.channel === "projects:setActive").map((call) => call.payload)).toEqual([{ id: "shop" }]));
    expect(screen.getByTestId("current-route")).toHaveTextContent("/chat");
  });

  it("switches nothing when the chat is on the project the window is on", async () => {
    const { calls, client } = renderActions([FIX], { conversation: CHAT, problem: null, projectId: "shop" }, "shop");
    await waitFor(() => expect(client.getQueryData(["projects"])).toMatchObject({ activeProjectId: "shop" }));

    fireEvent.click(screen.getByRole("button", { name: "Fix with assistant" }));

    await waitFor(() => expect(screen.getByTestId("current-route")).toHaveTextContent("/chat"));
    expect(calls.some((call) => call.channel === "projects:setActive")).toBe(false);
  });

  it("says why when the chat cannot be opened, and stays where it is", async () => {
    renderActions([FIX], { conversation: null, problem: "That template update has already been resolved." });

    fireEvent.click(screen.getByRole("button", { name: "Fix with assistant" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That template update has already been resolved.");
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/thread");
  });
});
