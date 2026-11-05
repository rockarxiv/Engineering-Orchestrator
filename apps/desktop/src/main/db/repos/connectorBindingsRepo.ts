import { and, asc, eq } from "drizzle-orm";
import {
  CarriedConnectorDefinitionSchema,
  connectorDefinition,
  CONNECTOR_DEFINITIONS,
  JIRA_CONNECTOR,
  JiraBindingConfigSchema,
  isJiraBound,
  uuidv7,
  type Connector,
  type ConnectorDefinition,
  type JiraBindingConfig,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { connectorBindings } from "../schema.js";

/**
 * What a project is bound to outside EO (KAN-130, ARCHITECTURE.md, "A workspace is a kind, attached
 * to the project").
 *
 * The eight `jira*` columns `repositories` carried, as one row on the
 * project. Which issue type an EO feature becomes in Jira, which fields
 * that site demands, which status each step means — none of it is a fact
 * about a checkout, and two repositories on one project each kept their
 * own copy that nothing kept in step.
 *
 * One row per (project, connector), which the unique index enforces, so
 * every accessor here is keyed by the pair.
 */
export interface ConnectorBinding {
  id: Uuid;
  projectId: Uuid;
  connector: Connector;
  config: JiraBindingConfig;
  createdAt: number;
  updatedAt: number;
}

function toDomain(row: typeof connectorBindings.$inferSelect): ConnectorBinding {
  return {
    id: row.id as Uuid,
    projectId: row.projectId as Uuid,
    connector: row.connector as Connector,
    // Parsed with the schema's defaults rather than cast, for the reason
    // a workspace's config is: JSON accepts a row that leaves a key out,
    // and every reader would otherwise cope with `undefined` where the
    // type promises a value.
    config: JiraBindingConfigSchema.parse(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The project's Jira binding, or undefined where it has never had one. */
export function getJiraBinding(db: Db, projectId: Uuid): ConnectorBinding | undefined {
  const row = db
    .select()
    .from(connectorBindings)
    .where(and(eq(connectorBindings.projectId, projectId), eq(connectorBindings.connector, JIRA_CONNECTOR)))
    .get();
  return row ? toDomain(row) : undefined;
}

/**
 * Is this project mirroring to Jira (J-01)?
 *
 * Everything Jira-shaped asks this first, and with it false EO behaves
 * exactly as it did before the integration existed. The token is not
 * part of the answer — an unreadable credential is J-01's problem to
 * report, not a reason to pretend the project is unconfigured.
 */
export function isJiraConnected(binding: ConnectorBinding | undefined): boolean {
  return isJiraBound(binding?.config);
}

/**
 * Lays a patch over the binding and writes the result, creating it if
 * this project has never had one.
 *
 * Read-modify-write, because `config` is one JSON value: a caller
 * saving a status map must not have to restate the project key to keep
 * it — the trap a JSON column sets for every partial update.
 */
export function saveJiraBinding(db: Db, projectId: Uuid, patch: Partial<JiraBindingConfig>): ConnectorBinding {
  const now = Date.now();
  const current = getJiraBinding(db, projectId);
  const config = JiraBindingConfigSchema.parse({ ...(current?.config ?? {}), ...patch });

  if (!current) {
    const row = db
      .insert(connectorBindings)
      .values({ id: uuidv7(), projectId, connector: JIRA_CONNECTOR, config, createdAt: now, updatedAt: now })
      .returning()
      .get();
    return toDomain(row);
  }

  const row = db
    .update(connectorBindings)
    .set({ config, updatedAt: now })
    .where(eq(connectorBindings.id, current.id))
    .returning()
    .get();
  return toDomain(row);
}

/**
 * Unbinds a project from Jira.
 *
 * The row goes rather than being blanked: "connected to nothing" and
 * "never connected" are the same state, and storing a payload that
 * asserts silence is what KAN-148 decided against for item extensions.
 */
export function deleteJiraBinding(db: Db, projectId: Uuid): void {
  db.delete(connectorBindings)
    .where(and(eq(connectorBindings.projectId, projectId), eq(connectorBindings.connector, JIRA_CONNECTOR)))
    .run();
}

/** Every Jira binding, oldest first — what a startup sweep and a "who still uses this site" question read. */
export function listJiraBindings(db: Db): ConnectorBinding[] {
  return db
    .select()
    .from(connectorBindings)
    .where(eq(connectorBindings.connector, JIRA_CONNECTOR))
    .orderBy(asc(connectorBindings.createdAt))
    .all()
    .map(toDomain);
}

/** The projects mirroring through one Jira site — what says whether its token is still needed. */
export function projectsUsingJiraConnection(db: Db, connectionId: Uuid): Uuid[] {
  return listJiraBindings(db)
    .filter((binding) => binding.config.connectionId === connectionId)
    .map((binding) => binding.projectId);
}

/**
 * Which connectors this project has a row for, in the order they were
 * written (EO-314).
 *
 * Deliberately not `getJiraBinding`'s shape: this answers about
 * *connectors*, whatever they are, so it carries no config — the config
 * belongs to whichever connector's schema can read it, and Jira's is the
 * only one there is. A pack's `slack` row has a `{}` nobody would want
 * parsed as Jira's.
 *
 * What the import preflight lists as "connectors this pack needs, and
 * which of them you have" (the original design), and what an export reads to write the
 * pack's connector definitions.
 */
export function listConnectorsForProject(db: Db, projectId: Uuid): string[] {
  return connectorDefinitionsForProject(db, projectId).map((definition) => definition.slug);
}

/**
 * The same connectors, with the words anybody has for each (EO-314).
 *
 * Two sources, and which one answers is the whole point. A connector
 * **EO ships** is described by EO (`connectorDefinition`), so an
 * imported document cannot rename Jira on somebody's installation. A
 * connector EO has never heard of is described by whatever was stored
 * with the binding — which is what an import wrote down from the pack —
 * because otherwise the words are gone and the same pack exported from
 * here would carry a bare slug where its author wrote a sentence.
 */
export function connectorDefinitionsForProject(db: Db, projectId: Uuid): ConnectorDefinition[] {
  return db
    .select({ connector: connectorBindings.connector, config: connectorBindings.config })
    .from(connectorBindings)
    .where(eq(connectorBindings.projectId, projectId))
    .orderBy(asc(connectorBindings.createdAt))
    .all()
    .map((row) => {
      const shipped = CONNECTOR_DEFINITIONS[row.connector as Connector];
      if (shipped !== undefined) return shipped;

      const carried = CarriedConnectorDefinitionSchema.safeParse((row.config as { definition?: unknown } | null)?.definition);
      return carried.success ? { slug: row.connector, ...carried.data } : connectorDefinition(row.connector);
    });
}

/**
 * Gives this project a connector with nothing configured in it, unless
 * it already has one (EO-314).
 *
 * How a pack's connectors land: **disconnected** (ARCHITECTURE.md, "Import is the needs check").
 * The row says
 * "this project talks to Jira" and holds no site, no key and no token,
 * because those are the exporting machine's and a credential does not
 * travel — so `isJiraConnected` answers false and every Jira-shaped
 * thing behaves exactly as it does on a project that has never had one,
 * until somebody here connects it.
 *
 * Never overwrites. An import that blanked a binding the person had
 * already configured would disconnect a working project in the act of
 * adding a pipeline to it.
 */
export function createDisconnectedConnector(db: Db, projectId: Uuid, definition: ConnectorDefinition): boolean {
  const existing = db
    .select({ id: connectorBindings.id })
    .from(connectorBindings)
    .where(and(eq(connectorBindings.projectId, projectId), eq(connectorBindings.connector, definition.slug)))
    .get();
  if (existing) return false;

  // The words, for a connector EO does not ship, and nothing at all for
  // one it does — see `CarriedConnectorDefinitionSchema`. Either way the
  // *connection* is absent, which is what "disconnected" means: no site,
  // no key, no token.
  const config =
    CONNECTOR_DEFINITIONS[definition.slug as Connector] === undefined
      ? { definition: { label: definition.label, description: definition.description, mcpServer: definition.mcpServer } }
      : {};

  const now = Date.now();
  db.insert(connectorBindings).values({ id: uuidv7(), projectId, connector: definition.slug, config, createdAt: now, updatedAt: now }).run();
  return true;
}
