import { z } from "zod";
import { ClarificationQuestionSchema } from "./clarification.js";
import { SettledDecisionSchema } from "./intake.js";
import { ItemPrioritySchema } from "./priority.js";
import { PlannedStorySchema } from "./refine.js";

/**
 * A reference to an item that already exists, by key.
 *
 * Deliberately not a strict `[A-Z]+-\d+`: the prefix half is a repository
 * or project setting a human types (`projects.key_prefix`), so anything
 * that assumes its shape is asserting something this codebase does not
 * enforce anywhere else. What *is* structural is the trailing counter,
 * and checking only that is enough to catch the failure that matters —
 * a model answering with an item's title where its key was asked for.
 */
const ItemKeySchema = z
  .string()
  .trim()
  .min(1)
  .regex(/-\d+$/, 'must be a ticket key, like "EO-42"');

/**
 * Which pipeline the work should flow through: its name is preferred, and
 * its id is accepted.
 *
 * Required when the project has more than one usable pipeline, and may
 * be left out when it has one — the work then lands on that one, which is
 * not a guess (EO-441). The schema cannot say which, because it does not
 * know the project: a reply that leaves it out where there is a choice to
 * make is sent back to the agent before its card is posted, as one naming
 * a pipeline that does not exist is. Guessing silently would put work on
 * a pipeline nobody chose, and every step of that pipeline would then be
 * the wrong step.
 *
 * The name is preferred because it is what the product owner is told and
 * what a person reads on the card. An id is accepted as well (EO-440),
 * because agents send one anyway — `default` for Delivery — and a
 * proposal right in every other respect should not be refused for it.
 * `resolvePlacement` matches the name first (trimmed, case-insensitive),
 * then the id, so a value that is one pipeline's name and another's id
 * means the one with that name. A value that is neither is sent back to
 * the agent before its card is posted.
 */
const PipelineNameSchema = z.string().trim().min(1);

/**
 * A whole feature, decomposed up front (KAN-4 / refine).
 *
 * `stories` is the refine path's own story shape rather than a parallel declaration,
 * so `buildProposal` and `applyApprovedProposal` accept a discussion
 * proposal without knowing one exists — the touches merge, the cycle
 * check and the story creation are all the refine path's, reused. That
 * also means `depends_on` here is *indices into this array*, matching
 * `refine`, because these stories do not exist yet.
 *
 * `PlannedStorySchema` — `ProposedStorySchema` with the base branch a
 * person may name for a story (EO-364) — and not `RefineStorySchema`: the two Jira fields
 * that schema gained in EO-124 belong to a *submitter*, and this shape
 * is handed to a provider as the `discuss` output schema. An agent in a
 * conversation about work that does not exist yet has no issue key to
 * give, and showing it the field is how it comes to invent one.
 */
const NewFeatureProposalSchema = z.object({
  action: z.literal("new_feature"),
  /** Which pipeline the stories flow through. The feature itself joins none (ARCHITECTURE.md, "One work entity"). */
  pipeline: PipelineNameSchema.optional(),
  title: z.string().min(1),
  /** The feature in the agent's own words. Pinned on the created item, exactly as `intake` pins it. */
  understanding: z.string().min(1),
  decisions: z.array(SettledDecisionSchema).default([]),
  /**
   * The feature's own priority (EO-568). Left out, it is 0. Its stories
   * do not inherit it: each carries its own, and one that says nothing
   * is 0 whatever the feature's is.
   */
  priority: ItemPrioritySchema.optional(),
  /**
   * The outside issue the feature belongs to, as a plain label — PROJ-123,
   * a GitHub issue (EO-739). Written onto the feature's `git` extension;
   * its stories carry none of their own and read it through
   * `effectiveReference`, which is why `PlannedStorySchema` has no such
   * field. Trimmed, a blank one is none, and one `referenceProblem`
   * refuses is sent back before the card is posted. A plain string for
   * the reason `base_branch` is one.
   */
  reference: z.string().optional(),
  /**
   * Who is asked to review the pull requests of this feature's stories,
   * in place of the repository's default reviewers (EO-743). Written onto
   * the feature's `git` extension, and its stories read it through
   * `effectiveReviewers`, which is why `PlannedStorySchema` has no such
   * field. Normalised as `item_update`'s are (`normaliseReviewers`), and
   * an entry it refuses is sent back before the card is posted. `[]` asks
   * nobody; left out, the repository's default is read.
   */
  reviewers: z.array(z.string()).optional(),
  /** Each may name a `base_branch` to be cut from (EO-364), or an `existing_branch` to work on (EO-365) — see `PlannedStorySchema`. */
  stories: z.array(PlannedStorySchema).min(1),
});

/**
 * What every proposal that creates a single item shares.
 *
 * `parent` is the whole point of this half of the feature: "add a story
 * to the rate limiting feature" is a story whose parent already exists.
 * Optional, because standalone work is still work — a bug found in
 * something nobody modelled as a feature has no parent to name.
 */
