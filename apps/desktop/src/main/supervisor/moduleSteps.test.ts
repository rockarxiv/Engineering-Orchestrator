import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMINAL_TARGET, type ModuleManifest, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createPipeline, createRoute, createStep, currentOutputOf, getItem, listCommentsForItem, listRunsForItem, postComment, saveModule, transitionItem } from "../db/repos/index.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { createRunSupervisor } from "./runSupervisor.js";
import type { BuiltinRunner } from "./builtins.js";
import { fakeWorkspaceKind, installedKinds, type FakeVerifier } from "./testWorkspaceKinds.js";
import type { Artifact, Check, WorkspaceKind } from "./workspaceKind.js";

/**
 * A `module` step running (KAN-105).
 *
 * Everything a builtin step gets — a run row, an elapsed time, routing on
 * the result it reports, park-on-failure with a comment — reused rather
 * than reimplemented. What is tested here is that the reuse is real: the
 * host itself is covered in `modules/runModule.test.ts`, and a stub
 * runner is enough to prove the supervisor half.
 */

const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const manifest: ModuleManifest = {
  name: "Deploy",
  description: "Deploys the branch to staging.",
  inputs: {},
  needs: { bin: [], env: [], network: false, item: false, comment: false, attach: false, create: false },
  results: ["deployed", "failed"],
};

let handle: DbHandle;
let item: Item;
let moduleId: string;

function supervisorWith(runner: BuiltinRunner | undefined, kind?: WorkspaceKind) {
  return createRunSupervisor({
    db: handle.db,
    provider: { start: () => { throw new Error("a module must not reach a provider"); } } as never,
    ...createRoleWiring(handle.db),
    limits: LIMITS,
    moduleRunner: () => runner,
    ...(kind ? { kinds: installedKinds(kind) } : {}),
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();

  const saved = saveModule(handle.db, {
    slug: "deploy",
    name: "Deploy",
    description: "Deploys the branch to staging.",
    code: "export default async function run() {}",
    manifest,
    approve: true,
  });
  if (!saved.ok) throw new Error(saved.reason);
  moduleId = saved.module.id;

  // A module step on the seeded pipeline, between `todo` and `review`.
  createStep(handle.db, { id: "deploy", pipelineId: "default" as Uuid, position: 15, name: "Deploy", type: "module", entryAction: moduleId });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "deploy", resultKey: "deployed", label: "Deployed", target: "review" });
  createRoute(handle.db, { pipelineId: "default" as Uuid, fromStepId: "deploy", resultKey: "failed", label: "Failed", target: "todo", position: 1 });

  item = createTestItem(handle.db, { type: "story", title: "Rate limit the API", stepId: "deploy" });
});

afterEach(() => {
  handle.close();
});

/**
 * What a module produced, as the item's output (EO-298,
 * ARCHITECTURE.md, "The interface").
 *
 * The original design asks the supervisor for a run's artifacts "on the agent path and
 * on the builtin and module path", and a module is the case that makes
 * the second half matter rather than merely complete the sentence: the
 * report a step writes into a folder is exactly the deliverable an
 * output comment exists to carry, and there is no agent behind it to
 * post one.
 */
