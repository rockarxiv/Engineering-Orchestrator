import { eq } from "drizzle-orm";
import { GIT_WORKTREE_KIND, NO_WORKSPACE, type Item, type Uuid, type WorkspaceKindSlug } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  createRun,
  createStep,
  getItem,
  listAllDependencies,
  listCommentsForItem,
  listDispatches,
  listRunsForItem,
  needsAttention,
  setItemHeld,
  transitionItem,
  updateStep,
} from "../db/repos/index.js";
import { createPipelineVersion, ensureCurrentVersion, getPipelineVersion, prunePipelineVersions } from "../db/repos/pipelineVersionsRepo.js";
import { addWorkspaceToProject } from "../db/repos/projectsRepo.js";
import { createWorkspace } from "../db/repos/workspacesRepo.js";
import { planVersionMove, writeVersionMove } from "../record/versionMove.js";
import { pipelineSteps } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import type { BuiltinRunner } from "./builtins.js";
import { dispatchedPlaces } from "./buildTickInput.js";
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
function dispatchedSteps(...items: Item[]): Map<string, Set<string>> {
  return dispatchedPlaces(handle.db, items.map((item) => getItem(handle.db, item.id)!), () => "one-repository");
}

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
    expect(dispatchedSteps(holder, held)).toEqual(new Map([[holder.id, new Set(["one-repository"])]]));
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
    expect(listDispatches(handle.db, [held.id]).get(held.id)).toEqual([{ stepId: "merge_request", action: "open_pull_request", dispatchedIn: ["one-repository"] }]);
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
    expect(dispatchedSteps(holder, held, talkedTo, refused)).toEqual(new Map([[holder.id, new Set(["one-repository"])]]));
  });

  it("is where the run says it was dispatched, whatever is done to the step's definition afterwards", async () => {
    createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", dispatchedIn: ["one-repository"], status: "succeeded", threadId: "thread-1" });
    ensureCurrentVersion(handle.db, "default");
    handle.db.update(pipelineSteps).set({ entryAction: "review_again" }).where(eq(pipelineSteps.id, "review")).run();
    createPipelineVersion(handle.db, "default");
    handle.db.update(pipelineSteps).set({ entryAction: "review_once_more" }).where(eq(pipelineSteps.id, "review")).run();
    expect(dispatchedSteps(holder).get(holder.id)).toEqual(new Set(["one-repository"]));

    await supervisor().runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("is judged, for a run from before the stamp, by the step's action as the item's own version defines it", async () => {
    // The holder's run in `beforeEach` has no stamp. It entered on the
    // version in force; a later publish changes the step's action, and
    // the holder stays on the version it entered on.
    ensureCurrentVersion(handle.db, "default");
    const entered = getItem(handle.db, holder.id)?.pipelineVersionId;
    expect(entered).not.toBeNull();
    handle.db.update(pipelineSteps).set({ entryAction: "review_again" }).where(eq(pipelineSteps.id, "review")).run();
    createPipelineVersion(handle.db, "default");
    expect(getItem(handle.db, holder.id)?.pipelineVersionId).toBe(entered);
    expect(dispatchedSteps(holder).get(holder.id)).toEqual(new Set(["one-repository"]));

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
    expect(dispatchedPlaces(handle.db, [moved], (item) => workspaceFor(handle.db, item)?.id ?? null)).toEqual(new Map([[holder.id, new Set([repository])]]));

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
    expect(cardLine()).toBe(`Waits for ${holder.key}, which also changes packages/core/src/ipc.ts`);
  });

  it("does not let a run on no disk count as started: the item is still held where it would change files", async () => {
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "builtin", entryAction: "draft", workspaceId: NO_WORKSPACE });
    createRun(handle.db, { itemId: held.id, agentId: null, action: "draft", stepId: "draft", dispatchedIn: [], status: "succeeded" });
    expect(listDispatches(handle.db, [held.id]).get(held.id)).toEqual([{ stepId: "draft", action: "draft", dispatchedIn: [] }]);
    expect(dispatchedPlaces(handle.db, [held], (item) => workspaceFor(handle.db, item)?.id ?? null).has(held.id)).toBe(false);
    // And one from before the stamp reads the same, by the item's own definition of the step.
    createRun(handle.db, { itemId: held.id, agentId: null, action: "draft", stepId: "draft", status: "succeeded" });
    expect(dispatchedPlaces(handle.db, [held], (item) => workspaceFor(handle.db, item)?.id ?? null).has(held.id)).toBe(false);
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
    expect(dispatchedPlaces(handle.db, [moved], (item) => workspaceFor(handle.db, item)?.id ?? null)).toEqual(new Map([[holder.id, new Set([repository])]]));

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
    const places = dispatchedPlaces(handle.db, [getItem(handle.db, holder.id)!, getItem(handle.db, held.id)!], (item) => workspaceFor(handle.db, item)?.id ?? null);
    expect(places).toEqual(new Map([[holder.id, new Set([repository, second.id])], [held.id, new Set([repository])]]));

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
    expect(dispatchedPlaces(handle.db, [getItem(handle.db, holder.id)!], (item) => workspaceFor(handle.db, item)?.id ?? null)).toEqual(new Map([[holder.id, new Set([repository])]]));

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
      expect(dispatchedPlaces(handle.db, [getItem(handle.db, held.id)!], (item) => workspaceFor(handle.db, item)?.id ?? null)).toEqual(new Map([[held.id, new Set([repository])]]));
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
