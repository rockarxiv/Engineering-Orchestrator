import { describe, expect, it } from "vitest";
import type { EntryRule } from "./entryRules.js";
import { diffVersions, ghostColumnLabel, PipelineGraphSnapshotSchema, pipelineUpdatedBanner, versionLabel, type VersionRoute, type VersionStep } from "./pipelineVersions.js";

/**
 * What changed between two versions (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The rule the whole function answers to: **a version is an immutable
 * step and route set**, so anything a save can change about that set is
 * a change this has to report. A diff that compared less than the
 * document holds would answer "nothing changed" about a save that
 * changed something — which is worse than no diff at all, because
 * somebody would believe it.
 */
function step(overrides: Partial<VersionStep> = {}): VersionStep {
  return {
    id: "review",
    position: 1,
    name: "Review",
    type: "user",
    ownerRole: null,
    entryAction: null,
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    offBoard: false,
    results: [],
    watch: null,
    ...overrides,
  };
}

function route(overrides: Partial<VersionRoute> = {}): VersionRoute {
  return { fromStepId: "review", resultKey: "approved", label: "Approve", target: "done", tone: "success", position: 0, ...overrides };
}

const STEPS = [step(), step({ id: "done", position: 2, name: "Done", isTerminal: true })];

/** Two versions of one graph, differing only in the routes handed in. */
function between(from: VersionRoute[], to: VersionRoute[]) {
  return diffVersions({ number: 6, steps: STEPS, routes: from }, { number: 7, steps: STEPS, routes: to });
}

