import {
  isManagedServer,
  managedServerIds,
  managedServerRefusal,
  unavailableServerProblem,
  NO_POLICY,
  type IpcPayload,
  type IpcResponse,
  type McpServer,
  type McpServerView,
  type OrganisationPolicy,
  type UnavailableServer,
  withoutReservedEnvironmentVariables,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { archiveMcpServer, getMcpServer, listMcpServers, saveMcpServer, setMcpServerEnabled } from "../db/repos/index.js";
import {
  clearMcpServerSecret,
  listMcpServerSecretNames,
  listMcpServerUnreadableNames,
  mcpKeychainStatus,
  readMcpServerSecretEntry,
  storeMcpServerSecret,
  type McpServerSecretsOptions,
} from "../mcp/serverSecrets.js";
import { agentRunVariables, type ModuleSecretsOptions } from "../modules/secrets.js";
import { listOrganisationSecretNames, type OrganisationSecretsOptions } from "../policy/organisationSecrets.js";

/**
 * The MCP server catalogue, over IPC (EO-104).
 *
 * Nothing here dispatches anything. A server saved through these
 * channels reaches no agent until it is attached to one (EO-106) and
 * written into what a provider reads (EO-107, EO-108) — this is the
 * record, landed first so the shape is settled while it is cheap to
 * change.
 *
 * The record half is names only. The view carries `secretsSet`, which
 * is the list of names that have a value, and no record channel returns
 * one — the same arrangement the Jira token and a module's secrets have.
 * The one way a value comes back is `revealMcpServerSecretCommand` at the
 * end of this file, on the machine half, for the person who pressed
 * Reveal at this desktop (EO-489, ARCHITECTURE.md §14.2).
 */

/**
 * A row plus which of its declared names actually has a value.
 *
 * Derived on every read rather than stored, like `usedByStepCount` on a
 * module: the values live outside the database, so a column would be a
 * second thing to keep true and it would be wrong the first time
 * somebody cleared one.
 *
 * Intersected with the declared names rather than listing the directory
 * wholesale, so a value left behind by a variable the server no longer
 * declares does not show up as one it is waiting on.
 */
function toView(secrets: McpServerSecretsOptions, server: McpServer): McpServerView {
  const stored = new Set(listMcpServerSecretNames(secrets, server.id));
  // Stored and no longer decryptable (EO-489): neither set nor absent.
  const unreadable = new Set(listMcpServerUnreadableNames(secrets, server.id));
  return {
    ...server,
    secretsSet: server.envNames.filter((name) => stored.has(name)),
    secretsUnreadable: server.envNames.filter((name) => unreadable.has(name)),
  };
}

/**
 * `managedIds` and `organisationSecrets` ride on the list for
 * `keychain`'s reason (EO-328, ARCHITECTURE.md, "Policy", "Secrets"): each answers a question the
 * list itself raises, and a screen that fetched them separately would
 * render half of itself while the other half was in flight.
 *
 * A row this organisation published is one the person did not add and
 * cannot meaningfully edit, and a declared variable whose value is the
 * organisation's is not one they owe — a row reading "Not set" beside a
 * value the spawn will actually be given is the disagreement worth not
 * having. The names come from this machine's own copy of the store, for
 * `listModuleSecrets`' reason.
 */
/**
 * What this installation's organisation contributes to the list, where
 * it has one (EO-328).
 *
 * Last and optional, so that a caller with no organisation in view — a
 * test, and every call site written before this story — reads as what it
 * is: an installation nobody has published to, whose list has no managed
 * rows and no organisation secrets in it. The production call site in
 * `handlers.ts` always passes one.
 */
export interface ServerOrganisationView {
  secrets: OrganisationSecretsOptions;
  policy: OrganisationPolicy;
}

export function listMcpServerViews(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:list">,
  organisation?: ServerOrganisationView,
  /**
   * Where the environment variables are kept (EO-488): the module
   * secrets' store, which holds them beside its references. Omitted is
   * an installation with none, which is what every caller written
   * before this story is.
   */
  variables?: ModuleSecretsOptions,
): IpcResponse<"mcpServers:list"> {
  const rows = listMcpServers(db, true);
  return {
    servers: (input.includeArchived ?? false ? rows : rows.filter((server) => server.archivedAt === null)).map((server) => toView(secrets, server)),
    keychain: mcpKeychainStatus(secrets.store),
    managedIds: organisation === undefined ? [] : managedServerIds(organisation.policy),
    organisationSecrets: organisation === undefined ? [] : listOrganisationSecretNames(organisation.secrets),
    // The shared ones a run is actually given — read as a run on no step
    // reads them, less the names EO keeps for itself — so the row says
    // "From environment variables" exactly where a spawn would fill it.
    environmentVariables: variables === undefined ? [] : Object.keys(withoutReservedEnvironmentVariables(agentRunVariables(variables, null))).sort(),
    unavailable: organisation === undefined ? [] : notInstalled(rows, organisation.policy),
  };
}

/**
 * What the organisation publishes that this machine has not got
 * (EO-328, review).
 *
 * Derived here, on every read, rather than remembered from whatever the
 * last sync happened to return (invariant 6). A sync's answer is a fact
 * about one moment; this is a fact about the published list and this
 * catalogue *now*, and it stops being true the instant somebody renames
 * their own row — at which point the next sync installs the
 * organisation's and this list is empty again, with nothing to have
 * cleared.
 *
 * One cause today and the shape allows for more: a published definition
 * whose id is not in the catalogue is one `applyPublishedMcpServers`
 * declined to write, and the only thing that makes it decline is a name
 * a local row already holds.
 */
function notInstalled(rows: readonly McpServer[], policy: OrganisationPolicy): UnavailableServer[] {
  const here = new Set(rows.map((server) => server.id));
  return policy.mcpServers
    .filter((published) => !here.has(published.id))
    .map((published) => ({ name: published.name, problem: unavailableServerProblem(published.name) }));
}

/**
 * Creates or edits a server.
 *
 * Every way of getting it wrong — no command on a stdio server, a URL
 * that is not one, an environment-variable name that is not one, the
 * name `eo`, a name another server already has — comes back as
 * `problem`. Nothing on this path throws: the refusals are things a
 * person typed, and the boundary's job is to say so where they can see
 * it (F-04).
 *
 * The problems are joined into one sentence-per-line string rather than
 * sent as a list, because that is the shape every other `problem` on
 * this contract has and a screen that has learned to render one has
 * learned to render all of them.
 */
/**
 * Creates or edits a server — unless the organisation published it
 * (EO-328, ARCHITECTURE.md, "Policy", review).
 *
 * Refused in the command path rather than only hidden in the screen, for
 * `saveAgent`'s reason and the design's: the system
 * agent's admin server reaches this handler through the same dispatch
 * the renderer does, and `mcp_server_save` is a catalogued tool. A row
 * the organisation published is its definition of how that server is
 * reached; a device that rewrote the command would be running something
 * else under a name every desktop trusts, and the next sync would put
 * the definition back — so the alteration would be both effective and
 * temporary.
 *
 * `setEnabled` below is *not* refused, and that is the same split the design
 * makes for a published agent: what is published is the definition, and
 * whether it is switched on here stays the person's.
 */
export function saveMcpServerCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:save">,
  policy: OrganisationPolicy = NO_POLICY,
): IpcResponse<"mcpServers:save"> {
  if (input.id !== undefined && isManagedServer(policy, input.id)) {
    const existing = getMcpServer(db, input.id);
    return { saved: false, server: null, problem: managedServerRefusal(existing?.name ?? input.name) };
  }
  const result = saveMcpServer(db, input);
  if (!result.ok) return { saved: false, server: null, problem: result.problems.join("\n") };
  return { saved: true, server: toView(secrets, result.server), problem: null };
}

