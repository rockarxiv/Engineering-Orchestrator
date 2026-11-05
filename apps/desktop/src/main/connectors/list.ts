import {
  EO_SERVER_CAPABILITIES,
  connectorConnected,
  connectorProblem,
  isDeliverableMcpServer,
  isDispatchable,
  reservedMcpServerName,
  type ConnectorSetup,
  type ConnectorView,
  type McpServer,
} from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgentAttachments, listAgents, listMcpServers } from "../db/repos/index.js";
import { listMcpServerSecretNames, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { packConnectors } from "./declared.js";

/**
 * What a person is shown under "what this agent can reach" (EO-315,
 * the original design).
 *
 * Two sources, one list. A **pack** declares a connector for a server EO
 * injects — the developer pack's `repo`, which has no catalogue row and
 * so no id — and a **catalogue row** carries one in `mcp_servers.connector`,
 * which is what a data pack's import writes. They are joined on the
 * server's name, because that is the one identifier both halves have: a
 * pack cannot know a uuid EO minted on somebody else's machine.
 *
 * **Where both speak, the pack's setup wins.** A setup that arrived as
 * data must not be able to relabel a server EO itself ships, which is
 * the same call EO-314 made about a connector EO describes: a document
 * renaming "Repository intelligence" would be words written by whoever
 * sent the file.
 *
 * **What a connector reaches is read, never composed.** The capability
 * line is `mcp_servers.description` — EO-314's column, written by
 * whoever added the server or by a pack's import — and for a server EO
 * injects it is `EO_SERVER_CAPABILITIES`, the same table the import
 * gate's capability lines come from. An empty one is answered by naming
 * the server, which is EO-314's own rule and is honest rather than
 * invented.
 */

/**
 * What this connector reaches, in a person's words.
 *
 * The row's own sentence first, because somebody wrote it about this
 * installation's server; then EO's, for the two servers it injects; then
 * the server's name, which says less but says nothing untrue.
 */
function capabilityFor(serverName: string, server: McpServer | undefined): string {
  const described = server?.description.trim() ?? "";
  if (described !== "") return described;
  return EO_SERVER_CAPABILITIES[serverName] ?? serverName;
}

/** Which of a server's declared secrets the keychain currently answers for. Names, never values. */
function secretsSetFor(secrets: McpServerSecretsOptions, setup: ConnectorSetup, server: McpServer | undefined): string[] {
  if (server === undefined) return [];
  const stored = new Set(listMcpServerSecretNames(secrets, server.id));
  // Intersected with what the *connector* declares rather than with the
  // server's whole `envNames`, so a variable the server needs for some
  // other reason is not read as one this connector is waiting on. The
  // two lists are usually the same — `readMcpServerDraft` folds the
  // connector's names into `envNames` — and "usually" is exactly the
  // kind of thing that stops being true.
  return setup.secretNames.filter((name) => stored.has(name));
}

function toView(
  secrets: McpServerSecretsOptions,
  serverName: string,
  setup: ConnectorSetup,
  server: McpServer | undefined,
): ConnectorView {
  const secretsSet = secretsSetFor(secrets, setup, server);
  return {
    serverId: server?.id ?? null,
    serverName,
    label: setup.label,
    capability: capabilityFor(serverName, server),
    // The view says `setup` where the stored shape says `kind`: on a
    // screen it answers "how do I set this up", and in the row it is the
    // kind of setup the row carries.
    setup: setup.kind,
    secretNames: setup.secretNames,
    secretsSet,
    connected: connectorConnected(setup, secretsSet),
    problem: connectorProblem(setup, secretsSet),
    // A connector with no row is one EO injects itself, and EO injects
    // it or it would not be a connector — there is no switch on it to be
    // off. A row is held to exactly the rule the dispatch path applies,
    // imported rather than restated, so a reach list cannot come to
    // disagree with what is actually written into `.mcp.json`.
    deliverable: server === undefined ? true : isDeliverableMcpServer(server),
  };
}

export interface ConnectorListOptions {
  /**
   * Narrow the list to what a step owned by this role would reach.
   *
   * Null lists every connector the installation has, which is what
   * Settings shows. A role narrows it the way a dispatch does: a
   * catalogue server reaches an agent only if somebody attached it
   * (EO-106), so the connectors on a step are the ones attached to an
   * agent staffing that role. A pack's connector is on every list,
   * because EO injects it for every dispatch rather than because
   * anybody ticked it.
   */
  role?: string | null;
}

export function listConnectorViews(db: Db, secrets: McpServerSecretsOptions, options: ConnectorListOptions = {}): ConnectorView[] {
  const role = options.role ?? null;
  // Live rows only. An archived server is one somebody is done with —
  // it survives so an attachment still resolves to something a screen
  // can name, not so it keeps appearing in a list of what a step can
  // reach.
  const servers = listMcpServers(db);
  const byName = new Map(servers.map((server) => [server.name, server] as const));

  const reachable = role === null ? null : reachableServerIds(db, role);

  const views: ConnectorView[] = [];
  const seen = new Set<string>();

  for (const [serverName, setup] of packConnectors()) {
    seen.add(serverName);
    // A catalogue row under a name EO has reserved is never delivered —
    // `isDeliverableMcpServer` refuses it wherever a dispatch is built —
    // so binding this connector to one would read its state off a row
    // that has nothing to do with the server EO actually injects, and
    // report "switched off" about a server nobody can switch off. The
    // pack's connector is the injected one; the row is somebody's
    // shadowed entry and the catalogue screen is where it is answered.
    const row = reservedMcpServerName(serverName) === null ? byName.get(serverName) : undefined;
    views.push(toView(secrets, serverName, setup, row));
  }

  for (const server of servers) {
    if (server.connector === null || seen.has(server.name)) continue;
    if (reachable !== null && !reachable.has(server.id)) continue;
    views.push(toView(secrets, server.name, server.connector, server));
  }

  // By the words a person reads rather than by the identifier under
  // them: the list is read as a list of capabilities, and sorting by
  // `serverName` would order "Repository intelligence" under `repo`.
  return views.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The catalogue servers a step owned by `role` would actually be
 * dispatched with.
 *
 * Every dispatchable agent staffing the role, unioned, and
 * `isDispatchable` rather than a hand-written pair of checks because
 * that is the one place "may this agent be dispatched" is decided.
 * Several can staff one role: `agents.role` is not unique, and which
 * one a dispatch picks is
 * the supervisor's business rather than this screen's — a reach list
 * that guessed at one would be answering for a step whose other agent is
 * the one that ran.
 */
function reachableServerIds(db: Db, role: string): Set<string> {
  const ids = new Set<string>();
  for (const agent of listAgents(db)) {
    if (agent.role !== role || !isDispatchable(agent)) continue;
    for (const serverId of getAgentAttachments(db, agent.id).mcpServerIds) ids.add(serverId);
  }
  return ids;
}
