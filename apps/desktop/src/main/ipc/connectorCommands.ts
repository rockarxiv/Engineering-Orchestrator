import type { IpcPayload, IpcResponse } from "@eo/core";
import type { Db } from "../db/client.js";
import { getMcpServer } from "../db/repos/index.js";
import { packConnectors } from "../connectors/declared.js";
import { listConnectorViews } from "../connectors/list.js";
import { runConnectorOAuth } from "../connectors/oauth.js";
import {
  clearMcpServerSecret,
  listMcpServerSecretNames,
  mcpKeychainStatus,
  readMcpServerSecretEntry,
  storeMcpServerSecret,
  type McpSecretRead,
  type McpServerSecretsOptions,
} from "../mcp/serverSecrets.js";

/**
 * Connectors, over IPC (EO-315, ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * The setup flow and nothing else. A connector's *delivery* is
 * unchanged — it is an `mcp_servers` row, attached to an agent, written
 * into what a provider reads — so nothing here touches a dispatch. What
 * these four do is let a person give a server what it needs without
 * meeting a command line: paste a value, or sign in and have EO catch
 * the callback.
 *
 * Values go in and never come back out through here: the view carries
 * `secretsSet`, which is a list of names. The only channel that returns
 * a server's value is the machine half's `mcpServers:revealSecret`, for
 * a person pressing Reveal at this desktop (EO-489).
 */

/**
 * The setup in force for a server, by the same rule
 * `listConnectorViews` lists by: a pack's wins over a row's, because a
 * setup that arrived as data must not be able to relabel a server EO
 * itself ships.
 */
function setupFor(db: Db, serverId: string) {
  const server = getMcpServer(db, serverId);
  if (server === undefined) return { server: undefined, setup: null } as const;
  return { server, setup: packConnectors().get(server.name) ?? server.connector } as const;
}

export function listConnectorsCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"connectors:list">,
): IpcResponse<"connectors:list"> {
  return {
    connectors: listConnectorViews(db, secrets, { role: input.role }),
    keychain: mcpKeychainStatus(secrets.store),
  };
}

/**
 * Stores what a person pasted.
 *
 * Every value or none. A connector wanting two is connected by neither
 * alone, so a failure on the second write leaves the first unwritten
 * too — otherwise a person who pressed Connect once is left half
 * connected, with a screen that says so and no way to tell which half.
 *
 * Refused, never thrown, when the keychain is missing or weak, and the
 * status comes back either way so the caller can say which it was. That
 * refusal is `storeMcpServerSecret`'s own; this is a second caller of
 * the same rule rather than a second rule.
 */
export function connectConnectorTokenCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"connectors:connectToken">,
): IpcResponse<"connectors:connectToken"> {
  const keychain = mcpKeychainStatus(secrets.store);
  const { server, setup } = setupFor(db, input.serverId);
  if (server === undefined) return { connected: false, problem: "That server no longer exists.", keychain };
  if (setup === null) return { connected: false, problem: `"${server.name}" is not a connector, so there is nothing to connect.`, keychain };
  if (setup.kind !== "token") {
    return { connected: false, problem: `"${setup.label}" is not connected by pasting a value.`, keychain };
  }

  const offered = Object.keys(input.values);
  const undeclared = offered.filter((name) => !setup.secretNames.includes(name));
  if (undeclared.length > 0) {
    // Refused rather than written and ignored: a value filed under a
    // name the connector does not declare is a value nothing will ever
    // read, and nothing would clean it up.
    return { connected: false, problem: `"${setup.label}" does not ask for ${undeclared.join(", ")}.`, keychain };
  }

  const missing = setup.secretNames.filter((name) => !offered.includes(name) && !storedNames(secrets, server.id).includes(name));
  if (missing.length > 0) return { connected: false, problem: `${setup.label} also needs ${missing.join(", ")}.`, keychain };

  // **What was there before, before anything is overwritten.**
  //
  // Reconnecting is the ordinary case — somebody rotates a token and
  // pastes the new one — so "a value that was already there is not this
  // call's to remove" was the wrong rule: the rollback deleted every
  // name this call had touched, and for a two-value connector whose
  // second write failed that meant a working first credential erased by
  // a failed attempt to replace it. Held here so the rollback can put
  // each name back the way it found it rather than merely empty it.
  //
  // The values are read into memory in the main process and go nowhere
  // else. That is the same thing `attachmentEnvironment` does at every
  // spawn; what must never happen is one of them crossing IPC, and
  // nothing in this function returns one.
  const before = new Map(setup.secretNames.map((name) => [name, readMcpServerSecretEntry(secrets, server.id, name)] as const));

  // Written in the order the setup declares rather than the order
  // the payload happened to serialise in, so a partial write is the same
  // partial write every time and a person retrying sees the same state.
  const written: string[] = [];
  for (const name of setup.secretNames) {
    const value = input.values[name];
    if (value === undefined) continue;
    const result = storeMcpServerSecret(secrets, server.id, name, value);
    if (result.ok) {
      written.push(name);
      continue;
    }
    const unrestored = rollBack(secrets, server.id, written, before);
    // All or nothing, and said so when it could not be. A restore that
    // itself failed is the keychain refusing twice in a row, which is
    // rare and is exactly the moment somebody has to be told which
    // credential they now have to set again — silence here would be a
    // guard dropping work on the floor (invariant 8).
    const one = unrestored.length === 1;
    const lost =
      unrestored.length === 0
        ? ""
        : ` ${setup.label} had ${unrestored.join(", ")} set before, and EO could not put ${one ? "it" : "them"} back — ` +
          `set ${one ? "it" : "them"} again.`;
    return { connected: false, problem: `${result.reason}${lost}`, keychain };
  }

  return { connected: true, problem: null, keychain };
}