const attachable = {
  /** An existing *feature* item's key. Absent means standalone. */
  parent: ItemKeySchema.optional(),
  pipeline: PipelineNameSchema.optional(),
  title: z.string().min(1),
  body: z.string(),
  /**
   * How soon it should be picked up (EO-568). Left out, it is 0, as every
   * item proposed before this field was; setting it here saves the
   * amendment that used to follow every urgent proposal.
   */
  priority: ItemPrioritySchema.optional(),
  /**
   * The outside issue this item belongs to, as a plain label (EO-739) —
   * see `NewFeatureProposalSchema.reference`. Under a feature, left out
   * means the feature's is read.
   */
  reference: z.string().optional(),
  /**
   * Who is asked to review this item's pull request (EO-743) — see
   * `NewFeatureProposalSchema.reviewers`. Left out, the feature's are
   * read, else the repository's default; `[]` asks nobody.
   */
  reviewers: z.array(z.string()).optional(),
};

const NewStoryProposalSchema = z.object({
  action: z.literal("new_story"),
  ...attachable,
  /** At least one, for the reason `RefineStorySchema` gives: nothing downstream can check the implementer's claim without it. */
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  /**
   * Existing item **keys**, unlike `RefineStorySchema.depends_on`,
   * which holds indices.
   *
   * The difference is real rather than cosmetic: a refine plan is a
   * closed set of stories that do not exist yet, so indices are the only
   * thing that can be said. This story is being attached to a graph
   * that is already running, and the things it can depend on are rows.
   */
  depends_on: z.array(ItemKeySchema).default([]),
  /** Same contract as `RefineStorySchema.touches` — repository-relative paths, no spaces. */
  touches: z.array(z.string().min(1).regex(/^\S+$/, "must be a repository-relative path, with no spaces")).default([]),
  /** Which repository, by name, on a project spanning several (KAN-17). Ignored when there is one. */
  repository: z.string().optional(),
  /**
   * The branch to cut this story's branch from and open its pull request
   * against, when it is not the repository's base branch (EO-364).
   * `RefineStorySchema.base_branch` says why it is a plain string.
   */
  base_branch: z.string().optional(),
  /**
   * A branch that already exists, to work on instead of cutting one
   * (EO-365). `RefineStorySchema.existing_branch` says what EO does with
   * it.
   */
  existing_branch: z.string().optional(),
});

const NewBugProposalSchema = z.object({
  action: z.literal("new_bug"),
  ...attachable,
  /**
   * The same four required fields `BugIntakeSchema` demands, for the
   * same reason: the pinned decision on KAN-4 is that an underspecified
   * bug report is not accepted, and a bug reaching `todo` from here
   * skips intake entirely.
   */
  steps_to_reproduce: z.string().min(1),
  expected: z.string().min(1),
  actual: z.string().min(1),
  environment: z.string().min(1),
  /**
   * Accepted, not demanded — the difference from `NewStoryProposalSchema`,
   * which requires at least one (EO-205).
   *
   * A bug filed without criteria is still a legitimate bug: the four
   * fields above are what make a bug report usable, and demanding a
   * criterion on top would refuse reports people should be able to
   * file. But a bug *with* criteria is the one thing that lets a
   * rejection close over something checkable — with none declared the
   * reviewer improvises them, which is what EO-204 cost eleven rounds
   * of. So they are kept when they arrive, and nothing here asks for
   * them when they do not.
   */
  acceptance_criteria: z.array(z.string().min(1)).default([]),
  repository: z.string().optional(),
});

/**
 * An edit to an item that already exists.
 *
 * Every field is optional and the refinement demands at least one,
 * because "what changed" is the entire payload — a patch that patches
 * nothing is a model going through the motions, and it would otherwise
 * validate and produce an approvable card that does nothing.
 *
 * `state` is deliberately absent and cannot be added: `updateItem`
 * refuses to write it (invariant 1 — only `transitionItem` moves an
 * item), and an architectural test enforces that. An amendment
 * changes what an item *says*, never where it is.
 */
const AmendProposalSchema = z
  .object({
    action: z.literal("amend"),
    item: ItemKeySchema,
    /**
     * Why the change is wanted, in the human's terms.
     *
     * Required, and the only required field besides the key. An
     * amendment lands on someone else's item — often work an agent is
     * about to pick up — and arrives as a comment there. A diff with no
     * reason is not reviewable by whoever finds it.
     */
    why: z.string().min(1),
    title: z.string().min(1).optional(),
    body: z.string().optional(),
    acceptance_criteria: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Held to the rule `items:update` applies (EO-568). It was any
     * integer, so an amendment could carry a negative one that was
     * approvable on its card and refused only when accepted.
     */
    priority: ItemPrioritySchema.optional(),
  })
  .refine(
    (proposal) =>
      proposal.title !== undefined ||
      proposal.body !== undefined ||
      proposal.acceptance_criteria !== undefined ||
      proposal.priority !== undefined,
    { message: "an amendment must change at least one of title, body, acceptance_criteria or priority" },
  );

/**
 * A change to the dependency graph, with no change to any item's
 * content.
 *
 * Separate from `amend` because the guards differ: content cannot be
 * edited under a running implementer, while an edge is about ordering
 * and is checked against the *live* graph for cycles instead.
 */
