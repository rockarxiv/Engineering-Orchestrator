import type { PipelineStep, RecordPipeline, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent, getPipeline, getStep, insertMessage, listItemsOnStepIncludingArchived, listStepsForPipeline, markMessagesAboutResolved, openMessageAbout, openSubjectsOf } from "../db/repos/index.js";
import { olderVersionsInUse } from "../db/repos/pipelineVersionsRepo.js";
import { signedInPersonId } from "../identity/viewer.js";

/** What the message a replica sends about a step's missing agent is filed under (EO-877). */
export const STEP_AGENT_MISSING_HERE = "step_agent_missing_here";

/**
 * Every agent step this replica may be asked to run on a pipeline: the
 * live graph's, and those of each older version an unfinished item here
 * is still bound to, which it runs rather than the live one (EO-877).
 */
function stepsInUse(db: Db, pipelineId: string): Pick<PipelineStep, "id" | "name" | "type" | "agentId">[] {
  return [...listStepsForPipeline(db, pipelineId), ...olderVersionsInUse(db, pipelineId).flatMap((version) => version.steps)].filter((step) => step.type === "agent" && step.agentId !== null);
}

/** What one message is about: the pipeline, the step and the agent it names. Ids hold no `|`. */
function subjectOf(pipelineId: string, stepId: string, agentId: string): string {
  return `${pipelineId}|${stepId}|${agentId}`;
}

/**
 * The agents a graph from the organisation's record names that this
 * replica does not have, said to the person here (EO-877, ARCHITECTURE.md
 * §17.5).
 *
 * A record-held pipeline reaches a replica naming agents by the ids the
 * record holds them under: a project's own agents travel with the
 * project and a global one with a publication of the agents section, so
 * both normally arrive under the same ids. Where one has not — a global
 * agent the organisation never published, say — the step cannot run
 * here. The work offer naming it is dropped (`resolveOffer`), and no
 * other agent of the same kind is put in its place: the step says who
 * runs it, here as on the record. What this adds is the person being
 * told, once per step and agent, which step it is and which agent it
 * names, read off the page's `stepAgents`. Asked of the steps as this
 * replica stores them — which an unpublished pipelines section leaves as
 * this machine's own — and of every older version an item here still
 * runs on.
 *
 * Addressed to this desktop's person and on no project, because it is a
 * fact about this machine rather than about the project the record holds:
 * a message on a record-held project would be forgotten at the next pull
 * as one the record no longer holds open.
 */
export function noticeMissingStepAgents(db: Db, pipeline: RecordPipeline, now: number = Date.now()): boolean {
  let told = false;
  const pipelineName = getPipeline(db, pipeline.id)?.name ?? pipeline.name;
  for (const step of stepsInUse(db, pipeline.id)) {
    const agentId = step.agentId as string;
    if (getAgent(db, agentId as Uuid) !== undefined) continue;
    const subject = subjectOf(pipeline.id, step.id, agentId);
    if (openMessageAbout(db, STEP_AGENT_MISSING_HERE, subject) !== undefined) continue;
    const named = pipeline.stepAgents?.[agentId];
    const agent = named === undefined ? "an agent" : `**${named.name}**, a "${named.kind}" agent`;
    insertMessage(
      db,
      {
        recipientId: signedInPersonId(db),
        source: STEP_AGENT_MISSING_HERE,
        subject,
        body:
          `"${step.name}" on the "${pipelineName}" pipeline runs ${agent} this machine does not have, so this machine does not run that step. ` +
          `No other agent stands in for it. It runs here once the agent arrives — ask whoever manages your organisation's agents to publish it — or once the step names an agent this machine has.`,
      },
      now,
    );
    told = true;
  }
  return told;
}

/**
 * The same message, sent from a work offer the record made this replica
 * that names an agent it does not have (EO-877) — the offer is dropped,
 * and no other agent of the kind runs it.
 *
 * What covers an item that runs an older version of its pipeline than
 * the live graph: the record dispatches it by the agent that version's
 * step names, and a replica whose pipelines section is not published
 * holds neither the version nor the item's pin to it, so the offer is
 * the one place it sees that agent named. The name and kind are the
 * record's, carried on the offer.
 */
export function noticeOfferedAgentMissing(
  db: Db,
  item: { pipelineId: string | null },
  offer: { stepId: string; agentId: string; agentName?: string | undefined; agentKind?: string | undefined },
  now: number = Date.now(),
): boolean {
  if (item.pipelineId === null || getAgent(db, offer.agentId as Uuid) !== undefined) return false;
  const subject = subjectOf(item.pipelineId, offer.stepId, offer.agentId);
  if (openMessageAbout(db, STEP_AGENT_MISSING_HERE, subject) !== undefined) return false;
  const step = getStep(db, offer.stepId);
  const agent = offer.agentName === undefined ? "an agent" : `**${offer.agentName}**${offer.agentKind === undefined ? "" : `, a "${offer.agentKind}" agent`}`;
  insertMessage(
    db,
    {
      recipientId: signedInPersonId(db),
      source: STEP_AGENT_MISSING_HERE,
      subject,
      body:
        `"${step?.name ?? "A step"}" on the "${getPipeline(db, item.pipelineId)?.name ?? "organisation's"}" pipeline runs ${agent} this machine does not have, so this machine does not run that step. ` +
        `No other agent stands in for it. It runs here once the agent arrives — ask whoever manages your organisation's agents to publish it — or once the step names an agent this machine has.`,
    },
    now,
  );
  return true;
}

/**
 * Closes each open message this file sent whose step no longer waits on
 * a missing agent here (EO-877): the agent arrived; or neither the live
 * graph nor any version an item here still runs on has the step naming
 * it, and no unfinished item stands on the step — an item the record
 * dispatches by an older version this replica does not hold.
 * Answers whether any closed.
 */
export function settleMissingStepAgents(db: Db, now: number = Date.now()): boolean {
  let settled = false;
  for (const subject of openSubjectsOf(db, STEP_AGENT_MISSING_HERE)) {
    const [pipelineId = "", stepId = "", agentId = ""] = subject.split("|");
    const named = stepsInUse(db, pipelineId).some((step) => step.id === stepId && step.agentId === agentId);
    const stillMissing = getAgent(db, agentId as Uuid) === undefined && (named || itemsStandOn(db, pipelineId, stepId));
    if (!stillMissing && markMessagesAboutResolved(db, STEP_AGENT_MISSING_HERE, subject, now).length > 0) settled = true;
  }
  return settled;
}

/** Whether an unarchived item on this pipeline stands on this step. */
function itemsStandOn(db: Db, pipelineId: string, stepId: string): boolean {
  return listItemsOnStepIncludingArchived(db, stepId).some((item) => item.pipelineId === pipelineId && item.archivedAt === null);
}
