import {
  type ActionDefinitionDraft,
  DEFAULT_WORKSPACE_MODE,
  type Agent,
  type ConfigureOutput,
  builtinInputs,
  type CustomModule,
  declaredStepInputs,
  DEFAULT_TIME_LIMIT,
  describeDuration,
  PROPOSED_MODULE_NEEDS_TESTS,
  isDispatchable,
  type PipelineDraft,
  proposedActionChange,
  resultsFromRoutes,
  RUNS_ONCE,
  type PipelineStep,
  type ProposedModule,
  type StepInputs,
  type StepResult,
  type StepWatch,
  type StepRoute,
  stepWorkspaceChoice,
  summarizeInstructions,
  ITEM_WORKSPACE,
  type Uuid,
  watchLine,
  settledWatch,
  type WorkspaceMode,
  entryRuleWords,
} from "@eo/core";
import { hasBlockingProblem, validatePipeline, type WorkflowProblem } from "@eo/engine";
import type { Db } from "../db/client.js";
import { registry, registryForProject, withProposedActions, type ProposedDefinition } from "../registry.js";
import {
  getActionDefinition,
  getPipeline,
  getWorkspace,
  listAgents,
  listIncomingHandOffs,
  listModules,
  listRoutesForPipeline,
  listStepsElsewhere,
  listStepsForPipeline,
  listItemsIncludingArchived,
  pipelineHasWebhookEntry,
  workspaceLabel,
} from "../db/repos/index.js";
import { sideEffectingServersByStep } from "../connectors/sideEffects.js";
import { itemTypesJudged, readGuards, staffedRolesForPipeline } from "../ipc/configCommands.js";
import { actionUsedBy, describeActionUse } from "../ipc/roleActionCommands.js";
import { activeProjectId } from "../ipc/repositoryCommands.js";

/**
 * Validating and rendering a pipeline draft.
 *
 * What the assistant proposes when somebody asks it to change a pipeline:
 * the same validator a publish uses, the card a person reads, and the
 * domain shapes `pipeline:save` takes. A draft is never applied here —
 * the person publishes it through the same `pipeline:save` every other
 * change goes through. One publish path, already validated and
 * transactional, is worth more than a second one that agrees with it
 * today.
 *
 * This was the Architecture panel's file (`configure` turns on the
 * `architecture` step). The panel and its conversations went in EO-526;
 * what is left is what the assistant's drafts are built on.
 */

// ── Validation ────────────────────────────────────────────────

/**
 * Turns a draft into the domain shapes and asks the real validator.
 *
 * The same function and the same inputs `savePipeline` uses, rather than
 * a lighter check written for agents. A draft judged by anything softer
 * than the Publish button would produce cards that cannot be applied,
 * which is worse than no card — and a draft judged by anything *stricter*
 * would refuse graphs a person is allowed to build by hand.
 */
export function validateDraft(
  db: Db,
  pipelineId: string,
  draft: DraftWithLimits,
  proposedModules: ProposedModule[] = [],
  options: ValidateDraftOptions = {},
): WorkflowProblem[] {
  const itemCountByStep: Record<string, number> = {};
  for (const item of listItemsIncludingArchived(db)) {
    if (item.stepId === null) continue;
    itemCountByStep[item.stepId] = (itemCountByStep[item.stepId] ?? 0) + 1;
  }

  // The definitions the draft brings with it, laid over the
  // installation's (EO-426): a step on an action this same reply defines
  // is held to the keys it proposes, exactly as Publish — which writes
  // them in the transaction that writes the graph — will hold it. One
  // the save's rules refuse is laid over nothing and reported instead,
  // so the graph is still judged and every problem arrives at once.
  const installed = registryForProject(db, null);
  const proposed = withProposedActions(installed, options.actions ?? []);
  // The pipeline's steps as they stand, which is what the draft's own
  // steps carry their keep checking from (EO-505).
  const existingSteps = new Map(listStepsForPipeline(db, pipelineId).map((step) => [step.id, step]));
  const domainSteps = toDomainSteps(pipelineId, draft, existingSteps);
  const refusedActions: WorkflowProblem[] = proposed.ok
    ? []
    : proposed.problems.map((message) => ({ severity: "error" as const, stateId: null, message: `The proposed action definition cannot be saved — ${message}` }));

  return [...refusedActions, ...validatePipeline({
    // With the actions roles define for themselves (EO-423), which are
    // rows rather than anything a pack contributes: a draft is held to
    // its actions' declared results exactly as a publish is. The
    // installation scope, because the validator reads roles, builtins
    // and actions and none of those has a project in it.
    registry: proposed.ok ? proposed.registry : installed,
    // The catalog as it will be *once the person accepts this turn*.
    //
    // A proposed module has no id yet — it does not exist — so a draft
    // names it by slug, and it is presented here as present and approved.
    // Without that, every draft introducing a module would be rejected
    // before anyone could read it, which is a card that cannot be applied:
    // the thing this function exists to avoid.
    //
    // Deliberately not the same question the Publish button asks. This
    // judges the *shape*: does each route use a key the module can
    // return, is every step reachable, does work still finish.
    // `savePipeline` reads the real catalog, where a module the architect
    // wrote is unapproved — and refuses. That refusal is the gate, and it
    // is what sends the person to read the code and approve it — which
    // runs its tests (KAN-106, EO-353).
    modules: [
      // A module already in the catalog and not yet approved, presented
      // as approved where the caller's card can wait on it (EO-399) — the
      // same treatment, for the same reason, as the proposed ones below.
      // One that has been deleted stays deleted: there is nothing a
      // person could approve to make that graph publishable.
      ...listModules(db, true).map((module) =>
        options.unapprovedModulesAsPresent && module.archivedAt === null && module.approvedAt === null ? { ...module, approvedAt: 0 } : module,
      ),
      ...proposedModules.map((proposed) => ({
        id: proposed.slug as Uuid,
        slug: proposed.slug,
        name: proposed.name,
        description: proposed.description,
        code: proposed.code,
        manifest: proposed.manifest,
        originalScript: proposed.originalScript,
        source: "architect" as const,
        approvedAt: 0,
        createdAt: 0,
        updatedAt: 0,
        archivedAt: null,
      })),
    ],
    steps: domainSteps,
    routes: toDomainRoutes(pipelineId, draft),
    entryStepId: draft.entryStepId,
    // The publish path's own answer (EO-186, EO-474) — a retired agent,
    // a preview's own and another project's agent staff nothing — and
    // the two must not disagree about a draft.
    staffedRoles: staffedRolesForPipeline(db, pipelineId),
    itemCountByStep,
    // Off-dashboard steps are absent from a draft exactly as they are
    // absent from the editor's submission, and "absent" is how a removal
    // is detected — so they must not count as removable here either.
    existingSteps: [...existingSteps.values()].filter((step) => !step.offBoard).map((step) => ({ id: step.id, name: step.name })),
    // Where a route may hand work to (EO-58), read as Publish reads it:
    // the steps of the project's other pipelines. Without it every draft
    // that hands work to another pipeline — the person's own Merge, a
    // resolved template update keeping it (EO-534) — was refused as
    // "routes to a step that is in no pipeline", a card Publish would
    // have taken.
    stepsElsewhere: listStepsElsewhere(db, pipelineId, activeProjectId(db)),
    // The same question the publish path asks (EO-167): a draft that
    // removes a step another pipeline hands work to is a card that
    // cannot be applied, and offering one is the thing this function
    // exists to avoid.
    incomingHandOffs: listIncomingHandOffs(db, pipelineId),
    // And the same question again about what a webhook could reach
    // (EO-334). A draft that Publish would refuse is a card nobody can
    // apply, so the architect is told here rather than leaving somebody
    // to press the button and find out.
    entryReachedByWebhook: pipelineHasWebhookEntry(db, pipelineId),
    sideEffectingServersByStep: sideEffectingServersByStep(db, domainSteps),
    // Judged as Publish will judge it (EO-405): where a person has let
    // this pipeline send unread, a draft that does so is one they can
    // apply, and refusing it here would be the card disagreeing with the
    // button. Read from the row — a draft has no way to say it.
    webhookUnattended: getPipeline(db, pipelineId)?.webhookUnattended ?? false,
    // The ceiling a module step's own limit is bounded by (EO-162), read
    // where `savePipeline` reads it. A draft from the configuration
    // screen sets no limit, so this changed nothing for one; a draft from
    // the assistant's room can set one on a step it creates (EO-381), and
    // judged against EO's ten-minute default instead of the configured
    // run timeout it would be refused here for a limit Publish accepts.
    runTimeoutMs: readGuards(db).wallClockTimeoutMs,
    // The rules it would publish (EO-610), held to what a save holds them to.
    ...(draft.entryRules === undefined ? {} : { entryRules: draft.entryRules, itemTypes: itemTypesJudged(db, pipelineId) }),
  })];
}

