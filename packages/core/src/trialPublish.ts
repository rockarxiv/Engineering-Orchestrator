import { z } from "zod";
import { PipelineStepViewSchema, StepRouteViewSchema } from "./ipc-schemas.js";

/**
 * The publish card after trials (EO-588, ARCHITECTURE.md, "Trial
 * pipelines").
 *
 * The assistant asks for it with a card of its own —
 * `{ "kind": "trialPublish" }` — once every test item of the newest round
 * has ended where it was expected to, or once the person answered a
 * guardrail stop with "Publish anyway". Everything on it is EO's reading
 * of the trial, never the assistant's account of it (invariant #5): the
 * graph that would be published, what changed since the design the
 * person approved, how each step ran, where each test item ended against
 * where it was expected to, and what the assistant answered in the
 * person's place — which are the questions the live pipeline will ask
 * the person instead.
 *
 * Its one button publishes the pipeline and approves every module it
 * runs, in one transaction (`assist:publishTrial`), and then discards the
 * trial.
 */

/**
 * How a step came out of the trials, by EO's own record of them. A step
 * a test item merely arrived on has not run: it ran where a run on it
 * succeeded or a run's result moved an item off it, where a person's step
 * was pressed, and — running nothing — where work ended on it.
 *
 *   * `tested` — real, and it ran on a test item;
 *   * `redirected` — its real code ran against trial-only values, so what
 *     it reaches on live work was never reached;
 *   * `mocked` — it never ran: it reported what the plan named for it.
 *     Never `tested`, whatever reached it;
 *   * `not_run` — real or redirected, and test items reached it, but it
 *     never ran on one: it parked before its work started (a missing
 *     credential, a withdrawn grant), or never got a result;
 *   * `not_reached` — real or redirected, and no test item ever got to it,
 *     so nothing about it was shown.
 */
export const TRIAL_STEP_OUTCOMES = ["tested", "redirected", "mocked", "not_run", "not_reached"] as const;
export const TrialStepOutcomeSchema = z.enum(TRIAL_STEP_OUTCOMES);
export type TrialStepOutcome = z.infer<typeof TrialStepOutcomeSchema>;

/**
 * Where one test item of the newest round got to: `passed` where it ended
 * on its expected step, `failed` where it ended anywhere else or stopped
 * short of an end, `unfinished` while it is still on its way.
 */
export const TrialItemVerdictSchema = z.enum(["passed", "failed", "unfinished"]);
export type TrialItemVerdict = z.infer<typeof TrialItemVerdictSchema>;

export const TrialPublishCardSchema = z.object({
  /** The trial this card reads. */
  trialPipelineId: z.string(),
  /** The pipeline it publishes into, or null where publishing creates one. */
  targetPipelineId: z.string().nullable(),
  /** What the published pipeline is called: the target's name, the new name, or the name a draft renames it to. */
  pipelineName: z.string(),
  /** The round whose test items are judged here, or null before any. */
  round: z.number().int().nullable(),
  /** The graph publishing writes, in the target's own step ids, for the card's drawing. */
  steps: z.array(PipelineStepViewSchema),
  routes: z.array(StepRouteViewSchema),
  entryStepId: z.string().nullable(),
  /** What changed since the design the person approved, each as a sentence. Empty where nothing did. */
  changes: z.array(z.string()),
  /**
   * Every module the published graph runs, as a collapsed row on the
   * card, with whether its code or its needs moved since the design was
   * approved — needs being what the person granted — and the live module
   * it replaces where it is a draft copy of one.
   */
  modules: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      codeChanged: z.boolean(),
      needsChanged: z.boolean(),
      /** The module the copy replaces on the published pipeline, or null where it is no copy. */
      replaces: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
  /** Every step of the published graph in order, with how it came out of the trials and the reason its mode was chosen. */
  stepOutcomes: z.array(
    z.object({
      stepId: z.string(),
      name: z.string(),
      outcome: TrialStepOutcomeSchema,
      reason: z.string().nullable(),
    }),
  ),
  /** Each test item of the newest round: where it was expected to end, and where it did. */
  items: z.array(
    z.object({
      itemKey: z.string(),
      title: z.string(),
      expectedStepName: z.string(),
      /** The person's words for anything more, which the assistant reports against and EO does not judge. */
      criteria: z.string().nullable(),
      /** The step it ended on, or null while it has not ended. */
      endedStepName: z.string().nullable(),
      /** The result it got there on, as EO read it. */
      result: z.string().nullable(),
      verdict: TrialItemVerdictSchema,
    }),
  ),
  /**
   * What the assistant did in the person's place on the trial items, in
   * every round: each result it pressed on a person's step, and each
   * question an agent asked that it answered. On the live pipeline these
   * are the person's.
   */
  onBehalf: z.array(
    z.object({
      kind: z.enum(["pressed", "answered"]),
      itemKey: z.string(),
      stepName: z.string(),
      /** The question an agent asked, or null for a press. */
      asked: z.string().nullable(),
      /** The result pressed, or what the assistant answered. */
      answer: z.string(),
      /** For a press, every result the step offers the person. */
      choices: z.array(z.string()),
    }),
  ),
  /** True where the person answered a guardrail stop with "Publish anyway" since the newest round started. */
  publishAnyway: z.boolean(),
  /** Why the button cannot be pressed now, or null where it can. */
  problem: z.string().nullable(),
});
export type TrialPublishCard = z.infer<typeof TrialPublishCardSchema>;

