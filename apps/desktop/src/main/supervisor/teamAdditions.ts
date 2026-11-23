import type { Agent, MemberAdditionOffer, NewTeamMember, Uuid } from "@eo/core";
import { checkMemberAdditions, type AcceptedMemberAddition } from "@eo/engine";
import type { Db } from "../db/client.js";
import { createAgent, getAgent, listAgents } from "../db/repos/agentsRepo.js";
import { setAgentAttachment } from "../db/repos/agentAttachmentsRepo.js";
import { getCliToolByCommand, setAgentCliTool } from "../db/repos/cliToolsRepo.js";
import { getMcpServerByName } from "../db/repos/mcpServersRepo.js";
import { getSkillBySlug } from "../db/repos/skillsRepo.js";
import { changeTeam, getTeam } from "../db/repos/teamsRepo.js";
import { foldCase } from "../db/textFold.js";
import { reasoningEffortConfig } from "../providers/smallModels.js";

/**
 * A leader adding a member to its declared team (EO-883, ARCHITECTURE.md
 * §4.2a): checked against what a person declared on the team
 * (`checkMemberAdditions`), then created as a real agent of the team's
 * member kind with only tools from the team's pool, and added to the team
 * as a new version recorded as the leader's, on the item it was added for.
 *
 * The leader's own agent is never touched (invariant 11): what it may do
 * is pick from the pool and the range, nothing more.
 */

/** A member a leader added: the agent EO created, and what was asked for. */
export interface AddedMember {
  agent: Agent;
  addition: AcceptedMemberAddition;
}

/** The kinds of a team's members, in its order. */
function memberKinds(db: Db, agentIds: readonly string[]): string[] {
  return [...new Set(agentIds.flatMap((agentId) => getAgent(db, agentId as Uuid)?.role ?? []))];
}

/**
 * What a leader's turn may add a member from, or null where no addition
 * could be accepted: a team that is not leader-led, is locked, is at its
 * cap, or whose range lacks a runtime, a model or a reasoning level.
 */
export function memberAdditionOffer(db: Db, teamId: string | null | undefined): MemberAdditionOffer | null {
  if (teamId === null || teamId === undefined) return null;
  const team = getTeam(db, teamId);
  const definition = team?.definition ?? null;
  if (team === undefined || definition === null || definition.coordination !== "leader" || team.locked) return null;
  const room = definition.memberCap - definition.members.length;
  const { runtimes, models, reasoning } = definition.modelRange;
  if (room <= 0 || runtimes.length === 0 || models.length === 0 || reasoning.length === 0) return null;
  const kinds = memberKinds(
    db,
    definition.members.map((member) => member.agentId),
  );
  if (kinds.length === 0) return null;
  return { kinds, pool: definition.toolPool, range: definition.modelRange, room };
}

/**
 * Adds the members a leader asked for to its team, or refuses each with
 * a sentence. Synchronous and on `db`, so the caller can hold it in the
 * transaction that keeps the leader's answer: a turn that turns out late
 * then creates nothing. Every accepted member is created and attached to
 * its tools, and the team gets a new version for it, by the leader.
 */
