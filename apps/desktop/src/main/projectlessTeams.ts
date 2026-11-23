import type { Uuid } from "@eo/core";
import type { Db } from "./db/client.js";
import { hasMessageAbout } from "./db/repos/messagesRepo.js";
import { getProject } from "./db/repos/projectsRepo.js";
import { settleProjectlessTeams, type SharedProjectlessTeam } from "./db/repos/teamsRepo.js";
import { sendMessageHere } from "./messages/messages.js";

/** The `messages.source` of a team on no project that more than one project's steps run as (EO-899). */
export const SHARED_PROJECTLESS_TEAM_SOURCE = "team_on_no_project";

/** What the person is told about a team EO could not give one project: the team, and every pipeline that runs as it, with its project. */
export function sharedProjectlessTeamMessage(db: Db, team: SharedProjectlessTeam): string {
  const pipelines = team.pipelines
    .map((pipeline) => {
      const project = pipeline.projectId === null ? null : (getProject(db, pipeline.projectId as Uuid)?.name ?? pipeline.projectId);
      return `"${pipeline.pipelineName}" (${project === null ? "on no project" : `project "${project}"`})`;
    })
    .join(", ");
  return (
    `The team "${team.teamName}" belongs to no project, and steps of pipelines in more than one project run as it: ${pipelines}. ` +
    `A step may run only as a team of its own pipeline's project, so none of those steps can run as it, and EO left it as it is rather than give it to one project. ` +
    `Have each pipeline's step run as a team of its own project.`
  );
}

/**
 * Settles the teams that belong to no project (EO-899), on every launch:
 * each one only one project's pipelines run as moves into that project
 * (`settleProjectlessTeams`), and the person is told of each one steps of
 * more than one project run as, which EO leaves as it is (invariant 8) —
 * once for the team and those pipelines, handled or not, so a launch does
 * not say it again. Answers what it did.
 */
export function settleProjectlessTeamsAtStart(db: Db, isTheRecord: boolean): ReturnType<typeof settleProjectlessTeams> {
  const settled = settleProjectlessTeams(db);
  for (const team of settled.shared) {
    const subject = `${team.teamId}:${team.pipelines.map((pipeline) => pipeline.pipelineId).join(",")}`;
    if (hasMessageAbout(db, SHARED_PROJECTLESS_TEAM_SOURCE, subject)) continue;
    sendMessageHere(db, { projectId: null, source: SHARED_PROJECTLESS_TEAM_SOURCE, subject, body: sharedProjectlessTeamMessage(db, team) }, isTheRecord);
  }
  return settled;
}
