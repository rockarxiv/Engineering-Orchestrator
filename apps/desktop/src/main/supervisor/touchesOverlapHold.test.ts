import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { GIT_WORKTREE_KIND, NO_WORKSPACE, uuidv7, type Item, type Uuid, type WorkspaceKindSlug } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  createRun,
  createStep,
  dispatchOf,
  getItem,
  listAllDependencies,
  listCommentsForItem,
  listDispatches,
  listRunsForItem,
  needsAttention,
  postComment,
  setItemHeld,
  transitionItem,
  updateStep,
} from "../db/repos/index.js";
import { createPipelineVersion, ensureCurrentVersion, getPipelineVersion, prunePipelineVersions } from "../db/repos/pipelineVersionsRepo.js";
import { addWorkspaceToProject } from "../db/repos/projectsRepo.js";
import { createWorkspace } from "../db/repos/workspacesRepo.js";
import { planVersionMove, writeVersionMove } from "../record/versionMove.js";
import { pipelineSteps } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { startTestWriteBridge } from "../testing/agentWrites.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import type { BuiltinRunner } from "./builtins.js";
import { dispatchedPlaces, type DispatchedPlaces } from "./buildTickInput.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import type { WorkspaceKind } from "./workspaceKind.js";
import { workspaceFor } from "./workspaceResolution.js";

/**
 * Two items filed apart that declare the same files (EO-912), as the
 * supervisor carries the hold out: the one not yet started waits while
 * the other is in flight, the thread says which item and which path
 * once (invariant #8), the card says it too, no dependency row is
 * written, and the held item goes by itself once the other finishes.
 *
 * On the seeded Delivery: the holder has been reviewed — a run of
 * `review` at `review` — and is parked there by a person, so it stays in
 * flight without running again; the held item stands on `merge_request`,
 * a builtin step, so its dispatch needs no backend.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 5 };

let handle: DbHandle;
let holder: Item;
let held: Item;
let openPullRequest: ReturnType<typeof vi.fn<BuiltinRunner>>;

function supervisor(capacityKeyOf: (item: Item) => string | null = () => "one-repository"): RunSupervisor {
  return supervisorWith(installedKinds(fakeWorkspaceKind({ capacityKeyOf })));
}

function supervisorWith(kinds: ReadonlyMap<WorkspaceKindSlug, WorkspaceKind>): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
    limits: LIMITS,
    kinds,
    builtins: { open_pull_request: openPullRequest },
  });
}

/** Where each item is in flight, as the tick reads it, under the one-bucket kind most of these tests use. */
function dispatchedSteps(...items: Item[]): DispatchedPlaces {
  return dispatchedPlaces(handle.db, items.map((item) => getItem(handle.db, item.id)!), () => "one-repository");
}

/** Where an item is proven in flight, and where it is only claimed to be, under the git kind's own bucket. */
function placesOf(...items: Item[]): DispatchedPlaces {
  return dispatchedPlaces(handle.db, items.map((item) => getItem(handle.db, item.id)!), (item) => workspaceFor(handle.db, item)?.id ?? null);
}

/** Places proven, none claimed. */
const proven = (...entries: [string, string[]][]): DispatchedPlaces => ({
  dispatchedIn: new Map(entries.map(([id, places]) => [id, new Set(places)])),
  claimedIn: new Map(),
});

function cardLine(): string | null | undefined {
  return listItemSummaries(handle.db, held.projectId).items.find((item) => item.id === held.id)?.dispatchHold;
}

function holdNotes(): string[] {
  return listCommentsForItem(handle.db, held.id)
    .filter((comment) => comment.authorType === "engine" && comment.body.startsWith("Holding"))
    .map((comment) => comment.body);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  openPullRequest = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "opened", detail: "Opened" }));
  holder = createTestItem(handle.db, {
    type: "story",
    title: "Holder",
    stepId: "review",
    spec: { touches: ["packages/core/src/ipc.ts", "packages/core/src/schemas/assistCard.ts"] },
  });
  createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", status: "succeeded", threadId: "thread-1" });
  setItemHeld(handle.db, holder.id, 1);
  held = createTestItem(handle.db, { type: "story", title: "Held", stepId: "merge_request", spec: { touches: ["packages/core/src/ipc.ts"] } });
});