describe("what a module produced", () => {
  const REPORT: Artifact = {
    kind: "report",
    name: "week-14.md",
    mediaType: "text/markdown",
    body: "## Week 14\n\nSignups are up 8%, and the onboarding change is why.",
  };

  /** A module that does what every real one does first: asks for somewhere to work. */
  function reportRunner(): BuiltinRunner {
    return async ({ item: onItem, prepareWorkspace }) => {
      // The only reason the supervisor knows where this run worked, and
      // so the only reason there is anywhere to gather from (EO-297).
      const prepared = await prepareWorkspace(onItem, moduleId);
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
      return { ok: true, result: "deployed", detail: "Wrote the report" };
    };
  }

  /** A run against a kind that produced `artifacts`, and optionally checked something first. */
  async function ranProducing(
    artifacts: readonly Artifact[],
    options: { cwd?: string; verifiers?: Record<string, FakeVerifier> } = {},
  ): Promise<void> {
    await supervisorWith(
      reportRunner(),
      fakeWorkspaceKind({
        cwd: options.cwd ?? "/tmp/eo/reports/EO-1",
        artifacts: async () => artifacts,
        ...(options.verifiers ? { verifiers: options.verifiers } : {}),
      }),
    ).runOnce();
  }

  it("becomes the item's output, authored by the module and by its run", async () => {
    await ranProducing([REPORT]);

    const output = currentOutputOf(handle.db, item.id);
    expect(output?.body).toBe(REPORT.body);
    expect(output?.kind).toBe("output");
    // A module, not an agent and not EO: there is no agent row behind
    // this, and `engine` would mean EO talking about its own bookkeeping
    // (EO-75).
    expect(output?.authorType).toBe("module");
    expect(output?.authorId).toBeNull();
    expect(output?.runId).toBe(listRunsForItem(handle.db, item.id)[0]?.id);
  });

  it("is the deliverable and nothing else — a module signs its notes, not its output", async () => {
    await ranProducing([REPORT]);

    // `postModuleComment` prepends `**Deploy** (module)` to a module's
    // remarks, because a remark in a thread needs a voice and the body
    // is the only part Jira receives. An output is the thing a step
    // sends, and a signature in it is a signature that gets sent.
    expect(currentOutputOf(handle.db, item.id)?.body.startsWith("## Week 14")).toBe(true);
    expect(currentOutputOf(handle.db, item.id)?.body).not.toContain("(module)");
  });

  it("records where it worked, which is how the output was found at all", async () => {
    await ranProducing([REPORT], { cwd: "/tmp/eo/reports/somewhere-else" });

    // `runs.cwd` was empty on this whole path before EO-298: a module
    // prepares inside its own runner, so nothing told the supervisor.
    expect(listRunsForItem(handle.db, item.id)[0]?.cwd).toBe("/tmp/eo/reports/somewhere-else");
  });

  it("still routes the item on the result it reported", async () => {
    await ranProducing([REPORT]);

    // The output is beside the routing, not instead of it.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("posts nothing when the kind produced nothing, which is every git installation today", async () => {
    await ranProducing([]);

    expect(currentOutputOf(handle.db, item.id)).toBeUndefined();
    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.kind === "output")).toEqual([]);
  });

  it("is not claimed at all when the workspace would not confirm the run (EO-297)", async () => {
    // The ordering the agent path has had since EO-298 and this path
    // gained with verification: an output is a claim that the ticket has
    // produced something, and EO does not make one on work its own
    // workspace has just refused to confirm. The module said it wrote
    // the report; the folder says the file is not there.
    await ranProducing([REPORT], {
      verifiers: {
        [moduleId]: async () => [
          { key: "wrote-it", passed: false, blocks: true, describes: "week-14.md is not in the folder the step writes to." },
        ],
      },
    });

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(currentOutputOf(handle.db, item.id)).toBeUndefined();
  });

  it("is claimed when a check only reports, because the work still stands", async () => {
    await ranProducing([REPORT], {
      verifiers: {
        [moduleId]: async () => [{ key: "stale-figures", passed: false, describes: "Two of the figures are from last week's export." }],
      },
    });

    // The item moved and the note was posted, so the deliverable is real
    // — it is simply real with something noticed about it.
    expect(currentOutputOf(handle.db, item.id)?.body).toBe(REPORT.body);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });
});