/**
 * Puts every name this call wrote back the way it found it.
 *
 * Three prior states and three answers. A value that was there is
 * written back; a name that was **absent** is cleared, which is what
 * "the way it found it" means for one; and a name whose ciphertext was
 * **unreadable** is cleared too — there is nothing to restore, and
 * leaving a half-applied new value under a connector this call has just
 * refused would be the one outcome nobody asked for.
 *
 * Answers with the names it could not put back rather than throwing:
 * this runs on the failure path, where a second failure is plausible and
 * an exception would replace a sentence about the person's credentials
 * with one about EO's.
 */
function rollBack(
  secrets: McpServerSecretsOptions,
  serverId: string,
  written: readonly string[],
  before: ReadonlyMap<string, McpSecretRead>,
): string[] {
  const unrestored: string[] = [];
  for (const name of written) {
    const prior = before.get(name);
    if (prior?.state === "value") {
      if (!storeMcpServerSecret(secrets, serverId, name, prior.value).ok) unrestored.push(name);
      continue;
    }
    clearMcpServerSecret(secrets, serverId, name);
  }
  return unrestored;
}

function storedNames(secrets: McpServerSecretsOptions, serverId: string): string[] {
  return listMcpServerSecretNames(secrets, serverId);
}

export interface ConnectorOAuthContext {
  /** The person's real browser. `shell.openExternal` in production, a fake in a test. */
  openExternal: (url: string) => Promise<void>;
  /** Injected so a test answers the token endpoint without a network. */
  fetchImpl?: typeof fetch;
  /** Shortened in tests; five minutes in production. */
  timeoutMs?: number;
}

/**
 * Opens the provider's URL and waits for the loopback callback.
 *
 * Awaited rather than started-and-polled: the renderer's Connect button
 * is busy until this resolves, which is what an awaited call already is.
 * It cannot hang — `runConnectorOAuth` times out and answers with a
 * sentence, which is invariant 9's rule one level down from a run.
 */
export async function connectConnectorOAuthCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"connectors:connectOAuth">,
  context: ConnectorOAuthContext,
): Promise<IpcResponse<"connectors:connectOAuth">> {
  const { server, setup } = setupFor(db, input.serverId);
  if (server === undefined) return { connected: false, problem: "That server no longer exists." };
  if (setup === null) return { connected: false, problem: `"${server.name}" is not a connector, so there is nothing to connect.` };
  const oauth = setup.oauth;
  if (setup.kind !== "oauth" || oauth === null) {
    return { connected: false, problem: `"${setup.label}" is not connected by signing in.` };
  }

  // Both of the next two are checked **before a browser opens**, for one
  // reason: finishing a round trip and then discovering the connector
  // could never have gone green is a sign-in somebody performed for
  // nothing.

  // Nowhere safe to put the answer.
  const keychain = mcpKeychainStatus(secrets.store);
  if (keychain.warning !== null) return { connected: false, problem: keychain.warning };

  // A setup the sign-in could not finish. One round trip produces
  // one value, and the `oauth` kind draws a Connect button rather than a
  // box — so a connector asking for anything beside its token would sign
  // in and stay red on a name nothing can ever fill.
  // `connectorDefinitionProblems` refuses this where a pack author can
  // still fix it, which makes this unreachable from a pack and from an
  // import; it is here for the row hand-edited into somebody's database,
  // and it says what is wrong with the setup rather than pretending
  // the person could supply the value.
  const unfillable = setup.secretNames.filter((name) => name !== oauth.tokenSecretName);
  if (unfillable.length > 0) {
    return {
      connected: false,
      problem:
        `"${setup.label}" signs in with OAuth, which stores one value, but also asks for ${unfillable.join(", ")} — ` +
        `so signing in could not connect it. Whoever wrote this connector has to declare it differently.`,
    };
  }

  const result = await runConnectorOAuth({
    oauth,
    openExternal: context.openExternal,
    ...(context.fetchImpl ? { fetchImpl: context.fetchImpl } : {}),
    ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
  });
  if (!result.ok) return { connected: false, problem: result.reason };

  const stored = storeMcpServerSecret(secrets, server.id, oauth.tokenSecretName, result.token);
  if (!stored.ok) return { connected: false, problem: stored.reason };

  return { connected: true, problem: null };
}

/**
 * Forgets what a connector was given.
 *
 * Only the names it declares. A value the server needs for some other
 * reason is not this button's to remove — `clearMcpServerSecrets` empties
 * a server, and that belongs to a server being deleted rather than to
 * somebody signing out of it.
 */
export function disconnectConnectorCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"connectors:disconnect">,
): IpcResponse<"connectors:disconnect"> {
  const { server, setup } = setupFor(db, input.serverId);
  // A server that is already gone took its values with it, so there is
  // nothing left to clear and nothing to complain about — the same
  // answer `clearMcpServerSecretCommand` gives.
  if (server === undefined) return { disconnected: true, problem: null };
  if (setup === null) return { disconnected: false, problem: `"${server.name}" is not a connector, so there is nothing to disconnect.` };

  for (const name of setup.secretNames) clearMcpServerSecret(secrets, server.id, name);
  return { disconnected: true, problem: null };
}
