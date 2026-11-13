import type { Uuid } from "@eo/core";
import { dispatchBlocker } from "@eo/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  gateArrivals,
  listAllDependencies,
  listCommentsForItem,
  projectForWorkspace,
  transitionItem,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "../ipc/domainQueries.js";
import { buildEligibilityInput, namedBlocker } from "./buildTickInput.js";
import { watchDependencyRegressions } from "./dependencyGates.js";
import { gateWords, resumeOutlook, type ItemBlocker } from "./dispatchBlockers.js";

/**
 * A dependency edge's wait rule, on a real database (EO-776): the host
 * works out from `transitions` where each gated dependency has arrived,
 * the scheduler and the board read the rule the same way, the blocker
 * names what it waits for, and a dependency going back after it released
 * its dependent is said on the dependent, once.
 *
 * The seeded Delivery pipeline: Worktree → Index → To Do → Review →
 * Merge Request → Watching pull request → Done.
 */
let handle: DbHandle;
let projectId: Uuid;
let workspaceId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  projectId = projectForWorkspace(handle.db, workspaceId)!.id;
});

afterEach(() => {
  handle.close();
});

const story = (title: string, stepId: string) => createTestItem(handle.db, { type: "story", title, stepId, projectId, workspaceId });
const move = (itemId: Uuid, toStepId: string) => transitionItem(handle.db, { itemId, toStepId, actor: "human" });
const blockerOf = (itemId: Uuid): ItemBlocker | null => namedBlocker(handle.db, dispatchBlocker(buildEligibilityInput(handle.db, false), itemId));
const openDepsFor = (id: Uuid): number | undefined => listItemSummaries(handle.db, projectId).items.find((entry) => entry.id === id)?.openDependencyCount;
const engineComments = (itemId: Uuid) => listCommentsForItem(handle.db, itemId).filter((comment) => comment.authorType === "engine");

describe("where a gated dependency has arrived", () => {
  it("counts an arrival at the gate step that was left and came back to, once, and nothing else", () => {
    const dependency = story("Goes first", "worktree");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, dependency.id, { wait: "reached", stepId: "review" });
    const arrivals = () => gateArrivals(handle.db, listAllDependencies(handle.db));

    expect(arrivals().get(dependency.id)).toBeUndefined();
    move(dependency.id, "todo");
    expect(arrivals().get(dependency.id)).toBeUndefined();
    move(dependency.id, "review");
    expect([...(arrivals().get(dependency.id) ?? [])]).toEqual(["review"]);
    // Left it: still arrived, because arriving is what happened, not where it is.
    move(dependency.id, "todo");
    expect([...(arrivals().get(dependency.id) ?? [])]).toEqual(["review"]);
    // And came back: the same one arrival, not two.
    move(dependency.id, "review");
    move(dependency.id, "merge_request");
    expect([...(arrivals().get(dependency.id) ?? [])]).toEqual(["review"]);
  });

  it("asks only about `reached` edges, and counts an item made on the gate step as there", () => {
    const madeThere = story("Made on Review", "review");
    const finishedEdgeTarget = story("Finished edge", "review");
    const noneEdgeTarget = story("None edge", "review");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, madeThere.id, { wait: "reached", stepId: "review" });
    addDependency(handle.db, waiting.id, finishedEdgeTarget.id);
    addDependency(handle.db, waiting.id, noneEdgeTarget.id, { wait: "none" });

    const arrivals = gateArrivals(handle.db, listAllDependencies(handle.db));
    expect([...arrivals.keys()]).toEqual([madeThere.id]);
  });

  it("keeps an item made on the gate step arrived after it leaves, so the edge stays released", () => {
    const madeThere = story("Made on Review", "review");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, madeThere.id, { wait: "reached", stepId: "review" });
    expect(blockerOf(waiting.id)?.kind).not.toBe("open_dependency");

    // Its only transition is Review → To Do: no row arrives at Review.
    move(madeThere.id, "todo");
    expect([...(gateArrivals(handle.db, listAllDependencies(handle.db)).get(madeThere.id) ?? [])]).toEqual(["review"]);
    expect(blockerOf(waiting.id)?.kind).not.toBe("open_dependency");
    expect(openDepsFor(waiting.id)).toBe(0);
  });
});

