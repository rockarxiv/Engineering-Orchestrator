import { backendAllowed, bindingRefusal, DEFAULT_MEMORY_DELIVERY_CHARS, DEFAULT_MEMORY_SCOPE_MAX_CHARS, DEFAULT_MEMORY_SCOPE_MAX_ENTRIES, DEFAULT_SKILL_ARCHIVE_AFTER_RUNS, DEFAULT_SKILL_STALE_AFTER_RUNS, isBuiltinRole, isDispatchable, isPreviewAgent, rolesStaffedFor, settledWatch, staffingAgents, stepHoldsItemsMessage, stepWorkspaceChoice, timeLimitBoundProblem, withMemoryNoteGrant } from "@eo/core";
import type { ActionDefinitionDraft, Agent, AgentRemovalImpact, EntryRule, GuardConfigView, IpcPayload, IpcResponse, ItemTypeEntry, Registry, Uuid, PipelineStep, StepRoute, StepWatch } from "@eo/core";
import { hasBlockingProblem, outsideReachByStep, validatePipeline, type WorkflowProblem } from "@eo/engine";
import type { Db } from "../db/client.js";
import { registry, registryForProject, withProposedActions } from "../registry.js";
import { sectionLockFor } from "../managed/locks.js";
import { loadRolePrompt, promptHash } from "../roles/prompts.js";
import {
  archiveAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getAgentAttachments,
  getItem,
  getProject,
  getRun,
  listActiveRuns,
  listPipelines,
  getPipeline,
  getSetting,
  getStep,
  getWorkspace,
  isDiverged,
  listAgents,
  listIncomingHandOffs,
  listModules,
  trialGrantedModuleIds,
  listItemsIncludingArchived,
  listPipelineSteps,
  listProjects,
  projectsWithWorkOnPipeline,
  listStepsElsewhere,
  listStepsForPipeline,
  pipelineHasWebhookEntry,
  unreachableRetiredSteps,
  pipelineVersionByNumber,
  versionSnapshot,
  getPerson,
  getGroup,
  projectWorkspaceList,
  replacePipelineGraph,
  saveActionDefinition,
  setAgentAttachment,
  setSetting,
  updateAgent,
  updateRun,
  workspaceLabel,
  type CreateStepInput,
  itemTypesFor,
} from "../db/repos/index.js";
import { sideEffectingServersByStep } from "../connectors/sideEffects.js";
import { readPolicy } from "../policy/policy.js";
import { activeProjectId } from "./repositoryCommands.js";
import { signedInPersonId } from "../identity/viewer.js";
import { moduleRulesUnrunnableHere } from "../modules/entryChecks.js";
import type { EngineHandle } from "./domainCommands.js";

/** Guardrails live here rather than in code so they can be tuned without a release (U-06, E-05). */
export const GUARDS_KEY = "engine.guards";

export const DEFAULT_GUARD_CONFIG: GuardConfigView = {
  // 1 by default, deliberately, until the loop is provably reliable (ARCHITECTURE.md, "Capacity and
  // concurrency").
  globalConcurrency: 1,
  perAgentConcurrency: 1,
  perRepositoryConcurrency: 1,
  perItemAttemptLimit: 3,
  // Two hours (thirty minutes until the inactivity guard below): the
  // wall clock was the only thing that caught a hung run, so it had to be
  // short, and it cut off implementers still working at minute thirty. A
  // hang is now caught by the silence it makes, and this is the ceiling
  // on a run that is busy but never finishing.
  wallClockTimeoutMs: 2 * 60 * 60 * 1000,
  // Ten minutes without a word from the backend while no tool runs —
  // Claude Desktop's Cowork waits the same before it calls a session
  // unresponsive.
  inactivityTimeoutMs: 10 * 60 * 1000,
  // Unset, deliberately, and unlike the daily one below (EO-211). What a
  // single large story legitimately costs is not a figure EO can guess,
  // so a default here would stop honest work on its way to being done —
  // and it would not buy the thing the budgets exist for, because a
  // runaway loop is bounded by the day either way.
  perItemBudgetCents: null,
  /**
   * The day's spend ceiling, across every item, in cents — the one
   * budget that ships switched on (EO-211).
   *
   * The original design asks for the cost guards to be built in "from the start, not
   * after an incident", because "autonomous loops burn money silently".
   * Both guards were built and both defaulted to nothing, which left the
   * guard for the case nobody was watching as the one somebody had to
   * know to turn on.
   *
   * 5,000¢ is picked to be invisible to a normal day and quick to reach
   * for a loop that has stopped making progress: a day of ordinary work
   * does not come near $50, and an item mentioning its way around a
   * circle gets there within the hour. It is a starting figure, not a
   * measurement — the Guardrails screen is where it is changed, and
   * clearing the field there removes the ceiling entirely.
   */
  dailyBudgetCents: 5_000,
  // On by default (EO-184). A reply somebody typed instead of clicking
  // is otherwise read by nothing at all, and the failure it produces —
  // the same question asked twice — looks exactly like EO ignoring them.
  interpretReplies: true,
  // The design's mention-depth cap (EO-212). Three hops without a person in the
  // thread, which is "ask, get an answer, ask a follow-up" and no more.
  agentMentionDepth: 3,
  // Five times round between a step that keeps checking and whoever it
  // sends the item to, with nobody saying anything (EO-456). A watch that
  // reports the same failure on every round is a loop with no person in
  // it, and five is past what an honest back-and-forth needs.
  watchRoundTripsPerItem: 5,
  // About a page of memory given whole, with nothing asked (EO-478);
  // past it a small model picks what bears on the task.
  memoryDeliveryChars: DEFAULT_MEMORY_DELIVERY_CHARS,
  // Each scope's caps (EO-480): reaching either queues a consolidation
  // that brings the scope back to about half.
  memoryScopeMaxEntries: DEFAULT_MEMORY_SCOPE_MAX_ENTRIES,
  memoryScopeMaxChars: DEFAULT_MEMORY_SCOPE_MAX_CHARS,
  // An agent's skill nobody loads (EO-720): stale after 20 runs given it
  // in a row without a load, archived after 50.
  skillStaleAfterRuns: DEFAULT_SKILL_STALE_AFTER_RUNS,
  skillArchiveAfterRuns: DEFAULT_SKILL_ARCHIVE_AFTER_RUNS,
  // On (EO-582): a test-fix loop waits on one trial run at a time, and
  // behind a queue of live work it would stall for hours. The order of
  // dispatch only — concurrency is untouched.
  trialsFirst: true,
  // A draft's test-fix loop (EO-586): eight rounds before the person is
  // asked whether to keep going, no budget of its own beyond the daily
  // one, and a stop when a fix did not change what was failing.
  trialRoundsPerDraft: 8,
  trialBudgetCentsPerDraft: null,
  trialStopOnRepeatedFailure: true,
  // EO's default for the machine (EO-738): three quarters of its memory,
  // shared across the global concurrency cap (`defaultRunMemoryMaxMb`).
  // Null rather than a figure, so it follows the cap and the machine
  // until a person picks one.
  runMemoryMaxMb: null,
};

/**
 * The guardrails in force: what was saved, over the defaults.
 *
 * Merged rather than returned raw: a config saved before a new guard
 * existed must not leave that guard undefined.
 *
 * **A saved `null` is not a missing key**, and the spread is what keeps
 * them apart (EO-211). Clearing "Daily budget" on the Guardrails screen
 * writes an explicit `dailyBudgetCents: null` — somebody chose to have
 * no ceiling — and a spread of that over the default keeps the null. A
 * config saved before the guard existed carries no such key at all, and
 * takes the default. The two look identical in `readGuards`' answer and
 * are entirely different decisions; `dailyBudgetDefaultApplies` below is
 * how the second one is told apart, so it can be said out loud once.
 */
export function readGuards(db: Db): GuardConfigView {
  return { ...DEFAULT_GUARD_CONFIG, ...getSetting<Partial<GuardConfigView>>(db, GUARDS_KEY, {}) };
}

/**
 * Is the daily ceiling in force EO's default rather than anybody's
 * choice (EO-211)?
 *
 * True when the saved config says nothing about `dailyBudgetCents` —
 * including when there is no saved config at all. Never opening the
 * Guardrails screen is not a decision about the daily budget; it is the
 * absence of one, which is exactly the installation the design built the guard
 * for. Both of those spend the day under a figure EO picked.
 *
 * False when the key is present, whatever its value: an explicit null is
 * a person clearing the field, and a number is a person setting one.
 *
 * It says nothing about whether that is *news*. An installation born
 * with the ceiling has always had it and has nothing to be told;
 * `guardDefaultNotice.ts` is what holds that second question, because
 * the answer cannot be read out of the guards row at all — it is a fact
 * about when the database was created.
 */
