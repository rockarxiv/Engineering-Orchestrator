import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_MCP_SERVER_NAME, McpServerDraftSchema } from "@eo/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { listMcpServerViews, saveMcpServerCommand, setMcpServerSecretCommand } from "../ipc/mcpServerCommands.js";
import type { SecretStore } from "../secrets/store.js";
import type { McpServerSecretsOptions } from "../mcp/serverSecrets.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { TOOLS } from "./catalog.js";
import { toolsFor, writeMcpConfig } from "./gate.js";
import { createAdminMcpHost, type AdminMcpHost } from "./admin.js";

/**
 * EO's second listener, over a real socket (EO-182).
 *
 * The SDK's own client, for the reason http.test.ts uses it next door: a
 * hand-rolled fetch against our own idea of the protocol would prove
 * only that we are self-consistent, and what is being claimed here is
 * that a CLI EO spawns can connect to this and be handed the catalogue.
 *
 * Four properties, and each of them is something the external host does
 * differently. The tool list is the whole array whatever the destructive
 * switch says. The credential is in memory and never on disk. The port
 * is whatever the OS gave. And — the one it does *not* do differently,
 * which is why it is asserted rather than assumed — no secret crosses
 * this wire either, mirroring the proof in dispatch.test.ts.
 */
const SOCKET_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: SOCKET_TIMEOUT_MS, hookTimeout: SOCKET_TIMEOUT_MS });

const opts = { exposeErrorDetails: true };

/** A value that only ever exists in this test's memory — nothing on this wire may carry it. */
const SECRET = "ghp-nobody-may-ever-read-this";

/**
 * Reversing rather than prefixing, as dispatch.test.ts does and for the
 * same reason: "the value is nowhere in the reply" has to be a claim
 * about the code under test rather than about the fake.
 */
const reverse = (text: string) => [...text].reverse().join("");
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(reverse(text)),
  decryptString: (buffer) => reverse(buffer.toString()),
  getSelectedStorageBackend: () => "gnome_libsecret",
};

let handle: DbHandle;
let host: AdminMcpHost;
/** Stands in for `app.getPath("userData")`: nothing about this server may appear under it. */
let userData: string;
let secretsDirectory: string;
let secrets: McpServerSecretsOptions;
let clients: Client[] = [];

beforeEach(() => {
  handle = openMigratedTestDb();
  userData = mkdtempSync(join(tmpdir(), "eo admin userdata "));
  secretsDirectory = join(userData, "mcp-server-secrets");
  secrets = { directory: secretsDirectory, store };

  registerHandler("items:list", () => listItemSummaries(handle.db, null), opts);
  registerHandler("mcpServers:list", (payload) => listMcpServerViews(handle.db, secrets, payload), opts);
  registerHandler("mcpServers:save", (payload) => saveMcpServerCommand(handle.db, secrets, payload), opts);

  host = createAdminMcpHost({ db: handle.db, version: "0.0.0-test" });
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  await host.stop();
  clearHandlerRegistry();
  handle.close();
  rmSync(userData, { recursive: true, force: true });
});

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    // @ts-expect-error — the SDK's own client transport does not satisfy the
    // SDK's own Transport interface under `exactOptionalPropertyTypes: true`.
    // Their bug, between two of their own exports — and using anything but
    // their client here would defeat the point of testing over the transport.
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  clients.push(client);
  return client;
}

/** The host, up, with the endpoint it is actually on and one turn's bearer for it. */
async function listening(): Promise<{ url: string; token: string }> {
  const status = await host.start();
  expect(status.problem).toBeNull();
  const endpoint = host.endpoint();
  if (endpoint === null) throw new Error("the internal host did not come up");
  return { url: endpoint.url, token: endpoint.lease().token };
}

/** An initialize, sent by hand: what a CLI sends first, and what the cap answers. */
function initialize(url: string, token: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } },
    }),
  });
}

/**
 * One system-agent turn, as the CLI really runs it (EO-444): it is
 * spawned with a bearer of its own, opens a session, lists the tools,
 * and exits without sending DELETE. `client.close()` is the exit — it
 * drops the transport's connections and sends nothing — and was checked
 * against the SDK's own client, whose DELETE is `terminateSession`, a
 * separate call no CLI was seen to make. `release` is what the adapter
 * does once the turn's process is over.
 */
async function turn(): Promise<string[]> {
  const endpoint = host.endpoint();
  if (endpoint === null) throw new Error("the internal host is not up");
  const lease = endpoint.lease();
  const client = await connect(endpoint.url, lease.token);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  await client.close();
  lease.release();
  return names;
}

/** Long enough for a release's closes, which run in the background, to have run. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A catalogued server with a value in the keychain, as a person would have made one. */
function github(): void {
  const draft = McpServerDraftSchema.parse({
    name: "github",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envNames: ["GITHUB_TOKEN"],
  });
  const saved = saveMcpServerCommand(handle.db, secrets, draft);
  expect(saved.problem).toBeNull();
  expect(setMcpServerSecretCommand(handle.db, secrets, { serverId: saved.server?.id ?? "", name: "GITHUB_TOKEN", value: SECRET }).saved).toBe(true);
}

