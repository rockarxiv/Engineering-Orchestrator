import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, listAllDependencies, listCommentsForItem, listDispatchedItemIds, listRunsForItem, needsAttention, setItemHeld, transitionItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getItemDetail, listItemSummaries } from "../ipc/domainQueries.js";
import type { BuiltinRunner } from "./builtins.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";

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
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
    limits: LIMITS,
    kinds: installedKinds(fakeWorkspaceKind({ capacityKeyOf })),
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
    expect(listDispatchedItemIds(handle.db)).toEqual(new Set([holder.id]));
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
    expect(listDispatchedItemIds(handle.db)).toEqual(new Set([holder.id]));
  });
});
