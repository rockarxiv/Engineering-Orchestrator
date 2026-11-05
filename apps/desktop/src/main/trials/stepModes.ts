import { TrialPlanSchema, type Item, type OutsideReachByStep, type PipelineStep, type RegistryFacts, type TrialMock, type TrialPlan } from "@eo/core";
import { declaredResults, outsideReachByStep } from "@eo/engine";
import { sideEffectingServersByStep } from "../connectors/sideEffects.js";
import type { Db } from "../db/client.js";
import { getTrialPipeline, listModules, listRoutesForPipeline, listStepsForPipeline, listTrialItemIds, readTrialPlan, readTrialStepSources, writeTrialPlan } from "../db/repos/index.js";
import { trialScopeOf, type StepScope } from "../modules/secrets.js";

/**
 * Step modes on a trial (EO-584, ARCHITECTURE.md, "Step modes on a trial").
 *
 * A trial's plan gives each of its steps one of three modes — real,
 * redirected or mocked (`TrialPlanSchema`) — and this is where a plan is
 * judged before it is saved, and where the machinery that runs a step
 * asks which mode it is in for one item.
 *
 * The mode is a fact about a step *and an item*: only an item carrying
 * the trial mark is ever redirected or mocked. A step on a trial pipeline
 * that somehow held an item without the mark runs as written, with its
 * own values, because nothing the trial planned was for that item.
 */

export type SaveTrialPlanResult = { ok: true; plan: TrialPlan } | { ok: false; problem: string };

/**
 * Saves a trial's plan (EO-584), refusing one that says something the
 * trial cannot do — before anything is written, and in a sentence that
 * names the step:
 *
 *   * a step that is not one of the trial's own;
 *   * the same step twice;
 *   * redirecting or mocking a person's step or a terminal one, which
 *     run nothing — a person's step on a trial is answered on their
 *     behalf (EO-585), not mocked;
 *   * a result for a step that is not mocked, which nothing would report;
 *   * a mocked result for an item that is not one of this trial's test
 *     items, or two for the same item;
 *   * **a result key the step does not declare** — one with no route out
 *     of it in the trial's graph. A mock reports its result through the
 *     engine's ordinary route resolution, and a key with no route would
 *     park the item asking for one: the plan would be testing a pipeline
 *     the draft is not;
 *   * an expected outcome (EO-586) for an item that is not one of this
 *     trial's test items, two for one item, or one ending on a step the
 *     trial does not have.
 */
export function saveTrialPlan(db: Db, trialPipelineId: string, input: unknown): SaveTrialPlanResult {
  const refuse = (problem: string): SaveTrialPlanResult => ({ ok: false, problem: `The trial plan was not saved: ${problem}` });
  if (getTrialPipeline(db, trialPipelineId) === undefined) return refuse("that pipeline is not a trial.");
  const parsed = TrialPlanSchema.safeParse(input);
  if (!parsed.success) return refuse(parsed.error.issues.map((issue) => `${issue.path.join(".") || "plan"}: ${issue.message}`).join("; "));
  const plan = parsed.data;

  const steps = new Map(listStepsForPipeline(db, trialPipelineId).map((step) => [step.id, step]));
  const routes = listRoutesForPipeline(db, trialPipelineId);
  const testItems = new Set<string>(listTrialItemIds(db, trialPipelineId));
  const planned = new Set<string>();

  for (const entry of plan.steps) {
    const step = steps.get(entry.stepId);
    if (step === undefined) return refuse(`"${entry.stepId}" is not a step of this trial.`);
    if (planned.has(step.id)) return refuse(`"${step.name}" is planned twice.`);
    planned.add(step.id);

    if (entry.mode !== "real" && (step.type === "user" || step.isTerminal)) {
      return refuse(`"${step.name}" ${step.isTerminal ? "is where work ends" : "is a person's step"} and runs nothing, so it cannot be ${entry.mode}. Plan it as real.`);
    }
    if (entry.mode !== "mocked") {
      if (entry.mocks.length > 0) return refuse(`"${step.name}" is ${entry.mode}, so it reports what it really reports — only a mocked step names a result.`);
      continue;
    }

    const declared = declaredResults(step.id, routes).map((route) => route.resultKey);
    const mockedItems = new Set<string>();
    for (const mock of entry.mocks) {
      if (!testItems.has(mock.itemId)) return refuse(`"${step.name}" names a result for ${mock.itemId}, which is not one of this trial's test items.`);
      if (mockedItems.has(mock.itemId)) return refuse(`"${step.name}" names two results for the same test item.`);
      mockedItems.add(mock.itemId);
      if (!declared.includes(mock.resultKey)) {
        return refuse(
          `"${step.name}" does not declare the result "${mock.resultKey}"` +
            (declared.length === 0 ? ", and declares none a mock could report." : ` — it declares ${declared.map((key) => `"${key}"`).join(", ")}.`),
        );
      }
    }
  }

  // Where each test item must end (EO-586): a step of this trial, for
  // one of its test items, once per item.
  const expectedItems = new Set<string>();
  for (const expected of plan.expected) {
    if (!testItems.has(expected.itemId)) return refuse(`an expected outcome names ${expected.itemId}, which is not one of this trial's test items.`);
    if (expectedItems.has(expected.itemId)) return refuse("a test item has two expected outcomes.");
    expectedItems.add(expected.itemId);
    if (!steps.has(expected.stepId)) return refuse(`an expected outcome ends on "${expected.stepId}", which is not a step of this trial.`);
  }

  writeTrialPlan(db, trialPipelineId, plan);
  return { ok: true, plan };
}

