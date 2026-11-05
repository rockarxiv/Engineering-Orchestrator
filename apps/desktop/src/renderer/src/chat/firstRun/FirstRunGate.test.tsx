import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Router, useLocation, useNavigate, type Navigator, type To } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../query/client";
import { firstRunKey } from "../../query/hooks";
import { FirstRunGate } from "./FirstRunGate";

/**
 * The flow stood in for by its two kinds of exit, so what is under test
 * is the gate: when it lets the window through, and against which
 * address.
 */
vi.mock("./FirstRun", () => ({
  FirstRun: ({ onLeft }: { onLeft: () => void }) => {
    const navigate = useNavigate();
    return (
      <div>
        <p>The flow</p>
        <button
          type="button"
          onClick={() => {
            void navigate("/pipelines/p1");
            onLeft();
          }}
        >
          Go to the board
        </button>
        <button type="button" onClick={onLeft}>
          Leave without going anywhere
        </button>
      </div>
    );
  },
}));

function mockIpc(done: boolean) {
  window.eo.ipc.invoke = vi.fn(async (channel: string) =>
    channel === "firstRun:state" ? { ok: true, data: { done, mode: "solo" } } : { ok: true, data: {} },
  ) as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
}

/** The window behind the gate, noting every address it was drawn at. */
function TheApp({ seen }: { seen: string[] }) {
  const { pathname } = useLocation();
  seen.push(pathname);
  return <p data-testid="the-app">{pathname}</p>;
}

function renderGate(seen: string[]) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <FirstRunGate>
          <TheApp seen={seen} />
        </FirstRunGate>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the gate, on the way out of first run", () => {
  /**
   * The window is drawn at the address the exit went to and never at the
   * one it left (EO-529). Drawn at `/` for a moment, the frame's
   * replacing redirect to `/chat` would land on the board's entry and
   * take the person to the conversation instead of the board.
   */
  it("lets the window through at the exit's address, never at the one the flow was on", async () => {
    mockIpc(false);
    const seen: string[] = [];
    renderGate(seen);

    fireEvent.click(await screen.findByRole("button", { name: "Go to the board" }));

    expect(await screen.findByTestId("the-app")).toHaveTextContent("/pipelines/p1");
    expect(seen).not.toContain("/");
  });

  it("keeps the flow up while an exit has gone nowhere, rather than drawing the window where the flow was", async () => {
    mockIpc(false);
    const seen: string[] = [];
    renderGate(seen);

    fireEvent.click(await screen.findByRole("button", { name: "Leave without going anywhere" }));
    await act(async () => {});

    expect(screen.getByText("The flow")).toBeInTheDocument();
    expect(seen).toEqual([]);
  });
});

/**
 * A history that has moved on before the router drew it: what a router
 * holding its location update back in a transition looks like from the
 * gate. The test says when the router draws the new address.
 */
function heldBackHistory(start: string) {
  const at = (to: To) => (typeof to === "string" ? to : (to.pathname ?? "/"));
  const history = {
    location: { pathname: start, search: "", hash: "", state: null, key: "start" },
    createHref: at,
    go: () => {},
    push: (to: To) => {
      history.location = { ...history.location, pathname: at(to) };
    },
    replace: (to: To) => {
      history.location = { ...history.location, pathname: at(to) };
    },
  };
  return history;
}

/**
 * `firstRun:finish` answered: `done` is true, as the refetch after it
 * says, delivered as the query cache delivers it — on a timer of its own,
 * which is let run here so the gate is drawn with it.
 */
async function finishFirstRun(client: ReturnType<typeof createQueryClient>) {
  await act(async () => {
    client.setQueryData(firstRunKey, { done: true, mode: "solo" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function renderHeldBack(seen: string[]) {
  const client = createQueryClient();
  const history = heldBackHistory("/");
  const ui = (drawn: string) => (
    <QueryClientProvider client={client}>
      <Router location={drawn} navigator={history as Navigator}>
        <FirstRunGate>
          <TheApp seen={seen} />
        </FirstRunGate>
      </Router>
    </QueryClientProvider>
  );
  const view = render(ui("/"));
  return { client, history, draw: (drawn: string) => view.rerender(ui(drawn)) };
}

describe("the gate, when first run ends before the router has drawn the exit", () => {
  /**
   * `firstRun:finish` answering is an urgent update; the exit's own
   * navigation is a transition that can still be held back. Opened then,
   * the window would be drawn at `/` — and the frame's replacing redirect
   * would take the board's entry — so the flow stays up until the router
   * draws where the window is.
   */
  it("keeps the flow up until the address the exit pushed is drawn, and never draws the window at the old one", async () => {
    mockIpc(false);
    const seen: string[] = [];
    const { client, history, draw } = renderHeldBack(seen);

    fireEvent.click(await screen.findByRole("button", { name: "Go to the board" }));
    expect(history.location.pathname).toBe("/pipelines/p1");
    await finishFirstRun(client);

    expect(screen.getByText("The flow")).toBeInTheDocument();
    expect(seen).toEqual([]);

    draw("/pipelines/p1");
    expect(screen.getByTestId("the-app")).toHaveTextContent("/pipelines/p1");
    expect(seen).not.toContain("/");

    // Once through, a later navigation the router has not drawn yet does
    // not bring the flow back.
    history.push("/inbox");
    draw("/pipelines/p1");
    expect(screen.getByTestId("the-app")).toHaveTextContent("/pipelines/p1");
    expect(screen.queryByText("The flow")).not.toBeInTheDocument();
  });

  it("lets the window through when first run ends after an exit that went nowhere", async () => {
    mockIpc(false);
    const seen: string[] = [];
    const { client } = renderHeldBack(seen);

    fireEvent.click(await screen.findByRole("button", { name: "Leave without going anywhere" }));
    await finishFirstRun(client);

    expect(screen.getByTestId("the-app")).toHaveTextContent("/");
  });
});
