/**
 * How long a step's work may take before EO stops it (EO-162).
 *
 * A module step waits for something outside EO — CI, a deploy, a queue —
 * and how long that takes is a property of somebody's repository rather
 * than of EO. It was a constant in `runModule.ts` reachable from nowhere
 * a person could see, so a merge module capping its own wait below it had
 * no way to be told the ceiling had moved. `pipeline_steps.timeout_ms` is
 * the ceiling now, and this is what it means when nobody has set one.
 *
 * Unchanged from the constant it replaces: a step that configures nothing
 * still stops after ten minutes, so raising it is opt-in.
 */
export const DEFAULT_MODULE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The limit that actually applies to a step's module.
 *
 * One function rather than `step?.timeoutMs ?? DEFAULT` written out at
 * each call site, because the two of them have to agree: what the
 * supervisor gives `runModule`, and the number `ctx.timeoutMs` reports
 * to the module itself.
 * A module sizing its own wait against a figure one of them computed
 * differently would be sizing it against a number that never applied.
 */
export function stepTimeoutMs(step: { timeoutMs: number | null } | null | undefined): number {
  return step?.timeoutMs ?? DEFAULT_MODULE_TIMEOUT_MS;
}

/**
 * A duration, in the unit somebody would have typed it in.
 *
 * Minutes for the values these limits actually hold — a person sets
 * fifteen minutes, and a sentence that answered "900000ms" would make
 * them do the arithmetic to check EO understood. Seconds and then
 * milliseconds below that, rather than rounding: a test's 500ms limit
 * reported as "1 second" is a number EO never used.
 */
export function describeDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (ms % 1000 === 0) {
    const seconds = ms / 1000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${ms}ms`;
}

/**
 * Why a step's time limit and the run timeout cannot both be honoured, or
 * null when they can (EO-162).
 *
 * ## The relationship, stated once
 *
 * A module step's limit is **bounded by the per-run wall-clock timeout**
 * (`GuardConfig.wallClockTimeoutMs`). A module run is a run: saying a run
 * may take at most thirty minutes and then letting one of them take
 * forty is two limits that contradict each other, and the one that loses
 * does so silently — which is the bug EO-162 exists to end.
 *
 * So the bound is enforced by *refusing to store the pair*, on both
 * sides. Publishing a pipeline whose step asks for longer than the run
 * timeout is refused by `validatePipeline`; lowering the run timeout
 * under a step that already asks for longer is refused by `writeGuards`.
 * Neither number is ever quietly reduced to fit the other, and because
 * stored state can never hold a contradicting pair, dispatch never has to
 * choose between them — it just uses what the step says.
 *
 * The bound is a person's own number rather than something fixed in EO,
 * which is the other half of the story: somebody whose CI takes fifteen
 * minutes raises the run timeout and then raises the step, and both
 * numbers are theirs.
 *
 * One wording, used by both refusals — the message is what tells somebody
 * which of the two to change, and two files spelling it differently is
 * how a person comes to believe they are two different problems.
 */
export function timeLimitBoundProblem(input: { stepName: string; timeoutMs: number; runTimeoutMs: number }): string | null {
  if (input.timeoutMs <= input.runTimeoutMs) return null;
  return (
    `"${input.stepName}" may run for ${describeDuration(input.timeoutMs)}, which is longer than the run timeout of ` +
    `${describeDuration(input.runTimeoutMs)}. Raise the run timeout under Settings → Guardrails, or lower this step's limit.`
  );
}