export function dailyBudgetDefaultApplies(db: Db): boolean {
  const saved = getSetting<unknown>(db, GUARDS_KEY, null);
  if (saved === null || typeof saved !== "object") return true;
  return !("dailyBudgetCents" in saved);
}

/**
 * Writes the guardrails, or refuses and says why (EO-162).
 *
 * The refusal is the run timeout being lowered under a module step that
 * already asks for longer. Storing it would leave a step configured for
 * twenty minutes under a rule saying no run may exceed five, and one of
 * those two numbers would then be a thing a person set and EO does not
 * do — which is exactly what this story exists to end. Refusing names the
 * steps, because "some step wants longer" is not something anybody can
 * act on.
 *
 * The other half is in `validationInput`, which refuses the same
 * contradiction arriving from the pipeline editor. Between them, stored
 * state can never hold a contradicting pair, so nothing at dispatch has
 * to decide which number wins.
 *
 * Every other field writes as it always did. A save that only turns the
 * daily budget off is not refused because an unrelated step is slow — the
 * check is on the number being changed, against the steps that depend on
 * it.
 *
 * Every step, including one on a pipeline nobody is using. A step that
 * exists is a step that can be dispatched again, and excluding one here
 * would let the contradiction come back the moment somebody restored its
 * pipeline — silently, which is the one outcome this is all for.
 */
export function writeGuards(db: Db, input: IpcPayload<"guards:set">): IpcResponse<"guards:set"> {
  const problems = listPipelineSteps(db)
    .map((step) =>
      step.timeoutMs === null
        ? null
        : timeLimitBoundProblem({ stepName: step.name, timeoutMs: step.timeoutMs, runTimeoutMs: input.wallClockTimeoutMs }),
    )
    .filter((problem): problem is string => problem !== null);
  // A skill is stale before it is archived (EO-720); the other way round,
  // it would be archived without ever having been shown as stale.
  if (input.skillArchiveAfterRuns < input.skillStaleAfterRuns) {
    problems.push(`A skill is archived after ${input.skillArchiveAfterRuns} runs without a load, which is before it would go stale at ${input.skillStaleAfterRuns}. Make the archive count at least the stale count.`);
  }

  if (problems.length > 0) return { saved: false, guards: readGuards(db), problems };

  setSetting(db, GUARDS_KEY, input);
  return { saved: true, guards: input, problems: [] };
}

export function listAgentDetails(db: Db): IpcResponse<"agents:listDetailed"> {
  // Counted from the steps, not stored: a role is referenced by whatever
  // steps happen to name it, across every pipeline, and any stored tally
  // would drift the moment someone rewired one.
  const pipelinesByRole = new Map<string, Set<string>>();
  for (const step of listPipelineSteps(db)) {
    if (!step.ownerRole) continue;
    const seen = pipelinesByRole.get(step.ownerRole) ?? new Set<string>();
    seen.add(step.pipelineId);
    pipelinesByRole.set(step.ownerRole, seen);
  }

  return {
    // A deleted agent is a tombstone kept for the names on its runs and
    // comments (EO-350), and appears nowhere on the Agents screen — not
    // even under "Show archived", where an archived one still does.
    agents: listAgents(db).filter((agent) => agent.deletedAt === null).map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      provider: agent.provider,
      model: agent.model,
      enabled: agent.enabled,
      // Archived rows are listed rather than dropped (EO-186): the
      // screen hides them behind "Show archived", and a person reading
      // what a retired agent was needs the row to arrive at all.
      archivedAt: agent.archivedAt,
      instructions: agent.instructions,
      // What this build ships for the role, so the editor can offer it
      // when someone's own text has diverged from it. Null for a role
      // EO has no prompt for, which is every role somebody invented.
      defaultInstructions: loadRolePrompt(agent.role) ?? null,
      // Whether EO ships this role, said outright (EO-178). The editor
      // draws no thread-reuse checkbox for one, because EO has already
      // decided it — and the editor must not be the thing that decides
      // which roles those are. Answered from the registry (KAN-124), which
      // is the same one `registry:get` hands the renderer.
      builtin: isBuiltinRole(registry, agent.role),
      config: agent.config,
      projectId: agent.projectId,
      pipelineCount: pipelinesByRole.get(agent.role)?.size ?? 0,
    })),
  };
}

/**
 * Creates or updates an agent.
 *
 * Instructions take effect on the *next* dispatch, not on runs already
 * in flight: buildDispatchContext reads them at dispatch time, and a run
 * mid-stream has already been given its prompt. That is the honest
 * behaviour — rewriting an agent's instructions underneath a running
 * conversation would produce something incoherent.
 */
/**
 * Which backend and model this machine runs an agent on (EO-329, ARCHITECTURE.md, "Publish, lock
 * and versions").
 *
 * The one write into an agent a locked agents section does not refuse,
 * and the reason it is safe is that it cannot express anything the
 * section publishes: no name, no role, no prompt, no `config` — so no
 * tool surface, which is invariant 11's subject. What it writes is a
 * fact about *this machine* — which CLI is installed here and signed in
 * here — and ARCHITECTURE.md, "Publish, lock and versions" is explicit that an organisation does
 * not own it:
 * "backend and model stay local, so a locked agents section never stops
 * a person who is signed in to one backend and not the other".
 *
 * Refused for an agent that is not here rather than creating one:
 * creating an agent is the agents section itself.
 */
export function setAgentBinding(db: Db, input: IpcPayload<"agents:setBinding">): IpcResponse<"agents:setBinding"> {
  const agent = getAgent(db, input.agentId as Uuid);
  if (agent === undefined) {
    return { bound: false, problem: "EO has no agent with that id on this machine." };
  }
  if (agent.archivedAt !== null) {
    return { bound: false, problem: "That agent is archived. It is dispatched to nothing, so there is no backend for it to run on." };
  }
  // …and only to a backend the organisation allows (EO-328, ARCHITECTURE.md, "Policy").
  //
  // The same check `saveAgent` makes, and it has to be made twice
  // because this is a second door onto the same column. A channel that
  // writes `agents.provider` without asking is a way round the policy
  // however carefully the other one asks — which is the whole of what
  // "a policy is only a policy where it cannot be gone around" means.
  // Local and *unconstrained* are different claims: the design says the
  // backend is the person's to choose, and the design says an organisation
  // may narrow what it is chosen from.
  const policy = readPolicy(db);
  if (agent.provider !== input.provider && !backendAllowed(policy, input.provider)) {
    return { bound: false, problem: bindingRefusal({ provider: input.provider, policy }) };
  }
  updateAgent(db, agent.id, { provider: input.provider, model: input.model });
  return { bound: true, problem: null };
}

