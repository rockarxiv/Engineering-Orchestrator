import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { JobSummary, ModuleView, WatchTrigger } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { jobsRootKey, useModulesWithDeleted } from "../../../query/hooks";
import { Chip } from "../../kit";

/**
 * What feeds a pipeline from a watch (EO-754): each watch job filing onto
 * it, named with its module and how often it checks, linking to the job.
 * Said on the head the board and the graph share, and in the pipeline's
 * details, so where its work comes from is not a question for Jobs.
 */

export interface WatchIntake {
  jobId: string;
  jobName: string;
  moduleName: string;
  everyMinutes: number;
  paused: boolean;
}

/** The watch jobs filing onto this pipeline, whatever project they are on. */
export function useWatchIntakes(pipelineId: string): WatchIntake[] {
  const jobs = useQuery({ queryKey: [...jobsRootKey, "pipeline", pipelineId], queryFn: () => ipcQuery("jobs:list", { pipelineId }) });
  const modules = useModulesWithDeleted();
  return watchIntakesOf(jobs.data?.jobs ?? [], modules.data?.modules ?? []);
}

export function watchIntakesOf(jobs: JobSummary[], modules: ModuleView[]): WatchIntake[] {
  return jobs.flatMap((job) => {
    if (job.trigger.kind !== "watch" || job.deletedAt !== null) return [];
    const trigger: WatchTrigger = job.trigger;
    const module = modules.find((one) => one.id === trigger.moduleId);
    return [{ jobId: job.id, jobName: job.name, moduleName: module?.name ?? trigger.moduleId, everyMinutes: trigger.everyMinutes, paused: job.pausedAt !== null }];
  });
}

/** "Fed by Dependabot · dependabot-alerts, every 60 minutes" — one sentence, the same on the head and in the details. */
export function watchIntakeLine(intake: WatchIntake): string {
  const every = intake.everyMinutes === 1 ? "every minute" : `every ${intake.everyMinutes} minutes`;
  return `Fed by ${intake.jobName} · ${intake.moduleName}, ${every}${intake.paused ? " (paused)" : ""}`;
}

/** On the pipeline's head: one chip per watch job, each a link to the job. Nothing when no watch job files here. */
export function WatchIntakeChips({ pipelineId }: { pipelineId: string }) {
  const intakes = useWatchIntakes(pipelineId);
  return (
    <>
      {intakes.map((intake) => (
        <Link key={intake.jobId} to={`/jobs/${intake.jobId}`} className="inline-flex rounded-[7px] hover:opacity-80">
          <Chip title="A watch job files what its module finds onto this pipeline.">{watchIntakeLine(intake)}</Chip>
        </Link>
      ))}
    </>
  );
}

/** In the pipeline's details: the same lines, or that nothing watches for it. */
export function WatchIntakeFact({ pipelineId }: { pipelineId: string }) {
  const intakes = useWatchIntakes(pipelineId);
  if (intakes.length === 0) return <>No watch job files onto this pipeline.</>;
  return (
    <span className="flex flex-col gap-1">
      {intakes.map((intake) => (
        <Link key={intake.jobId} to={`/jobs/${intake.jobId}`} className="text-ink underline-offset-2 hover:underline">
          {watchIntakeLine(intake)}
        </Link>
      ))}
    </span>
  );
}
