import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBridge, type RendererBridge } from "../ipc/bridge";
import { createQueryClient } from "./client";
import { RefetchOnReconnect } from "./RefetchOnReconnect";

/**
 * What a reconnection does to the cache (EO-321).
 *
 * The server answers a client that has been away with one `refetch`
 * rather than replaying what it missed, and this is the end that has to
 * make that equivalent: everything invalidated, because what was missed
 * is exactly what this end cannot know.
 */
let refetch: (() => void) | null = null;

function servedBridge(): RendererBridge {
  return {
    machineAvailable: false,
    invoke: (channel, payload) => window.eo.ipc.invoke(channel, payload),
    subscribe: () => () => {},
    subscribeRefetch(callback) {
      refetch = callback;
      return () => {
        refetch = null;
      };
    },
  };
}

afterEach(() => {
  setBridge(undefined);
  refetch = null;
  vi.restoreAllMocks();
});

describe("a client whose push stream has been away", () => {
  it("invalidates the whole cache when the stream says to", () => {
    setBridge(servedBridge());
    const queryClient = createQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <RefetchOnReconnect />
      </QueryClientProvider>,
    );

    expect(refetch).not.toBeNull();
    refetch?.();

    // No `queryKey`: TanStack reads an absent filter as "all of them",
    // which refetches what is mounted and marks the rest stale. A key
    // here would be a guess at what changed while nobody was listening.
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("lets go of the subscription when it unmounts", () => {
    setBridge(servedBridge());
    const queryClient = createQueryClient();

    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <RefetchOnReconnect />
      </QueryClientProvider>,
    );
    unmount();

    // Otherwise a `queryClient` belonging to a torn-down tree would be
    // invalidated on every reconnection for the life of the page.
    expect(refetch).toBeNull();
  });
});
