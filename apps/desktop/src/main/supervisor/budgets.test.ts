import type { AgentEvent, AgentProvider, Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgents } from "../db/repos/agentsRepo.js";
import { listCommentsForItem } from "../db/repos/commentsRepo.js";
import { createRun, listRunsForItem, updateRun } from "../db/repos/runsRepo.js";
import type { DbHandle } from "../db/client.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { validImplementResult } from "../providers/fixtures.js";
import { createRunSupervisor } from "./runSupervisor.js";

const LIMITS = { globalConcurrency: 1, perAgentConcurrency: 1, perRepositoryConcurrency: 1 };

/**
 * The budgets during a turn (`AgentTurnOverrides.budgetCents`): a backend
 * that stops a turn at the cap it was given is a budget stop, said the
 * way the guard says it, and a preview — which spends nothing — is never
 * held to one.
 */
describe("a run held to its budget", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = openMigratedTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("is parked with the budget's own words when its backend stops the turn at the cap, not failed", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    // How Claude's CLI ends a turn at `maxBudgetUsd`: what it spent, then a
    // budget stop — here before EO's own figures show the budget gone.
    const start: AgentProvider["start"] = async function* () {
      yield { type: "thread_started", threadId: "the-capped-thread" } satisfies AgentEvent;
      yield { type: "usage", scope: "session", tokensIn: 900, tokensOut: 40, costCents: 30 } satisfies AgentEvent;
      yield { type: "error", message: "Claude run stopped at the budget it was given.", retryable: false, budget: true } satisfies AgentEvent;
    };
    const supervisor = createRunSupervisor({
      db: handle.db,
      provider: { ...createFakeProvider({ result: validImplementResult }), start },
      limits: LIMITS,
      guards: { perItemBudgetCents: 100 },
    });

    await supervisor.runOnce();
    await supervisor.waitForIdle();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    expect(run).toMatchObject({ status: "awaiting_input", costCents: 30 });
    expect(run.error).toContain("Stopped at what this run was allowed to spend");
    expect(run.error).toContain("Guardrails");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.kind === "escalation")).toBe(true);
  });

  it("runs a preview on a day whose budget is spent: a preview spends nothing and is never asked to authorize spend", async () => {
    const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
    const elsewhere = createTestItem(handle.db, { type: "story", title: "Real work", stepId: "ready_to_merge" });
    const spent = createRun(handle.db, { itemId: elsewhere.id, agentId: implementer.id, action: "implement", status: "succeeded" });
    updateRun(handle.db, spent.id, { costCents: 600, startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    const preview: Item = createTestItem(handle.db, { type: "story", title: "Weekly report", stepId: "todo", previewAt: Date.now() });
    const fake = createFakeProvider({ result: validImplementResult });
    const start = vi.fn(fake.start.bind(fake));

    await createRunSupervisor({ db: handle.db, provider: { ...fake, start }, limits: LIMITS, guards: { dailyBudgetCents: 500 } }).runOnce();

    expect(start).toHaveBeenCalledOnce();
    expect((start.mock.calls[0]?.[0] as { budgetCents?: number }).budgetCents).toBeUndefined();
    expect(listRunsForItem(handle.db, preview.id)[0]?.status).toBe("succeeded");
  });
});
