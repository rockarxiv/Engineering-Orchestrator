import type { Item, Uuid } from "@eo/core";
import { describe, expect, it } from "vitest";
import { archivableItems, type ArchiveCandidate } from "./archive.js";


/** Any `item_types` row: these fixtures never read the type's row, only the word on it. */
const STORY_TYPE_ID = "0199aa00-0000-7000-8000-000000000001" as Uuid;
/**
 * When finished work leaves the project (KAN-33).
 *
 * The rule is worth testing without a database, which is why it is
 * here: `packages/engine` may not touch one (invariant 2), so the
 * caller reads the rows, this decides, the caller writes.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const TERMINAL = new Set(["ready_to_merge"]);

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
    stepId: "ready_to_merge",
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

function candidate(id: string, daysAgo: number | null, overrides: Partial<Item> = {}): ArchiveCandidate {
  const item = makeItem(id, overrides);
  // Decided here, as the caller decides it (EO-327): whether a step is
  // terminal is a property of the version an item entered on, so the
  // sweep answers it per item and hands the answer in. `TERMINAL` is
  // this fixture's stand-in for one version's terminal steps.
  return { item, terminalSince: daysAgo === null ? null : NOW - daysAgo * DAY, finished: item.stepId !== null && TERMINAL.has(item.stepId) };
}

function archivable(candidates: ArchiveCandidate[], delayDays = 14): string[] {
  return archivableItems({ candidates, delayMs: delayDays * DAY, now: NOW }).map((item) => item.id);
}

describe("archivableItems", () => {
  it("takes work that has been finished longer than the delay", () => {
    expect(archivable([candidate("old", 20)])).toEqual(["old"]);
  });

  it("leaves work that finished recently", () => {
    expect(archivable([candidate("fresh", 3)])).toEqual([]);
  });

  it("archives on the boundary, not a day later", () => {
    expect(archivable([candidate("exactly", 14)])).toEqual(["exactly"]);
  });

  it("never archives an unfinished item, however old", () => {
    // Age alone is not a reason. An item stuck in `blocked` for a
    // month is exactly the one someone needs to see, and hiding it
    // would turn tidying into losing work.
    const stale = [
      candidate("blocked", 90, { stepId: "blocked" }),
      candidate("forgotten", 400, { stepId: "todo" }),
      candidate("mid_review", 60, { stepId: "review" }),
    ];

    expect(archivable(stale)).toEqual([]);
  });

  it("archives immediately when the delay is zero", () => {
    expect(archivable([candidate("done", 0)], 0)).toEqual(["done"]);
  });

  it("says nothing about an item with no recorded transition", () => {
    // Seeded straight into a terminal state, or older than the audit.
    // There is no honest answer to "how long has this been done", and
    // guessing would archive work nobody has seen.
    expect(archivable([candidate("unknown", null)])).toEqual([]);
  });

  it("holds a feature back while a story under it is still live", () => {
    // A feature can be terminal while a story below it is not — a
    // rejected story reopens the work without reopening its parent.
    // Archiving the parent alone would leave the child on the project
    // with nothing above it.
    const tree = [
      candidate("feature", 30, { type: "feature" }),
      candidate("done_story", 30, { parentId: "feature" as Uuid }),
      candidate("live_story", 30, { parentId: "feature" as Uuid, stepId: "todo" }),
    ];

    expect(archivable(tree)).toEqual(["done_story"]);
  });

  it("holds it back for a story that is finished but not yet old enough", () => {
    // The subtree goes together. A child two days done is not archivable,
    // so its parent is not either — otherwise the feature disappears
    // twelve days before the story it contains.
    const tree = [
      candidate("feature", 30, { type: "feature" }),
      candidate("recent_story", 2, { parentId: "feature" as Uuid }),
    ];

    expect(archivable(tree)).toEqual([]);
  });

  it("takes the whole subtree once every part of it qualifies", () => {
    const tree = [
      candidate("feature", 30, { type: "feature" }),
      candidate("one", 20, { parentId: "feature" as Uuid }),
      candidate("two", 40, { parentId: "feature" as Uuid }),
    ];

    expect(new Set(archivable(tree))).toEqual(new Set(["feature", "one", "two"]));
  });

  it("does not let one feature's live story hold back another's", () => {
    const tree = [
      candidate("quiet", 30, { type: "feature" }),
      candidate("quiet_story", 30, { parentId: "quiet" as Uuid }),
      candidate("busy", 30, { type: "feature" }),
      candidate("busy_story", 30, { parentId: "busy" as Uuid, stepId: "todo" }),
    ];

    expect(new Set(archivable(tree))).toEqual(new Set(["quiet", "quiet_story"]));
  });

  it("handles an empty project", () => {
    expect(archivable([])).toEqual([]);
  });
});
/**
 * Two items on the same step, disagreeing about whether they are
 * finished (EO-327, ARCHITECTURE.md, "Publish, lock and versions").
 *
 * The reason `finished` is per candidate rather than a `terminalStepIds`
 * set for the whole sweep. Whether a step is terminal is a property of a
 * *version*: an item that entered before a save marked its step terminal
 * has more to do, and an item that finished on a step a later save
 * unmarked is still done. A single set could only ever have told them
 * the same thing — and the wrong answer here puts live work in the
 * Archive.
 */
