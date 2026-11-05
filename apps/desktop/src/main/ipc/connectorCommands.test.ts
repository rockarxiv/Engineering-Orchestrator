import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { EO_SERVER_CAPABILITIES, McpServerDraftSchema, REPOSITORY_MCP_SERVER_NAME, type ConnectorSetup, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentEnvironment } from "../agentAttachments/serverEnvironment.js";
import { usePackConnectors } from "../connectors/declared.js";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { createAgent, saveMcpServer, setAgentAttachment } from "../db/repos/index.js";
import { listMcpServerSecretNames, type McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import type { SecretStore } from "../secrets/store.js";
import {
  connectConnectorOAuthCommand,
  connectConnectorTokenCommand,
  disconnectConnectorCommand,
  listConnectorsCommand,
} from "./connectorCommands.js";

/**
 * Connectors, from the pack that ships one to the value a dispatch is
 * handed (EO-315, ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * Against the real migrations and the real secret store, because the
 * acceptance criterion is not "the command returned connected" — it is
 * that **the agent is served the server on the next dispatch**. So every
 * test that connects something ends at `attachmentEnvironment`, which is
 * what a spawn actually reads, rather than at this file's own answer.
 */

/** `safeStorage`, minus the OS. Reversing rather than prefixing, so a plaintext check stays a real one. */
const reverse = (text: string) => [...text].reverse().join("");

/**
 * Which values this keychain refuses to encrypt, by value.
 *
 * A keyring that locks partway through a multi-value write is the case
 * `storeMcpServerSecret` documents and the case the rollback exists for,
 * and it is the only way to reach that path without a real locked
 * keyring. A predicate rather than one value, because the interesting
 * failure is the *second* one: a write that fails and then a restore
 * that fails too. Reset in `beforeEach`.
 */
let refuses: (value: string) => boolean = () => false;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => {
    if (refuses(text)) throw new Error("the keyring is locked");
    return Buffer.from(reverse(text));
  },
  decryptString: (buffer: Buffer) => reverse(buffer.toString()),
};

const SLACK: ConnectorSetup = {
  label: "Slack",
  kind: "token",
  secretNames: ["SLACK_BOT_TOKEN"],
  oauth: null,
};

let handle: DbHandle;
let directory: string;
let secrets: McpServerSecretsOptions;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo connectors "));
  secrets = { directory, store };
  refuses = () => false;
  // No pack folded unless a test says otherwise, which is the state
  // invariant 13's second half describes: the core lists whatever the
  // catalogue's own rows carry and nothing else.
  usePackConnectors(new Map());
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
  usePackConnectors(new Map());
});

/**
 * A catalogue row that carries a connector setup — what a data pack's
 * import writes.
 *
 * The `description` is EO-314's column and is where the capability line
 * comes from: what a connector *reaches* is said once, about the server,
 * and both the import gate and the reach list read the same sentence.
 */
function connectorServer(connector: ConnectorSetup, name = "slack", description = "reads and posts in your Slack channels") {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "slack-mcp", description, connector }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

/** An agent staffing a role, with the server ticked onto it. */
function agentWith(role: string, serverId: string) {
  const agent = createAgent(handle.db, { name: "Reporter", role, provider: "claude", instructions: "" });
  const attached = setAgentAttachment(handle.db, { agentId: agent.id, kind: "mcpServer", id: serverId, attached: true });
  expect(attached.ok).toBe(true);
  return agent;
}

