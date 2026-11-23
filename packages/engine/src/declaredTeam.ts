import { actionFactsFor, SYSTEM_ROLE, teamDefinitionProblems } from "@eo/core";
import type { PipelineStep, RegistryFacts, TeamDefinition } from "@eo/core";

/**
 * What an agent may use, as a team's tool pool names it (EO-881): its CLI
 * tools by command, its MCP servers by name and its skills by slug.
 */
export interface AgentToolSurface {
  cliTools: readonly string[];
  mcpServers: readonly string[];
  skills: readonly string[];
}

/** What a team's checks read of an agent. */
export interface TeamAgentFacts {
  id: string;
  name: string;
  /** Its kind. */
  role: string;
  /** Whether it may be dispatched at all (EO-882): left out, it is taken to be. */
  enabled?: boolean;
  archivedAt?: number | null;
  deletedAt?: number | null;
}

/**
 * What is wrong with a declared team against the installation (EO-881,
 * ARCHITECTURE.md §4.2a), as sentences: the team's own checks
 * (`teamDefinitionProblems` — the member cap, `eo_admin` in the pool), and
 *
 * - every agent it names must exist;
 * - EO's system agent is never its leader or a member: it is the only
 *   holder of `eo_admin` (invariant 11);
 * - no member's own tool surface may go beyond the team's tool pool, so
 *   the pool is the whole of what the team's members may use and a
 *   leader adding a member picks from what a person declared (EO-883);
 * - where it is judged to run (`dispatch`, as a step naming it is): each
 *   agent it names must be one EO can dispatch — enabled, and not
 *   archived or deleted — since a session runs each as itself and never
 *   another of its kind in its place (EO-882); and on a report-only team
 *   one EO can hold to report-only (by agent id), or its first turn would
 *   be refused.
 *
 * Data in, data out (invariant 2).
 */
export function validateTeam(
  team: TeamDefinition,
  context: {
    agents: readonly TeamAgentFacts[];
    /** Each member's tools, by agent id. An agent absent here has none. */
    surfaces?: Readonly<Record<string, AgentToolSurface>>;
    /**
     * Judged as a team a step runs (EO-882): its agents must be ones EO can
     * dispatch, and `reportOnly` says why EO cannot hold an agent to
     * report-only, by agent id — read for a report-only team only, absent
     * is "every agent can be". Left out, as for a team on its own.
     */
    dispatch?: { reportOnly?: Readonly<Record<string, string>> };
  },
): string[] {
  const problems = [...teamDefinitionProblems(team)];
  const byId = new Map(context.agents.map((agent) => [agent.id, agent]));
  const named = (agentId: string) => byId.get(agentId);
  // Each agent as itself (EO-882): one that cannot run is not stood in
  // for by another of its kind.
  const usable = (agent: TeamAgentFacts, as: string) => {
    if (context.dispatch === undefined) return;
    if ((agent.deletedAt ?? null) !== null || (agent.archivedAt ?? null) !== null) problems.push(`${as} "${agent.name}" has been retired, so it cannot run.`);
    else if (agent.enabled === false) problems.push(`${as} "${agent.name}" is disabled, so it cannot run.`);
    else if (team.memberMode === "report_only") {
      const why = context.dispatch.reportOnly?.[agent.id];
      if (why !== undefined) problems.push(`${as} "${agent.name}" cannot be held to report-only: ${why}`);
    }
  };

  const leaderId = team.coordination === "leader" ? team.leader.agentId : null;
  if (leaderId !== null) {
    const leader = named(leaderId);
    if (leader === undefined) problems.push(`Its leader is an agent EO does not have (${leaderId}).`);
    else if (leader.role === SYSTEM_ROLE) problems.push(`Its leader "${leader.name}" is EO's system agent, which administers EO and can never lead a team.`);
    else usable(leader, "Its leader");
  }

  const pool = {
    cliTools: new Set(team.toolPool.cliTools),
    mcpServers: new Set(team.toolPool.mcpServers),
    skills: new Set(team.toolPool.skills),
  };
  const seen = new Set<string>();
  for (const { agentId } of team.members) {
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const agent = named(agentId);
    if (agent === undefined) {
      problems.push(`A member is an agent EO does not have (${agentId}).`);
      continue;
    }
    if (agent.role === SYSTEM_ROLE) {
      problems.push(`"${agent.name}" is EO's system agent, which administers EO and can never be a team member.`);
      continue;
    }
    // The leader as a member too is said of once.
    if (agentId !== leaderId) usable(agent, "Its member");
    const surface = context.surfaces?.[agentId];
    if (surface === undefined) continue;
    const beyond = [
      ...surface.mcpServers.filter((name) => !pool.mcpServers.has(name)).map((name) => `the MCP server "${name}"`),
      ...surface.skills.filter((slug) => !pool.skills.has(slug)).map((slug) => `the skill "${slug}"`),
      ...surface.cliTools.filter((command) => !pool.cliTools.has(command)).map((command) => `the CLI tool "${command}"`),
    ];
    if (beyond.length > 0) problems.push(`The member "${agent.name}" may use ${beyond.join(", ")}, beyond the team's tool pool.`);
  }
  return problems;
}

