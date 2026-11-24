import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_TEAM_MEMBER_CAP,
  exportedAgentKey,
  exportedTeamAgents,
  exportedTeamDefinition,
  ExportedTeamSchema,
  isExportedTeam,
  generatedTeamName,
  TeamDefinitionSchema,
  sessionTeamOf,
  stepTeamOf,
  isTeamOwned,
  staffingAgents,
  storedTeamDefinition,
  teamAgentIds,
  namesAdminServer,
  uuidv7,
  withMemoryNoteGrant,
} from "@eo/core";
import { TeamMemberSettingsSchema } from "@eo/core";
import type { Agent, ExportedTeam, ExportedTeamAgent, NewTeamAgent, SessionTeam, StepTeam, TeamAuthor, TeamDefinition, TeamMemberSettings, TeamSave, TeamVersion, Uuid } from "@eo/core";
import { sameValue, type AgentToolSurface, type PipelineTeamFacts } from "@eo/engine";
import type { Db } from "../client.js";
import { foldCase } from "../textFold.js";
import { createAgent, deleteAgent, getAgent, listAgents, updateAgent } from "./agentsRepo.js";
import { agentReasoningEffort, reasoningEffortKey } from "../../providers/smallModels.js";
import { kindCandidates } from "../../stepAgents.js";
import { agentCliTools, agentMcpServers, agentSkills, agents, cliTools, mcpServers, pipelineSteps, pipelines, projects, skills, teamVersions, teams } from "../schema.js";

/**
 * Declared teams (EO-881, ARCHITECTURE.md §4.2a): a team is a row of its
 * own, every change to it a new row of `team_versions` recording who made
 * it, and a step names it by id.
 *
 * Nothing here judges a team against the installation — that is
 * `validateTeam`, run by Publish with the graph. What this holds is the
 * versioning and the lock: a change to a locked team is refused, except
 * unlocking it, and a restore is itself a new version.
 */

