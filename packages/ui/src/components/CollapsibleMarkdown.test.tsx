import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLAPSE_ABOVE_PX, COLLAPSED_HEIGHT_PX, CollapsibleMarkdown } from "./CollapsibleMarkdown.js";

/** jsdom lays nothing out, so the height the component measures is whatever this says it is. */
function renderedHeight(px: number) {
  return vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(px);
}

function bodyOf(toggle: HTMLElement): HTMLElement {
  const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  if (!body) throw new Error("the toggle names no body");
  return body;
}

describe("CollapsibleMarkdown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clips a body taller than the threshold and offers Show more", () => {
    renderedHeight(COLLAPSE_ABOVE_PX + 1);
    render(<CollapsibleMarkdown>A **long** report.</CollapsibleMarkdown>);

    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(bodyOf(toggle)).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });
    expect(bodyOf(toggle)).toHaveClass("overflow-hidden");
    // Clipped, not removed: the words are still there to be searched and read out.
    expect(screen.getByText("long").tagName).toBe("STRONG");
  });

  it("draws a body at the threshold in full, with no toggle", () => {
    renderedHeight(COLLAPSE_ABOVE_PX);
    const { container } = render(<CollapsibleMarkdown>Just short enough.</CollapsibleMarkdown>);

    expect(screen.getByText("Just short enough.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("expands on Show more and clips again on Show less", () => {
    renderedHeight(900);
    render(<CollapsibleMarkdown>A long report.</CollapsibleMarkdown>);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    const toggle = screen.getByRole("button", { name: "Show less" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(bodyOf(toggle).style.maxHeight).toBe("");
    expect(bodyOf(toggle)).not.toHaveClass("overflow-hidden");

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
    expect(bodyOf(toggle)).toHaveStyle({ maxHeight: `${COLLAPSED_HEIGHT_PX}px` });
  });

  it("is reached and operated from the keyboard", () => {
    renderedHeight(900);
    render(<CollapsibleMarkdown>A long report.</CollapsibleMarkdown>);

    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(toggle, { key: " " });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(toggle, { key: "a" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("still toggles inside a disabled fieldset, where a real button would be dead", () => {
    renderedHeight(900);
    render(
      <fieldset disabled>
        <button type="button">Pin comment</button>
        <CollapsibleMarkdown>A long report.</CollapsibleMarkdown>
      </fieldset>,
    );

    expect(screen.getByRole("button", { name: "Pin comment" })).toBeDisabled();
    const toggle = screen.getByRole("button", { name: "Show more" });
    // Not a form control, which is the whole of why the fieldset leaves it alone.
    expect(toggle.matches("button, input, select, textarea")).toBe(false);
    expect(toggle.matches(":disabled")).toBe(false);

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("keeps what the reader chose when it is drawn again", () => {
    renderedHeight(900);
    const { rerender } = render(<CollapsibleMarkdown>A long report.</CollapsibleMarkdown>);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    rerender(<CollapsibleMarkdown>A long report.</CollapsibleMarkdown>);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});
