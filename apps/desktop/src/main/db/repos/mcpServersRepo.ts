import { asc, eq } from "drizzle-orm";
import {
  ConnectorSetupSchema,
  readMcpServerDraft,
  uuidv7,
  type ConnectorSetup,
  type McpServer,
  type McpServerConfig,
  type McpServerDraft,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { mcpServers } from "../schema.js";

/**
 * The MCP server catalogue's rows (EO-104).
 *
 * Nothing here dispatches, attaches or generates anything: this is the
 * record, deliberately landed first so the shape of a server is settled
 * while it is still cheap to change — the same order the module catalogue
 * went in.
 *
 * Every write goes through `readMcpServerDraft`, which is pure and lives
 * in `packages/core`. A malformed server comes back as sentences rather
 * than as a throw, here as well as at the IPC boundary, so a caller that
 * reaches the repository directly cannot write a row that the union
 * `McpServerConfigSchema` would refuse to read back.
 */

/**
 * The two halves of a row, narrowed to the one this server actually
 * uses.
 *
 * A row is trusted to the extent that it was written through
 * `saveMcpServer`, and no further: a `stdio` row with a null command
 * could only come from a hand-edited database, and it is answered here
 * with an empty command rather than a crash, because a catalogue that
 * cannot be listed is worse than one entry that reads as broken. The
 * screen shows it, the person fixes or archives it, and the save path
 * refuses to write it back in that state.
 */
function toConfig(row: typeof mcpServers.$inferSelect): McpServerConfig {
  if (row.transport === "stdio") {
    return { transport: "stdio", command: row.command ?? "", args: (row.args as string[] | null) ?? [] };
  }
  const url = row.url ?? "";
  const headers = (row.headers as Record<string, string> | null) ?? {};
  const auth = toAuth(row);
  return row.transport === "sse" ? { transport: "sse", url, headers, auth } : { transport: "http", url, headers, auth };
}

/**
 * A remote row's authentication (EO-117).
 *
 * `header` is what anything else reads as, and that covers two different
 * rows for one reason. A row written before the column has the default
 * the migration gave it, which *is* `header` — an explicit
 * `Authorization` header is what a person had to write then, and it
 * still works. A row carrying a kind this build has never heard of could
 * only come from a hand-edited database or a downgrade, and `header`
 * leaves it listable and delivering exactly the headers it names rather
 * than crashing the catalogue.
 *
 * A `bearer` row with no name is answered with an empty one, the way a
 * `stdio` row with no command is answered with an empty command and for
 * the note written there: the screen shows it, the person fixes it, and
 * `readMcpServerDraft` refuses to write it back in that state.
 */
function toAuth(row: typeof mcpServers.$inferSelect): Extract<McpServerConfig, { transport: "http" }>["auth"] {
  if (row.authKind === "bearer") return { kind: "bearer", tokenEnvName: row.bearerTokenEnvName ?? "" };
  if (row.authKind === "none") return { kind: "none" };
  return { kind: "header" };
}

/**
 * The connector setup on a row, or null (EO-315).
 *
 * Parsed rather than cast, for the reason a workspace's config is:
 * JSON accepts a row that leaves a key out, and every reader would
 * otherwise cope with `undefined` where the type promises a value. A
 * value this build cannot read is answered with null rather than a
 * throw, on the same grounds `toConfig` answers a command-less stdio row
 * with an empty command — a catalogue that cannot be listed is worse
 * than one entry that has lost its words, and the server underneath is
 * delivered either way.
 */
function toConnector(row: typeof mcpServers.$inferSelect): ConnectorSetup | null {
  if (row.connector === null || row.connector === undefined) return null;
  const parsed = ConnectorSetupSchema.safeParse(row.connector);
  return parsed.success ? parsed.data : null;
}

function toServer(row: typeof mcpServers.$inferSelect): McpServer {
  return {
    id: row.id as Uuid,
    name: row.name,
    // Empty for every row written before the column, which is what an
    // empty description means anyway: nobody has said what this server
    // does (EO-314).
    description: row.description,
    config: toConfig(row),
    envNames: (row.envNames as string[] | null) ?? [],
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    connector: toConnector(row),
  };
}

/**
 * Every live server, by name.
 *
 * Archived ones are excluded here rather than by each caller, the way
 * `listModules` does it: an archived server is kept so that whatever
 * referred to it still has something to point at, not so that it keeps
 * appearing in a picker.
 */
export function listMcpServers(db: Db, includeArchived = false): McpServer[] {
  const rows = db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all().map(toServer);
  return includeArchived ? rows : rows.filter((server) => server.archivedAt === null);
}

export function getMcpServer(db: Db, id: string): McpServer | undefined {
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  return row ? toServer(row) : undefined;
}

export function getMcpServerByName(db: Db, name: string): McpServer | undefined {
  const row = db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
  return row ? toServer(row) : undefined;
}

export type SaveMcpServerResult = { ok: true; server: McpServer } | { ok: false; problems: string[] };

/**
 * The names a row declares, with the connector's folded in whichever
 * draft touched it (EO-315).
 *
 * `readMcpServerDraft` folds them for the caller that *sends* a
 * connector, and that was not enough. The catalogue editor does not
 * offer a connector's setup, so a person adding the command to a server
 * a pack declared sends a draft with no connector and no environment
 * names in it — and the row, whose setup is left alone a few lines up,
 * came back out with nothing declared. The Connect button went on
 * storing a value under a name `attachmentEnvironment` no longer walked:
 * connected on screen, and the agent handed nothing.
 *
 * So the fold happens against the setup that is actually being written,
 * rather than against the one the draft happened to mention. A name the
 * person also typed by hand is kept once — order is theirs, the
 * connector's additions come after.
 */
function declaredEnvNames(fromDraft: readonly string[], connector: ConnectorSetup | null): string[] {
  if (connector === null) return [...fromDraft];
  const names = [...fromDraft];
  for (const name of connector.secretNames) if (!names.includes(name)) names.push(name);
  return names;
}

/**
 * Creates or edits a server.
 *
 * A refusal is a list of sentences and never an exception: a name
 * somebody typed, a URL with a typo in it and a duplicate are all things
 * a person did, and throwing is for programmer error.
 *
 * The name has to be free. Refused rather than resolved, because the
 * name is the key the model sees in every tool id — two servers sharing
 * it means one of them silently never answers, which is the failure that
 * looks most like the server itself being broken.
 */
export function saveMcpServer(db: Db, draft: McpServerDraft, now: number = Date.now()): SaveMcpServerResult {
  const read = readMcpServerDraft(draft);
  if (!read.ok) return { ok: false, problems: read.problems };

  const existing = draft.id === undefined ? undefined : getMcpServer(db, draft.id);
  if (draft.id !== undefined && !existing) return { ok: false, problems: [`No MCP server ${draft.id}.`] };

  const byName = getMcpServerByName(db, read.name);
  if (byName && byName.id !== existing?.id) return { ok: false, problems: [`Another MCP server is already called "${read.name}".`] };

  // Absent leaves the stored setup alone, for `enabled`'s reason
  // sharpened by who writes each half (EO-315): a connector's setup
  // comes from a pack, and the catalogue editor a person uses to fix a
  // command does not offer it — so a draft with no `connector` in it is
  // silence rather than a deletion. An explicit `null` is how a caller
  // says this is no longer a connector.
  const connector = read.connector === undefined ? (existing?.connector ?? null) : read.connector;

  const config = read.config;
  const values = {
    name: read.name,
    // Absent means "leave it as it is", the same arrangement `enabled`
    // has below and for the same reason: a save that fixes a command
    // must not wipe the sentence the import gate shows.
    description: read.description ?? existing?.description ?? "",
    transport: config.transport,
    command: config.transport === "stdio" ? config.command : null,
    args: config.transport === "stdio" ? config.args : [],
    url: config.transport === "stdio" ? null : config.url,
    headers: config.transport === "stdio" ? {} : config.headers,
    // A stdio row takes the column's own default and nothing reads it —
    // the union has no authentication on a stdio server, and EO-108 says
    // why. The bearer name is written only where it means something, so
    // switching a server to `none` clears it rather than leaving a name
    // behind that nothing refers to.
    authKind: config.transport === "stdio" ? "header" : config.auth.kind,
    bearerTokenEnvName: config.transport !== "stdio" && config.auth.kind === "bearer" ? config.auth.tokenEnvName : null,
    envNames: declaredEnvNames(read.envNames, connector),
    // Absent means "leave it as it is": a save that fixes a command must
    // not quietly switch a server somebody turned off back on. A new row
    // is on unless the caller said otherwise — see the draft's own note.
    enabled: read.enabled ?? existing?.enabled ?? true,
    connector,
    updatedAt: now,
  };

  if (existing) {
    db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id)).run();
    return { ok: true, server: getMcpServer(db, existing.id)! };
  }

  const row = db
    .insert(mcpServers)
    .values({ id: uuidv7(), createdAt: now, archivedAt: null, ...values })
    .returning()
    .get();
  return { ok: true, server: toServer(row) };
}