describe("the difference between two versions", () => {
  it("names the pair it is about", () => {
    expect(between([route()], [route()])).toMatchObject({ from: 6, to: 7 });
  });

  it("reports nothing about a route nobody touched", () => {
    expect(between([route()], [route()]).routes).toEqual([]);
  });

  /**
   * The edit this was rejected for missing: renaming the button on a
   * branch. It is the commonest route edit there is — the target is
   * untouched, and a diff that only compared targets said the save
   * changed nothing.
   */
  it("reports a label-only edit", () => {
    expect(between([route({ label: "Approve" })], [route({ label: "Ship it" })]).routes).toEqual([
      {
        fromStepName: "Review",
        resultKey: "approved",
        change: "changed",
        fields: [{ field: "label", before: "Approve", after: "Ship it" }],
      },
    ]);
  });

  it("reports a tone-only edit", () => {
    expect(between([route({ tone: "success" })], [route({ tone: "danger" })]).routes[0]?.fields).toEqual([
      { field: "tone", before: "success", after: "danger" },
    ]);
  });

  /** The order the results are offered in is a decision somebody made. */
  it("reports a position-only edit", () => {
    expect(between([route({ position: 0 })], [route({ position: 2 })]).routes[0]?.fields).toEqual([
      { field: "position", before: "0", after: "2" },
    ]);
  });

  it("reports where a route goes, by the step's name rather than its id", () => {
    expect(between([route({ target: "review" })], [route({ target: "done" })]).routes[0]?.fields).toEqual([
      { field: "target", before: "Review", after: "Done" },
    ]);
  });

  /** `terminal` and `user_attention` name no step, and read as themselves. */
  it("leaves a sentinel target as the word it is", () => {
    expect(between([route({ target: "done" })], [route({ target: "user_attention" })]).routes[0]?.fields).toEqual([
      { field: "target", before: "Done", after: "user_attention" },
    ]);
  });

  it("reports every field a single save changed, in one entry", () => {
    const changed = between([route()], [route({ target: "review", label: "Send back", tone: "warning", position: 1 })]).routes;

    expect(changed).toHaveLength(1);
    expect(changed[0]?.fields.map((field) => field.field)).toEqual(["target", "label", "tone", "position"]);
  });

  /**
   * An added route lists its fields too. "added" on its own does not say
   * where the new branch goes, which is the first thing anybody asks.
   */
  it("says what an added route is, not only that there is one", () => {
    const added = between([], [route()]).routes;

    expect(added[0]).toMatchObject({ change: "added", resultKey: "approved" });
    expect(added[0]?.fields).toEqual([
      { field: "target", before: null, after: "Done" },
      { field: "label", before: null, after: "Approve" },
      { field: "tone", before: null, after: "success" },
      { field: "position", before: null, after: "0" },
    ]);
  });

  it("says what a removed route was", () => {
    const removed = between([route()], []).routes;

    expect(removed[0]).toMatchObject({ change: "removed", fromStepName: "Review" });
    expect(removed[0]?.fields).toEqual([
      { field: "target", before: "Done", after: null },
      { field: "label", before: "Approve", after: null },
      { field: "tone", before: "success", after: null },
      { field: "position", before: "0", after: null },
    ]);
  });

  /**
   * A route is found by the step it leaves and the result it is for —
   * `step_routes` has a unique index on exactly that pair — so the same
   * key on two steps is two routes rather than one that moved.
   */
  it("tells two steps' routes for the same result apart", () => {
    const changed = between([route()], [route({ fromStepId: "done" })]).routes;

    expect(changed.map((entry) => [entry.fromStepName, entry.change])).toEqual([
      ["Done", "added"],
      ["Review", "removed"],
    ]);
  });

  it("reports a step's prompt changing, and says nothing about one that did not move", () => {
    const diff = diffVersions(
      { number: 6, steps: STEPS, routes: [] },
      { number: 7, steps: [step({ instructionsSummary: "Look again." }), STEPS[1]!], routes: [] },
    );

    expect(diff.steps).toEqual([
      { stepId: "review", name: "Review", change: "changed", fields: [{ field: "instructionsSummary", before: null, after: "Look again." }] },
    ]);
  });

  /**
   * Reordering the columns is a save somebody made deliberately, and it
   * produces a different immutable step set — so "View changes" saying
   * nothing about it would be "View changes" lying.
   */
  it("reports a step that only moved in the order", () => {
    const diff = diffVersions({ number: 6, steps: STEPS, routes: [] }, { number: 7, steps: [step({ position: 4 }), STEPS[1]!], routes: [] });

    expect(diff.steps).toEqual([{ stepId: "review", name: "Review", change: "changed", fields: [{ field: "position", before: "1", after: "4" }] }]);
  });

  /**
   * And the buttons a human step offers, which are executable: an item
   * finishing on an older version is offered *those*, so two versions
   * that accept different answers are not the same version.
   */
  it("reports a decision renamed, retoned or given a reason requirement", () => {
    const before = step({ results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }] });
    const after = step({ results: [{ key: "approved", label: "Ship it", tone: "warning", requiresComment: true }] });

    const diff = diffVersions({ number: 6, steps: [before], routes: [] }, { number: 7, steps: [after], routes: [] });

    expect(diff.steps[0]?.fields).toEqual([
      {
        field: "results",
        before: 'approved "Approve" (success)',
        after: 'approved "Ship it" (warning, reason required)',
      },
    ]);
  });

  it("reports a decision key replaced, which is the change an older item cannot take", () => {
    const before = step({ results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }] });
    const after = step({ results: [{ key: "shipped", label: "Approve", tone: "success", requiresComment: false }] });

    expect(diffVersions({ number: 6, steps: [before], routes: [] }, { number: 7, steps: [after], routes: [] }).steps[0]?.fields).toEqual([
      { field: "results", before: 'approved "Approve" (success)', after: 'shipped "Approve" (success)' },
    ]);
  });

  it("says a step that offered nothing now offers something, rather than printing an empty string", () => {
    const after = step({ results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }] });

    expect(diffVersions({ number: 6, steps: [step()], routes: [] }, { number: 7, steps: [after], routes: [] }).steps[0]?.fields).toEqual([
      { field: "results", before: "none", after: 'approved "Approve" (success)' },
    ]);
  });

  it("says nothing about a step whose decisions were left alone", () => {
    const declared = step({ results: [{ key: "approved", label: "Approve", tone: "success", requiresComment: false }] });

    expect(diffVersions({ number: 6, steps: [declared], routes: [] }, { number: 7, steps: [declared], routes: [] }).steps).toEqual([]);
  });

  it("reports a step set to keep checking, and the interval it checks on changing (EO-456)", () => {
    const once = step({ type: "builtin", entryAction: "check" });
    const watching = step({ type: "builtin", entryAction: "check", watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    const faster = step({ type: "builtin", entryAction: "check", watch: { everyMinutes: 1, giveUpAfterHours: 168 } });

    expect(diffVersions({ number: 6, steps: [once], routes: [] }, { number: 7, steps: [watching], routes: [] }).steps[0]?.fields).toEqual([
      { field: "watch", before: "runs once", after: "Checks every 5 minutes · gives up after 7 days" },
    ]);
    expect(diffVersions({ number: 7, steps: [watching], routes: [] }, { number: 8, steps: [faster], routes: [] }).steps[0]?.fields).toEqual([
      { field: "watch", before: "Checks every 5 minutes · gives up after 7 days", after: "Checks every 1 minute · gives up after 7 days" },
    ]);
  });

  it("reports a step set to never give up as never giving up, not as a time (EO-571)", () => {
    const week = step({ type: "builtin", entryAction: "check", watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    const never = step({ type: "builtin", entryAction: "check", watch: { everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true } });

    expect(diffVersions({ number: 7, steps: [week], routes: [] }, { number: 8, steps: [never], routes: [] }).steps[0]?.fields).toEqual([
      { field: "watch", before: "Checks every 5 minutes · gives up after 7 days", after: "Checks every 5 minutes · never gives up" },
    ]);
  });

  it("reports a step taken off the board, which stops it being a column", () => {
    expect(
      diffVersions({ number: 6, steps: [step()], routes: [] }, { number: 7, steps: [step({ offBoard: true })], routes: [] }).steps[0]?.fields,
    ).toEqual([{ field: "offBoard", before: "no", after: "yes" }]);
  });

  it("reports a step added and a step removed", () => {
    const diff = diffVersions({ number: 6, steps: [STEPS[0]!], routes: [] }, { number: 7, steps: [STEPS[1]!], routes: [] });

    expect(diff.steps).toEqual([
      { stepId: "done", name: "Done", change: "added", fields: [] },
      { stepId: "review", name: "Review", change: "removed", fields: [] },
    ]);
  });
});

describe("the words a version is written in", () => {
  it("writes a number the way every surface writes it", () => {
    expect(versionLabel(6)).toBe("v6");
  });

  it("drops the author when a version has none, rather than inventing one", () => {
    expect(pipelineUpdatedBanner({ current: 7, older: [{ number: 6, items: 3 }], by: null })).toBe("Pipeline updated to v7 · 3 items finish on v6");
  });

  it("says nothing about what is finishing when nothing is", () => {
    expect(pipelineUpdatedBanner({ current: 7, older: [], by: "Dana" })).toBe("Pipeline updated to v7 by Dana");
  });

  it("counts one item in the singular, and lists the newest older version first", () => {
    expect(
      pipelineUpdatedBanner({
        current: 8,
        older: [
          { number: 6, items: 1 },
          { number: 7, items: 2 },
        ],
        by: "Dana",
      }),
    ).toBe("Pipeline updated to v8 by Dana · 2 items finish on v7 · 1 item finishes on v6");
  });

  it("heads a ghost column with the step, the version it belongs to and what it holds", () => {
    expect(ghostColumnLabel({ stepName: "Review", number: 6, holding: 2 })).toBe("Review (v6) · 2 finishing");
  });
});

describe("a version's entry rules (EO-610)", () => {
  const side = (number: number, entryRules?: EntryRule[]) => ({ number, steps: [], routes: [], ...(entryRules === undefined ? {} : { entryRules }) });

  it("says nothing where they are the same, or where neither side has any", () => {
    expect(diffVersions(side(1), side(2)).entryRules).toBeNull();
    expect(diffVersions(side(1, [{ kind: "description" }]), side(2, [{ kind: "description" }])).entryRules).toBeNull();
  });

  it("lists the change in the words a refusal would use", () => {
    expect(diffVersions(side(1), side(2, [{ kind: "description" }, { kind: "field", field: "customer", types: ["developer:bug"] }])).entryRules).toEqual({
      before: "none",
      after: "a description, a Customer (developer:bug)",
    });
  });

  it("notices a rule that only changed the types it applies to", () => {
    const diff = diffVersions(side(1, [{ kind: "description" }]), side(2, [{ kind: "description", types: ["developer:bug"] }]));
    expect(diff.entryRules).toEqual({ before: "a description", after: "a description (developer:bug)" });
  });
});

describe("a document older than entry rules", () => {
  it("reads as a version that asks for nothing", () => {
    expect(PipelineGraphSnapshotSchema.parse({ steps: [], routes: [] }).entryRules).toEqual([]);
  });
});
