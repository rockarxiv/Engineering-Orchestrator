import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type {
  RecordAdoptCounts,
  RecordAdoptPage,
  RecordAgent,
  RecordAdoptedItem,
  RecordAdoptedTransition,
  RecordCommentCommand,
  RecordAdoptedMention,
  RecordItemDep,
  RecordItemExtension,
  RecordJobOccurrence,
  RecordItemType,
  RecordJob,
  RecordPipeline,
  RecordProject,
  RecordRunEvent,
  Uuid,
} from "@eo/core";
import type { Run } from "@eo/core";
import { EntryRulesSchema, parseStoredCommentOptions, TrialPlanSchema, TrialStepSourcesSchema, type TrialPlan, type TrialStepSources } from "@eo/core";
import { keepArrivedOrigin, originForWire } from "./itemOriginsRepo.js";
import type { Db } from "../client.js";
import { getRun } from "./runsRepo.js";
import { watchColumns, watchOf } from "./pipelineStepsRepo.js";
import { attachArrivedTools, getAgentAttachments, replaceReplicaAttachments, type UnarrivedTools } from "./agentAttachmentsRepo.js";
import { getSkill, getSkillBySlug, skillOwner, writeMovedSkill } from "./skillsRepo.js";
import { getMcpServer } from "./mcpServersRepo.js";
import { clearSetting, getSetting, setSetting } from "./settingsRepo.js";
import { getAgent, takesRecordCopy, upsertReplicaAgent } from "./agentsRepo.js";
import { deleteItem } from "./itemsRepo.js";
import { publishedSectionRow } from "./publishedSectionsRepo.js";
import { isDiverged } from "./divergenceRepo.js";
import { dropWebhookWaiversWithoutEntry } from "./webhookWaiverRepo.js";
import { writeArrivedMemory } from "./memoriesRepo.js";
import { PipelineExportSchema, UNBOUND_BACKEND } from "@eo/core";
import { getAppliedTemplateUpdate, getPipelineOrigin, isTemplateDocument, recordAppliedTemplateUpdate, recordPipelineOrigin } from "./pipelineOriginsRepo.js";
import {
  agents,
  attachments,
  comments,
  commentMentions,
  items,
  itemDeps,
  itemExtensions,
  itemTypes,
  jobOccurrences,
  jobs,
  keyCounters,
  memories,
  people,
  pipelines,
  pipelineSteps,
  pipelineVersions,
  projects,
  runEvents,
  runs,
  skills,
  stepRoutes,
  transitions,
} from "../schema.js";

/**
 * A project's rows, read on the machine that has it and written on the
 * record that takes it (EO-325, `ARCHITECTURE.md`, "What a person sees first",
 * "Identity").
 *
 * Both halves in one file on purpose. What a move has to get right is
 * that *the same rows* come out of one database and go into the other,
 * and the failure it has to avoid is the quiet one: a column read on
 * the way out and not written on the way in, which looks like a
 * successful move and is a project with something missing from it. Two
 * files would be two lists of columns to keep in step; this is one, and
 * a reviewer can put a finger on the reading and the writing of a field
 * at the same time.
 *
 * ### Verbatim, and what that rules out
 *
 * Every id travels. "The server assigning nothing new except the
 * record's ownership" is the story's own sentence, and it is not tidy
 * minimalism: `items.step_id`, `items.type_id`, `comments.parent_id`,
 * `transitions.run_id` and `step_routes.target` all name rows by id, so
 * anything renumbered in transit arrives pointing at nothing. The one
 * thing the record does assign is the owner, and it assigns it to the
 * person who signed in.
 *
 * Every write is `onConflictDoNothing` by primary key. A page that was
 * served and whose answer was lost is re-sent, and the second arrival
 * has to cost one statement and change nothing. That is also why
 * nothing here updates: the record has never seen these rows, so an
 * upsert would be a way of silently overwriting something that should
 * have been a collision worth reporting.
 *
 * ### What deliberately does not travel
 *
 * **The workspaces.** A workspace is a path on somebody's disk and the design
 * is explicit that the server never needs one: work runs on the
 * person's machine, with their files and their logins. A record holding
 * a checkout directory from a laptop would be storing a path that
 * resolves nowhere, so `items.workspace_id` and
 * `pipeline_steps.workspace_id` are nulled on the way up and the
 * machine that runs the work keeps its own.
 *
 * **A run's machine-local columns** — the provider session id, the
 * working directory, the process id, the hashes it was born with.
 * `RecordRunCommandSchema` already left those behind for the same
 * reason and this takes the same path, through `asRunCommand`.
 *
 * **A file's bytes.** They follow through the ordinary attachment
 * queue, which is the path EO-324 built for them; see
 * `RecordAdoptPageSchema`.
 */

// ── Reading, on the machine that has the project ────────────────────

/** The item types this project's items are filed under, with their ids. */
export function readProjectItemTypes(db: Db, projectId: Uuid): RecordItemType[] {
  return db
    .select()
    .from(itemTypes)
    .where(eq(itemTypes.projectId, projectId))
    .orderBy(asc(itemTypes.id))
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.projectId,
      slug: row.slug,
      packSlug: row.packSlug,
      label: row.label,
      plural: row.plural,
      container: row.container,
      specShape: row.specShape,
      actionOverrides: row.actionOverrides,
      createdAt: row.createdAt,
    }));
}

/** A pipeline row's trial columns as they travel (EO-582), or null for a pipeline that is not a trial. */
function trialOfRow(row: {
  trialAt: number | null;
  trialConversationId: string | null;
  trialTargetPipelineId: string | null;
  trialPlan: unknown;
  trialStepSources: unknown;
}): RecordPipeline["trial"] {
  if (row.trialAt === null || row.trialConversationId === null) return null;
  // Its plan with it (EO-584), as it reads: one that no longer parses is
  // every step real, which is what `readTrialPlan` makes of it here too.
  const plan = row.trialPlan === null ? null : TrialPlanSchema.safeParse(row.trialPlan);
  // And which live step each of its steps was copied from, as
  // `readTrialStepSources` reads it.
  const sources = TrialStepSourcesSchema.safeParse(row.trialStepSources ?? {});
  return {
    at: row.trialAt,
    conversationId: row.trialConversationId,
    targetPipelineId: row.trialTargetPipelineId,
    plan: plan?.success === true ? plan.data : null,
    stepSources: sources.success ? sources.data : {},
  };
}

/**
 * A travelling pipeline's trial as the columns it is written to (EO-582).
 * Every writer of an arriving pipeline row spreads this, on insert and on
 * update alike: the mark is written once where the trial is made and
 * never changes, so writing it again is writing the same thing.
 */
function trialColumnsOf(trial: RecordPipeline["trial"]): {
  trialAt: number | null;
  trialConversationId: string | null;
  trialTargetPipelineId: string | null;
  trialPlan: TrialPlan | null;
  trialStepSources: TrialStepSources | null;
} {
  return {
    trialAt: trial?.at ?? null,
    trialConversationId: trial?.conversationId ?? null,
    trialTargetPipelineId: trial?.targetPipelineId ?? null,
    // The plan does change — the test-fix loop saves it between rounds —
    // so it is written on every arrival, as the rest of the row is.
    trialPlan: trial?.plan ?? null,
    trialStepSources: trial === null ? null : trial.stepSources,
  };
}

/**
 * One pipeline row, with its steps and routes, as it travels.
 *
 * Shared by the move going up and the mirror coming down, because they
 * carry the same thing: a graph. Two readers would be two opinions
 * about which of a step's columns matter, and the one that matters most
 * — `workspaceId` — is exactly the one they would be tempted to
 * disagree about.
 */
function toRecordPipeline(db: Db, row: typeof pipelines.$inferSelect): RecordPipeline {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    entryStepId: row.entryStepId,
    position: row.position,
    previewItem: row.previewItem ?? null,
    // Between a record and its replicas only (EO-405): on a managed
    // desktop the setting is the administrator's, and the board there
    // still has to say what they chose. An export carries no such field.
    webhookUnattended: row.webhookUnattended,
    // Part of what the pipeline says (EO-610), so a record and its
    // replicas refuse the same work.
    entryRules: EntryRulesSchema.safeParse(row.entryRules).data ?? [],
    // What makes it a trial (EO-582), so it is one wherever it lands.
    trial: trialOfRow(row),
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
    steps: db
      .select()
      .from(pipelineSteps)
      .where(eq(pipelineSteps.pipelineId, row.id))
      .orderBy(asc(pipelineSteps.position))
      .all()
      .map((step) => ({
        id: step.id,
        pipelineId: step.pipelineId,
        position: step.position,
        name: step.name,
        type: step.type as RecordPipeline["steps"][number]["type"],
        ownerRole: step.ownerRole,
        entryAction: step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
        workspaceMode: step.workspaceMode as RecordPipeline["steps"][number]["workspaceMode"],
        // Deliberately dropped — see this file's own note about the disk.
        workspaceId: null,
        offBoard: step.offBoard,
        inputs: step.inputs as RecordPipeline["steps"][number]["inputs"],
        timeoutMs: step.timeoutMs,
        // Keep checking travels with the graph (EO-456): it is what the
        // step does, not a fact about this machine.
        watch: watchOf(step),
        ownerPersonId: step.ownerPersonId,
        ownerGroupId: step.ownerGroupId,
        results: step.results as RecordPipeline["steps"][number]["results"],
      })),
    routes: db
      .select()
      .from(stepRoutes)
      .where(eq(stepRoutes.pipelineId, row.id))
      .orderBy(asc(stepRoutes.position))
      .all()
      .map((route) => ({
        id: route.id,
        pipelineId: route.pipelineId,
        fromStepId: route.fromStepId,
        resultKey: route.resultKey,
        label: route.label,
        tone: route.tone as RecordPipeline["routes"][number]["tone"],
        target: route.target,
        position: route.position,
      })),
    currentVersionId: row.currentVersionId,
    versions: versionsAReplicaNeeds(db, row.id, row.currentVersionId),
    origin: originToSend(db, row.id),
  };
}

/** This pipeline's template origin as a page carries it, or null (EO-532). */
function originToSend(db: Db, pipelineId: string): RecordPipeline["origin"] {
  const origin = getPipelineOrigin(db, pipelineId);
  if (origin === null) return null;
  // With the update EO last applied to it (EO-536), which the pipeline
  // keeps beside its origin because its version may be pruned.
  const applied = getAppliedTemplateUpdate(db, pipelineId);
  return { slug: origin.slug, version: origin.version, base: origin.base, stepIds: origin.stepIds, baseMovedAt: origin.baseMovedAt, applied };
}

/**
 * Writes the origin a moved pipeline arrived with (EO-532).
 *
 * The base is the sender's stored snapshot, read through the export
 * schema like every document EO accepts; one that does not parse as a
 * template document is not written, and the pipeline keeps whatever
 * origin this record already gave it.
 */
function writeArrivedOrigin(db: Db, pipelineId: string, origin: RecordPipeline["origin"]): void {
  if (origin === null) return;
  const base = PipelineExportSchema.safeParse(origin.base);
  if (!base.success || !isTemplateDocument(base.data)) return;
  if (base.data.template.slug !== origin.slug || base.data.template.version !== origin.version) return;
  recordPipelineOrigin(db, { pipelineId, document: base.data, stepIds: origin.stepIds, baseMovedAt: origin.baseMovedAt });
  // And the update EO last applied to it (EO-536), so the record — which
  // answers this pipeline's head from now on — still says so.
  if (origin.applied !== null) recordAppliedTemplateUpdate(db, pipelineId, origin.applied);
}

/**
 * The version documents a replica could be asked to route by (EO-329).
 *
 * The current one, and every older one a live item on this pipeline is
 * still bound to. That is exactly the set `boundGraphForItem` can ask
 * for on the other end: an item finishing on v6 needs v6's document,
 * and a version nothing is standing in is history the record keeps for
 * the diff screen rather than something a device has to route by.
 *
 * Archived items are counted in, unlike the banner's own tally: an
 * archived item can be restored, and it comes back standing exactly
 * where it was.
 */
function versionsAReplicaNeeds(db: Db, pipelineId: string, currentVersionId: string | null): RecordPipeline["versions"] {
  const wanted = new Set<string>();
  if (currentVersionId !== null) wanted.add(currentVersionId);
  for (const row of db
    .selectDistinct({ versionId: items.pipelineVersionId })
    .from(items)
    .where(eq(items.pipelineId, pipelineId))
    .all()) {
    if (row.versionId !== null) wanted.add(row.versionId);
  }
  if (wanted.size === 0) return [];

  return db
    .select()
    .from(pipelineVersions)
    .where(and(eq(pipelineVersions.pipelineId, pipelineId), inArray(pipelineVersions.id, [...wanted])))
    .orderBy(asc(pipelineVersions.number))
    .all()
    .map((version) => ({
      id: version.id,
      number: version.number,
      steps: version.steps,
      routes: version.routes,
      entryStepId: version.entryStepId,
      entryRules: EntryRulesSchema.safeParse(version.entryRules).data ?? [],
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      releaseNotes: version.releaseNotes,
    }));
}