describe("a module step", () => {
  it("routes on the result the module reported", async () => {
    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "Deployed to staging" })).runOnce();

    // Where it goes is a row. The module said what happened; the routing
    // table said where that leads.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });

  it("takes the other branch when the module says so", async () => {
    await supervisorWith(async () => ({ ok: true, result: "failed", detail: "flyctl exited 1" })).runOnce();
    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  // Distinct from `builtin` in the run row, deliberately: one is code EO
  // ships and audited, the other is code somebody here approved, and an
  // incident is exactly when you want to know which ran.
  it("records the run as a module rather than a builtin", async () => {
    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "" })).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run).toMatchObject({ agentId: null, action: moduleId, status: "succeeded", provider: "module" });
    expect(run?.startedAt).not.toBeNull();
    expect(run?.endedAt).not.toBeNull();
  });

  it("parks and comments when the module fails", async () => {
    await supervisorWith(async () => ({ ok: false, reason: "flyctl is not installed" })).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    // Invariant #8: nothing drops work on the floor silently.
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("flyctl is not installed");
    // Still where it was — a failure is not a transition.
    expect(getItem(handle.db, item.id)?.stepId).toBe("deploy");
  });

  /**
   * A module can lose its approval after the pipeline naming it was
   * published, so the gate has to hold at the moment of running and not
   * only at the moment of saving. `moduleRunner` answering undefined is
   * how that arrives here.
   */
  it("parks with an explanation when the module is gone or unapproved", async () => {
    await supervisorWith(undefined).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(run?.status).toBe("awaiting_input");
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("no longer approved");
  });

  /**
   * The gotcha that would be silent and total.
   *
   * `resultKeyFor` reads a builtin's own reported key by testing the
   * action against a fixed list. A module's action is its id, so it has
   * to be recognised by the step's kind instead — and without that every
   * module result falls through to "done", finds no route, and parks with
   * "no route configured": a routing bug that is not one.
   */
  it("does not fall through to the generic done result", async () => {
    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "" })).runOnce();

    const bodies = listCommentsForItem(handle.db, item.id).map((comment) => comment.body);
    expect(bodies.some((body) => body.includes("no route configured"))).toBe(false);
  });

  /**
   * A module can run for minutes, so the item can move while it does.
   *
   * Routing from the dispatch-time snapshot undid the person's move: they
   * dragged the item to Implementer, `moveItem` said the run was
   * cancelled, and the module's late `deployed` then routed it to Review
   * from a step it was no longer on.
   */
  it("leaves an item alone when it moved while the module ran", async () => {
    const supervisor = supervisorWith(async () => {
      // Moved by a person mid-run, before the result comes back.
      transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
      return { ok: true, result: "deployed", detail: "" };
    });
    await supervisor.runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    // Invariant #8: it did something, and something says so.
    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("after you moved this ticket");
  });

  /**
   * A parked module whose item has been routed around.
   *
   * `awaitingInput` keeps the scheduler away and `resumeItem` is the
   * only thing that lifts it — so returning silently when the item had
   * moved left it dead, with nothing anywhere saying so.
   */
  it("releases the park when the item has been moved off the step", async () => {
    await supervisorWith(async () => ({ ok: false, reason: "FLY_API_TOKEN is not set" })).runOnce();
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");

    // The natural response: route around the module and say so.
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Skip the deploy, just fix the code." });

    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "" })).runOnce();

    const parked = listRunsForItem(handle.db, item.id)[0]!;
    expect(parked.status).toBe("cancelled");
    expect(listCommentsForItem(handle.db, item.id).some((comment) => comment.body.includes("free to carry on"))).toBe(true);
  });

  // The transcript is filed against the run, which is what makes a
  // module's output readable at all. `modules/registry.test.ts` proves
  // the real runner writes it; this proves the run it would be written
  // against exists and is the one the supervisor created.
  it("gives the module a run to file its transcript against", async () => {
    let seen: string | null = null;
    const runner: BuiltinRunner = async (context) => {
      seen = context.runId;
      return { ok: true, result: "deployed", detail: "" };
    };
    await supervisorWith(runner).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    expect(seen).toBe(run?.id);
  });
});

/**
 * What the workspace says about what the module claimed (EO-297,
 * invariant 5, ARCHITECTURE.md, "The interface").
 *
 * `verify` was called from the agent path alone until this story, so a
 * module step could report `deployed` and be believed without anything
 * ever looking at the workspace it worked in — a marketing pack's module
 * claiming it wrote a report into a folder was, in the platform's terms,
 * unverifiable by construction. The kind is asked here on exactly the
 * terms it is asked there: the verifier its *action* names, a blocking
 * failure that stops the run, and a check that only reports leaving the
 * work to stand.
 */
/**
 * A module run's action is the module's id, which means nothing to the
 * person reading the thread, so what EO writes names the module (EO-619).
 * The step here is called something else, so a sentence naming the step
 * cannot pass for one naming the module.
 */
