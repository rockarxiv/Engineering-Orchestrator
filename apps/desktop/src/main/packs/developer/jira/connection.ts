import { JIRA_ALWAYS_SENT_FIELDS, type JiraBindingConfig, type Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { getJiraBinding, getJiraConnection, getProject, isJiraConnected, projectForWorkspace } from "../../../db/repos/index.js";
import { readToken, type CredentialsOptions } from "./credentials.js";
import { createJiraClient, type FetchLike, type JiraClient, type JiraConnection } from "./index.js";

/**
 * A project's Jira binding plus its stored token, as a client (J-01).
 *
 * Config lives in the database and the token in the OS keychain, so
 * every caller needs both — this is the one place that joins them, and
 * the only place a token is read outside `credentials.ts`.
 */
export interface JiraContext {
  credentials: CredentialsOptions;
  /** Injected for tests, and the reason none of them reach the network. */
  fetchImpl?: FetchLike;
}

export type ConnectionResult =
  | { ok: true; client: JiraClient; projectId: Uuid; binding: JiraBindingConfig; connection: JiraConnection }
  | { ok: false; reason: string };

/**
 * The client for a project, or why there isn't one.
 *
 * Keyed on the project since KAN-130: the eight Jira columns were never
 * facts about a checkout, and two repositories on one project each kept
 * a copy of them. `jiraForWorkspace` below is the same question asked
 * the way the Repositories screen asks it.
 *
 * "Not connected" and "connected but the token is gone" are different
 * answers on purpose: the first is a normal state that callers skip
 * quietly, the second is something a person has to fix.
 */
export function jiraFor(db: Db, context: JiraContext, projectId: string): ConnectionResult {
  const project = getProject(db, projectId as Uuid);
  if (!project) return { ok: false, reason: "That project no longer exists." };

  const binding = getJiraBinding(db, project.id);
  if (!isJiraConnected(binding)) return { ok: false, reason: "This project is not connected to Jira." };

  // The site lives on the connection since KAN-22, and so does the
  // token — keyed by the connection's id, which is what lets several
  // projects on one site share a single credential.
  const site = getJiraConnection(db, binding!.config.connectionId as Uuid);
  if (!site) {
    return { ok: false, reason: `${project.name} points at a Jira connection that no longer exists — pick one in Settings.` };
  }

  const token = readToken(context.credentials, site.id);
  if (token === null) {
    return {
      ok: false,
      reason: `${site.name} has no stored token on this machine — reconnect it in Settings. Every project using it is affected.`,
    };
  }

  const connection: JiraConnection = {
    baseUrl: site.baseUrl,
    flavour: site.flavour,
    email: site.email,
    token,
  };

  return { ok: true, client: createJiraClient(connection, context.fetchImpl), projectId: project.id, binding: binding!.config, connection };
}

/**
 * The same, for a caller holding a workspace id.
 *
 * Which is most of them: the Repositories screen, `repositories_list`
 * and every `jira:*` channel name a repository, because that is what a
 * person configuring one is looking at. The binding is its project's
 * (ARCHITECTURE.md, "A workspace is a kind, attached to the project"), so this is one hop and then
 * the question above.
 */
export function jiraForWorkspace(db: Db, context: JiraContext, workspaceId: string): ConnectionResult {
  const project = projectForWorkspace(db, workspaceId as Uuid);
  if (!project) return { ok: false, reason: "That repository is not on a project, so it mirrors nowhere." };
  return jiraFor(db, context, project.id);
}

export interface ConnectionCheck {
  ok: boolean;
  /** Each step in the order it was tried, so a failure says which part of the path broke. */
  steps: { name: string; ok: boolean; detail: string }[];
}

/**
 * Proves the whole path rather than just the credentials (J-01).
 *
 * Reachable host, accepted credentials, a project key that exists, and
 * a readable createmeta are four separate things that fail for four
 * different reasons — a single "connection failed" would send someone
 * to check the wrong one.
 */
/**
 * Proves a connection, and optionally a Jira project on it.
 *
 * `projectKey` null checks the site and the credential alone, which is
 * all a connection *is* since KAN-22 — the project key belongs to the
 * binding and is proved when one is made.
 */
export async function checkConnection(client: JiraClient, projectKey: string | null, issueType: string | null): Promise<ConnectionCheck> {
  const steps: ConnectionCheck["steps"] = [];

  const step = async (name: string, run: () => Promise<string>): Promise<boolean> => {
    try {
      steps.push({ name, ok: true, detail: await run() });
      return true;
    } catch (error) {
      steps.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  // Stops at the first failure: asking about a project key with
  // credentials Jira has already rejected only produces a second,
  // less useful error.
  const authed = await step("Credentials", async () => {
    const me = await client.myself();
    return `Signed in as ${me.displayName || me.accountId}`;
  });
  if (!authed) return { ok: false, steps };
  if (projectKey === null) return { ok: true, steps };

  const found = await step("Repository", async () => {
    const repository = await client.repository(projectKey);
    return `${repository.key} — ${repository.name}`;
  });
  if (!found) return { ok: false, steps };

  await step("Fields", async () => {
    const fields = await client.createMeta(projectKey, issueType ?? "");
    // An empty list here is usually a permissions problem rather than a
    // repository that genuinely requires nothing, so it says both.
    if (fields.length === 0) {
      return `Jira listed no fields for "${issueType}" — check the issue type exists here and that you can create issues in this repository.`;
    }

    // Counting *every* required field says "4 required fields" about a
    // repository that in fact needs nothing configured, directly under a
    // panel saying so. What matters is how many someone has to fill in.
    const mustFill = fields.filter((field) => field.required && !JIRA_ALWAYS_SENT_FIELDS.has(field.id));
    return mustFill.length === 0
      ? `"${issueType}" needs nothing beyond what EO already sends`
      : `${mustFill.length} field(s) to fill in for "${issueType}": ${mustFill.map((field) => field.name).join(", ")}`;
  });

  return { ok: steps.every((entry) => entry.ok), steps };
}
