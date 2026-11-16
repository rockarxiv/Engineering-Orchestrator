import type { AgentProvider, AgentProviderResumeOptions, RunProcessScope, SuggestionOutcome, SuggestionSpend } from "@eo/core";

/**
 * A provider whose every turn carries the run's process scope (EO-738):
 * the run its processes belong to and the memory they may use, which
 * both adapters hand to `launchTree`.
 *
 * What a run's turn is opened through — `start`, `resume`, a `fork` —
 * and what describes it. Nothing a run never asks for: a warm start is a
 * conversation's, and a side call is no run's.
 */
export function scopedProvider(provider: AgentProvider, scope: RunProcessScope): AgentProvider {
  return {
    start: (opts) => provider.start({ ...opts, processScope: scope }),
    resume: (threadId, message, opts) => provider.resume(threadId, message, { ...opts, processScope: scope }),
    ...(provider.describeSession ? { describeSession: (turn) => provider.describeSession!(turn) } : {}),
    ...(provider.fork ? { fork: (threadId: string, message: string, opts?: AgentProviderResumeOptions) => provider.fork!(threadId, message, { ...opts, processScope: scope }) } : {}),
  };
}

/**
 * A provider whose every turn reports what making a suggested next
 * message spent to `onSpend` (EO-808, `AgentTurnOverrides.onSuggestionSpend`),
 * where its backend made one with a turn of its own — and what became of
 * the suggestion to `onOutcome` (EO-810, `AgentTurnOverrides.onSuggestionOutcome`),
 * where the adapter makes it. Asked of every run's turn, at the one door
 * they go through: only a turn that asked for a suggestion ever spends
 * anything on one, or says what became of it.
 */
export function suggestionSpendReported(provider: AgentProvider, onSpend: (spend: SuggestionSpend) => void, onOutcome?: (outcome: SuggestionOutcome) => void): AgentProvider {
  const reported = onOutcome ? { onSuggestionSpend: onSpend, onSuggestionOutcome: onOutcome } : { onSuggestionSpend: onSpend };
  return {
    ...provider,
    start: (opts) => provider.start({ ...opts, ...reported }),
    resume: (threadId, message, opts) => provider.resume(threadId, message, { ...opts, ...reported }),
  };
}
