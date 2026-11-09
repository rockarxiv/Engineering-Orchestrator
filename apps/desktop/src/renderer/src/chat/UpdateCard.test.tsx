import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UpdateStatus } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bridgeModule from "../ipc/bridge";
import { createQueryClient } from "../query/client";
import { forgetUpdateFlow } from "../shared/settings/useUpdateFlow";
import { UpdatesSection } from "./views/settings/sections/UpdatesSection";
import { UpdateCard } from "./UpdateCard";

/**
 * The corner card (EO-697): it follows the status Settings → Updates
 * reads, offers Download, then progress, then Restart and update, and
 * Later hides it for that version only.
 */

const AVAILABLE: UpdateStatus = { state: "available", version: "0.5.0", lastCheckedAt: 1 };

/**
 * A main process that behaves as `updater.ts` does: a download moves the
 * status to `downloading` and says so on `updates:changed`, and finishes
 * only when the test says it does.
 */
function fakeMain(initial: UpdateStatus) {
  const calls: string[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let served = initial;
  let checkFinds: UpdateStatus | null = null;
  let finishDownload: (next: UpdateStatus) => void = () => {};

  const push = (channel: string, payload: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  };

  window.eo = {
    versions: { electron: "0.0.0-test", chrome: "0.0.0-test", node: "0.0.0-test" },
    ipc: {
      invoke: vi.fn(async (channel: string) => {
        calls.push(channel);
        switch (channel) {
          case "app:getVersion":
            return { ok: true, data: { version: "0.4.0" } };
          case "updates:status":
            return { ok: true, data: served };
          case "updates:check":
            served = checkFinds ?? served;
            return { ok: true, data: served };
          case "updates:download": {
            served = { state: "downloading", percent: 0, lastCheckedAt: 1 };
            push("updates:changed", {});
            const next = await new Promise<UpdateStatus>((resolve) => (finishDownload = resolve));
            served = next;
            return { ok: true, data: next };
          }
          case "updates:install":
            return { ok: true, data: { requested: true } };
          default:
            return { ok: true, data: {} };
        }
      }) as never,
      subscribe: vi.fn((channel: string, callback: (payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(callback);
        listeners.set(channel, set);
        return () => set.delete(callback);
      }) as never,
    },
  };

  return {
    calls,
    /** The status moves with nobody in this window having asked: a background check, or another window. */
    move: (next: UpdateStatus) => {
      served = next;
      act(() => push("updates:changed", {}));
    },
    progress: (percent: number) => {
      served = { state: "downloading", percent, lastCheckedAt: 1 };
      act(() => push("updates:progress", { percent }));
    },
    /** What the next check finds. */
    checkFinds: (next: UpdateStatus) => {
      checkFinds = next;
    },
    finish: (next: UpdateStatus) => act(() => finishDownload(next)),
  };
}

function renderWindow({ settings = false }: { settings?: boolean } = {}) {
  const elsewhere = vi.fn();
  render(
    <QueryClientProvider client={createQueryClient()}>
      <button type="button" onClick={elsewhere}>
        Something else in the window
      </button>
      {settings ? <UpdatesSection /> : null}
      <UpdateCard />
    </QueryClientProvider>,
  );
  return { elsewhere };
}

const card = () => screen.getByRole("complementary", { name: "EO update" });
const findCard = () => screen.findByRole("complementary", { name: "EO update" });
const noCard = () => expect(screen.queryByRole("complementary", { name: "EO update" })).not.toBeInTheDocument();

beforeEach(() => {
  forgetUpdateFlow();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the update card", () => {
  it("appears when a check finds a newer version, and leaves the rest of the window usable", async () => {
    const main = fakeMain({ state: "idle", lastCheckedAt: null });
    const { elsewhere } = renderWindow();
    await waitFor(() => expect(main.calls).toContain("updates:status"));
    noCard();

    main.move({ state: "checking", lastCheckedAt: null });
    main.move(AVAILABLE);
    const shown = await findCard();
    expect(within(shown).getByText("EO 0.5.0 is available")).toBeInTheDocument();
    expect(within(shown).getByRole("button", { name: "Download" })).toBeEnabled();
    expect(within(shown).getByRole("button", { name: "Later" })).toBeEnabled();

    // No backdrop and nothing modal: the window behind it still takes clicks.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-modal]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Something else in the window" }));
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(card()).toBeInTheDocument();
  });

  it("downloads with progress, ends on Restart and update, and restarts only when that is pressed", async () => {
    const main = fakeMain(AVAILABLE);
    renderWindow();
    fireEvent.click(within(await findCard()).getByRole("button", { name: "Download" }));

    expect(await within(card()).findByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    main.progress(40);
    await waitFor(() => expect(within(card()).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40"));
    expect(within(card()).getByText("Downloading EO 0.5.0… 40%")).toBeInTheDocument();

    main.progress(100);
    main.finish({ state: "downloaded", version: "0.5.0", lastCheckedAt: 1 });
    const restart = await within(card()).findByRole("button", { name: "Restart and update" });
    expect(within(card()).getByText("EO 0.5.0 is ready")).toBeInTheDocument();
    expect(within(card()).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(main.calls).not.toContain("updates:install");

    fireEvent.click(restart);
    await waitFor(() => expect(main.calls).toContain("updates:install"));
    expect(main.calls.filter((channel) => channel === "updates:download")).toHaveLength(1);
  });

  it("stays hidden for a version Later was pressed on, and comes back for a different one", async () => {
    const main = fakeMain(AVAILABLE);
    renderWindow();
    fireEvent.click(within(await findCard()).getByRole("button", { name: "Later" }));
    noCard();

    // The six-hourly check finds the same version again.
    main.move({ state: "checking", lastCheckedAt: 1 });
    main.move({ state: "available", version: "0.5.0", lastCheckedAt: 2 });
    await waitFor(() => expect(main.calls.filter((channel) => channel === "updates:status").length).toBeGreaterThanOrEqual(3));
    noCard();

    main.move({ state: "available", version: "0.6.0", lastCheckedAt: 3 });
    expect(within(await findCard()).getByText("EO 0.6.0 is available")).toBeInTheDocument();
  });

  it("keeps Settings → Updates offering the update after Later", async () => {
    fakeMain(AVAILABLE);
    renderWindow({ settings: true });
    fireEvent.click(within(await findCard()).getByRole("button", { name: "Later" }));
    noCard();
    expect(screen.getByText("EO 0.5.0 is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("draws a download started from Settings → Updates, through to its end state", async () => {
    const main = fakeMain(AVAILABLE);
    renderWindow({ settings: true });
    await findCard();
    // The section's own Download: the one outside the card.
    const sectionDownload = screen.getAllByRole("button", { name: "Download" }).find((button) => !card().contains(button));
    fireEvent.click(sectionDownload as HTMLElement);

    await waitFor(() => expect(main.calls).toContain("updates:download"));
    main.progress(30);
    await waitFor(() => expect(within(card()).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30"));
    expect(screen.getByText("Downloading… 30%")).toBeInTheDocument();

    main.finish({ state: "downloaded", version: "0.5.0", lastCheckedAt: 1 });
    expect(await within(card()).findByRole("button", { name: "Restart and update" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Restart and update" })).toHaveLength(2);
    expect(main.calls).not.toContain("updates:install");
  });

  it("draws a download started from the card on Settings → Updates, through to its end state", async () => {
    const main = fakeMain(AVAILABLE);
    renderWindow({ settings: true });
    fireEvent.click(within(await findCard()).getByRole("button", { name: "Download" }));

    await waitFor(() => expect(main.calls).toContain("updates:download"));
    main.progress(55);
    expect(await screen.findByText("Downloading… 55%")).toBeInTheDocument();

    main.finish({ state: "error", message: "connection reset", lastCheckedAt: 1 });
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(within(card()).getByRole("alert")).toHaveTextContent("connection reset");
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
    expect(main.calls).not.toContain("updates:install");
  });

  it("retries a failed download from Try again, and never restarts", async () => {
    const main = fakeMain(AVAILABLE);
    renderWindow();
    fireEvent.click(within(await findCard()).getByRole("button", { name: "Download" }));
    await within(card()).findByRole("progressbar");
    main.finish({ state: "error", message: "connection reset", lastCheckedAt: 1 });
    expect(await within(card()).findByRole("alert")).toHaveTextContent("connection reset");

    // The retry checks first, which finds the version again, then downloads it.
    main.checkFinds(AVAILABLE);
    fireEvent.click(within(card()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(main.calls.filter((channel) => channel === "updates:download")).toHaveLength(2));
    expect(main.calls).not.toContain("updates:install");
  });

  it("says nothing about a background check that failed", async () => {
    const main = fakeMain({ state: "idle", lastCheckedAt: null });
    renderWindow();
    await waitFor(() => expect(main.calls).toContain("updates:status"));
    main.move({ state: "error", message: "feed unreachable", lastCheckedAt: null });
    await waitFor(() => expect(main.calls.filter((channel) => channel === "updates:status")).toHaveLength(2));
    noCard();
  });

  it.each<UpdateStatus>([
    { state: "idle", lastCheckedAt: null },
    { state: "checking", lastCheckedAt: null },
    { state: "up-to-date", lastCheckedAt: 1 },
    { state: "unsupported" },
  ])("is not drawn while the status is $state", async (status) => {
    const main = fakeMain(status);
    renderWindow();
    await waitFor(() => expect(main.calls).toContain("updates:status"));
    await act(async () => {});
    noCard();
  });

  it("is not drawn, and asks nothing, where machine channels are refused", async () => {
    vi.spyOn(bridgeModule, "machineAvailable").mockReturnValue(false);
    const main = fakeMain(AVAILABLE);
    renderWindow();
    await act(async () => {});
    noCard();
    expect(main.calls).not.toContain("updates:status");
  });
});
