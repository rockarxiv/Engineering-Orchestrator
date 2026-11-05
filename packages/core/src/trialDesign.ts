import { z } from "zod";
import { AssistDraftSchema, type AssistDraft } from "./schemas/assist.js";
import { AssistTrialPlanSchema, type AssistTrialPlan } from "./schemas/assistTrial.js";
import { shownEntryRules } from "./pipelineVersions.js";
import { ResolvedGraphSchema } from "./trialPublish.js";

/**
 * The design a person approved for a trial (EO-587, ARCHITECTURE.md,
 * "Trial pipelines").
 *
 * Approving a design card makes a hidden trial pipeline out of its draft.
 * What was approved is kept on that trial, as it was approved: the draft
 * and its trial plan in the draft's own terms, and how those terms became
 * the trial's — which trial step each draft step is, which module each
 * module step runs there, and which test item each filed item is.
 *
 * Two things read it. The test-fix loop compares every later draft in the
 * conversation against it (`classifyDesignChange`): a change to what the
 * person approved needs a new design card, and anything else is applied
 * to the trial and starts the next round. And each round files the test
 * items again from it, so every round tests what was approved.
 */
export const TrialDesignSchema = z.object({
  /** The design card the person approved. */
  commentId: z.string().min(1),
  draft: AssistDraftSchema,
  plan: AssistTrialPlanSchema,
  /** Which trial step each draft step became, by the draft's step id. */
  stepIds: z.record(z.string(), z.string()),
  /** Which module each of the draft's module steps runs on the trial, by the module it named (EO-583): itself, or its draft copy. */
  moduleIds: z.record(z.string(), z.string()),
  /** Which test item each filed item is, by the filed item's id: the plan's `key`. */
  filed: z.record(z.string(), z.string()).default({}),
  /** Which round each filed item was filed in, by the filed item's id (EO-588): the publish card judges the newest round's. */
  rounds: z.record(z.string(), z.number().int()).default({}),
  /**
   * The newest draft card the loop applied to the trial without a design
   * card (EO-588), or null while the trial runs the approved one: what
   * the trial's graph is, and so what the publish card publishes.
   */
  applied: z.string().nullable().default(null),
  /**
   * A digest of each module's code when the design was approved, by the
   * module the trial runs (EO-588): what "changed since you approved" on
   * the publish card is measured against. Its needs then are the grant's.
   */
  moduleCode: z.record(z.string(), z.string()).default({}),
  /**
   * The trial's graph as it was materialised when the design was
   * approved, in the trial's own step ids (EO-588): every setting each
   * step ran with, those the draft left out and took from the target
   * included. The publish card says what changed against this, not
   * against the draft the person read — a setting the target gained
   * after approval, inherited by a revision the loop applied, is a change
   * the person never saw. Null on a design approved before it was kept.
   */
  approvedGraph: ResolvedGraphSchema.nullable().default(null),
  /**
   * A design card posted while this design was under test that changes
   * what the person approved, and why — or null while nothing waits.
   *
   * Set when the loop leaves a draft as a new design card, and kept until
   * the person approves a design card: approving one replaces this trial,
   * and that is the only thing that clears it. While it is set no round
   * starts, whatever a later turn returns — a turn going back to the
   * approved shape is not the person deciding, so it is a design card
   * too, and waits with the rest.
   */
  pending: z
    .object({
      commentId: z.string().min(1),
      reasons: z.array(z.string()),
    })
    .nullable()
    .default(null),
});
export type TrialDesign = z.infer<typeof TrialDesignSchema>;

/** A draft and how it is to be tested: what a design card shows, and what approving one approves. */
export interface DesignShape {
  draft: AssistDraft;
  plan: AssistTrialPlan;
}

