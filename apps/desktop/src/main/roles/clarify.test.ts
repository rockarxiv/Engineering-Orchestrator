import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, listCommentsForItem, listRunsForItem, listItems } from "../db/repos/index.js";
import { createProject } from "../db/repos/projectsRepo.js";
import { createRoute, createStep } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb, REVIEWABLE_SPEC } from "../db/testHelpers.js";
import { createFakeProvider } from "../providers/fake.js";
import { blockingEscalationFixture } from "../providers/fixtures.js";
import { createScriptedProvider } from "../providers/scripted.js";
import { buildDispatchContext } from "../supervisor/buildDispatchContext.js";
import { createRunSupervisor } from "../supervisor/runSupervisor.js";
import { startTestWriteBridge } from "../testing/agentWrites.js";
import { BUILTIN_RUNNERS } from "../packs/developer/builtins.js";
import { createRoleWiring } from "../packs/developer/wiring.js";
import { developerSectionRenderers } from "../packs/developer/sections.js";

/**
 * Work imported already written (KAN-19).
 *
 * `refine` is two actions wearing one name. Pointed at a feature it
 * decomposes; pointed at anything a person already wrote it checks that
 * it can be worked as it stands, and either says so or asks. These are
 * the cases where getting that wrong would be silent: a story quietly
 * decomposed into stories nobody wanted, or parked forever at an
 * approval gate with nothing to approve.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

const CLARIFIED = { ready: true, understanding: "Return 429 once a key exceeds 100 requests in a minute." };
const DECOMPOSED = {
  stories: [{ title: "Count requests", body: "Per key, per minute.", acceptance_criteria: ["counts reset"], depends_on: [], touches: [] }],
};

let handle: DbHandle;

/** A supervisor that answers `refine` one way and everything downstream plausibly. */
function supervisorAnswering(refineResult: unknown) {
  return createRunSupervisor({
    db: handle.db,
    limits: LIMITS,
    provider: createScriptedProvider([
      { when: (context) => context.includes(`"refine" action`), script: { result: refineResult } },
      { when: (context) => context.includes(`"implement" action`), script: { result: { branch: "eo/EO-1", summary: "done", handoff: "Straightforward; nothing to flag." } } },
      {
        when: (context) => context.includes(`"review" action`),
        script: { result: { verdict: "approve", feedback: "Fine.", blocking_issues: [] } },
      },
    ]),
    builtins: BUILTIN_RUNNERS,
    ...createRoleWiring(handle.db),
  });
}

/** An issue someone wrote, imported as it stands: a story with no parent, waiting on the product owner. */
function alreadyWritten(type = "story"): Item {
  return createTestItem(handle.db, {
    type,
    title: "Rate limit the public API",
    body: "Return 429 once a key exceeds 100 requests in a minute.",
    stepId: "plan",
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  // `intake` and `refine` are actions, not columns (ARCHITECTURE.md, "A column is a responsibility,
  // not a status") — a
  // conversation drives them now. These configure steps that run them,
  // which is exactly what a person could do and all these tests need.
  createStep(handle.db, { id: "ask", pipelineId: "default" as never, position: -2, name: "Intake", type: "agent", ownerRole: "system", entryAction: "intake" });
  createStep(handle.db, { id: "plan", pipelineId: "default" as never, position: -1, name: "Refine", type: "agent", ownerRole: "system", entryAction: "refine" });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "done", label: "Understood", target: "plan", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "ask", resultKey: "classified_non_feature", label: "Already written", target: "todo", position: 1 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "decomposed", label: "Decomposed", target: "todo", position: 0 });
  createRoute(handle.db, { pipelineId: "default" as never, fromStepId: "plan", resultKey: "clarified", label: "Clarified", target: "todo", position: 1 });
});

afterEach(() => {
  handle.close();
});