/** What `validateDraft` is told about the surface asking. */
export interface ValidateDraftOptions {
  /**
   * The action definitions proposed beside the draft (EO-426), which the
   * graph is judged with as if they had been saved. Nothing is written.
   */
  actions?: readonly ActionDefinitionDraft[];
  /**
   * Judge the graph as if every module in the catalog that is waiting for
   * approval had been approved (EO-399).
   *
   * For a surface whose card can show that it is waiting on a module and
   * offer Approve for it — the assistant's draft card. There, a step
   * naming an unapproved module by its id is a draft that waits, exactly
   * as one naming a module the same reply proposed is; refusing it would
   * be refusing a card for the one thing the card is able to say.
   *
   * It moves no gate. `savePipeline` still reads the catalog as it is and
   * refuses a step running a module nobody has approved; this only
   * decides whether the draft is *offered*.
   */
  unapprovedModulesAsPresent?: boolean;
}

/**
 * What an assistant draft's step may say beyond the configuration
 * screen's draft (EO-381, EO-516, EO-520): its time limit, its input
 * values, keep checking, the disk it works on and how it uses a
 * repository.
 *
 * Every one optional, and absent means the step keeps what it has. The
 * words `DEFAULT_TIME_LIMIT`, `RUNS_ONCE` and `ITEM_WORKSPACE` are how a
 * draft says "back to EO's default", "runs once" and "the item's own" —
 * see `AssistDraftStepSchema` for why they are not `null`.
 */
export interface DraftStepSettings {
  timeoutMs?: number | typeof DEFAULT_TIME_LIMIT | undefined;
  inputs?: StepInputs | undefined;
  watch?: StepWatch | typeof RUNS_ONCE | undefined;
  workspaceId?: string | undefined;
  workspaceMode?: WorkspaceMode | undefined;
}

/**
 * A draft whose steps may carry settings, whose routes may say "Needs a
 * reason", and which may change the pipeline's icon or restore a version
 * (EO-381, EO-516, EO-520).
 *
 * The configuration screen's draft never carries any of it — its schema
 * leaves all of it out — so to it this is exactly a `PipelineDraft`, and
 * every step keeps what it has. The assistant's room may set them, and the
 * validator and the card have to judge the values it would publish.
 */
export type DraftWithLimits = Omit<PipelineDraft, "steps" | "routes"> & {
  steps: (PipelineDraft["steps"][number] & DraftStepSettings)[];
  routes: (PipelineDraft["routes"][number] & { requiresComment?: boolean | undefined })[];
  icon?: string | undefined;
  restoredFrom?: number | undefined;
};

/** The keys of `DraftStepSettings`, which `withoutDraftSettings` takes off a step. */
const DRAFT_SETTING_KEYS = ["timeoutMs", "inputs", "watch", "workspaceId", "workspaceMode"] as const satisfies readonly (keyof DraftStepSettings)[];

/**
 * A draft step without the settings it may carry, so what is published is
 * `settledStepSettings`' answer and never the draft's own value spread in
 * by accident.
 */
