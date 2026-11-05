import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { centsOfMicrocents, EMPTY_TRIAL_PLAN, TrialDesignSchema, TrialPlanSchema, TrialStepSourcesSchema, type TrialDesign, type TrialPlan, type Uuid } from "@eo/core";
import type { Db } from "../client.js";
import { items, pipelines, pipelineSteps, pipelineVersions, runs, sideCalls, stepRoutes } from "../schema.js";
import { releaseTrialModules } from "./moduleTrialGrantsRepo.js";

/**
 * Trial pipelines and the items filed on them (EO-582, ARCHITECTURE.md,
 * "Trial pipelines").
 *
 * A trial is a draft under test. Items cannot stand on a draft — they
 * stand on `pipeline_steps` rows and bind to a published version — so a
 * draft is materialised as a pipeline of its own, written the ordinary
 * way, and marked here. Everything a person browses reads pipelines
 * through `listPipelines`, which never answers with one of these; the
 * reads below are how the trial's own machinery finds them.
 */

/** What makes a pipeline a trial, and what it is a trial of. */
export interface TrialPipeline {
  id: Uuid;
  /** When it was made. */
  trialAt: number;
  /** The assistant conversation it was made from. */
  conversationId: Uuid;
  /** The pipeline the draft would replace, or null for a draft that creates one. */
  targetPipelineId: Uuid | null;
}

/**
 * Marks a pipeline as a trial (EO-582). Written once, by `createTrialFromDraft`,
 * in the transaction that creates the pipeline — so there is no moment
 * at which the pipeline exists and a board could list it.
 */
export function markTrialPipeline(db: Db, pipelineId: string, trial: { conversationId: string; targetPipelineId: string | null; at?: number }): void {
  db.update(pipelines)
    .set({ trialAt: trial.at ?? Date.now(), trialConversationId: trial.conversationId, trialTargetPipelineId: trial.targetPipelineId })
    .where(eq(pipelines.id, pipelineId))
    .run();
}

function toTrial(row: { id: string; trialAt: number | null; trialConversationId: string | null; trialTargetPipelineId: string | null }): TrialPipeline | undefined {
  if (row.trialAt === null || row.trialConversationId === null) return undefined;
  return { id: row.id as Uuid, trialAt: row.trialAt, conversationId: row.trialConversationId as Uuid, targetPipelineId: row.trialTargetPipelineId as Uuid | null };
}

const trialColumns = {
  id: pipelines.id,
  trialAt: pipelines.trialAt,
  trialConversationId: pipelines.trialConversationId,
  trialTargetPipelineId: pipelines.trialTargetPipelineId,
};

/** The trial a pipeline is, or undefined for a pipeline that is not one (or does not exist). */
export function getTrialPipeline(db: Db, pipelineId: string): TrialPipeline | undefined {
  const row = db.select(trialColumns).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  return row === undefined ? undefined : toTrial(row);
}

/** Whether this pipeline is a trial. */
export function isTrialPipeline(db: Db, pipelineId: string): boolean {
  return getTrialPipeline(db, pipelineId) !== undefined;
}

/**
 * A trial's plan (EO-584): how each of its steps runs on its test items.
 * Every step real where nobody has saved one, and where what is stored no
 * longer parses — a plan that cannot be read mocks and redirects nothing,
 * which is the direction that runs what the pipeline says. Undefined for a
 * pipeline that is not a trial.
 */
