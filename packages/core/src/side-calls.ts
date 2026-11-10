// Side calls (EO-477): one short question to a small model, with one
// schema-shaped answer, that is not an agent run.
//
// Provider-agnostic, like `agent-provider.ts`: nothing here names a
// backend's SDK or spelling. What a backend does with a side call is its
// adapter's (`AgentProvider.sideCall`); what EO records about one is the
// main process's (`sideCalls/sideCall.ts`, the `side_calls` table).

import { z } from "zod";

/**
 * Why EO is asking. A closed set: a purpose is what a row in
 * `side_calls` says the money went on, and a spend screen groups by it,
 * so a purpose nobody declared would be spend nobody can name.
 */
/**
 * Why EO asked. `learning_review` (EO-717) is the one purpose no side
 * call asks: it is the review turn on a fork of a run's own thread, run
 * on that run's agent, and it is written here only so that what it
 * spent is counted wherever side calls are (`SIDE_CALL_MODELS` says
 * `agent`, which `sideCall` refuses).
 */
export const SIDE_CALL_PURPOSES = ["memory_select", "memory_extract", "memory_consolidate", "learning_review"] as const;
export const SideCallPurposeSchema = z.enum(SIDE_CALL_PURPOSES);
export type SideCallPurpose = z.infer<typeof SideCallPurposeSchema>;

/**
 * Which model each purpose runs on (EO-578).
 *
 * - `small` — the backend's small model, with no reasoning effort set:
 *   selection and extraction, asked on every dispatch and every settle,
 *   where a short answer is wanted cheaply.
 * - `system_agent` — the system agent's own model and reasoning effort,
 *   or its consolidation override where one is set
 *   (`sideCallModelOfSystemAgent`): consolidation, asked about once a day
 *   per scope, which needs judgement over the whole scope. A small model
 *   failed it eight times in a row on a 56,000-character scope.
 * - `agent` — the reviewed run's own agent, on a fork of its thread
 *   (EO-717): never asked through `sideCall`, which refuses it.
 *
 * A record keyed by purpose, so a purpose added to `SIDE_CALL_PURPOSES`
 * without saying which model it runs on is a type error rather than a
 * call that quietly takes the small one.
 */
export const SIDE_CALL_MODELS = {
  memory_select: "small",
  memory_extract: "small",
  memory_consolidate: "system_agent",
  learning_review: "agent",
} as const satisfies Record<SideCallPurpose, "small" | "system_agent" | "agent">;

/** What a `system_agent` side call runs on: a model and a reasoning effort, either null for the backend's default. */
export interface SideCallModelChoice {
  model: string | null;
  reasoningEffort: string | null;
}

/**
 * Where the system agent keeps its consolidation override (EO-578): two
 * keys in its own `agents.config`, each optional. Named for EO rather
 * than for a backend — the effort is not Claude's `effort` or Codex's
 * `reasoningEffort` — so the override survives the agent being moved to
 * the other backend, where a model name may then be one it cannot run
 * and the call says so.
 */
export const CONSOLIDATION_OVERRIDE_KEYS = {
  model: "consolidationModel",
  reasoningEffort: "consolidationReasoningEffort",
} as const;

