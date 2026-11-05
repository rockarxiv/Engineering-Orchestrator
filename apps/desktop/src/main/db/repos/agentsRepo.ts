import { eq, isNotNull, sql } from "drizzle-orm";
import { UNBOUND_BACKEND, uuidv7, type Agent, type PublishedAgent, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { agentMcpServers, agents, agentSkills } from "../schema.js";

function toDomain(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id as Uuid,
    name: row.name,
    role: row.role,
    provider: row.provider,
    model: row.model,
    instructions: row.instructions,
    promptHash: row.promptHash,
    config: row.config as Record<string, unknown>,
    enabled: row.enabled,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    projectId: row.projectId as Uuid | null,
  };
}

export interface CreateAgentInput {
  name: string;
  role: string;
  provider: string;
  model?: string | null;
  instructions: string;
  /** Set when EO wrote the instructions itself; absent when a human did. */
  promptHash?: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
  /** The project this agent works for; absent or null is a global agent (EO-474). */
  projectId?: Uuid | null;
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  const row = db
    .insert(agents)
    .values({
      id: uuidv7(),
      name: input.name,
      role: input.role,
      provider: input.provider,
      model: input.model ?? null,
      instructions: input.instructions,
      promptHash: input.promptHash ?? null,
      config: input.config ?? {},
      enabled: input.enabled ?? true,
      projectId: input.projectId ?? null,
      updatedAt: Date.now(),
    })
    .returning()
    .get();
  return toDomain(row);
}

export function getAgent(db: Db, id: Uuid): Agent | undefined {
  const row = db.select().from(agents).where(eq(agents.id, id)).get();
  return row ? toDomain(row) : undefined;
}

/**
 * Every agent row, archived ones included (EO-186).
 *
 * Deliberately unlike `listSkills` and `listMcpServers`, which filter
 * archived rows out here so no caller has to remember to. An agent is
 * not only something to offer in a picker: it is what a run was
 * dispatched to and what a comment was written by, and both of those are
 * read back by name long after the agent is retired. Filtering here
 * would turn every one of those names into a UUID, which is the history
 * the row was kept for in the first place.
 *
 * So the filtering is at the decisions instead, and there are two kinds.
 * Whether an agent may be *dispatched* is `isDispatchable`, which every
 * staffing question goes through. Whether it is *shown* is the screen's,
 * and each one asks it where a person can see the answer.
 */
export function listAgents(db: Db): Agent[] {
  return db.select().from(agents).all().map(toDomain);
}

export interface UpdateAgentInput {
  name?: string;
  /**
   * Editable, per U-06. A change does not carry in-flight work with it:
   * `runs.thread_id` is a session id in the *old* backend's store, so a
   * run resumed after a provider switch fails and escalates rather than
   * quietly continuing somewhere else. `role` stays immutable — it is
   * what the workflow dispatches against.
   */
  provider?: string;
  model?: string | null;
  instructions?: string;
  /**
   * Always set alongside `instructions`, never on its own: it answers
   * "did EO write this?" about the text in the same patch, and a hash
   * left behind from previous text answers it wrongly.
   */
  promptHash?: string | null;
  config?: Record<string, unknown>;
  enabled?: boolean;
  /**
   * Which project it works for, null for global (EO-474). Whether a
   * scope is allowed — never on a `system` agent, only a project that
   * exists — is `saveAgent`'s question, as the backend policy is.
   */
  projectId?: Uuid | null;
}

export function updateAgent(db: Db, id: Uuid, patch: UpdateAgentInput): Agent {
  const row = db
    .update(agents)
    .set({ ...patch, updatedAt: Date.now(), revision: sql`${agents.revision} + 1` })
    .where(eq(agents.id, id))
    .returning()
    .get();
  return toDomain(row);
}

/**
 * Retires an agent (EO-186).
 *
 * Archived rather than deleted, for `modules.archived_at`'s reason and
 * one that is sharper here: the row is what `runs.agent_id`,
 * `comments.author_id` and `comment_mentions.target_id` point at, so
 * deleting it would strip authorship from comments in threads people
 * still read (invariant #3).
 *
 * One-way on purpose, as it is for modules and skills — there is no
 * un-archive, and nothing here writes `enabled`. Whether archiving this
 * agent would leave a step with nobody is not asked here: that is
 * `archiveAgentCommand`'s question, because the answer is a sentence for
 * a person rather than a boolean, and the repository has no business
 * reading the pipeline graph to compose one.
 */
/**
 * An agent as the organisation published it, into this replica
 * (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Role, prompt, tool-surface config and whether it is enabled are the
 * record's and are written over what is here. **Backend and model are
 * not**: they are a fact about which CLI is installed and signed in on
 * this machine, and an organisation that overwrote them would sign
 * somebody out of the only backend they have. An agent arriving for the
 * first time takes the publication's *recommendation*, because a column
 * has to say something; from then on it is the person's, through
 * `agents:setBinding`.
 *
 * The record's id is kept, for `upsertReplicaItem`'s reason:
 * `agent_mcp_servers`, `runs.agent_id` and a comment's author all name
 * an agent by id.
 *
 * `scope` is always written, never left as it was (EO-476). A
 * publication carries global agents only, so its entries are written
 * global — an agent the record moved from a project to the installation
 * is global on a replica that held it scoped exactly as on one meeting it
 * for the first time. A record-held project's own agent arrives on the
 * sync's own list instead, with its project — see
 * `upsertReplicaProjectAgent`.
 *
 * `stamp` is the record's revision of this copy, kept so a copy older
 * than it is recognised when it arrives late — see `takesRecordCopy`.
 * Null for a copy that carries no revision to order by.
 */