/** A declared team as `validatePipeline` reads it: null `definition` for one whose stored definition no longer parses. */
export interface PipelineTeamFacts {
  id: string;
  name: string;
  projectId: string | null;
  definition: TeamDefinition | null;
}

/** One problem with the declared team a step names. */
export interface DeclaredTeamProblem {
  stepId: string;
  message: string;
}

/**
 * What is wrong with the declared teams these steps name (EO-881), each a
 * sentence naming the step and the team: a team that does not exist, that
 * belongs to another project or that EO cannot read; a step that is not
 * an agent's; a leader whose kind lacks the step's action; and every
 * `validateTeam` problem with it.
 */
export function declaredTeamProblems(
  steps: readonly Pick<PipelineStep, "id" | "name" | "type" | "entryAction" | "teamId">[],
  context: {
    projectId: string | null;
    registry: RegistryFacts;
    teams: readonly PipelineTeamFacts[];
    agents: readonly TeamAgentFacts[];
    surfaces?: Readonly<Record<string, AgentToolSurface>>;
    /** Why EO cannot hold an agent to report-only, by agent id (`validateTeam`'s `reportOnly`). */
    reportOnly?: Readonly<Record<string, string>>;
  },
): DeclaredTeamProblem[] {
  const teams = new Map(context.teams.map((team) => [team.id, team]));
  const agents = new Map(context.agents.map((agent) => [agent.id, agent]));
  const problems: DeclaredTeamProblem[] = [];
  for (const step of steps) {
    // Absent as well as null: a step built before declared teams names none.
    const teamId = step.teamId;
    if (teamId === null || teamId === undefined) continue;
    const say = (message: string) => problems.push({ stepId: step.id, message });
    const team = teams.get(teamId);
    if (team === undefined) {
      say(`"${step.name}" runs as a team that does not exist (${teamId}).`);
      continue;
    }
    const lead = `"${step.name}" runs as the team "${team.name}"`;
    if (step.type !== "agent") {
      say(`${lead}, but only a step an agent does can run as a team.`);
      continue;
    }
    if (team.projectId !== context.projectId) {
      say(`${lead}, which belongs to another project: a step may run only as a team of its own pipeline's project.`);
      continue;
    }
    if (team.definition === null) {
      say(`${lead}, which EO cannot read.`);
      continue;
    }
    const definition = team.definition;
    if (definition.coordination === "leader" && step.entryAction !== null && step.entryAction !== "") {
      const leader = agents.get(definition.leader.agentId);
      if (leader !== undefined && leader.role !== SYSTEM_ROLE && actionFactsFor(context.registry, leader.role, step.entryAction) === undefined) {
        say(`${lead}, whose leader "${leader.name}" is a ${leader.role} agent, and that kind has no "${step.entryAction}" action to answer.`);
      }
    }
    for (const message of validateTeam(definition, { agents: context.agents, ...(context.surfaces === undefined ? {} : { surfaces: context.surfaces }), dispatch: context.reportOnly === undefined ? {} : { reportOnly: context.reportOnly } })) {
      say(`${lead}: ${message}`);
    }
  }
  return problems;
}
