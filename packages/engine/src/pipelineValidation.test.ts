import type { CustomModule, PipelineStep, StepRoute, Uuid } from "@eo/core";
import { coreRegistry, developerRegistry, fromRegistryView, toRegistryView, type ActionFacts, type RegistryFacts } from "@eo/core";
import { describe, expect, it } from "vitest";
import { hasBlockingProblem, outsideReachByStep, validatePipeline, type ValidatePipelineInput } from "./pipelineValidation.js";

function step(id: string, position: number, overrides: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id,
    pipelineId: "p1" as Uuid,
    position,
    name: id,
    type: "agent",
    ownerRole: "implementer",
    entryAction: "implement",
    instructionsSummary: null,
    isTerminal: false,
    planMode: false,
    workspaceMode: "isolated" as const,
    workspaceId: null,
    offBoard: false,
    inputs: {},
    timeoutMs: null,
    watch: null,
    ownerPersonId: null,
    ownerGroupId: null,
    results: [],
    ...overrides,
  };
}

function route(fromStepId: string, resultKey: string, target: string, position = 0): StepRoute {
  return {
    id: `${fromStepId}:${resultKey}` as Uuid,
    pipelineId: "p1" as Uuid,
    fromStepId,
    resultKey,
    label: resultKey,
    tone: "info",
    target,
    position,
  };
}

/**
 * The registry as EO ships it (KAN-124): what a builtin step may run and
 * what it may return. Passed in, as the module catalog is, because the
 * validator is pure and cannot know what is installed.
 */
const registry = developerRegistry();

/**
 * The steps as they stand today, which is how a removal is detected.
 * Named by their ids here, exactly as `step()` names them.
 */
function existing(...ids: string[]): ValidatePipelineInput["existingSteps"] {
  return ids.map((id) => ({ id, name: id }));
}

/** The shipped shape: implement → review, review branching three ways. */
function goodPipeline(): ValidatePipelineInput {
  return {
    steps: [
      step("implement", 0),
      step("review", 1, { ownerRole: "reviewer", entryAction: "review" }),
      step("merge", 2, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
    ],
    entryStepId: "implement",
    routes: [
      route("implement", "done", "review"),
      route("review", "approved", "merge", 0),
      route("review", "changes_requested", "implement", 1),
      route("review", "needs_user_input", "user_attention", 2),
    ],
    staffedRoles: ["implementer", "reviewer"],
    itemCountByStep: {},
    existingSteps: existing("implement", "review", "merge"),
    registry,
  };
}

function errors(input: ValidatePipelineInput): string[] {
  return validatePipeline(input)
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message);
}

function warnings(input: ValidatePipelineInput): string[] {
  return validatePipeline(input)
    .filter((problem) => problem.severity === "warning")
    .map((problem) => problem.message);
}

/** An approved deploy module: two results, one of which is a failure. */
function deployModule(overrides: Partial<CustomModule> = {}): CustomModule {
  return {
    id: "mod-deploy" as Uuid,
    slug: "deploy",
    name: "Deploy",
    description: "Builds and deploys the current branch to staging.",
    code: "export default async function run() {}",
    manifest: {
      name: "Deploy",
      description: "Builds and deploys the current branch to staging.",
      inputs: {},
      needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
      results: ["deployed", "failed"],
    },
    originalScript: null,
    source: "user",
    approvedAt: 1000,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...overrides,
  };
}

/**
 * The shipped pipeline with a deploy module wired in between implement
 * and review: `deployed` carries on, `failed` sends it back.
 */
/**
 * The shipped Delivery shape: a builtin step that opens the pull request,
 * with both of its outcomes routed (EO-77).
 */
function withBuiltinStep(stepOverrides: Partial<PipelineStep> = {}): ValidatePipelineInput {
  const input = goodPipeline();
  return {
    ...input,
    steps: [
      input.steps[0]!,
      input.steps[1]!,
      step("merge_request", 1.5, { type: "builtin", ownerRole: null, entryAction: "open_pull_request", ...stepOverrides }),
      input.steps[2]!,
    ],
    routes: [
      route("implement", "done", "review"),
      route("review", "approved", "merge_request", 0),
      route("review", "changes_requested", "implement", 1),
      route("review", "needs_user_input", "user_attention", 2),
      route("merge_request", "opened", "merge", 0),
      route("merge_request", "skipped", "merge", 1),
      route("merge_request", "failed", "user_attention", 2),
      // Back to the implementer, as the shipped pipeline sends them (EO-429).
      route("merge_request", "uncommitted_changes", "implement", 3),
      route("merge_request", "remote_diverged", "implement", 4),
    ],
    existingSteps: existing("implement", "review", "merge_request", "merge"),
    registry,
  };
}

function withModuleStep(stepOverrides: Partial<PipelineStep>, moduleOverrides: Partial<CustomModule> = {}): ValidatePipelineInput {
  const input = goodPipeline();
  const module = deployModule(moduleOverrides);
  return {
    ...input,
    steps: [
      input.steps[0]!,
      step("deploy", 0.5, { type: "module", ownerRole: null, entryAction: module.id, ...stepOverrides }),
      ...input.steps.slice(1),
    ],
    routes: [
      route("implement", "done", "deploy"),
      route("deploy", "deployed", "review", 0),
      route("deploy", "failed", "implement", 1),
      ...input.routes.filter((candidate) => candidate.fromStepId !== "implement"),
    ],
    modules: [module],
    existingSteps: existing("implement", "deploy", "review", "merge"),
    registry,
  };
}

