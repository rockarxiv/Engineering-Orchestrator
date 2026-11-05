import { describe, expect, it } from "vitest";
import { AssistDraftSchema } from "./schemas/assist.js";
import { AssistTrialPlanSchema } from "./schemas/assistTrial.js";
import type { EntryRule } from "./entryRules.js";
import { classifyDesignChange, type DesignShape } from "./trialDesign.js";

const step = (id: string, position: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  position,
  name,
  type: "agent",
  ownerRole: "implementer",
  entryAction: "implement",
  instructionsSummary: "Fix what the item says.",
  isTerminal: false,
  planMode: false,
  ...extra,
});

const approved: DesignShape = {
  draft: AssistDraftSchema.parse({
    rationale: "Fix it, then a person checks it.",
    entryStepId: "fix",
    target: { newPipeline: "Hotfix" },
    steps: [
      step("fix", 0, "Fix"),
      step("deploy", 1, "Deploy", { type: "module", ownerRole: null, entryAction: "deploy-module", timeoutMs: 60_000 }),
      step("check", 2, "Check", { type: "user", ownerRole: null, entryAction: null, instructionsSummary: null }),
      step("done", 3, "Done", { type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true }),
      step("dropped", 4, "Dropped", { type: "user", ownerRole: null, entryAction: null, instructionsSummary: null, isTerminal: true }),
    ],
    routes: [
      { fromStepId: "fix", resultKey: "done", label: "Done", tone: "success", target: "deploy", position: 0 },
      { fromStepId: "deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "check", position: 0 },
      { fromStepId: "check", resultKey: "approve", label: "Approve", tone: "success", target: "done", position: 0 },
      { fromStepId: "check", resultKey: "reject", label: "Reject", tone: "danger", target: "dropped", position: 1 },
    ],
  }),
  plan: AssistTrialPlanSchema.parse({
    items: [{ key: "login", title: "Fix the login", expected: { stepId: "done", criteria: "the login works" } }],
    steps: [
      { stepId: "fix", mode: "real", reason: "It works on a branch." },
      { stepId: "deploy", mode: "mocked", reason: "It deploys to production.", mocks: [{ item: "login", resultKey: "deployed", output: "Deployed." }] },
    ],
  }),
};

/** A copy of the approved design with one change made to it. */
function revised(change: (shape: { draft: Record<string, unknown> & typeof approved.draft; plan: typeof approved.plan }) => void): DesignShape {
  const copy = JSON.parse(JSON.stringify(approved)) as { draft: Record<string, unknown> & typeof approved.draft; plan: typeof approved.plan };
  change(copy);
  return { draft: AssistDraftSchema.parse(copy.draft), plan: AssistTrialPlanSchema.parse(copy.plan) };
}

/** EO, not the assistant, decides whether a draft revised mid-loop needs the person again (EO-587). */
describe("classifyDesignChange", () => {
  it("finds nothing in the design itself", () => {
    expect(classifyDesignChange(approved, approved)).toEqual({ design: [], within: [] });
  });

  describe("what work must have to enter (EO-610)", () => {
    const asking = (entryRules: EntryRule[] | undefined): DesignShape => ({ ...approved, draft: { ...approved.draft, ...(entryRules === undefined ? {} : { entryRules }) } });
    const description: EntryRule = { kind: "description" };
    const workspace: EntryRule = { kind: "workspace" };

    it("finds nothing where the two say the same", () => {
      expect(classifyDesignChange(asking([description]), asking([description]))).toEqual({ design: [], within: [] });
    });

    it("counts a rule added", () => {
      expect(classifyDesignChange(asking(undefined), asking([description])).design).toEqual(["what work must have to enter becomes a description instead of whatever the pipeline already asks for"]);
    });

    it("counts a rule weakened or taken away, which is how a test is made to pass", () => {
      expect(classifyDesignChange(asking([description, workspace]), asking([description])).design).toEqual(["what work must have to enter becomes a description instead of a description, a workspace"]);
      expect(classifyDesignChange(asking([description]), asking([])).design).toEqual(["what work must have to enter becomes none instead of a description"]);
      expect(classifyDesignChange(asking([description]), asking([{ ...description, types: ["developer:bug"] }])).design).toHaveLength(1);
    });

    it("counts a draft that stops saying what the approved one said, since publishing it would keep the pipeline's instead", () => {
      expect(classifyDesignChange(asking([description]), asking(undefined)).design).toEqual(["what work must have to enter becomes whatever the pipeline already asks for instead of a description"]);
    });

    it("counts clearing rules the approved draft left alone", () => {
      expect(classifyDesignChange(asking(undefined), asking([])).design).toHaveLength(1);
    });

    it("is not something the loop may apply without asking", () => {
      expect(classifyDesignChange(asking(undefined), asking([description])).within).toEqual([]);
    });
  });

  it("applies a change to a step's instructions, its name or its settings without a card", () => {
    const change = classifyDesignChange(
      approved,
      revised(({ draft }) => {
        draft.steps[0]!.instructionsSummary = "Fix what the item says, and run the tests first.";
        draft.steps[1]!.timeoutMs = 120_000;
        draft.steps[2]!.name = "Look it over";
      }),
    );
    expect(change.design).toEqual([]);
    expect(change.within).toEqual(['the instructions of "Fix"', 'the settings of "Deploy"', '"Check" is renamed "Look it over"']);
  });

  it("applies new words on a result and a new reason for a mode without a card", () => {
    const change = classifyDesignChange(
      approved,
      revised(({ draft, plan }) => {
        draft.routes[2]!.label = "Looks good";
        plan.steps[1]!.reason = "It deploys to production, which a test must never reach.";
      }),
    );
    expect(change.design).toEqual([]);
    expect(change.within).toEqual(['the words of "approve" on "Check"', 'the reason "Deploy" is mocked']);
  });

  it("asks again for a step added or removed", () => {
    expect(
      classifyDesignChange(
        approved,
        revised(({ draft }) => {
          draft.steps.push(step("qa", 5, "QA", { ownerRole: "qa", entryAction: "review" }) as never);
        }),
      ).design,
    ).toContain('it adds the step "QA"');
    expect(
      classifyDesignChange(
        approved,
        revised(({ draft, plan }) => {
          draft.steps = draft.steps.filter((entry) => entry.id !== "deploy");
          draft.routes = draft.routes.filter((route) => route.fromStepId !== "deploy").map((route) => (route.target === "deploy" ? { ...route, target: "check" } : route));
          plan.steps = plan.steps.filter((entry) => entry.stepId !== "deploy");
        }),
      ).design,
    ).toEqual(['it removes the step "Deploy"', '"Fix" sends "done" to "Check" instead of "Deploy"', '"Deploy" no longer declares the result "deployed"']);
  });

  it("asks again for a route rerouted, and a result declared or dropped", () => {
    expect(
      classifyDesignChange(
        approved,
        revised(({ draft }) => {
          draft.routes[3]!.target = "done";
        }),
      ).design,
    ).toEqual(['"Check" sends "reject" to "Done" instead of "Dropped"']);
    expect(
      classifyDesignChange(
        approved,
        revised(({ draft }) => {
          draft.routes.push({ fromStepId: "check", resultKey: "later", label: "Later", tone: "info", target: "check", position: 2 } as never);
        }),
      ).design,
    ).toEqual(['"Check" declares the result "later"']);
    expect(
      classifyDesignChange(
        approved,
        revised(({ draft }) => {
          draft.routes = draft.routes.filter((route) => route.resultKey !== "reject");
        }),
      ).design,
    ).toEqual(['"Check" no longer declares the result "reject"']);
  });

  it("asks again for an expected outcome edited, or a test item added, removed or changed", () => {
    expect(
      classifyDesignChange(
        approved,
        revised(({ plan }) => {
          plan.items[0]!.expected.stepId = "dropped";
        }),
      ).design,
    ).toEqual(['it changes the expected outcome of "Fix the login"']);
    expect(
      classifyDesignChange(
        approved,
        revised(({ plan }) => {
          plan.items[0]!.expected.criteria = "anything at all";
        }),
      ).design,
    ).toEqual(['it changes the expected outcome of "Fix the login"']);
    expect(
      classifyDesignChange(
        approved,
        revised(({ plan }) => {
          plan.items[0]!.body = "Only the easy half.";
        }),
      ).design,
    ).toEqual(['it changes the test item "Fix the login"']);
    expect(
      classifyDesignChange(
        approved,
        revised(({ plan }) => {
          plan.items.push({ key: "logout", title: "Fix the logout", body: null, type: null, workspaceId: null, expected: { stepId: "done", criteria: null } });
          plan.steps[1]!.mocks.push({ item: "logout", resultKey: "deployed", output: "Deployed." });
        }),
      ).design,
    ).toEqual(['it adds the test item "Fix the logout"', 'what the mocked "Deploy" reports changes']);
  });

  it("asks again for a step's mode changed — a failing step mocked is the person's call", () => {
    expect(
      classifyDesignChange(
        approved,
        revised(({ plan }) => {
          plan.steps[0] = { stepId: "fix", mode: "mocked", reason: "It keeps failing.", mocks: [{ item: "login", resultKey: "done", output: "Fixed." }] };
        }),
      ).design,
    ).toEqual(['"Fix" is mocked instead of real']);
  });

  it("asks again for a step that runs something else, is done by someone else, or ends work", () => {
    const change = classifyDesignChange(
      approved,
      revised(({ draft }) => {
        draft.steps[1]!.entryAction = "other-module";
        draft.steps[0]!.ownerRole = "reviewer";
        draft.steps[2]!.isTerminal = true;
      }),
    );
    expect(change.design).toEqual(['"Fix" is done by reviewer instead of implementer', '"Deploy" runs other-module instead of deploy-module', 'work ends on "Check" now']);
  });
});
