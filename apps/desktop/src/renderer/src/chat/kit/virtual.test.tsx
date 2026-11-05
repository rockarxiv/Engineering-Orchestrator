import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowsViewport } from "./testing";
import { VirtualRows, scrollingAncestorOf } from "./virtual";

/** A long list a screenful at a time (EO-565). */

const ROWS = Array.from({ length: 1000 }, (_, index) => ({ id: `r${index}`, title: `Row ${index}` }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the nearest scroller above a list", () => {
  it("is the closest ancestor that scrolls vertically", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    const inner = document.createElement("div");
    inner.style.overflowY = "scroll";
    const plain = document.createElement("div");
    const node = document.createElement("div");
    outer.append(inner);
    inner.append(plain);
    plain.append(node);
    document.body.append(outer);

    expect(scrollingAncestorOf(node)).toBe(inner);
    expect(scrollingAncestorOf(plain)).toBe(inner);
    expect(scrollingAncestorOf(inner)).toBe(outer);
    outer.remove();
  });

  it("is nobody where only the window scrolls", () => {
    const node = document.createElement("div");
    document.body.append(node);
    expect(scrollingAncestorOf(node)).toBeNull();
    node.remove();
  });
});

describe("a virtual list", () => {
  it("mounts a screenful of a thousand rows, in a labelled list of items", () => {
    render(
      <RowsViewport fits={15}>
        <VirtualRows label="Things" data={ROWS} rowKey={(row) => row.id}>
          {(row) => <span>{row.title}</span>}
        </VirtualRows>
      </RowsViewport>,
    );

    const mounted = within(screen.getByRole("list", { name: "Things" })).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThanOrEqual(15);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.getByText("Row 0")).toBeInTheDocument();
    expect(screen.queryByText("Row 999")).toBeNull();
  });

  it("scrolls with the view it is in, mounting no more of it", () => {
    // jsdom has no ResizeObserver, and a list following a scroller of
    // its own watches that scroller's size with one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      <RowsViewport fits={15}>
        <div data-testid="canvas" style={{ overflowY: "auto" }}>
          <VirtualRows label="Things" data={ROWS} rowKey={(row) => row.id}>
            {(row) => <span>{row.title}</span>}
          </VirtualRows>
        </div>
      </RowsViewport>,
    );

    const mounted = within(screen.getByRole("list", { name: "Things" })).getAllByRole("listitem");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(100);
    expect(screen.queryByText("Row 999")).toBeNull();
  });
});
