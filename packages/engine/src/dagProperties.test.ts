import type { Item, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { dependencyClosure, detectCycle, readySet, topoOrder, wouldCreateCycle, type Edge } from "./dag.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
/**
 * Properties of the dependency graph, checked over many generated graphs
 * rather than a handful of drawn ones.
 *
 * The DAG is where a wrong answer is least visible: a missed cycle is an
 * insert that succeeds and a `topoOrder` that throws later, somewhere
 * else; a wrong ready set is an item dispatched before the work it
 * builds on. Example tests cover the shapes somebody thought of, and the
 * shapes nobody thought of are the point.
 *
 * Each property is checked against an oracle derived a different way from
 * the implementation — reachability by repeated relaxation rather than by
 * the colored depth-first walk `detectCycle` uses — so agreeing is
 * evidence rather than a restatement.
 */

/** Deterministic, so a failure is a reproduction rather than a report. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const id = (n: number) => `t${n}` as Uuid;

function makeItem(n: number): Item {
  return {
    id: id(n),
    key: `EO-${n}`,
    typeId: STORY_TYPE_ID,
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    workspaceId: null,
    projectId: null,
    title: `Ticket ${n}`,
    body: null,
    spec: null,
    pipelineId: "p1" as Uuid,
    stepId: "todo",
    pipelineVersionId: null,
    priority: 0,
    extensions: {},
    archivedAt: null,
    heldAt: null,
    previewAt: null,
    trialAt: null,
    createdBy: null,
    assigneeId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * An acyclic graph by construction: an edge only ever points from a
 * higher index to a lower one, so no path can return to where it began.
 */
function acyclicEdges(random: () => number, size: number, density: number): Edge[] {
  const edges: Edge[] = [];
  for (let a = 0; a < size; a++) {
    for (let b = 0; b < a; b++) {
      if (random() < density) edges.push({ itemId: id(a), dependsOnId: id(b) });
    }
  }
  return edges;
}

/**
 * Everything reachable from `start`, by relaxation rather than by a
 * depth-first walk — deliberately not the algorithm under test.
 */
function reachableFrom(edges: Edge[], start: Uuid): Set<Uuid> {
  const out = new Set<Uuid>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if ((edge.itemId === start || out.has(edge.itemId)) && !out.has(edge.dependsOnId)) {
        out.add(edge.dependsOnId);
        grew = true;
      }
    }
  }
  return out;
}

const SIZES = [1, 2, 5, 12, 30];
const DENSITIES = [0.05, 0.2, 0.6];

/** Every (seed, size, density) combination, so a failure names its own case. */
function graphs(): { seed: number; size: number; density: number; edges: Edge[]; items: Item[] }[] {
  const out = [];
  for (let seed = 1; seed <= 12; seed++) {
    for (const size of SIZES) {
      for (const density of DENSITIES) {
        const random = rng(seed * 7919 + size * 31 + Math.round(density * 100));
        out.push({ seed, size, density, edges: acyclicEdges(random, size, density), items: Array.from({ length: size }, (_, n) => makeItem(n)) });
      }
    }
  }
  return out;
}

const GRAPHS = graphs();

describe("detectCycle", () => {
  it("finds no cycle in a graph that cannot have one", () => {
    for (const { seed, size, density, edges } of GRAPHS) {
      expect({ seed, size, density, cycle: detectCycle(edges) }).toEqual({ seed, size, density, cycle: null });
    }
  });

  it("finds one whenever an edge is added that closes a path", () => {
    // For each acyclic graph, close a loop deliberately: pick a node with
    // something reachable from it and point that back at it.
    let exercised = 0;
    for (const { seed, size, density, edges } of GRAPHS) {
      for (let n = 0; n < size; n++) {
        const downstream = [...reachableFrom(edges, id(n))];
        if (downstream.length === 0) continue;
        const back: Edge = { itemId: downstream[0]!, dependsOnId: id(n) };
        exercised += 1;
        expect({ seed, size, density, n, found: detectCycle([...edges, back]) !== null }).toEqual({ seed, size, density, n, found: true });
      }
    }
    expect(exercised).toBeGreaterThan(100); // the case actually got exercised
  });

  it("returns a path that really is a cycle in the graph it was given", () => {
    // Not just "something was found": every consecutive pair must be an
    // edge, and it must close. A cycle report that does not hold up is a
    // message that sends somebody looking at the wrong items.
    for (const { edges } of GRAPHS) {
      for (let n = 0; n < 3; n++) {
        const downstream = [...reachableFrom(edges, id(n))];
        if (downstream.length === 0) continue;
        const withCycle = [...edges, { itemId: downstream[0]!, dependsOnId: id(n) }];
        const cycle = detectCycle(withCycle)!;

        expect(cycle.length).toBeGreaterThan(1);
        expect(cycle[0]).toBe(cycle[cycle.length - 1]);
        for (let i = 0; i + 1 < cycle.length; i++) {
          const from = cycle[i]!;
          const to = cycle[i + 1]!;
          expect(withCycle.some((edge) => edge.itemId === from && edge.dependsOnId === to)).toBe(true);
        }
      }
    }
  });

  it("always finds a self-loop", () => {
    for (const { edges, size } of GRAPHS) {
      const self: Edge = { itemId: id(size - 1), dependsOnId: id(size - 1) };
      expect(detectCycle([...edges, self])).not.toBeNull();
    }
  });
});

