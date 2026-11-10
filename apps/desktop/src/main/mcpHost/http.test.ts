import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { type Workspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemSections, listItemSummaries } from "../ipc/domainQueries.js";
import type { FetchLike } from "../packs/developer/jira/client.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import type { SecretStore } from "../secrets/store.js";
import {
  connectJira,
  jiraFields,
  jiraOutboxView,
  jiraStatuses,
  listJiraConnectionsCommand,
  saveJiraConnection,
  testJira,
} from "../ipc/jiraCommands.js";
import { listRepositoriesCommand } from "../ipc/repositoryCommands.js";
import { writeMcpConfig } from "./gate.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { allowedNamesFor, startListener, type McpListener } from "./http.js";
import { startProtocolHost, type McpProtocolHost } from "./server.js";
import { detectMcpClients } from "../ipc/mcpCommands.js";

/**
 * The server over a real socket.
 *
 * The same instinct as eoServer.test.ts spawning the real process and
 * talking real stdio: what is being proved is that a client can connect,
 * and a hand-rolled fetch against our own idea of the protocol would
 * prove only that we are self-consistent. So this drives the SDK's own
 * client — the same code the real editors run.
 */
const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const opts = { exposeErrorDetails: true };

/**
 * Longer than vitest's default, because these are the only tests here
 * doing real network I/O: a socket, an HTTP round trip, an SSE stream
 * and a protocol handshake per case. Five seconds is a budget tuned for
 * pure functions, and on a loaded CI runner — or a laptop running the
 * rest of this suite in parallel — these legitimately take longer. A
 * flaky test is worth less than no test, so the budget is stated rather
 * than left to luck.
 */
const SOCKET_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: SOCKET_TIMEOUT_MS, hookTimeout: SOCKET_TIMEOUT_MS });

let handle: DbHandle;
let listener: McpListener;
let protocol: McpProtocolHost;
let url: URL;
/**
 * Every client this file opened.
 *
 * Closed in afterEach rather than at the end of each test, because a
 * failing assertion returns before its own `client.close()` and leaves a
 * session — and its SSE stream — open. The listener then waits out its
 * two-second forced-close race on the way down, which turns one honest
 * assertion failure into several timeouts that hide it.
 */
let clients: Client[] = [];

beforeEach(async () => {
  handle = openMigratedTestDb();
  registerHandler("items:list", () => listItemSummaries(handle.db, null), opts);

  const started = await startProtocolHost(handle.db, "0.0.0-test", () => allowedNamesFor(listener.port));
  if (!started.ok) throw new Error(started.problem);
  protocol = started.host;

  // Port 0: the OS picks a free one, which is also the case that proves
  // the Host allowlist is built from what was bound rather than asked for.
  const bound = await startListener({ port: 0, token: TOKEN, host: protocol });
  if (!bound.ok) throw new Error(bound.problem);
  listener = bound.listener;
  url = new URL(`http://127.0.0.1:${listener.port}/mcp`);
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  await listener.close();
  await protocol.close();
  clearHandlerRegistry();
  handle.close();
});

async function connect(): Promise<Client> {
  return connectAs("test");
}

/**
 * A client that says who it is, which is what the alias record is keyed
 * by (KAN-178).
 *
 * `clientInfo.name` is the only thing on the wire that distinguishes one
 * connected program from another — there is one token and one socket —
 * so a test about *which client* is on the old names has to send it the
 * way a real editor does.
 */
async function connectAs(name: string): Promise<Client> {
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }),
  );
  clients.push(client);
  return client;
}

async function raw(init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.headers ?? {}),
    },
    body: init.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

/**
 * A request with headers `fetch` will not send.
 *
 * `Host` is a forbidden header name, so undici drops it silently — a
 * fetch-based test of the Host allowlist passes for the wrong reason and
 * proves nothing. Since that allowlist is the whole DNS-rebinding
 * defence, it gets a real socket.
 */
function rawSocket(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: listener.port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}

