import { useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Play, Workflow } from "lucide-react";
import { JOB_ID_FACET, describeJobTrigger, type JobMachine, type JobOccurrenceRow, type JobPlacement, type JobSummary, type ModuleView, type PipelineView, type RegistryFacts } from "@eo/core";
import { NOTHING, costOf, durationOf, pauseChipOf, timeZoneNote, whenOf, zoneOf } from "../../../shared/jobs/format";
import { ipcQuery } from "../../../query/client";
import { itemsKey, jobKey, jobsRootKey, useModules, usePipelines, useRegistry, useSession, workspacesKey } from "../../../query/hooks";
import { Card, CardSection, Chip, EmptyState, Facts, Loading, Select, Switch, Tabs, ViewHeader, Button } from "../../kit";
import { ItemKeyLink } from "../inbox/references";
import { RunsOn } from "./RunsOn";
import { WatchChecks, WatchStatus, watchFacts } from "./Watch";
import { JobEvents, WebhookAddress, WebhookMappingTable } from "./Webhook";

/**
 * `/jobs/:jobId`: one job, read-only apart from Pause, Resume and Run
 * now (EO-308, EO-787, `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * The trigger with its zone stated, where it runs, the paused switch,
 * Run now, what the job was set up with, and the history including its
 * skipped rows — a job that has quietly done nothing for a fortnight is a
 * fortnight of rows here and a gap nowhere. There is deliberately no list
 * of the items it filed: those are the board and the archive narrowed to
 * this job, and the view links to them.
 *
 * Making, changing and deleting a job are the agents' (EO-784): the
 * assistant's job cards, which a person presses, and an outside agent's
 * job tools. So the page has no form, no Save and no Delete — save for
 * the repository its items are filed on (EO-856), which a person picks
 * from the project's here.
 */
export function JobView({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: jobKey(jobId), queryFn: () => ipcQuery("jobs:get", { jobId }) });
  const cost = useQuery({ queryKey: [...jobKey(jobId), "cost"], queryFn: () => ipcQuery("jobs:cost", { jobId }) });
  const job = query.data?.job ?? null;

  // Solo mode hides the control and never asks the question behind it
  // (EO-330, ARCHITECTURE.md, "Where a job runs"): a placement spawns a CLI, and a desktop with no
  // organisation has one place for work to happen.
  const session = useSession();
  const managed = session.data?.state === "signed-in";
  const placement = useQuery({
    queryKey: [...jobKey(jobId), "placement"],
    queryFn: () => ipcQuery("jobs:placement", { jobId }),
    enabled: managed,
  });

  // The deliveries, for a webhook job (EO-333), and the findings filed
  // or refused, for a watch job (EO-754): both are `job_events` rows.
  const webhook = job?.trigger.kind === "webhook" ? job.trigger : null;
  const watch = job?.trigger.kind === "watch";
  const events = useQuery({
    queryKey: [...jobKey(jobId), "events"],
    queryFn: () => ipcQuery("jobs:events", { jobId }),
    enabled: webhook !== null || watch,
  });

  // Every check a watch job ran (EO-800), a page at a time, newest first.
  const checks = useInfiniteQuery({
    queryKey: [...jobKey(jobId), "checks"],
    enabled: watch,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => ipcQuery("jobs:checks", { jobId, ...(pageParam === undefined ? {} : { before: pageParam }) }),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const checkRows = checks.data?.pages.flatMap((page) => page.checks) ?? [];

  const { registry } = useRegistry();
  const { pipelines } = usePipelines(job?.projectId ?? null);
  const modules = useModules();

  const [tab, setTab] = useState<"history" | "events" | "checks">("history");
  const [ran, setRan] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: jobsRootKey });
    void queryClient.invalidateQueries({ queryKey: itemsKey });
  };

  const pause = useMutation({
    mutationFn: (paused: boolean) => ipcQuery(paused ? "jobs:pause" : "jobs:resume", { jobId }),
    onSuccess: refresh,
  });

  const runNow = useMutation({
    mutationFn: () => ipcQuery("jobs:runNow", { jobId }),
    onSuccess: (result) => {
      setRan(result.fired ? "Filed." : result.problem);
      refresh();
    },
  });

  if (query.isLoading) return <Loading />;
  if (job === null) {
    return (
      <>
        <ViewHeader icon={<Workflow size={15} />} title="Job" />
        <EmptyState title="There is no job here.">
          It has been deleted, or it belongs to a conversation rather than to this screen — either way the work it filed is still on the board, and
          still says where it came from.
        </EmptyState>
      </>
    );
  }

  const chip = pauseChipOf(job);
  const zone = zoneOf(job);
  const occurrences = query.data?.occurrences ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ViewHeader
        icon={<Workflow size={15} />}
        title={job.name}
        actions={
          // Refused for a watch job: the template alone is not a finding.
          watch ? null : (
            <Button icon={<Play size={13} />} onClick={() => runNow.mutate()} disabled={runNow.isPending}>
              Run now
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Switch label="Paused" checked={job.pausedAt !== null} disabled={pause.isPending} onChange={(next) => pause.mutate(next)} />
          {chip === null ? null : <Chip tone="paused">{chip}</Chip>}
        </div>
      </ViewHeader>

      {ran === null ? null : (
        <p role="status" className="text-[13px] text-ink-muted">
          {ran}
        </p>
      )}

      <JobStatus
        job={job}
        costCents={cost.data?.costCents ?? 0}
        managed={managed}
        placement={placement.data?.placement ?? null}
        machine={placement.data?.machine ?? null}
      />

      {webhook === null ? null : <WebhookAddress trigger={webhook} />}

      <CardSection title="Definition" description="Set up and changed by the assistant, or by an agent connected to EO.">
        <Facts
          items={[...definitionFacts(job, pipelines, registry, modules.data?.modules ?? []), { term: "Repository", value: <JobRepository job={job} onSaved={refresh} /> }]}
        />
        {webhook === null ? null : (
          <WebhookMappingTable
            mapping={webhook.mapping}
            itemType={job.template === null ? undefined : registry.itemTypes.get(job.template.type)}
            lastPayload={events.data?.lastPayload ?? null}
          />
        )}
      </CardSection>

      {/* Two records for a webhook job, answering different questions:
          what it filed, and what arrived — including what arrived and
          filed nothing. A watch job's events are its findings, each
          filed or refused, named by its key, and it has a third: every
          check it ran, including the ones that found nothing. */}
      <Card label="Record">
        {webhook === null && !watch ? (
          <History rows={occurrences} timeZone={zone} />
        ) : (
          <>
            <Tabs
              label="Record"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "history", label: "History", count: occurrences.length },
                { value: "events", label: "Events", count: events.data?.events.length ?? 0 },
                ...(watch ? [{ value: "checks" as const, label: "Checks", count: checkRows.length }] : []),
              ]}
            />
            {tab === "history" ? (
              <History rows={occurrences} timeZone={zone} />
            ) : tab === "checks" && watch ? (
              <WatchChecks
                checks={checkRows}
                timeZone={zone}
                hasOlder={checks.hasNextPage}
                loadingOlder={checks.isFetchingNextPage}
                onOlder={() => void checks.fetchNextPage()}
              />
            ) : (
              <JobEvents
                events={events.data?.events ?? []}
                heldCount={events.data?.heldCount ?? 0}
                timeZone={zone}
                {...(watch ? { showKeys: true, empty: "It has not found anything yet." } : {})}
              />
            )}
          </>
        )}
      </Card>

    </div>
  );
}

