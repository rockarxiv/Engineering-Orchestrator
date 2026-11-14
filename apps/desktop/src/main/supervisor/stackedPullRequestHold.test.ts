import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem, needsAttention, transitionItem, updateItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createDispatchGate } from "../packs/developer/scheduling.js";
import { createRunSupervisor, type RunSupervisor } from "./runSupervisor.js";
import type { BuiltinRunner } from "./builtins.js";

/**
 * A stacked child's pull request held until its dependency has one
 * (EO-781), as the supervisor carries it out: the gate keeps the step
 * from dispatching, the thread says so once (invariant #8), and the step
 * runs by itself once the hold lifts.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let dependency: Item;
let child: Item;
let openPullRequest: ReturnType<typeof vi.fn<BuiltinRunner>>;

function supervisor(): RunSupervisor {
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a builtin must not reach a provider"); } } as never,
    limits: LIMITS,
    dispatchGate: createDispatchGate(handle.db),
    builtins: { open_pull_request: openPullRequest },
    ...createRoleWiring(handle.db),
  });
}

function holdNotes(): string[] {
  return listCommentsForItem(handle.db, child.id)
    .filter((comment) => comment.authorType === "engine" && comment.body.includes("to open its pull request"))
    .map((comment) => comment.body);
}

beforeEach(() => {
  handle = openMigratedTestDb();
  openPullRequest = vi.fn<BuiltinRunner>(async () => ({ ok: true, result: "opened", detail: "Opened" }));
  dependency = createTestItem(handle.db, { type: "story", title: "Dependency", stepId: "review", git: { branch: "eo/dependency" } });
  // On the seeded Delivery's `merge_request`, whose action is `open_pull_request`.
  child = createTestItem(handle.db, {
    type: "story",
    title: "Child",
    stepId: "merge_request",
    git: { branch: "eo/child", stackedOn: { itemId: dependency.id, commit: "abc123" } },
  });
});

afterEach(() => {
  handle.close();
});

describe("a stacked child whose dependency has no pull request yet", () => {
  it("is not dispatched, and the thread says why once however many ticks pass", async () => {
    const engine = supervisor();
    await engine.runOnce();
    await engine.runOnce();
    await engine.runOnce();

    expect(openPullRequest).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, child.id)).toEqual([]);
    expect(holdNotes()).toEqual([
      `Holding "Merge Request": its branch is built on ${dependency.key}'s, so it waits for ${dependency.key} to open its pull request. ` +
        `Nothing to do: it opens its own once ${dependency.key} has one, or once ${dependency.key} finishes.`,
    ]);
    // A note, not a question: nothing is asked of anybody.
    expect(listCommentsForItem(handle.db, child.id).every((comment) => comment.kind === "note")).toBe(true);
    expect(needsAttention(handle.db, child.id)).toBe(false);
    expect(getItem(handle.db, child.id)?.stepId).toBe("merge_request");
  });

  it("opens its pull request on the next tick after the dependency's is recorded, without saying anything more", async () => {
    const engine = supervisor();
    await engine.runOnce();
    expect(openPullRequest).not.toHaveBeenCalled();

    updateItem(handle.db, dependency.id, { git: { pullRequest: "https://github.com/acme/app/pull/12" } });
    await engine.runOnce();

    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(listRunsForItem(handle.db, child.id).map((run) => [run.action, run.status])).toEqual([["open_pull_request", "succeeded"]]);
    expect(holdNotes()).toHaveLength(1);
  });

  it("opens it once the dependency finishes, pull request or not", async () => {
    const engine = supervisor();
    await engine.runOnce();

    transitionItem(handle.db, { itemId: dependency.id, toStepId: "ready_to_merge", actor: "human" });
    await engine.runOnce();

    expect(openPullRequest).toHaveBeenCalledTimes(1);
  });
});
