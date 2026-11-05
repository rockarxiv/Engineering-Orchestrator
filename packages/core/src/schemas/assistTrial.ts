import { z } from "zod";
import { TrialStepModeSchema } from "../trialPlan.js";

/**
 * The trial plan an assistant turn proposes beside its draft (EO-587,
 * ARCHITECTURE.md, "Trial pipelines").
 *
 * When the person wants a draft tested with real runs, the assistant
 * plans the test with them before it drafts: the test items, what success
 * looks like for each, and how each step runs on them. It hands that plan
 * back beside the `draft`, and the reply is posted as a **design card**
 * rather than a publish card: the graph, its modules, the test items with
 * their expected outcomes and every step's mode, with Approve design and
 * no Publish.
 *
 * Written in the draft's own terms — its step ids, and the test items by
 * a short key — because nothing it names exists yet. Approving the design
 * makes the trial pipeline (fresh step ids) and files the test items (fresh
 * item ids), and translates this into the trial's own `TrialPlanSchema`,
 * which is keyed by those.
 *
 * Every optional field is nullable with a default rather than optional,
 * for invariant #12's sake: Codex's strict output writes every key, as
 * `null` where it has nothing to say.
 */

/** At most this many test items in one plan: each is a real run, on real backends, costing real money. */
export const MAX_TRIAL_TEST_ITEMS = 6;

/**
 * What success looks like for one test item: the step it must end on —
 * which EO checks, not the assistant (invariant #5) — and the person's
 * own words for anything more, which the assistant reports against.
 */
export const AssistExpectedOutcomeSchema = z.object({
  /** A step of the draft, by the draft's id. A test item that ends anywhere else has failed. */
  stepId: z.string().min(1),
  /** What else should be true, in the person's words. Null where they said nothing more. */
  criteria: z.string().nullable().default(null),
});

/** One test item: a real item filed on the trial, with what it must come to. */
export const AssistTestItemSchema = z.object({
  /** A short name for it, unique in the plan, which a mocked step names it by (`fix-login`). */
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  /** What the item says, as a person would file it. */
  body: z.string().nullable().default(null),
  /** The item type, by its word (`story`). Null is the project's first type that is not a container. */
  type: z.string().min(1).nullable().default(null),
  /** Which of the project's workspaces it works on, by id. Null where the project has exactly one with a disk. */
  workspaceId: z.string().min(1).nullable().default(null),
  expected: AssistExpectedOutcomeSchema,
});

/** What a mocked step reports for one test item: the result key it routes on, and the output it posts. */
export const AssistTrialMockSchema = z.object({
  /** The test item, by its `key`. */
  item: z.string().min(1),
  resultKey: z.string().min(1),
  output: z.string(),
});

/** How one step of the draft runs on the test items, and why. */
export const AssistTrialStepSchema = z.object({
  /** A step of the draft, by the draft's id. */
  stepId: z.string().min(1),
  mode: TrialStepModeSchema,
  /**
   * Why this mode, in a sentence the person reads on the card — from what
   * EO says the step reaches outside it (`outsideReach` on `pipeline_get`
   * and `pipeline_validate`): "posts to Slack, so it is redirected to a
   * scratch channel".
   */
  reason: z.string().trim().min(1),
  /** For a mocked step, what it reports for every test item. Empty for any other. */
  mocks: z.array(AssistTrialMockSchema).default([]),
});

export const AssistTrialPlanSchema = z
  .object({
    items: z.array(AssistTestItemSchema).min(1).max(MAX_TRIAL_TEST_ITEMS),
    steps: z.array(AssistTrialStepSchema).default([]),
  })
  .superRefine((plan, context) => {
    for (const problem of trialPlanShapeProblems(plan)) context.addIssue({ code: "custom", message: problem });
  });

export type AssistExpectedOutcome = z.infer<typeof AssistExpectedOutcomeSchema>;
export type AssistTestItem = z.infer<typeof AssistTestItemSchema>;
export type AssistTrialMock = z.infer<typeof AssistTrialMockSchema>;
export type AssistTrialStep = z.infer<typeof AssistTrialStepSchema>;
export type AssistTrialPlan = z.infer<typeof AssistTrialPlanSchema>;

/** What is wrong with a plan on its own, before any draft is asked: keys and steps said twice, mocks that name nothing. */
function trialPlanShapeProblems(plan: { items: readonly { key: string }[]; steps: readonly { stepId: string; mode: string; mocks: readonly { item: string }[] }[] }): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const item of plan.items) {
    if (keys.has(item.key)) problems.push(`The test item "${item.key}" is listed twice; give each test item a key of its own.`);
    keys.add(item.key);
  }
  const planned = new Set<string>();
  for (const step of plan.steps) {
    if (planned.has(step.stepId)) problems.push(`The step "${step.stepId}" is planned twice; give each step one mode.`);
    planned.add(step.stepId);
    if (step.mode !== "mocked") {
      if (step.mocks.length > 0) problems.push(`"${step.stepId}" is ${step.mode}, so it reports what it really reports: only a mocked step names results in \`mocks\`.`);
      continue;
    }
    const mocked = new Set<string>();
    for (const mock of step.mocks) {
      if (!keys.has(mock.item)) problems.push(`"${step.stepId}" names a result for "${mock.item}", which is not one of the plan's test items.`);
      if (mocked.has(mock.item)) problems.push(`"${step.stepId}" names two results for "${mock.item}".`);
      mocked.add(mock.item);
    }
    const missing = [...keys].filter((key) => !mocked.has(key));
    if (missing.length > 0) {
      problems.push(`"${step.stepId}" is mocked and names no result for ${missing.map((key) => `"${key}"`).join(", ")}; a mocked step reports a result for every test item.`);
    }
  }
  return problems;
}

