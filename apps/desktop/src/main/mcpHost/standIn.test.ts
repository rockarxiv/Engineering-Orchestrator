import type { Uuid } from "@eo/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createAgent, createRoute, createStep, listCommentsForItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { decideItem, postHumanComment } from "../ipc/domainCommands.js";
import { getItemDetail } from "../ipc/domainQueries.js";
import { clearHandlerRegistry, registerHandler } from "../ipc/registry.js";
import { ON_YOUR_BEHALF_TRIAL } from "../trials/onBehalf.js";
import { createAdminMcpHost, type AdminMcpHost } from "./admin.js";
import { answerToolCall } from "./server.js";
import { TOOLS } from "./catalog.js";

/**
 * Who pressed it, as the administrative host says (EO-585).
 *
 * A system agent's turn holds a credential EO minted for that agent, and
 * a press or a reply made through it is recorded as the agent's. Over a
 * real socket with the SDK's own client, because the claim is about what
 * a CLI EO spawned actually causes — and about what a caller cannot:
 * name an agent for itself, on either host.
 */
const SOCKET_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: SOCKET_TIMEOUT_MS, hookTimeout: SOCKET_TIMEOUT_MS });

const opts = { exposeErrorDetails: true };

let handle: DbHandle;
let host: AdminMcpHost;
let clients: Client[] = [];
let systemAgentId: Uuid;

function approvalStep(): void {
  const pipelineId = "default" as Uuid;
  createStep(handle.db, {
    id: "approval",
    pipelineId,
    position: 21,
    name: "Approval",
    type: "user",
    results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }],
  });
  createStep(handle.db, { id: "send", pipelineId, position: 22, name: "Send", type: "builtin", entryAction: "open_pull_request" });
  createRoute(handle.db, { pipelineId, fromStepId: "approval", resultKey: "approved", label: "Approve", tone: "success", target: "send", position: 0 });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  approvalStep();
  systemAgentId = createAgent(handle.db, {
    name: "Assistant",
    role: "system",
    provider: "fake",
    instructions: "",
    config: { allowedTools: ["mcp__eo_admin"] },
  }).id;
  registerHandler("items:decide", (payload) => decideItem(handle.db, undefined, payload), opts);
  registerHandler("comments:post", (payload) => postHumanComment(handle.db, undefined, payload), opts);
  host = createAdminMcpHost({ db: handle.db, version: "0.0.0-test" });
});

afterEach(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  await host.stop();
  clearHandlerRegistry();
  handle.close();
});

async function connect(agentId?: string): Promise<Client> {
  const status = await host.start();
  expect(status.problem).toBeNull();
  const endpoint = host.endpoint()!;
  const lease = endpoint.lease(agentId);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization: `Bearer ${lease.token}` } } }),
  );
  clients.push(client);
  return client;
}

function trialItem() {
  return createTestItem(handle.db, { type: "story", title: "A test item", stepId: "approval", trialAt: Date.now() });
}

function actorOf(itemId: Uuid): string {
  return getItemDetail(handle.db, { itemId })!.transitions.at(-1)!.actor;
}

describe("a press made through the administrative host", () => {
  it("is the system agent's when the turn's credential was leased for it", async () => {
    const subject = trialItem();
    const client = await connect(systemAgentId);

    const answer = await client.callTool({ name: "item_decide", arguments: { itemId: subject.id, resultKey: "approved", comment: "Looks right." } });

    expect(answer.isError).toBe(false);
    expect(actorOf(subject.id)).toBe(systemAgentId);
    const [comment] = listCommentsForItem(handle.db, subject.id);
    expect(comment).toMatchObject({ authorType: "agent", authorId: systemAgentId });
    expect(comment!.body).toContain(ON_YOUR_BEHALF_TRIAL);
  });

  it("is the person's when the credential names no agent, whatever the call says", async () => {
    const subject = trialItem();
    const client = await connect();

    await client.callTool({ name: "item_decide", arguments: { itemId: subject.id, resultKey: "approved", comment: "Fine.", actingAgentId: systemAgentId } });

    expect(actorOf(subject.id)).toBe("human");
    expect(listCommentsForItem(handle.db, subject.id)[0]).toMatchObject({ authorType: "human", body: "Fine." });
  });

  it("cannot be passed off as another agent by the agent holding the credential", async () => {
    const subject = trialItem();
    const other = createAgent(handle.db, { name: "Other", role: "system", provider: "fake", instructions: "", config: { allowedTools: ["mcp__eo_admin"] } });
    const client = await connect(systemAgentId);

    await client.callTool({ name: "item_decide", arguments: { itemId: subject.id, resultKey: "approved", comment: "", actingAgentId: other.id } });

    expect(actorOf(subject.id)).toBe(systemAgentId);
  });

  it("files a reply under a question as the agent's own on a trial item", async () => {
    const subject = trialItem();
    const client = await connect(systemAgentId);

    await client.callTool({ name: "comment_post", arguments: { itemId: subject.id, body: "Zero." } });

    const [comment] = listCommentsForItem(handle.db, subject.id);
    expect(comment).toMatchObject({ authorType: "agent", authorId: systemAgentId });
    expect(comment!.body).toContain(ON_YOUR_BEHALF_TRIAL);
  });
});

describe("the tools never take who is acting as an argument", () => {
  it("advertises no actingAgentId on item_decide or comment_post", () => {
    for (const name of ["item_decide", "comment_post"]) {
      const tool = TOOLS.find((candidate) => candidate.name === name)!;
      expect(JSON.stringify(tool.inputSchema)).not.toContain("actingAgentId");
    }
  });

  it("drops one a caller sent on the external host, which acts for the person", async () => {
    const subject = trialItem();

    await answerToolCall({ name: "item_decide", arguments: { itemId: subject.id, resultKey: "approved", comment: "", actingAgentId: systemAgentId } }, "external", true);

    expect(actorOf(subject.id)).toBe("human");
  });
});
