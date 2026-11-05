import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createQueryClient } from "../../query/client";
import { ItemReferenceProvider } from "./ItemReferenceProvider";
import { setBridge } from "../../ipc/bridge";
import { Composer } from "./Composer";

function CurrentRoute() {
  return <div data-testid="current-route">{useLocation().pathname}</div>;
}

function renderComposerWithReferences(appearance: "default" | "chat") {
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "projects:list") return { ok: true, data: { projects: [], activeProjectId: null } };
    if (channel === "items:list") return { ok: true, data: { items: [{ id: "t2", key: "EO-2" }] } };
    if (channel === "items:listArchived") return { ok: true, data: { items: [] } };
    return { ok: true, data: {} };
  }) as never;

  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <ItemReferenceProvider>
          <Composer appearance={appearance} mentionables={[]} onSubmit={async () => { throw new Error("Could not post because EO-2 is closed."); }} />
        </ItemReferenceProvider>
        <CurrentRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * The file names a bridge was asked to stage, in order.
 *
 * By name rather than by call count: `window.eo.ipc.invoke` is shared
 * across cases, so a batch still in flight when one ends lands on the
 * next one's mock. Every case here names its files distinctly, and the
 * cases that count them wait for their own to settle first.
 */
function stagedNames(invoke: { mock: { calls: unknown[][] } }): string[] {
  return invoke.mock.calls
    .filter(([channel]) => channel === "attachments:stage")
    .map(([, payload]) => (payload as { name?: string }).name ?? "");
}

/** Drafts as `attachments:pick` hands them back, numbered so ids and names stay distinct. */
function pickedDrafts(from: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `0198a000-0000-7000-8000-0000000003${String(from + index).padStart(2, "0")}`,
    kind: "file",
    name: `picked${from + index}.txt`,
    mimeType: "text/plain",
    size: 5,
  }));
}

/** An IPC bridge whose picker answers with each of these in turn. */
function pickerReturning(...answers: { attachments: unknown[]; omitted: number }[]) {
  let call = 0;
  return vi.fn(async (channel: string) => ({
    ok: true,
    data: channel === "attachments:pick" ? (answers[Math.min(call++, answers.length - 1)] ?? {}) : {},
  }));
}

/**
 * The chat layout's composer, held to every case the classic one is
 * (`item/Composer.test.tsx`), and then to what is its own: both
 * appearances drawn in the chat's box, and the controls each one names.
 */
