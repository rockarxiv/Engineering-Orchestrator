import { z } from "zod";
import { MODULE_ENV_NAME_MESSAGE, MODULE_ENV_NAME_PATTERN } from "./modules.js";

/**
 * Environment variables: named values that are not secret (EO-485,
 * ARCHITECTURE.md §14.2).
 *
 * A separate list beside Secrets, not a third kind of secret. A variable
 * is kept in the clear, shown in full and editable, and — like a module
 * secret — is either shared by every step or set on one step, the step's
 * winning name by name. It is this machine's own setting: never exported
 * with a pipeline, and never written to SQLite or the keychain.
 *
 * Here rather than beside the module secrets' schemas because more than
 * modules read it: an MCP server and an agent run are given variables
 * too, and the rules below — which names may be one at all — are the
 * same for every consumer.
 */

/** Where a variable is set: for every step, or for the one step asked about. */
export const EnvironmentVariableScopeSchema = z.enum(["shared", "step"]);
export type EnvironmentVariableScope = z.infer<typeof EnvironmentVariableScopeSchema>;

/** The name a variable is held to — the shape `needs.env` holds a module's names to. */
export const EnvironmentVariableNameSchema = z.string().regex(MODULE_ENV_NAME_PATTERN, MODULE_ENV_NAME_MESSAGE);

/** One variable, as the list returns it. The value is included: a variable is not a secret. */
export const EnvironmentVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  scope: EnvironmentVariableScopeSchema,
});
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

/**
 * The names EO sets for a run itself, exactly.
 *
 * A variable never replaces one of them. `PATH` and `HOME` are what EO
 * hands every process it starts — a module host runs on EO's `PATH`, a
 * backend's CLI is given a `HOME` of EO's choosing — and a value typed
 * here that displaced either would change which binaries a run finds or
 * where it keeps its state, for every step, from a settings field.
 */
const RESERVED_NAMES = ["PATH", "HOME"] as const;

/**
 * The names EO sets when it starts an agent's backend (EO-487).
 *
 * Each is EO's answer to a question about how the run is held: which
 * key Claude signs in with, which Codex home a locked-down agent reads,
 * and which of the Claude CLI's own behaviours EO pins for every turn
 * (its auto-memory off, fork subagents off, the answer streamed). A
 * variable that displaced one would undo that for every agent run, from
 * a settings field — so both adapters drop these from what a run is
 * given, and a save refuses them. The names EO sets per turn beyond
 * these (an attached server's values, the admin bearer, the search
 * hook's) are EO_-prefixed or are spread over the variables at spawn.
 */
const BACKEND_NAMES = [
  "ANTHROPIC_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_FORK_SUBAGENT",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
] as const;

/** The prefix of every variable EO sets for its own use. */
const RESERVED_PREFIX = "EO_";

/**
 * Why a name cannot be a variable, as a sentence, or null when it can.
 *
 * The shape is the schema's to refuse; this is the second rule, and a
 * sentence rather than a parse error because a screen shows it under the
 * field. Compared without regard to case: Windows reads `Path` as `PATH`,
 * so on that platform the lower-case spelling would displace the same
 * variable, and refusing it everywhere costs nobody anything.
 */
export function reservedEnvironmentVariableProblem(name: string): string | null {
  const upper = name.toUpperCase();
  if ((RESERVED_NAMES as readonly string[]).includes(upper)) {
    return `EO sets ${name} itself for every run, so it cannot be an environment variable here.`;
  }
  if (upper.startsWith(RESERVED_PREFIX)) {
    return `Names starting ${RESERVED_PREFIX} are EO's own: EO sets them itself for a run, so ${name} cannot be an environment variable here.`;
  }
  if ((BACKEND_NAMES as readonly string[]).includes(upper)) {
    return `EO sets ${name} itself when it starts an agent's backend, so it cannot be an environment variable here.`;
  }
  return null;
}

/**
 * What a run may be given of these variables: every one whose name is
 * not EO's own (EO-487).
 *
 * The save already refuses those names. This is the same rule applied
 * where the process is started, so a variable written before the rule,
 * or by hand, still cannot displace PATH, HOME, an EO_ name or a name EO
 * sets for a backend.
 */
export function withoutReservedEnvironmentVariables(variables: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).filter(([name]) => reservedEnvironmentVariableProblem(name) === null));
}

/** The name of the list a variable is set in, as a person reads it — and the one a refused secret is pointed at. */
export const ENVIRONMENT_VARIABLES_LIST = "Environment variables";
/** The name of the list a module secret is set in, as a person reads it — and the one a refused variable is pointed at. */
export const SECRETS_LIST = "Secrets";

/**
 * What a declared MCP server name filled only from an environment
 * variable reads as, where "Not set" would otherwise be (EO-488): on the
 * server rows in both layouts, and in `mcp_servers_list`.
 */
export const FROM_ENVIRONMENT_VARIABLES = "From environment variables";