describe("who gets in", () => {
  it("refuses a request with no credential", async () => {
    const response = await raw();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses a wrong token, and says no more than it did for a missing one", async () => {
    const missing = await raw();
    const wrong = await raw({ headers: { authorization: "Bearer not-the-token" } });

    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe(await missing.text());
  });

  it("refuses a foreign Origin, which is how a web page would reach a loopback port", async () => {
    const response = await raw({ headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" } });

    expect(response.status).toBe(403);
  });

  it("refuses a Host header that is not one of its own names", async () => {
    // The DNS-rebinding case: a name that resolves to 127.0.0.1 but is
    // not one EO answers to.
    await expect(rawSocket({ authorization: `Bearer ${TOKEN}`, host: "rebound.example" })).resolves.toBe(403);
  });

  it("allows the loopback names it does answer to", async () => {
    // The other half, so the check above is known to be discriminating
    // rather than merely refusing everything.
    await expect(rawSocket({ authorization: `Bearer ${TOKEN}`, host: `localhost:${listener.port}` })).resolves.toBe(404);
  });

  it("allows a request with no Origin at all, which is every non-browser client", async () => {
    const response = await raw({ headers: { authorization: `Bearer ${TOKEN}` } });

    // 404 with -32001 is what a `ping` carrying no session id gets: the
    // request was authenticated, passed both header checks and reached
    // the protocol. Asserting merely "not 403" would also pass on a 401
    // or a 500 — i.e. on the request being rejected for a different
    // reason, which is the thing this is supposed to rule out.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: -32001 } });
  });

  it("says nothing about itself on any other path", async () => {
    const response = await fetch(new URL(`http://127.0.0.1:${listener.port}/`), { method: "GET" });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("a connected client", () => {
  it("initializes and is told how EO works", async () => {
    const client = await connect();

    expect(client.getServerVersion()).toMatchObject({ name: "eo" });
    // The instructions are where a model learns that work is handed over
    // as an agreed plan rather than typed in as a title. A handshake that
    // dropped them would leave it guessing, and guessing here means
    // submitting a plan nobody agreed.
    expect(client.getInstructions()).toContain("Agree the work first");
  });

  it("lists the tools, with their derived schemas", async () => {
    const client = await connect();

    const { tools } = await client.listTools();
    const itemGet = tools.find((tool) => tool.name === "ticket_get");

    // `ticketId`, not `itemId`: the tool kept its name when the entity
    // was renamed (KAN-145), and a name is only a third of what a client
    // registered against — see legacyNames.ts.
    expect(itemGet?.inputSchema).toMatchObject({ type: "object", required: ["ticketId"] });
    expect(itemGet?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("calls a tool and gets both the prose and the structured copy", async () => {
    createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    const client = await connect();

    const result = await client.callTool({ name: "tickets_list", arguments: {} });

    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain("Rate limit the import");
    // `tickets`, for the same reason the argument above is `ticketId`.
    expect(result.structuredContent).toMatchObject({ tickets: [{ title: "Rate limit the import" }] });
  });

  /**
   * The whole round trip a client registered against, over the real
   * transport: the name it always called, the argument it always sent,
   * and the shape it always read back (KAN-145, legacyNames.ts).
   *
   * Asserted here rather than only against `tool.run`, because the
   * translation happens at two different points — arguments in
   * `channelTool`, the answer in `callTool` — and only a call through
   * the wire crosses both.
   */
  it("answers a call made in the vocabulary the tool has always used", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
    const client = await connect();

    const result = await client.callTool({ name: "ticket_get", arguments: { ticketId: item.id } });

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { ticket?: { key?: string }; comments?: unknown[] };
    expect(structured.ticket?.key).toBe(item.key);
    // Nothing item-shaped reaches the wire, at any depth.
    expect(JSON.stringify(result.structuredContent)).not.toMatch(/"item(s|Id|Key|Title|Count|State)?":/);
  });

  /**
   * The other half of the pair, over the same transport (KAN-162), and
   * the answer is the same answer.
   *
   * The temptation is to let `item_get` reply in EO's own vocabulary,
   * since nothing has registered against that name yet — and it was
   * written that way once. It is wrong: a pair whose two names hand back
   * two shapes is two tools, and the whole promise of an alias is that a
   * client cannot tell which of the names it called. So the reply is the
   * spelling clients registered against, from both doors, and the
   * release that retires the old names is where the answers follow.
   *
   * Only a call through the wire proves it: the translation happens in
   * `callTool`, one layer above the tool.
   */
  it("answers the twin exactly as it answers the name it replaces", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
    const client = await connect();

    const old = await client.callTool({ name: "ticket_get", arguments: { itemId: item.id } });
    const twin = await client.callTool({ name: "item_get", arguments: { itemId: item.id } });

    expect(twin.isError).toBe(false);
    expect(twin).toEqual(old);
    const structured = twin.structuredContent as { ticket?: { key?: string } };
    expect(structured.ticket?.key).toBe(item.key);
    // Nothing item-shaped on the wire, at any depth, from either name.
    expect(JSON.stringify(twin.structuredContent)).not.toMatch(/"item(s|Id|Key|Title|Count|State)?":/);
  });

  /**
   * Both names offered, so a client can see what to migrate to before
   * the old name stops working — and the old one carries the notice, so
   * a model reading the list is told rather than left to find out
   * (invariant #12).
   */
  it("lists both names, with the deprecated one saying so", async () => {
    const client = await connect();

    const names = (await client.listTools()).tools;
    const deprecated = names.find((entry) => entry.name === "ticket_get");

    expect(names.map((entry) => entry.name)).toEqual(expect.arrayContaining(["item_get", "ticket_get"]));
    expect(deprecated?.description).toContain("Deprecated: use item_get");
  });

  /**
   * The deprecated name, called in EO's own vocabulary (KAN-162).
   *
   * Taken rather than refused, which is the widening this story is: a
   * key the tool renamed is accepted under either spelling so that a
   * client migrating one call at a time never has to migrate a name and
   * its arguments in the same edit. The *answer* is still the old
   * spelling, because the name that was called is the old one — see
   * `aliases.test.ts` for the twin that answers in the new.
   */
  it("takes the new vocabulary on the old name, and still answers in the old", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
    const client = await connect();

    const result = await client.callTool({ name: "ticket_get", arguments: { itemId: item.id } });

    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { ticket?: { key?: string } };
    expect(structured.ticket?.key).toBe(item.key);
  });

  /**
   * And the one call that is still refused, loudly and with the answer
   * in it: one field under both of its names. Zod drops a key it does
   * not know, so choosing between them would have meant a successful
   * call that quietly answered about the other item (see legacyNames.ts).
   */
  it("refuses a call that spells one field both ways", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);
    const client = await connect();

    const result = await client.callTool({ name: "ticket_get", arguments: { itemId: item.id, ticketId: item.id } });

    expect(result.isError).toBe(true);
    const said = JSON.stringify(result.content);
    // EO's own name for the tool, not the door the call came in through
    // — see `canonicalToolName`. A refusal that echoed `ticket_get` here
    // would be the one sentence in the pair that told a client which of
    // the two names it had used.
    expect(said).toContain("item_get");
    expect(said).toContain("ticketId");
  });

  it("reports an unknown tool without ending the session", async () => {
    const client = await connect();

    const result = await client.callTool({ name: "no_such_tool", arguments: {} });

    expect(result.isError).toBe(true);
    // Still usable afterwards: a bad guess is not a protocol fault.
    await expect(client.listTools()).resolves.toBeDefined();
  });
});

/**
 * The other boundary, and it is not the gate (EO-192).
 *
 * The gate asks whether somebody has turned destructive operations on;
 * this asks which of EO's two listeners you reached. `view_current`
 * answers with what is on the person's screen right now — a fact about
 * them rather than about the project, and the one thing in the catalogue
 * that exists so the assistant's agent can act on "this". A stranger's
 * editor holding a pasted token has no such conversation.
 *
 * Both halves are asserted because a client can call a tool it was never
 * shown. Over this listener the tool does not exist, and it is told so
 * in the same words a name nobody has would get.
 */
describe("the admin-only surface, over the wire", () => {
  it("does not advertise it to an ordinary client", async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("view_current");
    // And this listener is genuinely serving things, so the absence
    // above is a decision rather than an empty list.
    expect(tools.map((tool) => tool.name)).toContain("ticket_move");
  });

  it("does not answer one that calls it anyway", async () => {
    const client = await connect();

    const result = await client.callTool({ name: "view_current", arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no tool named");
  });

  it("keeps it out even with the destructive-operations switch on, which is a different question", async () => {
    // Flipping the gate widens what this listener serves. It does not
    // make this listener the admin one, and the two must not be one
    // setting somebody could reach through the other.
    writeMcpConfig(handle.db, { dangerousOperations: true });
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain("ticket_delete");
    expect(tools.map((tool) => tool.name)).not.toContain("view_current");
  });
});

describe("the destructive-operations gate, over the wire", () => {
  it("does not advertise the destructive tools while it is closed", async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("ticket_delete");
    // And the tools that are offered are genuinely there, so this is not
    // passing because the list is empty.
    expect(tools.map((tool) => tool.name)).toContain("ticket_move");
  });

  it("lets a client write a module while it is closed, and offers it no way to approve one", async () => {
    // Authoring is an ordinary write because what it makes is inert:
    // an unapproved module stops a pipeline naming it from publishing,
    // and its tests run it only against a scripted ctx where nothing
    // real happens (EO-352). Approving is the
    // act that makes it live, so that one stays behind the gate.
    const client = await connect();

    const { tools } = await client.listTools();
    const save = tools.find((tool) => tool.name === "module_save");

    expect(save).toBeDefined();
    expect(tools.map((tool) => tool.name)).not.toContain("module_approve");
    // What the client is shown has no approval flag on it at all — the
    // wire copy, not the catalog's, since that is what a model reads.
    expect(Object.keys(save?.inputSchema.properties ?? {})).not.toContain("approve");
  });

  it("offers EO's own settings and guardrails while it is closed", async () => {
    // Configuration is an ordinary write: it destroys nothing, writes no
    // secret and approves nothing, and anything wrong with it can be
    // read back and corrected. So a client sees all three with the gate
    // shut — a client that can move an item but not change a guardrail
    // is not at parity with the app.
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("settings_read");
    expect(names).toContain("settings_write");
    expect(names).toContain("guardrails_set");
    // And none of them is announced as destructive, which is what a
    // well-behaved client would put a confirmation in front of.
    for (const name of ["settings_read", "settings_write", "guardrails_set"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it("lets a client see what runtimes exist while it cannot install one", async () => {
    // The asymmetry this closes. Installing and removing a runtime were
    // offered — behind the switch, correctly — while nothing reported
    // what was installed, so a caller could act on runtimes it could not
    // inspect. Both reads are ungated; `runtime_describe` in particular,
    // because it is what makes an install a decision rather than a
    // surprise, and withholding the numbers while offering the download
    // would be exactly backwards.
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("runtime_status");
    expect(names).toContain("runtime_describe");
    expect(names).toContain("agent_save");
    expect(names).not.toContain("runtime_install");
    expect(names).not.toContain("runtime_remove");
    // And not `runtime_set_automatic_updates` either: turning it on
    // grants the same download consent and reconciles the provider on
    // the spot, so offering it here would be a way around the switch
    // `runtime_install` stands behind.
    expect(names).not.toContain("runtime_set_automatic_updates");
    // The registry read says so on the wire, not just in the catalog.
    expect(tools.find((tool) => tool.name === "runtime_describe")?.annotations?.openWorldHint).toBe(true);
  });

  it("lets a client set EO up while it is closed, and not detach a repository", async () => {
    // "One-time setup" was never a statement about danger: creating a
    // project, renaming one, moving a repository on or off it and
    // attaching one all delete nothing, store no secret and approve
    // nothing, and every one of them can be read back and corrected.
    // Detaching a repository is the one that takes something away, so it
    // is the one that stays behind the switch.
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const name of [
      "project_create",
      "project_update",
      "project_add_repository",
      "project_remove_repository",
      "project_set_active",
      "repository_create",
      "repository_update",
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain("repository_remove");
    // And the one that moves someone's window says so where a model
    // actually reads it — on the wire, not only in the catalog.
    expect(tools.find((tool) => tool.name === "project_set_active")?.description).toMatch(/window/);
  });

  it("lets a client wire EO to a tracker while it is closed, and touch no credential", async () => {
    // "Settings-screen minutiae" was a judgement about how interesting
    // each looked, and between them they are the whole of connecting EO
    // to a tracker. None of these deletes anything a person cannot write
    // again or stores a secret, and every one can be read back — so a
    // client sees all ten with the gate shut.
    const client = await connect();

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const name of [
      "jira_connections_list",
      "jira_test",
      "jira_fields",
      "jira_statuses",
      "jira_outbox",
      "forge_detect",
      "jira_save_config",
      "jira_save_status_map",
      "jira_save_transition_fields",
      "jira_disconnect",
    ]) {
      expect(names, name).toContain(name);
    }

    // The three that carry or bind a credential stay behind the switch.
    for (const name of ["jira_connection_save", "jira_connection_remove", "jira_connect"]) {
      expect(names, name).not.toContain(name);
    }
    // And the one that can take a token away with it says so where a
    // model reads it, on the wire rather than only in the catalog.
    expect(tools.find((tool) => tool.name === "jira_disconnect")?.annotations?.destructiveHint).toBe(true);
  });

  it("refuses a destructive call the client made anyway, without touching the handler", async () => {
    // A client can call a tool it was never shown — a stale list, or a
    // guess. Filtering the listing alone would let that straight through.
    const deleteHandler = vi.fn(() => ({
      deleted: true,
      deletedCount: 1,
      blockedByActiveRun: false,
      blockedByUncommittedWork: false,
      problem: null,
      jira: null,
      leftoverWorktrees: [],
    }));
    registerHandler("items:delete", deleteHandler, opts);
    const client = await connect();

    const result = await client.callTool({ name: "ticket_delete", arguments: { ticketId: "whatever" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Settings");
    // The point of the assertion: nothing was deleted, because nothing ran.
    expect(deleteHandler).not.toHaveBeenCalled();
  });

  it("offers them once the switch is on", async () => {
    const client = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("ticket_delete");

    writeMcpConfig(handle.db, { dangerousOperations: true });

    // Read at call time rather than cached at startup, so the switch
    // takes effect on the next call rather than the next launch.
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("ticket_delete");
  });

  it("tells a connected client the list changed, rather than waiting to be asked", async () => {
    // Separate from the test above on purpose. That one passes whether
    // or not anything is announced, because `listTools()` re-reads the
    // gate every time — gutting `notifyToolsChanged` to a no-op left it
    // green. A client that never re-lists would go on offering the old
    // set, which is the failure this catches.
    const client = await connect();
    const announced = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve());
    });

    // Announced until it is heard, rather than once.
    //
    // Not flake-padding: a server-to-client notification travels on the
    // standalone SSE stream, and the SDK client only opens that stream
    // after the server has accepted its `initialized` notification —
    // which happens after `connect()` resolves. A notification sent into
    // the gap is genuinely dropped, by design, for any client. What is
    // being proved here is that the announcement reaches a client that
    // is listening, not that the transport buffers for one that is not.
    const announcing = setInterval(() => protocol.notifyToolsChanged(), 50);
    try {
      await expect(announced).resolves.toBeUndefined();
    } finally {
      clearInterval(announcing);
    }
  });
});

describe("what one client can make the server hold", () => {
  it("refuses a session beyond the cap, and says so in JSON-RPC", async () => {
    // Untested until a review replaced the cap with `if (false)` and all
    // 71 tests stayed green. It is a backstop rather than a budget — a
    // single-user desktop has no business with eight editors attached —
    // but a cap nothing exercises is a cap that has already stopped
    // working.
    const opened = [];
    for (let index = 0; index < 8; index += 1) opened.push(await connect());

    const refused = await raw({
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "extra", version: "0" } },
      }),
    });

    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining("8 MCP sessions") } });
    expect(opened).toHaveLength(8);
  });

  /**
   * A second host, whose sessions are filed under whoever its caller says
   * opened them (EO-444) — the arrangement the admin host makes, by
   * bearer, with the owner read here from a header the test sets.
   */
  async function ownedHost(sessionOwner: (req: IncomingMessage) => string | null) {
    const started = await startProtocolHost(handle.db, "0.0.0-test", () => allowedNamesFor(owned.port), { sessionOwner });
    if (!started.ok) throw new Error(started.problem);
    const bound = await startListener({ port: 0, token: TOKEN, host: started.host });
    if (!bound.ok) throw new Error(bound.problem);
    const owned = bound.listener;
    closers.push(async () => {
      await owned.close();
      await started.host.close();
    });
    return { protocol: started.host, url: new URL(`http://127.0.0.1:${owned.port}/mcp`) };
  }
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    clients = [];
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  });

  async function connectTo(target: URL, turn: string): Promise<Client> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(target, { requestInit: { headers: { authorization: `Bearer ${TOKEN}`, "x-turn": turn } } }),
    );
    clients.push(client);
    return client;
  }

  it("closes the sessions one owner opened, and no one else's (EO-444)", async () => {
    const { protocol: owning, url: target } = await ownedHost((req) => {
      const turn = req.headers["x-turn"];
      return typeof turn === "string" ? turn : null;
    });
    const finished = await connectTo(target, "turn-1");
    const running = await connectTo(target, "turn-2");

    // What the admin host does once a turn's process is over: the CLI
    // left without DELETE, so its session is closed from this side.
    expect(await owning.closeSessionsOf("turn-1")).toBe(1);

    await expect(finished.listTools()).rejects.toThrow();
    expect((await running.listTools()).tools.length).toBeGreaterThan(0);
    // And a second close finds nothing more to close.
    expect(await owning.closeSessionsOf("turn-1")).toBe(0);
  });

  it("opens nothing for nobody, on a host that keeps track of who opens its sessions (EO-444)", async () => {
    // A credential let go of between the listener's check and the body
    // being read arrives here as nobody's. Opening a session for it would
    // be opening one `closeSessionsOf` can never find.
    const { protocol: owning, url: target } = await ownedHost(() => null);

    const refused = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } },
      }),
    });

    expect(refused.status).toBe(401);
    expect(refused.headers.get("mcp-session-id")).toBeNull();
    expect(owning.sessionCount()).toBe(0);
  });

  it("does not keep a session whose owner was let go while its handshake was in flight (EO-444)", async () => {
    // The owner is asked when the session is opened and again once the
    // initialize has been answered. A turn let go between the two has
    // already had `closeSessionsOf` run for it — before this session was
    // there to be found — so the host closes it itself rather than leave
    // it to the idle timeout.
    let asked = 0;
    const { protocol: owning, url: target } = await ownedHost(() => {
      asked += 1;
      return asked === 1 ? "turn-1" : null;
    });

    const opened = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } },
      }),
    });
    expect(opened.status).toBe(200);
    const sessionId = opened.headers.get("mcp-session-id") ?? "";
    expect(sessionId).not.toBe("");

    const after = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
    expect(await owning.closeSessionsOf("turn-1")).toBe(0);
  });

  it("turns an unknown session id away instead of quietly opening one", async () => {
    // A server that created a session for whatever id arrived would let
    // a caller choose its own — and the whole reason ids are generated
    // here is that a caller must not.
    const response = await raw({ headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": "not-a-session" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: -32001 } });
  });
});

