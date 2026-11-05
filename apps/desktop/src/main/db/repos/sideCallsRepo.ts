import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  centsOfMicrocents,
  SIDE_CALL_SPEND_GROUPS,
  spendGroupOf,
  uuidv7,
  type SideCallFailureReason,
  type SideCallPurpose,
  type SideCallSpendGroup,
  type SideCallSpendLine,
  type Uuid,
} from "@eo/core";
import type { Db } from "../client.js";
import { items, projects, sideCalls } from "../schema.js";
import { notifySideCallRecorded } from "../sideCallEvents.js";

/** One row of `side_calls`, as EO reads it back (EO-477). No prompt and no answer: neither is stored. */
export interface SideCallRow {
  id: Uuid;
  purpose: SideCallPurpose;
  projectId: Uuid | null;
  itemId: Uuid | null;
  runId: Uuid | null;
  backend: string;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /**
   * What it cost in millionths of a cent (EO-510). A side call costs a
   * fraction of a cent, so whole cents would record almost every one as
   * nothing; every reader below sums these first and rounds the sum.
   */
  costMicrocents: number;
  startedAt: number;
  durationMs: number;
  outcome: "succeeded" | "failed";
  reason: SideCallFailureReason | null;
}

export type RecordSideCallInput = Omit<SideCallRow, "id"> & { id?: Uuid };

/**
 * Writes the one row a side call leaves, however it ended — and says so,
 * so a desktop signed in to an organisation sends it to the record
 * (`onSideCallRecorded`, EO-514).
 */
export function recordSideCall(db: Db, input: RecordSideCallInput): SideCallRow {
  const row: SideCallRow = { ...input, id: input.id ?? (uuidv7() as Uuid) };
  db.insert(sideCalls).values(row).run();
  notifySideCallRecorded(db, row);
  return row;
}

/**
 * Writes a side call a device reported, on the record (EO-514), under
 * the record's own item's project — the one its budgets read. Announced
 * to nobody: it is the device's call, already on its way to nowhere
 * else. A report that arrives twice writes nothing the second time.
 */
export function mirrorReportedSideCall(db: Db, input: SideCallRow): void {
  db.insert(sideCalls).values(input).onConflictDoNothing({ target: sideCalls.id }).run();
}

export function listSideCalls(db: Db): SideCallRow[] {
  return db
    .select()
    .from(sideCalls)
    .all()
    .map((row) => ({
      ...row,
      id: row.id as Uuid,
      purpose: row.purpose as SideCallPurpose,
      projectId: row.projectId as Uuid | null,
      itemId: row.itemId as Uuid | null,
      runId: row.runId as Uuid | null,
      outcome: row.outcome as SideCallRow["outcome"],
      reason: row.reason as SideCallFailureReason | null,
    }));
}

/**
 * Not a preview's. A side call about a preview item spends nothing real,
 * and is left out for the reason every run sum in `runsRepo.ts` leaves a
 * preview's runs out (EO-313): a rehearsal must never be what trips a
 * budget. A call about no item at all — consolidation — always counts.
 *
 * Read through a left join on `items`, so every sum below joins it.
 */
const notAPreview: SQL = or(isNull(sideCalls.itemId), isNull(items.previewAt))!;

/**
 * A sum of micro-cents as whole cents (EO-510) — rounded once, after the
 * summing, so that half-cent calls add up rather than each counting as
 * nought. Every figure these readers return is whole cents, as every
 * amount in EO is, and adds to the runs' sum beside it.
 */
function total(rows: { total: number | null } | undefined): number {
  return centsOfMicrocents(rows?.total ?? 0);
}

/** What side calls about one item have cost — half of the per-item budget's figure. */
export function sideCallCentsForItem(db: Db, itemId: Uuid): number {
  return total(
    db
      .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .innerJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(eq(sideCalls.itemId, itemId), isNull(items.previewAt)))
      .get(),
  );
}

/** Side calls about any of these items, for a job's spend (EO-307). */
export function sideCallCentsForItems(db: Db, itemIds: Uuid[]): number {
  if (itemIds.length === 0) return 0;
  return total(
    db
      .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .innerJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(inArray(sideCalls.itemId, itemIds), isNull(items.previewAt)))
      .get(),
  );
}

