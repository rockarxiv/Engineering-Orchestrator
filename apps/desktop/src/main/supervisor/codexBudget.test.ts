import { listAgents } from "../db/repos/agentsRepo.js";
import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { needsAttention } from "../db/repos/commentsRepo.js";
import { getItem } from "../db/repos/itemsRepo.js";
import { createRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import { comments } from "../db/schema.js";
import { createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createCodexProvider } from "../providers/codex.js";
import { CodexClient } from "../providers/codexClient.js";
import { validImplementResult } from "../providers/fixtures.js";
import { fakeAppServer, note, type FakeAppServerScenario } from "../testing/fakeCodexAppServer.js";
import { createRunSupervisor, type GuardConfig } from "./runSupervisor.js";

/**
 * The budgets stop a Codex run (EO-374).
 *
 * Codex reports tokens and never money, and until EO priced them every
 * Codex run cost nothing — so the per-item and daily budgets, which are
 * in cents, stopped Claude runs and let every Codex one through. These
 * are the guardrails cases for both budgets (`guardrails.test.ts`), with
 * the real Codex adapter and client over a stubbed app-server in place of
 * the fake provider, so what is under test is the whole path: the model
 * the thread opened on, the price the table holds for it, and the guard.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };
const EXECUTABLE = "/opt/eo/runtimes/codex/bin/codex";

let handle: DbHandle;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", spec: REVIEWABLE_SPEC });
});

afterEach(() => {
  handle.close();
});

/**
 * One turn that answers and reports its tokens: 1,000,000 in, none of it
 * cached, and 100,000 out. On gpt-6.1-sol ($2.00 in, $10.00 out per
 * million) that is 200¢ + 100¢.
 */
function oneTurn(model: string): FakeAppServerScenario {
  return {
    model,
    after: {
      "turn/start": [note.turnStarted(), note.agentMessage(JSON.stringify(validImplementResult)), note.tokenUsage({ input: 1_000_000, output: 100_000 }), note.turnCompleted()],
    },
  };
}

function supervisorOver(scenario: FakeAppServerScenario, guards: Partial<GuardConfig> = {}) {
  const fake = fakeAppServer(scenario);
  const provider = createCodexProvider({
    executablePath: EXECUTABLE,
    createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }),
  });
  return createRunSupervisor({ db: handle.db, limits: LIMITS, provider, guards });
}

function notes() {
  return handle.db.select().from(comments).all().filter((comment) => comment.kind === "note");
}

describe("a Codex run's cost", () => {
  it("is priced at the model the thread ran on and recorded on the run", async () => {
    await supervisorOver(oneTurn("gpt-6.1-sol")).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.costCents).toBe(300);
    expect(run.tokensIn).toBe(1_000_000);
  });

  it("trips the per-item budget, the way a Claude run does", async () => {
    await supervisorOver(oneTurn("gpt-6.1-sol"), { perItemBudgetCents: 200 }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("Per-ticket cost budget of 200¢ reached (spent 300¢ so far)");
    expect(run?.costCents).toBe(300); // recorded before the guard stopped the run
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo"); // the answer it gave was never acted on
    expect(needsAttention(handle.db, item.id)).toBe(true);
  });

  it("trips the daily budget across items, the way a Claude run does", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const otherItem = createTestItem(handle.db, { type: "story", title: "Other", stepId: "ready_to_merge" });
    const priorRun = createRun(handle.db, { itemId: otherItem.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, priorRun.id, { costCents: 400, startedAt: Date.now(), endedAt: Date.now() });

    // 400 already spent today on another item + 300 for this run > 500.
    await supervisorOver(oneTurn("gpt-6.1-sol"), { dailyBudgetCents: 500 }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("Daily cost budget of 500¢ reached");
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("stops a turn part-way at the budget, before the answer it was writing can be acted on", async () => {
    const fake = fakeAppServer({
      model: "gpt-6.1-sol",
      after: { "turn/start": [note.turnStarted(), note.tokenUsage({ input: 1_000_000, output: 100_000 }), note.agentMessage(JSON.stringify(validImplementResult)), note.turnCompleted()] },
    });
    const provider = createCodexProvider({
      executablePath: EXECUTABLE,
      createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }),
    });
    await createRunSupervisor({ db: handle.db, limits: LIMITS, provider, guards: { perItemBudgetCents: 200 } }).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(fake.sent.some((message) => message.method === "turn/interrupt")).toBe(true);
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toContain("Per-ticket cost budget of 200¢ reached");
    expect(run?.costCents).toBe(300);
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("does not start a run on an item whose budget is already spent", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const spent = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, spent.id, { costCents: 250, startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    const fake = fakeAppServer(oneTurn("gpt-6.1-sol"));
    const provider = createCodexProvider({
      executablePath: EXECUTABLE,
      createCodex: () => new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 }),
    });

    await createRunSupervisor({ db: handle.db, limits: LIMITS, provider, guards: { perItemBudgetCents: 200 } }).runOnce();

    expect(fake.launches).toHaveLength(0);
    const refused = listRunsForItem(handle.db, item.id).find((run) => run.id !== spent.id);
    expect(refused).toMatchObject({ status: "awaiting_input" });
    expect(refused?.error).toContain("Per-ticket cost budget of 200¢ reached (spent 250¢ so far)");
  });

  it("posts no note about pricing when the model has a price", async () => {
    await supervisorOver(oneTurn("gpt-6.1-sol")).runOnce();

    expect(notes().filter((comment) => comment.body.includes("no price"))).toEqual([]);
  });
});

describe("a Codex run on a model EO has no price for", () => {
  it("says so on the item once, naming the model, rather than recording zero in silence", async () => {
    await supervisorOver(oneTurn("gpt-9-imaginary"), { perItemBudgetCents: 1 }).runOnce();

    const said = notes().filter((comment) => comment.body.includes("no price"));
    expect(said).toHaveLength(1);
    expect(said[0]!.itemId).toBe(item.id);
    expect(said[0]!.body).toContain("**gpt-9-imaginary**");
    expect(said[0]!.body).toContain("per-ticket and daily budgets cannot see it");

    // Its tokens are on the run; its cost is not, which is why the
    // one-cent budget above did not stop it — and why the note exists.
    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run.tokensIn).toBe(1_000_000);
    expect(run.costCents ?? 0).toBe(0);
    expect(run.error ?? "").not.toContain("budget");
  });

  it("says it once per run, however many turns the run takes", async () => {
    // Two turns on the same run: the first answer fails the action's
    // schema, so the supervisor resumes the thread for a corrected one.
    const fake = fakeAppServer({
      model: "gpt-9-imaginary",
      after: {
        "turn/start": [note.turnStarted(), note.agentMessage('{"not":"an implement result"}'), note.tokenUsage({ input: 100, output: 10 }), note.turnCompleted()],
      },
    });
    let resumed = 0;
    const provider = createCodexProvider({
      executablePath: EXECUTABLE,
      createCodex: () => {
        const client = new CodexClient({ executablePath: EXECUTABLE, spawn: fake.spawn, shutdownGraceMs: 200 });
        return {
          startThread: (options) => client.startThread(options),
          resumeThread: (id, options) => {
            resumed += 1;
            return client.resumeThread(id, options);
          },
        };
      },
    });

    await createRunSupervisor({ db: handle.db, limits: LIMITS, provider }).runOnce();

    const runs = listRunsForItem(handle.db, item.id);
    expect(runs).toHaveLength(1);
    expect(resumed, "the run took one turn, so this proves nothing about a second").toBeGreaterThan(0);
    expect(notes().filter((comment) => comment.body.includes("no price"))).toHaveLength(1);
  });
});
