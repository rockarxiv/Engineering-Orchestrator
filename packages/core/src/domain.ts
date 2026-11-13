import type { EntryRule } from "./entryRules.js";
import type { Uuid } from "./index.js";
import type { ItemExtensions } from "./itemExtensions.js";
import type { StepInputs } from "./schemas/modules.js";
import type { PreviewItem } from "./schemas/pipelineExport.js";
import type { StepResult } from "./schemas/pipelines.js";
import type { WorkspaceMode } from "./schemas/workspaces.js";
import type { StepWatch } from "./watch.js";
import { criteriaField, type SpecShape } from "./schemas/specShape.js";

// role/type are plain strings, not closed unions — ARCHITECTURE.md, "An agent is a row":
// "Roles are configuration, not code." A new role or item type is a data
// row, not a schema change, and typing them as an enum here would
// contradict that.

export interface Agent {
  id: Uuid;
  name: string;
  role: string;
  provider: string;
  model: string | null;
  instructions: string;
  /**
   * The hash of the instructions EO wrote, when EO wrote them.
   *
   * Null once a human has saved their own — which is exactly what stops
   * a later version of the shipped prompt from overwriting their work.
   */
  promptHash: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  /**
   * When this agent was retired, or null while it is somebody's agent
   * (EO-186).
   *
   * A different question from `enabled`, and the reason `agents` grew a
   * column rather than reusing the switch: disabled is "not right now",
   * which somebody flips back, while archived is "this is over, keep it
   * for the record". The row stays because things point at it — its runs,
   * the comments it wrote, the mentions that named it — and invariant #3
   * is what says those must still read as they did.
   *
   * Every other catalogue in EO already draws the line here:
   * `pipelines`, `modules`, `mcp_servers` and `skills` all carry one and
   * all archive rather than delete.
   */
  archivedAt: number | null;
  /**
   * When this agent was deleted, or null (EO-350).
   *
   * A deleted agent is a tombstone: its name and role are kept so the
   * runs it did and the comments it wrote still say who did them, and
   * everything else — instructions, config, backend, attachments — is
   * gone. It is archived and disabled as well, so every question that
   * asks `isDispatchable` already leaves it out; this is what keeps it
   * off the Agents screen, where an archived agent is still listed.
   */
  deletedAt: number | null;
  /**
   * The one project this agent works for, or null for a global agent
   * (EO-474, ARCHITECTURE.md, "An agent is a row").
   *
   * Null is what every agent was before there was a choice, and what
   * every agent is unless somebody scoped it. A scoped agent staffs that
   * project's items and nobody else's, and within that project it takes
   * precedence over the global agents in its role — `staffingAgents` is
   * where both halves are written. Never set on a `system` agent: the
   * assistant is one agent with the same instructions for everyone, and
   * `agents:save` refuses the pair.
   */
  projectId: Uuid | null;
}

/**
 * Whether this agent may be dispatched at all (EO-186).
 *
 * Both halves, in one place, because the two ways of getting it wrong
 * are not symmetrical. An agent counted as staffing a role it will never
 * run for leaves every item that reaches that step waiting in silence —
 * the exact failure `no_enabled_agent` and `validatePipeline`'s
 * "items will wait there indefinitely" exist to make loud — so the
 * scheduler and the staffing checks have to answer this the same way,
 * and answering it in two places is how they come to disagree.
 *
 * Not about capacity, and deliberately not: an agent that is merely busy
 * is a queue, not a reason.
 */
export function isDispatchable(agent: Pick<Agent, "enabled" | "archivedAt">): boolean {
  return agent.enabled && agent.archivedAt === null;
}

/** The role of the agent that runs EO itself: the assistant, a scenario chat, the reading of a reply. */
export const SYSTEM_ROLE = "system";

/**
 * The one definition of a system agent run: its agent holds the `system`
 * role (EO-615). Null and undefined are the runs with no agent, a builtin
 * or a module, and an agent whose row has gone.
 */
export function isSystemAgent(agent: Pick<Agent, "role"> | null | undefined): boolean {
  return agent?.role === SYSTEM_ROLE;
}

/**
 * An agent row that names no backend yet (EO-314).
 *
 * What a role imported from a data pack lands as when the backend the
 * pack recommends is not signed in here. The original design is the rule: "a pack names
 * the role each agent step needs and the installing machine chooses the
 * agent … It may recommend a backend and model. It may not require one."
 * An import that bound the agent to a backend nobody has signed in to
 * would be a row that looks staffed and fails at dispatch; one that
 * created nothing at all would throw away the prompt, the schemas and
 * the tool surface the pack shipped, which is most of what a pack *is*.
 * So the row exists, carrying all of that, and says out loud that the
 * one local decision has not been made.
 *
 * The empty string rather than a nullable column, because `provider` is
 * `NOT NULL` and every reader of it is a `switch` on a backend's name:
 * "" matches no adapter, exactly as it should. It is paired with
 * `enabled: false` on creation, so nothing dispatches it — and
 * `agents:save` requires a non-empty provider, so the only way to enable
 * one is to have picked a backend for it.
 */
export const UNBOUND_BACKEND = "";

/** Whether somebody here has chosen what this agent runs on. */
export function isBoundAgent(agent: Pick<Agent, "provider">): boolean {
  return agent.provider !== UNBOUND_BACKEND;
}