describe("a pack that ships a token connector", () => {
  it("shows it on the step as a red capability line, then serves the server once it is connected", () => {
    const server = connectorServer(SLACK);
    const agent = agentWith("reporter", server.id);

    // The step's question: what would a step owned by `reporter` reach?
    const before = listConnectorsCommand(handle.db, secrets, { role: "reporter" });
    expect(before.connectors).toEqual([
      expect.objectContaining({
        serverId: server.id,
        serverName: "slack",
        label: "Slack",
        capability: "reads and posts in your Slack channels",
        setup: "token",
        connected: false,
        problem: "Slack is not connected yet — EO still needs SLACK_BOT_TOKEN.",
        deliverable: true,
      }),
    ]);

    // Nothing is in the environment a dispatch would build, and the
    // server says which name it is waiting on.
    expect(attachmentEnvironment(handle.db, agent.id, secrets)).toEqual({
      env: {},
      unresolved: [{ server: "slack", name: "SLACK_BOT_TOKEN", reason: "absent" }],
      withheld: [],
    });

    const connected = connectConnectorTokenCommand(handle.db, secrets, {
      serverId: server.id,
      values: { SLACK_BOT_TOKEN: "xoxb-pasted" },
    });
    expect(connected).toEqual({ connected: true, problem: null, keychain: expect.objectContaining({ available: true }) });

    // Under the declared name, in the store a server's values have
    // always been in — not a second directory of its own.
    expect(listMcpServerSecretNames(secrets, server.id)).toEqual(["SLACK_BOT_TOKEN"]);

    const after = listConnectorsCommand(handle.db, secrets, { role: "reporter" });
    expect(after.connectors[0]).toMatchObject({ connected: true, problem: null, secretsSet: ["SLACK_BOT_TOKEN"] });

    // The criterion itself: what the next dispatch puts in the CLI's
    // environment, read through the function a spawn reads it through.
    expect(attachmentEnvironment(handle.db, agent.id, secrets)).toEqual({ env: { SLACK_BOT_TOKEN: "xoxb-pasted" }, unresolved: [], withheld: [] });
  });

  it("is not on a step whose role is staffed by nobody holding it", () => {
    const server = connectorServer(SLACK);
    agentWith("reporter", server.id);

    // A catalogue server reaches an agent only if somebody attached it,
    // so a reach list that showed it on every step would be promising
    // something no dispatch delivers.
    expect(listConnectorsCommand(handle.db, secrets, { role: "approver" }).connectors).toEqual([]);
    // Settings asks the un-narrowed question and sees it.
    expect(listConnectorsCommand(handle.db, secrets, { role: null }).connectors).toHaveLength(1);
  });

  it("refuses a value under a name the connector does not ask for", () => {
    const server = connectorServer(SLACK);

    const result = connectConnectorTokenCommand(handle.db, secrets, { serverId: server.id, values: { SLACK_TEAM_ID: "T1" } });

    expect(result.connected).toBe(false);
    expect(result.problem).toBe('"Slack" does not ask for SLACK_TEAM_ID.');
    // Nothing written: a value filed under a name nothing reads is a
    // value nothing would ever clean up.
    expect(listMcpServerSecretNames(secrets, server.id)).toEqual([]);
  });

  it("stays disconnected, and says what is outstanding, when only half is pasted", () => {
    const server = connectorServer({ ...SLACK, secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] });

    const result = connectConnectorTokenCommand(handle.db, secrets, { serverId: server.id, values: { SLACK_BOT_TOKEN: "xoxb" } });

    expect(result).toMatchObject({ connected: false, problem: "Slack also needs SLACK_TEAM_ID." });
    expect(listMcpServerSecretNames(secrets, server.id)).toEqual([]);
  });

  /**
   * The failure review found, and the reason the rollback snapshots
   * rather than clears.
   *
   * Reconnecting is the ordinary case — somebody rotates one of two
   * tokens and pastes both again. The first cut rolled back by deleting
   * every name the call had written, so a failure on the second write
   * erased a working first credential: the person came to replace one
   * value and left with neither.
   */
  it("puts a working credential back when a later value in the same call fails", () => {
    const server = connectorServer({ ...SLACK, secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] });
    const agent = agentWith("reporter", server.id);

    connectConnectorTokenCommand(handle.db, secrets, {
      serverId: server.id,
      values: { SLACK_BOT_TOKEN: "xoxb-working", SLACK_TEAM_ID: "T-working" },
    });
    expect(attachmentEnvironment(handle.db, agent.id, secrets).env).toEqual({ SLACK_BOT_TOKEN: "xoxb-working", SLACK_TEAM_ID: "T-working" });

    // The keychain locks between the first write and the second — the
    // case `storeMcpServerSecret` documents and answers with a sentence.
    refuses = (value) => value === "T-rotated";
    const result = connectConnectorTokenCommand(handle.db, secrets, {
      serverId: server.id,
      values: { SLACK_BOT_TOKEN: "xoxb-rotated", SLACK_TEAM_ID: "T-rotated" },
    });

    expect(result.connected).toBe(false);
    expect(result.problem).toContain("keyring has locked");
    // Both values are exactly as this call found them: neither the new
    // pair nor a half-applied one, and above all not an empty one.
    expect(attachmentEnvironment(handle.db, agent.id, secrets).env).toEqual({ SLACK_BOT_TOKEN: "xoxb-working", SLACK_TEAM_ID: "T-working" });
  });

  it("clears a name that was not set before, rather than inventing one", () => {
    const server = connectorServer({ ...SLACK, secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] });

    refuses = (value) => value === "T-1";
    connectConnectorTokenCommand(handle.db, secrets, { serverId: server.id, values: { SLACK_BOT_TOKEN: "xoxb", SLACK_TEAM_ID: "T-1" } });

    // "The way it found it" for a name that had nothing is nothing.
    expect(listMcpServerSecretNames(secrets, server.id)).toEqual([]);
  });

  /**
   * Rare — the keychain refusing twice in a row — and the one moment
   * somebody has to be told which credential they now have to set again.
   * Silence here would be a guard dropping work on the floor (invariant
   * 8).
   */
  it("says which credential it could not put back when the restore fails too", () => {
    const server = connectorServer({ ...SLACK, secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"] });
    connectConnectorTokenCommand(handle.db, secrets, { serverId: server.id, values: { SLACK_BOT_TOKEN: "xoxb-working", SLACK_TEAM_ID: "T" } });

    // The keyring locks after the first of the two new values goes in,
    // so the second write fails *and* so does putting the first one
    // back.
    refuses = (value) => value !== "xoxb-rotated";
    const result = connectConnectorTokenCommand(handle.db, secrets, {
      serverId: server.id,
      values: { SLACK_BOT_TOKEN: "xoxb-rotated", SLACK_TEAM_ID: "T-rotated" },
    });

    expect(result.problem).toContain("Slack had SLACK_BOT_TOKEN set before");
    expect(result.problem).toContain("could not put it back — set it again");
  });

  it("forgets the values on disconnect, and leaves the server behind", () => {
    const server = connectorServer(SLACK);
    const agent = agentWith("reporter", server.id);
    connectConnectorTokenCommand(handle.db, secrets, { serverId: server.id, values: { SLACK_BOT_TOKEN: "xoxb" } });

    expect(disconnectConnectorCommand(handle.db, secrets, { serverId: server.id })).toEqual({ disconnected: true, problem: null });

    expect(listMcpServerSecretNames(secrets, server.id)).toEqual([]);
    // The server is still catalogued and still attached — signing out of
    // Slack is not deleting Slack.
    expect(listConnectorsCommand(handle.db, secrets, { role: "reporter" }).connectors[0]).toMatchObject({ connected: false });
    expect(attachmentEnvironment(handle.db, agent.id, secrets).env).toEqual({});
  });
});

