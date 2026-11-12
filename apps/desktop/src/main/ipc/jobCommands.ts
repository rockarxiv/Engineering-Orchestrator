import {
  placementAllows,
  placementRefusal,
  type IpcPayload,
  type IpcResponse,
  type Job,
  type JobMachine,
  type Uuid,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getJob, listDevices, listJobs } from "../db/repos/index.js";
import { placementForJob, runsOnOf, type PlacementFacts } from "../jobs/placement.js";
import { sessionStatus, type SessionStoreOptions } from "../managed/session.js";
import { jobCostCents, pauseJob, resumeJob } from "../jobs/budget.js";
import { fireJob, jobEntryVerdicts, type FireOptions } from "../jobs/fire.js";
import { moduleRulesNotice, createJob, deleteJob, updateJob } from "../jobs/jobs.js";
import { resumeWatch } from "../jobs/watch.js";
import { jobSummary, occurrenceRows } from "../jobs/summary.js";
import { activeProjectId } from "./repositoryCommands.js";
import type { EngineHandle } from "./domainCommands.js";
import { emitPush } from "./push.js";

/**
 * The `jobs:*` commands (EO-304, EO-307, EO-308,
 * `ARCHITECTURE.md`, "Controls",
 * "The inbox, the archive and jobs").
 *
 * Edits and questions, and nothing the app drives itself: a job is
 * configuration a person keeps. EO-304 and EO-307 landed these before
 * the screen that calls them; EO-308 is that screen, and the two it
 * added — read one, change one — are the ones a full editor needs.
 */

/**
 * Which project a request means.
 *
 * Omitted is the window's active project, said is that project —
 * including `null`, which is a real scope rather than "all of them"
 * (`listJobs` says why).
 */
function scopeOf(db: Db, projectId: string | null | undefined): Uuid | null {
  return (projectId === undefined ? activeProjectId(db) : projectId) as Uuid | null;
}

/**
 * Whether this is a job the Jobs screen keeps (EO-308, ARCHITECTURE.md, "The inbox, the archive and
 * jobs").
 *
 * A `from-discussion` job is not. It is provenance rather than
 * configuration: nobody set it up — pressing Create in a conversation
 * made it — it has no trigger to edit, no pipeline and no template
 * (ARCHITECTURE.md, "Trigger kinds"), `updateJob` refuses it and `runJobNowCommand` refuses it.
 * What
 * it is *for* is the "From: conversation …" line on the item, which
 * reads it directly.
 *
 * Listing one anyway would fill the Jobs screen with rows nobody can
 * edit for every developer who has ever pressed Create in a
 * conversation, which is most of them. The rule lives here so the list
 * and the page read the same one. The rail's Jobs row does not read it:
 * it is always there (EO-757).
 */
function keptByAPerson(job: Job): boolean {
  return job.trigger.kind !== "from-discussion";
}

/**
 * What the `jobs:*` commands need that is a fact about this machine
 * (EO-330, ARCHITECTURE.md, "Where a job runs").
 *
 * Two seams, both lazy. `facts` spawns a CLI to find out how this
 * desktop is signed in, so it is a function rather than a value: the
 * list, the history and the cost want none of it, and a context built
 * eagerly would put a probe in front of opening the Jobs page. `session`
 * is what this machine signed in as, for the name the design asks a device
 * job to say out loud.
 */
export interface JobsContext {
  facts: () => Promise<PlacementFacts>;
  session?: SessionStoreOptions;
}

/** The job as placement reads one — the pipeline, its trigger, and where it is being asked to run. */
type PlacedJob = Pick<Job, "name" | "projectId" | "pipelineId" | "runsOn"> & { trigger?: Job["trigger"] };

/**
 * Why this job may not be placed there, or null.
 *
 * **Refused in the command and not only greyed on the screen**, which
 * is the design's rule for a lock applied to a placement: the system agent's
 * admin MCP server reaches these same handlers, so a control that was
 * merely hidden in the renderer would let a job be placed from a chat
 * where it cannot run. A person meets it as the sentence under the save;
 * an agent meets it as `problem`, which is the typed refusal both ends
 * receive.
 *
 * A job asking for the place it is already in is never refused —
 * including a job that is stranded, with reasons in both directions.
 * Something already running somewhere is not made to stop because a
 * secret was published this morning; what a save may not do is *move*
 * work to a machine that cannot do it.
 */
async function refusePlacement(db: Db, context: JobsContext, job: PlacedJob): Promise<string | null> {
  const where = job.runsOn;
  const placement = placementForJob(db, blankJob(job), await context.facts());
  if (placementAllows(placement, where)) return null;
  return placementRefusal(placement, where);
}

