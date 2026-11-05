import { homedir, platform } from "node:os";
import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { writeMcpConfig } from "../mcpHost/gate.js";
import type { McpHostHandle } from "../mcpHost/index.js";
import { mintToken, readTokenValue, type TokenStoreOptions } from "../mcpHost/token.js";
import { freePort } from "../mcpHost/http.js";
import { createRunner, detectClients, registerWith, type ClientContext } from "../mcpHost/clients.js";
import { clientIdFor, oldNamesStillCalled, readAliasUse } from "../mcpHost/aliasUse.js";

/**
 * The Settings screen's side of EO's MCP server.
 *
 * These do not start or stop anything directly. They write what was
 * asked for through `writeMcpConfig`, which notifies an in-process
 * listener the host subscribed to, and then await a reconcile so the
 * status handed back describes what actually happened rather than what
 * was intended.
 *
 * Worth being exact about: the host subscribes to that listener set, not
 * to the settings table. A `setSetting` that went around
 * `writeMcpConfig` would change the stored configuration and the server
 * would never notice — which is the entire reason `onMcpConfigChanged`
 * exists rather than a poll.
 */
export interface McpContext {
  host: McpHostHandle;
  tokens: TokenStoreOptions;
  /** Overridden in tests; production builds one from the real PATH and home directory. */
  clients?: ClientContext;
}

function clientContext(context: McpContext): ClientContext {
  return context.clients ?? { run: createRunner(), home: homedir(), platform: platform() };
}

/**
 * The registration to advertise, or null when there is nothing to join.
 *
 * Both halves have to exist: a command naming a port EO is not listening
 * on is worse than no command, because it looks like it worked.
 */
function currentRegistration(context: McpContext): { url: string; token: string } | null {
  const status = context.host.status();
  const token = readTokenValue(context.tokens);
  if (status.listeningPort === null || token === null) return null;
  return { url: `http://127.0.0.1:${status.listeningPort}/mcp`, token };
}

/**
 * The clients on this machine, and which of them are still on the old
 * tool names (KAN-178).
 *
 * Two answers from two sources in one reply, because the screen shows
 * them as one thing: the detection runs their CLIs, and the alias state
 * is read back out of what the MCP host wrote down when they called.
 * Asking for them separately would let a row appear a refresh after the
 * client it belongs to.
 *
 * Only clients with something to say are returned — a client that has
 * moved to `item_*` is absent rather than present-and-empty, so the
 * screen never has to decide whether an empty list means "fine" or
 * "nothing recorded".
 */
export async function detectMcpClients(db: Db, context: McpContext): Promise<IpcResponse<"mcp:detectClients">> {
  const oldNameUse = readAliasUse(db).flatMap((record) => {
    const names = oldNamesStillCalled(record);
    if (names.length === 0) return [];
    return [
      {
        client: record.client,
        clientId: clientIdFor(record.client),
        names: names.map((entry) => ({ deprecated: entry.deprecated, replacement: entry.replacement })),
        lastCalledAt: record.lastCalledAt,
      },
    ];
  });

  return { clients: await detectClients(clientContext(context), currentRegistration(context)), oldNameUse };
}

/**
 * Puts EO into one client, using whatever that client provides.
 *
 * Refuses while the server is down rather than writing a URL nothing
 * answers on: a registration naming a port EO is not listening on looks
 * identical to a working one until the first tool call fails, and by
 * then the person is debugging their editor rather than this screen.
 */
export async function registerMcpWith(
  context: McpContext,
  input: IpcPayload<"mcp:registerWith">,
): Promise<IpcResponse<"mcp:registerWith">> {
  const registration = currentRegistration(context);
  if (registration === null) {
    return {
      client: {
        id: input.id,
        label: input.id,
        installed: true,
        registered: false,
        caveat: null,
        problem: "Turn the MCP server on first — there is nothing for a client to connect to yet.",
        manual: null,
      },
    };
  }

  return { client: await registerWith(clientContext(context), input.id, registration) };
}

/**
 * The full token, which is the one secret in this contract that travels.
 *
 * See McpStatusSchema's comment for why: it is typed into another
 * program's configuration file, so a screen that cannot show it is a
 * server nobody can connect to.
 */
function withToken(context: McpContext): IpcResponse<"mcp:getStatus"> {
  const status = context.host.status();
  return {
    enabled: status.enabled,
    dangerousOperations: status.dangerousOperations,
    port: status.port,
    listeningPort: status.listeningPort,
    token: readTokenValue(context.tokens),
    problem: status.problem,
    toolCount: status.toolCount,
  };
}

export function getMcpStatus(context: McpContext): IpcResponse<"mcp:getStatus"> {
  return withToken(context);
}

export async function setMcpConfig(
  db: Db,
  context: McpContext,
  input: IpcPayload<"mcp:setConfig">,
): Promise<IpcResponse<"mcp:setConfig">> {
  // `0` is the screen asking EO to find a free port, because the server
  // deliberately will not wander on its own — a port that moved without
  // being asked would silently invalidate a config file already pasted
  // into another program. Resolved to a real number here and stored as
  // one, so what Settings shows and what the snippets say stay the same
  // thing.
  let port = input.port;
  if (input.port === 0) {
    const found = await freePort().catch(() => null);
    if (found === null) {
      return { ...withToken(context), problem: "EO could not find a free port to offer. Choose one yourself in Settings." };
    }
    port = found;
  }

  writeMcpConfig(db, {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.dangerousOperations === undefined ? {} : { dangerousOperations: input.dangerousOperations }),
    ...(port === undefined ? {} : { port }),
  });

  // The write above already told the host to reconcile, but that path is
  // fire-and-forget. Awaiting one here means the status this returns
  // describes a server that has finished starting or stopping, rather
  // than one that is about to.
  await context.host.reconcile();
  return withToken(context);
}

export async function regenerateMcpToken(context: McpContext): Promise<IpcResponse<"mcp:regenerateToken">> {
  const minted = mintToken(context.tokens);
  if (!minted.ok) {
    return { ...withToken(context), problem: minted.reason };
  }

  // Every connected client is holding the old one. A restart is what
  // closes their sessions, rather than leaving them connected on a
  // credential that no longer exists — and it has to be `restart` rather
  // than `reconcile`, which would correctly notice that nothing about
  // the configuration changed and do nothing at all.
  await context.host.restart();
  return withToken(context);
}
