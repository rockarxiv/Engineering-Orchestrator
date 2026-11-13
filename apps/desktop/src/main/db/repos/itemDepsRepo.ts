import { and, eq, or } from "drizzle-orm";
import { DEPENDENCY_WAITS, type DependencyWait, type ItemDep, type RecordItemWaits, type Uuid } from "@eo/core";
import { detectCycle, formatCyclePath, wouldCreateCycle } from "@eo/engine";
import type { Db } from "../client.js";
import { isReplica } from "../recordRole.js";
import { itemDeps, items } from "../schema.js";

/**
 * The column's text as a rule (EO-776). Anything this build has no word
 * for reads as `finished`, the rule that holds longest: a row a newer
 * build wrote with a rule this one does not know is safer waiting for
 * its dependency to finish than released early.
 */
function waitOf(raw: string): DependencyWait {
  return (DEPENDENCY_WAITS as readonly string[]).includes(raw) ? (raw as DependencyWait) : "finished";
}

function toDomain(row: typeof itemDeps.$inferSelect): ItemDep {
  const wait = waitOf(row.wait);
  return {
    itemId: row.itemId as Uuid,
    dependsOnId: row.dependsOnId as Uuid,
    wait,
    // A step only means something on a `reached` edge, and a `reached`
    // edge with none can never be met, so it falls back to `finished`
    // above rather than holding forever: see `scheduler.ts`.
    waitStepId: wait === "reached" ? row.waitStepId : null,
  };
}

/**
 * The rule an edge is written with (EO-776). Absent is `finished`, which
 * is what every caller that predates the rule means.
 */
export type DependencyGate = { wait: "finished" } | { wait: "none" } | { wait: "reached"; stepId: string };

function listAllEdges(db: Db): ItemDep[] {
  return db.select().from(itemDeps).all().map(toDomain);
}

/** Every dependency edge in the table — what the scheduler (E-02) needs, not scoped to one item. */
export function listAllDependencies(db: Db): ItemDep[] {
  return listAllEdges(db);
}

/**
 * A cycle can never be persisted (E-01): wouldCreateCycle() is checked
 * against every existing edge in the table, not just itemId's own,
 * before the insert runs.
 */
export function addDependency(db: Db, itemId: Uuid, dependsOnId: Uuid, gate: DependencyGate = { wait: "finished" }): ItemDep {
  const candidate = { itemId, dependsOnId, wait: gate.wait, waitStepId: gate.wait === "reached" ? gate.stepId : null };
  const existingEdges = listAllEdges(db);

  if (wouldCreateCycle(existingEdges, candidate)) {
    const cycle = detectCycle([...existingEdges, candidate]);
    throw new Error(`addDependency: would create a cycle: ${cycle ? formatCyclePath(cycle) : "(unknown)"}`);
  }

  const row = db.insert(itemDeps).values(candidate).returning().get();
  return toDomain(row);
}

export function listDependencies(db: Db, itemId: Uuid): ItemDep[] {
  return db.select().from(itemDeps).where(eq(itemDeps.itemId, itemId)).all().map(toDomain);
}

/** The edges waiting on one item — what it blocks — through `idx_item_deps_depends_on`. */
export function listDependents(db: Db, dependsOnId: Uuid): ItemDep[] {
  return db.select().from(itemDeps).where(eq(itemDeps.dependsOnId, dependsOnId)).all().map(toDomain);
}

export function removeDependency(db: Db, itemId: Uuid, dependsOnId: Uuid): void {
  db.delete(itemDeps)
    .where(and(eq(itemDeps.itemId, itemId), eq(itemDeps.dependsOnId, dependsOnId)))
    .run();
}

/** An item's edges in both directions, as a record sends them with the item (EO-434). */
export function waitsForWire(edges: readonly ItemDep[], itemId: string): RecordItemWaits {
  return {
    dependsOn: edges.filter((edge) => edge.itemId === itemId).map((edge) => edge.dependsOnId as string),
    blocks: edges.filter((edge) => edge.dependsOnId === itemId).map((edge) => edge.itemId as string),
  };
}

/**
 * Makes a replica's edges at one item what the record said they are
 * (EO-434). Nothing for an item that arrived saying nothing.
 *
 * No cycle check, unlike `addDependency`: the record is the authority
 * on this graph and refused a cycle when the edge was made, and a
 * replica that holds only part of the graph is in no position to
 * second-guess it.
 *
 * - An edge whose other end has not arrived is left out, not waited
 *   for: `item_deps` has foreign keys both ways, and that item brings
 *   the same edge with it when it comes, from its own side.
 * - An edge the record no longer has is removed — but only one to
 *   another item this machine mirrors. One to work the person keeps
 *   local is theirs; the record never knew of it and its silence is not
 *   a statement about it.
 */
export function keepArrivedWaits(db: Db, itemId: string, waits: RecordItemWaits | null | undefined): void {
  if (waits === null || waits === undefined) return;
  const here = (id: string): boolean => db.select({ id: items.id }).from(items).where(eq(items.id, id)).get() !== undefined;
  const wanted = [
    ...waits.dependsOn.map((other) => ({ itemId, dependsOnId: other })),
    ...waits.blocks.map((other) => ({ itemId: other, dependsOnId: itemId })),
  ].filter((edge) => edge.itemId !== edge.dependsOnId);
  const said = new Set(wanted.map((edge) => `${edge.itemId}>${edge.dependsOnId}`));

  const held = db
    .select()
    .from(itemDeps)
    .where(or(eq(itemDeps.itemId, itemId), eq(itemDeps.dependsOnId, itemId)))
    .all();
  for (const edge of held) {
    if (said.has(`${edge.itemId}>${edge.dependsOnId}`)) continue;
    const other = edge.itemId === itemId ? edge.dependsOnId : edge.itemId;
    if (!isReplica(db, other as Uuid)) continue;
    db.delete(itemDeps)
      .where(and(eq(itemDeps.itemId, edge.itemId), eq(itemDeps.dependsOnId, edge.dependsOnId)))
      .run();
  }
  for (const edge of wanted) {
    const other = edge.itemId === itemId ? edge.dependsOnId : edge.itemId;
    if (!here(other)) continue;
    db.insert(itemDeps).values(edge).onConflictDoNothing().run();
  }
}
