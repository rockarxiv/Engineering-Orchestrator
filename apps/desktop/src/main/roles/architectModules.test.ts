import { PROPOSED_MODULE_NEEDS_TESTS, validateActionResult, type ConfigureOutput, type ModuleManifest, type PipelineDraft, type ProposedModule } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRoutesForPipeline, listStepsForPipeline, saveModule } from "../db/repos/index.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { renderDraft, validateDraft } from "./architect.js";
import { registryForProject } from "../registry.js";
import { ASSIST_ACTION } from "./conversationSteps.js";

/**
 * A pipeline draft proposing a module (KAN-107) — the assistant's, since
 * the Architecture panel went (EO-526).
 *
 * The interesting part is the ordering. A module the assistant wrote has
 * no id when the draft naming it is written, and `validatePipeline`
 * refuses a step naming a module that is not there — so a draft
 * introducing one would be rejected before anybody could read it unless
 * the validator is told what is being proposed alongside it.
 */

let handle: DbHandle;

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Builds and deploys the branch to staging.",
  inputs: {},
  needs: { bin: ["flyctl"], env: ["FLY_API_TOKEN"], network: true, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

function proposedModule(overrides: Partial<ProposedModule> = {}): ProposedModule {
  return {
    name: "Deploy",
    slug: "deploy",
    description: "Builds and deploys the branch to staging.",
    code: "export default async function run(ctx) { return { ok: true, result: 'deployed', detail: '' }; }",
    manifest,
    originalScript: null,
    why: "A deploy was a script before agents existed; there is no judgement in it.",
    tests: [
      {
        description: "deploys the branch",
        source: "export default async function (harness) { await harness.run({ exec: [{ bin: 'flyctl', code: 0 }] }); }",
      },
    ],
    ...overrides,
  };
}

/** The shipped pipeline, read back, so "unchanged" means exactly that. */
function currentGraph(): PipelineDraft {
  const steps = listStepsForPipeline(handle.db, "default").filter((step) => !step.offBoard);
  return {
    rationale: "No change.",
    entryStepId: "worktree",
    removes: [],
    steps: steps.map((step) => ({
      id: step.id,
      position: step.position,
      name: step.name,
      type: step.type,
      ownerRole: step.ownerRole,
      entryAction: step.entryAction,
      instructionsSummary: step.instructionsSummary,
      isTerminal: step.isTerminal,
      planMode: step.planMode,
    })),
    routes: listRoutesForPipeline(handle.db, "default").map((route) => ({
      fromStepId: route.fromStepId,
      resultKey: route.resultKey,
      label: route.label,
      tone: route.tone,
      target: route.target,
      position: route.position,
    })),
  };
}

/** A reply as these tests write one: `actions` (EO-426) is left out by every turn that proposes none. */
type Reply = Omit<ConfigureOutput, "actions"> & Partial<Pick<ConfigureOutput, "actions">>;

/** The shipped graph with a deploy step wired in front of review. */
function graphWithDeploy(entryAction: string): PipelineDraft {
  const base = currentGraph();
  return {
    ...base,
    rationale: "Deploy to staging before review sees it.",
    steps: [
      ...base.steps,
      { id: "deploy", position: 15, name: "Deploy", type: "module", ownerRole: null, entryAction, instructionsSummary: null, isTerminal: false, planMode: false },
    ],
    routes: [
      ...base.routes.filter((route) => !(route.fromStepId === "todo" && route.resultKey === "done")),
      { fromStepId: "todo", resultKey: "done", label: "Done", tone: "success", target: "deploy", position: 0 },
      { fromStepId: "deploy", resultKey: "deployed", label: "Deployed", tone: "success", target: "review", position: 0 },
      { fromStepId: "deploy", resultKey: "failed", label: "Failed", tone: "danger", target: "todo", position: 1 },
    ],
  };
}

/** The card one reply's draft renders as, or why it renders as none. */
function card(output: Reply): string {
  const rendered = renderDraft(handle.db, "default", { ...output, actions: [] });
  if (!rendered.ok) throw new Error(rendered.reason);
  return rendered.body;
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("a draft that proposes a module", () => {
  /**
   * The ordering problem, stated as a test.
   *
   * The step names the module by slug because there is no id yet.
   * Without the proposals reaching the validator this is "a module this
   * installation does not have" — a card that cannot be applied, which
   * is worse than no card.
   */
  it("validates against the modules proposed alongside it", () => {
    const problems = validateDraft(handle.db, "default", graphWithDeploy("deploy"), [proposedModule()]);
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });

  it("is refused when the module is neither proposed nor in the catalog", () => {
    const problems = validateDraft(handle.db, "default", graphWithDeploy("deploy"), []);
    expect(problems.some((problem) => problem.severity === "error" && problem.message.includes("does not have"))).toBe(true);
  });

  // The declared-results check, reaching a draft. A route to a key the
  // module cannot return is an edge somebody believes in and nothing can
  // ever take.
  it("is refused when a route uses a result the proposed module cannot return", () => {
    const graph = graphWithDeploy("deploy");
    graph.routes = [...graph.routes, { fromStepId: "deploy", resultKey: "rolled_back", label: "Rolled back", tone: "warning", target: "todo", position: 2 }];

    const problems = validateDraft(handle.db, "default", graph, [proposedModule()]);
    expect(problems.some((problem) => problem.severity === "error" && problem.message.includes("rolled_back"))).toBe(true);
  });

  it("validates against a module the catalog already has, by id", () => {
    const saved = saveModule(handle.db, { slug: "deploy", name: "Deploy", description: "Deploys.", code: "export default async function run() {}", manifest, approve: true });
    if (!saved.ok) throw new Error(saved.reason);

    const problems = validateDraft(handle.db, "default", graphWithDeploy(saved.module.id), []);
    expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
  });

  /**
   * What the person is asked to agree to.
   *
   * The needs first, because that is the part somebody can weigh without
   * reading JavaScript, and the module-versus-agent reason after it —
   * which is the judgement this whole feature turns on.
   */
  it("puts what the module needs, and why it is a module, on the card", () => {
    const body = card({
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [],
      modules: [proposedModule()],
      draft: graphWithDeploy("deploy"),
    });

    expect(body).toContain("**New module** Deploy");
    expect(body).toContain("flyctl");
    expect(body).toContain("FLY_API_TOKEN");
    expect(body).toContain("returns deployed, failed");
    expect(body).toContain("Why a module: A deploy was a script");
  });

  it("names the module's test cases on the card", () => {
    const body = card({
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [],
      modules: [proposedModule()],
      draft: graphWithDeploy("deploy"),
    });

    expect(body).toContain("Tests: deploys the branch");
  });
});

/**
 * A module proposed without its tests (EO-355).
 *
 * A module with no test cases cannot be approved (EO-353), so the graph
 * naming it could never be published. The refusal has to reach the
 * *agent*: a result that fails its action's schema is sent back to it
 * with the validation message (A-02), which is why the rule lives in the
 * schema (below, on the assist path) as well as on the card.
 */
describe("a module proposed without tests", () => {
  it("is refused by the card renderer, saying why", () => {
    const rendered = renderDraft(handle.db, "default", {
      message: "Here it is.",
      questions: [],
      agents: [],
      runtimes: [],
      modules: [proposedModule({ tests: [] })],
      draft: graphWithDeploy("deploy"),
    });
    expect(rendered).toEqual({ ok: false, reason: expect.stringContaining('"Deploy" has no test cases.') });
  });
});

/**
 * The assist path, through the registry the supervisor validates a run's
 * result with (EO-355, EO-381).
 *
 * An assist turn may propose a module beside its draft now, in this
 * room's shape — so it is held to this room's rule: a module without
 * test cases is refused at validation, with the sentence the agent is
 * re-prompted with.
 */
describe("an assist result proposing a module", () => {
  it("is refused without tests by the registry a run is validated against, with the refusal the agent is re-prompted with", () => {
    const withoutTests: Partial<ProposedModule> = proposedModule();
    delete withoutTests.tests;
    const validated = validateActionResult(registryForProject(handle.db, null), ASSIST_ACTION, {
      message: "Here is a module.",
      draft: graphWithDeploy("deploy"),
      modules: [withoutTests],
    });
    expect(validated).toEqual({ ok: false, error: expect.stringContaining(PROPOSED_MODULE_NEEDS_TESTS) });
  });

  it("is accepted with its tests beside a draft", () => {
    const validated = validateActionResult(registryForProject(handle.db, null), ASSIST_ACTION, {
      message: "Here is a module.",
      draft: graphWithDeploy("deploy"),
      modules: [proposedModule()],
    });
    expect(validated.ok).toBe(true);
  });

  it("still accepts an ordinary assist turn", () => {
    expect(validateActionResult(registryForProject(handle.db, null), ASSIST_ACTION, { message: "That item is on Review." }).ok).toBe(true);
  });
});
