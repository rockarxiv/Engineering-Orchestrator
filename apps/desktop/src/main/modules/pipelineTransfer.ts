import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type {
  Agent,
  CustomModule,
  ExportedBoard,
  ExportedConnector,
  ExportedItemType,
  ExportedMcpServer,
  ExportedRole,
  ExportedVocabulary,
  ItemTypeEntry,
  JsonSchemaDocument,
  Pipeline,
  PipelineExport,
  PipelineStep,
  Uuid,
} from "@eo/core";
import {
  addedFieldCollisionMessage,
  addedFieldCollisions,
  MODULE_ENTRY_RULE_KIND,
  ADMIN_GRANT_REFUSAL,
  CONNECTOR_SETUP_REFUSAL,
  ADMIN_MCP_SERVER_NAME,
  allowedToolsOf,
  deprecatedContextMethodsCalledIn,
  deprecatedToolsNamedIn,
  documentBoards,
  documentSteps,
  EO_SERVER_CAPABILITIES,
  instructionsMachineSpecificWarnings,
  isBoundAgent,
  isPreviewAgent,
  JIRA_CONNECTOR,
  jsonSchemaOutputSchema,
  mcpServersNamedIn,
  moduleMachineSpecificWarnings,
  namesAdminServer,
  PIPELINE_EXPORT_VERSION,
  PipelineExportSchema,
  pipelineStepMachineSpecificWarnings,
  qualifiedItemType,
  RESERVED_MCP_SERVER_NAME_LIST,
  resultsFromRoutes,
  roleAskingForAdminGrant,
  servesProject,
  staffingAgents,
  TERMINAL_TARGET,
  USER_ATTENTION_TARGET,
  UNBOUND_BACKEND,
  uuidv7,
  withMemoryNoteGrant,
  type DeprecatedToolName,
  type MachineSpecificWarning,
} from "@eo/core";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  addModuleTests,
  createAgent,
  connectorDefinitionsForProject,
  createDisconnectedConnector,
  createPipeline,
  declareMcpServer,
  getJiraBinding,
  getMcpServerByName,
  getModule,
  hasItemType,
  insertItemType,
  isJiraConnected,
  isTemplateDocument,
  isTrialPipeline,
  listMcpServers,
  listAgents,
  getModuleBySlug,
  getPipeline,
  getPipelineOrigin,
  originBoardKey,
  getProject,
  getStep,
  listActionDefinitionsForRole,
  listItemTypes,
  listModules,
  listModuleTests,
  listRoutesForPipeline,
  listStepsForPipeline,
  recordPipelineOrigin,
  replacePipelineGraph,
  saveModule,
  setAgentAttachment,
  itemTypesFor,
} from "../db/repos/index.js";
import { entryRuleProblems } from "@eo/engine";
import { registry } from "../registry.js";
import { adoptCarriedSchemas, adoptExportedActions, carriedSchemaRefusal, exportedActionRefusal, malformedActionRefusal } from "../actionDefinitionAdoption.js";
import { loadRolePrompt } from "../roles/prompts.js";
import { searchPath } from "../process/searchPath.js";
import { listAvailableNames, type ModuleSecretsOptions } from "./secrets.js";

/**
 * Moving a pipeline between machines (KAN-108).
 *
 * The story the module contract was shaped for. Because a module
 * declares everything it touches and can reach nothing else, an import
 * can be checked against the machine before a line of it runs — which a
 * step holding a shell command line could never have supported.
 *
 * The risk this makes real is worth naming: an exported pipeline carries
 * executable code from somewhere else. Imported modules therefore land
 * unapproved, and `validatePipeline` already refuses to publish a
 * pipeline naming an unapproved module (KAN-104) — so the mitigation is
 * enforcement that already exists rather than a new rule to remember.
 *
 * **A data pack (EO-314, `ARCHITECTURE.md`, "One document").** The document
 * is that pipeline plus the item types with their spec shapes, the roles
 * with prompts and output schemas, the connector definitions, the
 * vocabulary and a template item for Preview — "one file, one format
 * version, the same import gate". The gate widens with it: role slots,
 * connectors and a backend nobody has signed in are needs the preflight
 * states before anything is written, the pack's tool surface is shown as
 * capabilities rather than as tool names, and a role asking for EO's
 * administrative grant is refused outright rather than stripped
 * (invariant #11, ARCHITECTURE.md, "The `eo_admin` grant").
 */

// ── Export ────────────────────────────────────────────────────

export function exportPipeline(db: Db, pipelineId: string): { ok: true; document: PipelineExport } | { ok: false; reason: string } {
  const pipeline = getPipeline(db, pipelineId);
  if (!pipeline) return { ok: false, reason: "That pipeline no longer exists." };
  // A trial is a draft under test, not a pipeline anybody published
  // (EO-582, ARCHITECTURE.md, "Trial pipelines"): it is in no list to
  // export from, and asked for by id it is answered as it is seen.
  if (isTrialPipeline(db, pipelineId)) return { ok: false, reason: "That pipeline no longer exists." };

  // The board asked for, then every board it hands work to (EO-762).
  // A route into another board's step travels with that board, so the
  // file imports elsewhere whole rather than with a route to nowhere.
  const boards = linkedBoards(db, pipelineId);
  const steps = boards.flatMap((board) => board.steps);
  const byId = new Map(listModules(db, true).map((module) => [module.id as string, module]));

  const used: CustomModule[] = [];
  for (const step of steps) {
    if (step.type !== "module" || step.entryAction === null) continue;
    const module = byId.get(step.entryAction);
    if (!module) return { ok: false, reason: `"${step.name}" runs a module this installation no longer has, so the pipeline cannot be exported whole.` };
    if (!used.some((candidate) => candidate.id === module.id)) used.push(module);
  }
  // And the modules its entry rules run (EO-736), which travel the same
  // way: by slug, with their code and their tests.
  for (const rule of boards.flatMap((board) => board.pipeline.entryRules)) {
    if (rule.kind !== MODULE_ENTRY_RULE_KIND || rule.module === undefined) continue;
    const module = byId.get(rule.module);
    if (!module) return { ok: false, reason: `An entry rule runs a module this installation no longer has ("${rule.module}"), so the pipeline cannot be exported whole.` };
    if (!used.some((candidate) => candidate.id === module.id)) used.push(module);
  }

  const slugById = new Map(used.map((module) => [module.id as string, module.slug]));
  const exported = new Set(steps.map((step) => step.id));
  const exportedBoards = boards.map((board) => exportedBoard(db, board, exported, slugById));
  const [first, ...linked] = exportedBoards;
  const rest = linked.map((board, index) => ({ key: exportedBoardKey(db, boards[index + 1]!.pipeline.id), ...board }));

  const roles = exportedRoles(db, steps, pipeline.projectId);
  // Refused here rather than written and refused on the far side. A
  // step-owning agent may not hold the admin grant at all (invariant
  // #11), so this is a document that could only have come from a
  // configuration that is already wrong — and an export nobody can
  // import is a worse way to find that out than a sentence naming the
  // agent.
  if (roles.adminGrantHeldBy !== null) {
    return {
      ok: false,
      reason:
        `"${roles.adminGrantHeldBy}" is allowed EO's admin tools, and a pack may not carry that grant — ` +
        `no installation would be able to import this. Take "${ADMIN_MCP_SERVER_NAME}" off that agent's allowed tools, or export a pipeline that does not use it.`,
    };
  }

  const types = exportedItemTypes(db, pipeline.projectId);
  const connectors = exportedConnectors(db, pipeline.projectId);
  const mcpServers = exportedMcpServers(db, roles.document);

  return {
    ok: true,
    document: {
      eoPipelineExport: PIPELINE_EXPORT_VERSION,
      // Null on an ordinary export, which is what this is: a person
      // sending their graph to a colleague is not publishing a gallery
      // template, and a title and a description invented for them would
      // be EO writing copy about somebody's work (EO-316,
      // `PackTemplateSchema`). A template is authored, and the gallery's
      // bundled packs are where the authored ones live.
      template: null,
      pipeline: first!.pipeline,
      steps: first!.steps,
      routes: first!.routes,
      boards: rest,
      // The roles these steps name, with the prompt each runs on
      // (KAN-178, `ARCHITECTURE.md`, "One document"). What makes this
      // document a pack rather than a graph: a step says it wants an
      // implementer, and without the prompt the receiving machine has
      // no idea what this author's implementer was told to do.
      roles: roles.document,
      // What a pack ships besides a graph (EO-314, ARCHITECTURE.md, "One document"). All of it is
      // read from this project's own rows rather than from what a pack
      // *declares*: the types somebody renamed here are the types this
      // pipeline actually files work under, and exporting the
      // declaration would export a pipeline nobody is running.
      itemTypes: types,
      connectors,
      // The words for the servers those tool surfaces name (EO-314).
      // Names and descriptions only: a document may not carry a command
      // to run — see `ExportedMcpServerSchema`.
      mcpServers,
      vocabulary: vocabularyOf(types, steps),
      // Authored, never harvested — see `PreviewItemSchema`. The newest
      // item on this pipeline is somebody's real work, and a pipeline
      // export is not a thing to put it in. What travels is the example
      // a pack was *written* with, which is the column an import wrote
      // and null on every pipeline somebody drew here.
      previewItem: pipeline.previewItem,
      modules: used.map((module) => ({
        slug: module.slug,
        name: module.name,
        description: module.description,
        code: module.code,
        manifest: module.manifest,
        originalScript: module.originalScript,
        // The cases approving it runs (EO-355), by description and
        // source. Their latest result stays here, with approval: it is
        // a record of this machine running the code.
        tests: listModuleTests(db, module.id).map((test) => ({ description: test.description, source: test.source })),
      })),
      // Approval is absent by design: it records that somebody *here*
      // read this code, and a stranger's word for that is worth nothing.
    },
  };
}

/** A pipeline being exported, with the steps of it that leave. */
interface BoardToExport {
  pipeline: Pipeline;
  steps: PipelineStep[];
}