/**
 * The graphs this project's items stand on, each whole.
 *
 * Archived ones included, because an item on an archived pipeline is
 * still an item and the step it sits on is still the step it sits on.
 * A move that left those behind would drop exactly the work whose
 * pipeline somebody has since retired.
 *
 * **What the items stand on, not only what the project owns.** A
 * pipeline nothing has adopted belongs to whichever project is asking
 * (`listPipelines` says so, and it is what lets EO work before anything
 * is configured) — so the Delivery board every installation is seeded
 * with is, in every way a person can see, this project's graph. Reading
 * only `project_id = …` sent none of it, and the record appeared to
 * cope because both ends had been seeded with the same step ids. A
 * pipeline somebody drew here has ids nothing else has ever seen, and
 * its items would have arrived standing on nothing.
 *
 * An unadopted pipeline stays unadopted on the far side — see
 * `writeAdoptedPage`, which keeps its null rather than claiming it for
 * the moved project. It is shared here and it is shared there.
 */
export function readProjectPipelines(db: Db, projectId: Uuid): RecordPipeline[] {
  const standingOn = new Set(
    db
      .select({ pipelineId: items.pipelineId })
      .from(items)
      .where(eq(items.projectId, projectId))
      .all()
      .flatMap((row) => (row.pipelineId === null ? [] : [row.pipelineId])),
  );
  return db
    .select()
    .from(pipelines)
    .orderBy(asc(pipelines.position), asc(pipelines.id))
    .all()
    .filter((row) => row.projectId === projectId || standingOn.has(row.id))
    .map((row) => toRecordPipeline(db, row));
}

/**
 * The graphs the record holds, paged for a replica catching up.
 *
 * Paged on the pipeline's own `updated_at` and its id, the pair every
 * other list in `record:changes` is read by. The steps and the routes
 * carry no timestamp of their own, so they are not paged at all — they
 * travel whole with the pipeline, and a graph edited on the record
 * reaches a replica when the pipeline's own row is touched.
 */
export function listPipelinesUpdatedSince(
  db: Db,
  cursor: { ts: number; id: string },
  limit: number,
  within?: string,
): RecordPipeline[] {
  return db
    .select()
    .from(pipelines)
    .where(
      and(
        sql`(${pipelines.updatedAt}, ${pipelines.id}) > (${cursor.ts}, ${cursor.id})`,
        // The project's own graphs *and* the ones its items stand on —
        // the same pair `readProjectPipelines` sends up, because a
        // project seeded on the installation-wide board owns no
        // pipeline at all and its items would arrive standing on
        // nothing this desktop can resolve.
        within === undefined
          ? undefined
          : sql`(${pipelines.projectId} = ${within}
                 or ${pipelines.id} in (select ${items.pipelineId} from ${items} where ${items.projectId} = ${within}))`,
      ),
    )
    .orderBy(asc(pipelines.updatedAt), asc(pipelines.id))
    .limit(limit)
    .all()
    .map((row) => toRecordPipeline(db, row));
}

/**
 * One agent row as it travels with its project (EO-476).
 *
 * Shared by the move going up and the mirror coming down, for
 * `toRecordPipeline`'s reason: one reading of which columns travel. The
 * backend and model go as a recommendation only, as a published agent's
 * do — they are a fact about the machine the agent last ran on, and the
 * far side keeps its own once it has one.
 */
