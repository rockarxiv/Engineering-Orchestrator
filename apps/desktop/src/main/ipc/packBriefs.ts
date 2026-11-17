import type { Item, ItemBriefPart, PipelineStep } from "@eo/core";

/**
 * What a pack is told about the decision it may brief (EO-828).
 *
 * The step the item stands on, and the one it came to it from, each with
 * what a pack recognises a step by: its id, the id the template it was
 * installed from gave it (an install re-mints every step id, so a pack
 * shipping `pr_comments_approve` finds it here rather than in `id`), and
 * the function or action the step runs.
 */
export interface DecisionBriefContext {
  item: Item;
  /** The step the item stands on, as the item's own version of the pipeline has it. */
  step: PipelineStep;
  /** The template's id for `step`, when its pipeline was made from one; null otherwise. */
  templateStepId: string | null;
  /**
   * The step the item came to this one from — the step whose result put
   * it here — or null where it was filed straight onto it.
   */
  cameFrom: {
    stepId: string;
    templateStepId: string | null;
    type: PipelineStep["type"] | null;
    /** The action or builtin the step runs (`review_plan`, `watch_pull_request`), or null for a step that runs none. */
    action: string | null;
  } | null;
}

/**
 * A brief a pack computes for a decision it knows (EO-828, ARCHITECTURE.md,
 * "The decision's brief").
 *
 * The third of the brief's layers, beside the default and the one a step
 * declares as data: for what has to be worked out rather than read off the
 * thread — a pull request comment beside the reply planned for it, the
 * state of the pull request a step closes. Code a pack contributes, like
 * its section renderers, and like them it closes over the database it was
 * composed with.
 *
 * `render` answers null for a decision that is not its own, and the next
 * renderer is asked; with none answering, the item gets the default. A
 * step that declares its own brief is never put to a renderer at all: what
 * a person chose for the step wins over what a pack would compute.
 */
export interface DecisionBriefRenderer {
  /** How the renderer is named in a collision between two packs, and in a brief that failed. */
  id: string;
  render: (context: DecisionBriefContext) => readonly ItemBriefPart[] | null | Promise<readonly ItemBriefPart[] | null>;
}

/**
 * The brief renderers the installed packs contribute, in pack order.
 *
 * A module-level value with a setter, for `packConnectors`' reason: the
 * reader is the `items:brief` handler, which has no engine in hand. Empty
 * by default — with no pack folded nothing computes a brief, and every
 * decision gets the default or what its step declares (invariant 13).
 */
let current: readonly DecisionBriefRenderer[] = [];

/** Installed once, by the composition root, from the packs it folded. */
export function usePackBriefs(next: readonly DecisionBriefRenderer[]): void {
  current = next;
}

/** What the installed packs contribute. A function, so a reader imported before the fold sees what the fold installed. */
export function packBriefs(): readonly DecisionBriefRenderer[] {
  return current;
}
