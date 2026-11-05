import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createQueryClient } from "../query/client";
import { DebugHotkey } from "./DebugHotkey";
import { debugBridge } from "./testing";

/**
 * F12 (EO-392): EO's key while debug mode is on, and nobody's while it
 * is off.
 */
function mount(enabled: boolean) {
  let on = enabled;
  const bridge = debugBridge({
    "debug:getMode": () => ({ enabled: on }),
    "debug:window": () => ({ opened: on }),
  });
  window.eo = bridge.eo;
  render(
    <QueryClientProvider client={createQueryClient()}>
      <DebugHotkey />
    </QueryClientProvider>,
  );
  return {
    ...bridge,
    /** The switch flipped in another window: the setting moves and every window is told. */
    flip: (next: boolean) => {
      on = next;
      act(() => bridge.push("config:changed"));
    },
  };
}

/** Presses a key on the window; true when nothing prevented its default. */
const press = (key: string, modifiers: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...modifiers });

describe("F12", () => {
  it("asks for the debug window while debug mode is on, and takes the key", async () => {
    const bridge = mount(true);
    await waitFor(() => expect(bridge.asked("debug:getMode")).toHaveLength(1));
    await waitFor(() => expect(press("F12")).toBe(false));

    expect(bridge.asked("debug:window").length).toBeGreaterThan(0);
  });

  it("asks again on a second press, which is what focuses the window already open", async () => {
    const bridge = mount(true);
    await waitFor(() => expect(press("F12")).toBe(false));
    const before = bridge.asked("debug:window").length;

    press("F12");

    // One request per press and no window bookkeeping here: main raises
    // the one it has (`platform.openDebug`).
    expect(bridge.asked("debug:window")).toHaveLength(before + 1);
  });

  it("does nothing at all while debug mode is off: no request, and the key is left alone", async () => {
    const bridge = mount(false);
    await waitFor(() => expect(bridge.asked("debug:getMode")).toHaveLength(1));

    expect(press("F12")).toBe(true);
    expect(bridge.asked("debug:window")).toEqual([]);
  });

  it("leaves the devtools chord and every other key alone while it is on", async () => {
    const bridge = mount(true);
    await waitFor(() => expect(press("F12")).toBe(false));
    const before = bridge.asked("debug:window").length;

    expect(press("I", { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(press("F11")).toBe(true);
    expect(press("F12", { ctrlKey: true })).toBe(true);
    expect(bridge.asked("debug:window")).toHaveLength(before);
  });

  it("starts and stops with the setting, without the window being reloaded", async () => {
    const bridge = mount(false);
    await waitFor(() => expect(bridge.asked("debug:getMode")).toHaveLength(1));
    expect(press("F12")).toBe(true);

    bridge.flip(true);
    await waitFor(() => expect(press("F12")).toBe(false));

    bridge.flip(false);
    await waitFor(() => expect(press("F12")).toBe(true));
  });
});