function toRecordAgent(db: Db, row: typeof agents.$inferSelect & { projectId: string }): RecordAgent {
  const attached = getAgentAttachments(db, row.id);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    config: row.config as Record<string, unknown>,
    enabled: row.enabled,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    recommendedProvider: row.provider,
    recommendedModel: row.model,
    mcpServerIds: attached.mcpServerIds,
    skillIds: attached.skillIds,
    // What this database calls each of them (EO-513), so a record that
    // has not got one of them can still say which it was.
    toolNames: toolNames(db, attached),
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

function toolNames(db: Db, attached: { mcpServerIds: readonly string[]; skillIds: readonly string[] }): Record<string, string> {
  const names: Record<string, string> = {};
  for (const id of attached.mcpServerIds) {
    const server = getMcpServer(db, id);
    if (server !== undefined) names[id] = server.name;
  }
  for (const id of attached.skillIds) {
    const skill = getSkill(db, id);
    if (skill !== undefined) names[id] = skill.name;
  }
  return names;
}

/** The one role that is never a project's own (EO-474) — the assistant is the same for everyone. */
const SYSTEM_ROLE = "system";

function scoped(row: typeof agents.$inferSelect): row is typeof agents.$inferSelect & { projectId: string } {
  return row.projectId !== null;
}

/**
 * The project's own agents, as the move carries them (EO-476).
 *
 * Archived and deleted ones included, for the reason archived items
 * are: a run, a comment or a mention on the project names the agent by
 * id, and the record has to be able to say who it was. Global agents
 * are not here — they are the installation's, not the project's, and an
 * organisation hands those out by publishing its agents section.
 */
export function readProjectAgents(db: Db, projectId: Uuid): RecordAgent[] {
  return db
    .select()
    .from(agents)
    .where(eq(agents.projectId, projectId))
    .orderBy(asc(agents.id))
    .all()
    .filter(scoped)
    .map((row) => toRecordAgent(db, row));
}

/**
 * The record-held projects' own agents, paged for a replica catching up
 * (EO-476).
 *
 * Paged on the agent's own `updated_at` and its id, as the pipelines
 * are, and only ever a project's own: a global agent reaches a replica
 * in the agents section's publication, never here. `within` is one
 * project's backfill, as it is for every other list.
 */
export function listProjectAgentsUpdatedSince(db: Db, cursor: { ts: number; id: string }, limit: number, within?: string): RecordAgent[] {
  return db
    .select()
    .from(agents)
    .where(
      and(
        isNotNull(agents.projectId),
        sql`(${agents.updatedAt}, ${agents.id}) > (${cursor.ts}, ${cursor.id})`,
        within === undefined ? undefined : eq(agents.projectId, within),
      ),
    )
    .orderBy(asc(agents.updatedAt), asc(agents.id))
    .limit(limit)
    .all()
    .filter(scoped)
    .map((row) => toRecordAgent(db, row));
}

/**
 * One of a record-held project's own agents, into this replica (EO-476).
 *
 * Under the pipelines' rule, for the pipelines' reason
 * (`upsertReplicaPipeline`): **where the organisation has published the
 * agents section**, the record's agent is the agent, written over what
 * is here — role, prompt, tool surface, whether it is enabled, archived
 * or deleted. **Where it has not**, a row already here is left exactly
 * alone, because unpublished sections stay editable locally; a row that
 * is new here is written, so the project arrives with its agents. In
 * both, the backend and model are this machine's from the first arrival
 * on, as a published agent's are (`upsertReplicaAgent`).
 *
 * Four answers, and the drain holds two of them:
 *
 *  - `written` — the record's agent is here now.
 *  - `waiting` — its project has not reached this replica yet. It is not
 *    written with no project, because a project's agent with no project
 *    is a *global* agent and would staff every project's work here.
 *  - `kept` — this machine's own copy stands, the section being
 *    unpublished. Held all the same, newest copy first, because the
 *    moment the section *is* published the record's agent is the agent,
 *    and the publication and this agent page on separate cursors: the
 *    agent may well be read before the publication that makes it apply.
 *  - `stale` — this replica already holds a newer copy from the record,
 *    through either door: the publication that later made the agent
 *    global, or a later project copy (`takesRecordCopy`). Passed over.
 *  - `refused` — a `system` agent, which is never scoped (EO-474).
 */
export function upsertReplicaProjectAgent(db: Db, agent: RecordAgent): "written" | "waiting" | "kept" | "stale" | "refused" {
  if (agent.role === SYSTEM_ROLE) return "refused";
  if (!takesRecordCopy(db, agent.id, agent.revision)) return "stale";
  if (hasProject(db, agent.projectId) === null) return "waiting";
  const here = getAgent(db, agent.id as Uuid);
  const published = publishedSectionRow(db, "agents") !== undefined;
  if (here !== undefined && !published) return "kept";
  db.transaction(() => {
    upsertReplicaAgent(db, agent, { projectId: agent.projectId as Uuid, stamp: agent.revision });
    // A tombstone has no tool surface, and `upsertReplicaAgent` has
    // just removed what it had.
    if (agent.deletedAt === null) replaceReplicaAttachments(db, agent.id, agent.mcpServerIds, agent.skillIds);
  });
  return "written";
}

/**
 * One graph from the record, into this replica.
 *
 * The pipeline, then its steps, then its routes. A step the record no
 * longer has is left where it is either way — deleting it would take
 * the items standing on it with it, and where an item sits is invariant
 * #1's subject rather than this file's.
 *
 * ### Two ways to write it, and what decides between them (EO-329)
 *
 * **Where the organisation has published the pipelines section**, the
 * record's graph is the graph: steps are written over and routes are
 * replaced. That is what publishing *is* (ARCHITECTURE.md, "Publish, lock and versions") — an admin
 * who rolls
 * back to v6 has changed a graph every desktop already holds a copy of,
 * same ids and different names, prompts and routes, and a replica that
 * kept what it first saw would draw a board disagreeing with the
 * configuration screen the admin is looking at.
 *
 * **Where it has not**, a row already here is left exactly alone, which
 * is what this function has always done. ARCHITECTURE.md, "Publish, lock and versions" is as clear
 * about this
 * half as about the other: "unpublished sections stay editable
 * locally", and a desktop that had its own edits reverted by the next
 * pull would have no local editing at all — only a delay before losing
 * it.
 *
 * The question is asked of the *section* and not of this pipeline,
 * because the lock is per section and never finer (ARCHITECTURE.md, "Publish, lock and versions").
 * It is asked
 * of the replica's own rows, which is why `drain.ts` applies the
 * publications before the graphs: the page that brings a publish brings
 * the graph it published with it.
 *
 * Two fields are never taken from the record, published or not:
 *
 *  - **`workspaceId`** — a path on *this* machine's disk. The design is
 *    explicit that a workspace never travels, and a null arriving from
 *    a record that has none would clear the checkout somebody pointed
 *    the step at.
 *  - **`id`**, which is the key the update is found by.
 *
 * `projectId` is taken only where the replica has the project. A graph
 * whose project has not arrived yet is still worth writing: it is what
 * lets the items land at all, and the next pull sets the project once
 * the row is here.
 */
export function upsertReplicaPipeline(db: Db, pipeline: RecordPipeline): "written" | "skipped" {
  const projectId = pipeline.projectId === null ? null : hasProject(db, pipeline.projectId);
  // Whether this machine's pipelines are its own to edit — see above.
  const published = publishedSectionRow(db, "pipelines") !== undefined;
  /**
   * Unless somebody here edited this one anyway (EO-331, the original design).
   *
   * "A pack a person edited locally is marked diverged, and updates
   * stop applying silently." Silently is the word that decides where
   * this guard goes: not a merge, not a newer-wins rule, not the
   * published half of the branch below with the person's changes
   * layered under it — nothing. Their copy stands until they suggest it
   * or discard it, and the screens say which state it is in rather than
   * the database quietly picking one.
   *
   * The versions still arrive, and that is not a hole in it. A version
   * is an immutable document keyed by its own id, not a graph anybody
   * is standing on: it is what *Compare* shows the local copy against
   * and what *Discard my edits* restores from, and a machine refusing
   * to hold the organisation's history is a machine that cannot offer
   * either.
   */
  if (published && isDiverged(db, pipeline.id)) {
    db.transaction(() => {
      storeReplicaVersions(db, pipeline);
      /**
       * And the one column of the row that is not the person's copy
       * (EO-405).
       *
       * What diverged is a *graph*: the steps and routes somebody here
       * edited, which stand until they suggest them or discard them.
       * Whether the pipeline may send what a webhook delivers unread
       * was never theirs — the command that writes it is refused on
       * this machine, diverged or not — so there is no local edit for
       * an update to overwrite, and skipping it would leave an
       * administrator unable to take a waiver back: the desktop would
       * keep `true`, its control locked, and its own copy still
       * publishing past the refusal.
       *
       * Nothing else on the row is touched, `updated_at` included, so
       * the copy is exactly as diverged as it was.
       */
      db.update(pipelines).set({ webhookUnattended: pipeline.webhookUnattended }).where(eq(pipelines.id, pipeline.id)).run();
    });
    return "skipped";
  }
  const managed = published;
  db.transaction(() => {
    db.insert(pipelines)
      .values({
        id: pipeline.id,
        projectId,
        name: pipeline.name,
        icon: pipeline.icon,
        entryStepId: null,
        position: pipeline.position,
        previewItem: pipeline.previewItem ?? null,
        // The record's, when the pipeline is new here (EO-405).
        webhookUnattended: pipeline.webhookUnattended,
        entryRules: pipeline.entryRules,
        // A trial arrives as one (EO-582).
        ...trialColumnsOf(pipeline.trial),
        archivedAt: pipeline.archivedAt,
        createdAt: pipeline.updatedAt,
        updatedAt: pipeline.updatedAt,
      })
      .onConflictDoUpdate({
        target: pipelines.id,
        // Not `projectId` and not `entryStepId`: the first is resolved
        // against what this replica holds and the second is set below,
        // once the step it names exists here.
        set: managed
          ? {
              name: pipeline.name,
              icon: pipeline.icon,
              position: pipeline.position,
              previewItem: pipeline.previewItem ?? null,
              // With the rest of what the organisation publishes
              // (EO-405): where the section is managed the setting is
              // the administrator's, and this is how their choice — on
              // or off again — reaches the board here.
              webhookUnattended: pipeline.webhookUnattended,
              entryRules: pipeline.entryRules,
              ...trialColumnsOf(pipeline.trial),
              archivedAt: pipeline.archivedAt,
              updatedAt: pipeline.updatedAt,
            }
          : pipeline.trial !== null
            ? // A trial's plan, whoever manages pipelines (EO-584): nobody
              // edits a trial here, and the test-fix loop saves the plan
              // between rounds, so the record's is the one a trial item
              // run here has to read.
              { trialPlan: pipeline.trial.plan, updatedAt: sql`${pipelines.updatedAt}` }
            : // Left as it is. Drizzle has no "do nothing" inside
              // `onConflictDoUpdate`, and writing the row's own
              // `updated_at` back over itself is the smallest statement
              // that changes none of what a person edited.
              { updatedAt: sql`${pipelines.updatedAt}` },
      })
      .run();
    for (const step of pipeline.steps) {
      db.insert(pipelineSteps)
        .values({
          id: step.id,
          pipelineId: pipeline.id,
          position: step.position,
          name: step.name,
          type: step.type,
          ownerRole: step.ownerRole,
          entryAction: step.entryAction,
          instructionsSummary: step.instructionsSummary,
          isTerminal: step.isTerminal,
          planMode: step.planMode,
          workspaceMode: step.workspaceMode,
          // Whatever this machine's own steps use. A workspace is this
          // machine's and never travels, in either direction.
          workspaceId: null,
          offBoard: step.offBoard,
          inputs: step.inputs,
          timeoutMs: step.timeoutMs,
          ...watchColumns(step.watch ?? null),
          ownerPersonId: knownPerson(db, step.ownerPersonId),
          ownerGroupId: step.ownerGroupId,
          results: step.results,
        })
        .onConflictDoUpdate({
          target: pipelineSteps.id,
          set: managed
            ? {
                pipelineId: pipeline.id,
                position: step.position,
                name: step.name,
                type: step.type,
                ownerRole: step.ownerRole,
                entryAction: step.entryAction,
                instructionsSummary: step.instructionsSummary,
                isTerminal: step.isTerminal,
                planMode: step.planMode,
                workspaceMode: step.workspaceMode,
                offBoard: step.offBoard,
                inputs: step.inputs,
                timeoutMs: step.timeoutMs,
                ...watchColumns(step.watch ?? null),
                ownerPersonId: knownPerson(db, step.ownerPersonId),
                ownerGroupId: step.ownerGroupId,
                results: step.results,
                // `workspaceId` is absent on purpose — see this
                // function's header. It is the one thing on a step that
                // belongs to the machine rather than to the graph.
              }
            : // Left as it is, for the pipeline row's reason.
              { name: sql`${pipelineSteps.name}` },
        })
        .run();
    }
    // Replaced rather than merged, where the section is published: a
    // route id is regenerated on every save on the record, so merging
    // would leave this replica holding the retired set beside the
    // published one — an item offered a button the organisation took
    // away. Unpublished, the routes are this machine's and are added to
    // rather than rewritten.
    if (managed) db.delete(stepRoutes).where(eq(stepRoutes.pipelineId, pipeline.id)).run();
    for (const route of pipeline.routes) {
      db.insert(stepRoutes)
        .values({
          id: route.id,
          pipelineId: pipeline.id,
          fromStepId: route.fromStepId,
          resultKey: route.resultKey,
          label: route.label,
          tone: route.tone,
          target: route.target,
          position: route.position,
        })
        .onConflictDoNothing()
        .run();
    }
    /**
     * The versions, and which one the pipeline is on (EO-329).
     *
     * Only for a published pipeline, and that is not tidiness: version
     * *numbers* are unique per pipeline, and a desktop editing its own
     * unpublished copy files its own v2. Writing the record's v2 beside
     * it would break that index or, worse, silently make the two v2s a
     * matter of which arrived first. On a published pipeline there is
     * one history and it is the organisation's — so a local row holding
     * the same number is replaced, and anything standing in it is
     * rebound to the record's row of that number, which is the document
     * it is actually finishing on now.
     *
     * The rows themselves are immutable (EO-327), so an id already here
     * is left exactly as it is.
     */
    if (managed) {
      storeReplicaVersions(db, pipeline);
      // The pointer last, once the row it names is here — a pointer at a
      // version this replica does not hold would make
      // `boundGraphForItem` answer "current" for every item on the
      // pipeline, which is the failure the documents above exist to
      // prevent.
      if (pipeline.currentVersionId !== null && hasVersion(db, pipeline.currentVersionId)) {
        db.update(pipelines).set({ currentVersionId: pipeline.currentVersionId }).where(eq(pipelines.id, pipeline.id)).run();
      }
    }

    // Last, once the step it names exists.
    if (pipeline.entryStepId !== null && hasStep(db, pipeline.entryStepId)) {
      db.update(pipelines).set({ entryStepId: pipeline.entryStepId, projectId }).where(eq(pipelines.id, pipeline.id)).run();
    } else if (projectId !== null) {
      db.update(pipelines).set({ projectId }).where(eq(pipelines.id, pipeline.id)).run();
    }
  });
  return "written";
}

/**
 * The organisation's version history, into this replica's own table.
 *
 * Lifted out of `upsertReplicaPipeline` so that a **diverged** pipeline
 * can have this and nothing else (EO-331): the documents are what
 * *Compare* and *Discard my edits* read, and they are safe to hold
 * because a version is immutable and keyed by its own id.
 *
 * The collision sweep is the case the header above describes: a local
 * row holding the same number as the record's is replaced, and anything
 * standing in it is rebound to the record's row of that number, which
 * is the document it is actually finishing on now.
 */
function storeReplicaVersions(db: Db, pipeline: RecordPipeline): void {
  for (const version of pipeline.versions) {
    const collides = db
      .select({ id: pipelineVersions.id })
      .from(pipelineVersions)
      .where(and(eq(pipelineVersions.pipelineId, pipeline.id), eq(pipelineVersions.number, version.number)))
      .all()
      .filter((row) => row.id !== version.id);
    for (const stale of collides) {
      db.update(items).set({ pipelineVersionId: version.id }).where(eq(items.pipelineVersionId, stale.id)).run();
      db.delete(pipelineVersions).where(eq(pipelineVersions.id, stale.id)).run();
    }
    db.insert(pipelineVersions)
      .values({
        id: version.id,
        pipelineId: pipeline.id,
        number: version.number,
        steps: version.steps,
        routes: version.routes,
        entryStepId: version.entryStepId,
        entryRules: version.entryRules,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        releaseNotes: version.releaseNotes,
      })
      .onConflictDoNothing()
      .run();
  }
}

/** Whether this replica holds that version document yet. */
function hasVersion(db: Db, id: string): boolean {
  return db.select({ id: pipelineVersions.id }).from(pipelineVersions).where(eq(pipelineVersions.id, id)).get() !== undefined;
}

/** Whether this database has that project. */
function hasProject(db: Db, id: string): string | null {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get() === undefined ? null : id;
}

/** The jobs that fire into this project, deleted ones included — a deletion is a fact too. */
export function readProjectJobs(db: Db, projectId: Uuid): RecordJob[] {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, projectId))
    .orderBy(asc(jobs.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      projectId,
      name: row.name,
      trigger: row.trigger,
      pipelineId: row.pipelineId,
      template: row.template ?? null,
      ownerId: row.ownerId,
      threadItemId: row.threadItemId,
      pausedAt: row.pausedAt,
      pausedReason: row.pausedReason,
      budgetPerOccurrenceCents: row.budgetPerOccurrenceCents,
      maxItemsPerHour: row.maxItemsPerHour,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
}

/**
 * What this project's jobs have already done (EO-325).
 *
 * Append-only rows, and the only account there is of a job having
 * fired or been skipped: a record that took the schedule and not the
 * history would fire an occurrence this machine had already fired, and
 * the skip somebody was told about would be gone from the thread it
 * was told in.
 */
export function readProjectOccurrences(db: Db, projectId: Uuid): RecordJobOccurrence[] {
  return db
    .select({ occurrence: jobOccurrences })
    .from(jobOccurrences)
    .innerJoin(jobs, eq(jobs.id, jobOccurrences.jobId))
    .where(eq(jobs.projectId, projectId))
    .orderBy(asc(jobOccurrences.dueAt), asc(jobOccurrences.id))
    .all()
    .map(({ occurrence }) => ({
      id: occurrence.id,
      jobId: occurrence.jobId,
      dueAt: occurrence.dueAt,
      firedAt: occurrence.firedAt,
      status: occurrence.status,
      reason: occurrence.reason,
      itemId: occurrence.itemId,
      offerCommentId: occurrence.offerCommentId,
    }));
}

/**
 * Every row this project holds, counted by table (EO-325).
 *
 * What the move *reports* having moved, and it is read from the
 * database rather than added up from the acknowledgements. Adding them
 * up was wrong in a way a count comparison could not see: the sweep
 * re-sends the structure on every pass to catch a pipeline added mid
 * transfer, so an ordinary two-pass move acknowledged its types,
 * pipelines, steps and routes twice and reported twice as many as
 * exist. A count that says two of something the record holds one of is
 * a count nobody can check anything against.
 *
 * Read here, after every page has been accepted whole — which is what
 * the per-page shortfall check already proves — so this is what the
 * record holds as much as it is what this machine does.
 */
export function countProjectRows(db: Db, projectId: Uuid): Omit<RecordAdoptCounts, "skipped"> {
  const one = (query: SQL): number => db.get<{ n: number }>(query)?.n ?? 0;
  const graphs = sql`(select p.id from ${pipelines} p where p.project_id = ${projectId}
                      union select i.pipeline_id from ${items} i where i.project_id = ${projectId} and i.pipeline_id is not null)`;
  return {
    itemTypes: one(sql`select count(*) as n from ${itemTypes} where project_id = ${projectId}`),
    pipelines: one(sql`select count(*) as n from ${pipelines} where id in ${graphs}`),
    steps: one(sql`select count(*) as n from ${pipelineSteps} where pipeline_id in ${graphs}`),
    routes: one(sql`select count(*) as n from ${stepRoutes} where pipeline_id in ${graphs}`),
    agents: one(sql`select count(*) as n from ${agents} where project_id = ${projectId}`),
    jobs: one(sql`select count(*) as n from ${jobs} where project_id = ${projectId}`),
    occurrences: one(
      sql`select count(*) as n from ${jobOccurrences} o join ${jobs} j on j.id = o.job_id where j.project_id = ${projectId}`,
    ),
    items: one(sql`select count(*) as n from ${items} where project_id = ${projectId}`),
    runs: one(sql`select count(*) as n from ${runs} r join ${items} i on i.id = r.item_id where i.project_id = ${projectId}`),
    runEvents: one(
      sql`select count(*) as n from ${runEvents} e join ${runs} r on r.id = e.run_id join ${items} i on i.id = r.item_id
          where i.project_id = ${projectId}`,
    ),
    transitions: one(
      sql`select count(*) as n from ${transitions} t join ${items} i on i.id = t.item_id where i.project_id = ${projectId}`,
    ),
    comments: one(sql`select count(*) as n from ${comments} c join ${items} i on i.id = c.item_id where i.project_id = ${projectId}`),
    mentions: one(
      sql`select count(*) as n from ${commentMentions} m join ${comments} c on c.id = m.comment_id
          join ${items} i on i.id = c.item_id where i.project_id = ${projectId}`,
    ),
    deps: one(sql`select count(*) as n from ${itemDeps} d join ${items} i on i.id = d.item_id where i.project_id = ${projectId}`),
    extensions: one(
      sql`select count(*) as n from ${itemExtensions} e join ${items} i on i.id = e.item_id where i.project_id = ${projectId}`,
    ),
    attachments: one(
      sql`select count(*) as n from ${attachments} a join ${items} i on i.id = a.item_id where i.project_id = ${projectId}`,
    ),
    memories: one(sql`select count(*) as n from ${memories} where project_id = ${projectId}`),
    skills: one(sql`select count(*) as n from ${skills} where project_id = ${projectId} and scope <> 'global'`),
  };
}

/**
 * Every item on the project, oldest first.
 *
 * Archived and preview items included: the count comparison the story
 * asks for is over the whole table, and an "everything except the bits
 * we thought you would not miss" move is precisely the outcome that
 * criterion exists to rule out.
 *
 * Oldest first because `items.parent_id` points at another item, and a
 * container is created before what it contains. A page boundary can
 * still fall between a parent and a child, which is why the record
 * writes a child whose parent has not arrived with the link dropped
 * rather than refusing it — `writeAdoptedPage` says so where it does it.
 */
export function readProjectItems(db: Db, projectId: Uuid): RecordAdoptedItem[] {
  return db
    .select({ item: items, typeSlug: itemTypes.slug })
    .from(items)
    .innerJoin(itemTypes, eq(itemTypes.id, items.typeId))
    .where(eq(items.projectId, projectId))
    .orderBy(asc(items.createdAt), asc(items.id))
    .all()
    .map(({ item, typeSlug }) => ({
      id: item.id,
      key: item.key,
      typeId: item.typeId,
      typeSlug,
      parentId: item.parentId,
      projectId: item.projectId,
      // The disk stays here; see the file note.
      workspaceId: null,
      title: item.title,
      body: item.body,
      spec: item.spec ?? null,
      pipelineId: item.pipelineId,
      stepId: item.stepId,
      priority: item.priority,
      archivedAt: item.archivedAt,
      heldAt: item.heldAt,
      previewAt: item.previewAt,
      // The trial mark (EO-582): a move must not turn a trial into live work.
      trialAt: item.trialAt,
      createdBy: item.createdBy,
      assigneeId: item.assigneeId,
      // Not sent on the way up. The name is for a *replica* that has no
      // row to point at (EO-367); the record is the one holding the
      // people list, and `adopt.ts` maps this id onto it.
      assigneeName: null,
      // The graph it is being routed by (EO-329). A project handed to a
      // record brings its items' bindings with it, so work mid-flight
      // goes on finishing on the version it entered.
      pipelineVersionId: item.pipelineVersionId,
      // What made it, where a module did (EO-433). With the item rather
      // than in a list of its own, so there is no page on which an item
      // can arrive without it: the record that takes this project over
      // is the one that will be asked "has this key already made
      // something" and "how far down a chain is this", and an item that
      // arrived without the answer would be created again and would
      // count as nobody's.
      origin: originForWire(db, item.id as Uuid),
      // Not here: a move carries the project's whole graph in `deps`.
      waits: null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
}

/** The ids of every item on the project, which is what the rest of the read is keyed on. */
export function projectItemIds(db: Db, projectId: Uuid): Uuid[] {
  return db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.projectId, projectId))
    .orderBy(asc(items.createdAt), asc(items.id))
    .all()
    .map((row) => row.id as Uuid);
}

/**
 * The runs those items produced, oldest first, as the domain reads
 * them.
 *
 * Domain rather than rows, because the shape they travel in —
 * `asRunCommand` — takes a `Run`, and it is that function that decides
 * what stays on this machine. A second reader here would be a second
 * opinion about which of a run's columns mean anything elsewhere.
 */
export function readItemRuns(db: Db, itemIds: readonly Uuid[]): Run[] {
  if (itemIds.length === 0) return [];
  return db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.itemId, [...itemIds]))
    .orderBy(asc(runs.id))
    .all()
    .flatMap((row) => {
      const run = getRun(db, row.id as Uuid);
      return run === undefined ? [] : [run];
    });
}

