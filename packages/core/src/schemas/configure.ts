import { z } from "zod";
import { EntryRulesSchema } from "../entryRules.js";
import { PipelineStepViewSchema, StepRouteViewSchema } from "../ipc-schemas.js";
import { ProposedActionsSchema } from "./actionDefinition.js";
import { DiscussionQuestionSchema } from "./discussion.js";
import { ModuleManifestSchema, ModuleTestCaseInputSchema } from "./modules.js";

/**
 * What a module proposal without test cases is refused with (EO-355).
 *
 * Written to the agent, since it is the one that reads it: what is
 * missing, the shape that supplies it, and why it is not optional.
 */
export const PROPOSED_MODULE_NEEDS_TESTS =
  "A proposed module must come with its test cases: at least one entry in `tests`, each { description, source }, where source is " +
  "an ES module whose default export is an async function taking the harness and driving the module with harness.run. " +
  "A module with no tests cannot be approved, so a pipeline naming it could never be published — write the cases and propose it again.";

/**
 * What the pipeline architect returns from `configure`.
 *
 * The second conversational action, after `discuss`, and deliberately its
 * sibling rather than its extension: the product owner talks about *work*
 * and proposes items, while this one talks about *configuration* and
 * proposes a graph. Same conversation machinery, different subject.
 *
 * The important difference from `DiscussionOutputSchema` is what a
 * proposal is. A discussion proposes several independent things — a
 * story here, an amendment there — so its proposals are an array, each
 * approved on its own. A pipeline is one document: its steps, its edges
 * and where work enters are a single shape that `validatePipeline` judges
 * whole, and half a graph is not a smaller graph but a broken one. So
 * there is at most one `draft` per turn, and it is complete.
 */

/**
 * One step of a proposed pipeline.
 *
 * `pipelineId` is omitted rather than asked for. It is a constant for the
 * whole draft that the caller already knows, and every field a model is
 * asked to repeat is a field it can get wrong — the point of constrained
 * generation is to ask for exactly what only the model can supply.
 *
 * `id` is required and must be stable *within the draft*, because the
 * routes reference it. An id that already exists edits that step in
 * place; anything else creates one. `replacePipelineGraph` persists
 * whatever arrives and updates by id, so the architect follows the same
 * convention the configuration screen uses when a person adds a step by
 * hand (`new-…`), which keeps an agent-authored draft and a hand-authored
 * one indistinguishable.
 *
 * `inputs` is omitted for a third reason again (EO-78). The architect
 * draws the graph — which steps exist, who acts, where each result goes.
 * What a module step's declared inputs are set to is somebody's tuning of
 * this installation: how long *this* repository's CI takes. Asking a
 * model to restate those on every draft is asking it to get them wrong,
 * and worse, a draft that simply omitted them would read as "set nothing"
 * and wipe them. Absent from the draft, they are left exactly as they
 * were — the editor carries each step's own values across when a draft is
 * applied.
 *
 * `timeoutMs` is omitted on the same argument (EO-162). How long a step
 * may run is how slow this repository's CI is, not a property of the
 * graph, and a draft that omitted it while the schema demanded one would
 * reset a limit somebody raised on purpose.
 *
 * `workspaceMode` is omitted for the same reason again (EO-296). Whether
 * a step works on a branch or reads the repository is a fact about the
 * disk an installation has, not about the shape of the graph — and a
 * draft that restated it on every turn is a draft that can flip it by
 * accident, which would quietly start cutting branches for a step
 * somebody had set to read only.
 *
 * And `workspaceId` for the strongest version of it yet (EO-301). Which
 * disk a step works on is a UUID the architect has never seen and could
 * only guess at; a draft naming one would either name nothing or name
 * another project's workspace, which is the one thing the save refuses
 * outright.
 *
 * `results` is omitted for a different reason from all of those (EO-310):
 * not because it is a fact about this installation, but because on a
 * human step it is *already in the draft*. A branch out of a step a
 * person acts on is the offer — there is nothing else that could take it
 * — so the results are derived from the routes the draft drew
 * (`resultsFromRoutes`) rather than restated beside them. Asking for both
 * would be asking a model to keep two lists in agreement when
 * `validatePipeline` refuses the graph if it fails, which is a card
 * nobody can apply.
 *
 * `watch` is omitted for now (EO-456): keep checking is new, the
 * architect's prompt does not describe it yet, and a draft that omitted
 * it while the schema carried it would turn off a step somebody set to
 * keep checking. Absent from the draft, the save leaves each step's mode
 * where it was. The help chat's draft adds it back for a step the draft
 * creates (`AssistDraftStepSchema`, EO-516), where there is no mode to
 * lose.
 */
export const DraftStepSchema = PipelineStepViewSchema.omit({
  pipelineId: true,
  inputs: true,
  timeoutMs: true,
  workspaceMode: true,
  workspaceId: true,
  results: true,
  watch: true,
});