/**
 * The mark on an agent row that exists only so a preview could walk
 * (EO-316, `ARCHITECTURE.md`, "Preview").
 *
 * Preview runs a real pipeline and a real pipeline dispatches to agents.
 * A pack's roles land unbound and disabled when the backend they
 * recommend is not signed in here (EO-314, ARCHITECTURE.md, "An agent is a row") — which on first
 * run is
 * always — so the gallery adds a row of its own, on `fake`, or the
 * preview stops dead at its first agent step.
 *
 * That row is a rehearsal's, and **it is not part of the installation's
 * staffing**. It carries the pack's ordinary role name, because that is
 * what the steps it must run name; left in the ordinary pool it would
 * answer "who runs `reporter`?" for a real item filed by a person, which
 * would dispatch their work to a placeholder that makes things up. It
 * would also answer "is this role filled?" on a needs check, and silence
 * `validatePipeline`'s warning about a step nobody staffs.
 *
 * So the mark is in *core*, beside the other two questions every reader
 * of an agent asks, rather than in the gallery that writes it: the
 * scheduler, the import preflight and the pipeline validator all have to
 * agree about what this row is for, and a predicate each of them
 * re-derived would be three chances to forget.
 */
export const PREVIEW_AGENT_KEY = "eoPreviewAgent";

/** Whether this agent exists only to walk previews — see `PREVIEW_AGENT_KEY`. */
export function isPreviewAgent(agent: Pick<Agent, "config">): boolean {
  return agent.config[PREVIEW_AGENT_KEY] === true;
}

/**
 * Whether this agent's scope reaches this item's project (EO-474).
 *
 * A global agent reaches every item; a project's own agent reaches that
 * project's items and nothing else — not another project's, and not an
 * item that belongs to no project. The scope half of `staffsItem`, apart
 * so that the one reader that must not also apply the preview rule — a
 * mention, which can name a preview's agent on purpose — asks exactly
 * this and no more.
 */
export function servesProject(agent: Pick<Agent, "projectId">, item: Pick<Item, "projectId">): boolean {
  return agent.projectId === null || agent.projectId === item.projectId;
}

/**
 * Whether this agent may run this item.
 *
 * The composition of the rules above, written once so that the scheduler,
 * the preflight and the validator cannot come to disagree: an ordinary
 * agent runs anything its scope reaches, and a preview's own runs
 * previews only.
 *
 * Not the same question as `isDispatchable`, which asks whether a row is
 * live at all. Both apply, and in that order: a disabled preview agent
 * is no more dispatchable than a disabled real one.
 *
 * Nor the whole of staffing. Whether a global agent is *outranked* on
 * this item by the project's own is a question about the other agents
 * too, so it is `staffingAgents`'s, and that is what callers ask.
 */
export function staffsItem(agent: Pick<Agent, "config" | "projectId">, item: Pick<Item, "previewAt" | "projectId">): boolean {
  return servesProject(agent, item) && (item.previewAt !== null || !isPreviewAgent(agent));
}

/** What `staffingAgents` reads of an agent. */
export type StaffingAgent = Pick<Agent, "role" | "enabled" | "archivedAt" | "config" | "projectId">;

/**
 * Whether the item's project has a dispatchable agent of its own in
 * this role (EO-474) — which is what takes the global agents in that
 * role off the item.
 *
 * Dispatchable rather than free: a project's own implementer that is
 * busy is a queue for that project's work, not a reason to hand the
 * work to the global one. Disabled or archived, it outranks nobody, and
 * the project falls back to the global agents as if it had none.
 */
export function projectHasOwnAgent(agents: readonly StaffingAgent[], role: string, item: Pick<Item, "previewAt" | "projectId">): boolean {
  return agents.some((agent) => agent.projectId !== null && isDispatchable(agent) && agent.role === role && staffsItem(agent, item));
}

/**
 * Every agent that may be dispatched for this item at a step owned by
 * this role, in the order given (EO-474, ARCHITECTURE.md, "An agent is
 * a row").
 *
 * The one staffing rule. The scheduler picks from it, its "no enabled
 * agent" blocker asks whether it is empty, the dispatch preflight asks
 * whether the agent a rerun named is in it, and the pipeline validator
 * asks which roles it is non-empty for — four readers of one function,
 * so none of them can come to promise what another refuses.
 *
 * Live (`isDispatchable`), in the role, reaching the item (`staffsItem`)
 * — and then the precedence: where the item's project has an agent of
 * its own in the role, only the project's own are candidates; otherwise
 * the global ones are, exactly as before agents could be scoped.
 * Capacity is not asked: a busy agent is a queue, not a reason.
 *
 * Empty for a null role, which is a step nobody is dispatched at.
 */
export function staffingAgents<A extends StaffingAgent>(agents: readonly A[], role: string | null, item: Pick<Item, "previewAt" | "projectId">): A[] {
  if (role === null) return [];
  const eligible = agents.filter((agent) => isDispatchable(agent) && agent.role === role && staffsItem(agent, item));
  const own = eligible.filter((agent) => agent.projectId !== null);
  return own.length > 0 ? own : eligible;
}

/**
 * The roles somebody would be dispatched for on this item — the roles
 * `staffingAgents` is non-empty for (EO-474).
 *
 * What `validatePipeline` is handed as `staffedRoles`, asked of an item
 * standing for the pipeline's work: real (not a preview) and on the
 * pipeline's project. A role only another project's agent holds is
 * therefore unstaffed for this pipeline, which is what the scheduler
 * will find when an item arrives.
 */
export function rolesStaffedFor(agents: readonly StaffingAgent[], item: Pick<Item, "previewAt" | "projectId">): string[] {
  const roles = [...new Set(agents.map((agent) => agent.role))];
  return roles.filter((role) => staffingAgents(agents, role, item).length > 0);
}

