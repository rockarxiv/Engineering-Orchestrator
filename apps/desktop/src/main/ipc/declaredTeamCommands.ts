import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { backendAllowed, bindingRefusal, storedTeamDefinition, teamAgentIds } from "@eo/core";
import type { Agent, IpcPayload, IpcResponse, RuntimeStatusView, TeamAuthor, TeamDefinition, TeamMemberOrigin, TeamMemberView, TeamVersion, TeamVersionView, TeamView, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { items, people, projects, teams } from "../db/schema.js";
import { getAgent, listAgents } from "../db/repos/agentsRepo.js";
import { archiveTeam, deleteTeam, getTeam, listTeamVersions, memberSettingsOf, restoreTeamVersion, setTeamLocked, setTeamMemberSettings, setTeamMembersSettings, stepsNamingTeam, teamOwnedAgents, type StoredTeam } from "../db/repos/teamsRepo.js";
import { foldCase } from "../db/textFold.js";
import { RUNTIMES } from "../runtimes/catalog.js";
import { stepsInWords, stepsNamingTeams } from "./configCommands.js";
import { readPolicy } from "../policy/policy.js";
import { agentReasoningEffort } from "../providers/smallModels.js";
import { actingCaller } from "../identity/acting.js";

/**
 * The Teams tab in the Agents section (EO-884): every declared team read
 * whole, and the three things a person does to one there — changing a
 * member's runtime, model and reasoning, restoring a version, and locking
 * it. A team's instructions and membership are not changed here: only the
 * assistant's draft, published by a person, or a leader adding a member
 * changes them (EO-880).
 */

/** Who first put each agent on the team: the author of the earliest version naming it. */
function originsOf(versions: readonly TeamVersion[], keyOf: (itemId: string) => string | null, nameOf: (personId: string | null) => string | null): Map<string, TeamMemberOrigin> {
  const origins = new Map<string, TeamMemberOrigin>();
  for (const version of versions) {
    for (const agentId of teamAgentIds(version.definition)) {
      if (origins.has(agentId)) continue;
      const author = version.author;
      origins.set(
        agentId,
        author.kind === "leader"
          ? { kind: "leader", itemId: author.itemId, itemKey: keyOf(author.itemId) }
          : author.kind === "person"
            ? { kind: "person", personName: nameOf(author.personId) }
            : { kind: author.kind },
      );
    }
  }
  return origins;
}

function memberView(agentId: string, agent: Agent | undefined, team: { instructions: string | null; key: string | null }, addedBy: TeamMemberOrigin | undefined): TeamMemberView {
  return {
    agentId,
    name: agent?.name ?? null,
    kind: agent?.role ?? null,
    provider: agent?.provider ?? null,
    model: agent?.model ?? null,
    reasoning: agent === undefined ? null : agentReasoningEffort(agent),
    instructions: agent?.instructions ?? "",
    teamInstructions: team.instructions,
    key: team.key,
    archived: agent === undefined || agent.archivedAt !== null || agent.deletedAt !== null,
    // A team always has a version naming each of its agents; EO's own for one that somehow does not.
    addedBy: addedBy ?? { kind: "eo" },
  };
}

function definitionParts(definition: TeamDefinition, agentOf: (id: string) => Agent | undefined, origins: Map<string, TeamMemberOrigin>): Pick<TeamView, "leader" | "members"> {
  if (definition.coordination === "leader") {
    return {
      leader: memberView(definition.leader.agentId, agentOf(definition.leader.agentId), { instructions: definition.leader.instructions, key: null }, origins.get(definition.leader.agentId)),
      members: definition.members.map((member) => memberView(member.agentId, agentOf(member.agentId), { instructions: null, key: null }, origins.get(member.agentId))),
    };
  }
  return {
    leader: null,
    members: definition.members.map((member) => memberView(member.agentId, agentOf(member.agentId), { instructions: member.instructions, key: member.key }, origins.get(member.agentId))),
  };
}

/** Every declared team but a trial's own copies, as the Teams tab draws them. */
export function listTeamViews(db: Db): TeamView[] {
  // An archived team has left the tab (EO-897), and is not brought back.
  const rows = db.select().from(teams).where(and(isNull(teams.trialPipelineId), isNull(teams.archivedAt))).orderBy(asc(teams.name), asc(teams.id)).all();
  if (rows.length === 0) return [];
  const agents = new Map(listAgents(db).map((agent) => [agent.id as string, agent]));
  const projectNames = new Map(db.select({ id: projects.id, name: projects.name }).from(projects).all().map((row) => [row.id, row.name]));
  const personNames = new Map(db.select({ id: people.id, name: people.name }).from(people).all().map((row) => [row.id, row.name]));
  const versionsOf = new Map(rows.map((row) => [row.id, listTeamVersions(db, row.id)]));
  const itemIds = [...new Set([...versionsOf.values()].flat().flatMap((version) => (version.author.kind === "leader" ? [version.author.itemId] : [])))];
  const itemKeys = new Map(itemIds.length === 0 ? [] : db.select({ id: items.id, key: items.key }).from(items).where(inArray(items.id, itemIds)).all().map((row) => [row.id, row.key]));
  const keyOf = (itemId: string) => itemKeys.get(itemId) ?? null;
  const nameOf = (personId: string | null) => (personId === null ? null : (personNames.get(personId) ?? null));

  return rows.map((row): TeamView => {
    const definition = storedTeamDefinition(row.definition);
    const versions = versionsOf.get(row.id) ?? [];
    const origins = originsOf(versions, keyOf, nameOf);
    const versionViews = versions
      .map(
        (version): TeamVersionView => ({
          number: version.number,
          author: version.author,
          authorName:
            version.author.kind === "person"
              ? nameOf(version.author.personId)
              : version.author.kind === "leader" || version.author.kind === "system"
                ? (agents.get(version.author.agentId)?.name ?? null)
                : null,
          itemKey: version.author.kind === "leader" ? keyOf(version.author.itemId) : null,
          restoredFrom: version.restoredFrom,
          note: version.note,
          createdAt: version.createdAt,
        }),
      )
      .reverse();
    return {
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectId === null ? null : (projectNames.get(row.projectId) ?? null),
      name: row.name,
      locked: row.locked,
      version: row.version,
      coordination: definition?.coordination ?? null,
      memberMode: definition?.memberMode ?? null,
      memberCap: definition?.memberCap ?? null,
      toolPool: definition?.toolPool ?? null,
      modelRange: definition?.modelRange ?? null,
      limits: definition === null ? null : Object.fromEntries(Object.entries(definition.limits).filter((entry): entry is [string, number] => typeof entry[1] === "number")),
      ...(definition === null ? { leader: null, members: [] } : definitionParts(definition, (id) => agents.get(id), origins)),
      steps: stepsNamingTeam(db, row.id),
      versions: versionViews,
    };
  });
}

export function listTeamsCommand(db: Db): IpcResponse<"teams:list"> {
  return { teams: listTeamViews(db) };
}

/**
 * Whether a team exists and is one the Teams tab shows — never a trial's
 * copy, which nobody restores or locks, nor an archived team (EO-897),
 * which has left the tab.
 */
function shownTeam(db: Db, teamId: string): StoredTeam | undefined {
  const team = getTeam(db, teamId);
  if (team === undefined || team.archivedAt !== null) return undefined;
  const row = db.select({ trial: teams.trialPipelineId }).from(teams).where(eq(teams.id, teamId)).get();
  return row?.trial === null || row?.trial === undefined ? team : undefined;
}

/**
 * A backend the organisation does not allow, among those a write would put
 * a member on (EO-328): asked as `agents:setBinding` asks, of a member it
 * would move to another backend only, so a member already on one is not
 * stranded.
 */
function disallowedBackend(db: Db, moves: readonly { agentId: string; provider: string }[]): string | null {
  const policy = readPolicy(db);
  const current = memberSettingsOf(
    db,
    moves.map((move) => move.agentId),
  );
  const refused = moves.find((move) => current[move.agentId] !== undefined && current[move.agentId]?.provider !== move.provider && !backendAllowed(policy, move.provider));
  return refused === undefined ? null : bindingRefusal({ provider: refused.provider, policy });
}

export function setTeamMemberSettingsCommand(db: Db, input: IpcPayload<"teams:setMemberSettings">): IpcResponse<"teams:setMemberSettings"> {
  if (shownTeam(db, input.teamId) === undefined) return { saved: false, problem: "That team no longer exists." };
  const refused = disallowedBackend(db, [{ agentId: input.agentId, provider: input.provider }]);
  if (refused !== null) return { saved: false, problem: refused };
  const caller = actingCaller(db, input.actingDeviceId);
  const result = setTeamMemberSettings(db, input.teamId, input.agentId, { provider: input.provider, model: input.model, reasoning: input.reasoning }, { personId: caller.person?.id ?? null });
  return result.ok ? { saved: result.changed, problem: null } : { saved: false, problem: result.reason };
}

/**
 * What this machine says of a runtime, for a change that would put team
 * members on it (EO-900): null for one that runs inside EO and has no CLI
 * (`fake`). Asked of EO's managed copy, as the Teams tab asks.
 */
export type RuntimeReadiness = (provider: string) => Promise<RuntimeStatusView | null>;

/** The runtimes a member may be put on: every one EO manages, and the one built in. */
const KNOWN_RUNTIMES: readonly string[] = [...Object.keys(RUNTIMES), "fake"];

/**
 * What the Teams tab says under a member's runtime where this machine
 * cannot run it, said back for a change that put `count` members on it
 * anyway (EO-900), or null where it can. Neither the tab nor the tool
 * refuses it: the setting is the team's, and the machine is only where it
 * runs now. A runtime with no CLI (`fake`) is never said.
 */
export function runtimeReadinessNote(runtime: RuntimeStatusView | null, count: number): string | null {
  if (runtime === null) return null;
  const who = count === 1 ? "this member cannot" : "these members cannot";
  if (runtime.source === "absent") return `${runtime.label} is not installed on this machine, so ${who} run here until somebody installs it on the Runtimes tab.`;
  if (runtime.path === null) return `${runtime.label} is turned off on this machine, so ${who} run here until somebody turns it on on the Runtimes tab.`;
  if (runtime.auth.state === "signed_out") return `This machine is not signed in to ${runtime.label}, so ${who} run here until somebody signs in on the Runtimes tab.`;
  return null;
}

/**
 * One or more members of a declared team set to a runtime, model and
 * reasoning through EO's tools (EO-900): the Teams tab's change, under the
 * Teams tab's rules, for several members at once and as one version. The
 * members are named by their names within the team, the leader's
 * included. Refused whole, nothing written, for a team that is not shown
 * there, a locked team, a name that is no member, a runtime EO has none
 * of, a backend the organisation does not allow, or whatever the write
 * itself refuses. The team's model range is not asked: it bounds only the
 * members a leader adds (docs/teams.md). A runtime this machine has not
 * installed or is not signed in to is saved, and said back as `note`, as
 * the tab says it under the picker. The version is the system agent's
 * where the administrative host stamped one, an outside client's where
 * the MCP tool said so, a person's otherwise.
 */
export async function setTeamMembersSettingsCommand(db: Db, input: IpcPayload<"teams:setMembersSettings">, readiness: RuntimeReadiness): Promise<IpcResponse<"teams:setMembersSettings">> {
  const refuse = (problem: string, version: number | null) => ({ saved: false, changed: [], version, problem, note: null });
  const team = shownTeam(db, input.teamId);
  if (team === undefined) return refuse("That team no longer exists.", null);
  if (team.locked) return refuse(`The team "${team.name}" is locked: a person must unlock it before it can change.`, team.version);
  const definition = team.definition;
  if (definition === null) return refuse(`EO cannot read what the team "${team.name}" declares, so it cannot change a member of it.`, team.version);

  // Its members by name, the leader's included — once each, as the Teams tab lists them.
  const named = new Map<string, { agentId: string; name: string }>();
  for (const agentId of teamAgentIds(definition)) {
    const agent = getAgent(db, agentId as Uuid);
    if (agent !== undefined && agent.deletedAt === null && !named.has(foldCase(agent.name.trim()))) named.set(foldCase(agent.name.trim()), { agentId, name: agent.name });
  }
  const unknown = input.members.filter((name) => !named.has(foldCase(name.trim())));
  if (unknown.length > 0) {
    const listed = [...named.values()].map((member) => `"${member.name}"`).join(", ");
    return refuse(`${unknown.map((name) => `"${name.trim()}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not on the team "${team.name}", whose leader and members are ${listed || "none"}. Nothing has changed.`, team.version);
  }
  const targets = [...new Map(input.members.map((name) => named.get(foldCase(name.trim())) as { agentId: string; name: string }).map((member) => [member.agentId, member])).values()];

  const provider = input.provider.trim();
  if (!KNOWN_RUNTIMES.includes(provider)) return refuse(`EO has no runtime called "${provider}": a member runs on one of ${KNOWN_RUNTIMES.map((id) => `"${id}"`).join(", ")}. Nothing has changed.`, team.version);
  const settings = { provider, model: input.model === null || input.model.trim() === "" ? null : input.model.trim(), reasoning: input.reasoning === null || input.reasoning.trim() === "" ? null : input.reasoning.trim() };
  const disallowed = disallowedBackend(
    db,
    targets.map((member) => ({ agentId: member.agentId, provider })),
  );
  if (disallowed !== null) return refuse(disallowed, team.version);
  const note = runtimeReadinessNote(await readiness(provider), targets.length);

  const author: TeamAuthor =
    input.actingAgentId !== undefined
      ? { kind: "system", agentId: input.actingAgentId }
      : input.throughClient === true
        ? { kind: "client" }
        : { kind: "person", personId: actingCaller(db, input.actingDeviceId).person?.id ?? null };
  const before = memberSettingsOf(
    db,
    targets.map((member) => member.agentId),
  );
  // Asked again after the wait for the runtime: a person may have locked or changed the team meanwhile, and the write refuses what it must.
  const result = setTeamMembersSettings(
    db,
    team.id,
    targets.map((member) => member.agentId),
    settings,
    { author },
  );
  if (!result.ok) return refuse(result.reason, getTeam(db, team.id)?.version ?? null);
  const after = memberSettingsOf(
    db,
    targets.map((member) => member.agentId),
  );
  const changed = targets.filter((member) => JSON.stringify(before[member.agentId]) !== JSON.stringify(after[member.agentId])).map((member) => member.name);
  return { saved: true, changed, version: result.team.version, problem: null, note };
}

export function restoreTeamCommand(db: Db, input: IpcPayload<"teams:restore">): IpcResponse<"teams:restore"> {
  if (shownTeam(db, input.teamId) === undefined) return { restored: false, problem: "That team no longer exists." };
  const version = listTeamVersions(db, input.teamId).find((one) => one.number === input.version);
  const refused = disallowedBackend(
    db,
    Object.entries(version?.memberSettings ?? {}).map(([agentId, settings]) => ({ agentId, provider: settings.provider })),
  );
  if (refused !== null) return { restored: false, problem: refused };
  const caller = actingCaller(db, input.actingDeviceId);
  const result = restoreTeamVersion(db, input.teamId, input.version, { personId: caller.person?.id ?? null });
  return result.ok ? { restored: true, problem: null } : { restored: false, problem: result.reason };
}

export function setTeamLockedCommand(db: Db, input: IpcPayload<"teams:setLocked">): IpcResponse<"teams:setLocked"> {
  if (shownTeam(db, input.teamId) === undefined) return { changed: false, problem: "That team no longer exists." };
  const result = setTeamLocked(db, input.teamId, input.locked);
  return result.ok ? { changed: result.changed, problem: null } : { changed: false, problem: result.reason };
}

/**
 * Why a team cannot be archived or deleted yet (EO-897), or null: a lock a
 * person set, or the steps that name it — in a pipeline's current graph or
 * an older version items still run on — said as archiving an agent says
 * them, with what clears each.
 */
function teamRemovalRefusal(db: Db, team: StoredTeam, removal: "archive" | "delete"): string | null {
  const done = removal === "archive" ? "archived" : "deleted";
  if (team.locked) return `The team "${team.name}" is locked: a person must unlock it before it can be ${done}.`;
  const steps = stepsNamingTeams(db).get(team.id) ?? [];
  if (steps.length === 0) return null;
  const current = steps.filter((step) => step.version === null);
  const older = steps.filter((step) => step.version !== null);
  const remedies = [
    ...(current.length === 0 ? [] : [`have ${stepsInWords(current)} run as another team, or as none`]),
    ...(older.length === 0 ? [] : [`let the items still on ${older.length === 1 ? "that older version" : "those older versions"} finish, or move them to the current version`]),
  ];
  const first = remedies.join(", and ");
  return (
    `The team "${team.name}" cannot be ${done} while ${stepsInWords(steps)} ${steps.length === 1 ? "names" : "name"} it. ` +
    `${first.charAt(0).toUpperCase()}${first.slice(1)} first, then ${removal} it.`
  );
}

/** The names of the team's own agents that go with it: those not already archived or deleted. */
function goingWith(db: Db, teamId: string, removal: "archive" | "delete"): string[] {
  return teamOwnedAgents(db, teamId)
    .filter((agent) => agent.deletedAt === null && (removal === "delete" || agent.archivedAt === null))
    .map((agent) => agent.name);
}

/**
 * A person archiving one team (EO-897): one-way, its own agents archived
 * with it. Refused while it is locked or a step names it; unconfirmed, it
 * archives nothing and answers with the agents that would go with it.
 */
export function archiveTeamCommand(db: Db, input: IpcPayload<"teams:archive">): IpcResponse<"teams:archive"> {
  const team = getTeam(db, input.teamId);
  if (team === undefined || shownOrArchived(db, team) === undefined) return { archived: false, problem: "That team no longer exists.", members: [] };
  if (team.archivedAt !== null) return { archived: true, problem: null, members: [] };
  const members = goingWith(db, team.id, "archive");
  const refused = teamRemovalRefusal(db, team, "archive");
  if (refused !== null) return { archived: false, problem: refused, members };
  if (!input.confirm) return { archived: false, problem: null, members };
  if (!archiveTeam(db, team.id)) return { archived: false, problem: "That team no longer exists.", members: [] };
  return { archived: true, problem: null, members };
}

/**
 * A person deleting one team (EO-897), archived or not: it and its
 * versions go, its own agents left as tombstones. Refused and confirmed as
 * `archiveTeamCommand` is.
 */
export function deleteTeamCommand(db: Db, input: IpcPayload<"teams:delete">): IpcResponse<"teams:delete"> {
  const team = getTeam(db, input.teamId);
  if (team === undefined || shownOrArchived(db, team) === undefined) return { deleted: false, problem: "That team no longer exists.", members: [] };
  const members = goingWith(db, team.id, "delete");
  const refused = teamRemovalRefusal(db, team, "delete");
  if (refused !== null) return { deleted: false, problem: refused, members };
  if (!input.confirm) return { deleted: false, problem: null, members };
  if (!deleteTeam(db, team.id)) return { deleted: false, problem: "That team no longer exists.", members: [] };
  return { deleted: true, problem: null, members };
}

/** A team a person may archive or delete: any but a trial's own copy, which goes with its trial. */
function shownOrArchived(db: Db, team: StoredTeam): StoredTeam | undefined {
  const row = db.select({ trial: teams.trialPipelineId }).from(teams).where(eq(teams.id, team.id)).get();
  return row?.trial === null || row?.trial === undefined ? team : undefined;
}
