import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { chatViewFor } from "../views/registry";
import { TourHost, placeCallout, useShowTour } from "./Tour";

/**
 * The first-board tour (EO-667), against a window of stand-in screens
 * that carry the same `data-tour` marks the real ones do.
 */

vi.mock("../../query/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../query/hooks")>()),
  // A pack whose word for an item is "report": the tour must say that.
  useChromeVocabulary: () => ({ item: "Report", items: "Reports", mixed: false }),
}));

let due = true;
let seenCalls = 0;

beforeEach(() => {
  due = true;
  seenCalls = 0;
  window.eo.ipc.invoke = vi.fn(async (channel: string) => {
    if (channel === "firstRun:tourState") return { ok: true, data: { due } };
    if (channel === "firstRun:tourSeen") {
      seenCalls += 1;
      due = false;
      return { ok: true, data: { due: false } };
    }
    if (channel === "pipelines:list") return { ok: true, data: { pipelines: [] } };
    return { ok: true, data: {} };
  }) as never;
});

/** The window: the rail and conversation always, and whatever the address draws. */
function Window({ absent = [], folded = false }: { absent?: string[]; folded?: boolean }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const section = new URLSearchParams(search).get("section") ?? "general";
  const mark = (name: string) => (absent.includes(name) ? {} : { "data-tour": name });
  return (
    <>
      <p data-testid="address">{`${pathname}${search}`}</p>
      <nav {...mark("rail")}>
        <a {...mark("waiting")}>Waiting on you</a>
      </nav>
      <section {...mark("assistant")} hidden={folded}>
        Conversation
      </section>
      {pathname.startsWith("/pipelines/") ? <div {...mark("board")}>Columns</div> : null}
      {pathname === "/agents" ? <div {...mark("view-agents")}>Agents</div> : null}
      {pathname === "/agent-tools" ? <div {...mark("view-agentTools")}>Agent tools</div> : null}
      {pathname === "/settings" ? (
        <>
          <nav {...mark("settings")}>Sections</nav>
          <div {...mark(`settings-${section}`)}>{section}</div>
          <ReplayButton />
        </>
      ) : null}
      <button type="button" onClick={() => void navigate("/pipelines/p1")}>
        Open the board
      </button>
      <button type="button" onClick={() => void navigate("/settings")}>
        Open Settings
      </button>
    </>
  );
}

function ReplayButton() {
  const show = useShowTour();
  return show ? (
    <button type="button" onClick={show}>
      Show the tour
    </button>
  ) : null;
}

function Host({ absent, folded }: { absent?: string[]; folded?: boolean }) {
  const { pathname, search } = useLocation();
  return (
    <TourHost view={chatViewFor(pathname, search)} wait={60}>
      <Window {...(absent ? { absent } : {})} folded={folded ?? false} />
    </TourHost>
  );
}

function renderAt(path: string, absent?: string[], folded = false) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Host {...(absent ? { absent } : {})} folded={folded} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tour = () => screen.findByRole("dialog", { name: "Tour" });
const address = () => screen.getByTestId("address").textContent;

async function pressNext() {
  fireEvent.click(await screen.findByRole("button", { name: /^(Next|Done)$/ }));
}

describe("when the tour starts on its own", () => {
  it("starts the first time a board is shown, once it is due", async () => {
    renderAt("/pipelines/p1");
    const callout = await tour();
    expect(callout).toHaveTextContent("The board");
    expect(callout).toHaveTextContent("1 of 9");
    expect(callout).toHaveTextContent("a report moving through it");
    expect(screen.getByRole("button", { name: "Skip tour" })).toBeInTheDocument();
    expect(screen.getByTestId("tour-highlight")).toBeInTheDocument();
  });

  it("waits for a board: not on the conversation", async () => {
    renderAt("/chat");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("dialog", { name: "Tour" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the board" }));
    expect(await tour()).toHaveTextContent("The board");
  });

  it("does not start once it has been seen", async () => {
    due = false;
    renderAt("/pipelines/p1");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("dialog", { name: "Tour" })).toBeNull();
  });
});

describe("going through it", () => {
  it("visits every stop in order, on its own screen, and ends on the board with Done", async () => {
    renderAt("/pipelines/p1");
    const visited: string[] = [];
    for (let stop = 0; stop < 9; stop += 1) {
      const callout = await tour();
      await waitFor(() => expect(callout.querySelector("h2")?.textContent).not.toBe(visited[visited.length - 1]));
      visited.push(callout.querySelector("h2")!.textContent!);
      expect(callout).toHaveTextContent(`${stop + 1} of 9`);
      if (visited.at(-1) === "Agents") expect(address()).toBe("/agents");
      if (visited.at(-1) === "Modules") expect(address()).toBe("/settings?section=modules");
      if (stop === 8) expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
      await pressNext();
    }
    expect(visited).toEqual(["The board", "Waiting on you", "The assistant", "The rail", "Agents", "Agent tools", "Settings", "Modules", "MCP server"]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tour" })).toBeNull());
    expect(address()).toBe("/pipelines/p1");
    await waitFor(() => expect(seenCalls).toBe(1));
  });

  it("passes over a stop whose element is not on screen, and counts it out", async () => {
    renderAt("/pipelines/p1", ["view-agentTools"]);
    for (let stop = 0; stop < 5; stop += 1) {
      await tour();
      if (stop < 4) await pressNext();
    }
    await waitFor(async () => expect(await tour()).toHaveTextContent("5 of 9"));
    await pressNext();
    const callout = await screen.findByText("Settings", { selector: "h2" });
    expect(callout.closest("[role=dialog]")).toHaveTextContent("6 of 8");
  });

  it("passes over an element that is there but hidden, as the folded conversation is", async () => {
    renderAt("/pipelines/p1", [], true);
    await tour();
    await pressNext();
    await waitFor(async () => expect(await tour()).toHaveTextContent("Waiting on you"));
    await pressNext();
    await waitFor(async () => expect(await tour()).toHaveTextContent("The rail"));
    expect(await tour()).toHaveTextContent("3 of 8");
  });

  it("is skipped with Escape, which records it seen and goes back to the board", async () => {
    renderAt("/pipelines/p1");
    await tour();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowRight" });
    await waitFor(async () => expect(await tour()).toHaveTextContent("Waiting on you"));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Tour" })).toBeNull());
    await waitFor(() => expect(seenCalls).toBe(1));
    expect(address()).toBe("/pipelines/p1");
  });

  it("moves focus into the callout, onto Next", async () => {
    renderAt("/pipelines/p1");
    await tour();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" })));
  });
});

describe("Show the tour", () => {
  it("replays it from the first stop, on the board, though it was seen", async () => {
    due = false;
    renderAt("/pipelines/p1");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show the tour" }));
    const callout = await tour();
    expect(callout).toHaveTextContent("The board");
    expect(callout).toHaveTextContent("1 of 9");
    await waitFor(() => expect(address()).toBe("/pipelines/p1"));
  });
});

describe("where the callout goes", () => {
  const viewport = { width: 1200, height: 800 };
  it("beside the element where there is room", () => {
    expect(placeCallout({ top: 100, left: 0, width: 250, height: 700 }, viewport, 180)).toEqual({ top: 100, left: 262 });
  });
  it("over the element's corner when it fills the window", () => {
    const place = placeCallout({ top: 0, left: 0, width: 1200, height: 800 }, viewport, 180);
    expect(place.left).toBeLessThanOrEqual(1200 - 320 - 12);
    expect(place.top).toBeLessThanOrEqual(800 - 180 - 12);
  });
});