export function saveAgent(db: Db, input: IpcPayload<"agents:save">): IpcResponse<"agents:save"> {
  // What the organisation allows this machine to bind an agent to
  // (EO-328, `ARCHITECTURE.md`, "Policy").
  //
  // **Here rather than only in the picker**, which is the design's rule applied to this section:
  // the system agent's admin
  // MCP server reaches this handler through the same dispatch the
  // renderer does, so a greyed dropdown is a lock only one of the two
  // callers knows about. The Agents screen still greys the options — a
  // disabled control beside the reason beats one that fails — and this
  // is what makes it a rule. The dispatch guard stays too: it is what
  // catches a row written before the policy was published.
  //
  // A row that is *already* on a disallowed backend can still be saved,
  // so long as this save is not what puts it there. Refusing every edit
  // to such a row would make it unfixable from the one screen that
  // exists to fix it — a person could not rename it, could not disable
  // it, and could not re-point it, because re-pointing is a save.
  const policy = readPolicy(db);
  const existing = input.id === undefined ? undefined : getAgent(db, input.id as Uuid);
  // A tombstone is not an agent to edit (EO-350): writing instructions
  // back into it would be restoring a deleted agent by the side door.
  if (existing !== undefined && existing.deletedAt !== null) return { saved: false, agent: null, problem: "That agent has been deleted." };
  const wasOn = existing?.provider ?? null;
  if (input.provider !== wasOn && !backendAllowed(policy, input.provider)) {
    return { saved: false, agent: null, problem: bindingRefusal({ provider: input.provider, policy }) };
  }

  // Which project it works for (EO-474). Absent keeps what is stored, so
  // an edit that never mentions the scope cannot widen a project's own
  // agent into everybody's; on a create it is global.
  const projectId = input.projectId === undefined ? (existing?.projectId ?? null) : input.projectId;
  // The role the row will have: fixed once it exists, so the stored one
  // and not the request's — the request's is not what gets written.
  const role = existing?.role ?? input.role;
  // The system agent is always global (ARCHITECTURE.md, "An agent is a
  // row"). It is one agent with the same instructions for everyone, and
  // the only holder of the `eo_admin` grant (invariant 11), so a scoped
  // one would be a second assistant answering one project differently
  // and reconfiguring the installation from inside it. Here, in the
  // command, for the backend policy's reason above: `agent_save` over
  // MCP reaches this same handler, and a refusal only the editor knew
  // about would be one the assistant could go round.
  if (role === "system" && projectId !== null) {
    return {
      saved: false,
      agent: null,
      problem:
        "A system agent cannot belong to a project: the assistant is one agent with the same instructions for everyone, " +
        "so it is always global. Leave the project out, or give the project an agent in another role.",
    };
  }
  if (projectId !== null && getProject(db, projectId as Uuid) === undefined) {
    return { saved: false, agent: null, problem: "EO has no project with that id, so there is nothing to scope this agent to." };
  }

  // Who wrote this text, recorded at the moment it is written (0033).
  //
  // Null unless it is verbatim the prompt this build ships: from here on
  // the instructions are the human's, and `syncRolePrompts` must never
  // overwrite them with a later default. Saving the default unchanged is
  // the one case where it is still EO's text — leaving that as "edited"
  // would strand someone on this version for pressing Save.
  const shipped = loadRolePrompt(input.role);
  const provenance = shipped !== undefined && input.instructions.trim() === shipped ? promptHash(shipped) : null;

  const saved = input.id
    ? updateAgent(db, input.id as Uuid, {
        name: input.name,
        provider: input.provider,
        model: input.model,
        instructions: input.instructions,
        promptHash: provenance,
        enabled: input.enabled,
        // Only when it was sent (EO-185). `config` is the one field on
        // this channel a caller can hold none of and still have a reason
        // to save — and while it defaulted to `{}`, omitting it wrote an
        // empty object over whatever was there. `UpdateAgentInput` is
        // already a patch, so leaving the key out is the honest way to
        // say "not mine to change"; a key present and undefined would
        // reach drizzle's `set()` and is not the same thing.
        ...(input.config === undefined ? {} : { config: input.config }),
        projectId: projectId as Uuid | null,
      })
    : createAgent(db, {
        name: input.name,
        role: input.role,
        provider: input.provider,
        model: input.model,
        instructions: input.instructions,
        promptHash: provenance,
        enabled: input.enabled,
        // Nothing to preserve on a row that does not exist yet, so the
        // absent case is the empty bag it always was — with the
        // `memory_note` grant every new agent is given, whatever its role
        // (EO-593; the three shipped roles only, from EO-514 until then).
        config: withMemoryNoteGrant(input.config ?? {}),
        projectId: projectId as Uuid | null,
      });

  // Recomputed rather than carried in: saving an agent can change its
  // role, which changes how many pipelines it answers for.
  const pipelineCount = new Set(listPipelineSteps(db).filter((step) => step.ownerRole === saved.role).map((step) => step.pipelineId)).size;

  return {
    saved: true,
    problem: null,
    agent: {
      pipelineCount,
      id: saved.id,
      name: saved.name,
      role: saved.role,
      provider: saved.provider,
      model: saved.model,
      enabled: saved.enabled,
      // Never written by a save (EO-186): retiring an agent is
      // `agents:archive`'s job, so an edit cannot archive one in passing
      // and — since nothing un-archives — cannot bring one back either.
      archivedAt: saved.archivedAt,
      instructions: saved.instructions,
      defaultInstructions: loadRolePrompt(saved.role) ?? null,
      // From the saved row's role, not the request's: creating an agent
      // on a role EO ships makes it one, and the editor is handed the
      // answer rather than left to work it out.
      builtin: isBuiltinRole(registry, saved.role),
      config: saved.config,
      projectId: saved.projectId,
    },
  };
}

/** Thrown inside `customiseAgent`'s transaction to roll the copy back, carrying the sentence to answer with. */
class CopyRefused extends Error {}

/**
 * A project's own copy of a global agent (EO-475, `agents:customise`).
 *
 * Through `saveAgent`, so the copy meets every refusal a create does —
 * the organisation's backends, the system agent's scope, a project that
 * does not exist — and gets its prompt provenance the same way: a copy
 * of an unedited shipped prompt is still EO's text and keeps following
 * the default. Then its attachments, in the same transaction, so a copy
 * that exists has all of its tools or there is no copy.
 *
 * Named for the project it belongs to rather than after the original
 * verbatim: a mention addresses an agent by name, and two agents both
 * called "Implementer" would be one name for two agents.
 */
export function customiseAgent(db: Db, input: IpcPayload<"agents:customise">): IpcResponse<"agents:customise"> {
  const source = getAgent(db, input.agentId as Uuid);
  if (source === undefined || source.deletedAt !== null) {
    return { saved: false, agent: null, problem: "EO has no agent with that id, so there is nothing to copy." };
  }
  if (source.archivedAt !== null) {
    return { saved: false, agent: null, problem: `${source.name} is archived. Copy an agent that is still in use, or create a new one for the project.` };
  }
  if (source.projectId !== null) {
    return {
      saved: false,
      agent: null,
      problem: `${source.name} already belongs to a project. A project's own agent is changed by editing it; only a global agent is copied for a project.`,
    };
  }
  const project = getProject(db, input.projectId as Uuid);
  if (project === undefined) return { saved: false, agent: null, problem: "EO has no project with that id, so there is nothing to make this copy for." };

  try {
    return db.transaction(() => {
      const saved = saveAgent(db, {
        name: `${source.name} (${project.name})`,
        role: source.role,
        provider: source.provider,
        model: source.model,
        instructions: source.instructions,
        enabled: source.enabled,
        config: { ...source.config },
        projectId: project.id,
      });
      if (!saved.saved || saved.agent === null) return saved;
      const copyId = saved.agent.id;
      const attached = getAgentAttachments(db, source.id);
      const ticks = [
        ...attached.mcpServerIds.map((id) => ({ kind: "mcpServer" as const, id })),
        ...attached.skillIds.map((id) => ({ kind: "skill" as const, id })),
      ];
      for (const tick of ticks) {
        const result = setAgentAttachment(db, { agentId: copyId, kind: tick.kind, id: tick.id, attached: true });
        if (!result.ok) throw new CopyRefused(`${result.problem} Nothing was copied.`);
      }
      return saved;
    });
  } catch (error) {
    if (error instanceof CopyRefused) return { saved: false, agent: null, problem: error.message };
    throw error;
  }
}

/**
 * Who a project's work goes to, role by role (EO-475, `projects:staffing`).
 *
 * The roles are the ones the agent steps of the project's live pipelines
 * name — `listPipelines`'s idea of the project's, so a pipeline nothing
 * has adopted yet counts, as it does everywhere else — in the order the
 * pipelines and their steps come. Each is answered by `staffingAgents`
 * asked of a real item on the project: the scheduler's rule, so this
 * cannot name an agent the scheduler would pass over.
 */
export function projectStaffing(db: Db, input: IpcPayload<"projects:staffing">): IpcResponse<"projects:staffing"> {
  const projectId = input.projectId as Uuid;
  const pipelineIds = listPipelines(db, projectId).map((pipeline) => pipeline.id);
  const steps = listPipelineSteps(db);
  const roles: string[] = [];
  for (const pipelineId of pipelineIds) {
    for (const step of steps) {
      if (step.pipelineId !== pipelineId || step.type !== "agent" || step.ownerRole === null) continue;
      if (!roles.includes(step.ownerRole)) roles.push(step.ownerRole);
    }
  }
  // Tombstones left out, as every other reader of the list does: a
  // deleted agent is archived as well, so it would never staff anything,
  // but it has no business being looked at either.
  const agents = listAgents(db).filter((agent) => agent.deletedAt === null);
  const item = { previewAt: null, projectId };
  return {
    roles: roles.map((role) => {
      const candidates = staffingAgents(agents, role, item);
      const from = candidates.length === 0 ? "nobody" : candidates.some((agent) => agent.projectId !== null) ? "project" : "global";
      return { role, from, agents: candidates.map((agent) => ({ id: agent.id, name: agent.name })) };
    }),
  };
}

