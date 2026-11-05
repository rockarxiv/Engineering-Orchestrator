import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { debugBridge } from "./testing";

/**
 * The debug window is the app's own bundle, told apart by its URL
 * (EO-392): `?window=debug` draws the debug window and nothing else, and
 * every other window carries the F12 listener.
 */
afterEach(() => {
  window.history.replaceState({}, "", "/");
});

/** A main process that answers everything, the debug channels in particular. */
function mainProcess(enabled: boolean) {
  const answer = () => ({ items: [], agents: [], projects: [], activeProjectId: null });
  const answers: Record<string, (payload: unknown) => unknown> = new Proxy(
    {
      "debug:getMode": () => ({ enabled }),
      "debug:window": () => ({ opened: enabled }),
      "debug:runs": () => ({ agents: [] }),
    } as Record<string, (payload: unknown) => unknown>,
    { get: (known, channel: string) => known[channel] ?? answer },
  );
  const bridge = debugBridge(answers);
  window.eo = bridge.eo;
  return bridge;
}

describe("the window marked ?window=debug", () => {
  it("draws the debug window, and none of the routed app around it", async () => {
    window.history.replaceState({}, "", "/?window=debug#/");
    const bridge = mainProcess(true);

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Debug" })).toBeInTheDocument();
    expect(await screen.findByText("No run in this project has been recorded. Runs started while debug mode is on appear here.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    // No router means no view publisher either: this window never tells
    // main what screen the person is on, so `view_current` keeps
    // answering about the board.
    expect(bridge.asked("view:publish")).toEqual([]);
  });
});

describe("every other window", () => {
  it("draws the app, and opens the debug window on F12 while debug mode is on", async () => {
    const bridge = mainProcess(true);
    render(<App />);

    await waitFor(() => expect(bridge.asked("debug:getMode").length).toBeGreaterThan(0));
    await waitFor(() => expect(fireEvent.keyDown(window, { key: "F12" })).toBe(false));

    expect(bridge.asked("debug:window").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 1, name: "Debug" })).not.toBeInTheDocument();
  });

  it("opens nothing on F12 while debug mode is off", async () => {
    const bridge = mainProcess(false);
    render(<App />);

    await waitFor(() => expect(bridge.asked("debug:getMode").length).toBeGreaterThan(0));
    expect(fireEvent.keyDown(window, { key: "F12" })).toBe(true);
    expect(bridge.asked("debug:window")).toEqual([]);
  });
});
