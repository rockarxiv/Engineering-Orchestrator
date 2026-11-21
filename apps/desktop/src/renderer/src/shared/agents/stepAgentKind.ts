import { stepAgentFactsLine, stepAgentKind, stepAgentOf, stepAgentProblem, type AgentView } from "@eo/core";
import { useQuery } from "@tanstack/react-query";
import { ipcQuery } from "../../query/client";
import { agentsKey } from "../../query/hooks";
import { runtimeLabel } from "./catalog";

type StepRef = { readonly type: string; readonly agentId: string | null };

/**
 * The kind of the agent a step names, as a screen reads it (EO-875): a
 * step carries no role of its own, so the "reviewer" in "agent ·
 * reviewer" is its agent's. From the agents list every screen already
 * shares; null for a step that names no agent, one of another type, and
 * while the list has not arrived.
 */
export function useStepAgentKind(): (step: StepRef) => string | null {
  return useStepAgents().kindOf;
}

/**
 * Who runs a step, as the Graph view and the board's column head say it
 * (EO-876): the agent it names, with its kind, backend and model, and in
 * words why nothing runs there where its agent cannot (`stepAgentProblem`,
 * the sentence `pipeline_get` says). Both are null for a step of another
 * type, and the problem is null while the agents list has not arrived —
 * an agent not yet read is not an agent EO no longer has.
 */
export function useStepAgents(): {
  kindOf: (step: StepRef) => string | null;
  agentOf: (step: StepRef) => AgentView | undefined;
  /** "Reviewer — reviewer · Codex · gpt-5", or null where the step names no agent here. */
  lineOf: (step: StepRef) => string | null;
  problemOf: (step: StepRef) => string | null;
} {
  const agents = useQuery({ queryKey: agentsKey, queryFn: () => ipcQuery("agents:list", undefined) });
  const list = agents.data?.agents ?? [];
  const agentOf = (step: StepRef) => stepAgentOf(list, step);
  return {
    kindOf: (step) => stepAgentKind(list, step),
    agentOf,
    lineOf: (step) => {
      const agent = agentOf(step);
      return agent === undefined ? null : `${agent.name} — ${stepAgentFactsLine(agent, runtimeLabel)}`;
    },
    problemOf: (step) => (agents.data === undefined ? null : stepAgentProblem(list, step)),
  };
}