/** A second pipeline, the one a finished story is handed to (EO-58). */
const MERGE_PIPELINE = [
  step("queue", 0, { pipelineId: "p2" as Uuid, type: "user", ownerRole: null, entryAction: null }),
  step("merged", 1, { pipelineId: "p2" as Uuid, type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
];

describe("validatePipeline", () => {
  it("passes the shipped pipeline, review loop and all", () => {
    // A cycle is legitimate here. Review → changes requested → implement →
    // review is the review loop, and being able to express it is the whole
    // reason routing became a graph rather than an ordered list.
    expect(validatePipeline(goodPipeline())).toEqual([]);
  });

  it("rejects a route whose target is a step in no pipeline at all", () => {
    // Still an error now that a target may resolve elsewhere (EO-58): a
    // typo must stay a typo rather than become a silent cross-pipeline
    // jump, and the message names the route so it can be found.
    const input = goodPipeline();
    input.routes = [...input.routes, route("implement", "escaped", "a-step-nobody-has", 1)];
    expect(errors(input)).toContain('"escaped" routes to a step that is in no pipeline.');
  });

  it("rejects the same result declared twice on one step", () => {
    const input = goodPipeline();
    input.routes = [...input.routes, route("review", "approved", "implement", 9)];
    expect(errors(input)).toContain('"approved" is declared twice on this step — which one wins would depend on row order.');
  });

  it("warns about a step nothing routes to", () => {
    const input = goodPipeline();
    input.steps = [...input.steps, step("orphan", 3)];
    input.existingSteps = [...input.existingSteps, ...existing("orphan")];
    const problems = validatePipeline(input);
    expect(problems.some((p) => p.stateId === "orphan" && /no ticket can ever reach it/.test(p.message))).toBe(true);
  });

  it("rejects a pipeline with no terminal step at all", () => {
    const input = goodPipeline();
    input.steps = input.steps.map((s) => ({ ...s, isTerminal: false }));
    expect(errors(input)).toContain("No step is terminal, so nothing can ever finish — mark the last one terminal.");
  });

  it("rejects a terminal that exists but cannot be reached", () => {
    // The check an ordered list never needed. Work goes in and never comes
    // out, and every item sits still looking like a busy agent.
    const input = goodPipeline();
    input.routes = [route("implement", "done", "review"), route("review", "changes_requested", "implement", 0)];
    expect(errors(input)).toContain("No terminal step can be reached from the first step — work would enter this pipeline and never finish.");
  });

  it("names the steps trapped in a cycle with no way out", () => {
    const input = goodPipeline();
    input.steps = [...input.steps, step("a", 3), step("b", 4)];
    input.existingSteps = [...input.existingSteps, ...existing("a", "b")];
    input.routes = [...input.routes, route("review", "sidetrack", "a", 3), route("a", "next", "b"), route("b", "back", "a")];
    const trapped = validatePipeline(input)
      .filter((p) => /cannot reach a terminal step/.test(p.message))
      .map((p) => p.stateId);
    expect(trapped).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("warns when a step's role has no enabled agent", () => {
    const input = goodPipeline();
    input.staffedRoles = ["implementer"];
    const problems = validatePipeline(input);
    expect(problems.some((p) => p.stateId === "review" && /no enabled agent/.test(p.message))).toBe(true);
    // A warning, not an error: the user may be about to enable one.
    expect(hasBlockingProblem(problems)).toBe(false);
  });

  it("rejects a terminal step that still does something", () => {
    // Nothing runs where work has finished — the scheduler declines to
    // dispatch a terminal step, so a terminal step that names an action is
    // one that would silently never run.
    const input = goodPipeline();
    input.steps = input.steps.map((s) => (s.isTerminal ? { ...s, type: "agent" as const, ownerRole: "implementer", entryAction: "implement" } : s));
    expect(errors(input).some((m) => /is terminal, so nothing runs there/.test(m))).toBe(true);
  });

  it("refuses to remove a step that still holds items, and says how many", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.itemCountByStep = { review: 3 };
    expect(errors(input)).toContain("review has 3 items on it. Move them before removing the step.");
  });

  /**
   * The refusal is data as well as a sentence (EO-230): the configure
   * screen offers the board narrowed to those items, and needs the step
   * and the count without parsing them back out of prose.
   */
  it("types the refusal with the step and the count", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.existingSteps = [{ id: "review", name: "Reviewer" }];
    input.itemCountByStep = { review: 2 };

    const problem = validatePipeline(input).find((candidate) => candidate.holdsItems !== undefined);

    expect(problem).toMatchObject({
      severity: "error",
      stateId: "review",
      message: "Reviewer has 2 items on it. Move them before removing the step.",
      holdsItems: { stepId: "review", stepName: "Reviewer", count: 2, archived: 0 },
    });
    // Only that one problem carries it.
    expect(validatePipeline(input).filter((candidate) => candidate.holdsItems !== undefined)).toHaveLength(1);
  });

  /**
   * Archived items count — the foreign key holds for them — but the
   * board cannot show them, so the refusal says so and the typed shape
   * lets the screen offer the Archive for those instead (EO-230).
   */
  it("says how many of the items are archived, and types it", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.existingSteps = [{ id: "review", name: "Reviewer" }];
    input.itemCountByStep = { review: 3 };
    input.archivedCountByStep = { review: 1 };

    expect(validatePipeline(input).find((candidate) => candidate.holdsItems !== undefined)).toMatchObject({
      message: "Reviewer has 3 items on it. Move them before removing the step. 1 of them is archived — restore it first.",
      holdsItems: { stepId: "review", stepName: "Reviewer", count: 3, archived: 1 },
    });
  });

  it("lets a step with items on it be renamed or change type — only removal is refused", () => {
    const input = goodPipeline();
    input.steps = input.steps.map((s) => (s.id === "review" ? { ...s, name: "Code review", type: "user" as const, ownerRole: null, entryAction: null } : s));
    input.itemCountByStep = { review: 2 };
    expect(errors(input).some((message) => message.includes("items on it"))).toBe(false);
  });

  /**
   * The editor refuses this before it is staged (EO-167), so what reaches
   * here is a race: an item that arrived while the draft was open. The
   * person is being told something moved under them, and the id it moved
   * onto is a UUIDv7 that names nothing to anybody.
   */
  it("names the removed step rather than its id, and counts one item in the singular", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.existingSteps = [{ id: "review", name: "Code review" }];
    input.itemCountByStep = { review: 1 };
    expect(errors(input)).toContain("Code review has 1 item on it. Move it before removing the step.");
  });

  /**
   * The half no other check covers (EO-58, EO-167). This function is
   * given *this* pipeline's routes, so a hand-off in is invisible to it
   * unless it is passed one — and `step_routes.target` has no foreign key
   * to reject the delete. Without this the editor's refusal is a screen's
   * good manners: a client calling `pipeline:save` directly, or a draft
   * loaded before somebody drew the route, walks straight past it.
   */
  it("refuses to remove a step another pipeline hands work to, and names the route", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.incomingHandOffs = [{ target: "review", pipelineName: "Delivery", label: "Approved" }];

    expect(errors(input)).toContain('"review" is where Delivery · Approved hands work to. Repoint that route in Delivery before removing it.');
  });

  it("says so once per stranded route when several pipelines point at the same step", () => {
    const input = goodPipeline();
    input.steps = input.steps.filter((s) => s.id !== "review");
    input.routes = [route("implement", "done", "merge")];
    input.incomingHandOffs = [
      { target: "review", pipelineName: "Delivery", label: "Approved" },
      { target: "review", pipelineName: "Release", label: "Shipped" },
    ];

    expect(errors(input)).toContain(
      '"review" is where Delivery · Approved, Release · Shipped hand work to. Repoint those routes in their own pipelines before removing it.',
    );
  });

  it("says nothing about a hand-off into a step that is staying", () => {
    // The route is only a problem because its target is going. A
    // pipeline that hands work here and keeps the step is the shape
    // EO-58 exists for, and must publish exactly as it always did.
    const input = goodPipeline();
    input.incomingHandOffs = [{ target: "review", pipelineName: "Delivery", label: "Approved" }];

    expect(validatePipeline(input)).toEqual([]);
  });

  it("rejects an empty pipeline outright", () => {
    const input = goodPipeline();
    input.steps = [];
    expect(errors(input)).toEqual(["A pipeline needs at least one step."]);
  });

  it("treats a step with no declared routes as walking to the next by position", () => {
    // The builtin step that scaffolds a worktree declares no routes, and
    // must not read as a dead end to the validator when it is not one at
    // runtime. Since `failed` was declared it is not silent either: the
    // walk is fine for `ready` and wrong for a failure, which is a
    // warning rather than a refusal — the pipeline still saves.
    const input = goodPipeline();
    input.steps = [step("worktree", -1, { type: "builtin", ownerRole: null, entryAction: "create_worktree" }), ...input.steps];
    input.existingSteps = [...existing("worktree"), ...input.existingSteps];
    input.entryStepId = "worktree";
    expect(errors(input)).toEqual([]);
    expect(validatePipeline(input).map((problem) => problem.severity)).toEqual(["warning"]);
  });
  // ── Handing work to another pipeline (EO-58) ────────────────

  it("accepts a route whose target is a step in another pipeline", () => {
    // The same shipped pipeline, with one of review's ways out leaving
    // it: a review that needs a person is handed to another pipeline's
    // queue. One of the results `review` declares, because a key it does
    // not is refused on an agent step for a reason of its own (EO-423).
    const input = goodPipeline();
    input.routes = input.routes.map((existing) => (existing.resultKey === "needs_user_input" ? route("review", "needs_user_input", "queue", 2) : existing));
    input.stepsElsewhere = MERGE_PIPELINE;
    expect(validatePipeline(input)).toEqual([]);
  });

  it("does not report a pipeline whose only way out is a hand-off as having no terminal step", () => {
    // The shape the feature exists for: this pipeline finishes by leaving,
    // so nothing in it is terminal and that is not a mistake.
    const input = goodPipeline();
    input.steps = [step("implement", 0), step("review", 1, { ownerRole: "reviewer", entryAction: "review" })];
    input.existingSteps = existing("implement", "review");
    input.routes = [
      route("implement", "done", "review"),
      route("review", "approved", "queue", 0),
      route("review", "changes_requested", "implement", 1),
      route("review", "needs_user_input", "user_attention", 2),
    ];
    input.stepsElsewhere = MERGE_PIPELINE;
    expect(validatePipeline(input)).toEqual([]);
  });

  it("still refuses a pipeline whose hand-off can never be reached", () => {
    // A way out nothing can get to is the same failure as an unreachable
    // terminal: work enters and never comes out.
    const input = goodPipeline();
    input.steps = [step("implement", 0), step("review", 1, { ownerRole: "reviewer", entryAction: "review" }), step("stranded", 2)];
    input.existingSteps = existing("implement", "review", "stranded");
    input.routes = [
      route("implement", "done", "review"),
      route("review", "changes_requested", "implement", 0),
      route("stranded", "handed_off", "queue", 0),
    ];
    input.stepsElsewhere = MERGE_PIPELINE;
    expect(errors(input)).toContain("No terminal step can be reached from the first step — work would enter this pipeline and never finish.");
  });

  // ── Module steps (KAN-104) ──────────────────────────────────
  //
  // The first four are the module version of what a builtin already
  // gets. The last two are new to EO and are the reason a module
  // declares its results at all: an agent's verdict is known only when
  // it comes back, so the design catches an unroutable result at runtime,
  // where a module can be checked before an item is near it.

  it("rejects a module step that does not say which module", () => {
    const input = withModuleStep({ entryAction: null });
    expect(errors(input)).toContain('"deploy" runs a module but does not say which.');
  });

  it("rejects a module this installation does not have, naming the id", () => {
    const input = withModuleStep({ entryAction: "some-other-module" });
    // The id is in the message because on an imported pipeline it is the
    // only clue to what failed to come with it.
    expect(errors(input)).toContain('"deploy" runs a module this installation does not have ("some-other-module").');
  });

  it("rejects a module that has been deleted", () => {
    const input = withModuleStep({}, { archivedAt: 5000 });
    expect(errors(input)).toContain('"deploy" runs "Deploy", which has been deleted.');
  });

  // The check an imported module rests on: it arrives unapproved and this
  // is what keeps it inert until somebody has read it.
  it("rejects a module nobody has approved", () => {
    const input = withModuleStep({}, { approvedAt: null });
    expect(errors(input)).toContain(
      '"Deploy" has not been approved. Read it in Settings → Modules and approve it before a step runs it — approving runs its tests, and it needs at least one, all passing.',
    );
  });

  // A trial grant (EO-583) is the one other permission, and only for the
  // pipeline it was granted on: the caller passes it for that one alone.
  it("accepts an unapproved module on a pipeline holding a trial grant for it, and only there", () => {
    const input = withModuleStep({}, { approvedAt: null });
    const moduleId = input.modules![0]!.id;
    const unapproved = (problems: string[]) => problems.filter((message) => message.includes("has not been approved"));
    expect(unapproved(errors({ ...input, trialGrantedModuleIds: [moduleId] }))).toEqual([]);
    expect(unapproved(errors({ ...input, trialGrantedModuleIds: ["some-other-module"] }))).toHaveLength(1);
    expect(unapproved(errors(input))).toHaveLength(1);
  });

  it("rejects a route declaring a result the module cannot return", () => {
    const input = withModuleStep({});
    input.routes = [...input.routes, route("deploy", "rolled_back", "review", 9)];
    expect(errors(input)).toContain('"rolled_back" is not a result "Deploy" can return (deployed, failed).');
  });

  /**
   * The one result nothing that runs declares (EO-297).
   *
   * `verification_failed` comes from the *workspace kind* an item's step
   * works in, not from the module's manifest or a builtin's declaration —
   * and which kind that is depends on the item rather than on the
   * pipeline, so this package cannot know and must not guess. Permitted
   * here, never required; the supervisor asks the kind whether it has a
   * verifier for the action before it takes the route.
   */
  it("permits a route on verification_failed, which no manifest can declare", () => {
    const input = withModuleStep({});
    input.routes = [...input.routes, route("deploy", "verification_failed", "review", 9)];
    expect(validatePipeline(input)).toEqual([]);
  });

  it("warns when a declared result has no route, because that outcome would park", () => {
    const input = withModuleStep({});
    // `failed` is declared by the module and routed by nobody.
    input.routes = input.routes.filter((candidate) => candidate.resultKey !== "failed");
    expect(warnings(input)).toContain('"Deploy" can return "failed", which has no route — a ticket getting that result would park and ask you.');
  });

  // An unconditional step is legitimate — it walks to the next by
  // position, which is what the worktree step relies on. It stops being
  // legitimate once the module can fail.
  it("warns when a module that can fail has no routes at all", () => {
    const input = withModuleStep({});
    input.routes = input.routes.filter((candidate) => candidate.fromStepId !== "deploy");
    expect(warnings(input)).toContain(
      '"deploy" declares no routes, so all of deployed, failed walk to the next step — a failure would advance like a success.',
    );
  });

  it("passes a fully wired module step", () => {
    expect(validatePipeline(withModuleStep({}))).toEqual([]);
  });

  /**
   * What a step sets for the inputs its module declares (EO-78).
   *
   * Checked here as well as at dispatch, and the difference is who finds
   * out: a person who typed a word into the box for a number learns so
   * while the box is still in front of them, rather than an hour later
   * when an item parks with a transcript about `NaN`.
   */
  describe("a module step's configured inputs", () => {
    const waits = { inputs: { wait_seconds: { type: "number" as const, default: 900 } } };

    it("passes a value of the declared type", () => {
      expect(validatePipeline(withModuleStep({ inputs: { wait_seconds: 90 } }, { manifest: { ...deployModule().manifest, ...waits } }))).toEqual([]);
    });

    it("passes an input the step leaves unset, which is the manifest's default", () => {
      expect(validatePipeline(withModuleStep({}, { manifest: { ...deployModule().manifest, ...waits } }))).toEqual([]);
    });

    it("refuses a value of the wrong type, naming the input", () => {
      const input = withModuleStep({ inputs: { wait_seconds: "ninety" } }, { manifest: { ...deployModule().manifest, ...waits } });
      const problem = errors(input).find((message) => message.includes("wait_seconds"));

      expect(problem).toBeDefined();
      expect(problem).toContain("number");
      expect(problem).toContain('the text "ninety"');
      // Blocking, so it cannot be published — the whole point of catching
      // it here rather than when an item arrives.
      expect(hasBlockingProblem(validatePipeline(input))).toBe(true);
    });

    /**
     * A manifest that dropped an input leaves whatever the step stored
     * for it behind. The manifest decides what exists, so the value is
     * inert rather than a problem — refusing it would make every save of
     * a perfectly good pipeline fail because a module was edited.
     */
    it("says nothing about a value for an input the manifest no longer declares", () => {
      expect(validatePipeline(withModuleStep({ inputs: { retired: "left behind" } }))).toEqual([]);
    });
  });

  /**
   * How long a module step may run (EO-162).
   *
   * Four cases, because the story is about a number being honoured or
   * visibly refused and never quietly reduced: nothing configured, a
   * raised value that fits, a raised value that does not, and a limit on
   * a step with no module to apply one to.
   *
   * The bound arrives as data for the reason the catalog does —
   * `packages/engine` is pure, so it cannot read `engine.guards` — and
   * the message is `timeLimitBoundProblem`'s, shared verbatim with
   * `writeGuards`, which refuses the same contradiction coming the other
   * way.
   */
  describe("a module step's time limit", () => {
    const RUN_TIMEOUT_MS = 30 * 60_000;

    it("says nothing about a step that sets none, so the default is opt-out of nothing", () => {
      expect(validatePipeline({ ...withModuleStep({ timeoutMs: null }), runTimeoutMs: RUN_TIMEOUT_MS })).toEqual([]);
    });

    it("passes a raised value that fits inside the run timeout", () => {
      expect(validatePipeline({ ...withModuleStep({ timeoutMs: 20 * 60_000 }), runTimeoutMs: RUN_TIMEOUT_MS })).toEqual([]);
    });

    it("refuses a value longer than the run timeout, and blocks the save rather than shrinking it", () => {
      const input = { ...withModuleStep({ timeoutMs: 40 * 60_000 }), runTimeoutMs: RUN_TIMEOUT_MS };
      const problem = errors(input).find((message) => message.includes("40 minutes"));

      expect(problem).toBeDefined();
      // Both numbers, so it is obvious which two are in conflict, and
      // both ways out — this is a bound on a person's own setting, not
      // on EO's.
      expect(problem).toContain("30 minutes");
      expect(problem).toContain("Raise the run timeout");
      expect(hasBlockingProblem(validatePipeline(input))).toBe(true);
    });

    it("refuses a limit on a step that runs no module, which would be stored and never read", () => {
      const input = goodPipeline();
      const withLimit = {
        ...input,
        steps: [{ ...input.steps[0]!, timeoutMs: 5 * 60_000 }, ...input.steps.slice(1)],
        runTimeoutMs: RUN_TIMEOUT_MS,
      };

      expect(errors(withLimit).find((message) => message.includes("time limit"))).toBeDefined();
      expect(hasBlockingProblem(validatePipeline(withLimit))).toBe(true);
    });

    /**
     * A caller that passes no bound gets the ceiling a module has always
     * had. Conservative on purpose: the alternative is an unbounded
     * default, and a validator whose silence depends on a field being
     * remembered is a validator that eventually waves something through.
     */
    it("falls back to EO's own module default when no run timeout is passed", () => {
      expect(errors(withModuleStep({ timeoutMs: 20 * 60_000 })).length).toBe(1);
      expect(errors(withModuleStep({ timeoutMs: 5 * 60_000 }))).toEqual([]);
    });
  });

  // Invariant #2: the catalog arrives as data. Omitting it entirely must
  // keep every pipeline that has no module steps validating as before.
  it("validates a module-free pipeline with no catalog at all", () => {
    expect(validatePipeline(goodPipeline())).toEqual([]);
  });
});