describe("what EO writes about a module run", () => {
  const NAME = "Staging deploy";

  beforeEach(() => {
    const saved = saveModule(handle.db, { id: moduleId, slug: "deploy", name: NAME, description: manifest.description, code: "export default async function run() {}", manifest });
    if (!saved.ok) throw new Error(saved.reason);
  });

  /** Every comment on the item and every run error, which is all of what EO wrote. */
  function written(): string {
    const runs = listRunsForItem(handle.db, item.id);
    return [...listCommentsForItem(handle.db, item.id).map((comment) => comment.body), ...runs.map((run) => run.error ?? "")].join("\n");
  }

  it("names the module when it could not finish, and the run keeps the id", async () => {
    await supervisorWith(async () => ({ ok: false, reason: "flyctl is not installed" })).runOnce();

    const escalation = listCommentsForItem(handle.db, item.id).at(-1);
    expect(escalation?.kind).toBe("escalation");
    expect(escalation?.body).toContain(`"${NAME}" could not finish: flyctl is not installed`);
    expect(escalation?.body).not.toContain(moduleId);
    expect(listRunsForItem(handle.db, item.id)[0]?.action).toBe(moduleId);
  });

  it("names the module when its workspace could not confirm what it did", async () => {
    const undelivered: Check = { key: "deployed", passed: false, blocks: true, describes: "Nothing reached staging.", evidence: { released: false } };
    const runner: BuiltinRunner = async ({ item: onItem, prepareWorkspace }) => {
      const prepared = await prepareWorkspace(onItem, moduleId);
      return prepared.ok ? { ok: true, result: "deployed", detail: "" } : { ok: false, reason: prepared.reason };
    };
    await supervisorWith(runner, fakeWorkspaceKind({ cwd: "/tmp/eo/deploy", verifiers: { [moduleId]: async () => [undelivered] } })).runOnce();

    expect(written()).toContain(`"${NAME}" finished, but`);
    expect(written()).not.toContain(moduleId);
  });

  it("names the module when it finished after the item was moved", async () => {
    await supervisorWith(async () => {
      transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
      return { ok: true, result: "deployed", detail: "" };
    }).runOnce();

    expect(written()).toContain(`"${NAME}" finished with "deployed" after you moved`);
    expect(written()).not.toContain(moduleId);
  });

  it("names the module when a parked run is closed because the item moved on", async () => {
    await supervisorWith(async () => ({ ok: false, reason: "FLY_API_TOKEN is not set" })).runOnce();
    transitionItem(handle.db, { itemId: item.id, toStepId: "todo", actor: "human" });
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Skip the deploy." });

    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "" })).runOnce();

    expect(written()).toContain(`"${NAME}" was waiting for you here`);
    expect(written()).not.toContain(moduleId);
  });

  it("names the module when what it reported has no route", async () => {
    // `terminal` on a pipeline with no terminal step: the one way a result
    // that matched a route still leads nowhere.
    const pipeline = createPipeline(handle.db, { name: "Nowhere" });
    createStep(handle.db, { id: "last", pipelineId: pipeline.id, position: 0, name: "Last", type: "module", entryAction: moduleId });
    createRoute(handle.db, { pipelineId: pipeline.id, fromStepId: "last", resultKey: "deployed", label: "Deployed", target: TERMINAL_TARGET });
    item = createTestItem(handle.db, { type: "story", title: "Goes nowhere", pipelineId: pipeline.id, stepId: "last" });

    await supervisorWith(async () => ({ ok: true, result: "deployed", detail: "" })).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.error).toBe(`"${NAME}" reported "deployed", which has no route out of "Last".`);
    expect(written()).not.toContain(moduleId);
  });

  it("names the step when the module cannot be found, and still not the id", async () => {
    const gone = "019a0000-0000-7000-8000-000000000001";
    createStep(handle.db, { id: "lost", pipelineId: "default" as Uuid, position: 16, name: "Lost step", type: "module", entryAction: gone });
    item = createTestItem(handle.db, { type: "story", title: "On a lost module", stepId: "lost" });

    await supervisorWith(undefined).runOnce();

    expect(written()).toContain(`The module on "Lost step" could not finish`);
    expect(written()).not.toContain(gone);
  });
});

