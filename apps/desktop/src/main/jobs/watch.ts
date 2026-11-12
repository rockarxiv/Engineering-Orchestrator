import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAITING_RESULT, moduleInputProblems, type CustomModule, type Item, type Job, type JobRunsOn, type Uuid, type WatchFinding, type WatchTrigger } from "@eo/core";
import { WATCH_FAILURE_LIMIT, watchFailuresExhausted, watchRetryDelayMs } from "@eo/engine";
import type { Db } from "../db/client.js";
import {
  createdEventFor,
  getItem,
  getJob,
  getJobWatchState,
  getProject,
  itemIdsCreatedByEvents,
  latestRefusalFor,
  listAllJobs,
  recordJobEvent,
  saveJobWatchState,
  stepForItem,
  type JobWatchStateRow,
} from "../db/repos/index.js";
import { getModule } from "../db/repos/modulesRepo.js";
import { projectMovedToTheRecord } from "../db/repos/projectsRepo.js";
import { isProjectReplica } from "../db/recordRole.js";
import { intakeRunContext } from "../ipc/domainQueries.js";
import { readOrganisationSecretEntry, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";
import { runModule, type ModuleHostLauncher, type ModuleOutcome } from "../modules/runModule.js";
import { environmentFor, type ModuleSecretsOptions } from "../modules/secrets.js";
import { startInterval } from "../schedule/interval.js";
import { pauseJob } from "./budget.js";
import { fireJob, jobEntryVerdicts, type FireOptions } from "./fire.js";
import { JOB_MESSAGE_SOURCE, messageJobOwner } from "./ownerMessage.js";

/**
 * A watch job: a watch module as a pipeline's intake (EO-753,
 * ARCHITECTURE.md §9.1).
 *
 * While EO is open, each unpaused watch job's module is run as an intake
 * check (EO-752) every `everyMinutes`, counted from the end of its last
 * check. A check answers `waiting` with what it found, and each finding
 * whose key has not yet created an item for the job is filed through the
 * job's own door — `fireJob`, entry rules and all — with the finding's
 * title, body and spec in place of the template's. A key already filed
 * writes nothing, so a watch that sees the same open pull request every
 * hour does not grow `job_events` every hour.
 *
 * A check that cannot run is retried on the backoff watch steps use, and
 * the sixth failure in a row pauses the job and messages its owner. A
 * check answering one of the module's declared results is the module
 * telling a person something is wrong, so the job pauses at once. Either
 * way there is no item to comment on, so the owner is messaged
 * (invariant 8).
 *
 * Checks run one at a time, outside the dispatcher, so they take no item
 * dispatch slot. There is no give-up time.
 */

const MINUTE_MS = 60_000;

/** What `lastAnswer` says of a check that failed. */
export const WATCH_FAILED_ANSWER = "failed";

/**
 * Why this watch trigger cannot be saved, or null (EO-753): its module,
 * its inputs, and where it would run. Asked by `createJob` and
 * `updateJob` alongside everything else a job must be able to do.
 */
export function watchTriggerProblem(db: Db, trigger: WatchTrigger, place: { projectId: Uuid | null; runsOn: JobRunsOn }): string | null {
  const module = getModule(db, trigger.moduleId);
  const unfit = unfitWatchModule(module, trigger.moduleId);
  if (unfit !== null) return unfit;
  const manifest = module!.manifest;
  const undeclared = Object.keys(trigger.inputs).filter((name) => !(name in manifest.inputs));
  if (undeclared.length > 0) {
    return `"${module!.name}" declares no input ${undeclared.map((name) => `"${name}"`).join(", ")}, so a watch job cannot set ${undeclared.length === 1 ? "it" : "them"}.`;
  }
  const wrong = moduleInputProblems(manifest, trigger.inputs).map((problem) => problem.replace("this step sets", "this job sets"));
  if (wrong.length > 0) return `"${module!.name}" cannot be run with these inputs: ${wrong.join(" ")}`;
  if (place.runsOn === "server") {
    return "A watch intake runs its module on this machine, so a watch job cannot run on the organisation server.";
  }
  if (place.projectId !== null && (projectMovedToTheRecord(db, place.projectId) || isProjectReplica(db, place.projectId))) {
    return "This project is held by your organisation's record, and a watch job runs on this machine only: the record would have to file what it finds.";
  }
  return null;
}

/** Why this module cannot be a job's intake, or null. Asked when the job is saved and again before every check. */
function unfitWatchModule(module: CustomModule | undefined, moduleId: string): string | null {
  if (module === undefined) return `No module "${moduleId}" is installed here, so there is nothing to watch with.`;
  if (module.archivedAt !== null) return `"${module.name}" has been archived, so it cannot run as a watch job's intake.`;
  if (module.approvedAt === null) return `"${module.name}" has not been approved. Approve it under Settings → Modules before a watch job runs it.`;
  if (module.manifest.watch !== true) return `"${module.name}" does not declare watch: true, so it cannot run as a pipeline's intake.`;
  return null;
}

/**
 * Runs one intake check of this job's module and answers what it said.
 * A seam, so the whole of the watch is testable with a scripted module
 * host; `createWatchCheck` is the real one.
 */
export type WatchCheck = (job: Job, module: CustomModule, trigger: WatchTrigger) => Promise<ModuleOutcome>;

export interface WatchCheckOptions {
  launcher: ModuleHostLauncher;
  secrets: ModuleSecretsOptions;
  organisationSecrets?: OrganisationSecretsOptions;
}

/**
 * The real intake check: the module run with no item, in a temporary
 * directory removed afterwards, with the shared values of the module's
 * variables and secrets — a job has no step for an override to be on —
 * under the module time limit.
 */
export function createWatchCheck(db: Db, options: WatchCheckOptions): WatchCheck {
  return async (job, module, trigger) => {
    const organisation = options.organisationSecrets;
    const { env, unreadable, dangling, variables } = environmentFor(
      options.secrets,
      module.manifest.needs.env,
      null,
      organisation === undefined ? undefined : (name: string) => readOrganisationSecretEntry(organisation, name),
    );
    if (unreadable.length > 0) {
      return { ok: false, reason: `"${module.name}" cannot read ${unreadable.join(", ")}: stored by another machine or before this one's keychain was reset. Set ${unreadable.length === 1 ? "it" : "them"} again under Settings → Modules.` };
    }
    if (dangling.length > 0) {
      return { ok: false, reason: `"${module.name}" was not run: ${dangling.map(({ name, variable }) => `${name} is read from ${variable}, which is missing or empty where EO was launched`).join("; ")}.` };
    }
    const missing = module.manifest.needs.env.filter((name) => !(name in env));
    if (missing.length > 0) {
      return { ok: false, reason: `"${module.name}" needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set. Add ${missing.length === 1 ? "it" : "them"} under Settings → Modules.` };
    }
    const cwd = mkdtempSync(join(tmpdir(), "eo-watch-"));
    try {
      const context = intakeRunContext(db, { job, intervalMs: trigger.everyMinutes * MINUTE_MS, now: Date.now() });
      return await runModule(options.launcher, {
        module,
        item: null,
        intake: { job: { id: job.id, name: job.name } },
        cwd,
        inputs: trigger.inputs,
        env,
        variables,
        context,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

/**
 * What this process runs intake checks with, set once where the engine
 * is put together — `configureEntryChecks`' arrangement, for its reason:
 * the module host is built there. Null refuses every check, saying why,
 * which counts as a failed check.
 */
let configured: WatchCheckOptions | null = null;

export function configureWatchChecks(options: WatchCheckOptions | null): void {
  configured = options;
}

/** The real check, run with whatever `configureWatchChecks` was last given. */
export function configuredWatchCheck(db: Db): WatchCheck {
  return async (job, module, trigger) =>
    configured === null ? { ok: false, reason: `"${module.name}" cannot run: EO here has no module host to run it on.` } : createWatchCheck(db, configured)(job, module, trigger);
}

export interface WatchIntakeDeps {
  check: WatchCheck;
  /** The clock. Injected so a test drives it rather than waiting for it. */
  now?: () => number;
  /** Told each item a finding filed, so open windows and the scheduler hear of it. */
  onFiled?: (itemId: Uuid) => void;
  /** The entry rules a finding is judged by before it is filed. `jobEntryVerdicts` unless a test holds them open. */
  entryVerdicts?: typeof jobEntryVerdicts;
}

/** What one sweep did, for a test to assert on. */
export interface WatchTickResult {
  /** The jobs whose module was run. */
  checked: string[];
  /** The jobs held by an unfinished item they filed. */
  held: string[];
  /** The items filed. */
  filed: string[];
}

/**
 * The watch jobs this machine checks: live, unpaused, and on a project
 * this installation is the writer for — a project half way through a
 * move, or held by the record, is passed over as the job scheduler
 * passes over it.
 */
function watchJobs(db: Db): Job[] {
  return listAllJobs(db).filter((job) => isCheckable(db, job));
}

function isCheckable(db: Db, job: Job): boolean {
  return (
    job.deletedAt === null &&
    job.trigger.kind === "watch" &&
    job.pausedAt === null &&
    !isProjectReplica(db, job.projectId as Uuid | null) &&
    !(job.projectId !== null && getProject(db, job.projectId as Uuid)?.adoptingAt != null)
  );
}

/**
 * The job as it stands now, if it may still be checked and file — read
 * again after every await, because a person may pause, delete or move it
 * while a module runs, and a job object read before that wait would
 * still say it was live.
 */
function liveWatchJob(db: Db, id: Uuid): Job | null {
  const job = getJob(db, id);
  return job !== undefined && isCheckable(db, job) ? job : null;
}

/**
 * One sweep: every watch job that is due is checked, one at a time.
 *
 * Due is `nextCheckAt` at or before now, and a job never checked is due
 * at once. A job overdue at launch is checked once: its next check is
 * counted from the end of this one, not from the interval it missed.
 */
export async function runWatchTick(db: Db, deps: WatchIntakeDeps): Promise<WatchTickResult> {
  const now = deps.now ?? Date.now;
  const result: WatchTickResult = { checked: [], held: [], filed: [] };
  // Ids rather than jobs: each is read again before it is checked, since
  // the checks before it may have taken minutes.
  for (const id of watchJobs(db).map((job) => job.id as Uuid)) {
    const job = liveWatchJob(db, id);
    if (job === null) continue;
    const trigger = job.trigger as WatchTrigger;
    const state = getJobWatchState(db, job.id as Uuid);
    if ((state?.nextCheckAt ?? 0) > now()) continue;
    try {
      if (trigger.waitWhileOpen) {
        const open = openItemFiledBy(db, job);
        if (open !== null) {
          if (state?.waitingForItemId !== open.id) saveJobWatchState(db, job.id as Uuid, { waitingForItemId: open.id });
          result.held.push(job.id);
          continue;
        }
      }
      if (state?.waitingForItemId != null) saveJobWatchState(db, job.id as Uuid, { waitingForItemId: null });
      result.checked.push(job.id);
      result.filed.push(...(await checkWatchJob(db, job, deps)));
    } catch (error) {
      console.error(`[eo] the watch job "${job.name}" could not be checked:`, error);
    }
  }
  return result;
}

/**
 * The newest item this job filed that is unfinished — not on its
 * pipeline's terminal step and not archived — or null. Judged by the
 * item's own version, as `catchUp`'s "previous still open" is.
 */
function openItemFiledBy(db: Db, job: Job): Item | null {
  for (const itemId of itemIdsCreatedByEvents(db, job.id as Uuid).reverse()) {
    const item = getItem(db, itemId as Uuid);
    if (!item || item.archivedAt !== null) continue;
    if (item.stepId === null || stepForItem(db, item)?.isTerminal !== true) return item;
  }
  return null;
}

/**
 * Runs the job's check now and acts on its answer, whatever its next
 * check time says. Answers the ids of the items it filed.
 */
export async function checkWatchJob(db: Db, job: Job, deps: WatchIntakeDeps): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const trigger = job.trigger as WatchTrigger;
  const module = getModule(db, trigger.moduleId);
  const unfit = unfitWatchModule(module, trigger.moduleId);
  let outcome: ModuleOutcome;
  try {
    outcome = unfit !== null ? { ok: false, reason: unfit } : await deps.check(job, module!, trigger);
  } catch (error) {
    outcome = { ok: false, reason: `The check crashed: ${error instanceof Error ? error.message : String(error)}` };
  }

  // Read again: a person may have paused, deleted or moved it while the module ran.
  const id = job.id as Uuid;
  const stored = getJob(db, id);
  if (stored === undefined || stored.deletedAt !== null) return [];
  const before = getJobWatchState(db, id);
  const current = liveWatchJob(db, id);
  if (current === null) {
    saveJobWatchState(db, id, { lastCheckedAt: now() });
    return [];
  }

  if (!outcome.ok) {
    failed(db, current, before, outcome.reason, now());
    return [];
  }

  if (outcome.result === WAITING_RESULT) {
    const filed: string[] = [];
    for (const finding of outcome.findings ?? []) {
      const answer = await fileFinding(db, id, finding, now(), deps.entryVerdicts ?? jobEntryVerdicts);
      if (answer === STOPPED) {
        // Paused, deleted or moved while an entry rule ran: what is left
        // of this check is not filed, and the job's state says only that
        // it looked.
        if (getJob(db, id) !== undefined) saveJobWatchState(db, id, { lastCheckedAt: now() });
        return filed;
      }
      if (answer !== null) {
        filed.push(answer);
        deps.onFiled?.(answer as Uuid);
      }
    }
    const ended = now();
    saveJobWatchState(db, id, {
      lastCheckedAt: ended,
      lastAnswer: WAITING_RESULT,
      consecutiveFailures: 0,
      lastError: null,
      nextCheckAt: ended + trigger.everyMinutes * MINUTE_MS,
    });
    return filed;
  }

  const ended = now();
  if (module!.manifest.results.includes(outcome.result)) {
    // The module is telling a person something is wrong: stop at once.
    saveJobWatchState(db, id, { lastCheckedAt: ended, lastAnswer: outcome.result, consecutiveFailures: 0, lastError: null, nextCheckAt: null });
    pauseJob(db, id, ended, "watch");
    const detail = outcome.detail.trim();
    messageJobOwner(
      db,
      current,
      `"${current.name}" is paused: its module "${module!.name}" answered "${outcome.result}"${detail === "" ? "." : `: ${detail}`} Resume the job once that is dealt with, and it checks again at once.`,
      { source: JOB_MESSAGE_SOURCE.watch },
    );
    return [];
  }

  failed(db, current, before, `"${module!.name}" answered "${outcome.result}", which is neither ${WAITING_RESULT} nor one of the results it declares.`, ended);
  return [];
}

/**
 * A check that failed: retried after 1, 2, 5, 10 and 30 minutes, and the
 * sixth in a row pauses the job and messages its owner.
 */
function failed(db: Db, job: Job, before: JobWatchStateRow | undefined, reason: string, ended: number): void {
  const failures = (before?.consecutiveFailures ?? 0) + 1;
  saveJobWatchState(db, job.id as Uuid, {
    lastCheckedAt: ended,
    lastAnswer: WATCH_FAILED_ANSWER,
    consecutiveFailures: failures,
    lastError: reason,
    nextCheckAt: ended + watchRetryDelayMs(failures),
  });
  if (!watchFailuresExhausted(failures)) return;
  pauseJob(db, job.id as Uuid, ended, "watch");
  messageJobOwner(
    db,
    job,
    `"${job.name}" is paused: its check failed ${failures} times in a row, and after ${WATCH_FAILURE_LIMIT} EO stops retrying. ` +
      `The last error was: ${reason} Resume the job once it should try again.`,
    { source: JOB_MESSAGE_SOURCE.watch },
  );
}

/** Carries "already said" out through the transaction that must take back the repeat's occurrence. */
class AlreadySaid extends Error {}

/** What `fileFinding` answers when the job stopped being live while its entry rules ran. */
const STOPPED = Symbol("stopped");

/**
 * Files one finding, or does not, and answers the item's id where it
 * filed one.
 *
 * A key that already has a `created` row writes nothing. Anything else
 * goes through `fireJob` with the finding in place of the template, and
 * writes a `created` or `refused` row. The owner is messaged the first
 * time a key is refused; the same key refused again for the same reason
 * writes nothing at all — its `failed` occurrence is taken back with the
 * rest of the transaction.
 */
async function fileFinding(db: Db, jobId: Uuid, finding: WatchFinding, at: number, entryVerdictsOf: typeof jobEntryVerdicts): Promise<string | null | typeof STOPPED> {
  const before = liveWatchJob(db, jobId);
  if (before === null) return STOPPED;
  if (createdEventFor(db, jobId, finding.key) !== undefined) return null;
  const options: FireOptions & { dueAt: number } = {
    dueAt: at,
    firedAt: at,
    quiet: true,
    overrides: {
      title: finding.title,
      ...(finding.body === undefined ? {} : { body: finding.body }),
      ...(finding.spec === undefined ? {} : { spec: finding.spec }),
      ...(finding.existingBranch === undefined ? {} : { existingBranch: finding.existingBranch }),
    },
  };
  const entryVerdicts = await entryVerdictsOf(db, before, options);
  let filed: { itemId: string } | { refused: string; job: Job } | typeof STOPPED;
  try {
    filed = db.transaction(() => {
      // Read again in the transaction that files: the entry rules may
      // have run for minutes, and `fireJob`'s own pause and deletion
      // guards only see the job they are handed.
      const job = liveWatchJob(db, jobId);
      if (job === null) return STOPPED;
      const fired = fireJob(db, job, { ...options, entryVerdicts });
      if (fired.item !== null) {
        recordJobEvent(db, { jobId, receivedAt: at, eventKey: finding.key, payload: "", outcome: "created", itemId: fired.item.id as Uuid });
        return { itemId: fired.item.id };
      }
      const reason = fired.problem ?? "EO could not file it.";
      if (latestRefusalFor(db, jobId, finding.key)?.reason === reason) throw new AlreadySaid();
      recordJobEvent(db, { jobId, receivedAt: at, eventKey: finding.key, payload: "", outcome: "refused", reason });
      return { refused: reason, job };
    });
  } catch (error) {
    if (error instanceof AlreadySaid) return null;
    // The partial unique index: another check filed this key first.
    if (createdEventFor(db, jobId, finding.key) !== undefined) return null;
    throw error;
  }
  if (filed === STOPPED) return STOPPED;
  if ("itemId" in filed) return filed.itemId;
  const { job } = filed;
  messageJobOwner(db, job, `"${job.name}" could not file "${finding.title}" (${finding.key}), which its module found. ${filed.refused}`, { source: JOB_MESSAGE_SOURCE.watch });
  return null;
}

/**
 * Resuming a watch job checks it at once and starts its failure count
 * again (EO-753). Nothing for any other kind.
 */
export function resumeWatch(db: Db, job: Job, at: number = Date.now()): void {
  if (job.trigger.kind !== "watch") return;
  saveJobWatchState(db, job.id as Uuid, { consecutiveFailures: 0, lastError: null, nextCheckAt: at });
  kickWatchIntake();
}

/** The running loop's kick, so a resume is checked now rather than at the next tick. Queued, not dropped, while a sweep runs. */
let kick: (() => void) | null = null;

/** Runs the sweep now, where the loop is running. */
export function kickWatchIntake(): void {
  kick?.();
}

export interface WatchIntakeOptions extends WatchIntakeDeps {
  intervalMs?: number;
}

/**
 * Sweeps every minute, and at launch, until stopped. The loop's
 * non-overlap flag is what keeps checks one at a time.
 *
 * The interval loop drops a kick while a tick is in flight, which here
 * would leave a job resumed during another job's ten-minute check
 * waiting for that check and then the next tick. So a kick is
 * remembered, and the sweep that is running sweeps again before it
 * lets go of the flag.
 */
export function startWatchIntake(db: Db, options: WatchIntakeOptions): () => void {
  let pending = false;
  const loop = startInterval({
    name: "watch intake",
    tick: async () => {
      do {
        pending = false;
        await runWatchTick(db, options);
      } while (pending);
    },
    readIntervalMs: () => options.intervalMs ?? MINUTE_MS,
  });
  const ownKick = (): void => {
    pending = true;
    loop.kick();
  };
  kick = ownKick;
  return () => {
    if (kick === ownKick) kick = null;
    loop.stop();
  };
}
