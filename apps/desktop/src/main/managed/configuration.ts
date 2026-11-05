import { SectionDocumentSchema, type PublishedAgent, type PublishedSection, type SectionDocument } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgentAttachments, replaceReplicaAttachments } from "../db/repos/agentAttachmentsRepo.js";
import { listAgents, revisionOf, takesRecordCopy, updateAgent, upsertReplicaAgent } from "../db/repos/agentsRepo.js";
import { listModules, upsertReplicaModule } from "../db/repos/modulesRepo.js";
import { listModuleTests, replaceReplicaModuleTests } from "../db/repos/moduleTestsRepo.js";
import { listSkills, upsertReplicaSkill } from "../db/repos/skillsRepo.js";

/**
 * What a publish carries, and what a device does with it (EO-329,
 * `ARCHITECTURE.md`, "Publish, lock and versions").
 *
 * The lock was only ever half of this story. The original design's sentence is that an
 * admin edits the five sections on the server "exactly as a solo user
 * edits them on the desktop" and that **Publish pushes a version to
 * every signed-in desktop** — so what reaches a device has to be the
 * organisation's configuration. A lock delivered over each machine's
 * own stale copy would be the worst of both: nobody could edit it and
 * nobody was running the same thing.
 *
 * Two functions, one on each side of the sync:
 *
 *  - `sectionDocument` reads the record's tables at the moment somebody
 *    presses Publish. What it returns is frozen into the publication
 *    row, which is what makes a publish an act with a moment attached
 *    rather than a subscription to an admin's half-finished edits.
 *  - `applySectionDocument` writes it into a replica, read-only by
 *    consequence: the same section is locked in the command layer, so
 *    nothing on that machine can write these rows back.
 *
 * The pipelines section is not here. Its document is a *version* —
 * immutable, numbered, and already travelling with the pipeline on the
 * sync's own list (EO-327) — and a second copy of a graph in a second
 * shape is a second answer to "what is this pipeline".
 *
 * **Policy and connectors are not here either**, for the same rule
 * applied to a different table. EO-328 publishes the MCP server
 * catalogue, the allowed backends, the per-person budget and the
 * organisation's secret names through `policy:save`, and writes the
 * servers into `mcp_servers` itself. So what this carries is the three
 * sections nothing else publishes: agents, the skills a pack brings,
 * and the modules a `module` step runs.
 *
 * ## What is deliberately left out
 *
 * **Secrets, in either direction.** An organisation secret is the
 * server's and is the design's own later subject; a connector's values are in
 * the keychain of the machine that connected it. A document carries
 * what a server *wants* (`envNames`) and never what it was given.
 *
 * **A backend and a model.** The design keeps both local, which is what stops
 * a locked agents section stranding somebody signed in to one backend
 * and not the other. `upsertReplicaAgent` is where that is actually
 * kept; the document only carries a recommendation for an agent a
 * machine has never seen.
 *
 * **A workspace, a path, anything on a disk.** ARCHITECTURE.md, "Where a job runs": the server
 * never
 * needs the person's disk, and a row naming one would resolve nowhere.
 */

/**
 * The section as the record has it right now, ready to freeze into a
 * publication.
 *
 * Archived rows travel too, and on purpose: archiving is how EO retires
 * something whose history still points at it, so a desktop that never
 * heard about the retirement would go on offering an agent or a skill
 * the organisation has done with.
 */
export function sectionDocument(db: Db, section: PublishedSection): SectionDocument | null {
  switch (section) {
    case "agents":
      // The installation's agents, not a project's (EO-476). A project's
      // own agents travel with their project, on the sync's own list,
      // as its pipelines do; a publication carrying them would deliver
      // them with no project — as global agents, staffing every
      // project's work on the desktops that applied it.
      return SectionDocumentSchema.parse({
        agents: listAgents(db)
          .filter((agent) => agent.projectId === null)
          .map((agent) => publishedAgent(db, agent)),
      });
    case "packs":
      return SectionDocumentSchema.parse({ skills: listSkills(db, true) });
    case "connectors":
      // Nothing of its own to carry, and that is a decision rather than
      // an omission (EO-328). A connector is an MCP server row with a
      // descriptor on it, and the *rows* are published by policy —
      // `applyPublishedMcpServers` writes them into this same table
      // with the record's ids. A second document of the same rows would
      // be a second writer with a different rule about name
      // collisions, and which one a person met would depend on which
      // publish landed last. What publishing connectors does here is
      // shut the doors a pack would bring one through.
      return null;
    case "policy":
      // EO-328's section, whole — see `SECTION_LOCKED_CHANNELS.policy`.
      // `publishSectionCommand` refuses it rather than writing a row
      // nothing would read.
      return null;
    case "pipelines":
      // The graph and its versions travel with the pipeline; what is
      // left is the code its `module` steps run, which nothing else
      // carries.
      // Each with its test cases (EO-355): approving a module runs
      // them, and a replica that received the code without them would
      // hold a module nobody there could approve again.
      return SectionDocumentSchema.parse({
        modules: listModules(db, true).map((module) => ({
          ...module,
          tests: listModuleTests(db, module.id).map((test) => ({ id: test.id, description: test.description, source: test.source, createdAt: test.createdAt, updatedAt: test.updatedAt })),
        })),
      });
  }
}

