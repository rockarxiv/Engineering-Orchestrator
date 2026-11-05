import { z } from "zod";
import { ProposedActionsSchema } from "./actionDefinition.js";
import { AssistCardSchema, KEEP_PIPELINE_CARD_KIND } from "./assistCard.js";
import { AssistTrialPlanSchema, trialPlanProblems } from "./assistTrial.js";
import { DraftRouteSchema, DraftStepSchema, PipelineDraftSchema, ProposedModuleSchema } from "./configure.js";
import { DiscussionProposalSchema, DiscussionQuestionSchema } from "./discussion.js";
import { AssistModuleChangeSchema } from "./moduleChange.js";
import { StepInputsSchema } from "./modules.js";
import { PipelineIconSchema } from "./pipelines.js";
import { WorkspaceModeSchema } from "./workspaces.js";
import { StepWatchSchema } from "../watch.js";

/**
 * What a draft says for "Works on" when it means the item's own disk
 * (EO-520) — what `workspaceId: null` means on a step.
 *
 * A word rather than `null`, for invariant #12's sake: Codex's strict
 * output writes every optional field, as `null` when it has nothing to
 * say, so `null` cannot also mean "put this step back on the item's
 * workspace" without every Codex draft saying it about every step.
 */
export const ITEM_WORKSPACE = "item";

/** What a draft says for a step's time limit when it means EO's default (EO-520) — `timeoutMs: null` on a step. A word, for `ITEM_WORKSPACE`'s reason. */
export const DEFAULT_TIME_LIMIT = "default";

/** What a draft says for keep checking when it means the step runs once (EO-520) — `watch: null` on a step. A word, for `ITEM_WORKSPACE`'s reason. */
export const RUNS_ONCE = "off";

/**
 * One step of a draft raised in the assistant's room (EO-381).
 *
 * `DraftStepSchema`, plus the values the configuration screen's draft
 * deliberately leaves out: how long a module step may run (EO-162), what
 * it sets for the inputs its module or builtin declares (EO-78, EO-507),
 * whether it keeps checking (EO-456, EO-516), which disk it works on
 * (EO-301) and whether it works on a branch or reads the repository
 * (EO-296).
 *
 * They are left out *there* because on a step that already exists they
 * are somebody's setting of this installation, and a draft that had to
 * restate them could reset them. Here every one is optional, and absent
 * means exactly that: the step keeps what it has. So a draft changes a
 * setting only by naming it, which is what lets the help chat tune a step
 * that already exists (EO-520) — the pipeline editor is going, and these
 * are the settings it was the only way to change. Every one a draft sets
 * on an existing step is listed on the card as old → new, and Publish
 * applies exactly those.
 *
 * None of them is nullable, and deliberately: a Codex agent writes every
 * optional field, as `null` where it has nothing to say, and that `null`
 * is read back as absent. So "back to EO's default", "runs once" and "the
 * item's own" are words (`DEFAULT_TIME_LIMIT`, `RUNS_ONCE`,
 * `ITEM_WORKSPACE`) rather than a `null` that would mean them on one
 * backend and "keep it" on the other.
 */
export const AssistDraftStepSchema = DraftStepSchema.extend({
  /** A module step's time limit, in milliseconds, or `"default"` for EO's default. Absent keeps the step's own. */
  timeoutMs: z.union([z.number().int().positive(), z.literal(DEFAULT_TIME_LIMIT)]).optional(),
  /**
   * A module or builtin step's values for the inputs its module or builtin
   * declares — the whole set: an input left out of it is unset. Absent
   * keeps the step's own.
   */
  inputs: StepInputsSchema.optional(),
  /** A builtin or module step's keep-checking settings, or `"off"` to make it run once. Absent keeps the step's own. */
  watch: z.union([StepWatchSchema, z.literal(RUNS_ONCE)]).optional(),
  /** "Works on": a workspace id from `workspace_list`, `"none"` for no disk, or `"item"` for the item's own. Absent keeps the step's own. */
  workspaceId: z.string().min(1).optional(),
  /** On a repository, `isolated` works on a branch of its own and `read` reads the repository as it stands. Absent keeps the step's own. */
  workspaceMode: WorkspaceModeSchema.optional(),
});