/**
 * The pipeline asked for, then every pipeline it hands work to, and every
 * one those hand work to, in the order they are reached (EO-762).
 *
 * A route may name a step of another pipeline (EO-58), and a template's
 * boards are wired that way: Delivery sends a pull request's comments to
 * the board they are planned on, and that board sends them back. Such a
 * route used to be dropped on the way out, so the file imported with a
 * result routed nowhere. Now the board it names travels with it, and the
 * route lands on that board's step on the far side.
 *
 * Only the direction work goes: a pipeline that hands work *to* this one
 * is somebody else's, and exporting this one does not export it. A
 * trial is never reached (EO-582), and its routes are dropped as before.
 *
 * Off-board steps are not columns and never leave: they exist so a
 * conversation can host runs, and a conversation is not something a
 * second machine should acquire by importing a pipeline.
 */
function linkedBoards(db: Db, pipelineId: string): BoardToExport[] {
  const boards: BoardToExport[] = [];
  const queue = [pipelineId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const pipeline = getPipeline(db, id);
    if (pipeline === undefined) continue;
    const steps = listStepsForPipeline(db, id).filter((step) => !step.offBoard);
    boards.push({ pipeline, steps });
    const own = new Set(steps.map((step) => step.id));
    for (const route of listRoutesForPipeline(db, id)) {
      if (isSentinel(route.target) || own.has(route.target) || !own.has(route.fromStepId)) continue;
      const holder = getStep(db, route.target);
      if (holder === undefined || holder.offBoard || seen.has(holder.pipelineId) || isTrialPipeline(db, holder.pipelineId)) continue;
      seen.add(holder.pipelineId);
      queue.push(holder.pipelineId);
    }
  }
  return boards;
}

/**
 * The key a further board travels under (EO-762, `ExportedBoardSchema.key`):
 * the key of the template board the pipeline was made from, where it was
 * made from one, so a template's next version exported from an
 * installation of it names its boards as the last one did; otherwise the
 * pipeline's own id, which is unique and means nothing else.
 */
function exportedBoardKey(db: Db, pipelineId: string): string {
  const origin = getPipelineOrigin(db, pipelineId);
  return (origin === null ? null : originBoardKey(origin)) ?? pipelineId;
}

/** One board as the document carries it, its key aside. `exported` is every step on every board that leaves. */
function exportedBoard(db: Db, board: BoardToExport, exported: ReadonlySet<string>, slugById: ReadonlyMap<string, string>): Omit<ExportedBoard, "key"> {
  const { pipeline, steps } = board;
  return {
    // Null rather than a step the document does not carry, for the same
    // reason: `pipelines.entry_step_id` is a foreign key.
    pipeline: {
      name: pipeline.name,
      icon: pipeline.icon,
      entryStepId: pipeline.entryStepId !== null && exported.has(pipeline.entryStepId) ? pipeline.entryStepId : null,
      // Part of what the pipeline says rather than a fact about this
      // machine (EO-610): a type is named by pack and word, and a field
      // by the word its type declares, so both mean the same over there.
      // A module rule names its module by slug, as a step does (EO-736).
      entryRules: pipeline.entryRules.map((rule) =>
        rule.kind === MODULE_ENTRY_RULE_KIND && rule.module !== undefined ? { ...rule, module: slugById.get(rule.module) ?? rule.module } : rule,
      ),
    },
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      // Ids are local; a slug means the same thing on both machines.
      entryAction: step.type === "module" && step.entryAction !== null ? (slugById.get(step.entryAction) ?? step.entryAction) : step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
      // What a person may decide on a human step travels (EO-310).
      // Unlike the inputs and the limits above it is not a fact about
      // this installation: it is the graph's own shape — the buttons
      // the pipeline offers and whether taking one needs a reason —
      // and a document that carried the routes without them would
      // import a step routing results nobody there can choose, which
      // `validatePipeline` refuses.
      results: step.results,
      // And keep checking (EO-456), for the same reason: whether a step
      // waits on something outside EO is what the step does, and a
      // template that watches has to arrive watching.
      watch: step.watch,
    })),
    // Only routes both of whose ends the document carries — on this
    // board or on another it carries (EO-762). Exporting one that
    // references a step the document does not carry produces a dangling
    // reference — and the foreign key on the far side turns that into a
    // half-written import.
    routes: listRoutesForPipeline(db, pipeline.id)
      .filter((route) => exported.has(route.fromStepId) && (isSentinel(route.target) || exported.has(route.target)))
      .map((route) => ({
        fromStepId: route.fromStepId,
        resultKey: route.resultKey,
        label: route.label,
        tone: route.tone,
        target: route.target,
        position: route.position,
      })),
  };
}

/**
 * Each role an exported step is owned by, as the pack carries it.
 *
 * The prompt is the agent's instructions, not the pack's shipped file:
 * EO updates an unedited prompt by itself and leaves an edited one alone
 * (`roles/prompts.ts`), so the text an agent is actually running is the
 * one worth carrying — and the one that can still name `ticket_detail`
 * long after EO's own files stopped.
 *
 * Widened in EO-314 to what the design calls a role: the output schemas its
 * actions are held to, the tool surface it asks for, and the backend and
 * model this installation runs it on. The last two travel as a
 * **recommendation** (ARCHITECTURE.md, "An agent is a row") — they are shown beside the role on
 * import
 * and bind nothing that is not signed in over there.
 *
 * A role with no agent here contributes nothing rather than an empty
 * prompt: a slot the exporting machine never filled is a slot, and
 * inventing a blank prompt for it would tell the receiving machine that
 * this role is meant to run on nothing. Unless it defines actions
 * (EO-424), which are carried under a prompt of null — see
 * `ExportedRoleSchema.prompt`.
 *
 * Archived agents are skipped for the same reason `listAgents` callers
 * skip them elsewhere — a retired agent's prompt is not what this
 * pipeline runs on.
 *
 * **A role, never an agent** (EO-476, ARCHITECTURE.md, "One document").
 * Nothing here names an agent — no id, no name, no project — and the
 * receiving machine chooses who fills the slot. Which agent's prompt
 * the role carries follows the staffing rule's scope: an agent that
 * works for another project never runs this pipeline's work, so its
 * instructions are not this pipeline's role, and the pipeline's own
 * project's agent is preferred over a global one in the same role, as
 * it is on dispatch.
 *
 * `adminGrantHeldBy` comes back rather than being quietly dropped from
 * the list, because the caller has to refuse: see `exportPipeline`.
 */
function exportedRoles(
  db: Db,
  steps: readonly { type: string; ownerRole: string | null }[],
  projectId: string | null,
): { document: ExportedRole[]; adminGrantHeldBy: string | null } {
  const wanted = [...new Set(steps.filter((step) => step.type === "agent" && step.ownerRole !== null).map((step) => step.ownerRole as string))];
  const reaching = listAgents(db).filter((agent) => agent.archivedAt === null && servesProject(agent, { projectId: projectId as Uuid | null }));
  const live = [...reaching.filter((agent) => agent.projectId !== null), ...reaching.filter((agent) => agent.projectId === null)];

  const document: ExportedRole[] = [];
  let adminGrantHeldBy: string | null = null;

  for (const slug of wanted) {
    // Every definition the role has, as it is held (EO-424): the
    // description, each result with its label and meaning, the fields.
    // A pack's own role included, for an action it defines beside the
    // ones it ships.
    const actions = listActionDefinitionsForRole(db, slug).map(({ action, description, results, fields }) => ({ action, description, results, fields }));

    const agent = live.find((candidate) => candidate.role === slug);
    if (agent === undefined) {
      // Nobody in the role here, and so no prompt to carry — but its
      // definitions are the role's rather than an agent's: they are
      // saved without one and stay when the agent is archived. The
      // steps that dispatch them are in this document, so they travel,
      // under a prompt of null that the import makes no agent from.
      if (actions.length > 0) document.push({ slug, prompt: null, schemasByAction: schemasByActionFor(slug), actions, allowedTools: null, backend: null, model: null });
      continue;
    }

    const allowedTools = allowedToolsOf(agent.config);
    // The same predicate the import gate refuses on, so the two cannot
    // come to disagree about what holding the grant looks like — the
    // bare `eo_admin` spelling included.
    if (allowedTools !== null && namesAdminServer(allowedTools)) adminGrantHeldBy = agent.name;

    const recommendation = recommendationOf(agent);
    document.push({
      slug,
      prompt: agent.instructions,
      schemasByAction: schemasByActionFor(slug),
      actions,
      allowedTools,
      ...recommendation,
    });
  }

  return { document, adminGrantHeldBy };
}

/**
 * The backend and model this role travels with (EO-314, ARCHITECTURE.md, "An agent is a row").
 *
 * The agent's own, where somebody here has bound it: that is what this
 * installation runs the role on, and it is the honest recommendation to
 * pass on.
 *
 * And the **pack's own**, where nobody has. An agent imported while its
 * recommended backend was signed out carries no provider (`UNBOUND_BACKEND`),
 * and reading the recommendation off the row would turn "built on Claude,
 * which you are not signed in to" into "built on nothing" — the same pack,
 * passed on one machine further, arriving with the one fact the needs
 * check is made of quietly deleted. So the import writes the pack's
 * recommendation down beside the prompt and this reads it back.
 *
 * The moment somebody picks a backend the row's own answer takes over,
 * which is right: the recommendation was what to do in the absence of a
 * choice, and there is now a choice.
 */
function recommendationOf(agent: Agent): { backend: string | null; model: string | null } {
  if (isBoundAgent(agent)) return { backend: agent.provider, model: agent.model };

  const carried = CarriedRecommendationSchema.safeParse(agent.config[RECOMMENDATION_KEY]);
  return carried.success ? carried.data : { backend: null, model: null };
}

/** Where an unbound imported role keeps the backend its pack was built on. */
const RECOMMENDATION_KEY = "packRecommendation";

const CarriedRecommendationSchema = z.object({
  backend: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
});

/**
 * What a code pack holds this role's shipped actions to, as JSON Schema
 * (EO-314, ARCHITECTURE.md, "One document").
 *
 * The **registry's** schemas: where a code pack ships this role, they
 * are what every run of it is actually held to, and they are zod —
 * `toJsonSchema` is the emitter `OutputSchema` exists to provide.
 *
 * An action the role defines for itself is not here as of EO-424. It
 * used to be, as the schema EO generates from the definition, and the
 * far side's import mapped it back — keys intact, labels guessed, and
 * the description and every meaning lost. It travels whole in the
 * role's `actions` instead.
 *
 * Empty for a role no pack ships, which is honest: a run of it is held
 * to whatever the *action* declares, by whichever role shipped that
 * action (`resultSchemaFor`), and writing that role's shapes down here
 * as though this one owned them would be a claim this document cannot
 * support.
 */