/** A team as it is stored: its definition parsed, or null where it no longer parses. */
export interface StoredTeam {
  id: string;
  projectId: string | null;
  name: string;
  locked: boolean;
  version: number;
  definition: TeamDefinition | null;
  /** When a person archived it (EO-897), or null. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What a write to a team came to: the team as it now stands, or why it was refused. */
export type TeamWrite = { ok: true; team: StoredTeam; changed: boolean } | { ok: false; reason: string };

function toTeam(row: typeof teams.$inferSelect): StoredTeam {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    locked: row.locked,
    version: row.version,
    definition: storedTeamDefinition(row.definition),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTeam(db: Db, id: string): StoredTeam | undefined {
  const row = db.select().from(teams).where(eq(teams.id, id)).get();
  return row === undefined ? undefined : toTeam(row);
}

/**
 * A project's teams, by name; `null` for the teams of pipelines on no
 * project. An archived team is left out (EO-897): nothing may name it, and
 * its name is free for another team.
 */
export function listTeams(db: Db, projectId: string | null): StoredTeam[] {
  return db
    .select()
    .from(teams)
    .where(and(projectId === null ? isNull(teams.projectId) : eq(teams.projectId, projectId), isNull(teams.archivedAt)))
    .orderBy(asc(teams.name), asc(teams.id))
    .all()
    .map(toTeam);
}

/** Every team, whichever project it is on, archived ones included. */
export function listAllTeams(db: Db): StoredTeam[] {
  return db.select().from(teams).orderBy(asc(teams.name), asc(teams.id)).all().map(toTeam);
}

/**
 * What makes two team names the same name: trimmed and folded as every
 * case-insensitive comparison in EO is (`foldCase`, EO-539) — the one
 * migration 0185 numbers its names apart by, through `eo_fold_case`.
 */
export function teamNameKey(name: string): string {
  return foldCase(name.trim());
}

/** The project's team called this, if it has one. */
export function teamByName(db: Db, projectId: string | null, name: string): StoredTeam | undefined {
  const key = teamNameKey(name);
  return listTeams(db, projectId).find((team) => teamNameKey(team.name) === key);
}

function authorColumns(author: TeamAuthor): { authorKind: string; authorId: string | null; authorItemId: string | null } {
  if (author.kind === "person") return { authorKind: "person", authorId: author.personId, authorItemId: null };
  if (author.kind === "leader") return { authorKind: "leader", authorId: author.agentId, authorItemId: author.itemId };
  if (author.kind === "system") return { authorKind: "system", authorId: author.agentId, authorItemId: null };
  return { authorKind: author.kind, authorId: null, authorItemId: null };
}

function authorOf(row: typeof teamVersions.$inferSelect): TeamAuthor {
  if (row.authorKind === "person") return { kind: "person", personId: row.authorId };
  if (row.authorKind === "leader") return { kind: "leader", agentId: row.authorId ?? "", itemId: row.authorItemId ?? "" };
  if (row.authorKind === "assistant") return { kind: "assistant" };
  if (row.authorKind === "system") return { kind: "system", agentId: row.authorId ?? "" };
  if (row.authorKind === "client") return { kind: "client" };
  return { kind: "eo" };
}

/** A version's recorded member settings, or null where it recorded none (before EO-884) or they no longer parse. */
function storedMemberSettings(value: unknown): Record<string, TeamMemberSettings> | null {
  if (value === null || typeof value !== "object") return null;
  const settings: Record<string, TeamMemberSettings> = {};
  for (const [agentId, one] of Object.entries(value)) {
    const parsed = TeamMemberSettingsSchema.safeParse(one);
    if (parsed.success) settings[agentId] = parsed.data;
  }
  return settings;
}

/**
 * Each of these agents' runtime, model and reasoning effort as they are now
 * (EO-884), by agent id: what a version of their team records. An agent
 * that no longer exists is left out.
 */
export function memberSettingsOf(db: Db, agentIds: readonly string[]): Record<string, TeamMemberSettings> {
  const settings: Record<string, TeamMemberSettings> = {};
  for (const agentId of new Set(agentIds)) {
    const agent = getAgent(db, agentId as Uuid);
    if (agent !== undefined) settings[agentId] = { provider: agent.provider, model: agent.model, reasoning: agentReasoningEffort(agent) };
  }
  return settings;
}

/**
 * Puts a runtime, model and reasoning effort on a member's agent (EO-884),
 * and nothing else of it: the reasoning under the backend's own key, any
 * the other backend kept dropped, since it means nothing there.
 */
function applyMemberSettings(db: Db, teamId: string, agentId: string, settings: TeamMemberSettings): void {
  const agent = getAgent(db, agentId as Uuid);
  // Only ever the team's own agent (EO-897): no ordinary agent changes with a team.
  if (agent === undefined || agent.teamId !== teamId) return;
  const config: Record<string, unknown> = { ...agent.config };
  // Whichever backend's key it was kept under: it means nothing on another.
  for (const provider of [agent.provider, settings.provider]) {
    const old = reasoningEffortKey(provider);
    if (old !== null) delete config[old];
  }
  const key = reasoningEffortKey(settings.provider);
  if (key !== null && settings.reasoning !== null && settings.reasoning.trim() !== "") config[key] = settings.reasoning.trim();
  updateAgent(db, agent.id, { provider: settings.provider, model: settings.model, config });
}

/** Every version of a team, oldest first. A definition that no longer parses is left out. */
export function listTeamVersions(db: Db, teamId: string): TeamVersion[] {
  return db
    .select()
    .from(teamVersions)
    .where(eq(teamVersions.teamId, teamId))
    .orderBy(asc(teamVersions.number))
    .all()
    .flatMap((row): TeamVersion[] => {
      const definition = storedTeamDefinition(row.definition);
      if (definition === null) return [];
      return [{ id: row.id, teamId: row.teamId, number: row.number, definition, author: authorOf(row), restoredFrom: row.restoredFrom, memberSettings: storedMemberSettings(row.memberSettings), note: row.note, createdAt: row.createdAt }];
    });
}

/**
 * The pipelines whose steps name this team, moved forward: `pipeline_steps`
 * has no timestamp, and a replica pages a graph on its pipeline's
 * `updated_at`, so a team change that moved none would reach nobody who had
 * already read the pipeline.
 */
function touchPipelinesNaming(db: Db, teamId: string, now: number): void {
  const named = db.selectDistinct({ pipelineId: pipelineSteps.pipelineId }).from(pipelineSteps).where(eq(pipelineSteps.teamId, teamId)).all();
  if (named.length === 0) return;
  db.update(pipelines)
    .set({ updatedAt: now })
    .where(
      inArray(
        pipelines.id,
        named.map((row) => row.pipelineId),
      ),
    )
    .run();
}

/** Why an archived team refuses a change (EO-897): archiving is one-way. */
function archivedReason(team: Pick<StoredTeam, "name">): string {
  return `The team "${team.name}" is archived: an archived team does not change, and is not brought back.`;
}

function nameTaken(db: Db, projectId: string | null, name: string, except: string | null): boolean {
  const other = teamByName(db, projectId, name);
  return other !== undefined && other.id !== except;
}

/**
 * A copy of `agent` owned by the team (EO-897): the same name, kind,
 * runtime, model, instructions, config (reasoning included), state and
 * tool surface, on the team's project. No prompt hash, so a newer shipped
 * role prompt never rewrites a member's instructions outside its team's
 * versions. What migration 0187 does in SQL for the teams it found.
 */
function copyAgentForTeam(db: Db, agent: Agent, team: { id: string; projectId: string | null }, now: number): string {
  const copy = createAgent(db, {
    name: agent.name,
    role: agent.role,
    provider: agent.provider,
    model: agent.model,
    instructions: agent.instructions,
    promptHash: null,
    config: { ...agent.config },
    enabled: agent.enabled,
    projectId: team.projectId as Uuid | null,
    teamId: team.id,
  });
  if (agent.archivedAt !== null || agent.deletedAt !== null) db.update(agents).set({ archivedAt: agent.archivedAt, deletedAt: agent.deletedAt }).where(eq(agents.id, copy.id)).run();
  for (const row of db.select().from(agentCliTools).where(eq(agentCliTools.agentId, agent.id)).all()) db.insert(agentCliTools).values({ ...row, agentId: copy.id, createdAt: now }).run();
  for (const row of db.select().from(agentMcpServers).where(eq(agentMcpServers.agentId, agent.id)).all()) db.insert(agentMcpServers).values({ ...row, agentId: copy.id, createdAt: now }).run();
  for (const row of db.select().from(agentSkills).where(eq(agentSkills.agentId, agent.id)).all()) db.insert(agentSkills).values({ ...row, agentId: copy.id, createdAt: now }).run();
  return copy.id;
}

/**
 * The definition naming only the team's own agents (EO-897), and which
 * agent each one it named became. An ordinary agent — or another team's
 * — cannot be a member: naming one makes it a new agent the team owns.
 * That is the team's live agent of the same name and kind where it
 * already has one the definition does not otherwise name (so restoring a
 * version from before the team's agents were its own, or saving a
 * trial's copy of a team again, names what the team already has), or
 * else a new copy (`copyAgentForTeam`). An id no agent has is kept as
 * written, for `validateTeam` to refuse. Inside the caller's transaction.
 *
 * `create: false` makes nothing: an agent the team has no agent for is
 * kept as written — what a write would come to where it makes nothing.
 */
export function ownedTeamDefinition(
  db: Db,
  team: { id: string; projectId: string | null },
  definition: TeamDefinition,
  now: number = Date.now(),
  options: { create?: boolean } = {},
): { definition: TeamDefinition; became: Map<string, string> } {
  const named = teamAgentIds(definition);
  const became = new Map<string, string>();
  const taken = new Set(named);
  let own: Agent[] | null = null;
  for (const agentId of new Set(named)) {
    const agent = getAgent(db, agentId as Uuid);
    if (agent === undefined || agent.teamId === team.id) continue;
    own ??= teamOwnedAgents(db, team.id);
    const key = foldCase(agent.name.trim());
    const kept = own.find((one) => !taken.has(one.id) && one.deletedAt === null && one.archivedAt === null && one.role === agent.role && foldCase(one.name.trim()) === key);
    if (kept === undefined && options.create === false) continue;
    const ownId = kept?.id ?? copyAgentForTeam(db, agent, team, now);
    taken.add(ownId);
    became.set(agentId, ownId);
  }
  if (became.size === 0) return { definition, became };
  return { definition: withAgentIds(definition, became), became };
}

/** The definition with each agent it names that `became` maps named as what it became. */
function withAgentIds(definition: TeamDefinition, became: ReadonlyMap<string, string>): TeamDefinition {
  if (became.size === 0) return definition;
  const as = (agentId: string) => became.get(agentId) ?? agentId;
  return definition.coordination === "leader"
    ? { ...definition, leader: { ...definition.leader, agentId: as(definition.leader.agentId) }, members: definition.members.map((member) => ({ ...member, agentId: as(member.agentId) })) }
    : { ...definition, members: definition.members.map((member) => ({ ...member, agentId: as(member.agentId) })) };
}

/**
 * A member a save declares that does not exist yet (EO-898), read as the
 * agent Publish would create for it: what validation judges in its place,
 * so a draft, `pipeline:validate` and `pipeline:save` refuse a new member
 * in the same words, and Publish creates exactly what was judged.
 */
export interface DeclaredNewMember {
  member: NewTeamAgent;
  /** The team that declares it, which will own it. */
  teamId: string;
  /** The agent it would be, under its stand-in id: the team's own, on the team's project. */
  agent: Agent;
  /** The agent its runtime, model, reasoning and tools are taken from: the one it names, else the project's agent of its kind. */
  base: Agent | undefined;
  /** `fromAgentId` names no agent EO has. */
  fromMissing: boolean;
  /** Its reasoning cannot be set on its runtime. */
  reasoningRefused: boolean;
  /** Its tools: the base's, kept to the team's pool. */
  surface: AgentToolSurface;
}

/**
 * Every member these saves declare (EO-898), as `DeclaredNewMember`. A
 * team's project is the stored team's, or `projectId` for a team the save
 * creates. Writes nothing.
 */
export function declaredNewMembers(db: Db, declared: readonly TeamSave[], projectId: string | null): DeclaredNewMember[] {
  if (!declared.some((save) => (save.newMembers ?? []).length > 0)) return [];
  const roster = listAgents(db);
  const answer: DeclaredNewMember[] = [];
  for (const save of declared) {
    const teamProjectId = getTeam(db, save.id)?.projectId ?? projectId;
    const pool = save.definition.toolPool;
    for (const member of save.newMembers ?? []) {
      const named = member.fromAgentId === undefined ? undefined : roster.find((agent) => agent.id === member.fromAgentId && agent.deletedAt === null);
      const base = member.fromAgentId === undefined ? kindCandidates(roster, member.kind, teamProjectId)[0] : named;
      const provider = member.runtime ?? base?.provider ?? "";
      // The base's config, as a copy for a team takes it; its reasoning
      // only where it runs on the base's runtime, since each backend keeps
      // its own under its own key.
      const config: Record<string, unknown> = { ...(base?.config ?? withMemoryNoteGrant({})) };
      // Never EO's administration grant (invariant 11): `newMemberProblems`
      // refuses a base that holds it, and this keeps a save sent past that
      // check from creating a team's member served `eo_admin`.
      if (Array.isArray(config.allowedTools)) config.allowedTools = config.allowedTools.filter((entry: unknown) => typeof entry !== "string" || !namesAdminServer([entry]));
      if (base !== undefined && base.provider !== provider) {
        for (const one of [base.provider, provider]) {
          const key = reasoningEffortKey(one);
          if (key !== null) delete config[key];
        }
      }
      const reasoningKey = reasoningEffortKey(provider);
      if (member.reasoning !== undefined && reasoningKey !== null) config[reasoningKey] = member.reasoning;
      const tools = base === undefined ? undefined : agentToolSurfaces(db, [base.id])[base.id];
      answer.push({
        member,
        teamId: save.id,
        agent: {
          id: member.id as Uuid,
          name: member.name.trim(),
          role: member.kind,
          provider,
          model: member.model ?? (base !== undefined && base.provider === provider ? base.model : null),
          instructions: member.instructions,
          promptHash: null,
          config,
          enabled: true,
          archivedAt: null,
          deletedAt: null,
          projectId: teamProjectId as Uuid | null,
          teamId: save.id as Uuid,
        },
        base,
        fromMissing: member.fromAgentId !== undefined && named === undefined,
        reasoningRefused: member.reasoning !== undefined && reasoningKey === null,
        surface: {
          cliTools: (tools?.cliTools ?? []).filter((name) => pool.cliTools.includes(name)),
          mcpServers: (tools?.mcpServers ?? []).filter((name) => pool.mcpServers.includes(name)),
          skills: (tools?.skills ?? []).filter((name) => pool.skills.includes(name)),
        },
      });
    }
  }
  return answer;
}

/**
 * Creates the members a save declares (EO-898) as agents `team` owns
 * (EO-897), each as `declaredNewMembers` read it: its base's tools, kept
 * to the team's pool. Inside the caller's transaction, so a write refused
 * after it leaves none of them. The stand-in id of each to the agent it
 * became.
 */
function createDeclaredMembers(db: Db, team: { id: string; projectId: string | null }, definition: TeamDefinition, newMembers: readonly NewTeamAgent[], now: number): Map<string, string> {
  const became = new Map<string, string>();
  if (newMembers.length === 0) return became;
  for (const declared of declaredNewMembers(db, [{ id: team.id, definition, newMembers: [...newMembers] }], team.projectId)) {
    const { agent, base } = declared;
    const id = createAgent(db, {
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      instructions: agent.instructions,
      promptHash: null,
      config: agent.config,
      enabled: true,
      projectId: team.projectId as Uuid | null,
      teamId: team.id,
    }).id;
    if (base !== undefined) {
      for (const row of db.select().from(agentCliTools).where(eq(agentCliTools.agentId, base.id)).all()) db.insert(agentCliTools).values({ ...row, agentId: id, createdAt: now }).run();
      for (const row of db.select().from(agentMcpServers).where(eq(agentMcpServers.agentId, base.id)).all()) db.insert(agentMcpServers).values({ ...row, agentId: id, createdAt: now }).run();
      for (const row of db.select().from(agentSkills).where(eq(agentSkills.agentId, base.id)).all()) db.insert(agentSkills).values({ ...row, agentId: id, createdAt: now }).run();
      keepToPool(db, id, definition.toolPool);
    }
    became.set(declared.member.id, id);
  }
  return became;
}

/** Recorded member settings, keyed by the agents they became (`ownedTeamDefinition`). */
function settingsBecame(settings: Record<string, TeamMemberSettings>, became: ReadonlyMap<string, string>): Record<string, TeamMemberSettings> {
  return Object.fromEntries(Object.entries(settings).map(([agentId, one]) => [became.get(agentId) ?? agentId, one]));
}

/**
 * Writes a version row, recording every member's runtime, model and
 * reasoning as they are (EO-884) unless the caller says what they will be.
 * Inside the caller's transaction.
 */
function writeVersion(
  db: Db,
  teamId: string,
  number: number,
  definition: TeamDefinition,
  author: TeamAuthor,
  restoredFrom: number | null,
  now: number,
  memberSettings?: Record<string, TeamMemberSettings>,
  note: string | null = null,
): void {
  const settings = memberSettings ?? memberSettingsOf(db, teamAgentIds(definition));
  db.insert(teamVersions)
    .values({ id: uuidv7(), teamId, number, definition, ...authorColumns(author), restoredFrom, memberSettings: settings, note, createdAt: now })
    .run();
}

/**
 * Declares a team: a new row and its first version. Refused where the
 * project already has a team of that name — a draft names teams by name.
 */
export function createTeam(
  db: Db,
  input: { id?: string; projectId: string | null; definition: TeamDefinition; author: TeamAuthor; now?: number; newMembers?: readonly NewTeamAgent[] },
): TeamWrite {
  const definition = TeamDefinitionSchema.parse(input.definition);
  if (nameTaken(db, input.projectId, definition.name, null)) return { ok: false, reason: `This project already has a team called "${definition.name}".` };
  const now = input.now ?? Date.now();
  const id = input.id ?? uuidv7();
  return db.transaction((tx) => {
    // Its members are its own agents (EO-897): those it declares new
    // made now (EO-898), any other it names made its own.
    const declared = withAgentIds(definition, createDeclaredMembers(tx as unknown as Db, { id, projectId: input.projectId }, definition, input.newMembers ?? [], now));
    const owned = ownedTeamDefinition(tx as unknown as Db, { id, projectId: input.projectId }, declared, now).definition;
    tx.insert(teams).values({ id, projectId: input.projectId, name: definition.name, definition: owned, locked: false, version: 1, createdAt: now, updatedAt: now }).run();
    writeVersion(tx as unknown as Db, id, 1, owned, input.author, null, now);
    return { ok: true, team: getTeam(tx as unknown as Db, id) as StoredTeam, changed: true };
  });
}

function sameDefinition(a: TeamDefinition | null, b: TeamDefinition): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether writing `definition` would change `team`, as `changeTeam` reads
 * it: the definition as the schema reads it, against the one stored. One
 * the schema refuses is a change (and refused as one).
 */
export function changesTeam(team: Pick<StoredTeam, "definition">, definition: TeamDefinition): boolean {
  const parsed = TeamDefinitionSchema.safeParse(definition);
  return !parsed.success || !sameDefinition(team.definition, parsed.data);
}

/**
 * Changes a team: a new version, made by `author`. Refused for a locked
 * team, and for a name another team of its project has. A definition
 * identical to the current one writes nothing.
 */
export function changeTeam(
  db: Db,
  id: string,
  input: { definition: TeamDefinition; author: TeamAuthor; now?: number; restoredFrom?: number; memberSettings?: Record<string, TeamMemberSettings>; newMembers?: readonly NewTeamAgent[] },
): TeamWrite {
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  if (team.archivedAt !== null) return { ok: false, reason: archivedReason(team) };
  const definition = TeamDefinitionSchema.parse(input.definition);
  // Writing what it already is changes nothing, so a locked team allows it —
  // its own agents named by the agents they were copied from included (EO-897).
  if (input.restoredFrom === undefined && input.memberSettings === undefined && sameDefinition(team.definition, ownedTeamDefinition(db, team, definition, 0, { create: false }).definition)) {
    return { ok: true, team, changed: false };
  }
  if (team.locked) return { ok: false, reason: `The team "${team.name}" is locked: a person must unlock it before it can change.` };
  if (nameTaken(db, team.projectId, definition.name, id)) return { ok: false, reason: `This project already has a team called "${definition.name}".` };
  const now = input.now ?? Date.now();
  return db.transaction((tx): TeamWrite => {
    // Its members are its own agents (EO-897): those the change declares
    // new made now (EO-898), and an agent the change names that is not
    // its own becomes one, what was recorded for it going with it.
    const declared = withAgentIds(definition, createDeclaredMembers(tx as unknown as Db, team, definition, input.newMembers ?? [], now));
    const { definition: owned, became } = ownedTeamDefinition(tx as unknown as Db, team, declared, now);
    if (input.restoredFrom === undefined && input.memberSettings === undefined && sameDefinition(team.definition, owned)) return { ok: true, team, changed: false };
    const settings = input.memberSettings === undefined ? undefined : settingsBecame(input.memberSettings, became);
    const number = team.version + 1;
    writeVersion(tx as unknown as Db, id, number, owned, input.author, input.restoredFrom ?? null, now, settings);
    tx.update(teams).set({ name: definition.name, definition: owned, version: number, updatedAt: now }).where(eq(teams.id, id)).run();
    touchPipelinesNaming(tx as unknown as Db, id, now);
    return { ok: true, team: getTeam(tx as unknown as Db, id) as StoredTeam, changed: true };
  });
}

/**
 * Puts an earlier version of a team back, as a person (EO-881): itself a
 * new version, recording the one it restored. Refused for a locked team.
 * Where the version recorded its members' runtime, model and reasoning
 * (EO-884), they go back on those members' agents that still exist — and
 * the new version records them as restored.
 */
export function restoreTeamVersion(db: Db, id: string, number: number, person: { personId: string | null; now?: number }): TeamWrite {
  const version = listTeamVersions(db, id).find((one) => one.number === number);
  if (version === undefined) return { ok: false, reason: `That team has no version ${number}.` };
  const author: TeamAuthor = { kind: "person", personId: person.personId };
  const when = person.now === undefined ? {} : { now: person.now };
  const recorded = version.memberSettings;
  if (recorded === null) return changeTeam(db, id, { definition: version.definition, author, restoredFrom: number, ...when });
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  if (team.archivedAt !== null) return { ok: false, reason: archivedReason(team) };
  if (team.locked) return { ok: false, reason: `The team "${team.name}" is locked: a person must unlock it before it can change.` };
  try {
    return db.transaction((tx) => {
      const inTx = tx as unknown as Db;
      // A version from before the team's agents were its own names ordinary
      // agents (EO-897): it is restored naming the team's own, and what it
      // recorded for each goes on the team's agent, never the ordinary one.
      const { definition, became } = ownedTeamDefinition(inTx, team, version.definition, person.now);
      const current = memberSettingsOf(inTx, teamAgentIds(definition));
      const restored = Object.fromEntries(Object.entries(settingsBecame(recorded, became)).filter(([agentId]) => current[agentId] !== undefined));
      const written = changeTeam(inTx, id, { definition, author, restoredFrom: number, memberSettings: { ...current, ...restored }, ...when });
      // A refusal undoes any agent made the team's own for it.
      if (!written.ok) throw new VersionRefused(written.reason);
      for (const [agentId, settings] of Object.entries(restored)) applyMemberSettings(inTx, id, agentId, settings);
      return written;
    });
  } catch (error) {
    if (error instanceof VersionRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * A person changing one member's runtime, model and reasoning effort
 * (EO-884), the leader's included: written on the member's agent — the
 * team's own — and recorded as a new version of the team made by that
 * person. Refused for a locked team, a team EO cannot read, and an agent
 * that is not on the team, is archived or no longer exists. Settings it
 * already has write nothing, and a version refused writes nothing either.
 */
export function setTeamMemberSettings(db: Db, id: string, agentId: string, settings: TeamMemberSettings, person: { personId: string | null; now?: number }): TeamWrite {
  return setTeamMembersSettings(db, id, [agentId], settings, { author: { kind: "person", personId: person.personId }, ...(person.now === undefined ? {} : { now: person.now }) });
}

/**
 * Several members set to one runtime, model and reasoning effort (EO-900),
 * as `setTeamMemberSettings` sets one, by `author`: every one checked
 * first, and the lot written as one version of the team, so one restore
 * puts all of them back. Refused whole where any member is refused; where
 * every member already runs on them, nothing is written.
 */
export function setTeamMembersSettings(db: Db, id: string, agentIds: readonly string[], settings: TeamMemberSettings, by: { author: TeamAuthor; now?: number }): TeamWrite {
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  if (team.archivedAt !== null) return { ok: false, reason: archivedReason(team) };
  if (team.locked) return { ok: false, reason: `The team "${team.name}" is locked: a person must unlock it before it can change.` };
  if (team.definition === null) return { ok: false, reason: `EO cannot read what the team "${team.name}" declares, so it cannot change a member of it.` };
  const definition = team.definition;
  const ids = teamAgentIds(definition);
  const targets = [...new Set(agentIds)];
  for (const agentId of targets) {
    if (!ids.includes(agentId)) return { ok: false, reason: `That agent is not on the team "${team.name}".` };
    const agent = getAgent(db, agentId as Uuid);
    if (agent === undefined || agent.deletedAt !== null) return { ok: false, reason: "That member's agent no longer exists." };
    // Changing a member changes the team alone (EO-897): never an agent the team does not own.
    if (agent.teamId !== id) return { ok: false, reason: `${agent.name} is not the team "${team.name}"'s own agent, so changing it would change more than the team.` };
    if (agent.archivedAt !== null) return { ok: false, reason: `${agent.name} is archived: restore it before changing its runtime, model or reasoning.` };
  }
  const wanted: TeamMemberSettings = { provider: settings.provider, model: settings.model === null || settings.model.trim() === "" ? null : settings.model.trim(), reasoning: settings.reasoning === null || settings.reasoning.trim() === "" ? null : settings.reasoning.trim() };
  const before = memberSettingsOf(db, targets);
  const moving = targets.filter((agentId) => before[agentId] === undefined || JSON.stringify(before[agentId]) !== JSON.stringify(wanted));
  if (moving.length === 0) return { ok: true, team, changed: false };
  try {
    return db.transaction((tx) => {
      const inTx = tx as unknown as Db;
      for (const agentId of moving) applyMemberSettings(inTx, id, agentId, wanted);
      const written = changeTeam(inTx, id, { definition, author: by.author, memberSettings: memberSettingsOf(inTx, ids), ...(by.now === undefined ? {} : { now: by.now }) });
      // No version, no change: a refusal undoes the agents' new settings with it.
      if (!written.ok) throw new VersionRefused(written.reason);
      return written;
    });
  } catch (error) {
    if (error instanceof VersionRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Thrown inside a transaction to roll back a member's settings whose version `changeTeam` refused. */
class VersionRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Locks or unlocks a team, as a person. A lock is a guard on the team, not
 * a change to what it is, so it writes no version; while it holds, every
 * change but unlocking is refused.
 */
export function setTeamLocked(db: Db, id: string, locked: boolean, now: number = Date.now()): TeamWrite {
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  if (team.archivedAt !== null) return { ok: false, reason: archivedReason(team) };
  if (team.locked === locked) return { ok: true, team, changed: false };
  db.transaction((tx) => {
    tx.update(teams).set({ locked, updatedAt: now }).where(eq(teams.id, id)).run();
    touchPipelinesNaming(tx as unknown as Db, id, now);
  });
  return { ok: true, team: getTeam(db, id) as StoredTeam, changed: true };
}

/** Removes a project's teams, for `deleteProject`, as `deleteTeam` removes one: its own agents and its versions go with it. */
export function deleteProjectTeams(db: Db, projectId: string): void {
  const ids = db.select({ id: teams.id }).from(teams).where(eq(teams.projectId, projectId)).all().map((row) => row.id);
  for (const id of ids) removeTeam(db, id, Date.now());
}

/**
 * Removes a team: the steps that name it — a retired step's row included
 * — let go of it, its own agents become tombstones (`deleteTeamMembers`)
 * and its versions go with its row. Inside the caller's transaction.
 */
function removeTeam(db: Db, teamId: string, at: number): void {
  touchPipelinesNaming(db, teamId, at);
  db.update(pipelineSteps).set({ teamId: null }).where(eq(pipelineSteps.teamId, teamId)).run();
  // Its own agents go with it (EO-897).
  deleteTeamMembers(db, teamId, at);
  db.delete(teams).where(eq(teams.id, teamId)).run();
}

/**
 * Archives a team, as a person (EO-897): one-way, as an agent's archive
 * is. Its own agents are archived with it, so none is left behind without
 * its team; it leaves the Teams tab, and no step may name it after. The
 * row and its versions stay. Whether a step still names it, or a person
 * locked it, is the caller's question (`archiveTeamCommand`). False when
 * there is no such team.
 */
export function archiveTeam(db: Db, id: string, at: number = Date.now()): boolean {
  const team = getTeam(db, id);
  if (team === undefined) return false;
  if (team.archivedAt !== null) return true;
  db.transaction((tx) => {
    tx.update(teams).set({ archivedAt: at, updatedAt: at }).where(eq(teams.id, id)).run();
    archiveTeamMembers(tx as unknown as Db, id, at);
  });
  return true;
}

/**
 * Deletes a team, as a person (EO-897), archived or not, the way
 * `deleteProject` deletes a project's: the row and its versions go, and
 * its own agents stay only as tombstones its runs, reports and comments
 * still name. The caller asks what refuses it (`deleteTeamCommand`).
 * False when there is no such team.
 */
export function deleteTeam(db: Db, id: string, at: number = Date.now()): boolean {
  if (getTeam(db, id) === undefined) return false;
  db.transaction((tx) => removeTeam(tx as unknown as Db, id, at));
  return true;
}

/** The agents a team owns (EO-897): every one it ever had, those removed from it, archived or deleted included. */
export function teamOwnedAgents(db: Db, teamId: string): Agent[] {
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .orderBy(asc(agents.id))
    .all()
    .flatMap((row) => getAgent(db, row.id as Uuid) ?? []);
}

/**
 * Archives every agent a team owns (EO-897), as the team is archived, so
 * no team's own agent is left behind without its team. Each keeps its
 * row, so its runs, reports and comments still name it, and an archive
 * stamp it already had, being the true one.
 */
export function archiveTeamMembers(db: Db, teamId: string, at: number = Date.now()): void {
  db.update(agents)
    .set({ archivedAt: sql`coalesce(${agents.archivedAt}, ${at})`, updatedAt: at, revision: sql`${agents.revision} + 1` })
    .where(eq(agents.teamId, teamId))
    .run();
}

/**
 * Deletes every agent a team owns (EO-897), as the team is deleted: each
 * a tombstone (`deleteAgent`) that keeps its name, kind and team, so its
 * runs, reports and comments still say who did them.
 */
export function deleteTeamMembers(db: Db, teamId: string, at: number = Date.now()): void {
  for (const agent of teamOwnedAgents(db, teamId)) if (agent.deletedAt === null) deleteAgent(db, agent.id, at);
}

/**
 * What each of these agents may use, as a team's tool pool names it: its
 * CLI tools by command, its MCP servers by name, its skills by slug — every
 * attachment it has.
 */
export function agentToolSurfaces(db: Db, agentIds: readonly string[]): Record<string, AgentToolSurface> {
  const ids = [...new Set(agentIds)];
  const surfaces: Record<string, { cliTools: string[]; mcpServers: string[]; skills: string[] }> = {};
  for (const id of ids) surfaces[id] = { cliTools: [], mcpServers: [], skills: [] };
  if (ids.length === 0) return surfaces;
  for (const row of db.select({ agentId: agentCliTools.agentId, name: cliTools.command }).from(agentCliTools).innerJoin(cliTools, eq(cliTools.id, agentCliTools.cliToolId)).where(inArray(agentCliTools.agentId, ids)).all()) {
    surfaces[row.agentId]?.cliTools.push(row.name);
  }
  for (const row of db.select({ agentId: agentMcpServers.agentId, name: mcpServers.name }).from(agentMcpServers).innerJoin(mcpServers, eq(mcpServers.id, agentMcpServers.serverId)).where(inArray(agentMcpServers.agentId, ids)).all()) {
    surfaces[row.agentId]?.mcpServers.push(row.name);
  }
  for (const row of db.select({ agentId: agentSkills.agentId, name: skills.slug }).from(agentSkills).innerJoin(skills, eq(skills.id, agentSkills.skillId)).where(inArray(agentSkills.agentId, ids)).all()) {
    surfaces[row.agentId]?.skills.push(row.name);
  }
  return surfaces;
}

/**
 * The teams a pipeline on this project may name, as `validatePipeline`
 * reads them, with those a save declares laid over them (by id), what
 * each agent they name may use, and the agents the members a save
 * declares new would be (EO-898) — which no `listAgents` has yet, and
 * which every judging of the graph must be given beside it.
 */
export function teamsForValidation(
  db: Db,
  projectId: string | null,
  declared: readonly TeamSave[] = [],
): { teams: PipelineTeamFacts[]; surfaces: Record<string, AgentToolSurface>; newAgents: Agent[] } {
  const byId = new Map<string, PipelineTeamFacts>();
  for (const team of listAllTeams(db)) byId.set(team.id, { id: team.id, name: team.name, projectId: team.projectId, definition: team.definition, archived: team.archivedAt !== null });
  for (const team of declared) {
    const stored = byId.get(team.id);
    byId.set(team.id, { id: team.id, name: team.definition.name, projectId: stored?.projectId ?? projectId, definition: team.definition, archived: stored?.archived ?? false });
  }
  const list = [...byId.values()];
  const agentIds = list.flatMap((team) => (team.definition === null ? [] : teamAgentIds(team.definition)));
  // The members a save declares new (EO-898), as the agents they would be.
  const declaredNew = declaredNewMembers(db, declared, projectId);
  const surfaces = agentToolSurfaces(db, agentIds);
  for (const one of declaredNew) surfaces[one.agent.id] = one.surface;
  return { teams: list, surfaces, newAgents: declaredNew.map((one) => one.agent) };
}

/**
 * Reads declared teams as the role-staffed shape a session runs
 * (`stepTeamOf`), one team at a time and each once. For step reads: a
 * step's `team` is its declared team read this way.
 */
export function teamReader(db: Db, declared: readonly TeamSave[] = []): (teamId: string | null) => StepTeam | null {
  const read = new Map<string, StepTeam | null>();
  const overlay = new Map(declared.map((team) => [team.id, team.definition]));
  // A member a save declares new (EO-898) is of the kind it declares.
  const declaredKinds = new Map(declared.flatMap((team) => (team.newMembers ?? []).map((member) => [member.id, member.kind] as const)));
  return (teamId) => {
    if (teamId === null) return null;
    const known = read.get(teamId);
    if (known !== undefined) return known;
    // A team the save declares is read as it would be written (EO-881).
    const definition = overlay.get(teamId) ?? getTeam(db, teamId)?.definition ?? null;
    let shaped: StepTeam | null = null;
    if (definition !== null) {
      const ids = teamAgentIds(definition);
      const kinds = new Map([...declaredKinds, ...db.select({ id: agents.id, role: agents.role }).from(agents).where(inArray(agents.id, ids)).all().map((row) => [row.id, row.role] as const)]);
      shaped = stepTeamOf(definition, (agentId) => kinds.get(agentId));
    }
    read.set(teamId, shaped);
    return shaped;
  };
}

/**
 * A declared team as a session runs it (EO-882, `sessionTeamOf`): the
 * step's team with the agent behind each part of it. Null where the step
 * names none, or one EO cannot read — where its `team` is null too.
 */
export function sessionTeamFor(db: Db, teamId: string | null): SessionTeam | null {
  if (teamId === null) return null;
  const definition = getTeam(db, teamId)?.definition ?? null;
  if (definition === null) return null;
  const ids = teamAgentIds(definition);
  const kinds = new Map(db.select({ id: agents.id, role: agents.role }).from(agents).where(inArray(agents.id, ids)).all().map((row) => [row.id, row.role]));
  return sessionTeamOf(definition, (agentId) => kinds.get(agentId));
}

/** The agent a role is bound to on a project: EO-874's staffing rule first, then any agent that held the role there. */
function boundAgent(all: readonly Agent[], role: string, projectId: string | null): Agent | undefined {
  const staffed = staffingAgents(all, role, { projectId: projectId as Uuid | null, previewAt: null });
  if (staffed.length > 0) return staffed[0];
  const held = all.filter((agent) => !isTeamOwned(agent) && agent.role === role && (agent.projectId === null || agent.projectId === projectId));
  return held.find((agent) => agent.projectId !== null && agent.deletedAt === null) ?? held.find((agent) => agent.deletedAt === null) ?? held[0];
}

/**
 * A role-staffed team (a step's team before EO-881, or as an exported
 * document still carries one) as a declared team's definition, named
 * `name`: each role bound to the agent EO-874 bound a step's role to
 * (`boundAgent`), the tool pool every tool those members have and the
 * model range their runtimes, models and reasoning — so no member is
 * beyond what the team declares. Null where a role has no agent at all.
 *
 * What migration 0185 does in SQL, for what arrives inline after it: an
 * imported document, a template update, a copy from the organisation's
 * record.
 */
export function definitionOfStepTeam(db: Db, team: StepTeam, input: { name: string; projectId: string | null }): TeamDefinition | null {
  // In staffing order, which is `listAgents`' (rowid).
  const roster = listAgents(db);
  const bind = (role: string) => boundAgent(roster, role, input.projectId);
  const memberAgents: Agent[] = [];
  const member = (role: string): string | null => {
    const agent = bind(role);
    if (agent === undefined) return null;
    if (!memberAgents.includes(agent)) memberAgents.push(agent);
    return agent.id;
  };

  let shaped: Record<string, unknown>;
  if (team.coordination === "leader") {
    const leader = bind(team.leader.role);
    const members = team.roles.map(member);
    if (leader === undefined || members.includes(null)) return null;
    shaped = {
      coordination: "leader",
      name: input.name,
      memberMode: team.members,
      leader: { agentId: leader.id, instructions: team.leader.instructions },
      members: [...new Set(members as string[])].map((agentId) => ({ agentId })),
      outcomes: team.outcomes,
      limits: team.limits,
    };
  } else {
    const members = team.participants.map((participant) => ({ participant, agentId: member(participant.role) }));
    if (members.some((one) => one.agentId === null)) return null;
    shaped = {
      coordination: "independent",
      name: input.name,
      memberMode: team.members,
      members: members.map(({ participant, agentId }) => ({ key: participant.key, agentId, instructions: participant.instructions, required: participant.required })),
      outcomes: team.outcomes,
      completion: team.completion,
      limits: team.limits,
    };
  }
  const surfaces = agentToolSurfaces(
    db,
    memberAgents.map((agent) => agent.id),
  );
  const union = (pick: (surface: AgentToolSurface) => readonly string[]) => [...new Set(Object.values(surfaces).flatMap(pick))].sort();
  shaped["toolPool"] = { cliTools: union((surface) => surface.cliTools), mcpServers: union((surface) => surface.mcpServers), skills: union((surface) => surface.skills) };
  shaped["modelRange"] = {
    runtimes: [...new Set(memberAgents.map((agent) => agent.provider))].sort(),
    models: [...new Set(memberAgents.flatMap((agent) => (agent.model === null || agent.model.trim() === "" ? [] : [agent.model])))].sort(),
    // Each backend keeps it under its own key; the one reading of it is the providers' (`agentReasoningEffort`).
    reasoning: [...new Set(memberAgents.flatMap((agent) => agentReasoningEffort(agent) ?? []))].sort(),
  };
  shaped["memberCap"] = DEFAULT_TEAM_MEMBER_CAP;
  return TeamDefinitionSchema.safeParse(shaped).data ?? null;
}

/**
 * A name no team of the project has, within a team name's limit
 * (`generatedTeamName`): `base`, or `base (2)`, `base (3)`…, a long base
 * cut first, so the team declared under it is one EO can read.
 */
export function freeTeamName(db: Db, projectId: string | null, base: string): string {
  for (let n = 1; ; n += 1) {
    const candidate = generatedTeamName(base, n);
    if (teamByName(db, projectId, candidate) === undefined) return candidate;
  }
}

/**
 * The declared team a step that arrives with an inline, role-staffed team
 * runs as: the team it already names, where that reads as the same team,
 * and otherwise a team declared from it, named after the pipeline and the
 * step, by EO. Null where the team cannot be declared — a role no agent
 * here has ever held — which leaves the step naming none.
 */
export function teamIdForInlineTeam(
  db: Db,
  input: { pipelineId: string; stepName: string; team: StepTeam; current: string | null; id?: string; now?: number },
): string | null {
  const pipeline = db.select({ name: pipelines.name, projectId: pipelines.projectId }).from(pipelines).where(eq(pipelines.id, input.pipelineId)).get();
  if (pipeline === undefined) return null;
  if (input.current !== null) {
    const same = teamReader(db)(input.current);
    if (same !== null && JSON.stringify(same) === JSON.stringify(input.team)) return input.current;
  }
  if (input.id !== undefined) {
    const existing = getTeam(db, input.id);
    if (existing !== undefined) {
      const definition = definitionOfStepTeam(db, input.team, { name: existing.name, projectId: existing.projectId });
      if (definition === null) return null;
      // A locked team keeps what it is: the copy names it all the same.
      changeTeam(db, existing.id, { definition, author: { kind: "eo" }, ...(input.now === undefined ? {} : { now: input.now }) });
      return existing.id;
    }
  }
  const name = freeTeamName(db, pipeline.projectId, `${pipeline.name} · ${input.stepName}`);
  const definition = definitionOfStepTeam(db, input.team, { name, projectId: pipeline.projectId });
  if (definition === null) return null;
  const created = createTeam(db, { ...(input.id === undefined ? {} : { id: input.id }), projectId: pipeline.projectId, definition, author: { kind: "eo" }, ...(input.now === undefined ? {} : { now: input.now }) });
  return created.ok ? created.team.id : null;
}

/** The steps that name a team, with their pipelines: what a team is used by. */
export function stepsNamingTeam(db: Db, teamId: string): { stepId: string; stepName: string; pipelineId: string; pipelineName: string }[] {
  return db
    .select({ stepId: pipelineSteps.id, stepName: pipelineSteps.name, pipelineId: pipelines.id, pipelineName: pipelines.name })
    .from(pipelineSteps)
    .innerJoin(pipelines, eq(pipelines.id, pipelineSteps.pipelineId))
    .where(and(eq(pipelineSteps.teamId, teamId), isNull(pipelineSteps.retiredVersion)))
    .orderBy(asc(pipelines.name), asc(pipelineSteps.position))
    .all();
}

/**
 * The live pipelines whose current steps name a team, each with its
 * project (null for one on no project). An archived pipeline runs nothing,
 * so it is left out.
 */
function pipelinesNamingTeam(db: Db, teamId: string): { pipelineId: string; pipelineName: string; projectId: string | null }[] {
  return db
    .selectDistinct({ pipelineId: pipelines.id, pipelineName: pipelines.name, projectId: pipelines.projectId })
    .from(pipelineSteps)
    .innerJoin(pipelines, eq(pipelines.id, pipelineSteps.pipelineId))
    .where(and(eq(pipelineSteps.teamId, teamId), isNull(pipelineSteps.retiredVersion), isNull(pipelines.archivedAt)))
    .orderBy(asc(pipelines.name), asc(pipelines.id))
    .all();
}

/** A team on no project that steps of more than one project — or of a project and of a pipeline on none — run as: left where it is. */
export interface SharedProjectlessTeam {
  teamId: string;
  teamName: string;
  pipelines: { pipelineId: string; pipelineName: string; projectId: string | null }[];
}

/**
 * Puts each team that belongs to no project into the project whose
 * pipelines run as it (EO-899). A step may run only as a team of its own
 * pipeline's project, and a team made for a pipeline while it was on no
 * project — the seeded Delivery, brought up to its template before any
 * project existed — stayed on none when the pipeline was adopted.
 *
 * Each such team that only one project's pipelines name moves there with
 * its own agents, as a new version by EO saying so; one whose name that
 * project already has is numbered apart, and the version says that too.
 * One that more than one project names, or a project and a pipeline on
 * none, is left as it is and answered as `shared`, for the caller to tell
 * the person. One nothing names, or only pipelines on no project, stays.
 * `pipelineId` narrows it to the teams that pipeline's steps name.
 * Archived teams and a trial's copies are left alone.
 */
export function settleProjectlessTeams(db: Db, options: { pipelineId?: string; now?: number } = {}): { moved: { teamId: string; projectId: string }[]; shared: SharedProjectlessTeam[] } {
  const now = options.now ?? Date.now();
  const scope =
    options.pipelineId === undefined
      ? undefined
      : new Set(
          db
            .selectDistinct({ teamId: pipelineSteps.teamId })
            .from(pipelineSteps)
            .where(and(eq(pipelineSteps.pipelineId, options.pipelineId), isNull(pipelineSteps.retiredVersion)))
            .all()
            .flatMap((row) => (row.teamId === null ? [] : [row.teamId])),
        );
  if (scope !== undefined && scope.size === 0) return { moved: [], shared: [] };
  const candidates = db
    .select({ id: teams.id })
    .from(teams)
    .where(and(isNull(teams.projectId), isNull(teams.archivedAt), isNull(teams.trialPipelineId)))
    .orderBy(asc(teams.name), asc(teams.id))
    .all()
    .filter((row) => scope === undefined || scope.has(row.id));
  const moved: { teamId: string; projectId: string }[] = [];
  const shared: SharedProjectlessTeam[] = [];
  for (const { id } of candidates) {
    const team = getTeam(db, id);
    const definition = team?.definition ?? null;
    if (team === undefined || definition === null) continue;
    const naming = pipelinesNamingTeam(db, id);
    const projects = new Set(naming.map((pipeline) => pipeline.projectId));
    if (projects.size > 1) {
      shared.push({ teamId: id, teamName: team.name, pipelines: naming });
      continue;
    }
    const [projectId] = [...projects];
    if (projectId === undefined || projectId === null) continue;
    moveTeamIntoProject(db, { ...team, definition }, projectId, naming.map((pipeline) => pipeline.pipelineName), now);
    moved.push({ teamId: id, projectId });
  }
  return { moved, shared };
}

/**
 * Moves a team on no project, and its own agents, into `projectId`: a new
 * version by EO with the same definition — its name numbered apart where
 * the project has it — whose note says why. A lock does not hold it back:
 * nothing of what the team is changes, only where it belongs, and where it
 * was no step of its pipeline could run as it.
 */
function moveTeamIntoProject(db: Db, team: StoredTeam & { definition: TeamDefinition }, projectId: string, pipelineNames: readonly string[], now: number): void {
  const project = db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).get();
  const name = teamByName(db, projectId, team.name) === undefined ? team.name : freeTeamName(db, projectId, team.name);
  const definition: TeamDefinition = { ...team.definition, name };
  const named = pipelineNames.map((one) => `"${one}"`).join(", ");
  const note =
    `EO moved this team into the project "${project?.name ?? projectId}", which ${pipelineNames.length === 1 ? `the pipeline ${named} that runs as it belongs` : `the pipelines ${named} that run as it belong`} to: it belonged to no project, and a step may run only as a team of its own pipeline's project.` +
    (name === team.name ? "" : ` That project already had a team called "${team.name}", so this one is "${name}" now.`);
  db.transaction((tx) => {
    const inTx = tx as unknown as Db;
    const number = team.version + 1;
    writeVersion(inTx, team.id, number, definition, { kind: "eo" }, null, now, undefined, note);
    tx.update(teams).set({ projectId, name, definition, version: number, updatedAt: now }).where(eq(teams.id, team.id)).run();
    for (const own of teamOwnedAgents(inTx, team.id)) updateAgent(inTx, own.id, { projectId: projectId as Uuid });
    touchPipelinesNaming(inTx, team.id, now);
  });
}

/**
 * The teams a trial of a draft runs as (EO-881): each team the draft
 * creates or changes, as a team of the trial's own — named after the
 * trial — so a trial never changes a team a live pipeline names, and a
 * draft's new team is tried before it exists. Steps naming one of the
 * draft's teams name the trial's copy.
 *
 * A copy is found again by what it belongs to — the trial, and the draft
 * team it copies (`teams.trial_pipeline_id`, `trial_source`, written by
 * the save through `sources`) — never by its name: a name cut within the
 * limit can lose the trial's part, and then be a live team's, or another
 * copy's. Each copy is named apart from every other team of the project.
 */
export function trialTeams(
  db: Db,
  trial: { id: string; name: string },
  declared: readonly TeamSave[],
): { teams: TeamSave[]; teamIdOf: (teamId: string | null | undefined) => string | null | undefined; sources: Record<string, string> } {
  const projectId = db.select({ projectId: pipelines.projectId }).from(pipelines).where(eq(pipelines.id, trial.id)).get()?.projectId ?? null;
  const owned = new Map(
    db
      .select({ id: teams.id, source: teams.trialSource })
      .from(teams)
      .where(eq(teams.trialPipelineId, trial.id))
      .all()
      .flatMap((row): [string, string][] => (row.source === null ? [] : [[row.source, row.id]])),
  );
  const named = new Set<string>();
  const copies = new Map<string, TeamSave>();
  const sources: Record<string, string> = {};
  for (const team of declared) {
    const source = teamNameKey(team.definition.name);
    const claimed = Object.values(sources).includes(source);
    const id = (claimed ? undefined : owned.get(source)) ?? uuidv7();
    let name = "";
    for (let n = 1; name === ""; n += 1) {
      const candidate = generatedTeamName(`${team.definition.name} (${trial.name})`, n);
      const other = teamByName(db, projectId, candidate);
      if (!named.has(teamNameKey(candidate)) && (other === undefined || other.id === id)) name = candidate;
    }
    named.add(teamNameKey(name));
    copies.set(team.id, { ...team, id, definition: { ...team.definition, name } });
    if (!claimed) sources[id] = source;
  }
  return { teams: [...copies.values()], teamIdOf: (teamId) => (teamId === null || teamId === undefined ? teamId : (copies.get(teamId)?.id ?? teamId)), sources };
}

/** Marks a team as a trial's own copy of a draft's team (`trialTeams`). Inside the save's transaction. */
export function claimTrialTeam(db: Db, teamId: string, trialPipelineId: string, source: string): void {
  db.update(teams).set({ trialPipelineId, trialSource: source }).where(eq(teams.id, teamId)).run();
}

/**
 * A declared team as a document carries it (EO-885, `ExportedTeamSchema`):
 * everything it declares, with its leader and members as the kinds and
 * instructions of the agents it names — never their ids. Two of its
 * agents that share a name travel apart, the later numbered, since a
 * document tells a team's agents apart by name. Null where it no longer
 * parses, or an agent it names no longer exists.
 */
export function exportedTeamOf(db: Db, teamId: string | null): ExportedTeam | null {
  if (teamId === null) return null;
  const definition = getTeam(db, teamId)?.definition ?? null;
  if (definition === null) return null;
  const parts = new Map<string, ExportedTeamAgent>();
  const names = new Set<string>();
  for (const agentId of teamAgentIds(definition)) {
    if (parts.has(agentId)) continue;
    const agent = getAgent(db, agentId as Uuid);
    if (agent === undefined) return null;
    let name = agent.name.trim();
    for (let n = 2; names.has(exportedAgentKey(name)); n += 1) name = `${agent.name.trim()} (${n})`;
    names.add(exportedAgentKey(name));
    parts.set(agentId, { name, kind: agent.role, instructions: agent.instructions });
  }
  const part = (agentId: string) => parts.get(agentId) as ExportedTeamAgent;
  const shared = { name: definition.name, memberMode: definition.memberMode, toolPool: definition.toolPool, modelRange: definition.modelRange, memberCap: definition.memberCap };
  const shaped =
    definition.coordination === "leader"
      ? {
          coordination: "leader" as const,
          ...shared,
          leader: { ...part(definition.leader.agentId), teamInstructions: definition.leader.instructions },
          members: definition.members.map((member) => part(member.agentId)),
          outcomes: definition.outcomes,
          limits: definition.limits,
        }
      : {
          coordination: "independent" as const,
          ...shared,
          members: definition.members.map((member) => ({ ...part(member.agentId), key: member.key, teamInstructions: member.instructions, required: member.required })),
          outcomes: definition.outcomes,
          completion: definition.completion,
          limits: definition.limits,
        };
  return ExportedTeamSchema.safeParse(shaped).data ?? null;
}

/**
 * Whether two exported teams declare the same, their names and tool
 * pools aside: a team's name is what a person calls it here, and its pool
 * belongs to the installation, as its members' runtimes and models do,
 * so a template never replaces or compares it.
 */
export function sameExportedTeam(a: ExportedTeam | null, b: ExportedTeam | null): boolean {
  if (a === null || b === null) return a === b;
  const pool = { cliTools: [], mcpServers: [], skills: [] };
  return sameValue({ ...a, name: "", toolPool: pool }, { ...b, name: "", toolPool: pool });
}

/**
 * How one agent of an exported team is bound (EO-885): to the team's own
 * agent of its kind with the same instructions (`team`, a team being
 * updated), to one of the project's ordinary agents of its kind with the
 * same instructions (`existing`, copied for the team, as every member is
 * the team's own, EO-897), or to a new agent (`create`).
 */
export interface ExportedTeamBinding {
  name: string;
  kind: string;
  binding: "team" | "existing" | "create";
  /** The agent it is bound to, or for `create` the agent of its kind its runtime, model and tools are taken from, where there is one. */
  agent: Agent | null;
}

function sameInstructions(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}

/**
 * How each agent of an exported team would be bound on a project: what
 * the import does (`teamIdForExportedTeam`) and what `pipeline_import_check`
 * says it would. `ownTeamId` is the team being changed, whose own agents
 * are offered first; `baseAgent` the agent of a kind a created one is
 * made like — the one the pipeline's steps of that kind name — falling
 * back to the kind's agent on the project. Writes nothing.
 */
export function exportedTeamBindings(
  db: Db,
  team: ExportedTeam,
  input: { projectId: string | null; ownTeamId?: string | null; baseAgent?: (kind: string) => Agent | undefined },
): ExportedTeamBinding[] {
  const roster = listAgents(db);
  const own = input.ownTeamId === null || input.ownTeamId === undefined ? [] : teamOwnedAgents(db, input.ownTeamId).filter((agent) => agent.archivedAt === null && agent.deletedAt === null);
  const taken = new Set<string>();
  const pick = (candidates: readonly Agent[], part: ExportedTeamAgent): Agent | undefined => {
    const fitting = candidates.filter((agent) => !taken.has(agent.id) && agent.role === part.kind && sameInstructions(agent.instructions, part.instructions));
    return fitting.find((agent) => exportedAgentKey(agent.name) === exportedAgentKey(part.name)) ?? fitting[0];
  };
  return exportedTeamAgents(team).map((part): ExportedTeamBinding => {
    const ownAgent = pick(own, part);
    const ordinary = ownAgent === undefined ? pick(kindCandidates(roster, part.kind, input.projectId), part) : undefined;
    const bound = ownAgent ?? ordinary;
    if (bound !== undefined) {
      taken.add(bound.id);
      return { name: part.name, kind: part.kind, binding: ownAgent !== undefined ? "team" : "existing", agent: bound };
    }
    const base = input.baseAgent?.(part.kind) ?? kindCandidates(roster, part.kind, input.projectId)[0] ?? null;
    return { name: part.name, kind: part.kind, binding: "create", agent: base };
  });
}

/** Detaches every tool a team's member has beyond the team's pool: a member the import makes has only what the team declares. */
function keepToPool(db: Db, agentId: string, pool: TeamDefinition["toolPool"]): void {
  const surface = agentToolSurfaces(db, [agentId])[agentId];
  if (surface === undefined) return;
  for (const command of surface.cliTools.filter((name) => !pool.cliTools.includes(name))) {
    const tool = db.select({ id: cliTools.id }).from(cliTools).where(eq(cliTools.command, command)).get();
    if (tool !== undefined) db.delete(agentCliTools).where(and(eq(agentCliTools.agentId, agentId), eq(agentCliTools.cliToolId, tool.id))).run();
  }
  for (const name of surface.mcpServers.filter((server) => !pool.mcpServers.includes(server))) {
    const server = db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, name)).get();
    if (server !== undefined) db.delete(agentMcpServers).where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.serverId, server.id))).run();
  }
  for (const slug of surface.skills.filter((skill) => !pool.skills.includes(skill))) {
    const skill = db.select({ id: skills.id }).from(skills).where(eq(skills.slug, slug)).get();
    if (skill !== undefined) db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, skill.id))).run();
  }
}