export function addLeaderMembers(
  db: Db,
  input: { teamId: string | null | undefined; leaderAgentId: string; itemId: string; additions: readonly NewTeamMember[]; now: number },
): { added: AddedMember[]; refused: { key: string; reason: string }[] } {
  const added: AddedMember[] = [];
  if (input.additions.length === 0) return { added, refused: [] };
  const refuseAll = (reason: string) => ({ added, refused: input.additions.map((addition) => ({ key: `new member "${addition.name}"`, reason })) });
  const team = input.teamId === null || input.teamId === undefined ? undefined : getTeam(db, input.teamId);
  if (team === undefined || team.definition === null) return refuseAll("EO did not add it, and created nothing: EO cannot read the team this step runs as, so it cannot add a member to it.");

  const taken = new Set(listAgents(db).flatMap((agent) => (agent.deletedAt === null ? [foldCase(agent.name.trim())] : [])));
  const checked = checkMemberAdditions(
    team.definition,
    {
      locked: team.locked,
      memberKinds: memberKinds(
        db,
        team.definition.members.map((member) => member.agentId),
      ),
      nameTaken: (name) => taken.has(foldCase(name.trim())),
    },
    input.additions,
  );
  const refused = [...checked.refused];

  let definition = team.definition;
  for (const addition of checked.accepted) {
    // Each tool as the catalogue has it: a pool may name one this
    // installation does not have, and an attachment needs the row.
    const cliToolIds: string[] = [];
    const serverIds: string[] = [];
    const skillIds: string[] = [];
    const missing: string[] = [];
    for (const command of addition.tools.cliTools) {
      const tool = getCliToolByCommand(db, command);
      if (tool === undefined || tool.archivedAt !== null) missing.push(`the CLI tool "${command}"`);
      else cliToolIds.push(tool.id);
    }
    for (const name of addition.tools.mcpServers) {
      const server = getMcpServerByName(db, name);
      if (server === undefined) missing.push(`the MCP server "${name}"`);
      else serverIds.push(server.id);
    }
    for (const slug of addition.tools.skills) {
      const skill = getSkillBySlug(db, slug);
      if (skill === undefined) missing.push(`the skill "${slug}"`);
      else skillIds.push(skill.id);
    }
    const config = reasoningEffortConfig(addition.runtime, addition.reasoning);
    const problems = [
      ...(missing.length === 0 ? [] : [`the team's pool names ${missing.join(", ")}, which EO does not have`]),
      ...(config === null ? [`EO sets no reasoning effort on the runtime "${addition.runtime}"`] : []),
    ];
    if (problems.length > 0) {
      refused.push({ key: `new member "${addition.name}"`, reason: `EO did not add it, and created nothing: ${problems.join("; ")}.` });
      continue;
    }

    const agent = createAgent(db, {
      name: addition.name.trim(),
      role: addition.kind,
      provider: addition.runtime,
      model: addition.model,
      instructions: addition.instructions,
      config: config ?? {},
      projectId: team.projectId as Uuid | null,
    });
    for (const cliToolId of cliToolIds) setAgentCliTool(db, { agentId: agent.id, cliToolId, attached: true }, input.now);
    for (const id of serverIds) setAgentAttachment(db, { agentId: agent.id, kind: "mcpServer", id, attached: true }, input.now);
    for (const id of skillIds) setAgentAttachment(db, { agentId: agent.id, kind: "skill", id, attached: true }, input.now);

    definition = { ...definition, members: [...definition.members, { agentId: agent.id }] } as typeof definition;
    const written = changeTeam(db, team.id, { definition, author: { kind: "leader", agentId: input.leaderAgentId, itemId: input.itemId }, now: input.now });
    // Checked above in the same transaction, so nothing can have changed
    // in between: a refusal here is EO's own mistake.
    if (!written.ok) throw new Error(`EO could not add "${agent.name}" to the team "${team.name}": ${written.reason}`);
    added.push({ agent, addition });
  }
  return { added, refused };
}

/** The comment that announces a member a leader added, on the item it was added for. */
export function memberAddedNote(teamName: string, leaderName: string, member: AddedMember): string {
  const { agent, addition } = member;
  const list = (names: readonly string[]) => (names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", "));
  return [
    `${leaderName} added a member to the team "${teamName}": **${agent.name}**, a ${agent.role} agent on ${addition.runtime}, model ${addition.model}, reasoning ${addition.reasoning}.`,
    "",
    `**Tools:** CLI tools ${list(addition.tools.cliTools)}; MCP servers ${list(addition.tools.mcpServers)}; skills ${list(addition.tools.skills)}.`,
    "",
    "**Instructions:**",
    "",
    addition.instructions
      .trim()
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
    "It is a member of the team from now on. A person can remove it through the assistant, or restore a version of the team from before it was added.",
  ].join("\n");
}
