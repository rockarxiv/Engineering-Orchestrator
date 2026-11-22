import { TEAM_PARTICIPANT_ACTION, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import {
  clearSetting,
  getItem,
  getSetting,
  listRunsForItem,
  listTransitionsForItem,
  postComment,
  setItemHeld,
  stepForItem,
} from "../db/repos/index.js";
import { cancelHoldNote } from "./dispatchBlockers.js";

/**
 * Where EO-175 kept the runs a person had stopped: one entry per item,
 * naming the initiation the stop ended. Read once more here and removed;
 * nothing writes it any more, since a cancel now holds its item (EO-891).
 */
export const STOPPED_BY_HAND_KEY = "engine.stopped-by-hand";

interface Stop {
  itemId: string;
  initiationId: string;
}

/**
 * Turns every stop still standing into a hold on its item, with the
 * comment a cancel posts now, and removes the setting (EO-891).
 *
 * Run as EO starts, before the scheduler's first tick. A stop the item
 * has since moved past did nothing — the scheduler dropped such a stop
 * the next time it asked — so it is dropped here too rather than holding
 * an item nobody stopped. "Moved past" is read as the scheduler read it:
 * the initiation the stop named is the item's entry onto its current step
 * (or the step it was created on), or a run's own initiation since then.
 */
export function adoptStoppedByHand(db: Db, now: () => number = Date.now): void {
  const stops = getSetting<Stop[] | null>(db, STOPPED_BY_HAND_KEY, null);
  if (stops === null) return;
  for (const stop of Array.isArray(stops) ? stops : []) {
    if (typeof stop?.itemId === "string" && typeof stop.initiationId === "string") adoptOne(db, stop, now());
  }
  clearSetting(db, STOPPED_BY_HAND_KEY);
}

function adoptOne(db: Db, stop: Stop, at: number): void {
  const item = getItem(db, stop.itemId as Uuid);
  if (!item || item.archivedAt !== null) return;
  const step = stepForItem(db, item);
  if (!step || step.isTerminal || step.type === "user") return;

  const entry = listTransitionsForItem(db, item.id)
    .filter((transition) => transition.toStepId === item.stepId)
    .at(-1);
  const runs = listRunsForItem(db, item.id).filter((run) => run.action !== TEAM_PARTICIPANT_ACTION);
  const sinceEntry = runs.filter((run) => entry === undefined || (run.startedAt ?? 0) >= entry.ts);
  const stands =
    stop.initiationId === (entry?.id ?? `initial:${item.id}:${item.stepId}`) ||
    sinceEntry.some((run) => run.initiationId === stop.initiationId);
  if (!stands) return;

  // The cancelled run this stop came from, so a move ends the hold as it
  // ended the stop. A stop always followed a cancel; should none be found,
  // the item is held all the same, as a person's hold.
  const cancelled = sinceEntry.filter((run) => run.status === "cancelled").at(-1);
  if (item.heldAt === null) setItemHeld(db, item.id, at, cancelled?.id ?? null);
  postComment(db, {
    itemId: item.id,
    runId: cancelled?.id ?? null,
    author: { type: "engine" },
    kind: "note",
    body: cancelHoldNote(step.name, step.type === "agent" && step.team !== null && step.team !== undefined),
  });
}
