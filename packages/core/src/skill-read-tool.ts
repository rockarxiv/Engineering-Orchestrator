import { z } from "zod";

/**
 * The tool a Codex agent loads one of the skills its run was given with
 * (EO-721).
 *
 * Claude loads a skill with the SDK's own `Skill` tool, and that call is
 * the load — exact, and seen by EO. Codex has no skill tool: EO used to
 * write each `SKILL.md` into the worktree and tell the agent to read it,
 * and could only infer a load from a shell command and its output
 * (EO-715). So on Codex EO serves a skill's instructions itself, and the
 * call to this tool is the load, as exact as Claude's.
 *
 * Named here for the reason `REPOSITORY_CHECKOUT_TOOL_NAME` is: the
 * service advertises it, the main process answers it over the agent write
 * bridge (`agent-writes.ts`), the prompt names it and the adapter reads
 * the load off the call, and a literal in four places is one rename away
 * from a tool that is advertised and never counted.
 *
 * Through the bridge although it writes nothing: which skills a run was
 * given is the main process's to know, and only it can refuse a skill the
 * run was not given.
 */
export const SKILL_READ_TOOL_NAME = "skill_read";

/**
 * What the tool takes: a skill's slug, as the prompt lists it. Strict, so
 * an argument the tool does not name is a refused call rather than an
 * ignored field.
 */
export const SkillReadArgsSchema = z.strictObject({
  slug: z.string().trim().min(1),
});

export type SkillReadArgs = z.infer<typeof SkillReadArgsSchema>;
