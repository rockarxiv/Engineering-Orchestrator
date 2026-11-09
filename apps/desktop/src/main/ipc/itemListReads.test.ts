import type { Item, Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addDependency,
  createAgent,
  createStep,
  getItemWatch,
  latestRunForItem,
  listItems,
  listItemWatchesOnCurrentSteps,
  listRunsForItem,
  listTransitionsForItem,
  createRun,
  projectForWorkspace,
  setItemArchived,
  startItemWatch,
  stepEntryTransitionIds,
  transitionItem,
  updateRun,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { listItemSummaries } from "./domainQueries.js";

/**
 * What `items:list` reads, and that reading it once rather than per
 * card left the answer as it was (EO-556).
 *
 * The repository barrel is wrapped rather than replaced, so every module
 * reading through it — this one and `roles/featureLifecycle.ts` — is
 * counted and still answered by the in-memory database.
 */
vi.mock("../db/repos/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/repos/index.js")>();
  return {
    ...actual,
    listItems: vi.fn(actual.listItems),
    listRunsForItem: vi.fn(actual.listRunsForItem),
    latestRunForItem: vi.fn(actual.latestRunForItem),
    getItemWatch: vi.fn(actual.getItemWatch),
    listTransitionsForItem: vi.fn(actual.listTransitionsForItem),
    listItemWatchesOnCurrentSteps: vi.fn(actual.listItemWatchesOnCurrentSteps),
    stepEntryTransitionIds: vi.fn(actual.stepEntryTransitionIds),
  };
});

const here = dirname(fileURLToPath(import.meta.url));

let handle: DbHandle;
let projectId: Uuid;
let workspaceId: Uuid;

beforeEach(() => {
  handle = openMigratedTestDb();
  workspaceId = attachWorkspace(handle.db, { name: "app", keyPrefix: "APP", repoPath: "/tmp/app" }).id;
  projectId = projectForWorkspace(handle.db, workspaceId)!.id;
  vi.clearAllMocks();
});

afterEach(() => {
  handle.close();
});

function item(title: string, stepId: string | null, extra: { type?: string; parentId?: Uuid; projectId?: Uuid; workspaceId?: Uuid } = {}): Item {
  return createTestItem(handle.db, {
    type: extra.type ?? "story",
    title,
    stepId,
    projectId: extra.projectId ?? projectId,
    workspaceId: extra.workspaceId ?? workspaceId,
    parentId: extra.parentId ?? null,
  });
}

function finish(row: Item): void {
  transitionItem(handle.db, { itemId: row.id, toStepId: "ready_to_merge", actor: "human" });
}

/**
 * A board with one of each thing a card's answer turns on: features with
 * no stories, some and all of them done; dependencies on a feature, on
 * finished and open work, on archived work, on another project's and on
 * an item that is gone; and runs that tie on when they started.
 */
function seed() {
  const otherWorkspace = attachWorkspace(handle.db, { name: "other", keyPrefix: "OTH", repoPath: "/tmp/other" }).id;
  const otherProject = projectForWorkspace(handle.db, otherWorkspace)!.id;
  const implementer = createAgent(handle.db, { name: "Implementer", role: "implementer", provider: "fake", instructions: "Do the work." });
  const reviewer = createAgent(handle.db, { name: "Reviewer", role: "reviewer", provider: "fake", instructions: "Read the work." });

  const halfway = item("Import pipeline", null, { type: "feature" });
  const limit = item("Rate limit the import", "todo", { parentId: halfway.id });
  const retry = item("Retry the import", "todo", { parentId: halfway.id });
  finish(limit);

  const shipped = item("Export pipeline", null, { type: "feature" });
  const exporter = item("Write the exporter", "todo", { parentId: shipped.id });
  finish(exporter);

  item("Search", null, { type: "feature" });

  const crash = item("Crash on save", "review", { type: "bug" });
  const archivedDone = item("Old finished work", "todo");
  finish(archivedDone);
  setItemArchived(handle.db, archivedDone.id, Date.now());
  const archivedOpen = item("Old abandoned work", "todo");
  setItemArchived(handle.db, archivedOpen.id, Date.now());
  const elsewhere = item("Their work", "todo", { projectId: otherProject, workspaceId: otherWorkspace });

  const waiting = item("Ship the importer", "todo");
  for (const dependency of [halfway, shipped, limit, retry, crash, archivedDone, archivedOpen, elsewhere]) addDependency(handle.db, waiting.id, dependency.id);
  // An edge naming an item that is not there — what a deleted dependency
  // looked like before deletion took its edges with it.
  handle.db.run(sql`pragma foreign_keys = off`);
  handle.db.run(sql`insert into item_deps (item_id, depends_on_id) values (${retry.id}, ${"019a0000-0000-7000-8000-000000000000"})`);
  handle.db.run(sql`pragma foreign_keys = on`);
  addDependency(handle.db, crash.id, retry.id);

  // Two runs starting in the same millisecond, and one not started yet:
  // the larger id names the card.
  const queued = createRun(handle.db, { itemId: waiting.id, agentId: implementer.id, action: "implement", status: "queued" });
  const first = createRun(handle.db, { itemId: waiting.id, agentId: implementer.id, action: "implement", status: "failed" });
  const second = createRun(handle.db, { itemId: waiting.id, agentId: reviewer.id, action: "review", status: "running" });
  updateRun(handle.db, first.id, { startedAt: 1_000 });
  updateRun(handle.db, second.id, { startedAt: 1_000 });
  void queued;
  // EO acting itself.
  createRun(handle.db, { itemId: crash.id, agentId: null, action: "create_worktree", status: "succeeded" });
  const older = createRun(handle.db, { itemId: retry.id, agentId: reviewer.id, action: "review", status: "succeeded" });
  const newer = createRun(handle.db, { itemId: retry.id, agentId: implementer.id, action: "implement", status: "failed" });
  updateRun(handle.db, older.id, { startedAt: 2_000 });
  updateRun(handle.db, newer.id, { startedAt: 3_000 });
  return { halfway };
}

