import { summariseConsolidation, type IpcPayload, type IpcResponse, type MemoryConsolidationSummary } from "@eo/core";
import type { Db } from "../db/client.js";
import { readGuards } from "./configCommands.js";
import { editedPredecessors, getMemorySearchEntry, listMemories, memoryUsageByEntry, searchMemories, supersededEntries, usageOf } from "../db/repos/index.js";
import type { ItemRecord } from "../record/record.js";
import type { EngineHandle } from "./domainCommands.js";

/**
 * The `memory:*` channels (EO-478): a person reading and writing a
 * scope's memory. Each write keeps what was there — an edit retires the
 * old row and inserts a new one, a retirement and a restore only stamp
 * and clear `retired_at` — and none of them deletes anything.
 *
 * Every write goes to whichever record holds the scope's project
 * (EO-482): this database for a solo desktop, a project kept on one, or
 * the organisation's server itself; the organisation's record for a
 * project somebody moved there, where the entry is shared by every
 * desktop and named after the person whose device asked. A person's
 * entry on a solo installation has no id, since there is nobody to tell
 * them apart from. Reading is always from this database, which a
 * desktop's sync keeps level with its record.
 */
export type MemoryRecord = Pick<ItemRecord, "writeMemory" | "memoryConsolidations" | "restoreMemoryConsolidation">;

export function listMemoryCommand(db: Db, payload: IpcPayload<"memory:list">): IpcResponse<"memory:list"> {
  // With how often each was given to a run and said to be used (EO-597),
  // from this database's run logs.
  const usage = memoryUsageByEntry(db);
  return { entries: listMemories(db, payload.scope, { includeRetired: payload.includeRetired ?? false }).map((entry) => ({ ...entry, ...usageOf(usage, entry.id) })) };
}

/**
 * Entries across every scope, filtered, and found by approximate text
 * search where a query is given (EO-545). From this database, as
 * `memory:list` reads: a desktop's sync keeps a moved project's entries
 * level with the record.
 */
export function searchMemoryCommand(db: Db, payload: IpcPayload<"memory:search">): IpcResponse<"memory:search"> {
  return { entries: searchMemories(db, payload) };
}

/**
 * One entry with its history (EO-545): the versions its edits replaced
 * and the entries it superseded as a note (EO-594), from this database,
 * and the consolidations that wrote or retired it, from the record that
 * ran them — the organisation's, for a moved
 * project, as `memory:consolidations` reads them. Every consolidation of
 * the scope is read, so an entry's links are found however old they are.
 */
export async function getMemoryCommand(db: Db, record: MemoryRecord, payload: IpcPayload<"memory:get">): Promise<IpcResponse<"memory:get">> {
  const entry = getMemorySearchEntry(db, payload.id);
  if (entry === undefined) return { ok: false, problem: `No memory entry has the id "${payload.id}".` };
  const consolidations = (await record.memoryConsolidations({ kind: entry.scope.kind, id: entry.scope.id })).map(summariseConsolidation);
  const producedBy = consolidations.find((consolidation) => consolidation.writtenIds.includes(entry.id)) ?? null;
  // Newest first, so the first that retired it is the latest to have —
  // an entry restored and folded again was retired twice.
  const retiredBy: MemoryConsolidationSummary | null = consolidations.find((consolidation) => consolidation.retiredIds.includes(entry.id)) ?? null;
  return { ok: true, entry, replaced: editedPredecessors(db, entry), superseded: supersededEntries(db, entry), producedBy, retiredBy };
}

export function addMemoryCommand(record: MemoryRecord, payload: IpcPayload<"memory:add">): Promise<IpcResponse<"memory:add">> {
  return record.writeMemory({ op: "add", scope: payload.scope, body: payload.body });
}

export function editMemoryCommand(record: MemoryRecord, payload: IpcPayload<"memory:edit">): Promise<IpcResponse<"memory:edit">> {
  return record.writeMemory({ op: "edit", id: payload.id, body: payload.body });
}

export function retireMemoryCommand(record: MemoryRecord, payload: IpcPayload<"memory:retire">): Promise<IpcResponse<"memory:retire">> {
  return record.writeMemory({ op: "retire", id: payload.id });
}

export function restoreMemoryCommand(record: MemoryRecord, payload: IpcPayload<"memory:restore">): Promise<IpcResponse<"memory:restore">> {
  return record.writeMemory({ op: "restore", id: payload.id });
}

/**
 * A scope's consolidations, newest first (EO-480): what a person restores
 * from. From the record that runs them — the organisation's, for a moved
 * project (EO-482). Each with how many entries it replaced and produced,
 * and whether it was restored (EO-545).
 */
export async function listConsolidationsCommand(
  record: MemoryRecord,
  payload: IpcPayload<"memory:consolidations">,
  engine?: Pick<EngineHandle, "memoryConsolidationPending">,
): Promise<IpcResponse<"memory:consolidations">> {
  return {
    consolidations: (await record.memoryConsolidations(payload.scope)).map(summariseConsolidation),
    // Whether one is queued or running here now (EO-589): the queue is the
    // supervisor's and is never written down.
    pending: engine?.memoryConsolidationPending?.(payload.scope) ?? null,
  };
}

/**
 * A person asking for one scope to be consolidated now (EO-589): handed
 * to the supervisor, which owns the consolidator and queues it with the
 * trigger `manual`. Without an engine nothing consolidates in this
 * process, and that is the answer.
 */
export function consolidateNowCommand(
  engine: Pick<EngineHandle, "consolidateMemoryNow"> | undefined,
  payload: IpcPayload<"memory:consolidateNow">,
): IpcResponse<"memory:consolidateNow"> {
  if (engine?.consolidateMemoryNow === undefined) {
    return { outcome: "refused", reason: "unavailable", message: "No engine runs in this EO process, so nothing consolidates memory here." };
  }
  return engine.consolidateMemoryNow(payload.scope);
}

/**
 * Puts back the set from before one consolidation, in one action
 * (EO-480): what it retired is active again, what it wrote is retired —
 * on the record that made it (EO-482).
 */
export function restoreConsolidationCommand(
  db: Db,
  record: MemoryRecord,
  payload: IpcPayload<"memory:restoreConsolidation">,
): Promise<IpcResponse<"memory:restoreConsolidation">> {
  const guards = readGuards(db);
  return record.restoreMemoryConsolidation(payload.consolidationId, { maxEntries: guards.memoryScopeMaxEntries, maxChars: guards.memoryScopeMaxChars });
}
