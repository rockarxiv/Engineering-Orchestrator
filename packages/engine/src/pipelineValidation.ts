import type { ActionResultFacts, CustomModule, EntryRule, IncomingHandOff, ItemTypeEntry, OutsideReachByStep, PipelineStep, RegistryFacts, StepHoldingItems, StepOutsideReach, StepResult, StepRoute } from "@eo/core";
import {
  actionFactsFor,
  builtinCanWait,
  builtinHasSideEffects,
  DEFAULT_MODULE_TIMEOUT_MS,
  ENGINE_RESULTS,
  moduleInputProblems,
  stepHoldsItemsMessage,
  TERMINAL_TARGET,
  timeLimitBoundProblem,
  USER_ATTENTION_TARGET,
  MIN_WATCH_INTERVAL_MINUTES,
  VERIFICATION_FAILED_RESULT,
  WAITING_RESULT,
} from "@eo/core";
import { entryRuleProblems } from "./entryRules.js";

export interface WorkflowProblem {
  /** `error` blocks the save; `warning` is worth saying but the user may know better. */
  severity: "error" | "warning";
  /** The step the problem belongs to, so the editor can show it in place. */
  stateId: string | null;
  /** The route, when the problem is about one branch rather than the step. */
  resultKey?: string;
  message: string;
  /**
   * The removed step and how many items sit on it, as data (EO-230).
   * Only on that one problem — it is what lets a screen offer the board
   * narrowed to those items rather than parse a count out of prose.
   */
  holdsItems?: StepHoldingItems;
}

export interface ValidatePipelineInput {
  steps: PipelineStep[];
  routes: StepRoute[];
  /** Where work enters (ARCHITECTURE.md, "Vocabulary"). Null is itself a problem, not a default. */
  entryStepId: string | null;
  /**
   * Roles somebody would be dispatched for on this pipeline's work —
   * `rolesStaffedFor` in `@eo/core`, asked of the pipeline's project, so
   * the warning below and the scheduler share one staffing rule (EO-474).
   */
  staffedRoles: string[];
  /** How many items currently sit on each step — a step in use cannot be removed. */
  itemCountByStep: Record<string, number>;
  /**
   * Of those, how many are archived (EO-230). Optional and empty by
   * default, which is the conservative reading — a caller that passes
   * nothing gets the refusal exactly as it was, with every item treated
   * as one the board can show.
   */
  archivedCountByStep?: Record<string, number>;
  /**
   * The steps as they are today, to detect removals.
   *
   * Their names as well as their ids (EO-167): a removal is now something
   * a person asks for from the configuration screen, and the refusal it
   * can meet has to name the step they were looking at. The id is a
   * UUIDv7, which names nothing to anybody.
   */
  existingSteps: { id: string; name: string }[];
  /**
   * The module catalog, as data (KAN-104).
   *
   * Passed in rather than read, exactly as `staffedRoles` is, because
   * `packages/engine` is pure (invariant #2) — it must never learn what a
   * module is by opening a database. Defaulted so that every existing
   * caller and test keeps working: an installation with no modules
   * validates the way it always did.
   */
  modules?: CustomModule[];
  /**
   * The steps of the other pipelines this one may hand work to (EO-58).
   *
   * As data, for the reason `modules` is: `packages/engine` is pure
   * (invariant #2), so it cannot go and look up which pipeline a target
   * belongs to. Optional and empty by default, which is also the
   * conservative reading — an installation that passes nothing gets the
   * check exactly as it was, where every target must be a step of this
   * pipeline.
   */
  stepsElsewhere?: PipelineStep[];
  /**
   * The hand-offs *into* this pipeline, so a removal cannot strand one
   * (EO-58, EO-167).
   *
   * The mirror of `stepsElsewhere`, and needed for the same reason:
   * `packages/engine` is pure (invariant #2), so it cannot go and look up
   * who routes here. Without it this check is a screen's good manners
   * rather than a rule — the editor can refuse the removal, and a client
   * calling `pipeline:save` directly, or a draft loaded before somebody
   * else drew the route, sails straight past.
   *
   * Optional and empty by default, which is the conservative reading: a
   * caller that passes nothing gets the check exactly as it was.
   */
  incomingHandOffs?: IncomingHandOff[];
  /**
   * The run timeout a module step's own limit is bounded by (EO-162).
   *
   * As data, for the reason `modules` is: `packages/engine` is pure
   * (invariant #2), so it cannot go and read `engine.guards` for itself.
   * Defaulted to EO's own module default, which is the conservative
   * reading — a caller that passes nothing gets the ceiling that applied
   * before this was configurable, so no step it validates can ask for
   * more than a module has always been allowed.
   */
  runTimeoutMs?: number;
  /**
   * What roles, built-in functions and item types this installation
   * knows about (KAN-124).
   *
   * As data, for the reason `modules` is: `packages/engine` is pure
   * (invariant #2), and which builtins exist is a property of which
   * packs are installed — something the validator must be told rather
   * than something it can know. Required, unlike the inputs above,
   * because there is no conservative default: an empty registry would
   * refuse every builtin step, and a built-in one would make this
   * package the thing that decides what a pack ships.
   */
  registry: RegistryFacts;
  /**
   * Whether a webhook job files items onto this pipeline's entry
   * (EO-334, ARCHITECTURE.md, "Results and routes").
   *
   * As data, for the reason `modules` is: `packages/engine` is pure
   * (invariant #2), so it cannot go and ask which jobs point here.
   * False by default, which is the conservative reading — a caller that
   * passes nothing gets the graph checks exactly as they were, and a
   * pipeline no stranger can reach is not one this refusal is about.
   */
  entryReachedByWebhook?: boolean;
  /**
   * The side-effecting connectors each step reaches through the agent
   * dispatched on it, by step id (EO-334).
   *
   * The half of "reaches a side-effecting connector" this package cannot
   * work out for itself. A module's manifest and a builtin's registry
   * entry are both in hand here; which MCP servers an agent step's role
   * is attached to, and which of those declare `sideEffects`, is two
   * database reads and belongs to the caller — and it is the case the design
   * is actually written about, an agent that can answer the email it
   * was sent.
   *
   * Empty by default. An installation that passes nothing gets the
   * refusal for modules and builtins alone, which is fewer refusals
   * rather than more.
   */
  sideEffectingServersByStep?: Record<string, readonly string[]>;
  /**
   * Whether somebody with authority over this pipeline has accepted
   * that what a webhook delivers reaches a step that sends with nobody
   * reading it first (EO-405).
   *
   * As data, for the reason `entryReachedByWebhook` is: `packages/engine`
   * is pure (invariant #2), and the setting is a column on the pipeline's
   * row. It changes one thing and only one — the severity of what the
   * webhook walk finds. The walk still runs and still names every step,
   * so accepting the risk is never the same as not being told about it.
   *
   * False by default, which is the conservative reading and the one
   * every pipeline that existed before the setting did gets: the
   * refusal, exactly as it was.
   */
  webhookUnattended?: boolean;
  /**
   * The modules holding a trial grant on this pipeline (EO-583,
   * ARCHITECTURE.md, "Modules: a step that is a script").
   *
   * A trial pipeline may run a module nobody has approved, if the person
   * granted it permission to run on that trial's items; the grant is a
   * row, so it is handed in as data like everything above. Empty by
   * default, which is the conservative reading — every pipeline that is
   * not a trial has none, and an unapproved module is refused exactly as
   * it was.
   */
  trialGrantedModuleIds?: readonly string[];
  /**
   * The entry rules being published with this graph (EO-610,
   * ARCHITECTURE.md, "Entry rules"). Absent is a save with no opinion
   * about them, which judges nothing: a rule that has since gone stale
   * must not stop somebody editing a step.
   */
  entryRules?: readonly EntryRule[];
  /**
   * The item types those rules are judged against, as data for `modules`'
   * reason. Defaulted to `registry.itemTypes`, but a caller judging a
   * pipeline several projects use passes what all of them have.
   */
  itemTypes?: ReadonlyMap<string, Pick<ItemTypeEntry, "specShape">>;
}