export function upsertReplicaAgent(db: Db, published: PublishedAgent, scope: { projectId: Uuid | null; stamp: number | null }): void {
  const mine = getAgent(db, published.id as Uuid);
  const now = Date.now();
  const project = { projectId: scope.projectId, recordStamp: scope.stamp, revision: published.revision };
  if (mine === undefined) {
    db.insert(agents)
      .values({
        id: published.id,
        name: published.name,
        role: published.role,
        provider: published.recommendedProvider ?? "fake",
        model: published.recommendedModel,
        instructions: published.instructions,
        promptHash: null,
        config: published.config,
        enabled: published.enabled,
        archivedAt: published.archivedAt,
        deletedAt: published.deletedAt,
        ...project,
        updatedAt: now,
      })
      .run();
  } else {
    db.update(agents)
      .set({
        name: published.name,
        role: published.role,
        instructions: published.instructions,
        config: published.config,
        enabled: published.enabled,
        archivedAt: published.archivedAt,
        deletedAt: published.deletedAt,
        ...project,
        updatedAt: now,
      })
      .where(eq(agents.id, published.id))
      .run();
  }
  // A published tombstone is a tombstone here too (EO-350): the local
  // half — backend, model, attachments — goes the way it went on the
  // machine that deleted it.
  if (published.deletedAt !== null) deleteAgent(db, published.id as Uuid, published.deletedAt);
}

export function archiveAgent(db: Db, id: Uuid, at: number = Date.now()): boolean {
  if (!getAgent(db, id)) return false;
  db.update(agents)
    .set({ archivedAt: at, updatedAt: Date.now(), revision: sql`${agents.revision} + 1` })
    .where(eq(agents.id, id))
    .run();
  return true;
}

/**
 * Deletes an agent, leaving a tombstone (EO-350).
 *
 * The row stays and keeps its name and role, because `runs.agent_id`
 * references it (a real delete of an agent that has run fails on the
 * foreign key) and because `comments.author_id` and mention targets name
 * it without one — a missing row would turn every one of those into
 * "unknown agent". Everything else goes: the instructions and config are
 * cleared, the backend is unbound, and the MCP server and skill
 * attachments are removed, as the cascade would have removed them.
 *
 * Archived and disabled too, so everything that already asks
 * `isDispatchable` or `archivedAt` leaves it out without learning a new
 * word; `deletedAt` is for the one screen that still lists archived
 * agents. An archive stamp already there is kept, being the true one.
 *
 * `runs` and `run_events` are not touched (invariant #3).
 */
export function deleteAgent(db: Db, id: Uuid, at: number = Date.now()): boolean {
  const agent = getAgent(db, id);
  if (!agent) return false;
  db.transaction((tx) => {
    tx.delete(agentMcpServers).where(eq(agentMcpServers.agentId, id)).run();
    tx.delete(agentSkills).where(eq(agentSkills.agentId, id)).run();
    tx.update(agents)
      .set({
        instructions: "",
        promptHash: null,
        config: {},
        provider: UNBOUND_BACKEND,
        model: null,
        enabled: false,
        archivedAt: agent.archivedAt ?? at,
        deletedAt: agent.deletedAt ?? at,
        updatedAt: Date.now(),
        revision: sql`${agents.revision} + 1`,
      })
      .where(eq(agents.id, id))
      .run();
  });
  return true;
}

/**
 * Offers every project's own agent to the replicas again (EO-476).
 *
 * Called when the agents section is published. A replica pages a
 * record-held project's agents on `updated_at`, and while the section
 * was unpublished it kept its own copy of any agent it already had — so
 * an edit made on the record in that time was read past and never
 * applied. Publishing makes the record's agent the agent there, and an
 * agent that is not edited again would otherwise stay as the replica
 * last wrote it, under a lock that forbids correcting it. Stamping them
 * puts every one back on the replicas' next pull, where the
 * publication, applied first, decides they are written over.
 */
export function touchProjectAgents(db: Db, at: number = Date.now()): number {
  return db.update(agents).set({ updatedAt: at }).where(isNotNull(agents.projectId)).run().changes;
}

/**
 * Whether a copy of an agent at the record's revision `stamp` may be
 * written here (EO-476).
 *
 * An agent reaches a replica through two doors that page independently
 * — the agents section's publication for a global one, the sync's list
 * for a record-held project's own — and the record can move an agent
 * from one to the other. So a copy can arrive after a newer one has
 * already been written through the other door: a held project copy
 * retried after the publication that made the agent global, or a
 * publication read after the project copy that superseded it. Every
 * change on the record adds one to the agent's `revision`, and every
 * copy carries it, so the newer copy is the one with the higher
 * revision — two changes in one millisecond included, which a timestamp
 * could not order. A tie is the same version of the agent and writes:
 * re-offering an agent on publish changes no revision, and is meant to
 * write. A row the record never wrote here has no stamp, and anything
 * from the record may write over it.
 */
export function takesRecordCopy(db: Db, id: string, stamp: number): boolean {
  const here = db.select({ recordStamp: agents.recordStamp }).from(agents).where(eq(agents.id, id)).get();
  return here === undefined || here.recordStamp === null || stamp >= here.recordStamp;
}

/** How many times this row has changed — see `agents.revision`. Zero for an agent that is not here. */
export function revisionOf(db: Db, id: string): number {
  return db.select({ revision: agents.revision }).from(agents).where(eq(agents.id, id)).get()?.revision ?? 0;
}

/** The record's revision of the copy written here, or null — see `takesRecordCopy`. */
export function recordStampOf(db: Db, id: string): number | null {
  return db.select({ recordStamp: agents.recordStamp }).from(agents).where(eq(agents.id, id)).get()?.recordStamp ?? null;
}