/** A pipeline's graph as it is saved and run: what a trial is materialised with, and what the publish card publishes. */
export const ResolvedGraphSchema = z.object({
  steps: z.array(PipelineStepViewSchema),
  routes: z.array(StepRouteViewSchema),
  entryStepId: z.string().nullable(),
});
export type ResolvedGraph = z.infer<typeof ResolvedGraphSchema>;

type ResolvedStep = ResolvedGraph["steps"][number];
type ResolvedRoute = ResolvedGraph["routes"][number];

/** Every setting of a step the publish card compares, with how a change to it is said. Everything the graph carries but its id and pipeline. */
const STEP_SETTINGS: readonly { key: keyof ResolvedStep; label: string }[] = [
  { key: "planMode", label: "plan mode" },
  { key: "workspaceMode", label: "workspace mode" },
  { key: "workspaceId", label: "workspace" },
  { key: "inputs", label: "inputs" },
  { key: "timeoutMs", label: "time limit" },
  { key: "watch", label: "watch" },
  { key: "results", label: "results" },
];

function shown(value: unknown): string {
  if (value === null || value === undefined) return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changed between two resolved graphs (EO-588), each as a sentence:
 * the graph a trial was materialised with when the person approved its
 * design, against the graph the publish card would publish.
 *
 * Every field the graph carries is compared — a step's name, kind, owner,
 * what it runs, its instructions, whether work ends on it, its place, and
 * every setting it runs with; each route's target, words and order; and
 * where work enters — because a change the assistant never wrote can
 * still be in what is published: a setting a draft left out, taken from
 * the target pipeline as it was when the draft was applied. Both graphs
 * are in the same step ids.
 */
export function resolvedGraphChanges(before: ResolvedGraph, after: ResolvedGraph): string[] {
  const changes: string[] = [];
  const was = new Map(before.steps.map((step) => [step.id, step]));
  const now = new Map(after.steps.map((step) => [step.id, step]));
  const name = (id: string | null): string => (id === null ? "nowhere" : (now.get(id)?.name ?? was.get(id)?.name ?? id));

  for (const step of after.steps) if (!was.has(step.id)) changes.push(`it adds the step "${step.name}"`);
  for (const step of before.steps) if (!now.has(step.id)) changes.push(`it removes the step "${step.name}"`);
  for (const step of after.steps) {
    const old = was.get(step.id);
    if (old === undefined) continue;
    if (old.name !== step.name) changes.push(`"${old.name}" is renamed "${step.name}"`);
    if (old.type !== step.type) changes.push(`"${step.name}" becomes a ${step.type} step instead of a ${old.type} step`);
    if (old.ownerRole !== step.ownerRole) changes.push(`"${step.name}" is done by ${step.ownerRole ?? "nobody"} instead of ${old.ownerRole ?? "nobody"}`);
    if (old.entryAction !== step.entryAction) changes.push(`"${step.name}" runs ${step.entryAction ?? "nothing"} instead of ${old.entryAction ?? "nothing"}`);
    if ((old.instructionsSummary ?? null) !== (step.instructionsSummary ?? null)) changes.push(`the instructions of "${step.name}"`);
    if (old.isTerminal !== step.isTerminal) changes.push(step.isTerminal ? `work ends on "${step.name}" now` : `work no longer ends on "${step.name}"`);
    if (old.position !== step.position) changes.push(`"${step.name}" moves from position ${old.position} to ${step.position}`);
    for (const setting of STEP_SETTINGS) {
      if (!same(old[setting.key], step[setting.key])) changes.push(`the ${setting.label} of "${step.name}": ${shown(old[setting.key])} → ${shown(step[setting.key])}`);
    }
  }
  if ((before.entryStepId ?? null) !== (after.entryStepId ?? null)) changes.push(`work starts on "${name(after.entryStepId)}" instead of "${name(before.entryStepId)}"`);

  const keyOf = (route: ResolvedRoute): string => `${route.fromStepId}\u0000${route.resultKey}`;
  const routesBefore = new Map(before.routes.map((route) => [keyOf(route), route]));
  const routesAfter = new Map(after.routes.map((route) => [keyOf(route), route]));
  for (const [key, route] of routesAfter) {
    const old = routesBefore.get(key);
    if (old === undefined) {
      changes.push(`"${name(route.fromStepId)}" declares the result "${route.resultKey}"`);
      continue;
    }
    if (old.target !== route.target) changes.push(`"${name(route.fromStepId)}" sends "${route.resultKey}" to "${name(route.target)}" instead of "${name(old.target)}"`);
    if (old.label !== route.label || old.tone !== route.tone) changes.push(`the words of "${route.resultKey}" on "${name(route.fromStepId)}"`);
    if (old.position !== route.position) changes.push(`the order of "${route.resultKey}" on "${name(route.fromStepId)}"`);
  }
  for (const [key, route] of routesBefore) if (!routesAfter.has(key)) changes.push(`"${name(route.fromStepId)}" no longer declares the result "${route.resultKey}"`);
  return changes;
}