// ── Builtin steps (EO-77) ───────────────────────────────────────
//
// The same three checks a module step gets, now that a builtin's
// outcomes are declared data rather than string literals inside its own
// runner. Delivery routes `opened` and `skipped` correctly and always
// has; what was missing is that a typo in either would have been caught
// by nothing at all, and an item would simply have stopped.
describe("a builtin step's results", () => {
  it("passes a fully wired builtin step", () => {
    expect(validatePipeline(withBuiltinStep())).toEqual([]);
  });

  it("permits a route on verification_failed, which no builtin declares either", () => {
    const input = withBuiltinStep();
    input.routes = [...input.routes, route("merge_request", "verification_failed", "merge", 9)];
    expect(errors(input)).toEqual([]);
  });

  it("rejects a route declaring a result the function cannot return", () => {
    const input = withBuiltinStep();
    input.routes = [...input.routes, route("merge_request", "opend", "merge", 9)];
    // Named by the function rather than by the step: renaming the column
    // is not what would fix this.
    expect(errors(input)).toContain('"opend" is not a result "open_pull_request" can return (opened, skipped, uncommitted_changes, remote_diverged, failed).');
  });

  it("warns when a declared outcome has no route, because that outcome would park", () => {
    const input = withBuiltinStep();
    // A story with no branch, or no forge configured, answers `skipped` —
    // and with nothing routing it the item stops and asks why.
    input.routes = input.routes.filter((candidate) => candidate.resultKey !== "skipped");
    expect(warnings(input)).toContain('"open_pull_request" can return "skipped", which has no route — a ticket getting that result would park and ask you.');
  });

  it("warns when a builtin with more than one outcome has no routes at all", () => {
    const input = withBuiltinStep();
    input.routes = input.routes.filter((candidate) => candidate.fromStepId !== "merge_request");
    expect(warnings(input)).toContain(
      '"merge_request" declares no routes, so all of opened, skipped, uncommitted_changes, remote_diverged, failed walk to the next step — a failure would advance like a success.',
    );
  });

  /**
   * Every builtin can fail now, so no builtin is unconditional.
   *
   * `create_worktree` declared one outcome, `ready`, which made a
   * route-less worktree step unambiguous — the sentence above had nothing
   * to warn about. Declaring `failed` is what makes that sentence true of
   * it too: a branch that could not be cut would walk to Implementer
   * exactly as a branch that could.
   */
  it("warns about a route-less worktree step, which it could not before `failed` was declared", () => {
    const input = withBuiltinStep({ entryAction: "create_worktree" });
    input.routes = input.routes.filter((candidate) => candidate.fromStepId !== "merge_request");
    expect(warnings(input)).toContain(
      '"merge_request" declares no routes, so all of ready, failed walk to the next step — a failure would advance like a success.',
    );
  });

  // A function EO does not ship has nothing to declare, so the step is
  // refused for that alone rather than for routes nobody can check.
  it("says only that the function does not exist when it does not exist", () => {
    const input = withBuiltinStep({ entryAction: "deploy_to_prod" });
    const reported = validatePipeline(input).filter((problem) => problem.stateId === "merge_request");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toContain("is not one of EO's built-in functions");
  });
});

