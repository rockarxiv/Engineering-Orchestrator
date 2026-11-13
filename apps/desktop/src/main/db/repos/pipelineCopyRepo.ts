import { asc, desc, eq } from "drizzle-orm";
import { uuidv7, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { pipelines, pipelineSteps, pipelineVersions, stepRoutes } from "../schema.js";

/**
 * A pipeline copied whole onto a project, and how its ids were re-minted
 * (EO-766).
 *
 * `stepIds` and `versionIds` map each of the source's ids to the copy's,
 * which is what lets the work standing on the source be moved onto the
 * matching step, under the matching version, of the copy.
 */
export interface PipelineCopy {
  pipelineId: string;
  stepIds: ReadonlyMap<string, string>;
  versionIds: ReadonlyMap<string, string>;
}

/**
 * Every step id that is one of a pipeline's own: its rows, retired ones
 * included, and any step a version names that no row holds any more.
 *
 * What a copy renames, and so what a caller minting the copy's ids ahead
 * of time — to point several copies at each other — has to mint them for.
 */
export function ownStepIds(db: Db, pipelineId: string): string[] {
  const ids = new Set(
    db.select({ id: pipelineSteps.id }).from(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipelineId)).all().map((row) => row.id),
  );
  for (const version of db.select({ steps: pipelineVersions.steps }).from(pipelineVersions).where(eq(pipelineVersions.pipelineId, pipelineId)).all()) {
    for (const step of arrayOf(version.steps)) {
      const id = isRecord(step) ? step["id"] : undefined;
      if (typeof id === "string") ids.add(id);
    }
  }
  return [...ids];
}

export interface CopyPipelineOptions {
  /**
   * Step ids already minted, the copy's own and other copies' (EO-766
   * review). A step of the source found here takes the id given; a route
   * whose target is found here is pointed at it — which is how a copy of
   * one shared pipeline hands work to the same project's copy of
   * another, rather than to the original the oldest project kept.
   * A source step missing from it is minted a fresh id.
   */
  stepIds?: ReadonlyMap<string, string>;
  /**
   * Where a route to a step that is not the source's and not in
   * `stepIds` goes instead; its own target where this answers it.
   */
  retarget?: (target: string) => string;
}

/**
 * Copies one pipeline onto a project: the row, every step (retired ones
 * included), every route, every version, and the template it remembers.
 *
 * Not an export and an import. An export carries the graph as it stands,
 * and an item may stand on a step only an older version has, or be bound
 * to a version the pipeline has since moved past; either would arrive on
 * the copy with nowhere to stand. So this copies the rows themselves,
 * with fresh ids for the pipeline, its steps, its routes and its
 * versions — a step id is unique across every pipeline in EO — and
 * rewrites each version's document to the copy's ids.
 *
 * A route out to another pipeline's step goes where `options` says, in
 * the live graph and in every version alike, and keeps its target
 * otherwise. The template origin is kept, with its step map moved onto
 * the copy's ids, so a later template update reaches the copy as it
 * reaches the source.
 *
 * One transaction, so a copy is either whole or not there.
 */
