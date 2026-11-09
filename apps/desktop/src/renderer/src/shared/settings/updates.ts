import { useQuery } from "@tanstack/react-query";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";

export const updatesKey = ["updates"] as const;

export const appVersionKey = ["app", "version"] as const;

/**
 * Whether EO is updated by hand here — macOS, where it cannot install
 * over itself (EO-698) — as the main process says on the update status.
 *
 * Also true while the status has not arrived yet, so a Mac never shows
 * Settings → Updates for a moment before taking it away. Elsewhere the
 * section appears as soon as the answer does, which by the time Settings
 * is open is usually already cached: the corner card reads it at start.
 */
export function useUpdatedByHand(): boolean {
  const query = useQuery({ queryKey: updatesKey, queryFn: () => ipcQuery("updates:status", undefined), enabled: machineAvailable() });
  return query.isPending || query.data?.manual === true;
}