/**
 * Writes down a server a pack named, without configuring it (EO-314).
 *
 * **The words, never the transport.** A pack carries what a server *does*
 * — "reads your Slack channels", which is the capability line the import
 * gate shows — and never a command to run: a document that could write
 * `command` would be a pack shipping executable configuration under
 * another name, with none of the reading and approving a module gets
 * (`ExportedMcpServerSchema`). So the row arrives with the name, the
 * description and nothing to spawn.
 *
 * It lands **disabled**, which is what makes the empty command safe
 * rather than broken: `isDeliverableMcpServer` refuses a disabled row,
 * so nothing reaches a dispatch, and the catalogue screen shows it as a
 * server waiting to be set up. Saving it back through `saveMcpServer`
 * requires a command, which is the person filling in the half only they
 * can.
 *
 * Never overwrites. A server this installation already has is somebody's
 * configuration, description included: an import adds what is missing
 * and touches nothing that is there.
 */
export function declareMcpServer(
  db: Db,
  input: { name: string; description: string; connector?: ConnectorSetup | null },
  now: number = Date.now(),
): boolean {
  if (getMcpServerByName(db, input.name)) return false;

  const connector = input.connector ?? null;
  db.insert(mcpServers)
    .values({
      id: uuidv7(),
      name: input.name,
      description: input.description,
      // The one kind that needs no URL to be a well-formed row at all.
      // `toConfig` answers an empty command, which is the state the
      // screen shows and the person completes.
      transport: "stdio",
      command: null,
      args: [],
      // **The connector's secrets are declared here too** (EO-315), the
      // way `readMcpServerDraft` folds them in on the path a person
      // types. Without it the Connect button would store a value under a
      // name the delivery path never reads — `attachmentEnvironment`
      // walks `envNames` — so the person would connect successfully and
      // the agent would be handed nothing.
      envNames: connector === null ? [] : [...connector.secretNames],
      connector,
      enabled: false,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .run();
  return true;
}

/**
 * Turns a server on or off.
 *
 * Its own function rather than a field on the save, so switching one off
 * cannot change what it points at in the same breath — the same reason
 * `approveModule` is separate from `saveModule`.
 */
export function setMcpServerEnabled(db: Db, id: string, enabled: boolean, at: number = Date.now()): boolean {
  if (!getMcpServer(db, id)) return false;
  db.update(mcpServers).set({ enabled, updatedAt: at }).where(eq(mcpServers.id, id)).run();
  return true;
}

/** Deleting a server archives it — see the column's note and invariant #3. */
export function archiveMcpServer(db: Db, id: string, at: number = Date.now()): boolean {
  if (!getMcpServer(db, id)) return false;
  db.update(mcpServers).set({ archivedAt: at, updatedAt: at }).where(eq(mcpServers.id, id)).run();
  return true;
}

/**
 * Makes this machine's catalogue hold what the organisation published
 * (EO-328, `ARCHITECTURE.md`, "Policy").
 *
 * Written into the ordinary `mcp_servers` table rather than kept beside
 * it, and that is the whole design: every consumer downstream — the
 * attachment picker, the generated `.mcp.json`, the Codex `mcp_servers`
 * object, the dispatch's own account of what an agent was served — then
 * works unchanged. A second table of servers would have meant a second
 * branch at each of those, and one of them forgetting is a server an
 * agent is told about and never given.
 *
 * **The record's id, not a fresh one.** That is what makes a published
 * definition *one* server across an organisation: an attachment made on
 * one desktop names something the next desktop also has. Which rows are
 * the organisation's is derived from the published list rather than
 * stored beside them (`managedServerIds`, invariant 6).
 *
 * Three rules, each of them a case that would otherwise go wrong
 * quietly:
 *
 *  - **A name another row already holds is refused, not renamed.** The
 *    catalogue holds names unique, and the local row is somebody's own
 *    work; taking the name from it would break whatever refers to it in
 *    order to install something they never asked for. The refusal is
 *    reported so a screen can say so.
 *  - **A definition that leaves the publish is archived, never
 *    deleted.** Invariant #3's shape: an attachment that named it still
 *    resolves, and a run that used it still points at something.
 *  - **`enabled` is left as this machine has it.** Whether a server is
 *    switched on here is a local decision — the same split the design makes
 *    for a published agent, whose backend and model stay the person's —
 *    and a sync that flipped it back on every tick would be an
 *    organisation overruling a switch somebody deliberately threw.
 *    A row arriving for the first time is enabled, like any other.
 */
export interface PublishedServerDefinition {
  id: string;
  name: string;
  description: string;
  config: McpServerConfig;
  envNames: string[];
}

export interface PublishedServersResult {
  /** Ids now in this machine's catalogue as the organisation's. */
  applied: string[];
  /** Definitions this machine could not take, and the sentence saying why. */
  refused: { name: string; problem: string }[];
  /** Ids the organisation has stopped publishing, archived here. */
  withdrawn: string[];
}

export function applyPublishedMcpServers(
  db: Db,
  published: readonly PublishedServerDefinition[],
  /**
   * The ids this machine took from the *previous* publish.
   *
   * Passed in rather than queried, because "did this row come from a
   * publish" is not something the table can be asked: a person's own
   * server and an organisation's look identical in it, which is the
   * point of writing them into the same table. The caller holds the
   * policy it is replacing and therefore holds the answer — and because
   * a person's own id is never in that list, this cannot archive
   * anything of theirs.
   */
  previouslyPublished: readonly string[] = [],
  now: number = Date.now(),
): PublishedServersResult {
  const applied: string[] = [];
  const refused: { name: string; problem: string }[] = [];
  const publishedIds = new Set(published.map((server) => server.id));

  for (const server of published) {
    const byName = getMcpServerByName(db, server.name);
    if (byName && byName.id !== server.id) {
      refused.push({
        name: server.name,
        problem: `This machine already has an MCP server called "${server.name}", so your organisation's could not be installed. Rename yours, or ask your admin to rename theirs.`,
      });
      continue;
    }

    const existing = getMcpServer(db, server.id);
    const config = server.config;
    const values = {
      name: server.name,
      description: server.description,
      transport: config.transport,
      command: config.transport === "stdio" ? config.command : null,
      args: config.transport === "stdio" ? config.args : [],
      url: config.transport === "stdio" ? null : config.url,
      headers: config.transport === "stdio" ? {} : config.headers,
      authKind: config.transport === "stdio" ? "header" : config.auth.kind,
      bearerTokenEnvName: config.transport !== "stdio" && config.auth.kind === "bearer" ? config.auth.tokenEnvName : null,
      envNames: server.envNames,
      updatedAt: now,
      // A publish brings a row back: an admin who withdrew a definition
      // and then published it again means it to be usable, and leaving
      // it archived would be EO remembering a decision that has been
      // reversed.
      archivedAt: null,
    };

    if (existing) db.update(mcpServers).set(values).where(eq(mcpServers.id, server.id)).run();
    else db.insert(mcpServers).values({ id: server.id, createdAt: now, enabled: true, connector: null, ...values }).run();
    applied.push(server.id);
  }

  // What the organisation has stopped publishing: archived, never
  // deleted, so an attachment that named it still resolves and a run
  // that used it still points at something (invariant #3).
  const withdrawn: string[] = [];
  for (const id of previouslyPublished) {
    if (publishedIds.has(id)) continue;
    if (archiveMcpServer(db, id, now)) withdrawn.push(id);
  }

  return { applied, refused, withdrawn };
}
