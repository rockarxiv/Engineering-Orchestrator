// What a Codex turn costs, by EO's own reckoning (EO-374).
//
// Codex reports tokens and never money. The daily and per-item budgets
// (E-05) are in cents, so until this table existed every Codex run cost
// nothing and no budget ever stopped one. These are **EO's stated
// estimates**, read off OpenAI's published price list by a person — not
// a figure the backend reported, and not a bill. A run's `cost_cents`
// on Codex is what these numbers say it cost.
//
// Source: https://developers.openai.com/api/docs/pricing
// (`platform.openai.com/docs/pricing` redirects there), the Standard
// tier's "Short context" columns. Read on 2026-10-08.
//
// What the table deliberately leaves out, so nobody has to rediscover it:
//
// - **Cache writes.** The page prices them separately for the newest
//   models (gpt-6.1-sol: $2.50 against $2.00 for input). Codex reports
//   `cache_write_input_tokens`, but does not say whether they sit inside
//   `input_tokens` or beside it (`codex.ts`, `usageEvent`), so they are
//   priced as the uncached input they are counted in.
// - **Long context.** The page charges more for a request over 272K
//   tokens. Codex reports a turn's tokens summed over its requests, not
//   per request, so there is nothing to tell a long one by; every token
//   is priced at the short-context rate, and a request past 272K is
//   undercounted.
// - **Other tiers.** Batch and Flex are not how Codex runs, and EO does
//   not ask for the Fast tier (`serviceTier`), so Standard is the price.
//
// GPT-5.6 Sol's price is promotional, "available at least through
// November 21, 2026" — read the page again after that date.
//
// Every model the pinned Codex lists has a row; `codexPricing.test.ts`
// holds this table against `__fixtures__/codex-0.166.0-model-list.json`,
// captured from that binary's `model/list`: 0.161.0's and 0.163.0's seven
// models (EO-453), plus gpt-6.1-terra, which 0.165.0 added and whose row
// was read off the same page and tier on 2026-10-29 (EO-599). 0.166.0
// lists the same eight, every field as 0.165.0 had it (EO-644). A Codex bump that adds a
// model fails that test until somebody reads the page and adds its price.
// A model the table does not know — a newer one, or one typed in by hand
// — is not priced at zero: the run posts a note saying the budgets cannot
// count it (`runSupervisor.ts`).
import type { Usage } from "./codexClient.js";

/** Cents per million tokens, at the Standard tier. */
export interface CodexModelPrice {
  /** Input the prompt cache did not serve. */
  inputCentsPerMillion: number;
  /** Input the prompt cache served, which Codex counts inside `input_tokens`. */
  cachedInputCentsPerMillion: number;
  /**
   * Output, reasoning included: Codex's `output_tokens` already holds
   * `reasoning_output_tokens`. Read off 0.161.0's own rollouts, where
   * `total_tokens` is `input_tokens + output_tokens` exactly — 551,564 in
   * and 2,695 out (1,118 of it reasoning) made 554,259 — so neither the
   * reasoning nor the cached share is counted beside the figure it is in.
   */
  outputCentsPerMillion: number;
}

/** Where the prices were read, and when — said with any figure EO derives from them. */
export const CODEX_PRICES_SOURCE = { url: "https://developers.openai.com/api/docs/pricing", readOn: "2026-10-08" } as const;

/**
 * OpenAI's list prices, in cents per million tokens, by the slug
 * Codex's `thread/start` names the model with.
 *
 * gpt-5.5 is listed by the pinned binary only with `includeHidden`, and
 * is here because the page prices it and a person can still name it.
 */
export const CODEX_MODEL_PRICES: Readonly<Record<string, CodexModelPrice>> = {
  // $2.00 / $0.10 / $10.00
  "gpt-6.1-sol": { inputCentsPerMillion: 200, cachedInputCentsPerMillion: 10, outputCentsPerMillion: 1_000 },
  // $10.00 / $1.00 / $50.00
  "gpt-6-astra": { inputCentsPerMillion: 1_000, cachedInputCentsPerMillion: 100, outputCentsPerMillion: 5_000 },
  // $1.00 / $0.05 / $5.00 — read 2026-10-29 (EO-599)
  "gpt-6.1-terra": { inputCentsPerMillion: 100, cachedInputCentsPerMillion: 5, outputCentsPerMillion: 500 },
  // $2.00 / $0.20 / $10.00
  "gpt-6-sol": { inputCentsPerMillion: 200, cachedInputCentsPerMillion: 20, outputCentsPerMillion: 1_000 },
  // $0.10 / $0.01 / $0.50
  "gpt-6-luna": { inputCentsPerMillion: 10, cachedInputCentsPerMillion: 1, outputCentsPerMillion: 50 },
  // $4.00 / $0.40 / $20.00 — promotional, see above
  "gpt-5.6-sol": { inputCentsPerMillion: 400, cachedInputCentsPerMillion: 40, outputCentsPerMillion: 2_000 },
  // $2.00 / $0.20 / $12.00
  "gpt-5.6-terra": { inputCentsPerMillion: 200, cachedInputCentsPerMillion: 20, outputCentsPerMillion: 1_200 },
  // $0.20 / $0.02 / $1.20
  "gpt-5.6-luna": { inputCentsPerMillion: 20, cachedInputCentsPerMillion: 2, outputCentsPerMillion: 120 },
  // $5.00 / $0.50 / $30.00 (under 272K context)
  "gpt-5.5": { inputCentsPerMillion: 500, cachedInputCentsPerMillion: 50, outputCentsPerMillion: 3_000 },
};

/** The price of one model, or null when EO has none — which is not the same as free. */
export function codexModelPrice(model: string): CodexModelPrice | null {
  return Object.hasOwn(CODEX_MODEL_PRICES, model) ? (CODEX_MODEL_PRICES[model] ?? null) : null;
}

/**
 * One turn's cost in micro-cents — millionths of a cent — at the price
 * of the model it ran on, unrounded (EO-510). Exact: the prices are
 * whole cents per million tokens, so tokens times price is micro-cents.
 *
 * Codex counts cached input *inside* `input_tokens` and names the cached
 * share separately, so the uncached input is the difference — pricing
 * `input_tokens` whole at the input rate would charge the cached share
 * at the full rate, up to twenty times what it costs.
 *
 * What a side call records: one costs a fraction of a cent, and rounded
 * to whole cents almost every one would be recorded as nothing.
 */
export function codexTurnCostMicrocents(usage: Pick<Usage, "input_tokens" | "cached_input_tokens" | "output_tokens">, price: CodexModelPrice): number {
  const cached = Math.min(Math.max(0, usage.cached_input_tokens), Math.max(0, usage.input_tokens));
  const uncached = Math.max(0, usage.input_tokens) - cached;
  const output = Math.max(0, usage.output_tokens);
  return uncached * price.inputCentsPerMillion + cached * price.cachedInputCentsPerMillion + output * price.outputCentsPerMillion;
}

/**
 * One turn's cost in whole cents, at the price of the model it ran on:
 * `codexTurnCostMicrocents`, rounded.
 *
 * Rounded once per turn, the unit Codex reports in. A Codex turn is a
 * whole agent turn, not one model response, so a run carries a few of
 * these and the rounding is a fraction of a cent on each.
 */
export function codexTurnCostCents(usage: Pick<Usage, "input_tokens" | "cached_input_tokens" | "output_tokens">, price: CodexModelPrice): number {
  return Math.round(codexTurnCostMicrocents(usage, price) / 1_000_000);
}