afterEach(() => {
  handle.close();
});

describe("an item whose touches overlap an item in flight", () => {
  it("is not dispatched, the thread and the card say which item and path, and no dependency is written", async () => {
    // The holder's run carries no stamp, so where it worked is a claim: one that holds others back.
    expect(dispatchedSteps(holder, held)).toEqual({ dispatchedIn: new Map(), claimedIn: new Map([[holder.id, new Set(["one-repository"])]]) });
    const engine = supervisor();
    await engine.runOnce();
    await engine.runOnce();

    expect(openPullRequest).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, held.id)).toEqual([]);
    expect(holdNotes()).toEqual([
      `Holding "Merge Request": ${holder.key} is already under way and also changes packages/core/src/ipc.ts, so this waits rather than collide with it. ` +
        `Nothing to do: it starts by itself once ${holder.key} finishes. If it will not change that path after all, take it out of this ticket's touches.`,
    ]);
    expect(needsAttention(handle.db, held.id)).toBe(false);
    expect(listAllDependencies(handle.db)).toEqual([]);
    expect(engine.dispatchBlockerFor(held.id)).toEqual({
      kind: "touches_overlap",
      holderId: holder.id,
      holderKey: holder.key,
      path: "packages/core/src/ipc.ts",
      holderPath: "packages/core/src/ipc.ts",
    });

    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
    expect(getItemDetail(handle.db, { itemId: held.id })?.item.dispatchHold).toBe(cardLine());
  });

  it("is dispatched on the next tick once the holder finishes, and the card stops saying it", async () => {
    const engine = supervisor();
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();

    transitionItem(handle.db, { itemId: holder.id, toStepId: "ready_to_merge", actor: "human" });
    expect(cardLine()).toBeNull();
    await engine.runOnce();

    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(holdNotes()).toHaveLength(1);
    // And its run keeps where it was dispatched, from the moment it was made.
    expect(listDispatches(handle.db, [held.id]).get(held.id)).toEqual([{ stepId: "merge_request", action: "open_pull_request", dispatchedIn: ["one-repository"], basis: "stamped" }]);
  });

  it("is not held by an item in another bucket, however alike the paths", async () => {
    const engine = supervisor((item) => (item.id === holder.id ? "api" : "web"));
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(holdNotes()).toEqual([]);
  });
});