/** One override field from an agent's config: a non-empty string, trimmed, or null for "follow the agent". */
function overrideField(config: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The model and reasoning effort a `system_agent` side call runs on: the
 * system agent's own, with each field its consolidation override sets
 * taking that field's place. An empty field follows the agent, so
 * changing the agent's model or effort changes the call's with it.
 */
export function sideCallModelOfSystemAgent(agent: SideCallModelChoice, config: Readonly<Record<string, unknown>>): SideCallModelChoice {
  return {
    model: overrideField(config, CONSOLIDATION_OVERRIDE_KEYS.model) ?? agent.model,
    reasoningEffort: overrideField(config, CONSOLIDATION_OVERRIDE_KEYS.reasoningEffort) ?? agent.reasoningEffort,
  };
}

/**
 * Every way a side call can fail, and the only ones. None of them throws:
 * the caller always gets one of these back with a sentence.
 *
 * - `timeout` — it ran past its `timeoutMs`, waiting for a slot included,
 *   or wrote past its `maxOutputTokens` and was cut off (EO-577).
 * - `schema` — the model answered, but not in the shape asked for.
 * - `budget` — the day's budget, the item's, or the run's turn budget is
 *   spent; refused before any model call, or stopped at the cap.
 * - `quota` — the backend's plan said no (a rate-limit refusal).
 * - `signed_out` — the backend is not signed in.
 * - `sign_in_unreachable` — the backend is signed in, but where no home
 *   of the side calls' own can reach it (EO-509): Codex keeping its
 *   sign-in in the operating system's keyring, or `auto`. Not
 *   `signed_out`, because signing in again the same way changes nothing,
 *   and not `error`, because nothing went wrong — it is how the machine
 *   is set up, and only the person can change it.
 * - `error` — anything else, including the caller's own abort and EO
 *   shutting down under it.
 */
export const SIDE_CALL_FAILURE_REASONS = ["timeout", "schema", "budget", "quota", "signed_out", "sign_in_unreachable", "error"] as const;
export const SideCallFailureReasonSchema = z.enum(SIDE_CALL_FAILURE_REASONS);
export type SideCallFailureReason = z.infer<typeof SideCallFailureReasonSchema>;

/** What a side call comes back with: the parsed answer, or why there is none. */
export type SideCallResult<T> = { ok: true; value: T } | { ok: false; reason: SideCallFailureReason; message: string };

/**
 * The line a spend screen lists a purpose's cost under.
 *
 * Grouped rather than one line per purpose: selecting, extracting and
 * consolidating memory are three questions about one thing, and a person
 * reading what the day cost wants to know what memory costs, not which of
 * its three moments spent it.
 */
export const SIDE_CALL_SPEND_GROUPS = {
  memory_upkeep: { label: "Memory upkeep", purposes: ["memory_select", "memory_extract", "memory_consolidate", "learning_review"] },
} as const satisfies Record<string, { label: string; purposes: readonly SideCallPurpose[] }>;

export type SideCallSpendGroup = keyof typeof SIDE_CALL_SPEND_GROUPS;

/** The spend line a purpose's cost is listed under. */
export function spendGroupOf(purpose: SideCallPurpose): SideCallSpendGroup {
  for (const [group, spec] of Object.entries(SIDE_CALL_SPEND_GROUPS) as [SideCallSpendGroup, (typeof SIDE_CALL_SPEND_GROUPS)[SideCallSpendGroup]][]) {
    if ((spec.purposes as readonly SideCallPurpose[]).includes(purpose)) return group;
  }
  // Unreachable while every purpose is in a group, which the test holds.
  return "memory_upkeep";
}

/**
 * Micro-cents in a cent (EO-510). A side call's cost is stored in
 * micro-cents — it costs a fraction of a cent, and rounding each call to
 * a whole one recorded almost every call as nothing — and its sums are
 * rounded to whole cents only once they are summed.
 */
export const MICROCENTS_PER_CENT = 1_000_000;

/** A sum of micro-cents as the whole cents every figure in EO is shown and budgeted in. */
export function centsOfMicrocents(microcents: number): number {
  return Math.round(microcents / MICROCENTS_PER_CENT);
}

/** One line of spend that is not a run's: side calls of one group, summed. */
export const SideCallSpendLineSchema = z.object({
  group: z.string(),
  label: z.string(),
  costCents: z.number(),
});
export type SideCallSpendLine = z.infer<typeof SideCallSpendLineSchema>;

/**
 * The small model Claude side calls run on unless a person picks another.
 * Codex has no fixed default: it is the smallest model the Codex runtime
 * reports, which only the runtime can say.
 */
export const DEFAULT_CLAUDE_SMALL_MODEL = "claude-haiku-5-5";

/** One backend's small model, as the Runtimes card shows it. */
export const SmallModelViewSchema = z.object({
  /** The backend's id, as `agents.provider` spells it. */
  backend: z.string(),
  /** What a person chose. Null is "use the default". */
  chosen: z.string().nullable(),
  /** What the default is, when EO can say; null when it cannot (Codex not installed, not signed in). */
  defaultModel: z.string().nullable(),
  /** Where the default comes from, said to a person. */
  defaultNote: z.string(),
});
export type SmallModelView = z.infer<typeof SmallModelViewSchema>;
