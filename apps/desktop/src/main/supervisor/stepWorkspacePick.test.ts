import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, NONE_KIND, NO_WORKSPACE, SCRATCH_KIND, type Uuid } from "@eo/core";
import type { DbHandle } from "../db/client.js";
import { createStep, createWorkspace, getPipeline, type Workspace } from "../db/repos/index.js";
import { createDefaultProject } from "../db/repos/projectsRepo.js";
import { workspaces } from "../db/schema.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { folderWorkspaceKind } from "./folderKind.js";
import { resolveItemWorkspace, workspaceFor } from "./workspaceResolution.js";

/**
 * A step picks among the project's workspaces (EO-301,
 * the original design).
 *
 * "A pipeline where one step drafts in `scratch` and the next commits to
 * `git-worktree` is legitimate." Before this story there was one answer
 * to *which disk* for a whole pipeline — the ticket's, and behind it the
 * project's first — so every step of it worked in the same place and a
 * drafting step and a committing step could not disagree.
 *
 * What is tested here is the order the three answers resolve in, and
 * that it is the *one* order: `workspaceFor` is the single function the
 * scheduler's capacity key, each kind's `prepare`, the dispatch and the
 * card's badge all go through, so a pick honoured in one of them and not
 * the others would route a run into the folder and then cap its
 * concurrency on the repository.
 */
let handle: DbHandle;
let scratch: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-step-pick-"));
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

function directory(name: string): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A repository and a folder on one project — the case a step picking between them is for. */
function projectWithBoth(): { repo: Workspace; folder: Workspace; projectId: Uuid } {
  const repo = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the repo", repoPath: directory("the repo") });
  const projectId = repo.projectId!;
  const folder = createWorkspace(handle.db, { projectId, kind: FOLDER_KIND, config: { path: directory("the drive") }, position: 1 });
  return { repo, folder, projectId };
}

/** A step of the seeded pipeline that names a workspace, or says "no disk", or says nothing. */
function stepPicking(id: string, workspaceId: string | null): string {
  createStep(handle.db, { id, pipelineId: "default" as Uuid, position: 20, name: id, type: "module", entryAction: "draft", workspaceId });
  return id;
}

describe("which workspace a run happens on", () => {
  it("takes the step's pick over the ticket's own workspace", () => {
    const { repo, folder, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Draft the quarterly report",
      // The ticket is on the repository, which is what every ticket in a
      // one-repository project is. The step is what disagrees.
      workspaceId: repo.id,
      projectId,
      stepId: stepPicking("draft", folder.id),
    });

    expect(workspaceFor(handle.db, item)?.id).toBe(folder.id);
    expect(resolveItemWorkspace(handle.db, item).kind).toBe(FOLDER_KIND);
  });

  it("falls back to the ticket's workspace when the step picks nothing, which is what every step did before", () => {
    const { repo, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Add the rate limiter",
      workspaceId: repo.id,
      projectId,
      stepId: stepPicking("build", null),
    });

    expect(workspaceFor(handle.db, item)?.id).toBe(repo.id);
  });

  it("gives a step that says 'no disk' no disk, whatever the ticket is on", () => {
    const { repo, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Ask the helpdesk",
      workspaceId: repo.id,
      projectId,
      stepId: stepPicking("ask", NO_WORKSPACE),
    });

    // The difference between this and an unset pick, and the whole
    // reason the sentinel exists: nothing further is consulted.
    expect(workspaceFor(handle.db, item)).toBeUndefined();
    expect(resolveItemWorkspace(handle.db, item).kind).toBe(NONE_KIND);
    expect(resolveItemWorkspace(handle.db, item).workspaceId).toBeNull();
  });

  it("falls back rather than stranding the run when a picked workspace has gone", () => {
    const { repo, folder, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Draft the quarterly report",
      workspaceId: repo.id,
      projectId,
      stepId: stepPicking("draft", folder.id),
    });

    // `deleteWorkspace` clears the picks it orphans, so reaching this
    // state means a row vanished some other way — a restored database, a
    // hand-edit. The ticket's own workspace is the answer that leaves
    // work running; "no disk" would silently stop a pipeline.
    handle.db.delete(workspaces).where(eq(workspaces.id, folder.id)).run();

    expect(workspaceFor(handle.db, item)?.id).toBe(repo.id);
  });

  it("lets two steps of one pipeline work in two different places", () => {
    const { repo, folder, projectId } = projectWithBoth();
    const drafts = createTestItem(handle.db, { type: "story", title: "Draft it", workspaceId: repo.id, projectId, stepId: stepPicking("draft", folder.id) });
    const commits = createTestItem(handle.db, { type: "story", title: "Commit it", workspaceId: repo.id, projectId, stepId: stepPicking("commit", repo.id) });

    expect(workspaceFor(handle.db, drafts)?.kind).toBe(FOLDER_KIND);
    expect(workspaceFor(handle.db, commits)?.kind).toBe(repo.kind);
  });
});

