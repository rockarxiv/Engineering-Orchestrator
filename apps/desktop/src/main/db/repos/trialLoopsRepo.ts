import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { centsOfMicrocents, uuidv7, type TrialStopChoice } from "@eo/core";
import type { Db } from "../client.js";
import { items, runs, sideCalls, trialOutcomes, trialRounds, trialStops } from "../schema.js";

/**
 * A draft's test-fix loop, as rows (EO-586, ARCHITECTURE.md, "Trial
 * pipelines"): the rounds it has started, where its test items got to,
 * and the guardrail stops with what the person answered. The rules —
 * which round may start, what counts as failing, what an answer does —
 * are `main/trials/loop.ts`'s; this only reads and writes.
 */

/** One started round of a trial's test items. */
export interface TrialRound {
  id: string;
  trialPipelineId: string;
  number: number;
  startedAt: number;
  startedBy: string;
}

/** What EO woke the assistant about (EO-586). */
export type TrialEvent = "terminal" | "parked" | "attempts" | "person_step";

/** Where a trial item got to, as EO read it. */
export interface TrialOutcome {
  id: string;
  trialPipelineId: string;
  roundId: string | null;
  itemId: string;
  event: TrialEvent;
  stepId: string;
  result: string;
  failed: boolean;
  runId: string | null;
  commentId: string | null;
  createdAt: number;
}

/** Which guardrail stopped a loop (EO-586). */
export type TrialGuard = "rounds" | "budget" | "repeated_failure";

/** A guardrail stop, and the person's answer once they gave one. */
export interface TrialStop {
  id: string;
  trialPipelineId: string;
  guard: TrialGuard;
  commentId: string;
  createdAt: number;
  choice: TrialStopChoice | null;
  answeredAt: number | null;
  /** The trial's newest round number when it was answered (0 before any). */
  answeredAfterRound: number | null;
}

/** Records the next round of a trial, numbered one past its newest. */
export function recordTrialRound(db: Db, input: { trialPipelineId: string; startedBy: string; at?: number }): TrialRound {
  const newest = newestTrialRound(db, input.trialPipelineId);
  const round: TrialRound = {
    id: uuidv7(),
    trialPipelineId: input.trialPipelineId,
    number: (newest?.number ?? 0) + 1,
    startedAt: input.at ?? Date.now(),
    startedBy: input.startedBy,
  };
  db.insert(trialRounds).values(round).run();
  return round;
}

/** A trial's rounds, oldest first. */
export function listTrialRounds(db: Db, trialPipelineId: string): TrialRound[] {
  return db.select().from(trialRounds).where(eq(trialRounds.trialPipelineId, trialPipelineId)).orderBy(asc(trialRounds.number)).all();
}

/** The round a trial is on, or undefined before its first. */
export function newestTrialRound(db: Db, trialPipelineId: string): TrialRound | undefined {
  return db.select().from(trialRounds).where(eq(trialRounds.trialPipelineId, trialPipelineId)).orderBy(desc(trialRounds.number)).limit(1).get();
}

/** Records where a trial item got to. */
export function recordTrialOutcome(db: Db, input: Omit<TrialOutcome, "id" | "createdAt"> & { createdAt?: number }): TrialOutcome {
  const outcome: TrialOutcome = { ...input, id: uuidv7(), createdAt: input.createdAt ?? Date.now() };
  db.insert(trialOutcomes).values(outcome).run();
  return outcome;
}

/** Every outcome on a trial, oldest first. */
export function listTrialOutcomes(db: Db, trialPipelineId: string): TrialOutcome[] {
  return db
    .select()
    .from(trialOutcomes)
    .where(eq(trialOutcomes.trialPipelineId, trialPipelineId))
    .orderBy(asc(trialOutcomes.createdAt), asc(trialOutcomes.id))
    .all()
    .map((row) => ({ ...row, event: row.event as TrialEvent }));
}

/** Whether a park by this run of this item has already been read: one park is one wake, however many questions it asked. */
export function trialOutcomeForRun(db: Db, itemId: string, runId: string): boolean {
  return db.select({ id: trialOutcomes.id }).from(trialOutcomes).where(and(eq(trialOutcomes.itemId, itemId), eq(trialOutcomes.runId, runId))).get() !== undefined;
}

