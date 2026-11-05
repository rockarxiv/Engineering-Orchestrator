import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./useStickToBottom";

/**
 * A scroller jsdom can measure: heights it is told, and a scrollTop it
 * clamps the way a browser does.
 */
function measured(element: HTMLElement, sizes: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => sizes.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => sizes.clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, sizes.scrollHeight - sizes.clientHeight));
    },
  });
}

let resize: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resize = null;
});

function Harness({ sizes, resetKey = "a" }: { sizes: { scrollHeight: number; clientHeight: number }; resetKey?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const { following, jumpToLatest } = useStickToBottom(scroller, content, resetKey);
  return (
    <>
      <div
        data-testid="scroller"
        ref={(element) => {
          scroller.current = element;
          if (element && !ready.current) {
            measured(element, sizes);
            ready.current = true;
          }
        }}
      >
        <div ref={content} />
      </div>
      <span data-testid="following">{String(following)}</span>
      <button type="button" onClick={jumpToLatest}>
        Jump
      </button>
    </>
  );
}

describe("following the newest words", () => {
  it("starts at the end and stays there as the content grows", () => {
    const sizes = { scrollHeight: 1000, clientHeight: 400 };
    render(<Harness sizes={sizes} />);
    const scroller = screen.getByTestId("scroller");
    expect(scroller.scrollTop).toBe(600);
    sizes.scrollHeight = 1300;
    act(() => resize?.());
    expect(scroller.scrollTop).toBe(900);
  });

  it("stops following the moment the person moves up, even while the content grows, and leaves them where they are", () => {
    const sizes = { scrollHeight: 1000, clientHeight: 400 };
    render(<Harness sizes={sizes} />);
    const scroller = screen.getByTestId("scroller");
    fireEvent.wheel(scroller, { deltaY: -120 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    sizes.scrollHeight = 1400;
    act(() => resize?.());
    expect(scroller.scrollTop).toBe(300);
    expect(screen.getByTestId("following")).toHaveTextContent("false");
  });

  it("follows again once the person scrolls back to the end, or jumps there", () => {
    const sizes = { scrollHeight: 1000, clientHeight: 400 };
    render(<Harness sizes={sizes} />);
    const scroller = screen.getByTestId("scroller");
    fireEvent.keyDown(scroller, { key: "PageUp" });
    expect(screen.getByTestId("following")).toHaveTextContent("false");
    scroller.scrollTop = 580;
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("following")).toHaveTextContent("true");

    fireEvent.wheel(scroller, { deltaY: -50 });
    expect(screen.getByTestId("following")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    expect(screen.getByTestId("following")).toHaveTextContent("true");
    expect(scroller.scrollTop).toBe(600);
  });

  it("does not read its own scroll as the person's", () => {
    const sizes = { scrollHeight: 1000, clientHeight: 400 };
    render(<Harness sizes={sizes} />);
    const scroller = screen.getByTestId("scroller");
    sizes.scrollHeight = 5000;
    act(() => resize?.());
    fireEvent.scroll(scroller);
    expect(screen.getByTestId("following")).toHaveTextContent("true");
  });
});
