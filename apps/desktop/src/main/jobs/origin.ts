import type { ItemOrigin, Job, Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { firedOccurrencesForItems, getJob, occurrenceForItem, sumCostCentsForItem } from "../db/repos/index.js";

/**
 * Where an item came from, when it did not come from a person typing it
 * (EO-304, `ARCHITECTURE.md`, "What a job records").
 *
 * Read back through the occurrence rather than stored on the item. The
 * occurrence already records the firing that created it; a `jobId`
 * column on `items` would be the same fact written a second time, with
 * nothing keeping the two in step and a nullable foreign key on the
 * table every item shares.
 *
 * Null for most items, which is right: a person filing work is not a
 * provenance worth a row on the rail.
 *
 * **A deleted job is still named.** Its row survives as a tombstone
 * (EO-308) precisely so that an item somebody chose to keep can go on
 * saying what filed it; what disappears is the job from every list, not
 * the answer to "where did this come from".
 */
export function originOfItem(db: Db, itemId: Uuid): ItemOrigin | null {
  const occurrence = occurrenceForItem(db, itemId);
  if (!occurrence) return null;
  const job = getJob(db, occurrence.jobId as Uuid);
  // The job was deleted and the item it made outlived it (the design's
  // cascade). Nothing left to name, so the rail says nothing rather
  // than showing an id.
  if (!job) return null;
  return {
    jobId: job.id,
    jobName: job.name,
    trigger: job.trigger.kind,
    occurrenceId: occurrence.id,
    firedAt: occurrence.firedAt,
    // What this occurrence cost, for the card's hover (EO-308, ARCHITECTURE.md, "The inbox, the
    // archive and jobs").
    // The item's own runs, which is what "the occurrence's cost" means:
    // one occurrence files one item, and the job's total is `jobs:cost`.
    costCents: sumCostCentsForItem(db, itemId),
  };
}

/**
 * The same question asked of a whole screen's worth of items at once
 * (EO-308, ARCHITECTURE.md, "The inbox, the archive and jobs").
 *
 * A second function rather than a loop over `originOfItem`, for arity:
 * a board of fifty cards would be fifty occurrence lookups and fifty
 * job reads to produce, almost always, fifty nulls. The occurrences come
 * back in one query and each job is read once.
 *
 * **Every reader of the job facet goes through this.** The board draws
 * `ItemSummary` rows and `view:current` answers about the same board
 * from raw `items` rows, and the two must agree — `matchesBoardQuery`
 * reads `origin.jobId`, so a caller that handed it rows without one
 * would report an empty board to an agent while the person is looking
 * at four cards. That is the failure this index exists to make
 * impossible to write by accident.
 *
 * It agrees with `originOfItem` about *which* occurrence, since an item
 * can be named by more than one: both take the oldest firing, which
 * `firedOccurrencesForItems` orders for.
 *
 * A deleted job is still named. Its row is a tombstone precisely so
 * that an item somebody chose to keep goes on saying what filed it
 * (`deleteJob`) — which is the half of the delete dialog this makes
 * true on the board.
 */
export function originIndex(db: Db, itemIds: string[]): Map<string, ItemOrigin> {
  const origins = new Map<string, ItemOrigin>();
  const jobs = new Map<string, Job | undefined>();
  for (const occurrence of firedOccurrencesForItems(db, itemIds as Uuid[])) {
    if (occurrence.itemId === null || origins.has(occurrence.itemId)) continue;
    if (!jobs.has(occurrence.jobId)) jobs.set(occurrence.jobId, getJob(db, occurrence.jobId as Uuid));
    const job = jobs.get(occurrence.jobId);
    if (job === undefined) continue;
    origins.set(occurrence.itemId, {
      jobId: job.id,
      jobName: job.name,
      trigger: job.trigger.kind,
      occurrenceId: occurrence.id,
      firedAt: occurrence.firedAt,
      costCents: sumCostCentsForItem(db, occurrence.itemId as Uuid),
    });
  }
  return origins;
}
