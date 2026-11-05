import type { ConnectorSetup } from "@eo/core";

/**
 * The connectors the installed packs ship (EO-315).
 *
 * A module-level value with a setter, for the reason `registry.ts` has
 * one: the readers are IPC handlers, and threading the folded packs
 * through every one of them would put an argument on functions that have
 * no other reason to know a pack exists — with one caller forgetting it
 * answering for a different installation than the one the engine is
 * running.
 *
 * The default is **empty**, which is where this differs from the
 * registry's. `registry.ts` falls back to the developer pack's because a
 * process that never composes an engine still has to know what a role
 * is; there is no such obligation here. With no pack folded the honest
 * answer is that nothing declares a connector, and the list is whatever
 * the catalogue's own rows say — which is invariant 13's second half
 * made checkable rather than asserted.
 */
let current: ReadonlyMap<string, ConnectorSetup> = new Map();

/** Installed once, by the composition root, from the packs it folded. Called before anything ticks. */
export function usePackConnectors(next: ReadonlyMap<string, ConnectorSetup>): void {
  current = next;
}

/**
 * What the installed packs declare, by server name.
 *
 * A function rather than a `const`, so a reader that imported this
 * module before the fold ran still sees what the fold installed — a
 * snapshot taken at import time would be a property of module order,
 * which is the fact this indirection exists to remove.
 */
export function packConnectors(): ReadonlyMap<string, ConnectorSetup> {
  return current;
}
