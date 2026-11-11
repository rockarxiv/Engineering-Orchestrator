import { z } from "zod";

/**
 * The tools the learning review writes skills with (EO-718).
 *
 * Served on the `eo` server of the review's fork and on no other turn of
 * any agent: the review's write credential names them
 * (`AgentWriteBridgeAddress.writes`), and the server lists none of them on
 * a credential that does not. The main process answers every one over the
 * agent write bridge (`agent-writes.ts`) — the reads too, because which
 * skills the review may read, and what it has read, is the main process's
 * to know, and a write is refused unless the same review read what it
 * changes.
 *
 * Named here for the reason `SKILL_READ_TOOL_NAME` is: the server lists
 * them, the bridge takes them, the supervisor answers them and the review
 * prompt names them, and a literal in four places is one rename away from
 * a tool that is listed and never answered.
 *
 * Distinct from `skill_read`, which is a Codex run *loading* a skill it
 * was given, and is counted as a load (EO-721). Reading a skill to judge
 * it is not using it.
 */
export const SKILL_VIEW_TOOL_NAME = "skill_view";
export const SKILL_CREATE_TOOL_NAME = "skill_create";
export const SKILL_PATCH_TOOL_NAME = "skill_patch";
export const SKILL_FILE_WRITE_TOOL_NAME = "skill_file_write";
export const SKILL_FILE_REMOVE_TOOL_NAME = "skill_file_remove";

/** Every skill tool, in the order the `eo` server lists them. */
export const SKILL_WRITE_TOOLS = [SKILL_VIEW_TOOL_NAME, SKILL_CREATE_TOOL_NAME, SKILL_PATCH_TOOL_NAME, SKILL_FILE_WRITE_TOOL_NAME, SKILL_FILE_REMOVE_TOOL_NAME] as const;
export type SkillWriteTool = (typeof SKILL_WRITE_TOOLS)[number];

/**
 * Why a skill tool is refused on a turn that is not a learning review
 * (EO-732): every turn that could be reviewed lists them, so the refusal
 * is said when one is called — by the `eo` server, the bridge and the
 * supervisor alike, whatever else the turn's credential names.
 */
export const skillToolNotServed = (tool: string): string =>
  `Only a learning review may write skills, so EO serves ${tool} to no other turn, and nothing was read or written.`;

/**
 * What each tool takes. Strict, so an argument a tool does not name is a
 * refused call rather than an ignored field.
 */
export const SkillViewArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
  /** One supporting file's path, relative to the skill's folder; absent reads the body. */
  file: z.string().trim().min(1).optional(),
});
export type SkillViewArgs = z.infer<typeof SkillViewArgsSchema>;

export const SkillCreateArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
  description: z.string(),
  body: z.string(),
});
export type SkillCreateArgs = z.infer<typeof SkillCreateArgsSchema>;

export const SkillPatchArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
  /** Text the body holds exactly once. */
  old_text: z.string().min(1),
  /** What it becomes; empty removes it. */
  new_text: z.string(),
});
export type SkillPatchArgs = z.infer<typeof SkillPatchArgsSchema>;

export const SkillFileWriteArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
  path: z.string().trim().min(1),
  content: z.string(),
});
export type SkillFileWriteArgs = z.infer<typeof SkillFileWriteArgsSchema>;

export const SkillFileRemoveArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
  path: z.string().trim().min(1),
});
export type SkillFileRemoveArgs = z.infer<typeof SkillFileRemoveArgsSchema>;