describe("a pack-declared connector with nothing to connect", () => {
  it("is on every step's list, green, with no server row behind it", () => {
    usePackConnectors(
      new Map([
        [
          "repo",
          {
            label: "Repository intelligence",
            kind: "none",
            secretNames: [],
            oauth: null,
          } satisfies ConnectorSetup,
        ],
      ]),
    );

    const listed = listConnectorsCommand(handle.db, secrets, { role: "implementer" }).connectors;

    expect(listed).toEqual([
      {
        // No catalogue row: EO injects this one, so there is nothing to
        // edit, archive or set a value on.
        serverId: null,
        serverName: "repo",
        label: "Repository intelligence",
        capability: EO_SERVER_CAPABILITIES[REPOSITORY_MCP_SERVER_NAME],
        setup: "none",
        secretNames: [],
        secretsSet: [],
        connected: true,
        problem: null,
        deliverable: true,
      },
    ]);
  });

  /**
   * A row under a name EO has reserved is never delivered — every
   * dispatch path refuses it — so reading this connector's state off one
   * would report "switched off" about a server nobody can switch off.
   */
  it("ignores a shadowed catalogue row under a name EO keeps for itself", () => {
    usePackConnectors(
      new Map([
        [
          REPOSITORY_MCP_SERVER_NAME,
          {
            label: "Repository intelligence",
            kind: "none",
            secretNames: [],
            oauth: null,
          } satisfies ConnectorSetup,
        ],
      ]),
    );
    // Written straight to the table: `saveMcpServer` refuses the name,
    // which is exactly why a row carrying it could only come from before
    // the reservation or from a restored database.
    handle.db.run(
      sql`INSERT INTO mcp_servers (id, name, transport, command, args, headers, env_names, enabled, created_at, updated_at)
          VALUES ('019fb8c6-0000-7000-8000-00000000beef', ${REPOSITORY_MCP_SERVER_NAME}, 'stdio', 'shadow', '[]', '{}', '[]', 0, 1, 1)`,
    );

    expect(listConnectorsCommand(handle.db, secrets, { role: null }).connectors).toEqual([
      expect.objectContaining({ serverId: null, connected: true, deliverable: true }),
    ]);
  });

  it("keeps EO's label when a row by the same name carries its own", () => {
    usePackConnectors(new Map([["slack", SLACK]]));
    connectorServer({ ...SLACK, label: "Not Slack" });

    // A setup that arrived as data must not be able to relabel a server
    // EO itself ships — the same call EO-314 made about the connectors
    // EO describes. What it *reaches* is the row's own sentence either
    // way, because that is a fact about this installation's server
    // rather than words EO has an opinion about.
    expect(listConnectorsCommand(handle.db, secrets, { role: null }).connectors[0]).toMatchObject({
      label: "Slack",
      capability: "reads and posts in your Slack channels",
    });
  });

  it("falls back to EO's own words, then to the server's name, for a capability nobody wrote", () => {
    usePackConnectors(new Map([[REPOSITORY_MCP_SERVER_NAME, { label: "Repository intelligence", kind: "none", secretNames: [], oauth: null }]]));
    connectorServer(SLACK, "helpdesk", "");

    const listed = listConnectorsCommand(handle.db, secrets, { role: null }).connectors;
    const byName = new Map(listed.map((connector) => [connector.serverName, connector.capability] as const));

    // EO's own two servers are described by EO (EO-314), and a row whose
    // description nobody filled in is answered by naming it — which says
    // less than a sentence and nothing untrue, which is EO-314's rule
    // for the import gate's lines as well.
    expect(byName.get(REPOSITORY_MCP_SERVER_NAME)).toBe(EO_SERVER_CAPABILITIES[REPOSITORY_MCP_SERVER_NAME]);
    expect(byName.get("helpdesk")).toBe("helpdesk");
  });
});