/** One run's transcript, in the order invariant #3 promises. */
export function readRunTranscript(db: Db, runId: Uuid): RecordRunEvent[] {
  return db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((row) => ({ seq: row.seq, ts: row.ts, type: row.type, payload: row.payload }));
}

/** The moves applied to those items, as audit rows rather than as requests. */
export function readItemTransitions(db: Db, itemIds: readonly Uuid[]): RecordAdoptedTransition[] {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(transitions)
    .where(inArray(transitions.itemId, [...itemIds]))
    .orderBy(asc(transitions.ts), asc(transitions.id))
    .all()
    .map((row) => ({
      id: row.id,
      itemId: row.itemId,
      fromStepId: row.fromStepId,
      toStepId: row.toStepId,
      actor: row.actor,
      reason: row.reason,
      runId: row.runId,
      deviceId: row.deviceId,
      ts: row.ts,
    }));
}

/**
 * The threads on those items — outputs and escalations among them,
 * because those *are* comments (ARCHITECTURE.md, "The record").
 *
 * Oldest first, because `comments.parent_id` is a reply to an earlier
 * comment in the same thread.
 */
export function readItemComments(db: Db, itemIds: readonly Uuid[]): RecordCommentCommand[] {
  if (itemIds.length === 0) return [];
  const rows = db
    .select()
    .from(comments)
    .where(inArray(comments.itemId, [...itemIds]))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
  return rows.map((row) => ({
    kind: "comment" as const,
    // The command's own id, which for a row being copied is the row's:
    // a page re-sent after a lost answer must be the same command
    // twice rather than two commands.
    id: row.id,
    itemId: row.itemId,
    commentId: row.id,
    authorType: row.authorType as RecordCommentCommand["authorType"],
    authorId: row.authorId,
    runId: row.runId,
    parentId: row.parentId,
    body: row.body,
    kindOfComment: row.kind,
    options: parseStoredCommentOptions(row.options),
    // None here, deliberately (EO-325, review). A mention is a row
    // with a status and the reply that answered it, and rebuilding it
    // from a target made every addressed and dismissed one open again.
    // They travel as `RecordAdoptedMentionSchema`, after every comment,
    // because `addressed_by` names one.
    mentions: [],
    pinned: row.pinned,
    attachments: db
      .select()
      .from(attachments)
      .where(eq(attachments.commentId, row.id))
      .all()
      .map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType, size: file.size })),
    createdAt: row.createdAt,
  }));
}

/**
 * The project's dependency graph, as edges the record can write
 * (EO-325).
 *
 * In-project edges only, because `item_deps` has foreign keys both
 * ways and an edge reaching out to work that stayed behind cannot be
 * written on the record at all. `severed` is what those would have been
 * — named rather than dropped, so a move that would cut a dependency
 * stops and says which, instead of quietly handing over a project the
 * record will schedule differently.
 */
export function readProjectDeps(db: Db, itemIds: readonly Uuid[]): { edges: RecordItemDep[]; severed: string[] } {
  if (itemIds.length === 0) return { edges: [], severed: [] };
  const inside = new Set<string>(itemIds);
  const rows = db
    .select()
    .from(itemDeps)
    .where(inArray(itemDeps.itemId, [...itemIds]))
    .orderBy(asc(itemDeps.itemId), asc(itemDeps.dependsOnId))
    .all();
  const edges: RecordItemDep[] = [];
  const severed: string[] = [];
  for (const row of rows) {
    if (inside.has(row.dependsOnId)) edges.push({ itemId: row.itemId, dependsOnId: row.dependsOnId });
    else severed.push(`${keyOf(db, row.itemId)} waits on ${keyOf(db, row.dependsOnId)}, which is not on this project`);
  }
  return { edges, severed };
}

/** What a person calls an item, for a sentence about it. */
function keyOf(db: Db, itemId: string): string {
  return db.select({ key: items.key }).from(items).where(eq(items.id, itemId)).get()?.key ?? itemId;
}

/**
 * What the packs know about these items (EO-325, KAN-148).
 *
 * Domain-neutral: this knows a pack may have state on an item and
 * nothing whatever about what any pack keeps there. The Jira binding is
 * one of these today; the git extension's branch and pull request are
 * another. All of it is a fact about the *work* rather than about the
 * machine that did it, so all of it travels — the machine-local half of
 * that story is `items.workspace_id`, which names a checkout on
 * somebody's disk and is nulled on the way up (ARCHITECTURE.md, "Where a job runs").
 */
export function readItemExtensions(db: Db, itemIds: readonly Uuid[]): RecordItemExtension[] {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(itemExtensions)
    .where(inArray(itemExtensions.itemId, [...itemIds]))
    .orderBy(asc(itemExtensions.itemId), asc(itemExtensions.extension))
    .all()
    .map((row) => ({ itemId: row.itemId, extension: row.extension, data: row.data, updatedAt: row.updatedAt }));
}
/**
 * Every mention on those items' threads, whole (EO-325).
 *
 * Rows rather than targets: `status` is what the inbox and the `!`
 * marker are, and `addressed_by` is which reply made it go away. The
 * adoption rebuilt both from nothing, so an escalation answered a
 * fortnight ago came back open on the record — the same number of rows
 * and a different history, which is exactly what a count comparison
 * cannot see.
 *
 * An agent target with no id is dropped: the row predates `people` and
 * names nobody EO can dispatch.
 */
export function readItemMentions(db: Db, itemIds: readonly Uuid[]): RecordAdoptedMention[] {
  if (itemIds.length === 0) return [];
  return db
    .select({ mention: commentMentions })
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .where(inArray(comments.itemId, [...itemIds]))
    .orderBy(asc(commentMentions.commentId), asc(commentMentions.targetType), asc(commentMentions.targetId))
    .all()
    .flatMap(({ mention }) =>
      mention.targetType !== "human" && mention.targetId === null
        ? []
        : [
            {
              commentId: mention.commentId,
              targetType: mention.targetType as "human" | "agent",
              targetId: mention.targetId,
              status: mention.status,
              addressedBy: mention.addressedBy,
            },
          ],
    );
}

/** Every file on the project, so the move can queue their bytes behind it. */
export interface MovedFile {
  id: Uuid;
  itemId: Uuid;
  /** Null for one of the item's own files (EO-702), which moves with its item. */
  commentId: Uuid | null;
  name: string;
  mimeType: string;
  size: number;
  /** Where the bytes are on this machine, so the move can read and send them. */
  storagePath: string;
  createdAt: number;
}

export function projectAttachments(db: Db, itemIds: readonly Uuid[]): MovedFile[] {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(attachments)
    .where(inArray(attachments.itemId, [...itemIds]))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .all()
    .map((row) => ({
      id: row.id as Uuid,
      itemId: row.itemId as Uuid,
      commentId: row.commentId as Uuid | null,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      storagePath: row.storagePath,
      createdAt: row.createdAt,
    }));
}

// ── Rewriting what named the implicit local person (EO-325) ─────────

/**
 * Everything on this project that pointed at "you", pointed at the
 * person who signed in.
 *
 * The original design's own sentence — *"on first sign-in to a server, mentions that
 * targeted the local person become the signing-in person's"* — and the
 * three other columns that mean the same thing. A mention is what puts
 * a row in somebody's inbox; `created_by` and `assignee_id` are what a
 * card says about whose work it is; a job's owner is who hears about a
 * skipped occurrence.
 *
 * `LOCAL_PERSON_ID` and nothing else. A project may already name a real
 * colleague — an item assigned to somebody the people list knows — and
 * rewriting *those* would be this machine deciding that everybody it
 * had ever named was in fact the person holding the keyboard.
 *
 * On the moved project only. Kept projects are untouched, which is the
 * third bullet's second half and the reason this takes a project rather
 * than sweeping the database.
 */
export function adoptLocalPersonRows(db: Db, projectId: Uuid, localPersonId: Uuid, personId: Uuid): number {
  if (localPersonId === personId) return 0;
  const itemIds = projectItemIds(db, projectId);
  if (itemIds.length === 0) return 0;

  let rewritten = 0;
  db.transaction(() => {
    rewritten += db
      .update(items)
      .set({ createdBy: personId })
      .where(and(inArray(items.id, [...itemIds]), eq(items.createdBy, localPersonId)))
      .run().changes;
    rewritten += db
      .update(items)
      .set({ assigneeId: personId })
      .where(and(inArray(items.id, [...itemIds]), eq(items.assigneeId, localPersonId)))
      .run().changes;
    rewritten += db
      .update(commentMentions)
      .set({ targetId: personId })
      .where(
        and(
          eq(commentMentions.targetType, "human"),
          eq(commentMentions.targetId, localPersonId),
          sql`${commentMentions.commentId} in (select ${comments.id} from ${comments} where ${comments.itemId} in ${itemIds})`,
        ),
      )
      .run().changes;
    rewritten += db
      .update(jobs)
      .set({ ownerId: personId })
      .where(and(eq(jobs.projectId, projectId), eq(jobs.ownerId, localPersonId)))
      .run().changes;
    rewritten += db
      .update(pipelineSteps)
      .set({ ownerPersonId: personId })
      .where(
        and(
          eq(pipelineSteps.ownerPersonId, localPersonId),
          sql`${pipelineSteps.pipelineId} in (select ${pipelines.id} from ${pipelines} where ${pipelines.projectId} = ${projectId})`,
        ),
      )
      .run().changes;
  });
  return rewritten;
}

