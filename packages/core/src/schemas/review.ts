import { z } from "zod";
import { MemoryUsedSchema } from "../memory.js";

/**
 * The action a step runs when it judges an item against what the item
 * declares.
 *
 * The string lives here rather than beside the pipeline, for the reason
 * `INTERPRET_ACTION` does: the schema and the action name are one fact,
 * `SCHEMAS_BY_ACTION` is keyed on it, and the places that have to
 * recognise a review are scattered — the scheduler, the guard on editing
 * an item, the dispatcher. The *action* is the honest key rather than
 * the step id or the owning role: a pipeline may insert a `qa` step that
 * reviews, owned by a "qa" agent, and it is still a review (invariant
 * #7).
 */
export const REVIEW_ACTION = "review";

/**
 * What the reviewer returns (ARCHITECTURE.md, "Verification, review and the pull request").
 *
 * One enum plus text — nothing to misparse, which is why the original design rates
 * this handoff "mostly" engine-verifiable. The verdict is what R-03
 * branches on to send an item forward or back.
 */
/**
 * The description for the pull request an approval opens (F-06).
 *
 * Optional, and driven entirely by the dispatch context: most reviews
 * open nothing — a repository with no forge configured — and
 * `outputSchemaFor` is keyed on the action, so the schema cannot vary
 * per repository. The reviewer is asked for it in its context when there
 * is one to write, and leaves it out otherwise.
 *
 * The reviewer rather than the implementer because it runs exactly
 * once, immediately before the pull request is opened, having read the
 * whole change — where the implementer re-runs on every rejection and
 * describes only its last attempt.
 */
const ApprovedSchema = z.object({
  verdict: z.literal("approve"),
  feedback: z.string(),
  pull_request_body: z.string().optional(),
  /** The memory entries the review relied on (EO-597), on every verdict — as `ImplementOutputSchema` takes them. */
  memoryUsed: MemoryUsedSchema,
});

/**
 * What a reviewer says about one acceptance criterion (EO-200).
 *
 * `not_assessed` is the load-bearing member. Without it a reviewer that
 * stopped at the first blocker has only two honest options — claim a
 * criterion it never looked at, or leave it out — and both of those
 * produce a verdict indistinguishable from a thorough one. With it,
 * stopping early is a thing the artefact *says*.
 *
 * `criterion` echoes the item's wording rather than naming an index:
 * the coverage is rendered into the thread and carried to the next
 * implementation attempt, where "criterion 3 was not assessed" means
 * nothing without the item open beside it. The engine matches the echo
 * back to the item's own list, so a paraphrase is caught as an
 * unreported criterion rather than silently accepted.
 */
export const CRITERION_RESULTS = ["met", "not_met", "not_assessed"] as const;

export const CriterionResultSchema = z.object({
  criterion: z.string().min(1),
  result: z.enum(CRITERION_RESULTS),
  /** Why, when a sentence helps — the evidence for `met`, the gap for the others. */
  note: z.string().optional(),
});

export type CriterionResult = z.infer<typeof CriterionResultSchema>;

const RejectedSchema = z.object({
  verdict: z.literal("reject"),
  feedback: z.string(),
  /**
   * A result for every one of the story's acceptance criteria (EO-200).
   *
   * The instruction to report every blocking issue in one verdict was
   * already in `reviewer.md`, in bold, argued with EO's own numbers. It
   * did not hold: EO-194 went five implementer rounds on three faults in
   * two files, one rejection at a time. Prose has been tried and
   * measured, so this is the schema saying it instead — a reviewer that
   * stopped at the first blocker now has to write down that it stopped.
   *
   * Not `.min(1)`, and that is not an oversight. An item may carry no
   * acceptance criteria at all, and a floor here would leave its
   * reviewer unable to produce any valid rejection. The check that
   * matters is not "did you write something" but "does what you wrote
   * account for the criteria this item actually declares" — which is
   * the engine's to make, not the schema's, because only the engine
   * holds the item (invariant #5). `summariseCriteriaCoverage` makes
   * it, and the gap it finds is rendered into the rejection comment.
   */
  criteria_coverage: z.array(CriterionResultSchema),
  /**
   * At least one, and only here (KAN-31).
   *
   * A rejection is the one result whose entire purpose is to be acted
   * on, and it reaches the next attempt as prose in a comment — so a
   * rejection with nothing listed sends a story back with no idea what
   * to change. Requiring it is the difference between "the reviewer
   * was unhappy" and "here is what to fix".
   *
   * Flat and optional-on-both before this, which let the schema accept
   * an approval carrying blocking issues — a shape that means nothing
   * and that nothing downstream knew how to read.
   */
  blocking_issues: z.array(z.string().min(1)).min(1),
  memoryUsed: MemoryUsedSchema,
});

/**
 * The reviewer asking rather than deciding (KAN-53, KAN-55).
 *
 * A step's declared results are only meaningful if an agent can actually
 * produce them: the shipped pipeline routes `needs_user_input` to the
 * human, and before this there was no verdict that reached it — the route
 * existed and nothing could ever take it.
 *
 * `blocking_issues` is absent on purpose. This is a question, not a
 * rejection, and the difference matters to the person reading the inbox:
 * "I cannot tell which way you want this" is not "here is what to fix".
 */
const NeedsInputSchema = z.object({
  verdict: z.literal("needs_user_input"),
  feedback: z.string(),
  memoryUsed: MemoryUsedSchema,
});

export const ReviewOutputSchema = z.discriminatedUnion("verdict", [ApprovedSchema, RejectedSchema, NeedsInputSchema]);

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;