/**
 * How a later draft differs from the approved design (EO-587).
 *
 * `design` lists every change to what the person approved — the steps,
 * the routes, the results a step declares, what work must have to enter,
 * a test item or where it must end, a step's mode — each as a sentence
 * for the card that asks again.
 * Not empty means the draft is posted as a new design card and no round
 * starts until the person approves it.
 *
 * `within` lists what changed inside the design: a step's instructions,
 * name or settings, a result's words, a mode's reason. Applied to the
 * trial without asking, since none of it changes what the trial tests or
 * what success means.
 */
export interface DesignChange {
  design: string[];
  within: string[];
}

/**
 * Classifies a draft against the design the person approved (EO-587) —
 * EO's judgement, not the assistant's, of whether it may carry on
 * without asking.
 *
 * Asking again for anything that changes what the trial tests is the
 * point: a test-fix loop is exactly the thing that could make a test pass
 * by weakening the pipeline — a step dropped, a route rerouted to Done, a
 * failing step mocked, an expected outcome moved to where the item ended,
 * a rule at the door taken away. So all of those are the person's, and only what leaves the shape and
 * the meaning of success alone is the loop's.
 */
export function classifyDesignChange(approved: DesignShape, proposed: DesignShape): DesignChange {
  const design: string[] = [];
  const within: string[] = [];
  const name = (id: string): string => proposed.draft.steps.find((step) => step.id === id)?.name ?? approved.draft.steps.find((step) => step.id === id)?.name ?? id;

  if (JSON.stringify(approved.draft.target ?? null) !== JSON.stringify(proposed.draft.target ?? null)) design.push("it is for a different pipeline");

  // The steps.
  const before = new Map(approved.draft.steps.map((step) => [step.id, step]));
  const after = new Map(proposed.draft.steps.map((step) => [step.id, step]));
  for (const step of proposed.draft.steps) if (!before.has(step.id)) design.push(`it adds the step "${step.name}"`);
  for (const step of approved.draft.steps) if (!after.has(step.id)) design.push(`it removes the step "${step.name}"`);
  for (const step of proposed.draft.steps) {
    const was = before.get(step.id);
    if (was === undefined) continue;
    if (was.type !== step.type) design.push(`"${step.name}" becomes a ${step.type} step instead of a ${was.type} step`);
    else if (was.entryAction !== step.entryAction) design.push(`"${step.name}" runs ${step.entryAction ?? "nothing"} instead of ${was.entryAction ?? "nothing"}`);
    if (was.ownerRole !== step.ownerRole) design.push(`"${step.name}" is done by ${step.ownerRole ?? "nobody"} instead of ${was.ownerRole ?? "nobody"}`);
    if (was.isTerminal !== step.isTerminal) design.push(step.isTerminal ? `work ends on "${step.name}" now` : `work no longer ends on "${step.name}"`);
    if ((was.instructionsSummary ?? null) !== (step.instructionsSummary ?? null)) within.push(`the instructions of "${step.name}"`);
    if (was.name !== step.name) within.push(`"${was.name}" is renamed "${step.name}"`);
    if (settingsOf(was) !== settingsOf(step)) within.push(`the settings of "${step.name}"`);
  }
  if (approved.draft.entryStepId !== proposed.draft.entryStepId) design.push(`work starts on "${name(proposed.draft.entryStepId)}" instead of "${name(approved.draft.entryStepId)}"`);

  // What work must have to enter (EO-610). Left out is not the same as
  // none: it keeps what the pipeline has, so a draft that stops saying
  // what the approved one said has dropped those rules from what would be
  // published, and an empty list clears rules the approved one left alone.
  const rules = (draft: AssistDraft): string => (draft.entryRules === undefined ? "whatever the pipeline already asks for" : shownEntryRules(draft.entryRules));
  if (JSON.stringify(approved.draft.entryRules ?? null) !== JSON.stringify(proposed.draft.entryRules ?? null)) {
    design.push(`what work must have to enter becomes ${rules(proposed.draft)} instead of ${rules(approved.draft)}`);
  }

  // The results each step declares, then where each one goes.
  const resultsOf = (routes: AssistDraft["routes"]): Map<string, { resultKey: string; fromStepId: string; target: string; words: string }> =>
    new Map(routes.map((route) => [`${route.fromStepId}\u0000${route.resultKey}`, { resultKey: route.resultKey, fromStepId: route.fromStepId, target: route.target, words: wordsOf(route) }]));
  const routesBefore = resultsOf(approved.draft.routes);
  const routesAfter = resultsOf(proposed.draft.routes);
  for (const [key, route] of routesAfter) {
    const was = routesBefore.get(key);
    if (was === undefined) design.push(`"${name(route.fromStepId)}" declares the result "${route.resultKey}"`);
    else if (was.target !== route.target) design.push(`"${name(route.fromStepId)}" sends "${route.resultKey}" to "${name(route.target)}" instead of "${name(was.target)}"`);
    else if (was.words !== route.words) within.push(`the words of "${route.resultKey}" on "${name(route.fromStepId)}"`);
  }
  for (const [key, route] of routesBefore) if (!routesAfter.has(key)) design.push(`"${name(route.fromStepId)}" no longer declares the result "${route.resultKey}"`);

  // The test items, and what success means for each.
  const itemsBefore = new Map(approved.plan.items.map((item) => [item.key, item]));
  const itemsAfter = new Map(proposed.plan.items.map((item) => [item.key, item]));
  for (const item of proposed.plan.items) if (!itemsBefore.has(item.key)) design.push(`it adds the test item "${item.title}"`);
  for (const item of approved.plan.items) if (!itemsAfter.has(item.key)) design.push(`it removes the test item "${item.title}"`);
  for (const item of proposed.plan.items) {
    const was = itemsBefore.get(item.key);
    if (was === undefined) continue;
    if (was.expected.stepId !== item.expected.stepId || (was.expected.criteria ?? null) !== (item.expected.criteria ?? null)) {
      design.push(`it changes the expected outcome of "${item.title}"`);
    }
    if (was.title !== item.title || (was.body ?? null) !== (item.body ?? null) || (was.type ?? null) !== (item.type ?? null) || (was.workspaceId ?? null) !== (item.workspaceId ?? null)) {
      design.push(`it changes the test item "${was.title}"`);
    }
  }

  // How each step runs: real, redirected or mocked, and what a mock reports.
  const modeOf = (plan: AssistTrialPlan, stepId: string) => plan.steps.find((entry) => entry.stepId === stepId);
  for (const step of proposed.draft.steps) {
    if (!before.has(step.id)) continue;
    const was = modeOf(approved.plan, step.id);
    const now = modeOf(proposed.plan, step.id);
    const wasMode = was?.mode ?? "real";
    const nowMode = now?.mode ?? "real";
    if (wasMode !== nowMode) design.push(`"${step.name}" is ${nowMode} instead of ${wasMode}`);
    else if (mocksOf(was) !== mocksOf(now)) design.push(`what the mocked "${step.name}" reports changes`);
    else if ((was?.reason ?? null) !== (now?.reason ?? null)) within.push(`the reason "${step.name}" is ${nowMode}`);
  }
  return { design, within };
}

/** The settings a draft may name on a step (EO-520), as one comparable value. */
function settingsOf(step: AssistDraft["steps"][number]): string {
  return JSON.stringify([step.planMode, step.timeoutMs ?? null, step.inputs ?? null, step.watch ?? null, step.workspaceId ?? null, step.workspaceMode ?? null]);
}

/** What a person reads on a result: its words, its tone, its place and whether it needs a reason. */
function wordsOf(route: AssistDraft["routes"][number]): string {
  return JSON.stringify([route.label, route.tone, route.position, route.requiresComment ?? null]);
}

function mocksOf(entry: AssistTrialPlan["steps"][number] | undefined): string {
  return JSON.stringify([...(entry?.mocks ?? [])].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)));
}
