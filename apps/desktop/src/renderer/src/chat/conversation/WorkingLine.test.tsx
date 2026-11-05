import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingLine } from "./WorkingLine";

describe("the chat working line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("says Working once, and keeps its ticking clock out of the announcement", () => {
    render(<WorkingLine since={Date.now() - 9_000} />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Working");
    const clock = screen.getByText("9s");
    expect(clock).toHaveAttribute("aria-hidden", "true");

    // The clock moves on its own, with nothing pushed to redraw it.
    act(() => {
      vi.advanceTimersByTime(56_000);
    });
    expect(screen.getByText("1:05")).toBeInTheDocument();
  });

  it("shows an ellipsis before the turn has a start", () => {
    render(<WorkingLine since={null} />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});
