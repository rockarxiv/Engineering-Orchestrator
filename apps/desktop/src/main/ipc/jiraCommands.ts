import type { IpcPayload, IpcResponse, JiraConfigView, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  createJiraConnection,
  deleteJiraBinding,
  deleteJiraConnection,
  getJiraBinding,
  getJiraConnection,
  listJiraConnections,
  outboxDepth,
  projectForWorkspace,
  projectsUsingConnection,
  saveJiraBinding,
  updateJiraConnection,
  type ConnectorBinding,
  type Project,
} from "../db/repos/index.js";
import { checkConnection, jiraForWorkspace, type JiraContext } from "../packs/developer/jira/connection.js";
import { clearToken, hasToken, readToken, storeToken } from "../packs/developer/jira/credentials.js";
import { createJiraClient } from "../packs/developer/jira/index.js";

/**
 * The Jira settings commands (J-01).
 *
 * The token is written here and never read back out: `readToken` is
 * called only inside `jiraFor`, and nothing in this file puts a token
 * into a response.
 *
 * **Every channel here names a repository and writes a project.** The
 * configuration is a `connector_bindings` row on the project since
 * KAN-130 — one binding, whatever a project spans — while the screen and
 * `repositories_list` are where a person picks one, and they show
 * repositories. So the id arrives as a workspace and this is where the
 * hop to its project happens, once, rather than in each caller.
 */

/** The project whose binding a `repositoryId` names, or the refusal to hand back. */
function projectFor(db: Db, workspaceId: string): { ok: true; project: Project } | { ok: false; problem: string } {
  const project = projectForWorkspace(db, workspaceId as Uuid);
  if (!project) return { ok: false, problem: "That repository is not on a project, so there is nothing to connect." };
  return { ok: true, project };
}

/**
 * Connects a repository.
 *
 * The credentials are proved *before* they are stored — a stored token
 * that has never worked is worse than none, because everything
 * afterwards reports a puzzling failure at the moment it matters rather
 * than at the moment you typed it.
 */
export async function connectJira(db: Db, context: JiraContext, input: IpcPayload<"jira:connect">): Promise<IpcResponse<"jira:connect">> {
  const target = projectFor(db, input.repositoryId);
  if (!target.ok) return { ok: false, problem: target.problem };

  // The site is chosen, not described (KAN-22): its URL and credential
  // belong to the connection, and several repositories share one.
  const site = getJiraConnection(db, input.connectionId as Uuid);
  if (!site) return { ok: false, problem: "That Jira connection no longer exists." };

  const token = readToken(context.credentials, site.id);
  if (!token) return { ok: false, problem: `${site.name} has no stored token on this machine. Reconnect it under Jira connections.` };

  const client = createJiraClient({ baseUrl: site.baseUrl, flavour: site.flavour, email: site.email, token }, context.fetchImpl);

  // Proved before it is saved. A repository pointed at a Jira project that
  // does not exist, or that this account cannot see, reports a puzzling
  // failure later rather than a clear one now.
  const check = await checkConnection(client, input.projectKey, input.featureIssueType);
  if (!check.ok) {
    const failed = check.steps.find((step) => !step.ok);
    return { ok: false, problem: failed ? `${failed.name}: ${failed.detail}` : "Jira could not be reached." };
  }

  saveJiraBinding(db, target.project.id, {
    connectionId: site.id,
    projectKey: input.projectKey,
    featureIssueType: input.featureIssueType,
    storyIssueType: input.storyIssueType,
  });

  return { ok: true, problem: null };
}

/** Forgets the connection *and* the credential — leaving the token behind would be a surprise. */
export function disconnectJira(db: Db, context: JiraContext, input: IpcPayload<"jira:disconnect">): IpcResponse<"jira:disconnect"> {
  const target = projectFor(db, input.repositoryId);
  if (!target.ok) return { ok: false };
  const binding = getJiraBinding(db, target.project.id);
  if (!binding) return { ok: true };

  // The token belongs to the site, which other projects may be using
  // (KAN-22). Clearing it unconditionally would silently disconnect
  // every one of them — a shared credential is the thing this feature
  // introduced, and this is where it would first go wrong.
  const site = binding.config.connectionId;
  if (site && projectsUsingConnection(db, site as Uuid).every((other) => other.id === target.project.id)) {
    clearToken(context.credentials, site);
  }

  // The row goes rather than being blanked: "bound to nothing" and
  // "never bound" are one state, and the issue types the person set are
  // not worth keeping for a project that mirrors nowhere — reconnecting
  // asks for them again, exactly as it did when this cleared four
  // columns and left the rest.
  deleteJiraBinding(db, target.project.id);

  return { ok: true };
}

