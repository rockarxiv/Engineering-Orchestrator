import { and, eq, sql } from "drizzle-orm";
import { skillsForRun, type AgentAttachments, type AttachableKind, type McpServer, type Skill, type SkillRunScope, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { agentMcpServers, agents, agentSkills } from "../schema.js";
import { getAgent } from "./agentsRepo.js";
import { getMcpServer, listMcpServers } from "./mcpServersRepo.js";
import { getSkill, listSkills } from "./skillsRepo.js";

/**
 * The join between the two catalogues and `agents` (EO-106).
 *
 * 0050 and 0051 built catalogues that reach nobody. This is what carries
 * one to an agent, and it is the first thing in either story that
 * changes what a dispatch is built with — which is why a write here has
 * two consequences elsewhere, both of them the actual work of EO-106:
 * the cached provider for that agent is discarded (`providerCacheKey`),
 * and a thread born under the old surface is refused a resume
 * (`findReusableThread`).
 *
 * A tick is idempotent in both directions. Attaching what is already
 * attached, and detaching what is not, are both fine and both report
 * what the agent now has — the alternative is a screen that has to know
 * what it last saw in order to send the right verb.
 */

/** What one agent has attached, as ids. Ordered by the catalogues' own order, so the answer is stable. */
export function getAgentAttachments(db: Db, agentId: string): AgentAttachments {
  const serverOrder = listMcpServers(db, true).map((server) => server.id);
  const skillOrder = listSkills(db, true).map((skill) => skill.id);

  const attachedServers = new Set(
    db.select().from(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).all().map((row) => row.serverId),
  );
  const attachedSkills = new Set(
    db.select().from(agentSkills).where(eq(agentSkills.agentId, agentId)).all().map((row) => row.skillId),
  );

  return {
    agentId,
    mcpServerIds: serverOrder.filter((id) => attachedServers.has(id)),
    skillIds: skillOrder.filter((id) => attachedSkills.has(id)),
  };
}

function groupByAgent(pairs: [string, string][]): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const [agentId, id] of pairs) {
    const held = grouped.get(agentId) ?? new Set<string>();
    held.add(id);
    grouped.set(agentId, held);
  }
  return grouped;
}

/**
 * Every agent's, for the screen that asks the question the other way
 * round — "which agents have this server?" (EO-109).
 *
 * Built from one pass over each join table rather than a query per
 * agent: the whole answer is a few dozen rows, and the version that
 * loops would be one round trip per role for it.
 */
export function listAgentAttachments(db: Db): AgentAttachments[] {
  const serverOrder = listMcpServers(db, true).map((server) => server.id);
  const skillOrder = listSkills(db, true).map((skill) => skill.id);

  const servers = groupByAgent(db.select().from(agentMcpServers).all().map((row) => [row.agentId, row.serverId]));
  const skills = groupByAgent(db.select().from(agentSkills).all().map((row) => [row.agentId, row.skillId]));

  // Only the agents that have something. An agent with nothing attached
  // has an answer — `getAgentAttachments` gives it — but putting an
  // empty row here for every agent would make the list say "seven
  // agents, none of them configured" in a shape a caller has to filter
  // anyway.
  const agentIds = [...new Set([...servers.keys(), ...skills.keys()])].sort();
  return agentIds.map((agentId) => ({
    agentId,
    mcpServerIds: serverOrder.filter((id) => servers.get(agentId)?.has(id) ?? false),
    skillIds: skillOrder.filter((id) => skills.get(agentId)?.has(id) ?? false),
  }));
}

/**
 * The rows an agent's attachments point at, archived ones included.
 *
 * The reason `archiveMcpServer` and `archiveSkill` archive rather than
 * delete: an agent that was given a server keeps pointing at something
 * a person can read, so the screen says "archived" instead of showing a
 * gap, and nothing here has to cope with an id that resolves to nothing.
 *
 * Whether an archived or disabled entry is *delivered* is not decided
 * here — that is EO-107 and EO-108, which build what each provider
 * actually reads. Both flags travel in the fingerprint regardless, so a
 * change of mind about either still invalidates a cached provider.
 */
export interface ResolvedAgentAttachments {
  servers: McpServer[];
  skills: Skill[];
}

export function resolveAgentAttachments(db: Db, agentId: string): ResolvedAgentAttachments {
  const { mcpServerIds, skillIds } = getAgentAttachments(db, agentId);
  return {
    // `flatMap` over `map`: a row deleted between the two reads is
    // dropped rather than turned into an undefined nothing downstream
    // narrows. Archiving means that should not happen, and this is not
    // the place to find out it did.
    servers: mcpServerIds.flatMap((id) => {
      const server = getMcpServer(db, id);
      return server ? [server] : [];
    }),
    skills: skillIds.flatMap((id) => {
      const skill = getSkill(db, id);
      return skill ? [skill] : [];
    }),
  };
}

/**
 * What an agent has attached, narrowed to what one run is given (EO-470).
 *
 * The servers as they are — a server has no scope — and the skills whose
 * scope takes the run in (`skillsForRun`). Enabled and archived are left
 * for `deliverableAttachments` to decide, as they always were, so the two
 * filters compose rather than one quietly doing the other's job.
 *
 * Both deliveries ask this: the Claude tool directory is written from it,
 * and the thread-reuse fingerprint is taken over it, so a skill moving
 * into or out of a run's scope is a different surface for that run and
 * cannot be resumed under.
 */
