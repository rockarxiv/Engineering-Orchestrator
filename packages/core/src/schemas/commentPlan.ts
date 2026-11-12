import { z } from "zod";
import { MemoryUsedSchema } from "../memory.js";

/**
 * Planning a response to other accounts' pull request comments (EO-760).
 *
 * A comment on a pull request by anybody but the account EO is signed in
 * to the forge as is not an instruction (EO-759). The implementer reads
 * the comments the watch handed to planning and proposes, per comment,
 * what to change — or that nothing should — and the reply to post; the
 * reviewer judges that plan; a person approves it. Only then is anything
 * done about the comments.
 */
export const PLAN_COMMENT_RESPONSE_ACTION = "plan_comment_response";

/** The reviewer's judgement of that plan, before a person sees it. */
export const REVIEW_PLAN_ACTION = "review_plan";

/** One comment, and what the plan proposes for it. */
export const PlannedCommentSchema = z.object({
  comment_id: z.string().min(1).describe("The comment's forge id, exactly as it is listed under the comments awaiting a plan."),
  change: z
    .string()
    .min(1)
    .nullable()
    .describe("What you propose to change in answer to this comment, specific enough to carry out. null when you propose no change."),
  reply: z.string().min(1).describe("The reply to post on the pull request for this comment, once the plan has been carried out or rejected."),
});

export type PlannedComment = z.infer<typeof PlannedCommentSchema>;

/**
 * What the planner returns.
 *
 * One entry for every comment awaiting a plan, and none for anything
 * else: the engine checks the list against the comments the watch handed
 * to planning and refuses an answer that leaves one out or names another
 * (invariant 5). Not `.min(1)`, so a dispatch with nothing awaiting a
 * plan still has an answer it can give.
 */
export const PlanCommentResponseOutputSchema = z.object({
  summary: z.string().min(1).describe("The plan in a sentence or two, for the person who approves it."),
  comments: z.array(PlannedCommentSchema),
  memoryUsed: MemoryUsedSchema,
});

export type PlanCommentResponseOutput = z.infer<typeof PlanCommentResponseOutputSchema>;

/**
 * What the plan's reviewer returns.
 *
 * The three verdicts `review` has, and the same result keys, without what
 * only a code review carries: no pull request body, and no acceptance
 * criteria coverage table — the plan is held to the criteria by the
 * instructions, and a rejection says what is wrong in `blocking_issues`.
 */
const PlanApprovedSchema = z.object({
  verdict: z.literal("approve"),
  feedback: z.string(),
  memoryUsed: MemoryUsedSchema,
});

const PlanRejectedSchema = z.object({
  verdict: z.literal("reject"),
  feedback: z.string(),
  /** At least one, for `RejectedSchema`'s reason: the planner is sent back with this and nothing else from the reviewer. */
  blocking_issues: z.array(z.string().min(1)).min(1),
  memoryUsed: MemoryUsedSchema,
});

const PlanNeedsInputSchema = z.object({
  verdict: z.literal("needs_user_input"),
  feedback: z.string(),
  memoryUsed: MemoryUsedSchema,
});

export const ReviewPlanOutputSchema = z.discriminatedUnion("verdict", [PlanApprovedSchema, PlanRejectedSchema, PlanNeedsInputSchema]);

export type ReviewPlanOutput = z.infer<typeof ReviewPlanOutputSchema>;
