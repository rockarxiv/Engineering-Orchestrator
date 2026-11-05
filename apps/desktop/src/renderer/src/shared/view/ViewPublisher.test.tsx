import type { ReactNode } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ViewPublisher, useViewParameters } from "./ViewPublisher";

/**
 * What the window tells the main process it is showing (EO-192).
 *
 * Every case asserts on the *payload*, because the payload is the whole
 * design: identifiers and view parameters leave this side, never a
 * sentence about an item and never a row the renderer resolved for
 * itself.
 */
let destination: string | null = null;

beforeEach(() => {
  destination = null;
});

/** Every `view:publish` call, in order. */
function published(): Record<string, unknown>[] {
  const invoke = window.eo.ipc.invoke as unknown as ReturnType<typeof vi.fn>;
  return invoke.mock.calls
    .filter((call: unknown[]) => call[0] === "view:publish")
    .map((call: unknown[]) => call[1] as Record<string, unknown>);
}

function latest(): Record<string, unknown> | undefined {
  return published().at(-1);
}

/**
 * A tree the test can walk around in.
 *
 * Real routes, so a walk really does unmount the screen being left —
 * which is the whole of what the last case here is about. `Navigate` is
 * rendered on demand rather than driven through a router hook so the
 * navigation happens inside the tree the publisher is mounted in.
 */
function walkable(path: string, screen: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewPublisher>
        {destination === null ? null : <Navigate to={destination} replace />}
        <Routes>
          <Route path="/items" element={<>{screen}</>} />
          <Route path="/agents" element={<>{screen}</>} />
          <Route path="/settings" element={<Screen />} />
          <Route path="*" element={<>{screen}</>} />
        </Routes>
      </ViewPublisher>
    </MemoryRouter>,
  );
}