describe("the guides, over the wire", () => {
  it("advertises them as prompts", async () => {
    const client = await connect();

    const { prompts } = await client.listPrompts();

    expect(prompts.map((prompt) => prompt.name)).toEqual(["eo_orient", "eo_submit_work", "eo_change_pipeline", "eo_unblock"]);
  });

  it("serves one, as a message a client can hand straight to a model", async () => {
    const client = await connect();

    const result = await client.getPrompt({ name: "eo_change_pipeline" });

    expect(result.messages[0]?.content).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.messages[0]?.content)).toContain("replaces what");
  });

  it("serves the same guide through the tool as through the prompt", async () => {
    // Prompt support is uneven across clients, so every guide has two
    // doors. Two doors onto different text would be worse than one: a
    // caller has no way to tell which it got.
    const client = await connect();

    const prompt = await client.getPrompt({ name: "eo_submit_work" });
    const tool = await client.callTool({ name: "eo_guide", arguments: { name: "eo_submit_work" } });

    const throughPrompt = (prompt.messages[0]?.content as { type: string; text?: string }).text;
    const throughTool = (tool.content as { type: string; text?: string }[])[0]?.text;

    expect(throughPrompt).toContain("# Handing work over to EO");
    expect(throughTool).toBe(throughPrompt);
  });

  it("serves the guide in structuredContent too, for a client that reads that instead of content", async () => {
    // The third door. `callTool` attaches `content` and
    // `structuredContent` to every successful answer and no tool
    // declares an `outputSchema`, so a client is free to surface either
    // — and the one that surfaced the structured copy used to get
    // `{name, title}` and no guide at all (EO-202).
    const client = await connect();

    const prompt = await client.getPrompt({ name: "eo_submit_work" });
    const tool = await client.callTool({ name: "eo_guide", arguments: { name: "eo_submit_work" } });

    const throughPrompt = (prompt.messages[0]?.content as { type: string; text?: string }).text;
    const structured = tool.structuredContent as { name?: string; title?: string; body?: string };

    expect(structured.body).toBe(throughPrompt);
    expect(structured.name).toBe("eo_submit_work");
  });

  it("lists the newest guide through the tool, for a client that never asks for prompts", async () => {
    const client = await connect();

    const listed = await client.callTool({ name: "eo_guide", arguments: {} });

    expect(JSON.stringify(listed.content)).toContain("eo_submit_work");
  });

  it("refuses a guide that does not exist, without ending the session", async () => {
    const client = await connect();

    await expect(client.getPrompt({ name: "eo_nonsense" })).rejects.toThrow();
    // Still usable: a bad guess is not a protocol fault.
    await expect(client.listPrompts()).resolves.toBeDefined();
  });

  it("declares the capability, or a client never asks", async () => {
    // A server that serves prompts without advertising them is a server
    // whose prompts nothing fetches.
    const client = await connect();

    expect(client.getServerCapabilities()).toMatchObject({ prompts: {} });
  });
});