describe("what counts as dispatched", () => {
  it("is a run of the step's own action, not a reply on the item or a guard's placeholder", () => {
    const talkedTo = createTestItem(handle.db, { type: "story", title: "Talked to", stepId: "todo" });
    createRun(handle.db, { itemId: talkedTo.id, agentId: null, action: "respond", stepId: "todo", status: "succeeded", threadId: "thread-2" });
    const refused = createTestItem(handle.db, { type: "story", title: "Refused", stepId: "review" });
    createRun(handle.db, { itemId: refused.id, agentId: null, action: "review", stepId: "review", status: "awaiting_input" });
    expect(dispatchedSteps(holder, held, talkedTo, refused)).toEqual({ dispatchedIn: new Map(), claimedIn: new Map([[holder.id, new Set(["one-repository"])]]) });
  });

  it("is where the run says it was dispatched, whatever is done to the step's definition afterwards", async () => {
    createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", dispatchedIn: ["one-repository"], status: "succeeded", threadId: "thread-1" });
    ensureCurrentVersion(handle.db, "default");
    handle.db.update(pipelineSteps).set({ entryAction: "review_again" }).where(eq(pipelineSteps.id, "review")).run();
    createPipelineVersion(handle.db, "default");
    handle.db.update(pipelineSteps).set({ entryAction: "review_once_more" }).where(eq(pipelineSteps.id, "review")).run();
    expect(dispatchedSteps(holder).dispatchedIn.get(holder.id)).toEqual(new Set(["one-repository"]));

    await supervisor().runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("is judged, for a run with no stamp and no basis, by the step's action as the item's own version defines it", async () => {
    // The holder's run in `beforeEach` has no stamp — a run from another machine, say. It entered on the
    // version in force; a later publish changes the step's action, and
    // the holder stays on the version it entered on.
    ensureCurrentVersion(handle.db, "default");
    const entered = getItem(handle.db, holder.id)?.pipelineVersionId;
    expect(entered).not.toBeNull();
    handle.db.update(pipelineSteps).set({ entryAction: "review_again" }).where(eq(pipelineSteps.id, "review")).run();
    createPipelineVersion(handle.db, "default");
    expect(getItem(handle.db, holder.id)?.pipelineVersionId).toBe(entered);
    expect(dispatchedSteps(holder).claimedIn.get(holder.id)).toEqual(new Set(["one-repository"]));

    await supervisor().runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });
});

/**
 * Where an item is in flight is where it worked, not where it stands
 * (EO-912): on a repository attached the way the app attaches one, with
 * the git kind's own bucket — the workspace the step resolves to — and
 * EO's own `none` kind for a step that says "no disk".
 */
describe("in flight where it worked", () => {
  let repository: Uuid;
  const repositoryKinds = () =>
    new Map<WorkspaceKindSlug, WorkspaceKind>([[GIT_WORKTREE_KIND, fakeWorkspaceKind({ capacityKeyOf: (item) => workspaceFor(handle.db, item)?.id ?? null })]]);

  beforeEach(() => {
    handle.close();
    handle = openMigratedTestDb();
    const workspace = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo", repoPath: "/tmp/eo/eo" });
    repository = workspace.id;
    const projectId = workspace.projectId!;
    holder = createTestItem(handle.db, {
      type: "story",
      title: "Holder",
      projectId,
      workspaceId: repository,
      stepId: "review",
      spec: { touches: ["packages/core/src/ipc.ts"] },
    });
    createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", dispatchedIn: [repository], status: "succeeded", threadId: "thread-1" });
    held = createTestItem(handle.db, { type: "story", title: "Held", projectId, workspaceId: repository, stepId: "merge_request", spec: { touches: ["packages/core/src/ipc.ts"] } });
  });

  it("keeps holding while the holder stands on a step that works on no disk, since its changes are still in the repository", async () => {
    updateStep(handle.db, "pull_request_watch", { workspaceId: NO_WORKSPACE });
    transitionItem(handle.db, { itemId: holder.id, toStepId: "pull_request_watch", actor: "human" });
    setItemHeld(handle.db, holder.id, 1);
    const moved = getItem(handle.db, holder.id)!;
    expect(workspaceFor(handle.db, moved)).toBeUndefined();
    expect(placesOf(moved)).toEqual(proven([holder.id, [repository]]));

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("does not let a run on no disk count as started: the item is still held where it would change files", async () => {
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "builtin", entryAction: "draft", workspaceId: NO_WORKSPACE });
    createRun(handle.db, { itemId: held.id, agentId: null, action: "draft", stepId: "draft", dispatchedIn: [], status: "succeeded" });
    expect(listDispatches(handle.db, [held.id]).get(held.id)).toEqual([{ stepId: "draft", action: "draft", dispatchedIn: [], basis: "stamped" }]);
    expect(placesOf(held)).toEqual(proven());
    // And one with no stamp reads the same, by the item's own definition of the step.
    createRun(handle.db, { itemId: held.id, agentId: null, action: "draft", stepId: "draft", status: "succeeded" });
    expect(placesOf(held)).toEqual(proven());
    setItemHeld(handle.db, holder.id, 1);

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
  });

  it("keeps holding after the holder is moved to a version whose step works on no disk: it worked in the repository under the one before", async () => {
    // Under the version it entered on, `review` worked in the repository.
    const entered = ensureCurrentVersion(handle.db, "default");
    expect(getItem(handle.db, holder.id)?.pipelineVersionId).toBe(entered?.id);
    // A later version says `review` works on no disk, and a person moves the holder onto it.
    updateStep(handle.db, "review", { workspaceId: NO_WORKSPACE });
    const later = createPipelineVersion(handle.db, "default");
    const plan = planVersionMove(handle.db, getItem(handle.db, holder.id)!, later.number);
    if (!plan.ok) throw new Error(plan.problem);
    writeVersionMove(handle.db, { item: getItem(handle.db, holder.id)!, move: plan, by: "you", note: "" });
    setItemHeld(handle.db, holder.id, 1);
    const moved = getItem(handle.db, holder.id)!;
    expect(moved.pipelineVersionId).toBe(later.id);
    expect(workspaceFor(handle.db, moved)).toBeUndefined();
    expect(placesOf(moved)).toEqual(proven([holder.id, [repository]]));

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("holds an item under way in one repository as it enters another where an overlapping item is under way", async () => {
    // A second repository on the same project. The holder reviewed in it;
    // the held item implemented in the first, and now stands on a step
    // that works in the second.
    const second = createWorkspace(handle.db, { config: { name: "web", repoPath: "/tmp/eo/web" } });
    addWorkspaceToProject(handle.db, held.projectId!, second.id);
    updateStep(handle.db, "review", { workspaceId: second.id });
    updateStep(handle.db, "merge_request", { workspaceId: second.id });
    createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", dispatchedIn: [second.id], status: "succeeded", threadId: "thread-2" });
    createRun(handle.db, { itemId: held.id, agentId: null, action: "implement", stepId: "todo", dispatchedIn: [repository], status: "succeeded", threadId: "thread-3" });
    setItemHeld(handle.db, holder.id, 1);
    expect(placesOf(holder, held)).toEqual(proven([holder.id, [repository, second.id]], [held.id, [repository]]));

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);

    // And it goes once the holder finishes.
    transitionItem(handle.db, { itemId: holder.id, toStepId: "ready_to_merge", actor: "human" });
    await engine.runOnce();
    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps holding after the version the holder worked under is pruned: the run says where it worked, not the version", async () => {
    const entered = ensureCurrentVersion(handle.db, "default")!;
    updateStep(handle.db, "review", { workspaceId: NO_WORKSPACE });
    const later = createPipelineVersion(handle.db, "default");
    for (const item of [holder, held]) {
      const plan = planVersionMove(handle.db, getItem(handle.db, item.id)!, later.number);
      if (!plan.ok) throw new Error(plan.problem);
      writeVersionMove(handle.db, { item: getItem(handle.db, item.id)!, move: plan, by: "you", note: "" });
    }
    expect(prunePipelineVersions(handle.db, "default", 1)).toContain(entered.number);
    expect(getPipelineVersion(handle.db, entered.id)).toBeUndefined();
    setItemHeld(handle.db, holder.id, 1);
    expect(placesOf(holder)).toEqual(proven([holder.id, [repository]]));

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
  });

  /**
   * The reviewer's case: an item reviewed only in the first repository
   * under the version it entered on is moved to a version whose `review`
   * works in the second, without reviewing again. Where it worked is the
   * first repository alone — so it is held as it enters the second beside
   * an overlapping item under way there, and it holds nothing there itself.
   */
  describe("after a move to a version whose step works in another repository", () => {
    let second: Uuid;
    let other: Item;

    beforeEach(() => {
      ensureCurrentVersion(handle.db, "default");
      second = createWorkspace(handle.db, { config: { name: "web", repoPath: "/tmp/eo/web" } }).id;
      addWorkspaceToProject(handle.db, held.projectId!, second);
      // `held` was reviewed in the first repository under the version it entered on.
      createRun(handle.db, { itemId: held.id, agentId: null, action: "review", stepId: "review", dispatchedIn: [repository], status: "succeeded", threadId: "thread-4" });
      updateStep(handle.db, "review", { workspaceId: second });
      updateStep(handle.db, "merge_request", { workspaceId: second });
      const later = createPipelineVersion(handle.db, "default");
      const plan = planVersionMove(handle.db, getItem(handle.db, held.id)!, later.number);
      if (!plan.ok) throw new Error(plan.problem);
      writeVersionMove(handle.db, { item: getItem(handle.db, held.id)!, move: plan, by: "you", note: "" });
      // The first holder is finished; another item is under way in the second repository.
      transitionItem(handle.db, { itemId: holder.id, toStepId: "ready_to_merge", actor: "human" });
      other = createTestItem(handle.db, {
        type: "story",
        title: "Other",
        projectId: held.projectId!,
        workspaceId: repository,
        stepId: "review",
        spec: { touches: ["packages/core/src/ipc.ts"] },
      });
      createRun(handle.db, { itemId: other.id, agentId: null, action: "review", stepId: "review", dispatchedIn: [second], status: "succeeded", threadId: "thread-5" });
      setItemHeld(handle.db, other.id, 1);
    });

    it("is held as it first enters the other repository, rather than exempt there by a definition it never ran under", async () => {
      expect(placesOf(held)).toEqual(proven([held.id, [repository]]));
      const engine = supervisorWith(repositoryKinds());
      await engine.runOnce();
      expect(openPullRequest).not.toHaveBeenCalled();
      expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: other.id });
    });

    it("holds nothing in the other repository, where it never worked", async () => {
      // `held` is parked, still in flight; `other` finished, and a newcomer enters the second repository.
      transitionItem(handle.db, { itemId: other.id, toStepId: "ready_to_merge", actor: "human" });
      const newcomer = createTestItem(handle.db, {
        type: "story",
        title: "Newcomer",
        projectId: held.projectId!,
        workspaceId: repository,
        stepId: "merge_request",
        spec: { touches: ["packages/core/src/ipc.ts"] },
      });
      setItemHeld(handle.db, held.id, 1);
      const engine = supervisorWith(repositoryKinds());
      expect(engine.dispatchBlockerFor(newcomer.id)).not.toMatchObject({ kind: "touches_overlap" });
      await engine.runOnce();
      expect(listRunsForItem(handle.db, newcomer.id).map((run) => run.action)).toContain("open_pull_request");
    });
  });
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

/**
 * Runs from before the stamp (EO-912, migration 0185), as an upgraded
 * installation has them: written by a launch that had no
 * `dispatched_in`, then migrated. Read once as the supervisor starts —
 * by the item's own definition of the step as it stands then — and kept
 * as read, so a later move to another version cannot read them again
 * differently; and only ever a claim, which holds others back but lets
 * nobody past.
 */
describe("runs from before the stamp", () => {
  let repository: Uuid;
  let second: Uuid;
  let tempDir: string;
  const repositoryKinds = () =>
    new Map<WorkspaceKindSlug, WorkspaceKind>([[GIT_WORKTREE_KIND, fakeWorkspaceKind({ capacityKeyOf: (item) => workspaceFor(handle.db, item)?.id ?? null })]]);

  /** A run as a launch before 0185 wrote it: no column for where it worked. */
  function oldRun(itemId: string, stepId: string, action: string): string {
    const id = uuidv7();
    handle.db.run(sql`INSERT INTO runs (id, item_id, agent_id, action, step_id, status, thread_id) VALUES (${id}, ${itemId}, NULL, ${action}, ${stepId}, 'succeeded', 'thread-old')`);
    return id;
  }

  beforeEach(() => {
    handle.close();
    handle = openDb(":memory:");
    // Every migration before 0185, and nothing after.
    tempDir = mkdtempSync(join(tmpdir(), "eo-dispatched-in-"));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const kept = journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag.startsWith("0185_")));
    mkdirSync(join(tempDir, "meta"), { recursive: true });
    writeFileSync(join(tempDir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: kept }));
    for (const entry of kept) writeFileSync(join(tempDir, `${entry.tag}.sql`), readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), "utf8"));
    runMigrations(handle.db, tempDir);

    const workspace = attachWorkspace(handle.db, { keyPrefix: "EO", name: "eo", repoPath: "/tmp/eo/eo" });
    repository = workspace.id;
    const projectId = workspace.projectId!;
    second = createWorkspace(handle.db, { config: { name: "web", repoPath: "/tmp/eo/web" } }).id;
    addWorkspaceToProject(handle.db, projectId, second);
    holder = createTestItem(handle.db, { type: "story", title: "Holder", projectId, workspaceId: repository, stepId: "review", spec: { touches: ["packages/core/src/ipc.ts"] } });
    held = createTestItem(handle.db, { type: "story", title: "Held", projectId, workspaceId: repository, stepId: "merge_request", spec: { touches: ["packages/core/src/ipc.ts"] } });
    oldRun(holder.id, "review", "review");
    // Both entered on the version in force before the upgrade.
    ensureCurrentVersion(handle.db, "default");

    runMigrations(handle.db, MIGRATIONS);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function moveHolderTo(workspaceId: string): void {
    updateStep(handle.db, "review", { workspaceId });
    const later = createPipelineVersion(handle.db, "default");
    const plan = planVersionMove(handle.db, getItem(handle.db, holder.id)!, later.number);
    if (!plan.ok) throw new Error(plan.problem);
    writeVersionMove(handle.db, { item: getItem(handle.db, holder.id)!, move: plan, by: "you", note: "" });
    setItemHeld(handle.db, holder.id, 1);
  }

  it("are marked by the migration, and read once as the supervisor starts, into a claim where the step worked then", () => {
    expect(listDispatches(handle.db, [holder.id]).get(holder.id)).toEqual([{ stepId: "review", action: "review", dispatchedIn: null, basis: "legacy" }]);
    supervisorWith(repositoryKinds());
    expect(listDispatches(handle.db, [holder.id]).get(holder.id)).toEqual([{ stepId: "review", action: "review", dispatchedIn: [repository], basis: "inferred" }]);
    expect(placesOf(holder)).toEqual({ dispatchedIn: new Map(), claimedIn: new Map([[holder.id, new Set([repository])]]) });
  });

  it("keep holding after the holder is moved to a version whose step works on no disk", async () => {
    const engine = supervisorWith(repositoryKinds());
    moveHolderTo(NO_WORKSPACE);
    expect(workspaceFor(handle.db, getItem(handle.db, holder.id)!)).toBeUndefined();
    expect(placesOf(holder).claimedIn.get(holder.id)).toEqual(new Set([repository]));

    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("keep holding where the holder worked after it is moved to a version whose step works in another repository, and hold nothing there", async () => {
    const engine = supervisorWith(repositoryKinds());
    moveHolderTo(second);
    expect(workspaceFor(handle.db, getItem(handle.db, holder.id)!)?.id).toBe(second);
    expect(placesOf(holder).claimedIn.get(holder.id)).toEqual(new Set([repository]));
    // A newcomer working in the other repository, where the holder never worked.
    updateStep(handle.db, "merge_request", { workspaceId: second });
    const newcomer = createTestItem(handle.db, { type: "story", title: "Newcomer", projectId: held.projectId!, workspaceId: repository, stepId: "pull_request_watch", spec: { touches: ["packages/core/src/ipc.ts"] } });
    updateStep(handle.db, "pull_request_watch", { workspaceId: second });
    expect(engine.dispatchBlockerFor(newcomer.id)).not.toMatchObject({ kind: "touches_overlap" });
    // `held` still works in the first repository, by the version it is bound to.
    expect(workspaceFor(handle.db, getItem(handle.db, held.id)!)?.id).toBe(repository);

    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
  });

  it("do not let their own item past: one only believed to be under way somewhere waits there beside one proven under way", async () => {
    // `held` implemented in the repository before the upgrade; `other` has since been reviewed there, stamped.
    oldRun(held.id, "todo", "implement");
    transitionItem(handle.db, { itemId: holder.id, toStepId: "ready_to_merge", actor: "human" });
    const engine = supervisorWith(repositoryKinds());
    const other = createTestItem(handle.db, { type: "story", title: "Other", projectId: held.projectId!, workspaceId: repository, stepId: "review", spec: { touches: ["packages/core/src/ipc.ts"] } });
    createRun(handle.db, { itemId: other.id, agentId: null, action: "review", stepId: "review", dispatchedIn: [repository], status: "succeeded", threadId: "thread-5" });
    setItemHeld(handle.db, other.id, 1);
    expect(placesOf(held, other)).toEqual({ dispatchedIn: new Map([[other.id, new Set([repository])]]), claimedIn: new Map([[held.id, new Set([repository])]]) });

    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: other.id });
  });
});