/**
 * What an agent is for, in one line, taken from its own instructions.
 *
 * Derived rather than stored, which was the Agents screen's call and is
 * worth restating because it is load-bearing here: a separate description
 * column is a second thing to keep true, and the first sentence of a
 * prompt is already what the agent is for. Prompt-version markers and
 * headings are skipped — they are addressed to EO, not to whoever is
 * reading.
 *
 * In `packages/core` rather than in the renderer because two things now
 * ask the question. The Agents card shows this to a person; the `eo` MCP
 * service reports it to the system agent, which decides from it
 * whether an agent that already exists can own a step. Those two must not
 * be able to disagree about what an agent does, and the service is an
 * unbundled `.mjs` that cannot import a `.tsx` — so a shared home is the
 * only arrangement where there is one answer.
 */
export function summarizeInstructions(instructions: string): string | null {
  for (const raw of instructions.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("<!--") || line.startsWith("#")) continue;
    return line;
  }
  return null;
}

/**
 * The roles EO ships are registry data now (KAN-124): `BUILTIN_ROLES` in
 * `registry/developer.ts` is the developer pack's contribution, and
 * `isBuiltinRole(registry, role)` is the question. `role` stays a plain
 * string everywhere here (ARCHITECTURE.md, "An agent is a row": "roles are configuration, not
 * code") — a
 * pipeline step can name a role nobody has created yet and that must
 * keep working.
 */

/**
 * The system agent's actions whose item *is* one chat (EO-210).
 *
 * The assistant's chat and a module's scenario chat (EO-356) are each an
 * item — `ASK-n`, `SCN-n` — holding one continuous conversation with one
 * person. There is nothing episodic about either, so "one provider
 * thread per item" and "one provider thread per conversation" are the
 * same sentence in these rooms, ending included: Clear archives the conversation's item, so the next
 * message is a new item and therefore a new thread with no special
 * case anywhere.
 *
 * The list is here rather than beside the rooms because it is read where
 * the reuse decision is made, and that decision has to be the same in
 * the main process, the editor and the `eo` MCP service — the reason
 * `reusesThreadPerItem` lives in `packages/core` at all. The strings
 * are the desktop app's `ASSIST_ACTION` and `SCENARIO_ACTION`; `conversationSteps.test.ts`
 * asserts they still are, so a rename over there fails a test rather than
 * silently turning those rooms back into one-shot dispatches.
 *
 * **What is deliberately absent is the rest of the system agent's work.**
 * `interpret` runs against a real work item that parked with a
 * question, one decision at a time, and `respond` against a real work
 * item somebody @-mentioned it on. Keying reuse on the role alone
 * would give those a thread keyed on a *work* item, accumulating
 * unrelated interpretations of different parks in one conversation —
 * which is exactly the case EO-178's "each dispatch is a separate
 * question" was written about, and it is still true there. So reuse is a
 * property of the action as well as of the role.
 */
export const THREAD_PER_CONVERSATION_ACTIONS = ["assist", "scenario"] as const;

export type ThreadPerConversationAction = (typeof THREAD_PER_CONVERSATION_ACTIONS)[number];

/** Whether this dispatch's subject is a conversation rather than an episode of work. */
export function isThreadPerConversationAction(action: string | null | undefined): action is ThreadPerConversationAction {
  return action !== null && action !== undefined && (THREAD_PER_CONVERSATION_ACTIONS as readonly string[]).includes(action);
}

/**
 * Thread reuse is a registry question now (KAN-124): each role entry
 * carries `threadReuse`, and `reusesThreadPerItem(registry, agent,
 * action)` in `registry/index.ts` is the one reader. The list above is
 * what it consults for a `per-conversation` role.
 */

/** A configurable route from "new work" to "done" (KAN-52). */
export interface Pipeline {
  id: Uuid;
  /** Null until a project adopts it — EO is usable before one exists. */
  projectId: Uuid | null;
  name: string;
  icon: string | null;
  /**
   * Where an item assigned to this pipeline lands (ARCHITECTURE.md, "Vocabulary").
   *
   * Explicit rather than "the lowest position": position orders the
   * display and nothing else (ARCHITECTURE.md, "A step"). Null only while a pipeline has no
   * steps yet — the validator refuses to publish one without it.
   */
  entryStepId: string | null;
  position: number;
  /**
   * The template item this pipeline's pack ships for Preview (EO-314,
   * `ARCHITECTURE.md`, "Preview").
   *
   * Null on every pipeline somebody drew here, which is almost all of
   * them: an example arrives with a pack and is not something EO makes
   * up. Carried so that a pack passed on from this installation still
   * has the one thing that lets the next person watch it work before
   * they sign anything in.
   */
  previewItem: PreviewItem | null;
  /**
   * Whether somebody has let this pipeline send what a webhook delivers
   * without a person reading it first (EO-405). Off unless a person
   * turned it on in the pipeline's editor; see `webhookUnattended.ts`.
   */
  webhookUnattended: boolean;
  /**
   * What an item must have to enter (EO-610, ARCHITECTURE.md, "Entry
   * rules"), in order. Empty on every pipeline that asks for nothing.
   */
  entryRules: EntryRule[];
  /** Deleting a pipeline archives it; the work that flowed through it still points here. */
  archivedAt: number | null;
}

/**
 * The board a screen with no pipeline in its address is showing.
 *
 * `'default'` is the row migration 0028 seeds — "Delivery", the pipeline
 * every installation starts with. `/project` draws the same board as
 * `/pipelines/:pipelineId` and falls back to this when its address
 * names no pipeline, which is what makes the two paths one board.
 *
 * Named here rather than spelled inside the view because a second
 * reader of that fallback exists: the main process resolves the page
 * somebody is on to the rows behind it (EO-191), and on `/project`
 * it has to name the pipeline the screen is *actually* drawing. A
 * section describing a different board than the one in front of the
 * person is worse than no section at all — nothing on the screen shows
 * that it is wrong. One constant is what keeps the two answers the same
 * answer.
 */
