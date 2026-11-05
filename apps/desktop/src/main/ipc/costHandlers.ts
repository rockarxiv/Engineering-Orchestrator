import type { IpcPayload, IpcResponse, Uuid } from "@eo/core";
import { formatDateKey, startOfDay, startOfDayForKey } from "../dateUtils.js";
import type { Db } from "../db/client.js";
import { sideCallLinesBetween, sideCallLinesForItem, sumCostCentsBetween, sumCostCentsForItem, trialCostCentsBetween } from "../db/repos/index.js";

/**
 * Midnight to midnight, however many hours that is.
 *
 * Not `start + 24h`: the day a clock changes is 23 or 25 hours long, so a
 * fixed offset drops an hour of runs every spring and counts an hour
 * twice every autumn. Landing in the middle of the next day and asking
 * when *that* day began is right whatever the offset did.
 */
function endOfLocalDay(start: number): number {
  return startOfDay(start + 36 * 60 * 60 * 1000);
}

/** Electron-free so it's testable without ipcMain — registerHandler() just wires this to the "costs:getForItem" channel. */
export function getItemCost(db: Db, { itemId }: IpcPayload<"costs:getForItem">): IpcResponse<"costs:getForItem"> {
  // The whole figure, side calls in it, and the side calls' share as
  // their own lines (EO-477).
  return { itemId, costCents: sumCostCentsForItem(db, itemId as Uuid), sideCalls: sideCallLinesForItem(db, itemId as Uuid) };
}

/** Electron-free so it's testable without ipcMain — registerHandler() just wires this to the "costs:getDaily" channel. */
export function getDailyCost(db: Db, { date }: IpcPayload<"costs:getDaily">): IpcResponse<"costs:getDaily"> {
  const dateKey = date ?? formatDateKey(Date.now());
  const start = startOfDayForKey(dateKey);
  const end = endOfLocalDay(start);
  // The trials' share of the same figure (EO-582), reported apart and
  // never taken out of it: their cost counts against the budgets.
  return {
    date: dateKey,
    costCents: sumCostCentsBetween(db, start, end),
    sideCalls: sideCallLinesBetween(db, start, end),
    trialCostCents: trialCostCentsBetween(db, start, end),
  };
}