export async function testJira(db: Db, context: JiraContext, input: IpcPayload<"jira:test">): Promise<IpcResponse<"jira:test">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { ok: false, steps: [{ name: "Configuration", ok: false, detail: connection.reason }] };

  return checkConnection(connection.client, connection.binding.projectKey!, connection.binding.featureIssueType ?? "Epic");
}

/** What Jira requires to create this issue type here, so a missing field is caught in Settings. */
export async function jiraFields(db: Db, context: JiraContext, input: IpcPayload<"jira:fields">): Promise<IpcResponse<"jira:fields">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { fields: [], problem: connection.reason };

  try {
    const fields = await connection.client.createMeta(connection.binding.projectKey!, input.issueType);
    return { fields, problem: null };
  } catch (error) {
    return { fields: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

export function saveJiraConfig(db: Db, input: IpcPayload<"jira:saveConfig">): IpcResponse<"jira:saveConfig"> {
  const target = projectFor(db, input.repositoryId);
  if (!target.ok) return { ok: false, problem: target.problem };

  saveJiraBinding(db, target.project.id, {
    fields: input.fields,
    createByDefault: input.createByDefault,
    featureIssueType: input.featureIssueType,
    storyIssueType: input.storyIssueType,
  });

  return { ok: true, problem: null };
}

/** Every status this repository's workflow has, so a state can be mapped to one by name (J-04). */
export async function jiraStatuses(db: Db, context: JiraContext, input: IpcPayload<"jira:statuses">): Promise<IpcResponse<"jira:statuses">> {
  const connection = jiraForWorkspace(db, context, input.repositoryId);
  if (!connection.ok) return { statuses: [], problem: connection.reason };

  try {
    return { statuses: await connection.client.statuses(connection.binding.projectKey!), problem: null };
  } catch (error) {
    return { statuses: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

export function saveJiraStatusMap(db: Db, input: IpcPayload<"jira:saveStatusMap">): IpcResponse<"jira:saveStatusMap"> {
  const target = projectFor(db, input.repositoryId);
  if (!target.ok) return { ok: false, problem: target.problem };

  saveJiraBinding(db, target.project.id, { statusMap: input.statusMap });
  return { ok: true, problem: null };
}

/** The values to send with a transition into one status (J-05). What it *requires* is discovered, not typed. */
export function saveJiraTransitionFields(db: Db, input: IpcPayload<"jira:saveTransitionFields">): IpcResponse<"jira:saveTransitionFields"> {
  const target = projectFor(db, input.repositoryId);
  if (!target.ok) return { ok: false, problem: target.problem };

  const existing = getJiraBinding(db, target.project.id)?.config.transitionFields ?? {};
  const current = existing[input.status];
  if (!current) return { ok: false, problem: `Nothing is known to be required for "${input.status}" yet.` };

  saveJiraBinding(db, target.project.id, { transitionFields: { ...existing, [input.status]: { ...current, values: input.values } } });
  return { ok: true, problem: null };
}

/** What is still waiting to be sent — a stuck queue should be visible, not mysterious. */
export function jiraOutboxView(db: Db, input: IpcPayload<"jira:outbox">): IpcResponse<"jira:outbox"> {
  return outboxDepth(db, input.repositoryId as Uuid, "jira");
}

/**
 * The Jira half of a repository view. Says whether a token exists, never
 * what it is.
 *
 * The site's own details are read through the connection (KAN-22) and
 * the rest off the project's binding (KAN-130), reported flattened so
 * the renderer keeps the shape it had — a repository's Jira settings
 * still read as one thing on screen, even though the credential behind
 * them is shared and the settings belong to its project. Two
 * repositories on one project therefore show the same Jira, which is
 * what they now have.
 */
export function jiraConfigView(db: Db, binding: ConnectorBinding | undefined, credentials: JiraContext["credentials"]): JiraConfigView {
  const config = binding?.config;
  const site = config?.connectionId ? getJiraConnection(db, config.connectionId as Uuid) : undefined;
  return {
    connectionId: config?.connectionId ?? null,
    baseUrl: site?.baseUrl ?? null,
    flavour: site?.flavour ?? null,
    projectKey: config?.projectKey ?? null,
    email: site?.email ?? null,
    featureIssueType: config?.featureIssueType ?? null,
    storyIssueType: config?.storyIssueType ?? null,
    fields: config?.fields ?? null,
    createByDefault: config?.createByDefault ?? true,
    statusMap: config?.statusMap ?? null,
    transitionFields: config?.transitionFields ?? null,
    // The *site's* credential, so two projects sharing a connection
    // both report configured the moment either one is connected.
    credentialsConfigured: site ? hasToken(credentials, site.id) : false,
  };
}

/**
 * The Jira sites EO knows about (KAN-22).
 *
 * `credentialsConfigured` says a token exists, never what it is, and
 * `projectCount` is what makes removing one an informed decision rather
 * than a surprise for every project sharing it.
 */
export function listJiraConnectionsCommand(db: Db, credentials: JiraContext["credentials"]): IpcResponse<"jiraConnections:list"> {
  return {
    connections: listJiraConnections(db).map((site) => ({
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      flavour: site.flavour,
      email: site.email,
      credentialsConfigured: hasToken(credentials, site.id),
      projectCount: projectsUsingConnection(db, site.id).length,
    })),
  };
}

/**
 * Creates or updates a site, proving the credential before storing it.
 *
 * The check is deliberately the cheapest one that exercises auth rather
 * than reachability — a URL that resolves proves nothing about whether
 * the token works, and "connected" that has never authenticated is the
 * state this whole path exists to avoid.
 *
 * An omitted token on an update keeps the stored one, so renaming a
 * connection does not mean retyping a secret.
 */
export async function saveJiraConnection(
  db: Db,
  context: JiraContext,
  input: IpcPayload<"jiraConnections:save">,
): Promise<IpcResponse<"jiraConnections:save">> {
  const existing = input.id ? getJiraConnection(db, input.id as Uuid) : undefined;
  if (input.id && !existing) return { ok: false, problem: "That Jira connection no longer exists." };

  const token = input.token?.trim() || (existing ? readToken(context.credentials, existing.id) : null);
  if (!token) return { ok: false, problem: "A token is needed to reach Jira." };

  const check = await checkConnection(
    createJiraClient({ baseUrl: input.baseUrl, flavour: input.flavour, email: input.email, token }, context.fetchImpl),
    // No project key to check yet: this proves the site and the
    // credential, which is all a connection is. The project key is
    // proved when a binding is made.
    null,
    null,
  );
  if (!check.ok) {
    const failed = check.steps.find((step) => !step.ok);
    return { ok: false, problem: failed ? `${failed.name}: ${failed.detail}` : "Jira could not be reached." };
  }

  const site = existing
    ? updateJiraConnection(db, existing.id, {
        ...(input.name.trim() ? { name: input.name.trim() } : {}),
        baseUrl: input.baseUrl,
        flavour: input.flavour,
        email: input.email,
      })!
    : createJiraConnection(db, { name: input.name, baseUrl: input.baseUrl, flavour: input.flavour, email: input.email });

  if (input.token?.trim()) {
    const stored = storeToken(context.credentials, site.id, input.token.trim());
    if (!stored.ok) return { ok: false, problem: stored.reason };
  }

  const view = listJiraConnectionsCommand(db, context.credentials).connections.find((entry) => entry.id === site.id);
  return { ok: true, connection: view, problem: null };
}

/**
 * Removes a site.
 *
 * Refused while projects still use it. Deleting it would leave each of
 * them pointing at nothing and quietly stop mirroring — the shared
 * credential is the whole point of this feature, and silently breaking
 * several projects at once is the way it would hurt most.
 */
export function removeJiraConnection(db: Db, context: JiraContext, input: IpcPayload<"jiraConnections:remove">): IpcResponse<"jiraConnections:remove"> {
  const site = getJiraConnection(db, input.id as Uuid);
  if (!site) return { ok: true, problem: null }; // already gone is the outcome asked for

  const users = projectsUsingConnection(db, site.id);
  if (users.length > 0) {
    return {
      ok: false,
      problem: `${users.length} project(s) use ${site.name} — ${users.map((project) => project.name).join(", ")}. Disconnect them first.`,
    };
  }

  clearToken(context.credentials, site.id);
  deleteJiraConnection(db, site.id);
  return { ok: true, problem: null };
}
