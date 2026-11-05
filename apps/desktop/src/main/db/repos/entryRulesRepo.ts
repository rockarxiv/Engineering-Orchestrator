import { qualifiedItemType, type Item, type Uuid } from "@eo/core";
import { entryRefusal } from "@eo/engine";
import type { Db } from "../client.js";
import { registry } from "../../registry.js";
import { getItemType, type ItemType } from "./itemTypesRepo.js";
import { getPipeline } from "./pipelineStepsRepo.js";
import { entryRulesForArrival } from "./pipelineVersionsRepo.js";

/**
 * Whether work may enter a pipeline (EO-610, ARCHITECTURE.md, "Entry
 * rules"): the reads `packages/engine` cannot make for itself.
 */

/** What is arriving, and where. Facts rather than an item, because at creation and on a job's template there is no item yet. */
export interface Arrival {
  pipelineId: string;
  stepId: string | null;
  type: ItemType;
  body: string | null;
  spec: Readonly<Record<string, unknown>> | null;
  hasWorkspace: boolean;
  extensions: Readonly<Record<string, unknown>>;
}

/** The sentence refusing this arrival, or null where it may enter. */
export function arrivalRefusal(db: Db, arrival: Arrival): string | null {
  const rules = entryRulesForArrival(db, arrival.pipelineId, arrival.stepId);
  if (rules.length === 0) return null;
  return entryRefusal(
    getPipeline(db, arrival.pipelineId)?.name ?? "This pipeline",
    rules,
    {
      itemType: qualifiedItemType(arrival.type),
      body: arrival.body,
      spec: arrival.spec,
      hasWorkspace: arrival.hasWorkspace,
      declaredFields: Object.keys(arrival.type.specShape.properties),
      extensions: arrival.extensions,
    },
    registry.entryRuleKinds,
  );
}

/**
 * The same for an item that exists and is moving in from elsewhere.
 *
 * Null where the pipeline is the one it is on: only entering is checked.
 * Null on a rehearsal too, so a trial or a preview does not exercise the
 * rules.
 */
export function itemEntryRefusal(db: Db, item: Item, toPipelineId: string | null, toStepId: string): string | null {
  if (toPipelineId === null || toPipelineId === item.pipelineId) return null;
  if (item.trialAt !== null || item.previewAt !== null) return null;
  const type = getItemType(db, item.typeId as Uuid);
  if (type === undefined) return null;
  return arrivalRefusal(db, {
    pipelineId: toPipelineId,
    stepId: toStepId,
    type,
    body: item.body,
    spec: item.spec,
    hasWorkspace: item.workspaceId !== null,
    extensions: item.extensions,
  });
}
