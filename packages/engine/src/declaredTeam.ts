import { ADMIN_MCP_SERVER_NAME, actionFactsFor, SYSTEM_ROLE, teamDefinitionProblems } from "@eo/core";
import type { NewTeamMember, PipelineStep, RegistryFacts, TeamDefinition } from "@eo/core";

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

/** A member a leader asked to add, accepted: what EO creates, its kind settled. */
export interface AcceptedMemberAddition extends NewTeamMember {
  kind: string;
}

/**
 * What EO accepts of the members a leader asks to add to its team
 * (EO-883), each refusal a sentence keyed by the name asked for. Refused:
 * a team that is not leader-led, or is locked; a name another agent
 * already has (`nameTaken`), or one named twice; a kind none of the
 * team's members is (`memberKinds`), or EO's system kind; a tool outside
 * the team's tool pool, and `eo_admin` whatever the pool says; a runtime,
 * model or reasoning outside the team's model range; and a member past
 * the team's cap. An addition refused for any reason creates nothing.
 *
 * Data in, data out (invariant 2): the caller creates what is accepted.
 */
export function checkMemberAdditions(
  team: TeamDefinition,
  context: { locked: boolean; memberKinds: readonly string[]; nameTaken: (name: string) => boolean },
  additions: readonly NewTeamMember[],
): { accepted: AcceptedMemberAddition[]; refused: { key: string; reason: string }[] } {
  const accepted: AcceptedMemberAddition[] = [];
  const refused: { key: string; reason: string }[] = [];
  const keyOf = (addition: NewTeamMember) => `new member "${addition.name}"`;
  const refuseAll = (reason: string) => ({ accepted, refused: additions.map((addition) => ({ key: keyOf(addition), reason })) });
  if (team.coordination !== "leader") return refuseAll(`EO did not add it, and created nothing: "${team.name}" is not led by a leader, so no leader may add a member to it.`);
  if (context.locked) return refuseAll(`EO did not add it, and created nothing: the team "${team.name}" is locked: a person must unlock it before a member can be added.`);
  const kinds = [...new Set(context.memberKinds)];
  const seen = new Set<string>();
  const range = team.modelRange;
  const pool = team.toolPool;
  const outside = (value: string, allowed: readonly string[], what: string, plural: string) =>
    allowed.includes(value) ? [] : [`its ${what} "${value}" is not in the team's model range (${allowed.length === 0 ? `it allows no ${plural}` : allowed.map((one) => `"${one}"`).join(", ")})`];
  for (const addition of additions) {
    const problems: string[] = [];
    const folded = addition.name.trim().toLocaleLowerCase();
    if (seen.has(folded)) problems.push("the same name is asked for twice in one answer");
    else if (context.nameTaken(addition.name)) problems.push(`another agent is already called "${addition.name.trim()}"`);
    seen.add(folded);
    const kind = addition.kind ?? (kinds.length === 1 ? kinds[0] : undefined);
    if (kind === undefined) problems.push(`its kind is left out, and the team's members are of several kinds (${kinds.join(", ")}), so it must name one`);
    else if (kind === SYSTEM_ROLE) problems.push("EO's system agent can never be a team member");
    else if (!kinds.includes(kind)) problems.push(`its kind "${kind}" is none of the team's members' kinds (${kinds.join(", ")})`);
    const beyond = [
      ...addition.tools.mcpServers.filter((name) => name === ADMIN_MCP_SERVER_NAME || !pool.mcpServers.includes(name)).map((name) => `the MCP server "${name}"`),
      ...addition.tools.skills.filter((slug) => !pool.skills.includes(slug)).map((slug) => `the skill "${slug}"`),
      ...addition.tools.cliTools.filter((command) => !pool.cliTools.includes(command)).map((command) => `the CLI tool "${command}"`),
    ];
    if (beyond.length > 0) problems.push(`${beyond.join(", ")} ${beyond.length === 1 ? "is" : "are"} not in the team's tool pool`);
    problems.push(...outside(addition.runtime, range.runtimes, "runtime", "runtimes"), ...outside(addition.model, range.models, "model", "models"), ...outside(addition.reasoning, range.reasoning, "reasoning", "reasoning levels"));
    if (problems.length === 0 && team.members.length + accepted.length >= team.memberCap) {
      problems.push(`the team has ${team.members.length + accepted.length} members, and its cap is ${team.memberCap}`);
    }
    if (problems.length > 0) {
      refused.push({ key: keyOf(addition), reason: `EO did not add it, and created nothing: ${problems.join("; ")}.` });
      continue;
    }
    accepted.push({ ...addition, kind: kind as string });
  }
  return { accepted, refused };
}