/** Enough of the engine to stop a run, so a test can hand in a spy. */
export type RunCanceller = Pick<EngineHandle, "cancelRun">;

/**
 * What archiving or deleting this agent would take away (EO-350).
 *
 * The one answer both `agents:archive` and `agents:delete` give before
 * they act, so the two confirmations cannot come to say different
 * things about the same agent.
 *
 * **Steps.** Every `type === "agent"` step, in every live pipeline, whose
 * owner is this agent's role — a builtin, a module or a `user` step names
 * no role and has nobody to lose. Off-board steps are included, as they
 * were in the refusal this replaced: the two conversation steps carry
 * `owner_role` NULL and so are already out, while an off-board step
 * somebody wired to a role is a step items can still reach.
 *
 * **Who staffs them.** Enabled, non-archived, non-preview agents only,
 * on *both* sides of the question. A disabled or archived agent staffs
 * nothing (`isDispatchable`), and a preview's own agent runs rehearsals
 * only (EO-316) — so it can neither be what still covers a role nor be
 * what leaves it empty. The second half is the bug this fixed: the
 * gallery's "writer (preview)" was refused archiving as "the only
 * enabled agent" on a role it never staffed.
 *
 * **The system agent.** The Assistant is answered by whichever
 * dispatchable `system` agent `productOwner` finds; the last one going
 * leaves it with nobody.
 */
export function agentRemovalImpact(db: Db, agent: Agent): AgentRemovalImpact {
  const staffs = (candidate: Agent) => isDispatchable(candidate) && !isPreviewAgent(candidate);
  const others = listAgents(db).filter((other) => other.id !== agent.id && other.role === agent.role);
  const coveredBy = others.filter(staffs).map((other) => other.name);

  // Archived pipelines included: "every pipeline" is what the person is
  // told, and a step in an archived one still names this role.
  const pipelineNames = new Map(listPipelines(db, undefined, true).map((pipeline) => [pipeline.id as string, pipeline.name]));
  const steps = listPipelineSteps(db)
    .filter((step) => step.type === "agent" && step.ownerRole === agent.role && pipelineNames.has(step.pipelineId))
    .map((step) => ({ stepId: step.id, stepName: step.name, pipelineId: step.pipelineId, pipelineName: pipelineNames.get(step.pipelineId)! }));

  const activeRuns = listActiveRuns(db)
    .filter((run) => run.agentId === agent.id)
    .map((run) => {
      const item = getItem(db, run.itemId as Uuid);
      return { runId: run.id, itemId: run.itemId, itemKey: item?.key ?? "", itemTitle: item?.title ?? "" };
    });

  const lastSystemAgent =
    agent.role === "system" && isDispatchable(agent) && !others.some((other) => isDispatchable(other));

  return {
    agentName: agent.name,
    role: agent.role,
    steps,
    leavesStepsWithNobody: staffs(agent) && coveredBy.length === 0 && steps.length > 0,
    coveredBy,
    activeRuns,
    lastSystemAgent,
  };
}

/**
 * Stops every run the impact named, as `superseded`: the agent is going,
 * and there is no step to stand off from (EO-175).
 *
 * The engine first, because a run it is driving has a backend to stop
 * and it writes the row `cancelled` itself before aborting. What the
 * engine leaves untouched is a row nothing in this process drives —
 * `cancelRun` returns without a word when there is no controller for
 * it. The supervisor claims a controller in the same synchronous block
 * that writes a run's row, so a `queued` or `running` row without one is
 * left over from a process that is gone (or there is no engine at all).
 * The confirmation promised to cancel it, so it is written `cancelled`
 * here rather than left to look active.
 */
function cancelRunsOf(db: Db, impact: AgentRemovalImpact, engine: RunCanceller | undefined): void {
  for (const entry of impact.activeRuns) {
    engine?.cancelRun(entry.runId, "superseded");
    const run = getRun(db, entry.runId as Uuid);
    if (run !== undefined && (run.status === "queued" || run.status === "running")) {
      updateRun(db, run.id, { status: "cancelled", error: "cancelled because its agent was removed", endedAt: Date.now() });
    }
  }
}

/**
 * Retires an agent (EO-186), once the caller has seen what it takes
 * away (EO-350).
 *
 * `{ archived, problem, impact }` and never a throw, which is the
 * contract `mcpServers:archive` and `skills:archive` already answer on.
 *
 * Unconfirmed, it archives nothing and answers with `impact`. That used
 * to be an outright refusal for the last enabled holder of a role some
 * step is owned by — the state `validatePipeline` reports as "items will
 * wait there indefinitely". It is still said, in the confirmation, but a
 * person who has read it may go ahead: whether a step should wait for a
 * new agent is theirs to decide. Confirming cancels the agent's runs in
 * progress, since nothing would dispatch it to finish them.
 */
export function archiveAgentCommand(
  db: Db,
  input: IpcPayload<"agents:archive">,
  engine?: RunCanceller,
): IpcResponse<"agents:archive"> {
  const agent = getAgent(db, input.id as Uuid);
  if (agent === undefined || agent.deletedAt !== null) return { archived: false, problem: "That agent no longer exists.", impact: null };
  if (agent.archivedAt !== null) return { archived: true, problem: null, impact: null };

  const impact = agentRemovalImpact(db, agent);
  if (!input.confirm) return { archived: false, problem: null, impact };

  cancelRunsOf(db, impact, engine);
  // Only reachable if the row vanished between the read above and here,
  // which nothing in EO does — answered rather than asserted, because a
  // throw from an IPC boundary is not the shape this contract has.
  if (!archiveAgent(db, agent.id)) return { archived: false, problem: "That agent no longer exists.", impact: null };
  return { archived: true, problem: null, impact };
}

/**
 * Deletes an agent (EO-350), archived ones included.
 *
 * The same confirmation as archiving: unconfirmed, it deletes nothing
 * and answers with `impact`. Confirmed, it cancels the agent's runs in
 * progress and leaves a tombstone — see `deleteAgent` for why the row
 * stays, and for what it keeps.
 */
export function deleteAgentCommand(
  db: Db,
  input: IpcPayload<"agents:delete">,
  engine?: RunCanceller,
): IpcResponse<"agents:delete"> {
  const agent = getAgent(db, input.id as Uuid);
  if (agent === undefined || agent.deletedAt !== null) return { deleted: false, problem: "That agent no longer exists.", impact: null };

  const impact = agentRemovalImpact(db, agent);
  if (!input.confirm) return { deleted: false, problem: null, impact };

  cancelRunsOf(db, impact, engine);
  if (!deleteAgent(db, agent.id)) return { deleted: false, problem: "That agent no longer exists.", impact: null };
  return { deleted: true, problem: null, impact };
}

/**
 * The keep-checking settings a step of this save ends up with (EO-506).
 *
 * What the caller sent, where it sent anything — `null` included, which
 * is how a step is turned back into one that runs once. Where it left the
 * field out, the step's own row: a caller that never mentioned keep
 * checking has not asked for it to change, and reading that silence as
 * "off" is what turned a shipped pull request watch into a step that
 * parks every item on it. Resolved here rather than left absent for the
 * repository to keep, because the validator judges the graph with it —
 * a watch step judged as running once is refused for a reason that is
 * not true.
 *
 * Read from the step's row by id, retired or not, so a step a save
 * brings back keeps what its row says, as the repository would. A step
 * this save creates, or an id from some other pipeline, has nothing to
 * keep, and runs once.
 */
function watchFor(db: Db, pipelineId: string, step: IpcPayload<"pipeline:save">["steps"][number]): StepWatch | null {
  if (step.watch !== undefined) return step.watch === null ? null : settledWatch(step.watch);
  const stored = getStep(db, step.id);
  return stored !== undefined && stored.pipelineId === pipelineId ? stored.watch : null;
}

/**
 * The live steps this save stops keeping checking (EO-506), for the
 * answer to say so: each kept checking before the save and runs once
 * after it. A step the save removes is not one of them — it is not a
 * step that runs once now, it is not a step at all, and the save
 * already refuses to remove one anything stands on.
 */
function watchTurnedOff(before: readonly PipelineStep[], after: readonly PipelineStep[]): { stepId: string; name: string }[] {
  const was = new Map(before.map((step) => [step.id as string, step.watch]));
  return after.filter((step) => step.watch === null && was.get(step.id) != null).map((step) => ({ stepId: step.id, name: step.name }));
}

