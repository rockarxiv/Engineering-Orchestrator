import { documentSteps, isBoundAgent, stepAgentRefusal, type Agent, type PipelineExport, type PipelineStep, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getStep, listAgents, templateBoardHolders } from "../db/repos/index.js";

/**
 * The steps a template's installation on a project holds of one kind
 * (EO-877): each agent step of the kind in the document, as the project's
 * pipelines made from the template hold it, found through their template
 * origins. A step that names no agent has no kind of its own, so the
 * template's step it was made from is what says which kind it needs.
 *
 * Empty for a document that is not a template, or one not installed on
 * the project.
 */
export function installedStepsOfKind(db: Db, document: PipelineExport, projectId: string, kind: string): PipelineStep[] {
  if (document.template === null) return [];
  const needing = documentSteps(document).filter((step) => step.type === "agent" && step.ownerRole === kind);
  return templateBoardHolders(db, document.template.slug, projectId).flatMap((holder) =>
    needing.flatMap((step) => {
      const id = holder.stepIds[step.id];
      const here = id === undefined ? undefined : getStep(db, id);
      return here !== undefined && here.type === "agent" ? [here] : [];
    }),
  );
}

/** Whether a step's agent can run the project's work: it names one, that one runs here, and it has a backend. */
export function stepAgentRuns(agents: readonly Agent[], step: Pick<PipelineStep, "agentId">, projectId: string): boolean {
  const agent = step.agentId === null ? undefined : agents.find((candidate) => candidate.id === step.agentId);
  return agent !== undefined && isBoundAgent(agent) && stepAgentRefusal(agent, { previewAt: null, projectId: projectId as Uuid }) === null;
}

/**
 * Whether a template installed on a project has every step of a kind
 * running (EO-877) — read off the agents its steps name, not off whether
 * the project has some agent of the kind, so a person's choice of a
 * switched-off agent, or a step left naming nobody, is not reported as
 * ready. Null where the project holds no step of the kind from the
 * template: the needs check then says what the import would do.
 */
export function installedKindReady(db: Db, document: PipelineExport, projectId: string, kind: string): boolean | null {
  const steps = installedStepsOfKind(db, document, projectId, kind);
  if (steps.length === 0) return null;
  const agents = listAgents(db);
  return steps.every((step) => stepAgentRuns(agents, step, projectId));
}