export function withoutDraftSettings<T extends DraftStepSettings>(step: T): Omit<T, keyof DraftStepSettings> {
  const rest: Partial<T> = { ...step };
  for (const key of DRAFT_SETTING_KEYS) delete rest[key];
  return rest as Omit<T, keyof DraftStepSettings>;
}

/** A draft step's settings once what it left out is filled in from the step as it stands. */
export interface SettledStepSettings {
  timeoutMs: number | null;
  /** Before the module's declaration is applied: `assistDraftForPublish` keeps only what the module or builtin declares. */
  inputs: StepInputs;
  watch: StepWatch | null;
  workspaceId: string | null;
  workspaceMode: WorkspaceMode;
}

/**
 * What a draft step's settings come to, against the step as it stands
 * (EO-520).
 *
 * One function for the validator, the card and Publish, so the three
 * cannot disagree about what a draft does to a step. The rule is the
 * same for every field: what the draft says, or else what the step
 * already has, or else what a new step gets.
 *
 * Two of them are also bounded by the kind of step it now is, as they
 * always were. A step that is no longer a module step loses its time
 * limit, and one that runs nothing of its own loses keep checking —
 * unless the draft *said* one, which is then judged as said: a person's
 * step set to keep checking is a draft `validatePipeline` refuses by
 * name, not one quietly published running once.
 */
export function settledStepSettings(step: { type: string } & DraftStepSettings, existing: PipelineStep | undefined): SettledStepSettings {
  const runsSomething = step.type === "builtin" || step.type === "module";
  return {
    timeoutMs:
      step.timeoutMs === DEFAULT_TIME_LIMIT ? null : step.timeoutMs !== undefined ? step.timeoutMs : step.type === "module" ? (existing?.timeoutMs ?? null) : null,
    inputs: step.inputs ?? existing?.inputs ?? {},
    watch: step.watch === RUNS_ONCE ? null : step.watch !== undefined ? settledWatch(step.watch) : runsSomething ? (existing?.watch ?? null) : null,
    workspaceId: step.workspaceId === ITEM_WORKSPACE ? null : (step.workspaceId ?? existing?.workspaceId ?? null),
    workspaceMode: step.workspaceMode ?? existing?.workspaceMode ?? DEFAULT_WORKSPACE_MODE,
  };
}

/**
 * The input values a draft step is published with (EO-78, EO-516, EO-520):
 * its settled values, minus every one the module or builtin it now runs
 * does not declare — and none at all on a step that runs neither.
 *
 * One function for the card and for Publish (`assistDraftForPublish`), so
 * an input Publish drops — a step moved onto a module that does not
 * declare it — is one the card lists as going, rather than a value that
 * disappears without anybody having been shown it.
 *
 * A module is found by id in the catalog, or — named in a draft by the
 * slug of a module the same reply proposes — by that slug, in the catalog
 * where it has been saved and in the proposal where it has not yet. The
 * two are one module wherever both exist (`moduleCollision`).
 */
export function publishedStepInputs(
  step: { type: string; entryAction: string | null },
  settled: StepInputs,
  catalog: readonly CustomModule[],
  proposed: readonly ProposedModule[],
): StepInputs {
  const action = step.entryAction;
  if (action === null) return {};
  let declares: Record<string, unknown> | null = null;
  if (step.type === "module") {
    const offered = proposed.find((module) => module.slug === action);
    const module = offered
      ? (catalog.find((candidate) => candidate.slug === action && candidate.archivedAt === null) ?? offered)
      : catalog.find((candidate) => candidate.id === action);
    declares = module?.manifest.inputs ?? null;
  } else if (step.type === "builtin") {
    declares = builtinInputs(registry, action);
  }
  return declares === null ? {} : declaredStepInputs({ inputs: declares }, settled);
}

/**
 * What a person may decide on a human step of a draft (EO-310, EO-520).
 *
 * Derived from the branches the draft drew out of it, keeping what the
 * step already declared on every key it still routes — and then "Needs a
 * reason" wherever the draft's branch says it.
 */
export function draftStepResults(
  step: { id: string; type: PipelineStep["type"] },
  routes: DraftWithLimits["routes"],
  declared: readonly StepResult[],
): StepResult[] {
  return resultsFromRoutes({ id: step.id, type: step.type, results: declared }, routes).map((result) => {
    const said = routes.find((route) => route.fromStepId === step.id && route.resultKey === result.key)?.requiresComment;
    return said === undefined ? result : { ...result, requiresComment: said };
  });
}

/** The draft's steps as the engine sees them. `pipelineId` is stamped rather than asked for. */
export function toDomainSteps(pipelineId: string, draft: DraftWithLimits, existingSteps: ReadonlyMap<string, PipelineStep> = new Map()): PipelineStep[] {
  return draft.steps.map((draftStep) => {
    const step = withoutDraftSettings(draftStep);
    const existing = existingSteps.get(step.id);
    return {
      ...step,
      pipelineId: pipelineId as Uuid,
      // Never on the wire, by design: an off-dashboard step is not a column,
      // so a draft has nothing to say about one.
      offBoard: false,
      // Its time limit (EO-162), input values (EO-78), keep checking
      // (EO-456), disk (EO-301) and repository mode (EO-296): what the
      // draft says, or else what the step already has — the values
      // Publish would save (`settledStepSettings`, EO-520). The
      // configuration screen's draft says none of them, so its steps are
      // judged with their own.
      //
      // That matters most for keep checking (EO-505): `validatePipeline`
      // refuses a function that waits on a step that runs once, and
      // judging the shipped pull request watch as though its keep
      // checking had been switched off would refuse every draft of a
      // pipeline that has one.
      ...settledStepSettings(draftStep, existing),
      // Nor about who a human step waits on (EO-302), and for the
      // strongest form of that reason: a person is not something a draft
      // can propose. Null is "nobody in particular" — what every step
      // says today — and `replacePipelineGraph` leaves the row's own
      // owner alone when a rewrite says nothing, so applying a draft
      // cannot unname somebody. A draft that restores a version puts its
      // owners back through `restoredFrom` (EO-520), read from the
      // version's own document at Publish.
      ownerPersonId: null,
      ownerGroupId: null,
      // What a person may decide on a human step, derived from the branches
      // the draft drew out of it (EO-310). A draft says nothing about
      // results directly — the architect proposes a *graph*, and on a human
      // step a branch is the offer — so this is computed rather than
      // blanked: without it every human step the architect proposes would
      // fail validation for routing a result it does not declare, and the
      // card could never be applied.
      results: draftStepResults(step, draft.routes, existing?.results ?? []),
    };
  });
}