function schemasByActionFor(slug: string): Record<string, JsonSchemaDocument> {
  const entry = registry.roles.get(slug);
  if (entry === undefined) return {};
  return Object.fromEntries([...entry.schemasByAction].map(([action, schema]) => [action, schema.toJsonSchema()]));
}

/**
 * The item types this pipeline's project files work under (EO-314).
 *
 * The project's rows rather than what a pack declares, for
 * `itemTypesFor`'s reason: the rows are what this project *has*, and
 * since KAN-129 a person may have renamed one or added one of their own.
 * Sorted by pack and word so that two exports of the same installation
 * are the same bytes — a document that is diffed (ARCHITECTURE.md, "Divergence and suggestions")
 * may not reorder
 * itself because a row was written a second later.
 */
function exportedItemTypes(db: Db, projectId: Uuid | null): ExportedItemType[] {
  return listItemTypes(db, projectId)
    .map((type) => ({
      packSlug: type.packSlug,
      slug: type.slug,
      label: type.label,
      plural: type.plural,
      container: type.container,
      specShape: type.specShape,
      actionOverrides: { ...type.actionOverrides },
    }))
    .sort((left, right) => qualifiedItemType(left).localeCompare(qualifiedItemType(right)));
}

/**
 * The connectors this project is bound to, as definitions (EO-314).
 *
 * Definitions only: which site, which project key and which token are
 * this installation's and stay here — the design has connectors landing
 * **disconnected** on the far side, which is the same sentence read from
 * the other end. What travels is that this pack talks to Jira at all,
 * which is a line on the needs check rather than a credential.
 *
 * A pipeline with no project carries none. There is nothing dishonest
 * about that: a binding belongs to a project, and a pipeline that
 * belongs to none is bound to nothing.
 */
function exportedConnectors(db: Db, projectId: Uuid | null): ExportedConnector[] {
  if (projectId === null) return [];
  // The words each binding has, which for a connector EO ships are EO's
  // own and for one a pack brought are the pack's — kept on the binding
  // precisely so they survive being imported and exported again.
  return connectorDefinitionsForProject(db, projectId);
}

/**
 * The MCP servers this pack's roles reach, with what each does (EO-314).
 *
 * Taken from the catalogue rows the tool surfaces name, which is where
 * the description lives: a server definition is the only thing that
 * knows what reaching it means, and the machine importing this pack has
 * no row of its own to ask. A server named by a role but not in this
 * catalogue contributes nothing — there is no definition to carry, and
 * inventing a sentence about somebody else's tools is the one thing the
 * capability line must never do.
 *
 * EO's own servers are not here and cannot be: `eo` and `repo` are
 * reserved names no catalogue row may take, and what they do is EO's own
 * sentence (`EO_SERVER_CAPABILITIES`) rather than a fact about the
 * exporting machine.
 */
function exportedMcpServers(db: Db, roles: readonly ExportedRole[]): ExportedMcpServer[] {
  // Read against the names this catalogue actually holds, because
  // Claude's spelling cannot be read without them: `mcp__slack__prod__list`
  // is `slack__prod`'s tool where that server exists and `slack`'s where
  // it does not (`mcpToolId`).
  const catalogue = listMcpServers(db, true).map((server) => server.name);
  const wanted = new Set(roles.flatMap((role) => mcpServersNamedIn(role.allowedTools ?? [], catalogue)));

  return [...wanted]
    .flatMap((name) => {
      const server = getMcpServerByName(db, name);
      // The connector travels with it (EO-315). A setup is a label, a
      // kind, the names values are stored under and where a sign-in
      // goes — no transport, so the rule this function is named for is
      // untouched, and the person on the far side still says how the
      // server runs.
      return server === undefined ? [] : [{ name: server.name, description: server.description, connector: server.connector }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The words this pack puts in front of a person (EO-314, ARCHITECTURE.md, "What a pack labels").
 *
 * Gathered from the document's own contents rather than stored beside
 * them — see `ExportedVocabularySchema` for why a second copy would be a
 * vocabulary nothing keeps true. The types bring their labels, the steps
 * bring the word on every button they offer, and both are what an
 * import reproduces by writing the rows and the graph.
 *
 * A result key appears once, under the first label the pipeline gives
 * it: two steps that both offer `approved` under different words are a
 * pipeline with two buttons, not a vocabulary with two entries, and the
 * per-step wording is already on the step.
 */
function vocabularyOf(types: readonly ExportedItemType[], steps: readonly { results: readonly { key: string; label: string }[] }[]): ExportedVocabulary {
  const results = new Map<string, string>();
  for (const step of steps) {
    for (const result of step.results) {
      if (!results.has(result.key)) results.set(result.key, result.label);
    }
  }

  return {
    types: types.map((type) => ({ type: qualifiedItemType(type), label: type.label, plural: type.plural })),
    results: [...results].map(([key, label]) => ({ key, label })),
  };
}

/** `user_attention` and `terminal` are routing outcomes, not steps. */
function isSentinel(target: string): boolean {
  return target === USER_ATTENTION_TARGET || target === TERMINAL_TARGET;
}

// ── Preflight ─────────────────────────────────────────────────

export interface ImportPreflight {
  pipelineName: string;
  /** Binaries no directory EO searches provides (`process/searchPath.ts`), and which module wants each. */
  missingBinaries: { name: string; wantedBy: string[] }[];
  /** Declared secrets this machine has no value for. */
  missingSecrets: { name: string; wantedBy: string[] }[];
  /** Modules that want the network, so that is a decision rather than a surprise. */
  wantsNetwork: string[];
  /**
   * Modules that declare they read EO's items (EO-74).
   *
   * Reported beside the rest, and unlike the rest it is not a check: the
   * host hands the reads to any module that asks, declared or not. What
   * it tells the person is what the author says this code is for, before
   * they read a line of it.
   */
  readsItems: string[];
  /**
   * Modules that declare they post comments (EO-75).
   *
   * Reported beside the reads and read the same way. What it adds over
   * `readsItems` is direction: a module that reads leaves nothing
   * behind, and one that comments writes into a thread and into the
   * Jira issue mirroring it, which is the part that leaves this machine.
   */
  postsComments: string[];
  /**
   * Modules that declare they attach files (EO-414).
   *
   * Listed apart from the comments because what leaves is different: a
   * comment is words the module composed, and an attachment is a file
   * out of the directory the run worked in, uploaded to the Jira issue
   * on a mirrored item.
   */
  attachesFiles: string[];
  /**
   * Modules that declare they create work items (EO-433).
   *
   * Listed apart because it is the one of these that acts on the board:
   * an item such a module creates lands on a pipeline with nobody
   * accepting it first, so importing and approving it is the gate.
   */
  createsItems: string[];
  /**
   * What in this document is written against the names EO has renamed
   * (KAN-178).
   *
   * The import preflight is the one place a person reads a pack's
   * contents before agreeing to them, so it is where the design's second surface lands: a step
   * whose instructions tell an
   * agent to call `mcp__eo__ticket_detail`, or a module whose code calls
   * `ctx.ticket()`, still works — and stops working one release later,
   * on a machine whose owner did not write either line.
   *
   * A text scan, like `portabilityWarnings` and `readsItems` above: what
   * it reads is prose somebody wrote and code EO will not parse until it
   * runs. Over-eager in the direction that costs a sentence rather than
   * a surprise.
   */
  oldNames: { where: string; names: { deprecated: string; replacement: string }[] }[];
  /**
   * What in this document looks like it only holds on the machine it
   * was written on (EO-451): a path under somebody's home directory, a
   * Windows drive path, a loopback address, a shell one OS has and
   * another does not.
   *
   * Listed here for `oldNames`' reason — this is the one place a person
   * reads a pack's contents before agreeing to them — and with its
   * standing: a text scan, advice, and never a reason to refuse. Grouped
   * the way `oldNames` is, by the role prompt, step or module it was
   * found in, and each warning names where inside that it is: the line,
   * the step's field, the manifest entry, the test case.
   */
  machineSpecific: { where: string; warnings: MachineSpecificWarning[] }[];
  /**
   * The roles this document's steps need, and whether an agent here
   * fills each (`ARCHITECTURE.md`, "Import is the needs check", "An agent is a row").
   *
   * A pack names a role; the installing machine chooses the agent. So
   * importing one creates no agents — "role slots land unfilled" — and
   * what the preflight owes the person is which slots those are, before
   * a step refuses to dispatch for the want of somebody in that role.
   */
  roleSlots: RoleSlot[];
  /**
   * What this pack talks to outside EO, and whether it is connected here
   * (EO-314, ARCHITECTURE.md, "Import is the needs check").
   *
   * Connectors land disconnected, so this is a need rather than a
   * report: the line says a pipeline that mirrors to Jira will mirror
   * nowhere until somebody here points it at a site.
   */
  connectors: {
    slug: string;
    label: string;
    description: string;
    /**
     * The `mcp_servers` name this connector is, which is what a screen
     * acts on (EO-317).
     *
     * The slug names the connector inside the pack; the server name is
     * what EO-315's connectors list is keyed by and what the model sees
     * in every tool id. The needs check's "Connect" button hands off to
     * that row, so the name has to travel with the line — otherwise the
     * screen would be matching two vocabularies by eye.
     *
     * Null where the pack declared a connector that names no server,
     * which is a connector with nothing to sign into — the `none` setup
     * kind from the other end.
     */
    server: string | null;
    connected: boolean;
  }[];
  /**
   * The pack's tool surface, as capabilities (ARCHITECTURE.md, "A connector is an MCP server with a
   * setup flow").
   *
   * One line per MCP server its roles reach — "reads your Slack
   * channels" — rather than a list of tool names. The person agreeing to
   * an import is agreeing to what the pack can *do*, and
   * `mcp__slack__conversations_history` is not a sentence anybody can
   * weigh. Tool names are still in the document for whoever wants them;
   * they are not what the gate asks about.
   */
  capabilities: { server: string; line: string }[];
  /**
   * Why this document cannot be imported at all, or null (EO-314).
   *
   * One case today and it is invariant #11's: a role asking for EO's
   * administrative grant. Separate from the needs above because it is
   * not a need — nothing the person can install, sign into or set makes
   * it green, and the answer is no.
   */
  refusal: string | null;
  /** The types the pack ships, and whether this project already has each. */
  itemTypes: { type: string; label: string; present: boolean; conflict: string | null }[];
  /** A slug already in this catalog. Neither side is overwritten without a choice. */
  collisions: { slug: string; localName: string; incomingName: string }[];
  moduleCount: number;
}

/**
 * A role the document needs, and everything the person has to decide
 * about it (ARCHITECTURE.md, "Import is the needs check", "An agent is a row").
 *
 * `filled` is about *this* machine: an agent in the role that somebody
 * has bound to a backend. The three that follow are the pack's
 * recommendation and the state of it here — shown beside the role,
 * never enforced, because "the author cannot know what the reader has
 * signed in".
 */
export interface RoleSlot {
  slug: string;
  filled: boolean;
  carriesPrompt: boolean;
  /** What the author ran this role on, where the pack says. */
  recommendedBackend: string | null;
  recommendedModel: string | null;
  /**
   * Whether that backend is signed in here. Null when the pack
   * recommends none, or when nothing asked — see `PreflightOptions`.
   */
  backendSignedIn: boolean | null;
}

/**
 * What the preflight knows about the machine it is checking against.
 *
 * `signedInBackends` is asked for rather than looked up, because looking
 * it up means spawning each CLI to ask it (`runtimeAuth`) — a process
 * launch, cached, owned by the IPC layer that already does it for the
 * runtime cards. This module reads a database and a PATH; a provider
 * probe in the middle of it would make every test of an import a test
 * that shells out.
 *
 * Absent means nothing was asked, which is reported as `null` rather
 * than as "signed out": a check that did not run is not a failure, and
 * the design's needs list is explicit that every red line says *why* it is red.
 */
export interface PreflightOptions {
  signedInBackends?: readonly string[];
  /**
   * Which project the import would land in — the same answer
   * `pipelines:import` will resolve, passed rather than worked out
   * here.
   *
   * Absent or null means the caller does not know, and everything
   * scoped to a project reports the honest "not that I can see": an MCP
   * client checking a document with no project in hand is asking about
   * the installation, and a preflight that guessed at one would say a
   * type is already present on the strength of somebody else's project.
   * Item types are read in the installation's own scope then, which is
   * where an import naming no project writes them (EO-735).
   */
  projectId?: Uuid | null;
}

/** Whether any directory on PATH provides an executable of this name. */
function onPath(name: string, path = searchPath()): boolean {
  // An absolute or relative path is checked as given; a bare name is
  // looked up, which is what `ctx.exec` will do with it.
  const candidates = name.includes("/") || name.includes("\\") ? [name] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
      // eslint-disable-next-line no-empty
    } catch {}
    // Windows keeps the extension out of the declared name.
    if (process.platform === "win32") {
      for (const extension of [".exe", ".cmd", ".bat"]) {
        try {
          accessSync(`${candidate}${extension}`, constants.X_OK);
          return true;
          // eslint-disable-next-line no-empty
        } catch {}
      }
    }
  }
  return false;
}

export function parseExport(text: string): { ok: true; document: PipelineExport } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file is not a pipeline export — it is not readable as JSON." };
  }

  const parsed = PipelineExportSchema.safeParse(raw);
  if (!parsed.success) {
    // The one refusal that is not "this file is damaged" (EO-314,
    // invariant #11). The schema rejects an admin-grant entry rather
    // than stripping it, so the document does not parse at all — and
    // the person is owed the reason it did not, in the words the design
    // writes, rather than being told their file is broken.
    if (parsed.error.issues.some((issue) => issue.message === ADMIN_GRANT_REFUSAL)) return { ok: false, reason: ADMIN_GRANT_REFUSAL };
    // The second refusal that is not "this file is damaged" (EO-315).
    // A connector whose setup could not be completed here is refused
    // rather than written half-working, and the author is owed the
    // sentence saying which part of it EO could not read.
    const connector = parsed.error.issues.find((issue) => issue.message.startsWith(CONNECTOR_SETUP_REFUSAL));
    if (connector !== undefined) return { ok: false, reason: connector.message };
    // The third (EO-424): an action definition that is not shaped like
    // one — `fields` as a list, a result with no key. The save's rules
    // refuse it as they refuse a duplicate key, and the author is owed
    // the role and the action either way, not "damaged".
    const malformed = malformedActionRefusal(
      raw,
      parsed.error.issues.map((issue) => issue.path),
    );
    if (malformed !== null) return { ok: false, reason: malformed };
    return { ok: false, reason: "That file is not a pipeline export, or it is damaged." };
  }

  // Refused rather than half-read. A document from a newer EO may carry
  // fields this build would silently drop, and a pipeline that imported
  // *most* of itself is the worst outcome available: it validates, it
  // publishes, and it is not what anyone exported.
  if (parsed.data.eoPipelineExport > PIPELINE_EXPORT_VERSION) {
    return { ok: false, reason: `That pipeline was exported by a newer version of EO (format ${parsed.data.eoPipelineExport}, this build reads ${PIPELINE_EXPORT_VERSION}). Update EO and try again.` };
  }

  return { ok: true, document: parsed.data };
}

