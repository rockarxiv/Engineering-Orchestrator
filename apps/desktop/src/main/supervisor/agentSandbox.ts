import { homedir } from "node:os";
import { agentSandboxed, type Agent, type AgentSandbox } from "@eo/core";
import { credentialFiles, FORGE_TOKEN_VARIABLES, SIGN_IN_CHANNEL_VARIABLES, signInSockets } from "../providers/sandboxCredentials.js";
import type { WorkspaceAttachment } from "./workspaceKind.js";

/**
 * What EO keeps from a sandboxed agent (EO-934, ARCHITECTURE.md §12.7):
 * the lists live in `providers/sandboxCredentials.ts`, where both adapters
 * ask them again of the environment they launch with.
 */
export { credentialFiles, FORGE_TOKEN_VARIABLES, SIGN_IN_CHANNEL_VARIABLES, signInSockets } from "../providers/sandboxCredentials.js";

/** One turn's sandbox: what it may write, as the dispatch worked it out, and what EO always keeps from it. */
export function agentSandboxFor(writable: readonly string[], home: string = homedir(), environment: NodeJS.ProcessEnv = process.env): AgentSandbox {
  return {
    writable: [...writable],
    hidden: [...credentialFiles(home, environment), ...signInSockets(environment)],
    withheld: [...FORGE_TOKEN_VARIABLES, ...SIGN_IN_CHANNEL_VARIABLES],
  };
}

/**
 * The attachment with this turn's sandbox on it, for an agent whose
 * setting asks for one (EO-934), and unchanged for every other.
 *
 * Every turn of a sandboxed agent gets a sandbox, whatever its
 * workspace: what the workspace kind lends (`sandboxWritable`) is what it
 * may write beyond the directory it runs in, and a kind that lends
 * nothing — a folder, a run with no disk — leaves it that directory
 * alone, which both backends make writable as the turn's own. There is
 * no path on which a sandboxed agent's turn is launched without one.
 */
export function withAgentSandbox(attachment: WorkspaceAttachment, agent: Agent, cwd: string | null): WorkspaceAttachment {
  if (!agentSandboxed(agent)) return attachment;
  const writable = attachment.sandboxWritable ?? (cwd === null ? [] : [cwd]);
  return { ...attachment, sandbox: agentSandboxFor(writable) };
}
