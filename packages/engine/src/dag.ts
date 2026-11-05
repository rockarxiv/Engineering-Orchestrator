import type { Item, Uuid } from "@eo/core";

export interface Edge {
  itemId: Uuid;
  dependsOnId: Uuid;
}

function buildAdjacency(edges: Edge[]): Map<Uuid, Uuid[]> {
  const adjacency = new Map<Uuid, Uuid[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.itemId);
    if (list) {
      list.push(edge.dependsOnId);
    } else {
      adjacency.set(edge.itemId, [edge.dependsOnId]);
    }
  }
  return adjacency;
}

const enum Color {
  White = 0,
  Gray = 1,
  Black = 2,
}

/**
 * Returns the cycle as a readable path (e.g. ["A", "B", "C", "A"]) or null
 * if the graph is acyclic. Follows "item depends on" edges.
 */
export function detectCycle(edges: Edge[]): Uuid[] | null {
  const adjacency = buildAdjacency(edges);
  const nodes = new Set<Uuid>();
  for (const edge of edges) {
    nodes.add(edge.itemId);
    nodes.add(edge.dependsOnId);
  }

  const color = new Map<Uuid, Color>();
  const stack: Uuid[] = [];

  function visit(node: Uuid): Uuid[] | null {
    color.set(node, Color.Gray);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? Color.White;
      if (nextColor === Color.White) {
        const found = visit(next);
        if (found) return found;
      } else if (nextColor === Color.Gray) {
        const cycleStart = stack.indexOf(next);
        return [...stack.slice(cycleStart), next];
      }
    }

    stack.pop();
    color.set(node, Color.Black);
    return null;
  }

  for (const node of nodes) {
    if ((color.get(node) ?? Color.White) === Color.White) {
      const found = visit(node);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Every item `itemId` depends on, directly or through another
 * item — the transitive closure of "depends on" edges, excluding
 * `itemId` itself.
 *
 * Used by the stacking resolver to tell a genuine sibling apart from a
 * dependency that already contains another one: if C depends on A and B
 * while B depends on A, B's branch was cut from A's, so B alone is the
 * one to stack on. Only the closure can see that — the direct edges
 * from C say nothing about how A and B relate to each other.
 *
 * Iterative rather than recursive: this walks the whole table's edges,
 * and a deep chain of stories is not worth a stack frame each.
 */
export function dependencyClosure(edges: Edge[], itemId: Uuid): Set<Uuid> {
  const adjacency = buildAdjacency(edges);
  const seen = new Set<Uuid>();
  const queue = [...(adjacency.get(itemId) ?? [])];

  while (queue.length > 0) {
    const next = queue.pop()!;
    if (seen.has(next) || next === itemId) continue;
    seen.add(next);
    queue.push(...(adjacency.get(next) ?? []));
  }

  return seen;
}

/** Formats a detectCycle() result for error messages: "A → B → C → A". */
export function formatCyclePath(cycle: Uuid[]): string {
  return cycle.join(" → ");
}

/** Would adding `candidate` to `edges` introduce a cycle? Check before every insert. */
export function wouldCreateCycle(edges: Edge[], candidate: Edge): boolean {
  return detectCycle([...edges, candidate]) !== null;
}

/**
 * Items ready to work on now: every dependency is satisfied. `items`
 * is expected to be the caller's *active* (non-terminal) set — a
 * dependency id that doesn't appear in it is assumed already terminal,
 * since packages/engine has no way to know workflow_states.is_terminal
 * itself (that's DB state, and this module must stay pure).
 */
export function readySet(items: Item[], edges: Edge[]): Item[] {
  const activeIds = new Set(items.map((item) => item.id));
  const adjacency = buildAdjacency(edges);

  return items.filter((item) => {
    const deps = adjacency.get(item.id) ?? [];
    return deps.every((depId) => !activeIds.has(depId));
  });
}

/**
 * Dependencies before dependents. Throws if `edges` contains a cycle —
 * there is no valid order for a cyclic graph.
 */
export function topoOrder(items: Item[], edges: Edge[]): Item[] {
  const cycle = detectCycle(edges);
  if (cycle) {
    throw new Error(`topoOrder: cycle detected: ${formatCyclePath(cycle)}`);
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const dependents = new Map<Uuid, Uuid[]>(); // dependsOnId -> [itemId, ...]
  const remainingDepCount = new Map<Uuid, number>();

  for (const item of items) {
    remainingDepCount.set(item.id, 0);
  }
  for (const edge of edges) {
    if (!byId.has(edge.itemId) || !byId.has(edge.dependsOnId)) continue; // dep outside this set
    remainingDepCount.set(edge.itemId, (remainingDepCount.get(edge.itemId) ?? 0) + 1);
    const list = dependents.get(edge.dependsOnId);
    if (list) {
      list.push(edge.itemId);
    } else {
      dependents.set(edge.dependsOnId, [edge.itemId]);
    }
  }

  const queue = items.filter((item) => remainingDepCount.get(item.id) === 0).map((item) => item.id);
  const ordered: Item[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const dependentId of dependents.get(id) ?? []) {
      const remaining = (remainingDepCount.get(dependentId) ?? 0) - 1;
      remainingDepCount.set(dependentId, remaining);
      if (remaining === 0) queue.push(dependentId);
    }
  }

  return ordered;
}

export interface StoryTouches {
  touches: string[];
}

export interface TouchesDependency {
  storyIndex: number;
  dependsOnIndex: number;
}

/** `./src/` and `src` are the same place; comparing them as strings says otherwise. */
function normalisePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Do these two entries name work in the same place?
 *
 * Prefix, not equality (KAN-31). The original compared with `includes`,
 * so `src/` and `src/router.js` — plainly the same collision — did not
 * overlap, and neither did any two spellings of anything. A real run
 * returned `["gateway/", "gateway middleware / request pipeline"]`, at
 * which point the check could not fire at all.
 *
 * The boundary matters: `src/a` must not overlap `src/abc`, so a prefix
 * only counts when the next character is a separator.
 */
export function touchesOverlap(a: string, b: string): boolean {
  const left = normalisePath(a);
  const right = normalisePath(b);
  if (left === "" || right === "") return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Proposes serializing any two stories whose `touches` overlap — a
 * suggestion for human or engine review, never applied automatically.
 * Indices are positions within `stories`, matching how the PO agent's
 * StoriesOutput expresses depends_on before real items exist (ARCHITECTURE.md, "What it proposes,
 * and what a person approves").
 */
export function deriveDepsFromTouches(stories: StoryTouches[]): TouchesDependency[] {
  const dependencies: TouchesDependency[] = [];

  for (let i = 0; i < stories.length; i++) {
    for (let j = 0; j < i; j++) {
      const overlaps = stories[i]!.touches.some((path) => stories[j]!.touches.some((other) => touchesOverlap(path, other)));
      if (overlaps) {
        dependencies.push({ storyIndex: i, dependsOnIndex: j });
      }
    }
  }

  return dependencies;
}
