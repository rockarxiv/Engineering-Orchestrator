import { and, asc, eq } from "drizzle-orm";
import { USER_ATTENTION_TARGET, uuidv7, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { itemWatches, items, jobs, pipelines, pipelineVersions, stepRoutes } from "../db/schema.js";
import {
  adoptPipeline,
  archivePipeline,
  clearSetting,
  copyPipeline,
  createPipelineVersion,
  fileRetargetedVersion,
  getJiraBinding,
  getPipeline,
  getProject,
  getStep,
  listPipelines,
  listProjects,
  listRoutesForPipeline,
  ownStepIds,
  saveJiraBinding,
  setSetting,
  SHARED_UNTIL_SPLIT_SETTING,
  staysShared,
  versionTargets,
  type PipelineCopy,
  type Project,
} from "../db/repos/index.js";
import { resolveMessagesAbout, sendMessageHere } from "../messages/messages.js";
import { clearStepSecrets, copyStepSecrets, type ModuleSecretsOptions } from "../modules/secrets.js";
import { recordFor } from "../record/localRecord.js";
import { previewProjectId } from "./commands.js";

/**
 * The projects a shared pipeline is shared out among, oldest first: every
 * project but the gallery's Preview and the ones an organisation manages,
 * whose pipelines are what the organisation serves and are left exactly
 * as served.
 */
export function ownProjects(db: Db): Project[] {
  const preview = previewProjectId(db);
  return listProjects(db).filter((project) => project.id !== preview && project.managedAt === null);
}

export interface SharedPipelineSplit {
  pipelineId: string;
  /** The project that kept the original. */
  keptBy: Uuid;
  copies: { projectId: Uuid; pipelineId: string; movedItems: number }[];
}

/**
 * A hand-off that would cross from one project into another once the
 * split is made (EO-766 review), and what was done about it.
 *
 * `asksAPerson` is a copy's route, which now parks the work for a person
 * instead of carrying one project's work onto another's board. The
 * original's routes are left as they were — the oldest project keeps it
 * unchanged — and only reported.
 */
export interface HandOffElsewhere {
  /** The project whose pipeline holds the route. */
  projectId: Uuid;
  pipelineId: string;
  /** The step it named, which another project's pipeline holds. */
  targetStepId: string;
  asksAPerson: boolean;
}

export interface SplitOptions {
  /**
   * Where step-scoped module secrets live. Each copied step is given its
   * original's, before any work moves onto it; without these a copy's
   * step would fall back to the shared value its original replaced.
   */
  moduleSecrets?: ModuleSecretsOptions;
  /** Whether this is the organisation's record, for whom a message goes to. */
  isTheRecord?: boolean;
}

/** The message source a split's report of cross-project hand-offs is sent under. */
export const HAND_OFF_ELSEWHERE_SOURCE = "pipeline-split";

/**
 * Gives every project its own copy of each pipeline it shared (EO-766).
 *
 * Before EO-766 a pipeline with no project — the seeded Delivery above
 * all — was shown to every project, and each project's work could stand
 * on it. Now no pipeline is shared, so on upgrade each such pipeline is
 * split: the oldest of this machine's own projects keeps the original,
 * id, items, versions and history unchanged, and every other one gets a
 * copy of its own (`copyPipeline`), onto which its work on the original
 * moves, step for matching step and version for matching version.
 *
 * Every copy a project is given has its step ids minted before any is
 * made, so where one shared pipeline handed work to another the
 * project's copy hands it to the project's own copy of the other —
 * live and in every version alike.
 *
 * What travels with the work, for the project whose copy it is:
 *  - each copied step's module secrets, references and variables
 *    (`copyStepSecrets`), before anything moves onto the copy;
 *  - its items, moved through the record (invariant #1) — these are this
 *    machine's own projects, so the record is this database — each with
 *    its version binding and its assignee as they were — a re-homing is
 *    not an arrival, and nobody's claim is taken by it — and its watches
 *    on the step it stands on;
 *  - its jobs that file onto the original;
 *  - hand-offs its own pipelines route into the original, and its work
 *    bound to an older version of one of those: the version is history
 *    and is left as it was, and the work is bound instead to the same
 *    graph filed again with the hand-off pointed at the copy
 *    (`retargetOwnPipelines`);
 *  - the Jira status each step was mapped to.
 *
 * A route of a copy into another project's pipeline cannot follow its
 * work anywhere of the project's own, so it asks for a person instead,
 * and the original's such routes are left as they were; either way the
 * person is sent a message naming them.
 *
 * Nothing to do where no own project exists yet: first run gives the
 * seeded Delivery a home then (`settleSeededPipelines`). Idempotent:
 * once split, nothing is shared, and every later launch finds nothing.
 * All of it in one transaction; should that fail, every secret copied
 * for it is removed again, and nothing is split until the next launch.
 */
export function splitSharedPipelines(db: Db, options: SplitOptions = {}): SharedPipelineSplit[] {
  const owners = ownProjects(db);
  const keeper = owners[0];
  if (keeper === undefined) return [];
  const shared = listPipelines(db).filter((pipeline) => pipeline.projectId === null && !staysShared(db, pipeline));
  if (shared.length === 0) return [];

  const copiedScopes: string[] = [];
  const elsewhere: HandOffElsewhere[] = [];
  let splits: SharedPipelineSplit[];
  try {
    splits = db.transaction(() => {
      const results: SharedPipelineSplit[] = shared.map((pipeline) => ({ pipelineId: pipeline.id, keptBy: keeper.id, copies: [] }));
      for (const project of owners.slice(1)) {
        // What the project had before it was given any copy.
        const own = db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.projectId, project.id)).all().map((row) => row.id);
        const stepIds = new Map<string, string>();
        for (const pipeline of shared) for (const id of ownStepIds(db, pipeline.id)) stepIds.set(id, uuidv7());

        shared.forEach((pipeline, index) => {
          const parked = new Set<string>();
          const copy = copyPipeline(db, pipeline.id, project.id, {
            stepIds,
            retarget: (target) => {
              if (projectOfStep(db, target) === null || projectOfStep(db, target) === project.id) return target;
              parked.add(target);
              return USER_ATTENTION_TARGET;
            },
          });
          for (const targetStepId of parked) elsewhere.push({ projectId: project.id, pipelineId: copy.pipelineId, targetStepId, asksAPerson: true });
          if (options.moduleSecrets !== undefined) {
            for (const [from, to] of copy.stepIds) {
              copiedScopes.push(to);
              copyStepSecrets(options.moduleSecrets, from, to);
            }
          }
          results[index]?.copies.push({ projectId: project.id, pipelineId: copy.pipelineId, movedItems: rehomeProjectWork(db, pipeline.id, project.id, copy) });
        });

        retargetOwnPipelines(db, project.id, own, stepIds);
        const binding = getJiraBinding(db, project.id);
        const statusMap = binding?.config.statusMap ?? null;
        if (statusMap !== null) {
          saveJiraBinding(db, project.id, { statusMap: Object.fromEntries(Object.entries(statusMap).map(([stepId, status]) => [stepIds.get(stepId) ?? stepId, status])) });
        }
      }
      for (const pipeline of shared) {
        adoptPipeline(db, pipeline.id, keeper.id);
        const targets = new Set(listRoutesForPipeline(db, pipeline.id).map((route) => route.target));
        for (const targetStepId of targets) {
          const owner = projectOfStep(db, targetStepId);
          if (owner !== null && owner !== keeper.id) elsewhere.push({ projectId: keeper.id, pipelineId: pipeline.id, targetStepId, asksAPerson: false });
        }
      }
      return results;
    });
  } catch (error) {
    // Each scope on its own, so one that will not go does not keep the
    // rest, or the error that undid the split, from the caller.
    if (options.moduleSecrets !== undefined) {
      for (const stepId of copiedScopes) {
        try {
          clearStepSecrets(options.moduleSecrets, stepId);
        } catch (cleanup) {
          console.error(`[eo] could not remove the module secrets copied for step ${stepId} by a split that was undone`, cleanup);
        }
      }
    }
    throw error;
  }

  for (const report of elsewhere) {
    sendMessageHere(db, { projectId: report.projectId, source: HAND_OFF_ELSEWHERE_SOURCE, subject: `${report.pipelineId}:${report.targetStepId}`, body: handOffElsewhereLine(db, report) }, options.isTheRecord ?? false);
  }
  return splits;
}

