import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isDebugWindowSearch } from "@eo/core";
import { machineAvailable } from "../ipc/bridge";
import { ipcQuery } from "../query/client";
import { useInvalidateOnPush } from "../query/useInvalidateOnPush";

/** The debug-mode query key, shared by the switch, the F12 listener and the window. */
export const debugModeKey = ["debug", "mode"] as const;

/** Whether this is the debug window: the same bundle, loaded with `?window=debug` (EO-392). */
export function isDebugWindow(): boolean {
  return typeof window !== "undefined" && isDebugWindowSearch(window.location.search);
}

/**
 * Whether debug mode is on, kept current.
 *
 * `undefined` until it is known, and never asked where there is no
 * machine: `debug:*` is the machine half of the contract, so a served
 * page would only be collecting refusals.
 *
 * Refetched on `config:changed`, which the switch's handler emits — the
 * setting is flipped in one window and the F12 listener lives in all of
 * them.
 */
export function useDebugMode(): boolean | undefined {
  const mode = useQuery({ queryKey: debugModeKey, queryFn: () => ipcQuery("debug:getMode", undefined), enabled: machineAvailable() });
  useInvalidateOnPush("config:changed", debugModeKey, machineAvailable());
  return mode.data?.enabled;
}

/** Turns debug mode on or off. */
export function useSetDebugMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => ipcQuery("debug:setMode", { enabled }),
    onSuccess: (stored) => queryClient.setQueryData(debugModeKey, stored),
  });
}
