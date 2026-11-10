import type { Db } from "../db/client.js";
import { getSetting, setSetting } from "../db/repos/index.js";
import { TOOLS, type ToolSpec } from "./catalog.js";

/**
 * Whether destructive tools are offered, and the config the server runs on.
 *
 * Kept out of `settings:get`/`settings:set` deliberately. That channel's
 * own doc comment explains why: it is a closed object of four
 * preferences shared with the inbox's Do Not Disturb toggle, and a
 * screen should only be able to change the setting it is showing.
 * Putting a port in there means the inbox refetches when someone edits
 * it, and vice versa.
 *
 * This module holds no SDK types, so `handlers.ts` never learns the MCP
 * SDK exists — it changes a setting and something else notices.
 */
export const MCP_ENABLED_KEY = "mcp.enabled";
export const MCP_PORT_KEY = "mcp.port";
export const MCP_DANGEROUS_KEY = "mcp.dangerousOperations";

/**
 * Not chosen for any reason beyond being unlikely to collide and easy to
 * say. It is written into a config file the person pastes elsewhere, so
 * what matters is that it does not move on its own — see http.ts on why
 * a busy port is reported rather than worked around.
 */
export const DEFAULT_PORT = 4319;

export interface McpConfig {
  enabled: boolean;
  port: number;
  dangerousOperations: boolean;
}

export function readMcpConfig(db: Db): McpConfig {
  return {
    enabled: getSetting<boolean>(db, MCP_ENABLED_KEY, false),
    port: getSetting<number>(db, MCP_PORT_KEY, DEFAULT_PORT),
    dangerousOperations: getSetting<boolean>(db, MCP_DANGEROUS_KEY, false),
  };
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Returns a disposer, the shape `bridgePushChannels` uses for the same job. */
export function onMcpConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function writeMcpConfig(db: Db, patch: Partial<McpConfig>): McpConfig {
  if (patch.enabled !== undefined) setSetting(db, MCP_ENABLED_KEY, patch.enabled);
  if (patch.port !== undefined) setSetting(db, MCP_PORT_KEY, patch.port);
  if (patch.dangerousOperations !== undefined) setSetting(db, MCP_DANGEROUS_KEY, patch.dangerousOperations);

  const config = readMcpConfig(db);
  for (const listener of listeners) listener();
  return config;
}

/**
 * The tools a client may see, given the gate.
 *
 * Filtering the advertised list is the first of three layers, and the
 * only one that changes what a well-behaved model reaches for. The
 * second is `toolAllowed` below, checked on every call because a client
 * can call a tool it was never shown; the third is that both read the
 * setting at call time rather than caching it at startup, so flipping
 * the switch takes effect on the next call rather than the next launch.
 */
export function toolsFor(dangerousOperations: boolean, audience: McpAudience = "external"): readonly ToolSpec[] {
  return TOOLS.filter((tool) => toolAllowed(tool, dangerousOperations) && toolOffered(tool, audience));
}

/** Takes only what it reads, so a caller with a `kind` and nothing else needs no cast. */
export function toolAllowed(tool: Pick<ToolSpec, "kind">, dangerousOperations: boolean): boolean {
  return tool.kind !== "dangerous" || dangerousOperations;
}

/**
 * Which of EO's two listeners a client reached (EO-192).
 *
 * `external` is the accessory — off by default, reached by a stranger
 * holding a token out of the keychain. `admin` is the socket EO opens
 * for the agent it spawns itself. Both serve the same catalogue through
 * the same code, so *which one you are* has to be a value rather than an
 * assumption, and a tool that is only ever the system agent's says so on
 * its own entry.
 *
 * The default is `external` everywhere, which is the fail-safe
 * direction: a caller that forgets to say gets the smaller list, and the
 * one host that needs more asks for it by name.
 */
export type McpAudience = "admin" | "external";

/** Whether this listener offers this tool at all — see `ToolSpec.adminOnly` and `ToolSpec.personOnly`. */
export function toolOffered(tool: Pick<ToolSpec, "adminOnly" | "personOnly">, audience: McpAudience): boolean {
  return audience === "admin" ? tool.personOnly !== true : tool.adminOnly !== true;
}

/**
 * What a blocked call is told.
 *
 * It names the exact switch, and says nothing changed, because a model
 * told only "not allowed" retries or goes looking for another tool that
 * achieves the same thing — which is the one outcome the gate exists to
 * prevent.
 */
export function gateRefusal(toolName: string): string {
  return (
    `\`${toolName}\` is a destructive tool. EO keeps those off until someone turns on "Allow destructive operations" ` +
    "in Settings → MCP server, on the machine EO is running on. Nothing has been changed. " +
    "Do not try another tool to achieve the same thing."
  );
}