/**
 * A human step's results against its routes (EO-310, ARCHITECTURE.md, "Results and routes").
 *
 * The validator is the only thing standing between "the pipeline offers
 * a button" and "the button does something", so both halves of that are
 * errors rather than advice: a declared result nothing routes is a
 * control that does nothing when pressed, and a route out of a human
 * step nobody can choose is an edge drawn on the configuration screen
 * that no gesture can ever take.
 */
describe("a step a person decides on", () => {
  /** The shipped shape with a decision on its human step, which is what the developer pack now ships. */
  function decidingPipeline(): ValidatePipelineInput {
    const input = goodPipeline();
    input.steps = input.steps.map((candidate) =>
      candidate.id === "merge"
        ? {
            ...candidate,
            results: [
              { key: "approved", label: "Approve", tone: "success" as const, requiresComment: false },
              { key: "send_back", label: "Send back", tone: "warning" as const, requiresComment: true },
            ],
          }
        : candidate,
    );
    input.routes = [...input.routes, route("merge", "approved", "terminal", 0), route("merge", "send_back", "implement", 1)];
    return input;
  }

  it("takes a human step whose every result is routed", () => {
    expect(errors(decidingPipeline())).toEqual([]);
  });

  it("refuses a declared result nothing routes, naming the button rather than the key", () => {
    const input = decidingPipeline();
    input.routes = input.routes.filter((candidate) => candidate.resultKey !== "send_back");
    expect(errors(input)).toContain(
      '"merge" offers "Send back", but nothing says where it sends the item — the button would do nothing. Route it, or take it off the step.',
    );
  });

  it("refuses a route out of a human step whose key it does not offer", () => {
    const input = decidingPipeline();
    input.routes = [...input.routes, route("merge", "escalate", "implement", 2)];
    expect(errors(input)).toContain(
      '"escalate" routes out of "merge", which does not offer it (approved, send_back). Give it that result, or remove the branch.',
    );
  });

  /**
   * The same route, out of a human step that declares nothing at all.
   * A different sentence, because the answer is different: there is no
   * list to have left the key out of, so "which does not offer it ()"
   * would be an empty parenthesis where the reason should be.
   */
  it("says the step offers nothing to press when it declares nothing at all", () => {
    const input = goodPipeline();
    input.routes = [...input.routes, route("merge", "approved", "implement", 0)];
    expect(errors(input)).toContain(
      '"approved" routes out of "merge", but nobody there can choose it: the step offers nothing to press. Give it that result, or remove the branch.',
    );
  });

  /**
   * Results on a step nobody stands at. Dead wiring of the same kind:
   * the buttons would never be drawn, because nothing draws buttons for
   * a step that reports its own result.
   */
  it("refuses results declared on a step an agent acts on", () => {
    const input = goodPipeline();
    input.steps = input.steps.map((candidate) =>
      candidate.id === "review" ? { ...candidate, results: [{ key: "approved", label: "Approve", tone: "success" as const, requiresComment: false }] } : candidate,
    );
    expect(errors(input)).toContain(
      '"review" declares results for a person to choose between, but it is not a step a person acts on — an agent reports its own result. Make it a step a person does, or remove them.',
    );
  });

  /**
   * A button routed to a person's attention.
   *
   * The third way to publish a decision that does nothing, and the one
   * that looks most like wiring: the branch is drawn, the key is
   * declared, and the target is a sentinel EO has always accepted.
   * `items:decide` refuses it every time — the item is already standing
   * on the step whose whole business is asking a person — so the button
   * is dead before anybody presses it.
   */
  it("refuses a result routed to a person's attention, which is where the item already is", () => {
    const input = decidingPipeline();
    input.routes = input.routes.map((candidate) =>
      candidate.fromStepId === "merge" && candidate.resultKey === "send_back" ? { ...candidate, target: "user_attention" } : candidate,
    );

    expect(errors(input)).toContain(
      '"merge" offers "Send back" and routes it to a person\'s attention, which is where the item already is — pressing it would ' +
        "leave the item exactly where it stands, so EO refuses it every time. Point it at a step.",
    );
  });

  /**
   * The same sentinel out of a step an *agent* acts on, which is the
   * shipped pipeline's own `needs_user_input` and must keep working: a
   * review that ends in a question has to stop and wait for somebody.
   */
  it("leaves an agent's result routed to a person's attention alone", () => {
    expect(errors(decidingPipeline())).toEqual([]);
    expect(goodPipeline().routes.some((route) => route.target === "user_attention")).toBe(true);
  });

  /** And `terminal` is a destination rather than a parking space — it is what the shipped human step approves to. */
  it("takes a human step's result routed to the terminal step", () => {
    const input = decidingPipeline();
    expect(input.routes.some((route) => route.fromStepId === "merge" && route.target === "terminal")).toBe(true);
    expect(errors(input)).toEqual([]);
  });

  /**
   * Two declarations under one key.
   *
   * `step_routes` has a unique index that makes this impossible on the
   * routing side; `results` is JSON, so this check is the index. What
   * goes wrong is not ambiguity in the abstract — every reader takes the
   * first match, so the second button's own words and its "needs a
   * reason" are decoration over somebody else's answer.
   */
  it("refuses a result key declared twice, naming what the second one could never do", () => {
    const input = decidingPipeline();
    input.steps = input.steps.map((candidate) =>
      candidate.id === "merge"
        ? { ...candidate, results: [...candidate.results, { key: "approved", label: "Accept", tone: "warning" as const, requiresComment: true }] }
        : candidate,
    );

    expect(errors(input)).toContain(
      '"merge" offers "approved" twice. Both buttons send the same answer, so the second one\'s own words and whether it asks for a reason ' +
        "could never be the ones that applied — and which of them a person saw would depend on row order. Give it a result key of its own, " +
        "or take it off the step.",
    );
  });

  /** Said once about the word, not once per row: the duplicate is the problem, and it is one problem. */
  it("says it once, and does not also say the repeat is unrouted", () => {
    const input = decidingPipeline();
    input.steps = input.steps.map((candidate) =>
      candidate.id === "merge"
        ? { ...candidate, results: [...candidate.results, { key: "escalate", label: "Escalate", tone: "danger" as const, requiresComment: true }, { key: "escalate", label: "Escalate now", tone: "danger" as const, requiresComment: false }] }
        : candidate,
    );

    // One for the duplicate, one for the key nothing routes — and not a
    // second copy of the latter for the row that repeats it. Matched on
    // each sentence rather than on the word, because one names the key
    // and the other names the button.
    const reported = errors(input);
    expect(reported.filter((message) => message.includes('offers "escalate" twice'))).toHaveLength(1);
    expect(reported.filter((message) => message.includes("nothing says where it sends the item"))).toHaveLength(1);
  });

  /** A human step that only waits is every human step EO shipped before this, and it still validates. */
  it("leaves a human step that declares nothing alone", () => {
    expect(errors(goodPipeline())).toEqual([]);
  });
});