export function readTrialPlan(db: Db, pipelineId: string): TrialPlan | undefined {
  const row = db.select({ trialAt: pipelines.trialAt, trialPlan: pipelines.trialPlan }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  if (row === undefined || row.trialAt === null) return undefined;
  const parsed = TrialPlanSchema.safeParse(row.trialPlan ?? EMPTY_TRIAL_PLAN);
  return parsed.success ? parsed.data : EMPTY_TRIAL_PLAN;
}

/**
 * Writes a trial's plan (EO-584). The plan is judged by `saveTrialPlan`
 * (`main/trials/stepModes.ts`) before it gets here; this only refuses —
 * throws, a caller's mistake — a pipeline that is not a trial, because a
 * plan on a published pipeline would be a way to mock live work.
 */
export function writeTrialPlan(db: Db, pipelineId: string, plan: TrialPlan): void {
  if (!isTrialPipeline(db, pipelineId)) throw new Error(`Pipeline ${pipelineId} is not a trial, and only a trial has a plan.`);
  // `updated_at` moves with it, which is what a replica's pull pages on:
  // a plan saved between rounds has to reach whichever machine runs the
  // next trial item.
  db.update(pipelines).set({ trialPlan: plan, updatedAt: Date.now() }).where(eq(pipelines.id, pipelineId)).run();
}

/**
 * Records which live step each of a trial's steps was copied from
 * (EO-584), by the trial step's id. Written once, by
 * `createTrialFromDraft`, in the transaction that makes the trial.
 */
export function writeTrialStepSources(db: Db, pipelineId: string, sources: Readonly<Record<string, string>>): void {
  if (!isTrialPipeline(db, pipelineId)) throw new Error(`Pipeline ${pipelineId} is not a trial, and only a trial's steps are copies.`);
  db.update(pipelines).set({ trialStepSources: { ...sources } }).where(eq(pipelines.id, pipelineId)).run();
}

/**
 * Which live step each of a trial's steps was copied from (EO-584), by the
 * trial step's id; empty for a pipeline that is not a trial, a trial of a
 * new pipeline, and anything stored that is not a map of ids.
 */
export function readTrialStepSources(db: Db, pipelineId: string): Record<string, string> {
  const row = db.select({ trialAt: pipelines.trialAt, sources: pipelines.trialStepSources }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  if (row === undefined || row.trialAt === null) return {};
  const parsed = TrialStepSourcesSchema.safeParse(row.sources ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Records the design a person approved for a trial (EO-587): written when
 * the design card is approved, and again each round as its test items are
 * filed, so the design always knows which filed item is which test item.
 */
export function writeTrialDesign(db: Db, pipelineId: string, design: TrialDesign): void {
  if (!isTrialPipeline(db, pipelineId)) throw new Error(`Pipeline ${pipelineId} is not a trial, and only a trial has a design.`);
  db.update(pipelines).set({ trialDesign: design }).where(eq(pipelines.id, pipelineId)).run();
}

/**
 * The design a person approved for a trial (EO-587), or undefined for a
 * trial made without a design card, a pipeline that is not a trial, and
 * anything stored that no longer parses — which the loop reads as a trial
 * it has no design to compare a draft against, and so never applies one
 * to without a card.
 */
export function readTrialDesign(db: Db, pipelineId: string): TrialDesign | undefined {
  const row = db.select({ trialAt: pipelines.trialAt, design: pipelines.trialDesign }).from(pipelines).where(eq(pipelines.id, pipelineId)).get();
  if (row === undefined || row.trialAt === null || row.design === null) return undefined;
  const parsed = TrialDesignSchema.safeParse(row.design);
  return parsed.success ? parsed.data : undefined;
}

/** Every trial made from one conversation, oldest first. */
export function listTrialPipelinesForConversation(db: Db, conversationId: string): TrialPipeline[] {
  return db
    .select(trialColumns)
    .from(pipelines)
    .where(and(isNotNull(pipelines.trialAt), eq(pipelines.trialConversationId, conversationId)))
    .orderBy(pipelines.trialAt, pipelines.id)
    .all()
    .flatMap((row) => toTrial(row) ?? []);
}

/** The ids of every trial pipeline, as a set to test rows against. */
export function trialPipelineIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(isNotNull(pipelines.trialAt))
      .all()
      .map((row) => row.id),
  );
}

/** The trial items on one trial pipeline, archived or not. */
export function listTrialItemIds(db: Db, pipelineId: string): Uuid[] {
  return db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.pipelineId, pipelineId), isNotNull(items.trialAt)))
    .all()
    .map((row) => row.id as Uuid);
}

