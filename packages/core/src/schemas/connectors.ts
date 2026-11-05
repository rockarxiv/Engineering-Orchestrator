import { z } from "zod";
import { httpUrlFault } from "./httpUrl.js";

/**
 * A connector is an MCP server with a setup flow (EO-315,
 * ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * Nothing new reaches an agent. A server EO already knows how to deliver
 * is delivered exactly as it was — this is the *way a person gives it
 * what it needs*. A pack ships the setup; the person sees "Connect
 * Slack", signs in, and the step's "what this agent can reach" list gains
 * a line. They never see a command line or a JSON config, which is the
 * whole difference between a connector and the catalogue entry
 * underneath it.
 *
 * ## What is here and what is not
 *
 * **The words are not here.** `schemas/connectorBindings.ts` owns
 * `ConnectorDefinition` — slug, label, description, which MCP server —
 * because EO-314 needed them for the import preflight's capability
 * lines, and the sentence a person reads about Slack has to be one
 * sentence rather than one per screen. The capability line for a
 * connector on a catalogue row is `mcp_servers.description`, EO-314's
 * column, and for a server EO injects it is `EO_SERVER_CAPABILITIES`.
 * This module adds only what EO-314 had no need of: **how somebody
 * connects it**.
 *
 * The two are different scopes as well as different subjects.
 * `connector_bindings` is a *project* bound to something outside EO,
 * and Jira's definition names no MCP server at all because EO reaches
 * Jira over its own HTTP client. A connector here is an *installation's*
 * MCP server, and what it needs is a value in the keychain. A connector
 * that is both would be one row in each, joined on the server's name.
 *
 * `label` is the one word that is here, and it is here because an
 * `mcp_servers` row has no other: `name` is the identifier the model
 * sees in every tool id, and "Connect slack" is not what a button says.
 *
 * **No value is here either.** A setup names the secrets it needs — the
 * same environment-variable names `envNames` holds, and folded into it
 * by `readMcpServerDraft` so they are declared once — and the values
 * live where every other value does: the OS keychain, under
 * `mcp/serverSecrets.ts` (ARCHITECTURE.md, "Secrets").
 */

/**
 * What a person has to do to connect this, and nothing about how it is
 * delivered afterwards.
 *
 * - `token` — paste a value. One box per declared secret.
 * - `oauth` — EO opens the provider's URL in the person's own browser
 *   and receives the callback on a loopback listener it started for the
 *   purpose. `ConnectorOAuthSchema` is the rest of it.
 * - `none` — nothing to do. The server is either already there (EO
 *   injects the repository server) or needs no credential, and the line
 *   exists so the reach list reads the same for everyone rather than
 *   having a hole in it where the developer pack's own server would be.
 *
 * A closed set, and deliberately three: a fourth kind is a member here
 * plus every place that stops compiling, which is exactly the prompt you
 * want on the day something implements one.
 */
export const ConnectorSetupKindSchema = z.enum(["token", "oauth", "none"]);
export type ConnectorSetupKind = z.infer<typeof ConnectorSetupKindSchema>;

/**
 * The authorization-code round trip, as the pack that ships it describes
 * it.
 *
 * EO performs the flow; it does not guess at it. The redirect is always
 * loopback on a port EO binds at the moment it starts — `http://127.0.0.1:<port>/callback`
 * — which is why there is no `redirectUri` here: a definition that named
 * one would be naming a port EO has not got yet.
 *
 * `clientSecret` is deliberately absent. A desktop app is a public
 * client (RFC 8252 §8.5); a secret shipped in a pack is a secret
 * everybody who has the pack has, and PKCE is what actually protects the
 * exchange — EO sends a code challenge on every flow whether or not the
 * provider demands one.
 */