/** Every side call started at or after `sinceMs` — half of the daily budget's figure. */
export function sideCallCentsSince(db: Db, sinceMs: number): number {
  return total(
    db
      .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .leftJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(notAPreview, sql`${sideCalls.startedAt} >= ${sinceMs}`))
      .get(),
  );
}

/** Every side call started in [startMs, endMs). */
export function sideCallCentsBetween(db: Db, startMs: number, endMs: number): number {
  return total(
    db
      .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .leftJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(notAPreview, sql`${sideCalls.startedAt} >= ${startMs}`, sql`${sideCalls.startedAt} < ${endMs}`))
      .get(),
  );
}

/**
 * What side calls cost, by the line a spend screen lists them under
 * ("Memory upkeep"), in the order the groups are declared. A group with
 * nothing spent is left out, so a screen draws no line of zeroes.
 */
function linesOf(rows: { purpose: string; total: number | null }[]): SideCallSpendLine[] {
  // Micro-cents by group, rounded once the group is summed (EO-510).
  const byGroup = new Map<SideCallSpendGroup, number>();
  for (const row of rows) {
    const group = spendGroupOf(row.purpose as SideCallPurpose);
    byGroup.set(group, (byGroup.get(group) ?? 0) + (row.total ?? 0));
  }
  return (Object.keys(SIDE_CALL_SPEND_GROUPS) as SideCallSpendGroup[])
    .map((group) => ({ group, label: SIDE_CALL_SPEND_GROUPS[group].label, costCents: centsOfMicrocents(byGroup.get(group) ?? 0) }))
    .filter((line) => line.costCents > 0);
}

/** The spend lines for one day, [startMs, endMs). */
export function sideCallLinesBetween(db: Db, startMs: number, endMs: number): SideCallSpendLine[] {
  return linesOf(
    db
      .select({ purpose: sideCalls.purpose, total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .leftJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(notAPreview, sql`${sideCalls.startedAt} >= ${startMs}`, sql`${sideCalls.startedAt} < ${endMs}`))
      .groupBy(sideCalls.purpose)
      .all(),
  );
}

/** The spend lines for one item. */
export function sideCallLinesForItem(db: Db, itemId: Uuid): SideCallSpendLine[] {
  return linesOf(
    db
      .select({ purpose: sideCalls.purpose, total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .innerJoin(items, eq(items.id, sideCalls.itemId))
      .where(and(eq(sideCalls.itemId, itemId), isNull(items.previewAt)))
      .groupBy(sideCalls.purpose)
      .all(),
  );
}

/** By project id, for the project switcher's totals (EO-326). A call on no project is summed under null. */
export function sideCallCentsByProject(db: Db): Map<string | null, number> {
  const rows = db
    .select({ projectId: sideCalls.projectId, total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
    .from(sideCalls)
    .leftJoin(items, eq(items.id, sideCalls.itemId))
    .where(notAPreview)
    .groupBy(sideCalls.projectId)
    .all();
  return new Map(rows.map((row) => [row.projectId, total(row)]));
}

/** By the owner of the call's project since `sinceMs` (EO-328). */
export function sideCallCentsByOwnerSince(db: Db, sinceMs: number): Map<string | null, number> {
  const rows = db
    .select({ ownerId: projects.ownerId, total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
    .from(sideCalls)
    .leftJoin(items, eq(items.id, sideCalls.itemId))
    .leftJoin(projects, eq(projects.id, sideCalls.projectId))
    .where(and(notAPreview, sql`${sideCalls.startedAt} >= ${sinceMs}`))
    .groupBy(projects.ownerId)
    .all();
  return new Map(rows.map((row) => [row.ownerId, total(row)]));
}

/** One person's share of the above. */
export function personSideCallCentsSince(db: Db, personId: Uuid, sinceMs: number): number {
  return total(
    db
      .select({ total: sql<number | null>`sum(${sideCalls.costMicrocents})` })
      .from(sideCalls)
      .leftJoin(items, eq(items.id, sideCalls.itemId))
      .innerJoin(projects, eq(projects.id, sideCalls.projectId))
      .where(and(notAPreview, eq(projects.ownerId, personId), sql`${sideCalls.startedAt} >= ${sinceMs}`))
      .get(),
  );
}
