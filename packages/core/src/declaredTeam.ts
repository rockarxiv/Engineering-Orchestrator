import { z } from "zod";
import { ADMIN_MCP_SERVER_NAME } from "./schemas/mcpServers.js";
import {
  DEFAULT_TEAM_MEMBER_MODE,
  IndependentTeamLimitsSchema,
  IndependentTeamSchema,
  LeaderTeamLimitsSchema,
  StepTeamSchema,
  TEAM_CEILINGS,
  TEAM_MEMBER_MODES,
  TeamInstructionsSchema,
  TeamKeySchema,
  TeamOutcomeSchema,
  memberModeWords,
  teamConfigProblems,
  type StepTeam,
} from "./team.js";

/**
 * A declared team (EO-881, ARCHITECTURE.md §4.2a): a configured thing of
 * its own, beside agents, which an `agent` step names by id the way it
 * names an agent. Several pipelines can name one team.
 *
 * Where a step's team used to be a setting carried inline and staffed by
 * role, a declared team names **agents**: a leader agent (leader-led
 * only) and member agents, each an ordinary agent with its own runtime,
 * model and reasoning. Beside them it declares what its leader may do
 * beyond its declared members — a **tool pool** (the CLI tools, MCP
 * servers and skills a member may be given), a **model range** (the
 * runtimes, models and reasoning levels a member the leader adds may run
 * on) and a **member cap**.
 *
 * This file is the single source of truth for the shape, across IPC, the
 * assistant's draft and storage. What a team is checked against the
 * installation for — that no member is the system agent, that no member's
 * own tools go beyond the pool — is `validateTeam` in the engine, since
 * it reads agents.
 *
 * What runs is still the role-staffed team the supervisor has always run:
 * `stepTeamOf` reads a declared team as that shape, each member as its
 * agent's kind, until a team session dispatches each member as its own
 * agent (EO-882).
 */

/** The most members a team may cap itself at, whatever it declares. */
export const TEAM_MEMBER_CAP_CEILING = 16;

/** What a team that says nothing caps its members at. */
export const DEFAULT_TEAM_MEMBER_CAP = TEAM_CEILINGS.participants;

const AgentIdSchema = z.string().trim().min(1);
const NamesSchema = z.array(z.string().trim().min(1)).default([]);

/**
 * The tools a team's members may be given (EO-880): each by the name an
 * agent is given it under — a CLI tool by its command, an MCP server by
 * its name, a skill by its slug. A leader picks only from here when it
 * adds a member (EO-883), and no declared member may have more.
 * `eo_admin` can never be in it (invariant 11).
 */
export const TeamToolPoolSchema = z.strictObject({
  cliTools: NamesSchema,
  mcpServers: NamesSchema,
  skills: NamesSchema,
});
export type TeamToolPool = z.infer<typeof TeamToolPoolSchema>;

/** The runtimes, models and reasoning levels a member the leader adds may run on (EO-880). */
export const TeamModelRangeSchema = z.strictObject({
  runtimes: NamesSchema,
  models: NamesSchema,
  reasoning: NamesSchema,
});
export type TeamModelRange = z.infer<typeof TeamModelRangeSchema>;

/** One member of an independent team: an agent, the assignment key its reports are attributed to, and what it is asked to look at. */
export const IndependentTeamMemberSchema = z.strictObject({
  key: TeamKeySchema,
  agentId: AgentIdSchema,
  instructions: TeamInstructionsSchema,
  /** Whether the team cannot decide without it, as a participant's `required` always meant. */
  required: z.boolean().default(true),
});
export type IndependentTeamMember = z.infer<typeof IndependentTeamMemberSchema>;

/** One member of a leader-led team: an agent the leader may assign work to. */
export const LeaderTeamMemberSchema = z.strictObject({ agentId: AgentIdSchema });
export type LeaderTeamMember = z.infer<typeof LeaderTeamMemberSchema>;

/** The longest a team's name may be, in UTF-16 code units as Zod counts them. */
export const TEAM_NAME_MAX = 120;

/**
 * A name EO gives a team it declares itself — after a pipeline and step
 * ("Delivery · Review"), a copy or a trial — numbered `n` where an earlier
 * one took the name, always within `TEAM_NAME_MAX`, so the team it names
 * stays readable. A base of at most 110 UTF-8 bytes is kept whole; a
 * longer one is cut to its first 54 characters and "…", which is at most
 * 109 code units even if every character were outside the BMP, leaving
 * room for " (n)". Migration 0185 applies the same rule in SQL, where a
 * name's bytes and characters are what can be counted.
 */
