import { describe, expect, it } from "vitest";
import { AssistOutputSchema } from "./assist.js";
import { AssistTrialPlanSchema, MAX_TRIAL_TEST_ITEMS, trialPlanProblems } from "./assistTrial.js";

const step = (id: string, position: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  position,
  name,
  type: "agent",
  ownerRole: "implementer",
  entryAction: "implement",
  instructionsSummary: null,
  isTerminal: false,
  planMode: false,
  ...extra,
});

/** Fix, a QA step that passes or fails, Notify (which posts to Slack), and where work ends. */
const draft = {
  rationale: "Fix it, check it, tell the channel.",
  entryStepId: "fix",
  target: { newPipeline: "Hotfix" },
  steps: [
    step("fix", 0, "Fix"),
    step("qa", 1, "QA", { ownerRole: "qa", entryAction: "review" }),
    step("notify", 2, "Notify", { type: "builtin", ownerRole: null, entryAction: "slack_post" }),
    step("check", 3, "Check", { type: "user", ownerRole: null, entryAction: null }),
    step("done", 4, "Done", { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
    step("rejected", 5, "Rejected", { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
  ],
  routes: [
    { fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "qa", position: 0 },
    { fromStepId: "qa", resultKey: "passed", label: "Passed", tone: "success", target: "notify", position: 0 },
    { fromStepId: "qa", resultKey: "failed", label: "Failed", tone: "danger", target: "rejected", position: 1 },
    { fromStepId: "notify", resultKey: "sent", label: "Sent", tone: "success", target: "check", position: 0 },
    { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
  ],
};

/** A plan with a case that passes and a case that must fail, every step given a mode and a reason. */
const trial = {
  items: [
    { key: "good", title: "Fix the login", expected: { stepId: "done", criteria: "the login works again" } },
    { key: "bad", title: "Delete the database", body: "QA must refuse this.", expected: { stepId: "rejected" } },
  ],
  steps: [
    { stepId: "fix", mode: "real", reason: "It works on a branch of its own, so nothing leaves EO." },
    { stepId: "qa", mode: "real", reason: "It only reads the branch." },
    {
      stepId: "notify",
      mode: "mocked",
      reason: "It posts to Slack, which sends outside EO.",
      mocks: [
        { item: "good", resultKey: "sent", output: "Posted to #releases." },
        { item: "bad", resultKey: "sent", output: "Posted to #releases." },
      ],
    },
  ],
};

/** The trial plan beside a draft (EO-587), validated by Zod in `@eo/core`. */
describe("a trial plan beside a draft", () => {
  it("is accepted with test items, expected outcomes and every step's mode, its nullable fields filled in", () => {
    const parsed = AssistOutputSchema.parse({ message: "Here is the design.", draft, trial });
    expect(parsed.trial?.items.map((item) => [item.key, item.expected.stepId, item.expected.criteria, item.body, item.type, item.workspaceId])).toEqual([
      ["good", "done", "the login works again", null, null, null],
      ["bad", "rejected", null, "QA must refuse this.", null, null],
    ]);
    expect(parsed.trial?.steps.map((entry) => [entry.stepId, entry.mode, entry.mocks.length])).toEqual([
      ["fix", "real", 0],
      ["qa", "real", 0],
      ["notify", "mocked", 2],
    ]);
  });

  it("is null on a turn without one, so a draft not tested is a publish card as before", () => {
    expect(AssistOutputSchema.parse({ message: "Here.", draft }).trial).toBeNull();
    expect(AssistOutputSchema.parse({ message: "Here.", draft, trial: null }).trial).toBeNull();
  });

  it("is refused without a draft, and beside alternatives", () => {
    const alone = AssistOutputSchema.safeParse({ message: "Here.", trial });
    expect(alone.success).toBe(false);
    expect(JSON.stringify(alone.error?.issues)).toContain("`trial` is how a `draft` is tested");
    const beside = AssistOutputSchema.safeParse({ message: "Here.", draft, alternatives: [draft], trial });
    expect(beside.success).toBe(false);
    expect(JSON.stringify(beside.error?.issues)).toContain("no `alternatives`");
  });

  it("refuses a step that runs something and has no mode, naming it", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft, trial: { ...trial, steps: trial.steps.filter((entry) => entry.stepId !== "qa") } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('\\"QA\\" runs something and the trial plan gives it no mode');
  });

  it("refuses a mode with no reason", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft, trial: { ...trial, steps: trial.steps.map((entry) => ({ ...entry, reason: " " })) } });
    expect(parsed.success).toBe(false);
  });

  it("refuses an expected outcome on a step the draft does not have", () => {
    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft, trial: { ...trial, items: [{ ...trial.items[0]!, expected: { stepId: "shipped" } }, trial.items[1]!] } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('expected to end on \\"shipped\\", which is not a step of the draft');
  });

  it("refuses a mocked result the step does not declare, naming the ones it does", () => {
    const steps = trial.steps.map((entry) => (entry.stepId === "notify" ? { ...entry, mocks: entry.mocks!.map((mock) => ({ ...mock, resultKey: "posted" })) } : entry));
    const parsed = AssistOutputSchema.safeParse({ message: "Here.", draft, trial: { ...trial, steps } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('it declares \\"sent\\"');
  });

  it("refuses redirecting or mocking a person's step or a terminal one", () => {
    const plan = AssistTrialPlanSchema.parse(trial);
    expect(trialPlanProblems(draft, { ...plan, steps: [...plan.steps, { stepId: "check", mode: "mocked", reason: "x", mocks: [] }] })).toContainEqual(
      expect.stringContaining('"Check" is a person\'s step and runs nothing'),
    );
    expect(trialPlanProblems(draft, { ...plan, steps: [...plan.steps, { stepId: "done", mode: "redirected", reason: "x", mocks: [] }] })).toContainEqual(
      expect.stringContaining('"Done" is where work ends'),
    );
  });

  it("refuses, on its own, test items said twice, a mocked step missing a test item, and mocks on a step that is not mocked", () => {
    const twice = AssistTrialPlanSchema.safeParse({ ...trial, items: [trial.items[0], trial.items[0]] });
    expect(JSON.stringify(twice.error?.issues)).toContain('\\"good\\" is listed twice');
    const short = AssistTrialPlanSchema.safeParse({
      ...trial,
      steps: trial.steps.map((entry) => (entry.stepId === "notify" ? { ...entry, mocks: entry.mocks!.slice(0, 1) } : entry)),
    });
    expect(JSON.stringify(short.error?.issues)).toContain('names no result for \\"bad\\"');
    const real = AssistTrialPlanSchema.safeParse({ ...trial, steps: [{ stepId: "fix", mode: "real", reason: "x", mocks: [{ item: "good", resultKey: "done", output: "" }] }] });
    expect(JSON.stringify(real.error?.issues)).toContain("only a mocked step names results");
  });

  it("holds at least one test item and at most the cap", () => {
    expect(AssistTrialPlanSchema.safeParse({ items: [], steps: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_TRIAL_TEST_ITEMS + 1 }, (_, index) => ({ key: `t${index}`, title: `Case ${index}`, expected: { stepId: "done" } }));
    expect(AssistTrialPlanSchema.safeParse({ items: many, steps: [] }).success).toBe(false);
  });
});
