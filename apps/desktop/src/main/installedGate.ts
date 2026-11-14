import type { Item, PipelineStep } from "@eo/core";
import type { DispatchGate } from "@eo/engine";
import type { Db } from "./db/client.js";
import type { GateRefusal } from "./supervisor/dispatchBlockers.js";

/**
 * The dispatch gate the installed packs supplied, where a screen can ask
 * it (EO-781).
 *
 * The scheduler is handed the gate as an option; the board and the item
 * page are drawn by an IPC query that has no supervisor in hand, and a
 * card that sits still on a step a pack refuses has to say why. So it is
 * installed here as well, by `createEngine`, beside `useWorkspaceKinds`
 * and for that one's reason.
 *
 * Kept with the database it was composed with, and answered only for
 * that one: a pack's gate closes over its database, and asking it about
 * an item read from another — a test's second in-memory database, after
 * the first engine's was closed — would read the wrong rows or none.
 *
 * None until the composition root fills it: a process that never
 * composed an engine has no pack, and no pack refuses anything.
 */
let current: { db: Db; gate: DispatchGate<GateRefusal> } | undefined;

/** Installed once, by `createEngine`, from whatever packs it folded. */
export function useDispatchGate(db: Db, gate: DispatchGate<GateRefusal> | undefined): void {
  current = gate === undefined ? undefined : { db, gate };
}

/** What the installed gate says about this item on this step: null when nothing of a pack's stands in the way. */
export function installedGateRefusal(db: Db, item: Item, step: PipelineStep): GateRefusal | null {
  return current?.db === db ? current.gate(item, step) : null;
}