/**
 * A webhook's payload reaching something that sends, with nobody asked
 * in between (EO-334, ARCHITECTURE.md, "A connector is an MCP server with a setup flow",
 * "Results and routes").
 *
 * The support-triage shape: a case arrives from the internet, an agent
 * classifies it and a step answers it. Every piece is reasonable and the
 * whole is a stranger driving a tool somebody gave EO, so the graph is
 * refused until there is a person in it.
 */
describe("a webhook entry that reaches a side effect (EO-334)", () => {
  /** A module that answers the customer: two results, and it says that it sends. */
  function replyModule(overrides: Partial<CustomModule> = {}): CustomModule {
    return deployModule({
      id: "mod-reply" as Uuid,
      slug: "reply",
      name: "Send reply",
      manifest: {
        name: "Send reply",
        description: "Sends the drafted reply to the customer through the helpdesk.",
        inputs: {},
        needs: { bin: [], env: ["HELPDESK_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
        results: ["sent", "failed"],
        sideEffects: true,
      },
      ...overrides,
    });
  }

  /**
   * webhook → classify → Send → Done, with the send step's kind left to
   * the caller: a module, a builtin, or an agent holding a connector.
   */
  function triagePipeline(send: Partial<PipelineStep>, overrides: Partial<ValidatePipelineInput> = {}): ValidatePipelineInput {
    return {
      steps: [
        step("classify", 0),
        step("send", 1, { name: "Send", type: "module", ownerRole: null, entryAction: "mod-reply", ...send }),
        step("done", 2, { name: "Done", type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
      ],
      entryStepId: "classify",
      routes: [route("classify", "done", "send"), route("send", "sent", "done", 0), route("send", "failed", "user_attention", 1)],
      staffedRoles: ["implementer"],
      itemCountByStep: {},
      existingSteps: existing("classify", "send", "done"),
      modules: [replyModule()],
      registry,
      entryReachedByWebhook: true,
      ...overrides,
    };
  }

  /** The same graph with somebody in it: classify → Approve → Send. */
  function withApproveStep(input: ValidatePipelineInput): ValidatePipelineInput {
    return {
      ...input,
      steps: [
        ...input.steps,
        step("approve", 0.5, {
          name: "Approve",
          type: "user",
          ownerRole: null,
          entryAction: null,
          results: [{ key: "approved", label: "Approve", tone: "success" as const, requiresComment: false }],
        }),
      ],
      routes: [route("classify", "done", "approve"), route("approve", "approved", "send"), ...input.routes.filter((r) => r.fromStepId !== "classify")],
      existingSteps: existing("classify", "approve", "send", "done"),
    };
  }

  it("refuses the graph in §7.4's own words", () => {
    expect(errors(triagePipeline({}))).toEqual(["Cases arriving by webhook go straight to Send. Add an approve step before Send."]);
  });

  it("publishes once an approve step stands between them", () => {
    expect(errors(withApproveStep(triagePipeline({})))).toEqual([]);
  });

  it("says nothing about the same graph when no webhook can reach it", () => {
    // The refusal is about where the *payload* can get to. A pipeline a
    // person files work onto is one they have already read.
    expect(errors(triagePipeline({}, { entryReachedByWebhook: false }))).toEqual([]);
  });

  /**
   * The per-pipeline setting (EO-405). Off is the refusal above, which
   * the first case in this block already holds; on is the same walk with
   * a different severity, and on without a webhook is nothing at all.
   */
  it("refuses with the setting off, said or left unsaid", () => {
    const refusal = ["Cases arriving by webhook go straight to Send. Add an approve step before Send."];
    expect(errors(triagePipeline({}, { webhookUnattended: false }))).toEqual(refusal);
    // Unsaid is off: what every caller that predates the setting sends.
    expect(errors(triagePipeline({}))).toEqual(refusal);
  });

  it("warns about the same step, and blocks nothing, with the setting on", () => {
    const refused = validatePipeline(triagePipeline({})).filter((problem) => problem.message.includes("webhook"));
    const allowed = validatePipeline(triagePipeline({}, { webhookUnattended: true }));

    expect(errors(triagePipeline({}, { webhookUnattended: true }))).toEqual([]);
    expect(hasBlockingProblem(allowed)).toBe(false);
    const found = allowed.filter((problem) => problem.message.includes("webhook"));
    // The same finding for the same step, one for one.
    expect(found.map((problem) => problem.stateId)).toEqual(refused.map((problem) => problem.stateId));
    expect(found).toEqual([{ severity: "warning", stateId: "send", message: "Items arriving by webhook reach Send without a person reading them first." }]);
  });

  it("warns once for every step the refusal would have named", () => {
    // Two that send before anybody reads: the walk is the same walk, so
    // the setting cannot quietly shorten what it reports.
    const input = triagePipeline({}, { sideEffectingServersByStep: { classify: ["Helpdesk"] } });
    expect(errors(input)).toHaveLength(2);
    const warned = validatePipeline({ ...input, webhookUnattended: true }).filter((problem) => problem.severity === "warning");
    expect(warned.map((problem) => problem.stateId).sort()).toEqual(["classify", "send"]);
  });

  it("says nothing at all with the setting on and no webhook entry", () => {
    const quiet = validatePipeline(triagePipeline({}, { entryReachedByWebhook: false, webhookUnattended: true }));
    expect(quiet.filter((problem) => problem.message.includes("webhook"))).toEqual([]);
    expect(quiet).toEqual(validatePipeline(triagePipeline({}, { entryReachedByWebhook: false })));
  });

  it("has nothing to warn about once a person stands in between, setting on or off", () => {
    expect(validatePipeline(withApproveStep(triagePipeline({}, { webhookUnattended: true }))).filter((problem) => problem.message.includes("webhook"))).toEqual([]);
  });

  it("leaves a module that declares no side effects alone", () => {
    const quiet = replyModule({ manifest: { ...replyModule().manifest, sideEffects: false } });
    expect(errors(triagePipeline({}, { modules: [quiet] }))).toEqual([]);
    // And one written before the flag existed, which says nothing at all.
    const silent = { ...replyModule().manifest };
    delete silent.sideEffects;
    expect(errors(triagePipeline({}, { modules: [replyModule({ manifest: silent })] }))).toEqual([]);
  });

  it("counts the forge's open-pull-request, which the developer pack marks as one", () => {
    const input = triagePipeline({ type: "builtin", entryAction: "open_pull_request" });
    input.routes = [route("classify", "done", "send"), route("send", "opened", "done", 0), route("send", "skipped", "done", 1), route("send", "failed", "user_attention", 2)];

    expect(errors(input)).toEqual(["Cases arriving by webhook go straight to Send. Add an approve step before Send."]);
    expect(errors(withApproveStep(input))).toEqual([]);
  });

  it("counts a connector the step's role can reach, which is the case §4.6 is written about", () => {
    // Nothing about the step says it sends: what sends is the helpdesk
    // server attached to the agents in its role, which the caller
    // resolves because this package cannot.
    const input = triagePipeline(
      { type: "agent", ownerRole: "implementer", entryAction: "implement" },
      { modules: [], sideEffectingServersByStep: { send: ["helpdesk"] } },
    );
    input.routes = [route("classify", "done", "send"), route("send", "done", "done")];

    expect(errors(input)).toEqual(["Cases arriving by webhook go straight to Send. Add an approve step before Send."]);
  });

  it("names every step a payload reaches unread, once each", () => {
    const input = triagePipeline({});
    input.steps = [...input.steps, step("escalate", 1.5, { name: "Escalate", type: "module", ownerRole: null, entryAction: "mod-reply" })];
    input.routes = [
      route("classify", "done", "send"),
      route("send", "sent", "done", 0),
      // The failure of the send is triaged by a second module rather
      // than by a person, which is the same hole one step further on.
      route("send", "failed", "escalate", 1),
      route("escalate", "sent", "done", 0),
      route("escalate", "failed", "user_attention", 1),
    ];
    input.existingSteps = existing("classify", "send", "escalate", "done");

    expect(errors(input)).toEqual([
      "Cases arriving by webhook go straight to Send. Add an approve step before Send.",
      "Cases arriving by webhook go straight to Escalate. Add an approve step before Escalate.",
    ]);
  });

  /**
   * A module that creates work (EO-435). It sends nothing, and it is the
   * same hole: the payload can be copied into a new item's title and
   * body, where the next agent reads it as the item's own description.
   */
  describe("a module that creates items (EO-435)", () => {
    const REFUSAL = "Send creates work from what a webhook sent, with nobody asked in between. Add an approve step before Send.";
    const WARNING = "Send creates work from what a webhook sent, with nobody asked in between.";

    /** The reply module, except that what it does is file work and say nothing of sending. */
    function creatingModule(sideEffects?: boolean): CustomModule {
      const manifest = { ...replyModule().manifest, needs: { ...replyModule().manifest.needs, create: true } };
      delete manifest.sideEffects;
      return replyModule({ manifest: sideEffects === undefined ? manifest : { ...manifest, sideEffects } });
    }

    it("refuses the graph, naming the step and what it does", () => {
      const problems = validatePipeline(triagePipeline({}, { modules: [creatingModule()] }));
      expect(problems.filter((problem) => problem.severity === "error")).toEqual([{ severity: "error", stateId: "send", message: REFUSAL }]);
      expect(hasBlockingProblem(problems)).toBe(true);
    });

    it("counts one that says outright that it has no side effects", () => {
      expect(errors(triagePipeline({}, { modules: [creatingModule(false)] }))).toEqual([REFUSAL]);
    });

    it("publishes once a person stands on every path to it", () => {
      const input = withApproveStep(triagePipeline({}, { modules: [creatingModule()] }));
      expect(validatePipeline(input).filter((problem) => problem.message.includes("webhook"))).toEqual([]);
      expect(errors(input)).toEqual([]);
    });

    it("still refuses when a person stands on one path and not the other", () => {
      const input = withApproveStep(triagePipeline({}, { modules: [creatingModule()] }));
      // A second way out of classify that goes round the approve step.
      input.routes = [...input.routes, route("classify", "verification_failed", "send", 1)];
      expect(errors(input)).toEqual([REFUSAL]);
    });

    it("warns about the same step, and publishes, with the unattended setting on", () => {
      const allowed = validatePipeline(triagePipeline({}, { modules: [creatingModule()], webhookUnattended: true }));
      expect(hasBlockingProblem(allowed)).toBe(false);
      expect(allowed.filter((problem) => problem.message.includes("webhook"))).toEqual([{ severity: "warning", stateId: "send", message: WARNING }]);
    });

    it("says nothing on a pipeline no webhook enters, setting on or off", () => {
      for (const webhookUnattended of [false, true]) {
        const quiet = validatePipeline(triagePipeline({}, { modules: [creatingModule()], entryReachedByWebhook: false, webhookUnattended }));
        expect(quiet.filter((problem) => problem.message.includes("webhook"))).toEqual([]);
        expect(hasBlockingProblem(quiet)).toBe(false);
      }
    });

    it("reports a module that sends and does not create in the words it always was", () => {
      expect(replyModule().manifest.needs.create).toBe(false);
      expect(errors(triagePipeline({}))).toEqual(["Cases arriving by webhook go straight to Send. Add an approve step before Send."]);
      expect(validatePipeline(triagePipeline({}, { webhookUnattended: true })).filter((problem) => problem.message.includes("webhook"))).toEqual([
        { severity: "warning", stateId: "send", message: "Items arriving by webhook reach Send without a person reading them first." },
      ]);
    });

    it("reports a module that does both once, as one that sends", () => {
      // The sending sentence is true of it and is the one already read;
      // the creating sentence is for a step that counts for no other reason.
      expect(errors(triagePipeline({}, { modules: [creatingModule(true)] }))).toEqual(["Cases arriving by webhook go straight to Send. Add an approve step before Send."]);
    });
  });

  it("is a refusal rather than a warning, which is this story's decision to revisit", () => {
    // Written down here because the alternative was considered: a
    // warning on the publish screen is a line somebody reads once and
    // publishes past, and what it protects is the one way into an
    // installation that nobody in it controls. It stays an error until
    // a customer asks otherwise.
    expect(validatePipeline(triagePipeline({})).map((problem) => problem.severity)).toEqual(["error"]);
    expect(hasBlockingProblem(validatePipeline(triagePipeline({})))).toBe(true);
  });
});

/**
 * An agent step's routes against what its action declares (EO-423).
 *
 * The check a builtin and a module step have had since EO-77, asked of
 * the step it could not be asked of while an agent's answer was whatever
 * its prompt said. An action is a declared thing now — a pack's, or one
 * a role defined for itself — so its keys are known at publish.
 */
describe("an agent step's routes against its action's declared results (EO-423)", () => {
  /** The registry as shipped, plus what roles on this installation defined for themselves. */
  function withRoleActions(defined: Record<string, Record<string, string[]>>): RegistryFacts {
    return {
      ...registry,
      roleActions: new Map(
        Object.entries(defined).map(([role, actions]) => [
          role,
          new Map(
            Object.entries(actions).map(([action, keys]): [string, ActionFacts] => [
              action,
              { description: "", results: keys.map((key) => ({ key, label: key })), packShipped: false },
            ]),
          ),
        ]),
      ),
    };
  }

  /** The shipped shape with a `qa` step between review and merge, on an action of the caller's choosing. */
  function withQa(action: string, routes: StepRoute[], registryFacts: RegistryFacts = registry): ValidatePipelineInput {
    const input = goodPipeline();
    return {
      ...input,
      registry: registryFacts,
      steps: [input.steps[0]!, input.steps[1]!, step("qa", 2, { ownerRole: "qa", entryAction: action }), { ...input.steps[2]!, position: 3 }],
      routes: [...input.routes.map((existing) => (existing.fromStepId === "review" && existing.resultKey === "approved" ? route("review", "approved", "qa") : existing)), ...routes],
      staffedRoles: [...input.staffedRoles, "qa"],
      existingSteps: existing("implement", "review", "qa", "merge"),
    };
  }

  const ALIGNMENT = withRoleActions({ qa: { alignment: ["aligned", "gaps_found"] } });

  it("accepts a step that routes exactly what its role's own action declares", () => {
    expect(validatePipeline(withQa("alignment", [route("qa", "aligned", "merge"), route("qa", "gaps_found", "implement", 1)], ALIGNMENT))).toEqual([]);
  });

  it("refuses a route on a key the action does not declare, naming the key, the action and what it does declare", () => {
    const input = withQa("alignment", [route("qa", "aligned", "merge"), route("qa", "gaps_found", "implement", 1), route("qa", "shrugged", "merge", 2)], ALIGNMENT);

    expect(validatePipeline(input)).toEqual([
      { severity: "error", stateId: "qa", resultKey: "shrugged", message: '"shrugged" is not a result the "alignment" action can return (aligned, gaps_found).' },
    ]);
  });

  it("refuses a declared key nothing routes, and says it can go to user_attention", () => {
    const input = withQa("alignment", [route("qa", "aligned", "merge")], ALIGNMENT);
    const problems = validatePipeline(input);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: "error", stateId: "qa", resultKey: "gaps_found" });
    expect(problems[0]!.message).toContain('"gaps_found"');
    expect(problems[0]!.message).toContain('"alignment"');
    expect(problems[0]!.message).toContain("user_attention");

    // And routing it there is what clears it.
    expect(validatePipeline(withQa("alignment", [route("qa", "aligned", "merge"), route("qa", "gaps_found", "user_attention", 1)], ALIGNMENT))).toEqual([]);
  });

  it("refuses every declared key on a step with no routes at all, rather than letting them walk on by position", () => {
    // Stricter than a builtin or a module, which warn: every answer
    // would advance the same way, and the keys exist to stop that.
    const input = withQa("alignment", [], ALIGNMENT);

    expect(validatePipeline(input).map((problem) => [problem.severity, problem.resultKey])).toEqual([
      ["error", "aligned"],
      ["error", "gaps_found"],
    ]);
  });

  it.each(["needs_user_input", "escalation", "verification_failed"])("never reports a route on %s as undeclared", (engineKey) => {
    // `implement` declares `done` alone. These three are produced by EO
    // whatever ran, so a route on one is a branch that can be taken.
    const input = goodPipeline();
    input.routes = [...input.routes, route("implement", engineKey, "user_attention", 1)];
    expect(validatePipeline(input)).toEqual([]);

    const custom = withQa("alignment", [route("qa", "aligned", "merge"), route("qa", "gaps_found", "implement", 1), route("qa", engineKey, "user_attention", 2)], ALIGNMENT);
    expect(validatePipeline(custom)).toEqual([]);
  });

  it("does not require a route for an engine result the action does not declare", () => {
    // `goodPipeline` routes none of the three out of `implement`.
    expect(validatePipeline(goodPipeline())).toEqual([]);
  });

  it("requires an engine result the action does declare, like any other", () => {
    // The pack's `review` returns `needs_user_input` as a verdict.
    const input = goodPipeline();
    input.routes = input.routes.filter((existing) => existing.resultKey !== "needs_user_input");

    expect(errors(input)).toEqual([expect.stringContaining('The "review" action can return "needs_user_input"')]);
  });

  it("warns, and does not refuse, when neither the role nor an installed pack defines the action", () => {
    const input = withQa("ponder", [route("qa", "done", "merge")]);
    const problems = validatePipeline(input);

    expect(problems).toEqual([
      {
        severity: "warning",
        stateId: "qa",
        message: '"qa" asks "qa" for "ponder", which neither that role nor an installed pack defines — its answer is not validated and will route as "done".',
      },
    ]);
    expect(hasBlockingProblem(problems)).toBe(false);
    // Whatever it routes: with nothing declared there is nothing to hold the routes to.
    expect(errors(withQa("ponder", [route("qa", "anything", "merge")]))).toEqual([]);
  });

  it("holds a custom role with no definition of its own to the pack's action of that name", () => {
    // `qa` on a `review` step that defined nothing is the pack's review.
    const input = withQa("review", [route("qa", "approved", "merge"), route("qa", "changes_requested", "implement", 1)]);

    expect(errors(input)).toEqual([expect.stringContaining('The "review" action can return "needs_user_input"')]);
  });

  it("lets a role's own definition of a pack's action name win, for that role alone", () => {
    const own = withRoleActions({ qa: { review: ["passed", "failed"] } });
    const input = withQa("review", [route("qa", "passed", "merge"), route("qa", "failed", "implement", 1)], own);

    // `qa` is held to its own two keys, and the reviewer beside it to
    // the pack's three — which `goodPipeline` routes.
    expect(validatePipeline(input)).toEqual([]);
    expect(errors(withQa("review", [route("qa", "approved", "merge"), route("qa", "changes_requested", "implement", 1)], own))).toEqual(
      expect.arrayContaining(['"approved" is not a result the "review" action can return (passed, failed).']),
    );
  });

  it("never applies one role's definition to another role", () => {
    const elsewhere = withRoleActions({ auditor: { alignment: ["aligned", "gaps_found"] } });
    const input = withQa("alignment", [route("qa", "done", "merge")], elsewhere);

    expect(validatePipeline(input).map((problem) => problem.severity)).toEqual(["warning"]);
  });

  it("says the same thing from the registry as it crosses IPC", () => {
    // The renderer holds `fromRegistryView` of what main sent. A graph
    // with one of each finding, so "the same" is not two empty lists.
    const inputWith = (facts: RegistryFacts) => {
      const input = withQa("alignment", [route("qa", "aligned", "merge"), route("qa", "shrugged", "merge", 1)], facts);
      input.routes = input.routes.filter((existing) => existing.resultKey !== "changes_requested");
      return input;
    };
    const overTheWire = fromRegistryView(JSON.parse(JSON.stringify(toRegistryView(ALIGNMENT))));

    const here = validatePipeline(inputWith(ALIGNMENT));
    expect(validatePipeline(inputWith(overTheWire))).toEqual(here);
    expect(here.filter((problem) => problem.severity === "error").map((problem) => [problem.stateId, problem.resultKey])).toEqual([
      ["review", "changes_requested"],
      ["qa", "shrugged"],
      ["qa", "gaps_found"],
    ]);
  });
});

/**
 * Keep checking (EO-456): a builtin or module step checking on an
 * interval, held to the function or module saying it can wait.
 */
describe("validatePipeline: keep checking", () => {
  /** The shipped registry plus one function written to be checked. */
  const waitingRegistry = {
    ...registry,
    builtins: new Map([...registry.builtins, ["check_status", { label: "Check the status", results: ["arrived", "failed"], sideEffects: false, watch: true }]]),
  };

  function withWatchingBuiltin(watch: PipelineStep["watch"], action = "check_status"): ValidatePipelineInput {
    const input = goodPipeline();
    return {
      ...input,
      steps: [input.steps[0]!, input.steps[1]!, step("wait", 1.5, { type: "builtin", ownerRole: null, entryAction: action, watch }), input.steps[2]!],
      routes: [
        route("implement", "done", "review"),
        route("review", "approved", "wait", 0),
        route("review", "changes_requested", "implement", 1),
        route("review", "needs_user_input", "user_attention", 2),
        route("wait", "arrived", "merge", 0),
        route("wait", "failed", "user_attention", 1),
      ],
      existingSteps: existing("implement", "review", "wait", "merge"),
      registry: waitingRegistry,
    };
  }

  it("saves a builtin step that keeps checking with an interval and a give-up time, when its function can wait", () => {
    expect(errors(withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: 168 }))).toEqual([]);
    expect(errors(withWatchingBuiltin({ everyMinutes: 1, giveUpAfterHours: 2 }))).toEqual([]);
  });

  it("refuses an interval under a minute with a sentence naming the step", () => {
    expect(errors(withWatchingBuiltin({ everyMinutes: 0.5, giveUpAfterHours: 168 }))).toEqual([
      `"wait" checks every 0.5 minutes, and a step that keeps checking may check at most once a minute.`,
    ]);
    expect(errors(withWatchingBuiltin({ everyMinutes: 0, giveUpAfterHours: 168 }))).toHaveLength(1);
  });

  it("refuses a give-up time that would stop the watch before it started", () => {
    expect(errors(withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: 0 }))[0]).toContain(`"wait" gives up after 0 hours`);
  });

  it("saves a step that never gives up, and still refuses nought, a negative or a non-finite give-up time by name (EO-571)", () => {
    expect(errors(withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: 168, neverGivesUp: true }))).toEqual([]);
    const sentence = (hours: number) => `"wait" gives up after ${hours} hours, so it would stop before it had checked at all. Give it a time in hours above nought.`;
    for (const hours of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(errors(withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: hours }))).toEqual([sentence(hours)]);
      // The hours are what a device that predates the flag reads, so they are held there too.
      expect(errors(withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: hours, neverGivesUp: true }))).toEqual([sentence(hours)]);
    }
  });

  it("refuses keep checking on a builtin whose declaration does not say it can wait", () => {
    const input = withBuiltinStep({ watch: { everyMinutes: 5, giveUpAfterHours: 168 } });
    expect(errors(input)).toEqual([
      `"merge_request" is set to keep checking, but "open_pull_request" does not say it can wait — it runs once. Turn keep checking off, or pick a function made to be checked.`,
    ]);
  });

  it("refuses keep checking on a module whose manifest does not say it can wait, and accepts one whose manifest does", () => {
    const watch = { everyMinutes: 10, giveUpAfterHours: 24 };
    expect(errors(withModuleStep({ watch }))).toEqual([
      `"deploy" is set to keep checking, but "Deploy" does not say it can wait — its manifest does not declare \`watch: true\`. Turn keep checking off, or pick a module made to be checked.`,
    ]);
    const canWait = deployModule().manifest;
    expect(errors(withModuleStep({ watch }, { manifest: { ...canWait, watch: true } }))).toEqual([]);
  });

  it("refuses the mode on a step that does not run anything of its own", () => {
    const input = goodPipeline();
    input.steps[1] = { ...input.steps[1]!, watch: { everyMinutes: 5, giveUpAfterHours: 168 } };
    expect(errors(input)).toEqual([`"review" is set to keep checking, which only a step EO runs or a step a script runs can do.`]);
  });

  it("refuses a route on `waiting`, which a check says while it waits and which never moves the item", () => {
    const input = withWatchingBuiltin({ everyMinutes: 5, giveUpAfterHours: 168 });
    input.routes.push(route("wait", "waiting", "implement", 2));
    // Once, in its own sentence, and not again as a result the function never returns (EO-505).
    expect(errors(input)).toEqual([`"wait" routes "waiting", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`]);
  });

  it("says nothing new about a step that runs once", () => {
    expect(errors(withBuiltinStep())).toEqual([]);
  });

  it("passes a pipeline that waits with the core's wait_until, with no pack installed (EO-459)", () => {
    // Nothing but the core: no roles, no agents, no developer pack —
    // a date to wait for and somewhere to go once it has come.
    const input: ValidatePipelineInput = {
      steps: [
        step("wait", 0, { type: "builtin", ownerRole: null, entryAction: "wait_until", inputs: { field: "due" }, watch: { everyMinutes: 15, giveUpAfterHours: 168 } }),
        step("done", 1, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
      ],
      entryStepId: "wait",
      routes: [route("wait", "reached", "done", 0), route("wait", "failed", "user_attention", 1)],
      staffedRoles: [],
      itemCountByStep: {},
      existingSteps: existing("wait", "done"),
      registry: coreRegistry(),
    };
    expect(validatePipeline(input).filter((problem) => problem.severity === "error")).toEqual([]);

    // And a key it never declared is still caught, so the pass above is
    // the registry answering rather than the validator looking away.
    input.routes.push(route("wait", "arrived", "done", 2));
    expect(errors(input).join("\n")).toContain("arrived");
  });
});