export const ConnectorOAuthSchema = z.object({
  /** Where the person is sent to sign in. */
  authorizeUrl: z.string(),
  /** Where the code is exchanged for a token. */
  tokenUrl: z.string(),
  clientId: z.string(),
  /** Sent as a space-separated `scope`, and omitted entirely when empty. */
  scopes: z.array(z.string()).default([]),
  /**
   * Which of `secretNames` the access token is stored under.
   *
   * Named rather than positional, even though `connectorDefinitionProblems`
   * requires it to be the *only* name an OAuth connector declares: the
   * name is what the server's `envNames` gains and what a dispatch reads,
   * so it has to be said out loud rather than inferred from a list of
   * one. If a second round trip ever produces a second value, this is
   * already the field that says which is which.
   */
  tokenSecretName: z.string(),
});

export type ConnectorOAuth = z.infer<typeof ConnectorOAuthSchema>;

export const ConnectorSetupSchema = z.object({
  /**
   * "Slack". What the button says after the word Connect.
   *
   * The only word this module holds, and only because an `mcp_servers`
   * row has nowhere else to put one: `name` is the identifier the model
   * sees in every tool id, so it is lower case and often not a name at
   * all. What the connector *reaches* is said once, in
   * `mcp_servers.description` (EO-314) or in `EO_SERVER_CAPABILITIES`
   * for a server EO injects.
   */
  label: z.string(),
  /** Whether a person pastes a value, signs in, or does nothing. */
  kind: ConnectorSetupKindSchema,
  /**
   * The environment-variable names this connector's values are stored
   * under.
   *
   * The same names the server declares — `readMcpServerDraft` folds
   * these into `envNames`, so declaring a connector declares the
   * variables it needs and nobody types them twice.
   *
   * **What may be in here is decided by `setup`**, and
   * `connectorDefinitionProblems` refuses the two combinations that
   * would leave a red line nobody can turn green: `none` must declare
   * none, because it draws no button, and `oauth` must declare exactly
   * the one the sign-in stores, because the flow produces exactly one
   * value and there is no box to type a second into. Empty for `none`
   * is what makes it connected the moment it exists.
   */
  secretNames: z.array(z.string()).default([]),
  /** Required when `kind` is `oauth`, meaningless otherwise. */
  oauth: ConnectorOAuthSchema.nullable().default(null),
  /**
   * Whether an agent holding this server can change something outside
   * EO (EO-334, ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
   *
   * The same flag a module's manifest and a builtin's registry entry
   * carry, and read by the same one refusal: a pipeline a webhook
   * enters and a side-effecting step ends, with nobody asked in
   * between. The helpdesk connector that *sends the reply* is the case
   * the design is written about — inbound email straight into an agent that
   * can answer it — and nothing else EO holds can tell that server
   * apart from one that only reads.
   *
   * Whoever describes the connector answers it, because nobody else
   * can: EO sees a tool surface, and which of those tools writes is not
   * something a name reveals. Optional rather than defaulted, so a
   * setup written before this reads as what it was — a connector nobody
   * had asked. Absent is read as false, which refuses less rather than
   * more.
   */
  sideEffects: z.boolean().optional(),
});

export type ConnectorSetup = z.infer<typeof ConnectorSetupSchema>;

/**
 * Whether this connector has everything it was asked for.
 *
 * Derived on every read from what the keychain currently answers, never
 * stored — the same rule `McpServerView.secretsSet` is derived under,
 * and for the same reason: a column would be a second thing to keep true
 * about values that live outside the database. It is also invariant #6's
 * shape applied one level down.
 *
 * A connector declaring no secrets is connected. That is not a special
 * case for `none`: "every name it asked for has a value" is vacuously
 * true of a connector that asked for nothing, and writing it as a branch
 * on the kind would be a second rule saying the same thing.
 */
export function connectorConnected(setup: ConnectorSetup, secretsSet: readonly string[]): boolean {
  return setup.secretNames.every((name) => secretsSet.includes(name));
}