function toDomainSteps(db: Db, pipelineId: string, steps: IpcPayload<"pipeline:save">["steps"]): PipelineStep[] {
  return steps.map((step) => ({
    id: step.id,
    pipelineId: pipelineId as Uuid,
    position: step.position,
    name: step.name,
    type: step.type,
    ownerRole: step.ownerRole,
    entryAction: step.entryAction,
    instructionsSummary: step.instructionsSummary,
    isTerminal: step.isTerminal,
    planMode: step.planMode,
    workspaceMode: step.workspaceMode,
    workspaceId: step.workspaceId,
    inputs: step.inputs,
    timeoutMs: step.timeoutMs,
    // Absent keeps the row's (EO-506) — see `watchFor`.
    watch: watchFor(db, pipelineId, step),
    // Never on the wire, by design: an off-dashboard step is not a column,
    // so the configuration screen has nothing to show for it and nothing
    // to submit. `savePipeline` skips those rows rather than reading this.
    offBoard: false,
    // Nor is who a human step waits on (EO-302, EO-323). The picker for
    // that is on the board's column head and writes through
    // `steps:setOwner`, because who is expected to act at a step is not
    // the shape of the graph this screen publishes.
    //
    // Null *for the validator*, which is all this function's result is
    // allowed to be used for where the field is concerned. A publish
    // must say nothing about an owner rather than say null — see
    // `forWriting` below, which is what makes that true.
    ownerPersonId: null,
    // And the group beside it (EO-323), for the same reason and with
    // the same protection below: the wire carries neither.
    ownerGroupId: null,
    // What a person may decide here, **exactly as it was submitted**
    // (EO-310).
    //
    // This used to be `resultsFromRoutes(step, routes)`, and that was
    // wrong in the way a repair is always wrong at a boundary whose job
    // is to judge: deriving the declaration from the routes made both
    // of `validatePipeline`'s new refusals unreachable from here. An
    // unrouted declared result was dropped before the validator could
    // see it, and a route out of a user step naming a key nobody
    // declared had a result invented for it — so a graph offering a
    // button that goes nowhere, and a graph whose branch no gesture can
    // take, both arrived looking perfectly consistent and were saved.
    //
    // The normalising belongs where the *data is constructed* — the
    // editor's publish, the architect's draft, an imported document —
    // and each of those does it with the same `resultsFromRoutes`. What
    // arrives here is somebody's claim about their own pipeline, and
    // this function's whole contract is to hand that claim to the
    // validator unaltered (invariant #5: verify, don't trust).
    results: step.results,
  }));
}

/**
 * The same steps, as something safe to *write* (EO-302).
 *
 * `toDomainSteps` answers to `PipelineStep`, which means it has to
 * produce every field on that type whether or not the editor sent one.
 * For most fields that costs nothing, because the editor does send
 * them and "publish what I sent" is the right reading. For a field the
 * wire does not carry it is a trap: `CreateStepInput` draws a
 * three-way distinction — absent leaves the row alone, `null` clears
 * it, a value sets it — and a filled-in placeholder arrives at
 * `replacePipelineGraph` as the middle one.
 *
 * That is not hypothetical. `ownerPersonId: null` above, passed
 * straight through, meant every ordinary publish — somebody renaming a
 * step, tightening a timeout, applying an architect draft — silently
 * unnamed whoever a human step was waiting on, with nothing in the
 * record to say when it happened or that it had.
 *
 * So the write path drops it, and the rule generalises: a field that
 * is on `PipelineStep` and not on `pipeline:save`'s payload belongs
 * here, not in the object handed to the repository. The validator
 * keeps the full row, because it is only ever read.
 */
function forWriting(steps: PipelineStep[]): CreateStepInput[] {
  // Destructured out by name rather than deleted, so adding a second
  // such field is a compile-time conversation rather than a silent
  // omission.
  return steps.map(({ ownerPersonId: _ownerPersonId, ownerGroupId: _ownerGroupId, ...step }) => step);
}

/** Who a human step waits on: a person, a group, or neither. Never both. */
interface StepOwner {
  personId: Uuid | null;
  groupId: string | null;
}

/**
 * Who each human step of a restored version waited on, keyed by step id
 * (EO-359) — or undefined when that version is not one this pipeline
 * still keeps.
 *
 * Read out of the version's own document rather than taken from the
 * caller, which is the whole point: `pipeline:save` carries no owner,
 * and a restore names a *version*, so the only owners a restore can
 * publish are ones this pipeline already had.
 *
 * Only for a step that is a human step both in that version and in the
 * graph being published. A step the draft has since turned into an
 * agent step has nobody waiting at it, and one the version did not
 * have, or did not have as a human step, has nothing to restore — both
 * leave the row's owner where it is, as any publish does.
 *
 * A person or group this installation no longer has comes back as
 * nobody in particular, which is the answer `deleteGroup` gives every
 * step that waited on a group it removes: a step must not wait on a row
 * that is not there.
 */
function restoredOwners(db: Db, pipelineId: string, number: number, steps: readonly PipelineStep[]): Map<string, StepOwner> | undefined {
  const version = pipelineVersionByNumber(db, pipelineId, number);
  const snapshot = version === undefined ? undefined : versionSnapshot(db, version.id);
  if (snapshot === undefined) return undefined;

  const human = new Set(steps.filter((step) => step.type === "user").map((step) => step.id));
  const owners = new Map<string, StepOwner>();
  for (const step of snapshot.steps) {
    if (step.type !== "user" || !human.has(step.id)) continue;
    const personId = step.ownerPersonId !== null && getPerson(db, step.ownerPersonId as Uuid) !== undefined ? (step.ownerPersonId as Uuid) : null;
    // A person wins where a document somehow names both, as
    // `steps:setOwner` would never have let it.
    const groupId = personId === null && step.ownerGroupId !== null && getGroup(db, step.ownerGroupId) !== undefined ? step.ownerGroupId : null;
    owners.set(step.id, { personId, groupId });
  }
  return owners;
}

function toDomainRoutes(pipelineId: string, routes: IpcPayload<"pipeline:save">["routes"]): StepRoute[] {
  return routes.map((route) => ({
    id: route.id as Uuid,
    pipelineId: pipelineId as Uuid,
    fromStepId: route.fromStepId,
    resultKey: route.resultKey,
    label: route.label,
    tone: route.tone,
    target: route.target,
    position: route.position,
  }));
}

/**
 * The registry a graph is judged against, with the definitions it is
 * published with laid over the installation's (EO-426) — or the
 * sentences saying which of them the save would refuse.
 *
 * The project's registry for the reason `validationInput` gives. With
 * nothing proposed this is exactly that registry, so a publish that
 * carries no definitions is judged as it always was.
 */
function registryWith(db: Db, actions: readonly ActionDefinitionDraft[]): { registry: Registry; refused: WorkflowProblem[] } {
  const installed = registryForProject(db, activeProjectId(db));
  if (actions.length === 0) return { registry: installed, refused: [] };
  const proposed = withProposedActions(installed, actions);
  if (proposed.ok) return { registry: proposed.registry, refused: [] };
  return {
    registry: installed,
    refused: proposed.problems.map((message) => ({ severity: "error" as const, stateId: null, message: `The action definition cannot be saved — ${message}` })),
  };
}

/**
 * The roles somebody would be dispatched for on this pipeline's work —
 * what `validatePipeline` is handed as `staffedRoles`.
 *
 * `rolesStaffedFor`, which is `staffingAgents` — the scheduler's own
 * rule — asked of a real item on the pipeline's project (EO-474). So:
 * not an archived or disabled agent (EO-186), or a step owned only by
 * retired agents would validate clean and then never dispatch — the
 * silent park "which has no enabled agent" exists to make loud; not the
 * preview's own (EO-316), or a step nobody real staffs would validate
 * clean because a rehearsal could walk it; and not another project's
 * agent, which the scheduler will never send this pipeline's work to.
 *
 * A pipeline no project has adopted yet belongs to whichever project is
 * asking (`listPipelines`), and the scheduler staffs each item on it by
 * that item's own project (EO-514). So it is asked of the projects whose
 * work stands on it, and a role is staffed where any of them would
 * dispatch somebody: the seeded Delivery pipeline, carrying SHOP's work,
 * is staffed by SHOP's own implementer. With no work on it yet, it is
 * asked of every live project and of none, since any of them could bring
 * some. Asking it of no project at all — global agents only — warned
 * that a role SHOP's agent fills was unstaffed.
 *
 * Exported because the architect's draft is judged by it too, and a
 * draft and a publish must not disagree about who staffs a step.
 */