/**
 * The answer with what differs between two runs of the same fixture
 * taken out: ids are named by what they are, times by being times.
 */
function stable(answer: ReturnType<typeof listItemSummaries>): string {
  const names = new Map<string, string>([
    [projectId, "<project>"],
    [workspaceId, "<workspace>"],
  ]);
  for (const row of answer.items) names.set(row.id, `<item ${row.key}>`);
  let others = 0;
  const text = JSON.stringify(
    answer,
    (key, value: unknown) => ((key === "updatedAt" || key === "heldAt" || key === "stepEnteredAt") && typeof value === "number" ? "<time>" : value),
    2,
  );
  return text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!names.has(id)) names.set(id, `<id ${(others += 1)}>`);
    return names.get(id)!;
  });
}

describe("items:list, read once per call", () => {
  it("answers a board exactly as it did before its reads were batched", async () => {
    seed();

    await expect(stable(listItemSummaries(handle.db, projectId)) + "\n").toMatchFileSnapshot(join(here, "__snapshots__", "itemListReads.board.json"));
    // Narrowed to the features, whose stories are then read on their own.
    await expect(stable(listItemSummaries(handle.db, projectId, { type: "feature" })) + "\n").toMatchFileSnapshot(join(here, "__snapshots__", "itemListReads.features.json"));
  });

  it("reads every item once, however many features the board and its dependencies hold", () => {
    const { halfway } = seed();
    // More features, each with a story, and one waiting on all of them.
    const waiting = item("Release", "todo");
    for (let n = 0; n < 10; n += 1) {
      const feature = item(`Feature ${n}`, null, { type: "feature" });
      item(`Story ${n}`, "todo", { parentId: feature.id });
      addDependency(handle.db, waiting.id, feature.id);
    }
    addDependency(handle.db, waiting.id, halfway.id);
    vi.mocked(listItems).mockClear();

    const answer = listItemSummaries(handle.db, projectId);

    expect(answer.items.find((row) => row.id === waiting.id)?.openDependencyCount).toBe(11);
    expect(answer.items.filter((row) => row.stepId === null).length).toBeGreaterThan(10);
    expect(vi.mocked(listItems)).toHaveBeenCalledTimes(1);

    // Narrowed as well: the features alone, whose stories are read apart.
    vi.mocked(listItems).mockClear();
    listItemSummaries(handle.db, projectId, { type: "feature" });
    expect(vi.mocked(listItems)).toHaveBeenCalledTimes(1);
  });

  it("does not read every item when no feature is listed or depended on", () => {
    const first = item("First", "todo");
    addDependency(handle.db, item("Second", "todo").id, first.id);
    vi.mocked(listItems).mockClear();

    listItemSummaries(handle.db, projectId);

    expect(vi.mocked(listItems)).not.toHaveBeenCalled();
  });

  it("reads each card's latest run as one row, not its whole history", () => {
    seed();
    vi.mocked(listRunsForItem).mockClear();
    vi.mocked(latestRunForItem).mockClear();

    const answer = listItemSummaries(handle.db, projectId);

    expect(vi.mocked(listRunsForItem)).not.toHaveBeenCalled();
    expect(vi.mocked(latestRunForItem)).toHaveBeenCalledTimes(answer.items.length);
  });

  it("reads the watches on a board's steps once, however many cards are watching (EO-699)", () => {
    seed();
    createStep(handle.db, { id: "wait", pipelineId: "default" as Uuid, position: 15, name: "Wait", type: "builtin", entryAction: "create_worktree", watch: { everyMinutes: 1440, giveUpAfterHours: 168 } });
    const watching = Array.from({ length: 5 }, (_, n) => {
      const row = item(`Watch ${n}`, "todo");
      transitionItem(handle.db, { itemId: row.id, toStepId: "wait", actor: "engine" });
      const stay = listTransitionsForItem(handle.db, row.id).at(-1)!.id;
      startItemWatch(handle.db, { itemId: row.id, stepId: "wait", initiationId: stay, startedAt: 1_000 });
      return row;
    });
    for (const spy of [getItemWatch, listTransitionsForItem, listItemWatchesOnCurrentSteps, stepEntryTransitionIds]) vi.mocked(spy).mockClear();

    const answer = listItemSummaries(handle.db, projectId);

    for (const row of watching) expect(answer.items.find((entry) => entry.id === row.id)?.watch).toMatchObject({ stepId: "wait", nextCheckAt: 1_000 });
    expect(answer.items.filter((entry) => entry.watch == null)).toHaveLength(answer.items.length - watching.length);
    expect(vi.mocked(listItemWatchesOnCurrentSteps)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stepEntryTransitionIds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getItemWatch)).not.toHaveBeenCalled();
    expect(vi.mocked(listTransitionsForItem)).not.toHaveBeenCalled();
  });
});