/**
 * What this pipeline would need here, before anything is written.
 *
 * The payoff of the whole design. Every answer below comes from what the
 * modules *declared*, and the declarations are enforced at runtime — an
 * undeclared binary is refused by `ctx.exec` — so this is a check rather
 * than a guess.
 */
export function preflightImport(db: Db, secrets: ModuleSecretsOptions, document: PipelineExport, options: PreflightOptions = {}): ImportPreflight {
  // A shared environment variable counts as set (EO-485): a module
  // declaring the name would be given a value, which is the question.
  const setSecrets = new Set(listAvailableNames(secrets));

  const binaries = new Map<string, string[]>();
  const secretNames = new Map<string, string[]>();
  const wantsNetwork: string[] = [];
  const readsItems: string[] = [];
  const postsComments: string[] = [];
  const attachesFiles: string[] = [];
  const createsItems: string[] = [];
  const collisions: ImportPreflight["collisions"] = [];

  for (const module of document.modules) {
    for (const bin of module.manifest.needs.bin) {
      if (onPath(bin)) continue;
      binaries.set(bin, [...(binaries.get(bin) ?? []), module.name]);
    }
    for (const name of module.manifest.needs.env) {
      if (setSecrets.has(name)) continue;
      secretNames.set(name, [...(secretNames.get(name) ?? []), module.name]);
    }
    if (module.manifest.needs.network) wantsNetwork.push(module.name);
    if (module.manifest.needs.item) readsItems.push(module.name);
    if (module.manifest.needs.comment) postsComments.push(module.name);
    if (module.manifest.needs.attach) attachesFiles.push(module.name);
    if (module.manifest.needs.create) createsItems.push(module.name);

    // The most dangerous case in this story: the local module is code
    // somebody here approved, and the incoming one is code from
    // elsewhere with the same name. Never resolved silently.
    const local = getModuleBySlug(db, module.slug);
    if (local) collisions.push({ slug: module.slug, localName: local.name, incomingName: module.name });
  }

  const projectId = options.projectId ?? undefined;

  return {
    pipelineName: document.pipeline.name,
    oldNames: oldNamesIn(document),
    machineSpecific: machineSpecificIn(document),
    roleSlots: roleSlotsIn(db, document, options.signedInBackends, options.projectId ?? null),
    connectors: connectorNeeds(db, document, projectId),
    capabilities: capabilitiesOf(db, document),
    // Stated, not thrown. `parseExport` already refuses a document that
    // names the admin grant, so reaching that one needs a caller holding
    // a document it did not parse here — and the screen it reaches has a
    // line to show rather than an exception to swallow.
    refusal: packRefusal(document),
    itemTypes: document.itemTypes.map((type) => {
      // The row already here under the pack's word, if any, in the scope
      // the import writes to (`writeItemTypes`): the project's, or the
      // installation's where no project is named (EO-735, review). An
      // import never reshapes it, so the one thing to say about it beyond
      // "kept" is a field the document ships under a name this scope gave
      // a field of its own.
      const scope = (projectId ?? null) as Uuid | null;
      const here = listItemTypes(db, scope).find((row) => row.packSlug === type.packSlug && row.slug === type.slug);
      const collisions = here === undefined ? [] : addedFieldCollisions(here.specShape, type.specShape);
      const projectName = scope === null ? null : (getProject(db, scope)?.name ?? null);
      return {
        type: qualifiedItemType(type),
        label: type.label,
        present: here !== undefined,
        conflict: here === undefined || collisions.length === 0 ? null : collisions.map((field) => addedFieldCollisionMessage(here, field, projectName)).join(" "),
      };
    }),
    missingBinaries: [...binaries].map(([name, wantedBy]) => ({ name, wantedBy })),
    missingSecrets: [...secretNames].map(([name, wantedBy]) => ({ name, wantedBy })),
    wantsNetwork,
    readsItems,
    postsComments,
    attachesFiles,
    createsItems,
    collisions,
    moduleCount: document.modules.length,
  };
}

/**
 * The connectors the pack needs, and which of them this project has
 * connected (ARCHITECTURE.md, "Import is the needs check").
 *
 * "Connected" is the binding's own question and not the row's existence:
 * an import writes a row with nothing in it, so a row alone means the
 * connector is known about here rather than reachable. Jira is the one
 * that can answer today; anything else a pack carries is reported
 * unconnected, which is true — nothing here knows how to reach it yet.
 */
function connectorNeeds(db: Db, document: PipelineExport, projectId: Uuid | undefined): ImportPreflight["connectors"] {
  return document.connectors.map((connector) => ({
    slug: connector.slug,
    label: connector.label,
    description: connector.description,
    server: connector.mcpServer,
    connected: projectId !== undefined && connector.slug === JIRA_CONNECTOR && isJiraConnected(getJiraBinding(db, projectId)),
  }));
}

