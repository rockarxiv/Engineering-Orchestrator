import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  DEFAULT_TEAM_MEMBER_CAP,
  generatedTeamName,
  TeamDefinitionSchema,
  stepTeamOf,
  staffingAgents,
  storedTeamDefinition,
  teamAgentIds,
  uuidv7,
} from "@eo/core";
import type { Agent, StepTeam, TeamAuthor, TeamDefinition, TeamSave, TeamVersion, Uuid } from "@eo/core";
import type { AgentToolSurface, PipelineTeamFacts } from "@eo/engine";
import type { Db } from "../client.js";
import { foldCase } from "../textFold.js";
import { listAgents } from "./agentsRepo.js";
import { agentReasoningEffort } from "../../providers/smallModels.js";
import { agentCliTools, agentMcpServers, agentSkills, agents, cliTools, mcpServers, pipelineSteps, pipelines, skills, teamVersions, teams } from "../schema.js";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTeam(db: Db, id: string): StoredTeam | undefined {
  const row = db.select().from(teams).where(eq(teams.id, id)).get();
  return row === undefined ? undefined : toTeam(row);
}

/** A project's teams, by name; `null` for the teams of pipelines on no project. */
export function listTeams(db: Db, projectId: string | null): StoredTeam[] {
  return db
    .select()
    .from(teams)
    .where(projectId === null ? isNull(teams.projectId) : eq(teams.projectId, projectId))
    .orderBy(asc(teams.name), asc(teams.id))
    .all()
    .map(toTeam);
}

/** Every team, whichever project it is on. */
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
  return { authorKind: author.kind, authorId: null, authorItemId: null };
}