/**
 * An exported team as a definition of `team`'s own agents (EO-885): each
 * agent bound as `exportedTeamBindings` says — the team's own kept, an
 * ordinary one copied for the team under the document's name, a missing
 * one made like the kind's agent with the document's name and
 * instructions — and each member's tools kept to the team's pool. Null
 * where an agent can be neither bound nor made: a kind no agent here has.
 * Inside the caller's transaction.
 */
function definitionOfExportedTeam(
  db: Db,
  exported: ExportedTeam,
  team: { id: string; projectId: string | null; name: string },
  baseAgent: ((kind: string) => Agent | undefined) | undefined,
  now: number,
): TeamDefinition | null {
  const bindings = exportedTeamBindings(db, exported, { projectId: team.projectId, ownTeamId: team.id, ...(baseAgent === undefined ? {} : { baseAgent }) });
  const ids = new Map<string, string>();
  const members = new Set((exported.members as readonly ExportedTeamAgent[]).map((member) => exportedAgentKey(member.name)));
  for (const binding of bindings) {
    const part = exportedTeamAgents(exported).find((one) => exportedAgentKey(one.name) === exportedAgentKey(binding.name)) as ExportedTeamAgent;
    if (binding.agent === null) return null;
    let id: string;
    if (binding.binding === "team") id = binding.agent.id;
    else {
      const from = binding.binding === "existing" ? binding.agent : { ...binding.agent, instructions: part.instructions };
      id = copyAgentForTeam(db, { ...from, name: part.name.trim(), archivedAt: null, deletedAt: null }, team, now);
      if (members.has(exportedAgentKey(part.name))) keepToPool(db, id, exported.toolPool);
    }
    ids.set(exportedAgentKey(binding.name), id);
  }
  const definition = exportedTeamDefinition({ ...exported, name: team.name }, (part) => ids.get(exportedAgentKey(part.name)) as string);
  return TeamDefinitionSchema.safeParse(definition).data ?? null;
}