/**
 * One route of a draft raised in the assistant's room (EO-520).
 *
 * `DraftRouteSchema`, plus "Needs a reason" for a branch out of a
 * person's step. On a human step a branch *is* the result a person is
 * offered (EO-310), so whether taking it needs a reason typed is said on
 * the branch. Absent keeps what the result already declares, and a new
 * result gets EO's default — a reason for anything but a success.
 */
export const AssistDraftRouteSchema = DraftRouteSchema.extend({
  requiresComment: z.boolean().optional(),
});

/**
 * Which pipeline a draft is for (EO-381).
 *
 * One of the two, never both: an existing pipeline by id, or a pipeline
 * that does not exist yet, by the name it will be created with. Absent
 * altogether, a draft is about the board the person was on when they
 * asked — which is what every draft meant before this field existed.
 *
 * A name for a new one rather than an id, because there is no id to give:
 * the pipeline is created when the person presses Publish, and not
 * before, so a draft nobody publishes leaves nothing behind.
 */
export const AssistDraftTargetSchema = z
  .object({
    /** An existing pipeline, by the id `pipeline_get` and `pipelines_list` answer with. */
    pipelineId: z.string().min(1).optional(),
    /** A pipeline to create on Publish, by its name. Refused if the project already has one called that. */
    newPipeline: z.string().trim().min(1).optional(),
  })
  .refine((target) => (target.pipelineId === undefined) !== (target.newPipeline === undefined), {
    message: "a draft's target names an existing pipeline by `pipelineId` or a new one by `newPipeline` — exactly one of the two",
  });

/**
 * A pipeline draft raised in the assistant's room (EO-381).
 *
 * The configuration screen's draft, with the differences that come of
 * this room not being attached to any one pipeline the way that panel
 * is, and of there being no editor behind its card: it can say which
 * pipeline it is for (`target`); its steps can carry the settings that
 * panel's editor would otherwise have been there to set
 * (`AssistDraftStepSchema`), and its routes "Needs a reason"
 * (`AssistDraftRouteSchema`); and it can change the pipeline's icon and
 * restore a version with who its person steps waited on (EO-520).
 */
