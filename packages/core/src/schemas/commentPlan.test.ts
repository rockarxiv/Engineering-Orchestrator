import { describe, expect, it } from "vitest";
import { PlanCommentResponseOutputSchema, ReviewPlanOutputSchema } from "./commentPlan.js";
import { ImplementOutputSchema } from "./implement.js";

const IMPLEMENTED = { branch: "eo/EO-1", summary: "Did it.", handoff: "Nothing to flag." };

describe("the implement answer's replies (EO-760)", () => {
  it("are optional, and an answer without them is what it was", () => {
    expect(ImplementOutputSchema.parse(IMPLEMENTED)).not.toHaveProperty("replies");
  });

  it("carry, per pull request comment addressed, its forge id and a sentence saying what changed", () => {
    const replies = [{ comment_id: "review-comment:11", reply: "Renamed `a` to `total`." }];
    expect(ImplementOutputSchema.parse({ ...IMPLEMENTED, replies }).replies).toEqual(replies);
    expect(ImplementOutputSchema.safeParse({ ...IMPLEMENTED, replies: [{ comment_id: "", reply: "x" }] }).success).toBe(false);
    expect(ImplementOutputSchema.safeParse({ ...IMPLEMENTED, replies: [{ comment_id: "review-comment:11" }] }).success).toBe(false);
  });
});

describe("a plan for pull request comments", () => {
  it("lists each comment with a change or none, and a reply", () => {
    const plan = {
      summary: "Rename one thing.",
      comments: [
        { comment_id: "review-comment:11", change: "Rename it.", reply: "Renamed." },
        { comment_id: "issue-comment:12", change: null, reply: "Out of scope here." },
      ],
    };
    expect(PlanCommentResponseOutputSchema.parse(plan)).toEqual(plan);
    expect(PlanCommentResponseOutputSchema.parse({ summary: "Nothing awaited a plan.", comments: [] }).comments).toEqual([]);
  });

  it("refuses an entry with no reply, or one that leaves the change unsaid", () => {
    expect(PlanCommentResponseOutputSchema.safeParse({ summary: "s", comments: [{ comment_id: "a", change: null }] }).success).toBe(false);
    expect(PlanCommentResponseOutputSchema.safeParse({ summary: "s", comments: [{ comment_id: "a", reply: "r" }] }).success).toBe(false);
  });
});

describe("a plan's review", () => {
  it("has a code review's three verdicts, and a rejection names at least one blocking issue", () => {
    expect(ReviewPlanOutputSchema.safeParse({ verdict: "approve", feedback: "Fine." }).success).toBe(true);
    expect(ReviewPlanOutputSchema.safeParse({ verdict: "needs_user_input", feedback: "Which?" }).success).toBe(true);
    expect(ReviewPlanOutputSchema.safeParse({ verdict: "reject", feedback: "No.", blocking_issues: ["The reply does not answer it."] }).success).toBe(true);
    expect(ReviewPlanOutputSchema.safeParse({ verdict: "reject", feedback: "No.", blocking_issues: [] }).success).toBe(false);
  });
});