/**
 * The declared team a step that arrives with an exported team runs as
 * (EO-885): imported, installed from a template, or written by a template
 * update.
 *
 * - The team the step names, where it declares the same (its name aside).
 * - Otherwise that team changed to the document's, as a new version by
 *   EO, keeping its name and its tool pool — a template update the person had not changed
 *   the team against. Its own agents with the same kind and instructions
 *   are kept, with whatever runtime, model and reasoning a person gave
 *   them. Not a locked or archived team: that one stays as it is, and the
 *   step is given a team of its own.
 * - Otherwise a new team, under the document's name (numbered where the
 *   project has it), by EO.
 *
 * Null where the team cannot be declared: a kind no agent here has.
 */
export function teamIdForExportedTeam(
  db: Db,
  input: { pipelineId: string; team: ExportedTeam; current: string | null; baseAgent?: (kind: string) => Agent | undefined; now?: number },
): string | null {
  const pipeline = db.select({ projectId: pipelines.projectId }).from(pipelines).where(eq(pipelines.id, input.pipelineId)).get();
  if (pipeline === undefined) return null;
  const now = input.now ?? Date.now();
  if (input.current !== null && sameExportedTeam(exportedTeamOf(db, input.current), input.team)) return input.current;
  const existing = input.current === null ? undefined : getTeam(db, input.current);
  if (existing !== undefined && !existing.locked && existing.archivedAt === null && existing.projectId === pipeline.projectId) {
    // The pool is the installation's: the team keeps its own (where it has one EO can read), and new members are kept to it.
    const changed = withoutRefusedCopies(db, (inTx) => {
      const definition = definitionOfExportedTeam(inTx, { ...input.team, toolPool: existing.definition?.toolPool ?? input.team.toolPool }, existing, input.baseAgent, now);
      if (definition === null) return "cannot";
      const written = changeTeam(inTx, existing.id, { definition, author: { kind: "eo" }, now });
      return written.ok ? existing.id : null;
    });
    if (changed === "cannot") return null;
    if (changed !== null) return changed;
  }
  const id = uuidv7();
  const name = freeTeamName(db, pipeline.projectId, input.team.name);
  const created = withoutRefusedCopies(db, (inTx) => {
    const definition = definitionOfExportedTeam(inTx, input.team, { id, projectId: pipeline.projectId, name }, input.baseAgent, now);
    if (definition === null) return "cannot";
    const written = createTeam(inTx, { id, projectId: pipeline.projectId, definition, author: { kind: "eo" }, now });
    return written.ok ? written.team.id : null;
  });
  return created === "cannot" ? null : created;
}

