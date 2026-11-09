import { useQuery } from "@tanstack/react-query";
import type { UpdateStatus } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { appVersionKey } from "../../../../shared/settings/updates";
import { useUpdateFlow } from "../../../../shared/settings/useUpdateFlow";
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
  // The status, the progress and the sequencing are the corner card's too (EO-697).
  const { status: current, percent, busy, check, download, retry, restart } = useUpdateFlow();
  const version = useQuery({ queryKey: appVersionKey, queryFn: () => ipcQuery("app:getVersion", undefined) });

  const header = <Header version={version.data?.version} status={current} />;

  if (current.state === "unsupported") {
    return (
      <CardSection title="Updates" description={DESCRIPTION}>
        {header}
        <p className="text-[13px] text-ink-muted">Updates apply to installed builds; this is running from source.</p>
      </CardSection>
    );
  }

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
          <Button disabled={busy} onClick={() => void retry()}>
            Try again
          </Button>
        ) : current.state === "downloaded" ? (
          <Button variant="primary" disabled={busy} onClick={() => void restart()}>
            Restart and update
          </Button>
        ) : current.state === "available" || percent !== null ? (
          <Button variant="primary" disabled={busy || percent !== null} onClick={() => void download()}>
            Download
          </Button>
        ) : (
          <Button disabled={busy || current.state === "checking"} onClick={() => void check()}>
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