/**
 * The pack's tool surface, one line per MCP server it reaches (ARCHITECTURE.md, "The `eo_admin`
 * grant").
 *
 * Three sources for the sentence, in order: the pack's own connector
 * definition for that server, which is where a pack says what reaching
 * Slack means; EO's own servers, whose words EO owns; and, failing both,
 * the server's name — an honest "uses your `slack` server" rather than
 * an invented description of somebody else's tools.
 *
 * Never a tool name, which is the finding: what a person is agreeing to
 * is what the pack can do, and a list of twelve `mcp__slack__*` strings
 * is a list only its author can read.
 */
function capabilitiesOf(db: Db, document: PipelineExport): ImportPreflight["capabilities"] {
  // Every name anybody here can name: the ones the pack itself carries,
  // the ones its connectors point at, EO's own reserved three, and this
  // catalogue's. Without them a server whose name contains a double
  // underscore is unreadable in Claude's spelling, and the line would
  // fall back to describing a server that does not exist.
  const known = [
    ...document.mcpServers.map((server) => server.name),
    ...document.connectors.flatMap((connector) => (connector.mcpServer === null ? [] : [connector.mcpServer])),
    ...RESERVED_MCP_SERVER_NAME_LIST,
    ...listMcpServers(db, true).map((server) => server.name),
  ];

  const lines: ImportPreflight["capabilities"] = [];
  for (const role of document.roles) {
    for (const server of mcpServersNamedIn(role.allowedTools ?? [], known)) {
      if (lines.some((line) => line.server === server)) continue;
      lines.push({ server, line: capabilityLine(db, document, server) });
    }
  }
  return lines;
}

/**
 * What one server does, in the best words anybody has.
 *
 * Four sources, in the order of who is entitled to describe it. **The
 * pack's own server definition** first: the author added that server and
 * wrote what it reaches, and that sentence is what travelled. Then a
 * **connector** the pack describes the server through, for a pack that
 * says it in that half of the document instead. Then **EO's own
 * servers**, whose words are EO's. Then this machine's **catalogue row**
 * — which is what answers for a document written before descriptions
 * travelled, on a machine that has the server anyway.
 *
 * And failing all four, the server's own name. Honest, and deliberately
 * not a tool list: a person weighing an import is owed either a sentence
 * about what a pack can do or an admission that nobody wrote one, never
 * twelve `mcp__slack__*` strings dressed up as an answer.
 */
function capabilityLine(db: Db, document: PipelineExport, server: string): string {
  const carried = document.mcpServers.find((candidate) => candidate.name === server)?.description;
  if (carried !== undefined && carried !== "") return carried;

  const connector = document.connectors.find((candidate) => candidate.mcpServer === server)?.description;
  if (connector !== undefined && connector !== "") return connector;

  const own = EO_SERVER_CAPABILITIES[server];
  if (own !== undefined) return own;

  const local = getMcpServerByName(db, server)?.description;
  if (local !== undefined && local !== "") return local;

  return `uses your ${server} server`;
}

/**
 * Why this pack cannot be imported at all, or null (EO-314).
 *
 * Not a need and not a warning: a need is a line somebody can turn green
 * by installing, signing in or setting something, and neither of these
 * is. The preflight reports it and the import refuses on it, from one
 * function, so the screen and the write cannot come to different
 * conclusions about the same document.
 */
function packRefusal(document: PipelineExport): string | null {
  if (roleAskingForAdminGrant(document) !== null) return ADMIN_GRANT_REFUSAL;
  return unreadableSchema(document);
}

/**
 * A pack-shipped output schema that is not a JSON Schema EO can read.
 *
 * Compiled here, before anything is written, because that is the only
 * moment refusing costs nothing. A schema that arrives malformed and is
 * stored anyway is a role whose runs are either unvalidated — the
 * registry skips what it cannot compile — or, worse, held to nothing
 * while the pack says they are held to something. Both are silent, and
 * the second is the kind of silence a pack's whole point is to remove.
 *
 * ajv decides, rather than a check of EO's own: it is what compiles the
 * document at dispatch time, and a second opinion here would be a
 * second definition of "valid JSON Schema" for packs to fall between.
 * Its own message is quoted, because "unknown keyword" naming the
 * keyword is what the pack's author can act on.
 */
