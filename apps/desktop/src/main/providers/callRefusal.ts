import { RESERVED_MCP_SERVER_NAME, type AgentEvent } from "@eo/core";

/**
 * Which calls a turn given `refuseCallsExcept` may make (EO-732), decided
 * once for both backends.
 *
 * The learning review runs on a fork of a run's thread and is sent the
 * run's own tools, so its prompt starts exactly as the run's last request
 * did and the backend reads the thread out of its prompt cache. A tool
 * hidden from it would change that start and cost the whole thread again.
 * So nothing is hidden, and what the review may do is held here, at the
 * call: each backend's `PreToolUse` hook asks this about every call and
 * refuses the ones it answers for — Claude's in EO's own process
 * (`claude.ts`), Codex's through the listener its hook command posts to
 * (`codexSearchHook.ts`). One rule, two deliveries.
 *
 * Both hooks are handed a tool by the same spelling: a built-in by its
 * own name (`Bash`, `Edit`, `apply_patch`, `Skill`) and an MCP server's
 * tool as `mcp__<server>__<tool>`, which is what the pinned Codex reports
 * in a hook payload as well as what Claude calls it.
 *
 * What it allows:
 * - the named tools of EO's own server, by bare name;
 * - every tool of the repository server, which is an index the agent
 *   queries and has no tool that changes anything;
 * - the backend's own way of giving the turn's answer, where it has one
 *   — Claude's `StructuredOutput`, which the turn must call to end when it
 *   was sent the run's answer schema, and which writes nothing.
 *
 * Everything else is refused: file edits, shell commands, an attached
 * server's tools, the administrative server, `Skill` and `skill_read`,
 * EO's other tools, subagents and tool search.
 */
export interface CallRule {
  /** EO's own tools the turn may call, by bare name. */
  eoTools: readonly string[];
  /** The repository server's name on this turn, or null where it has none. */
  repositoryServer: string | null;
  /** The backend's own answer tool, which the turn may always call. */
  answerTool?: string;
}

/** Why a call was refused, or null for a call the turn may make. */
export function refusedCall(tool: string, rule: CallRule): string | null {
  if (rule.answerTool !== undefined && tool === rule.answerTool) return null;
  const own = `mcp__${RESERVED_MCP_SERVER_NAME}__`;
  if (tool.startsWith(own) && rule.eoTools.includes(tool.slice(own.length))) return null;
  if (rule.repositoryServer !== null && tool.startsWith(`mcp__${rule.repositoryServer}__`)) return null;
  return `EO refused this call: this turn is a learning review, which may read and write memory and skills and read the repository index, and nothing else. \`${tool}\` was not run, and nothing it would have done happened.`;
}

/** The answer a `PreToolUse` hook gives to refuse a call, in the shape both backends read. */
export function refusalHookOutput(reason: string): { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } } {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

/**
 * What a call says by being made — a skill loaded, a file edited — which a
 * refused call did not do, so a turn whose calls are refused does not say
 * it (EO-732). A refused `Skill` or `skill_read` records no `skill_loaded`.
 */
export const REFUSED_CALL_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set(["skill_loaded", "file_edit"]);
