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
import { Button, Field, Select } from "../../kit";

/** The two places, in the order the picker offers them. */
const PLACES: readonly JobRunsOn[] = ["device", "server"];

/**
 * "Runs on: this machine / organisation server" (EO-330,
 * the original design, invariant 12).
 *
 * One control, and beside it every reason each greyed option is greyed:
 * a person is never allowed to pick a place where the job would quietly
 * fail, so such a place is disabled rather than offered and refused. Each
 * reason says what is in the way *and* what would clear it, and each
 * greyed place has its own copyable summary for an admin.
 *
 * Every greyed place is explained, the job's own included: placement is
 * derived (invariant #6), so the ground can move under a job standing
 * still, and a greyed control must never be silent about why.
 */
export function RunsOn({
  job,
  placement,
  machine,
  onChange,
  saving,
}: {
  job: JobSummary;
  placement: JobPlacement;
  machine: JobMachine | null;
  onChange: (next: JobRunsOn) => void;
  saving: boolean;
}) {
  const [copied, setCopied] = useState<JobRunsOn | null>(null);
  const greyed = PLACES.filter((where) => !placementAllows(placement, where));
  const here = !placementAllows(placement, job.runsOn);

  const copy = (where: JobRunsOn) => {
    void navigator.clipboard?.writeText(placementSummary({ jobName: job.name, placement, where }));
    setCopied(where);
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Field label="Runs on">
        <Select value={job.runsOn} disabled={saving} onChange={(event) => onChange(event.target.value as JobRunsOn)}>
          {PLACES.map((where) => (
            // Disabled rather than absent, so the reasons below answer a
            // question the control on screen is asking.
            <option key={where} value={where} disabled={!placementAllows(placement, where)}>
              {runsOnLabel(where)}
              {placementAllows(placement, where) ? "" : ` — ${NOT_AVAILABLE_FOR_THIS_JOB}`}
            </option>
          ))}
        </Select>
      </Field>

      {job.runsOn === "device" && machine !== null ? <p className="text-[12.5px] text-ink-subtle">{jobMachineLine(machine, Date.now())}</p> : null}
      {job.runsOn === "server" ? <p className="text-[12.5px] text-ink-subtle">Runs on the organisation server, whether or not any desktop is open.</p> : null}

      {/* First, because it is the one line about work that is happening
          rather than about a choice. */}
      {here && !placementStranded(placement) ? (
        <p className="text-[12.5px] text-danger">
          This job can no longer run where it is. Move it to "{runsOnLabel(job.runsOn === "device" ? "server" : "device")}".
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