describe("finished, per item rather than per step", () => {
  const onStep = (id: string, finished: boolean): ArchiveCandidate => ({
    item: makeItem(id, { stepId: "review" }),
    terminalSince: NOW - 40 * DAY,
    finished,
  });

  it("takes the one whose own version calls its step terminal, and leaves the one whose version does not", () => {
    expect(archivable([onStep("entered_after", true), onStep("entered_before", false)])).toEqual(["entered_after"]);
  });

  it("holds a feature open on a story its own version has not finished, whatever the step says", () => {
    expect(
      archivable([
        { item: makeItem("feature", { type: "feature", stepId: null }), terminalSince: null, finished: false },
        { ...onStep("mid_flight", false), item: makeItem("mid_flight", { stepId: "review", parentId: "feature" as Uuid }) },
      ]),
    ).toEqual([]);
  });
});

describe("a feature, which is off the pipeline entirely (§6.2)", () => {
  // Every test above calls a container a "feature" by its `type` while
  // leaving it on a step, so `archivableItems` takes the ordinary
  // item branch for all of them. The branch that actually decides a
  // feature's fate — no step at all, judged by the stories under it —
  // had never been executed. Mutation testing found it: every operator
  // in that block could be inverted with the suite still green.
  const feature = (overrides: Partial<Item> = {}) =>
    ({ item: makeItem("feature", { type: "feature", stepId: null, ...overrides }), terminalSince: null, finished: false }) satisfies ArchiveCandidate;

  it("goes with its stories once the last of them is old enough", () => {
    expect(
      archivable([feature(), candidate("old", 40, { parentId: "feature" as Uuid }), candidate("newest", 20, { parentId: "feature" as Uuid })]),
    ).toEqual(["feature", "old", "newest"]);
  });

  it("waits while any story under it is too recent, however old the rest are", () => {
    // Note what enforces this, because the name it used to carry — "is
    // dated by its newest story, not its oldest" — claimed more than the
    // test can show. Both orderings of the clock give this same answer:
    // `recent` is not eligible on its own, so the parent is held by the
    // live-child rule before its own clock is ever consulted. The
    // max-versus-min distinction is unobservable here and is pinned where
    // it is visible instead — `sweep.test.ts`, on the number the archive
    // note reports.
    expect(archivable([feature(), candidate("old", 40, { parentId: "feature" as Uuid }), candidate("recent", 2, { parentId: "feature" as Uuid })])).toEqual([
      "old",
    ]);
  });

  it("is never taken while it has no stories at all", () => {
    // No stories is no evidence it is done — a plan nobody approved has
    // not started, rather than finished.
    expect(archivable([feature()])).toEqual([]);
  });

  it("is not taken while a story under it is still being worked", () => {
    expect(archivable([feature(), candidate("done", 40, { parentId: "feature" as Uuid }), candidate("live", 40, { parentId: "feature" as Uuid, stepId: "todo" })])).toEqual(
      ["done"],
    );
  });

  it("is not taken when a story has no recorded finish time", () => {
    // Null is "there is no honest answer to how long", and a feature
    // cannot be older than a story whose age nobody knows.
    //
    // Same caveat as above: a story with no finish time is not eligible
    // either, so the live-child rule reaches this first and the feature's
    // own null-handling is not what the assertion proves. It is the
    // outcome that is worth fixing in place, not the route to it.
    expect(archivable([feature(), candidate("known", 40, { parentId: "feature" as Uuid }), candidate("unknown", null, { parentId: "feature" as Uuid })])).toEqual([
      "known",
    ]);
  });
});
