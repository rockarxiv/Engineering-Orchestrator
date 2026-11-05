import { z } from "zod";

/**
 * What a project is bound to outside EO (KAN-130,
 * ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 *
 * Eight of the `repositories` columns were never facts about a checkout:
 * which Jira site, which project key on it, which issue type an EO
 * feature and an EO story become, the extra fields that site demands,
 * the step-to-status map, what each transition asks for, and whether the
 * "also create this in Jira" box starts ticked. They describe a
 * *binding* — this project's work mirrored into that tracker — and two
 * repositories on one project each kept their own copy of it.
 *
 * So they become one row, `(id, projectId, connector, config)`, keyed by
 * the connector rather than by the pack that ships it: a support pack
 * mirroring to Zendesk adds a row here, not eight columns to a table
 * every project shares. One binding per (project, connector).
 */
export const CONNECTORS = ["jira"] as const;

export const ConnectorSchema = z.enum(CONNECTORS);

export type Connector = z.infer<typeof ConnectorSchema>;

/** The only connector there is today. Named, so a reader is never comparing to a loose string. */
export const JIRA_CONNECTOR: Connector = "jira";

/**
 * What a transition into one Jira status asks for (J-05).
 *
 * `requires` is discovered at push time and written by the drain; Jira
 * only describes transitions available from where an issue currently
 * sits, so there is no moment in Settings when it could be fetched in
 * full. `values` is what the person filled in.
 */
export const JiraTransitionFieldConfigSchema = z.object({
  requires: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      schemaType: z.string(),
      allowedValues: z.array(z.object({ id: z.string(), value: z.string() })),
    }),
  ),
  values: z.record(z.string(), z.unknown()),
});

export type JiraTransitionFieldConfig = z.infer<typeof JiraTransitionFieldConfigSchema>;

/**
 * The `jira` binding's configuration.
 *
 * The eight columns, under the same meanings, spelled without the `jira`
 * prefix they carried: inside the `jira` binding saying it twice is
 * noise — the same call `item_extensions` made in KAN-148.
 *
 * The **token is not here and never will be**: the design puts
 * secrets in the OS keychain, keyed by the connection's id — which is
 * what lets several projects on one site share one credential.
 */
export const JiraBindingConfigSchema = z.object({
  /** Which Jira site (KAN-22). Null means this project mirrors nowhere. */
  connectionId: z.string().nullable().default(null),
  projectKey: z.string().nullable().default(null),
  featureIssueType: z.string().nullable().default(null),
  storyIssueType: z.string().nullable().default(null),
  /** Extra fields Jira requires here, discovered from createmeta and sent on every create. */
  fields: z.record(z.string(), z.unknown()).nullable().default(null),
  /** EO step id -> Jira status name. Discovered, because which transitions exist is per Jira project (J-04). */
  statusMap: z.record(z.string(), z.string()).nullable().default(null),
  /** J-05: what each transition asks for, keyed by the status it leads to. */
  transitionFields: z.record(z.string(), JiraTransitionFieldConfigSchema).nullable().default(null),
  /** Whether "also create this in Jira" starts ticked (J-03). */
  createByDefault: z.boolean().default(true),
});

export type JiraBindingConfig = z.infer<typeof JiraBindingConfigSchema>;

/** A binding that names a site *and* a project on it — either alone mirrors nothing (KAN-22). */
export function isJiraBound(config: JiraBindingConfig | undefined): boolean {
  return Boolean(config?.connectionId && config.projectKey);
}

/**
 * What a connector is, in words a person reads (EO-314,
 * `ARCHITECTURE.md`, "One document").
 *
 * A pack carries its connectors as **definitions** — what this pack
 * talks to and what reaching it means — and the import preflight shows
 * that as a capability rather than as a tool name (ARCHITECTURE.md, "A connector is an MCP server
 * with a setup flow"). So the sentence has to exist somewhere, and it belongs beside the
 * connector rather than in whichever screen happens to render it: the
 * import gate, the setup flow and the needs check all say the same thing
 * about Jira, and three copies is three chances to say it differently.
 *
 * `mcpServer` is how a definition is matched to a tool surface — a role
 * granted `mcp__slack__*` is asking for whatever the `slack` connector
 * says it does. Null for a connector EO reaches itself, as Jira's HTTP
 * client does.
 */
export interface ConnectorDefinition {
  slug: string;
  label: string;
  /** One line, lower case, completing "this pack …": "reads and updates your Jira issues". */
  description: string;
  mcpServer: string | null;
}

/**
 * A definition as a **binding row** carries it (EO-314).
 *
 * Only for a connector EO does not ship. A pack may name one this build
 * has never heard of — that is what a pack *is* — and its label,
 * description and server are then the only words anybody has for it; the
 * binding row is where they live, so the same pack exported from here
 * carries them onward instead of degrading into a bare slug.
 *
 * Deliberately **not** written for a connector EO ships. Jira's words
 * are EO's own (`CONNECTOR_DEFINITIONS`), and a stored copy would let an
 * imported document rename Jira on somebody's installation.
 *
 * The slug is absent because the row already has it, in a column with a
 * unique index on it. Storing it twice is one more thing to disagree.
 */
export const CarriedConnectorDefinitionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
  mcpServer: z.string().nullable().default(null),
});

export type CarriedConnectorDefinition = z.infer<typeof CarriedConnectorDefinitionSchema>;

/** The connectors EO knows, by slug. One today, for `CONNECTORS`' reason. */
export const CONNECTOR_DEFINITIONS: Readonly<Record<Connector, ConnectorDefinition>> = {
  [JIRA_CONNECTOR]: {
    slug: JIRA_CONNECTOR,
    label: "Jira",
    description: "reads and updates your Jira issues",
    mcpServer: null,
  },
};

/**
 * The definition for a slug, or a bare one naming it.
 *
 * A pack may carry a connector this build has never heard of — that is
 * what a pack *is* — and the honest line for one is its own name rather
 * than a refusal: the needs check's job is to say it is not connected
 * here, which is true whether or not EO knows what it does.
 */
export function connectorDefinition(slug: string): ConnectorDefinition {
  return CONNECTOR_DEFINITIONS[slug as Connector] ?? { slug, label: slug, description: "", mcpServer: null };
}
