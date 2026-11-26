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
  listDispatchSteps,
  listRunsForItem,
  needsAttention,
  setItemHeld,
  transitionItem,
  updateStep,
} from "../db/repos/index.js";
import { createPipelineVersion, ensureCurrentVersion } from "../db/repos/pipelineVersionsRepo.js";
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
    expect(listDispatchSteps(handle.db)).toEqual(new Map([[holder.id, new Set(["review"])]]));
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
    expect(listDispatchSteps(handle.db)).toEqual(new Map([[holder.id, new Set(["review"])]]));
  });

  it("is judged by the step's action as it was defined, so editing the action takes nothing out of flight", async () => {
    // The holder entered on the version in force; its step's action then
    // changes, first by a save nobody has published, then by a publish.
    ensureCurrentVersion(handle.db, "default");
    const entered = getItem(handle.db, holder.id)?.pipelineVersionId;
    expect(entered).not.toBeNull();
    handle.db.update(pipelineSteps).set({ entryAction: "review_again" }).where(eq(pipelineSteps.id, "review")).run();
    expect(listDispatchSteps(handle.db).get(holder.id)).toEqual(new Set(["review"]));

    createPipelineVersion(handle.db, "default");
    expect(getItem(handle.db, holder.id)?.pipelineVersionId).toBe(entered);
    expect(listDispatchSteps(handle.db).get(holder.id)).toEqual(new Set(["review"]));

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
    createRun(handle.db, { itemId: holder.id, agentId: null, action: "review", stepId: "review", status: "succeeded", threadId: "thread-1" });
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
    createRun(handle.db, { itemId: held.id, agentId: null, action: "draft", stepId: "draft", status: "succeeded" });
    expect(listDispatchSteps(handle.db).get(held.id)).toEqual(new Set(["draft"]));
    expect(dispatchedPlaces(handle.db, [held], (item) => workspaceFor(handle.db, item)?.id ?? null).has(held.id)).toBe(false);
    setItemHeld(handle.db, holder.id, 1);

    const engine = supervisorWith(repositoryKinds());
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();
    expect(engine.dispatchBlockerFor(held.id)).toMatchObject({ kind: "touches_overlap", holderId: holder.id });
  });
});