/** The message source a failed split is reported under, and the subject that resolves it. */
export const SPLIT_FAILED_SOURCE = "pipeline-split-failed";
const SPLIT_FAILED_SUBJECT = "split";

/**
 * `splitSharedPipelines` as EO's launch runs it (EO-766 review): a split
 * that fails is undone whole, and the pipelines it was splitting stay
 * shared — every project is shown them as before the upgrade
 * (`SHARED_UNTIL_SPLIT_SETTING`), so no board goes out of reach — and
 * the person is sent a message saying so, and why (invariant 8). Each
 * launch tries again; the one that succeeds stops sharing them and
 * resolves the message.
 *
 * Throws nothing, so a failed split never stops EO starting.
 */
export function splitSharedPipelinesOrHold(db: Db, options: SplitOptions = {}): SharedPipelineSplit[] {
  const isTheRecord = options.isTheRecord ?? false;
  const pending = ownProjects(db).length === 0 ? [] : listPipelines(db).filter((pipeline) => pipeline.projectId === null && !staysShared(db, pipeline));
  try {
    const splits = splitSharedPipelines(db, options);
    clearSetting(db, SHARED_UNTIL_SPLIT_SETTING);
    resolveMessagesAbout(db, SPLIT_FAILED_SOURCE, SPLIT_FAILED_SUBJECT);
    return splits;
  } catch (error) {
    console.error("[eo] could not give each project its own copy of the pipelines they share; they stay shared, and EO tries again next launch", error);
    try {
      setSetting(
        db,
        SHARED_UNTIL_SPLIT_SETTING,
        pending.map((pipeline) => pipeline.id),
      );
      // One open message at a time, however many launches it fails on.
      resolveMessagesAbout(db, SPLIT_FAILED_SOURCE, SPLIT_FAILED_SUBJECT);
      const names = pending.map((pipeline) => `"${pipeline.name}"`).join(", ");
      const reason = error instanceof Error ? error.message : String(error);
      sendMessageHere(
        db,
        {
          projectId: null,
          source: SPLIT_FAILED_SOURCE,
          subject: SPLIT_FAILED_SUBJECT,
          body:
            `EO could not give each of your projects its own copy of ${names}, which they shared before this version: ${reason}. ` +
            `Nothing was changed, and until it can, ${pending.length === 1 ? "that pipeline stays" : "those pipelines stay"} shared among your projects as before, so every board is where it was. ` +
            `EO tries again each time it starts. If this keeps happening, check that EO can read and write its module secrets folder, which the copies take each step's secrets from.`,
        },
        isTheRecord,
      );
    } catch (reporting) {
      console.error("[eo] could not report the failed pipeline split", reporting);
    }
    return [];
  }
}