/**
 * Checks a proposed pipeline before it is saved (U-06, KAN-57).
 *
 * Workflow is data (invariant #7), which is the point — and also why it
 * needs validating: a pipeline is a graph the scheduler walks, and the
 * failure modes are silent. A step owned by a role with no enabled agent
 * doesn't error, it parks every item that reaches it forever, looking
 * exactly like an agent that is thinking hard.
 *
 * The checks that are new here are the ones a *graph* needs and an ordered
 * list did not. "There is a terminal step" was enough when every step
 * walked to the next one; now a terminal you can never arrive at is a
 * pipeline where work goes in and never comes out, and that reads as
 * perfectly valid until you watch an item sit still for an hour.
 */
export function validatePipeline(input: ValidatePipelineInput): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const {
    steps,
    routes,
    entryStepId,
    staffedRoles,
    itemCountByStep,
    archivedCountByStep = {},
    existingSteps,
    modules = [],
    stepsElsewhere = [],
    incomingHandOffs = [],
    runTimeoutMs = DEFAULT_MODULE_TIMEOUT_MS,
    registry,
    entryReachedByWebhook = false,
    sideEffectingServersByStep = {},
    webhookUnattended = false,
    trialGrantedModuleIds = [],
    entryRules = [],
    itemTypes = registry.itemTypes,
  } = input;

  if (steps.length === 0) {
    return [{ severity: "error", stateId: null, message: "A pipeline needs at least one step." }];
  }

  for (const message of entryRuleProblems(entryRules, itemTypes, registry.entryRuleKinds)) {
    problems.push({ severity: "error", stateId: null, message });
  }

  const byId = new Map(steps.map((step) => [step.id, step]));
  // What a route may name that is not here: a step of another pipeline,
  // which is the one legitimate way a target resolves outside this graph
  // (EO-58). Consulted only after `byId`, so nothing a caller passes in
  // here can change where a route that already resolved goes.
  const elsewhereById = new Map(stepsElsewhere.map((step) => [step.id, step]));
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) {
      problems.push({ severity: "error", stateId: step.id, message: `Two steps share the id "${step.id}".` });
    }
    seenIds.add(step.id);
    if (step.name.trim() === "") {
      problems.push({ severity: "error", stateId: step.id, message: "Every step needs a name." });
    }
  }

  const positions = new Set<number>();
  for (const step of steps) {
    if (positions.has(step.position)) {
      problems.push({
        severity: "error",
        stateId: step.id,
        message: `Position ${step.position} is used twice — the column order would be ambiguous.`,
      });
    }
    positions.add(step.position);
  }

  // Removing a step items are sitting on would orphan them: the foreign
  // key would reject it, and if it didn't, those items would be on a
  // step nothing knows how to dispatch.
  //
  // The editor refuses this before it is staged (EO-167), which makes
  // this the backstop rather than the only guard — and the case it
  // catches is a race, not a hand-edit: items move while a draft is
  // open, so a step empty when Remove was clicked can be occupied by the
  // time Publish is. That is the reason the sentence names the step. The
  // person is being told something changed under them, and being told it
  // about a UUID is being told nothing.
  //
  // Typed as well as worded (EO-230): the step and the count travel as
  // data, in the same sentence the editor and the repository use, so the
  // screen can offer the board narrowed to exactly those items.
  for (const removed of existingSteps.filter((step) => !seenIds.has(step.id))) {
    const count = itemCountByStep[removed.id] ?? 0;
    if (count > 0) {
      const holdsItems: StepHoldingItems = { stepId: removed.id, stepName: removed.name, count, archived: archivedCountByStep[removed.id] ?? 0 };
      problems.push({ severity: "error", stateId: removed.id, message: stepHoldsItemsMessage(holdsItems), holdsItems });
    }

    // And removing one another pipeline hands work to would strand that
    // route (EO-58, EO-167). Nothing else catches it: this function is
    // given this pipeline's routes, `step_routes.target` has no foreign
    // key to reject the delete, and the pipeline that declares it is not
    // being saved — so the hole opens in a graph nobody was editing and
    // is found when an item next takes that branch.
    //
    // Refused rather than repaired, and refused here rather than only on
    // the screen. A save does not get to rewrite another pipeline's
    // wiring, and the person can: the message names the route and the
    // pipeline it lives in, which is where they have to go.
    const stranded = incomingHandOffs.filter((handOff) => handOff.target === removed.id);
    if (stranded.length > 0) {
      const named = stranded.map((handOff) => `${handOff.pipelineName} · ${handOff.label}`).join(", ");
      problems.push({
        severity: "error",
        stateId: removed.id,
        message:
          stranded.length === 1
            ? `"${removed.name}" is where ${named} hands work to. Repoint that route in ${stranded[0]!.pipelineName} before removing it.`
            : `"${removed.name}" is where ${named} hand work to. Repoint those routes in their own pipelines before removing it.`,
      });
    }
  }

  // ── Routes ──────────────────────────────────────────────────
  //
  // A dangling target is the likeliest hand-edit error and the most
  // damaging: at runtime the item simply stops, with nothing said.
  const seenResults = new Set<string>();
  for (const route of routes) {
    if (!byId.has(route.fromStepId)) {
      problems.push({
        severity: "error",
        stateId: route.fromStepId,
        resultKey: route.resultKey,
        message: `A result "${route.resultKey}" leaves a step that is not in this pipeline.`,
      });
      continue;
    }
    const pairKey = `${route.fromStepId}\u0000${route.resultKey}`;
    if (seenResults.has(pairKey)) {
      problems.push({
        severity: "error",
        stateId: route.fromStepId,
        resultKey: route.resultKey,
        message: `"${route.resultKey}" is declared twice on this step — which one wins would depend on row order.`,
      });
    }
    seenResults.add(pairKey);

    if (route.target === USER_ATTENTION_TARGET || route.target === TERMINAL_TARGET) continue;
    // A step of another pipeline is a hand-off, not a mistake. A step of
    // no pipeline at all still is: a typo must stay an error rather than
    // become a silent cross-pipeline jump, because at runtime the item
    // simply stops with nothing said.
    if (!byId.has(route.target) && !elsewhereById.has(route.target)) {
      problems.push({
        severity: "error",
        stateId: route.fromStepId,
        resultKey: route.resultKey,
        message: `"${route.resultKey}" routes to a step that is in no pipeline.`,
      });
    }
  }

  if (routes.some((route) => route.target === TERMINAL_TARGET) && !steps.some((step) => step.isTerminal)) {
    problems.push({
      severity: "error",
      stateId: null,
      message: "A result routes to the terminal step, but no step is marked terminal.",
    });
  }

  // ── Reachability ────────────────────────────────────────────
  //
  // From the declared entry step, not from whatever sorts first: those are
  // the same thing in a straight line and different the moment work enters
  // somewhere other than the leftmost column. Falls back to position only
  // so that a pipeline with no entry yet still gets useful reachability
  // problems alongside the one saying it has no entry.
  const entry = (entryStepId !== null ? byId.get(entryStepId) : undefined) ?? [...steps].sort((a, b) => a.position - b.position)[0]!;
  const reachable = reachableFrom(entry.id, steps, routes);

  for (const step of steps) {
    if (!reachable.has(step.id)) {
      problems.push({
        severity: "warning",
        stateId: step.id,
        message: `Nothing routes to "${step.name}", so no ticket can ever reach it.`,
      });
    }
  }

  const terminals = steps.filter((step) => step.isTerminal);

  // Where work can leave. A terminal step is one way out and, since
  // EO-58, a route into another pipeline is the other: a pipeline that
  // hands its work on — Delivery ending with a pull request open, merging
  // living in a pipeline of its own — finishes by leaving rather than by
  // arriving somewhere terminal. Every question below is really "can work
  // still get out of here", so both count.
  const exits = new Set<string>(terminals.map((step) => step.id));
  for (const route of routes) {
    if (byId.has(route.fromStepId) && !byId.has(route.target) && elsewhereById.has(route.target)) exits.add(route.fromStepId);
  }

  if (exits.size === 0) {
    problems.push({
      severity: "error",
      stateId: null,
      message: "No step is terminal, so nothing can ever finish — mark the last one terminal.",
    });
  } else if (![...exits].some((id) => reachable.has(id))) {
    // "A terminal exists" was enough for an ordered list. In a graph it is
    // not: work goes in and never comes out, and every item sits still.
    problems.push({
      severity: "error",
      stateId: null,
      message: "No terminal step can be reached from the first step — work would enter this pipeline and never finish.",
    });
  }

  // A cycle is legitimate here and expected — Review → changes requested →
  // Implementer → Review is the review loop, and being able to express it
  // is the whole reason routing became a graph. What is not legitimate is
  // a cycle with no exit, so the check is "can you still get out" — to a
  // terminal step, or by a route into another pipeline — named per step
  // so the trapped set is visible.
  const canFinish = new Set<string>();
  for (const step of steps) {
    const onward = reachableFrom(step.id, steps, routes);
    if ([...exits].some((exit) => onward.has(exit))) canFinish.add(step.id);
  }
  for (const step of steps) {
    if (step.isTerminal || !reachable.has(step.id) || canFinish.has(step.id)) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      message: `"${step.name}" cannot reach a terminal step — a ticket arriving here would loop forever.`,
    });
  }

  // ── Steps ───────────────────────────────────────────────────
  const staffed = new Set(staffedRoles);
  const moduleById = new Map(modules.map((module) => [module.id, module]));
  const trialGranted = new Set(trialGrantedModuleIds);
  for (const step of steps) {
    if (step.type === "agent") {
      if (step.ownerRole === null) {
        problems.push({
          severity: "error",
          stateId: step.id,
          message: `"${step.name}" is an agent step with no role, so there is nobody to dispatch it to.`,
        });
      } else if (!staffed.has(step.ownerRole)) {
        problems.push({
          severity: "warning",
          stateId: step.id,
          message: `"${step.name}" is owned by "${step.ownerRole}", which has no enabled agent — tickets will wait there indefinitely.`,
        });
      }
      if (!step.entryAction) {
        problems.push({
          severity: "warning",
          stateId: step.id,
          message: `"${step.name}" has an owner but no entry action, so the engine will not know what to ask for.`,
        });
      } else if (step.ownerRole !== null) {
        // What the action can return, against what the step routes
        // (EO-423). Only once there is a role: a definition is keyed by
        // role and action, and a step with nobody to dispatch already
        // has an error saying so.
        const action = actionFactsFor(registry, step.ownerRole, step.entryAction);
        if (action === undefined) {
          problems.push({
            severity: "warning",
            stateId: step.id,
            // A warning, because nothing here is wrong in a way a person
            // must fix before publishing: the step runs. What they are
            // owed is what it runs *as*.
            message:
              `"${step.name}" asks "${step.ownerRole}" for "${step.entryAction}", which neither that role nor an installed pack defines — ` +
              `its answer is not validated and will route as "done".`,
          });
        } else {
          problems.push(...actionResultProblems(step, routes, step.entryAction, action.results));
        }
      }
    }

    // A builtin names a function EO ships, so a name it does not ship is a
    // step that can never run. An error rather than a warning: unlike a
    // role, this cannot be fixed later by enabling an agent.
    if (step.type === "builtin") {
      const declared = step.entryAction === null ? undefined : registry.builtins.get(step.entryAction);
      if (step.entryAction === null || declared === undefined) {
        problems.push({
          severity: "error",
          stateId: step.id,
          message:
            step.entryAction === null
              ? `"${step.name}" runs a built-in function but does not say which.`
              : `"${step.name}" runs "${step.entryAction}", which is not one of EO's built-in functions (${[...registry.builtins.keys()].join(", ")}).`,
        });
      } else {
        // The same check a module step has had since KAN-104, now that a
        // builtin's outcomes are data rather than literals inside its own
        // runner (EO-77). Named by the function rather than by the step,
        // because the function is the thing that can return them —
        // renaming the column does not change what comes back.
        problems.push(...resultProblems(step, routes, step.entryAction, declared.results));
      }
    }

    if (step.type === "module") problems.push(...moduleProblems(step, routes, moduleById, trialGranted));
    problems.push(...decisionProblems(step, routes));
    problems.push(...timeLimitProblems(step, runTimeoutMs));
    problems.push(...watchProblems(step, registry, moduleById));
    problems.push(...waitingRouteProblems(step, routes));
  }

  // A terminal step is where work has finished. The scheduler declines to
  // dispatch one for exactly this reason, so this is about saying so at
  // configuration time rather than leaving someone to wonder why their
  // last step never runs.
  for (const step of steps) {
    if (step.isTerminal && step.type !== "user") {
      problems.push({
        severity: "error",
        stateId: step.id,
        message: `"${step.name}" is terminal, so nothing runs there — a step that both finishes work and does work would never be dispatched.`,
      });
    }
  }

  // Where work enters. Without one, an item assigned to this pipeline has
  // nowhere to land, and falling back to "the lowest position" is what
  // the design exists to stop — it would make reordering the columns re-route
  // every new item.
  if (entryStepId === null) {
    problems.push({ severity: "error", stateId: null, message: "No step is marked as where work enters this pipeline." });
  } else if (!byId.has(entryStepId)) {
    problems.push({ severity: "error", stateId: null, message: "Work enters at a step that is not in this pipeline." });
  } else if (byId.get(entryStepId)!.isTerminal) {
    problems.push({ severity: "error", stateId: entryStepId, message: "Work cannot enter at a terminal step — it would arrive finished." });
  }

  // And what a stranger's event can reach once it is on the board
  // (EO-334). Last, and only on an entry that resolves: a graph whose
  // entry is missing or is not in it has a problem about that already,
  // and a walk from nowhere would add a second sentence about the first.
  if (entryReachedByWebhook && entryStepId !== null && byId.has(entryStepId)) {
    problems.push(...webhookSideEffectProblems(entryStepId, steps, routes, registry, moduleById, sideEffectingServersByStep, webhookUnattended));
  }

  return problems;
}

