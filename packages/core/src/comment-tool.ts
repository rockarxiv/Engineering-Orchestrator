import { z } from "zod";
import type { ToolDef } from "./agent-provider.js";

// The tool schema from the design, given to every agent —
// commenting is the only communication channel, agent or human.
export const CommentToolArgsSchema = z.object({
  body: z.string(),
  mentions: z.array(z.string()).default([]), // ["user"] | ["product-owner"]
  /**
   * `output` is the run's deliverable, and the one kind here that is not
   * conversation (EO-298).
   *
   * A workspace that produced files posts it through `artifacts` — the
   * git kind posts the diff — but the `none` kind produces nothing on
   * disk to gather, and an agent that drafted a reply or a report has it
   * in the turn rather than in a directory. So the agent says so itself,
   * and what it writes is the same comment, of the same kind, derived
   * the same way: the latest output on the item is the item's output,
   * whoever posted it.
   *
   * `rejection` and `escalation` stay absent. Both are things EO
   * concludes about a run rather than things a run may declare about
   * itself — escalating is a `blocking` mention, and a rejection is the
   * engine's verdict (invariant 1).
   */
  kind: z.enum(["note", "question", "decision", "approval", "output"]).default("note"),
  options: z.array(z.string()).optional(),
  blocking: z.boolean().default(false),
});

export type CommentToolArgs = z.infer<typeof CommentToolArgsSchema>;

export const COMMENT_TOOL_NAME = "comment";

/**
 * The read-only item reader Discussions gives the product owner.
 *
 * Named here beside `comment` because both are EO's own tools and both
 * are referenced from two places — the provider that registers them and
 * the `agents.config.allowedTools` entry that permits them — and a
 * string literal in four files is one rename away from a tool that is
 * registered and never permitted.
 */
export const ITEM_DETAIL_TOOL_NAME = "item_detail";

/**
 * What the same tool was called before KAN-145 renamed the entity.
 *
 * Still advertised, still answering identically, and still named by the
 * `allowedTools` five migrations built up — see `deprecations.ts` for the
 * whole arrangement and the release it ends after. Kept beside the
 * current name rather than in that file because this is the name the
 * service registers and the allowlist permits, and those two have to go
 * on agreeing for as long as both spellings resolve.
 */
export const TICKET_DETAIL_TOOL_NAME = "ticket_detail";

// Derived from CommentToolArgsSchema rather than hand-mirrored: A-02
// established z.toJSONSchema() as the converter, so the schema the agent
// is shown and the validator its call is checked against can no longer
// drift apart. `io: "input"` describes what the agent must *send*, so a
// field with a default is optional rather than required.
export const commentToolDef: ToolDef = {
  name: COMMENT_TOOL_NAME,
  description:
    "Post a comment on this ticket. Mention @user to ask the human something you cannot resolve, " +
    "or @<agent> to ask a teammate. If you mention someone and set blocking, your run ends here " +
    "and resumes when they reply. Use kind `output` for the thing you were asked to produce — " +
    "the report, the reply, the draft — rather than leaving it in your final message: the latest " +
    "output on a ticket is what the next step works from and what a person edits.",
  parameters: z.toJSONSchema(CommentToolArgsSchema, { io: "input" }) as Record<string, unknown>,
};
