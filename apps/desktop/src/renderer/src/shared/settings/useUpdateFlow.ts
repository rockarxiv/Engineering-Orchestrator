import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateStatus } from "@eo/core";
import { bridge } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { useInvalidateOnPush } from "../../query/useInvalidateOnPush";
import { updatesKey } from "./updates";

/**
 * The download and restart sequencing, once, for both surfaces that offer
 * it: Settings → Updates and the corner card (EO-697).
 *
 * Both read the one cached status, so they cannot disagree: a download
 * started from either is a `downloading` status the other draws, and
 * every `updates:progress` push is written into that same status rather
 * than into a component's own state. Nothing here calls `updates:install`
 * except `restart` (EO-696).
 */

/** What was last asked of the updater in this window, so an error's *Try again* repeats it. */
export type UpdateIntent = "check" | "download";

interface FlowMemory {
  intent: UpdateIntent | null;
  /** The last version announced as available or downloaded: what a version-less `downloading` or `error` is about. */
  announced: string | null;
  /** Versions somebody pressed Later on. Held for this renderer's life, which is EO's run. */
  dismissed: readonly string[];
}

const FORGOTTEN: FlowMemory = { intent: null, announced: null, dismissed: [] };

/*
 * Module-level rather than component state: the card and the section are
 * mounted and unmounted independently, and a download started from one
 * that fails must still be retried as a download from the other.
 */
let memory: FlowMemory = FORGOTTEN;
const listeners = new Set<() => void>();

function remember(next: Partial<FlowMemory>): void {
  memory = { ...memory, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Back to how a fresh start of EO finds it. For tests, which share one module across cases. */
export function forgetUpdateFlow(): void {
  memory = FORGOTTEN;
  for (const listener of listeners) listener();
}

const IDLE: UpdateStatus = { state: "idle", lastCheckedAt: null };

export interface UpdateFlow {
  status: UpdateStatus;
  /** The download's percentage while one is in flight, and null otherwise. */
  percent: number | null;
  /** A press from this surface is still being answered. */
  busy: boolean;
  intent: UpdateIntent | null;
  announced: string | null;
  dismissed: readonly string[];
  check(): Promise<void>;
  /** Download, and stop there. From anything but `available` it checks first. It never restarts. */
  download(): Promise<void>;
  /** Repeats what was last asked: the download if it was one, the check otherwise. */
  retry(): Promise<void>;
  /** The only path to `updates:install`. The main process may still ask about running agents first. */
  restart(): Promise<void>;
  /** Later: hide the card for this version until EO next starts. */
  dismiss(version: string): void;
}

export function useUpdateFlow(): UpdateFlow {
  const queryClient = useQueryClient();
  const flow = useSyncExternalStore(subscribe, () => memory, () => FORGOTTEN);
  const [sequencing, setSequencing] = useState(false);

  const query = useQuery({ queryKey: updatesKey, queryFn: () => ipcQuery("updates:status", undefined) });
  // The background check moves the status with nobody having asked.
  useInvalidateOnPush("updates:changed", updatesKey);
  // electron-updater's event stream is the only copy of a download's
  // progress, so the push is written into the status every surface reads.
  // Outside `downloading` it is late and the status already says more.
  useEffect(
    () =>
      bridge().subscribe("updates:progress", ({ percent }) => {
        queryClient.setQueryData<UpdateStatus>(updatesKey, (previous) => (previous?.state === "downloading" ? { ...previous, percent } : previous));
      }),
    [queryClient],
  );

  const status: UpdateStatus = query.data ?? IDLE;

  // A download seen in flight is one an error is about, whoever started it
  // — another window included. And the version a status names is what the
  // version-less states after it are about.
  const announcedNow = status.state === "available" || status.state === "downloaded" ? status.version : null;
  useEffect(() => {
    if (status.state === "downloading" && memory.intent !== "download") remember({ intent: "download" });
    if (announcedNow !== null && memory.announced !== announcedNow) remember({ announced: announcedNow });
  }, [status.state, announcedNow]);

  // Each channel answers with the whole status, so the cache is written
  // rather than invalidated: a refetch could race the next event.
  const store = (next: UpdateStatus): UpdateStatus => {
    queryClient.setQueryData(updatesKey, next);
    return next;
  };

  const checkCall = useMutation({ mutationFn: () => ipcQuery("updates:check", undefined), onSuccess: store });
  const downloadCall = useMutation({ mutationFn: () => ipcQuery("updates:download", undefined), onSuccess: store });
  const installCall = useMutation({ mutationFn: () => ipcQuery("updates:install", undefined) });

  async function check(): Promise<void> {
    remember({ intent: "check" });
    await checkCall.mutateAsync();
  }

  async function download(): Promise<void> {
    remember({ intent: "download" });
    setSequencing(true);
    try {
      // The answer the check returned, not the cache: it is the newer of the two.
      let next = status;
      if (next.state !== "available") next = await checkCall.mutateAsync();
      if (next.state === "available") {
        // What the main process sets the moment it is asked, written
        // ahead of its push so both surfaces draw the bar at once.
        store({ state: "downloading", percent: 0, lastCheckedAt: next.lastCheckedAt });
        await downloadCall.mutateAsync();
      }
    } finally {
      setSequencing(false);
    }
  }

  async function restart(): Promise<void> {
    await installCall.mutateAsync();
  }

  return {
    status,
    percent: status.state === "downloading" ? status.percent : null,
    busy: sequencing || checkCall.isPending || downloadCall.isPending || installCall.isPending,
    intent: flow.intent,
    announced: flow.announced,
    dismissed: flow.dismissed,
    check,
    download,
    retry: () => (memory.intent === "download" ? download() : check()),
    restart,
    dismiss: (version) => {
      if (!memory.dismissed.includes(version)) remember({ dismissed: [...memory.dismissed, version] });
    },
  };
}