/**
 * One declared result of a step, and where it sends the item.
 *
 * `id` is omitted for a stronger reason than `pipelineId`: route ids are
 * regenerated on every save (`replacePipelineGraph`), so any id the model
 * invented would be discarded within the second. Asking for one would be
 * asking for a lie.
 */
export const DraftRouteSchema = StepRouteViewSchema.omit({ id: true, pipelineId: true });

/**
 * The whole proposed graph.
 *
 * `entryStepId` is part of the draft rather than a separate step, because
 * a graph without an entry is one `validatePipeline` refuses (ARCHITECTURE.md, "Vocabulary") —
 * "the first step" must never mean "lowest position", or reordering the
 * columns would silently re-route every new item.
 */
export const PipelineDraftSchema = z.object({
  /** Renames the pipeline. Absent leaves the name alone. */
  name: z.string().min(1).optional(),
  steps: z.array(DraftStepSchema).min(1),
  routes: z.array(DraftRouteSchema).default([]),
  entryStepId: z.string(),
  /**
   * What an item must have to enter (EO-610). Left out keeps the rules
   * the pipeline has; `[]` clears them. On the draft because a draft is
   * how the assistant changes a pipeline, so this is how a person's "make
   * it refuse work with no customer" reaches one.
   */
  entryRules: EntryRulesSchema.optional(),
  /**
   * The steps this draft means to remove, by id (EO-209).
   *
   * There is still no patch form: the document is whole and
   * `validatePipeline` judges it whole. What this adds is *intent*.
   * Without it, omission is the only way to remove a step — so a graph
   * that forgot a step and a graph that decided against one are the same
   * bytes, and EO has nothing to tell them apart by. An agent that meant
   * to keep everything has no way to say so, and its forgetfulness
   * arrives at a person as a considered proposal with a button on it.
   *
   * So a removal is declared, and the engine compares the declaration
   * against what the graph actually leaves out: omitted and declared is a
   * decision, omitted and undeclared is a mistake, and declared while
   * still present is a contradiction. All three are settled in
   * `renderDraft`, before a card exists.
   *
   * Defaulted rather than required, because the ordinary draft removes
   * nothing and a field a model must restate on every turn is a field it
   * can get wrong — the same argument `routes` is defaulted on. Empty
   * therefore means "this draft removes nothing", which is exactly what a
   * graph naming every current step also says.
   */
  removes: z.array(z.string()).default([]),
  /** What changed and why, in the architect's words. Shown above the diff. */
  rationale: z.string().min(1),
});

/**
 * An agent the draft needs and the install does not have.
 *
 * Proposed rather than created, and separately from the graph, because a
 * step owned by a role with no enabled agent is a step that parks every
 * item reaching it forever — `validatePipeline` warns about exactly
 * this. So the agent has to exist before the graph naming its role is
 * published, which makes this an ordered part of the same approval rather
 * than a footnote to it.
 *
 * `instructions` is required. An agent is its prompt: creating one with
 * a placeholder would produce a row that looks staffed and behaves like
 * nothing at all.
 */
export const ProposedAgentSchema = z.object({
  name: z.string().min(1),
  /** Same shape `agents:save` enforces — a role is a slug, not a sentence. */
  role: z.string().regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores."),
  /** Which backend runs it. `fake` is EO's own demo provider. */
  provider: z.enum(["claude", "codex", "fake"]),
  model: z.string().nullable().default(null),
  instructions: z.string().min(1),
});

/**
 * A runtime the draft needs on this machine.
 *
 * A closed pair, mirroring `RUNTIMES` in the main process: EO ships two
 * and adding a third is a code change, so an architect that could name
 * anything would spend its turns offering runtimes that cannot exist.
 *
 * This is a *request for consent*, never an instruction. Installing
 * fetches hundreds of megabytes from npm and grants durable update
 * consent, which is a decision that belongs to the person — so `why` is
 * required: it is what they are being asked to agree to.
 */
export const ProposedRuntimeSchema = z.object({
  id: z.enum(["claude", "codex"]),
  why: z.string().min(1),
});

/**
 * A module the draft needs and the catalog does not have (KAN-107).
 *
 * The same shape as a proposed agent, and there for the same reason: a
 * step naming a module that does not exist parks every item reaching
 * it, so the module has to be saved before the graph naming it is
 * published. Worse than the agent case, in fact — an unstaffed role is a
 * warning, an unknown module id is a step nothing can dispatch at all.
 *
 * When to propose one of these rather than an agent is the whole
 * judgement this feature turns on, and it lives in the prompt where the
 * architect can act on it: *before agents existed, would this have been
 * a script?* A deploy would have been. Reviewing a diff would not.
 */