/** The part of a draft a trial plan is judged against. */
export interface PlannedDraft {
  steps: readonly { id: string; name: string; type: string; isTerminal: boolean }[];
  routes: readonly { fromStepId: string; resultKey: string }[];
}

/**
 * What is wrong with a trial plan as a plan *of this draft* (EO-587):
 * every sentence names the step or test item and what to do, for the
 * schema to refuse the turn with and for a card to be refused with when
 * a plan carried from an earlier design no longer fits a revised graph.
 *
 *   * a step or an expected outcome naming a step the draft does not have;
 *   * a step that runs something — not a person's step, not where work
 *     ends — left out of the plan: every such step's mode is the person's
 *     to decide, so each comes with one and a reason;
 *   * a person's step or a terminal one planned as anything but real:
 *     they run nothing to redirect or mock;
 *   * a mocked result the step does not declare — no route out of it on
 *     that key — which would park the item asking for one.
 */
export function trialPlanProblems(draft: PlannedDraft, plan: Pick<AssistTrialPlan, "items" | "steps">): string[] {
  const problems: string[] = [];
  const steps = new Map(draft.steps.map((step) => [step.id, step]));
  for (const item of plan.items) {
    if (!steps.has(item.expected.stepId)) problems.push(`The test item "${item.key}" is expected to end on "${item.expected.stepId}", which is not a step of the draft.`);
  }
  const planned = new Set(plan.steps.map((entry) => entry.stepId));
  for (const entry of plan.steps) {
    const step = steps.get(entry.stepId);
    if (step === undefined) {
      problems.push(`The trial plan gives a mode to "${entry.stepId}", which is not a step of the draft.`);
      continue;
    }
    if (entry.mode !== "real" && (step.type === "user" || step.isTerminal)) {
      problems.push(`"${step.name}" ${step.isTerminal ? "is where work ends" : "is a person's step"} and runs nothing, so it cannot be ${entry.mode}; plan it as real.`);
    }
    if (entry.mode !== "mocked") continue;
    const declared = draft.routes.filter((route) => route.fromStepId === step.id).map((route) => route.resultKey);
    for (const mock of entry.mocks) {
      if (!declared.includes(mock.resultKey)) {
        problems.push(
          `"${step.name}" is mocked to report "${mock.resultKey}" for "${mock.item}", which it does not declare` +
            (declared.length === 0 ? " — it has no route out of it." : ` — it declares ${declared.map((key) => `"${key}"`).join(", ")}.`),
        );
      }
    }
  }
  for (const step of draft.steps) {
    if (step.type === "user" || step.isTerminal || planned.has(step.id)) continue;
    problems.push(`"${step.name}" runs something and the trial plan gives it no mode; say whether it runs real, redirected or mocked, and why.`);
  }
  return problems;
}

/**
 * What a design card shows of its trial plan (EO-587), read now from the
 * draft, the plan and the trial it may already have started — never from
 * anything the renderer kept. On `assist:draft`, beside the graph, so the
 * card draws exactly what Approve design would make.
 */
export const AssistTrialCardSchema = z.object({
  /** Each test item, with where it must end by that step's name. */
  items: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      body: z.string().nullable(),
      expectedStepId: z.string(),
      expectedStepName: z.string(),
      criteria: z.string().nullable(),
    }),
  ),
  /**
   * Every step of the draft in order, with its mode — a step the plan
   * does not name is real, and says so with no reason — and whether EO
   * classes it as sending or creating outside EO (EO-584), which is what
   * a mode is chosen from.
   */
  steps: z.array(
    z.object({
      stepId: z.string(),
      name: z.string(),
      mode: TrialStepModeSchema,
      reason: z.string().nullable(),
      reaches: z.enum(["sends", "creates"]).nullable(),
      /** For a mocked step, what it reports for each test item, by the item's title. */
      mocks: z.array(z.object({ item: z.string(), resultKey: z.string(), output: z.string() })),
    }),
  ),
  /** Every module the draft runs, by slug: each is granted trial-only permission within its declared needs when the design is approved. */
  modules: z.array(z.object({ slug: z.string(), name: z.string() })),
  /**
   * What this design changes from the one the person approved before it,
   * where testing is under way — why it is a new design card rather than
   * applied. Empty for a first design.
   */
  changes: z.array(z.string()),
  /** Why Approve design cannot be pressed, or null where it can. */
  problem: z.string().nullable(),
  /** The trial this design started, where it has been approved; null until then. */
  approved: z
    .object({
      trialPipelineId: z.string(),
      /** The trial's newest round, or null before any has started. */
      round: z.number().int().nullable(),
    })
    .nullable(),
});
export type AssistTrialCard = z.infer<typeof AssistTrialCardSchema>;
