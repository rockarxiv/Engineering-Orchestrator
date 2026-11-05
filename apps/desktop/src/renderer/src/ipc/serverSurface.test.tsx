import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMachineChannel, machineOnlyRefusal, type IpcChannel } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../chat/conversation/ItemReferenceProvider";
import { createQueryClient } from "../query/client";
import { SettingsView } from "../chat/views/settings/SettingsView";
import { ViewPublisher } from "../shared/view/ViewPublisher";
import { setBridge, type RendererBridge } from "./bridge";

/**
 * The renderer, served from an organisation server (EO-319, the story's
 * second acceptance criterion).
 *
 * The other half of that criterion is `main/server/smoke.test.ts`, which
 * proves the server answers a machine channel with the typed refusal.
 * This is what the person sees because of it: the controls that would
 * have called one are not on the screen. The screen is the chat layout's
 * Settings view (`chat/views/settings/SettingsView.tsx`), whose section
 * list leaves out every section marked `machine` when the bridge has no
 * machine behind it.
 *
 * Not "are disabled" — invariant 12 asks for the absence to be *named*
 * rather than discovered, and a greyed button with no explanation is the
 * worst of both. A whole section is simply not offered, which is what an
 * admin opening this address should find: an app about the record,
 * because the record is all this installation has.
 */
const calls: { channel: string; payload: unknown }[] = [];

/**
 * The bridge an HTTP-served renderer has, with the record half answered
 * out of the default mock.
 *
 * `window.eo` is setupTests.ts's stub for every channel, and delegating
 * to it keeps this file about the one difference it is testing rather
 * than about re-stubbing twenty channels. The refusal is core's own, so
 * it is the same answer the real server's door would give.
 */
function servedBridge(): RendererBridge {
  return {
    machineAvailable: false,
    invoke(channel, payload) {
      calls.push({ channel, payload });
      if (isMachineChannel(channel)) return Promise.resolve(machineOnlyRefusal(channel));
      return window.eo.ipc.invoke(channel, payload);
    },
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  };
}

beforeEach(() => {
  calls.length = 0;
  setBridge(servedBridge());
});

afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
});

function renderSettings(): void {
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <ViewPublisher>
            <ItemReferenceProvider>
              <SettingsView />
            </ItemReferenceProvider>
          </ViewPublisher>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("Settings, served from a server", () => {
  it("leaves out the sections that are about this machine", async () => {
    renderSettings();

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });

    // Git & worktrees is the checkouts on a disk, MCP server is the
    // editors installed on it, and Updates replaces this binary from
    // inside itself. None of the three means anything on a server.
    for (const absent of ["Git & worktrees", "MCP server", "Updates"]) {
      expect(within(nav).queryByRole("button", { name: absent }), absent).toBeNull();
    }
  });

  it("keeps every section that is about the record", async () => {
    renderSettings();

    const nav = await screen.findByRole("navigation", { name: "Settings sections" });

    // The point of the phase: an organisation server is the same app.
    // A test that only asserted absences would pass just as well on a
    // screen that had lost its nav entirely.
    for (const present of ["General", "Projects", "Workspaces", "Connectors", "Modules", "Guardrails", "Archive"]) {
      expect(within(nav).getByRole("button", { name: present }), present).toBeTruthy();
    }
  });

  it("asks for nothing from the machine half while it draws", async () => {
    renderSettings();

    await screen.findByRole("navigation", { name: "Settings sections" });
    // `view:publish` is the one every screen would otherwise make on
    // each keystroke, and it is in the machine half: what a window is
    // showing is a fact about a window.
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    expect(calls.filter((call) => isMachineChannel(call.channel as IpcChannel)).map((call) => call.channel)).toEqual([]);
  });
});
