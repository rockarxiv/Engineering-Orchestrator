import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IpcPushPayload, UpdateStatus } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../../query/client";
import { UpdatesSection } from "./UpdatesSection";

/**
 * Settings → Updates in the chat layout (EO-201), as
 * `settings/UpdatesSection.test.tsx` asserts the classic section: the dead
 * ends say what they are and offer no button, a failed download says why
 * and never restarts, and the one button's label is the state it is in.
 * Downloading and restarting are separate presses (EO-696).
 */

function renderSection(status: UpdateStatus, answers: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  let pushProgress: ((payload: IpcPushPayload<"updates:progress">) => void) | undefined;
  let pushChanged: (() => void) | undefined;
  let served = status;

  window.eo = {
    versions: { electron: "0.0.0-test", chrome: "0.0.0-test", node: "0.0.0-test" },
    ipc: {
      invoke: vi.fn(async (channel: string) => {
        calls.push(channel);
        if (channel === "app:getVersion") return { ok: true, data: { version: "0.4.0" } };
        const answer = channel === "updates:status" ? served : answers[channel];
        return { ok: true, data: answer ?? { state: "idle", lastCheckedAt: null } };
      }) as never,
      subscribe: vi.fn((channel: string, callback: (payload: never) => void) => {
        if (channel === "updates:progress") pushProgress = callback as (payload: IpcPushPayload<"updates:progress">) => void;
        if (channel === "updates:changed") pushChanged = callback as () => void;
        return () => {};
      }) as never,
    },
  };

  render(
    <QueryClientProvider client={createQueryClient()}>
      <UpdatesSection />
    </QueryClientProvider>,
  );

  return {
    calls,
    progress: (percent: number) => act(() => pushProgress?.({ percent })),
    backgroundCheck: (next: UpdateStatus) => {
      served = next;
      act(() => pushChanged?.());
    },
  };
}

describe("the Updates section", () => {
  it("shows the running version and when EO last looked", async () => {
    renderSection({ state: "up-to-date", lastCheckedAt: Date.UTC(2026, 7, 20, 9, 30) });
    expect(await screen.findByText("EO 0.4.0")).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toBeInTheDocument();
    expect(screen.getByText("This is the newest release.")).toBeInTheDocument();
  });

  it("says a build running from source cannot update, and offers no button", async () => {
    renderSection({ state: "unsupported" });
    expect(await screen.findByText("Updates apply to installed builds; this is running from source.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("checks when asked, and leaves the button as it was when there is nothing new", async () => {
    const { calls } = renderSection({ state: "idle", lastCheckedAt: null }, { "updates:check": { state: "up-to-date", lastCheckedAt: 1_700_000_000_000 } });
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("This is the newest release.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(calls).not.toContain("updates:download");
  });

  it("downloads when asked and stops there, ending on Restart and update (EO-696)", async () => {
    const { calls } = renderSection(
      { state: "available", version: "0.5.0", lastCheckedAt: 1 },
      { "updates:download": { state: "downloaded", version: "0.5.0", lastCheckedAt: 1 }, "updates:install": { requested: true } },
    );
    expect(await screen.findByText("EO 0.5.0 is available.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("button", { name: "Restart and update" })).toBeEnabled();
    expect(screen.getByText("EO 0.5.0 has been downloaded. It installs when you press Restart and update.")).toBeInTheDocument();
    expect(calls).toContain("updates:download");
    // A finished download never leads to a restart by itself.
    expect(calls).not.toContain("updates:install");

    fireEvent.click(screen.getByRole("button", { name: "Restart and update" }));
    await waitFor(() => expect(calls).toContain("updates:install"));
    expect(calls.filter((channel) => channel === "updates:download")).toHaveLength(1);
  });

  it("advances a progress readout as the main process pushes it, with the button held", async () => {
    const { progress, calls } = renderSection({ state: "available", version: "0.5.0", lastCheckedAt: 1 }, { "updates:download": new Promise(() => {}) });
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));

    progress(20);
    expect(await screen.findByText("Downloading… 20%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
    progress(75);
    expect(await screen.findByText("Downloading… 75%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
    expect(calls).not.toContain("updates:install");
  });

  it("follows a background check that resolves while it is open, and re-enables the button", async () => {
    const { backgroundCheck } = renderSection({ state: "checking", lastCheckedAt: null });
    await screen.findByText("checking");
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();

    backgroundCheck({ state: "up-to-date", lastCheckedAt: 1_700_000_000_000 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled());
    expect(screen.getByText("This is the newest release.")).toBeInTheDocument();
  });

  it("says why a download failed, retries the download, and never restarts", async () => {
    const { calls } = renderSection(
      { state: "available", version: "0.5.0", lastCheckedAt: 1 },
      {
        "updates:check": { state: "available", version: "0.5.0", lastCheckedAt: 2 },
        "updates:download": { state: "error", message: "connection reset", lastCheckedAt: 1 },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("connection reset");
    expect(calls).not.toContain("updates:install");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.filter((channel) => channel === "updates:download")).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeEnabled();
    expect(calls).not.toContain("updates:install");
  });

  it("offers the restart on its own for an update staged earlier", async () => {
    const { calls } = renderSection({ state: "downloaded", version: "0.5.0", lastCheckedAt: 1 }, { "updates:install": { requested: true } });
    fireEvent.click(await screen.findByRole("button", { name: "Restart and update" }));
    await waitFor(() => expect(calls).toContain("updates:install"));
    expect(calls).not.toContain("updates:download");
  });
});