/**
 * Why this line is red, in a sentence, or null when it is green
 * (ARCHITECTURE.md, "The needs check" — "each red line says why it is red").
 *
 * The names are in it. "Not connected" tells somebody nothing they can
 * act on; "EO still needs SLACK_BOT_TOKEN" tells them what the Connect
 * button is about to ask for — and, when they have half of a two-value
 * connector, which half.
 */
export function connectorProblem(setup: ConnectorSetup, secretsSet: readonly string[]): string | null {
  const missing = setup.secretNames.filter((name) => !secretsSet.includes(name));
  if (missing.length === 0) return null;
  if (setup.kind === "oauth") return `${setup.label} is not connected yet — signing in stores ${missing.join(", ")}.`;
  return `${setup.label} is not connected yet — EO still needs ${missing.join(", ")}.`;
}

/** RFC 9110-ish, and the same shape `mcpServers.ts` holds an environment-variable name to. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Everything wrong with a definition, as sentences, or an empty list.
 *
 * Exported and pure for the reason `readMcpServerDraft` is: the
 * repository and the IPC boundary both apply it, and a pack's document
 * will apply it too, so there is one account of what a well-formed
 * connector is rather than three that agree today.
 */
export function connectorSetupProblems(setup: ConnectorSetup): string[] {
  const problems: string[] = [];

  if (setup.label.trim() === "") problems.push("A connector needs a name to put on its Connect button.");
  // What it *reaches* is not checked here, because it is not here: an
  // empty `mcp_servers.description` is answered by naming the server,
  // which is EO-314's own rule for the capability lines on the import
  // gate and is honest rather than invented.

  const seen = new Set<string>();
  for (const name of setup.secretNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      problems.push(`"${name}" is not an environment-variable name: use letters, digits and underscores, not starting with a digit.`);
      continue;
    }
    if (seen.has(name)) problems.push(`"${name}" is listed twice — one name holds one value.`);
    seen.add(name);
  }

  if (setup.kind === "oauth") {
    const oauth = setup.oauth;
    if (oauth === null) {
      problems.push(`"${setup.label}" signs in with OAuth but says nothing about where — it needs an authorize URL, a token URL and a client id.`);
    } else {
      problems.push(...oauthUrlProblems(oauth.authorizeUrl, "the URL the person is sent to"));
      problems.push(...oauthUrlProblems(oauth.tokenUrl, "the URL the code is exchanged at"));
      if (oauth.clientId.trim() === "") problems.push("An OAuth connector needs a client id.");
      if (!setup.secretNames.includes(oauth.tokenSecretName)) {
        problems.push(
          `"${oauth.tokenSecretName}" is where the token would be stored, but it is not one of the secrets "${setup.label}" declares.`,
        );
      }
      // **One round trip produces one value.** EO signs in, receives an
      // access token and stores it under `tokenSecretName`; there is no
      // second thing the flow could learn and nowhere for a person to
      // type one, because the `oauth` kind draws a Connect button rather
      // than a box. A setup asking for a workspace id beside its
      // token would sign in successfully and *stay red* on a name
      // nothing can ever fill — a needs-check line with no button that
      // fixes it, which is the one thing the design
      // says a red line may never be. Refused here, where the author can
      // still change it, rather than discovered by the person who
      // installed the pack.
      const extra = setup.secretNames.filter((name) => name !== oauth.tokenSecretName);
      if (extra.length > 0) {
        problems.push(
          `"${setup.label}" signs in with OAuth, which stores one value — so it cannot also ask for ${extra.join(", ")}. ` +
            `A connector that needs a value somebody types is a \`token\` connector.`,
        );
      }
    }
  } else if (setup.kind === "token" && setup.secretNames.length === 0) {
    problems.push(`"${setup.label}" is connected by pasting a value, but declares no secret to paste it into.`);
  } else if (setup.kind === "none" && setup.secretNames.length > 0) {
    // `none` means there is nothing for a person to do, and that is what
    // every screen draws it as: no button, because a Connect that did
    // nothing is the control invariant 12 rules out for a person as
    // firmly as for an agent. A `none` connector that declared a secret
    // would therefore render red, with its capability line, and no way
    // at all to turn it green — the exact dead end this refusal exists
    // to keep out of somebody's needs check.
    problems.push(
      `"${setup.label}" has nothing to connect, so it cannot need ${setup.secretNames.join(", ")} — ` +
        `there would be no button to set them with. Say \`token\` or \`oauth\` if it needs a value.`,
    );
  }

  return problems;
}

