import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Play, Workflow } from "lucide-react";
import { JOB_ID_FACET, describeJobTrigger, type JobMachine, type JobOccurrenceRow, type JobPlacement, type JobRunsOn, type JobSummary } from "@eo/core";
import { budgetOf, draftOf, templateOf, triggerOf, watchDraftProblem, type JobDraft } from "../../../shared/jobs/draft";
import { NOTHING, costOf, durationOf, pauseChipOf, timeZoneNote, whenOf, zoneOf } from "../../../shared/jobs/format";
import { archivedKey } from "../../../shared/pipeline/archive";
import { ipcQuery } from "../../../query/client";
import { itemsKey, jobKey, jobsRootKey, useRegistry, useSession } from "../../../query/hooks";
import { Button, Card, CardSection, Chip, Dialog, EmptyState, ErrorLine, Loading, Switch, Tabs, ViewHeader } from "../../kit";
import { ItemKeyLink } from "../inbox/references";
import { JobFields } from "./JobFields";
import { RunsOn } from "./RunsOn";
import { WatchStatus } from "./Watch";
import { JobEvents, WebhookAddress, WebhookMappingTable } from "./Webhook";

/**
 * `/jobs/:jobId`: one job, as a full editor (EO-308,
 * `ARCHITECTURE.md`, "The inbox, the archive and jobs").
 *
 * The trigger with its zone stated, where it runs, the paused switch,
 * Run now, the form, and the history including its skipped rows — a job
 * that has quietly done nothing for a fortnight is a fortnight of rows
 * here and a gap nowhere. There is deliberately no list of the items it
 * filed: those are the board and the archive narrowed to this job, and
 * the view links to them.
 */