describe("an oauth connector, driven by a fake provider", () => {
  let provider: Server;
  let origin: string;

  beforeEach(async () => {
    provider = createServer((request, response) => {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "the-code");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: redirect.href });
        response.end();
        return;
      }
      if (url.pathname === "/token") {
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ access_token: "xoxb-signed-in" }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      provider.listen(0, "127.0.0.1", () => {
        origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    provider.close();
    provider.closeAllConnections?.();
  });

  function oauthConnector(): ConnectorSetup {
    return {
      label: "Slack",
      kind: "oauth",
      secretNames: ["SLACK_BOT_TOKEN"],
      oauth: {
        authorizeUrl: `${origin}/authorize`,
        tokenUrl: `${origin}/token`,
        clientId: "eo-desktop",
        scopes: ["chat:write"],
        tokenSecretName: "SLACK_BOT_TOKEN",
      },
    };
  }

  it("opens the URL, completes on the loopback callback, and the server is served next dispatch", async () => {
    const server = connectorServer(oauthConnector());
    const agent = agentWith("reporter", server.id);
    const opened: string[] = [];

    const result = await connectConnectorOAuthCommand(
      handle.db,
      secrets,
      { serverId: server.id },
      {
        // The person's browser: opens what it is handed and follows
        // where it is sent, which lands on EO's own loopback listener.
        openExternal: async (url) => {
          opened.push(url);
          await fetch(url, { redirect: "follow" });
        },
        timeoutMs: 10_000,
      },
    );

    expect(result).toEqual({ connected: true, problem: null });
    expect(opened[0]).toContain(`${origin}/authorize`);
    expect(listConnectorsCommand(handle.db, secrets, { role: "reporter" }).connectors[0]).toMatchObject({ connected: true, problem: null });
    expect(attachmentEnvironment(handle.db, agent.id, secrets)).toEqual({ env: { SLACK_BOT_TOKEN: "xoxb-signed-in" }, unresolved: [], withheld: [] });
  });

  it("refuses to open a browser at all when there is nowhere safe to put the answer", async () => {
    const server = connectorServer(oauthConnector());
    const opened: string[] = [];
    const weak: McpServerSecretsOptions = {
      directory,
      store: { ...store, getSelectedStorageBackend: () => "basic_text" },
    };

    const result = await connectConnectorOAuthCommand(
      handle.db,
      weak,
      { serverId: server.id },
      { openExternal: async (url) => void opened.push(url), timeoutMs: 10_000 },
    );

    expect(result.connected).toBe(false);
    expect(result.problem).toContain("basic_text");
    // Checked before the browser, not after: finishing a round trip and
    // then discovering there is nowhere to put the token is a sign-in
    // somebody performed for nothing.
    expect(opened).toEqual([]);
  });

  /**
   * `connectorDefinitionProblems` refuses this where a pack author can
   * still fix it, so the only way to hold a definition like this is a
   * row somebody hand-edited — and the point is *where* it is refused:
   * before a browser opens, not after somebody has signed in for
   * nothing.
   */
  it("refuses a definition the sign-in could not complete, before opening anything", async () => {
    const opened: string[] = [];
    // Straight to the table: `saveMcpServer` reads the definition and
    // would refuse it, which is exactly why this shape can only arrive
    // from outside EO.
    const unfillable = {
      ...oauthConnector(),
      secretNames: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
      oauth: { ...oauthConnector().oauth, tokenSecretName: "SLACK_BOT_TOKEN" },
    };
    handle.db.run(
      sql`INSERT INTO mcp_servers (id, name, transport, command, args, headers, env_names, enabled, created_at, updated_at, connector)
          VALUES ('019fb8c6-0000-7000-8000-00000000c0de', 'slack', 'stdio', 'slack-mcp', '[]', '{}', '["SLACK_BOT_TOKEN","SLACK_TEAM_ID"]', 1, 1, 1, ${JSON.stringify(unfillable)})`,
    );

    const result = await connectConnectorOAuthCommand(
      handle.db,
      secrets,
      { serverId: "019fb8c6-0000-7000-8000-00000000c0de" },
      { openExternal: async (url) => void opened.push(url), timeoutMs: 10_000 },
    );

    expect(result.connected).toBe(false);
    expect(result.problem).toContain("also asks for SLACK_TEAM_ID");
    expect(result.problem).toContain("Whoever wrote this connector");
    expect(opened).toEqual([]);
  });

  it("refuses to sign into a connector that is connected by pasting a value", async () => {
    const server = connectorServer(SLACK);

    const result = await connectConnectorOAuthCommand(
      handle.db,
      secrets,
      { serverId: server.id },
      { openExternal: async () => {}, timeoutMs: 10_000 },
    );

    expect(result).toEqual({ connected: false, problem: '"Slack" is not connected by signing in.' });
  });
});

describe("a server that is not a connector", () => {
  it("is not listed, and cannot be connected or disconnected", () => {
    const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name: "github", transport: "stdio", command: "gh-mcp" }));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(listConnectorsCommand(handle.db, secrets, { role: null }).connectors).toEqual([]);
    expect(connectConnectorTokenCommand(handle.db, secrets, { serverId: saved.server.id, values: {} })).toMatchObject({
      connected: false,
      problem: '"github" is not a connector, so there is nothing to connect.',
    });
    expect(disconnectConnectorCommand(handle.db, secrets, { serverId: saved.server.id })).toMatchObject({ disconnected: false });
  });

  it("answers about a server that is already gone rather than complaining", () => {
    const gone = "019fb8c6-0000-7000-8000-00000000dead" as Uuid;

    expect(disconnectConnectorCommand(handle.db, secrets, { serverId: gone })).toEqual({ disconnected: true, problem: null });
    expect(connectConnectorTokenCommand(handle.db, secrets, { serverId: gone, values: {} })).toMatchObject({
      connected: false,
      problem: "That server no longer exists.",
    });
  });
});