function unreadableSchema(document: PipelineExport): string | null {
  // Every role-and-action this file defines, across all its roles.
  const definedInThisFile = new Set<string>();
  for (const role of document.roles) {
    for (const [action, schema] of Object.entries(role.schemasByAction)) {
      try {
        jsonSchemaOutputSchema(schema);
      } catch (error) {
        return `The ${role.slug} role's schema for "${action}" is not a JSON Schema EO can read: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    // And one the import could not write down (EO-421). A carried schema
    // lands as the role's definition of that action, through the one
    // save every definition goes through — so a schema whose `result`
    // keys a route could not name is refused here, whole, rather than
    // imported with that role held to nothing.
    const undefinable = carriedSchemaRefusal(role.slug, role.schemasByAction);
    if (undefinable !== null) return undefinable;
    // And a definition the save's rules refuse (EO-424): duplicate or
    // misspelt keys, no results, a field named `result`, fields that do
    // not compile, an action no step dispatches or one a pack ships for
    // this role. Here, for the reason the two above are.
    const unsaveable = exportedActionRefusal(role.slug, role.actions, definedInThisFile);
    if (unsaveable !== null) return unsaveable;
  }
  return null;
}

/**
 * Everything in an export still written against a renamed contract.
 *
 * Both halves of it, because a document carries both: the prompts a
 * pack's steps hand to an agent, which name a tool, and the module code
 * a person is about to be asked to approve, which calls `ctx.ticket()`.
 * One list rather than two, since the sentence the screen prints is the
 * same sentence and the only thing that differs is what `where` says.
 *
 * A step's name is scanned alongside its instructions for the reason the
 * portability scan reads a docstring: the cost of being over-eager is a
 * line that is true anyway.
 */
function oldNamesIn(document: PipelineExport): ImportPreflight["oldNames"] {
  const found: ImportPreflight["oldNames"] = [];

  const add = (where: string, entries: DeprecatedToolName[]): void => {
    if (entries.length === 0) return;
    found.push({ where, names: entries.map((entry) => ({ deprecated: entry.deprecated, replacement: entry.replacement })) });
  };

  // The pack's prompts first, because they are the half of the document
  // written in prose *about* tools: a role prompt telling an agent to
  // "read it with mcp__eo__ticket_detail" is the case KAN-178 exists for,
  // and it arrives on this machine attached to a role nobody here has
  // yet filled.
  for (const role of document.roles) {
    if (role.prompt !== null) add(`the ${role.slug} prompt`, deprecatedToolsNamedIn(role.prompt));
  }
  for (const step of documentSteps(document)) {
    add(step.name, deprecatedToolsNamedIn(`${step.name}\n${step.instructionsSummary ?? ""}`));
  }
  for (const module of document.modules) {
    add(module.name, [...deprecatedToolsNamedIn(module.code), ...deprecatedContextMethodsCalledIn(module.code)]);
  }

  return found;
}

/**
 * Everything in an export that looks like it only holds on the machine
 * it was written on (EO-451), by the thing it was found in.
 *
 * The scan EO-449 and EO-450 run where each of these is saved, run
 * again over what the document carries, because the person reading the
 * import check wrote none of it and has had no save to be warned on:
 *
 *  - each role's prompt, leaving out lines EO itself ships for that
 *    role, for the reason the agent editor does — the system agent's
 *    prompt names `/home/…` as what *not* to write;
 *  - each step's name and instructions summary, and the text inputs a
 *    template's blanks would set on it. The document carries no other
 *    step inputs: they are this installation's facts and are omitted
 *    from it (EO-78), so a template's suggested answer is the one value
 *    an input can arrive with;
 *  - each module's code and manifest, and each of its test cases, with
 *    the output a case scripts left out as it is everywhere else.
 */
function machineSpecificIn(document: PipelineExport): ImportPreflight["machineSpecific"] {
  const found: ImportPreflight["machineSpecific"] = [];
  const add = (where: string, warnings: MachineSpecificWarning[]): void => {
    if (warnings.length > 0) found.push({ where, warnings });
  };

  for (const role of document.roles) {
    if (role.prompt !== null) add(`the ${role.slug} prompt`, instructionsMachineSpecificWarnings(role.prompt, loadRolePrompt(role.slug) ?? null));
  }
  for (const step of documentSteps(document)) {
    add(step.name, pipelineStepMachineSpecificWarnings({ name: step.name, instructionsSummary: step.instructionsSummary, inputs: templateInputsFor(document, step.id) }));
  }
  for (const module of document.modules) {
    add(module.name, moduleMachineSpecificWarnings(module));
  }

  return found;
}

/** The input values a template's blanks would set on one step: `<step id>.<input name>` → its suggested answer. */
function templateInputsFor(document: PipelineExport, stepId: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const blank of document.template?.blanks ?? []) {
    if (blank.kind !== "stepInput" || !blank.key.startsWith(`${stepId}.`)) continue;
    inputs[blank.key.slice(stepId.length + 1)] = blank.default;
  }
  return inputs;
}

/**
 * Which roles this document needs, and what is undecided about each.
 *
 * `carriesPrompt` is the pack half: a document from a build before
 * KAN-178 names roles through its steps and carries no prompts at all,
 * and a slot whose prompt did not travel is a different thing to explain
 * than one whose prompt did.
 *
 * `filled` asks `isDispatchable`'s two questions and `isBoundAgent`
 * beside them (EO-314), because the slot is about whether work arriving
 * on that step will move. All three ways of answering no are rows that
 * exist and dispatch nothing: an archived agent is retired, a disabled
 * one is somebody's "not right now", and an agent imported while its
 * recommended backend was signed out has a prompt and no backend at all.
 * Counting any of them would report a staffed role that cannot run —
 * the exact silence the design's needs list exists to break — and it would
 * also hide the warning that the pipeline about to be imported will sit
 * where it lands.
 *
 * The same predicate every staffing question goes through, rather than a
 * second reading of the columns here: `isDispatchable` is what the
 * scheduler and `validatePipeline` ask, and a preflight that answered
 * differently would be promising something the scheduler then refuses.
 */
function roleSlotsIn(db: Db, document: PipelineExport, signedInBackends: readonly string[] | undefined, projectId: Uuid | null): RoleSlot[] {
  // A preview's own agent staffs nothing here (EO-316): it carries the
  // pack's role name so a rehearsal can walk, and reporting the role
  // filled because one exists would put a green line on the needs check
  // for work that would never run. Nor does another project's agent
  // (EO-474): the pipeline lands on `projectId`, and the scheduler never
  // sends that project's work to it. Both are `staffingAgents`, asked of
  // a real item on the project the import would land in.
  const agents = listAgents(db).filter(isBoundAgent);
  const filledFor = (slug: string): boolean => staffingAgents(agents, slug, { previewAt: null, projectId }).length > 0;
  const carried = new Map(document.roles.map((role) => [role.slug, role]));
  const wanted = [...new Set(documentSteps(document).filter((step) => step.type === "agent" && step.ownerRole !== null).map((step) => step.ownerRole as string))];

  return wanted.map((slug) => {
    const role = carried.get(slug);
    const recommendedBackend = role?.backend ?? null;
    return {
      slug,
      filled: filledFor(slug),
      carriesPrompt: role !== undefined && role.prompt !== null,
      recommendedBackend,
      recommendedModel: role?.model ?? null,
      backendSignedIn: recommendedBackend === null || signedInBackends === undefined ? null : signedInBackends.includes(recommendedBackend),
    };
  });
}

// ── Import ────────────────────────────────────────────────────

/** What to do about a slug this catalog already uses. */
export type CollisionChoice = "reuse" | "import";

export interface ImportPipelineInput {
  document: PipelineExport;
  /**
   * Per colliding slug: keep the local module, or bring the incoming one
   * in beside it under a fresh slug. Anything unanswered is refused
   * rather than guessed.
   */
  choices?: Record<string, CollisionChoice>;
  projectId?: Uuid | null;
  /**
   * The backends this machine is signed in to (EO-314, ARCHITECTURE.md, "An agent is a row").
   *
   * What decides whether an imported role's agent is bound to the
   * backend the pack recommends or lands unbound. Asked for rather than
   * looked up, for `PreflightOptions`' reason — and defaulting to none
   * is the safe direction: an agent nobody has chosen a backend for is
   * visibly unfinished, and one bound to a backend that is not signed in
   * fails at the first dispatch.
   */
  signedInBackends?: readonly string[];
}

export type ImportResult =
  | {
      ok: true;
      /** The document's first board, as a pipeline here. */
      pipelineId: string;
      /** The document's other boards, as pipelines here, in its order (EO-762). Empty for a document of one board. */
      boardPipelineIds: string[];
      /** Every step of every board, the document's id to the id it was written under here (EO-762): what the form's step inputs and owners are laid onto. */
      stepIds: Record<string, string>;
      unapprovedModules: string[];
      /**
       * The ids of the modules this import wrote (EO-355), so the caller
       * can run their tests: a module that arrived with cases and no run
       * of them reads as untested until something runs them, and the
       * import is when they are new.
       */
      createdModuleIds: string[];
      /**
       * The definitions this document carried that the installation
       * already had differently, and kept (EO-424). Named back so the
       * summary can say the pipeline will run on the installed
       * definition rather than the file's.
       */
      keptDefinitions: { role: string; action: string }[];
    }
  | { ok: false; reason: string };

/**
 * `deploy` → `deploy-2`, `deploy-3`, … — the first free name.
 *
 * `taken` carries the slugs claimed earlier in this same import as well
 * as the catalog's. Asking the database alone renamed a colliding module
 * to `deploy-2` when the document itself contained a `deploy-2`, which
 * then collided with a row that did not exist at preflight — so no answer
 * the person could have given would have covered it.
 */
function freeSlug(slug: string, taken: Set<string>): string {
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${uuidv7()}`;
}

/**
 * Everything the document says about itself that has to be true before
 * any of it is written.
 *
 * `PipelineExportSchema` checks shape, not references: `entryStepId` and
 * a route's `fromStepId`/`target` are plain strings, and they land in
 * columns with real foreign keys. Reaching the insert with a bad one
 * threw a raw `SqliteError` out of a function whose type promises
 * `{ ok: false, reason }` — and left a pipeline row and its modules
 * behind, which is precisely the half-written import `parseExport`'s own
 * comment says must never happen.
 */
function referenceProblem(document: PipelineExport): string | null {
  const boards = documentBoards(document);
  const steps = documentSteps(document);
  // Every board's steps, because a route on one board may name a step on
  // another (EO-762), and a step id names one step in the whole document.
  const stepIds = new Set(steps.map((step) => step.id));
  if (stepIds.size !== steps.length) return "This document has two steps with the same id.";
  // A board's key is what names it to the next version of a template, so two boards on one key would be one board twice.
  if (new Set(document.boards.map((board) => board.key)).size !== document.boards.length) return "This document has two boards with the same key.";

  for (const board of boards) {
    const own = new Set(board.steps.map((step) => step.id));
    if (board.pipeline.entryStepId !== null && !own.has(board.pipeline.entryStepId)) {
      return `This document says work enters "${board.pipeline.name}" at "${board.pipeline.entryStepId}", which is not one of that board's steps.`;
    }
    for (const route of board.routes) {
      if (!own.has(route.fromStepId)) return `A route leaves "${route.fromStepId}", which is not one of the steps of "${board.pipeline.name}" in this document.`;
      if (!isSentinel(route.target) && !stepIds.has(route.target)) {
        return `A route sends "${route.resultKey}" to "${route.target}", which is not a step on any of this document's boards.`;
      }
    }
  }
  if (new Set(document.modules.map((module) => module.slug)).size !== document.modules.length) {
    return "This document declares the same module slug twice.";
  }
  for (const step of steps) {
    if (step.type !== "module" || step.entryAction === null) continue;
    if (!document.modules.some((module) => module.slug === step.entryAction)) {
      return `"${step.name}" runs a module ("${step.entryAction}") that this document does not carry.`;
    }
  }
  return null;
}

/**
 * An entry rule naming a module neither the document carries nor this
 * installation has (EO-736), refused by name: imported, it would refuse
 * every item at the door.
 */
function entryRuleModuleProblem(db: Db, document: PipelineExport): string | null {
  for (const rule of documentBoards(document).flatMap((board) => board.pipeline.entryRules)) {
    if (rule.kind !== MODULE_ENTRY_RULE_KIND || rule.module === undefined) continue;
    const slug = rule.module;
    if (!document.modules.some((module) => module.slug === slug) && getModuleBySlug(db, slug) === undefined) {
      return `An entry rule runs the module "${slug}", which this document does not carry and this installation does not have.`;
    }
  }
  return null;
}

/**
 * What `validatePipeline` would say about the document's entry rules
 * (EO-610), held to the types the project has and the ones the document
 * brings with it, since those land in the same transaction.
 */
function entryRulesProblem(db: Db, document: PipelineExport, projectId: Uuid | null): string | null {
  const types = new Map([...itemTypesFor(db, projectId), ...document.itemTypes.map((type) => [qualifiedItemType(type), type] as const)]);
  for (const board of documentBoards(document)) {
    const problem = entryRuleProblems(board.pipeline.entryRules, types, registry.entryRuleKinds)[0];
    if (problem !== undefined) return problem;
  }
  return null;
}

/**
 * Brings a document in, or changes nothing at all.
 *
 * Every write happens inside one transaction, and every reason to refuse
 * is established before the first of them. Both halves of that were
 * missing: a document could be refused *after* its first module was
 * inserted, and a dangling step reference threw out of the middle — each
 * leaving orphan modules and an empty pipeline behind, with the person
 * told the import failed.
 */
export function importPipeline(db: Db, input: ImportPipelineInput): ImportResult {
  const { document, choices = {} } = input;

  // ── Everything that can refuse, before anything is written ──

  // Invariant #11, at the gate and not only in the schema (ARCHITECTURE.md, "The `eo_admin`
  // grant"), and beside it the schemas this pack would be validated
  // against. `parseExport` refuses a document that names the admin
  // grant, so a document arriving here with one came from a caller that
  // built it in code — and "the path that parsed it checked" is the kind
  // of reasoning that holds until somebody adds a second path.
  const refusal = packRefusal(document);
  if (refusal !== null) return { ok: false, reason: refusal };

  const problem = referenceProblem(document) ?? entryRuleModuleProblem(db, document) ?? entryRulesProblem(db, document, input.projectId ?? null);
  if (problem !== null) return { ok: false, reason: problem };

  // Slugs claimed here already, plus the ones this document is about to
  // claim, so a rename cannot collide with a later module in the same
  // document.
  const taken = new Set(listModules(db, true).map((module) => module.slug));

  // Slug → the module id a step should point at here; and what to write.
  const idBySlug = new Map<string, string>();
  const toCreate: { slug: string; from: (typeof document.modules)[number] }[] = [];

  for (const module of document.modules) {
    const local = getModuleBySlug(db, module.slug);
    if (local) {
      const choice = choices[module.slug];
      if (choice === undefined) {
        return { ok: false, reason: `"${module.slug}" already exists here. Choose whether to reuse yours or import theirs alongside it.` };
      }
      if (choice === "reuse") {
        idBySlug.set(module.slug, local.id);
        continue;
      }
    }

    // Renamed when the catalog holds the slug *or* when an earlier
    // rename in this same document has just claimed it. The second case
    // is not something the person could have been asked about — the
    // colliding name did not exist when preflight ran — so it is
    // resolved rather than refused.
    const slug = local || taken.has(module.slug) ? freeSlug(module.slug, taken) : module.slug;
    taken.add(slug);
    toCreate.push({ slug, from: module });
  }

  // ── The writes ──────────────────────────────────────────────

  let pipelineId = "";
  let boardPipelineIds: string[] = [];
  let stepIds: Record<string, string> = {};
  let keptDefinitions: { role: string; action: string }[] = [];
  try {
    db.transaction(() => {
      ({ pipelineId, boardPipelineIds, stepIds, keptDefinitions } = writeImport(db, document, toCreate, idBySlug, input.projectId ?? null, input.signedInBackends ?? []));
    });
  } catch (error) {
    // Rolled back by the transaction, so there is nothing half-written to
    // clean up — but the caller is promised a reason rather than a throw.
    return { ok: false, reason: `That pipeline could not be imported: ${error instanceof Error ? error.message : String(error)}` };
  }

  return {
    ok: true,
    pipelineId,
    boardPipelineIds,
    stepIds,
    keptDefinitions,
    createdModuleIds: toCreate.flatMap(({ from }) => {
      const id = idBySlug.get(from.slug);
      return id === undefined ? [] : [id];
    }),
    // Named back, so the screen can say what still has to be read before
    // this pipeline will publish.
    unapprovedModules: document.modules
      .filter((module) => {
        const id = idBySlug.get(module.slug);
        return id !== undefined && getModule(db, id)?.approvedAt === null;
      })
      .map((module) => module.name),
  };
}

/** The write half, run inside one transaction by `importPipeline`. */
function writeImport(
  db: Db,
  document: PipelineExport,
  toCreate: { slug: string; from: PipelineExport["modules"][number] }[],
  idBySlug: Map<string, string>,
  projectId: Uuid | null,
  signedInBackends: readonly string[],
): { pipelineId: string; boardPipelineIds: string[]; stepIds: Record<string, string>; keptDefinitions: { role: string; action: string }[] } {
  writeItemTypes(db, document, projectId);
  const keptDefinitions = writeRoles(db, document, signedInBackends, projectId);
  writeConnectors(db, document, projectId);
  attachDeclaredServers(db, document, writeMcpServers(db, document));

  for (const { slug, from: module } of toCreate) {
    const saved = saveModule(db, {
      slug,
      name: module.name,
      description: module.description,
      code: module.code,
      manifest: module.manifest,
      originalScript: module.originalScript,
      source: "import",
      // Never approved on arrival. This is the whole mitigation for a
      // document carrying executable code from another machine, and
      // KAN-104 is what enforces it: a pipeline naming an unapproved
      // module cannot be published.
      approve: false,
    });
    // Thrown rather than returned: this runs inside the transaction, so a
    // throw is what rolls the earlier writes back.
    if (!saved.ok) throw new Error(saved.reason);
    // Its cases, every one and in the order the document lists them
    // (EO-355), two that read identically included. A document from
    // before tests travelled carries none, and the module arrives with
    // none: not fully tested, which is what it is.
    for (const added of addModuleTests(db, saved.module.id, module.tests, { skipExisting: false })) {
      if (!added.ok) throw new Error(added.reason);
    }
    idBySlug.set(module.slug, saved.module.id);
  }

  // Step ids are re-minted rather than kept.
  //
  // `pipeline_steps.id` is a primary key across the whole table, not one
  // scoped to a pipeline — so importing a document into the installation
  // it came from, or into one that happens to use `review` as a step id,
  // collides on the way in. Keeping the ids would work exactly until the
  // first time somebody imported their own export.
  //
  // Everything that references a step therefore moves with them: a
  // route's `fromStepId`, a route's `target` when it names a step rather
  // than a sentinel, and where work enters. One map across every board
  // (EO-762), so a route from one board into another lands on the step
  // as it is written here.
  const stepIdMap = new Map(documentSteps(document).map((step) => [step.id, uuidv7() as string]));
  const mapped = (id: string): string => stepIdMap.get(id) ?? id;

  // Every board, each a pipeline of its own, in this one transaction
  // (EO-762): a template whose second board failed to write is not
  // installed at all, rather than installed with routes into nothing.
  const pipelineIds = documentBoards(document).map((board, index) => {
    const pipeline = createPipeline(db, {
      projectId,
      name: board.pipeline.name,
      icon: board.pipeline.icon,
      // In the document's order, after everything already on the rail.
      position: Date.now() + index,
      // The pack's example, kept as the pack wrote it (EO-314), on the
      // board it is an example for. Nothing is filed from it: making it
      // into an item is Preview's, and doing it here would put an item on
      // somebody's board that nobody asked for.
      previewItem: index === 0 ? document.previewItem : null,
    });

    // Into a pipeline created a moment ago, which has no steps and so no
    // items on any of them: the graph write cannot meet the refusal a
    // removed step with items on it earns (EO-230). Asserted rather than
    // ignored, because a result that says the write did not happen is not
    // one to walk past on the way to reporting a success.
    const written = replacePipelineGraph(
      db,
      pipeline.id,
      board.steps.map((step) => ({
        id: mapped(step.id),
        pipelineId: pipeline.id,
        position: step.position,
        name: step.name,
        type: step.type,
        ownerRole: step.ownerRole,
        entryAction: step.type === "module" && step.entryAction !== null ? (idBySlug.get(step.entryAction) ?? step.entryAction) : step.entryAction,
        instructionsSummary: step.instructionsSummary,
        isTerminal: step.isTerminal,
        planMode: step.planMode,
        offBoard: false,
        // The keys travel unchanged (EO-310): only ids are local, and a
        // result key is a word the document chose, matched to the route
        // that carries the same one.
        //
        // Run through the same helper every other writer of a graph uses,
        // so an imported human step offers exactly the branches the
        // document draws, labelled the way the document draws them. What
        // the declaration brings with it and the routes cannot is
        // `requiresComment`, and that is what the helper keeps — a
        // document whose two halves disagreed about a button's words
        // would otherwise be imported disagreeing, and nothing here
        // edits either side afterwards.
        results: resultsFromRoutes(step, board.routes),
        // Keep checking arrives as the document says (EO-456): part of
        // the graph, and absent from a document written before it existed,
        // which reads as a step that runs once.
        watch: step.watch,
      })),
      board.routes.map((route) => ({
        ...route,
        pipelineId: pipeline.id,
        fromStepId: mapped(route.fromStepId),
        // `user_attention` and `terminal` are sentinels, not steps, and
        // `mapped` leaves anything it does not know alone. A step of
        // another board is mapped like one of this board's.
        target: mapped(route.target),
      })),
      // Where work enters lands with the graph, inside the same
      // transaction and inside the version that freezes both (EO-327):
      // an imported pipeline whose entry step arrived a statement later
      // would have a v1 that froze the wrong one.
      {
        entryStepId: board.pipeline.entryStepId === null ? null : mapped(board.pipeline.entryStepId),
        // A module rule's slug back to the module it means here (EO-736): one
        // this document brought, or the one this installation already has.
        entryRules: board.pipeline.entryRules.map((rule) => {
          if (rule.kind !== MODULE_ENTRY_RULE_KIND || rule.module === undefined) return rule;
          return { ...rule, module: idBySlug.get(rule.module) ?? getModuleBySlug(db, rule.module)?.id ?? rule.module };
        }),
      },
    );
    if (!written.replaced) throw new Error(`A freshly created pipeline refused its graph: ${written.holding.map((hold) => hold.stepId).join(", ")}`);

    // Where it came from (EO-531), inside the same transaction as the
    // graph. A document carrying a `template` block is a template version
    // — installed from the gallery, previewed, or dropped in as a file —
    // and the pipeline made from it remembers which one, with the
    // document itself stored as its base. The step map is written here
    // because this is the only place it exists: the ids were re-minted a
    // moment ago, and nothing afterwards could say which uuid was `review`.
    //
    // Each board's map names that board's steps and no others: that is
    // how a pipeline knows which of the template's boards it is
    // (`boardHolding`, `sameBoard`, EO-762).
    if (isTemplateDocument(document)) {
      recordPipelineOrigin(db, { pipelineId: pipeline.id, document, stepIds: Object.fromEntries(board.steps.map((step) => [step.id, mapped(step.id)])) });
    }
    return pipeline.id;
  });

  const [pipelineId, ...boardPipelineIds] = pipelineIds;
  return { pipelineId: pipelineId!, boardPipelineIds, stepIds: Object.fromEntries(stepIdMap), keptDefinitions };
}

/**
 * The pack's item types, into the project the pipeline lands in
 * (EO-314, ARCHITECTURE.md, "One document").
 *
 * Skipped where the project already has that pack's word, and never
 * overwritten: a type here may have been renamed by the person who owns
 * it (ARCHITECTURE.md, "An item type is data"), and an import that re-labelled "Case" back to
 * whatever the
 * author called it would rewrite their board on the way past. Which of
 * the two a person is looking at is what the preflight's `itemTypes`
 * line says before any of this runs.
 *
 * Into the scope the pipeline lands in, which is the scope the export
 * read them from: a project's, or — where the import names no project,
 * as it does on an installation that has none — the installation's.
 * Symmetric on purpose, so that a document exported from one scope
 * reproduces in the matching one; the consequence worth knowing is that
 * the installation scope is what a new project is stamped from
 * (`copyItemTypesToProject`), so types imported there are types every
 * project created afterwards starts with.
 */
function writeItemTypes(db: Db, document: PipelineExport, projectId: Uuid | null): void {
  for (const type of document.itemTypes) {
    if (hasItemType(db, projectId, type.packSlug, type.slug)) continue;
    const entry: ItemTypeEntry = {
      packSlug: type.packSlug,
      slug: type.slug,
      label: type.label,
      plural: type.plural,
      container: type.container,
      specShape: type.specShape,
      actionOverrides: type.actionOverrides,
    };
    insertItemType(db, projectId, entry);
  }
}

/**
 * The pack's roles, as agents (EO-314, ARCHITECTURE.md, "Import is the needs check", "An agent is a
 * row").
 *
 * One row per role this machine has nobody in, carrying everything the
 * pack shipped about it: the prompt, the tool surface — minus the grant
 * this document could not have contained and still been parsed. The
 * output schemas it carries become the role's action definitions
 * (EO-421), through `adoptCarriedSchemas`: they lived on the row's
 * config until a role's actions had somewhere of their own to be kept.
 *
 * The definitions it carries as `actions` (EO-424) are written for every
 * role in the document, staffed here or not, and the ones this
 * installation already had differently come back to be named.
 *
 * **Bound only where the recommendation is signed in.** ARCHITECTURE.md, "An agent is a row": a
 * pack may
 * recommend a backend and model, and may not require one. Signed in, the
 * agent is ready and enabled; otherwise it lands `UNBOUND_BACKEND` and
 * disabled, which is a row that says what it is for and admits the one
 * decision nobody here has made. Either way nothing is overwritten: a
 * role somebody already has an agent in keeps theirs, prompt and all,
 * because their edited prompt is theirs (U-06) and an import is not a
 * reason to lose it.
 *
 * `promptHash` stays null. The hash records that *EO* wrote the text, so
 * that `syncRolePrompts` may improve it later; this text came from
 * somebody else's machine, and claiming EO wrote it would licence a
 * future release to overwrite a pack's prompt with EO's own.
 */
function writeRoles(db: Db, document: PipelineExport, signedInBackends: readonly string[], projectId: Uuid | null): { role: string; action: string }[] {
  // A preview's own agent does not count as somebody already having this
  // role (EO-316): it runs rehearsals and nothing else, so skipping the
  // write because one exists would leave the project that asked for this
  // pack with no agent at all — the role reported unfilled on its needs
  // check and nothing there to fill it. Another project's own agent does
  // not count either, for the same reason (EO-474): it never runs this
  // project's work.
  const live = listAgents(db).filter((agent) => agent.archivedAt === null && !isPreviewAgent(agent) && servesProject(agent, { projectId }));

  const kept: { role: string; action: string }[] = [];

  for (const role of document.roles) {
    // The role's definitions first, and for every role the document
    // carries — one somebody already staffs included (EO-424). They are
    // the role's rather than an agent's, the steps arriving with this
    // document dispatch them either way, and one already defined here is
    // never replaced. First, so that where a file names an action both
    // ways the carried schema below finds it defined and leaves it.
    kept.push(...adoptExportedActions(db, role.slug, role.actions).kept);

    // An entry that is here for its definitions alone (EO-424): the
    // exporting installation had nobody in the role, so there is no
    // prompt to make an agent from. The slot lands unfilled and the
    // needs check says so, as it does for a role the file never named.
    if (role.prompt === null) continue;

    if (live.some((agent) => agent.role === role.slug)) continue;

    const bound = role.backend !== null && signedInBackends.includes(role.backend);
    const config: Record<string, unknown> = {};
    if (role.allowedTools !== null) config["allowedTools"] = role.allowedTools;
    // The pack's recommendation, kept only where it is not also the
    // row's own answer: an unbound agent has no provider to read it off,
    // and losing it would delete the one line the needs check is made of
    // — "built on claude, which you are not signed in to" — from every
    // copy of this pack passed on from here.
    if (!bound && role.backend !== null) config[RECOMMENDATION_KEY] = { backend: role.backend, model: role.model };

    createAgent(db, {
      name: agentNameFor(role.slug),
      role: role.slug,
      provider: bound ? (role.backend as string) : UNBOUND_BACKEND,
      model: bound ? role.model : null,
      instructions: role.prompt,
      // With the `memory_note` grant every new agent is given (EO-593),
      // as `agents:save` gives it.
      config: withMemoryNoteGrant(config),
      // An unbound agent is not something to dispatch: it names no
      // backend, and `isDispatchable` is what every staffing question
      // asks. Enabled the moment it has one, which is the person's
      // decision and the Agents screen's job.
      enabled: bound,
    });
    // With the agent, and only with it: a role somebody already staffs
    // keeps their agent and everything about it, which is the rule this
    // loop's first line states. `packRefusal` has already established
    // that the save takes every one of these.
    adoptCarriedSchemas(db, role.slug, role.schemasByAction);
  }

  return kept;
}

/**
 * `code_reviewer` → "Code reviewer".
 *
 * A name rather than a slug because a name is what a person reads on the
 * card and in a comment's author line, and the document deliberately
 * carries none: what an agent is *called* is as local as which backend
 * it runs on — somebody's "Reviewer (Codex)" says something about their
 * installation and nothing about the pack.
 */
export function agentNameFor(slug: string): string {
  const words = slug.replace(/[_-]+/g, " ").trim();
  return words === "" ? slug : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

/**
 * The pack's connectors, disconnected (EO-314, ARCHITECTURE.md, "Import is the needs check").
 *
 * A row per connector the pack names, holding nothing: "connectors land
 * disconnected". What it buys over writing nothing at all is that the
 * project can *say* what it is meant to reach — the needs check has a
 * line to render and a setup flow has something to fill in — without
 * anybody's credentials having travelled to get there.
 *
 * Nothing at all for an import with no project: a binding belongs to a
 * project, and there is no scope for one that has none.
 */
function writeConnectors(db: Db, document: PipelineExport, projectId: Uuid | null): void {
  if (projectId === null) return;
  for (const connector of document.connectors) createDisconnectedConnector(db, projectId, connector);
}

/**
 * The servers this pack's roles reach, written down and not configured
 * (EO-314).
 *
 * The words only — see `declareMcpServer`, which is where the reason a
 * transport does not travel is written. What this buys is the half of
 * the capability line that has to survive: without it the description
 * the pack carried would be read once at the gate and lost, and the
 * same pack sent on from here would arrive at the next person with a
 * server nobody can describe.
 *
 * A server this installation already has is left exactly as it is,
 * description included — and connector included. Theirs is the
 * configured one, and a document must not be able to change how somebody
 * signs into a server they already run.
 *
 * What a *new* row gains, beyond the words, is the connector setup
 * (EO-315): the Connect button on the step, and the environment-variable
 * names the value is stored under. Without those the pack could describe
 * a server and leave the person no way to give it anything, which is the
 * half the design is actually about.
 */
function writeMcpServers(db: Db, document: PipelineExport): Set<string> {
  // The names this import actually wrote, which is not the same list as
  // the ones it was handed: `declareMcpServer` leaves a row this machine
  // already has exactly as it is and answers false. `attachDeclaredServers`
  // needs that distinction rather than being able to re-derive it, and
  // re-finding the row by name afterwards cannot tell the two apart —
  // which is how an import came to tick somebody's own configured server
  // onto an agent they had never given it to.
  const created = new Set<string>();
  for (const server of document.mcpServers) {
    if (declareMcpServer(db, { name: server.name, description: server.description, connector: server.connector })) {
      created.add(server.name);
    }
  }
  return created;
}

/**
 * Ties each imported role to the servers its own tool surface names
 * (EO-315).
 *
 * Without this the import stops one link short of working. A pack's role
 * says it reaches `mcp__slack__*`, the pack's server row is written down
 * beside it, and nothing joins them — so the step staffed by that role
 * shows an empty "what this agent can reach" list, the connector the
 * pack shipped has nowhere to appear, and there is no Connect button
 * anywhere in the product for a credential the pack exists to collect.
 * Attachment is what a dispatch actually reads (EO-106), and the
 * document already says which roles reach which servers; making the
 * person re-derive that by hand from a tool id is asking them to do the
 * one piece of wiring the pack was explicit about.
 *
 * **Nothing becomes reachable by being attached.** The row is disabled
 * and has no command — `declareMcpServer`'s doing, because a pack may
 * not ship a transport — so `deliverableAttachments` withholds it from
 * every dispatch until the person has filled in the half only they can.
 * What the tick buys is that the server is *listed*, with its capability
 * line, its Connect button and, until the person finishes, the sentence
 * saying it is switched off.
 *
 * **Only rows this import created**, which is why `created` is passed in
 * rather than worked out here. A server the installation already had
 * under that name is the person's own — their command, their
 * credentials, their decision about which agents hold it — and a
 * document must not be able to hand somebody else's agent a tool they
 * never ticked. Re-finding the row by name cannot tell a row this import
 * wrote from one that was already there, which is exactly how the first
 * cut of this promised one thing in a comment and did the other.
 *
 * **Every live agent staffing the role, not one of them.** `agents.role`
 * is not unique and nothing says it should be: two agents can staff
 * `triager`, and which one a dispatch picks is the supervisor's business.
 * Keying them into a map by role kept whichever happened to be last, so
 * the reach list — which unions every dispatchable agent, on purpose —
 * advertised a connector the other agent's dispatch would run without.
 * A screen promising something a run then does not do is the failure
 * worth avoiding here, and the two have to agree about the same set.
 *
 * Disabled and unbound agents are included deliberately. An imported
 * role whose backend nobody is signed in to lands disabled (ARCHITECTURE.md, "An agent is a row"),
 * and
 * it becomes dispatchable the moment the person binds it — attaching
 * only what is dispatchable *now* would leave that agent without the
 * server precisely when it started being used.
 *
 * Idempotent, and deliberately not undone anywhere: `setAgentAttachment`
 * is a no-op for a pair that already exists, so importing the same pack
 * twice ticks nothing twice.
 */
function attachDeclaredServers(db: Db, document: PipelineExport, created: ReadonlySet<string>): void {
  if (created.size === 0) return;

  const declared = new Map(document.mcpServers.flatMap((server) => {
    if (!created.has(server.name)) return [];
    const row = getMcpServerByName(db, server.name);
    return row === undefined ? [] : [[server.name, row.id] as const];
  }));
  if (declared.size === 0) return;

  // Read against the names this catalogue holds, for `exportedMcpServers`'
  // reason: Claude's spelling cannot be split without them, since
  // `mcp__slack__prod__list` is `slack__prod`'s tool where that server
  // exists and `slack`'s where it does not (`mcpToolId`).
  const catalogue = listMcpServers(db, true).map((server) => server.name);

  const byRole = new Map<string, string[]>();
  for (const agent of listAgents(db)) {
    if (agent.archivedAt !== null) continue;
    const staffing = byRole.get(agent.role) ?? [];
    staffing.push(agent.id);
    byRole.set(agent.role, staffing);
  }

  for (const role of document.roles) {
    const agentIds = byRole.get(role.slug) ?? [];
    if (agentIds.length === 0) continue;
    for (const name of mcpServersNamedIn(role.allowedTools ?? [], catalogue)) {
      const serverId = declared.get(name);
      if (serverId === undefined) continue;
      for (const agentId of agentIds) setAgentAttachment(db, { agentId, kind: "mcpServer", id: serverId, attached: true });
    }
  }
}