/**
 * Why the webhook walk stops at this step, if it does (EO-334, EO-435,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow",
 * "Webhooks").
 *
 * `sends` is the original question — whether running the step reaches
 * outside EO. Three declarations answer it: a module says so in its
 * manifest, a builtin in the registry entry its pack contributes, and
 * an MCP server in the connector setup on it — which is the one the
 * caller has to resolve, because it hangs off the agents in the step's
 * role rather than off the step. None of the three is guessed at: a
 * thing that says nothing is taken at its word.
 *
 * `creates` is a module whose manifest declares `needs.create` (EO-435).
 * It sends nothing anywhere, and it is the same hole: the payload an
 * agent is only ever shown as a quoted, untrusted block can be copied
 * into a new item's title and body, where the next agent reads it as
 * the item's own description. Unlike `sideEffects` that declaration is
 * enforced (EO-433), so a module that does not make it cannot create.
 *
 * A step that does both is `sends`: the sentence written for that is
 * true of it, and is the one a person has already read. `creates` is
 * for the step that counts for no other reason.
 */
export function webhookReach(
  step: PipelineStep,
  registry: RegistryFacts,
  moduleById: ReadonlyMap<string, Pick<CustomModule, "manifest">>,
  sideEffectingServersByStep: Readonly<Record<string, readonly string[]>>,
): StepOutsideReach | null {
  if ((sideEffectingServersByStep[step.id] ?? []).length > 0) return "sends";
  if (step.type === "builtin") return builtinHasSideEffects(registry, step.entryAction) ? "sends" : null;
  if (step.type === "module" && step.entryAction !== null) {
    const manifest = moduleById.get(step.entryAction)?.manifest;
    if (manifest?.sideEffects === true) return "sends";
    // Optional chaining twice: a manifest stored before `needs.create`
    // existed, and handed here unparsed, is one that creates nothing.
    if (manifest?.needs?.create === true) return "creates";
  }
  return null;
}

