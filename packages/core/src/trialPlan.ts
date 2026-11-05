import { z } from "zod";

/**
 * A trial plan: how each step of a trial pipeline runs on its test items
 * (EO-584, ARCHITECTURE.md, "Trial pipelines", "Step modes on a trial").
 *
 * A draft under test is a hidden trial pipeline (EO-582), and the plan is
 * a structured value on it. Every step runs in one of three modes:
 *
 *   * **real** — as written, exactly as it would on a published pipeline.
 *     A step the plan does not mention is real.
 *   * **redirected** — the real code runs, against a test target: on a
 *     trial item the step is given its trial-only variables and secrets
 *     in place of its own (a scratch Slack channel, a fork). On any other
 *     item it is given its own.
 *   * **mocked** — the step does not run at all. For each trial item the
 *     plan names the result key it reports and the output it posts, and
 *     the item moves on that result through the engine's ordinary route
 *     resolution, as if the step had reported it.
 *
 * In `@eo/core` because it crosses a boundary twice: the assistant writes
 * it, and a pipeline that travels to the organisation's record or a
 * replica carries it with its trial (`RecordPipelineSchema.trial`), so
 * whichever machine runs a trial item reads the same plan.
 */

export const TRIAL_STEP_MODES = ["real", "redirected", "mocked"] as const;
export const TrialStepModeSchema = z.enum(TRIAL_STEP_MODES);
export type TrialStepMode = z.infer<typeof TrialStepModeSchema>;

/**
 * What a mocked step reports for one trial item: the result key it
 * routes on, and the output it posts in its place.
 *
 * The key has to be one the step declares — one of its routes — and that
 * is checked where the plan is saved, against the trial's own graph,
 * because a schema cannot see the graph.
 */
export const TrialMockSchema = z.object({
  itemId: z.string().min(1),
  resultKey: z.string().min(1),
  output: z.string(),
});
export type TrialMock = z.infer<typeof TrialMockSchema>;

export const TrialPlanStepSchema = z.object({
  /** A step of the trial pipeline — the trial's own id, not the draft's. */
  stepId: z.string().min(1),
  mode: TrialStepModeSchema,
  /**
   * Per trial item, for a mocked step: what it reports. Empty, and
   * refused when not, for a step that is not mocked — a result nobody
   * will report is a plan saying something untrue about the run.
   */
  mocks: z.array(TrialMockSchema).default([]),
});
export type TrialPlanStep = z.infer<typeof TrialPlanStepSchema>;

/**
 * What success looks like for one test item (EO-586, ARCHITECTURE.md,
 * "Trial pipelines"): the step it must end on, which EO checks, and the
 * person's own words for anything more, which the assistant reports
 * against and EO does not judge.
 *
 * Read when a trial item ends somewhere — reaches a terminal step, parks,
 * runs out of attempts — to say in the conversation what was expected and
 * whether it is where it ended. A trial item that ends anywhere else has
 * failed, whatever the assistant concludes (invariant #5).
 */
export const TrialExpectedOutcomeSchema = z.object({
  itemId: z.string().min(1),
  /** A step of the trial pipeline — the trial's own id, not the draft's. */
  stepId: z.string().min(1),
  /** The person's words for what else should be true, if they gave any. */
  criteria: z.string().nullable().default(null),
});
export type TrialExpectedOutcome = z.infer<typeof TrialExpectedOutcomeSchema>;

export const TrialPlanSchema = z.object({
  steps: z.array(TrialPlanStepSchema).default([]),
  /** Per test item, where it must end (EO-586). An item with none has no expected outcome to fail. */
  expected: z.array(TrialExpectedOutcomeSchema).default([]),
});
export type TrialPlan = z.infer<typeof TrialPlanSchema>;

/**
 * Which live step each of a trial's steps was copied from, by the trial
 * step's id (EO-584). A trial step's own variables and secrets are its
 * source step's — read, never written — so a real step on a trial runs on
 * what the published step runs on.
 */
export const TrialStepSourcesSchema = z.record(z.string(), z.string());
export type TrialStepSources = z.infer<typeof TrialStepSourcesSchema>;

/** The plan a trial has before anybody writes one: every step real. */
export const EMPTY_TRIAL_PLAN: TrialPlan = { steps: [], expected: [] };

/**
 * The line a mocked step's output comment opens with (EO-584).
 *
 * The mark is in the body because the body is what travels: a trial
 * item's comments go to the organisation's record and down to replicas
 * as commands and pages that carry no column for it, and a person reading
 * the thread has to be told, in the thread, that nothing ran. It is a
 * mark only on a comment EO itself wrote as an output (`isMockedOutput`):
 * an agent cannot post as the engine, so it cannot forge one.
 */
export const MOCKED_OUTPUT_MARK = "**Mocked on this trial** — this step did not run.";

/** The body of a mocked step's output comment: the mark, which result it reports, then the output the plan names. */
export function mockedOutputBody(stepName: string, resultKey: string, output: string): string {
  const said = output.trim() === "" ? "" : `\n\n${output}`;
  return `${MOCKED_OUTPUT_MARK} The trial plan has "${stepName}" report \`${resultKey}\` for this test item.${said}`;
}

/** Whether a comment is a mocked step's output: EO's own output comment, opening with the mark. */
export function isMockedOutput(comment: { authorType: string; kind: string; body: string }): boolean {
  return comment.authorType === "engine" && comment.kind === "output" && comment.body.startsWith(MOCKED_OUTPUT_MARK);
}

/**
 * Whether a step sends or creates outside EO (EO-584), as the webhook
 * refusal classifies it (`webhookReach`, EO-334, EO-435): `sends` for a
 * builtin whose registry entry has side effects, a module whose manifest
 * says `sideEffects`, or an agent step whose role can reach a connector
 * with side effects; `creates` for a module declaring `needs.create`.
 * Absent where a step does neither.
 *
 * What the assistant reads to propose a step's mode on a trial: a step
 * that sends is the one to redirect or mock.
 */
export const StepOutsideReachSchema = z.enum(["sends", "creates"]);
export type StepOutsideReach = z.infer<typeof StepOutsideReachSchema>;

/** Per step id, the steps that reach outside EO; a step that does not is absent. */
export const OutsideReachByStepSchema = z.record(z.string(), StepOutsideReachSchema);
export type OutsideReachByStep = z.infer<typeof OutsideReachByStepSchema>;

/**
 * What a person may answer when a guardrail stops a draft's test-fix loop
 * (EO-586, ARCHITECTURE.md, "Trial pipelines"), as the options on the
 * stop comment — so pressing one posts it as the reply.
 *
 *   * **Keep going** — the loop carries on, and the guardrails count again
 *     from this answer: rounds, the draft's spend, and repeated failures.
 *   * **Publish anyway** — the assistant brings the publish card, which
 *     says which test items did not end where they were expected to.
 *   * **Discard** — the trial and its test items are deleted.
 */
export const TRIAL_STOP_CHOICES = ["Keep going", "Publish anyway", "Discard"] as const;
export type TrialStopChoice = (typeof TRIAL_STOP_CHOICES)[number];

/** Which choice a reply to a stop is, read leniently (case, spacing, a full stop); null for anything else. */
export function trialStopChoiceOf(reply: string): TrialStopChoice | null {
  const said = reply.trim().replace(/[.!]+$/, "").replace(/\s+/g, " ").toLowerCase();
  return TRIAL_STOP_CHOICES.find((choice) => choice.toLowerCase() === said) ?? null;
}
