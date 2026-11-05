import { QueryClient } from "@tanstack/react-query";
import type { IpcChannel, IpcRequest, IpcResponse } from "@eo/core";
import { bridge } from "../ipc/bridge";

/**
 * Calls the main process and unwraps the IpcResult envelope.
 *
 * The envelope exists so IPC never throws across the boundary (F-04),
 * but TanStack Query signals failure by rejecting — so this is where the
 * two conventions meet. Returning `{ ok: false }` as a *resolved* value
 * would make every failed query look successful to the cache.
 */
export async function ipcQuery<K extends IpcChannel>(channel: K, payload: IpcRequest<K>): Promise<IpcResponse<K>> {
  const result = await bridge().invoke(channel, payload);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The main process pushes when something changes (see
        // useInvalidateOnPush), and that stays the mechanism — polling
        // would be redundant work, so there is deliberately no
        // refetchInterval anywhere.
        //
        // Focus refetch is the *backstop*, and it earned its place: five
        // separate write paths turned out to emit no push at all, which
        // left a posted reply invisible until the screen was remounted.
        // A missed push now heals the moment you come back to the
        // window. It does not fight anything — `staleTime` means only
        // queries untouched for 30s refetch, and TanStack dedupes a
        // focus refetch against an in-flight invalidation.
        //
        // These are local SQLite reads over in-process IPC, so the cost
        // of being wrong in this direction is a few milliseconds.
        refetchOnWindowFocus: true,
        staleTime: 30_000,
        retry: false, // a failing IPC call is a bug to surface, not a flake to paper over
      },
    },
  });
}
