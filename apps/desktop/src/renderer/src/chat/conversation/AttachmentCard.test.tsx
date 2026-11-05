import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscussionAttachment } from "@eo/core";
import { setBridge } from "../../ipc/bridge";
import { createQueryClient } from "../../query/client";
import { AttachmentCard } from "./AttachmentCard";

function attachment(overrides: Partial<DiscussionAttachment> = {}): DiscussionAttachment {
  return { id: "0198a000-0000-7000-8000-000000000801", kind: "file", name: "notes.txt", mimeType: "text/plain", size: 12, ...overrides } as DiscussionAttachment;
}

function mount(of: DiscussionAttachment) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AttachmentCard attachment={of} />
    </QueryClientProvider>,
  );
}

/** A browser served by a server: the record is there, the machine is not (EO-319). */
function onAServer(invoke: (channel: string) => Promise<unknown>) {
  setBridge({ invoke: invoke as never, machineAvailable: false, subscribe: () => () => {}, subscribeRefetch: () => () => {} });
}

afterEach(() => setBridge(undefined));

describe("the chat attachment card", () => {
  it("names the file and offers Open and Save as… for it", async () => {
    const invoke = vi.fn(async (_channel: string, _payload?: unknown) => ({ ok: true, data: { problem: null } }));
    window.eo.ipc.invoke = invoke as never;
    mount(attachment());

    expect(screen.getByText("notes.txt")).toHaveAttribute("title", "notes.txt");
    fireEvent.click(screen.getByRole("button", { name: "Open notes.txt" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("attachments:open", { attachmentId: "0198a000-0000-7000-8000-000000000801" }));
    expect(screen.getByRole("button", { name: "Save notes.txt" })).toHaveAttribute("title", "Save as…");
    fireEvent.click(screen.getByRole("button", { name: "Save notes.txt" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("attachments:save", { attachmentId: "0198a000-0000-7000-8000-000000000801" }));
    // A file is never asked for a preview.
    expect(invoke.mock.calls.some(([channel]) => channel === "attachments:preview")).toBe(false);
  });

  it("says what the main process said when a file cannot be opened", async () => {
    window.eo.ipc.invoke = vi.fn(async () => ({ ok: true, data: { problem: "notes.txt could not be opened because the file is gone." } })) as never;
    mount(attachment());

    fireEvent.click(screen.getByRole("button", { name: "Open notes.txt" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("notes.txt could not be opened because the file is gone.");
  });

  it("previews an image inline, and opens it on a click", async () => {
    const invoke = vi.fn(async (channel: string) => ({
      ok: true,
      data: channel === "attachments:preview" ? { dataUrl: "data:image/png;base64,AAAA" } : { problem: null },
    }));
    window.eo.ipc.invoke = invoke as never;
    mount(attachment({ kind: "image", name: "screen.png", mimeType: "image/png" }));

    expect(await screen.findByRole("img", { name: "screen.png" })).toHaveAttribute("src", "data:image/png;base64,AAAA");
    fireEvent.click(screen.getByRole("button", { name: "Preview screen.png" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("attachments:open", { attachmentId: "0198a000-0000-7000-8000-000000000801" }));
  });

  it("still previews on a server, but offers nothing that needs the machine", async () => {
    onAServer(async (channel: string) => ({ ok: true, data: channel === "attachments:preview" ? { dataUrl: "data:image/png;base64,BBBB" } : {} }));
    mount(attachment({ kind: "image", name: "screen.png", mimeType: "image/png" }));

    expect(await screen.findByRole("img", { name: "screen.png" })).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