/**
 * Enough of a job for `placementForJob` to walk, from a job that may
 * not exist yet.
 *
 * `jobs:create` is judged before anything is written — `createJob`'s own
 * rule, that the moment to say a job cannot work is the moment somebody
 * sets it up — so there is no row to read. Everything filled in here is
 * something placement does not look at.
 */
function blankJob(job: PlacedJob): Job {
  return {
    id: "",
    projectId: job.projectId,
    name: job.name,
    // A watch trigger binds the job to this machine (EO-753); any other
    // kind says nothing placement reads.
    trigger: job.trigger ?? { kind: "manual" },
    pipelineId: job.pipelineId,
    template: null,
    ownerId: "",
    pausedAt: null,
    pausedReason: null,
    budgetPerOccurrenceCents: null,
    maxItemsPerHour: null,
    runsOn: job.runsOn,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Where this job may run, and why the other place is greyed (EO-330,
 * ARCHITECTURE.md, "Where a job runs").
 *
 * A job the Jobs screen does not keep answers nulls rather than a
 * placement — a conversation's job has no pipeline to walk and no
 * control to draw — and so does a deleted one, for `jobs:get`'s reason.
 *
 * `machine` is the second half of the design's sentence and it is deliberately
 * only ever *this* machine. A desktop's replica holds no `devices` rows
 * — they are the record's — so the honest answer to "which machine does
 * this run on" from here is the one this process can stand behind: the
 * device this installation signed in as. A solo desktop has none, which
 * is exactly where the control is hidden and the page says what it has
 * always said. A server-placed job has none either, and that is not a
 * gap: it runs on nobody's laptop.
 */
export async function jobPlacementCommand(
  db: Db,
  context: JobsContext,
  input: IpcPayload<"jobs:placement">,
): Promise<IpcResponse<"jobs:placement">> {
  const job = getJob(db, input.jobId as Uuid);
  if (!job || job.deletedAt !== null || !keptByAPerson(job)) return { placement: null, machine: null };
  return {
    placement: placementForJob(db, job, await context.facts()),
    machine: job.runsOn === "server" ? null : thisMachine(db, context),
  };
}

/**
 * The device this installation signed in as, and when the record last
 * heard from it.
 *
 * Null in solo mode, which is the whole of how the Job page knows to
 * hide the control and keep its old sentence: there is no organisation,
 * so there is no second place and no machine to name.
 *
 * `lastSeenAt` comes from the `devices` row where this process is the
 * record — an admin looking at the server sees "last online 3h ago"
 * about somebody's laptop — and is null on a desktop, which has no such
 * rows to read. Null is `jobMachineLine`'s "never online" only when
 * nothing has ever been seen; a desktop asking about itself is online
 * by the fact of asking, so it answers with now.
 */
function thisMachine(db: Db, context: JobsContext): JobMachine | null {
  if (context.session === undefined) return null;
  const status = sessionStatus(context.session);
  if (status.state !== "signed-in") return null;
  const row = listDevices(db).find((device) => device.id === status.deviceId);
  return { name: status.deviceName, lastSeenAt: row?.lastSeenAt ?? Date.now() };
}

export function listJobsCommand(db: Db, input: IpcPayload<"jobs:list">): IpcResponse<"jobs:list"> {
  // One `now` for the whole list, so two jobs due at the same minute are
  // described against the same clock rather than against whichever
  // moment their turn in the loop came round — `runJobTick`'s rule, for
  // its reason.
  const now = Date.now();
  return {
    jobs: listJobs(db, scopeOf(db, input.projectId))
      .filter(keptByAPerson)
      .map((job) => jobSummary(db, job, now)),
  };
}

/**
 * One job and its history, for the Job page (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * A deleted job answers null rather than its tombstone. The row stays
 * so that the items it filed can still name it (`deleteJob`); it is not
 * a page to open, and a page that opened would offer Run now and a
 * paused toggle for something that no longer fires. A conversation's
 * job answers null for `keptByAPerson`'s reason, which is the same
 * shape of answer: there is nothing on this page it could edit.
 */
export function getJobCommand(db: Db, input: IpcPayload<"jobs:get">): IpcResponse<"jobs:get"> {
  const job = getJob(db, input.jobId as Uuid);
  if (!job || job.deletedAt !== null || !keptByAPerson(job)) return { job: null, occurrences: [] };
  return { job: jobSummary(db, job), occurrences: occurrenceRows(db, job.id as Uuid) };
}

/**
 * The Job page's save (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * Answers with the job as it now stands, for `jobs:pause`'s reason: the
 * next-run time the page shows is computed from the trigger, and a
 * caller that had to re-list to find out what its own edit did would
 * draw the old one for a moment.
 */
export async function updateJobCommand(
  db: Db,
  context: JobsContext,
  input: IpcPayload<"jobs:update">,
): Promise<IpcResponse<"jobs:update">> {
  // Judged against the job as it *would be*, for `updateJob`'s own
  // reason: a save that moves the job to the server and repoints its
  // pipeline in one gesture has to be decided about the pair. The
  // stored row is the fallback for everything the patch leaves alone.
  //
  // And judged only where the save is a *move*. A patch that re-sends
  // the place the job is already in is not asking for anything, and
  // refusing it would stop a job that is running perfectly well
  // somewhere because a secret was published this morning — which is
  // the difference between a guard on a choice and a guard on a row.
  const standing = getJob(db, input.jobId as Uuid);
  if (input.runsOn !== undefined && standing !== undefined && input.runsOn !== runsOnOf(standing)) {
    const refusal = await refusePlacement(db, context, {
      name: input.name ?? standing.name,
      projectId: standing.projectId,
      pipelineId: input.pipelineId === undefined ? standing.pipelineId : input.pipelineId,
      trigger: input.trigger ?? standing.trigger,
      runsOn: input.runsOn,
    });
    if (refusal !== null) return { job: null, problem: refusal };
  }
  const result = updateJob(db, {
    jobId: input.jobId as Uuid,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    ...(input.pipelineId === undefined ? {} : { pipelineId: input.pipelineId }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: input.budgetPerOccurrenceCents }),
    ...(input.maxItemsPerHour === undefined ? {} : { maxItemsPerHour: input.maxItemsPerHour }),
    ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
  });
  if (!result.ok) return { job: null, problem: result.problem };
  return { job: jobSummary(db, result.job), problem: null, notice: moduleRulesNotice(db, result.job) };
}

export async function createJobCommand(
  db: Db,
  context: JobsContext,
  input: IpcPayload<"jobs:create">,
): Promise<IpcResponse<"jobs:create">> {
  const projectId = scopeOf(db, input.projectId);
  if (input.runsOn !== undefined) {
    const refusal = await refusePlacement(db, context, {
      name: input.name,
      projectId,
      pipelineId: input.pipelineId ?? null,
      trigger: input.trigger,
      runsOn: input.runsOn,
    });
    if (refusal !== null) return { job: null, problem: refusal };
  }
  const result = createJob(db, {
    projectId,
    name: input.name,
    trigger: input.trigger,
    ...(input.pipelineId === undefined ? {} : { pipelineId: input.pipelineId }),
    ...(input.template === undefined ? {} : { template: input.template }),
    ...(input.budgetPerOccurrenceCents === undefined ? {} : { budgetPerOccurrenceCents: input.budgetPerOccurrenceCents }),
    ...(input.maxItemsPerHour === undefined ? {} : { maxItemsPerHour: input.maxItemsPerHour }),
    ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
  });
  if (!result.ok) return { job: null, problem: result.problem };
  // A summary, like every other `jobs:*` answer about one job (EO-308):
  // the caller opens the Job page on it, and the next run is the first
  // thing that page states.
  return { job: jobSummary(db, result.job), problem: null, notice: moduleRulesNotice(db, result.job) };
}

/**
 * The `manual` trigger, and a schedule run ahead of its time (ARCHITECTURE.md, "What a job
 * records").
 *
 * A `schedule` job is fired here too, since EO-306 gave it a template to
 * fire from: "run this morning's report now, I do not want to wait for
 * Monday" is the same act as pressing Run now, and refusing it would
 * leave the one button on the Job page greyed for the jobs people press
 * it on most. The occurrence it writes is for *now* rather than for a
 * scheduled minute, which is what stops it from being mistaken later for
 * the occurrence the calendar was due.
 *
 * A `from-discussion` job is refused rather than fired: its items come
 * from somebody pressing Create in the conversation, and firing one
 * here would mean stamping out an item from a template it deliberately
 * does not have. The refusal is answered to the caller rather than
 * posted on the thread — a person who pressed a button is owed the
 * reason where they pressed it, and invariant #8 is about work dropped
 * where nobody is looking.
 */
export function runJobNowCommand(
  db: Db,
  engine: EngineHandle | undefined,
  input: IpcPayload<"jobs:runNow">,
  /** The firing's moment and its module entry verdicts, where `runJobNowChecked` worked them out (EO-736). */
  fire: FireOptions = {},
): IpcResponse<"jobs:runNow"> {
  const job = getJob(db, input.jobId as Uuid);
  // A tombstone is not a job to run. `getJob` still answers for one so
  // that the items it filed can name it (`deleteJob`); every door a
  // person can press is closed to it.
  if (!job || job.deletedAt !== null) return { fired: false, occurrence: null, itemId: null, problem: "That job no longer exists." };
  if (job.trigger.kind === "from-discussion") {
    return {
      fired: false,
      occurrence: null,
      itemId: null,
      problem: "This job files work when somebody presses Create in its conversation, so there is nothing to run now.",
    };
  }
  // A watch job files what its module finds (EO-753); its template alone
  // is not a finding, and firing it would file an item nothing found.
  if (job.trigger.kind === "watch") {
    return {
      fired: false,
      occurrence: null,
      itemId: null,
      problem: "This job files what its module finds, so there is nothing to run now. Pausing and resuming it checks it at once.",
    };
  }

  const result = fireJob(db, job, fire);
  if (result.item !== null) {
    emitPush("items:changed", { itemId: result.item.id });
    // New work on a step: the scheduler should look now rather than on
    // its next tick, the same as any other way an item arrives.
    engine?.notifyStateChange();
  }
  // A refusal wrote a `failed` occurrence, and its message pushes `messages:changed` itself.
  return {
    fired: result.item !== null,
    occurrence: result.occurrence,
    itemId: result.item?.id ?? null,
    problem: result.problem,
  };
}

/**
 * Stopping a job, and starting it again (EO-307).
 *
 * Nothing is posted on the thread for either. A guard that pauses a job
 * on the person's behalf says so there, because they were not watching;
 * a person pressing the button is watching, and telling them what they
 * just did is noise rather than invariant #8.
 *
 * Resuming does not catch anything up. Every occurrence that came round
 * while the job was paused was decided about and written down, so the
 * next sweep starts after the newest of them and files the *next* one —
 * which is what a person resuming a job on Friday means.
 */
export function pauseJobCommand(db: Db, input: IpcPayload<"jobs:pause">): IpcResponse<"jobs:pause"> {
  // A person pressed it, which is the whole of what the chip will say
  // (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs") — and the one thing nothing
  // downstream could work
  // out, since a job paused by hand after an expensive occurrence has
  // the same spend as one a budget stopped.
  const job = pauseJob(db, input.jobId as Uuid, Date.now(), "by hand");
  return { job: job === undefined ? null : jobSummary(db, job) };
}

export function resumeJobCommand(db: Db, input: IpcPayload<"jobs:resume">): IpcResponse<"jobs:resume"> {
  const job = resumeJob(db, input.jobId as Uuid);
  // A watch job is checked again at once, its failure count started
  // again (EO-753).
  if (job !== undefined) resumeWatch(db, job);
  return { job: job === undefined ? null : jobSummary(db, job) };
}

/** What the job has cost: the runs of every item its occurrences filed (ARCHITECTURE.md, "Jobs"). */
export function jobCostCommand(db: Db, input: IpcPayload<"jobs:cost">): IpcResponse<"jobs:cost"> {
  return { jobId: input.jobId, costCents: jobCostCents(db, input.jobId as Uuid) };
}

/**
 * Is done with the job, and with its work if that is what was chosen
 * (ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * The push is emitted whichever way the choice went: a from-discussion
 * job's conversation is archived either way, and archiving the items
 * moves work off every board that was showing it.
 */
export function deleteJobCommand(db: Db, input: IpcPayload<"jobs:delete">): IpcResponse<"jobs:delete"> {
  const result = deleteJob(db, input.jobId as Uuid, { archiveItems: input.archiveItems });
  if (result.deleted) emitPush("items:changed", {});
  return result;
}

/**
 * `jobs:runNow` as the channel answers it: the pipeline's module entry
 * rules are run on the item first (EO-736), since the firing itself
 * cannot wait on a module.
 */
export async function runJobNowChecked(db: Db, engine: EngineHandle | undefined, input: IpcPayload<"jobs:runNow">): Promise<IpcResponse<"jobs:runNow">> {
  const job = getJob(db, input.jobId as Uuid);
  if (!job || job.deletedAt !== null || job.trigger.kind === "from-discussion" || job.trigger.kind === "watch") return runJobNowCommand(db, engine, input);
  const dueAt = Date.now();
  return runJobNowCommand(db, engine, input, { dueAt, entryVerdicts: await jobEntryVerdicts(db, job, { dueAt }) });
}
