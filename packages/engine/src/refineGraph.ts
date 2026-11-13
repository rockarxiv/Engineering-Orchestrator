import type { Uuid } from "@eo/core";
import { detectCycle, formatCyclePath, type Edge } from "./dag.js";

export type RefineGraphResult = { ok: true } | { ok: false; error: string };

/**
 * One proposed child, as far as the graph is concerned: something with
 * a name and a list of indices into its siblings.
 *
 * Structural rather than the pack's own shape (KAN-147). A decomposition
 * produces children of whatever types the project has, and this half of
 * checking one — does index 3 exist, does anything depend on itself,
 * does the whole thing have a cycle — is the same question whether they
 * are stories or cases.
 */
export interface GraphChild {
  title: string;
  /**
   * A bare index, or an entry naming one with the rule it waits by
   * (EO-777). The rule is no business of the graph's: every edge counts
   * towards a cycle, whatever it waits for.
   */
  depends_on: readonly (number | { readonly story: number })[];
}

function indexOf(entry: number | { readonly story: number }): number {
  return typeof entry === "number" ? entry : entry.story;
}

/**
 * Post-validation for a decomposition, past what a schema can express
 * (ARCHITECTURE.md, "What it proposes, and what a person approves", A-02).
 *
 * The schema proves each `depends_on` entry is a non-negative integer.
 * It cannot prove the index points at a child that exists, that a child
 * doesn't depend on itself, or that the whole graph is acyclic — those
 * are relationships between array elements. All three must hold
 * *before* any item is created, because a cyclic or dangling graph
 * would either deadlock the scheduler or fail halfway through insertion
 * and leave the DAG half-built.
 */
export function validateRefineGraph(children: readonly GraphChild[]): RefineGraphResult {
  const problems: string[] = [];

  children.forEach((child, index) => {
    for (const dependsOnIndex of child.depends_on.map(indexOf)) {
      if (dependsOnIndex >= children.length) {
        problems.push(
          `children[${index}] ("${child.title}") depends_on index ${dependsOnIndex}, but there ` +
            `${children.length === 1 ? "is only 1 child" : `are only ${children.length} children`} (valid indices: 0-${children.length - 1}).`,
        );
      } else if (dependsOnIndex === index) {
        problems.push(`children[${index}] ("${child.title}") depends on itself.`);
      }
    }
  });

  if (problems.length > 0) {
    return { ok: false, error: problems.map((problem) => `- ${problem}`).join("\n") };
  }

  // Indices are known valid now, so they can stand in as node ids.
  const edges: Edge[] = children.flatMap((child, index) =>
    child.depends_on.map(indexOf).map((dependsOnIndex) => ({ itemId: String(index) as Uuid, dependsOnId: String(dependsOnIndex) as Uuid })),
  );

  const cycle = detectCycle(edges);
  if (cycle) {
    const readable = cycle.map((id) => `children[${id}] ("${children[Number(id)]?.title ?? "?"}")`);
    return { ok: false, error: `- The dependencies form a cycle: ${formatCyclePath(readable as Uuid[])}` };
  }

  return { ok: true };
}