/**
 * The draft's routes as the engine sees them.
 *
 * Ids are minted here and thrown away on save — `replacePipelineGraph`
 * regenerates every one — so they exist only to satisfy the shape.
 */
export function toDomainRoutes(pipelineId: string, draft: Pick<PipelineDraft, "routes">): StepRoute[] {
  return draft.routes.map((route, index) => ({
    ...route,
    id: `draft-route-${index}` as Uuid,
    pipelineId: pipelineId as Uuid,
  }));
}

// ── Rendering ─────────────────────────────────────────────────

type RenderedDraft = { ok: true; body: string } | { ok: false; reason: string };

/** How a draft is rendered when it is not about a pipeline that exists. */
export interface RenderDraftOptions {
  /**
   * The draft creates a pipeline of this name on Publish (EO-381), so
   * there is nothing to diff against: every step is added, and
   * `pipelineId` is a placeholder no row holds.
   */
  newPipelineName?: string;
  /** Offer a draft that runs a module nobody has approved yet, for a card that waits on it (EO-399). See `ValidateDraftOptions`. */
  unapprovedModulesAsPresent?: boolean;
}

/**
 * The card a person reads before applying a draft.
 *
 * A diff rather than the whole graph: the question in front of someone is
 * "what does this change", and a list of eight steps of which two are new
 * makes them find the two themselves. Items currently sitting on a
 * changed step are named for the same reason — rewiring a step that four
 * items are on is a different decision from rewiring an empty one.
 */