export function setMcpServerEnabledCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:setEnabled">,
): IpcResponse<"mcpServers:setEnabled"> {
  if (!setMcpServerEnabled(db, input.id, input.enabled)) return { server: null, problem: "That MCP server no longer exists." };
  const server = getMcpServer(db, input.id);
  return server === undefined ? { server: null, problem: "That MCP server no longer exists." } : { server: toView(secrets, server), problem: null };
}

/**
 * Archives a server.
 *
 * Its secrets are deliberately left where they are. An archived row is
 * still listable and still what an attachment points at, so the values
 * are still reachable and still wanted if it is brought back —
 * `clearMcpServerSecrets` is for a server that is genuinely gone.
 */
export function archiveMcpServerCommand(
  db: Db,
  input: IpcPayload<"mcpServers:archive">,
  policy: OrganisationPolicy = NO_POLICY,
): IpcResponse<"mcpServers:archive"> {
  // A published row is not this machine's to retire (EO-328, review).
  // The next sync would bring it back, so archiving it here is a state
  // that undoes itself — and "switch it off" is the control that
  // actually means what somebody pressing this wants.
  if (isManagedServer(policy, input.id)) {
    const existing = getMcpServer(db, input.id);
    return { archived: false, problem: managedServerRefusal(existing?.name ?? "That server") };
  }
  if (!archiveMcpServer(db, input.id)) return { archived: false, problem: "That MCP server no longer exists." };
  return { archived: true, problem: null };
}