describe("EO's internal administrative MCP host", () => {
  it("binds loopback on a port the OS chose, and answers there", async () => {
    const { url, token } = await listening();

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // Ephemeral means "not the configured one and not a constant": there
    // is no setting for this, so a fixed number would only be something
    // to collide with.
    expect(new URL(url).port).not.toBe("4319");
    expect(Number(new URL(url).port)).toBeGreaterThan(0);

    const client = await connect(url, token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("holds its token in memory only — nothing about it is written under userData", async () => {
    const { token } = await listening();

    expect(token.length).toBeGreaterThan(20);
    // The external host mints into `userData/mcp` because a person has to
    // read that one and paste it into an editor. Nobody pastes this one
    // anywhere, so there is no file to protect and none is made.
    expect(existsSync(join(userData, "mcp"))).toBe(false);
    expect(readdirSync(userData)).toEqual([]);
  });

  it("serves every tool in the catalogue, whatever the destructive switch says", async () => {
    // Off is the default and the case that matters: the switch is about a
    // stranger holding a token out of the keychain, and this socket
    // answers a process EO spawned itself.
    writeMcpConfig(handle.db, { dangerousOperations: false });
    const { url, token } = await listening();

    const client = await connect(url, token);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual(TOOLS.map((tool) => tool.name).sort());
    // Including the ones the external listener is not offered at all
    // (EO-192). This socket is the reason `adminOnly` can exist.
    expect(names).toContain("view_current");
    expect(toolsFor(true, "external").map((tool) => tool.name)).not.toContain("view_current");
    // Named rather than only counted, because these are the ones the
    // gate exists to withhold, and the four the boundary comments argue
    // about are among them.
    for (const gated of ["ticket_delete", "mcp_server_save", "agent_attachments_set", "agent_save", "module_save", "module_approve"]) {
      expect(names, `${gated} must be served here`).toContain(gated);
    }
    // And the external host is unchanged by any of this: with the switch
    // off it still offers strictly less than the whole array.
    expect(toolsFor(false).length).toBeLessThan(TOOLS.length);
    expect(toolsFor(false).map((tool) => tool.name)).not.toContain("ticket_delete");
  });

  it("calls a gated tool without the refusal the external host would give", async () => {
    writeMcpConfig(handle.db, { dangerousOperations: false });
    const { url, token } = await listening();
    const client = await connect(url, token);

    // `mcp_server_save` is one of the four the boundary comments used to
    // forbid outright. Refused for its *name* here, which is the
    // reservation working — and pointedly not refused for being gated.
    const result = await client.callTool({ name: "mcp_server_save", arguments: { name: ADMIN_MCP_SERVER_NAME, transport: "stdio", command: "node" } });

    const text = JSON.stringify(result.content);
    expect(text).toContain("shadow");
    expect(text).not.toContain("Allow destructive operations");
  });

  it("carries no secret over its wire, as the external one does not", async () => {
    github();
    const { url, token } = await listening();
    const client = await connect(url, token);

    const result = await client.callTool({ name: "mcp_servers_list", arguments: {} });

    // A name and whether something is behind it. That is the whole of
    // what any caller learns about a stored value, and being EO's own
    // agent at the other end buys no more of it: the catalogue has no
    // channel that reads one back, so there is nothing here to leak.
    expect(JSON.stringify(result)).toContain("GITHUB_TOKEN (set)");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("refuses a caller that has not got the token", async () => {
    const { url } = await listening();

    // Loopback is not a boundary — every process on this machine can
    // reach 127.0.0.1. The token is the whole of the difference between
    // "EO's own agent" and "anything running on this laptop".
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(unauthorized.status).toBe(401);

    const wrong = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-the-token-not-the-token-not-the",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(wrong.status).toBe(401);
  });

  it("has no endpoint before it starts, and none after it stops", async () => {
    // What a dispatch asks per turn. Null is the honest answer while the
    // socket is not up: an agent handed a server that cannot answer
    // spends its turn on connection errors.
    expect(host.endpoint()).toBeNull();

    const { url } = await listening();
    await host.stop();

    expect(host.endpoint()).toBeNull();
    await expect(
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ).rejects.toThrow();
  });

  it("starts once, however many times it is asked", async () => {
    const first = await listening();

    const again = await host.start();

    // A second socket would be a second token, and the dispatch that
    // asked between the two would have been handed a credential for a
    // listener nobody is on any more.
    expect(again.listeningPort).toBe(Number(new URL(first.url).port));
    expect(host.endpoint()?.url).toBe(first.url);
    // And the bearer minted before the second start still works: it is
    // the same listener, holding the same leases.
    const client = await connect(first.url, first.token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("reaches nothing the registry has not been given", async () => {
    // The wall around the carve-out, from the outside. `invariants.test.ts`
    // asserts no file here writes to the database; this asserts what
    // happens when the handler it would have dispatched to is absent —
    // a sentence, rather than a second door found some other way.
    clearHandlerRegistry();
    const { url, token } = await listening();
    const client = await connect(url, token);

    const result = await client.callTool({ name: "tickets_list", arguments: {} });

    expect(JSON.stringify(result.content)).toContain("no handler registered");
  });
});

/**
 * Turns that leave without closing their session (EO-444).
 *
 * Every system-agent turn is a fresh CLI process that opens a session
 * here, and neither backend's CLI sends DELETE when it exits. With one
 * bearer for every turn the host could not tell a finished turn's session
 * from a live one, so each sat out the half-hour idle timeout — and the
 * ninth turn in that half hour was refused at initialize and ran without
 * `view_current`, `pipeline_get` or anything else this server is for,
 * while a note blamed the Servers screen.
 */
describe("turns that end without closing their session", () => {
  it("serves twenty consecutive turns inside half an hour, each with the whole catalogue", async () => {
    await listening();

    for (let index = 1; index <= 20; index += 1) {
      const names = await turn();
      // Connected and served, which is what `eo_admin: connected` on the
      // backend's startup report is a reading of.
      expect(names, `turn ${index}`).toContain("view_current");
      expect(names, `turn ${index}`).toHaveLength(TOOLS.length);
      // And nothing of it is left counting against the cap.
      await settled();
      expect(host.status().openSessions, `after turn ${index}`).toBe(0);
    }
  });

  it("stops counting a turn's session against the cap once that turn's process is over", async () => {
    const { url } = await listening();
    const endpoint = host.endpoint();
    if (endpoint === null) throw new Error("the internal host is not up");

    // Eight turns whose CLI has exited without DELETE and that nobody has
    // let go of yet: the state the host was in after eight turns before
    // this story. The ninth is refused, which is the proof that the cap
    // being tested here is real.
    const held = [];
    for (let index = 0; index < 8; index += 1) {
      const lease = endpoint.lease();
      const client = await connect(endpoint.url, lease.token);
      await client.close();
      held.push(lease);
    }
    const waiting = endpoint.lease();
    const refused = await initialize(url, waiting.token);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining("8 MCP sessions") } });

    // One turn's process is over: its session is closed, and the next
    // turn opens one in its place.
    held[0]?.release();
    await settled();
    const client = await connect(endpoint.url, waiting.token);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("view_current");
  });

  it("refuses a bearer once its turn is over, session and all", async () => {
    await listening();
    const endpoint = host.endpoint();
    if (endpoint === null) throw new Error("the internal host is not up");
    const lease = endpoint.lease();
    const opened = await initialize(endpoint.url, lease.token);
    expect(opened.status).toBe(200);
    const sessionId = opened.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    lease.release();
    // Twice is once: a turn's finally running after its catch lets go of
    // nothing more.
    lease.release();

    const after = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${lease.token}`,
        "mcp-session-id": sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  it("lets one turn go without touching another's session", async () => {
    await listening();
    const endpoint = host.endpoint();
    if (endpoint === null) throw new Error("the internal host is not up");
    const running = endpoint.lease();
    const finished = endpoint.lease();
    const live = await connect(endpoint.url, running.token);
    await connect(endpoint.url, finished.token);

    finished.release();
    await settled();

    expect((await live.listTools()).tools.length).toBe(TOOLS.length);
  });

  it("opens no session for a turn let go while its initialize body was still arriving", async () => {
    // The listener checks the bearer on the headers and only then reads
    // the body. A turn let go of in between used to reach the protocol
    // host as nobody's, and was given a session `closeSessionsOf` had
    // already looked for and missed — one more slot of the eight, for
    // half an hour.
    await listening();
    const endpoint = host.endpoint();
    if (endpoint === null) throw new Error("the internal host is not up");
    const port = Number(new URL(endpoint.url).port);
    const lease = endpoint.lease();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } },
    });

    const answered = new Promise<{ status: number; session: string | undefined }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: `127.0.0.1:${port}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${lease.token}`,
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          const session = response.headers["mcp-session-id"];
          resolve({ status: response.statusCode ?? 0, session: typeof session === "string" ? session : undefined });
        },
      );
      request.on("error", reject);
      // The headers, and the first half of the body: the listener has
      // authenticated and is waiting for the rest.
      request.flushHeaders();
      request.write(body.slice(0, 10));
      setTimeout(() => {
        // The turn ends here, as its adapter would let it go.
        lease.release();
        request.end(body.slice(10));
      }, 150);
    });

    const { status, session } = await answered;
    await settled();

    expect(status).toBe(401);
    expect(session).toBeUndefined();
    expect(host.status().openSessions).toBe(0);
  });
});
