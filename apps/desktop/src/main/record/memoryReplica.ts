import type { RecordMemory, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { writeArrivedMemory } from "../db/repos/memoriesRepo.js";
import { getRun } from "../db/repos/runsRepo.js";

/**
 * Memory entries the record holds, copied into a replica (EO-482,
 * ARCHITECTURE.md, "The record").
 *
 * An entry names its source — the run that wrote it and the item that
 * run was on — and both are foreign keys. A replica can be sent an entry
 * before the run it names, because each list pages on a cursor of its
 * own; such an entry is held until the run is here rather than written
 * without it, which would lose who wrote it for good, since an entry is
 * paged again only when it changes.
 */

/** What an entry is waiting for before it can be written here, or null when nothing. */
export function memoryWaitingFor(db: Db, entry: RecordMemory): string | null {
  if (entry.source.type !== "run") return null;
  if (entry.source.itemId !== null && getItem(db, entry.source.itemId as Uuid) === undefined) return `item ${entry.source.itemId}`;
  if (entry.source.runId !== null && getRun(db, entry.source.runId as Uuid) === undefined) return `run ${entry.source.runId}`;
  return null;
}

/**
 * The rows a record answered a write with, copied here at once, so the
 * person or the run that asked sees the entry before the next pull.
 * Whatever this replica cannot place yet is left to that pull, which
 * brings it again with what it waits for.
 */
export function copyRecordMemories(db: Db, entries: readonly RecordMemory[]): void {
  for (const entry of entries) {
    try {
      if (memoryWaitingFor(db, entry) !== null) continue;
      writeArrivedMemory(db, entry);
    } catch (error) {
      // The record has it, which is what was asked; the pull brings it.
      console.warn(`[eo] memory entry ${entry.id} could not be copied from the record yet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