/**
 * Sets one value for one server.
 *
 * Refused when the server is not there, rather than written anyway: a
 * value filed against an id no row carries is a value nothing will ever
 * read, and nothing would clean it up — the same refusal
 * `setModuleSecret` makes about an unpublished step.
 *
 * Refused too when the machine's keychain is missing or weak, and the
 * keychain status comes back either way so the caller can say which of
 * those it was. Storing it regardless is the one thing this must not do:
 * a value written under `basic_text` is readable by anything running as
 * the person, under a screen saying it is safe.
 *
 * Refused in the same shape, and not thrown, when the keychain or the
 * disk fails with the value in hand. `storeMcpServerSecret` catches both
 * and answers with a sentence of its own: a throw from there would reach
 * a caller as `String(error)` in the IPC envelope wherever
 * `exposeErrorDetails` is on — which is how the MCP host dispatches — and
 * an exception out of a call that was handed a token is the one error
 * message in EO that could be quoting one. `clearMcpServerSecretCommand`
 * below needs no such care and deliberately has none: it is given a
 * server and a name, never a value, so nothing it could throw has a
 * secret in it.
 */
export function setMcpServerSecretCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:setSecret">,
): IpcResponse<"mcpServers:setSecret"> {
  const keychain = mcpKeychainStatus(secrets.store);
  const server = getMcpServer(db, input.serverId);
  if (server === undefined) return { saved: false, problem: "That MCP server no longer exists.", keychain };

  const result = storeMcpServerSecret(secrets, server.id, input.name, input.value);
  return result.ok ? { saved: true, problem: null, keychain } : { saved: false, problem: result.reason, keychain };
}

export function clearMcpServerSecretCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:clearSecret">,
): IpcResponse<"mcpServers:clearSecret"> {
  // A server that is already gone took its values with it, so there is
  // nothing left to clear and nothing to complain about.
  if (getMcpServer(db, input.serverId) === undefined) return { cleared: true };

  clearMcpServerSecret(secrets, input.serverId, input.name);
  return { cleared: true };
}

/**
 * The stored value of one of a server's variables, for the person who
 * pressed Reveal at this desktop (EO-489, ARCHITECTURE.md §14.2).
 *
 * A machine-half channel, so a server refuses it at the door and no
 * eo_admin tool is built on it. It reads this server's own store and
 * nothing else: an organisation secret of the same name is never read
 * here, so the answer is the person's own value or none.
 *
 * A server that is gone answers `absent` rather than throwing on its id:
 * its values went with it. One that can no longer be decrypted answers
 * `unreadable`, which the screen draws as a sentence and never as an
 * empty value.
 */
export function revealMcpServerSecretCommand(
  db: Db,
  secrets: McpServerSecretsOptions,
  input: IpcPayload<"mcpServers:revealSecret">,
): IpcResponse<"mcpServers:revealSecret"> {
  const server = getMcpServer(db, input.serverId);
  if (server === undefined) return { state: "absent" };

  const read = readMcpServerSecretEntry(secrets, server.id, input.name);
  return read.state === "value" ? { state: "value", value: read.value } : { state: read.state };
}