describe("the scheduler, the board and the blocker, read from the database", () => {
  it("holds on a `reached` edge until the dependency gets there, names it while it does, and stays released after it goes back", () => {
    const dependency = story("Goes first", "worktree");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, dependency.id, { wait: "reached", stepId: "review" });
    move(dependency.id, "todo");

    const held = blockerOf(waiting.id);
    expect(held).toMatchObject({ kind: "open_dependency", dependsOnId: dependency.id, wait: "reached", waitStepId: "review" });
    expect(held?.kind === "open_dependency" ? gateWords(held) : null).toBe(`Waits for ${dependency.key} to reach Review (now at To Do)`);
    expect(resumeOutlook("To Do", held)).toContain(`it waits for ${dependency.key} to reach Review (now at To Do)`);
    expect(openDepsFor(waiting.id)).toBe(1);

    move(dependency.id, "review");
    move(dependency.id, "todo");
    expect(blockerOf(waiting.id)?.kind).not.toBe("open_dependency");
    expect(openDepsFor(waiting.id)).toBe(0);
  });

  it("keeps today's words for a `finished` edge", () => {
    const dependency = story("Goes first", "review");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, dependency.id);

    const held = blockerOf(waiting.id);
    expect(held).toMatchObject({ kind: "open_dependency", wait: "finished", waitStepId: null, dependencyKey: dependency.key });
    expect(held?.kind === "open_dependency" ? gateWords(held) : "words").toBeNull();
    expect(resumeOutlook("To Do", held)).toBe(
      'Nothing will pick it up from "To Do" yet, though: this ticket is waiting on another that has not finished. Finish that ticket, or remove the dependency.',
    );
  });

  it("never holds on a `none` edge, and the board does not count it", () => {
    const dependency = story("Elsewhere", "todo");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, dependency.id, { wait: "none" });

    expect(blockerOf(waiting.id)?.kind).not.toBe("open_dependency");
    expect(openDepsFor(waiting.id)).toBe(0);
  });
});

describe("a dependency going back after it released its dependent", () => {
  let stop: () => void;
  beforeEach(() => {
    stop = watchDependencyRegressions(handle.db);
  });
  afterEach(() => stop());

  it("posts one comment on each unfinished dependent, naming the dependency and the step, and holds nothing again", () => {
    const dependency = story("Goes first", "worktree");
    const waiting = story("Waits", "todo");
    const alsoWaiting = story("Also waits", "todo");
    const done = story("Already done", "ready_to_merge");
    const unGated = story("Waits for it to finish", "todo");
    for (const dependent of [waiting, alsoWaiting, done]) addDependency(handle.db, dependent.id, dependency.id, { wait: "reached", stepId: "review" });
    addDependency(handle.db, unGated.id, dependency.id);

    move(dependency.id, "todo");
    move(dependency.id, "review");
    // On to a step it had not been on before the gate: carrying on, not going back.
    move(dependency.id, "merge_request");
    for (const dependent of [waiting, alsoWaiting, done, unGated]) expect(engineComments(dependent.id)).toEqual([]);
    const before = blockerOf(waiting.id);

    move(dependency.id, "todo");

    for (const dependent of [waiting, alsoWaiting]) {
      const said = engineComments(dependent.id);
      expect(said).toHaveLength(1);
      expect(said[0]!.body).toContain(dependency.key);
      expect(said[0]!.body).toContain('"To Do"');
    }
    // Finished, or not released by a gate: nothing to say to it.
    expect(engineComments(done.id)).toEqual([]);
    expect(engineComments(unGated.id)).toEqual([]);
    // Its eligibility is what it was before the dependency went back.
    expect(blockerOf(waiting.id)).toEqual(before);
    expect(before?.kind).not.toBe("open_dependency");
  });

  it("says nothing about moves before the gate was first reached", () => {
    const dependency = story("Goes first", "todo");
    const waiting = story("Waits", "todo");
    addDependency(handle.db, waiting.id, dependency.id, { wait: "reached", stepId: "review" });

    move(dependency.id, "worktree");
    move(dependency.id, "todo");
    expect(engineComments(waiting.id)).toEqual([]);
  });
});