/** A team build that came to nothing, which undoes the agents copied for it. */
class TeamBuildRefused extends Error {
  constructor(readonly answer: "cannot" | null) {
    super("a team build was refused");
  }
}

/**
 * Runs one team build in a transaction of its own (a savepoint inside the
 * caller's), so that where it comes to nothing — no agent for a kind
 * (`"cannot"`), or the team refused (`null`) — the agents copied for it
 * are not left behind unused.
 */
function withoutRefusedCopies(db: Db, build: (inTx: Db) => string | "cannot" | null): string | "cannot" | null {
  try {
    return db.transaction((tx) => {
      const answer = build(tx as unknown as Db);
      if (answer === null || answer === "cannot") throw new TeamBuildRefused(answer);
      return answer;
    });
  } catch (error) {
    if (error instanceof TeamBuildRefused) return error.answer;
    throw error;
  }
}

/**
 * The declared team a step carrying a team inline runs as: a role-staffed
 * one as before EO-881 (`teamIdForInlineTeam`), or a document's declared
 * one (`teamIdForExportedTeam`, EO-885), whose created agents are made like
 * the agent this graph's steps of their kind name (`stepAgentIds`).
 */
export function teamIdForCarriedTeam(
  db: Db,
  input: { pipelineId: string; stepName: string; team: StepTeam | ExportedTeam; current: string | null; stepAgentIds?: readonly (string | null | undefined)[]; now?: number },
): string | null {
  if (!isExportedTeam(input.team)) return teamIdForInlineTeam(db, { pipelineId: input.pipelineId, stepName: input.stepName, team: input.team, current: input.current, ...(input.now === undefined ? {} : { now: input.now }) });
  const named = (input.stepAgentIds ?? []).flatMap((id) => (id === null || id === undefined ? [] : (getAgent(db, id as Uuid) ?? [])));
  const baseAgent = (kind: string) => named.find((agent) => agent.role === kind && !isTeamOwned(agent) && agent.archivedAt === null && agent.deletedAt === null);
  return teamIdForExportedTeam(db, { pipelineId: input.pipelineId, team: input.team, current: input.current, baseAgent, ...(input.now === undefined ? {} : { now: input.now }) });
}
