import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Markdown, type MarkdownProps } from "@eo/ui";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { itemsKey } from "../../query/hooks";
import { itemReferencesKey } from "../../shared/items/itemReference";
import { ItemReferenceProvider } from "./ItemReferenceProvider";

/**
 * Every render of a `Markdown`, counted from inside it. A `Profiler` cannot
 * count these: React propagates a context change lazily, so a Profiler
 * above a consumer redrawn only by its context is never told.
 */
const markdown = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@eo/ui", async (importOriginal) => {
  // Typed by the one name used, as the layout test lets the renderer take nothing whole from here.
  const actual = await importOriginal<{ Markdown: typeof Markdown }>();
  return {
    ...actual,
    // Called rather than rendered, so its hooks — the context read
    // included — are this component's, and each of its renders is one here.
    Markdown: (props: MarkdownProps) => {
      markdown.renders += 1;
      return actual.Markdown(props);
    },
  };
});

/**
 * The item-reference catalog after EO-560: drawn from the board's own
 * list, and never filing one project's keys under another's — however
 * the reads in flight when the project changes come back.
 */

type Listener = (payload: unknown) => void;

/** A read held until the test answers it. */
interface Held {
  /** Answers with these keys; `rest` is what else each summary says — a step, a title. */
  answer: (keys: string[], rest?: Record<string, unknown>) => void;
}

function summary(key: string, rest: Record<string, unknown> = {}) {
  return { id: `id-${key}`, key, title: key, ...rest };
}

/**
 * The bridge, with `items:list` answered only when the test says, and the
 * active project whatever the test last set.
 */
function fakeBridge() {
  let active = "A";
  const held: Held[] = [];
  const listeners = new Map<string, Set<Listener>>();
  window.eo.ipc.subscribe = vi.fn((channel: string, callback: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(callback);
    listeners.set(channel, set);
    return () => set.delete(callback);
  }) as never;
  window.eo.ipc.invoke = vi.fn((channel: string) => {
    switch (channel) {
      case "projects:list":
        return Promise.resolve({
          ok: true,
          data: {
            projects: ["A", "B"].map((id) => ({ id, name: id, keyPrefix: id, jiraProjectId: null, repositoryIds: [], itemCount: 0 })),
            activeProjectId: active,
          },
        });
      case "items:list":
        return new Promise((resolve) => held.push({ answer: (keys, rest) => resolve({ ok: true, data: { items: keys.map((key) => summary(key, rest)) } }) }));
      case "items:listArchived":
        return Promise.resolve({ ok: true, data: { items: [] } });
      default:
        return Promise.resolve({ ok: true, data: {} });
    }
  }) as never;
  return {
    held,
    switchTo: (id: string) => (active = id),
    push: (channel: string, payload: unknown) =>
      act(async () => {
        listeners.get(channel)?.forEach((listener) => listener(payload));
        await Promise.resolve();
      }),
  };
}

/** Every catalog ever written under a project, as the keys it held. */
function recordCatalogs(client: ReturnType<typeof createQueryClient>, projectId: string) {
  const written: string[][] = [];
  const key = JSON.stringify(itemReferencesKey(projectId));
  client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || JSON.stringify(event.query.queryKey) !== key) return;
    written.push([...((event.query.state.data as ReadonlyMap<string, unknown> | undefined)?.keys() ?? [])]);
  });
  return written;
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

function renderProvider() {
  const client = createQueryClient();
  const underB = recordCatalogs(client, "B");
  render(
    <QueryClientProvider client={client}>
      <ItemReferenceProvider>{null}</ItemReferenceProvider>
    </QueryClientProvider>,
  );
  return { client, underB };
}