export function renderDraft(
  db: Db,
  pipelineId: string,
  output: Omit<ConfigureOutput, "draft" | "actions"> & { draft?: DraftWithLimits | undefined; actions?: readonly ActionDefinitionDraft[] | undefined },
  options: RenderDraftOptions = {},
): RenderedDraft {
  const draft = output.draft;
  const creating = options.newPipelineName;
  if (!draft) return { ok: false, reason: "That turn proposed no changes." };
  if (creating === undefined && !getPipeline(db, pipelineId)) return { ok: false, reason: "That pipeline no longer exists." };

  // A module with no tests cannot be approved (EO-353), so a card
  // offering one is a card whose graph can never be published (EO-355).
  // The schema already sends such a result back to the agent with
  // `PROPOSED_MODULE_NEEDS_TESTS`; this is the same rule at the renderer
  // both the configure and the assist path go through, for an output
  // that reached it some other way.
  const untested = output.modules.filter((module) => module.tests.length === 0);
  if (untested.length > 0) {
    return {
      ok: false,
      reason: `${untested.map((module) => `"${module.name}"`).join(", ")} ${untested.length === 1 ? "has" : "have"} no test cases. ${PROPOSED_MODULE_NEEDS_TESTS}`,
    };
  }

  // A definition the save would refuse (EO-426), before the graph is
  // judged at all. Not where the agent is told: the schema sends back
  // everything wrong with a definition on its own, and the supervisor
  // sends back the rule that is about this installation
  // (`proposedActionsProblem`), both while the turn is still open. This
  // is the same rule at the renderer both rooms go through, for a result
  // that reached it some other way — and for a card read back later,
  // since a pack can be installed underneath one. Said in the save's
  // words, with nothing posted but the reason: Publish writes these with
  // the graph, so a card carrying one it would refuse could never be
  // published.
  const proposedActions = output.actions ?? [];
  const definitions = withProposedActions(registryForProject(db, null), proposedActions);
  if (!definitions.ok) {
    return {
      ok: false,
      reason: [
        "This draft was refused rather than offered, because an action definition it proposes cannot be saved:",
        "",
        ...definitions.problems.map((problem) => `- ${problem}`),
        "",
        "_Nothing was written. Fix the definition in `actions` and propose the draft again._",
      ].join("\n"),
    };
  }

  // Checked here as well as at apply time, so a graph that was never
  // going to publish is not offered with a button on it.
  const problems = validateDraft(db, pipelineId, draft, output.modules, {
    unapprovedModulesAsPresent: options.unapprovedModulesAsPresent === true,
    actions: proposedActions,
  });
  if (hasBlockingProblem(problems)) {
    const blocking = problems.filter((problem) => problem.severity === "error");
    return {
      ok: false,
      reason: [
        "This graph cannot be published as proposed:",
        "",
        ...blocking.map((problem) => `- ${problem.message}`),
        "",
        "_Fix these and propose it again._",
      ].join("\n"),
    };
  }

  const before = listStepsForPipeline(db, pipelineId).filter((step) => !step.offBoard);
  const beforeById = new Map(before.map((step) => [step.id, step]));
  const afterIds = new Set(draft.steps.map((step) => step.id));
  const beforeRoutes = listRoutesForPipeline(db, pipelineId);

  const counts = itemCounts(db);
  const lines = [draft.rationale, ""];
  // Said first, because it is the largest thing the card does: Publish
  // makes a pipeline that is not there now (EO-381).
  if (creating !== undefined) lines.push(`**New pipeline** ${creating}`, "");

  const added = draft.steps.filter((step) => !beforeById.has(step.id));
  const removed = before.filter((step) => !afterIds.has(step.id));
  // What each step that stays would be published with (EO-520), set
  // beside what it has now, field by field.
  const workspaceName = (id: string | null) => workspaceWords(db, id);
  const catalog = listModules(db, true);
  const settingsOf = (step: DraftWithLimits["steps"][number], was: PipelineStep) => {
    const settled = settledStepSettings(step, was);
    // The inputs Publish would save, not the ones before the module's
    // declaration is applied: an input it drops is shown going.
    const inputs = publishedStepInputs(step, settled.inputs, catalog, output.modules);
    return settingChanges(was, { ...settled, inputs, results: draftStepResults(step, draft.routes, was.results) }, draft.routes, workspaceName);
  };
  const changed = draft.steps.filter((step) => {
    const was = beforeById.get(step.id);
    return was !== undefined && (changesOf(was, step).length > 0 || settingsOf(step, was).length > 0);
  });

  // Did the draft mean to drop those (EO-209)?
  //
  // Here rather than earlier, because every check above this line is
  // about the graph and this one is about the *proposal*. A draft that
  // empties a column `validatePipeline` will not let go of is already
  // refused, in the words the publish path uses, and answering it with
  // this instead would be EO changing its account of a failure it
  // already had a good one for. What is left over is the case nothing
  // else can see: a step holding no items that nothing hands work to,
  // dropped by a graph that says nothing about dropping it.
  const refusal = removalRefusal(draft, removed, counts);
  if (refusal !== null) return { ok: false, reason: refusal };

  if (added.length > 0) {
    lines.push("**Added**", "", ...added.map((step) => `- ${step.name} — ${describeStep(step)}${limitsOf(step, draft.routes, workspaceName)}`), "");
  }
  if (changed.length > 0) {
    lines.push("**Changed**", "");
    for (const step of changed) {
      const was = beforeById.get(step.id)!;
      const sentence = changesOf(was, step);
      lines.push(`- ${was.name}${sentence.length > 0 ? ` — ${sentence.join("; ")}` : ""}${holding(counts, step.id)}`);
      // Each setting the draft changes, under its step, old → new (EO-520).
      lines.push(...settingsOf(step, was).map((change) => `  - ${change}`));
    }
    lines.push("");
  }
  if (removed.length > 0) lines.push("**Removed**", "", ...removed.map((step) => `- ${step.name}${holding(counts, step.id)}`), "");

  const routeLines = renderRouteDiff(draft, beforeRoutes, [...draft.steps, ...before]);
  if (routeLines.length > 0) lines.push("**Routing**", "", ...routeLines, "");

  const entryWas = getPipeline(db, pipelineId)?.entryStepId ?? null;
  if (entryWas !== draft.entryStepId) {
    const name = draft.steps.find((step) => step.id === draft.entryStepId)?.name ?? draft.entryStepId;
    lines.push(`**Work now enters at** ${name}`, "");
  }
  const pipeline = getPipeline(db, pipelineId);
  const renamed = creating === undefined && draft.name !== undefined && draft.name !== pipeline?.name;
  if (renamed) lines.push(`**Renamed to** ${draft.name}`, "");
  // What work must have to enter (EO-610), in the words a refusal would
  // use: a change to them alone is a change worth a card.
  const entryRules = draft.entryRules;
  const rulesChanged = entryRules !== undefined && JSON.stringify(entryRules) !== JSON.stringify(creating === undefined ? (pipeline?.entryRules ?? []) : []);
  if (rulesChanged) {
    const words = entryRules.map((rule) => entryRuleWords(rule, registry.entryRuleKinds)).join(", ");
    lines.push(entryRules.length === 0 ? "**Entry rules removed** — work enters with nothing asked of it" : `**To enter, work needs** ${words}`, "");
  }
  // The pipeline's icon (EO-520), which only an assistant draft can say.
  const iconChanged = draft.icon !== undefined && (creating !== undefined || draft.icon !== pipeline?.icon);
  if (iconChanged) lines.push(creating !== undefined ? `**Icon** ${draft.icon}` : `**Icon** ${pipeline?.icon ?? "the default"} → ${draft.icon}`, "");
  // A restore (EO-520): the graph above is that version's, and Publish
  // puts back who each of its person steps waited on.
  if (draft.restoredFrom !== undefined) {
    lines.push(
      `**Restores version ${draft.restoredFrom}** — publishing files it as a new version, and puts back who each person step waited on in v${draft.restoredFrom}.`,
      "",
    );
  }

  for (const agent of output.agents) {
    lines.push(`**New agent** ${agent.name} (${agent.role}, ${agent.provider}) — ${summarizeInstructions(agent.instructions) ?? "no summary"}`);
  }
  if (output.agents.length > 0) lines.push("");
  for (const runtime of output.runtimes) lines.push(`**Needs runtime** ${runtime.id} — ${runtime.why}`);
  if (output.runtimes.length > 0) lines.push("");
  // What it needs first, then why it is a module rather than an agent.
  // The `needs` line is the part a person can actually judge without
  // reading JavaScript — "this wants flyctl and your Fly token" is a
  // decision, where a hundred lines of code is a task.
  for (const module of output.modules) {
    const needs = [...module.manifest.needs.bin, ...module.manifest.needs.env, ...(module.manifest.needs.network ? ["network"] : [])];
    lines.push(`**New module** ${module.name} — ${module.description}`);
    lines.push(`  Needs: ${needs.length > 0 ? needs.join(", ") : "nothing outside the worktree"} · returns ${module.manifest.results.join(", ")}`);
    lines.push(`  Why a module: ${module.why}`);
    // Named so the person knows what approving it will run (EO-355);
    // the card below the transcript runs them and shows how they went.
    lines.push(`  Tests: ${module.tests.map((test) => test.description).join("; ")}`);
  }
  if (output.modules.length > 0) lines.push("");

  // The definitions Publish writes with the graph (EO-426). Each with
  // the keys it can return, because those are what the routes above are
  // drawn from; and one that replaces a definition the role already has
  // is said to, with the keys it adds and removes — every other step on
  // that action is held to the new list from the moment this publishes.
  const actionLines = definitions.definitions.flatMap((definition) => renderProposedAction(db, pipelineId, definition));
  if (actionLines.length > 0) lines.push(...actionLines, "");
  const changesAnAction = definitions.definitions.some((definition) => changeOf(db, definition).kind !== "same");

  // Warnings are not blocking and the person may know better, but they
  // are the ones that describe silent failure — a step nothing routes to,
  // a role nobody staffs — so they belong on the card rather than in a log.
  const warnings = problems.filter((problem) => problem.severity === "warning");
  if (warnings.length > 0) lines.push("**Worth knowing**", "", ...warnings.map((problem) => `- ${problem.message}`), "");

  const pipelineChanged = renamed || iconChanged || rulesChanged || draft.restoredFrom !== undefined;
  if (
    added.length === 0 &&
    changed.length === 0 &&
    removed.length === 0 &&
    routeLines.length === 0 &&
    entryWas === draft.entryStepId &&
    !changesAnAction &&
    !pipelineChanged
  ) {
    return { ok: false, reason: "That draft is identical to the pipeline as it stands, so there is nothing to apply." };
  }

  return { ok: true, body: lines.join("\n").trimEnd() };
}