export const DEFAULT_PIPELINE_ID = "default";

/**
 * Who or what is responsible while an item sits on a step.
 *
 * Three kinds, and the difference between them is *who acts*:
 *
 * - `agent` — a role is dispatched to a coding agent. `entryAction` names
 *   the action (`implement`, `review`) and `ownerRole` names the role.
 * - `user` — a person. The engine does not dispatch; it hands off and
 *   waits, which is what `owner_role IS NULL` used to mean on its own.
 * - `builtin` — EO does it itself, by running a named function.
 *   `entryAction` names which (`create_worktree`, `index_repository`,
 *   `open_pull_request`).
 * - `module` — a custom module runs, out of process. `entryAction` names
 *   its id (KAN-104).
 *
 * The kinds this replaced (`source`, `merge_request`, `gate`) described
 * *what a step was for* while the engine branched on something else
 * entirely, so choosing one changed an icon and nothing more. These four
 * decide which executor runs, which is why the set is short.
 *
 * `module` is deliberately its own kind rather than a third builtin
 * action. `builtin` means code EO ships and audited; a module is code a
 * person approved. That is a different trust class, and the moment it
 * matters — reading a transcript after something went wrong — is exactly
 * when you want the two distinguishable rather than merged.
 */
export type PipelineStepType = "agent" | "user" | "builtin" | "module";

export interface PipelineStep {
  /**
   * uuidv7 for anything a person creates. The steps seeded on first run
   * keep the slugs their states had (`todo`, `review`, …) — nothing
   * branches on the value, because routing reads `StepRoute`.
   */
  id: string;
  pipelineId: Uuid;
  position: number;
  name: string;
  type: PipelineStepType;
  /** The role dispatched on an `agent` step. Null on every other kind. */
  ownerRole: string | null;
  /**
   * What this step does — an agent action on an `agent` step, a builtin
   * function on a `builtin` one. Null on a `user` step, which does not act.
   */
  entryAction: string | null;
  instructionsSummary: string | null;
  isTerminal: boolean;
  /**
   * Ask this step to plan before it writes anything (KAN-18, ARCHITECTURE.md, "A step").
   *
   * On the step rather than on the project, where it lived with a note
   * explaining that a per-group gate could not be a state while
   * `workflow_states` was global. It is not global any more — and the flag
   * was never about a project: it asks one step to work differently.
   */
  planMode: boolean;
  /**
   * How this step uses a git workspace: a branch of its own, or the
   * repository as it stands (EO-296, ARCHITECTURE.md, "The four kinds").
   *
   * On the step for `planMode`'s reason — it asks one step to work
   * differently, and two steps of one pipeline may legitimately
   * disagree: a step that reads the code to answer a question wants no
   * branch, and the step after it that changes the code wants nothing
   * else. Meaningless on a workspace that is not a git kind, where it is
   * simply never read.
   *
   * `isolated` for every step that has never said otherwise, which is
   * what every step did before this existed.
   */
  workspaceMode: WorkspaceMode;
  /**
   * Which of the project's workspaces this step runs on (EO-301,
   * the original design).
   *
   * "A step may pick among the project's workspaces. A step does not
   * define a workspace of its own" — so this is an id, never a config.
   * A pipeline whose first step drafts in `scratch` and whose second
   * commits to a repository is the case it exists for.
   *
   * Three values, and `stepWorkspaceChoice` is the one place they are
   * read apart. Null is "whatever the ticket is on", which is what every
   * step did before a step could pick, and therefore what every row
   * written before this story means. `NO_WORKSPACE` is "no disk", said
   * out loud. Anything else is a workspace id.
   *
   * Held to the *project's* workspaces when it is saved: a step pointing
   * at another project's disk is a run that would work somewhere nobody
   * looking at this pipeline can see.
   */
  workspaceId: string | null;
  /**
   * Holds something other than work, so the dashboard, the archive and the
   * inbox leave it out. Shipped for the `discussion` step — an item
   * for the sake of runs and durability, not a piece of work anyone should
   * see queued next to one.
   */
  offBoard: boolean;
  /**
   * What this step sets for the inputs its module declares (EO-78).
   *
   * On the step rather than on the module, for the reason a secret is:
   * two steps can run one module and mean different things by it — the
   * merge module waits for CI, and how long to wait is a property of a
   * repository's CI rather than of the code that waits.
   *
   * Only the names somebody set. Absent means the manifest's default
   * applies, which is not the same as a value that happens to equal it:
   * one follows the module when its default changes and the other does
   * not. Empty on every step that is not a module step, and on a module
   * step nobody has configured.
   */
  inputs: StepInputs;
  /**
   * How long this step's module may run before EO stops it (EO-162).
   *
   * Null means EO's own default, `DEFAULT_MODULE_TIMEOUT_MS` — not "ten
   * minutes, written down". A step that never set one follows the default
   * if it ever changes, exactly as an unset input follows its manifest.
   *
   * On the step for the reason `inputs` is: two steps running different
   * modules have no reason to share a limit, and the one that waits for
   * CI is the one that needs a large one. Milliseconds, like every other
   * duration crossing this boundary, though a person types minutes.
   *
   * Bounded by `GuardConfig.wallClockTimeoutMs` — see
   * `timeLimitBoundProblem`, which is the one place that relationship is
   * written down. Meaningless on any step that is not a `module` step,
   * and refused there rather than ignored.
   */
  timeoutMs: number | null;
  /**
   * Keep checking (EO-456, ARCHITECTURE.md, "A step").
   *
   * Null on a step that runs once, which is every step that existed
   * before this. Set on a `builtin` or `module` step whose function or
   * module declares that it can wait: the step then runs a short check
   * every `everyMinutes` until one returns a result key, and gives up
   * `giveUpAfterHours` after it started. Refused by `validatePipeline`
   * anywhere else, rather than stored and ignored.
   */
  watch: StepWatch | null;
  /**
   * The person a human step waits on (EO-302, ARCHITECTURE.md, "Identity").
   *
   * Null on every step that names nobody, which is every step today: it
   * waits for whoever is there, and in solo mode that is the one person
   * there is. Naming one is what turns a column head from "Nobody
   * assigned" into "Anna Ruiz · approves here" (ARCHITECTURE.md, "Identity").
   *
   */
  ownerPersonId: Uuid | null;
  /**
   * The group a human step waits on instead (EO-323, ARCHITECTURE.md, "Identity").
   *
   * Reserved by EO-302 and unread until now, for the reason it gave:
   * there was no `groups` table for it to name. There is one from 0089,
   * and what reads this is the column head — "Support team · anyone
   * claims", which is a different promise from "Anna Ruiz · approves
   * here" and so cannot be a name with no kind beside it.
   *
   * Never set at the same time as `ownerPersonId`; `setStepOwnerCommand`
   * refuses the pair rather than choosing between them. `replacePipelineGraph`
   * says nothing about either — who waits at a step is not the shape of
   * a graph, which is why it is `steps:setOwner` and not a field on a
   * publish (see `forWriting`).
   */
  ownerGroupId: string | null;
  /**
   * What a person may decide here (EO-310, ARCHITECTURE.md, "Results and routes").
   *
   * Only a `user` step declares these, and `validatePipeline` refuses a
   * pipeline where one of them is unrouted, or where a route out of a
   * user step names a key that is not here. Empty on every other kind,
   * and on a human step nobody has given a decision to — which is every
   * human step that only ever waited, and so what the column means for
   * every row written before it existed.
   */
  results: StepResult[];
  /**
   * Which version of its module a `module` step runs (EO-770,
   * ARCHITECTURE.md, "Modules: a step that is a script").
   *
   * A `module_versions.number` of the module `entryAction` names. The
   * runner loads that version's code and manifest and gates on that
   * version's approval, so an edit to the module — which files a new,
   * unapproved version — changes nothing a pipeline runs until a pin
   * moves. Part of the graph document, so every pipeline version is exact
   * about the code its steps run.
   *
   * Null on every other kind of step. Null on a module step only where
   * its module has no version at all; such a step runs the module as it
   * stands, which is what every step did before pins.
   */
  moduleVersion: number | null;
}

