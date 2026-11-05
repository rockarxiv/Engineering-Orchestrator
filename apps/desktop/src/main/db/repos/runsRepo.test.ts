import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INTERPRET_ACTION, type Agent, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { promptHash } from "../../roles/prompts.js";
import { createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { listAgents } from "./agentsRepo.js";
import { costCentsByProject, createRun, getRun, listActiveRuns, listAwaitingInputItemIds, listRunsForItem, updateRun, usageHistoryOnThread } from "./runsRepo.js";
import { createProject } from "./projectsRepo.js";

describe("runsRepo", () => {
  let handle: DbHandle;
  let item: Item;
  let agent: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    agent = listAgents(handle.db)[0]!;
  });

  afterEach(() => {
    handle.close();
  });

  it("creates a run defaulting to queued, attempt 1", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    expect(run.status).toBe("queued");
    expect(run.attempt).toBe(1);
    expect(run.runtimeSource).toBeNull();
    expect(run.result).toBeNull();

    expect(getRun(handle.db, run.id)).toEqual(run);
  });

  it("records the step the item was on, without being told", () => {
    // Six places create a run and only the scheduler's knows the step as
    // an object. Defaulting it here is what stops the other five from
    // each having to remember — and the item's own step is the value
    // the scheduler resolved the step from, not an approximation of it.
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });

    expect(run.stepId).toBe("todo");
  });

  it("prefers the step it is given, for a run that continues an earlier one", () => {
    // A resumed or reconciled run belongs to the step its predecessor was
    // dispatched from, which is not necessarily where the item sits by
    // the time it is written.
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "review", stepId: "review" });

    expect(run.stepId).toBe("review");
  });

  it("records no step for an item that has none, rather than inventing one", () => {
    const feature = createTestItem(handle.db, { type: "feature", title: "A feature", stepId: null });

    expect(createRun(handle.db, { itemId: feature.id, agentId: agent.id, action: "refine" }).stepId).toBeNull();
  });

  it("persists the runtime selection used to launch the provider subprocess", () => {
    const run = createRun(handle.db, {
      itemId: item.id,
      agentId: agent.id,
      action: "implement",
      runtimeSource: "managed",
    });

    expect(getRun(handle.db, run.id)?.runtimeSource).toBe("managed");
  });

  it("records which instructions a run was handed, and null where there were none", () => {
    // What the thread was born with (EO-87): neither backend re-sends
    // instructions on resume, so this row is the only record of them.
    const hash = promptHash(agent.instructions);
    const dispatched = createRun(handle.db, {
      itemId: item.id,
      agentId: agent.id,
      action: "implement",
      instructionsHash: hash,
    });

    expect(getRun(handle.db, dispatched.id)?.instructionsHash).toBe(hash);

    // A builtin or module run has no agent, so there are no instructions
    // to hash. Null, not the hash of an empty string — that would be a
    // real-looking value standing for nothing, and something comparing
    // hashes would call two of them a match.
    const builtin = createRun(handle.db, { itemId: item.id, agentId: null, action: "create_worktree" });

    expect(builtin.instructionsHash).toBeNull();
    expect(getRun(handle.db, builtin.id)?.instructionsHash).toBeNull();
  });

  it("updates status and result fields", () => {
    const run = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });

    const updated = updateRun(handle.db, run.id, {
      status: "succeeded",
      result: { branch: "eo/EO-1" },
      endedAt: 1234,
    });

    expect(updated.status).toBe("succeeded");
    expect(updated.result).toEqual({ branch: "eo/EO-1" });
    expect(updated.endedAt).toBe(1234);
  });

  it("lists runs for an item", () => {
    createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", attempt: 2 });

    expect(listRunsForItem(handle.db, item.id)).toHaveLength(2);
  });

  it("enforces the item_id foreign key", () => {
    expect(() =>
      createRun(handle.db, { itemId: "not-a-real-item" as Item["id"], agentId: agent.id, action: "implement" }),
    ).toThrow();
  });

  it("listActiveRuns() returns only queued/running runs, across items", () => {
    const other = createTestItem(handle.db, { type: "story", title: "Other", stepId: "todo" });
    const queued = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    const running = createRun(handle.db, { itemId: other.id, agentId: agent.id, action: "implement" });
    updateRun(handle.db, running.id, { status: "running" });
    const done = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", attempt: 2 });
    updateRun(handle.db, done.id, { status: "succeeded" });

    const active = listActiveRuns(handle.db);
    expect(active.map((r) => r.id).sort()).toEqual([queued.id, running.id].sort());
  });

  it("listAwaitingInputItemIds() returns only items whose MOST RECENT run is awaiting_input", () => {
    const first = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement" });
    updateRun(handle.db, first.id, { status: "awaiting_input", startedAt: 1 });

    expect(listAwaitingInputItemIds(handle.db)).toEqual(new Set([item.id]));

    // A newer run superseding the awaiting_input one clears it from the set.
    const second = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", attempt: 2 });
    updateRun(handle.db, second.id, { status: "running", startedAt: 2 });

    expect(listAwaitingInputItemIds(handle.db)).toEqual(new Set());
  });

  it("listAwaitingInputItemIds() ignores an interpretation, which leaves a parked item parked", () => {
    const parked = createRun(handle.db, { itemId: item.id, agentId: null, action: "create_worktree" });
    updateRun(handle.db, parked.id, { status: "awaiting_input", startedAt: 1 });

    // The system agent reading the reply is a newer run that succeeded,
    // and it must not be read as the step having got somewhere (EO-184):
    // it moved nothing and declared no result. Counted, it would report
    // this item as free and the scheduler would dispatch the very step
    // the interpretation was sent to answer for.
    const interpretation = createRun(handle.db, { itemId: item.id, agentId: agent.id, action: INTERPRET_ACTION });
    updateRun(handle.db, interpretation.id, { status: "succeeded", startedAt: 2 });

    expect(listAwaitingInputItemIds(handle.db)).toEqual(new Set([item.id]));

    // Any other run still supersedes it, exactly as before.
    const rerun = createRun(handle.db, { itemId: item.id, agentId: null, action: "create_worktree", attempt: 2 });
    updateRun(handle.db, rerun.id, { status: "running", startedAt: 3 });

    expect(listAwaitingInputItemIds(handle.db)).toEqual(new Set());
  });
});