export const AssistDraftSchema = PipelineDraftSchema.extend({
  steps: z.array(AssistDraftStepSchema).min(1),
  routes: z.array(AssistDraftRouteSchema).default([]),
  /** Which pipeline this replaces or creates. Absent is the board the person asked from. */
  target: AssistDraftTargetSchema.optional(),
  /** The pipeline's icon (EO-520). Absent leaves it alone. */
  icon: PipelineIconSchema.optional(),
  /**
   * The version this draft restores, by number (EO-520).
   *
   * What the editor's History sent as `restoredFrom` (EO-359): the graph
   * is the draft's own, and Publish puts back who each of that version's
   * person steps waited on — read from the version's own document, never
   * from anything the draft says. Absent is an ordinary draft, which
   * leaves who each step waits on where it is.
   */
  restoredFrom: z.number().int().positive().optional(),
  /**
   * For a draft resolving a held template update (EO-534): each step the
   * template adds that this draft gives a fresh id — because another
   * pipeline holds the template's — by the template's step id, mapped to
   * the draft's. Publishing records it with the pipeline's new base, so a
   * later template version still knows the step as the template's.
   * Absent everywhere else: a step under the template's own id needs no
   * entry.
   */
  templateStepIds: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type AssistDraftStep = z.infer<typeof AssistDraftStepSchema>;
export type AssistDraftRoute = z.infer<typeof AssistDraftRouteSchema>;
export type AssistDraftTarget = z.infer<typeof AssistDraftTargetSchema>;
export type AssistDraft = z.infer<typeof AssistDraftSchema>;

/**
 * What the system agent returns from `assist` — the assistant's room.
 *
 * The third conversational action, and deliberately the union of the two
 * that came before rather than a third dialect. Discussions talks about
 * *work* and proposes items; the architect panel talks about
 * *configuration* and proposes a graph. This room is neither subject and
 * both: you are on whatever screen you are on, and the thing you want to
 * say is about what is in front of you — an item, a pipeline, a
 * setting. A turn that could only propose one of the two would send
 * somebody to another screen mid-sentence, which is the whole thing the
 * widget exists to avoid.
 *
 * Every field is a piece that already exists, imported rather than
 * restated. That is not tidiness: `DiscussionQuestionSchema` is what
 * makes a question a card with alternatives on it rather than a sentence,
 * `PipelineDraftSchema` (which `AssistDraftSchema` extends) is what
 * `validatePipeline` and `pipeline:save` already judge, `ProposedModuleSchema`
 * is the module the Architecture panel already saves, and `DiscussionProposalSchema` is what
 * `applyDiscussionProposal` already builds from. A parallel declaration
 * here would drift from one of the three within a story or two, and the
 * drift would surface as a card that cannot be applied — the worst
 * outcome available, since it is offered with a button on it.
 *
 * Nothing here is applied by returning it. A draft is published through
 * the same `pipeline:save` the configuration screen uses and a proposal
 * becomes items through the same approval path Discussions uses; this
 * schema only says what a turn is allowed to hand back.
 */
export const AssistOutputSchema = z
  .object({
    /** What the agent says back, in markdown. Always present: this action exists to continue, not to finish. */
    message: z.string().min(1),
    /**
     * Decisions to put in front of the person, asked at once.
     *
     * The discussion's card, not a parallel one — "which role owns QA?"
     * and "per API key or per account?" are the same kind of question,
     * and the panel renders them with the same component. Bounded at six
     * for the reason both other rooms are: past that a card stops being a
     * choice and becomes a form.
     */
    questions: z.array(DiscussionQuestionSchema).max(6).default([]),
    /**
     * A proposed pipeline graph. Absent on an ordinary turn.
     *
     * At most one, and complete, exactly as `configure` has it: a
     * pipeline is one document that `validatePipeline` judges whole, and
     * half a graph is not a smaller graph but a broken one. It may say
     * which pipeline it is for, and its steps their settings — see
     * `AssistDraftSchema` (EO-381, EO-520).
     */
    draft: AssistDraftSchema.optional(),
    /**
     * Other drafts of the same pipeline, offered beside `draft` as
     * alternatives to it (EO-534) — at most two, so a turn offers at most
     * three. Each is a whole graph `validatePipeline` judges on its own,
     * posted as a draft card of its own after `draft`, and any one of
     * them is what Publish writes. `draft` is the one recommended.
     *
     * What resolving a held template update offers: a merge of the
     * person's intent and the template's, the template's version as it
     * ships, and so on. Each says in its `rationale` what it keeps from
     * either side.
     *
     * Only beside a `draft`, for the same pipeline, and with no `modules`
     * or `actions`: those are saved by, or with, one draft's Publish, and
     * three cards sharing them would be three decisions resting on one.
     *
     * Optional rather than defaulted, for `modules`' reason.
     */
    alternatives: z.array(AssistDraftSchema).max(2).optional(),
    /**
     * Modules the catalog does not have (EO-381, EO-398).
     *
     * The Architecture panel's own shape, `ProposedModuleSchema`, test
     * cases and all, so a module proposed here and one proposed there are
     * the same document. Saved unapproved, with their tests, when the
     * reply is posted — approving one stays a person's act, and a draft's
     * Publish is refused until every one of its modules has been.
     *
     * Beside a `draft` they are the modules that draft's steps run.
     * Without one, each is a proposal in its own right (EO-398): a module
     * somebody asked for on its own, which arrives in the chat as a card
     * with its code behind View code and an Approve button. It used to be
     * refused there, which left the assistant writing straight to the
     * catalog and the chat holding a sentence about where to go and look.
     *
     * Optional rather than defaulted, so an ordinary turn's result reads
     * back exactly as it always did.
     */
    modules: z.array(ProposedModuleSchema).optional(),
    /**
     * Action definitions the draft's steps rely on (EO-426).
     *
     * `configure`'s own field, with its rule: nothing is saved when the
     * card is posted, and Publish writes every one of these and the
     * pipeline in one transaction or neither. So a pipeline that needs a
     * new action arrives as one card, rather than as a draft resting on
     * a definition written through a tool before anybody read it.
     *
     * Only beside a `draft`, unlike `modules`: a definition proposed on
     * its own would be a card with nothing to publish it with, and one
     * somebody asks for on its own is written through the `eo_admin`
     * server instead.
     *
     * Optional rather than defaulted, for `modules`' reason.
     */
    actions: ProposedActionsSchema.optional(),
    /**
     * Work to create or change, each entry approved on its own.
     *
     * An array where `draft` is singular, and the asymmetry is the same
     * one the two rooms already have: a story here and an amendment there
     * are independent decisions, and a person accepts them one at a time.
     */
    proposals: z.array(DiscussionProposalSchema).default([]),
    /**
     * A change to one module the catalog already holds (EO-418). Null on
     * every other turn.
     *
     * `modules` cannot say this. It saves when the card is posted, so it
     * is rightly refused over a module somebody approved, wrote or
     * imported — and that left "just change it" with no answer but a
     * walk to Settings → Modules. A change is the other kind of card: a
     * diff of the module's code and of its manifest against what is
     * saved, with nothing written until the person presses Apply. So any
     * module in the catalog may be changed this way, approved or not,
     * whoever wrote it.
     *
     * The scenario chat's own shape (`ModuleChangeSchema`), plus what
     * that room has no need to say: which module, the test cases the
     * change adds or replaces, and the ones it removes, by id.
     *
     * At most one, and on its own: no `draft` and no `modules` beside
     * it. A draft is published against modules as they are approved, and
     * a module proposed in `modules` is saved at once — either beside a
     * change nobody has applied yet would be a card resting on a module
     * that may never become what the change says.
     *
     * Nullable with a default rather than optional, on purpose — the
     * note on `ScenarioOutputSchema` (invariant #12).
     */
    change: AssistModuleChangeSchema.nullable().default(null),
    /**
     * Something only a person may do, as a card whose button does it
     * (EO-521) — exporting a pipeline to a file, importing an attached
     * one, deleting one, or discarding this machine's edits to one the
     * organisation manages; letting its webhook items through unread, or
     * setting a step's own secret or variable (EO-522), whose value the
     * person types on the card; adding, changing or removing an item type
     * (EO-523). Null on every other turn.
     *
     * Nothing is done by returning it: see `AssistCardSchema`. At most
     * one, and on its own — no `draft`, `modules`, `change` or
     * `proposals` beside it — because each of those is a card with a
     * button of its own, and two buttons from one turn that both change
     * pipelines would be two decisions offered as one.
     *
     * Nullable with a default rather than optional, for `change`'s reason.
     */
    card: AssistCardSchema.nullable().default(null),
    /**
     * How the `draft` is to be tested with real runs (EO-587), where the
     * person asked for that: the test items, where each must end, and how
     * each step runs on them — see `AssistTrialPlanSchema`. Null on every
     * other turn, and on a draft the person chose not to test, which is
     * offered as the publish card it always was.
     *
     * Beside a `draft` it makes that draft's card a **design card**:
     * Approve design, and no Publish. Pressing it makes the trial
     * pipeline, grants the draft's modules permission to run on it, files
     * the test items and starts the first round.
     *
     * Only beside a `draft`, and with no `alternatives`: a design is one
     * shape the person approves, and three cards sharing one plan would be
     * three decisions resting on one.
     *
     * Nullable with a default rather than optional, for `change`'s reason.
     */
    trial: AssistTrialPlanSchema.nullable().default(null),
  })
  .refine(
    (output) =>
      output.questions.length === 0 ||
      (output.proposals.length === 0 &&
        output.draft === undefined &&
        (output.modules ?? []).length === 0 &&
        (output.actions ?? []).length === 0 &&
        output.change === null &&
        output.card === null),
    {
      message: "a turn either asks or proposes — a proposal built on unanswered questions is a guess with a button on it",
    },
  )
  .refine((output) => output.draft !== undefined || (output.actions ?? []).length === 0, {
    message:
      "`actions` are the definitions a `draft`'s steps rely on, and are written when that draft is published; without a draft there is nothing to publish them with. " +
      "Return the draft beside them, or save a definition on its own through the `eo_admin` server",
    path: ["actions"],
  })
  .refine((output) => output.change === null || (output.draft === undefined && (output.modules ?? []).length === 0), {
    message:
      "a `change` to a module that exists comes on its own: no `draft` and no `modules` in the same reply. Return the change, and propose the draft or the new module once the person has applied it",
    path: ["change"],
  })
  .refine(
    (output) =>
      output.card === null ||
      (output.draft === undefined && (output.modules ?? []).length === 0 && output.change === null && output.proposals.length === 0) ||
      // Keeping one's own pipeline is the alternative to the drafts that
      // resolve a held template update (EO-534), offered beside them.
      (output.card.kind === KEEP_PIPELINE_CARD_KIND && (output.modules ?? []).length === 0 && output.change === null && output.proposals.length === 0),
    {
      message:
        "a `card` comes on its own: no `draft`, `modules`, `change` or `proposals` in the same reply. Return the card, and propose the rest once the person has pressed it. " +
        `The one exception is a \`${KEEP_PIPELINE_CARD_KIND}\` card, which may come beside the drafts that resolve a held template update`,
      path: ["card"],
    },
  )
  .refine((output) => (output.alternatives ?? []).length === 0 || output.draft !== undefined, {
    message: "`alternatives` are other drafts offered beside `draft`; without a `draft` there is nothing for them to be alternatives to. Put the recommended one in `draft`",
    path: ["alternatives"],
  })
  .refine((output) => (output.alternatives ?? []).length === 0 || ((output.modules ?? []).length === 0 && (output.actions ?? []).length === 0), {
    message:
      "`alternatives` come with no `modules` and no `actions`: those are saved with one draft, and alternative drafts cannot share them. Propose the one draft that needs them on its own",
    path: ["alternatives"],
  })
  .refine((output) => (output.alternatives ?? []).every((alternative) => sameTarget(alternative.target, output.draft?.target)), {
    message: "every one of `alternatives` is for the pipeline `draft` is for: give each the same `target` as `draft`",
    path: ["alternatives"],
  })
  .superRefine((output, context) => {
    // A trial plan is a plan of one draft (EO-587).
    if (output.trial === null) return;
    if (output.draft === undefined) {
      context.addIssue({
        code: "custom",
        path: ["trial"],
        message: "`trial` is how a `draft` is tested; without a draft there is nothing to test. Return the draft beside it, or ask the person first",
      });
      return;
    }
    if ((output.alternatives ?? []).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["trial"],
        message: "a `trial` comes with one `draft` and no `alternatives`: the person approves one design. Settle which draft first, then plan its test",
      });
    }
    for (const problem of trialPlanProblems(output.draft, output.trial)) context.addIssue({ code: "custom", path: ["trial"], message: problem });
  });

