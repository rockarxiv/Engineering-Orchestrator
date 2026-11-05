import { McpServerDraftSchema, type Agent, type PipelineStep, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { archiveMcpServer, createAgent, listAgents, saveMcpServer, setAgentAttachment, setMcpServerEnabled } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { usePackConnectors } from "./declared.js";
import { sideEffectingServersByStep } from "./sideEffects.js";

/**
 * Which servers an agent step can reach that send (EO-334, ARCHITECTURE.md, "A connector is an MCP
 * server with a setup flow").
 *
 * The case the refusal is written about: nothing in the pipeline says
 * the step sends, and what sends is the connector somebody attached to
 * the agent standing on it.
 */
let handle: DbHandle;
let implementer: Agent;

beforeEach(() => {
  handle = openMigratedTestDb();
  implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  usePackConnectors(new Map());
});

afterEach(() => {
  handle.close();
  usePackConnectors(new Map());
});

function server(name: string, connector: Record<string, unknown> | null) {
  const saved = saveMcpServer(handle.db, McpServerDraftSchema.parse({ name, transport: "stdio", command: "helpdesk-mcp", connector }));
  if (!saved.ok) throw new Error(saved.problems.join("\n"));
  return saved.server;
}

/** A connector that answers customers, and one that only looks things up. */
const SENDS = { label: "Helpdesk", kind: "token", secretNames: ["HELPDESK_TOKEN"], oauth: null, sideEffects: true };
const READS = { label: "Helpdesk", kind: "token", secretNames: ["HELPDESK_TOKEN"], oauth: null };

function agentStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: "classify",
    pipelineId: "default" as Uuid,
    position: 0,
    name: "Classify",
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated",
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    results: [],
    ...overrides,
  };
}

describe("sideEffectingServersByStep", () => {
  it("names a sending server against every step its role owns", () => {
    const helpdesk = server("helpdesk", SENDS);
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: helpdesk.id, attached: true });

    expect(sideEffectingServersByStep(handle.db, [agentStep(), agentStep({ id: "reply", name: "Send" })])).toEqual({
      classify: ["helpdesk"],
      reply: ["helpdesk"],
    });
  });

  it("says nothing about a server that declares no side effects", () => {
    const helpdesk = server("helpdesk", READS);
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: helpdesk.id, attached: true });

    expect(sideEffectingServersByStep(handle.db, [agentStep()])).toEqual({});
  });

  it("says nothing about a server nobody is holding", () => {
    server("helpdesk", SENDS);

    expect(sideEffectingServersByStep(handle.db, [agentStep()])).toEqual({});
  });

  it("says nothing about a server that cannot be delivered", () => {
    const helpdesk = server("helpdesk", SENDS);
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: helpdesk.id, attached: true });

    // Disabled and archived are both "no agent gets this", so neither is
    // a reason to refuse a pipeline.
    setMcpServerEnabled(handle.db, helpdesk.id, false);
    expect(sideEffectingServersByStep(handle.db, [agentStep()])).toEqual({});

    setMcpServerEnabled(handle.db, helpdesk.id, true);
    archiveMcpServer(handle.db, helpdesk.id);
    expect(sideEffectingServersByStep(handle.db, [agentStep()])).toEqual({});
  });

  it("says nothing about an agent nobody can dispatch", () => {
    const helpdesk = server("helpdesk", SENDS);
    const retired = createAgent(handle.db, { name: "Retired", role: "triage", provider: "fake", model: null, instructions: "", enabled: false });
    setAgentAttachment(handle.db, { agentId: retired.id, kind: "mcpServer", id: helpdesk.id, attached: true });

    expect(sideEffectingServersByStep(handle.db, [agentStep({ ownerRole: "triage" })])).toEqual({});
  });

  it("asks the question only of steps an agent stands on", () => {
    const helpdesk = server("helpdesk", SENDS);
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: helpdesk.id, attached: true });

    // A builtin and a module declare their own side effects, and a human
    // step is the thing this refusal asks for rather than something it
    // is ever about.
    const others = [
      agentStep({ id: "forge", type: "builtin", ownerRole: null, entryAction: "open_pull_request" }),
      agentStep({ id: "approve", type: "user", ownerRole: null, entryAction: null }),
    ];
    expect(sideEffectingServersByStep(handle.db, others)).toEqual({});
  });

  it("prefers the pack's word about the server, where a pack has one", () => {
    const helpdesk = server("helpdesk", READS);
    setAgentAttachment(handle.db, { agentId: implementer.id, kind: "mcpServer", id: helpdesk.id, attached: true });
    usePackConnectors(new Map([["helpdesk", { label: "Helpdesk", kind: "token" as const, secretNames: ["HELPDESK_TOKEN"], oauth: null, sideEffects: true }]]));

    // The row says it only reads; the pack that describes the server
    // says otherwise, and a setup that arrived as data does not get to
    // overrule the pack — `connectors/list.ts`' own join rule.
    expect(sideEffectingServersByStep(handle.db, [agentStep()])).toEqual({ classify: ["helpdesk"] });
  });
});