/**
 * What each project has cost (EO-326, `ARCHITECTURE.md`, "Policy").
 *
 * The figure on the admin's project switcher, which is where the
 * comparison the original design describes actually gets made: "the server sums per-
 * person budgets into a project total for the admin". The budgets are
 * 7c's; this is the number they will be compared against, and it does
 * not wait for them.
 *
 * The two things worth holding are the two that would go wrong quietly:
 * a preview's runs counted as money, which is EO contradicting the
 * banner it drew; and a project's total leaking into another's, which
 * an admin has no way to notice and every reason to act on.
 */
describe("what each project has cost", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  function spend(projectId: Uuid | null, costCents: number, preview = false): void {
    const one = createTestItem(handle.db, {
      type: "story",
      title: `An item costing ${costCents}`,
      stepId: "todo",
      projectId,
      ...(preview ? { previewAt: Date.now() } : {}),
    });
    const run = createRun(handle.db, { itemId: one.id, agentId: listAgents(handle.db)[0]!.id, action: "implement" });
    updateRun(handle.db, run.id, { status: "succeeded", costCents });
  }

  it("keeps one project's spend out of another's", () => {
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    const marketing = createProject(handle.db, { name: "Marketing", keyPrefix: "MKT" });
    spend(support.id, 120);
    spend(support.id, 30);
    spend(marketing.id, 7);

    const byProject = costCentsByProject(handle.db);

    expect(byProject.get(support.id)).toBe(150);
    expect(byProject.get(marketing.id)).toBe(7);
  });

  it("leaves a preview's runs out, as every other cost does", () => {
    // EO-313 ARCHITECTURE.md, "Preview". The banner says nothing cost money, and a switcher
    // that put a figure beside the project would be the app disagreeing
    // with a promise it had just made.
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });
    spend(support.id, 100);
    spend(support.id, 999, true);

    expect(costCentsByProject(handle.db).get(support.id)).toBe(100);
  });

  it("sums what belongs to no project rather than dropping it", () => {
    // Real spending: an installation before its first project has
    // nothing else. No caller draws the row today; a total that quietly
    // omitted it would be money nobody could account for later.
    spend(null, 42);

    expect(costCentsByProject(handle.db).get(null)).toBe(42);
  });

  it("says nothing about a project that has run nothing", () => {
    // Absent rather than nought, so the switcher can tell "has spent
    // nothing" from "has spent zero" without a second field.
    const support = createProject(handle.db, { name: "Support", keyPrefix: "SUP" });

    expect(costCentsByProject(handle.db).has(support.id)).toBe(false);
  });
});

describe("a thread's usage history (EO-504)", () => {
  let handle: DbHandle;
  let item: Item;
  let agent: Agent;
  const THREAD = "a-thread";

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    agent = listAgents(handle.db)[0]!;
  });

  afterEach(() => {
    handle.close();
  });

  const run = (threadId: string | null) => createRun(handle.db, { itemId: item.id, agentId: agent.id, action: "implement", threadId });

  it("is every other run on the thread, oldest first, with what each recorded and where it left the session", () => {
    const preFix = run(THREAD);
    updateRun(handle.db, preFix.id, { tokensIn: 1_000_000, tokensOut: 10_000, costCents: 120 });
    const nothing = run(THREAD);
    const after = run(THREAD);
    updateRun(handle.db, after.id, {
      tokensIn: 200_000,
      tokensOut: 2_000,
      cacheReadTokens: 150_000,
      costCents: 30,
      sessionTokensIn: 1_200_000,
      sessionTokensOut: 12_000,
      sessionCacheReadTokens: 900_000,
      sessionCostCents: 150,
    });
    const elsewhere = run("another-thread");
    updateRun(handle.db, elsewhere.id, { tokensIn: 5, tokensOut: 5, costCents: 5 });
    const resuming = run(THREAD);
    updateRun(handle.db, resuming.id, { tokensIn: 7, tokensOut: 7, costCents: 7, sessionTokensIn: 7, sessionTokensOut: 7, sessionCostCents: 7 });

    expect(usageHistoryOnThread(handle.db, THREAD, resuming.id)).toEqual([
      { recorded: { tokensIn: 1_000_000, tokensOut: 10_000, cacheReadTokens: null, cacheWriteTokens: null, costCents: 120 }, sessionEndedOn: null },
      { recorded: null, sessionEndedOn: null },
      {
        recorded: { tokensIn: 200_000, tokensOut: 2_000, cacheReadTokens: 150_000, cacheWriteTokens: null, costCents: 30 },
        sessionEndedOn: { tokensIn: 1_200_000, tokensOut: 12_000, cacheReadTokens: 900_000, cacheWriteTokens: null, costCents: 150 },
      },
    ]);
    expect(nothing.id < after.id).toBe(true);
  });

  it("is empty for a thread nothing else has used", () => {
    const only = run(THREAD);
    expect(usageHistoryOnThread(handle.db, THREAD, only.id)).toEqual([]);
  });
});