/**
 * The repository every item the job files is filed on (EO-856): one of
 * its project's, or — for none, which files on the project's only
 * repository when it has exactly one. Saved on change through
 * `jobs:update`, whose refusal — a project with several and an entry step
 * that needs one — is shown beside it.
 */
function JobRepository({ job, onSaved }: { job: JobSummary; onSaved: () => void }) {
  const workspaces = useQuery({
    queryKey: [...workspacesKey, job.projectId] as const,
    queryFn: () => ipcQuery("workspaces:list", { projectId: job.projectId }),
    enabled: job.projectId !== null,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (workspaceId: string | null) => ipcQuery("jobs:update", { jobId: job.id, workspaceId }),
    onSuccess: (result) => {
      setProblem(result.problem);
      if (result.job !== null) onSaved();
    },
  });
  const options = workspaces.data?.workspaces ?? [];
  const gone = job.workspaceId !== null && !options.some((workspace) => workspace.id === job.workspaceId);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        aria-label="Repository"
        value={job.workspaceId ?? ""}
        disabled={save.isPending || workspaces.isLoading}
        onChange={(event) => save.mutate(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{NOTHING}</option>
        {options.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.label}
          </option>
        ))}
        {gone ? <option value={job.workspaceId!}>{`${job.workspaceName ?? job.workspaceId} — no longer on this project`}</option> : null}
      </Select>
      {problem === null ? null : (
        <p role="alert" className="text-[12.5px] text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Where a job's past items live (ARCHITECTURE.md, "The inbox, the archive and jobs"): its own
 * pipeline's board,
 * narrowed — the default board for a job with no pipeline, so the link
 * never names one that is not there.
 */
function boardLink(job: JobSummary): string {
  const board = job.pipelineId === null ? "/project" : `/pipelines/${job.pipelineId}`;
  return `${board}?${JOB_ID_FACET}=${encodeURIComponent(job.id)}`;
}

const QUIET_LINK = "inline-flex h-[26px] items-center rounded-[10px] px-2.5 text-xs font-medium text-ink-muted hover:bg-canvas-raised hover:text-ink";

function JobStatus({
  job,
  costCents,
  managed,
  placement,
  machine,
}: {
  job: JobSummary;
  costCents: number;
  managed: boolean;
  placement: JobPlacement | null;
  machine: JobMachine | null;
}) {
  return (
    <Card label="Status">
      <p className="text-[13px] text-ink">{describeJobTrigger(job.trigger)}</p>
      {job.trigger.kind === "schedule" ? <p className="text-[12.5px] text-ink-subtle">{timeZoneNote(job.trigger)}</p> : null}
      {job.trigger.kind === "watch" ? <WatchStatus job={job} /> : null}
      {/* The design's sentence, and in managed mode where it runs and
          why the other place is unavailable. Solo mode keeps the
          sentence: a desktop with no organisation has one place. */}
      {managed && placement !== null ? (
        <RunsOn job={job} placement={placement} machine={machine} />
      ) : (
        <p className="text-[12.5px] text-ink-subtle">Runs while EO is open on this machine.</p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-muted">
        {/* A watch job has no calendar: when it checks is said above. */}
        {job.trigger.kind === "watch" ? null : (
          <>
            <span>Next run {whenOf(job.nextRunAt, zoneOf(job))}</span>
            <span>Last run {whenOf(job.lastRunAt, zoneOf(job))}</span>
          </>
        )}
        <span>Spent {costOf(costCents)}</span>
      </div>
      <div className="-ml-2.5 flex flex-wrap gap-1">
        <Link to={boardLink(job)} className={QUIET_LINK}>
          Its items on the board
        </Link>
        <Link to={`/archive?${JOB_ID_FACET}=${encodeURIComponent(job.id)}`} className={QUIET_LINK}>
          In the archive
        </Link>
      </div>
    </Card>
  );
}

/**
 * Every occurrence, newest first, the skipped ones included: a fired row
 * is visible as an item on a board, and a skipped one exists nowhere
 * else. The reason is the row's own sentence, the one the owner's message carries.
 */
function History({ rows, timeZone }: { rows: JobOccurrenceRow[]; timeZone: string | undefined }) {
  if (rows.length === 0) return <p className="text-[12.5px] text-ink-subtle">It has not come round yet.</p>;
  return (
    <section aria-label="History" className="flex min-w-0 flex-col">
      <ul className="flex min-w-0 flex-col [&>li+li]:border-t [&>li+li]:border-line/60">
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 items-start gap-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={row.status === "fired" ? "text-[13px] text-ink" : "text-[13px] text-ink-muted"}>
                {row.status === "fired" ? "Fired" : `${row.status}: ${row.reason ?? "no reason recorded"}`}
              </span>
              <span className="text-[11px] text-ink-subtle">Due {whenOf(row.dueAt, timeZone)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-ink-subtle">
              {row.itemKey === null ? <span>{NOTHING}</span> : <ItemKeyLink itemKey={row.itemKey} itemId={row.itemId} />}
              <span title="Cost">{row.status === "fired" ? costOf(row.costCents) : NOTHING}</span>
              <span title="Duration">{durationOf(row.durationMs)}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What the job was set up with, in words: its pipeline, the item each
 * occurrence files, and the budget — and for a schedule its catch-up,
 * for a watch job its module, inputs and Wait while open. The trigger
 * itself, its zone and Runs on are in the status card above.
 */
function definitionFacts(job: JobSummary, pipelines: readonly PipelineView[], registry: RegistryFacts, modules: readonly ModuleView[]): { term: string; value: ReactNode }[] {
  const pipeline = job.pipelineId === null ? null : (pipelines.find((candidate) => candidate.id === job.pipelineId)?.name ?? job.pipelineId);
  const template = job.template;
  return [
    { term: "Trigger", value: describeJobTrigger(job.trigger) },
    ...(job.trigger.kind === "schedule" ? [{ term: "Catch up within", value: `${job.trigger.catchUpWithinMinutes} minutes` }] : []),
    ...(job.trigger.kind === "watch" ? watchFacts(job.trigger, modules) : []),
    { term: "Pipeline", value: pipeline ?? "The project's default" },
    { term: "Type", value: template === null ? NOTHING : (registry.itemTypes.get(template.type)?.label ?? template.type) },
    { term: "Title", value: template?.title ?? NOTHING },
    { term: "Body", value: template?.body ? <span className="whitespace-pre-wrap">{template.body}</span> : NOTHING },
    { term: "Budget per occurrence", value: job.budgetPerOccurrenceCents === null ? "None" : costOf(job.budgetPerOccurrenceCents) },
  ];
}
