import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../query/client";
import { DEFAULT_PRESET_ID, paletteOf, setThemeChoice, THEME_STORAGE_KEY } from "../theme";
import { FirstRun } from "./FirstRun";
import { FirstRunGate } from "./FirstRunGate";

/**
 * First run, in the order the design settled (EO-317, the original design).
 *
 * "Mode, then gallery, then optional Preview with no sign-in, then the
 * template's own blanks, then the needs check … then the first real
 * item." What is asserted here is the **order** — the thing the finding
 * was about — and the one question that comes before everything else.
 * The gallery's own three screens are asserted where they live.
 */

function mockIpc(state: { done: boolean; mode: "solo" | "organisation" | null }) {
  const stored = { ...state };
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      // A copy each time, not the held object: the screen compares what
      // it was given with what it has, and handing back the very object
      // it already holds is a change it cannot see.
      case "firstRun:state":
        return { ok: true, data: { ...stored } };
      case "firstRun:setMode": {
        stored.mode = (payload as { mode: "solo" | "organisation" }).mode;
        return { ok: true, data: { mode: stored.mode } };
      }
      case "gallery:list":
        return { ok: true, data: { templates: [], fetched: false, people: [] } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderFirstRun(node: React.ReactNode) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("step 1, before anything else", () => {
  it("asks solo or organisation, and shows no gallery until it is answered", async () => {
    mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Is this just you, or is it for an organisation?")).toBeInTheDocument();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
  });

  it("goes straight to the gallery on Just me", async () => {
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Just me" }));

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "firstRun:setMode")?.[1]).toEqual({ mode: "solo", address: "" });
  });

  /**
   * "Organisation asks for a server address, signs in, and pulls the
   * published packs." The sign-in exists since EO-323 and lives in
   * Settings → Organisation, because getting in needs an invitation from
   * whoever runs the server rather than an address — so this step keeps
   * the address and says where to go, rather than putting a password
   * field in front of somebody who has no password yet.
   */
  it("takes an organisation's address and says where the sign-in is", async () => {
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));

    expect(await screen.findByText(/Settings → Organisation/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your organisation's EO address"), { target: { value: "eo.acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Carry on" }));

    await waitFor(() => expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "firstRun:setMode")).toBe(true));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "firstRun:setMode")?.[1]).toEqual({
      mode: "organisation",
      address: "eo.acme.com",
    });
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
  });

  it("resumes at the gallery for somebody who already answered", async () => {
    mockIpc({ done: false, mode: "solo" });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(screen.queryByText("Is this just you, or is it for an organisation?")).not.toBeInTheDocument();
  });
});

/**
 * Drawn in the chat layout's look (EO-527). The flow sits above the
 * frame, so it paints this device's theme itself — the default preset on
 * a device that has never chosen one, which is every fresh installation.
 */
describe("its look", () => {
  const rootColour = (name: string) => document.documentElement.style.getPropertyValue(name);

  it("wears the default chat theme on a device that has never chosen one, and takes it off on the way out", async () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    mockIpc({ done: false, mode: null });
    const { unmount } = renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Welcome to EO" })).toBeInTheDocument();
    expect(rootColour("--color-canvas")).toBe(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID })["--color-canvas"]);

    unmount();
    expect(rootColour("--color-canvas")).toBe("");
  });

  it("wears the theme this device chose", async () => {
    setThemeChoice({ kind: "preset", id: "nord" });
    mockIpc({ done: false, mode: "solo" });
    const { unmount } = renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(rootColour("--color-accent")).toBe(paletteOf({ kind: "preset", id: "nord" })["--color-accent"]);

    unmount();
    setThemeChoice({ kind: "preset", id: DEFAULT_PRESET_ID });
  });
});

describe("the gate", () => {
  it("shows the flow instead of the app while there is nothing of their own", async () => {
    mockIpc({ done: false, mode: null });
    renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(await screen.findByText("Is this just you, or is it for an organisation?")).toBeInTheDocument();
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });

  /** Which is every installation that predates this story, and every one that has finished the flow. */
  it("gets out of the way once first run is behind them", async () => {
    mockIpc({ done: true, mode: "solo" });
    renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByText("Is this just you, or is it for an organisation?")).not.toBeInTheDocument();
  });

  /**
   * Step 3 is watched where it happens (the original design).
   *
   * "Preview this pipeline walks an example item through every step …
   * the person sees the product work before it asks them for
   * anything" — so the item it files is let through the gate. Holding
   * the window on the gallery would be the flow talking over its own
   * demonstration.
   */
  it("lets the preview item through, so the rehearsal can be watched", async () => {
    mockIpc({ done: false, mode: "solo" });
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/preview-1"]}>
            <FirstRunGate>
              <span data-testid="the-app" />
            </FirstRunGate>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
  });

  /**
   * And nothing is drawn while the question is in flight: an
   * installation halfway through first run must not be shown a flash of
   * the empty board the design exists to replace.
   */
  it("draws nothing at all before it knows", () => {
    window.eo.ipc.invoke = vi.fn(() => new Promise(() => {})) as never;
    const { container } = renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });
});
