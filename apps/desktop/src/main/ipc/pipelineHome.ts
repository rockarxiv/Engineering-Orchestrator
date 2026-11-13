import type { Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getProject, listPipelines, listProjects, listStepsForPipeline } from "../db/repos/index.js";
import { previewProjectId } from "../gallery/commands.js";
import { activeProjectId } from "./repositoryCommands.js";

/**
 * What every door that makes a pipeline answers when it has no project to
 * put it on (EO-766). Said once, so `pipelines:create`, an import and an
 * assistant draft refuse in the same words.
 */
export const PIPELINE_NEEDS_PROJECT =
  "A pipeline belongs to a project, and there is no project to put this one on. Make a project first, then try again. Nothing was written.";

/**
 * The project a new pipeline goes on, or the refusal (EO-766).
 *
 * Every pipeline has a project now: the one the caller named, otherwise
 * the one the window or the chat is on — each caller resolves that and
 * hands it here. What is refused is no project at all, a project that has
 * gone, and the gallery's Preview: that is EO's rehearsal, and a pipeline
 * somebody made there would be made on a project they never made.
 */
export function pipelineHome(db: Db, projectId: Uuid | null): { ok: true; projectId: Uuid } | { ok: false; problem: string } {
  if (projectId === null) return { ok: false, problem: PIPELINE_NEEDS_PROJECT };
  const project = getProject(db, projectId);
  if (project === undefined || project.id === previewProjectId(db)) return { ok: false, problem: PIPELINE_NEEDS_PROJECT };
  return { ok: true, projectId: project.id };
}

/**
 * The project an assistant chat's pipelines go on (EO-766): the one the
 * chat was opened on, and for a chat opened before any project existed,
 * the oldest project — which is where the rail lists such a chat
 * (`assistChatProjectId`, EO-765). Where that is Preview, `pipelineHome`
 * refuses it as it refuses Preview everywhere, rather than putting the
 * pipeline on a project the chat is not shown on. Null with no project.
 */
export function chatPipelineProjectId(db: Db, chatProjectId: Uuid | null): Uuid | null {
  return chatProjectId ?? listProjects(db)[0]?.id ?? null;
}

/**
 * The pipeline `/project` opens (EO-766): the active project's first, as
 * its rail lists them — a pipeline whose every step is off the board
 * holds no work and is not listed there. Null where it has none.
 *
 * Never `default` by name: the seeded Delivery is one project's at most,
 * and archived on an installation whose first project was made without
 * its template.
 */
export function projectBoardPipelineId(db: Db): string | null {
  const projectId = activeProjectId(db);
  const first = listPipelines(db, projectId ?? undefined).find((pipeline) => {
    const steps = listStepsForPipeline(db, pipeline.id);
    return steps.length === 0 || steps.some((step) => !step.offBoard);
  });
  return first?.id ?? null;
}
