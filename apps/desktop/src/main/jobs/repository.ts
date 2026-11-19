import { parseQualifiedItemType, type JobTemplate, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getPipeline, getProject, getWorkspace, projectWorkspaceList, resolveItemType, workspaceLabel, type Workspace } from "../db/repos/index.js";
import { stepPickedWorkspace, worksOnABranch } from "../supervisor/workspaceResolution.js";

/**
 * Which repository a job's items are filed on (EO-856), and why one
 * cannot be.
 *
 * Asked twice with the same code: when a job is saved, so a job that
 * would file stuck work is refused while somebody is setting it up, and
 * at every firing, because a repository can leave the project and a
 * second one can join it after the save.
 *
 * The job's own repository where it names one. Otherwise EO-855's rule:
 * the project's only repository, else none — and "none" is refused where
 * the project has several and the pipeline's entry step cuts a branch of
 * the item's own repository, since that item would stop at its first step
 * with "no repository assigned" and nothing can assign one afterwards.
 */
export interface JobRepositorySubject {
  projectId: string | null;
  workspaceId: string | null;
  pipelineId: string | null;
  template: JobTemplate | null;
}

export type JobRepositoryAnswer = { ok: true; workspaceId: Uuid | null } | { ok: false; problem: string };

export function jobRepository(db: Db, job: JobRepositorySubject): JobRepositoryAnswer {
  const projectId = job.projectId as Uuid | null;
  const members = projectId === null ? [] : projectWorkspaceList(db, projectId);

  if (job.workspaceId !== null) {
    if (members.some((member) => member.id === job.workspaceId)) return { ok: true, workspaceId: job.workspaceId as Uuid };
    const named = getWorkspace(db, job.workspaceId as Uuid);
    const which = named === undefined ? "The repository this job names no longer exists." : `"${workspaceLabel(named)}" is not one of this job's project's repositories.`;
    return { ok: false, problem: `${which} ${theRepositories(db, projectId, members)}` };
  }

  if (members.length === 1) return { ok: true, workspaceId: members[0]!.id };
  if (members.length > 1 && entryNeedsOwnRepository(db, job)) {
    const pipeline = getPipeline(db, job.pipelineId!)!;
    return {
      ok: false,
      problem:
        `"${pipeline.name}" starts new work on a branch of the item's own repository, and this job names none. ` +
        `${theRepositories(db, projectId, members)} Name the one its items are filed on.`,
    };
  }
  return { ok: true, workspaceId: null };
}

/** Why a job cannot be saved as it is, about its repository, or null. */
export function jobRepositoryProblem(db: Db, job: JobRepositorySubject): string | null {
  const answer = jobRepository(db, job);
  return answer.ok ? null : answer.problem;
}

/**
 * Whether the pipeline's entry step would cut a branch of an item's own
 * repository: isolated mode, on a git workspace, with no workspace of its
 * own picked. Asked of the item as the firing would file it, with no
 * repository, through the resolution dispatch itself uses.
 */
function entryNeedsOwnRepository(db: Db, job: JobRepositorySubject): boolean {
  if (job.pipelineId === null || job.template === null) return false;
  const pipeline = getPipeline(db, job.pipelineId);
  if (pipeline === undefined || pipeline.entryStepId === null) return false;
  const type = resolveItemType(db, job.projectId as Uuid | null, parseQualifiedItemType(job.template.type) ?? job.template.type);
  const subject = {
    container: type.ok ? type.type.container : false,
    workspaceId: null,
    projectId: job.projectId as Uuid | null,
    pipelineId: pipeline.id,
    stepId: pipeline.entryStepId,
    pipelineVersionId: null,
  };
  return stepPickedWorkspace(db, subject) === undefined && worksOnABranch(db, subject);
}

/** The sentence naming the project's repositories, for a person to pick one from. */
function theRepositories(db: Db, projectId: Uuid | null, members: Workspace[]): string {
  const project = projectId === null ? undefined : getProject(db, projectId);
  const whose = project === undefined ? "this job's project" : `"${project.name}"`;
  if (members.length === 0) return `${whose} has no repositories.`;
  return `${whose}'s repositories are ${members.map((member) => `"${workspaceLabel(member)}"`).join(", ")}.`;
}
