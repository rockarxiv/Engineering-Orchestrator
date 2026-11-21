import { isDeliverableMcpServer, isDispatchable, isPreviewAgent, stepAgentOf, type ConnectorSetup, type McpServer, type PipelineStep } from "@eo/core";
import type { Db } from "../db/client.js";
import { listAgentAttachments, listAgents, listMcpServers } from "../db/repos/index.js";
import { packConnectors } from "./declared.js";

/**
 * Which servers an agent step can reach that change something outside
 * EO (EO-334, `ARCHITECTURE.md`, "A connector is an MCP server with a setup flow").
 *
 * The half of the validator's webhook refusal that `packages/engine`
 * cannot work out for itself. A module says whether it sends in its
 * manifest and a builtin in the registry entry its pack contributes;
 * both are already inputs to `validatePipeline`. A *connector* hangs off
 * neither — it is attached to an agent, and a step names its agent by
 * id (EO-875) — so the answer is two database reads and belongs out
 * here, where rows are.
 *
 * It is also the case the design is actually written about: inbound email
 * straight into an agent that can send replies through a helpdesk
 * server. Nothing about that step's own configuration says it sends;
 * what says so is the connector somebody gave the agent.
 *
 * **A step is what its agent can do.** The step runs the agent it names
 * and no other, so that agent's servers are the ones it reaches.
 */
export function sideEffectingServersByStep(db: Db, steps: readonly PipelineStep[]): Record<string, string[]> {
  const sending = new Map<string, string>(
    listMcpServers(db)
      .filter((server) => isDeliverableMcpServer(server) && setupFor(server)?.sideEffects === true)
      .map((server) => [server.id, server.name]),
  );
  if (sending.size === 0) return {};

  // The step's own agent (EO-875): the one it runs, and so the one whose
  // servers it reaches. A preview's own agent is left out (EO-316): it
  // runs on the fake backend and reaches nowhere, so counting it would
  // refuse a pipeline on the strength of a rehearsal. Nor one that cannot
  // run at all.
  const agents = listAgents(db);
  const serversByAgent = new Map(listAgentAttachments(db).map((attachments) => [attachments.agentId, attachments.mcpServerIds]));

  const byStep: Record<string, string[]> = {};
  for (const step of steps) {
    const agent = stepAgentOf(agents, step);
    if (agent === undefined || !isDispatchable(agent) || isPreviewAgent(agent)) continue;
    const names = new Set((serversByAgent.get(agent.id) ?? []).flatMap((serverId) => sending.get(serverId) ?? []));
    if (names.size === 0) continue;
    byStep[step.id] = [...names].sort();
  }
  return byStep;
}

/**
 * The setup that describes this server, pack first.
 *
 * `connectors/list.ts`' own join rule, and it matters here for the same
 * reason it matters there: a setup that arrived as data must not be able
 * to say something about a server EO itself ships that the pack shipping
 * it disagrees with.
 */
function setupFor(server: McpServer): ConnectorSetup | null {
  return packConnectors().get(server.name) ?? server.connector;
}