function publishedAgent(db: Db, agent: ReturnType<typeof listAgents>[number]): PublishedAgent {
  const attached = getAgentAttachments(db, agent.id);
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    config: agent.config,
    enabled: agent.enabled,
    archivedAt: agent.archivedAt,
    deletedAt: agent.deletedAt,
    // A recommendation and not a setting — see this module's header and
    // `PublishedAgentSchema`.
    recommendedProvider: agent.provider,
    recommendedModel: agent.model,
    mcpServerIds: attached.mcpServerIds,
    skillIds: attached.skillIds,
    revision: revisionOf(db, agent.id),
  };
}

/**
 * The organisation's configuration, into this machine.
 *
 * Order matters once: the catalogues before the agents that are
 * attached to them, because the join has foreign keys and an attachment
 * to a skill this replica has not got is a row SQLite refuses. Within a
 * catalogue the writes are idempotent and may arrive in any order.
 *
 * Called from the drain, for every publication row that arrived, which
 * means it runs again on a rollback and again on a re-publish. That is
 * the intent: a publication is the whole of what the section is, so
 * applying it twice leaves the same rows and applying an older one puts
 * the older configuration back.
 */
export function applySectionDocument(db: Db, document: SectionDocument | null): number {
  if (document === null) return 0;
  let written = 0;

  for (const skill of document.skills) {
    upsertReplicaSkill(db, skill);
    written += 1;
  }
  for (const module of document.modules) {
    upsertReplicaModule(db, module);
    // Absent on a publication from before tests travelled, and absent
    // leaves this replica's cases alone — see `PublishedModuleSchema`.
    if (module.tests !== undefined) replaceReplicaModuleTests(db, module.id, module.tests);
    written += 1;
  }
  for (const agent of document.agents) {
    // Global, explicitly (EO-476): the publication carries the
    // installation's agents only, and a row this replica holds scoped to
    // a project — because the record has since made it global — must not
    // keep a scope the record no longer gives it.
    //
    // Unless this replica already holds a newer copy from the record
    // (EO-476): the agent may have been put back on a project after this
    // was published, and that copy, on the sync's own list, can be read
    // first. The agent's revision orders the two.
    if (!takesRecordCopy(db, agent.id, agent.revision)) continue;
    upsertReplicaAgent(db, agent, { projectId: null, stamp: agent.revision });
    replaceReplicaAttachments(db, agent.id, agent.mcpServerIds, agent.skillIds);
    written += 1;
  }
  if (document.agents.length > 0) written += standDownLocalAgents(db, document.agents);

  return written;
}

/**
 * This machine's own agents for a role the organisation now staffs
 * (EO-329, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * Every installation seeds its own agents, with ids of its own, so a
 * published agents section arrives *beside* them rather than over them:
 * two enabled implementers, and a dispatch picking whichever the
 * staffing query happened to sort first. That is not a state a person
 * could diagnose, and on a locked section it is not one they could fix
 * either — `agents:save` is refused.
 *
 * So the local one is switched off rather than archived or deleted.
 * Off is reversible and keeps every run, comment and mention that names
 * it exactly where it is (invariant #3); archiving is one-way and would
 * throw away a solo installation's own work the first time somebody
 * signed in to an organisation. A person who later signs out gets their
 * agents back with one switch.
 *
 * Only for a role the publication actually staffs: an agent for a role
 * the organisation says nothing about is not competing with anything,
 * and is the person's own exactly as it was.
 *
 * And only a global one (EO-476). A project's own agent is not competing
 * with a published global agent either — on its project it outranks the
 * global ones by the staffing rule, and elsewhere it staffs nothing — and
 * on a record-held project it is the record's own configuration, which
 * standing it down would switch off on every desktop that pulled it.
 */
function standDownLocalAgents(db: Db, published: readonly PublishedAgent[]): number {
  const theirs = new Set(published.map((agent) => agent.id));
  const staffed = new Set(published.filter((agent) => agent.enabled && agent.archivedAt === null).map((agent) => agent.role));
  let stood = 0;
  for (const mine of listAgents(db)) {
    if (theirs.has(mine.id) || mine.projectId !== null || mine.archivedAt !== null || !mine.enabled) continue;
    if (!staffed.has(mine.role)) continue;
    updateAgent(db, mine.id, { enabled: false });
    stood += 1;
  }
  return stood;
}
