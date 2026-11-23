import {
  actionFactsFor,
  deterministicAnswerProblem,
  NONE_KIND,
  staffingAgents,
  stepAgentOf,
  stepWorkspaceChoice,
  teamFacts,
  teamMemberMode,
  teamResultKeys,
  teamRightsWords,
  type Agent,
  type PipelineStep,
  type RegistryFacts,
  type TeamDefinition,
  type TeamReading,
  type Uuid,
} from "@eo/core";
import { teamProblems, type IsolatedCopyProblem } from "@eo/engine";
import type { Db } from "../db/client.js";
import { projectWorkspaceList } from "../db/repos/projectsRepo.js";
import { getWorkspace } from "../db/repos/workspacesRepo.js";
import type { StoredTeam } from "../db/repos/teamsRepo.js";
import { reportOnlyAgentProblem } from "../providers/reportOnly.js";
import { kindMakesMemberCopies } from "../workspaceKinds.js";

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

/**
 * The kinds of workspace a step could work in, as dispatch resolves it
 * (`workspaceForStep`): the one it names, no disk, or — inheriting — any
 * workspace of the projects its work comes from, and no disk for a
 * project that has none.
 */
function stepKinds(db: Db, projects: readonly (Uuid | null)[], step: Pick<PipelineStep, "workspaceId">): string[] {
  const choice = stepWorkspaceChoice(step.workspaceId);
  if (choice.pick === "none") return [NONE_KIND];
  if (choice.pick === "workspace") return [getWorkspace(db, choice.workspaceId as Uuid)?.kind ?? NONE_KIND];
  const kinds = new Set<string>();
  for (const projectId of projects) {
    const workspaces = projectId === null ? [] : projectWorkspaceList(db, projectId);
    if (workspaces.length === 0) kinds.add(NONE_KIND);
    for (const workspace of workspaces) kinds.add(workspace.kind);
  }
  return [...kinds];
}

/**
 * Why an isolated team on each step could not give its members copies of
 * their own (EO-867), by step: the workspace kinds the step could work in
 * that make none (`kindMakesMemberCopies`). What `validatePipeline` is
 * handed as `isolatedCopyProblems`; only an isolated team's step is asked.
 *
 * An error only where none of those kinds makes copies, since the team
 * could then never run. Where some do and some do not — a project with a
 * Git and a folder workspace — a warning naming the kinds that cannot
 * (EO-871): an item in one of them is refused at start with a comment
 * naming the kind (`isolatedCopyRefusal`), and the team runs on every
 * other item, so neither a save nor a template update is held for it.
 */
export function isolatedCopyProblems(db: Db, projects: readonly (Uuid | null)[], steps: readonly Pick<PipelineStep, "id" | "team" | "workspaceId">[]): Record<string, IsolatedCopyProblem> {
  const problems: Record<string, IsolatedCopyProblem> = {};
  for (const step of steps) {
    if (step.team === null || step.team === undefined || teamMemberMode(step.team) !== "isolated") continue;
    const kinds = stepKinds(db, projects, step);
    const cannot = kinds.filter((kind) => !kindMakesMemberCopies(kind));
    if (cannot.length === 0) continue;
    const named = cannot.map((kind) => `"${kind}"`).join(" and ");
    problems[step.id] =
      cannot.length === kinds.length
        ? { severity: "error", why: `but it works in a ${named} workspace, which cannot give each member a copy of its own. Make its members report-only, or have the step work in a Git repository or on no disk.` }
        : {
            severity: "warning",
            why: `and some of the workspaces it may work in — ${named} — cannot give each member a copy of its own. On an item that works in one of them, EO starts nobody and says so on the item; the team runs as usual everywhere else.`,
          };
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
  /** For the workspaces a step could work in, which decide whether an isolated team can run there. */
  db?: Db;
  agents: readonly Agent[];
  projects: readonly (Uuid | null)[];
  registry: RegistryFacts;
  staffedRoles: readonly string[];
  runTimeoutMs: number;
  /** The declared teams a step may name, by id (EO-881), for the reading to say which team it runs as. */
  teams?: ReadonlyMap<string, StoredTeam>;
}

/**
 * A declared team as a draft's `teams` entry writes it (EO-881): its
 * agents by name, as a draft names a step's, and everything else as it is.
 */
export function draftFormOfTeam(team: TeamDefinition, agents: readonly Agent[]): Record<string, unknown> {
  const name = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  if (team.coordination === "leader") {
    return { ...team, leader: { agent: name(team.leader.agentId), instructions: team.leader.instructions }, members: team.members.map((member) => ({ agent: name(member.agentId) })) };
  }
  return { ...team, members: team.members.map(({ agentId, ...member }) => ({ ...member, agent: name(agentId) })) };
}

/** Each step of `steps` that has a team, as the read and validation answers describe it. */
export function teamReadings(steps: readonly PipelineStep[], context: TeamReadingContext): TeamReading[] {
  const roleProblems = reportOnlyRoleProblems(context.agents, context.projects);
  const copyProblems = context.db === undefined ? {} : isolatedCopyProblems(context.db, context.projects, steps);
  return steps.flatMap((step): TeamReading[] => {
    const team = step.team;
    if (team === null || team === undefined) return [];
    const action = step.entryAction === null || step.entryAction === "" ? null : step.entryAction;
    // The kind of the agent the step names (EO-875): the action the team
    // answers is that kind's.
    const kind = stepAgentOf(context.agents, step)?.role ?? null;
    const facts = kind === null || action === null ? undefined : actionFactsFor(context.registry, kind, action);
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
              : teamMemberMode(team) === "isolated"
                ? null
                : (roleProblems[role] ?? null);
          return { role, serves: serves(step, role), agents: staff.map((agent) => agent.name), problem };
        }),
        members: teamMemberMode(team),
        reportOnly: teamRightsWords(team),
        finalAction: { role: kind, action, answeredBy: team.coordination === "independent" ? "eo" : "leader", problem: finalProblem },
        results: team.coordination === "independent" ? teamResultKeys(team) : (facts?.results.map((result) => result.key) ?? []),
        facts: teamFacts(team),
        declared: declaredOf(step.teamId, context),
        problems: teamProblems([step], { registry: context.registry, agents: context.agents, staffedRoles: context.staffedRoles, runTimeoutMs: context.runTimeoutMs, reportOnlyRoleProblems: roleProblems, isolatedCopyProblems: copyProblems }).map(
          (problem) => problem.message,
        ),
      },
    ];
  });
}

/** The declared team a reading names (EO-881), or null where the step names none EO can read. */
function declaredOf(teamId: string | null | undefined, context: TeamReadingContext): TeamReading["declared"] {
  if (teamId === null || teamId === undefined) return null;
  const team = context.teams?.get(teamId);
  if (team === undefined || team.definition === null) return null;
  return { id: team.id, name: team.name, locked: team.locked, version: team.version, draft: draftFormOfTeam(team.definition, context.agents) };
}