export const ProposedModuleSchema = z.object({
  name: z.string().min(1),
  /** Stable across machines; what an exported pipeline names. */
  slug: z.string().regex(/^[a-z0-9_-]+$/, "Use lowercase letters, digits, hyphens and underscores."),
  /**
   * Required, and the field that makes the catalog worth having: this is
   * what the architect reads next time to decide whether the module it is
   * about to write already exists.
   */
  description: z.string().min(1),
  /** The module source. Node builtins only; `ctx` is the whole surface. */
  code: z.string().min(1),
  manifest: ModuleManifestSchema,
  /**
   * The script this was written from, when the person handed one over.
   *
   * Provenance, not a backup. Nothing can establish that a translation is
   * faithful — invariant #5 prefers what the engine can check over what
   * an agent asserts — so keeping the original is what leaves the
   * translation diffable rather than a one-time guess.
   */
  originalScript: z.string().nullable().default(null),
  /** Why this is a module rather than an agent, in the architect's words. */
  why: z.string().min(1),
  /**
   * The module's test cases, written with it (EO-355). At least one.
   *
   * A module is approved by running its tests (EO-353), and one with
   * none cannot be approved at all — so a proposal without them is a
   * card whose module can never be approved, and the graph naming it a
   * graph that can never be published. Refused here, in the schema,
   * because that is where the refusal reaches the agent: a result that
   * fails its schema is sent straight back with the message, and the
   * next attempt can add the cases. A rejection posted into the thread
   * would be read by the person, and not by the agent.
   *
   * The message is the same whether `tests` is missing or empty: the
   * agent can act on either in one way.
   */
  tests: z
    .array(ModuleTestCaseInputSchema, { error: (issue) => (issue.input === undefined ? PROPOSED_MODULE_NEEDS_TESTS : undefined) })
    .min(1, PROPOSED_MODULE_NEEDS_TESTS),
});

/**
 * One turn of a configuration conversation.
 *
 * `message` is always present and a turn that proposes nothing is the
 * normal case, exactly as in a discussion: this action exists to
 * continue, not to finish.
 *
 * The ask-or-propose refinement is the same one `DiscussionOutputSchema`
 * carries, and it matters more here. A pipeline is published as a whole
 * and dispatches real work; a draft built on top of unanswered questions
 * is a guess with a Publish button on it.
 */
export const ConfigureOutputSchema = z
  .object({
    /** What the architect says back, in markdown. */
    message: z.string().min(1),
    /**
     * Decisions to put in front of the person, asked at once.
     *
     * Reuses the discussion's card rather than declaring a parallel one:
     * "which role owns QA?" and "per API key or per account?" are the
     * same kind of question, and the screen renders them with the same
     * component.
     */
    questions: z.array(DiscussionQuestionSchema).max(6).default([]),
    /** The proposed graph. Absent on an ordinary conversational turn. */
    draft: PipelineDraftSchema.optional(),
    /** Agents the draft needs that do not exist yet. */
    agents: z.array(ProposedAgentSchema).default([]),
    /** Runtimes the draft needs that are not installed. */
    runtimes: z.array(ProposedRuntimeSchema).default([]),
    /**
     * Modules the draft needs that the catalog does not have (KAN-107).
     *
     * Saved before the graph, like an agent — see `ProposedModuleSchema`.
     */
    modules: z.array(ProposedModuleSchema).default([]),
    /**
     * Action definitions the draft's steps rely on that the installation
     * does not have, or has differently (EO-426).
     *
     * Beside the graph rather than written before it, and unlike an
     * agent or a module **nothing is saved until Publish**: a definition
     * decides which results a step must route, so one written ahead of
     * the graph that routes them would hold every other step using that
     * action to keys nobody has agreed to yet. Publish writes each of
     * these and the pipeline in one transaction, or neither.
     *
     * An entry for a role and action that already has a definition
     * replaces it, and the card says so with the keys it adds and
     * removes.
     */
    actions: ProposedActionsSchema.default([]),
  })
  .refine((output) => output.questions.length === 0 || output.draft === undefined, {
    message: "a turn either asks or proposes — a draft built on unanswered questions is a guess with a button on it",
  })
  .refine(
    (output) =>
      output.draft !== undefined || (output.agents.length === 0 && output.runtimes.length === 0 && output.modules.length === 0 && output.actions.length === 0),
    {
      message: "agents, runtimes, modules and actions are proposed in support of a draft; without one there is nothing for them to staff",
    },
  );

export type DraftStep = z.infer<typeof DraftStepSchema>;
export type DraftRoute = z.infer<typeof DraftRouteSchema>;
export type PipelineDraft = z.infer<typeof PipelineDraftSchema>;
export type ProposedAgent = z.infer<typeof ProposedAgentSchema>;
export type ProposedRuntime = z.infer<typeof ProposedRuntimeSchema>;
export type ProposedModule = z.infer<typeof ProposedModuleSchema>;
export type ConfigureOutput = z.infer<typeof ConfigureOutputSchema>;