export function generatedTeamName(base: string, n = 1): string {
  const trimmed = base.trim();
  const characters = Array.from(trimmed);
  const bytes = characters.reduce((sum, character) => {
    const point = character.codePointAt(0) ?? 0;
    return sum + (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);
  }, 0);
  const bounded = bytes <= 110 ? trimmed : `${characters.slice(0, 54).join("")}…`;
  return n <= 1 ? bounded : `${bounded} (${n})`;
}

const sharedDefinition = {
  /** What a person and a draft call the team. Unique within its project. */
  name: z.string().trim().min(1).max(TEAM_NAME_MAX),
  /** How its members work (`TEAM_MEMBER_MODES`): report-only, or each in a copy of its own. */
  memberMode: z.enum(TEAM_MEMBER_MODES).default(DEFAULT_TEAM_MEMBER_MODE),
  toolPool: TeamToolPoolSchema.prefault({}),
  modelRange: TeamModelRangeSchema.prefault({}),
  /** How many members the team may have, those its leader adds included. */
  memberCap: z.number().int().min(1).max(TEAM_MEMBER_CAP_CEILING).default(DEFAULT_TEAM_MEMBER_CAP),
};

export const IndependentTeamDefinitionSchema = z.strictObject({
  coordination: z.literal("independent"),
  ...sharedDefinition,
  members: z.array(IndependentTeamMemberSchema).min(1).max(TEAM_CEILINGS.participants),
  outcomes: z.array(TeamOutcomeSchema).min(1),
  completion: IndependentTeamSchema.shape.completion,
  limits: IndependentTeamLimitsSchema.prefault({}),
});
export type IndependentTeamDefinition = z.infer<typeof IndependentTeamDefinitionSchema>;

export const LeaderTeamDefinitionSchema = z.strictObject({
  coordination: z.literal("leader"),
  ...sharedDefinition,
  /** Who leads: an agent, assigning work and answering the step's action, with what it is asked to do. */
  leader: z.strictObject({ agentId: AgentIdSchema, instructions: TeamInstructionsSchema }),
  members: z.array(LeaderTeamMemberSchema).min(1).max(TEAM_MEMBER_CAP_CEILING),
  outcomes: z.array(TeamOutcomeSchema).default([]),
  limits: LeaderTeamLimitsSchema.prefault({}),
});
export type LeaderTeamDefinition = z.infer<typeof LeaderTeamDefinitionSchema>;

const TeamDefinitionShapeSchema = z.discriminatedUnion("coordination", [IndependentTeamDefinitionSchema, LeaderTeamDefinitionSchema]);

/**
 * What a team is: its name and everything it declares. What a version
 * records, what a draft writes and what a save sends. Every check that
 * needs nothing from the installation is part of parsing it
 * (`teamDefinitionProblems`).
 */
export const TeamDefinitionSchema = TeamDefinitionShapeSchema.superRefine((team, context) => {
  for (const message of teamDefinitionProblems(team)) context.addIssue({ code: "custom", message });
});
export type TeamDefinition = z.infer<typeof TeamDefinitionSchema>;

/** A stored definition, or null for one that no longer parses. */
export function storedTeamDefinition(value: unknown): TeamDefinition | null {
  return TeamDefinitionSchema.safeParse(value).data ?? null;
}

/** Every agent a team names, the leader's first. */
export function teamAgentIds(team: TeamDefinition): string[] {
  const members = team.members.map((member) => member.agentId);
  return team.coordination === "leader" ? [team.leader.agentId, ...members] : members;
}

/**
 * What is wrong with a team definition on its own terms, as sentences:
 * the team's own checks (`teamConfigProblems`), the member cap, and
 * `eo_admin` in the tool pool, which no team may ever offer (invariant
 * 11). Those needing the installation are `validateTeam`'s.
 */
