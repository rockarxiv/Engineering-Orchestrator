import { z } from "zod";

/**
 * What an agent has been given out of the two catalogues (EO-106).
 *
 * Attachment is the join between `mcp_servers`, `skills` and `agents`.
 * It attaches to an *agent* and not to a role name, because roles are
 * configuration (ARCHITECTURE.md, "An agent is a row") — "the reviewer" is a row somebody
 * can rename, add a second of, or delete, and a table keyed on the word
 * would point at whichever one of those happened last.
 *
 * Ids rather than whole rows. What crosses this boundary is which
 * catalogue entries are ticked, and the screen that shows them has
 * already asked `mcpServers:list` and `skills:list` for what they say —
 * sending the rows again would be two sources for one answer, and the
 * stale one would be this one.
 *
 * The *resolved* shape — the rows those ids point at — is a main-process
 * concern and lives beside the repository that reads them, because that
 * is where the archived ones have to keep resolving.
 */
export const AgentAttachmentsSchema = z.object({
  agentId: z.string(),
  /** `mcp_servers.id`, in catalogue order. Archived entries are included: see `resolveAgentAttachments`. */
  mcpServerIds: z.array(z.string()),
  /** `skills.id`, in catalogue order. */
  skillIds: z.array(z.string()),
});

export type AgentAttachments = z.infer<typeof AgentAttachmentsSchema>;

/**
 * Which catalogue an attachment points into.
 *
 * One channel with a `kind` rather than four channels, because the act
 * is the same act: a person ticks a box, and both catalogues answer to
 * exactly the same rules about what that means. Two of these and a
 * boolean is the whole write surface.
 */
export const AttachableKindSchema = z.enum(["mcpServer", "skill"]);

export type AttachableKind = z.infer<typeof AttachableKindSchema>;