/** The project whose pipeline holds a step; null for a shared pipeline's, or a step nothing holds. */
function projectOfStep(db: Db, stepId: string): string | null {
  const step = getStep(db, stepId);
  return step === undefined ? null : (getPipeline(db, step.pipelineId)?.projectId ?? null);
}

/** What the person is told about one cross-project hand-off. */
function handOffElsewhereLine(db: Db, report: HandOffElsewhere): string {
  const pipelineName = getPipeline(db, report.pipelineId)?.name ?? report.pipelineId;
  const step = getStep(db, report.targetStepId);
  const target = step === undefined ? undefined : getPipeline(db, step.pipelineId);
  const theirs = target?.projectId === undefined || target.projectId === null ? undefined : getProject(db, target.projectId as Uuid)?.name;
  const where = `"${step?.name ?? report.targetStepId}" on "${target?.name ?? "another pipeline"}"${theirs === undefined ? "" : `, which belongs to ${theirs}`}`;
  return report.asksAPerson
    ? `This project's own copy of "${pipelineName}" had a route handing work to ${where}. No pipeline is shared between projects any more, so that route now asks for a person instead of moving this project's work onto another project's board. Redraw it in the pipeline editor if the work should go somewhere of this project's own.`
    : `"${pipelineName}" is this project's now, and it still hands work to ${where}. That hands this project's work to another project; redraw the route in the pipeline editor if it should not.`;
}

/**
 * Points a project's own pipelines' hand-offs into the shared originals
 * at the project's copies (EO-766), and its work on them with them.
 *
 * The live routes are rewritten. A version is history, so none is: where
 * the project's work is bound to an older version that hands off into an
 * original, that version is filed again with the hand-off moved
 * (`fileRetargetedVersion`) and the work bound to that. And where the
 * live graph changed, it is filed as the pipeline's new current version,
 * with the work on the old current bound to it — otherwise that work,
 * routed by the live graph until now, would be left on a version that
 * still names the original.
 */