export function teamDefinitionProblems(team: TeamDefinition): string[] {
  const problems: string[] = [];
  // The team's own checks, read on its role-shaped twin: each agent id
  // stands in for a role, which is all those checks compare.
  const twin = stepTeamOf(team, (agentId) => agentId, { parse: false });
  if (twin !== null) problems.push(...teamConfigProblems(twin).filter((message) => !message.includes(" is permitted twice.")));
  if (team.coordination === "leader") {
    const seen = new Set<string>();
    for (const member of team.members) {
      if (seen.has(member.agentId)) problems.push(`The agent "${member.agentId}" is a member twice.`);
      seen.add(member.agentId);
    }
  }
  if (team.members.length > team.memberCap) {
    problems.push(`The team has ${team.members.length} members, over its cap of ${team.memberCap}.`);
  }
  if (team.toolPool.mcpServers.includes(ADMIN_MCP_SERVER_NAME)) {
    problems.push(`"${ADMIN_MCP_SERVER_NAME}" administers EO, and can never be in a team's tool pool.`);
  }
  return problems;
}

/**
 * A declared team as the role-staffed team a step has always run
 * (`StepTeam`): each member read as its agent's kind. Null where an agent
 * it names is not known to `kindOf`, or the result is not a team EO can
 * run.
 *
 * This is how a declared team runs until EO-882: a session copies this
 * shape and staffs each kind as it always has, so a team migrated from a
 * step runs exactly what that step ran.
 */
export function stepTeamOf(team: TeamDefinition, kindOf: (agentId: string) => string | undefined, options: { parse?: boolean } = {}): StepTeam | null {
  const kinds = new Map<string, string>();
  for (const agentId of teamAgentIds(team)) {
    const kind = kindOf(agentId);
    if (kind === undefined) return null;
    kinds.set(agentId, kind);
  }
  const kind = (agentId: string) => kinds.get(agentId) as string;
  const shaped =
    team.coordination === "leader"
      ? {
          coordination: "leader" as const,
          members: team.memberMode,
          leader: { role: kind(team.leader.agentId), instructions: team.leader.instructions },
          roles: [...new Set(team.members.map((member) => kind(member.agentId)))],
          outcomes: team.outcomes,
          limits: team.limits,
        }
      : {
          coordination: "independent" as const,
          members: team.memberMode,
          participants: team.members.map((member) => ({ key: member.key, role: kind(member.agentId), instructions: member.instructions, required: member.required })),
          outcomes: team.outcomes,
          completion: team.completion,
          limits: team.limits,
        };
  if (options.parse === false) return shaped as StepTeam;
  return StepTeamSchema.safeParse(shaped).data ?? null;
}

/**
 * Who made a version of a team (EO-881): a person (a restore, or a change
 * in the Teams tab), the assistant (a draft a person published), or a
 * team's leader adding a member while working an item (EO-883). `eo` is
 * EO itself declaring a team that already ran inline — the migration
 * from step teams, an imported document, a copy from the organisation's
 * record — and is never a change to a team somebody declared.
 */
export const TeamAuthorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), personId: z.string().nullable().default(null) }),
  z.strictObject({ kind: z.literal("assistant") }),
  z.strictObject({ kind: z.literal("leader"), agentId: z.string(), itemId: z.string() }),
  z.strictObject({ kind: z.literal("eo") }),
]);
export type TeamAuthor = z.infer<typeof TeamAuthorSchema>;

/** A declared team as it is stored and crosses IPC. */
export const DeclaredTeamSchema = z.object({
  id: z.string(),
  /** The project it belongs to, or null for a team of pipelines on no project: only pipelines of the same project may name it. */
  projectId: z.string().nullable(),
  /** Locked by a person: every change but unlocking is refused, the leader's additions included. */
  locked: z.boolean(),
  /** The number of its current version. */
  version: z.number().int().positive(),
  definition: TeamDefinitionSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeclaredTeam = z.infer<typeof DeclaredTeamSchema>;

/** One version of a team: what it was, who made it, and the version it restored, if it was a restore. */
export const TeamVersionSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  number: z.number().int().positive(),
  definition: TeamDefinitionSchema,
  author: TeamAuthorSchema,
  restoredFrom: z.number().int().positive().nullable(),
  createdAt: z.number(),
});
export type TeamVersion = z.infer<typeof TeamVersionSchema>;

/** "a leader-led team" or "an independent team". */
export function declaredTeamKind(team: Pick<TeamDefinition, "coordination">): string {
  return team.coordination === "leader" ? "a leader-led team" : "an independent team";
}

/** A team in one line, for a card or a tool's answer: its name, how it coordinates and how its members work. */
export function declaredTeamLine(team: TeamDefinition): string {
  return `"${team.name}", ${declaredTeamKind(team)} of ${memberModeWords(team.memberMode)} members`;
}
