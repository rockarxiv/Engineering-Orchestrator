import { useState } from "react";
import {
  NOT_AVAILABLE_FOR_THIS_JOB,
  jobMachineLine,
  placementAllows,
  placementStranded,
  placementSummary,
  reasonsAgainst,
  runsOnLabel,
  type JobMachine,
  type JobPlacement,
  type JobRunsOn,
  type JobSummary,
} from "@eo/core";
import { Button } from "../../kit";

/** The two places, in the order their reasons are listed. */
const PLACES: readonly JobRunsOn[] = ["device", "server"];

/**
 * "Runs on: this machine / organisation server" (EO-330,
 * the original design, invariant 12), stated rather than picked (EO-787):
 * a job is moved by the assistant's card or an outside agent's tool, and
 * `jobs:update` refuses a place the job would quietly fail in.
 *
 * Beside it, every reason a place is unavailable: each says what is in
 * the way *and* what would clear it, and each such place has its own
 * copyable summary for an admin.
 *
 * Every unavailable place is explained, the job's own included: placement
 * is derived (invariant #6), so the ground can move under a job standing
 * still, and the page must never be silent about why.
 */
export function RunsOn({ job, placement, machine }: { job: JobSummary; placement: JobPlacement; machine: JobMachine | null }) {
  const [copied, setCopied] = useState<JobRunsOn | null>(null);
  const greyed = PLACES.filter((where) => !placementAllows(placement, where));
  const here = !placementAllows(placement, job.runsOn);

  const copy = (where: JobRunsOn) => {
    void navigator.clipboard?.writeText(placementSummary({ jobName: job.name, placement, where }));
    setCopied(where);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-[13px] text-ink">
        Runs on {runsOnLabel(job.runsOn)}
        {here ? ` — ${NOT_AVAILABLE_FOR_THIS_JOB}` : ""}
      </p>

      {job.runsOn === "device" && machine !== null ? <p className="text-[12.5px] text-ink-subtle">{jobMachineLine(machine, Date.now())}</p> : null}
      {job.runsOn === "server" ? <p className="text-[12.5px] text-ink-subtle">Runs on the organisation server, whether or not any desktop is open.</p> : null}

      {/* First, because it is the one line about work that is happening
          rather than about a choice. */}
      {here && !placementStranded(placement) ? (
        <p className="text-[12.5px] text-danger">
          This job can no longer run where it is. Ask the assistant to move it to "{runsOnLabel(job.runsOn === "device" ? "server" : "device")}".
        </p>
      ) : null}

      {greyed.map((where) => (
        <div key={where} className="flex min-w-0 flex-col gap-1.5 rounded-[12px] bg-canvas-subtle px-3.5 py-2.5">
          <p className="text-[11.5px] text-ink-subtle">
            Why "{runsOnLabel(where)}" is {NOT_AVAILABLE_FOR_THIS_JOB}:
          </p>
          <ul className="flex flex-col gap-1">
            {reasonsAgainst(placement, where).map((reason) => (
              <li key={`${reason.kind}:${reason.stepName ?? ""}:${reason.subject}`} className="text-[12.5px] leading-snug text-ink-muted">
                {reason.line} <span className="text-ink-subtle">{reason.fix}</span>
              </li>
            ))}
          </ul>
          <div>
            {/* One per greyed place, and named for it: an admin can answer
                reasons one at a time and cannot answer two places at once. */}
            <Button size="sm" variant="ghost" aria-label={`Copy why "${runsOnLabel(where)}" is unavailable`} onClick={() => copy(where)}>
              {copied === where ? "Copied" : "Copy these reasons"}
            </Button>
          </div>
        </div>
      ))}

      {placementStranded(placement) ? (
        <p className="text-[12.5px] text-ink-subtle">Neither place can run this job as it stands. Clearing any one reason above opens the place it was greying.</p>
      ) : null}
    </div>
  );
}