/** Whether two drafts say the same thing about which pipeline they are for. */
function sameTarget(a: AssistDraftTarget | undefined, b: AssistDraftTarget | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export type AssistOutput = z.infer<typeof AssistOutputSchema>;
/** An `assist` result as an agent may write it, before the defaults are filled in: Claude leaves `change` out where Codex writes `null`. */
export type AssistReply = z.input<typeof AssistOutputSchema>;

/**
 * A module a draft card is waiting on (EO-399).
 *
 * A draft can depend on a module nobody has approved two ways: one the
 * same reply proposed, which its step names by slug, and one already in
 * the catalog, which its step names by id. Either way the card says the
 * same thing about it — what it is called, and why Publish is waiting.
 *
 * `unapproved` is in the catalog and nobody has approved it; the card
 * offers Approve. `gone` was proposed with the draft and has since been
 * deleted, so there is nothing to approve and the draft has to be asked
 * for again.
 *
 * `id` is null only for a module that is in no catalog at all. `slug` is
 * what the card reads the catalog by, since it is the one name a module
 * has both before it is saved and after.
 */
export const AssistWaitingModuleSchema = z.object({
  id: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  state: z.enum(["unapproved", "gone"]),
});

export type AssistWaitingModule = z.infer<typeof AssistWaitingModuleSchema>;
