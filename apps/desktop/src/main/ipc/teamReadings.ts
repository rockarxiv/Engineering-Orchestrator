import { actionFactsFor, deterministicAnswerProblem, staffingAgents, TEAM_REPORT_ONLY, teamFacts, teamResultKeys, type Agent, type PipelineStep, type RegistryFacts, type TeamReading, type Uuid } from "@eo/core";
import { teamProblems } from "@eo/engine";
import { reportOnlyAgentProblem } from "../providers/reportOnly.js";

/**
 * A pipeline's teams as its read and validation answers describe them
 * (EO-848): what `pipeline_get` and `pipeline_validate` say about each step
 * that runs as a report-only team, and what the validator is told about
 * agents EO could not hold to report-only.
 *
 * Read as dispatch acts. A role is staffed by `staffingAgents` — the rule
 * the scheduler and the team supervisor's `staffFor` use — on each project
 * whose work the pipeline serves, so the agents named here are the ones a
 * participant could run as. The problems are `teamProblems`' own, the
 * sentences `validatePipeline` refuses a publish with, so the read and the
 * Publish button cannot disagree about a team.
 */

/** Every agent dispatch could staff `role` with, on any of these projects, in the order it would try them. */
export function teamStaff(agents: readonly Agent[], projects: readonly (Uuid | null)[], role: string): Agent[] {
  const staff = new Map<string, Agent>();
  for (const projectId of projects) {
    for (const agent of staffingAgents(agents, role, { previewAt: null, projectId })) staff.set(agent.id, agent);
  }
  return [...staff.values()];
}

/**
 * Why each role's staff cannot all be held to report-only, by role: every
 * agent dispatch could choose for it that EO would refuse to start as a
 * team member (`reportOnlyAgentProblem`). What `validatePipeline` is
 * handed as `reportOnlyRoleProblems`; it is read only for a role a team
 * dispatches.
 */
export function reportOnlyRoleProblems(agents: readonly Agent[], projects: readonly (Uuid | null)[]): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const role of new Set(agents.map((agent) => agent.role))) {
    const reasons = teamStaff(agents, projects, role).flatMap((agent) => reportOnlyAgentProblem(agent) ?? []);
    if (reasons.length > 0) problems[role] = reasons.join(" ");
  }
  return problems;
}

/** What one role is for on a team: the leader, the leader's assignments, or the participants it staffs. */
function serves(step: PipelineStep, role: string): string {
  const team = step.team!;
  if (team.coordination === "leader") {
    return [...(team.leader.role === role ? ["leader"] : []), ...(team.roles.includes(role) ? ["assignments"] : [])].join(", ");
  }
  return team.participants
    .filter((participant) => participant.role === role)
    .map((participant) => participant.key)
    .join(", ");
}

export interface TeamReadingContext {
  agents: readonly Agent[];
  projects: readonly (Uuid | null)[];
  registry: RegistryFacts;
  staffedRoles: readonly string[];
  runTimeoutMs: number;
}

/** Each step of `steps` that has a team, as the read and validation answers describe it. */
export function teamReadings(steps: readonly PipelineStep[], context: TeamReadingContext): TeamReading[] {
  const roleProblems = reportOnlyRoleProblems(context.agents, context.projects);
  return steps.flatMap((step): TeamReading[] => {
    const team = step.team;
    if (team === null || team === undefined) return [];
    const action = step.entryAction === null || step.entryAction === "" ? null : step.entryAction;
    const facts = step.ownerRole === null || action === null ? undefined : actionFactsFor(context.registry, step.ownerRole, action);
    const finalProblem =
      action === null
        ? `"${step.name}" has no action for the team to answer.`
        : team.coordination === "independent"
          ? deterministicAnswerProblem(step.name, action, facts)
          : facts === undefined
            ? `"${action}" is defined nowhere, so the leader's answer would be held to nothing.`
            : null;
    const roles = team.coordination === "leader" ? [...new Set([team.leader.role, ...team.roles])] : [...new Set(team.participants.map((participant) => participant.role))];
    return [
      {
        stepId: step.id,
        stepName: step.name,
        coordination: team.coordination,
        staffing: roles.map((role) => {
          const staff = teamStaff(context.agents, context.projects, role);
          const problem =
            staff.length === 0
              ? `No enabled "${role}" agent serves this pipeline's work.`
              : (roleProblems[role] ?? null);
          return { role, serves: serves(step, role), agents: staff.map((agent) => agent.name), problem };
        }),
        reportOnly: TEAM_REPORT_ONLY,
        finalAction: { role: step.ownerRole, action, answeredBy: team.coordination === "independent" ? "eo" : "leader", problem: finalProblem },
        results: team.coordination === "independent" ? teamResultKeys(team) : (facts?.results.map((result) => result.key) ?? []),
        facts: teamFacts(team),
        problems: teamProblems([step], { registry: context.registry, staffedRoles: context.staffedRoles, runTimeoutMs: context.runTimeoutMs, reportOnlyRoleProblems: roleProblems }).map(
          (problem) => problem.message,
        ),
      },
    ];
  });
}