export function attachmentsForRun(resolved: ResolvedAgentAttachments, scope: SkillRunScope): ResolvedAgentAttachments {
  return { servers: resolved.servers, skills: skillsForRun(resolved.skills, scope) };
}

/** `resolveAgentAttachments`, narrowed to one run's scope. */
export function resolveAgentAttachmentsForRun(db: Db, agentId: string, scope: SkillRunScope): ResolvedAgentAttachments {
  return attachmentsForRun(resolveAgentAttachments(db, agentId), scope);
}

/**
 * The tool surface an organisation published for one agent, into this
 * replica (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Replaced rather than merged: "a published agent carries role, prompt
 * and tool surface", and a surface that was the union of what the
 * organisation gave and what this machine had attached earlier would be
 * a surface nobody decided — and one an agent could have widened for
 * itself before the section was locked (invariant 11).
 *
 * A server or skill this replica does not hold yet is skipped rather
 * than written: the join has foreign keys. It is not always in the same
 * document — a skill comes with the packs section and a server with
 * policy, each on its own page — so what was skipped is *counted*, and
 * the drain holds the agent's surface until the catalogue catches up
 * (EO-476, `attachArrivedTools`).
 */
export function replaceReplicaAttachments(db: Db, agentId: string, mcpServerIds: readonly string[], skillIds: readonly string[]): UnarrivedTools {
  db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run();
  db.delete(agentSkills).where(eq(agentSkills.agentId, agentId)).run();
  return attachArrivedTools(db, agentId, mcpServerIds, skillIds);
}

/**
 * Attaches whichever of these servers and skills this replica now holds,
 * leaving every attachment already there alone, and counts the ones it
 * still does not (EO-476).
 *
 * The second half of `replaceReplicaAttachments`, and the whole of a
 * repair: an agent whose skill arrived a page after it gets the skill
 * attached when it does, without its surface being rebuilt.
 */
export function attachArrivedTools(db: Db, agentId: string, mcpServerIds: readonly string[], skillIds: readonly string[]): UnarrivedTools {
  const at = Date.now();
  const missingMcpServerIds: string[] = [];
  const missingSkillIds: string[] = [];
  for (const serverId of mcpServerIds) {
    if (getMcpServer(db, serverId) === undefined) {
      missingMcpServerIds.push(serverId);
      continue;
    }
    db.insert(agentMcpServers).values({ agentId, serverId, createdAt: at }).onConflictDoNothing().run();
  }
  for (const skillId of skillIds) {
    if (getSkill(db, skillId) === undefined) {
      missingSkillIds.push(skillId);
      continue;
    }
    db.insert(agentSkills).values({ agentId, skillId, createdAt: at }).onConflictDoNothing().run();
  }
  return { missingMcpServerIds, missingSkillIds, missing: missingMcpServerIds.length + missingSkillIds.length };
}

/** The servers and skills an attach could not write, for want of the catalogue row (EO-476). */
export interface UnarrivedTools {
  missingMcpServerIds: string[];
  missingSkillIds: string[];
  missing: number;
}

export type SetAgentAttachmentResult = { ok: true; attachments: AgentAttachments } | { ok: false; problem: string };

/**
 * Ticks one catalogue entry on or off for one agent.
 *
 * Both halves of the pair are checked to exist first, and a missing one
 * is a sentence rather than a throw: a screen listing an agent that
 * somebody deleted in another window is a race, not a programmer error.
 * A row filed against an id nothing carries is worse than a refusal —
 * nothing would ever read it and nothing would clean it up, which is the
 * refusal `setMcpServerSecret` makes for the same reason.
 */
export function setAgentAttachment(
  db: Db,
  input: { agentId: string; kind: AttachableKind; id: string; attached: boolean },
  now: number = Date.now(),
): SetAgentAttachmentResult {
  const { agentId, kind, id, attached } = input;
  // `as Uuid` because the id arrives from the boundary as a string, the
  // way every other id on this file's surface does. The check *is* the
  // narrowing: a value that is not an agent's id finds no agent.
  if (!getAgent(db, agentId as Uuid)) return { ok: false, problem: "That agent no longer exists." };

  if (kind === "mcpServer") {
    // Archived counts as existing — `getMcpServer` does not filter, and
    // must not: attaching a server somebody archived is odd but it is a
    // thing they asked for, and it resolves.
    if (attached && !getMcpServer(db, id)) return { ok: false, problem: "That MCP server no longer exists." };
    if (attached) {
      db.insert(agentMcpServers).values({ agentId, serverId: id, createdAt: now }).onConflictDoNothing().run();
    } else {
      db.delete(agentMcpServers).where(and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.serverId, id))).run();
    }
  } else {
    if (attached && !getSkill(db, id)) return { ok: false, problem: "That skill no longer exists." };
    if (attached) {
      db.insert(agentSkills).values({ agentId, skillId: id, createdAt: now }).onConflictDoNothing().run();
    } else {
      db.delete(agentSkills).where(and(eq(agentSkills.agentId, agentId), eq(agentSkills.skillId, id))).run();
    }
  }
  // The tool surface travels with the agent (EO-476): a record-held
  // project's own agent pages to replicas on its row's stamp, so a
  // change to what it is attached to has to move that stamp too.
  db.update(agents)
    .set({ updatedAt: Date.now(), revision: sql`${agents.revision} + 1` })
    .where(eq(agents.id, agentId))
    .run();

  return { ok: true, attachments: getAgentAttachments(db, agentId) };
}
