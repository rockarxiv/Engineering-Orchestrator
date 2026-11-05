import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIMES } from "../runtimes/catalog.js";
import { CODEX_MODEL_PRICES, CODEX_PRICES_SOURCE, codexModelPrice, codexTurnCostCents, codexTurnCostMicrocents } from "./codexPricing.js";

/**
 * What `model/list` answered on the pinned Codex, captured from the
 * binary itself rather than written by hand — so a table that is
 * missing a model fails here, not on a run the budgets silently let
 * through.
 *
 * Named by the version EO pins, so bumping the pin without capturing
 * the new binary's list fails the first case below rather than checking
 * the table against a list nobody runs any more. To capture: start
 * `codex app-server` from the new binary, `initialize`, and page
 * `model/list` with `includeHidden: false` — the request
 * `codexModels.ts` makes — keeping every page's `data`.
 */
const PINNED = RUNTIMES.codex.version;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", `codex-${PINNED}-model-list.json`);
const fixture = (existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : { capturedFrom: "", data: [] }) as { capturedFrom: string; data: { model: string; hidden: boolean }[] };

describe("the Codex price table", () => {
  it("was captured from the Codex EO pins", () => {
    expect(existsSync(FIXTURE), `no model/list captured from Codex ${PINNED}: capture one at ${FIXTURE}`).toBe(true);
    expect(fixture.capturedFrom).toContain(`codex app-server ${PINNED}`);
    // Non-vacuous: an empty capture would satisfy the next case.
    expect(fixture.data.length).toBeGreaterThan(0);
  });

  it.each(fixture.data.map((entry) => entry.model))("prices %s, which the pinned Codex lists", (model) => {
    const price = codexModelPrice(model);
    expect(price, `${model} is listed by the pinned Codex and has no price in codexPricing.ts`).not.toBeNull();
    // A price of zero is the failure this table exists to end, written down.
    expect(price!.inputCentsPerMillion).toBeGreaterThan(0);
    expect(price!.cachedInputCentsPerMillion).toBeGreaterThan(0);
    expect(price!.outputCentsPerMillion).toBeGreaterThan(0);
    // Cached input is the cheap kind on every model OpenAI lists.
    expect(price!.cachedInputCentsPerMillion).toBeLessThan(price!.inputCentsPerMillion);
  });

  it("says where its numbers came from and when they were read", () => {
    expect(CODEX_PRICES_SOURCE.url).toMatch(/^https:\/\/developers\.openai\.com\//);
    expect(CODEX_PRICES_SOURCE.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "codexPricing.ts"), "utf8");
    expect(source).toContain(CODEX_PRICES_SOURCE.url);
    expect(source).toContain(`Read on ${CODEX_PRICES_SOURCE.readOn}`);
  });

  it("knows no price for a model it was never told about, and does not reach the prototype for one", () => {
    expect(codexModelPrice("gpt-9-imaginary")).toBeNull();
    expect(codexModelPrice("constructor")).toBeNull();
    expect(codexModelPrice("toString")).toBeNull();
  });

  it("holds only whole-model entries with every price set", () => {
    for (const [model, price] of Object.entries(CODEX_MODEL_PRICES)) {
      expect(Object.keys(price).sort(), model).toEqual(["cachedInputCentsPerMillion", "inputCentsPerMillion", "outputCentsPerMillion"]);
    }
  });
});

describe("a Codex turn's cost", () => {
  const price = { inputCentsPerMillion: 200, cachedInputCentsPerMillion: 10, outputCentsPerMillion: 1_000 };

  it("is uncached input, cached input and output, each at its own price", () => {
    // 3M in, of which 2M cached: 1M × 200¢ + 2M × 10¢ + 0.5M × 1,000¢.
    expect(codexTurnCostCents({ input_tokens: 3_000_000, cached_input_tokens: 2_000_000, output_tokens: 500_000 }, price)).toBe(200 + 20 + 500);
  });

  it("does not charge the cached share at the input rate as well, since Codex counts it inside input", () => {
    // All of it cached: 1M × 10¢, not 1M × 200¢ + 1M × 10¢.
    expect(codexTurnCostCents({ input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 0 }, price)).toBe(10);
  });

  it("matches the table's own price for a real model", () => {
    // gpt-5.6-luna at $0.20 / $0.02 / $1.20: 400k uncached, 600k cached, 50k out
    // = 8¢ + 1.2¢ + 6¢ = 15.2¢.
    expect(codexTurnCostCents({ input_tokens: 1_000_000, cached_input_tokens: 600_000, output_tokens: 50_000 }, codexModelPrice("gpt-5.6-luna")!)).toBe(15);
  });

  it("rounds to whole cents, which is what a run records", () => {
    expect(codexTurnCostCents({ input_tokens: 2_500, cached_input_tokens: 0, output_tokens: 0 }, price)).toBe(1); // 0.5¢
    expect(codexTurnCostCents({ input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 0 }, price)).toBe(0); // 0.4¢
  });

  it("is exact to the micro-cent before it is rounded, which is what a side call records (EO-510)", () => {
    // A memory call on gpt-6-luna at $0.10 / $0.01 / $0.50: 3,000 uncached
    // in and 200 out = 30,000 + 10,000 millionths of a cent = 0.04¢,
    // which whole cents record as nothing.
    const usage = { input_tokens: 3_000, cached_input_tokens: 0, output_tokens: 200 };
    const luna = codexModelPrice("gpt-6-luna")!;
    expect(codexTurnCostMicrocents(usage, luna)).toBe(40_000);
    expect(codexTurnCostCents(usage, luna)).toBe(0);
    // Cached input at its own rate here too: 1,000 of 4,000 cached.
    expect(codexTurnCostMicrocents({ input_tokens: 4_000, cached_input_tokens: 1_000, output_tokens: 0 }, luna)).toBe(30_000 + 1_000);
  });

  it("never prices a cached share larger than the input it is part of", () => {
    expect(codexTurnCostCents({ input_tokens: 1_000_000, cached_input_tokens: 5_000_000, output_tokens: 0 }, price)).toBe(10);
  });
});
