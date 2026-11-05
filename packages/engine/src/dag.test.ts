import type { Item, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import {
  dependencyClosure,
  deriveDepsFromTouches,
  detectCycle,
  formatCyclePath,
  readySet,
  topoOrder,
  wouldCreateCycle,
  type Edge,
} from "./dag.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
function makeItem(id: string, overrides: Partial<Item> = {}): Item {
  return {
    id: id as Uuid,
    key: `EO-${id}`,
    typeId: STORY_TYPE_ID,
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    workspaceId: null,
    projectId: null,
    title: id,
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
    ...overrides,
  };
}

function edge(itemId: string, dependsOnId: string): Edge {
  return { itemId: itemId as Uuid, dependsOnId: dependsOnId as Uuid };
}

describe("dependencyClosure", () => {
  it("is empty for an item that depends on nothing", () => {
    expect(dependencyClosure([edge("A", "B")], "B" as Uuid)).toEqual(new Set());
  });

  it("includes what an item depends on through another item", () => {
    const edges = [edge("C", "B"), edge("B", "A")];
    expect(dependencyClosure(edges, "C" as Uuid)).toEqual(new Set(["B", "A"]));
  });

  it("visits a diamond's shared tail once and terminates", () => {
    const edges = [edge("D", "B"), edge("D", "C"), edge("B", "A"), edge("C", "A")];
    expect(dependencyClosure(edges, "D" as Uuid)).toEqual(new Set(["B", "C", "A"]));
  });

  it("never contains the item itself", () => {
    const edges = [edge("B", "A"), edge("C", "B")];
    expect(dependencyClosure(edges, "C" as Uuid).has("C" as Uuid)).toBe(false);
  });
});

describe("detectCycle", () => {
  it("returns null for an acyclic graph", () => {
    expect(detectCycle([edge("A", "B"), edge("B", "C")])).toBeNull();
  });

  it("finds a direct cycle", () => {
    const cycle = detectCycle([edge("A", "B"), edge("B", "A")]);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(["A", "B"]));
  });

  it("finds an indirect cycle and formats a readable path", () => {
    const cycle = detectCycle([edge("A", "B"), edge("B", "C"), edge("C", "A")]);
    expect(cycle).not.toBeNull();
    expect(formatCyclePath(cycle!)).toMatch(/^[ABC] → [ABC] → [ABC] → [ABC]$/);
    // The path starts and ends on the same node.
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it("ignores disconnected acyclic components", () => {
    expect(detectCycle([edge("A", "B"), edge("X", "Y"), edge("Y", "Z")])).toBeNull();
  });
});

describe("wouldCreateCycle", () => {
  it("is true when the candidate edge closes a loop", () => {
    const edges = [edge("A", "B"), edge("B", "C")];
    expect(wouldCreateCycle(edges, edge("C", "A"))).toBe(true);
  });

  it("is false when the candidate edge keeps the graph acyclic", () => {
    const edges = [edge("A", "B"), edge("B", "C")];
    expect(wouldCreateCycle(edges, edge("D", "A"))).toBe(false);
  });

  it("is true for a self-referencing candidate", () => {
    expect(wouldCreateCycle([], edge("A", "A"))).toBe(true);
  });
});

describe("readySet", () => {
  it("excludes an item whose dependency is still in the active set", () => {
    const items = [makeItem("A"), makeItem("B")];
    const edges = [edge("A", "B")]; // A depends on B, and B is still active/open

    expect(readySet(items, edges).map((t) => t.id)).toEqual(["B"]);
  });

  it("includes an item once its dependency is no longer in the active set (i.e. terminal)", () => {
    // Only A is passed as "active" — B has already left the active set.
    const items = [makeItem("A")];
    const edges = [edge("A", "B")];

    expect(readySet(items, edges).map((t) => t.id)).toEqual(["A"]);
  });

  it("includes items with no dependencies at all", () => {
    const items = [makeItem("A"), makeItem("B")];
    expect(readySet(items, []).map((t) => t.id).sort()).toEqual(["A", "B"]);
  });

  it("excludes an item with multiple deps until all of them clear the active set", () => {
    const items = [makeItem("A"), makeItem("B"), makeItem("C")];
    const edges = [edge("A", "B"), edge("A", "C")];

    // B and C are both still active, so A isn't ready; B and C have no
    // deps of their own, so they are.
    expect(readySet(items, edges).map((t) => t.id).sort()).toEqual(["B", "C"]);
  });
});

describe("topoOrder", () => {
  it("orders a simple chain correctly", () => {
    const items = [makeItem("A"), makeItem("B"), makeItem("C")];
    const edges = [edge("A", "B"), edge("B", "C")]; // A needs B, B needs C

    expect(topoOrder(items, edges).map((t) => t.id)).toEqual(["C", "B", "A"]);
  });

  it("throws for a cyclic graph rather than returning a bogus order", () => {
    const items = [makeItem("A"), makeItem("B")];
    const edges = [edge("A", "B"), edge("B", "A")];

    expect(() => topoOrder(items, edges)).toThrow(/cycle/i);
  });

  it("property: for 200 random acyclic DAGs, no item is ever placed before its dependency", () => {
    const rng = mulberry32(42);

    for (let trial = 0; trial < 200; trial++) {
      const nodeCount = 2 + Math.floor(rng() * 15);
      const { items, edges } = randomAcyclicDag(rng, nodeCount, 0.3);

      const order = topoOrder(items, edges);
      expect(order).toHaveLength(items.length);

      const position = new Map(order.map((item, index) => [item.id, index]));
      for (const e of edges) {
        expect(position.get(e.dependsOnId)).toBeLessThan(position.get(e.itemId)!);
      }
    }
  });
});

describe("deriveDepsFromTouches", () => {
  it("proposes a dependency for stories with overlapping touches, later depends on earlier", () => {
    const stories = [{ touches: ["src/a.ts"] }, { touches: ["src/a.ts", "src/b.ts"] }, { touches: ["src/c.ts"] }];

    expect(deriveDepsFromTouches(stories)).toEqual([{ storyIndex: 1, dependsOnIndex: 0 }]);
  });

  it("counts a directory and a file inside it as the same collision", () => {
    // The bug this replaces: `includes` compared strings, so `src/` and
    // `src/router.js` — plainly the same place — did not overlap, and
    // the check almost never fired.
    const stories = [{ touches: ["src/"] }, { touches: ["src/router.js"] }];

    expect(deriveDepsFromTouches(stories)).toEqual([{ storyIndex: 1, dependsOnIndex: 0 }]);
  });

  it("treats ./src and src as the same place", () => {
    expect(deriveDepsFromTouches([{ touches: ["./src/a.ts"] }, { touches: ["src/a.ts"] }])).toEqual([{ storyIndex: 1, dependsOnIndex: 0 }]);
  });

  it("does not let a shared prefix inside a name count as an overlap", () => {
    // `src/a` and `src/abc` are different files. A prefix only counts at
    // a path boundary, or every neighbouring name collides.
    expect(deriveDepsFromTouches([{ touches: ["src/a"] }, { touches: ["src/abc"] }])).toEqual([]);
  });

  it("proposes nothing when no touches overlap", () => {
    const stories = [{ touches: ["src/a.ts"] }, { touches: ["src/b.ts"] }];
    expect(deriveDepsFromTouches(stories)).toEqual([]);
  });

  it("proposes an edge for every overlapping pair when three stories share a file", () => {
    const stories = [{ touches: ["shared.ts"] }, { touches: ["shared.ts"] }, { touches: ["shared.ts"] }];

    expect(deriveDepsFromTouches(stories)).toEqual([
      { storyIndex: 1, dependsOnIndex: 0 },
      { storyIndex: 2, dependsOnIndex: 0 },
      { storyIndex: 2, dependsOnIndex: 1 },
    ]);
  });
});

// Deterministic PRNG (mulberry32) so the property test above is
// reproducible across runs instead of relying on true randomness.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Edges only ever point from a higher index to a lower one — guaranteed acyclic. */
function randomAcyclicDag(rng: () => number, nodeCount: number, edgeProbability: number): { items: Item[]; edges: Edge[] } {
  const items = Array.from({ length: nodeCount }, (_, i) => makeItem(`T${i}`));
  const edges: Edge[] = [];

  for (let i = 0; i < nodeCount; i++) {
    for (let j = 0; j < i; j++) {
      if (rng() < edgeProbability) {
        edges.push(edge(items[i]!.id, items[j]!.id));
      }
    }
  }

  return { items, edges };
}
