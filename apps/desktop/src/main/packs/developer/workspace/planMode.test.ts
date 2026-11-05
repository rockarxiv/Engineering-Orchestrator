import type { Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCommentsForItem } from "../../../db/repos/commentsRepo.js";
import { createProject } from "../../../db/repos/index.js";
import { getRun, listRunsForItem } from "../../../db/repos/runsRepo.js";
import { getItem } from "../../../db/repos/itemsRepo.js";
import { updateStep } from "../../../db/repos/pipelineStepsRepo.js";
import type { DbHandle } from "../../../db/client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { createFakeProvider } from "../../../providers/fake.js";
import { createScriptedProvider } from "../../../providers/scripted.js";
import { blockingEscalationFixture } from "../../../providers/fixtures.js";
import { createRunSupervisor } from "../../../supervisor/runSupervisor.js";
import { startTestWriteBridge, type TestWriteBridge } from "../../../testing/agentWrites.js";
import { installedKinds, kindsPreparing, preparedIn } from "../../../supervisor/testWorkspaceKinds.js";
import { gitWorkspaceKind } from "./gitKind.js";

/**
 * Plan mode's guard (KAN-18), which is the git kind's to make (EO-295).
 *
 * Beside the kind rather than beside the supervisor, and that is where
 * the guard moved: "was this worktree left alone" is a question only a
 * workspace that has a worktree can ask, so it is one of the three
 * checks `verify` returns. What the supervisor still owns is what
 * happens to a check that did not pass — a note on the item, and the
 * work kept — which is why the whole path is still exercised here
 * through a real supervisor.
 *
 * The instruction to propose rather than implement lives in the prompt,
 * and a prompt is a request, not a constraint. An implementer that
 * "plans" while writing half the change defeats the whole point of the
 * setting — and would do it silently, since the run ends exactly the
 * same way either way.
 *
 * So the worktree is checked. It reports rather than reverts: throwing
 * the work away would be a second surprise on top of the first, and the
 * person reading the plan is the one who should decide.
 */
const LIMITS = { globalConcurrency: 5, perAgentConcurrency: 5, perRepositoryConcurrency: 10 };

let handle: DbHandle;
let item: Item;
let writes: TestWriteBridge;

function project(planMode: boolean) {
  const repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
  const created = createProject(handle.db, { name: "api", keyPrefix: "APIB", workspaceIds: [repository.id] });
  // On the step that implements, not on the project (ARCHITECTURE.md, "A step"): plan mode
  // asks one step to plan before it writes, and two pipelines in one
  // project can reasonably disagree about that.
  if (planMode) updateStep(handle.db, "todo", { planMode: true });
  return { repository, project: created };
}

/**
 * A supervisor with the real git kind, over a status this test decides.
 *
 * The kind's own `verify`, not a stand-in for it: plan mode's gate — is
 * this step in plan mode at all, and did the run stop to ask — is the
 * kind's judgement since EO-295, and a fake that re-implemented it would
 * be testing the fake. Only the two things that need a repository on
 * disk are replaced: where the run happened, and what `git status` said
 * about it.
 *
 * The proposal is a blocking comment, which reaches EO over the agent
 * write bridge as a real one does (EO-543); without it the comment is
 * never made and the run never parks.
 */
function supervisorSeeing(clean: boolean, detail = "M src/thing.ts") {
  const supervisor = createRunSupervisor({
    db: handle.db,
    agentWriteBridge: writes.agentWriteBridge,
    provider: createFakeProvider(blockingEscalationFixture),
    limits: LIMITS,
    kinds: installedKinds({
      ...gitWorkspaceKind({
        db: handle.db,
        intelligenceFor: () => null,
        readStatus: async () => ({ ok: true as const, stdout: clean ? "" : detail }),
        // `/tmp/worktree` names a checkout without one existing, and
        // whether it is one is not what this file is about (EO-386).
        isGitRepository: () => true,
      }),
      prepare: async (item) => preparedIn(item, "/tmp/worktree"),
    }),
  });
  writes.serve(supervisor);
  return supervisor;
}

beforeEach(async () => {
  handle = openMigratedTestDb();
  writes = await startTestWriteBridge();
});

afterEach(async () => {
  await writes.close();
  handle.close();
});