/**
 * Per step, whether it sends or creates outside EO (EO-584,
 * ARCHITECTURE.md, "Step modes on a trial").
 *
 * The webhook refusal's own classification (`webhookReach`), every step
 * at once rather than only those a webhook can reach, so that what the
 * assistant reads to propose a step's mode on a trial and what refuses a
 * pipeline that sends unread can never disagree about a step. A step that
 * does neither is absent.
 *
 * The same inputs `validatePipeline` takes for the walk, and the same
 * caller's job to supply the one that needs rows:
 * `sideEffectingServersByStep`, the connectors an agent step's role can
 * reach (`connectors/sideEffects.ts`).
 */
export function outsideReachByStep(input: {
  steps: readonly PipelineStep[];
  registry: RegistryFacts;
  modules?: readonly Pick<CustomModule, "id" | "manifest">[];
  sideEffectingServersByStep?: Readonly<Record<string, readonly string[]>>;
}): OutsideReachByStep {
  const moduleById = new Map((input.modules ?? []).map((module) => [module.id, module]));
  const reach: OutsideReachByStep = {};
  for (const step of input.steps) {
    const found = webhookReach(step, input.registry, moduleById, input.sideEffectingServersByStep ?? {});
    if (found !== null) reach[step.id] = found;
  }
  return reach;
}