const ReorderProposalSchema = z
  .object({
    action: z.literal("reorder"),
    item: ItemKeySchema,
    /** Keys this item should wait for. */
    add_depends_on: z.array(ItemKeySchema).default([]),
    /** Keys it should stop waiting for. */
    remove_depends_on: z.array(ItemKeySchema).default([]),
    why: z.string().min(1),
  })
  .refine((proposal) => proposal.add_depends_on.length > 0 || proposal.remove_depends_on.length > 0, {
    message: "a reorder must add or remove at least one dependency",
  });

/**
 * One thing the product owner proposes doing, for a human to approve.
 *
 * Discriminated on `action` rather than on `type` (which `intake` uses)
 * because the axis is different: `intake` classifies *what a request
 * is*, while this says *what to do about it* — and "add a story under
 * EO-42" and "amend EO-45" are not classifications of anything.
 */
export const DiscussionProposalSchema = z.discriminatedUnion("action", [
  NewFeatureProposalSchema,
  NewStoryProposalSchema,
  NewBugProposalSchema,
  AmendProposalSchema,
  ReorderProposalSchema,
]);

/**
 * A choice the product owner needs made before it can go further.
 *
 * **`options` is required, and that is the whole definition of what
 * belongs here.** A card is a decision between alternatives someone can
 * click; a question with nothing to click is just something you said, and
 * belongs in `message` where the person answers it by typing — which is
 * what a conversation already is. "What are you trying to build?" is not
 * a card. "Per API key or per account?" is.
 *
 * Enforcing that in the schema rather than in the prompt is deliberate.
 * Asked in prose, the rule is advice; asked as a required field with a
 * minimum of two entries, a model that cannot name the alternatives
 * cannot produce the shape at all, and writes a sentence instead.
 *
 * Two other differences from `ClarificationQuestionSchema`, which pipeline
 * agents use. Five options is the ceiling — past that it stops being a
 * choice and becomes a form. And `allow_free_text` is gone: the card
 * always offers "Something else", there is nowhere in `comments` to store
 * a flag saying otherwise, and a field nothing can read is a field that
 * lies.
 */
export const DiscussionQuestionSchema = ClarificationQuestionSchema.omit({ allow_free_text: true }).extend({
  /** Two to five real answers. Not categories, and not "other" — the card has its own. */
  options: z.array(z.string().min(1)).min(2).max(5),
});

/**
 * What the product owner returns from `discuss` (Discussions).
 *
 * The third way a PO run can end, and the first that is a conversation
 * rather than a step in a pipeline. `intake` has exactly two outcomes —
 * ask, or answer — because it exists to finish. This one exists to
 * continue: `message` is always present, and a turn that proposes
 * nothing is the normal case, not a run that did nothing.
 *
 * `questions` is how the PO offers a *choice*, and it is deliberately not
 * how it asks anything else. Most questions in a conversation are open —
 * "what are you trying to build?" — and those belong in `message`, which
 * is why `message` is required and `questions` is not. A question with no
 * alternatives to choose between put on a card is worse than no card: it
 * is a form field wrapped around a sentence someone could simply have
 * answered.
 *
 * What the card earns is the batch. Several decisions asked at once are
 * answered at once and come back in one turn, where the same decisions
 * buried in a paragraph get one answer and lose the other three.
 *
 * It is not `ClarificationRequired` — that shape has no `message`, so a
 * turn would either say something or ask something, never both, and "here
 * is what I understand, and here are the three things I still need" is
 * one turn in any real conversation.
 */
export const DiscussionOutputSchema = z
  .object({
    /** What the PO says back, in markdown. */
    message: z.string().min(1),
    /**
     * Decisions to put in front of the person, asked at once.
     *
     * Empty on most turns — including every turn whose questions are
     * open-ended, since those are `message`. Bounded because a batch is a
     * card someone clicks through: past half a dozen it is an
     * interrogation, and the PO's job is to work out which few actually
     * change what gets built.
     */
    questions: z.array(DiscussionQuestionSchema).max(6).default([]),
    /** Empty on an ordinary conversational turn, which is most of them. */
    proposals: z.array(DiscussionProposalSchema).default([]),
  })
  .refine((output) => output.questions.length === 0 || output.proposals.length === 0, {
    message: "a turn either asks or proposes — a proposal built on unanswered questions is a guess with a button on it",
  });

export type NewFeatureProposal = z.infer<typeof NewFeatureProposalSchema>;
export type NewStoryProposal = z.infer<typeof NewStoryProposalSchema>;
export type NewBugProposal = z.infer<typeof NewBugProposalSchema>;
export type AmendProposal = z.infer<typeof AmendProposalSchema>;
export type ReorderProposal = z.infer<typeof ReorderProposalSchema>;
export type DiscussionProposal = z.infer<typeof DiscussionProposalSchema>;
export type DiscussionQuestion = z.infer<typeof DiscussionQuestionSchema>;
export type DiscussionOutput = z.infer<typeof DiscussionOutputSchema>;