describe("refining something that was already written", () => {
  it("asks the product owner to check it, not to break it up", async () => {
    const context = await buildDispatchContext(handle.db, alreadyWritten(), "refine", developerSectionRenderers);

    expect(context).toContain("do not decompose it");
    // And says how to ask: as a result, which is the one path that both
    // parks the item and waits for every question (KAN-29).
    expect(context).toContain("clarification_required");
  });

  it("leaves a feature's prompt exactly as it was", async () => {
    // The regression that matters: features are the overwhelming case,
    // and a section appearing in their prompt would change behaviour
    // nobody asked to change.
    const feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null });

    const context = await buildDispatchContext(handle.db, feature, "refine", developerSectionRenderers);

    expect(context).not.toContain("do not decompose it");
  });

  it("moves it to be implemented, past the gate it has nothing to wait at", async () => {
    // pending_approval sits between backlog and todo and nobody owns it,
    // so landing there would park the item in front of an approval
    // button that reads a proposal this run never made.
    const item = alreadyWritten();

    await supervisorAnswering(CLARIFIED).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("creates no stories — the person who wrote it already decided", async () => {
    const item = alreadyWritten();

    await supervisorAnswering(CLARIFIED).runOnce();

    expect(listItems(handle.db).filter((candidate) => candidate.id !== item.id)).toEqual([]);
  });

  it("records what it understood the work to be, for whoever implements it", async () => {
    const item = alreadyWritten();

    await supervisorAnswering(CLARIFIED).runOnce();

    const note = listCommentsForItem(handle.db, item.id).at(-1);
    expect(note?.kind).toBe("note");
    expect(note?.body).toContain("Return 429 once a key exceeds 100 requests in a minute.");
    // Nobody is being asked anything, so nobody is interrupted.
    expect(note?.body).not.toContain("@user");
  });

  it("refuses a decomposition, so a product owner that ignored the instruction cannot quietly succeed", async () => {
    const item = alreadyWritten();

    await supervisorAnswering(DECOMPOSED).runOnce();

    // A-02: the wrong shape is re-prompted and then escalated. What must
    // not happen is the item moving on as though it had been answered.
    expect(getItem(handle.db, item.id)?.stepId).toBe("plan");
    expect(listItems(handle.db).filter((candidate) => candidate.id !== item.id)).toEqual([]);
  });

  it("treats a bug, a task or a chore exactly like a story", async () => {
    // The reason this is keyed on "not a feature" rather than on the
    // word "story": what a team calls its written work is its own
    // business, and EO imports whatever type they picked.
    const item = alreadyWritten("bug");

    await supervisorAnswering(CLARIFIED).runOnce();

    expect(getItem(handle.db, item.id)?.stepId).toBe("todo");
  });

  it("parks it where an escalation parks anything, when it has a real question", async () => {
    const item = alreadyWritten();
    // The question is a blocking comment, and it reaches EO over the
    // write bridge as a real one does (EO-543): that is what parks the run.
    const writes = await startTestWriteBridge();
    const supervisor = createRunSupervisor({
      db: handle.db,
      limits: LIMITS,
      agentWriteBridge: writes.agentWriteBridge,
      provider: createFakeProvider(blockingEscalationFixture),
      builtins: BUILTIN_RUNNERS,
      ...createRoleWiring(handle.db),
    });
    writes.serve(supervisor);

    try {
      await supervisor.runOnce();
    } finally {
      await writes.close();
    }

    expect(listRunsForItem(handle.db, item.id)[0]?.status).toBe("awaiting_input");
    expect(getItem(handle.db, item.id)?.stepId).toBe("plan");
  });
});

describe("a story with no feature above it", () => {
  it("runs the whole pipeline to terminal without a parent to roll up into", async () => {
    // `syncFeatureState` fires on every transition and reads
    // `parentId`. Imported work is the first story to have none.
    const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const shown = createProject(handle.db, { name: "api", keyPrefix: "APIB", workspaceIds: [repository.id] });
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Rate limit the public API",
      body: "Return 429 over 100 a minute.",
      spec: REVIEWABLE_SPEC,
      stepId: "todo",
      workspaceId: repository.id,
      projectId: shown.id,
    });

    const supervisor = supervisorAnswering(CLARIFIED);
    await supervisor.runOnce(); // refine → todo
    await supervisor.runOnce(); // implement → review
    await supervisor.runOnce(); // review → merge request
    await supervisor.runOnce(); // merge request → ready_to_merge

    expect(getItem(handle.db, item.id)?.stepId).toBe("ready_to_merge");
    expect(getItem(handle.db, item.id)?.parentId).toBeNull();
  });
});