function Screen({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function Filtered({ text }: { text: string }) {
  useViewParameters({ filter: { text, facets: { type: "bug" } }, sort: "updated:desc" });
  return <div>filtered</div>;
}

function Faceted({ facets }: { facets: Record<string, string> }) {
  useViewParameters({ filter: { text: "", facets } });
  return <div>faceted</div>;
}

function Selecting({ id }: { id: string }) {
  useViewParameters({ selection: [id] });
  return <div>selecting</div>;
}

function Editing({ field = "Base branch", value }: { field?: string; value: string }) {
  useViewParameters({ unsavedEdits: [{ field, value }] });
  return <div>editing</div>;
}

describe("publishing the current view", () => {
  it("sends the route and its parameters, resolved against the shared table", async () => {
    walkable("/items/019fb8c6-de92-7a41-9c33-4471f0c2b1de", <Screen />);

    await waitFor(() => {
      expect(latest()?.["page"]).toEqual({
        route: "/items/:itemId",
        params: { itemId: "019fb8c6-de92-7a41-9c33-4471f0c2b1de" },
      });
    });
  });

  it("sends an unlisted path as itself rather than guessing at what it is", async () => {
    walkable("/somewhere-new", <Screen />);

    await waitFor(() => expect(latest()?.["page"]).toEqual({ route: "/somewhere-new", params: {} }));
  });

  it("carries a screen's own filter and ordering, as set", async () => {
    walkable("/items", <Filtered text="rate" />);

    await waitFor(() => {
      expect(latest()?.["filter"]).toEqual({ text: "rate", facets: { type: "bug" } });
      expect(latest()?.["sort"]).toBe("updated:desc");
    });
  });

  it("carries a selection as ids and nothing more", async () => {
    walkable("/agents", <Selecting id="019fb8c6-de92-7a41-9c33-4471f0c2b1df" />);

    await waitFor(() => expect(latest()?.["selection"]).toEqual(["019fb8c6-de92-7a41-9c33-4471f0c2b1df"]));
  });

  it("republishes when the filter changes, so what is on screen is what was sent", async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={["/items"]}>
        <ViewPublisher>
          <Filtered text="rate" />
        </ViewPublisher>
      </MemoryRouter>,
    );
    await waitFor(() => expect(latest()?.["filter"]).toEqual({ text: "rate", facets: { type: "bug" } }));

    rerender(
      <MemoryRouter initialEntries={["/items"]}>
        <ViewPublisher>
          <Filtered text="limit" />
        </ViewPublisher>
      </MemoryRouter>,
    );

    await waitFor(() => expect((latest()?.["filter"] as { text: string }).text).toBe("limit"));
  });

  /**
   * The case the route on a registration exists for.
   *
   * Walking from a filtered list to Settings must not describe Settings
   * with the list's filter — not even for the moment between the
   * location changing and the old screen's cleanup running. A tool call
   * takes exactly that long.
   */
  it("never describes one screen with another's filter, not even for a render", async () => {
    destination = "/settings";
    walkable("/items", <Filtered text="rate" />);

    await waitFor(() => expect((latest()?.["page"] as { route: string }).route).toBe("/settings"));

    // Every publish, not just the last one. The window that would show
    // the defect is one commit wide — the location has changed and the
    // screen being left has not finished unmounting — and a tool call
    // takes exactly that long.
    const settings = published().filter((payload) => (payload["page"] as { route: string }).route === "/settings");
    expect(settings.length).toBeGreaterThan(0);
    expect(settings.every((payload) => payload["filter"] === null)).toBe(true);
  });

  it("carries what has been typed into a field and not saved", async () => {
    walkable("/archive", <Editing value="release/next" />);

    await waitFor(() => expect(latest()?.["unsavedEdits"]).toEqual([{ field: "Base branch", value: "release/next" }]));
  });

  it("truncates a long unsaved value rather than letting it fail the whole publish", async () => {
    // A text area can hold an agent's whole instructions. A payload
    // refused at the boundary would take the route and the filter down
    // with it — the screen would go dark to the agent because somebody
    // pasted three paragraphs.
    walkable("/archive", <Editing value={"x".repeat(5_000)} />);

    await waitFor(() => {
      const edits = latest()?.["unsavedEdits"] as { value: string }[];
      expect(edits[0]?.value.length).toBe(500);
    });
  });

  /**
   * Two editors open at once is the ordinary case on Settings, which
   * renders Projects and Repositories together. An answer carrying one
   * of them is an answer saying the other does not exist.
   */
  it("carries every open editor's unsaved edits, not the last one to mount", async () => {
    walkable(
      "/archive",
      <>
        <Editing field="Branch prefix" value="" />
        <Editing field="New project name" value="Shop" />
      </>,
    );

    await waitFor(() => {
      expect(latest()?.["unsavedEdits"]).toEqual([
        { field: "Branch prefix", value: "" },
        { field: "New project name", value: "Shop" },
      ]);
    });
  });

  it("forgets one editor's edits when it closes and keeps the other's", async () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={["/archive"]}>
        <ViewPublisher>
          <Editing field="Branch prefix" value="" />
          <Editing field="New project name" value="Shop" />
        </ViewPublisher>
      </MemoryRouter>,
    );
    await waitFor(() => expect((latest()?.["unsavedEdits"] as unknown[]).length).toBe(2));

    rerender(
      <MemoryRouter initialEntries={["/archive"]}>
        <ViewPublisher>
          <Editing field="Branch prefix" value="" />
        </ViewPublisher>
      </MemoryRouter>,
    );

    await waitFor(() => expect(latest()?.["unsavedEdits"]).toEqual([{ field: "Branch prefix", value: "" }]));
  });

  /**
   * A screen's narrowing is not always owned by one component. Agent
   * tools holds which catalogue is open while each catalogue holds its
   * own *Show archived*, and the button belongs beside the list it
   * reveals. Taking the first filter would drop the other, and the
   * answer could not tell a live-only list from one showing archived
   * rows.
   */
  it("merges the facets of every part of a screen that narrows it", async () => {
    walkable(
      "/archive",
      <>
        <Faceted facets={{ tab: "servers" }} />
        <Faceted facets={{ archived: "true" }} />
      </>,
    );

    await waitFor(() => expect(latest()?.["filter"]).toEqual({ text: "", facets: { tab: "servers", archived: "true" } }));
  });

  it("keeps the search box when another part contributes facets alone", async () => {
    walkable(
      "/items",
      <>
        <Filtered text="rate" />
        <Faceted facets={{ archived: "true" }} />
      </>,
    );

    // A component sending only facets sends `text: ""`, and must not
    // blank out the box beside it.
    await waitFor(() => {
      expect((latest()?.["filter"] as { text: string }).text).toBe("rate");
      expect((latest()?.["filter"] as { facets: Record<string, string> }).facets).toMatchObject({ archived: "true", type: "bug" });
    });
  });

  it("still reports no filter at all where nothing narrows the screen", async () => {
    // Merging must not turn "this screen has none" into "one set to
    // nothing" — the reply says those in different words.
    walkable("/settings", <Screen />);

    await waitFor(() => expect(latest()?.["filter"]).toBeNull());
  });

  /**
   * The same defect one level down, hiding inside a navigation that
   * never changes route.
   *
   * `/items/:itemId/runs` is one route and two screens. Walking from
   * item A's runs to item B's keeps the pattern, so a check on the
   * pattern alone would let A's open-run selection be published against
   * B's descriptor until the child effect caught up — and a tool call
   * takes exactly that long.
   */
  it("discards the outgoing screen's selection when only the id in the path changed", async () => {
    destination = "/items/b/runs";
    render(
      <MemoryRouter initialEntries={["/items/a/runs"]}>
        <ViewPublisher>
          {destination === null ? null : <Navigate to={destination} replace />}
          <Routes>
            <Route path="/items/a/runs" element={<Selecting id="run-of-a" />} />
            <Route path="/items/b/runs" element={<Screen />} />
          </Routes>
        </ViewPublisher>
      </MemoryRouter>,
    );

    await waitFor(() => expect((latest()?.["page"] as { params: { itemId: string } }).params.itemId).toBe("b"));

    // Every publish that named item B, not merely the last: the window
    // where the defect shows is one commit wide.
    const onB = published().filter((payload) => (payload["page"] as { params: { itemId?: string } }).params.itemId === "b");
    expect(onB.length).toBeGreaterThan(0);
    expect(onB.every((payload) => (payload["selection"] as string[]).length === 0)).toBe(true);
  });

  it("still keeps a contributor's parameters while the page stays the same", async () => {
    // The other half: an identity that changed when it should not would
    // drop a filter on every render and publish an empty screen.
    walkable("/items/019fb8c6-de92-7a41-9c33-4471f0c2b1de", <Selecting id="run-of-a" />);

    await waitFor(() => expect(latest()?.["selection"]).toEqual(["run-of-a"]));
  });

  it("publishes nothing but the route on a screen that contributes none", async () => {
    walkable("/settings", <Screen />);

    await waitFor(() => {
      expect(latest()?.["filter"]).toBeNull();
      expect(latest()?.["selection"]).toEqual([]);
      expect(latest()?.["sort"]).toBeNull();
      expect(latest()?.["unsavedEdits"]).toEqual([]);
    });
  });

  it("publishes the page it is on", async () => {
    walkable("/agents", <Filtered text="rate" />);

    await waitFor(() => expect(latest()?.["page"]).toEqual({ route: "/agents", params: {} }));
  });

  it("survives a main process that will not take it, rather than failing the screen", async () => {
    window.eo.ipc.invoke = vi.fn(async (channel: string) =>
      channel === "view:publish" ? { ok: false, error: { message: "nope" } } : { ok: true, data: {} },
    ) as never;

    walkable("/settings", <Screen />);

    // The screen still rendered; the only cost is that the answer is a
    // little behind, which the tool's own reply already warns about.
    await waitFor(() => expect(published().length).toBeGreaterThan(0));
  });
});

describe("a component that contributes parameters outside the publisher", () => {
  it("publishes nothing rather than failing", () => {
    // A dialog mounted elsewhere, or a component under test on its own.
    // Requiring the provider would make a filter publishable only from
    // inside one tree.
    expect(() => render(<Filtered text="rate" />)).not.toThrow();
    expect(published()).toEqual([]);
  });
});
