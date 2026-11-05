import { isDeliverableMcpServer, isDispatchable, isPreviewAgent, type ConnectorSetup, type McpServer, type PipelineStep } from "@eo/core";
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
 * neither — it is attached to an agent, and an agent is attached to a
 * step only by the role it owns — so the answer is two database reads
 * and belongs out here, where rows are.
 *
 * It is also the case the design is actually written about: inbound email
 * straight into an agent that can send replies through a helpdesk
 * server. Nothing about that step's own configuration says it sends;
 * what says so is the connector somebody gave the agent.
 *
 * **A step is what its role can do**, not what one agent is. Agents are
 * edited without anyone reopening the pipeline, and a refusal that
 * depended on which of three reviewers happened to hold the server
 * would be a pipeline that publishes on Tuesday and not on Wednesday.
 * So every dispatchable agent in the role counts, and the step is held
 * to the most any of them can reach.
 */
export function sideEffectingServersByStep(db: Db, steps: readonly PipelineStep[]): Record<string, string[]> {
  const sending = new Map<string, string>(
    listMcpServers(db)
      .filter((server) => isDeliverableMcpServer(server) && setupFor(server)?.sideEffects === true)
      .map((server) => [server.id, server.name]),
  );
  if (sending.size === 0) return {};

  // The preview's own agent is left out for the reason it is left out of
  // `staffedRoles` (EO-316): it runs on the fake backend and reaches
  // nowhere, so counting it would refuse a pipeline on the strength of
  // a rehearsal.
  const dispatchable = listAgents(db).filter((agent) => isDispatchable(agent) && !isPreviewAgent(agent));
  const serversByAgent = new Map(listAgentAttachments(db).map((attachments) => [attachments.agentId, attachments.mcpServerIds]));

  const sendingByRole = new Map<string, Set<string>>();
  for (const agent of dispatchable) {
    for (const serverId of serversByAgent.get(agent.id) ?? []) {
      const name = sending.get(serverId);
      if (name === undefined) continue;
      const held = sendingByRole.get(agent.role) ?? new Set<string>();
      held.add(name);
      sendingByRole.set(agent.role, held);
    }
  }

  const byStep: Record<string, string[]> = {};
  for (const step of steps) {
    if (step.type !== "agent" || step.ownerRole === null) continue;
    const names = sendingByRole.get(step.ownerRole);
    if (names === undefined || names.size === 0) continue;
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