describe("the item-reference catalog across a project switch (EO-560)", () => {
  it("never files a read begun for the previous project under the new one, and asks the new one's lists", async () => {
    const bridge = fakeBridge();
    const { client, underB } = renderProvider();

    await waitFor(() => expect(bridge.held).toHaveLength(1));
    await act(async () => bridge.held[0]!.answer(["A-1"]));
    await waitFor(() => expect([...(client.getQueryData<ReadonlyMap<string, unknown>>(itemReferencesKey("A"))?.keys() ?? [])]).toEqual(["A-1"]));

    // An item in A changes: the list is asked again, and that read is held.
    await bridge.push("items:changed", { itemId: "id-A-1" });
    await waitFor(() => expect(bridge.held).toHaveLength(2));

    // Another window switches to B: this one hears `config:changed`.
    bridge.switchTo("B");
    await bridge.push("config:changed", {});
    // B's list is asked for, rather than A's read being taken for it.
    await waitFor(() => expect(bridge.held).toHaveLength(3));

    // A's read comes back after the switch.
    await act(async () => bridge.held[1]!.answer(["A-1", "A-2"]));
    await settle();
    expect(underB.flat()).not.toContain("A-1");
    expect(underB.flat()).not.toContain("A-2");

    await act(async () => bridge.held[2]!.answer(["B-1"]));
    await waitFor(() => expect(underB.at(-1)).toEqual(["B-1"]));
    expect(underB.flat().some((key) => key.startsWith("A-"))).toBe(false);
  });

  it("does the same when the previous project's first read has not answered yet", async () => {
    const bridge = fakeBridge();
    const { underB } = renderProvider();

    // A's first read, with no answer in the cache to fall back on.
    await waitFor(() => expect(bridge.held).toHaveLength(1));

    bridge.switchTo("B");
    await bridge.push("config:changed", {});
    await waitFor(() => expect(bridge.held).toHaveLength(2));

    await act(async () => bridge.held[0]!.answer(["A-1"]));
    await settle();
    expect(underB).toEqual([]);

    await act(async () => bridge.held[1]!.answer(["B-1"]));
    await waitFor(() => expect(underB.at(-1)).toEqual(["B-1"]));
    expect(underB.flat()).not.toContain("A-1");
  });
});

describe("the item-reference catalog across a change that changes nothing it draws (EO-561)", () => {
  it("keeps its identity, and re-renders no Markdown, when a refetch changes no key or title", async () => {
    const bridge = fakeBridge();
    const client = createQueryClient();
    markdown.renders = 0;
    // The same element on every render of the provider, as the app's
    // children are: only a changed context can draw it again.
    const consumer = <Markdown>{"A-1 waits on A-2."}</Markdown>;
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ItemReferenceProvider>{consumer}</ItemReferenceProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(bridge.held).toHaveLength(1));
    await act(async () => bridge.held[0]!.answer(["A-1", "A-2"], { stepId: "todo" }));
    await waitFor(() => expect(screen.getByRole("link", { name: "A-2" })).toHaveAttribute("href", "/items/id-A-2"));
    const catalog = client.getQueryData(itemReferencesKey("A"));
    const before = markdown.renders;
    // Drawn before the catalog and again once it arrived.
    expect(before).toBeGreaterThanOrEqual(2);

    // A card moves: the list is asked again and answers with the same keys
    // and titles, and only a step changed.
    await bridge.push("items:changed", { itemId: "id-A-1" });
    await waitFor(() => expect(bridge.held).toHaveLength(2));
    await act(async () => bridge.held[1]!.answer(["A-1", "A-2"], { stepId: "done" }));
    await waitFor(() => expect(client.getQueryData<{ items: { stepId: string }[] }>(itemsKey)?.items[0]?.stepId).toBe("done"));
    await settle();

    expect(client.getQueryData(itemReferencesKey("A"))).toBe(catalog);
    expect(markdown.renders).toBe(before);

    // A title that did change is a new catalog, and that does reach it.
    await bridge.push("items:changed", { itemId: "id-A-1" });
    await waitFor(() => expect(bridge.held).toHaveLength(3));
    await act(async () => bridge.held[2]!.answer(["A-1", "A-2"], { stepId: "done", title: "Renamed" }));
    await waitFor(() => expect(client.getQueryData(itemReferencesKey("A"))).not.toBe(catalog));
    await waitFor(() => expect(markdown.renders).toBeGreaterThan(before));
  });
});