describe("verifying a module run", () => {
  const CWD = "/tmp/eo/deploy-workspace";

  /** A kind that checks whatever action it is told to, and records what it was asked. */
  function checking(verifiers: Record<string, FakeVerifier>): WorkspaceKind {
    return fakeWorkspaceKind({ cwd: CWD, verifiers });
  }

  /** A module that does what every real one does first: asks for somewhere to work. */
  function deployRunner(): BuiltinRunner {
    return async ({ item: onItem, prepareWorkspace }) => {
      const prepared = await prepareWorkspace(onItem, moduleId);
      if (!prepared.ok) return { ok: false, reason: prepared.reason };
      return { ok: true, result: "deployed", detail: "Deployed to staging" };
    };
  }

  const undelivered: Check = {
    key: "deployed",
    passed: false,
    blocks: true,
    describes: "The release is not on staging: the version there is the one from before this run.",
    evidence: { released: false },
  };
  const released: Check = { key: "smoke", passed: true, describes: "Staging answered on /health after the deploy." };

  it("asks the verifier the module's action names, about the workspace the module worked in", async () => {
    const asked: string[] = [];
    await supervisorWith(
      deployRunner(),
      checking({
        [moduleId]: async (_item, run) => {
          asked.push(`${run.action}:${run.workspace.cwd}:${run.ended}`);
          return [released];
        },
      }),
    ).runOnce();

    expect(asked).toEqual([`${moduleId}:${CWD}:succeeded`]);
    // Nothing blocked, so the result routes exactly as it always did.
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
  });

  /**
   * Keyed by `(kind, action)`, which is the half of this story that makes
   * the other half safe: a kind that can check an implementer's branch
   * has nothing to say about a deploy, and saying nothing is the answer
   * rather than a gap.
   */
  it("says nothing about an action its kind has no verifier for", async () => {
    let asked = false;
    await supervisorWith(
      deployRunner(),
      checking({
        implement: async () => {
          asked = true;
          return [undelivered];
        },
      }),
    ).runOnce();

    expect(asked).toBe(false);
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    expect(listRunsForItem(handle.db, item.id)[0]?.verification).toBeNull();
  });

  it("parks the item with what was checked, when a check that blocks did not pass", async () => {
    await supervisorWith(deployRunner(), checking({ [moduleId]: async () => [released, undelivered] })).runOnce();

    const [run] = listRunsForItem(handle.db, item.id);
    // The park rather than a bare failure, for the reason every other
    // stop on this path parks: a module has no attempt cap, so a step
    // left on the board is a step the scheduler offers again next tick.
    expect(run?.status).toBe("awaiting_input");
    expect(run?.error).toBe(undelivered.describes);
    expect(run?.verification).toEqual(undelivered.evidence);
    expect(getItem(handle.db, item.id)?.stepId).toBe("deploy");

    // Every check, not only the one that failed: what was looked at is as
    // much of the answer as what came of it (invariant 5).
    const escalation = listCommentsForItem(handle.db, item.id).at(-1);
    expect(escalation?.kind).toBe("escalation");
    expect(escalation?.body).toContain(released.describes);
    expect(escalation?.body).toContain(undelivered.describes);
    expect(escalation?.body).toContain("waiting for you");
  });

  it("lets the work stand and says what it noticed, when a failed check does not block", async () => {
    await supervisorWith(
      deployRunner(),
      checking({ [moduleId]: async () => [{ key: "changelog", passed: false, describes: "Nothing was added to the changelog." }] }),
    ).runOnce();

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("succeeded");
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
    const note = listCommentsForItem(handle.db, item.id).at(-1);
    expect(note?.kind).toBe("note");
    expect(note?.body).toBe("Nothing was added to the changelog.");
  });

  /**
   * A failed verification is a result the graph can be wired for
   * (EO-297) — and a result nothing that *runs* declares: the module's
   * manifest says `deployed` and `failed`, and this key comes from the
   * workspace kind instead. When no route declares it, the park above is
   * what holds.
   */
  it("takes the verification_failed route when the pipeline declares one", async () => {
    createRoute(handle.db, {
      pipelineId: "default" as Uuid,
      fromStepId: "deploy",
      resultKey: "verification_failed",
      label: "Could not be confirmed",
      target: "todo",
      position: 2,
    });

    await supervisorWith(deployRunner(), checking({ [moduleId]: async () => [undelivered] })).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
    const [run] = listRunsForItem(handle.db, item.id);
    // `failed` rather than parked: unlike the park, a failed run does not
    // hold the item still — which is right when the pipeline has just
    // said who picks it up next.
    expect(run?.status).toBe("failed");
    expect((run?.result as { parsed?: { result?: string } } | null)?.parsed?.result).toBe("verification_failed");
    // A note rather than an escalation: the item is already on its way
    // to somebody, and `!` on top of that would be a second summons.
    const said = listCommentsForItem(handle.db, item.id).at(-1);
    expect(said?.kind).toBe("note");
    expect(said?.body).toContain(undelivered.describes);
  });

  /**
   * The loop the failure route already refuses, for the same reason: a
   * module has no attempt cap, so a step that routes its own failed
   * verification back to itself would re-run the module against exactly
   * what it just failed, minting a run and a comment every tick.
   */
  it("parks rather than routing a failed verification back into the step that produced it", async () => {
    createRoute(handle.db, {
      pipelineId: "default" as Uuid,
      fromStepId: "deploy",
      resultKey: "verification_failed",
      label: "Try again",
      target: "deploy",
      position: 2,
    });

    await supervisorWith(deployRunner(), checking({ [moduleId]: async () => [undelivered] })).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("deploy");
    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
  });

  /**
   * A run that asked for nowhere to work did nothing anywhere to check.
   * Preparing a workspace on its behalf in order to have something to
   * verify would cut a worktree as a side effect of asking a question.
   */
  it("checks nothing when the module never asked for somewhere to work", async () => {
    let asked = false;
    await supervisorWith(
      async () => ({ ok: true, result: "deployed", detail: "" }),
      checking({
        [moduleId]: async () => {
          asked = true;
          return [undelivered];
        },
      }),
    ).runOnce();

    expect(asked).toBe(false);
    expect(listRunsForItem(handle.db, item.id)[0]?.cwd).toBeNull();
    expect(getItem(handle.db, item.id)?.stepId).toBe("review");
  });
});