/**
 * A webhook's payload reaching something that sends, with nobody asked
 * in between (EO-334, ARCHITECTURE.md, "A connector is an MCP server with a setup flow", "Results
 * and routes").
 *
 * The support-triage pipeline is the case: inbound email becomes an
 * item, the item becomes an agent's prompt, and the agent can reply
 * through a helpdesk connector. Every hop is ordinary and the whole is
 * a stranger on the internet driving a tool EO gave somebody. The
 * quoted block in `context.ts` is the half that frames the payload; this
 * is the half that bounds what it can get to, because framing is advice
 * and a graph is a fact.
 *
 * **A user step is the thing that breaks the chain**, whatever it is
 * called: a step that waits for a person is where a payload stops being
 * acted on unread. So the walk starts at the entry and stops at the
 * first human, and everything it can reach before meeting one is what
 * this refuses.
 *
 * **A refusal rather than a warning**, unless somebody has said
 * otherwise about this one pipeline. A warning on the publish screen is
 * a line somebody reads once and publishes past, and what it would be
 * protecting is the one path into this installation that nobody in it
 * controls. The way past it is to add the step — which is what the
 * sentence says, in the words the design wrote for it.
 *
 * **Somebody did ask otherwise (EO-405)**, for pipelines that are meant
 * to run with nobody in them — acknowledging every inbound form, say.
 * So the refusal is the default and `unattended` is the exception: a
 * setting on the one pipeline, turned on by a person in its editor and
 * by nothing else. With it on the same walk runs, finds the same steps
 * and reports each as a warning, in a sentence that says what is now
 * true rather than what to add. The finding is kept rather than dropped
 * because accepting a risk is a reason to keep being shown it.
 *
 * What it deliberately does not follow: a route into another pipeline.
 * `stepsElsewhere` carries those steps but not their routes, so a walk
 * that crossed the boundary would be guessing at the far side's shape.
 * The hand-off lands on a step of a pipeline of its own, and a webhook
 * that reaches that pipeline's entry meets this check there.
 */
function webhookSideEffectProblems(
  entryStepId: string,
  steps: PipelineStep[],
  routes: StepRoute[],
  registry: RegistryFacts,
  moduleById: Map<string, CustomModule>,
  sideEffectingServersByStep: Record<string, readonly string[]>,
  unattended: boolean,
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>([entryStepId]);
  const queue = [entryStepId];

  while (queue.length > 0) {
    const step = byId.get(queue.pop()!);
    if (!step) continue;

    const reach = webhookReach(step, registry, moduleById, sideEffectingServersByStep);
    if (reach === "sends") {
      problems.push(
        unattended
          ? {
              severity: "warning",
              stateId: step.id,
              // No instruction, because there is nothing left to do:
              // this is the state somebody chose, said back to them.
              message: `Items arriving by webhook reach ${step.name} without a person reading them first.`,
            }
          : {
              severity: "error",
              stateId: step.id,
              // The design's own words, which are a reader's rather than a
              // validator's: it names what arrives, where it gets to, and the
              // one thing to do about it.
              message: `Cases arriving by webhook go straight to ${step.name}. Add an approve step before ${step.name}.`,
            },
      );
    } else if (reach === "creates") {
      // Its own sentences (EO-435), because the ones above are about
      // sending and this step sends nothing: what it does is file work
      // made of a stranger's words. Same shape otherwise — the warning
      // states, the refusal says what to add.
      problems.push(
        unattended
          ? {
              severity: "warning",
              stateId: step.id,
              message: `${step.name} creates work from what a webhook sent, with nobody asked in between.`,
            }
          : {
              severity: "error",
              stateId: step.id,
              message: `${step.name} creates work from what a webhook sent, with nobody asked in between. Add an approve step before ${step.name}.`,
            },
      );
    }

    // A person stands between the payload and everything past here, so
    // the walk ends rather than carrying the payload's unread-ness
    // onward. Checked after the test above and not before it, because a
    // human step cannot run anything and so can never be the step that
    // sends.
    if (step.type === "user" || step.isTerminal) continue;

    for (const target of onwardFrom(step, ordered, routes)) {
      if (seen.has(target) || !byId.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }

  return problems;
}

/**
 * How long a step may run, against what a run may take (EO-162).
 *
 * Two checks, and both of them refuse rather than adjust. A step asking
 * for longer than the run timeout is a pair of numbers that contradict
 * each other, and the whole point of this story is that the loser of such
 * a contest must never be decided quietly — so publishing is refused and
 * the sentence names both numbers and where to change either.
 *
 * The other is a limit on a step that has no module to apply it to. It
 * would be stored and never read, which is the same failure in its
 * cheapest form: `changeKind` clears it when somebody switches a step's
 * kind in the editor, and this is what catches the graph that arrives by
 * another road.
 */
function timeLimitProblems(step: PipelineStep, runTimeoutMs: number): WorkflowProblem[] {
  if (step.timeoutMs === null) return [];
  if (step.type !== "module") {
    return [
      {
        severity: "error",
        stateId: step.id,
        message: `"${step.name}" sets a time limit, which only a module step has anything to apply one to.`,
      },
    ];
  }
  const bound = timeLimitBoundProblem({ stepName: step.name, timeoutMs: step.timeoutMs, runTimeoutMs });
  return bound === null ? [] : [{ severity: "error", stateId: step.id, message: bound }];
}

/**
 * Whether a step can keep checking as it is configured to (EO-456,
 * ARCHITECTURE.md, "A step").
 *
 * The mode belongs to the two step types that run something of their own
 * — EO's function, or a module — and only to one whose function or
 * module says it was written to be asked over and over: a check answers
 * `waiting` until it has a result, and a function that runs once has no
 * way to say that. So a step whose function does not declare it is
 * refused rather than run on an interval it was never meant for.
 *
 * And the other way round (EO-505): a function or module that says it
 * can wait is refused on a step that runs once. It answers `waiting` on
 * its first check, nothing would ever ask it again, and the item would
 * park on its first run. Declaring it is a promise that it waits — every
 * one EO ships does — so the check reads the declaration rather than
 * guessing which of them might sometimes answer at once.
 *
 * Errors throughout, because each is a step that would misbehave on the
 * first item: one checking more than once a minute is polling somebody
 * else's system for nothing, one that gives up at once never watches,
 * and one that waits on a step that runs once parks every item.
 *
 * A step naming a function or module this installation does not have is
 * not refused again here: it already has an error saying so.
 */
function watchProblems(step: PipelineStep, registry: RegistryFacts, moduleById: Map<string, CustomModule>): WorkflowProblem[] {
  if (step.watch === null) return runOnceProblems(step, registry, moduleById);
  if (step.type !== "builtin" && step.type !== "module") {
    return [
      {
        severity: "error",
        stateId: step.id,
        message: `"${step.name}" is set to keep checking, which only a step EO runs or a step a script runs can do.`,
      },
    ];
  }

  const problems: WorkflowProblem[] = [];
  const { everyMinutes, giveUpAfterHours } = step.watch;
  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_WATCH_INTERVAL_MINUTES) {
    problems.push({
      severity: "error",
      stateId: step.id,
      message: `"${step.name}" checks every ${everyMinutes} minutes, and a step that keeps checking may check at most once a minute.`,
    });
  }
  // Asked of a watch that never gives up as well (EO-571). Its hours are
  // not read here, but a device that predates the flag reads the step by
  // them, and nought there is a step that stops before it checks.
  if (!Number.isFinite(giveUpAfterHours) || giveUpAfterHours <= 0) {
    problems.push({
      severity: "error",
      stateId: step.id,
      message: `"${step.name}" gives up after ${giveUpAfterHours} hours, so it would stop before it had checked at all. Give it a time in hours above nought.`,
    });
  }

  if (step.type === "builtin" && step.entryAction !== null && registry.builtins.has(step.entryAction) && !builtinCanWait(registry, step.entryAction)) {
    problems.push({
      severity: "error",
      stateId: step.id,
      message: `"${step.name}" is set to keep checking, but "${step.entryAction}" does not say it can wait — it runs once. Turn keep checking off, or pick a function made to be checked.`,
    });
  }
  if (step.type === "module" && step.entryAction !== null) {
    const module = moduleById.get(step.entryAction);
    if (module !== undefined && module.manifest.watch !== true) {
      problems.push({
        severity: "error",
        stateId: step.id,
        message: `"${step.name}" is set to keep checking, but "${module.name}" does not say it can wait — its manifest does not declare \`watch: true\`. Turn keep checking off, or pick a module made to be checked.`,
      });
    }
  }
  return problems;
}

/**
 * A step that runs once, running something that waits (EO-505) — the
 * mirror of the last two checks in `watchProblems`, which it is called
 * from. The sentence says to turn keep checking on, because that is the
 * one change that makes the step work; a route on `waiting` would not,
 * and `waitingRouteProblems` refuses one.
 */
function runOnceProblems(step: PipelineStep, registry: RegistryFacts, moduleById: Map<string, CustomModule>): WorkflowProblem[] {
  if (step.entryAction === null) return [];
  if (step.type === "builtin" && builtinCanWait(registry, step.entryAction)) {
    return [
      {
        severity: "error",
        stateId: step.id,
        message: `"${step.name}" runs "${step.entryAction}", which answers "${WAITING_RESULT}" until it has a result, but "${step.name}" runs once — nothing would ever ask it again, and every item would park on its first run. Turn keep checking on for "${step.name}".`,
      },
    ];
  }
  if (step.type === "module") {
    const module = moduleById.get(step.entryAction);
    if (module !== undefined && module.manifest.watch === true) {
      return [
        {
          severity: "error",
          stateId: step.id,
          message: `"${step.name}" runs "${module.name}", whose manifest declares \`watch: true\` — it answers "${WAITING_RESULT}" until it has a result — but "${step.name}" runs once, so nothing would ever ask it again and every item would park on its first run. Turn keep checking on for "${step.name}".`,
        },
      ];
    }
  }
  return [];
}

/**
 * A route keyed `waiting`, on any step (EO-456, EO-505).
 *
 * `waiting` is what a check says while it is still waiting, and it never
 * routes: on a step that keeps checking EO checks again, and on a step
 * that runs once the answer parks the item asking for keep checking.
 * A route on it is a branch nothing can take — and worse than inert on a
 * step that runs once, where it would send the item back round to a
 * check that answers `waiting` again. So it is refused whatever the step
 * is, not only where the step keeps checking, and the step-kind result
 * checks below step over the key so it is said once, in this sentence.
 */
function waitingRouteProblems(step: PipelineStep, routes: StepRoute[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const route of routes) {
    if (route.fromStepId !== step.id || route.resultKey !== WAITING_RESULT) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: route.resultKey,
      message: `"${step.name}" routes "${WAITING_RESULT}", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`,
    });
  }
  return problems;
}

