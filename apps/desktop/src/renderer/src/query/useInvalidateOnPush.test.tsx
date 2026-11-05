import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient, ipcQuery } from "./client";
import { useInvalidateOnPush } from "./useInvalidateOnPush";

function wrapper(children: ReactNode) {
  return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

function Version() {
  const { data } = useQuery({ queryKey: ["app", "version"], queryFn: () => ipcQuery("app:getVersion", undefined) });
  useInvalidateOnPush("config:changed", ["app", "version"]);
  return <span data-testid="version">{data?.version ?? "loading"}</span>;
}

describe("TanStack Query over the IPC bridge", () => {
  it("fetches through invoke and renders the result", async () => {
    window.eo.ipc.invoke = vi.fn().mockResolvedValue({ ok: true, data: { version: "1.2.3" } });

    render(wrapper(<Version />));

    await waitFor(() => expect(screen.getByTestId("version")).toHaveTextContent("1.2.3"));
  });

  it("a main-process push invalidates the query and refetches", async () => {
    // This is U-01's acceptance criterion, and the whole reason the UI
    // doesn't poll: the engine already knows when something changed.
    let deliver: (() => void) | undefined;
    window.eo.ipc.subscribe = vi.fn((_channel, callback) => {
      deliver = () => (callback as () => void)();
      return () => {};
    });

    let served = 0;
    window.eo.ipc.invoke = vi.fn().mockImplementation(() => {
      served += 1;
      return Promise.resolve({ ok: true, data: { version: `v${served}` } });
    });

    render(wrapper(<Version />));
    await waitFor(() => expect(screen.getByTestId("version")).toHaveTextContent("v1"));

    deliver?.(); // the main process pushes

    await waitFor(() => expect(screen.getByTestId("version")).toHaveTextContent("v2"));
    expect(served).toBe(2); // it genuinely refetched rather than serving the cache
  });

  it("unsubscribes on unmount, so a push after teardown touches nothing", () => {
    const unsubscribe = vi.fn();
    window.eo.ipc.subscribe = vi.fn().mockReturnValue(unsubscribe);

    const { unmount } = render(wrapper(<Version />));
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("surfaces an IPC error envelope as a rejected query rather than a successful empty one", async () => {
    window.eo.ipc.invoke = vi.fn().mockResolvedValue({ ok: false, error: { message: "handler exploded" } });

    await expect(ipcQuery("app:getVersion", undefined)).rejects.toThrow("handler exploded");
  });
});
