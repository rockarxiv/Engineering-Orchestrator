import { stepAgentKind } from "@eo/core";
import { useQuery } from "@tanstack/react-query";
import { ipcQuery } from "../../query/client";
import { agentsKey } from "../../query/hooks";

/**
 * The kind of the agent a step names, as a screen reads it (EO-875): a
 * step carries no role of its own, so the "reviewer" in "agent ·
 * reviewer" is its agent's. From the agents list every screen already
 * shares; null for a step that names no agent, one of another type, and
 * while the list has not arrived.
 */
export function useStepAgentKind(): (step: { readonly type: string; readonly agentId: string | null }) => string | null {
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const list = agents.data?.agents ?? [];
  return (step) => stepAgentKind(list, step);
}