function toStop(row: typeof trialStops.$inferSelect): TrialStop {
  return { ...row, guard: row.guard as TrialGuard, choice: row.choice as TrialStopChoice | null };
}

/** Records a guardrail stop and the comment that asked the person. */
export function recordTrialStop(db: Db, input: { trialPipelineId: string; guard: TrialGuard; commentId: string; at?: number }): TrialStop {
  const stop = { id: uuidv7(), trialPipelineId: input.trialPipelineId, guard: input.guard, commentId: input.commentId, createdAt: input.at ?? Date.now(), choice: null, answeredAt: null, answeredAfterRound: null };
  db.insert(trialStops).values(stop).run();
  return toStop(stop);
}

/** The stop a comment asked about, if it is one. */
export function trialStopByComment(db: Db, commentId: string): TrialStop | undefined {
  const row = db.select().from(trialStops).where(eq(trialStops.commentId, commentId)).get();
  return row === undefined ? undefined : toStop(row);
}

/** Every stop on a trial, answered or not, oldest first. */
export function listTrialStops(db: Db, trialPipelineId: string): TrialStop[] {
  return db.select().from(trialStops).where(eq(trialStops.trialPipelineId, trialPipelineId)).orderBy(asc(trialStops.createdAt), asc(trialStops.id)).all().map(toStop);
}

/** The newest stop on a trial the person has not answered yet. */
export function openTrialStop(db: Db, trialPipelineId: string): TrialStop | undefined {
  const row = db
    .select()
    .from(trialStops)
    .where(and(eq(trialStops.trialPipelineId, trialPipelineId), isNull(trialStops.answeredAt)))
    .orderBy(desc(trialStops.createdAt), desc(trialStops.id))
    .limit(1)
    .get();
  return row === undefined ? undefined : toStop(row);
}

/**
 * Records the person's answer to a stop. Every stop on the trial still
 * open is answered with it: one answer settles the loop, whichever of its
 * stop comments it was given under.
 */
export function answerTrialStops(db: Db, trialPipelineId: string, choice: TrialStopChoice, at: number = Date.now()): void {
  const answeredAfterRound = newestTrialRound(db, trialPipelineId)?.number ?? 0;
  db.update(trialStops)
    .set({ choice, answeredAt: at, answeredAfterRound })
    .where(and(eq(trialStops.trialPipelineId, trialPipelineId), isNull(trialStops.answeredAt)))
    .run();
}

/**
 * Where the person last said to keep going on this trial, or zeros when
 * they never have: what every guardrail counts from. Rounds by number —
 * each round numbered past `afterRound` counts, so one started in the
 * same millisecond as the answer is not lost — and the draft's spend by
 * time, from `at`.
 */
export function trialKeptGoing(db: Db, trialPipelineId: string): { afterRound: number; at: number } {
  const row = db
    .select({ afterRound: sql<number | null>`max(${trialStops.answeredAfterRound})`, at: sql<number | null>`max(${trialStops.answeredAt})` })
    .from(trialStops)
    .where(and(eq(trialStops.trialPipelineId, trialPipelineId), eq(trialStops.choice, "Keep going"), isNotNull(trialStops.answeredAt)))
    .get();
  return { afterRound: row?.afterRound ?? 0, at: row?.at ?? 0 };
}

/**
 * What the items on one trial pipeline have cost since `since`, in whole
 * cents: runs and side calls, summed as `trialCostCentsBetween` sums
 * them. What the draft's budget guardrail weighs.
 */
export function trialSpendCentsSince(db: Db, trialPipelineId: string, since: number): number {
  const runsTotal = db.get<{ total: number | null }>(
    sql`select sum(${runs.costCents}) as total from ${runs} join ${items} on ${items.id} = ${runs.itemId} where ${items.pipelineId} = ${trialPipelineId} and ${runs.startedAt} >= ${since}`,
  );
  const sideTotal = db
    .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
    .from(sideCalls)
    .innerJoin(items, eq(items.id, sideCalls.itemId))
    .where(and(eq(items.pipelineId, trialPipelineId), sql`${sideCalls.startedAt} >= ${since}`))
    .get();
  return (runsTotal?.total ?? 0) + centsOfMicrocents(sideTotal?.total ?? 0);
}