function retargetOwnPipelines(db: Db, projectId: Uuid, own: readonly string[], stepIds: ReadonlyMap<string, string>): void {
  const moved = (target: string): string => stepIds.get(target) ?? target;
  for (const pipelineId of own) {
    let liveChanged = false;
    for (const route of db.select({ id: stepRoutes.id, target: stepRoutes.target }).from(stepRoutes).where(eq(stepRoutes.pipelineId, pipelineId)).all()) {
      if (!stepIds.has(route.target)) continue;
      db.update(stepRoutes).set({ target: moved(route.target) }).where(eq(stepRoutes.id, route.id)).run();
      liveChanged = true;
    }

    const currentVersionId = db.select({ currentVersionId: pipelines.currentVersionId }).from(pipelines).where(eq(pipelines.id, pipelineId)).get()?.currentVersionId ?? null;
    const versions = db.select().from(pipelineVersions).where(eq(pipelineVersions.pipelineId, pipelineId)).orderBy(asc(pipelineVersions.number)).all();
    const rebind = (from: string, to: string): void => {
      db.update(items)
        .set({ pipelineVersionId: to, updatedAt: Date.now() })
        .where(and(eq(items.pipelineVersionId, from), eq(items.projectId, projectId)))
        .run();
    };
    for (const version of versions) {
      if (version.id === currentVersionId || !versionTargets(version).some((target) => stepIds.has(target))) continue;
      const bound = db.select({ id: items.id }).from(items).where(and(eq(items.pipelineVersionId, version.id), eq(items.projectId, projectId))).limit(1).get();
      if (bound === undefined) continue;
      rebind(version.id, fileRetargetedVersion(db, version.id, moved));
    }
    // Last, so the pipeline's current version stays its highest.
    if (liveChanged && currentVersionId !== null) rebind(currentVersionId, createPipelineVersion(db, pipelineId).id);
  }
}

/** Moves one project's work on `sourceId` onto its copy, and answers how many items moved. */
function rehomeProjectWork(db: Db, sourceId: string, projectId: Uuid, copy: PipelineCopy): number {
  const standing = db
    .select({ id: items.id, stepId: items.stepId, pipelineVersionId: items.pipelineVersionId, assigneeId: items.assigneeId })
    .from(items)
    .where(and(eq(items.pipelineId, sourceId), eq(items.projectId, projectId)))
    .all();

  let moved = 0;
  for (const item of standing) {
    // A container stands on no step: only which pipeline it is placed on
    // moves, which is not a move between steps.
    if (item.stepId === null) {
      db.update(items).set({ pipelineId: copy.pipelineId, updatedAt: Date.now() }).where(eq(items.id, item.id)).run();
      moved += 1;
      continue;
    }
    const toStepId = copy.stepIds.get(item.stepId);
    if (toStepId === undefined) continue;
    recordFor(db).applyTransition({
      itemId: item.id as Uuid,
      toStepId,
      toPipelineId: copy.pipelineId as Uuid,
      actor: "engine",
      reason: "moved onto this project's own copy of the pipeline",
    });
    // The version it entered on, in the copy, and whoever held it: the
    // move above rebinds and reassigns as an arrival would, and this is
    // the same place in the same graph rather than an arrival.
    const versionId = item.pipelineVersionId === null ? null : (copy.versionIds.get(item.pipelineVersionId) ?? null);
    db.update(items).set({ pipelineVersionId: versionId, assigneeId: item.assigneeId }).where(eq(items.id, item.id)).run();
    for (const [from, to] of copy.stepIds) {
      db.update(itemWatches).set({ stepId: to, updatedAt: Date.now() }).where(and(eq(itemWatches.itemId, item.id), eq(itemWatches.stepId, from))).run();
    }
    moved += 1;
  }

  db.update(jobs)
    .set({ pipelineId: copy.pipelineId })
    .where(and(eq(jobs.projectId, projectId), eq(jobs.pipelineId, sourceId)))
    .run();
  return moved;
}

/**
 * The seeded pipelines, settled when the first own project is made
 * (EO-766).
 *
 * A fresh installation is seeded with Delivery and no project. First run
 * adopts it when the first project is made from the template it is an
 * export of (`pipelineAlreadyHere`); any other way of making the first
 * project — Settings → Add project, a repository, another template —
 * calls this, and the project starts with no pipeline of anybody else's.
 *
 * A seeded pipeline with no work on it is archived. One somebody already
 * filed work onto, before any project existed, is given to this project
 * instead, with that work: archiving it would put that work on a board
 * nobody can open.
 *
 * Nothing at all once a second own project exists, or when there is no
 * shared pipeline left: then the question was answered already.
 */
export function settleSeededPipelines(db: Db, projectId: Uuid): void {
  const owners = ownProjects(db);
  if (owners.length !== 1 || owners[0]?.id !== projectId) return;
  for (const pipeline of listPipelines(db)) {
    if (pipeline.projectId !== null || staysShared(db, pipeline)) continue;
    const holding = db.select({ id: items.id }).from(items).where(eq(items.pipelineId, pipeline.id)).limit(1).get();
    if (holding === undefined) archivePipeline(db, pipeline.id);
    else adoptPipeline(db, pipeline.id, projectId);
  }
}
