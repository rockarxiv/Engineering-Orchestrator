import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateStatus } from "@eo/core";
import { bridge } from "../../../../ipc/bridge";
import { ipcQuery } from "../../../../query/client";
import { useInvalidateOnPush } from "../../../../query/useInvalidateOnPush";
import { appVersionKey, updatesKey } from "../../../../shared/settings/updates";
import { Button, CardSection, Chip, type Tone } from "../../../kit";
import { Note } from "../core/fields";

/**
 * Settings → Updates (EO-201): which build this is, whether there is a
 * newer one, and one button whose label is the state it is in — *Check
 * for updates*, *Download*, a progress readout, *Restart and update*.
 *
 * One state is a dead end — a build from source — and it says so and
 * offers no button. Downloading and restarting are separate presses
 * (EO-696): a finished download never leads to a restart by itself, and
 * a failed one cannot either, because nothing here calls
 * `updates:install` except the *Restart and update* button.
 */

/** What the last press was, so an error's *Try again* repeats it. */
type LastAction = "check" | "download";

function formatChecked(epochMs: number | null): string {
  if (epochMs === null) return "not yet";
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function toneFor(status: UpdateStatus): Tone {
  switch (status.state) {
    case "error":
      return "danger";
    case "available":
    case "downloaded":
      return "tag";
    case "checking":
    case "downloading":
      return "running";
    case "unsupported":
      return "paused";
    default:
      return "neutral";
  }
}

function labelFor(status: UpdateStatus): string {
  switch (status.state) {
    case "unsupported":
      return "not applicable";
    case "up-to-date":
      return "up to date";
    case "downloaded":
      return "ready to install";
    default:
      return status.state;
  }
}

const DESCRIPTION = "Which build of EO this is, and whether there is a newer one.";

export function UpdatesSection() {
  const queryClient = useQueryClient();
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [sequencing, setSequencing] = useState(false);
  // The pushed percentage: electron-updater's event stream is the only
  // copy of a download's progress, so there is nothing to refetch it from.
  // Null means no download is in flight.
  const [pushedPercent, setPushedPercent] = useState<number | null>(null);

  const version = useQuery({ queryKey: appVersionKey, queryFn: () => ipcQuery("app:getVersion", undefined) });
  const status = useQuery({ queryKey: updatesKey, queryFn: () => ipcQuery("updates:status", undefined) });
  useEffect(() => bridge().subscribe("updates:progress", (payload) => setPushedPercent(payload.percent)), []);
  // The background check moves the status with nobody having asked.
  useInvalidateOnPush("updates:changed", updatesKey);

  // Each channel answers with the whole status, so the cache is written
  // rather than invalidated: a refetch could race the next event.
  const store = (next: UpdateStatus): UpdateStatus => {
    if (next.state !== "downloading") setPushedPercent(null);
    queryClient.setQueryData(updatesKey, next);
    return next;
  };

  const check = useMutation({ mutationFn: () => ipcQuery("updates:check", undefined), onSuccess: store });
  const download = useMutation({ mutationFn: () => ipcQuery("updates:download", undefined), onSuccess: store });
  const install = useMutation({ mutationFn: () => ipcQuery("updates:install", undefined) });

  const current: UpdateStatus = status.data ?? { state: "idle", lastCheckedAt: null };
  const busy = sequencing || check.isPending || download.isPending || install.isPending;

  async function checkNow(): Promise<void> {
    setLastAction("check");
    await check.mutateAsync();
  }

  /**
   * Download, and stop there. From anything but `available` — a failed
   * download being tried again — it checks first, reading the answer the
   * check returned rather than the cache. It never restarts.
   */
  async function downloadNow(): Promise<void> {
    setLastAction("download");
    setSequencing(true);
    try {
      let next = current;
      if (next.state !== "available") next = await check.mutateAsync();
      if (next.state === "available") {
        setPushedPercent(0);
        await download.mutateAsync();
      }
    } finally {
      setSequencing(false);
    }
  }

  /** The only path to `updates:install`. The main process may still ask about running agents first. */
  async function restartAndUpdate(): Promise<void> {
    await install.mutateAsync();
  }

  const retry = (): void => void (lastAction === "download" ? downloadNow() : checkNow());
  const header = <Header version={version.data?.version} status={current} />;

  if (current.state === "unsupported") {
    return (
      <CardSection title="Updates" description={DESCRIPTION}>
        {header}
        <p className="text-[13px] text-ink-muted">Updates apply to installed builds; this is running from source.</p>
      </CardSection>
    );
  }

  // The pushed value wins: the push is the event stream itself, a status read only a snapshot of it.
  const percent = pushedPercent ?? (current.state === "downloading" ? current.percent : null);

  return (
    <CardSection title="Updates" description={DESCRIPTION}>
      {header}

      {current.state === "available" ? <p className="text-[13px] text-ink">EO {current.version} is available.</p> : null}
      {current.state === "up-to-date" ? <p className="text-[13px] text-ink-muted">This is the newest release.</p> : null}
      {current.state === "downloaded" ? <p className="text-[13px] text-ink">EO {current.version} has been downloaded. It installs when you press Restart and update.</p> : null}
      {current.state === "error" ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {current.message}
        </p>
      ) : null}

      {percent !== null ? (
        <div className="flex max-w-[24rem] flex-col gap-1.5">
          <div
            role="progressbar"
            aria-label="Download progress"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-canvas-raised"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(percent)}%` }} />
          </div>
          <Note>Downloading… {Math.round(percent)}%</Note>
        </div>
      ) : null}

      <div>
        {current.state === "error" ? (
          <Button disabled={busy} onClick={retry}>
            Try again
          </Button>
        ) : current.state === "downloaded" ? (
          <Button variant="primary" disabled={busy} onClick={() => void restartAndUpdate()}>
            Restart and update
          </Button>
        ) : current.state === "available" || percent !== null ? (
          <Button variant="primary" disabled={busy || percent !== null} onClick={() => void downloadNow()}>
            Download
          </Button>
        ) : (
          <Button disabled={busy || current.state === "checking"} onClick={() => void checkNow()}>
            Check for updates
          </Button>
        )}
      </div>
    </CardSection>
  );
}

/** The running version and when EO last looked — true in every state that has looked at all. */
function Header({ version, status }: { version: string | undefined; status: UpdateStatus }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Chip tone={toneFor(status)}>{labelFor(status)}</Chip>
      <span className="font-mono text-[12.5px] text-ink">EO {version ?? "…"}</span>
      {"lastCheckedAt" in status ? <span className="text-[11.5px] text-ink-subtle">Last checked: {formatChecked(status.lastCheckedAt)}</span> : null}
    </div>
  );
}
