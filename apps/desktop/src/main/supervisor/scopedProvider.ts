import type { AgentProvider, AgentProviderResumeOptions, RunProcessScope, SuggestionSpend } from "@eo/core";

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
 * where its backend made one with a turn of its own. Asked of every run's
 * turn, at the one door they go through: only a turn that asked for a
 * suggestion ever spends anything on one.
 */
export function suggestionSpendReported(provider: AgentProvider, onSpend: (spend: SuggestionSpend) => void): AgentProvider {
  return {
    ...provider,
    start: (opts) => provider.start({ ...opts, onSuggestionSpend: onSpend }),
    resume: (threadId, message, opts) => provider.resume(threadId, message, { ...opts, onSuggestionSpend: onSpend }),
  };
}
