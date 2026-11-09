import type { UpdateStatus } from "@eo/core";
import { machineAvailable } from "../ipc/bridge";
import { useUpdateFlow, type UpdateFlow } from "../shared/settings/useUpdateFlow";
import { Button } from "./kit";

/**
 * A newer EO, announced in the window's bottom-right corner (EO-697).
 *
 * No backdrop and nothing modal: the card is a box in a corner, and the
 * rest of the window takes clicks while it is up. It follows the status
 * Settings → Updates reads, through the same hook, so the two always
 * agree — a download started from either is drawn on both.
 *
 * Later hides it for that version until EO next starts; a different
 * version shows it again, and Settings → Updates offers the update
 * whatever was pressed here. Nothing is drawn where there is no machine,
 * the rule that hides Settings → Updates there (EO-319).
 */
export function UpdateCard() {
  return machineAvailable() ? <Card /> : null;
}

/** Which version the card is about in this status, or null when it is not drawn. */
function shownFor(status: UpdateStatus, flow: Pick<UpdateFlow, "intent" | "announced" | "dismissed">): string | null {
  const about = flow.announced ?? "";
  switch (status.state) {
    case "available":
    case "downloaded":
      return flow.dismissed.includes(status.version) ? null : status.version;
    case "downloading":
      return flow.dismissed.includes(about) ? null : about;
    case "error":
      // Only a failed download. A failed background check has nothing to offer here.
      return flow.intent === "download" && !flow.dismissed.includes(about) ? about : null;
    default:
      return null;
  }
}

function Card() {
  const flow = useUpdateFlow();
  const { status, percent, busy } = flow;
  const version = shownFor(status, flow);
  if (version === null) return null;

  const later = (
    <Button variant="ghost" onClick={() => flow.dismiss(version)}>
      Later
    </Button>
  );

  return (
    <aside
      aria-label="EO update"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-[var(--z-sticky)] flex w-[20rem] flex-col gap-3 rounded-[14px] border border-line bg-canvas p-4 text-ink shadow-panel"
    >
      {status.state === "available" ? (
        <>
          <p className="text-[13px]">EO {status.version} is available</p>
          <div className="flex justify-end gap-2">
            {later}
            <Button variant="primary" disabled={busy} onClick={() => void flow.download()}>
              Download
            </Button>
          </div>
        </>
      ) : null}

      {percent !== null ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px]">Downloading{version ? ` EO ${version}` : ""}… {Math.round(percent)}%</p>
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
        </div>
      ) : null}

      {status.state === "downloaded" ? (
        <>
          <p className="text-[13px]">EO {status.version} is ready</p>
          <div className="flex justify-end gap-2">
            {later}
            <Button variant="primary" disabled={busy} onClick={() => void flow.restart()}>
              Restart and update
            </Button>
          </div>
        </>
      ) : null}

      {status.state === "error" ? (
        <>
          <p role="alert" className="text-[12.5px] text-danger">
            {status.message}
          </p>
          <div className="flex justify-end gap-2">
            {later}
            <Button disabled={busy} onClick={() => void flow.retry()}>
              Try again
            </Button>
          </div>
        </>
      ) : null}
    </aside>
  );
}