/**
 * What a `module` step has to satisfy before it can be published (KAN-104).
 *
 * These four are the module-step version of what a builtin already gets:
 * a step naming a function that is not there can never run, and saying so
 * at save time beats leaving someone to watch items pile up on a column
 * that looks exactly like an agent thinking hard.
 *
 * Its routes are then checked by `resultProblems`, which a builtin step
 * now gets too (EO-77) — an outcome declared up front is what turns
 * the original design's runtime "nothing matches this result, ask a human" into
 * something visible before an item is anywhere near the step.
 *
 * The values it configures are checked too (EO-78), and only a module
 * step can have any: an input comes into existence by being declared in
 * a manifest, so nothing else has one to get wrong.
 */
function moduleProblems(step: PipelineStep, routes: StepRoute[], moduleById: Map<string, CustomModule>, trialGranted: ReadonlySet<string>): WorkflowProblem[] {
  if (step.entryAction === null) {
    return [{ severity: "error", stateId: step.id, message: `"${step.name}" runs a module but does not say which.` }];
  }

  const module = moduleById.get(step.entryAction);
  if (!module) {
    return [
      {
        severity: "error",
        stateId: step.id,
        // Names the id: on an imported pipeline this is the one clue to
        // which module failed to come with it (KAN-108).
        message: `"${step.name}" runs a module this installation does not have ("${step.entryAction}").`,
      },
    ];
  }
  if (module.archivedAt !== null) {
    return [{ severity: "error", stateId: step.id, message: `"${step.name}" runs "${module.name}", which has been deleted.` }];
  }
  // The check that makes accepting an imported module safe: it arrives
  // unapproved, and this is what keeps it inert until somebody has read
  // it and approved it — which runs its tests, and needs every one to
  // pass (EO-353). A trial grant is the one other permission (EO-583):
  // on the trial it was granted for, and only there.
  if (module.approvedAt === null && !trialGranted.has(module.id)) {
    return [
      {
        severity: "error",
        stateId: step.id,
        message: `"${module.name}" has not been approved. Read it in Settings → Modules and approve it before a step runs it — approving runs its tests, and it needs at least one, all passing.`,
      },
    ];
  }

  // What this step sets for the inputs the module declares (EO-78).
  //
  // An error, and here rather than only at dispatch: a number typed into
  // the box for a string is a mistake a person can fix in the second it
  // takes to read this, and the same mistake published is a module doing
  // arithmetic on `"900"` in a subprocess nobody is watching. The message
  // names the input, because a step can configure several and "one of
  // these is the wrong type" is not something anyone can act on.
  //
  // A stored value for an input the manifest no longer declares is not a
  // problem — see `moduleInputProblems`. It is inert, and the manifest
  // decides what exists.
  const inputProblems = moduleInputProblems(module.manifest, step.inputs).map(
    (message): WorkflowProblem => ({ severity: "error", stateId: step.id, message: `"${step.name}" runs "${module.name}": ${message}` }),
  );

  return [...inputProblems, ...resultProblems(step, routes, module.name, module.manifest.results)];
}

