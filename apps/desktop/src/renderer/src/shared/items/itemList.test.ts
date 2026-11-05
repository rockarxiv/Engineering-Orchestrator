import type { ItemSummary } from "@eo/core";
import { describe, expect, it } from "vitest";
import { NO_GIT_STATE, matchesItemFilter, ITEM_FACETS } from "@eo/core";
import { matchesFilters, itemViewFilter } from "./itemList";

function item(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "t1",
    key: "EO-1",
    type: "story",
    typeLabel: "Story",
    container: false,
    parentId: null,
    parentKey: null,
    parentTitle: null,
    repositoryId: "r1",
    repositoryName: "api",
    projectId: "p1",
    title: "Rate limit the API",
    pipelineId: "pipe-1",
    stepId: "step-impl",
    pipelineVersion: null,
    stepName: "Implementer",
    progress: null,
    priority: 0,
    git: NO_GIT_STATE,
    workspace: { kind: "git-worktree", mode: "isolated", label: null },
    jiraKey: null,
    jiraUrl: null,
    updatedAt: 1_700_000_000_000,
    stepEnteredAt: 1_700_000_000_000,
    heldAt: null,
    origin: null,
    needsAttention: false,
    atTerminalStep: false,
    openDependencyCount: 0,
    latestRunStatus: null,
    assigneeName: null,
    assigneePerson: null,
    claimable: false,
    preview: false,
    ...overrides,
  };
}

/**
 * What this screen shows and what the agent is told it shows (EO-192).
 *
 * `view:current` answers with the rows the filter matches, resolved in
 * the main process. That is only honest while the main process and this
 * screen agree about what the filter means — so the predicate is shared,
 * and the two things that could still drift are checked here: the set of
 * facets, and the translation into them.
 */
describe("publishing what the list is showing", () => {
  it("names every facet the shared predicate knows, and no others", () => {
    // A dropdown added to this screen and not to `ITEM_FACETS` would
    // be silently ignored by the handler, which would then report more
    // rows than are on screen. This is what makes that a build failure.
    const published = Object.keys(
      itemViewFilter({ type: "all", parent: "all", pipeline: "all", step: "all", repository: "all", status: "all", attention: false }, "").facets,
    );

    expect(published.sort()).toEqual([...ITEM_FACETS].sort());
  });

  it("carries the filter as typed, and the toggle as a value the predicate reads", () => {
    const filter = itemViewFilter(
      { type: "bug", parent: "all", pipeline: "all", step: "Review", repository: "all", status: "running", attention: true },
      "  Rate ",
    );

    expect(filter.text).toBe("  Rate ");
    expect(filter.facets["type"]).toBe("bug");
    expect(filter.facets["step"]).toBe("Review");
    expect(filter.facets["attention"]).toBe("true");
  });

  it("decides the same rows the screen does, because it is the same predicate", () => {
    const row = item({ title: "Rate limit the API", type: "bug", needsAttention: true });
    const filters = { type: "bug", parent: "all", pipeline: "all", step: "all", repository: "all", status: "all", attention: true };

    expect(matchesFilters(row, filters, "rate")).toBe(true);
    expect(matchesItemFilter(row, itemViewFilter(filters, "rate"))).toBe(true);
    expect(matchesItemFilter(item({ type: "story" }), itemViewFilter(filters, "rate"))).toBe(false);
  });
});
