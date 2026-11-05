import { existsSync } from "node:fs";
import type { AgentEvent, AgentProvider, AgentSideCallOptions, Uuid } from "@eo/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DbHandle } from "../db/client.js";
import { listAgents } from "../db/repos/agentsRepo.js";
import { createRun, sumCostCentsForItem, sumCostCentsSince, updateRun } from "../db/repos/runsRepo.js";
import { listSideCalls } from "../db/repos/sideCallsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createFakeProvider, type FakeProviderScript } from "../providers/fake.js";
import { createSideCaller, SIDE_CALL_ABORT_GRACE_MS, SIDE_CALL_GAVE_WAY, type SideCallerOptions, type SideCallRequest } from "./sideCall.js";
import { createSideCallSlots, type SideCallSlots } from "./slots.js";

const PICKED = z.object({ picked: z.array(z.string()) });

/**
 * `sideCall` against the fake provider (EO-477): every way it can end,
 * none of them a throw, and one `side_calls` row for each.
 */
describe("sideCall", () => {
  let handle: DbHandle;
  let slots: SideCallSlots;
  let busy: number;

  beforeEach(() => {
    handle = openMigratedTestDb();
    busy = 0;
    slots = createSideCallSlots({ limit: () => 1, busy: () => busy, pollMs: 5 });
  });

  afterEach(() => {
    handle.close();
  });

  function caller(provider: AgentProvider | null, overrides: Partial<SideCallerOptions> = {}) {
    return createSideCaller({
      db: handle.db,
      provider: () => provider,
      smallModel: async () => "claude-haiku-5-5",
      guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: null }),
      slots,
      ...overrides,
    });
  }

  function request(overrides: Partial<SideCallRequest<z.infer<typeof PICKED>>> = {}): SideCallRequest<z.infer<typeof PICKED>> {
    return {
      purpose: "memory_select",
      backend: "claude",
      schema: PICKED,
      system: "Pick the entries that bear on the task.",
      input: "THE-SECRET-QUESTION: which of these matter?",
      projectId: null,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  const fake = (script: FakeProviderScript) => createFakeProvider(script);

  it("answers with the schema-parsed value and writes one row of what it cost, never what was said", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const result = await caller(fake({ result: { picked: ["ANSWER-ENTRY-ONE", "ANSWER-ENTRY-TWO"] }, usage: { tokensIn: 1_200, tokensOut: 40, costCents: 3 } })).sideCall(
      request({ itemId: item.id as Uuid, projectId: item.projectId as Uuid | null }),
    );

    expect(result).toEqual({ ok: true, value: { picked: ["ANSWER-ENTRY-ONE", "ANSWER-ENTRY-TWO"] } });
    const rows = listSideCalls(handle.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "memory_select",
      projectId: item.projectId,
      itemId: item.id,
      runId: null,
      backend: "claude",
      model: "claude-haiku-5-5",
      tokensIn: 1_200,
      tokensOut: 40,
      costMicrocents: 3_000_000,
      outcome: "succeeded",
      reason: null,
    });
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
    // No prompt and no answer: not as a column, not in any value.
    const columns = handle.db.all<{ name: string }>(sql`pragma table_info(side_calls)`).map((column) => column.name);
    expect(columns.some((name) => /prompt|input|answer|result|system|text/.test(name))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("THE-SECRET-QUESTION");
    expect(JSON.stringify(rows)).not.toContain("ANSWER-ENTRY");
  });

  it("records a call's cost below a cent, unrounded, so the budgets see it (EO-510)", async () => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const provider: AgentProvider = {
      ...fake({}),
      async *sideCall() {
        // Half a cent, which whole cents would record as nothing.
        yield { type: "usage", scope: "session", tokensIn: 3_401, tokensOut: 352, costCents: 0, costMicrocents: 500_000 } satisfies AgentEvent;
        yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
      },
    };
    const sideCaller = caller(provider);
    for (let i = 0; i < 200; i++) expect(await sideCaller.sideCall(request({ itemId: item.id as Uuid }))).toMatchObject({ ok: true });

    expect(listSideCalls(handle.db)[0]).toMatchObject({ tokensIn: 3_401, tokensOut: 352, costMicrocents: 500_000 });
    expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(100);
    expect(sumCostCentsSince(handle.db, Date.now() - 60_000)).toBe(100);
  });

  it("hands the backend the question, the schema as JSON Schema, its small model and an empty directory it removes afterwards", async () => {
    const seen: AgentSideCallOptions[] = [];
    const provider: AgentProvider = {
      ...fake({}),
      async *sideCall(opts) {
        seen.push(opts);
        expect(existsSync(opts.cwd)).toBe(true);
        yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
      },
    };
    await caller(provider).sideCall(request());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: "claude-haiku-5-5", system: "Pick the entries that bear on the task.", input: "THE-SECRET-QUESTION: which of these matter?" });
    expect(seen[0]!.outputSchema).toMatchObject({ type: "object", properties: { picked: { type: "array" } } });
    expect(existsSync(seen[0]!.cwd)).toBe(false);
  });

  it("fails with `schema` when the answer is not the shape asked for", async () => {
    const result = await caller(fake({ result: { picked: "not a list" } })).sideCall(request());

    expect(result).toMatchObject({ ok: false, reason: "schema" });
    expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "schema" });
  });

  it("fails with `error`, and a sentence, when the backend throws — it never throws itself", async () => {
    const result = await caller(fake({ throwMessage: "the CLI fell over" })).sideCall(request());

    expect(result).toEqual({ ok: false, reason: "error", message: "the CLI fell over" });
    expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "error" });
  });

  it("fails with `error`, not a throw, when what it reads before the call is broken — and still writes its one row", async () => {
    const result = await caller(fake({ result: { picked: [] } }), {
      guards: () => {
        throw new Error("the settings could not be read");
      },
    }).sideCall(request());

    expect(result).toEqual({ ok: false, reason: "error", message: "the settings could not be read" });
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ outcome: "failed", reason: "error", tokensIn: 0, costMicrocents: 0 })]);
  });

  it("fails with `error` and writes its one row when the adapter cannot be built", async () => {
    const result = await caller(null, {
      provider: () => {
        throw new Error("the Claude Agent SDK is not installed");
      },
    }).sideCall(request());

    expect(result).toEqual({ ok: false, reason: "error", message: "the Claude Agent SDK is not installed" });
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ outcome: "failed", reason: "error" })]);
  });

  it("fails with `error` on a backend that makes no side calls", async () => {
    const result = await caller(null).sideCall(request({ backend: "fake" }));
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(listSideCalls(handle.db)).toHaveLength(1);
  });

  it("fails with `signed_out` when the backend says nobody is logged in", async () => {
    const result = await caller(fake({ throwMessage: "Not logged in · Please run /login" })).sideCall(request());
    expect(result).toMatchObject({ ok: false, reason: "signed_out" });
  });

  it("fails with `signed_out` before any model call when the runtime has no sign-in", async () => {
    const provider = fake({ result: { picked: [] } });
    const sideCall = vi.spyOn(provider, "sideCall" as never);
    const result = await caller(provider, { signedIn: async () => false }).sideCall(request());

    expect(result).toMatchObject({ ok: false, reason: "signed_out" });
    expect(sideCall).not.toHaveBeenCalled();
    expect(listSideCalls(handle.db)[0]).toMatchObject({ reason: "signed_out", tokensIn: 0 });
  });

  it("fails with `sign_in_unreachable`, not `error`, before any probe or model call when the sign-in cannot reach the call's own home (EO-509)", async () => {
    const provider = fake({ result: { picked: [] } });
    const sideCall = vi.spyOn(provider, "sideCall" as never);
    const signedIn = vi.fn(async () => true);
    const smallModel = vi.fn(async () => null);
    const sentence = "Set cli_auth_credentials_store = \"file\" and sign in to Codex again.";
    const result = await caller(provider, { signedIn, smallModel, signInUnreachable: (backend) => (backend === "codex" ? sentence : null) }).sideCall(
      request({ backend: "codex" }),
    );

    expect(result).toEqual({ ok: false, reason: "sign_in_unreachable", message: sentence });
    expect(sideCall).not.toHaveBeenCalled();
    expect(signedIn).not.toHaveBeenCalled();
    expect(smallModel).not.toHaveBeenCalled();
    expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ backend: "codex", outcome: "failed", reason: "sign_in_unreachable", tokensIn: 0 })]);
  });

  it("makes the call as usual where the sign-in reaches it", async () => {
    const result = await caller(fake({ result: { picked: ["a"] } }), { signInUnreachable: () => null }).sideCall(request());
    expect(result).toEqual({ ok: true, value: { picked: ["a"] } });
  });

  it("fails with `quota` when the backend's plan refused it", async () => {
    const provider: AgentProvider = {
      ...fake({}),
      async *sideCall() {
        yield { type: "quota", provider: "claude", window: "five_hour", status: "rejected" } satisfies AgentEvent;
        yield { type: "error", message: "You've hit your limit", retryable: true } satisfies AgentEvent;
      },
    };
    expect(await caller(provider).sideCall(request())).toMatchObject({ ok: false, reason: "quota" });
  });

  it("fails with `budget` when the backend stopped it at the cap it was handed", async () => {
    const seen: AgentSideCallOptions[] = [];
    const provider: AgentProvider = {
      ...fake({}),
      async *sideCall(opts) {
        seen.push(opts);
        yield { type: "usage", scope: "session", tokensIn: 10, tokensOut: 1, costCents: 7 } satisfies AgentEvent;
        yield { type: "error", message: "stopped at the budget", retryable: false, budget: true } satisfies AgentEvent;
      },
    };
    const result = await caller(provider, { guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: 7 }) }).sideCall(request());

    expect(result).toMatchObject({ ok: false, reason: "budget" });
    // What the day had left is the cap the backend held it to.
    expect(seen[0]!.budgetCents).toBe(7);
    expect(listSideCalls(handle.db)[0]).toMatchObject({ reason: "budget", costMicrocents: 7_000_000 });
  });

  describe("refused with `budget` and no model call", () => {
    function spentRun(itemId: string, costCents: number): void {
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      const run = createRun(handle.db, { itemId: itemId as Uuid, agentId: implementer.id, action: "implement", status: "succeeded" });
      updateRun(handle.db, run.id, { costCents, startedAt: Date.now() - 60_000, endedAt: Date.now() - 30_000 });
    }

    it("when the daily budget is spent", async () => {
      const elsewhere = createTestItem(handle.db, { type: "story", title: "Other work", stepId: "todo" });
      spentRun(elsewhere.id, 500);
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);

      const result = await caller(provider, { guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: 500 }) }).sideCall(request());

      expect(result).toMatchObject({ ok: false, reason: "budget" });
      expect((result as { message: string }).message).toContain("daily budget");
      expect(sideCall).not.toHaveBeenCalled();
      expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "budget", tokensIn: 0, costMicrocents: 0 });
    });

    it("when its item's budget is spent", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "Expensive", stepId: "todo" });
      spentRun(item.id, 200);
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);

      const result = await caller(provider, { guards: () => ({ perItemBudgetCents: 200, dailyBudgetCents: null }) }).sideCall(request({ itemId: item.id as Uuid }));

      expect(result).toMatchObject({ ok: false, reason: "budget" });
      expect((result as { message: string }).message).toContain("item's budget");
      expect(sideCall).not.toHaveBeenCalled();
    });

    it("counting side calls already made, not only runs", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "Remembered", stepId: "todo" });
      const spender = caller(fake({ result: { picked: [] }, usage: { tokensIn: 1, tokensOut: 1, costCents: 50 } }), {
        guards: () => ({ perItemBudgetCents: 50, dailyBudgetCents: null }),
      });

      expect(await spender.sideCall(request({ itemId: item.id as Uuid }))).toMatchObject({ ok: true });
      expect(await spender.sideCall(request({ itemId: item.id as Uuid }))).toMatchObject({ ok: false, reason: "budget" });
    });
  });

  it("is stopped and answers `timeout` when it runs past its time", async () => {
    const result = await caller(fake({ steps: [{ sleepMs: 5_000 }], result: { picked: [] } })).sideCall(request({ timeoutMs: 30 }));

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(listSideCalls(handle.db)[0]).toMatchObject({ reason: "timeout" });
  });

  it("is stopped by EO's shutdown, waiting or running, and starts no more afterwards", async () => {
    const sideCaller = caller(fake({ steps: [{ sleepMs: 5_000 }], result: { picked: [] } }));
    const running = sideCaller.sideCall(request());
    // A second one, queued behind the first for the one slot.
    const waiting = sideCaller.sideCall(request());
    await vi.waitFor(() => expect(sideCaller.inFlight()).toBe(2));

    sideCaller.abortAll();

    expect(await running).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shut down") });
    expect(await waiting).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shut down") });
    expect(await sideCaller.sideCall(request())).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shutting down") });
    expect(slots.held()).toBe(0);
    expect(slots.waiting()).toBe(0);
  });

  describe("concurrency (invariant 10)", () => {
    it("on its own, takes a global slot for as long as it runs and gives it back", async () => {
      let heldDuring = -1;
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall() {
          heldDuring = slots.held();
          yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };
      await caller(provider).sideCall(request());

      expect(heldDuring).toBe(1);
      expect(slots.held()).toBe(0);
    });

    it("on its own, waits while every slot is busy and starts when one frees", async () => {
      busy = 1;
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);
      const pending = caller(provider).sideCall(request());

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(sideCall).not.toHaveBeenCalled();
      expect(slots.waiting()).toBe(1);

      busy = 0;
      expect(await pending).toMatchObject({ ok: true });
      expect(sideCall).toHaveBeenCalledOnce();
    });

    it("inside a run, uses that run's slot and takes no second one", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "Dispatched", stepId: "todo" });
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
      // The run holds the only slot there is.
      busy = 1;
      let heldDuring = -1;
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall() {
          heldDuring = slots.held();
          yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };

      const result = await caller(provider).sideCall(request({ insideRunId: run.id, projectId: item.projectId as Uuid | null }));

      expect(result).toMatchObject({ ok: true });
      expect(heldDuring).toBe(0);
      // And the row says which run, and — read off the run — which item.
      expect(listSideCalls(handle.db)[0]).toMatchObject({ runId: run.id, itemId: item.id });
    });

    it("waiting for a slot counts against its timeout", async () => {
      busy = 1;
      expect(await caller(fake({ result: { picked: [] } })).sideCall(request({ timeoutMs: 30 }))).toMatchObject({ ok: false, reason: "timeout" });
      expect(slots.waiting()).toBe(0);
    });
  });

  describe("held short (EO-577)", () => {
    /**
     * A backend that writes the same piece of an answer over and over until
     * it is wound down, and then — as both adapters do — ends its turn
     * saying what it spent: `spent`, or nothing when `deaf`, which also
     * never hears the wind-down and only stops at the hard stop.
     */
    function runaway(piece: string, spent: { tokensOut: number; costMicrocents: number } | null = { tokensOut: 1_800, costMicrocents: 2_500_000 }, deaf = false) {
      const state = { pieces: 0, stopped: false, woundDown: false };
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall(opts) {
          try {
            while (!opts.signal.aborted && (deaf || !opts.windDown?.aborted)) {
              state.pieces += 1;
              yield { type: "output_delta", stream: "text", text: piece } satisfies AgentEvent;
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (opts.signal.aborted) return;
            state.woundDown = true;
            // Interrupted, the turn ends: the result that closes it says what it spent.
            if (spent) yield { type: "usage", scope: "session", tokensIn: 3_000, tokensOut: spent.tokensOut, costCents: 0, costMicrocents: spent.costMicrocents } satisfies AgentEvent;
            yield { type: "error", message: "Claude run ended: error_during_execution", retryable: true } satisfies AgentEvent;
          } finally {
            state.stopped = true;
          }
        },
      };
      return { provider, state };
    }

    it("cuts an answer off as it is written once it passes its output-token cap, counting a byte a token, and answers `timeout`", async () => {
      const { provider, state } = runaway("x".repeat(400));
      const result = await caller(provider).sideCall(request({ maxOutputTokens: 1_000, timeoutMs: 60_000 }));

      expect(result).toEqual({ ok: false, reason: "timeout", message: "The answer ran past its cap of 1000 output tokens and was cut off." });
      // 1,200 bytes after the third piece is past 1,000: no fourth is asked for.
      expect(state.pieces).toBe(3);
      expect(state.woundDown).toBe(true);
      expect(state.stopped).toBe(true);
      expect(slots.held()).toBe(0);
    });

    it("never lets text that takes more tokens than four characters each slip past the cap: code, punctuation and non-Latin text are counted by their bytes", async () => {
      // 100 characters, 300 bytes: four characters a token would let 4,000 characters — 12,000 bytes — through a cap of 1,000.
      const japanese = runaway("記憶の統合".repeat(20));
      expect(await caller(japanese.provider).sideCall(request({ maxOutputTokens: 1_000, timeoutMs: 60_000 }))).toMatchObject({ ok: false, reason: "timeout" });
      expect(japanese.state.pieces).toBe(4);
      // Punctuation-heavy JSON, which BPE tokenizers split nearly a token a character.
      const punctuation = runaway('{"a":[1,2],"b":"}"},'.repeat(10));
      expect(await caller(punctuation.provider).sideCall(request({ maxOutputTokens: 1_000, timeoutMs: 60_000 }))).toMatchObject({ ok: false, reason: "timeout" });
      expect(punctuation.state.pieces * 200).toBeLessThanOrEqual(1_000 + 200);
    });

    it("cuts off at the output tokens the backend reports, where they pass the cap first", async () => {
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall(opts) {
          // Reasoning it never streams, reported as spent.
          yield { type: "usage", scope: "turn", tokensIn: 1_000, tokensOut: 5_000, costCents: 1 } satisfies AgentEvent;
          if (!opts.windDown?.aborted) yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };
      expect(await caller(provider).sideCall(request({ maxOutputTokens: 1_000 }))).toMatchObject({ ok: false, reason: "timeout" });
      expect(listSideCalls(handle.db)[0]).toMatchObject({ tokensOut: 5_000, reason: "timeout" });
    });

    it("records the tokens and cost a call cut off at its cap spent, read from the end of its turn after it is wound down", async () => {
      const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
      const { provider, state } = runaway("x".repeat(400));
      const result = await caller(provider).sideCall(request({ maxOutputTokens: 1_000, itemId: item.id as Uuid }));

      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect(state.woundDown).toBe(true);
      expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "timeout", tokensIn: 3_000, tokensOut: 1_800, costMicrocents: 2_500_000 });
      // And the budgets see it.
      expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(3);
    });

    it("stops a backend that does not wind down outright once its few seconds are up, still answering `timeout`", async () => {
      const { provider, state } = runaway("x".repeat(400), null, true);
      const started = Date.now();
      const result = await caller(provider, { windDownMs: 50 }).sideCall(request({ maxOutputTokens: 1_000, timeoutMs: 60_000 }));

      expect(result).toEqual({ ok: false, reason: "timeout", message: "The answer ran past its cap of 1000 output tokens and was cut off." });
      expect(state.stopped).toBe(true);
      expect(state.woundDown).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(slots.held()).toBe(0);
    });

    it("has no cap but its time without `maxOutputTokens`", async () => {
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall() {
          for (let piece = 0; piece < 100; piece += 1) yield { type: "output_delta", stream: "text", text: "x".repeat(1_000) } satisfies AgentEvent;
          yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };
      expect(await caller(provider).sideCall(request())).toMatchObject({ ok: true });
    });

    it("gives way, with no model call and no slot taken, when pipeline work is waiting at the moment it would take the slot", async () => {
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);
      const acquire = vi.spyOn(slots, "acquire");
      const asked: string[] = [];
      const sideCaller = caller(provider, {
        smallModel: async () => {
          asked.push("small model");
          return "claude-haiku-5-5";
        },
      });

      const result = await sideCaller.sideCall(
        request({
          giveWay: () => {
            asked.push("give way");
            return true;
          },
        }),
      );

      expect(result).toEqual({ ok: false, reason: "error", message: SIDE_CALL_GAVE_WAY });
      // Asked last, after everything that could take a while.
      expect(asked).toEqual(["small model", "give way"]);
      expect(sideCall).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(slots.reserved()).toBe(0);
      expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "error" });
      // Nothing waiting: made as usual. And never asked inside a run, which takes no slot.
      expect(await sideCaller.sideCall(request({ giveWay: () => false }))).toMatchObject({ ok: true });
    });

    it("says how long a call made on its own held its slot, and nothing for one that took none", async () => {
      let clock = 1_000_000;
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall() {
          clock += 2_500;
          yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };
      const sideCaller = caller(provider, {
        now: () => clock,
        smallModel: async () => {
          // Before the slot is taken: not counted.
          clock += 700;
          return "claude-haiku-5-5";
        },
      });
      const held: number[] = [];
      const onSlotHeld = (ms: number) => held.push(ms);
      expect(await sideCaller.sideCall(request({ onSlotHeld }))).toEqual({ ok: true, value: { picked: [] } });
      expect(held).toEqual([2_500]);

      const item = createTestItem(handle.db, { type: "story", title: "Dispatched", stepId: "todo" });
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "running" });
      await sideCaller.sideCall(request({ insideRunId: run.id, onSlotHeld }));
      await sideCaller.sideCall(request({ giveWay: () => true, onSlotHeld }));
      expect(held).toEqual([2_500]);
    });
  });

  describe("the budget, asked again when the call is about to be made", () => {
    function spendToday(costCents: number): void {
      const item = createTestItem(handle.db, { type: "story", title: "Spending meanwhile", stepId: "todo" });
      const implementer = listAgents(handle.db).find((agent) => agent.role === "implementer")!;
      const run = createRun(handle.db, { itemId: item.id, agentId: implementer.id, action: "implement", status: "succeeded" });
      updateRun(handle.db, run.id, { costCents, startedAt: Date.now(), endedAt: Date.now() });
    }

    it("is refused with `budget`, and no model call, when a run spends the day's last cents while it waits for a slot", async () => {
      busy = 1;
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);
      const pending = caller(provider, { guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: 100 }) }).sideCall(request());
      await vi.waitFor(() => expect(slots.waiting()).toBe(1));

      // The run holding the slot spends what the day had left, and ends.
      spendToday(100);
      busy = 0;

      expect(await pending).toMatchObject({ ok: false, reason: "budget", message: expect.stringContaining("daily budget") });
      expect(sideCall).not.toHaveBeenCalled();
      expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ reason: "budget", tokensIn: 0 })]);
    });

    it("is capped at what is left once it starts, not at what was left when it was asked for", async () => {
      busy = 1;
      const seen: AgentSideCallOptions[] = [];
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall(opts) {
          seen.push(opts);
          yield { type: "result", data: { picked: [] } } satisfies AgentEvent;
        },
      };
      const pending = caller(provider, { guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: 100 }) }).sideCall(request());
      await vi.waitFor(() => expect(slots.waiting()).toBe(1));

      spendToday(70);
      busy = 0;

      expect(await pending).toMatchObject({ ok: true });
      expect(seen[0]!.budgetCents).toBe(30);
    });
  });

  describe("stopped while it is still getting ready", () => {
    /** A preflight step that never answers on its own, and says when it was told to stop. */
    function hanging() {
      const signals: AbortSignal[] = [];
      const step = (_backend: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      };
      return { step, signals };
    }

    it("times out promptly while the sign-in is being asked, and tells the probe to stop", async () => {
      const probe = hanging();
      const provider = fake({ result: { picked: [] } });
      const sideCall = vi.spyOn(provider, "sideCall" as never);
      const started = Date.now();

      const result = await caller(provider, { signedIn: probe.step }).sideCall(request({ timeoutMs: 40 }));

      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(probe.signals[0]!.aborted).toBe(true);
      expect(sideCall).not.toHaveBeenCalled();
      expect(listSideCalls(handle.db)).toEqual([expect.objectContaining({ reason: "timeout" })]);
    });

    it("times out promptly while the small model is being looked up, and tells the lookup to stop", async () => {
      const lookup = hanging();
      const result = await caller(fake({ result: { picked: [] } }), { smallModel: lookup.step }).sideCall(request({ timeoutMs: 40 }));

      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expect(lookup.signals[0]!.aborted).toBe(true);
    });

    it("answers `timeout`, not `signed_out`, when the sign-in answers no only after the deadline", async () => {
      const result = await caller(fake({ result: { picked: [] } }), {
        signedIn: () => new Promise((resolve) => setTimeout(() => resolve(false), 80)),
      }).sideCall(request({ timeoutMs: 20 }));

      expect(result).toMatchObject({ ok: false, reason: "timeout" });
    });

    it("is stopped by EO's shutdown during either step", async () => {
      for (const step of ["signedIn", "smallModel"] as const) {
        const hang = hanging();
        const sideCaller = caller(fake({ result: { picked: [] } }), { [step]: hang.step });
        const pending = sideCaller.sideCall(request({ timeoutMs: 60_000 }));
        await vi.waitFor(() => expect(hang.signals).toHaveLength(1));

        sideCaller.abortAll();

        expect(await pending, step).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shut down") });
        expect(hang.signals[0]!.aborted, step).toBe(true);
      }
    });
  });

  it("settles at its deadline, and at shutdown, though the backend never notices its signal", async () => {
    const deaf: AgentProvider = {
      ...fake({}),
      async *sideCall() {
        yield { type: "usage", scope: "session", tokensIn: 5, tokensOut: 1, costCents: 1 } satisfies AgentEvent;
        await new Promise(() => {});
      },
    };
    expect(await caller(deaf).sideCall(request({ timeoutMs: 30 }))).toMatchObject({ ok: false, reason: "timeout" });
    const sideCaller = caller(deaf);
    const pending = sideCaller.sideCall(request({ timeoutMs: 60_000 }));
    await vi.waitFor(() => expect(sideCaller.inFlight()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    sideCaller.abortAll();
    expect(await pending).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("shut down") });
    // What it spent before it was stopped is still counted.
    expect(listSideCalls(handle.db).map((row) => row.costMicrocents)).toEqual([1_000_000, 1_000_000]);
  });

  /** A backend that hears its signal and, as it stops, reports what the call spent — a little after the abort. */
  function spendsAsItStops(delayMs = 10): AgentProvider {
    return {
      ...fake({}),
      async *sideCall(opts) {
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: "usage", scope: "session", tokensIn: 123, tokensOut: 456, costCents: 7 } satisfies AgentEvent;
        yield { type: "error", message: "Claude run ended: aborted", retryable: true } satisfies AgentEvent;
      },
    };
  }

  it.each(["timeout", "shutdown", "caller"] as const)("records the usage a backend reports as it stops, after a %s, and the budgets count it", async (how) => {
    const item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo" });
    const sideCaller = caller(spendsAsItStops());
    const controller = new AbortController();
    const pending = sideCaller.sideCall(request({ itemId: item.id as Uuid, timeoutMs: how === "timeout" ? 30 : 60_000, signal: controller.signal }));
    if (how !== "timeout") {
      await vi.waitFor(() => expect(sideCaller.inFlight()).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (how === "shutdown") sideCaller.abortAll();
      else controller.abort();
    }

    const result = await pending;
    expect(result).toMatchObject({ ok: false, reason: how === "timeout" ? "timeout" : "error" });
    expect(listSideCalls(handle.db)[0]).toMatchObject({ tokensIn: 123, tokensOut: 456, costMicrocents: 7_000_000 });
    expect(sumCostCentsForItem(handle.db, item.id as Uuid)).toBe(7);
    expect(sumCostCentsSince(handle.db, Date.now() - 60_000)).toBe(7);
  });

  it("stops reading a stopped backend at the grace, however long it keeps reporting, and counts what it reported until then", async () => {
    const chatty: AgentProvider = {
      ...fake({}),
      async *sideCall(opts) {
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
        for (;;) {
          yield { type: "usage", scope: "turn", tokensIn: 1, tokensOut: 1, costCents: 0, costMicrocents: 1 } satisfies AgentEvent;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
    };
    const started = Date.now();
    expect(await caller(chatty).sideCall(request({ timeoutMs: 30 }))).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(SIDE_CALL_ABORT_GRACE_MS + 1_000);
    expect(listSideCalls(handle.db)[0]!.tokensIn).toBeGreaterThan(0);
  });

  it("answers `error` when its caller aborts it", async () => {
    const controller = new AbortController();
    const pending = caller(fake({ steps: [{ sleepMs: 5_000 }], result: { picked: [] } })).sideCall(request({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("cancelled") });
  });

  /**
   * Which model a call runs on (EO-578): selection and extraction on the
   * backend's small model with no effort, consolidation on the system
   * agent's model and effort, handed to it on the request.
   */
  describe("its model and reasoning effort", () => {
    function seeing(events: AgentEvent[] = [{ type: "result", data: { picked: [] } }]) {
      const seen: AgentSideCallOptions[] = [];
      const provider: AgentProvider = {
        ...fake({}),
        async *sideCall(opts) {
          seen.push(opts);
          for (const event of events) yield event;
        },
      };
      return { provider, seen };
    }

    it.each(["memory_select", "memory_extract"] as const)("runs %s on the small model with no effort set, whatever the request names", async (purpose) => {
      const { provider, seen } = seeing();
      await caller(provider).sideCall(request({ purpose, model: { model: "claude-opus-5-5", reasoningEffort: "xhigh" } }));

      expect(seen[0]!.model).toBe("claude-haiku-5-5");
      expect("reasoningEffort" in seen[0]!).toBe(false);
      expect(listSideCalls(handle.db)[0]).toMatchObject({ purpose, model: "claude-haiku-5-5" });
    });

    it("runs memory_consolidate on the model and effort it was given, never asking for the small model, and records that model", async () => {
      const { provider, seen } = seeing([
        { type: "usage", scope: "session", tokensIn: 50_000, tokensOut: 2_000, costCents: 40 },
        { type: "result", data: { picked: [] } },
      ]);
      const smallModel = vi.fn(async () => "claude-haiku-5-5");
      const result = await caller(provider, { smallModel }).sideCall(request({ purpose: "memory_consolidate", model: { model: "claude-opus-5-5", reasoningEffort: "high" } }));

      expect(result).toMatchObject({ ok: true });
      expect(seen[0]).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "high" });
      expect(smallModel).not.toHaveBeenCalled();
      // The model used, and a cost the budgets count like any other call's.
      expect(listSideCalls(handle.db)[0]).toMatchObject({ purpose: "memory_consolidate", model: "claude-opus-5-5", costMicrocents: 40_000_000 });
      expect(sumCostCentsSince(handle.db, Date.now() - 60_000)).toBe(40);
      const refused = await caller(provider, { guards: () => ({ perItemBudgetCents: null, dailyBudgetCents: 40 }) }).sideCall(request({ purpose: "memory_consolidate", model: { model: "claude-opus-5-5", reasoningEffort: null } }));
      expect(refused).toMatchObject({ ok: false, reason: "budget" });
    });

    it("sets no effort where the system agent has none", async () => {
      const { provider, seen } = seeing();
      await caller(provider).sideCall(request({ purpose: "memory_consolidate", model: { model: "claude-opus-5-5", reasoningEffort: null } }));
      expect(seen[0]!.model).toBe("claude-opus-5-5");
      expect("reasoningEffort" in seen[0]!).toBe(false);
    });

    it("runs on the backend's default for agents where no model is named, and records the model the backend says answered", async () => {
      const { provider, seen } = seeing([
        { type: "thread_started", threadId: "t", model: "gpt-6.1-sol" },
        { type: "result", data: { picked: [] } },
      ]);
      const defaultModel = vi.fn(async (_backend: string, _signal: AbortSignal) => "gpt-6.1-sol");
      await caller(provider, { defaultModel }).sideCall(request({ purpose: "memory_consolidate", backend: "codex", model: { model: null, reasoningEffort: "medium" } }));

      expect(defaultModel).toHaveBeenCalledWith("codex", expect.any(AbortSignal));
      expect(seen[0]).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "medium" });
      expect(listSideCalls(handle.db)[0]).toMatchObject({ backend: "codex", model: "gpt-6.1-sol" });
    });

    it("records the model the backend reports over the one asked for", async () => {
      const { provider } = seeing([
        { type: "usage", scope: "session", tokensIn: 1, tokensOut: 1, costCents: 0, model: "claude-opus-5-5-20261001" },
        { type: "result", data: { picked: [] } },
      ]);
      await caller(provider).sideCall(request({ purpose: "memory_consolidate", model: { model: null, reasoningEffort: null } }));
      expect(listSideCalls(handle.db)[0]).toMatchObject({ model: "claude-opus-5-5-20261001" });
    });

    it("fails a call on the system agent's model that was handed none, rather than taking the small one", async () => {
      const { provider, seen } = seeing();
      const result = await caller(provider).sideCall(request({ purpose: "memory_consolidate" }));
      expect(result).toMatchObject({ ok: false, reason: "error", message: expect.stringContaining("system agent's model") });
      expect(seen).toEqual([]);
      expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "error" });
    });

    it.each([
      ["Claude's CLI", "There's an issue with the selected model (claude-opus-9). It may not exist or you may not have access to it."],
      ["Claude's API", 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-9"}}'],
      ["Codex's catalogue", "Codex's model catalogue does not name claude-opus-9 on this machine, so EO cannot switch its tools off and did not make the call."],
      ["Codex's service", "The 'claude-opus-9' model is not supported when using Codex with a ChatGPT account."],
    ])("fails a model the backend cannot run with a sentence naming the model, from %s", async (_from, message) => {
      const { provider } = seeing([{ type: "error", message, retryable: false }]);
      const result = await caller(provider).sideCall(request({ purpose: "memory_consolidate", model: { model: "claude-opus-9", reasoningEffort: "high" } }));

      expect(result).toEqual({ ok: false, reason: "error", message: `The claude backend cannot run the model "claude-opus-9": ${message}` });
      expect(listSideCalls(handle.db)[0]).toMatchObject({ outcome: "failed", reason: "error", model: "claude-opus-9" });
    });

    it("leaves any other failure in the backend's own words", async () => {
      const { provider } = seeing([{ type: "error", message: "The model returned invalid output and the CLI gave up.", retryable: false }]);
      const result = await caller(provider).sideCall(request({ purpose: "memory_consolidate", model: { model: "claude-opus-5-5", reasoningEffort: null } }));
      expect(result).toEqual({ ok: false, reason: "error", message: "The model returned invalid output and the CLI gave up." });
    });
  });
});