/** What a proposed definition does to the one its role already has, read from the table as it stands. */
function changeOf(db: Db, definition: ProposedDefinition) {
  return proposedActionChange(getActionDefinition(db, definition.role, definition.action), definition);
}

/**
 * One proposed action definition, as the card says it (EO-426).
 *
 * The role and the action, what it is for, and every result key with
 * its label — the keys are what a step on this action must route, so
 * they are the part a person can hold against the **Routing** section
 * above without opening anything.
 *
 * A definition the role already has is a **change**, and says which
 * keys it adds and which it removes. It also names the steps outside
 * this pipeline that dispatch the same action: they are held to the new
 * keys the moment this is published, and this card's graph says nothing
 * about them.
 */
function renderProposedAction(db: Db, pipelineId: string, definition: ProposedDefinition): string[] {
  const change = changeOf(db, definition);
  const named = `${definition.role} / ${definition.action}`;
  const about = definition.description === "" ? "" : ` — ${definition.description}`;
  const keys = definition.results.map((result) => `\`${result.key}\` (${result.label})`).join(", ");
  const properties = definition.fields["properties"];
  const fieldNames = typeof properties === "object" && properties !== null ? Object.keys(properties) : [];
  const returns = [`  Returns: ${keys}`, ...(fieldNames.length > 0 ? [`  Extra answer fields: ${fieldNames.map((name) => `\`${name}\``).join(", ")}`] : [])];

  if (change.kind === "same") {
    return [`**Action** ${named}${about}`, ...returns, "  Already defined exactly this way; publishing changes nothing about it."];
  }
  if (change.kind === "new") return [`**New action** ${named}${about}`, ...returns];

  const quoted = (list: string[]) => list.map((key) => `\`${key}\``).join(", ");
  const lines = [`**Changed action** ${named}${about}`, "  Changes a definition this role already has.", ...returns];
  lines.push(
    change.added.length === 0 && change.removed.length === 0
      ? "  Adds no result keys and removes none; its description, labels or fields change."
      : `  Adds: ${change.added.length > 0 ? quoted(change.added) : "nothing"} · Removes: ${change.removed.length > 0 ? quoted(change.removed) : "nothing"}`,
  );
  const elsewhere = actionUsedBy(db, definition.role, definition.action).filter((use) => use.pipelineId !== pipelineId || use.finishing !== undefined);
  if (elsewhere.length > 0) lines.push(`  Also used by: ${elsewhere.map(describeActionUse).join(", ")}`);
  return lines;
}

/**
 * A draft that removes a step it never said it would remove (EO-209).
 *
 * The last way an agent's forgetfulness reads as a decision. A draft is
 * one whole document with no patch form, so a step it does not mention is
 * a step it deletes — and that is identical, byte for byte, to a step it
 * decided against. Four guards already stand in front of this: the read
 * gate throws away a graph derived from nothing, `validateDraft` refuses
 * a removal of a step holding items or one another pipeline hands work
 * to, the card names every removal under **Removed**, and the publish
 * path asks again. What they all miss is the empty step nobody routes to,
 * which every rule passes and which surfaces only as a line on a card
 * somebody is approving for a different reason.
 *
 * `removes` closes it by asking for the one thing only the agent knows:
 * whether it meant to. Declared and omitted is a decision and renders as
 * one; omitted and undeclared is refused here.
 *
 * Declared *and still present* is refused too, and it is not pedantry: a
 * draft that lists Review in `steps` and in `removes` has said two
 * incompatible things, and there is no reading of it that is safe to
 * guess at. Publishing the graph would keep a step the rationale says is
 * gone; honouring the declaration would delete one the graph keeps.
 *
 * A `removes` entry naming a step that is neither on the board nor in the
 * draft is left alone. It asks for nothing and gets nothing, and a rule
 * against it would only refuse drafts for a spelling mistake with no
 * consequence.
 *
 * Both mistakes are reported together when a draft manages both, because
 * they are independent — one is a step left out, the other a step named
 * twice — and a turn told only the first would fix it and meet the second
 * on the next round.
 */