/**
 * The one property this whole surface would be worth withdrawing over.
 *
 * A Jira token goes into the OS keychain and is read in exactly one
 * place — `jiraFor`, on its way to Jira itself. Nothing may hand it
 * back, and "nothing" includes a tool that reports a repository's
 * settings, one that lists the sites, and one that says why a
 * connection is not working. Asserted here rather than only in the
 * catalog because what a client actually receives is the JSON on the
 * wire: a leak into `structuredContent`, or into a problem string
 * quoting the request it made, would be invisible to a unit test of the
 * renderer.
 */
describe("the Jira token, over the wire", () => {
  const JIRA_TOKEN = "jira-token-nobody-may-read";
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
    decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
  };

  let directory: string;
  let repository: Workspace;

  /** A Jira that answers every call these tools make. */
  const jiraSays: FetchLike = async (url) => {
    const body = url.endsWith("/statuses")
      ? [{ statuses: [{ name: "Done" }] }]
      : url.endsWith("/issuetypes")
        ? { issueTypes: [{ id: "10", name: "Epic" }] }
        : url.includes("/createmeta/")
          ? { fields: [{ fieldId: "customfield_1", name: "Team", required: true, schema: { type: "option" }, allowedValues: [] }] }
          : url.includes("/myself")
            ? { accountId: "acc-1", displayName: "Dev" }
            : { id: "1", key: "ACME", name: "Acme API" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  const context = (): JiraContext => ({ credentials: { directory, store }, fetchImpl: jiraSays });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eo mcp wire jira "));
    repository = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: join(directory, "checkout"), baseBranch: "main" });

    registerHandler("repositories:list", () => listRepositoriesCommand(handle.db, { directory, store }), opts);
    registerHandler("jiraConnections:list", () => listJiraConnectionsCommand(handle.db, { directory, store }), opts);
    registerHandler("jira:test", (payload) => testJira(handle.db, context(), payload), opts);
    registerHandler("jira:fields", (payload) => jiraFields(handle.db, context(), payload), opts);
    registerHandler("jira:statuses", (payload) => jiraStatuses(handle.db, context(), payload), opts);
    registerHandler("jira:outbox", (payload) => jiraOutboxView(handle.db, payload), opts);

    // A real connection with a real stored credential, made the way the
    // app makes one: the token is proved against the site and then
    // written to the keychain.
    const saved = await saveJiraConnection(handle.db, context(), {
      name: "Acme",
      baseUrl: "https://acme.atlassian.net",
      flavour: "cloud",
      email: "dev@acme.com",
      token: JIRA_TOKEN,
    });
    if (!saved.ok || !saved.connection) throw new Error(saved.problem ?? "the site was not saved");
    const bound = await connectJira(handle.db, context(), {
      repositoryId: repository.id,
      connectionId: saved.connection.id,
      projectKey: "ACME",
      featureIssueType: "Epic",
      storyIssueType: "Story",
    });
    if (!bound.ok) throw new Error(bound.problem ?? "the repository was not connected");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is in nothing a client can call, against a connection that has one", async () => {
    const client = await connect();

    const replies = [];
    for (const call of [
      { name: "jira_connections_list", arguments: {} },
      { name: "repositories_list", arguments: {} },
      { name: "jira_test", arguments: { repositoryId: repository.id } },
      { name: "jira_statuses", arguments: { repositoryId: repository.id } },
      { name: "jira_fields", arguments: { repositoryId: repository.id, issueType: "Epic" } },
      { name: "jira_outbox", arguments: { repositoryId: repository.id } },
    ]) {
      const result = await client.callTool(call);

      // Everything the client receives: the prose it reads and the
      // structured copy it parses.
      expect(JSON.stringify(result), call.name).not.toContain(JIRA_TOKEN);
      // Nor the server's own bearer token, which is the other credential
      // within reach of anything that echoed a request back.
      expect(JSON.stringify(result), call.name).not.toContain(TOKEN);
      expect(result.isError, call.name).toBe(false);
      replies.push(JSON.stringify(result));
    }

    // And not because there was nothing to leak: the site has a stored
    // credential and the calls reached Jira with it.
    expect(replies[0]).toContain("a token is stored for it");
    expect(replies[2]).toContain("Signed in as Dev");
  });

  it("says a credential exists without a client being able to ask what it is", async () => {
    // The listing's whole contract, and the half a leak would break
    // quietly: `credentialsConfigured` is a boolean, and there is no
    // field beside it that could carry the value.
    const client = await connect();

    const result = await client.callTool({ name: "jira_connections_list", arguments: {} });

    expect(result.structuredContent).toMatchObject({ connections: [{ baseUrl: "https://acme.atlassian.net", credentialsConfigured: true }] });
    expect(Object.keys((result.structuredContent as { connections: Record<string, unknown>[] }).connections[0]!)).not.toContain("token");
  });
});