/** How one step runs for one item (EO-584). */
export type TrialStepResolution = { mode: "real" } | { mode: "redirected" } | { mode: "mocked"; mock: TrialMock | null; stepId: string };

const REAL: TrialStepResolution = { mode: "real" };

/**
 * Which mode `stepId` runs in for `item` (EO-584): real for anything that
 * is not a trial item, or a step its trial's plan does not mention; else
 * what the plan says, and for a mocked step what it reports for this item
 * — null where the plan names nothing for it, which the supervisor parks
 * and says, rather than running a step the person chose not to run.
 */
export function trialStepMode(db: Db, item: Pick<Item, "id" | "trialAt" | "pipelineId">, stepId: string | null | undefined): TrialStepResolution {
  if (item.trialAt === null || item.pipelineId === null || stepId === null || stepId === undefined) return REAL;
  const planned = readTrialPlan(db, item.pipelineId)?.steps.find((entry) => entry.stepId === stepId);
  if (planned === undefined || planned.mode === "real") return REAL;
  if (planned.mode === "redirected") return { mode: "redirected" };
  return { mode: "mocked", stepId, mock: planned.mocks.find((mock) => mock.itemId === item.id) ?? null };
}

/**
 * Whose variables and secrets a run of `stepId` on `item` reads (EO-584).
 *
 * The step's own: for a step of a trial copied from a live pipeline, the
 * live step's (`readTrialStepSources`) — read, never written — so a real
 * step on a trial runs on exactly what the published step runs on, and a
 * value edited on the live step reaches the trial's next run as it would
 * the live pipeline's. A step the draft invented, and every step of a
 * pipeline that is not a trial, is its own source.
 *
 * And for a step the plan redirects, on a trial item, its trial-only
 * scope (`trialScopeOf` the trial step's id) in place of its own. What
 * `environmentFor`, `agentRunVariables` and `redirectWithheldVariables`
 * take.
 */
export function stepScopeFor(db: Db, item: Pick<Item, "id" | "trialAt" | "pipelineId">, stepId: string | null | undefined): StepScope {
  if (stepId === null || stepId === undefined) return { stepId: null };
  const own = item.pipelineId === null ? stepId : (readTrialStepSources(db, item.pipelineId)[stepId] ?? stepId);
  return trialStepMode(db, item, stepId).mode === "redirected" ? { stepId: own, trialScope: trialScopeOf(stepId) } : { stepId: own };
}

/**
 * Per step, whether it sends or creates outside EO (EO-584) — the data
 * the assistant reads to propose a step's mode on a trial, on
 * `pipeline_get` for a published graph and `pipeline_validate` for a
 * draft.
 *
 * `outsideReachByStep`, which is the webhook refusal's classification
 * (`webhookReach`), handed the three things it cannot work out itself:
 * the registry a builtin's `sideEffects` is read from, the module
 * catalogue — archived modules included, as the validator is given them —
 * for a module's `sideEffects` and `needs.create`, and the connectors with
 * side effects an agent step's role can reach (`sideEffectingServersByStep`).
 * Read here exactly as the validator's inputs are read, so the two cannot
 * classify one step differently.
 */
export function outsideReachForSteps(db: Db, steps: readonly PipelineStep[], registry: RegistryFacts): OutsideReachByStep {
  return outsideReachByStep({ steps, registry, modules: listModules(db, true), sideEffectingServersByStep: sideEffectingServersByStep(db, steps) });
}