function removalRefusal(draft: PipelineDraft, removed: PipelineStep[], counts: Record<string, number>): string | null {
  const declared = new Set(draft.removes);
  const undeclared = removed.filter((step) => !declared.has(step.id));
  // From `draft.steps` rather than from the board, so a contradiction
  // about a step the draft invented is caught as readily as one about a
  // step that exists.
  const contradicted = draft.steps.filter((step) => declared.has(step.id));
  if (undeclared.length === 0 && contradicted.length === 0) return null;

  // The label line first and the argument under it, as
  // `underivedDraftRefusal` has it: what was actually wrong is the part
  // an agent acts on, and burying it in the third sentence of a
  // paragraph about why the rule exists is how a refusal gets skimmed.
  const lines = ["This graph was refused rather than offered, over what it says it removes.", ""];
  if (undeclared.length > 0) {
    const these = undeclared.length === 1 ? "it" : "them";
    lines.push(
      `Dropped without being declared: ${undeclared.map((step) => `**${step.name}**${holdingPhrase(counts, step.id)}`).join(", ")}.`,
      "",
      "A draft is the whole board: every step it does not name is a step it removes. So removing one is something to " +
        "**declare** — its id in `removes` — rather than something to achieve by leaving it out. Otherwise forgetting a " +
        "step and deciding to delete it are the same gesture, and nobody approving the card can tell which one they are " +
        `being shown. If you meant to keep ${these}, put ${these} back in \`steps\`; if you meant to remove ${these}, name ` +
        `${these} in \`removes\` and propose the graph again.`,
      "",
    );
  }
  if (contradicted.length > 0) {
    lines.push(
      `Kept and removed at once: ${contradicted.map((step) => `**${step.name}**`).join(", ")}, named in \`removes\` and also listed in \`steps\`.`,
      "",
      "A step in `steps` survives; a step in `removes` is deleted. Naming one in both says two incompatible things, and " +
        "neither of them is a graph anybody meant. Take it out of whichever list is wrong and propose again.",
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

/**
 * What actually changed about one step, field by field.
 *
 * Field-by-field rather than comparing two rendered sentences, because a
 * sentence deliberately leaves things out — a terminal step reads "the
 * end of the line" whatever it is called, so comparing descriptions
 * reported a rename as no change at all and offered "nothing to apply"
 * for a draft that plainly did something.
 *
 * `position` is excluded on purpose: reordering the columns is a display
 * change, and listing every step whose number shifted because one was
 * inserted above it would bury the edit that was actually made.
 */
function changesOf(
  was: PipelineStep,
  now: { name: string; type: string; ownerRole: string | null; entryAction: string | null; isTerminal: boolean; planMode: boolean; instructionsSummary: string | null },
): string[] {
  const changes: string[] = [];
  if (was.name !== now.name) changes.push(`renamed to **${now.name}**`);

  const before = describeStep(was);
  const after = describeStep(now);
  if (before !== after) changes.push(`${before} → ${after}`);

  if (was.planMode !== now.planMode) changes.push(now.planMode ? "now plans first" : "no longer plans first");
  if (was.instructionsSummary !== now.instructionsSummary) changes.push("new instructions");
  return changes;
}

/**
 * What a step the draft creates sets for itself, as a clause (EO-381).
 *
 * Only an assistant draft carries these, so this is empty on every other
 * card. Shown because they are published as written: a person pressing
 * Publish is agreeing to a 58-minute limit, to a step that checks every
 * five minutes for a week (EO-516), or to one that works on no disk
 * (EO-520), as much as to the step.
 */
function limitsOf(
  step: { id: string } & DraftStepSettings,
  routes: DraftWithLimits["routes"],
  workspaceName: (id: string | null) => string,
): string {
  const parts: string[] = [];
  if (step.timeoutMs !== undefined && step.timeoutMs !== DEFAULT_TIME_LIMIT) {
    const minutes = step.timeoutMs / 60_000;
    parts.push(`may run ${Number.isInteger(minutes) ? `${minutes} min` : `${step.timeoutMs} ms`}`);
  }
  const inputs = Object.entries(step.inputs ?? {});
  if (inputs.length > 0) parts.push(`sets ${inputs.map(([name, value]) => `\`${name}\` = ${JSON.stringify(value)}`).join(", ")}`);
  const watching = step.watch === undefined || step.watch === RUNS_ONCE ? null : watchLine({ watch: step.watch });
  if (watching !== null) parts.push(watching.charAt(0).toLowerCase() + watching.slice(1));
  if (step.workspaceId !== undefined && step.workspaceId !== ITEM_WORKSPACE) parts.push(`works on ${workspaceName(step.workspaceId)}`);
  if (step.workspaceMode !== undefined) parts.push(modeWords(step.workspaceMode));
  for (const route of routes) {
    if (route.fromStepId === step.id && route.requiresComment === true) parts.push(`**${route.label}** needs a reason`);
  }
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/**
 * Each setting a draft changes on a step that already exists, as
 * "what → what it becomes" (EO-520).
 *
 * `now` is what Publish would save (`settledStepSettings`), so a field the
 * draft left out is the step's own and says nothing here. Field by field,
 * and an input by name, because "the inputs changed" is not something a
 * person can agree to — "`ciWaitSeconds`: 1800 → 2400" is.
 */
function settingChanges(
  was: PipelineStep,
  now: SettledStepSettings & { results: readonly StepResult[] },
  routes: DraftWithLimits["routes"],
  workspaceName: (id: string | null) => string,
): string[] {
  const changes: string[] = [];
  const limit = (ms: number | null) => (ms === null ? "EO's default" : describeDuration(ms));
  if (was.timeoutMs !== now.timeoutMs) changes.push(`Time limit: ${limit(was.timeoutMs)} → ${limit(now.timeoutMs)}`);

  const shown = (value: unknown) => (value === undefined ? "unset" : JSON.stringify(value));
  for (const name of new Set([...Object.keys(was.inputs), ...Object.keys(now.inputs)])) {
    const before = was.inputs[name];
    const after = now.inputs[name];
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(`\`${name}\`: ${shown(before)} → ${shown(after)}`);
  }

  const checking = (watch: StepWatch | null) => (watch === null ? "runs once" : watchLine({ watch })!.toLowerCase());
  if (JSON.stringify(was.watch) !== JSON.stringify(now.watch)) changes.push(`Keep checking: ${checking(was.watch)} → ${checking(now.watch)}`);
  if (was.workspaceId !== now.workspaceId) changes.push(`Works on: ${workspaceName(was.workspaceId)} → ${workspaceName(now.workspaceId)}`);
  if (was.workspaceMode !== now.workspaceMode) changes.push(`Repository: ${modeWords(was.workspaceMode)} → ${modeWords(now.workspaceMode)}`);

  // "Needs a reason" on a result the step already offered, or on a new
  // one where the draft said it.
  const yes = (value: boolean) => (value ? "yes" : "no");
  for (const result of now.results) {
    const before = was.results.find((declared) => declared.key === result.key);
    if (before !== undefined && before.requiresComment !== result.requiresComment) {
      changes.push(`**${result.label}** needs a reason: ${yes(before.requiresComment)} → ${yes(result.requiresComment)}`);
    } else if (before === undefined && routes.some((route) => route.fromStepId === was.id && route.resultKey === result.key && route.requiresComment !== undefined)) {
      changes.push(`**${result.label}** needs a reason: ${yes(result.requiresComment)}`);
    }
  }
  return changes;
}

