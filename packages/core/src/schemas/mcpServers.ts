import { z } from "zod";
import { ConnectorSetupSchema, connectorSetupProblems, type ConnectorSetup } from "./connectors.js";
import { httpUrlFault } from "./httpUrl.js";

/**
 * An MCP server a person added, as it crosses every boundary (EO-104).
 *
 * One definition, because a server crosses several: IPC when the
 * catalogue screen saves one (EO-109), an agent's attachment when it is
 * ticked onto a role (EO-106), and a generated `.mcp.json` or a Codex
 * `config` object when it is finally dispatched (EO-107, EO-108). Three
 * hand-written shapes that had to agree is exactly the arrangement the
 * conventions rule out — the same reason `schemas/modules.ts` exists.
 *
 * What is *not* here is any value. A server declares the **names** of
 * the environment variables it needs and nothing else; the values live
 * in the OS keychain, under `main/mcp/serverSecrets.ts`, and never
 * reach SQLite (ARCHITECTURE.md, "Secrets").
 */

/**
 * How EO reaches the server.
 *
 * `stdio` is a local process — command plus args — and `http`/`sse` are
 * a URL with headers. The two remote transports differ only in how the
 * SDK talks over the connection, never in what EO has to store, which
 * is why they share a shape below.
 */
export const McpTransportSchema = z.enum(["stdio", "http", "sse"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/**
 * A server's name is an identifier, not a label.
 *
 * It is the key under `mcpServers` in a generated configuration and the
 * middle of every tool id the model sees — `mcp__github__create_issue`
 * — so a space or a capital in it is not a styling question: it is a
 * tool nobody can call and an allowlist entry that matches nothing.
 * Held to the same shape a module slug is, for the same reason.
 *
 * Lowercase-only also settles what `eo` means. With `EO` a legal name
 * there would be two spellings of EO's own server, one of which shadows
 * it and one of which quietly does not — so the pattern refuses the
 * question rather than the reserved-name check having to answer it.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The name EO's own service is registered under, and the first name a
 * catalogue entry may not have.
 *
 * EO injects this server into every agent it dispatches. A second entry
 * by that name is refused at save time rather than silently overriding
 * or being silently overridden — whichever way that resolved, the person
 * would be looking at a catalogue that says one thing and an agent that
 * has another.
 *
 * This covers EO's catalogue only. A repository's own `.mcp.json` can
 * still declare a server called `eo`, which is one more reason ambient
 * configuration is locked down by default.
 */
export const RESERVED_MCP_SERVER_NAME = "eo";

/**
 * The name the repository intelligence server is registered under, and
 * the second name a catalogue entry may not have (EO-151).
 *
 * Named for what it describes rather than for what builds it. An agent
 * that learned to call a vendor's tools would be an agent to retrain the
 * day the implementation changes, which is the whole thing the provider
 * port exists to prevent — so the *server* is EO's `repo` even though
 * the tool names inside it are the implementation's, and a model sees
 * `mcp__repo__<whatever the tool is called>`.
 *
 * Reserved on exactly the same argument as `eo` above, and for a reason
 * that is if anything sharper: `repo` is a name somebody would plausibly
 * reach for on their own, and a catalogue entry that took it would
 * shadow the server EO injects — leaving an agent whose index is ready
 * calling somebody else's tools under EO's name.
 *
 * It lives here rather than beside the implementation because this is
 * the file that has to refuse it. One spelling, so the reservation and
 * the registration cannot drift apart.
 */
export const REPOSITORY_MCP_SERVER_NAME = "repo";

/**
 * The name EO's own administrative service is registered under, and the
 * third name a catalogue entry may not have (EO-182).
 *
 * `eo` is the service every dispatched agent talks to EO through, and it
 * is read-mostly on purpose. This is the other one: the whole `mcpHost`
 * catalogue, ungated, served over a loopback listener EO starts with
 * itself and hands to the system agent alone — the agent whose job *is*
 * reconfiguring the installation.
 *
 * Reserved on the same argument as the two above, and the shadowing here
 * would be the worst of the three: a catalogue row called `eo_admin`
 * would displace the one server on which every write EO can make is
 * reachable, and the agent that noticed would be one that had already
 * tried to change something and been answered by somebody else's tools.
 *
 * It lives here rather than beside the listener that serves it because
 * this is the file that has to refuse it, and one spelling is what keeps
 * the reservation and the registration from drifting apart.
 */
export const ADMIN_MCP_SERVER_NAME = "eo_admin";

/**
 * Why a name is EO's rather than a person's, one sentence each.
 *
 * A map rather than a chain of `if`s, so that reserving a third name is
 * an entry here and nothing else — and so that every reservation is
 * forced to say what it is protecting. "That name is reserved" tells
 * somebody nothing they can act on; naming the server they would be
 * shadowing tells them why the name they wanted is already spoken for.
 */
const RESERVED_MCP_SERVER_NAMES: Readonly<Record<string, string>> = {
  [RESERVED_MCP_SERVER_NAME]:
    `"${RESERVED_MCP_SERVER_NAME}" is the name of EO's own MCP server, which every agent already has — a second server by that name would shadow it. Pick another name.`,
  [REPOSITORY_MCP_SERVER_NAME]:
    `"${REPOSITORY_MCP_SERVER_NAME}" is the name of the repository intelligence server EO gives an agent whose ticket has an index — a second server by that name would shadow it. Pick another name.`,
  [ADMIN_MCP_SERVER_NAME]:
    `"${ADMIN_MCP_SERVER_NAME}" is the name of the administrative server EO serves its own system agent on — a second server by that name would shadow it. Pick another name.`,
};

/**
 * The refusal for a name EO has taken, or null when the name is free.
 *
 * Exported because two places have to agree about the set: this file
 * refuses a name a person types, and each provider adapter refuses one
 * that reaches a dispatch anyway — from a row written before the name
 * was reserved, or restored from a backup. Two lists would be two lists
 * to keep in step.
 *
 * Case-folded here rather than at every call site. `MCP_SERVER_NAME_PATTERN`
 * already refuses a capital, so `EO` never becomes a saved server — but
 * this answers about a *name*, and a caller holding one from anywhere
 * else should not have to know that.
 */
export function reservedMcpServerName(name: string): string | null {
  return RESERVED_MCP_SERVER_NAMES[name.trim().toLowerCase()] ?? null;
}

/**
 * What EO's own servers do, in the words the import preflight shows
 * (EO-314, ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * A pack's tool surface is shown as capabilities — one line per MCP
 * server — and EO's own two are servers like any other in that list: a
 * role granted `mcp__eo__item_detail` is asking to read the reader's
 * items, and saying so in the reader's words is the whole point of the
 * line.
 *
 * `eo_admin` is deliberately absent. A pack naming it is refused
 * outright (invariant #11), so a sentence describing the grant would be
 * a sentence that only ever renders for a document nobody may import.
 */
export const EO_SERVER_CAPABILITIES: Readonly<Record<string, string>> = {
  [RESERVED_MCP_SERVER_NAME]: "reads and updates your items and the comments on them",
  [REPOSITORY_MCP_SERVER_NAME]: "reads the code index of the repository an item names",
};

/** Every name EO has taken, for a test or a screen that wants to list them. */
export const RESERVED_MCP_SERVER_NAME_LIST: readonly string[] = Object.keys(RESERVED_MCP_SERVER_NAMES);

/**
 * Whether a catalogue row is one a dispatch may actually hand an agent.
 *
 * Three reasons to withhold, and the third is the one this function
 * exists for. **Disabled** is the switch a person flips while working
 * out whether a server behaves. **Archived** is "I am done with this",
 * and the row survives only so an attachment made earlier still resolves
 * to something a screen can name. **A name EO has taken** is refused
 * here as well as at save time, because the two checks answer different
 * questions: `readMcpServerDraft` is about what a person may type, and
 * this is about what may reach a dispatch — a row written before a name
 * was reserved, or restored from a backup, must still not be able to
 * take the name an agent's own tools come through.
 *
 * It lives in this package, beside the reserved list, because *both*
 * adapters have to agree about it and neither is a good home for a rule
 * the other also obeys. Codex merges rows into `mcp_servers` directly;
 * Claude gets them written into a generated `.mcp.json` and pointed at
 * with `--mcp-config`. Those are entirely different delivery mechanisms
 * that were each filtering separately — which is exactly how one of
 * them came to be missing a name the other refused (EO-151).
 *
 * Deliberately about *servers* only. A skill is held to the first two
 * rules and not the third: a skill called `repo` shadows nothing,
 * because a skill is not a key under `mcpServers`.
 */
export function isDeliverableMcpServer(server: { name: string; enabled: boolean; archivedAt: number | null }): boolean {
  return server.enabled && server.archivedAt === null && reservedMcpServerName(server.name) === null;
}

/**
 * The shape an environment-variable name is held to, everywhere.
 *
 * Identical to the one `ModuleNeedsSchema.env` uses, and for the reason
 * written there: a declared name becomes a filename under the secrets
 * directory, and the path builder refuses anything else by throwing —
 * right for a programmer error and wrong as a user-facing outcome. It
 * is checked here so a name a person typed is refused where they can
 * see it, and the throw stays unreachable from the outside.
 */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 9110 token characters — what an HTTP field name may contain. */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * How a remote server authenticates — the *kind*, not the value (EO-117).
 *
 * The catalogue used to model remote authentication as a bag of headers
 * and nothing else, so a server could say what to send but never what it
 * was doing. That left every reader guessing: the Codex adapter can hand
 * a bearer token to the CLI through `bearer_token_env_var` — the one
 * channel that reaches a remote server, since the CLI makes that
 * connection itself rather than through the fixed environment allowlist
 * a stdio child gets (EO-108) — but only if it can tell a bearer server
 * from any other. Recognising `Authorization: Bearer ${VAR}` out of a
 * header string is reading meaning into a schema that does not describe
 * it, and it silently does nothing for the person who wrote the same
 * intention with different spacing. This is the schema describing it.
 *
 * The same closed set Multica holds in `plugin_installation_config`,
 * minus one member, and spelled the same way on purpose: a person moving
 * between the two reads the same three words.
 *
 * ### Why there is no `oauth`
 *
 * Deliberately, and this is the note the decision was asked to leave.
 *
 * Multica declares four kinds because Multica performs an OAuth flow.
 * EO performs none: there is no authorization-code round trip in this
 * codebase, no redirect listener, no refresh, and nowhere for the pair
 * of tokens such a flow ends with to live. A fourth member here would be
 * an option on the catalogue screen that a person can pick and that both
 * provider adapters can then only ignore — which is exactly the failure
 * this item cites about `agents.config`: a setting real in name only.
 *
 * Leaving it out is also the cheaper thing to undo. The set is a Zod
 * enum read through a discriminated union, so adding `oauth` on the day
 * something implements it is one member plus the places that stop
 * compiling — and stopping the compile at every reader is precisely the
 * prompt you want then. Declaring it now buys nothing and makes the
 * screen lie in the meantime.
 */
export const McpAuthKindSchema = z.enum(["none", "bearer", "header"]);
export type McpAuthKind = z.infer<typeof McpAuthKindSchema>;

/**
 * What a remote server's authentication is, once it is settled.
 *
 * A union rather than a kind plus a nullable name, for the reason the
 * config union below gives: `tokenEnvName` exists on the one member it
 * means something on, so nothing downstream has to ask "is this set on a
 * header server, and what would that mean".
 *
 * `tokenEnvName` is a **name**, never a token. The value it stands for
 * is in the keychain-backed store EO-104 built, under the server's id,
 * and reaches the server through the environment — the same arrangement,
 * and the same reason, as every other value the catalogue refuses to
 * hold (ARCHITECTURE.md, "Secrets").
 */
export const McpRemoteAuthSchema = z.discriminatedUnion("kind", [
  /** Open, or authenticated by something EO is not part of. */
  z.object({ kind: z.literal("none") }),
  /** A bearer token, named here and held in the keychain. */
  z.object({ kind: z.literal("bearer"), tokenEnvName: z.string() }),
  /**
   * Whatever the person wrote in `headers` — what every remote server in
   * the catalogue was before this field existed, and still a first-class
   * answer rather than a legacy one. A header can carry an API key under
   * a name no bearer token has, and EO has no business narrowing that.
   */
  z.object({ kind: z.literal("header") }),
]);

export type McpRemoteAuth = z.infer<typeof McpRemoteAuthSchema>;

/**
 * A well-formed server configuration: command and args, or url and
 * headers, never a mixture.
 *
 * A union rather than six nullable fields, so nothing downstream has to
 * ask "is `command` set on this http server, and what would that mean".
 * `McpServerDraftSchema` below is the flat, tolerant shape a form
 * sends; this is what a stored one has been narrowed to.
 *
 * `auth` is on the two remote members and on neither the stdio one, and
 * that is the pinned decision made checkable: a stdio server is spawned
 * into a fixed environment allowlist and is delivered without its
 * declared values whatever it claims about authenticating (EO-108), so
 * "this stdio server uses a bearer token" is a sentence the type refuses
 * to let anybody write.
 */
export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  z.object({ transport: z.literal("stdio"), command: z.string().min(1), args: z.array(z.string()) }),
  z.object({ transport: z.literal("http"), url: z.url(), headers: z.record(z.string(), z.string()), auth: McpRemoteAuthSchema }),
  z.object({ transport: z.literal("sse"), url: z.url(), headers: z.record(z.string(), z.string()), auth: McpRemoteAuthSchema }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * What this server does, in the words a person reads — "reads your
   * Slack channels" (EO-314).
   *
   * The one field here that is a label rather than an identifier, and it
   * exists because two surfaces need a sentence no tool name can supply:
   * the catalogue screen, where "github" says nothing about what a
   * person has just given an agent, and the pack import gate, which
   * shows a pack's tool surface as **capabilities** rather than as tool
   * names (ARCHITECTURE.md, "A connector is an MCP server with a setup flow"). EO cannot write it —
   * only whoever
   * added the server knows what it reaches — and a tool id cannot either.
   *
   * Empty where nobody has said. The readers fall back to naming the
   * server, which is honest, rather than to inventing a description of
   * somebody else's tools.
   */
  description: z.string().default(""),
  config: McpServerConfigSchema,
  /**
   * The names of the environment variables this server needs — never a
   * value, at any point, in any direction.
   *
   * A generated configuration carries `${VAR}`, and the value arrives
   * through the provider's own environment at spawn. That is what keeps
   * a secret off the process command line, where every other local
   * process can read it out of `/proc/<pid>/cmdline` for as long as the
   * run lasts.
   */
  envNames: z.array(z.string()),
  /**
   * Whether this server is offered at all.
   *
   * Distinct from archived: disabled is a switch a person flips while
   * they work out whether a server is behaving, archived is "I am done
   * with this". Attachment (EO-106) reads both.
   */
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Archived rather than deleted — a run that used it still points at it (invariant #3). */
  archivedAt: z.number().nullable(),
  /**
   * The setup flow that makes this server a *connector* (EO-315), or
   * null on a server nobody has written one for.
   *
   * On the server rather than in a table beside it, because a connector
   * is a server: see `schemas/connectors.ts`, which also says how this
   * relates to the `ConnectorDefinition` a project's binding carries. What
   * it adds is a display name and how a person gives the server what it
   * needs — never a value, and never anything about how the server is
   * reached, which is what `config` above has always said. What it
   * *does* is `description`, a few fields up.
   */
  connector: ConnectorSetupSchema.nullable().default(null),
});

export type McpServer = z.infer<typeof McpServerSchema>;

export const McpServerViewSchema = McpServerSchema.extend({
  /**
   * Which of `envNames` currently has a value in the keychain, by name.
   *
   * Names, never values: this is what a screen renders as "set" beside a
   * field, and what tells a person which of a server's variables they
   * still owe it. Derived on every read rather than stored, because the
   * values live outside the database and a column would be a second
   * thing to keep true.
   */
  secretsSet: z.array(z.string()),
  /**
   * Which of `envNames` has a value stored that this machine can no
   * longer decrypt (EO-489) — another machine's keychain, or one reset
   * since. Names only, as `secretsSet` is.
   *
   * Apart from `secretsSet` rather than in it, because "set" means a
   * spawn would get a value and this one will not; and not folded into
   * "Not set" either, because something *is* stored, and a row that says
   * so is the only way the person learns why a value they saved is not
   * arriving. Optional, so a view built before this field reads as none.
   */
  secretsUnreadable: z.array(z.string()).optional(),
});

export type McpServerView = z.infer<typeof McpServerViewSchema>;

/**
 * What a server's declared name reads as when a value is stored for it
 * and this machine can no longer decrypt it (EO-489): on the server rows
 * in both layouts, and in `mcp_servers_list`. Not "Not set", which would
 * hide that something is there, and never an empty value.
 */
export const UNREADABLE_SERVER_SECRET_LINE = "Stored, but this machine cannot read it";

/**
 * What `safeStorage` actually chose, reported rather than assumed.
 *
 * On Linux `isEncryptionAvailable()` returns true even when Electron has
 * fallen back to its `basic_text` backend, which encrypts with a
 * password compiled into Chromium — so the ciphertext under `userData`
 * is recoverable by anything running as the person. `mcpHost/token.ts`
 * already refuses to mint a bearer token on that backend, and a
 * third-party API token is worth exactly the same care.
 *
 * The whole status is handed to the caller instead of only a boolean,
 * because "EO will not store this" is a sentence a person can only act
 * on if it says which backend it means.
 */
export const McpKeychainSchema = z.object({
  available: z.boolean(),
  /** What Electron reports, verbatim. Null when the store cannot say — an older `SecretStore` has no `getSelectedStorageBackend`. */
  backend: z.string().nullable(),
  /** True when the backend is encryption in name only. Storing a secret is refused while it is. */
  weak: z.boolean(),
  /** Why nothing can be stored, in a sentence, or null when it can. */
  warning: z.string().nullable(),
});

export type McpKeychainStatus = z.infer<typeof McpKeychainSchema>;

/**
 * What a caller sends to save a server: flat, tolerant, and typed.
 *
 * Deliberately not `McpServerConfigSchema`. A discriminated union at the
 * boundary turns "you picked stdio and left the command empty" into a
 * zod issue in the IPC envelope — technically a typed refusal, and
 * useless to the person who has to fix it, since the envelope's message
 * is about a payload rather than about a field on a form. The draft
 * accepts the shape a form actually holds and `readMcpServerDraft`
 * narrows it, so every way of getting it wrong comes back as a sentence
 * beside the field.
 */
export const McpServerDraftSchema = z.object({
  /** Absent creates; present edits that server in place. */
  id: z.string().optional(),
  name: z.string(),
  /**
   * What the server does, in a person's words (EO-314).
   *
   * Optional with no default, for `enabled`'s reason and not for
   * tidiness: `.default("")` would make every save that does not mention
   * a description *erase* one — a caller fixing a header would silently
   * delete the sentence the import gate shows. Absent means "leave it as
   * it is"; a new row with nothing said starts empty.
   */
  description: z.string().optional(),
  transport: McpTransportSchema,
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  url: z.string().nullable().default(null),
  /**
   * Sent as typed, and never a place for a secret.
   *
   * A header that needs one is written `Authorization: Bearer ${TOKEN}`
   * with `TOKEN` declared in `envNames`; the interpolation happens where
   * the configuration is generated, from a value that came out of the
   * keychain. EO cannot tell a literal token from an ordinary header
   * value, so this is a rule the catalogue documents rather than one it
   * can enforce — but it is the reason nothing here is treated as
   * sensitive, and why headers may sit in SQLite when values may not.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * How this server authenticates, when it is a remote one (EO-117).
   *
   * `header` by default, and that default is doing real work rather than
   * picking a favourite: it is what every row written before this field
   * existed is, and what the migration wrote onto them, so a caller that
   * does not mention authentication leaves a header server exactly as it
   * was. A `none` default would have quietly relabelled somebody's
   * server on the next save that touched anything else — the trap
   * `enabled` documents further down this same object.
   *
   * Ignored outright on a stdio draft, the same way `url` is: the
   * narrowed config has no `auth` on a stdio server, because a stdio
   * server is delivered without its declared values whatever it says
   * (EO-108). The form does not offer the field there.
   */
  authKind: McpAuthKindSchema.default("header"),
  /**
   * The name of the environment variable holding the bearer token, and
   * never the token.
   *
   * Read only when `authKind` is `bearer`, where it is required — a
   * bearer server that cannot say which variable holds its token is a
   * server EO could not connect. `readMcpServerDraft` also adds it to
   * `envNames` if it is not already there, so declaring bearer
   * authentication declares the variable it needs and the secrets row
   * for it appears without the person having to list it twice.
   */
  bearerTokenEnvName: z.string().nullable().default(null),
  envNames: z.array(z.string()).default([]),
  /**
   * Optional with no default, deliberately.
   *
   * A `.default(true)` here is not a default at all on an edit: it makes
   * `enabled` always present, so a form that fixes a typo in a command
   * and does not think about the switch turns a server somebody had
   * deliberately turned off back on — silently, because nothing about
   * editing a command says anything about being enabled. Absent means
   * "leave it as it is"; `saveMcpServer` defaults a *new* row to on.
   * `ModuleSaveInputSchema.source` carries the same note for the same
   * reason.
   */
  enabled: z.boolean().optional(),
  /**
   * The connector setup this server carries, when it is one (EO-315).
   *
   * Optional with a null default rather than `.optional()`, and that is
   * a decision rather than a convenience: a connector is words a *pack*
   * wrote, and the catalogue editor does not offer them, so a person
   * fixing a typo in a command sends a draft with no `connector` in it.
   * `saveMcpServer` reads the absent case as "leave whatever is there",
   * exactly as it reads an absent `enabled`; an explicit `null` is how a
   * caller says "this is no longer a connector".
   */
  connector: ConnectorSetupSchema.nullable().optional(),
});

export type McpServerDraft = z.infer<typeof McpServerDraftSchema>;

/** A draft that is well-formed, or the sentences saying why it is not. */
export type McpServerDraftResult =
  | {
      ok: true;
      name: string;
      description: string | undefined;
      config: McpServerConfig;
      envNames: string[];
      enabled: boolean | undefined;
      /** `undefined` leaves the stored setup alone; `null` says this is no longer a connector. */
      connector: ConnectorSetup | null | undefined;
    }
  | { ok: false; problems: string[] };

/**
 * Whether a URL is one EO could actually open a transport to.
 *
 * The check itself is `httpUrlFault`, shared with the connector
 * definitions that have two URLs of their own to hold to the same shape
 * (EO-315). Only the wording is here, because it is a person's: these
 * sentences are shown beside the field on the catalogue form, and a
 * connector's are shown to whoever authored a pack.
 */
function remoteUrlProblem(url: string): string | null {
  const fault = httpUrlFault(url);
  if (fault === null) return null;
  if (fault.kind === "empty") return "A remote server needs a URL.";
  if (fault.kind === "no-scheme") return `"${url}" is not a URL — a remote server's address starts with http:// or https://.`;
  if (fault.kind === "not-http") return `A remote server's URL has to be http or https — "${url}" is ${fault.protocol}.`;
  return `"${url}" has no host in it.`;
}

/**
 * Narrows a draft to a server, or says everything that is wrong with it
 * (EO-104).
 *
 * Every problem at once rather than the first: a person fixing a form
 * one refusal per save is being made to play a guessing game with a
 * dialog box. Sentences rather than codes, because they are shown as
 * written.
 *
 * Pure, and in `packages/core` for that reason — the repository and the
 * IPC command both apply it, and neither should be the only place a
 * malformed server is caught. It refuses; it never throws. Throwing is
 * for programmer error, and a person typing a URL wrong is not one.
 */
export function readMcpServerDraft(draft: McpServerDraft): McpServerDraftResult {
  const problems: string[] = [];

  const name = draft.name.trim();
  const reserved = reservedMcpServerName(name);
  if (name === "") {
    problems.push("A server needs a name.");
  } else if (reserved !== null) {
    problems.push(reserved);
  } else if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    problems.push(
      `"${name}" cannot be a server name: it is the key the model sees in every tool id, so use lowercase letters, digits, hyphens and underscores, starting with a letter or digit.`,
    );
  }

  const envNames: string[] = [];
  for (const envName of draft.envNames) {
    if (!ENV_NAME_PATTERN.test(envName)) {
      problems.push(`"${envName}" is not an environment-variable name: use letters, digits and underscores, not starting with a digit.`);
      continue;
    }
    if (envNames.includes(envName)) {
      problems.push(`"${envName}" is listed twice — one name holds one value.`);
      continue;
    }
    envNames.push(envName);
  }

  // A connector's secrets are the server's environment variables, said
  // once (EO-315). The same arrangement `bearerTokenEnvName` gets a few
  // lines down and for the same reason: a definition that declared
  // `SLACK_BOT_TOKEN` and left the person to also list it under
  // `envNames` would be two lists to keep in step, with the failure — a
  // token stored where nothing reads it — invisible until a dispatch.
  const connector = draft.connector;
  if (connector !== undefined && connector !== null) {
    problems.push(...connectorSetupProblems(connector));
    for (const name of connector.secretNames) {
      if (ENV_NAME_PATTERN.test(name) && !envNames.includes(name)) envNames.push(name);
    }
  }

  let config: McpServerConfig | null = null;

  if (draft.transport === "stdio") {
    const command = (draft.command ?? "").trim();
    if (command === "") problems.push("A stdio server needs a command to run.");
    else config = { transport: "stdio", command, args: draft.args };
  } else {
    const url = (draft.url ?? "").trim();
    const urlProblem = remoteUrlProblem(url);
    if (urlProblem !== null) problems.push(urlProblem);

    for (const headerName of Object.keys(draft.headers)) {
      if (!HEADER_NAME_PATTERN.test(headerName)) problems.push(`"${headerName}" is not an HTTP header name.`);
    }

    let auth: McpRemoteAuth | null = null;
    if (draft.authKind === "bearer") {
      const tokenEnvName = (draft.bearerTokenEnvName ?? "").trim();
      if (tokenEnvName === "") {
        problems.push("A bearer server needs the name of the environment variable that holds its token — the name, not the token.");
      } else if (!ENV_NAME_PATTERN.test(tokenEnvName)) {
        problems.push(`"${tokenEnvName}" is not an environment-variable name: use letters, digits and underscores, not starting with a digit.`);
      } else {
        auth = { kind: "bearer", tokenEnvName };
        // Declared here so it need not be typed twice. `envNames` is the
        // list of names this server needs, and a bearer server needs
        // this one by definition — it is what puts a box for the value
        // on the screen and what `secretsSet` is intersected against.
        if (!envNames.includes(tokenEnvName)) envNames.push(tokenEnvName);
      }
    } else {
      auth = { kind: draft.authKind };
    }

    // Written out per transport rather than passing `draft.transport`
    // through: the two remote members are separate members of the union,
    // and a literal carrying `"http" | "sse"` is assignable to neither.
    if (urlProblem === null && auth !== null) {
      config =
        draft.transport === "http"
          ? { transport: "http", url, headers: draft.headers, auth }
          : { transport: "sse", url, headers: draft.headers, auth };
    }
  }

  if (problems.length > 0 || config === null) return { ok: false, problems };
  // Trimmed but never refused: a description is prose, and there is no
  // way to write one wrongly. Undefined stays undefined — see the
  // draft's own note about what a save that says nothing must not do.
  return { ok: true, name, description: draft.description?.trim(), config, envNames, enabled: draft.enabled, connector };
}