/**
 * The functions a `builtin` step can run, and what each returns, are
 * registry data now (KAN-124): `Registry.builtins`, contributed by
 * `BUILTIN_ACTIONS` and `BUILTIN_RESULTS` in `registry/developer.ts` and
 * read through `isBuiltinAction`, `builtinResults` and the validator.
 * `FAILED_RESULT` moved with them.
 */

/**
 * What a custom module declares about itself (KAN-103).
 *
 * The manifest is the point of the whole feature, not decoration. A step
 * holding a shell command line cannot say what it depends on — it reaches
 * the ambient PATH, an ambient cwd and the whole environment, and a
 * `needs` written beside it would be a comment nothing enforces. A module
 * is handed a `ctx` and has nothing else in scope, so everything it
 * touches has to be named here, and the host refuses what is not.
 *
 * That is what makes a pipeline portable: an import can answer "what does
 * this need on my machine" before anything runs (KAN-108).
 */
export interface ModuleInput {
  type: "string" | "number" | "boolean";
  // Explicitly `| undefined`: `exactOptionalPropertyTypes` is on, and these
  // are parsed from a zod schema whose optionals produce exactly that.
  description?: string | undefined;
  default?: string | number | boolean | null | undefined;
}

export interface ModuleNeeds {
  /** Binaries `ctx.exec` may launch. Anything else is refused. */
  bin: string[];
  /** Named secrets injected into the module's environment — nothing else is. */
  env: string[];
  network: boolean;
  /**
   * Whether this module reads EO's items through `ctx.item()` and
   * `ctx.itemByKey()` (EO-74) — or the deprecated `ctx.ticket()` and
   * `ctx.ticketByKey()` beside them (KAN-162).
   *
   * Declared for legibility, not as a control — unlike `bin` and `env`,
   * which the host enforces. The host is not a sandbox: a module runs
   * with the user's privileges and `node:fs` already reaches `eo.db`, so
   * a check here would stop nobody who meant to go around it. What it
   * buys is that a reviewer sees the intent in the manifest, instead of
   * finding hand-written SQL in the body.
   */
  item: boolean;
  /**
   * Whether this module posts comments through `ctx.comment()` and
   * `ctx.commentOn()` (EO-75).
   *
   * Declared exactly as `item` is, and for the same reason: legibility,
   * not a control. Writing is the one thing a module genuinely cannot do
   * for itself — the host's handle on EO's database is read-only, so a
   * comment has to be asked for over fd 3 — but the ask is not refused
   * on this flag either. A run is capped at a stated number of comments
   * whatever the manifest says, which is the limit that actually holds;
   * this is what the person approving reads.
   */
  comment: boolean;
  /**
   * Whether this module attaches files to its item through
   * `ctx.attach()` (EO-414).
   *
   * Declared as `comment` is and for the same reason: so the person
   * approving sees that this code puts files on an item — which, on an
   * item mirrored to Jira, is files leaving the machine. Not enforced.
   */
  attach: boolean;
  /**
   * Whether this module creates work items through `ctx.createItem()`
   * (EO-433).
   *
   * The one of these three that is enforced: a module whose manifest
   * does not declare it is refused by the host and again by the parent,
   * because an item it creates reaches a pipeline with nobody accepting
   * it first.
   */
  create: boolean;
}