/**
 * A run carried on works where the run it continues did (EO-912): its
 * `cwd` is that run's, so where it was dispatched is that run's too,
 * not wherever the item's step points by the time it is carried on.
 */
describe("a continuation", () => {
  let bucket: string;
  const movableKinds = () => installedKinds(fakeWorkspaceKind({ capacityKeyOf: () => bucket }));

  beforeEach(() => {
    bucket = "first";
  });

  it("after a restart keeps where the interrupted run was dispatched", async () => {
    const implementer = handle.db.get<{ id: string }>(sql`SELECT id FROM agents WHERE role = 'implementer' LIMIT 1`)!.id as Uuid;
    const item = createTestItem(handle.db, { type: "story", title: "Interrupted", stepId: "todo", spec: { touches: ["src"] } });
    const interrupted = createRun(handle.db, { itemId: item.id, agentId: implementer, action: "implement", stepId: "todo", dispatchedIn: ["first"], status: "running", threadId: "thr_crashed", cwd: "/tmp/eo/first" });
    bucket = "second";
    await createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }), limits: LIMITS, kinds: movableKinds() }).reconcile();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const continuation = listRunsForItem(handle.db, item.id).find((run) => run.id !== interrupted.id)!;
    expect(continuation.cwd).toBe("/tmp/eo/first");
    expect(dispatchOf(handle.db, continuation.id)).toEqual({ dispatchedIn: ["first"], dispatchBasis: "stamped" });
  });

  it("after a reply keeps where the parked run was dispatched", async () => {
    const writes = await startTestWriteBridge();
    try {
      const provider = createFakeProvider({
        steps: [{ toolCall: { name: "comment", args: { body: "@user proceed?", mentions: ["user"], blocking: true } } }],
        result: validImplementResult,
      });
      const engine = createRunSupervisor({ db: handle.db, provider, limits: LIMITS, kinds: movableKinds(), agentWriteBridge: writes.agentWriteBridge });
      writes.serve(engine);
      const item = createTestItem(handle.db, { type: "story", title: "Parked", stepId: "todo", spec: { ...REVIEWABLE_SPEC, touches: ["src"] } });
      await engine.runOnce();
      const [parked] = listRunsForItem(handle.db, item.id);
      expect(parked?.status).toBe("awaiting_input");
      expect(dispatchOf(handle.db, parked!.id)).toEqual({ dispatchedIn: ["first"], dispatchBasis: "stamped" });

      // The item's step now works somewhere else; the reply carries the parked run on where it was.
      bucket = "second";
      postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Proceed." });
      await engine.resumeItem(item.id);

      const resumed = listRunsForItem(handle.db, item.id).find((run) => run.id !== parked!.id)!;
      expect(resumed.cwd).toBe(parked!.cwd);
      expect(dispatchOf(handle.db, resumed.id)).toEqual({ dispatchedIn: ["first"], dispatchBasis: "stamped" });
      expect(listDispatches(handle.db, [item.id]).get(item.id)?.map((run) => run.dispatchedIn)).toEqual([["first"]]);
      engine.stop();
    } finally {
      await writes.close();
    }
  });
});