/**
 * A step's routes against what the thing it runs can actually return.
 *
 * Shared by `module` and `builtin` steps (EO-77). It was a module's alone
 * while a builtin's outcomes lived as string literals in the middle of
 * `builtins.ts`; they are declared data now, so the two get the same
 * check. An agent step's is `actionResultProblems`, which asks the same
 * question of its action's declared results and is stricter about the
 * answer (EO-423).
 *
 * `subject` is the thing that returns the results — a module's name, a
 * builtin's function name — rather than the step's, because that is what
 * a person would have to change their mind about.
 */
function resultProblems(step: PipelineStep, routes: StepRoute[], subject: string, results: readonly string[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const declared = new Set(results);
  const outgoing = routes.filter((route) => route.fromStepId === step.id);

  for (const route of outgoing) {
    if (declared.has(route.resultKey)) continue;
    // Except the one result nothing that *runs* declares (EO-297).
    // `verification_failed` is contributed by the workspace kind the
    // item's step works in — a branch that can be checked, a folder that
    // can be looked in — and which kind that is depends on the item
    // rather than on the pipeline, so this package cannot know and must
    // not guess. Permitted, never required: the supervisor asks the kind
    // whether it has a verifier for the action before it takes the
    // route, so a route declared where nothing verifies is inert rather
    // than wrong, and refusing to save it here would refuse a pipeline
    // that is correct for every item that has a workspace which checks.
    if (route.resultKey === VERIFICATION_FAILED_RESULT) continue;
    // Refused in its own sentence by `waitingRouteProblems` (EO-505).
    if (route.resultKey === WAITING_RESULT) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: route.resultKey,
      // A branch that can never be taken. Harmless in the sense that
      // nothing breaks, and misleading in the way that matters: the
      // configuration screen draws an edge somebody believes in.
      message: `"${route.resultKey}" is not a result "${subject}" can return (${results.join(", ")}).`,
    });
  }

  // No routes at all is legitimate — an unconditional step walks to the
  // next by position, which is what `resolveRoute` does and what a
  // `source` step relies on. It stops being legitimate the moment the
  // step can fail, because then a failure advances exactly like a
  // success and nothing anywhere says so.
  if (outgoing.length === 0) {
    if (results.length > 1) {
      problems.push({
        severity: "warning",
        stateId: step.id,
        message: `"${step.name}" declares no routes, so all of ${results.join(", ")} walk to the next step — a failure would advance like a success.`,
      });
    }
    return problems;
  }

  for (const result of results) {
    if (outgoing.some((route) => route.resultKey === result)) continue;
    // A manifest listing `waiting` among its results is not asking for a
    // route on it — there can be none (EO-505).
    if (result === WAITING_RESULT) continue;
    problems.push({
      severity: "warning",
      stateId: step.id,
      resultKey: result,
      message: `"${subject}" can return "${result}", which has no route — a ticket getting that result would park and ask you.`,
    });
  }

  return problems;
}

/**
 * An agent step's routes against what its action declares (EO-423).
 *
 * `resultProblems` asked of an agent step, and answered strictly on the
 * second half. That function's own comment used to say why an agent step
 * had no such check — its verdict was whatever its prompt said — and that
 * stopped being true when an action became a declared thing (EO-421): the
 * keys are the enum the provider is constrained to, so they are known
 * before an item is anywhere near the step.
 *
 * **A declared key with no route is an error here and a warning there.**
 * Decided by the person who owns the feature, and the reason is in what
 * each key is: a builtin's `failed` is a branch that may never be taken,
 * while an action's results are the answers an agent is *told to choose
 * between* on every run. One left unrouted is not an edge case waiting
 * to happen, it is an ordinary answer with nowhere to go. That includes a
 * step with no routes at all — the walk to the next step by position
 * would carry every answer the same way, which is what the keys exist to
 * stop. The sentence names `user_attention`, because "I do not want this
 * to go anywhere" has an honest spelling and it is that one.
 *
 * **The engine's own results are permitted and never required**
 * (`ENGINE_RESULTS`): a run that stopped to ask, one that escalated and
 * a workspace that would not vouch for the work are produced by EO
 * whatever the action is, so a route on one is never a branch that
 * cannot be taken. An action may still declare one — the pack's `review`
 * declares `needs_user_input` — and then it is required like any other.
 */
function actionResultProblems(step: PipelineStep, routes: StepRoute[], action: string, results: readonly ActionResultFacts[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const keys = results.map((result) => result.key);
  const declared = new Set(keys);
  const outgoing = routes.filter((route) => route.fromStepId === step.id);

  for (const route of outgoing) {
    // `waiting` is refused in its own sentence by `waitingRouteProblems` (EO-505).
    if (declared.has(route.resultKey) || ENGINE_RESULTS.includes(route.resultKey) || route.resultKey === WAITING_RESULT) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: route.resultKey,
      message: `"${route.resultKey}" is not a result the "${action}" action can return (${keys.join(", ")}).`,
    });
  }

  for (const key of declared) {
    if (outgoing.some((route) => route.resultKey === key)) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: key,
      message:
        `The "${action}" action can return "${key}", which "${step.name}" does not route — an item getting that result would have nowhere to go. ` +
        `Route it to a step, or to ${USER_ATTENTION_TARGET} to ask a person.`,
    });
  }

  return problems;
}

/**
 * A human step's results against its routes (EO-310, ARCHITECTURE.md, "Results and routes").
 *
 * The same question `resultProblems` asks of a builtin, answered
 * strictly: "the validator requires every declared result to be routed".
 * Errors rather than warnings, and that is the difference worth writing
 * down. A builtin's unrouted result is a branch nothing may ever take,
 * so EO parks the item and asks — which is a sentence somebody reads
 * once a month. A human step's unrouted result is a *button*, drawn on
 * the item, offered to a person: pressing it and having nothing happen
 * is the whole promise of the screen broken, and it would break at the
 * one moment somebody was trying to approve something.
 *
 * The mirror is an error for a reason of its own. A route out of a user
 * step whose key nothing declares is an edge no gesture can take —
 * unreachable, because a person can only send a key the step declares,
 * and drawn on the configuration screen as though it were wiring
 * somebody could rely on.
 *
 * Only `user` steps. A result declared on any other kind is refused in
 * its own sentence rather than silently ignored: a step that stopped
 * being human keeps buttons nobody will ever see, which is the same
 * dead wiring one paragraph up.
 */