describe("when the implementer proposes and stops", () => {
  it("parks the item exactly as an escalation does, because that is what it is", async () => {
    // Plan mode adds no new parking mechanism. The run ends
    // awaiting_input and a reply resumes the same thread — the A-03
    // path, unchanged.
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(true).runOnce();

    const run = listRunsForItem(handle.db, item.id)[0]!;
    // awaiting_input is what parks it, and what `findPendingResponses`
    // looks for when the reply arrives. (A real provider also leaves a
    // thread id here; the fake emits none, which is a fixture detail.)
    expect(getRun(handle.db, run.id)?.status).toBe("awaiting_input");
  });

  it("says nothing extra when the worktree was left alone", async () => {
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(true).runOnce();

    const engineComments = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
    expect(engineComments).toEqual([]);
  });
});

describe("when it wrote anyway", () => {
  it("says so, and shows what it found", async () => {
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(false, "M src/thing.ts").runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note, "the guard ends in a comment (invariant 8)").toBeDefined();
    expect(note!.body).toContain("plan mode");
    expect(note!.body).toContain("M src/thing.ts");
  });

  it("keeps the work rather than reverting it", async () => {
    // Discarding would be a second surprise on top of the first. The
    // person reading the plan decides.
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(false).runOnce();

    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine")!.body).toContain(
      "Nothing has been discarded",
    );
  });

  it("warns that the plan may not describe everything that happened", async () => {
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(false).runOnce();

    expect(listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine")!.body).toContain(
      "may not be all that was done",
    );
  });
});

describe("with the setting off", () => {
  it("checks nothing, because an ordinary escalation mid-implementation is not a violation", async () => {
    // An implementer that asks a blocking question halfway through has
    // done nothing wrong, and its worktree is *supposed* to have work
    // in it.
    const { repository, project: shown } = project(false);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(false).runOnce();

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
  });
});

/**
 * The failure the worktree guard cannot see (KAN-25).
 *
 * That guard only runs when the implementer escalated, so it catches an
 * agent that proposed *and* wrote. An agent that ignored plan mode
 * outright — implemented the story, returned a valid result — took the
 * success path, where nothing looked at plan mode at all. The run
 * succeeded, the item moved on, and the setting was overridden in
 * silence.
 */
describe("when it never proposed at all", () => {
  /** A supervisor whose implementer just does the work and returns a result. */
  function supervisorThatImplements() {
    return createRunSupervisor({
      db: handle.db,
      provider: createScriptedProvider([{ when: () => true, script: { result: { branch: "eo/EO-1", summary: "Did it.", handoff: "Straightforward; nothing to flag." } } }]),
      limits: LIMITS,
      kinds: kindsPreparing("/tmp/worktree"),
    });
  }

  it("says so, rather than letting the setting be ignored in silence", async () => {
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorThatImplements().runOnce();

    const note = listCommentsForItem(handle.db, item.id).find((comment) => comment.authorType === "engine");
    expect(note, "invariant 8: the guard ends in a comment").toBeDefined();
    expect(note!.body).toContain("never stopped to ask");
    expect(note!.body).toContain("nobody approved the approach");
  });

  it("still lets the item move, because this is not a verification failure", async () => {
    // The work is real and the tests are the thing that judges it.
    // Holding it here would be a policy nobody asked for.
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorThatImplements().runOnce();

    expect(getItem(handle.db, item.id)?.stepId).not.toBe("todo");
  });

  it("says nothing when the project is not in plan mode", async () => {
    // The overwhelming case: implementing directly is simply the job.
    const { repository, project: shown } = project(false);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorThatImplements().runOnce();

    expect(listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine")).toEqual([]);
  });

  it("says nothing about an implementation that was proposed and approved first", async () => {
    // The intended path, and the one that must not be accused: the
    // parked run is the evidence a human saw a plan, and the approved
    // implementation arrives as a second run that — correctly — does
    // not escalate.
    const { repository, project: shown } = project(true);
    item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: shown.id });

    await supervisorSeeing(true).runOnce(); // proposes, parks awaiting_input
    await supervisorThatImplements().runOnce(); // the approved implementation

    const notes = listCommentsForItem(handle.db, item.id).filter((comment) => comment.authorType === "engine");
    expect(notes.map((note) => note.body).join("\n")).not.toContain("never stopped to ask");
  });
});