function authorOf(row: typeof teamVersions.$inferSelect): TeamAuthor {
  if (row.authorKind === "person") return { kind: "person", personId: row.authorId };
  if (row.authorKind === "leader") return { kind: "leader", agentId: row.authorId ?? "", itemId: row.authorItemId ?? "" };
  if (row.authorKind === "assistant") return { kind: "assistant" };
  return { kind: "eo" };
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
      return [{ id: row.id, teamId: row.teamId, number: row.number, definition, author: authorOf(row), restoredFrom: row.restoredFrom, createdAt: row.createdAt }];
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

function nameTaken(db: Db, projectId: string | null, name: string, except: string | null): boolean {
  const other = teamByName(db, projectId, name);
  return other !== undefined && other.id !== except;
}

/** Writes a version row and points the team at it. Inside the caller's transaction. */
function writeVersion(db: Db, teamId: string, number: number, definition: TeamDefinition, author: TeamAuthor, restoredFrom: number | null, now: number): void {
  db.insert(teamVersions)
    .values({ id: uuidv7(), teamId, number, definition, ...authorColumns(author), restoredFrom, createdAt: now })
    .run();
}

/**
 * Declares a team: a new row and its first version. Refused where the
 * project already has a team of that name — a draft names teams by name.
 */
export function createTeam(
  db: Db,
  input: { id?: string; projectId: string | null; definition: TeamDefinition; author: TeamAuthor; now?: number },
): TeamWrite {
  const definition = TeamDefinitionSchema.parse(input.definition);
  if (nameTaken(db, input.projectId, definition.name, null)) return { ok: false, reason: `This project already has a team called "${definition.name}".` };
  const now = input.now ?? Date.now();
  const id = input.id ?? uuidv7();
  return db.transaction((tx) => {
    tx.insert(teams).values({ id, projectId: input.projectId, name: definition.name, definition, locked: false, version: 1, createdAt: now, updatedAt: now }).run();
    writeVersion(tx as unknown as Db, id, 1, definition, input.author, null, now);
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
export function changeTeam(db: Db, id: string, input: { definition: TeamDefinition; author: TeamAuthor; now?: number; restoredFrom?: number }): TeamWrite {
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  const definition = TeamDefinitionSchema.parse(input.definition);
  // Writing what it already is changes nothing, so a locked team allows it.
  if (input.restoredFrom === undefined && sameDefinition(team.definition, definition)) return { ok: true, team, changed: false };
  if (team.locked) return { ok: false, reason: `The team "${team.name}" is locked: a person must unlock it before it can change.` };
  if (nameTaken(db, team.projectId, definition.name, id)) return { ok: false, reason: `This project already has a team called "${definition.name}".` };
  const now = input.now ?? Date.now();
  return db.transaction((tx) => {
    const number = team.version + 1;
    writeVersion(tx as unknown as Db, id, number, definition, input.author, input.restoredFrom ?? null, now);
    tx.update(teams).set({ name: definition.name, definition, version: number, updatedAt: now }).where(eq(teams.id, id)).run();
    touchPipelinesNaming(tx as unknown as Db, id, now);
    return { ok: true, team: getTeam(tx as unknown as Db, id) as StoredTeam, changed: true };
  });
}

/**
 * Puts an earlier version of a team back, as a person (EO-881): itself a
 * new version, recording the one it restored. Refused for a locked team.
 */
export function restoreTeamVersion(db: Db, id: string, number: number, person: { personId: string | null; now?: number }): TeamWrite {
  const version = listTeamVersions(db, id).find((one) => one.number === number);
  if (version === undefined) return { ok: false, reason: `That team has no version ${number}.` };
  return changeTeam(db, id, { definition: version.definition, author: { kind: "person", personId: person.personId }, restoredFrom: number, ...(person.now === undefined ? {} : { now: person.now }) });
}

/**
 * Locks or unlocks a team, as a person. A lock is a guard on the team, not
 * a change to what it is, so it writes no version; while it holds, every
 * change but unlocking is refused.
 */
export function setTeamLocked(db: Db, id: string, locked: boolean, now: number = Date.now()): TeamWrite {
  const team = getTeam(db, id);
  if (team === undefined) return { ok: false, reason: "That team no longer exists." };
  if (team.locked === locked) return { ok: true, team, changed: false };
  db.transaction((tx) => {
    tx.update(teams).set({ locked, updatedAt: now }).where(eq(teams.id, id)).run();
    touchPipelinesNaming(tx as unknown as Db, id, now);
  });
  return { ok: true, team: getTeam(db, id) as StoredTeam, changed: true };
}

/** Removes a project's teams, for `deleteProject`, letting go of the steps that name them first. Their versions go with them. */
export function deleteProjectTeams(db: Db, projectId: string): void {
  const ids = db.select({ id: teams.id }).from(teams).where(eq(teams.projectId, projectId)).all().map((row) => row.id);
  if (ids.length === 0) return;
  db.update(pipelineSteps).set({ teamId: null }).where(inArray(pipelineSteps.teamId, ids)).run();
  db.delete(teams).where(inArray(teams.id, ids)).run();
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
 * reads them, with those a save declares laid over them (by id), and what
 * each agent they name may use.
 */
export function teamsForValidation(db: Db, projectId: string | null, declared: readonly TeamSave[] = []): { teams: PipelineTeamFacts[]; surfaces: Record<string, AgentToolSurface> } {
  const byId = new Map<string, PipelineTeamFacts>();
  for (const team of listAllTeams(db)) byId.set(team.id, { id: team.id, name: team.name, projectId: team.projectId, definition: team.definition });
  for (const team of declared) {
    const stored = byId.get(team.id);
    byId.set(team.id, { id: team.id, name: team.definition.name, projectId: stored?.projectId ?? projectId, definition: team.definition });
  }
  const list = [...byId.values()];
  const agentIds = list.flatMap((team) => (team.definition === null ? [] : teamAgentIds(team.definition)));
  return { teams: list, surfaces: agentToolSurfaces(db, agentIds) };
}

/**
 * Reads declared teams as the role-staffed shape a session runs
 * (`stepTeamOf`), one team at a time and each once. For step reads: a
 * step's `team` is its declared team read this way.
 */
export function teamReader(db: Db, declared: readonly TeamSave[] = []): (teamId: string | null) => StepTeam | null {
  const read = new Map<string, StepTeam | null>();
  const overlay = new Map(declared.map((team) => [team.id, team.definition]));
  return (teamId) => {
    if (teamId === null) return null;
    const known = read.get(teamId);
    if (known !== undefined) return known;
    // A team the save declares is read as it would be written (EO-881).
    const definition = overlay.get(teamId) ?? getTeam(db, teamId)?.definition ?? null;
    let shaped: StepTeam | null = null;
    if (definition !== null) {
      const ids = teamAgentIds(definition);
      const kinds = new Map(db.select({ id: agents.id, role: agents.role }).from(agents).where(inArray(agents.id, ids)).all().map((row) => [row.id, row.role]));
      shaped = stepTeamOf(definition, (agentId) => kinds.get(agentId));
    }
    read.set(teamId, shaped);
    return shaped;
  };
}

/** The agent a role is bound to on a project: EO-874's staffing rule first, then any agent that held the role there. */
function boundAgent(all: readonly Agent[], role: string, projectId: string | null): Agent | undefined {
  const staffed = staffingAgents(all, role, { projectId: projectId as Uuid | null, previewAt: null });
  if (staffed.length > 0) return staffed[0];
  const held = all.filter((agent) => agent.role === role && (agent.projectId === null || agent.projectId === projectId));
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
    copies.set(team.id, { id, definition: { ...team.definition, name } });
    if (!claimed) sources[id] = source;
  }
  return { teams: [...copies.values()], teamIdOf: (teamId) => (teamId === null || teamId === undefined ? teamId : (copies.get(teamId)?.id ?? teamId)), sources };
}

/** Marks a team as a trial's own copy of a draft's team (`trialTeams`). Inside the save's transaction. */
export function claimTrialTeam(db: Db, teamId: string, trialPipelineId: string, source: string): void {
  db.update(teams).set({ trialPipelineId, trialSource: source }).where(eq(teams.id, teamId)).run();
}