describe("wouldCreateCycle", () => {
  it("says yes exactly when the new dependency is already reachable the other way", () => {
    // The independent characterisation: adding "a depends on b" closes a
    // loop precisely when a is already reachable from b, or a is b.
    for (const { seed, size, density, edges } of GRAPHS) {
      for (let a = 0; a < size; a++) {
        for (let b = 0; b < size; b++) {
          const candidate: Edge = { itemId: id(a), dependsOnId: id(b) };
          const expected = a === b || reachableFrom(edges, id(b)).has(id(a));
          expect({ seed, size, density, a, b, would: wouldCreateCycle(edges, candidate) }).toEqual({ seed, size, density, a, b, would: expected });
        }
      }
    }
  });
});

describe("dependencyClosure", () => {
  it("is everything reachable, and never the item itself", () => {
    for (const { seed, size, density, edges } of GRAPHS) {
      for (let n = 0; n < size; n++) {
        const closure = dependencyClosure(edges, id(n));
        expect({ seed, size, density, n, closure: [...closure].sort() }).toEqual({ seed, size, density, n, closure: [...reachableFrom(edges, id(n))].sort() });
        expect(closure.has(id(n))).toBe(false);
      }
    }
  });

  it("contains every direct dependency", () => {
    for (const { edges } of GRAPHS) {
      for (const edge of edges) {
        if (edge.itemId === edge.dependsOnId) continue;
        expect(dependencyClosure(edges, edge.itemId).has(edge.dependsOnId)).toBe(true);
      }
    }
  });

  it("terminates and stays correct even when the graph has a cycle", () => {
    // Nothing promises the caller has checked first, and a closure that
    // hangs would take the process with it.
    for (const { edges, size } of GRAPHS.slice(0, 20)) {
      if (size < 2) continue;
      const cyclic = [...edges, { itemId: id(0), dependsOnId: id(size - 1) }, { itemId: id(size - 1), dependsOnId: id(0) }];
      const closure = dependencyClosure(cyclic, id(0));
      expect(closure.has(id(0))).toBe(false);
      expect(closure.has(id(size - 1))).toBe(true);
    }
  });
});

describe("topoOrder", () => {
  it("puts every dependency before the thing that depends on it", () => {
    for (const { seed, size, density, edges, items } of GRAPHS) {
      const ordered = topoOrder(items, edges);
      const position = new Map(ordered.map((item, index) => [item.id, index]));

      expect({ seed, size, density, count: ordered.length }).toEqual({ seed, size, density, count: items.length });
      for (const edge of edges) {
        expect(position.get(edge.dependsOnId)!).toBeLessThan(position.get(edge.itemId)!);
      }
    }
  });

  it("keeps every item exactly once", () => {
    for (const { edges, items } of GRAPHS) {
      const ordered = topoOrder(items, edges);
      expect(new Set(ordered.map((item) => item.id)).size).toBe(items.length);
    }
  });

  it("refuses a cyclic graph rather than returning a partial order", () => {
    for (const { edges, items, size } of GRAPHS) {
      if (size < 2) continue;
      const cyclic = [...edges, { itemId: id(0), dependsOnId: id(size - 1) }, { itemId: id(size - 1), dependsOnId: id(0) }];
      expect(() => topoOrder(items, cyclic)).toThrow(/cycle/i);
    }
  });

  it("ignores edges pointing outside the set it was given", () => {
    // A dependency on an item that is not here is assumed satisfied —
    // the same rule `readySet` follows. Counting it would leave the
    // dependent permanently unorderable and silently dropped.
    for (const { edges, items, size } of GRAPHS) {
      const outside = [...edges, { itemId: id(0), dependsOnId: "elsewhere" as Uuid }];
      expect(topoOrder(items, outside)).toHaveLength(size);
    }
  });
});

describe("readySet", () => {
  it("returns exactly the items with no unfinished dependency", () => {
    for (const { seed, size, density, edges, items } of GRAPHS) {
      const active = new Set(items.map((item) => item.id));
      const ready = readySet(items, edges).map((item) => item.id);
      const expected = items.filter((item) => !edges.some((edge) => edge.itemId === item.id && active.has(edge.dependsOnId))).map((item) => item.id);

      expect({ seed, size, density, ready }).toEqual({ seed, size, density, ready: expected });
    }
  });

  it("is never empty on an acyclic graph with something in it", () => {
    // A DAG always has a source. An empty ready set here would be the
    // scheduler stalling with work available and nothing to explain it.
    for (const { seed, size, density, edges, items } of GRAPHS) {
      expect({ seed, size, density, empty: readySet(items, edges).length === 0 }).toEqual({ seed, size, density, empty: false });
    }
  });

  it("treats a dependency outside the active set as already done", () => {
    for (const { edges, items } of GRAPHS) {
      const outside = [...edges, { itemId: id(0), dependsOnId: "elsewhere" as Uuid }];
      const before = readySet(items, edges).map((item) => item.id);
      expect(readySet(items, outside).map((item) => item.id)).toEqual(before);
    }
  });
});