/** "Works on", as the step editor said it: the item's own, no disk, or the workspace by name. */
function workspaceWords(db: Db, id: string | null): string {
  const choice = stepWorkspaceChoice(id);
  if (choice.pick === "inherit") return "the item's own";
  if (choice.pick === "none") return "no disk";
  const workspace = getWorkspace(db, choice.workspaceId as Uuid);
  return workspace ? workspaceLabel(workspace) : `\`${choice.workspaceId}\``;
}

/** How a step uses a repository, in the step editor's words. */
function modeWords(mode: WorkspaceMode): string {
  return mode === "read" ? "reads only" : "works on a branch";
}

/** One step in a sentence: who acts and what they do. */
function describeStep(step: { type: string; ownerRole: string | null; entryAction: string | null; isTerminal: boolean }): string {
  if (step.isTerminal) return "the end of the line";
  if (step.type === "user") return "waits for you";
  if (step.type === "builtin") return `EO runs ${step.entryAction ?? "nothing"}`;
  return `${step.ownerRole ?? "nobody"} runs ${step.entryAction ?? "nothing"}`;
}

/**
 * What each step is holding right now, by step id.
 *
 * Exported for `assist.ts`, which names the same numbers when it refuses
 * a draft that was never derived from a read (EO-208). One function
 * rather than two: a card that says a step holds eight items and a
 * refusal that says it holds nine would be EO disagreeing with itself
 * about the one fact a person is being asked to weigh.
 *
 * Archived items are excluded, which is what makes this "here now"
 * rather than "was ever here". `validateDraft` counts them in
 * deliberately — a removal has to account for everything filed against
 * the step — and the two questions are not the same one.
 */
export function itemCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of listItemsIncludingArchived(db)) {
    if (item.stepId === null || item.archivedAt !== null) continue;
    counts[item.stepId] = (counts[item.stepId] ?? 0) + 1;
  }
  return counts;
}

function holding(counts: Record<string, number>, stepId: string): string {
  const count = counts[stepId] ?? 0;
  return count === 0 ? "" : ` _(${count} ticket${count === 1 ? "" : "s"} here now)_`;
}

/**
 * The same fact as `holding`, as a clause inside a sentence.
 *
 * Two renderings rather than two counts, and the difference is only where
 * they are read: `holding` is a parenthetical on a card next to a step's
 * name, this is the middle of a refusal an agent is being asked to act
 * on. Shared with `underivedDraftRefusal` for `itemCounts`' reason — a
 * refusal saying a step holds nine items beside a card saying eight
 * would be EO disagreeing with itself about the one fact being weighed.
 *
 * Zero is words rather than silence, which is the whole difference from
 * `holding`. An empty step is exactly the case these refusals exist for
 * (EO-209), and naming it with nothing after it would read as a sentence
 * that lost its end — where "holding nothing" tells the reader what is at
 * stake, which is the omission itself and not the work on it.
 */
export function holdingPhrase(counts: Record<string, number>, stepId: string): string {
  const count = counts[stepId] ?? 0;
  return count === 0 ? ", holding nothing" : `, holding ${count} ticket${count === 1 ? "" : "s"}`;
}

/** Added, retargeted and dropped edges, named by what a person sees rather than by id. */
function renderRouteDiff(draft: PipelineDraft, before: StepRoute[], steps: { id: string; name: string }[]): string[] {
  const nameOf = (id: string) => {
    if (id === "user_attention") return "You";
    if (id === "terminal") return "the terminal step";
    return steps.find((step) => step.id === id)?.name ?? id;
  };
  const key = (route: { fromStepId: string; resultKey: string }) => `${route.fromStepId}\u0000${route.resultKey}`;
  const beforeByKey = new Map(before.map((route) => [key(route), route]));
  const afterByKey = new Map(draft.routes.map((route) => [key(route), route]));
  const lines: string[] = [];

  for (const route of draft.routes) {
    const was = beforeByKey.get(key(route));
    if (!was) lines.push(`- ${nameOf(route.fromStepId)} / ${route.resultKey} → ${nameOf(route.target)}`);
    else if (was.target !== route.target) {
      lines.push(`- ${nameOf(route.fromStepId)} / ${route.resultKey} → ${nameOf(was.target)} → ${nameOf(route.target)}`);
    }
  }
  for (const route of before) {
    if (!afterByKey.has(key(route))) lines.push(`- ${nameOf(route.fromStepId)} / ${route.resultKey} — no longer routed`);
  }
  return lines;
}

// ── Context ───────────────────────────────────────────────────

/**
 * The agent that answers a conversation: the system agent (EO-181).
 *
 * Re-exported as `assistAgent` and `scenarioAgent`. The action is still
 * chosen from the step the item sits on rather than from who was
 * mentioned, so one row answering every room changes which agent answers
 * and nothing about what it is asked for.
 */
export function architectAgent(db: Db): Agent | undefined {
  // Archived counts as gone here, not merely as switched off (EO-186):
  // an agent kept for the record is not one to dispatch a conversation
  // to.
  return listAgents(db).find((agent) => agent.role === "system" && isDispatchable(agent));
}