/**
 * A check on a step that runs once (EO-505): every kind that answers
 * `waiting` before it has a result, refused where keep checking is off,
 * and a route on `waiting` refused wherever it is.
 */
describe("validatePipeline: a check on a step that runs once", () => {
  /** The shipped pack's registry with the core's own builtins beside it, as an installation holds them. */
  const installed: RegistryFacts = { ...registry, builtins: new Map([...coreRegistry().builtins, ...registry.builtins]) };

  /** A step running `action` once, between review and merge, with `results` routed on. */
  function withRunOnceBuiltin(action: string, results: readonly string[], facts: RegistryFacts = installed): ValidatePipelineInput {
    const input = goodPipeline();
    return {
      ...input,
      steps: [input.steps[0]!, input.steps[1]!, step("wait", 1.5, { type: "builtin", ownerRole: null, entryAction: action, inputs: { field: "due" } }), input.steps[2]!],
      routes: [
        route("implement", "done", "review"),
        route("review", "approved", "wait", 0),
        route("review", "changes_requested", "implement", 1),
        route("review", "needs_user_input", "user_attention", 2),
        ...results.map((result, index) => route("wait", result, result === "failed" ? "user_attention" : "merge", index)),
      ],
      existingSteps: existing("implement", "review", "wait", "merge"),
      registry: facts,
    };
  }

  it("refuses wait_until on a step that runs once, naming the step", () => {
    expect(errors(withRunOnceBuiltin("wait_until", ["reached", "failed"]))).toEqual([
      `"wait" runs "wait_until", which answers "waiting" until it has a result, but "wait" runs once — nothing would ever ask it again, and every item would park on its first run. Turn keep checking on for "wait".`,
    ]);
    // The core's alone, with no pack installed, says the same.
    const coreOnly: ValidatePipelineInput = {
      steps: [
        step("wait", 0, { type: "builtin", ownerRole: null, entryAction: "wait_until", inputs: { field: "due" } }),
        step("done", 1, { type: "user", ownerRole: null, entryAction: null, isTerminal: true }),
      ],
      entryStepId: "wait",
      routes: [route("wait", "reached", "done", 0), route("wait", "failed", "user_attention", 1)],
      staffedRoles: [],
      itemCountByStep: {},
      existingSteps: existing("wait", "done"),
      registry: coreRegistry(),
    };
    expect(errors(coreOnly)).toEqual([
      `"wait" runs "wait_until", which answers "waiting" until it has a result, but "wait" runs once — nothing would ever ask it again, and every item would park on its first run. Turn keep checking on for "wait".`,
    ]);
  });

  it("refuses watch_pull_request on a step that runs once, naming the step", () => {
    const results = ["merged", "closed", "conflict", "checks_failed", "changes_requested", "ready", "failed"];
    expect(errors(withRunOnceBuiltin("watch_pull_request", results))).toEqual([
      `"wait" runs "watch_pull_request", which answers "waiting" until it has a result, but "wait" runs once — nothing would ever ask it again, and every item would park on its first run. Turn keep checking on for "wait".`,
    ]);
  });

  it("passes the same steps once keep checking is on", () => {
    const watch = { everyMinutes: 5, giveUpAfterHours: 168 };
    const waitUntil = withRunOnceBuiltin("wait_until", ["reached", "failed"]);
    waitUntil.steps[2] = { ...waitUntil.steps[2]!, watch };
    expect(errors(waitUntil)).toEqual([]);
    const pullRequest = withRunOnceBuiltin("watch_pull_request", ["merged", "closed", "conflict", "checks_failed", "changes_requested", "ready", "failed"]);
    pullRequest.steps[2] = { ...pullRequest.steps[2]!, watch };
    expect(errors(pullRequest)).toEqual([]);
  });

  it("refuses a module whose manifest declares watch: true on a step that runs once, and passes one that does not", () => {
    const canWait = { ...deployModule().manifest, watch: true };
    expect(errors(withModuleStep({}, { manifest: canWait }))).toEqual([
      `"deploy" runs "Deploy", whose manifest declares \`watch: true\` — it answers "waiting" until it has a result — but "deploy" runs once, so nothing would ever ask it again and every item would park on its first run. Turn keep checking on for "deploy".`,
    ]);
    expect(errors(withModuleStep({}))).toEqual([]);
    expect(errors(withModuleStep({ watch: { everyMinutes: 10, giveUpAfterHours: 24 } }, { manifest: canWait }))).toEqual([]);
  });

  it("refuses a route on `waiting` from a step that runs once", () => {
    const input = withBuiltinStep();
    input.routes.push(route("merge_request", "waiting", "implement", 5));
    expect(errors(input)).toEqual([
      `"merge_request" routes "waiting", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`,
    ]);
  });

  it("refuses a route on `waiting` from a module step, even one whose manifest lists it as a result", () => {
    const input = withModuleStep({}, { manifest: { ...deployModule().manifest, results: ["deployed", "failed", "waiting"] } });
    expect(warnings(input).join("\n")).not.toContain(`"waiting"`);
    input.routes.push(route("deploy", "waiting", "implement", 2));
    expect(errors(input)).toEqual([
      `"deploy" routes "waiting", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`,
    ]);
  });

  it("refuses a route on `waiting` from an agent step and from a person's step", () => {
    const fromAgent = goodPipeline();
    fromAgent.routes.push(route("implement", "waiting", "review", 1));
    expect(errors(fromAgent)).toEqual([
      `"implement" routes "waiting", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`,
    ]);

    const fromPerson = goodPipeline();
    fromPerson.steps[2] = { ...fromPerson.steps[2]!, isTerminal: false, results: [{ key: "done", label: "Done", tone: "success", requiresComment: false }] };
    fromPerson.routes.push(route("merge", "done", "terminal", 0), route("merge", "waiting", "implement", 1));
    expect(errors(fromPerson)).toContain(`"merge" routes "waiting", which is what a check says while it is still waiting — it never moves the item, so the route could never be taken.`);
  });
});

