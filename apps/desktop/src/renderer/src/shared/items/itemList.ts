import { matchesItemFilter, type ItemSummary, type ViewFilter } from "@eo/core";

export interface Filters {
  type: string;
  /** Which container's work to show, by parent id — `all`, or `__none__` for the unparented. */
  parent: string;
  pipeline: string;
  step: string;
  repository: string;
  status: string;
  /** Only what has an open mention waiting on you (invariant #6 — derived, never stored). */
  attention: boolean;
}

/**
 * This screen's filter in the shape that crosses IPC (EO-192).
 *
 * The help widget's agent can ask what is on screen, and the answer has
 * to be *these rows* — resolved from the database by the main process,
 * never a count this component sent. So the filter is published as
 * identifiers and the matching is `matchesItemFilter`, in `@eo/core`,
 * asked by both sides. `ITEM_FACETS` names the keys, and
 * `ItemList.test.tsx` checks this object against it: a dropdown added
 * here and not there would quietly widen what the agent is told the
 * person can see.
 */
export function itemViewFilter(filters: Filters, query: string): ViewFilter {
  return {
    text: query,
    facets: {
      type: filters.type,
      parent: filters.parent,
      pipeline: filters.pipeline,
      step: filters.step,
      repository: filters.repository,
      status: filters.status,
      attention: filters.attention ? "true" : "false",
    },
  };
}

/**
 * Whether a row survives the filter.
 *
 * The predicate itself is one function over in `@eo/core`, shared with
 * the handler that answers "what is this person looking at". Two copies
 * is how an agent comes to be told about seven items while six are on
 * screen.
 */
export function matchesFilters(item: ItemSummary, filters: Filters, needle: string): boolean {
  return matchesItemFilter(item, itemViewFilter(filters, needle));
}