describe("the chat composer, as the classic one", () => {
  it("keeps the default comment composer three-row and vertically resizable", () => {
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);

    const box = screen.getByLabelText("Write a comment");
    expect(box).toHaveAttribute("rows", "3");
    expect(box).toHaveClass("resize-y");
  });

  it("submits the current message on Enter", () => {
    const onSubmit = vi.fn();
    render(<Composer mentionables={[]} onSubmit={onSubmit} />);

    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "Send this" } });

    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(onSubmit).toHaveBeenCalledWith("Send this", [], []);
  });

  it.each([
    ["Ctrl+Enter", { ctrlKey: true }],
    ["Shift+Enter", { shiftKey: true }],
  ])("leaves %s to insert a newline instead of submitting", (_shortcut, modifier) => {
    const onSubmit = vi.fn();
    render(<Composer mentionables={[]} onSubmit={onSubmit} />);

    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "First line" } });

    expect(fireEvent.keyDown(box, { key: "Enter", ...modifier })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ["Ctrl+Enter", { ctrlKey: true }],
    ["Shift+Enter", { shiftKey: true }],
  ])("leaves %s as a newline when mention suggestions are open", (_shortcut, modifier) => {
    const onSubmit = vi.fn();
    render(<Composer mentionables={["implementer"]} onSubmit={onSubmit} />);

    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "@imp" } });

    expect(screen.getByRole("option", { name: "@implementer" })).toBeInTheDocument();
    expect(fireEvent.keyDown(box, { key: "Enter", ...modifier })).toBe(true);
    expect(box).toHaveValue("@imp");
    expect(screen.getByRole("option", { name: "@implementer" })).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("posts an attachment without requiring comment text", async () => {
    const attachment = { id: "0198a000-0000-7000-8000-000000000001", kind: "file", name: "notes.txt", mimeType: "text/plain", size: 12 };
    window.eo.ipc.invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === "attachments:pick" ? { attachments: [attachment], omitted: 0 } : {} })) as never;
    const onSubmit = vi.fn(async () => {});
    render(<Composer mentionables={[]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("", [], [attachment.id]));
  });

  it.each(["paste", "drop"] as const)("stages files received by %s", async (method) => {
    const attachment = { id: "0198a000-0000-7000-8000-000000000002", kind: "file", name: "pasted.txt", mimeType: "text/plain", size: 5 };
    const invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === "attachments:stage" ? { attachment } : {} }));
    window.eo.ipc.invoke = invoke as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);
    const box = screen.getByLabelText("Write a comment");
    const file = new File(["hello"], "pasted.txt", { type: "made/up" });

    if (method === "paste") fireEvent.paste(box, { clipboardData: { files: [file] } });
    else fireEvent.drop(box, { dataTransfer: { files: [file] } });

    expect(await screen.findByText("pasted.txt")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("attachments:stage", expect.objectContaining({ name: "pasted.txt" }));
  });

  /**
   * The cap, said out loud (EO-194).
   *
   * Eight was always the limit and the surplus was always dropped; what
   * was missing was anyone being told. It is the one failure a person
   * cannot catch by looking, because eight chips from nine files look
   * exactly like eight chips from eight — so the whole of this is the
   * sentence, and both routes into the composer have to produce it.
   */
  it.each(["paste", "drop"] as const)("says so when %s brings more files than a message may carry", async (method) => {
    let staged = 0;
    const invoke = vi.fn(async (channel: string) => ({
      ok: true,
      data: channel === "attachments:stage"
        ? { attachment: { id: `0198a000-0000-7000-8000-00000000010${staged++}`, kind: "file", name: `f${staged}.txt`, mimeType: "text/plain", size: 5 } }
        : {},
    }));
    window.eo.ipc.invoke = invoke as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);
    const box = screen.getByLabelText("Write a comment");
    const files = Array.from({ length: 9 }, (_, index) => new File(["hello"], `f${index}.txt`, { type: "text/plain" }));

    if (method === "paste") fireEvent.paste(box, { clipboardData: { files } });
    else fireEvent.drop(box, { dataTransfer: { files } });

    expect(await screen.findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so one was left out.");
    // The eight that fit are still attached: the ninth is refused, not
    // the paste. Waited to a standstill so nothing is still staging when
    // the case ends.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(8));
    expect(invoke.mock.calls.filter(([channel]) => channel === "attachments:stage")).toHaveLength(8);
  });

  /** The same sentence when the free slots, rather than the cap, are what ran out. */
  it("counts the surplus against the slots still free, not against eight", async () => {
    let staged = 0;
    window.eo.ipc.invoke = vi.fn(async (channel: string) => ({
      ok: true,
      data: channel === "attachments:stage"
        ? { attachment: { id: `0198a000-0000-7000-8000-00000000020${staged++}`, kind: "file", name: `first${staged}.txt`, mimeType: "text/plain", size: 5 } }
        : {},
    })) as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);
    const box = screen.getByLabelText("Write a comment");

    fireEvent.paste(box, { clipboardData: { files: Array.from({ length: 6 }, (_, index) => new File(["hello"], `first${index}.txt`, { type: "text/plain" })) } });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(6));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.paste(box, { clipboardData: { files: Array.from({ length: 5 }, (_, index) => new File(["hello"], `more${index}.txt`, { type: "text/plain" })) } });

    expect(await screen.findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so 3 were left out.");
    // Waited out rather than left running: a batch still staging when the
    // case ends goes on making IPC calls into whatever mock the *next*
    // one installs, and the next one counts calls.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(8));
  });

  /**
   * Two batches in flight at once, which is the case the cap used to be
   * only approximately true for (EO-194).
   *
   * Staging is a `FileReader` and an IPC round trip per file, and paste
   * and drop stay live throughout. Deciding how many files fit from the
   * rendered array meant both batches read the same pre-batch count: drop
   * four, paste five before either resolves, and all nine were staged.
   * Eight were shown. The ninth became a file on disk that no draft, no
   * comment and no cleanup ever mentioned again — the leak is the reason
   * this is not merely a counting bug.
   *
   * The IPC is held open until both events have been dispatched, so the
   * overlap is the test's rather than the scheduler's: without it the
   * first batch may finish before the second starts, and the assertion
   * would pass against the defect.
   */
  it("counts a second paste against a drop that is still staging", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel !== "attachments:stage") return { ok: true, data: {} };
      await held;
      staged += 1;
      return { ok: true, data: { attachment: { id: `0198a000-0000-7000-8000-0000000004${String(staged).padStart(2, "0")}`, kind: "file", name: `f${staged}.txt`, mimeType: "text/plain", size: 5 } } };
    });
    window.eo.ipc.invoke = invoke as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);
    const box = screen.getByLabelText("Write a comment");
    const files = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => new File(["hello"], `${prefix}${index}.txt`, { type: "text/plain" }));

    fireEvent.drop(box, { dataTransfer: { files: files(4, "dropped") } });
    fireEvent.paste(box, { clipboardData: { files: files(5, "pasted") } });

    // Said while both batches are still in flight: the fifth pasted file
    // is refused when it is offered, not after eight have landed.
    expect(await screen.findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so one was left out.");

    await act(async () => {
      release();
    });

    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(8));
    // The ninth was never staged, so there is nothing on disk to discard
    // and nothing to have lost track of. Counted by name: these mocks are
    // shared through `window`, so counting every call would count another
    // case's too.
    expect(stagedNames(invoke).filter((name) => /^(dropped|pasted)/.test(name))).toHaveLength(8);
    expect(invoke.mock.calls.filter(([channel]) => channel === "attachments:discard")).toHaveLength(0);
  });

  /**
   * A batch that finishes first must not let the message go without the
   * one still running (EO-194).
   *
   * `busy` is what keeps a composer unsendable while files are being
   * staged, and it was a boolean shared by every batch: the first to
   * finish cleared it while the second was still reading. Send and Enter
   * opened up, the comment went with half of what had been offered, and
   * `clearCommitted` emptied the composer — so the batch still in flight
   * committed its drafts into an empty box and they rode along on
   * whatever was written next. Two files went missing from one message
   * and appeared, unasked, on another.
   *
   * The chat appearance because that is what the assist panel draws, and
   * Enter as well as the button because Enter never consults a disabled
   * attribute.
   */
  it("stays unsendable until every overlapping batch has settled", async () => {
    const gates: { name: string; release: () => void }[] = [];
    const invoke = vi.fn(async (channel: string, payload: { name?: string }) => {
      if (channel !== "attachments:stage") return { ok: true, data: {} };
      const name = payload.name ?? "";
      await new Promise<void>((resolve) => gates.push({ name, release: resolve }));
      return { ok: true, data: { attachment: { id: `0198a000-0000-7000-8000-0000000005${name.startsWith("dropped") ? "01" : "02"}`, kind: "file", name, mimeType: "text/plain", size: 5 } } };
    });
    window.eo.ipc.invoke = invoke as never;
    const onSubmit = vi.fn(async () => {});
    render(<Composer appearance="chat" mentionables={[]} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Write a comment");

    // Two batches, both in flight: neither file is staged until its gate
    // is opened, so the overlap is the test's rather than the scheduler's.
    fireEvent.drop(box, { dataTransfer: { files: [new File(["hello"], "dropped.txt", { type: "text/plain" })] } });
    fireEvent.paste(box, { clipboardData: { files: [new File(["hello"], "pasted.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(gates).toHaveLength(2));

    // The drop lands. The paste has not.
    await act(async () => {
      gates.find((gate) => gate.name === "dropped.txt")!.release();
    });
    expect(await screen.findByText("dropped.txt")).toBeInTheDocument();

    // Neither route may send: one file is on screen and the other is
    // still being read.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(stagedNames(invoke)).toEqual(["dropped.txt", "pasted.txt"]));
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      gates.find((gate) => gate.name === "pasted.txt")!.release();
    });
    expect(await screen.findByText("pasted.txt")).toBeInTheDocument();

    // Both settled: now it sends, and it sends both.
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("", [], ["0198a000-0000-7000-8000-000000000501", "0198a000-0000-7000-8000-000000000502"]),
    );
    // And the composer is empty afterwards rather than holding a draft
    // that has already been sent.
    await waitFor(() => expect(screen.queryByText("dropped.txt")).not.toBeInTheDocument());
    expect(screen.queryByText("pasted.txt")).not.toBeInTheDocument();
  });

  /**
   * A file dropped while the message is already on its way (EO-194).
   *
   * The ids were read off the drafts before `onSubmit` was awaited, so a
   * file staged during that await belongs to neither message. Commit
   * before `clearCommitted()` and it is wiped without being sent and
   * without being discarded — bytes on disk that no draft, no comment and
   * no cleanup mentions again. Commit after and it is silently queued for
   * a message nobody has written yet.
   *
   * The wrapper that takes the drop is disabled by nothing: the textarea,
   * the paperclip and Send all grey out, and a drop lands regardless. No
   * `busy` prop is passed here on purpose — the guard has to hold on the
   * composer's own account, because a caller's `busy` is a render behind
   * `onSubmit` being called and some callers pass none at all.
   */
  it("refuses a file dropped while the message is already sending, and says so", async () => {
    const invoke = vi.fn(async (channel: string, payload: { name?: string }) => ({
      ok: true,
      data: channel === "attachments:stage"
        ? { attachment: { id: "0198a000-0000-7000-8000-000000000601", kind: "file", name: payload.name, mimeType: "text/plain", size: 5 } }
        : {},
    }));
    window.eo.ipc.invoke = invoke as never;
    let land!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      land = resolve;
    }));
    render(<Composer appearance="chat" mentionables={[]} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Write a comment");

    fireEvent.paste(box, { clipboardData: { files: [new File(["hello"], "first.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("first.txt")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("", [], ["0198a000-0000-7000-8000-000000000601"]));

    // Mid-flight, and the second file is refused rather than staged.
    fireEvent.drop(box, { dataTransfer: { files: [new File(["hello"], "second.txt", { type: "text/plain" })] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("The message was already sending, so that file was not attached.");

    // Dropping it again once the send has gone works, and takes the
    // refusal off the screen with it — a sentence that outlived what it
    // described would read as a second failure.
    await act(async () => {
      land();
    });
    fireEvent.drop(box, { dataTransfer: { files: [new File(["hello"], "second.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("second.txt")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The message carried the one file it was sent with, and nothing else
    // was posted behind it.
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Nothing was staged for the drop, so there is nothing on disk to be
    // orphaned by the clear…
    // The one that was refused mid-send was staged only when it was
    // offered again, after the message had gone — never during it.
    expect(stagedNames(invoke).filter((name) => /^(first|second)\./.test(name))).toEqual(["first.txt", "second.txt"]);
    expect(invoke.mock.calls.filter(([channel]) => channel === "attachments:discard")).toHaveLength(0);
    // …and the sent file left with the message rather than lingering as
    // a draft on the next one.
    expect(screen.queryByText("first.txt")).not.toBeInTheDocument();
  });

  /**
   * The picker's own two slices, added up.
   *
   * The native dialog belongs to main, which stages the first eight and
   * reports the rest as `omitted` — the renderer never sees them as
   * drafts at all. On top of that it discards any draft it has no free
   * slot for. Neither count is visible to the other side, so the sentence
   * is the sum, and a test that exercised only one of them would leave
   * the other silently dropping files.
   */
  it("says how many the picker left behind, when main is the one that dropped them", async () => {
    // Twelve chosen: main staged eight and says four never made it.
    const invoke = pickerReturning({ attachments: pickedDrafts(0, 8), omitted: 4 });
    window.eo.ipc.invoke = invoke as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so 4 were left out.");
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(8);
  });

  it("discards the picked drafts it has no room for, and says how many", async () => {
    // Seven staged, then three more offered into the one free slot.
    const invoke = pickerReturning(
      { attachments: pickedDrafts(0, 7), omitted: 0 },
      { attachments: pickedDrafts(10, 3), omitted: 0 },
    );
    window.eo.ipc.invoke = invoke as never;
    render(<Composer mentionables={[]} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(7));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Attach" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A message can carry at most 8 files, so 2 were left out.");
    // The two with nowhere to go are handed back rather than left staged
    // on disk for a message that will never carry them.
    await waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === "attachments:discard")).toHaveLength(2));
  });

  it.each(["default", "chat"] as const)("links ticket keys in %s composer alerts", async (appearance) => {
    renderComposerWithReferences(appearance);
    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "Please retry" } });
    fireEvent.keyDown(box, { key: "Enter" });

    const alert = await screen.findByRole("alert");
    const link = await waitFor(() => within(alert).getByRole("link", { name: "EO-2" }));
    expect(link).toHaveAttribute("href", "/items/t2");

    fireEvent.click(link);
    expect(screen.getByTestId("current-route")).toHaveTextContent("/items/t2");
  });
});

describe("the chat composer's own drawing", () => {
  it("draws the conversation's box: one line, the paperclip, the hint, and Send", () => {
    render(<Composer appearance="chat" ariaLabel="Message the assistant" mentionables={[]} onSubmit={vi.fn()} statusText="Acme ops" />);

    const box = screen.getByRole("textbox", { name: "Message the assistant" });
    expect(box).toHaveAttribute("rows", "1");
    expect(box).toHaveAttribute("placeholder", "Ask anything…");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
    expect(screen.getByText("Acme ops")).toBeInTheDocument();
    // Nothing to send yet.
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("names its button after what it does when it answers a comment", () => {
    render(<Composer mentionables={[]} onSubmit={vi.fn()} submitLabel="Reply" />);
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
  });

  it("says Posting… while the caller is busy, with every control held", () => {
    render(<Composer mentionables={[]} onSubmit={vi.fn()} busy />);

    expect(screen.getByRole("button", { name: "Posting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
    expect(screen.getByLabelText("Write a comment")).toBeDisabled();
  });

  it("is closed to a reader without claiming to be posting", () => {
    render(<Composer appearance="chat" mentionables={[]} onSubmit={vi.fn()} readOnly />);

    expect(screen.getByLabelText("Write a comment")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeDisabled();
    expect(screen.queryByText("Posting…")).not.toBeInTheDocument();
  });

  it("does not offer the machine's file picker on a server", () => {
    setBridge({
      invoke: (async () => ({ ok: true, data: {} })) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    try {
      const { unmount } = render(<Composer mentionables={[]} onSubmit={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Attach" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
      unmount();
      render(<Composer appearance="chat" mentionables={[]} onSubmit={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    } finally {
      setBridge(undefined);
    }
  });

  it("completes a mention with the arrows and Enter, and sends who was mentioned", () => {
    const onSubmit = vi.fn();
    render(<Composer mentionables={["user", "implementer", "reviewer"]} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Write a comment");

    fireEvent.change(box, { target: { value: "ask @" } });
    expect(screen.getByRole("listbox", { name: "Mention suggestions" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "@user" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "@implementer" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(screen.getByRole("option", { name: "@reviewer" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("ask @reviewer ");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("ask @reviewer", ["reviewer"], []);
  });

  it("offers the caller's completions with their descriptions in the chat box, and takes one with Tab", () => {
    render(
      <Composer
        appearance="chat"
        mentionables={[]}
        onSubmit={vi.fn()}
        completions={[{ trigger: "/", value: "clear", description: "Start a new chat" }, { trigger: "$", value: "skill" }]}
      />,
    );
    const box = screen.getByLabelText("Write a comment");

    fireEvent.change(box, { target: { value: "/cl" } });
    const list = screen.getByRole("listbox", { name: "Composer suggestions" });
    expect(within(list).getByRole("option")).toHaveTextContent("/clearStart a new chat");

    fireEvent.keyDown(box, { key: "Tab" });
    expect(box).toHaveValue("/clear ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("takes a suggestion on a click without losing the field's focus", () => {
    render(<Composer mentionables={["implementer"]} onSubmit={vi.fn()} />);
    const box = screen.getByLabelText("Write a comment");
    box.focus();
    fireEvent.change(box, { target: { value: "@im" } });

    const option = screen.getByRole("option", { name: "@implementer" });
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(box).toHaveValue("@implementer ");
    expect(box).toHaveFocus();
  });

  it("keeps what was typed when the post fails, and says why", async () => {
    render(<Composer appearance="chat" mentionables={[]} onSubmit={async () => { throw new Error("The room is closed."); }} />);
    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The room is closed.");
    expect(box).toHaveValue("Keep me");
  });

  it("clears once the post has landed, and not before", async () => {
    let land!: () => void;
    render(<Composer mentionables={[]} onSubmit={() => new Promise<void>((resolve) => { land = resolve; })} />);
    const box = screen.getByLabelText("Write a comment");
    fireEvent.change(box, { target: { value: "On its way" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(box).toHaveValue("On its way");
    await act(async () => {
      land();
    });
    expect(box).toHaveValue("");
  });

  /**
   * `clearOnSend` (EO-549): the conversation draws the message as sending,
   * so its box lets go at once — and a refusal gives everything back.
   */
  it("lets go of the text and the staged files as it sends, with clearOnSend", async () => {
    const attachment = { id: "0198a000-0000-7000-8000-000000000801", kind: "file", name: "sent-along.txt", mimeType: "text/plain", size: 5 };
    window.eo.ipc.invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === "attachments:stage" ? { attachment } : {} })) as never;
    let land!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => (land = resolve)));
    render(<Composer appearance="chat" mentionables={[]} clearOnSend onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Write a comment");
    fireEvent.paste(box, { clipboardData: { files: [new File(["hello"], "sent-along.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("sent-along.txt")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "On its way" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("On its way", [], [attachment.id]);
    expect(box).toHaveValue("");
    expect(screen.queryByText("sent-along.txt")).not.toBeInTheDocument();
    await act(async () => land());
    expect(box).toHaveValue("");
    expect(screen.queryByText("sent-along.txt")).not.toBeInTheDocument();
  });

  it("gives the text and the staged files back when a clearOnSend send is refused, and says why", async () => {
    const attachment = { id: "0198a000-0000-7000-8000-000000000802", kind: "file", name: "kept.txt", mimeType: "text/plain", size: 5 };
    window.eo.ipc.invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === "attachments:stage" ? { attachment } : {} })) as never;
    let refuse!: (error: Error) => void;
    const onSubmit = vi.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
    render(<Composer appearance="chat" mentionables={[]} clearOnSend onSubmit={onSubmit} />);
    const box = screen.getByLabelText("Write a comment");
    fireEvent.paste(box, { clipboardData: { files: [new File(["hello"], "kept.txt", { type: "text/plain" })] } });
    expect(await screen.findByText("kept.txt")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "  Keep me  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box).toHaveValue("");

    await act(async () => refuse(new Error("That conversation is closed.")));

    expect(box).toHaveValue("  Keep me  ");
    expect(screen.getByText("kept.txt")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("That conversation is closed.");
    // Sent again, it carries the same files.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenLastCalledWith("Keep me", [], [attachment.id]);
  });

  it("removes a staged file on its own button", async () => {
    const attachment = { id: "0198a000-0000-7000-8000-000000000701", kind: "file", name: "drop-me.txt", mimeType: "text/plain", size: 5 };
    window.eo.ipc.invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === "attachments:stage" ? { attachment } : {} })) as never;
    render(<Composer appearance="chat" mentionables={[]} onSubmit={vi.fn()} />);

    fireEvent.paste(screen.getByLabelText("Write a comment"), { clipboardData: { files: [new File(["hello"], "drop-me.txt", { type: "text/plain" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "Remove drop-me.txt" }));

    expect(screen.queryByText("drop-me.txt")).not.toBeInTheDocument();
  });
});

/** Claude Desktop's box while a turn runs, and its keyboard (Stop, Escape, Up, slash commands). */
describe("the chat box while a turn runs", () => {
  function renderChat(props: Partial<Parameters<typeof Composer>[0]> = {}) {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <Composer appearance="chat" mentionables={[]} onSubmit={onSubmit} {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { onSubmit, box: screen.getByRole("textbox") };
  }

  it("offers Stop instead of Send while the box is empty, and Send again once something is typed", () => {
    const onStop = vi.fn();
    const { box } = renderChat({ running: true, onStop });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: "use main instead", selectionStart: 16 } });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("stops on Escape, and not while it is already stopping", () => {
    const onStop = vi.fn();
    const { box } = renderChat({ running: true, onStop });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("closes the suggestion list on Escape before it stops anything", async () => {
    const onStop = vi.fn();
    const { box } = renderChat({ running: true, onStop, completions: [{ trigger: "/", value: "model", description: "Choose the model" }] });
    fireEvent.change(box, { target: { value: "/mo", selectionStart: 3 } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    // Typing opens it again.
    fireEvent.change(box, { target: { value: "/mod", selectionStart: 4 } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("does nothing on Escape when nothing is running", () => {
    const onStop = vi.fn();
    const { box } = renderChat({ running: false, onStop });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onStop).not.toHaveBeenCalled();
  });

  it("brings the last message back on Up in an empty box", () => {
    const { box } = renderChat({ recallLast: "Rework the release pipeline." });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box).toHaveValue("Rework the release pipeline.");
  });

  it("runs a slash command it knows instead of sending it, and sends one it does not", async () => {
    const onCommand = vi.fn((command: string) => command === "model");
    const { box, onSubmit } = renderChat({ onCommand, completions: [{ trigger: "/", value: "model", description: "Choose the model" }] });

    fireEvent.change(box, { target: { value: "/model claude-sonnet-5", selectionStart: 22 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onCommand).toHaveBeenCalledWith("model", "claude-sonnet-5"));
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(box).toHaveValue(""));

    fireEvent.change(box, { target: { value: "/etc/hosts is wrong", selectionStart: 19 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/etc/hosts is wrong", [], []));
  });

  it("draws the controls it is given in its own row", () => {
    renderChat({ controls: <button type="button">Opus · high</button> });
    expect(screen.getByRole("button", { name: "Opus · high" })).toBeInTheDocument();
  });
});

describe("saying somebody is typing", () => {
  it("says so on the first character and not again on every keystroke after", () => {
    const onTyping = vi.fn();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <Composer appearance="chat" mentionables={[]} onSubmit={async () => undefined} onTyping={onTyping} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: " ", selectionStart: 1 } });
    expect(onTyping).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "W", selectionStart: 1 } });
    fireEvent.change(box, { target: { value: "Wh", selectionStart: 2 } });
    fireEvent.change(box, { target: { value: "Wha", selectionStart: 3 } });
    expect(onTyping).toHaveBeenCalledTimes(1);
  });

  it("says so again for the next message once one is sent", async () => {
    const onTyping = vi.fn();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <Composer appearance="chat" mentionables={[]} onSubmit={async () => undefined} onTyping={onTyping} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "First", selectionStart: 5 } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box).toHaveValue(""));
    fireEvent.change(box, { target: { value: "S", selectionStart: 1 } });
    expect(onTyping).toHaveBeenCalledTimes(2);
  });
});