function decisionProblems(step: PipelineStep, routes: StepRoute[]): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const outgoing = routes.filter((route) => route.fromStepId === step.id);

  if (step.type !== "user") {
    if (step.results.length > 0) {
      problems.push({
        severity: "error",
        stateId: step.id,
        message:
          `"${step.name}" declares results for a person to choose between, but it is not a step a person acts on — ` +
          `${step.type === "agent" ? "an agent" : "what runs there"} reports its own result. Make it a step a person does, or remove them.`,
      });
    }
    return problems;
  }

  // First declaration wins, which is not a preference — it is what every
  // reader of this list already does. `decisionRefusal` matches the key
  // with `.find`, and `resolveRoute` is given the key rather than the
  // declaration, so a second entry under the same key is a button whose
  // own words and whose "needs a reason" can never be the ones that
  // apply.
  const declared = new Map<string, StepResult>();
  for (const result of step.results) {
    if (!declared.has(result.key)) {
      declared.set(result.key, result);
      continue;
    }
    // The same sentence the duplicate-route check makes one screen up,
    // about the same failure: two rows, one answer between them, and
    // which of them anybody gets decided by the order they happen to sit
    // in. `step_routes` has a unique index that makes this impossible on
    // the routing side; `results` is JSON, so this is the index.
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: result.key,
      message:
        `"${step.name}" offers "${result.key}" twice. Both buttons send the same answer, so the second one's own words and ` +
        `whether it asks for a reason could never be the ones that applied — and which of them a person saw would depend on ` +
        `row order. Give it a result key of its own, or take it off the step.`,
    });
  }

  // Over the first declaration of each key rather than over the list: a
  // key declared twice has already been reported once above, and saying
  // "nothing routes it" twice about one word is noise on top of it.
  for (const result of declared.values()) {
    if (outgoing.some((route) => route.resultKey === result.key)) continue;
    problems.push({
      severity: "error",
      stateId: step.id,
      resultKey: result.key,
      message: `"${step.name}" offers "${result.label}", but nothing says where it sends the item — the button would do nothing. Route it, or take it off the step.`,
    });
  }

  for (const route of outgoing) {
    const offered = declared.get(route.resultKey);
    if (offered === undefined) {
      problems.push({
        severity: "error",
        stateId: step.id,
        resultKey: route.resultKey,
        message:
          declared.size === 0
            ? `"${route.resultKey}" routes out of "${step.name}", but nobody there can choose it: the step offers nothing to press. Give it that result, or remove the branch.`
            : `"${route.resultKey}" routes out of "${step.name}", which does not offer it (${[...declared.keys()].join(", ")}). Give it that result, or remove the branch.`,
      });
      continue;
    }

    // A decision routed to a person's attention, which is a button that
    // can never act.
    //
    // `user_attention` means "park the item and ask somebody" (KAN-55),
    // and it is exactly right for an agent's result — a review that ends
    // in a question has to stop and wait. Out of a *human* step it is a
    // contradiction: the person is already the one being asked, standing
    // on the step, looking at the button. Taking it would park the item
    // where it already stands, so `items:decide` refuses it every single
    // time, whoever presses it and whatever they type.
    //
    // Refused here rather than only there, because there is the wrong
    // place to find out. The command's refusal is a sentence a person
    // reads *after* pressing a button somebody published for them; this
    // is the same sentence said to whoever is drawing the branch, while
    // they can still point it somewhere. A published decision is
    // actionable or it is not published.
    //
    // `terminal` is deliberately not in this check: it resolves to the
    // pipeline's terminal step, which is a real destination and is what
    // the developer pack's "Done" approves to.
    if (route.target === USER_ATTENTION_TARGET) {
      problems.push({
        severity: "error",
        stateId: step.id,
        resultKey: route.resultKey,
        message:
          `"${step.name}" offers "${offered.label}" and routes it to a person's attention, which is where the item already is — ` +
          `pressing it would leave the item exactly where it stands, so EO refuses it every time. Point it at a step.`,
      });
    }
  }

  return problems;
}

/**
 * Every step reachable from `startId` by following routes.
 *
 * A step with no declared routes falls through to the next by position,
 * exactly as `resolveRoute` does — otherwise the `source` step would look
 * like a dead end to the validator and like a working step at runtime.
 */
/**
 * Where an item on this step goes next, by the rule the scheduler
 * follows.
 *
 * One spelling, because two walks ask it: what is reachable at all, and
 * what a webhook's payload reaches before a person sees it (EO-334).
 * Two copies of the fall-through rule would be two chances for one of
 * them to disagree with `resolveRoute` about a step nobody drew a route
 * out of.
 *
 * `ordered` is the steps by position, which the caller sorts once
 * rather than per step.
 */
function onwardFrom(step: PipelineStep, ordered: PipelineStep[], routes: StepRoute[]): string[] {
  const outgoing = routes.filter((route) => route.fromStepId === step.id);
  if (outgoing.length === 0) {
    const next = ordered.find((candidate) => candidate.position > step.position);
    return next ? [next.id] : [];
  }

  const targets: string[] = [];
  for (const route of outgoing) {
    if (route.target === USER_ATTENTION_TARGET) continue; // parks in place; goes nowhere
    if (route.target === TERMINAL_TARGET) {
      const terminal = ordered.find((candidate) => candidate.isTerminal);
      if (terminal) targets.push(terminal.id);
      continue;
    }
    targets.push(route.target);
  }
  return targets;
}

function reachableFrom(startId: string, steps: PipelineStep[], routes: StepRoute[]): Set<string> {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>([startId]);
  const queue = [startId];

  while (queue.length > 0) {
    const id = queue.pop()!;
    const step = byId.get(id);
    if (!step) continue;

    // A terminal step is the end of the line. Without this it would fall
    // through to "next by position" below and quietly make whatever
    // happens to sit after it look reachable.
    if (step.isTerminal) continue;

    for (const target of onwardFrom(step, ordered, routes)) {
      if (seen.has(target) || !byId.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }

  return seen;
}

export function hasBlockingProblem(problems: WorkflowProblem[]): boolean {
  return problems.some((problem) => problem.severity === "error");
}
