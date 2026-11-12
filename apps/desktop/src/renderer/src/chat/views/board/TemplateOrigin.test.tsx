import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { PipelineTemplateStatus } from "@eo/core";
import { createQueryClient } from "../../../query/client";
import { assistRoomKey } from "../../../shared/assist/useAssistRoom";
import { PipelineTitle } from "./header";

/**
 * A pipeline's template origin and update state on the head the board
 * and the Graph view share (EO-536), in each of its states: no origin,
 * an origin, an update applied lately, and one held with or without its
 * chat.
 */

const ORIGIN = { slug: "software-feature-to-merge", title: "Software feature to merge", version: "1.0" };
const NOTES = "Adds Watching pull request after Merge Request.";
const CHAT = { id: "chat-1", key: "ASK-7", messages: [] };

const status = (overrides: Partial<PipelineTemplateStatus> = {}): PipelineTemplateStatus => ({ origin: ORIGIN, updated: null, waiting: null, problem: null, ...overrides });
const waiting = (overrides: Partial<NonNullable<PipelineTemplateStatus["waiting"]>> = {}): NonNullable<PipelineTemplateStatus["waiting"]> => ({
  conflictId: "conflict-1",
  fromVersion: "1.0",
  toVersion: "1.1",
  conflicts: 1,
  problems: 0,
  chatId: null,
  notice: { itemId: "thread-1", commentId: "notice-1" },
  ...overrides,
});

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderHead(answer: PipelineTemplateStatus, opened: { conversation: unknown; problem: string | null; projectId: string | null } = { conversation: CHAT, problem: null, projectId: null }) {
  const calls: { channel: string; payload: unknown }[] = [];
  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === "pipeline:templateStatus") return { ok: true, data: answer };
    if (channel === "assist:openUpdateConflict") return { ok: true, data: opened };
    return { ok: true, data: {} };
  }) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/pipelines/default"]}>
        <PipelineTitle name="Delivery" pipelineId="default" />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, client };
}

const asked = (calls: { channel: string }[]) => waitFor(() => expect(calls.some((call) => call.channel === "pipeline:templateStatus")).toBe(true));

describe("a pipeline's template origin on its head", () => {
  it("says nothing for a pipeline made from no template", async () => {
    const { calls } = renderHead({ origin: null, updated: null, waiting: null, problem: null });

    await asked(calls);
    expect(calls.find((call) => call.channel === "pipeline:templateStatus")?.payload).toEqual({ pipelineId: "default" });
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing where the record holding the pipeline could not be asked", async () => {
    const { calls } = renderHead({ origin: null, updated: null, waiting: null, problem: "Your organisation's record could not be reached." });

    await asked(calls);
    expect(screen.queryByText(/^From /)).toBeNull();
    expect(screen.queryByText(/could not be reached/)).toBeNull();
  });

  it("names the template and the version the pipeline's base is, and nothing more while there is no news", async () => {
    renderHead(status());

    expect(await screen.findByText("From Software feature to merge v1.0")).toBeInTheDocument();
    expect(screen.queryByText(/^Updated to/)).toBeNull();
    expect(screen.queryByText(/^Update waiting/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("after an applied update", () => {
  const updated = status({ origin: { ...ORIGIN, version: "1.1" }, updated: { version: "1.1", pipelineVersion: 4, at: 1_700_000_000_000, notes: NOTES } });

  it("says Updated to vN beside the origin", async () => {
    renderHead(updated);

    expect(await screen.findByText("From Software feature to merge v1.1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updated to v1.1 — read the release notes" })).toHaveTextContent("Updated to v1.1");
  });

  it("shows the release notes in one click", async () => {
    renderHead(updated);

    fireEvent.click(await screen.findByRole("button", { name: /^Updated to v1\.1/ }));

    const dialog = await screen.findByRole("dialog", { name: "Software feature to merge v1.1" });
    expect(within(dialog).getByLabelText("Release notes")).toHaveTextContent(NOTES);
    expect(dialog).toHaveTextContent("v4");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so where the version came with no notes", async () => {
    renderHead(status({ updated: { version: "1.0", pipelineVersion: 2, at: 1, notes: "" } }));

    fireEvent.click(await screen.findByRole("button", { name: /^Updated to v1\.0/ }));

    expect(within(await screen.findByRole("dialog")).getByLabelText("Release notes")).toHaveTextContent("This version came with no release notes.");
  });
});

describe("with an update held", () => {
  it("says Update waiting with the conflict count, and opens the notice while no chat exists", async () => {
    const { calls } = renderHead(status({ waiting: waiting() }));

    const button = await screen.findByRole("button", { name: "Update waiting: 1 conflict — see the notice" });
    expect(button).toHaveTextContent("Update waiting: 1 conflict");
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/items/thread-1"));
    expect(calls.some((call) => call.channel === "assist:openUpdateConflict")).toBe(false);
  });

  it("opens the conflict's assistant chat once Fix with assistant has made one", async () => {
    const { calls, client } = renderHead(status({ waiting: waiting({ conflicts: 2, chatId: "chat-1" }) }));

    fireEvent.click(await screen.findByRole("button", { name: "Update waiting: 2 conflicts — open the assistant chat about it" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/chat"));
    expect(calls.filter((call) => call.channel === "assist:openUpdateConflict").map((call) => call.payload)).toEqual([{ conflictId: "conflict-1", commentId: "notice-1" }]);
    expect(client.getQueryData(assistRoomKey)).toEqual({ conversation: CHAT });
  });

  it("opens the chat the notice's button would have, where the notice could go nowhere", async () => {
    const { calls } = renderHead(status({ waiting: waiting({ notice: null }) }));

    fireEvent.click(await screen.findByRole("button", { name: /^Update waiting: 1 conflict/ }));

    await waitFor(() => expect(calls.filter((call) => call.channel === "assist:openUpdateConflict").map((call) => call.payload)).toEqual([{ conflictId: "conflict-1", commentId: null }]));
  });

  it("says why when the chat cannot be opened, and stays where it is", async () => {
    renderHead(status({ waiting: waiting({ chatId: "chat-1" }) }), { conversation: null, problem: "That template update has already been resolved.", projectId: null });

    fireEvent.click(await screen.findByRole("button", { name: /^Update waiting/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That template update has already been resolved.");
    expect(screen.getByTestId("where")).toHaveTextContent("/pipelines/default");
  });

  it("counts problems where the merge was held because it would not validate", async () => {
    renderHead(status({ waiting: waiting({ conflicts: 0, problems: 1 }) }));

    expect(await screen.findByRole("button", { name: /^Update waiting: 1 problem/ })).toBeInTheDocument();
  });
});
