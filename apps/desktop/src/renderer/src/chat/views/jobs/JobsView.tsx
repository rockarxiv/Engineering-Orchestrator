import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, Workflow } from "lucide-react";
import { describeJobTrigger, type JobSummary } from "@eo/core";
import { pauseChipOf, whenOf, zoneOf } from "../../../shared/jobs/format";
import { ipcQuery } from "../../../query/client";
import { jobsKey } from "../../../query/hooks";
import { useProjects } from "../../../query/useRepositories";
import { Card, Chip, EmptyState, ErrorLine, Loading, ViewHeader } from "../../kit";
import { AskAssistantButton } from "../board/header";

/**
 * `/jobs`: what this project files on its own (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * Name, trigger, next and last run, and a status chip — the five things
 * the design names. Not a second board: a job's past items are the board and
 * the archive narrowed to it, and this is the list of definitions.
 *
 * No form (EO-787): jobs are set up by the assistant, which proposes a
 * card the person presses, or by an agent connected to EO's MCP host.
 * The line under the header says so, and its button opens the
 * conversation.
 */
export function JobsView() {
  const { active } = useProjects();
  const projectId = active?.id ?? null;
  const jobs = useQuery({ queryKey: jobsKey(projectId), queryFn: () => ipcQuery("jobs:list", { projectId }) });

  const rows = jobs.data?.jobs ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        icon={<Workflow size={15} />}
        title="Jobs"
        meta="What this project files on its own: a trigger, a pipeline, and a template for the work it stamps out."
        actions={rows.length > 0 ? <Chip>{rows.length}</Chip> : null}
      />

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13px] text-ink-muted">Jobs are set up by the assistant, or by an agent connected to EO.</p>
        <AskAssistantButton />
      </div>

      {jobs.isLoading ? <Loading /> : null}
      {jobs.error ? <ErrorLine>{jobs.error.message}</ErrorLine> : null}

      {!jobs.isLoading && rows.length === 0 ? (
        <EmptyState title="Nothing files work on its own here yet.">A job is a trigger, a pipeline and a template for the item it stamps out.</EmptyState>
      ) : null}

      {rows.length > 0 ? (
        <Card className="px-2 py-2" label="Jobs">
          <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
            {rows.map((job) => {
              const chip = pauseChipOf(job);
              return (
                <li key={job.id}>
                  <Link to={`/jobs/${job.id}`} className="flex min-w-0 items-center gap-3 rounded-[10px] px-3 py-2.5 hover:bg-canvas-raised">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-ink">{job.name}</span>
                        {chip === null ? null : <Chip tone="paused">{chip}</Chip>}
                      </span>
                      <span className="truncate text-[12.5px] text-ink-muted">{describeJobTrigger(job.trigger)}</span>
                      {/* In the job's own zone, with the zone named (ARCHITECTURE.md, "The inbox, the archive and jobs"):
                          a list of jobs is a list of different calendars. */}
                      <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-ink-subtle">
                        {job.trigger.kind === "watch" ? (
                          // A watch job has no calendar (EO-799): when it checks, as the Job page's `WatchStatus` says it.
                          <>
                            <span>{nextCheckOf(job)}</span>
                            <span>{lastCheckOf(job)}</span>
                          </>
                        ) : (
                          <>
                            <span>Next run {whenOf(job.nextRunAt, zoneOf(job))}</span>
                            <span>Last run {whenOf(job.lastRunAt, zoneOf(job))}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <ChevronRight aria-hidden size={14} className="shrink-0 text-ink-subtle" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/** When a watch job last checked, on its row. */
function lastCheckOf(job: JobSummary): string {
  const at = job.watch?.lastCheckedAt ?? null;
  return at === null ? "Not checked yet" : `Last checked ${whenOf(at)}`;
}

/**
 * When a watch job checks next, on its row: the same order as the Job
 * page's `WatchStatus`. The item it waits for is named by key and not
 * linked, since the whole row is already a link to the job.
 */
function nextCheckOf(job: JobSummary): string {
  const state = job.watch;
  if (job.pausedAt !== null) return "Paused";
  if (state?.waitingForItemId) return `Next check once ${state.waitingForItemKey ?? "the item it filed"} is finished`;
  if (state === null || state.nextCheckAt === null) return "Next check as soon as EO gets to it";
  return `Next check ${whenOf(state.nextCheckAt)}`;
}
