import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, ContextMenu, Dialog, Menu, contextMenuAt, isContextMenuKey, type ContextMenuAt } from "./overlays";

describe("the kit's dialog", () => {
  it("closes on Escape and on its X, and stays put while its action is in flight", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="Delete it?">
        <button type="button">Inside</button>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    rerender(
      <Dialog open onClose={onClose} title="Delete it?" busy>
        <button type="button">Inside</button>
      </Dialog>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeDisabled();
    // The answer to what is in flight is shown to somebody: nothing closed it.
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "Delete it?" })).toBeInTheDocument();
  });

  it("brings focus that fell out of it back in on Tab", () => {
    function Shifting() {
      const [gone, setGone] = useState(false);
      return (
        <Dialog open onClose={() => undefined} title="Pick one">
          {gone ? null : (
            <button type="button" onClick={() => setGone(true)}>
              Vanishes
            </button>
          )}
          <button type="button">Stays</button>
        </Dialog>
      );
    }
    render(<Shifting />);
    const vanishing = screen.getByRole("button", { name: "Vanishes" });
    vanishing.focus();
    fireEvent.click(vanishing);
    // The control focus was on went away; focus fell to the page behind.
    document.body.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("dialog", { name: "Pick one" })).toContainElement(document.activeElement as HTMLElement);
  });

  it("opens a dangerous confirmation on Cancel, and any other on its action", () => {
    const { rerender } = render(<ConfirmDialog open title="Delete the pipeline?" confirmLabel="Delete it" tone="danger" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    rerender(<ConfirmDialog open={false} title="Publish?" confirmLabel="Publish" onConfirm={() => undefined} onCancel={() => undefined} />);
    rerender(<ConfirmDialog open title="Publish?" confirmLabel="Publish" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole("button", { name: "Publish" })).toHaveFocus();
  });
});

describe("the kit's menu", () => {
  it("is used from the keyboard: focus moves in, arrows move, Enter chooses, focus goes back", () => {
    const exported = vi.fn();
    const deleted = vi.fn();
    render(
      <Menu
        label="Pipeline actions"
        trigger="…"
        entries={[
          { label: "Export", onSelect: exported },
          { label: "Import", onSelect: () => undefined, disabled: true },
          { label: "Delete", onSelect: deleted, tone: "danger" },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Pipeline actions" });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Export" })).toHaveFocus();

    // The disabled entry is passed over.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Export" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape, back on its button, having chosen nothing", () => {
    const exported = vi.fn();
    render(<Menu label="Pipeline actions" trigger="…" entries={[{ label: "Export", onSelect: exported }]} />);
    const trigger = screen.getByRole("button", { name: "Pipeline actions" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(exported).not.toHaveBeenCalled();
  });
});

describe("the kit's context menu", () => {
  function Row({ onRemove }: { onRemove: () => void }) {
    const [at, setAt] = useState<ContextMenuAt | null>(null);
    return (
      <>
        <button
          type="button"
          onContextMenu={(event) => {
            event.preventDefault();
            setAt(contextMenuAt(event.currentTarget, event));
          }}
          onKeyDown={(event) => {
            if (isContextMenuKey(event)) setAt(contextMenuAt(event.currentTarget));
          }}
        >
          A row
        </button>
        <ContextMenu label="Row actions" at={at} onClose={() => setAt(null)} entries={[{ label: "Remove", onSelect: onRemove, tone: "danger" }]} />
      </>
    );
  }

  it("opens at the pointer, kept inside the window, with focus on its first command", () => {
    render(<Row onRemove={() => undefined} />);
    const row = screen.getByRole("button", { name: "A row" });

    fireEvent.contextMenu(row, { clientX: 30, clientY: 50 });
    expect(screen.getByRole("menu", { name: "Row actions" })).toHaveStyle({ top: "50px", left: "30px" });
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // Asked for at the far corner, the whole menu is still on screen.
    fireEvent.contextMenu(row, { clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 });
    expect(screen.getByRole("menu")).toHaveStyle({ top: `${window.innerHeight - 51}px`, left: `${window.innerWidth - 216}px` });
  });

  it("opens from the keyboard, and Escape, a click away and choosing all hand focus back to what it was opened on", () => {
    const removed = vi.fn();
    render(<Row onRemove={removed} />);
    const row = screen.getByRole("button", { name: "A row" });

    fireEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();

    row.blur();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    fireEvent.click([...document.querySelectorAll("button[aria-hidden].fixed")].at(-1)!);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    expect(removed).not.toHaveBeenCalled();

    row.blur();
    fireEvent.keyDown(row, { key: "ContextMenu" });
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(removed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("names the way out of a confirmation when Cancel would not say what is kept", () => {
    render(<ConfirmDialog open title="Remove it?" confirmLabel="Remove chat" cancelLabel="Keep chat" tone="danger" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole("button", { name: "Keep chat" })).toHaveFocus();
  });
});
