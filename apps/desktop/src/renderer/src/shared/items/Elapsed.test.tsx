import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Elapsed } from "./Elapsed";

/**
 * A "how long ago" that keeps counting with nothing else redrawing it
 * (EO-570), on one clock however many of them are on screen.
 */

const NOW = new Date("2026-01-01T12:00:00Z").getTime();
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Elapsed", () => {
  it("advances on its own: 4m becomes 5m a minute later", () => {
    render(<Elapsed since={NOW - 4 * MINUTE} />);
    expect(screen.getByText("4m")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });

    expect(screen.getByText("5m")).toBeInTheDocument();
  });

  it("says minutes under an hour, hours under a day and days beyond", () => {
    render(
      <>
        <span data-testid="m">
          <Elapsed since={NOW - 59 * MINUTE} />
        </span>
        <span data-testid="h">
          <Elapsed since={NOW - 23 * 60 * MINUTE} />
        </span>
        <span data-testid="d">
          <Elapsed since={NOW - 3 * 24 * 60 * MINUTE} />
        </span>
      </>,
    );
    expect(screen.getByTestId("m")).toHaveTextContent(/^59m$/);
    expect(screen.getByTestId("h")).toHaveTextContent(/^23h$/);
    expect(screen.getByTestId("d")).toHaveTextContent(/^3d$/);

    act(() => {
      vi.advanceTimersByTime(MINUTE);
    });

    expect(screen.getByTestId("m")).toHaveTextContent(/^1h$/);
    expect(screen.getByTestId("h")).toHaveTextContent(/^23h$/);
  });

  it("never says less than nothing for a time a little ahead of this clock", () => {
    render(<Elapsed since={NOW + 5_000} />);
    expect(screen.getByText("0m")).toBeInTheDocument();
  });

  it("shares one interval between every label, and stops it when the last one goes", () => {
    const { unmount } = render(
      <>
        {Array.from({ length: 50 }, (_, index) => (
          <Elapsed key={index} since={NOW - index * MINUTE} />
        ))}
      </>,
    );
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