export interface ModuleManifest {
  name: string;
  /**
   * Required, for the reason `ProposedAgentSchema.instructions` is: a
   * placeholder produces a row that looks usable and is undiscoverable.
   * The architect reads these to decide whether a module it could write
   * already exists (KAN-107), so an empty one costs a duplicate.
   */
  description: string;
  inputs: Record<string, ModuleInput>;
  needs: ModuleNeeds;
  /**
   * Every result key this module can return.
   *
   * Declared, unlike an agent's verdict or a builtin's outcome, which is
   * what lets `validatePipeline` catch a branch that can never be taken
   * and an outcome no route handles — at publish time rather than when an
   * item arrives (ARCHITECTURE.md, "Results and routes").
   */
  results: string[];
  /**
   * Whether running this module reaches outside EO (EO-334) — see
   * `ModuleManifestSchema.sideEffects`, which is where it is written
   * down and why. Optional, so a manifest written before the question
   * existed reads as what it was.
   */
  sideEffects?: boolean | undefined;
  /**
   * Whether this module can serve as a keep-checking check (EO-456) — see
   * `ModuleManifestSchema.watch`. Optional, so a manifest written before
   * the question existed reads as a module that runs once.
   */
  watch?: boolean | undefined;
  /**
   * Whether this module is an entry check a `module` entry rule may run
   * (EO-736) — see `ModuleManifestSchema.entryCheck`. Optional, so a
   * manifest written before the question existed reads as no check.
   */
  entryCheck?: boolean | undefined;
}

/** Who wrote a module: a person at the editor, or the pipeline architect. */
export type ModuleSource = "user" | "architect" | "import";

/**
 * A unit of deterministic work a step can run, that EO did not ship.
 *
 * The gap it fills: "deploy the app" was a script before agents existed
 * and should still be one. There is no judgement in it, so an agent adds
 * a token bill, a nondeterministic transcript and a new way to fail in
 * exchange for nothing. EO already made this call for itself — `builtin`
 * exists because "there is no judgement in `git worktree add`" — and this
 * is that same choice handed to the user.
 */