export function JobView({ jobId }: { jobId: string }) {
  const navigate = useNavigate();
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

  const { registry } = useRegistry();

  const [tab, setTab] = useState<"history" | "events">("history");
  const [draft, setDraft] = useState<JobDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // What the save did not check (EO-736): a pipeline's entry check, which
  // runs on each firing. Seeded from the page that created the job.
  const location = useLocation();
  const [notice, setNotice] = useState<string | null>(noticeFrom(location.state));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const [movedProblem, setMovedProblem] = useState<string | null>(null);

  // Seeded once the job arrives, then left alone: re-seeding on every
  // answer would throw away what somebody is typing when a push lands.
  useEffect(() => {
    setDraft((current) => (current === null && job !== null ? draftOf(job) : current));
  }, [job]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: jobsRootKey });
    void queryClient.invalidateQueries({ queryKey: itemsKey });
  };

  const save = useMutation({
    mutationFn: (next: JobDraft) =>
      ipcQuery("jobs:update", {
        jobId,
        name: next.name,
        trigger: triggerOf(next),
        pipelineId: next.pipelineId === "" ? null : next.pipelineId,
        template: templateOf(next),
        budgetPerOccurrenceCents: budgetOf(next),
      }),
    onSuccess: (result) => {
      setProblem(result.problem);
      setNotice(result.notice ?? null);
      if (result.job !== null) refresh();
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
  });

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

  // Its own mutation rather than a field in the draft (EO-330): where a
  // job runs takes effect the moment it is picked, and can be refused on
  // its own terms.
  const runsOn = useMutation({
    mutationFn: (next: JobRunsOn) => ipcQuery("jobs:update", { jobId, runsOn: next }),
    onSuccess: (result) => {
      setMovedProblem(result.problem);
      if (result.job !== null) refresh();
      void queryClient.invalidateQueries({ queryKey: [...jobKey(jobId), "placement"] });
    },
  });

  const remove = useMutation({
    mutationFn: (archiveItems: boolean) => ipcQuery("jobs:delete", { jobId, archiveItems }),
    onSuccess: () => {
      setConfirmingDelete(false);
      refresh();
      void queryClient.invalidateQueries({ queryKey: archivedKey });
      void navigate("/jobs");
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
          <>
            {/* Refused for a watch job: the template alone is not a finding. */}
            {watch ? null : (
              <Button icon={<Play size={13} />} onClick={() => runNow.mutate()} disabled={runNow.isPending}>
                Run now
              </Button>
            )}
            <Button variant="ghost" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
          </>
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
        onRunsOnChange={(next) => runsOn.mutate(next)}
        savingRunsOn={runsOn.isPending}
        movedProblem={movedProblem}
      />

      {webhook === null ? null : <WebhookAddress jobId={jobId} trigger={webhook} onChanged={refresh} />}

      {draft === null ? null : (
        <CardSection title="Definition" description="Saved together: nothing here changes the job until Save.">
          <JobFields draft={draft} projectId={job.projectId} onChange={setDraft} />
          {draft.webhook === null ? null : (
            <WebhookMappingTable draft={draft} itemType={registry.itemTypes.get(draft.type)} lastPayload={events.data?.lastPayload ?? null} onChange={setDraft} />
          )}
          {problem === null ? null : <ErrorLine>{problem}</ErrorLine>}
          {problem === null && notice !== null ? <p className="text-[12px] text-ink-muted">{notice}</p> : null}
          <div className="flex items-center justify-end gap-2">
            {save.isSuccess && problem === null ? <span className="text-[12px] text-ink-subtle">Saved.</span> : null}
            <Button
              variant="primary"
              disabled={save.isPending}
              onClick={() => {
                const unsent = watchDraftProblem(draft);
                if (unsent === null) save.mutate(draft);
                else setProblem(unsent);
              }}
            >
              Save
            </Button>
          </div>
        </CardSection>
      )}

      {/* Two records for a webhook job, answering different questions:
          what it filed, and what arrived — including what arrived and
          filed nothing. A watch job's events are its findings, each
          filed or refused, named by its key. */}
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
              ]}
            />
            {tab === "history" ? (
              <History rows={occurrences} timeZone={zone} />
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

      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        busy={remove.isPending}
        title={`Delete "${job.name}"?`}
        description="It stops firing either way. What should happen to the work it has already filed?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            {/* "Keep them" first: it is the one that loses nothing. */}
            <Button onClick={() => remove.mutate(false)} disabled={remove.isPending} data-autofocus>
              Keep them
            </Button>
            <Button variant="danger" onClick={() => remove.mutate(true)} disabled={remove.isPending}>
              Archive its items
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Kept items stay on the board and go on naming this job. Archived ones keep their threads, their runs and their cost, and can be restored from
          the archive.
        </p>
      </Dialog>
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
  onRunsOnChange,
  savingRunsOn,
  movedProblem,
}: {
  job: JobSummary;
  costCents: number;
  managed: boolean;
  placement: JobPlacement | null;
  machine: JobMachine | null;
  onRunsOnChange: (next: JobRunsOn) => void;
  savingRunsOn: boolean;
  movedProblem: string | null;
}) {
  return (
    <Card label="Status">
      <p className="text-[13px] text-ink">{describeJobTrigger(job.trigger)}</p>
      {job.trigger.kind === "schedule" ? <p className="text-[12.5px] text-ink-subtle">{timeZoneNote(job.trigger)}</p> : null}
      {job.trigger.kind === "watch" ? <WatchStatus job={job} /> : null}
      {/* The design's sentence, and in managed mode the control it became.
          Solo mode keeps the sentence: a picker with one option is a
          question with no answer to give. */}
      {managed && placement !== null ? (
        <RunsOn job={job} placement={placement} machine={machine} onChange={onRunsOnChange} saving={savingRunsOn} />
      ) : (
        <p className="text-[12.5px] text-ink-subtle">Runs while EO is open on this machine.</p>
      )}
      {/* Beside the control that asked, not under Save: nothing typed was rejected. */}
      {movedProblem === null ? null : <ErrorLine>{movedProblem}</ErrorLine>}
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

/** The notice a job's creation came back with, handed over in the navigation's state (EO-736). */
function noticeFrom(state: unknown): string | null {
  const notice = state !== null && typeof state === "object" ? (state as { notice?: unknown }).notice : undefined;
  return typeof notice === "string" ? notice : null;
}
