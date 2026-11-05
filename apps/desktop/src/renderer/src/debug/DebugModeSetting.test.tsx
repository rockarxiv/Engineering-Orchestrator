import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@eo/ui";
import { DebugSection as ChatDebugSection } from "../chat/views/settings/sections/DebugSection";
import { SETTINGS_SECTIONS } from "../chat/views/settings/sections";
import { createQueryClient } from "../query/client";
import { debugBridge } from "./testing";

/**
 * Settings → Debug (EO-392): one switch, off until it
 * is turned on, written through its own channel.
 */
function mount(section: ReactNode, stored = false) {
  let enabled = stored;
  const bridge = debugBridge({
    "debug:getMode": () => ({ enabled }),
    "debug:setMode": (payload) => {
      enabled = (payload as { enabled: boolean }).enabled;
      return { enabled };
    },
  });
  window.eo = bridge.eo;
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>{section}</QueryClientProvider>
    </ThemeProvider>,
  );
  return bridge;
}

describe.each([
  { layout: "the chat layout", section: <ChatDebugSection /> },
])("Settings → Debug in $layout", ({ section }) => {
  it("has a Debug mode switch that is off by default", async () => {
    mount(section);

    expect(await screen.findByRole("switch", { name: "Debug mode" })).toHaveAttribute("aria-checked", "false");
  });

  it("turns it on through its own channel, and shows what was stored", async () => {
    const bridge = mount(section);

    fireEvent.click(await screen.findByRole("switch", { name: "Debug mode" }));

    await waitFor(() => expect(screen.getByRole("switch", { name: "Debug mode" })).toHaveAttribute("aria-checked", "true"));
    expect(bridge.asked("debug:setMode").map((call) => call.payload)).toEqual([{ enabled: true }]);
    // Never the shared preference object, which every other section
    // writes and which would otherwise carry this along with it.
    expect(bridge.asked("settings:set")).toEqual([]);
  });

  it("opens on what was stored before, which is how it survives a restart", async () => {
    mount(section, true);

    expect(await screen.findByRole("switch", { name: "Debug mode" })).toHaveAttribute("aria-checked", "true");
  });

  it("says what it records, that secrets are not, and which key opens the window", async () => {
    mount(section);

    await screen.findByRole("switch", { name: "Debug mode" });
    expect(screen.getByText(/press F12 to open the debug window/)).toBeInTheDocument();
    expect(screen.getByText(/secrets never are/)).toBeInTheDocument();
    expect(screen.getByText(/applies from the next dispatch/)).toBeInTheDocument();
  });
});

describe("where the section is drawn", () => {
  it("is machine-only in the chat layout, like the window it turns on", () => {
    expect(SETTINGS_SECTIONS.find((candidate) => candidate.id === "debug")).toMatchObject({ label: "Debug", machine: true });
  });
});
