import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { ItemReferenceProvider } from "../../conversation/ItemReferenceProvider";
import { createQueryClient } from "../../../query/client";
import { ViewPublisher } from "../../../shared/view/ViewPublisher";
import { SettingsView } from "./SettingsView";

/**
 * Settings → Updates follows what the main process says about the
 * platform (EO-698): on macOS, where EO cannot install over itself, the
 * status says `manual` and the section is neither listed nor opened by
 * `?section=updates`. Everywhere else it is there as before.
 */
function renderSettings(status: UpdateStatus, path = "/settings"): { served: () => boolean } {
  const stub = window.eo.ipc.invoke as (channel: string, payload: unknown) => Promise<unknown>;
  let served = false;
  window.eo.ipc.invoke = (async (channel: string, payload: unknown) => {
    if (channel !== "updates:status") return stub(channel, payload);
    served = true;
    return { ok: true, data: status };
  }) as never;

  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <ViewPublisher>
            <ItemReferenceProvider>
              <SettingsView />
            </ItemReferenceProvider>
          </ViewPublisher>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { served: () => served };
}

describe("Settings → Updates by platform", () => {
  it("lists Updates and opens it from ?section=updates where EO installs its own updates", async () => {
    renderSettings({ state: "up-to-date", lastCheckedAt: 1 }, "/settings?section=updates");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });

    expect(await within(nav).findByRole("button", { name: "Updates" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("has no Updates entry on macOS, and ?section=updates opens the first section instead", async () => {
    const { served } = renderSettings({ state: "available", version: "0.5.0", lastCheckedAt: 1, manual: true }, "/settings?section=updates");
    const nav = await screen.findByRole("navigation", { name: "Settings sections" });

    // Asserted only once the status saying macOS has been read, so the
    // absence is the answer's and not a status still on its way.
    await waitFor(() => expect(served()).toBe(true));
    await act(async () => {});
    expect(within(nav).getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    expect(screen.queryByText(/EO 0\.5\.0 is available/)).toBeNull();
  });
});