export function copyPipeline(db: Db, sourceId: string, projectId: Uuid, options: CopyPipelineOptions = {}): PipelineCopy {
  return db.transaction((tx) => {
    const source = tx.select().from(pipelines).where(eq(pipelines.id, sourceId)).get();
    if (source === undefined) throw new Error(`copyPipeline: no pipeline ${sourceId}`);
    const steps = tx.select().from(pipelineSteps).where(eq(pipelineSteps.pipelineId, sourceId)).orderBy(asc(pipelineSteps.position)).all();
    const routes = tx.select().from(stepRoutes).where(eq(stepRoutes.pipelineId, sourceId)).orderBy(asc(stepRoutes.position)).all();
    const versions = tx.select().from(pipelineVersions).where(eq(pipelineVersions.pipelineId, sourceId)).orderBy(asc(pipelineVersions.number)).all();

    const stepIds = new Map<string, string>();
    for (const id of ownStepIds(tx as unknown as Db, sourceId)) stepIds.set(id, options.stepIds?.get(id) ?? uuidv7());
    const stepOf = (id: string): string => stepIds.get(id) ?? id;
    const targetOf = (id: string): string => stepIds.get(id) ?? options.stepIds?.get(id) ?? options.retarget?.(id) ?? id;
    const routeIds = new Map<string, string>();
    const routeOf = (id: string): string => {
      const known = routeIds.get(id);
      if (known !== undefined) return known;
      const minted = uuidv7();
      routeIds.set(id, minted);
      return minted;
    };
    const versionIds = new Map(versions.map((version) => [version.id, uuidv7()] as const));

    const copyId = uuidv7();
    const now = Date.now();
    tx.insert(pipelines)
      .values({
        ...source,
        id: copyId,
        projectId,
        // Set once its steps exist, which is what the column references.
        entryStepId: null,
        currentVersionId: source.currentVersionId === null ? null : (versionIds.get(source.currentVersionId) ?? null),
        templateStepIds: remapValues(source.templateStepIds, stepOf),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const step of steps) tx.insert(pipelineSteps).values({ ...step, id: stepOf(step.id), pipelineId: copyId }).run();
    for (const route of routes) {
      tx.insert(stepRoutes)
        .values({ ...route, id: routeOf(route.id), pipelineId: copyId, fromStepId: stepOf(route.fromStepId), target: targetOf(route.target) })
        .run();
    }
    for (const version of versions) {
      tx.insert(pipelineVersions)
        .values({
          ...version,
          id: versionIds.get(version.id) as string,
          pipelineId: copyId,
          steps: arrayOf(version.steps).map((step) =>
            isRecord(step) ? { ...step, id: typeof step["id"] === "string" ? stepOf(step["id"]) : step["id"], pipelineId: copyId } : step,
          ),
          routes: arrayOf(version.routes).map((route) =>
            isRecord(route)
              ? {
                  ...route,
                  id: typeof route["id"] === "string" ? routeOf(route["id"]) : route["id"],
                  pipelineId: copyId,
                  fromStepId: typeof route["fromStepId"] === "string" ? stepOf(route["fromStepId"]) : route["fromStepId"],
                  target: typeof route["target"] === "string" ? targetOf(route["target"]) : route["target"],
                }
              : route,
          ),
          entryStepId: version.entryStepId === null ? null : stepOf(version.entryStepId),
        })
        .run();
    }
    if (source.entryStepId !== null) tx.update(pipelines).set({ entryStepId: stepOf(source.entryStepId) }).where(eq(pipelines.id, copyId)).run();

    return { pipelineId: copyId, stepIds, versionIds };
  });
}

/** The route targets a version's document names. */
export function versionTargets(version: { routes: unknown }): string[] {
  return arrayOf(version.routes).flatMap((route) => (isRecord(route) && typeof route["target"] === "string" ? [route["target"]] : []));
}

/**
 * Files a version of a pipeline that is an existing one with its route
 * targets moved, and answers its id (EO-766 review).
 *
 * For work bound to an older version whose routes hand off into a
 * pipeline that has since been split: the version itself is history and
 * stays exactly as it was, and this is the same graph, numbered after
 * every version the pipeline has, with each hand-off pointed where the
 * project's own work now goes. The pipeline's current version is not
 * moved.
 */
export function fileRetargetedVersion(db: Db, versionId: string, targetOf: (target: string) => string): string {
  const version = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, versionId)).get();
  if (version === undefined) throw new Error(`fileRetargetedVersion: no version ${versionId}`);
  const highest = db
    .select({ number: pipelineVersions.number })
    .from(pipelineVersions)
    .where(eq(pipelineVersions.pipelineId, version.pipelineId))
    .orderBy(desc(pipelineVersions.number))
    .limit(1)
    .get();
  const id = uuidv7();
  db.insert(pipelineVersions)
    .values({
      ...version,
      id,
      number: (highest?.number ?? 0) + 1,
      routes: arrayOf(version.routes).map((route) =>
        isRecord(route) && typeof route["target"] === "string" ? { ...route, target: targetOf(route["target"]) } : route,
      ),
      createdAt: Date.now(),
      createdBy: null,
      releaseNotes: null,
    })
    .run();
  return id;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `{ templateStepId: stepId }` map with each value moved onto the copy's ids. */
function remapValues(value: unknown, stepOf: (id: string) => string): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, id]) => [key, typeof id === "string" ? stepOf(id) : id]));
}