/**
 * Whether each step sends or creates outside EO (EO-584): the webhook
 * refusal's classification, every step at once, which is what the
 * assistant reads to propose how a step runs on a trial.
 */
describe("outsideReachByStep (EO-584)", () => {
  const sending = deployModule({ id: "mod-send" as Uuid, manifest: { ...deployModule().manifest, sideEffects: true } });
  const creating = deployModule({ id: "mod-create" as Uuid, manifest: { ...deployModule().manifest, needs: { ...deployModule().manifest.needs, create: true } } });
  const quiet = deployModule({ id: "mod-quiet" as Uuid });
  const steps = [
    step("open_pr", 0, { type: "builtin", ownerRole: null, entryAction: "open_pull_request" }),
    step("worktree", 1, { type: "builtin", ownerRole: null, entryAction: "create_worktree" }),
    step("send", 2, { type: "module", ownerRole: null, entryAction: "mod-send" }),
    step("file", 3, { type: "module", ownerRole: null, entryAction: "mod-create" }),
    step("build", 4, { type: "module", ownerRole: null, entryAction: "mod-quiet" }),
    step("reply", 5),
    step("think", 6),
    step("approve", 7, { type: "user", ownerRole: null, entryAction: null }),
  ];

  it("says a builtin with side effects sends, and one without says nothing", () => {
    const reach = outsideReachByStep({ steps, registry });
    expect(reach.open_pr).toBe("sends");
    expect(reach.worktree).toBeUndefined();
  });

  it("says a module sends from its manifest's sideEffects and creates from needs.create, and a quiet one says nothing", () => {
    const reach = outsideReachByStep({ steps, registry, modules: [sending, creating, quiet] });
    expect(reach).toMatchObject({ send: "sends", file: "creates" });
    expect(reach.build).toBeUndefined();
  });

  it("says an agent step sends when its role can reach a connector with side effects, and nothing otherwise", () => {
    const reach = outsideReachByStep({ steps, registry, modules: [sending, creating, quiet], sideEffectingServersByStep: { reply: ["helpdesk"] } });
    expect(reach.reply).toBe("sends");
    expect(reach.think).toBeUndefined();
    expect(reach.approve).toBeUndefined();
  });

  it("agrees with the webhook refusal about every step it names", () => {
    // The refusal reads the same function, so a step this calls `sends`
    // is the step a webhook reaching it is refused for.
    const reach = outsideReachByStep({ steps, registry, modules: [sending, creating, quiet], sideEffectingServersByStep: { reply: ["helpdesk"] } });
    expect(Object.keys(reach).sort()).toEqual(["file", "open_pr", "reply", "send"]);
  });
});