// ── Writing, on the record that takes the project ───────────────────

/** A row this page carried and the record could not write, with the reason. */
function skip(counts: RecordAdoptCounts, what: string): void {
  counts.skipped.push(what);
}

// ── What a moved agent was attached to and the record has not got ──

const NOTHING_UNARRIVED: UnarrivedTools = { missingMcpServerIds: [], missingSkillIds: [], missing: 0 };

/**
 * One moved agent's tools the record could not attach (EO-513), with
 * what the sender called each, so the thread can be told by name.
 */
const UncarriedToolsSchema = z.object({
  agentName: z.string(),
  mcpServers: z.array(z.object({ id: z.string(), name: z.string() })),
  skills: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type UncarriedTools = z.infer<typeof UncarriedToolsSchema> & { agentId: string };

const UncarriedSchema = z.record(z.string(), UncarriedToolsSchema);
type Uncarried = z.infer<typeof UncarriedSchema>;

/**
 * Where a move keeps them until the project is live (EO-513).
 *
 * Kept rather than said at once, because the project's thread is one of
 * the project's items and arrives on a later page than its agents — a
 * thread opened on the record before then would be a second one beside
 * it. A setting rather than a table: it is one move's working note,
 * small, and gone once it has been said or the move is abandoned.
 */
function uncarriedKey(projectId: string): string {
  return `record.move.uncarriedTools:${projectId}`;
}

function readUncarried(db: Db, projectId: string): Uncarried {
  // Parsed rather than cast: a value an older build may have written.
  const parsed = UncarriedSchema.safeParse(getSetting<unknown>(db, uncarriedKey(projectId), {}));
  return parsed.success ? parsed.data : {};
}

function writeUncarried(db: Db, projectId: string, uncarried: Uncarried): void {
  if (Object.keys(uncarried).length === 0) clearSetting(db, uncarriedKey(projectId));
  else setSetting(db, uncarriedKey(projectId), uncarried);
}

/** Records what one agent's write could not attach, in place of whatever an earlier copy of it left. */
function keepUncarried(db: Db, projectId: string, agent: RecordAgent, unarrived: UnarrivedTools): void {
  const uncarried = readUncarried(db, projectId);
  if (unarrived.missing === 0) {
    delete uncarried[agent.id];
  } else {
    const named = (id: string): { id: string; name: string } => ({ id, name: agent.toolNames?.[id] ?? id });
    uncarried[agent.id] = {
      agentName: agent.name,
      mcpServers: unarrived.missingMcpServerIds.map(named),
      skills: unarrived.missingSkillIds.map(named),
    };
  }
  writeUncarried(db, projectId, uncarried);
}

/** Attaches whatever of the kept tools has since arrived on this record, and keeps the rest. */
function attachLateTools(db: Db, projectId: string): void {
  const uncarried = readUncarried(db, projectId);
  for (const [agentId, kept] of Object.entries(uncarried)) {
    const still = attachArrivedTools(
      db,
      agentId,
      kept.mcpServers.map((server) => server.id),
      kept.skills.map((skill) => skill.id),
    );
    const missing = new Set([...still.missingMcpServerIds, ...still.missingSkillIds]);
    if (missing.size === 0) {
      delete uncarried[agentId];
      continue;
    }
    uncarried[agentId] = {
      agentName: kept.agentName,
      mcpServers: kept.mcpServers.filter((server) => missing.has(server.id)),
      skills: kept.skills.filter((skill) => missing.has(skill.id)),
    };
  }
  writeUncarried(db, projectId, uncarried);
}

/**
 * Says what the moved project's agents were attached to and this record
 * could not attach, and forgets it only once it has been said (EO-513).
 *
 * Only for a project that is live here: until then the move may still
 * be on its way, and what is kept waits for the page that makes it live.
 * Checked again first, so nothing is said about a tool that has arrived
 * since. `say` sends it — a message to the organisation's admins, see
 * `serveAdopt` (EO-727) — and answers whether it could.
 *
 * **One transaction, the saying and the forgetting** (EO-513, review).
 * Forgotten first and said second, a message that failed to go in — or a
 * process that stopped between the two — lost the warning for good, and
 * a retried request found nothing to say. Here a `say` that throws takes
 * the forgetting back with it, and one that answers false leaves it kept:
 * either way the next request says it (invariant 8).
 */
export function sayUncarriedTools(db: Db, projectId: string, say: (uncarried: UncarriedTools[]) => boolean): void {
  db.transaction(() => {
    const project = db.select({ managedAt: projects.managedAt, adoptingAt: projects.adoptingAt }).from(projects).where(eq(projects.id, projectId)).get();
    if (project === undefined || project.managedAt === null || project.adoptingAt !== null) return;
    attachLateTools(db, projectId);
    const uncarried = Object.entries(readUncarried(db, projectId)).map(([agentId, kept]) => ({ agentId, ...kept }));
    if (uncarried.length === 0) return;
    if (say(uncarried)) clearSetting(db, uncarriedKey(projectId));
  });
}

/**
 * One page of somebody's project, written on the record.
 *
 * Nothing here decides *whether* the project may be taken; the caller
 * did that. What this does is write the rows in the order the schema
 * allows them — a page carries several tables and the foreign keys
 * inside one page have to be satisfied in the same pass — and count
 * what it wrote.
 *
 * A row whose prerequisite is genuinely absent is skipped **and said**
 * rather than thrown, which is the difference between "this page half
 * landed and here is which half" and an exception that takes the rest
 * of the page with it. Invariant #8 in the small: nothing is dropped on
 * the floor without a sentence. The caller treats a page that said
 * anything as a failed move — see `RecordAdoptCountsSchema`.
 *
 * ### The counts are what the record *holds*, not what it inserted
 *
 * Which is a correction rather than a preference. Counting `changes`
 * made the answer depend on whether this page had been seen before: a
 * request that was served and whose reply was lost is re-sent, finds
 * every row already there, inserts nothing and would have reported a
 * total loss. So a row that is not skipped is counted, because after
 * this function it is on the record either way — which is the only
 * question the caller is asking.
 */
export function writeAdoptedPage(db: Db, project: RecordProject, page: RecordAdoptPage, deviceId: string): RecordAdoptCounts {
  const counts: RecordAdoptCounts = {
    itemTypes: 0,
    pipelines: 0,
    steps: 0,
    routes: 0,
    agents: 0,
    jobs: 0,
    occurrences: 0,
    items: 0,
    runs: 0,
    runEvents: 0,
    transitions: 0,
    comments: 0,
    mentions: 0,
    deps: 0,
    extensions: 0,
    // Written by `serveAdopt` once the bytes are on disk, because that
    // is where the file store is and this function only has a database.
    attachments: 0,
    memories: 0,
    skills: 0,
    skipped: [],
  };

  db.transaction(() => {
    for (const type of page.itemTypes) {
      counts.itemTypes += 1;
      db
        .insert(itemTypes)
        .values({
          id: type.id,
          projectId: project.id,
          packSlug: type.packSlug,
          slug: type.slug,
          label: type.label,
          plural: type.plural,
          container: type.container,
          specShape: type.specShape,
          actionOverrides: type.actionOverrides,
          createdAt: type.createdAt,
        })
        .onConflictDoUpdate({
          target: itemTypes.id,
          set: {
            label: type.label,
            plural: type.plural,
            container: type.container,
            specShape: type.specShape,
            actionOverrides: type.actionOverrides,
          },
        })
        .run();
    }

    for (const pipeline of page.pipelines) {
      /**
       * Whose graph this is, which decides how much of it may be
       * written (EO-325, the review's fourth finding).
       *
       * A pipeline the project owns exists on the record *because of
       * this project*: nothing else stands on it, so the sender's copy
       * is the truth and the record's is reconciled to it, deletions
       * and all.
       *
       * A pipeline nothing has adopted is the opposite. `listPipelines`
       * shows an unadopted graph to whichever project is asking, so the
       * seeded Delivery board is in every visible way this project's —
       * and it is also, on an organisation's record, *everybody's*.
       * Rewriting it from a move would let one person's local edits to
       * their own default board silently change the routing of every
       * other project on the record. A move carries work, not the
       * organisation's configuration; publishing a graph to an
       * organisation is 7c's (KAN-122) and has a lock and a person's
       * consent attached to it.
       *
       * So a shared graph is written only where the record has not got
       * it, and never modified. An item standing on a step that the
       * record's copy does not have is then refused by name rather than
       * landing in no column — which is the honest failure and the one
       * a person can act on.
       */
      const here = db.select({ projectId: pipelines.projectId }).from(pipelines).where(eq(pipelines.id, pipeline.id)).get();
      if (here !== undefined && here.projectId !== null && here.projectId !== project.id) {
        // Somebody else's graph, under an id this project also uses.
        // Refused outright: there is no reading of a move in which it
        // may rewrite another project's routing.
        skip(counts, `"${pipeline.name}" is another project's graph on this record`);
        continue;
      }
      /**
       * Whether the record holds this as *nobody's*, which is the only
       * thing that decides how much of it may be written.
       *
       * Asked of the record rather than of the sender, and that is the
       * correction. A machine that adopted the seeded board into its
       * own project — which is exactly what first run does — sends it
       * as owned, and the record has the same ids as everybody's. What
       * matters is what is at risk here, not what the sender calls it.
       */
      const shared = here === undefined ? pipeline.projectId === null : here.projectId === null;
      const already = here !== undefined;
      if (shared && already) {
        // Counted as what the record *holds* of what was sent, which is
        // this page's rule everywhere. A step or a route the record's
        // own copy of the shared graph does not have is a genuine
        // difference between the two installations, and it is named:
        // work standing on it would arrive in no column, so the person
        // hears about it rather than discovering it on the board.
        counts.pipelines += 1;
        for (const step of pipeline.steps) {
          if (hasStep(db, step.id)) counts.steps += 1;
          else skip(counts, `this record's shared "${pipeline.name}" has no step "${step.id}", and a move may not change a shared graph`);
        }
        for (const route of pipeline.routes) {
          if (db.select({ id: stepRoutes.id }).from(stepRoutes).where(eq(stepRoutes.id, route.id)).get() !== undefined) counts.routes += 1;
          else skip(counts, `this record's shared "${pipeline.name}" does not have one of its routes, and a move may not change a shared graph`);
        }
        continue;
      }

      // The pipeline first with no entry step, then its steps, then the
      // entry step named. `pipelines.entry_step_id` points into
      // `pipeline_steps` and the steps point back at the pipeline, so
      // one of the two references has to be filled in afterwards; doing
      // it this way round means a graph is never half-written with an
      // entry that does not exist.
      counts.pipelines += 1;
      db
        .insert(pipelines)
        .values({
          id: pipeline.id,
          // Its own project, or nobody's. A pipeline nothing has
          // adopted is shared here and is shared there; claiming it for
          // the moved project would take it away from every other
          // project on the record that was relying on the same rule.
          projectId: shared ? null : project.id,
          name: pipeline.name,
          icon: pipeline.icon,
          entryStepId: null,
          position: pipeline.position,
          previewItem: pipeline.previewItem ?? null,
          // Not `webhookUnattended` (EO-405), here or in the update
          // below: a move carries work, and a pipeline that lands on a
          // record lands with the refusal standing. Whether it may send
          // unread there is for somebody who administers that record.
          // A trial lands as one (EO-582): a move carries work, and must
          // not turn a draft under test into a pipeline the record lists.
          ...trialColumnsOf(pipeline.trial),
          entryRules: pipeline.entryRules,
          archivedAt: pipeline.archivedAt,
          createdAt: pipeline.updatedAt,
          updatedAt: pipeline.updatedAt,
        })
        .onConflictDoUpdate({
          target: pipelines.id,
          // Newer wins, which is what makes a graph edited while its
          // page was in flight land rather than linger at the version
          // the snapshot happened to read.
          set: {
            name: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.name else ${pipelines.name} end`,
            icon: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.icon else ${pipelines.icon} end`,
            position: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.position else ${pipelines.position} end`,
            archivedAt: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.archived_at else ${pipelines.archivedAt} end`,
            // A trial's plan changes between rounds (EO-584); newer wins.
            trialPlan: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.trial_plan else ${pipelines.trialPlan} end`,
            entryRules: sql`case when excluded.updated_at >= ${pipelines.updatedAt} then excluded.entry_rules else ${pipelines.entryRules} end`,
            updatedAt: sql`max(excluded.updated_at, ${pipelines.updatedAt})`,
          },
        })
        .run();

      for (const step of pipeline.steps) {
        counts.steps += 1;
        db.insert(pipelineSteps)
          .values({
            id: step.id,
            pipelineId: pipeline.id,
            position: step.position,
            name: step.name,
            type: step.type,
            ownerRole: step.ownerRole,
            entryAction: step.entryAction,
            instructionsSummary: step.instructionsSummary,
            isTerminal: step.isTerminal,
            planMode: step.planMode,
            workspaceMode: step.workspaceMode,
            // A path on somebody's laptop means nothing here (ARCHITECTURE.md, "Where a job runs").
            workspaceId: null,
            offBoard: step.offBoard,
            inputs: step.inputs,
            timeoutMs: step.timeoutMs,
            ...watchColumns(step.watch ?? null),
            ownerPersonId: knownPerson(db, step.ownerPersonId),
            ownerGroupId: step.ownerGroupId,
            results: step.results,
          })
          // Wholesale, because a step carries no timestamp of its own
          // and travels with the pipeline that does. What the sender
          // has is what the graph is.
          .onConflictDoUpdate({
            target: pipelineSteps.id,
            set: {
              position: step.position,
              name: step.name,
              type: step.type,
              ownerRole: step.ownerRole,
              entryAction: step.entryAction,
              instructionsSummary: step.instructionsSummary,
              isTerminal: step.isTerminal,
              planMode: step.planMode,
              workspaceMode: step.workspaceMode,
              offBoard: step.offBoard,
              inputs: step.inputs,
              timeoutMs: step.timeoutMs,
              ...watchColumns(step.watch ?? null),
              ownerPersonId: knownPerson(db, step.ownerPersonId),
              ownerGroupId: step.ownerGroupId,
              results: step.results,
            },
          })
          .run();
      }

      /**
       * A route the sender no longer has, taken off here too.
       *
       * The review's second finding. Steps and routes carry no version,
       * so the whole graph travels and the record was upserting every
       * row of it and removing none — which meant a route deleted
       * locally mid-transfer stayed on the record and changed where
       * work went after a move that reported success. Routes go first
       * because a step cannot be removed while one leaves it.
       */
      const keptRoutes = new Set(pipeline.routes.map((route) => route.id));
      for (const route of db.select({ id: stepRoutes.id }).from(stepRoutes).where(eq(stepRoutes.pipelineId, pipeline.id)).all()) {
        if (!keptRoutes.has(route.id)) db.delete(stepRoutes).where(eq(stepRoutes.id, route.id)).run();
      }
      for (const route of pipeline.routes) {
        counts.routes += 1;
        db.insert(stepRoutes)
          .values({
            id: route.id,
            pipelineId: pipeline.id,
            fromStepId: route.fromStepId,
            resultKey: route.resultKey,
            label: route.label,
            tone: route.tone,
            target: route.target,
            position: route.position,
          })
          .onConflictDoUpdate({
            target: stepRoutes.id,
            set: { resultKey: route.resultKey, label: route.label, tone: route.tone, target: route.target, position: route.position },
          })
          .run();
      }

      /**
       * …and a step the sender no longer has.
       *
       * Only where nothing is standing on it, which is
       * `replacePipelineGraph`'s own rule said on the other side of the
       * wire: a step an item sits on cannot be removed, here because
       * `items.step_id` is a foreign key and there because taking it
       * away would leave that work in no column. A step that cannot go
       * is *said* rather than passed over, so a graph that cannot be
       * reconciled ends the move instead of quietly differing from the
       * one it was moved from.
       */
      const keptSteps = new Set(pipeline.steps.map((step) => step.id));
      for (const step of db.select({ id: pipelineSteps.id }).from(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipeline.id)).all()) {
        if (keptSteps.has(step.id)) continue;
        const occupied = db.select({ id: items.id }).from(items).where(eq(items.stepId, step.id)).get();
        if (occupied !== undefined) {
          skip(counts, `the step "${step.id}" is no longer on "${pipeline.name}" but this record still has work sitting on it`);
          continue;
        }
        db.delete(stepRoutes).where(eq(stepRoutes.fromStepId, step.id)).run();
        db.delete(pipelineSteps).where(eq(pipelineSteps.id, step.id)).run();
      }

      if (pipeline.entryStepId !== null) {
        db.update(pipelines).set({ entryStepId: pipeline.entryStepId }).where(eq(pipelines.id, pipeline.id)).run();
      }

      // Where it came from, so the record — which compares the
      // pipelines it holds with newer template versions — has the base
      // and the step map an import re-minted (EO-532).
      writeArrivedOrigin(db, pipeline.id, pipeline.origin);
    }

    /**
     * The project's own agents (EO-476), before any run that names one.
     *
     * `runs.agent_id` resolves against this table, and a run whose agent
     * the record has not got is held as nobody's — so the agents come
     * with the graphs, and the moved runs keep saying who did them.
     *
     * Written as the project's, whatever the sender calls them: a move
     * carries one project, and nothing on its pages may scope an agent
     * to another. An id the record already holds for something else — a
     * global agent, or another project's — is refused by name rather
     * than taken over, for the shared graph's reason above. A `system`
     * agent is never a project's own (EO-474), so one arriving here is
     * refused too.
     *
     * Newer wins on a re-send, as it does for a pipeline: an agent edited
     * while its page was in flight lands as edited. The backend and
     * model are the sender's, written as they are: they are what the
     * record will recommend to a replica meeting the agent for the first
     * time. The tool surface is attached where the record holds the
     * server or skill — `replaceReplicaAttachments`' rule, since the
     * catalogues are the installation's and an organisation publishes
     * its own.
     */
    /**
     * The project's own skills and its workspaces' (EO-513), before the
     * agents attached to them: `agent_skills` is a foreign key, and an
     * agent is attached only to a skill the record holds.
     *
     * Written as this project's, whatever the sender calls them, and
     * never a global skill — that is the installation's, and the
     * organisation's catalogue is its own to publish. An id this record
     * holds for something else — a global skill, another project's — is
     * refused by name rather than taken over, as an agent's is. So is a
     * slug another skill here already answers to: the slug is what a
     * model invokes and is unique, and the row holding it is the
     * organisation's or another project's, which a move may not retire.
     * Either refusal ends the move with the sentence saying which skill,
     * and renaming it is the fix.
     *
     * Newer wins on a re-send, as it does for an agent.
     */
    for (const skill of page.skills) {
      if (skill.scope.kind === "global") {
        skip(counts, `the skill "${skill.slug}" is global, and a move carries only a project's own skills`);
        continue;
      }
      if (skill.projectId !== project.id || (skill.scope.kind === "project" && skill.scope.projectId !== project.id)) {
        skip(counts, `the skill "${skill.slug}" is another project's`);
        continue;
      }
      const here = skillOwner(db, skill.id);
      if (here !== undefined && (here.scope === "global" || here.projectId !== project.id)) {
        skip(counts, `the skill "${skill.slug}" is ${here.scope === "global" ? "a global skill" : "another project's skill"} on this record`);
        continue;
      }
      const named = getSkillBySlug(db, skill.slug);
      if (named !== undefined && named.id !== skill.id) {
        skip(counts, `this record already has a skill called "${skill.slug}"; rename the project's skill and move it again`);
        continue;
      }
      if (here !== undefined && here.updatedAt > skill.updatedAt) {
        counts.skills += 1;
        continue;
      }
      const written = writeMovedSkill(db, skill, project.id);
      if (!written.ok) {
        skip(counts, written.problem);
        continue;
      }
      counts.skills += 1;
    }
    // …and an agent written on an earlier page than one of them — a skill
    // made while the move was running — gets it now (EO-513).
    if (page.skills.length > 0) attachLateTools(db, project.id);

    for (const agent of page.agents) {
      if (agent.role === SYSTEM_ROLE) {
        skip(counts, `the agent "${agent.name}" is a system agent, and a system agent cannot belong to a project`);
        continue;
      }
      const here = db.select({ projectId: agents.projectId, updatedAt: agents.updatedAt }).from(agents).where(eq(agents.id, agent.id)).get();
      if (here !== undefined && here.projectId !== project.id) {
        skip(counts, `the agent "${agent.name}" is ${here.projectId === null ? "a global agent" : "another project's agent"} on this record`);
        continue;
      }
      counts.agents += 1;
      if (here !== undefined && here.updatedAt > agent.updatedAt) continue;
      const row = {
        name: agent.name,
        role: agent.role,
        provider: agent.recommendedProvider ?? UNBOUND_BACKEND,
        model: agent.recommendedModel,
        instructions: agent.instructions,
        promptHash: null,
        config: agent.config,
        enabled: agent.enabled,
        archivedAt: agent.archivedAt,
        deletedAt: agent.deletedAt,
        projectId: project.id,
        updatedAt: agent.updatedAt,
        // The sender's count, so the record's next change to it is one
        // more than anything the sender's own desktop could hold.
        revision: agent.revision,
      };
      db.insert(agents)
        .values({ id: agent.id, ...row })
        .onConflictDoUpdate({ target: agents.id, set: row })
        .run();
      // What could not be attached is kept, never dropped (EO-513,
      // invariant 8): a global skill this record has not got, another
      // project's, a server it has no row for. The project's thread is
      // told once the project is live — see `takeUncarriedTools`. Not for
      // a tombstone, which no run will ever be dispatched as.
      const unarrived = replaceReplicaAttachments(db, agent.id, agent.mcpServerIds, agent.skillIds);
      keepUncarried(db, project.id, agent, agent.deletedAt === null ? unarrived : NOTHING_UNARRIVED);
    }

    for (const item of page.items) {
      if (!hasItemType(db, item.typeId)) {
        skip(counts, `${item.key}: this record has no item type "${item.typeSlug}"`);
        continue;
      }
      if (item.stepId !== null && !hasStep(db, item.stepId)) {
        skip(counts, `${item.key}: this record has no step "${item.stepId}"`);
        continue;
      }
      counts.items += 1;
      db
        .insert(items)
        .values({
          id: item.id,
          key: item.key,
          typeId: item.typeId,
          // A container whose page has not arrived yet: the link is
          // dropped rather than the item. A card in no container is
          // visible and repairable; an item left out is neither.
          parentId: hasItem(db, item.parentId),
          workspaceId: null,
          projectId: project.id,
          title: item.title,
          body: item.body,
          spec: item.spec ?? null,
          pipelineId: item.pipelineId,
          // An insert, not an update: a first arrival has no prior
          // position, so this is not a move and invariant #1 is not in
          // play — `replicaRepo.ts` makes the same argument.
          stepId: item.stepId,
          priority: item.priority,
          archivedAt: item.archivedAt,
          heldAt: item.heldAt,
          previewAt: item.previewAt,
          trialAt: item.trialAt,
          createdBy: knownPerson(db, item.createdBy),
          assigneeId: knownPerson(db, item.assigneeId),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })
        .onConflictDoNothing()
        .run();
      updateAdoptedItem(db, item);
      // After the item, which it hangs off, and after the items before
      // it on the page — oldest first, so the item it was created from
      // is already here (EO-433).
      keepArrivedOrigin(db, item.id, item.origin);
    }

    for (const run of page.runs) {
      if (hasItem(db, run.itemId) === null) {
        skip(counts, `run ${run.runId}: this record has no such item`);
        continue;
      }
      counts.runs += 1;
      db
        .insert(runs)
        .values({
          id: run.runId,
          itemId: run.itemId,
          // An agent this record does not have is held as nobody rather
          // than as a dangling id. What the run *did* is in its result
          // and its transcript, and both travel.
          agentId: hasAgent(db, run.agentId),
          action: run.action,
          stepId: run.stepId,
          status: run.status,
          attempt: run.attempt,
          initiationId: run.initiationId,
          interruption: run.interruption,
          result: run.result ?? null,
          verification: run.verification ?? null,
          checks: run.checks ?? null,
          error: run.error,
          tokensIn: run.tokensIn,
          tokensOut: run.tokensOut,
          cacheReadTokens: run.cacheReadTokens,
          cacheWriteTokens: run.cacheWriteTokens,
          turns: run.turns,
          turnsScope: run.turnsScope,
          costCents: run.costCents,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          dryRun: run.dryRun,
          updatedAt: run.updatedAt,
        })
        // Newer wins, so a run that ended while the transfer was in
        // flight lands as it ended rather than as the snapshot read it.
        // The same `updated_at` guard the ordinary sync path applies,
        // said in SQL because this is one statement rather than two.
        .onConflictDoUpdate({
          target: runs.id,
          set: {
            status: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.status else ${runs.status} end`,
            result: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.result else ${runs.result} end`,
            checks: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.checks else ${runs.checks} end`,
            verification: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.verification else ${runs.verification} end`,
            error: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.error else ${runs.error} end`,
            endedAt: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.ended_at else ${runs.endedAt} end`,
            costCents: sql`case when excluded.updated_at >= ${runs.updatedAt} then excluded.cost_cents else ${runs.costCents} end`,
            updatedAt: sql`max(excluded.updated_at, ${runs.updatedAt})`,
          },
        })
        .run();
    }

    for (const batch of page.runEvents) {
      if (hasRun(db, batch.runId) === null) {
        skip(counts, `transcript of run ${batch.runId}: this record has no such run`);
        continue;
      }
      for (const event of batch.events) {
        counts.runEvents += 1;
        db
          .insert(runEvents)
          .values({
            runId: batch.runId,
            seq: event.seq,
            ts: event.ts,
            type: event.type,
            payload: event.payload,
            // Which machine wrote the line. The device that moved the
            // project is the one the record heard it from, which is the
            // truest thing available: the row itself carries no author,
            // because until this moment there was only one machine.
            deviceId,
          })
          .onConflictDoNothing()
          .run();
      }
    }

    for (const move of page.transitions) {
      if (hasItem(db, move.itemId) === null) {
        skip(counts, `move ${move.id}: this record has no such item`);
        continue;
      }
      counts.transitions += 1;
      db
        .insert(transitions)
        .values({
          id: move.id,
          deviceId: move.deviceId ?? deviceId,
          itemId: move.itemId,
          fromStepId: move.fromStepId,
          toStepId: move.toStepId,
          actor: move.actor,
          runId: hasRun(db, move.runId),
          reason: move.reason,
          ts: move.ts,
        })
        .onConflictDoNothing()
        .run();
    }

    for (const comment of page.comments) {
      if (hasItem(db, comment.itemId) === null) {
        skip(counts, `comment ${comment.commentId}: this record has no such item`);
        continue;
      }
      counts.comments += 1;
      db.insert(comments)
        .values({
          id: comment.commentId,
          itemId: comment.itemId,
          authorType: comment.authorType,
          authorId: comment.authorId,
          runId: hasRun(db, comment.runId),
          parentId: hasComment(db, comment.parentId),
          body: comment.body,
          kind: comment.kindOfComment,
          options: comment.options,
          // The file list the thread shows. The rows behind it are
          // written when the bytes land, through the ordinary
          // attachment command — a row pointing at a file the record
          // does not hold is a broken link on the admin's board.
          attachments: comment.attachments,
          pinned: comment.pinned,
          createdAt: comment.createdAt,
        })
        // A comment's body is immutable and its pin is not: somebody
        // reads a thread and marks the part that matters. That is the
        // one field a re-sent comment can be carrying news about.
        .onConflictDoUpdate({ target: comments.id, set: { pinned: comment.pinned } })
        .run();
      // The mentions are not written here (EO-325, review). They are
      // rows with a status and an `addressed_by`, and the second names
      // a comment that came *after* this one — so they travel on their
      // own list, after every comment has landed, and are written
      // below.
    }

    /**
     * Who those comments are asking, and whether it has been answered.
     *
     * Written whole, which is the correction: this used to rebuild the
     * row from a target as `open` with nothing addressing it, so an
     * escalation somebody had answered — or deliberately dismissed —
     * came back open on the record and landed in the signed-in person's
     * inbox. The same number of rows, and a different history.
     *
     * `addressed_by` is a foreign key to `comments`, and the comment
     * that answered a mention is always later than the one it is on.
     * The page order guarantees it is here by now; a reference that
     * still does not resolve is said rather than nulled, because a
     * status of `addressed` with nothing addressing it is a marker that
     * went away for no reason anybody can read.
     */
    for (const mention of page.mentions) {
      if (hasComment(db, mention.commentId) === null) {
        skip(counts, `a mention on a comment this record does not have`);
        continue;
      }
      if (mention.addressedBy !== null && hasComment(db, mention.addressedBy) === null) {
        skip(counts, `a mention answered by a comment this record does not have`);
        continue;
      }
      counts.mentions += 1;
      db.insert(commentMentions)
        .values({
          commentId: mention.commentId,
          targetType: mention.targetType,
          // The person the device resolved, which after the rewrite is
          // the person who signed in. A mention the record cannot name
          // is stored as an absence rather than as a dangling id — it
          // is history, and history with a hole in it is still history.
          targetId: mention.targetType === "agent" ? mention.targetId : knownPerson(db, mention.targetId),
          status: mention.status,
          addressedBy: mention.addressedBy,
        })
        // The three-column primary key, so a re-sent page finds the row
        // and brings its status up to date rather than doubling it.
        .onConflictDoUpdate({
          target: [commentMentions.commentId, commentMentions.targetType, commentMentions.targetId],
          set: { status: mention.status, addressedBy: mention.addressedBy },
        })
        .run();
    }

    for (const job of page.jobs) {
      if (hasItem(db, job.threadItemId) === null) {
        skip(counts, `job "${job.name}": this record has no thread item for it`);
        continue;
      }
      const owner = knownPerson(db, job.ownerId);
      if (owner === null) {
        skip(counts, `job "${job.name}": this record has no row for its owner`);
        continue;
      }
      counts.jobs += 1;
      db
        .insert(jobs)
        .values({
          id: job.id,
          projectId: project.id,
          name: job.name,
          trigger: job.trigger,
          pipelineId: hasPipeline(db, job.pipelineId),
          template: job.template ?? null,
          ownerId: owner,
          threadItemId: job.threadItemId,
          pausedAt: job.pausedAt,
          pausedReason: job.pausedReason,
          budgetPerOccurrenceCents: job.budgetPerOccurrenceCents,
          maxItemsPerHour: job.maxItemsPerHour,
          deletedAt: job.deletedAt,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        })
        .onConflictDoUpdate({
          target: jobs.id,
          // Newer wins, as everywhere else on this page: a job paused
          // or renamed mid-transfer lands paused or renamed.
          set: {
            name: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.name else ${jobs.name} end`,
            trigger: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.trigger else ${jobs.trigger} end`,
            // Which graph it fires into. The review's third finding:
            // `jobs:update` can move a job to another pipeline, every
            // sweep re-sent the job, and this column was the one the
            // conflict clause did not write — so the count matched and
            // the job pointed at the wrong graph.
            pipelineId: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.pipeline_id else ${jobs.pipelineId} end`,
            threadItemId: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.thread_item_id else ${jobs.threadItemId} end`,
            template: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.template else ${jobs.template} end`,
            pausedAt: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.paused_at else ${jobs.pausedAt} end`,
            pausedReason: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.paused_reason else ${jobs.pausedReason} end`,
            budgetPerOccurrenceCents: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.budget_per_occurrence_cents else ${jobs.budgetPerOccurrenceCents} end`,
            maxItemsPerHour: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.max_items_per_hour else ${jobs.maxItemsPerHour} end`,
            deletedAt: sql`case when excluded.updated_at >= ${jobs.updatedAt} then excluded.deleted_at else ${jobs.deletedAt} end`,
            updatedAt: sql`max(excluded.updated_at, ${jobs.updatedAt})`,
          },
        })
        .run();
    }
    // A re-sent job can arrive deleted, on another pipeline or with
    // another trigger, and so stop being a pipeline's webhook entry
    // (EO-405). A waiver given on this record for it goes then, as it
    // does when the job is edited here.
    if (page.jobs.length > 0) dropWebhookWaiversWithoutEntry(db);

    /**
     * What those jobs have already done (EO-325).
     *
     * Append-only, so insert-and-leave-alone: a re-sent page finds the
     * row here and changes nothing, and nothing anywhere may rewrite
     * one — `architecturalInvariants.test.ts` holds `job_occurrences`
     * to the same rule as `run_events` and `transitions`.
     *
     * After the jobs, because `job_id` is a foreign key. `item_id` and
     * `offer_comment_id` carry none on purpose — a firing outlives the
     * item — so they are written as they stand rather than nulled for a
     * row this record may not have.
     */
    for (const occurrence of page.occurrences) {
      if (db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, occurrence.jobId)).get() === undefined) {
        skip(counts, `an occurrence of a job this record does not have`);
        continue;
      }
      counts.occurrences += 1;
      db.insert(jobOccurrences)
        .values({
          id: occurrence.id,
          jobId: occurrence.jobId,
          dueAt: occurrence.dueAt,
          firedAt: occurrence.firedAt,
          status: occurrence.status,
          reason: occurrence.reason,
          itemId: occurrence.itemId,
          offerCommentId: occurrence.offerCommentId,
        })
        .onConflictDoNothing()
        .run();
    }

    /**
     * What a pack knows about each item (EO-325, KAN-148).
     *
     * Item-owned, so it belongs to the item wherever the item goes: the
     * issue it mirrors, the branch its work is on, the pull request it
     * opened. Newer wins, off the row's own `updated_at`.
     *
     * An item this record has not got is a skip rather than a silent
     * drop — extensions are the whole of what a pack knows, and a card
     * that arrived having forgotten what it is attached to is exactly
     * the quiet loss this transfer exists to make impossible.
     */
    for (const extension of page.extensions) {
      if (hasItem(db, extension.itemId) === null) {
        skip(counts, `the ${extension.extension} state of an item this record does not have`);
        continue;
      }
      counts.extensions += 1;
      db
        .insert(itemExtensions)
        .values({
          itemId: extension.itemId,
          extension: extension.extension,
          data: extension.data,
          updatedAt: extension.updatedAt,
        })
        .onConflictDoUpdate({
          target: [itemExtensions.itemId, itemExtensions.extension],
          set: {
            data: sql`case when excluded.updated_at >= ${itemExtensions.updatedAt} then excluded.data else ${itemExtensions.data} end`,
            updatedAt: sql`max(excluded.updated_at, ${itemExtensions.updatedAt})`,
          },
        })
        .run();
    }

    /**
     * The project's memory and its workspaces' (EO-482), retired entries
     * included — memory travels with its project.
     *
     * Written as this project's whatever the sender calls it, as its
     * agents are, and an id this record already holds for another
     * project's entry is refused by name rather than taken over. Newer
     * wins on a re-send, so an entry retired while its page was in flight
     * lands retired. Its source is kept where this record has the run and
     * item it names — sent before it — and held as nobody where it does
     * not, as a run whose agent is missing is: what the entry says is the
     * part that matters.
     */
    for (const entry of page.memories) {
      const here = db.select({ projectId: memories.projectId }).from(memories).where(eq(memories.id, entry.id)).get();
      if (here !== undefined && here.projectId !== project.id) {
        skip(counts, `memory entry ${entry.id} belongs to another project on this record`);
        continue;
      }
      if (entry.scope.kind === "project" && entry.scope.id !== project.id) {
        skip(counts, `memory entry ${entry.id} is another project's`);
        continue;
      }
      counts.memories += 1;
      const source =
        entry.source.type === "run"
          ? {
              ...entry.source,
              runId: hasRun(db, entry.source.runId),
              itemId: hasItem(db, entry.source.itemId),
            }
          : entry.source;
      writeArrivedMemory(db, { ...entry, source, projectId: project.id });
    }

    /**
     * The dependency graph, replaced rather than added to (EO-325).
     *
     * `item_deps` is two ids and nothing else, so an edge has no
     * version and a removed one has nothing to say. So the page carries
     * the project's *complete* set of in-project edges whenever the set
     * has changed, and the record puts it in place of its own for these
     * items. A dependency taken off mid-transfer therefore lands as
     * taken off rather than lingering.
     *
     * Which matters more than a dependency edge sounds like it should:
     * the scheduler will not dispatch an item whose dependency is not
     * done, so a record holding the wrong graph *schedules differently*
     * — work starting on the organisation's board that would not have
     * started on the person's, with nothing about the board looking
     * wrong.
     */
    if (page.graph) {
      const ours = db
        .select({ id: items.id })
        .from(items)
        .where(eq(items.projectId, project.id))
        .all()
        .map((row) => row.id);
      if (ours.length > 0) db.delete(itemDeps).where(inArray(itemDeps.itemId, ours)).run();
      for (const edge of page.deps) {
        if (hasItem(db, edge.itemId) === null || hasItem(db, edge.dependsOnId) === null) {
          skip(counts, `a dependency between items this record does not both have`);
          continue;
        }
        counts.deps += 1;
        db.insert(itemDeps).values({ itemId: edge.itemId, dependsOnId: edge.dependsOnId }).onConflictDoNothing().run();
      }
    }
  });

  return counts;
}

/**
 * An item the record already holds, brought up to date (EO-325).
 *
 * The insert above is what a first arrival takes; this is what a
 * *second* one means, and a transfer has second arrivals by
 * construction: a page can be re-sent after a lost reply, and a person
 * can edit an item while its page is in flight. Without this the record
 * kept whichever version the snapshot happened to read, and a move that
 * reported success committed a stale title.
 *
 * **Everything except where it sits.** `stepId` and `pipelineId` are
 * deliberately absent and their absence is checked by
 * `architecturalInvariants.test.ts`, which reads this `.set({...})` as
 * source text: where an item sits is invariant #1's subject and
 * `transitionItem` is the only writer of it. A step that changed during
 * the transfer arrives as what it is — a move — and is applied through
 * the record's own door; see `serveAdopt`, which is the one place with
 * a record to apply it with. `replicaRepo.ts` draws the same line for
 * the same reason.
 *
 * Newer wins, off the item's own `updated_at`.
 */
function updateAdoptedItem(db: Db, item: RecordAdoptedItem): void {
  db.update(items)
    .set({
      key: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.key} else ${items.key} end`,
      title: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.title} else ${items.title} end`,
      body: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.body} else ${items.body} end`,
      spec: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${JSON.stringify(item.spec ?? null)} else ${items.spec} end`,
      priority: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.priority} else ${items.priority} end`,
      archivedAt: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.archivedAt} else ${items.archivedAt} end`,
      heldAt: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.heldAt} else ${items.heldAt} end`,
      previewAt: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.previewAt} else ${items.previewAt} end`,
      trialAt: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${item.trialAt} else ${items.trialAt} end`,
      parentId: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${hasItem(db, item.parentId)} else ${items.parentId} end`,
      createdBy: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${knownPerson(db, item.createdBy)} else ${items.createdBy} end`,
      assigneeId: sql`case when ${item.updatedAt} >= ${items.updatedAt} then ${knownPerson(db, item.assigneeId)} else ${items.assigneeId} end`,
      updatedAt: sql`max(${item.updatedAt}, ${items.updatedAt})`,
    })
    .where(eq(items.id, item.id))
    .run();
}

/**
 * Writes the project row itself, and says whose it is.
 *
 * Separate from the pages because it happens once and before them —
 * every other table in a page references it — and because this is the
 * one place the record assigns anything: the owner.
 *
 * Refuses a key prefix another project already holds. The prefix
 * numbers the item keys and is unique, so taking it would interleave
 * two projects' numbering; said rather than renamed, because a project
 * whose keys silently changed is one whose every branch name, worktree
 * and link now points at nothing.
 *
 * ### And refuses a project that is somebody else's
 *
 * The review's first finding, and the sharpest of the three. This used
 * to rewrite `owner_id` on every page of every adoption, including one
 * for a project that was already here — so a signed-in device, which
 * learns every project's id through `record:changes`, could send a
 * single empty adopt request naming a colleague's project and become
 * its owner. Deriving the owner from the device token closed the
 * *first* half of that and left this half open.
 *
 * So an existing project may only be written by the person who already
 * owns it, and what that allows is exactly one thing: resuming an
 * adoption of their own that did not finish. A project owned by
 * somebody else, and a project the record made itself and nobody owns,
 * are both refused — there is no request a device can send that takes
 * either.
 *
 * `created` is what the caller uses to tell a fresh transfer from a
 * resumed one.
 */
export type AdoptProjectResult = { ok: true; created: boolean } | { ok: false; problem: string };

export function writeAdoptedProject(
  db: Db,
  project: RecordProject,
  ownerId: Uuid,
  at: number,
  /** Whether this page is the one that ends the transfer and makes the project live. */
  final = false,
): AdoptProjectResult {
  const existing = db.select().from(projects).where(eq(projects.id, project.id)).get();
  if (existing !== undefined) {
    if (existing.ownerId !== ownerId) {
      return {
        ok: false,
        problem:
          existing.ownerId === null
            ? "This record already has a project with that id, and it is not one anybody moved here."
            : "That project belongs to somebody else on this record.",
      };
    }
    // Live only when the last page says so. Until then the project sits
    // with `adopting_at` set: present enough for foreign keys to
    // resolve, invisible to `record:changes`, and out of the
    // scheduler's input.
    //
    // A project that is *already* live stays live, whatever this page
    // says. The owner may still add to it — the sweep that follows a
    // commit carries whatever was written during the commit's own round
    // trip — and re-opening the adoption for that would take a finished
    // project back off every other desktop's board.
    const live = existing.managedAt !== null || final;
    // The moment it becomes live, its graphs page again (EO-325,
    // review). A replica that read one while the project was still
    // arriving — or that simply did not have the project yet — wrote it
    // with no project to attach it to, and nothing about finalising
    // would otherwise have changed a pipeline row, so the cursor would
    // never have offered it a second look.
    if (final && existing.managedAt === null) {
      db.update(pipelines).set({ updatedAt: at }).where(eq(pipelines.projectId, project.id)).run();
      // …and its own agents, for the same reason (EO-476): a replica
      // holds one back while its project has not arrived, but the
      // record's feed leaves out a project still arriving, so the
      // cursor has to be offered them again once it is live.
      db.update(agents).set({ updatedAt: at }).where(eq(agents.projectId, project.id)).run();
      // …and its memory, for the same reason (EO-482): the feed leaves
      // out a project still arriving, and a cursor that moved past its
      // entries meanwhile has to be offered them again.
      db.update(memories).set({ updatedAt: at }).where(eq(memories.projectId, project.id)).run();
      // …and its skills, for the same reason (EO-513) — by the stamp the
      // feed pages on and never by `updated_at`, which is the sender's
      // version: the sweep that follows this commit may still carry an
      // edit made during it, and a record that had just called its own
      // copy newer would acknowledge that edit and keep the old body.
      db.update(skills).set({ localChangedAt: at }).where(eq(skills.projectId, project.id)).run();
    }
    // The name follows the sender, because a project renamed while its
    // transfer was running is a rename the record never heard about
    // otherwise: the row was read once, before the first page, and
    // carried unchanged to the end.
    const named = project.updatedAt >= existing.updatedAt ? { name: project.name } : {};
    db.update(projects)
      .set(
        live
          ? { ...named, managedAt: existing.managedAt ?? at, adoptingAt: null, ownerId, updatedAt: at }
          : { ...named, adoptingAt: existing.adoptingAt ?? at, ownerId, updatedAt: at },
      )
      .where(eq(projects.id, project.id))
      .run();
    return { ok: true, created: false };
  }
  const clash = db.select({ id: projects.id }).from(projects).where(eq(projects.keyPrefix, project.keyPrefix)).get();
  if (clash !== undefined) {
    return {
      ok: false,
      problem:
        `This record already has a project using the key prefix "${project.keyPrefix}", ` +
        `and two projects cannot share one — their item numbering would interleave. ` +
        `Rename the prefix on one of them and move the project again.`,
    };
  }
  db.insert(projects)
    .values({
      id: project.id,
      name: project.name,
      keyPrefix: project.keyPrefix,
      // Not live until the transfer says it is. A one-page move — a
      // project with nothing on it — is `final` on its first request
      // and is live at once, which is the same rule rather than an
      // exception to it.
      managedAt: final ? at : null,
      keptLocalAt: null,
      adoptingAt: final ? null : at,
      ownerId,
      createdAt: project.createdAt,
      updatedAt: at,
    })
    .run();
  return { ok: true, created: true };
}

/**
 * Takes a transfer that did not finish back off the record (EO-325).
 *
 * Only ever an *adopting* project, and only ever the caller's own: a
 * live project is not removed this way and somebody else's is not
 * removed at all. What it undoes is a half-written arrival that nobody
 * could see and nobody could reach — hidden by `adopting_at`, and
 * therefore also invisible to the person whose failed move left it.
 *
 * The items go through `deleteItem`, which is invariant #3's own
 * exemption and the only sanctioned way a row leaves `transitions` or
 * `run_events`: somebody asking for an item to be gone is not the same
 * as rewriting what happened while it existed, and a person abandoning
 * a move they started is asking exactly that of rows that never
 * finished arriving.
 *
 * Answers what it removed, so a caller can say so; nothing needs to.
 */
export function abandonAdoptedProject(db: Db, projectId: Uuid, ownerId: Uuid): { removed: number } | { problem: string } {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (existing === undefined) return { removed: 0 };
  if (existing.ownerId !== ownerId) return { problem: "That project belongs to somebody else on this record." };
  if (existing.adoptingAt === null) {
    return { problem: "That project finished moving here, so there is nothing half-written to take back." };
  }

  // Containers before what they contain would orphan nothing —
  // `deleteItem` takes an item's descendants with it — so the ids are
  // re-read each time rather than held across the loop.
  let removed = 0;
  for (;;) {
    const next = db.select({ id: items.id }).from(items).where(eq(items.projectId, projectId)).get();
    if (next === undefined) break;
    removed += deleteItem(db, next.id as Uuid).deletedItemIds.length;
  }
  db.delete(jobs).where(eq(jobs.projectId, projectId)).run();
  // A waiver somebody gave on this record for a webhook job that has
  // just been taken back does not stay behind for the next one (EO-405).
  dropWebhookWaiversWithoutEntry(db);
  db.delete(stepRoutes)
    .where(sql`${stepRoutes.pipelineId} in (select ${pipelines.id} from ${pipelines} where ${pipelines.projectId} = ${projectId})`)
    .run();
  db.delete(pipelineSteps)
    .where(sql`${pipelineSteps.pipelineId} in (select ${pipelines.id} from ${pipelines} where ${pipelines.projectId} = ${projectId})`)
    .run();
  db.update(pipelines).set({ entryStepId: null }).where(eq(pipelines.projectId, projectId)).run();
  db.delete(pipelines).where(eq(pipelines.projectId, projectId)).run();
  db.delete(itemTypes).where(eq(itemTypes.projectId, projectId)).run();
  // Its agents too (EO-476): they arrived with the half-written project
  // and nothing outside it can name them — their runs were the project's
  // items', and went with them. The attachments cascade.
  db.delete(agents).where(eq(agents.projectId, projectId)).run();
  // …and its memory (EO-482): the copy that arrived with the
  // half-written project. The entries themselves are still on the
  // machine that sent them, which keeps the project.
  db.delete(memories).where(eq(memories.projectId, projectId)).run();
  // …and its skills (EO-513), for the agents' reason: they arrived with
  // the half-written project, and the machine that sent them keeps them.
  // Never a global one, which a move does not write.
  db.delete(skills).where(and(eq(skills.projectId, projectId), sql`${skills.scope} <> 'global'`)).run();
  // …and what this record was keeping to say about its agents' tools.
  clearSetting(db, uncarriedKey(projectId));
  db.delete(projects).where(eq(projects.id, projectId)).run();
  return { removed };
}

/**
 * The record carries this project's key counter forward.
 *
 * Without it the record mints `SUP-1` for the next item on a project
 * whose last one was `SUP-207`, and `items.key` is unique: every item
 * created on the record from then until it caught up would collide with
 * one of the moved rows. `max` rather than a straight write, because the
 * record may already be further ahead on this prefix than the machine
 * that sent it.
 *
 * `next_value` holds the number the *last* item took — the column's
 * name has always been one ahead of what it holds — so zero is the
 * honest value for a prefix nothing has been filed under.
 */
export function carryKeyCounter(db: Db, keyPrefix: string, nextValue: number): void {
  db.insert(keyCounters)
    .values({ prefix: keyPrefix, nextValue })
    .onConflictDoUpdate({ target: keyCounters.prefix, set: { nextValue: sql`max(${keyCounters.nextValue}, excluded.next_value)` } })
    .run();
}

/** How far this prefix's counter has got. Zero where nothing has been filed under it. */
export function keyCounterFor(db: Db, keyPrefix: string): number {
  return db.select().from(keyCounters).where(eq(keyCounters.prefix, keyPrefix)).get()?.nextValue ?? 0;
}

/**
 * Whether a row with this id is here, one small function per table.
 *
 * Written out rather than generalised over a table argument. Drizzle
 * keeps a table's SQL name on a symbol, so a generic version has to
 * reach through that symbol and builds its query as a string — which is
 * the one shape in this file a reviewer cannot check by reading. Six
 * two-line functions are duller and are obviously right.
 */
function hasItem(db: Db, id: string | null): string | null {
  return id !== null && db.select({ id: items.id }).from(items).where(eq(items.id, id)).get() !== undefined ? id : null;
}

function hasRun(db: Db, id: string | null): string | null {
  return id !== null && db.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).get() !== undefined ? id : null;
}

function hasComment(db: Db, id: string | null): string | null {
  return id !== null && db.select({ id: comments.id }).from(comments).where(eq(comments.id, id)).get() !== undefined ? id : null;
}

function hasItemType(db: Db, id: string): boolean {
  return db.select({ id: itemTypes.id }).from(itemTypes).where(eq(itemTypes.id, id)).get() !== undefined;
}

function hasStep(db: Db, id: string): boolean {
  return db.select({ id: pipelineSteps.id }).from(pipelineSteps).where(eq(pipelineSteps.id, id)).get() !== undefined;
}

function hasPipeline(db: Db, id: string | null): string | null {
  return id !== null && db.select({ id: pipelines.id }).from(pipelines).where(eq(pipelines.id, id)).get() !== undefined ? id : null;
}

function hasAgent(db: Db, id: string | null): string | null {
  return id !== null && db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).get() !== undefined ? id : null;
}

/**
 * A person this record has a row for, or null.
 *
 * Null rather than the id, for the reason `upsertReplicaItem` gives: a
 * dangling person id is a card whose assignee cannot be drawn and an
 * inbox query that matches nothing, and the honest shape of "this
 * record does not know who that is" is nobody.
 */
function knownPerson(db: Db, id: string | null): Uuid | null {
  if (id === null) return null;
  return db.select({ id: people.id }).from(people).where(eq(people.id, id)).get() === undefined ? null : (id as Uuid);
}