/**
 * What the person is shown about a client still on the old names
 * (KAN-178).
 *
 * Driven over the real transport for the reason every other case in this
 * file is: the record is written where a `tools/call` lands, and the
 * name it is filed under comes off an initialize request. A test that
 * called `recordToolCall` directly would prove the bookkeeping and not
 * that the host does it.
 *
 * The assertion is on the rows `mcp:detectClients` hands the Servers
 * screen, rather than on the setting underneath, because the row is the
 * thing the story is about — derived, not guessed.
 */
describe("which of its two names a client is calling", () => {
  const store: SecretStore = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain),
    decryptString: (encrypted) => encrypted.toString(),
  };

  /**
   * The Servers screen's rows, through the command that builds them.
   *
   * The client detection is stubbed to "nothing installed" — it runs
   * `claude mcp list` and friends, which is about this machine and not
   * about this story. What is not stubbed is the alias half.
   */
  async function serverRows(): Promise<{ client: string; clientId: string | null; names: { deprecated: string; replacement: string }[] }[]> {
    const answer = await detectMcpClients(handle.db, {
      host: {
        status: () => ({ enabled: true, dangerousOperations: false, port: listener.port, listeningPort: listener.port, tokenConfigured: false, problem: null, toolCount: 0 }),
        reconcile: () => Promise.reject(new Error("not reached")),
        restart: () => Promise.reject(new Error("not reached")),
        stop: () => Promise.resolve(),
      },
      tokens: { directory: join(tmpdir(), "eo-no-token-here"), store },
      clients: {
        run: () => Promise.resolve({ ok: false, stdout: "", error: "", notFound: true }),
        home: join(tmpdir(), "eo-no-home-here"),
        platform: "linux",
      },
    });
    return answer.oldNameUse;
  }

  it("shows the row for a client on `ticket_*`, and none for one that has moved", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const old = await connectAs("claude-code");
    await old.callTool({ name: "ticket_get", arguments: { ticketId: item.id } });

    const moved = await connectAs("codex");
    await moved.callTool({ name: "item_get", arguments: { itemId: item.id } });

    const rows = await serverRows();

    expect(rows.map((row) => row.client)).toEqual(["claude-code"]);
    expect(rows[0]?.names).toEqual([{ deprecated: "ticket_get", replacement: "item_get" }]);
    // Matched to the client EO can register with, so the row lands on
    // that client rather than on a line of its own.
    expect(rows[0]?.clientId).toBe("claude-code");
  });

  it("stops showing it once that client calls EO's own name", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "Rate limit the import", stepId: "todo" });
    registerHandler("items:getSections", (payload) => getItemSections(handle.db, payload), opts);

    const client = await connectAs("claude-code");
    await client.callTool({ name: "ticket_get", arguments: { ticketId: item.id } });
    expect(await serverRows()).toHaveLength(1);

    await client.callTool({ name: "item_get", arguments: { itemId: item.id } });

    expect(await serverRows()).toEqual([]);
  });
});
