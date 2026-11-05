import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { bridge } from "../ipc/bridge";

/**
 * What a client does when its push transport has been away (EO-321).
 *
 * A browser client's connection to the server can be interrupted — a
 * laptop that slept, a proxy that timed out, a server that restarted —
 * and while it is gone, pushes are sent to nobody. The server answers
 * the reconnection with one `refetch` rather than replaying what was
 * missed, and this is the end that acts on it: every query in the cache
 * invalidated, which refetches what is mounted and marks the rest stale
 * for whenever it is next looked at.
 *
 * That is equivalent to the replay, and cheaper than one, because of
 * what a push is here: every channel bar `updates:progress` says "this
 * changed, ask again" and carries no state (`ipcPushContract`). Forty
 * missed invalidations and one refetch leave the renderer in the same
 * place.
 *
 * Mounted once, under the `QueryClientProvider` and above everything
 * else, because it is about the whole cache rather than about a screen.
 * Under Electron it subscribes nobody and costs one effect: the preload
 * is part of the process it talks to and cannot be disconnected from it
 * — see `RendererBridge.subscribeRefetch`.
 *
 * It renders nothing. There is deliberately no spinner, no toast and no
 * "reconnecting" banner: this story is about the data being right, and
 * what a person should notice about a reconnection is that the board
 * they are looking at is current.
 */
export function RefetchOnReconnect(): null {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      bridge().subscribeRefetch(() => {
        // No `queryKey`: the whole cache, because what was missed is
        // exactly what this end does not know.
        void queryClient.invalidateQueries();
      }),
    [queryClient],
  );

  return null;
}
