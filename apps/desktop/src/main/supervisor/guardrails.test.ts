import { GIT_WORKTREE_KIND, type Agent, type AgentProvider, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { createRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { clearSetting, setSetting } from "../db/repos/settingsRepo.js";
import { DAILY_BUDGET_NOTICE_KEY } from "../guardDefaultNotice.js";
import { getItem } from "../db/repos/itemsRepo.js";
import type { DbHandle } from "../db/client.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { crashMidStreamFixture, hangsPastTimeoutFixture, happyPathFixture, validImplementResult } from "../providers/fixtures.js";
import { BUILTIN_RUNNERS } from "../packs/developer/builtins.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";
import { fakeWorkspaceKind, installedKinds } from "./testWorkspaceKinds.js";
import type { PrepareWorkspaceOutcome } from "./workspaceKind.js";
import { hourlyClock } from "../testing/clock.js";

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

/**
 * A provider that answers each action with a result its own schema
 * accepts (A-02). Tests that walk an item through several pipeline
 * stages need this — one fixed result can't satisfy refine, implement
 * and review at once.
 */
function allActionsSucceed() {
  return createScriptedProvider([
    { when: (context) => context.includes(`"refine" action`), script: { result: { stories: [{ title: "S", body: "b", acceptance_criteria: ["it works"] }] } } },
    { when: (context) => context.includes(`"implement" action`), script: { result: validImplementResult } },
    { when: (context) => context.includes(`"review" action`), script: { result: { verdict: "approve", feedback: "LGTM" } } },
    { when: () => true, script: { result: { intake: "complete" } } },
  ]);
}

// ARCHITECTURE.md, "Guardrails": every guard resolves the same way — post an engine comment
// mentioning @user, and stop. Each `it` below trips a different guard
// and checks exactly that shape (kind: 'escalation', open human mention,
// run left awaiting_input) — collectively that's acceptance criterion
// "no guard path exists that ends a run without a comment".
describe("guardrails", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
  });

  afterEach(() => {
    handle.close();
  });

  function escalationComments() {
    return handle.db.select().from(comments).all();
  }

  it("defaults global/per-agent concurrency to 1 (§7 — deliberately, until the loop is provably reliable)", async () => {
    const item2 = createTestItem(handle.db, { type: "story", title: "B story", stepId: "todo" });
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }) }); // no explicit limits

    await supervisor.runOnce();

    const dispatched = listRunsForItem(handle.db, item.id).length + listRunsForItem(handle.db, item2.id).length;
    expect(dispatched).toBe(1); // both items were eligible; only one got a slot this tick
  });

  it("an item hitting the attempt limit stops being dispatched and is flagged with an escalation", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(crashMidStreamFixture), // always fails; item never leaves 'todo'
      limits: LIMITS,
      guards: { perItemAttemptLimit: 2 },
      // Past every retry backoff by the next tick.
      now: hourlyClock(),
    });

    await supervisor.runOnce(); // attempt 1: fails
    await supervisor.runOnce(); // attempt 2: fails
    await supervisor.runOnce(); // attempt 3 refused: guard trips, no provider call

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(3);
    expect(runs.filter((run) => run.status === "failed")).toHaveLength(2);

    const guardRun = runs.find((run) => run.status === "awaiting_input")!;
    expect(guardRun.threadId).toBeNull(); // never actually started a thread
    expect(guardRun.error).toContain("attempt");

    expect(needsAttention(handle.db, item.id)).toBe(true);
    const escalation = escalationComments().find((c) => c.kind === "escalation");
    expect(escalation?.authorType).toBe("engine");
    expect(escalation?.runId).toBe(guardRun.id);

    await supervisor.runOnce(); // stays stopped — no 4th run
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(3);
  });

  it("does not stop an item making ordinary forward progress through the pipeline", async () => {
    // Regression: the guard counted every run on the item rather than
    // every run at the same *action*, so a healthy item walking the
    // pipeline was stopped partway with nothing wrong.
    //
    // A limit of 1 makes that unmistakable: this story runs `implement`
    // once and `review` once. Counted per item, the review dispatch is
    // the second run and gets refused; counted per action, both are
    // first attempts and it reaches the end.
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: allActionsSucceed(),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 1 },
      // The pack, because this walks a whole pipeline: the review step's
      // routes are keyed on a verdict, and the merge step runs one of
      // the pack's functions (KAN-144). Without it the supervisor routes
      // on the reported result key and finds no route for it, which is
      // the right answer for a core with nothing installed and not what
      // this test is about.
      builtins: BUILTIN_RUNNERS,
      ...createRoleWiring(handle.db),
    });

    for (let i = 0; i < 4; i++) await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("ready_to_merge");
    const runs = listRunsForItem(handle.db, item.id);
    // The merge step is a run of its own now: it takes time and can fail,
    // which is why it stopped being a flag on arriving somewhere.
    expect(runs.map((run) => run.action)).toEqual(["implement", "review", "open_pull_request"]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true); // none refused by the guard
  });

  it("a review return starts a fresh implement initiation", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: allActionsSucceed(),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 3 },
      // A reviewer that always rejects: review bounces straight back to todo.
      // Both halves of the destination, as every mover names now (EO-59) —
      // the bounce never leaves the pipeline it started on.
      resolveNextState: (current) =>
        current.id === "review"
          ? { stepId: "todo", pipelineId: current.pipelineId }
          : current.id === "todo"
            ? { stepId: "review", pipelineId: current.pipelineId }
            : null,
    });

    for (let i = 0; i < 10; i++) await supervisor.runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    const implementRuns = runs.filter((run) => run.action === "implement");
    expect(implementRuns.filter((run) => run.status === "succeeded")).toHaveLength(5);
    expect(implementRuns.every((run) => run.attempt === 1)).toBe(true);
    expect(new Set(implementRuns.map((run) => run.initiationId)).size).toBe(5);
    expect(implementRuns.some((run) => run.status === "awaiting_input" && run.threadId === null)).toBe(false);
  });

  it("a human reply after the attempt limit starts a fresh full allowance", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(crashMidStreamFixture),
      limits: LIMITS,
      guards: { perItemAttemptLimit: 2 },
      // Past every retry backoff by the next tick.
      now: hourlyClock(),
    });

    await supervisor.runOnce(); // attempt 1: fails
    await supervisor.runOnce(); // attempt 2: fails
    await supervisor.runOnce(); // attempt 3 refused: guard trips
    const beforeIds = new Set(listRunsForItem(handle.db, item.id).map((run) => run.id));
    expect(beforeIds.size).toBe(3);

    await supervisor.resumeItem(item.id);
    await supervisor.runOnce(); // attempt 2 in the newly-authorized initiation
    await supervisor.runOnce(); // that initiation is now exhausted

    const afterRuns = listRunsForItem(handle.db, item.id);
    const newRuns = afterRuns.filter((run) => !beforeIds.has(run.id));
    const real = newRuns.filter((run) => !(run.status === "awaiting_input" && run.threadId === null));
    expect(real.map((run) => run.attempt)).toEqual([1, 2]);
    expect(new Set(real.map((run) => run.initiationId)).size).toBe(1);
    expect(newRuns.some((run) => run.status === "awaiting_input" && run.threadId === null)).toBe(true);
  });

  it("wall-clock timeout aborts a hung run, marks it awaiting_input, and posts an escalation", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(hangsPastTimeoutFixture),
      limits: LIMITS,
      guards: { wallClockTimeoutMs: 30 },
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("timeout");
    expect(run?.threadId).toBeTruthy(); // it did start — it just never finished in time

    expect(needsAttention(handle.db, item.id)).toBe(true);
    expect(escalationComments().some((c) => c.kind === "escalation" && c.runId === run?.id)).toBe(true);
  });

  it("cancelRun (a human choice) still ends the run 'cancelled', with no guard escalation posted", async () => {
    // Regression guard: the timeout guard and manual cancellation both
    // abort the same controller — they must not be conflated.
    //
    // A cancellation does now write a note saying EO has stopped with it
    // (EO-175). That is the opposite claim to a guard's: a guard is EO
    // asking for attention, and this is EO acknowledging an instruction,
    // so it is a `note` and raises no `!`. What must stay at zero is
    // escalations.
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 2000 }] }),
      limits: LIMITS,
      guards: { wallClockTimeoutMs: 60_000 },
    });

    const runPromise = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [run] = listRunsForItem(handle.db, item.id);
    supervisor.cancelRun(run!.id);
    await runPromise;

    expect(getItem(handle.db, item.id)).toBeDefined();
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
    expect(escalationComments().filter((c) => c.kind === "escalation")).toHaveLength(0);
    expect(needsAttention(handle.db, item.id)).toBe(false);
  });

  it("a per-item cost budget trips as a hard stop mid-run, before the result ever arrives", async () => {
    const script: FakeProviderScript = {
      steps: [{ output: "working" }],
      usage: { tokensIn: 100, tokensOut: 50, costCents: 1000 },
      result: validImplementResult, // scripted, but never reached — the budget trips first
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(script),
      limits: LIMITS,
      guards: { perItemBudgetCents: 500 },
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("budget");
    expect(run?.costCents).toBe(1000); // usage was still recorded before the guard stopped the run
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // never reached success

    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("the daily budget is enforced across all items, not per-item", async () => {
    // A different, non-dispatchable item's already-completed spend —
    // proves the aggregation is cross-item, not scoped to `item`.
    const otherItem = createTestItem(handle.db, { type: "story", title: "Other", stepId: "ready_to_merge" });
    const priorRun = createRun(handle.db, { itemId: otherItem.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, priorRun.id, { costCents: 400, startedAt: Date.now(), endedAt: Date.now() });

    const script: FakeProviderScript = {
      steps: [{ output: "working" }],
      usage: { tokensIn: 10, tokensOut: 10, costCents: 200 }, // well under any sane per-item budget on its own
      result: validImplementResult,
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider(script),
      limits: LIMITS,
      guards: { dailyBudgetCents: 500 }, // 400 (other item, already spent) + 200 (this run) = 600 > 500
    });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("Daily");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  /**
   * The upgrade's first tick says the ceiling arrived (EO-211).
   *
   * Wired here rather than only unit-tested next to
   * `announceDailyBudgetDefault`, because the thing that could silently
   * stop working is the *call*: a guard that changes what EO will do,
   * applied to an installation that never asked for it, has to be said
   * before it can stop anything. `guardDefaultNotice.test.ts` covers
   * what the notice says and every case it stays quiet for.
   */
  it("says once, on the first tick, that a daily budget it never set now applies", async () => {
    // An installation that predates the default. The test helper stamps
    // every database it makes as born under today's guards, exactly as
    // `index.ts` stamps a database it is creating; clearing that is what
    // makes this one an upgrade. Its saved config is from before the
    // guard existed: a row, with no `dailyBudgetCents` key in it.
    clearSetting(handle.db, DAILY_BUDGET_NOTICE_KEY);
    setSetting(handle.db, "engine.guards", { globalConcurrency: 1 });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ result: validImplementResult }),
      limits: LIMITS,
    });

    await supervisor.runOnce();
    await supervisor.runOnce();

    const said = escalationComments().filter((comment) => comment.body.includes("daily spend ceiling"));
    expect(said).toHaveLength(1);
    expect(said[0]?.body).toContain("Guardrails");
  });

  it("a signed-out backend escalates before any agent starts (A-06)", async () => {
    // The provider modules have shipped auth probes since A-04, but
    // nothing called them: a signed-out user got a stack trace from
    // inside the SDK stream instead of a comment. This is the wiring,
    // not the probe — `runtimes/auth.test.ts` covers what the probe
    // actually asks and what it makes of the answer (EO-82).
    let started = false;
    const inner = createFakeProvider({ result: validImplementResult });
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: {
        start: (opts) => {
          started = true;
          return inner.start(opts);
        },
        resume: inner.resume.bind(inner),
      },
      limits: LIMITS,
      // The real refusal, verbatim from `checkRuntimeAuth`: it names
      // where to fix it and no longer sends anyone to a terminal that a
      // desktop-only machine does not have.
      checkAuth: async () => ({
        ok: false,
        reason:
          "Claude Code is not signed in, so Implementer has nothing to run with. " +
          "Sign it in from Agents → Runtimes, then reply here to retry.",
      }),
    });

    await supervisor.runOnce();

    expect(started).toBe(false);

    const [runRow] = listRunsForItem(handle.db, item.id);
    expect(runRow?.status).toBe("awaiting_input");
    expect(runRow?.error).toContain("Agents → Runtimes");

    // Same shape as every other guard (invariant #8).
    expect(needsAttention(handle.db, item.id)).toBe(true);
    const escalation = handle.db
      .select()
      .from(comments)
      .all()
      .find((comment) => comment.kind === "escalation" && comment.authorType === "engine");
    expect(escalation?.body).toContain("Agents → Runtimes");
  });

  it("pause stops new dispatches within one tick; resume picks up cleanly", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider({ result: validImplementResult }), limits: LIMITS });

    supervisor.pause();
    expect(supervisor.isPaused()).toBe(true);
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(0); // paused — nothing dispatched

    supervisor.resume();
    expect(supervisor.isPaused()).toBe(false);
    await supervisor.runOnce();
    expect(listRunsForItem(handle.db, item.id)).toHaveLength(1); // resumed — dispatch happens normally
  });

  it("closes the provider boundary when pause arrives during dispatch preflight", async () => {
    let workspaceStarted = false;
    let releaseWorkspace: (value: PrepareWorkspaceOutcome) => void = () => {};
    const workspace = new Promise<PrepareWorkspaceOutcome>((resolve) => {
      releaseWorkspace = resolve;
    });
    const inner = createFakeProvider({ result: validImplementResult });
    const start = vi.fn(inner.start.bind(inner));
    const provider: AgentProvider = { start, resume: inner.resume.bind(inner) };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider,
      limits: LIMITS,
      kinds: installedKinds(
        fakeWorkspaceKind({
          prepare: () => {
            workspaceStarted = true;
            return workspace;
          },
        }),
      ),
    });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(workspaceStarted).toBe(true));
    supervisor.pause();
    releaseWorkspace({ ok: true, workspace: { cwd: "/tmp/eo/guardrails", kind: GIT_WORKTREE_KIND, workspaceId: null } });
    await tick;

    expect(start).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id)).toEqual([]);
  });

  it("does not cancel active agents and reports the count draining to zero", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 50 }], result: validImplementResult }),
      limits: LIMITS,
    });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    supervisor.pause();

    expect(supervisor.isPaused()).toBe(true);
    expect(supervisor.activeRunCount()).toBe(1);
    await tick;
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(supervisor.activeRunCount()).toBe(0);
  });

  it("can resume during a drain without interrupting the run already active", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 50 }], result: validImplementResult }),
      limits: LIMITS,
    });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    supervisor.pause();
    supervisor.resume();

    expect(supervisor.isPaused()).toBe(false);
    expect(supervisor.activeRunCount()).toBe(1);
    await tick;
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  it("does not start a corrective provider retry after pause", async () => {
    let releaseResult: () => void = () => {};
    const mayReturn = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const resume = vi.fn(() => createFakeProvider({ result: validImplementResult }).resume("unused", "unused"));
    const provider: AgentProvider = {
      async *start() {
        yield { type: "thread_started", threadId: "thread-to-correct" };
        await mayReturn;
        yield { type: "result", data: { malformed: true } };
      },
      resume,
    };
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    const tick = supervisor.runOnce();
    await vi.waitFor(() => expect(supervisor.activeRunCount()).toBe(1));
    supervisor.pause();
    releaseResult();
    await tick;

    expect(resume).not.toHaveBeenCalled();
    expect(listRunsForItem(handle.db, item.id)[0]).toMatchObject({
      status: "failed",
      error: "paused before starting a provider retry",
    });
    expect(supervisor.activeRunCount()).toBe(0);
  });

  it("pause({ cancelRunning: true }) also aborts every run already in flight", async () => {
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: createFakeProvider({ steps: [{ sleepMs: 2000 }] }),
      limits: LIMITS,
    });

    const runPromise = supervisor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    supervisor.pause({ cancelRunning: true });
    await runPromise;

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("cancelled");
  });

  it("tracks tokens_in/tokens_out/cost_cents on the run from provider usage events", async () => {
    const supervisor = createRunSupervisor({ db: handle.db, provider: createFakeProvider(happyPathFixture), limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ status: "succeeded", tokensIn: 500, tokensOut: 200, costCents: 3 });
  });

  it("lands the cache split and the turn count on the run row too", async () => {
    // End to end, because every layer between the provider and the row
    // is new: the fields have to survive the tally, the update and the
    // repo's mapping. The turn count is the multiplier the dispatch
    // prompt is paid over, so a null here is the whole measurement lost.
    const provider = createFakeProvider({
      ...happyPathFixture,
      usage: { tokensIn: 120_000, tokensOut: 3_000, cacheReadTokens: 96_000, cacheWriteTokens: 12_000, turns: 14, costCents: 3 },
    });
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ tokensIn: 120_000, cacheReadTokens: 96_000, cacheWriteTokens: 12_000, turns: 14 });
  });

  it("records nothing about caching or turns when the backend reported none", async () => {
    // Zero and unknown are different things (A-04), and this is the path
    // that decides which the row holds: a backend that says nothing about
    // its cache has not told us the cache was cold.
    const provider = createFakeProvider({ ...happyPathFixture, usage: { tokensIn: 500, tokensOut: 200, costCents: 3 } });
    const supervisor = createRunSupervisor({ db: handle.db, provider, limits: LIMITS });

    await supervisor.runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ tokensIn: 500, cacheReadTokens: null, cacheWriteTokens: null, turns: null });
  });
});