/**
 * One of an OAuth connector's two URLs, held to the shape EO could
 * actually open.
 *
 * Blank was the only thing refused until review, which left a
 * non-empty-but-malformed `authorizeUrl` passing every gate and then
 * throwing out of `new URL` at the moment somebody clicked Connect — a
 * pack author's typo surfacing as an exception in front of the person
 * who installed it. The same check `readMcpServerDraft` holds a remote
 * server's address to, under words that name which of the two is wrong.
 */
function oauthUrlProblems(url: string, role: string): string[] {
  const trimmed = url.trim();
  const fault = httpUrlFault(trimmed);
  if (fault === null) return [];
  if (fault.kind === "empty") return [`An OAuth connector needs ${role}.`];
  if (fault.kind === "no-scheme") return [`${capitalise(role)} is not a URL — "${trimmed}" has to start with http:// or https://.`];
  if (fault.kind === "not-http") return [`${capitalise(role)} has to be http or https — "${trimmed}" is ${fault.protocol}.`];
  return [`${capitalise(role)} has no host in it — "${trimmed}".`];
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One connector as every screen reads it (EO-315).
 *
 * The definition, plus the two things only the main process can answer:
 * which of its secrets the keychain has, and therefore whether it is
 * connected. A screen is handed the derived answer rather than the rule,
 * because "connected" is asked in three places — the step's reach list,
 * Settings, and the needs check — and three copies of the rule is three
 * chances to disagree about a red line.
 */
export const ConnectorViewSchema = z.object({
  /**
   * The `mcp_servers` row, or null for one EO injects itself.
   *
   * Null is the repository server's case and, in time, any other server
   * EO hands an agent without a catalogue row behind it: there is
   * nothing to edit, nothing to archive and no secret to set, which is
   * exactly the `none` setup kind. Every write channel takes a server id,
   * so a null one is a connector nothing can be done to — which is the
   * truth about it.
   */
  serverId: z.string().nullable(),
  /** The key the model sees in every tool id — `repo`, `slack`. */
  serverName: z.string(),
  label: z.string(),
  /**
   * What it reaches, as a capability rather than a tool name: "reads and
   * posts in your Slack channels".
   *
   * Resolved in the main process from `mcp_servers.description` (EO-314)
   * or, for a server EO injects, from `EO_SERVER_CAPABILITIES` — so a
   * screen is handed the sentence rather than the two places it could
   * have come from.
   */
  capability: z.string(),
  /** How a person connects it — `ConnectorSetup.kind`, under the name a screen reads it by. */
  setup: ConnectorSetupKindSchema,
  secretNames: z.array(z.string()),
  /** Which of them the keychain currently answers for. Names, never values. */
  secretsSet: z.array(z.string()),
  connected: z.boolean(),
  /** Why it is red, or null. `connectorProblem`, resolved once in the main process. */
  problem: z.string().nullable(),
  /**
   * Whether the server underneath would actually be handed to an agent
   * on the next dispatch.
   *
   * A connector whose server somebody disabled is a different sentence
   * from one that is missing a token, and a reach list that said
   * "connected" about a server no dispatch delivers would be lying in
   * the one place a person goes to find out what a step can do.
   */
  deliverable: z.boolean(),
});

export type ConnectorView = z.infer<typeof ConnectorViewSchema>;