describe("what the kind does with a step's pick", () => {
  it("routes the run into the folder the step named, not the repository the ticket is on", async () => {
    const { repo, folder, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, {
      type: "story",
      title: "Draft the quarterly report",
      workspaceId: repo.id,
      projectId,
      stepId: stepPicking("draft", folder.id),
    });

    const prepared = await folderWorkspaceKind({ db: handle.db }).prepare(item, "draft");

    // The acceptance criterion, at the layer that decides it: the folder
    // kind reads the same `workspaceFor` everything else does, so
    // assigning a folder to a step is what puts the run's cwd in it.
    expect(prepared.ok).toBe(true);
    expect(prepared.ok && prepared.workspace.cwd).toBe(join(scratch, "the drive"));
    expect(prepared.ok && prepared.workspace.workspaceId).toBe(folder.id);
  });

  it("caps concurrency on the workspace the step picked, so the two cannot disagree", () => {
    const { repo, folder, projectId } = projectWithBoth();
    const item = createTestItem(handle.db, { type: "story", title: "Draft it", workspaceId: repo.id, projectId, stepId: stepPicking("draft", folder.id) });

    // The failure this rules out: a run that works in the folder while
    // the scheduler believes it is treading on the repository — two
    // readings of one question, which is the shape the design spent a
    // paragraph on for the cwd fallback.
    expect(folderWorkspaceKind({ db: handle.db }).capacityKeyOf(item)).toBe(folder.id);
  });
});

/**
 * The shipped `default` pipeline belongs to *every* project (EO-301,
 * caught in review; `listPipelineStepViews` says so where it resolves
 * the project a project-less pipeline is being edited in).
 *
 * That makes a step's workspace pick a thing that can be right and
 * wrong at once. `pipeline:save` judges it against whichever project
 * was active when it was configured, and for a pipeline that belongs
 * to a project that is the whole guarantee — but a project-less one is
 * shared, so the moment an item from a second project reaches that step
 * the stored pick names a disk that project does not hold. Nothing is
 * stale and nothing was mis-saved: a correct row is being read by the
 * wrong item.
 *
 * So membership is asked per item, at resolution, where the item's
 * project is known.
 */
describe("a step pick stored on a pipeline every project shares", () => {
  /** Two projects, each with a repository of its own, and one shared pipeline between them. */
  function twoProjects() {
    const here = attachWorkspace(handle.db, { keyPrefix: "EO", name: "the api", repoPath: directory("the api") });
    const elsewhere = attachWorkspace(handle.db, { keyPrefix: "WEB", name: "the web", repoPath: directory("the web") });
    // The shipped pipeline is project-less, which is what makes it
    // shared. Asserted rather than assumed: the whole case rests on it.
    expect(getPipeline(handle.db, "default")?.projectId ?? null).toBeNull();
    return { here, elsewhere };
  }

  it("routes an item from the other project to its own disk, not to the configured one", () => {
    const { here, elsewhere } = twoProjects();
    // Configured while the first project was active, which the save
    // accepted because it was judged against that project.
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "module", entryAction: "draft", workspaceId: here.id });

    const theirs = createTestItem(handle.db, { type: "story", title: "Their report", workspaceId: here.id, projectId: here.projectId, stepId: "draft" });
    const ours = createTestItem(handle.db, { type: "story", title: "Our report", workspaceId: elsewhere.id, projectId: elsewhere.projectId, stepId: "draft" });

    // The project the pick belongs to gets what it configured.
    expect(workspaceFor(handle.db, theirs)?.id).toBe(here.id);
    // The other project does not. Its item works on its own repository
    // — the answer a step with no pick gives, and the only one that
    // keeps the run inside its own project.
    expect(workspaceFor(handle.db, ours)?.id).toBe(elsewhere.id);
  });

  it("keeps the capacity key in the item's own project too, so the two cannot disagree", () => {
    const { here, elsewhere } = twoProjects();
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "module", entryAction: "draft", workspaceId: here.id });
    const ours = createTestItem(handle.db, { type: "story", title: "Our report", workspaceId: elsewhere.id, projectId: elsewhere.projectId, stepId: "draft" });

    // A run capped on the other project's repository while working in
    // its own would be the same split reading the pick itself was.
    expect(resolveItemWorkspace(handle.db, ours).workspaceId).toBe(elsewhere.id);
  });

  it("answers for an item whose project is null from the workspace it sits on", () => {
    // `createItem` takes the project and the workspace separately, so an
    // item on a project's repository may carry a null `projectId`.
    // Comparing against that null alone would make every pick look like
    // another project's and be quietly ignored.
    const { here } = twoProjects();
    createStep(handle.db, { id: "draft", pipelineId: "default" as Uuid, position: 20, name: "Draft", type: "module", entryAction: "draft", workspaceId: here.id });
    const item = createTestItem(handle.db, { type: "story", title: "No project of its own", workspaceId: here.id, stepId: "draft" });

    expect(item.projectId).toBeNull();
    expect(workspaceFor(handle.db, item)?.id).toBe(here.id);
  });
});

describe("a project whose only workspace is a scratch directory", () => {
  it("still resolves, because a pick is not the only way a step gets a disk", () => {
    const workspace = createWorkspace(handle.db, { kind: SCRATCH_KIND });
    const project = createDefaultProject(handle.db, workspace, "EO");
    const item = createTestItem(handle.db, { type: "story", title: "Render the chart", projectId: project.id, stepId: "todo" });

    expect(resolveItemWorkspace(handle.db, item).kind).toBe(SCRATCH_KIND);
  });
});