export function staffedRolesForPipeline(db: Db, pipelineId: string): string[] {
  const agents = listAgents(db);
  return [...new Set(projectsServedByPipeline(db, pipelineId).flatMap((projectId) => rolesStaffedFor(agents, { previewAt: null, projectId })))];
}

/**
 * The projects whose work a pipeline serves — the context its graph is
 * judged in when nobody is editing it.
 *
 * Its own project where one adopted it. Otherwise, for
 * `staffedRolesForPipeline`'s reason, the projects whose work stands on
 * it; and with no work on it yet, every live project and none, since
 * any of them could bring some.
 *
 * Exported for a writer no person is driving (EO-532): a template
 * update validates the graph it would publish, at startup, and the
 * project somebody last had on screen says nothing about where that
 * pipeline's work comes from.
 */
export function projectsServedByPipeline(db: Db, pipelineId: string): (Uuid | null)[] {
  const adoptedBy = getPipeline(db, pipelineId)?.projectId ?? null;
  if (adoptedBy !== null) return [adoptedBy as Uuid];
  const working = projectsWithWorkOnPipeline(db, pipelineId);
  return working.length > 0 ? working : [null, ...listProjects(db).filter((project) => project.archivedAt === null).map((project) => project.id)];
}

/**
 * The project a graph is judged in.
 *
 * `editing` is a person's publish: the project they have on screen,
 * which is the one a project-less pipeline is being edited in (EO-72).
 * `serving` is a writer nobody is driving (EO-532): every project whose
 * work the pipeline serves, so that a hand-off into any of their
 * pipelines resolves whichever project happens to be selected.
 */
export type JudgedFor = { editing: true } | { serving: readonly (Uuid | null)[] };

function judgedProjects(db: Db, judgedFor: JudgedFor): (Uuid | null)[] {
  return "editing" in judgedFor ? [activeProjectId(db)] : [...judgedFor.serving];
}

function validationInput(
  db: Db,
  pipelineId: string,
  steps: PipelineStep[],
  routes: StepRoute[],
  entryStepId: string | null,
  registryInForce?: Registry,
  judgedFor: JudgedFor = { editing: true },
  entryRules?: readonly EntryRule[],
) {
  const projects = judgedProjects(db, judgedFor);
  const itemCountByStep: Record<string, number> = {};
  // Counted apart as well as in the total (EO-230): the refusal sends a
  // person to the board for what it can show and to the Archive for
  // what it cannot, and it has to know which is which.
  const archivedCountByStep: Record<string, number> = {};
  // Including archived (KAN-33): the FK from items.stepId is real whether
  // or not the dashboard shows the item, so a step with only archived
  // work on it still cannot be deleted.
  for (const item of listItemsIncludingArchived(db)) {
    // A feature sits on no step, so it holds none of them back.
    if (item.stepId === null) continue;
    itemCountByStep[item.stepId] = (itemCountByStep[item.stepId] ?? 0) + 1;
    if (item.archivedAt !== null) archivedCountByStep[item.stepId] = (archivedCountByStep[item.stepId] ?? 0) + 1;
  }

  return {
    steps,
    routes,
    entryStepId,
    archivedCountByStep,
    // What a builtin step may run and return (KAN-124). Passed in as the
    // module catalog is: the validator is pure and cannot know what is
    // installed.
    //
    // The project's, not the folded packs' alone (EO-423): an agent
    // step is held to the results its action declares, and an action a
    // role defined for itself is a row rather than something a pack
    // contributes. The same call `registry:get` answers with, so the
    // renderer's validator is told what this one is.
    //
    // Handed in where the caller has laid proposed definitions over it
    // (EO-426), so the graph is judged with the definitions it is being
    // published with.
    registry: registryInForce ?? registryForProject(db, projects.find((projectId) => projectId !== null) ?? projects[0] ?? null),
    staffedRoles: staffedRolesForPipeline(db, pipelineId),
    // Archived ones included: a step naming a deleted module is a distinct
    // problem from one naming a module that was never here, and the
    // validator can only tell them apart if it is given both (KAN-104).
    modules: listModules(db, true),
    // What this pipeline may run unapproved because it is a trial and the
    // person granted it (EO-583). Nothing on any other pipeline.
    trialGrantedModuleIds: trialGrantedModuleIds(db, pipelineId),
    itemCountByStep,
    // Off-dashboard steps are omitted, not merely undeleted. The editor
    // never shows them, so they are absent from every submission, and
    // "absent" is how this detects a removal — one discussion
    // would otherwise make every save fail with `"discussion" still holds 1
    // item(s)`, with no way to move them because the tab is the only
    // thing that creates them.
    existingSteps: listStepsForPipeline(db, pipelineId)
      .filter((step) => !step.offBoard)
      // The name travels with the id so the refusal can say which step
      // it is about (EO-167) — the person removed one by name.
      .map((step) => ({ id: step.id, name: step.name })),
    // Where a route may hand work to (EO-58, EO-69). Read here rather than
    // taken from the caller, deliberately: a save does not get to declare
    // what its own routes are allowed to resolve to, and the validator
    // consults these only after this pipeline's own steps. Without it the
    // field defaulted to empty and every cross-pipeline route was rejected
    // as "routes to a step that is in no pipeline" — at `pipeline:validate`
    // and again at `pipeline:save`, both of which come through here.
    //
    // The active project is which project a project-less pipeline is being
    // edited in, and so which project's pipelines it may hand work to
    // (EO-72). Read here for the same reason: the caller does not get to
    // name it either.
    //
    // A writer nobody is driving is given every project the pipeline
    // serves, and their hand-off targets together (EO-532).
    stepsElsewhere: uniqueById(projects.flatMap((projectId) => listStepsElsewhere(db, pipelineId, projectId))),
    // And who hands work *to* this pipeline (EO-58, EO-167). Read here for
    // the reason `stepsElsewhere` is, and it is the half that makes the
    // editor's refusal a rule rather than a courtesy: a route into a step
    // can be drawn after a draft was loaded, and `pipeline:save` can be
    // called by something that never opened the screen at all. Removing
    // its target would leave that route pointing at nothing, in a
    // pipeline this save is not touching and no foreign key protects.
    incomingHandOffs: listIncomingHandOffs(db, pipelineId),
    // Whether a stranger's event can land on this pipeline, and what a
    // step could do with it before anybody looked (EO-334, ARCHITECTURE.md, "Results and routes").
    // Read
    // here rather than taken from the caller, for `stepsElsewhere`'
    // reason: a save does not get to say whether it is exposed.
    entryReachedByWebhook: pipelineHasWebhookEntry(db, pipelineId),
    sideEffectingServersByStep: sideEffectingServersByStep(db, steps),
    // And whether somebody has accepted that for this pipeline (EO-405),
    // which turns the refusal into a warning. Read from the pipeline's
    // own row for the same reason again, and it matters more here than
    // anywhere: a save that could say "and I waive this" would be the
    // refusal asking permission of whatever it is refusing. Neither
    // `pipeline:validate` nor `pipeline:save` has a field for it.
    webhookUnattended: getPipeline(db, pipelineId)?.webhookUnattended ?? false,
    // The ceiling a module step's own time limit is bounded by (EO-162).
    //
    // Read here rather than taken from the caller, for the reason
    // `stepsElsewhere` is: a save does not get to declare the limit it is
    // being judged against. The other side of the same bound lives in
    // `writeGuards`, so the pair can never be stored contradicting each
    // other whichever of the two somebody edits.
    runTimeoutMs: readGuards(db).wallClockTimeoutMs,
    // The rules this save sets, and the types of the projects it would
    // file for (EO-610): the pipeline's own project where one adopted it,
    // as `foreignWorkspaceProblems` reads it. Absent judges nothing.
    ...(entryRules === undefined ? {} : { entryRules, itemTypes: itemTypesJudged(db, pipelineId, judgedFor) }),
  };
}

/** Every item type a pipeline's rules may name: its own project's, or those of every project it is judged for. */
export function itemTypesJudged(db: Db, pipelineId: string, judgedFor: JudgedFor = { editing: true }): ReadonlyMap<string, ItemTypeEntry> {
  const adoptedBy = getPipeline(db, pipelineId)?.projectId ?? null;
  const projects = adoptedBy !== null ? [adoptedBy as Uuid] : judgedProjects(db, judgedFor);
  return new Map(projects.flatMap((projectId) => [...itemTypesFor(db, projectId)]));
}