export interface CustomModule {
  id: Uuid;
  /** Stable, human-readable, unique. What an export refers to across machines. */
  slug: string;
  name: string;
  description: string;
  /** The module source. In the DB rather than on disk, so export is a query. */
  code: string;
  manifest: ModuleManifest;
  /**
   * The script this module was written from, when it was written from one.
   *
   * Provenance rather than a backup. A module the architect wrote from
   * someone's script is that agent's *reading* of the script, and invariant
   * #5 prefers what can be checked over what is asserted — keeping the
   * original is what leaves the translation diffable a year later.
   */
  originalScript: string | null;
  source: ModuleSource;
  /**
   * When a person last approved this exact code. Null means never, and an
   * unapproved module cannot run — which is what makes an imported one
   * safe to accept (KAN-108).
   */
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * Where one declared result of a step sends the item.
 *
 * `target` is a step id in the same pipeline, or one of the two sentinels
 * below. Keeping them in one field rather than adding two booleans is what
 * lets the configuration screen render a single "Route to" select.
 */
/** Park the item and ask the human (KAN-55). */
export const USER_ATTENTION_TARGET = "user_attention";
/** Resolve to the pipeline's terminal step. */
export const TERMINAL_TARGET = "terminal";

export interface StepRoute {
  id: Uuid;
  pipelineId: Uuid;
  fromStepId: string;
  /** Matches one of the results the step declares. */
  resultKey: string;
  label: string;
  tone: "success" | "warning" | "info" | "danger";
  target: string;
  position: number;
}

/**
 * What a person may decide on a human step is `StepResult`, in
 * `schemas/pipelines.ts` (EO-310) — beside `StepInputs` and
 * `WorkspaceMode`, and there for their reason: the column is JSON, so
 * the schema is what a row is read back through.
 */

/**
 * A human step's results, kept honest against its routes (EO-310).
 *
 * `validatePipeline` refuses a declared result with no route and a route
 * with no declared result, which leaves everything that *writes* a graph
 * with the same small job: keep the two sides in step. Four writers have
 * it — the configuration screen on publish, the architect's draft, the
 * assist draft, and a pipeline document on import — and four copies of
 * it would be four chances for one of them to drift into producing
 * graphs the validator will not take.
 *
 * So: one result per route out of the step, in the routes' own order,
 * because on a human step a route *is* an offer — there is nothing else
 * that could take it. Nothing at all on any other kind of step: an
 * agent, a builtin and a module each report their own result, and a
 * declaration there is dead wiring the validator refuses in its own
 * sentence.
 *
 * **Which side owns which field is the whole of this function, and it is
 * not the same answer for all four.**
 *
 * `key` is the route's, which is what makes this a function of the
 * routes at all.
 *
 * `label` and `tone` are the route's *every time*, and this is the part
 * that was wrong until EO-310's review caught it. The result row on the
 * configuration screen is where both are typed, and it writes them onto
 * the route — there is no second editor for them anywhere. A
 * declaration that kept its own copy was therefore a stale cache with a
 * button drawn from it: rename a result to "Accept" and turn it amber,
 * publish, and the graph showed an amber Accept while the item still
 * offered a green Approve. The declaration carries them so that a
 * refusal can name the button without holding the routes
 * (`decisionRefusal` is pure and is given the step alone) — carrying
 * them is not the same as owning them.
 *
 * `requiresComment` is the declaration's, and only the declaration's,
 * for exactly the reason the other two are not: nothing else edits it.
 * It is the one thing about an offer that is not on the edge — "Send
 * back" needing the reason typed before it can be taken is a property of
 * the decision — so it survives every rewrite of the wiring around it.
 *
 * A key the step does not yet declare has no `requiresComment` to keep,
 * and starts from its tone: the original design's "a non-approving result requires a
 * comment", as the starting point for a row nobody has configured, never
 * as a rule replacing the field.
 */
export function resultsFromRoutes(
  // `results` is optional, and deliberately: a caller holding a step
  // that predates the field, or one assembled by hand rather than
  // parsed, declares nothing — which is exactly what an absent list
  // means. Demanding it would make this helper the thing that threw on
  // an old row.
  step: { id: string; type: PipelineStepType; results?: readonly StepResult[] | undefined },
  routes: readonly { fromStepId: string; resultKey: string; label: string; tone: StepResult["tone"]; position: number }[],
): StepResult[] {
  if (step.type !== "user") return [];
  const declared = new Map((step.results ?? []).map((result) => [result.key, result]));
  return routes
    .filter((route) => route.fromStepId === step.id)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((route) => ({
      key: route.resultKey,
      // The row's own words and colour, whether or not this key was
      // declared before: they are edited on the route and nowhere else.
      label: route.label,
      tone: route.tone,
      // And the one field the route cannot answer for, kept across every
      // rewrite of the wiring — falling back to the tone only where
      // there is no declaration to keep.
      requiresComment: declared.get(route.resultKey)?.requiresComment ?? route.tone !== "success",
    }));
}

/**
 * A route out of *another* pipeline that lands on a step of this one
 * (EO-58, EO-167).
 *
 * The one edge nothing editing this pipeline can see. The configuration
 * screen is given this pipeline's routes and `validatePipeline` judges
 * this pipeline's routes; a hand-off in belongs to whichever pipeline
 * declares it, so removing the step it names leaves it pointing at
 * nothing — in a pipeline nobody had open, found when an item next takes
 * that branch. `step_routes.target` has no foreign key to catch it.
 *
 * Carries the pipeline's name rather than its id because the only thing
 * anyone can do about one is go to that pipeline and repoint it.
 */
export interface IncomingHandOff {
  /** The step of this pipeline the route lands on. */
  target: string;
  /** The pipeline that declares it — where somebody has to go to change it. */
  pipelineName: string;
  /** What that branch is called there. */
  label: string;
}

export interface Item {
  id: Uuid;
  key: string; // "EO-42"
  /**
   * The `item_types` row this is one of (KAN-129).
   *
   * The identity. `type` below is the word on that row, and two packs
   * may have shipped the same word — so a reader that has to be exact
   * about *which* type this is asks by this, and the readers that switch
   * off the word in KAN-146 and KAN-147 will be asking by this.
   */
  typeId: Uuid;
  /**
   * That row's slug — `feature`, `story` or `bug` in the developer pack.
   *
   * What a person and an agent are *shown*, and what a filter matches
   * on. No longer what anything branches on: the container branches
   * read `container` below since KAN-146, and a bare slug is ambiguous
   * across packs anyway, which is why nothing that must be exact uses
   * it.
   */
  type: string;
  /**
   * That row's label — "Story", "Case" (EO-309, ARCHITECTURE.md, "What a pack labels").
   *
   * The word a person reads, where `type` is the word a filter matches.
   * They are the same string in the developer pack and need not be in
   * any other: a pack is free to slug a type `case` and label it
   * "Support case", and the design's rule is that every cross-pipeline row
   * shows the *label*.
   *
   * Projected from the same join `container` comes from, for the same
   * reason — a board of fifty cards would otherwise be fifty lookups,
   * and a lookup keyed on the bare slug could not tell two packs' `case`
   * apart anyway.
   */
  typeLabel: string;
  /**
   * Whether this type holds other items rather than being work itself —
   * `item_types.container`, carried on the item view (KAN-146).
   *
   * The fourteen sites that used to ask whether the word was `feature`
   * ask this instead: a container decomposes rather than being
   * implemented, sits on no pipeline, has no changes of its own to open
   * a pull request for, may hold children, and takes its children with
   * it when it is deleted. A pack whose container is an epic or a
   * campaign gets all five without EO learning either word (ARCHITECTURE.md,
   * "An item type is data").
   *
   * On the row's own flag rather than looked up by the slug: two packs
   * may both ship a `case`, so the word cannot answer which type this
   * item actually is. Projected from the join `selectItems` already
   * does, so a reader pays no lookup for it — which is what let the
   * renderer and `packages/engine` read the flag without either of them
   * reaching for the table (invariant #2).
   */
  container: boolean;
  parentId: Uuid | null;
  /**
   * The workspace this work happens in — the repository, for the one
   * kind there is today (KAN-130).
   *
   * Null for items written before any workspace existed (D-04), and for
   * a feature on a project spanning several, whose work is spread across
   * them (KAN-17).
   */
  workspaceId: Uuid | null;
  /**
   * Which project it appears on.
   *
   * Not derived from `workspaceId`: an item may have no workspace at
   * all, and a workspace outlives the project it was attached to, so the
   * item says which project it belongs to itself.
   */
  projectId: Uuid | null;
  title: string;
  body: string | null;
  spec: Record<string, unknown> | null;
  /**
   * Which pipeline this work flows through, and where it sits on it.
   *
   * Both null for a feature (ARCHITECTURE.md, "One work entity"). A feature is a container, not
   * work:
   * nothing dispatches against it, it carries no changes of its own, and
   * whether it is finished is a question about its stories — which is why
   * it never belonged in a column in the first place.
   */
  pipelineId: Uuid | null;
  stepId: string | null; // references PipelineStep.id, within `pipelineId`
  /**
   * The version of that pipeline it entered on, and finishes on
   * (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
   *
   * Routing reads this, never the pipeline's current version: a save
   * made while this item is halfway down the graph changes where the
   * *next* item goes and not where this one does. Null is an item that
   * entered before its pipeline had a version at all, and routes by the
   * live graph — which is what every item did until versions existed.
   */
  pipelineVersionId: string | null;
  priority: number;
  /**
   * What the packs and the workspace kinds know about this item
   * (KAN-148, KAN-169).
   *
   * The `item_extensions` rows for this item, keyed by extension. The
   * Jira key, id, sync switch and pull-pending marker were four columns
   * on this row until KAN-148; they are the `jira` slot now, read
   * through `jiraStateOf(item)` rather than by hand. The branch and the
   * pull request were two more until KAN-169, and are the `git` slot,
   * read through `gitStateOf(item)` — they were never facts about an
   * item, only about the one workspace kind that cuts branches, and an
   * item on `none` carried them null forever (ARCHITECTURE.md, "One work entity").
   *
   * Always present, `{}` when no pack has said anything — so a reader
   * never has to ask whether the map exists before asking what is in it.
   */
  extensions: ItemExtensions;
  /**
   * When it left the project (KAN-33). Null means live.
   *
   * Distinct from deleted, which leaves no row at all: an archived
   * item keeps its comments, runs, run_events and cost, and putting it
   * back is a restore rather than a rebuild.
   */
  archivedAt: number | null;
  /**
   * When a person parked this item. Null means the scheduler may
   * consider it normally. A hold is deliberately not workflow state:
   * `pipelineId` and `stepId` stay exactly where they are.
   */
  heldAt: number | null;
  /**
   * When this item was created as a preview, or null for real work
   * (EO-313, ARCHITECTURE.md, "Preview").
   *
   * The mark `runs.dryRun` could not carry: that says one run was a
   * rehearsal, and a preview is a whole item walking a whole pipeline so
   * that somebody can watch the machine work before they have signed
   * into anything. Marked, it is kept out of the inbox count, the
   * archive, the day's cost and the `!` marker, dispatched only to the
   * fake provider whatever its agent's backend says, and shown a banner
   * wherever it appears.
   *
   * Deliberately *not* excluded from the scheduler, which is the one
   * thing `archivedAt` beside it does exclude: a preview nothing
   * dispatched would show nobody anything.
   */
  previewAt: number | null;
  /**
   * When this item was filed on a trial pipeline, or null for live work
   * (EO-582, ARCHITECTURE.md, "Trial pipelines").
   *
   * Unlike `previewAt`, nothing about how it runs changes: a trial item
   * runs on its agent's real backend, on a real workspace, through real
   * modules. It is left out of what a person browses — the board, the
   * inbox, the `!` marker, the archive — and its cost counts against the
   * budgets like any other item's.
   */
  trialAt: number | null;
  /**
   * The person who filed it (EO-302, ARCHITECTURE.md, "Identity"), or null where EO does not
   * know — an item written before people existed, or an issue imported
   * from a tracker somebody else filed it in.
   *
   * Never an agent. An agent that proposes work acts at somebody's
   * request and on their machine; the person who approved it is the one
   * who created it.
   */
  createdBy: Uuid | null;
  /**
   * The person it is waiting on (ARCHITECTURE.md, "Identity"). Claiming writes it, which is
   * the seventh story of this phase; null everywhere until then, and
   * the assignee a card shows is still derived from the latest run.
   */
  assigneeId: Uuid | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The acceptance criteria an item declares (EO-213).
 *
 * `spec` is open JSON, so this narrows rather than casts — an item
 * whose criteria were never written, or were written as something other
 * than a list of strings, declares none.
 *
 * Blank entries are dropped, and that is the load-bearing half. "What
 * this item declares" is now asked by three parts of EO that share no
 * infrastructure — the scheduler, which refuses to dispatch a review
 * without any; `summariseCriteriaCoverage`, which measures a review
 * against them; and the Jira description, which writes them out — and
 * two of those already dropped blanks. A list holding one empty string
 * counting as "declared" in the scheduler and as "none" in the coverage
 * table is precisely the disagreement this one definition exists to
 * prevent: EO would dispatch a review it could then never judge.
 */
export function acceptanceCriteriaOf(item: Pick<Item, "spec">, shape?: SpecShape): string[] {
  // Which field holds them is the type's to say (KAN-147): a pack's
  // `Case` whose bar is a `resolution` declares that on its shape, and
  // what reads the criteria reads the declared name. The conventional one
  // is the answer when nothing says otherwise — every item's spec has
  // used it, and a caller with no shape in hand is asking about an item
  // rather than about a type.
  const field = shape === undefined ? undefined : criteriaField(shape);
  const raw = item.spec?.[field?.name ?? "acceptance_criteria"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/**
 * What releases an item from one of its dependency edges (EO-776, EO-775).
 *
 * - `finished`: the dependency stands on a terminal step of its own
 *   pipeline. The default, and what every edge meant before the rule
 *   existed, so leaving it out always means this.
 * - `reached`: the first time the dependency arrives at the edge's
 *   `waitStepId`, or when it finishes, whichever comes first. Latched:
 *   whether it has arrived is read from `transitions`, never stored, so
 *   going back afterwards does not hold anything again.
 * - `none`: never holds. The link stays for the board, the item page
 *   and the agent's dependency summary.
 *
 * A finished dependency releases every edge, whatever its rule.
 */
export const DEPENDENCY_WAITS = ["finished", "reached", "none"] as const;
export type DependencyWait = (typeof DEPENDENCY_WAITS)[number];

export interface ItemDep {
  itemId: Uuid;
  dependsOnId: Uuid;
  wait: DependencyWait;
  /** The step of the dependency's pipeline a `reached` edge waits for; null for `finished` and `none`. */
  waitStepId: string | null;
}
