import { asc, eq } from "drizzle-orm";
import { uuidv7, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { jiraConnections } from "../schema.js";
import { getJiraBinding, listJiraBindings, saveJiraBinding } from "./connectorBindingsRepo.js";
import { getProject, type Project } from "./projectsRepo.js";

/**
 * Jira sites EO can talk to (KAN-22).
 *
 * A connection used to be part of a repository, which meant two
 * repositories on one site kept two copies of the same token — entered
 * twice, rotated twice, and quietly broken on whichever one you forgot.
 * Connections are global now and a project's Jira binding names one.
 *
 * What did *not* move is anything belonging to a particular Jira
 * project: its key, its issue types, the fields it demands on create,
 * its status map. Those are the binding's (KAN-130), because two Jira
 * projects on one site can differ in all of them (J-05).
 */

export interface JiraConnectionRecord {
  id: Uuid;
  name: string;
  baseUrl: string;
  flavour: "cloud" | "datacenter";
  /** Cloud only: Basic auth is email:token. */
  email: string | null;
  createdAt: number;
  updatedAt: number;
}

function toDomain(row: typeof jiraConnections.$inferSelect): JiraConnectionRecord {
  return {
    id: row.id as Uuid,
    name: row.name,
    baseUrl: row.baseUrl,
    flavour: row.flavour as "cloud" | "datacenter",
    email: row.email,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The host, which is what someone calls a site before being asked to name it. */
export function defaultConnectionName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
}

export interface CreateJiraConnectionInput {
  name?: string;
  baseUrl: string;
  flavour: "cloud" | "datacenter";
  email?: string | null;
}

export function createJiraConnection(db: Db, input: CreateJiraConnectionInput): JiraConnectionRecord {
  const now = Date.now();
  const row = db
    .insert(jiraConnections)
    .values({
      id: uuidv7(),
      name: input.name?.trim() || defaultConnectionName(input.baseUrl),
      baseUrl: input.baseUrl,
      flavour: input.flavour,
      email: input.email ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return toDomain(row);
}

export function listJiraConnections(db: Db): JiraConnectionRecord[] {
  return db.select().from(jiraConnections).orderBy(asc(jiraConnections.createdAt)).all().map(toDomain);
}

export function getJiraConnection(db: Db, id: Uuid): JiraConnectionRecord | undefined {
  const row = db.select().from(jiraConnections).where(eq(jiraConnections.id, id)).get();
  return row ? toDomain(row) : undefined;
}

export interface UpdateJiraConnectionInput {
  name?: string;
  baseUrl?: string;
  flavour?: "cloud" | "datacenter";
  email?: string | null;
}

export function updateJiraConnection(db: Db, id: Uuid, patch: UpdateJiraConnectionInput): JiraConnectionRecord | undefined {
  const row = db
    .update(jiraConnections)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(jiraConnections.id, id))
    .returning()
    .get();
  return row ? toDomain(row) : undefined;
}

/**
 * Which projects would stop mirroring if this connection went.
 *
 * Asked before deleting, so the answer can be shown rather than
 * discovered: several projects sharing a connection is the normal case
 * this feature exists for, and removing one silently is exactly the
 * quiet breakage it is meant to prevent.
 */
export function projectsUsingConnection(db: Db, id: Uuid): Project[] {
  return listJiraBindings(db)
    .filter((binding) => binding.config.connectionId === id)
    .flatMap((binding) => getProject(db, binding.projectId) ?? []);
}

export function deleteJiraConnection(db: Db, id: Uuid): void {
  // The bindings survive with their Jira project key and field settings
  // intact, looking exactly like a project that was never connected.
  //
  // Cleared here rather than by a foreign key, which is what
  // `repositories.jira_connection_id` had: the id lives inside the
  // binding's JSON now, and SQLite cannot police a value it cannot see.
  // So the sweep is explicit, and it is why this is a transaction — a
  // connection deleted with a binding still naming it would leave the
  // Jira path failing on a lookup that can never succeed again.
  db.transaction(() => {
    for (const binding of listJiraBindings(db)) {
      if (binding.config.connectionId === id) saveJiraBinding(db, binding.projectId, { connectionId: null });
    }
    db.delete(jiraConnections).where(eq(jiraConnections.id, id)).run();
  });
}

/**
 * The site a project's issues live on, for building a link.
 *
 * Two hops rather than the join written out at each of the three places
 * that wanted it — a card's Jira link, a pull request's body, and the
 * review context. It takes the project because the binding is the
 * project's (KAN-130); it took the repository while the connection id
 * was a column on one.
 */
export function jiraBaseUrlFor(db: Db, projectId: Uuid | null | undefined): string | null {
  if (!projectId) return null;
  const connectionId = getJiraBinding(db, projectId)?.config.connectionId;
  if (!connectionId) return null;
  return getJiraConnection(db, connectionId as Uuid)?.baseUrl ?? null;
}
