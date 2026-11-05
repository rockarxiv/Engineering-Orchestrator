/**
 * The attempt limit's stop, in words (ARCHITECTURE.md, "Guardrails").
 *
 * Spelled once, beside the test for it, because something other than the
 * supervisor has to tell this stop apart from every other one: a trial
 * item that failed past its attempts wakes the assistant as exactly that
 * (EO-586, `main/trials/loop.ts`), and the escalation's words are all
 * that reaches the comment listener that wakes it. The run's error holds
 * the same sentence.
 */
export function attemptLimitStop(priorAttempts: number, action: string, limit: number): string {
  return `Stopped after ${priorAttempts} attempt(s) in this "${action}" initiation (limit: ${limit}). Reply to start a new initiation.`;
}

const ATTEMPT_LIMIT_STOP = /^Stopped after \d+ attempt\(s\) in this ".*" initiation \(limit: \d+\)\./;

/** Whether an escalation is the attempt limit's stop. */
export function isAttemptLimitStop(body: string): boolean {
  return ATTEMPT_LIMIT_STOP.test(body);
}
