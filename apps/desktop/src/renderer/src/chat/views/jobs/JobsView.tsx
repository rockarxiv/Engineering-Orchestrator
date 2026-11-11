import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Plus, Workflow } from "lucide-react";
import { describeJobTrigger } from "@eo/core";
import { blankDraft, budgetOf, templateOf, triggerOf, type JobDraft } from "../../../shared/jobs/draft";
import { pauseChipOf, whenOf, zoneOf } from "../../../shared/jobs/format";
import { ipcQuery } from "../../../query/client";
import { jobsKey, jobsRootKey } from "../../../query/hooks";
import { useProjects } from "../../../query/useRepositories";
import { Button, Card, CardSection, Chip, EmptyState, ErrorLine, Loading, ViewHeader } from "../../kit";
import { JobFields } from "./JobFields";

/**
 * `/jobs`: what this project files on its own (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * Name, trigger, next and last run, and a status chip — the five things
 * the design names. Not a second board: a job's past items are the board and
 * the archive narrowed to it, and this is the list of definitions.
 */
export function JobsView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { active } = useProjects();
  const projectId = active?.id ?? null;
  const jobs = useQuery({ queryKey: jobsKey(projectId), queryFn: () => ipcQuery("jobs:list", { projectId }) });
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (next: JobDraft) =>
      ipcQuery("jobs:create", {
        projectId,
        name: next.name,
        trigger: triggerOf(next),
        pipelineId: next.pipelineId === "" ? null : next.pipelineId,
        template: templateOf(next),
        budgetPerOccurrenceCents: budgetOf(next),
      }),
    onSuccess: (result) => {
      // A refusal is the caller's own mistake, answered where it was made.
      if (result.job === null) {
        setProblem(result.problem);
        return;
      }
      setProblem(null);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: jobsRootKey });
      // With what the save did not check (EO-736), for the job's page to say.
      void navigate(`/jobs/${result.job.id}`, result.notice ? { state: { notice: result.notice } } : undefined);
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

  const rows = jobs.data?.jobs ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        icon={<Workflow size={15} />}
        title="Jobs"
        meta="What this project files on its own: a trigger, a pipeline, and a template for the work it stamps out."
        actions={
          <>
            {rows.length > 0 ? <Chip>{rows.length}</Chip> : null}
            <Button
              variant={draft === null ? "primary" : "ghost"}
              icon={draft === null ? <Plus size={14} /> : undefined}
              onClick={() => {
                setProblem(null);
                setDraft(draft === null ? blankDraft() : null);
              }}
            >
              {draft === null ? "New job" : "Cancel"}
            </Button>
          </>
        }
      />

      {draft === null ? null : (
        <CardSection title="New job">
          <JobFields draft={draft} projectId={projectId} onChange={setDraft} />
          {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
          <div className="flex justify-end">
            <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate(draft)}>
              Create job
            </Button>
          </div>
        </CardSection>
      )}

      {jobs.isLoading ? <Loading /> : null}
      {jobs.error ? <ErrorLine>{jobs.error.message}</ErrorLine> : null}

      {!jobs.isLoading && rows.length === 0 && draft === null ? (
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
                        <span>Next run {whenOf(job.nextRunAt, zoneOf(job))}</span>
                        <span>Last run {whenOf(job.lastRunAt, zoneOf(job))}</span>
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
