import type { Agent, AgentEvent, AgentProvider, AgentProviderResumeOptions, Item, Run, UsageEvent } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { createRun, getRun, listAgents, listRunsForItem, postComment, sumCostCentsForItem, sumCostCentsSince, updateAgent, updateRun, usageHistoryOnThread } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { getDailyCost, getItemCost } from "../ipc/costHandlers.js";
import { validImplementResult } from "../providers/fixtures.js";
import { promptHash } from "../roles/prompts.js";
import { createRunSupervisor, type GuardConfig } from "./runSupervisor.js";
import { kindsPreparing } from "./testWorkspaceKinds.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };
const CWD = "/tmp/eo/worktrees/EO-490";
const THREAD = "the-implementers-session";

/**
 * EO-486's two implement runs, as the CLI's own transcript has them. The
 * second run resumed the first one's session, and every reading it got
 * back was the first run's spend plus its own.
 */
const RUN_1 = { tokensIn: 5_826_855, tokensOut: 43_410, cacheWriteTokens: 120_181, costCents: 297 };
const RUN_2 = { tokensIn: 2_661_773, tokensOut: 12_255, cacheWriteTokens: 33_293, costCents: 104 };
/** What run 2's corrective turn spent of its own. */
const CORRECTION = { tokensIn: 40_000, tokensOut: 600, cacheWriteTokens: 1_000, costCents: 4 };

const sum = (...parts: (typeof RUN_1)[]): typeof RUN_1 => ({
  tokensIn: parts.reduce((total, part) => total + part.tokensIn, 0),
  tokensOut: parts.reduce((total, part) => total + part.tokensOut, 0),
  cacheWriteTokens: parts.reduce((total, part) => total + part.cacheWriteTokens, 0),
  costCents: parts.reduce((total, part) => total + part.costCents, 0),
});

const reading = (totals: typeof RUN_1, turns: number): UsageEvent => ({ type: "usage", scope: "session", ...totals, turns });

/**
 * What a resumed Claude run's spend is counted as, and what reads it
 * (EO-490): the run's row, the per-item and daily budgets, `spend_read`'s
 * two handlers, and the cap the next turn on the run is handed.
 *
 * One item, two runs on one thread. The first is on the record as it
 * recorded itself; the second resumes it, is asked once to correct its
 * result, and reports — as the CLI does — the session's running total
 * every time: run 1, then run 1 and 2, then run 1 and 2 and the
 * correction.
 */