/**
 * The trial items the scheduler orders ahead of live work (EO-582).
 *
 * A trial's loop runs while its conversation does: the trial pipeline
 * exists — discarding or publishing deletes it — and the conversation it
 * came from is still open. An item on a trial whose conversation has been
 * closed is still a trial item, and still runs, but it waits its turn by
 * priority and age like anything else.
 *
 * Only the order changes. Concurrency stays where the guardrails put it
 * (invariant #10), and nothing running is stopped for a trial.
 */
export function trialItemsInRunningLoops(db: Db): Set<string> {
  const rows = db.all<{ id: string }>(sql`
    select i.id as id from ${items} i
    join ${pipelines} p on p.id = i.pipeline_id
    join ${items} c on c.id = p.trial_conversation_id
    where i.trial_at is not null
      and i.archived_at is null
      and p.trial_at is not null
      and c.archived_at is null
  `);
  return new Set(rows.map((row) => row.id));
}

/**
 * What trial items cost in [startMs, endMs) — runs and side calls, in
 * whole cents (EO-582).
 *
 * The part of the day's figure that was spent testing drafts, reported
 * beside it rather than taken out of it: a trial runs on real backends,
 * so it spends real money and counts against the daily and per-item
 * budgets like any other item. Side calls are summed in micro-cents and
 * rounded once, as every side-call reader does (EO-510).
 */
export function trialCostCentsBetween(db: Db, startMs: number, endMs: number): number {
  const runsTotal = db.get<{ total: number | null }>(
    sql`select sum(${runs.costCents}) as total from ${runs} join ${items} on ${items.id} = ${runs.itemId} where ${items.trialAt} is not null and ${items.previewAt} is null and ${runs.startedAt} >= ${startMs} and ${runs.startedAt} < ${endMs}`,
  );
  const sideTotal = db
    .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
    .from(sideCalls)
    .innerJoin(items, eq(items.id, sideCalls.itemId))
    .where(and(isNotNull(items.trialAt), isNull(items.previewAt), sql`${sideCalls.startedAt} >= ${startMs}`, sql`${sideCalls.startedAt} < ${endMs}`))
    .get();
  return (runsTotal?.total ?? 0) + centsOfMicrocents(sideTotal?.total ?? 0);
}

/**
 * Removes a trial pipeline's own rows: its routes, its steps, its
 * versions and the pipeline itself (EO-582), and its modules' trial
 * grants, archiving the draft copies made for it (EO-583).
 *
 * Its items are not this function's: they go first, through the item
 * delete path, which is the one sanctioned way a row leaves
 * `transitions` and `run_events` (invariant #3's exception). So this
 * refuses — throws, since it is a caller that skipped a step — while any
 * item still stands on the pipeline, and refuses a pipeline that is not a
 * trial outright: nothing else in EO deletes a pipeline row, and this
 * must never be the way one that a person published goes.
 */
export function deleteTrialPipelineRows(db: Db, pipelineId: string): void {
  if (!isTrialPipeline(db, pipelineId)) throw new Error(`Pipeline ${pipelineId} is not a trial, and only a trial's rows are ever deleted.`);
  const remaining = db.select({ id: items.id }).from(items).where(eq(items.pipelineId, pipelineId)).all();
  if (remaining.length > 0) throw new Error(`Trial pipeline ${pipelineId} still has ${remaining.length} item(s); delete them first.`);

  db.transaction((tx) => {
    // Its trial grants go with it, and the draft copies of modules made
    // for it are archived (EO-583): they existed to be tested here.
    releaseTrialModules(db, pipelineId);
    tx.delete(stepRoutes).where(eq(stepRoutes.pipelineId, pipelineId)).run();
    // The pointer to a step first: the two tables reference each other.
    tx.update(pipelines).set({ entryStepId: null, currentVersionId: null }).where(eq(pipelines.id, pipelineId)).run();
    tx.delete(pipelineSteps).where(eq(pipelineSteps.pipelineId, pipelineId)).run();
    tx.delete(pipelineVersions).where(eq(pipelineVersions.pipelineId, pipelineId)).run();
    tx.delete(pipelines).where(eq(pipelines.id, pipelineId)).run();
  });
}