/**
 * Steps pointed at a disk this pipeline's project does not hold
 * (EO-301, ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * **Why this is not in `validatePipeline`.** Everything that function
 * checks is a property of the graph, and this is a property of the
 * *installation*: which project holds which workspace is a pair of
 * database reads. `packages/engine` is pure (invariant #2) and could
 * only be told the answer as data — but it could not even be told, in
 * this case, because invariant 13's neutrality scan bans the word
 * `workspaceId` from the engine's sources outright, and it bans it for
 * precisely this reason: the engine is not allowed to hold an opinion
 * about what a disk is. So the refusal lives one layer out, where the
 * project is a row, and is appended to the validator's problems in the
 * same shape the editor already draws.
 *
 * Asked on both `pipeline:validate` and `pipeline:save`, which is what
 * makes it a rule rather than a courtesy: the editor greys out Publish
 * on the first, and a client calling the save directly — or a draft
 * loaded before somebody moved the workspace off the project — meets it
 * on the second.
 *
 * The two answers that name no workspace are silent here. `null` is
 * "the ticket's own", which is not a pick; the `none` sentinel is "no
 * disk", which is not a workspace and belongs to no project. Only an id
 * can be another project's.
 */
function foreignWorkspaceProblems(db: Db, pipelineId: string, steps: PipelineStep[], judgedFor: JudgedFor = { editing: true }): WorkflowProblem[] {
  const adoptedBy = getPipeline(db, pipelineId)?.projectId ?? null;
  const projects = adoptedBy !== null ? [adoptedBy as Uuid] : judgedProjects(db, judgedFor);
  const held = new Set(projects.flatMap((projectId) => (projectId === null ? [] : projectWorkspaceList(db, projectId).map((workspace) => workspace.id))));
  const problems: WorkflowProblem[] = [];

  for (const step of steps) {
    const choice = stepWorkspaceChoice(step.workspaceId);
    if (choice.pick !== "workspace" || held.has(choice.workspaceId as Uuid)) continue;

    // Two states, one sentence each, because they send a person to
    // different places: a workspace that is gone is fixed by picking
    // another, and one that belongs elsewhere is fixed either here or on
    // the Projects screen — and being told the wrong one of those costs
    // a trip to a screen that has nothing to do with it.
    const workspace = getWorkspace(db, choice.workspaceId as Uuid);
    problems.push({
      severity: "error",
      stateId: step.id,
      message: workspace
        ? `"${step.name}" runs on ${workspaceLabel(workspace)}, which belongs to another project — work on this pipeline would ` +
          `happen on a disk nobody looking at it can see. Pick one of this project's workspaces, or add that one to this project first.`
        : `"${step.name}" names a workspace that no longer exists, so there would be nowhere for its runs to work. Pick one of this ` +
          `project's workspaces, or leave it on the ticket's own.`,
    });
  }
  return problems;
}

/**
 * What is wrong with this graph as a publish of this pipeline would
 * judge it, for a writer that is not `pipeline:save` (EO-532).
 *
 * The template update's merge is the caller: it writes a new version of
 * a pipeline nobody is looking at, and the rule is that a merged graph
 * failing `validatePipeline` is not applied. Judged by the same inputs a
 * publish is — the same staffing, the same registry, the same hand-offs
 * in and out — so that an update and a person's publish cannot disagree
 * about whether one graph works.
 */
export function storedGraphProblems(db: Db, pipelineId: string, steps: PipelineStep[], routes: StepRoute[], entryStepId: string | null): WorkflowProblem[] {
  // Judged for the projects the pipeline serves, never the one on
  // screen: the same unadopted graph must not apply with one project
  // selected and be held with another (EO-532 review).
  const judgedFor: JudgedFor = { serving: projectsServedByPipeline(db, pipelineId) };
  return [...validatePipeline(validationInput(db, pipelineId, steps, routes, entryStepId, undefined, judgedFor)), ...foreignWorkspaceProblems(db, pipelineId, steps, judgedFor)];
}

/** Each step once, by id, keeping the first. */
function uniqueById(steps: readonly PipelineStep[]): PipelineStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => !seen.has(step.id) && seen.add(step.id) !== undefined);
}

export function validatePipelineCommand(db: Db, input: IpcPayload<"pipeline:validate">): IpcResponse<"pipeline:validate"> {
  const steps = toDomainSteps(db, input.pipelineId, input.steps);
  const routes = toDomainRoutes(input.pipelineId, input.routes);
  const proposed = registryWith(db, input.actions ?? []);
  const judged = validationInput(db, input.pipelineId, steps, routes, input.entryStepId, proposed.registry, undefined, input.entryRules);
  return {
    problems: [...proposed.refused, ...validatePipeline(judged), ...foreignWorkspaceProblems(db, input.pipelineId, steps)],
    // What each step of the graph reaches outside EO (EO-584), from the
    // very inputs the webhook refusal above was judged with.
    outsideReach: outsideReachByStep(judged),
  };
}

/**
 * Why a publish carrying action definitions may not write them here, or
 * null where it may (EO-426).
 *
 * A role's definitions are part of the `agents` section (EO-425), and
 * `pipeline:save` is a `pipelines` channel: on an installation that
 * manages its agents and not its pipelines — or on a pipeline somebody
 * diverged, which the pipelines lock steps over — the channel's own lock
 * lets the save through. So the question `roleActions:save` is asked is
 * asked again here, of the one function that writes a definition on a
 * publish's behalf, where no caller can leave it out:
 * `assist:publishNew` reaches this function without passing that
 * channel at all.
 *
 * The whole save is refused rather than the graph published without its
 * definitions: the graph was drawn against them, and half of a card is
 * not what the person pressed Publish on.
 */
