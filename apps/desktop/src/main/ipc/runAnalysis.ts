import { centsOfMicrocents, type IpcPayload, type IpcResponse, type RunGroup, type RunGrouping, type RunRecord, type RunTotals } from "@eo/core";
import { formatDateKey } from "../dateUtils.js";
import type { Db } from "../db/client.js";
import { listRunRecords } from "../db/repos/index.js";

/**
 * Runs across items, for "how long did implement and review take on
 * these" and "what did this week's runs cost" (EO-541) — `runs:list`
 * and `runs:summary`, read-only.
 *
 * Both read the same rows through the same filters (`runAnalysisRepo.ts`),
 * so a summary's figures are always the sum of the list it summarises.
 */

/** Electron-free so it's testable without ipcMain — registerHandler() wires this to "runs:list". */
export function listRuns(db: Db, filters: IpcPayload<"runs:list">): IpcResponse<"runs:list"> {
  return { runs: listRunRecords(db, filters) };
}

/** Electron-free so it's testable without ipcMain — registerHandler() wires this to "runs:summary". */
export function summariseRuns(db: Db, request: IpcPayload<"runs:summary">): IpcResponse<"runs:summary"> {
  const { groupBy, ...filters } = request;
  const records = listRunRecords(db, filters);

  const grouped = new Map<string | null, { itemId: string | null; records: RunRecord[] }>();
  for (const record of records) {
    // Grouped on the item's id rather than its key: the id is the
    // identity and the key a label (`listReviewVerdictsByItem`'s reason).
    const identity = groupBy === "item" ? record.itemId : keyOf(record, groupBy);
    const group = grouped.get(identity) ?? { itemId: groupBy === "item" ? record.itemId : null, records: [] };
    group.records.push(record);
    grouped.set(identity, group);
  }

  const groups: RunGroup[] = [...grouped.values()].map((group) => ({
    key: keyOf(group.records[0]!, groupBy),
    itemId: group.itemId,
    ...totalsOf(group.records),
  }));
  return { groupBy, groups: groups.sort(byKey), overall: totalsOf(records) };
}

/** What a run is grouped under. */
function keyOf(record: RunRecord, groupBy: RunGrouping): string | null {
  switch (groupBy) {
    case "item":
      return record.itemKey;
    case "action":
      return record.action;
    case "backend":
      return record.backend;
    case "day":
      // The machine's local day, as the daily budget and `spend_read` count one.
      return record.startedAt === null ? null : formatDateKey(record.startedAt);
  }
}

/** Keys in order — EO-9 before EO-10, days by date — and the runs with no key last. */
function byKey(a: RunGroup, b: RunGroup): number {
  if (a.key === b.key) return 0;
  if (a.key === null) return 1;
  if (b.key === null) return -1;
  return a.key.localeCompare(b.key, "en", { numeric: true });
}

const MS_PER_MINUTE = 60_000;

/** Minutes to two places: fine enough to add up, coarse enough to read. */
function minutes(ms: number): number {
  return Math.round((ms / MS_PER_MINUTE) * 100) / 100;
}

/**
 * The figures for a set of runs.
 *
 * Active time is the sum of the durations — two runs at once count twice,
 * because two things were working. Elapsed time is the first start to the
 * last end, however much of it was spent waiting. Cost is summed in
 * micro-cents and rounded once (EO-510), so a hundred side calls of half a
 * cent each are fifty cents rather than nothing.
 */
function totalsOf(records: readonly RunRecord[]): RunTotals {
  let activeMs = 0;
  let firstStart: number | null = null;
  let lastEnd: number | null = null;
  const totals = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, microcents: 0, reviews: 0, rejections: 0 };

  for (const record of records) {
    if (record.durationMs !== null) activeMs += record.durationMs;
    if (record.startedAt !== null && (firstStart === null || record.startedAt < firstStart)) firstStart = record.startedAt;
    if (record.endedAt !== null && (lastEnd === null || record.endedAt > lastEnd)) lastEnd = record.endedAt;
    totals.tokensIn += record.tokensIn ?? 0;
    totals.tokensOut += record.tokensOut ?? 0;
    totals.cacheReadTokens += record.cacheReadTokens ?? 0;
    totals.cacheWriteTokens += record.cacheWriteTokens ?? 0;
    totals.microcents += record.costMicrocents ?? 0;
    if (record.verdict !== null) totals.reviews += 1;
    if (record.verdict === "reject") totals.rejections += 1;
  }

  return {
    count: records.length,
    activeMinutes: minutes(activeMs),
    elapsedMinutes: firstStart === null || lastEnd === null ? null : minutes(Math.max(0, lastEnd - firstStart)),
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costCents: centsOfMicrocents(totals.microcents),
    reviews: totals.reviews,
    rejections: totals.rejections,
  };
}
