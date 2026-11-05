import { z } from "zod";

/**
 * The tool an agent attaches files to its own item with, mid-run
 * (EO-412).
 *
 * Named here for the reason `COMMENT_TOOL_NAME` is: the service
 * advertises it, the main process writes what the agent asks of it over
 * the agent write bridge (`agent-writes.ts`) and an `allowedTools` entry
 * permits it, and a literal in three files is one rename away from a tool
 * that is advertised and never acted on.
 */
export const ATTACHMENT_ADD_TOOL_NAME = "attachment_add";

/** How many paths one call may name. The same eight a comment may carry — `MAX_ATTACHMENT_COUNT` in the desktop's storage layer. */
export const MAX_ATTACHMENT_ADD_PATHS = 8;

/**
 * How many files one run may attach, across every call it makes.
 *
 * A cap per call alone is no cap: an agent in a loop makes another call.
 * Sixteen is two full comments, which is room for the screenshots and
 * the log of a real piece of work and not for a directory listing.
 */
export const MAX_RUN_ATTACHMENTS = 16;

/**
 * What the tool takes: paths, and words to post them under.
 *
 * Strict, and deliberately short. There is no `mentions`, `kind`,
 * `options` or `blocking` here because a caption is text — it never
 * addresses anyone, never parks a run and never carries a question
 * (KAN-29 switched the `comment` tool off because two ways to ask made
 * asking non-deterministic, and a third would be the same mistake). An
 * argument this schema does not name is a refused call rather than an
 * ignored field, so an agent that tries to mention somebody hears that
 * it cannot.
 */
export const AttachmentAddArgsSchema = z.strictObject({
  paths: z.array(z.string().min(1)).min(1).max(MAX_ATTACHMENT_ADD_PATHS),
  caption: z.string().optional(),
});

export type AttachmentAddArgs = z.infer<typeof AttachmentAddArgsSchema>;

/**
 * Where a run may attach files from, for one turn (EO-412).
 *
 * The run and the directory it was dispatched in — `runs.id` and
 * `runs.cwd`. Per turn rather than per provider for the reason
 * `repositoryMcp` is: a provider is cached and works every item its
 * agent is given, while this is one run's. Both adapters hand it to the
 * `eo` server they start, which is how that server can refuse a path
 * truthfully while the agent is still working.
 *
 * Absent means the run has nothing to attach from — a conversation, or a
 * workspace with no disk — and the tool is then not offered at all.
 */
export interface AttachmentSource {
  runId: string;
  directory: string;
}