function proposedActionsLocked(db: Db, actions: readonly ActionDefinitionDraft[]): WorkflowProblem | null {
  if (actions.length === 0) return null;
  const lock = sectionLockFor(db, "roleActions:save");
  if (lock === null) return null;
  const by = lock.publishedBy === null ? "" : ` ${lock.publishedBy} published it.`;
  return {
    severity: "error",
    stateId: null,
    message:
      `The ${lock.section} section is managed by your organisation.${by} This pipeline comes with ${actions.length === 1 ? "an action definition" : "action definitions"} ` +
      `(${actions.map((entry) => `${entry.role}'s "${entry.action}"`).join(", ")}), and a role's actions are part of that section — so nothing was published: ` +
      `neither the ${actions.length === 1 ? "definition" : "definitions"} nor the pipeline. An administrator can add the ${actions.length === 1 ? "definition" : "definitions"}; the pipeline can be published once they exist.`,
  };
}

/** A publish whose definitions or graph were refused inside the transaction; carries the problems out of it so the transaction rolls back. */
class PublishRolledBack extends Error {
  constructor(readonly problems: WorkflowProblem[]) {
    super("publish refused");
  }
}

/**
 * Replaces one pipeline's graph, in a single transaction, if it validates.
 *
 * Saved whole rather than per row because the shape is a property of the
 * set: validating one step at a time cannot see a duplicate position, a
 * dangling route target, or notice that no terminal is reachable any more.
 */
export function savePipeline(
  db: Db,
  engine: { notifyStateChange: () => void } | undefined,
  input: IpcPayload<"pipeline:save">,
  /**
   * The steps this save deleted.
   *
   * A step can own secret values (KAN-105), and those are reachable only
   * through its id — so removing the step without saying so would leave
   * encrypted values on disk that nothing could ever read or remove
   * again. Reported rather than cleaned up here, because what is filed
   * against a step is not this function's business to know.
   */
  onStepsRemoved?: (stepIds: string[]) => void,
  /**
   * Who the version is filed under, where it is not this machine's person
   * (EO-534): on the organisation's record, the admin whose desktop
   * published a draft resolving a held template update.
   */
  options: { createdBy?: string | null } = {},
): IpcResponse<"pipeline:save"> {
  const steps = toDomainSteps(db, input.pipelineId, input.steps);
  const routes = toDomainRoutes(input.pipelineId, input.routes);
  const actions = input.actions ?? [];

  // Before anything is judged (EO-426): a managed agents section refuses
  // whatever was sent, as a section lock does everywhere else, and a
  // list of what is wrong with a graph nobody may publish this way
  // would send somebody to fix the wrong thing.
  const locked = proposedActionsLocked(db, actions);
  if (locked !== null) return { saved: false, problems: [locked], version: null, watchTurnedOff: [] };

  // A restored version brings its entry rules back with it (EO-610): they
  // are part of what it says. Rules the caller sent speak for themselves.
  const restoredVersion = input.restoredFrom === undefined ? undefined : pipelineVersionByNumber(db, input.pipelineId, input.restoredFrom);
  const entryRules = input.entryRules ?? (restoredVersion === undefined ? undefined : versionSnapshot(db, restoredVersion.id)?.entryRules);

  // Judged with the definitions it is being published with.
  const proposed = registryWith(db, actions);
  const problems = [
    ...proposed.refused,
    ...validatePipeline(validationInput(db, input.pipelineId, steps, routes, input.entryStepId, proposed.registry, undefined, entryRules)),
    // A module rule this installation could not run (EO-736): no module
    // host, or a binary its module needs that is not here. Refused when
    // it is published — on the record, where its doors are — rather than
    // found by the first item at the door.
    ...moduleRulesUnrunnableHere(db, entryRules ?? []).map((message) => ({ severity: "error" as const, stateId: null, message })),
    // Before the write rather than after it, and blocking: a step
    // pointed at another project's disk is not a warning about taste
    // (EO-301).
    ...foreignWorkspaceProblems(db, input.pipelineId, steps),
  ];

  if (hasBlockingProblem(problems)) {
    return { saved: false, problems, version: null, watchTurnedOff: [] };
  }

  // Who each human step of a restored version waited on (EO-359), read
  // from that version's own document. Before the write, so a version that
  // has gone since the draft was taken refuses rather than publishing
  // its graph with today's owners on it.
  const restored = input.restoredFrom === undefined ? new Map<string, StepOwner>() : restoredOwners(db, input.pipelineId, input.restoredFrom, steps);
  if (restored === undefined) {
    return {
      saved: false,
      version: null,
      watchTurnedOff: [],
      problems: [
        ...problems,
        {
          severity: "error" as const,
          stateId: null,
          message:
            `v${String(input.restoredFrom)} is no longer kept, so who its steps waited on cannot be restored with it. ` +
            `Cancel, and restore a version History still lists.`,
        },
      ],
    };
  }

  // Off-dashboard steps are not on the wire and must survive the save —
  // without this the first publish would delete `discussion` and orphan every
  // conversation on the FK from `items.stepId`. What the editor cannot
  // see, a save must not destroy.
  const before = listStepsForPipeline(db, input.pipelineId);
  const preserved = before.filter((step) => step.offBoard);

  /**
   * The graph, where work enters it, and the version that freezes both
   * — one call, one transaction (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Three writes that must never be seen apart, and the middle of them
   * is the dangerous one: a crash between the graph landing and the
   * version being filed would leave the *new* steps live under the *old*
   * current version, so every item still bound to it would read as "on
   * the current version", `boundGraphForItem` would answer with the live
   * rows, and work mid-flight would finish on a graph it never entered.
   * That is the one promise this whole story makes.
   *
   * They are one call rather than three here because the coordination
   * belongs where the writes are — `replacePipelineGraph` owns the
   * transaction, and a caller cannot change a graph without filing the
   * version that says what it changed to. Nothing that touches the disk
   * or the keychain is inside it: the module secrets are discarded after
   * it commits, below, because a transaction holding a file operation
   * open is one SQLite cannot roll back.
   */
  /**
   * And, where the publish carries action definitions, those too
   * (EO-426): each through `saveActionDefinition`, the one write every
   * definition goes through, and inside one transaction with the graph.
   * A definition the save refuses, or a graph the repository will not
   * replace, throws — which is what takes back whatever the other half
   * had already written. `replacePipelineGraph`'s own transaction nests
   * inside this one as a savepoint.
   *
   * Definitions first, so the graph lands on an installation that
   * already has the actions its steps name.
   */
  const write = () => replacePipelineGraph(
    db,
    input.pipelineId,
    forWriting([...steps, ...preserved]).map((step) => {
      // A restored owner, where the version said one (EO-359). Both
      // columns at once, because a step waits on a person *or* a group
      // and writing one without clearing the other could leave it
      // naming both. Absent everywhere else, which leaves the row's
      // owner exactly where it was — the rule `forWriting` exists for.
      const owner = step.id === undefined ? undefined : restored.get(step.id);
      return {
        ...step,
        pipelineId: input.pipelineId as Uuid,
        ...(owner === undefined ? {} : { ownerPersonId: owner.personId, ownerGroupId: owner.groupId }),
      };
    }),
    routes.map((route) => ({ ...route, pipelineId: input.pipelineId as Uuid })),
    {
      // Where work enters is part of the document a version freezes
      // (ARCHITECTURE.md, "Vocabulary"), so it lands with the graph rather than after it.
      entryStepId: input.entryStepId,
      ...(entryRules === undefined ? {} : { entryRules }),
      // Who this machine is known as, which on a desktop is the local
      // person and on a signed-in one is them. Not an acting device:
      // `pipeline:save` is a machine channel, and stamping one with a
      // caller is what `ACTOR_SCOPED_CHANNELS` exists to say is a
      // record-half idea.
      createdBy: options.createdBy === undefined ? signedInPersonId(db) : options.createdBy,
      /**
       * A diverged copy files no version (EO-331, ARCHITECTURE.md, "Divergence and suggestions").
       *
       * The history of a pipeline an organisation publishes is the
       * organisation's: every number in it is a publish an admin made,
       * and every item in flight finishes on one of them. A desktop
       * whose person is editing their own copy would be filing a v7
       * nobody published — and colliding with the record's v7 the
       * moment it arrives, since `pipeline_versions` is unique on
       * pipeline and number.
       *
       * What their edit becomes instead is a suggestion, and approving
       * one files the version on the record, from the admin's own act.
       */
      fileVersion: !isDiverged(db, input.pipelineId),
    },
  );

  let written: ReturnType<typeof write>;
  if (actions.length === 0) {
    written = write();
  } else {
    try {
      written = db.transaction(() => {
        for (const action of actions) {
          const saved = saveActionDefinition(db, action);
          if (!saved.ok) {
            throw new PublishRolledBack(
              saved.problems.map((message) => ({ severity: "error" as const, stateId: null, message: `The action definition cannot be saved — ${action.role}'s "${action.action}": ${message}` })),
            );
          }
        }
        const graph = write();
        if (!graph.replaced) {
          throw new PublishRolledBack(
            graph.holding.map((holdsItems) => ({ severity: "error" as const, stateId: holdsItems.stepId, message: stepHoldsItemsMessage(holdsItems), holdsItems })),
          );
        }
        return graph;
      });
    } catch (error) {
      if (!(error instanceof PublishRolledBack)) throw error;
      return { saved: false, version: null, problems: error.problems, watchTurnedOff: [] };
    }
  }

  // The repository's own guard under the validator's (EO-230). The
  // validator has already refused this save if a removed step holds
  // items, so this is the same answer from one layer down — kept as a
  // problem rather than a throw, because whatever reached here is
  // something a person can go and move, not a programmer error.
  if (!written.replaced) {
    return {
      saved: false,
      version: null,
      watchTurnedOff: [],
      problems: written.holding.map((holdsItems) => ({ severity: "error" as const, stateId: holdsItems.stepId, message: stepHoldsItemsMessage(holdsItems), holdsItems })),
    };
  }

  // After the write, so nothing is discarded on behalf of a save that
  // did not happen.
  //
  // **Not the steps this save removed** (EO-327). A removed step is
  // retired rather than dropped, precisely so an item finishing on an
  // older version can still be routed onto it — and anything filed
  // against that step by id has to outlive the removal by exactly as
  // long as that possibility does. Discarding a ghost step's secrets at
  // the moment of removal is how a run that reaches one fails with the
  // module's name on it and no way back.
  //
  // So what is reported is every retired step of this pipeline that
  // *nothing can reach any more*: none of its versions is bound by an
  // item, and nothing is standing on it. That set includes the steps
  // this save removed when they were never reachable, and it sweeps up
  // the ones whose last ghost item finished long ago — which is what
  // gives the discard a second chance rather than one moment.
  if (onStepsRemoved) {
    const unreachable = unreachableRetiredSteps(db, input.pipelineId);
    if (unreachable.length > 0) onStepsRemoved(unreachable);
  }

  // A new or re-owned step may be immediately dispatchable.
  engine?.notifyStateChange();
  // Saving *is* what creates a version (EO-327, ARCHITECTURE.md, "Publish, lock and versions"):
  // everything
  // standing on the pipeline keeps the one it entered on, and
  // everything filed from here takes this one.
  // Which steps stopped keeping checking (EO-506), against the rows as
  // they were before the write. Said in the answer because nothing else
  // would: the save is valid, and the first sign would be the next item
  // to reach the step parking there.
  return { saved: true, problems, version: written.version, watchTurnedOff: watchTurnedOff(before, steps) };
}