describe("a resumed run's spend", () => {
  let handle: DbHandle;
  let item: Item;
  let implementer: Agent;
  /** What each resumed turn was handed as its cap, in order. */
  let caps: (number | undefined)[];
  /** Run 1's row. */
  let first: Run;

  beforeEach(() => {
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    implementer = updateAgent(handle.db, implementer.id, { config: { reuseThreadPerItem: true } });
    caps = [];

    // Run 1, as it recorded itself: it started the thread, so its
    // session's running total was its own.
    first = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: THREAD,
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
    });
    updateRun(handle.db, first.id, { ...RUN_1, cacheReadTokens: null, turns: 31, turnsScope: "session", startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "One more thing: handle the empty case." });
  });

  afterEach(() => {
    handle.close();
  });

  /**
   * The CLI on a resumed session: every turn reports the whole
   * conversation's running total, which stood at `before` when run 2
   * resumed it.
   */
  function resumingProvider(before: typeof RUN_1 = RUN_1): AgentProvider {
    let turn = 0;
    return {
      start: () => {
        throw new Error("run 2 resumes the thread; nothing should start one");
      },
      resume: (threadId: string, _message: string, opts?: AgentProviderResumeOptions) => {
        expect(threadId).toBe(THREAD);
        caps.push(opts?.budgetCents);
        turn += 1;
        const thisTurn = turn;
        return (async function* (): AsyncGenerator<AgentEvent> {
          if (thisTurn === 1) {
            yield reading(sum(before, { ...RUN_2, tokensIn: 1_000_000, tokensOut: 5_000, cacheWriteTokens: 10_000, costCents: 40 }), 6);
            yield reading(sum(before, RUN_2), 17);
            // Not the action's shape, so the run is asked to correct it.
            yield { type: "result", data: { summary: "Did the work." } };
            return;
          }
          yield reading(sum(before, RUN_2, CORRECTION), 1);
          yield { type: "result", data: validImplementResult };
        })();
      },
    };
  }

  async function runTheSecondRun(guards: Partial<GuardConfig>, before: typeof RUN_1 = RUN_1): Promise<void> {
    const supervisor = createRunSupervisor({ db: handle.db, provider: resumingProvider(before), kinds: kindsPreparing(CWD), limits: LIMITS, guards });
    await supervisor.runOnce();
    await supervisor.waitForIdle();
  }

  const secondRun = () => listRunsForItem(handle.db, item.id).find((run) => run.threadId === THREAD && run.costCents !== RUN_1.costCents)!;

  it("records only what the run spent itself, its corrective turn once", async () => {
    await runTheSecondRun({});

    const run = getRun(handle.db, secondRun().id)!;
    expect(run.status).toBe("succeeded");
    expect(run).toMatchObject(sum(RUN_2, CORRECTION));
    // The turn count was never cumulative and is left alone.
    expect(run.turns).toBe(17);
  });

  it("records where it left the session, for the next run on the thread to start from (EO-504)", async () => {
    await runTheSecondRun({});

    expect(usageHistoryOnThread(handle.db, THREAD, first.id)).toEqual([
      { recorded: { ...sum(RUN_2, CORRECTION), cacheReadTokens: null }, sessionEndedOn: { ...sum(RUN_1, RUN_2, CORRECTION), cacheReadTokens: null } },
    ]);
  });

  it("records only its own spend on a thread with a resumed row from before EO-490 (EO-504)", async () => {
    // A second pre-fix run between them, which resumed run 1 and — as
    // every resumed run then did — recorded the session's whole total.
    // The rows now add up to run 1 twice over, more than the session holds.
    const between = { tokensIn: 300_000, tokensOut: 3_000, cacheWriteTokens: 9_000, costCents: 20 };
    const preFix = createRun(handle.db, {
      itemId: item.id,
      agentId: implementer.id,
      action: "implement",
      status: "succeeded",
      threadId: THREAD,
      provider: implementer.provider,
      instructionsHash: promptHash(implementer.instructions),
      cwd: CWD,
    });
    updateRun(handle.db, preFix.id, { ...sum(RUN_1, between), cacheReadTokens: null, turns: 4, turnsScope: "session", startedAt: Date.now() - 20_000, endedAt: Date.now() - 10_000 });

    await runTheSecondRun({}, sum(RUN_1, between));

    const run = listRunsForItem(handle.db, item.id).find((each) => each.id !== first.id && each.id !== preFix.id)!;
    expect(run.status).toBe("succeeded");
    expect(run).toMatchObject(sum(RUN_2, CORRECTION));
  });

  it("is what the item and the day are charged, and what spend_read reports", async () => {
    await runTheSecondRun({});

    const charged = sum(RUN_1, RUN_2, CORRECTION).costCents;
    expect(sumCostCentsForItem(handle.db, item.id)).toBe(charged);
    expect(sumCostCentsSince(handle.db, 0)).toBe(charged);
    // `spend_read` answers from these two handlers.
    expect(getItemCost(handle.db, { itemId: item.id }).costCents).toBe(charged);
    expect(getDailyCost(handle.db, {}).costCents).toBe(charged);
  });

  it("holds the run to the per-item budget by what it really spent, and hands the correction what is really left", async () => {
    // 600¢ is enough for both runs as they were: 297 + 108. Read as the
    // whole conversation, run 2 alone would be 405 and the item 702 —
    // tripped part-way through run 2, with its correction capped at nothing.
    await runTheSecondRun({ perItemBudgetCents: 600 });

    expect(getRun(handle.db, secondRun().id)!.status).toBe("succeeded");
    expect(caps).toEqual([600 - RUN_1.costCents, 600 - RUN_1.costCents - RUN_2.costCents]);
  });

  it("holds the run to the daily budget the same way", async () => {
    await runTheSecondRun({ dailyBudgetCents: 650 });

    expect(getRun(handle.db, secondRun().id)!.status).toBe("succeeded");
    expect(caps).toEqual([650 - RUN_1.costCents, 650 - RUN_1.costCents - RUN_2.costCents]);
  });
});
