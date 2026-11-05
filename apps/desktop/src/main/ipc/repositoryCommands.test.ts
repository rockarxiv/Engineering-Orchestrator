import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import {
  addWorkspaceToProject,
  createDefaultProject,
  createGitWorkspace,
  createPipeline,
  createProject,
  getGitWorkspace,
  getItem,
  getProject,
  listCommentsForItem,
  listPipelines,
  listProjects,
  listGitWorkspaces,
  postComment,
  projectWorkspaceList,
  setProjectArchived,
  setSetting,
} from "../db/repos/index.js";
import { abandonAdoption, beginAdoption } from "../db/repos/projectsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { PREVIEW_PROJECT_KEY } from "../gallery/commands.js";
import { openProjectThread } from "../projects/projectThread.js";
import { addRepositoryToProjectCommand, createProjectCommand, listProjectsCommand, removeRepositoryFromProjectCommand } from "./projectCommands.js";
import { ACTIVE_PROJECT_KEY, activeProjectId, createRepositoryCommand, removeRepositoryCommand } from "./repositoryCommands.js";

let handle: DbHandle;
let scratch: string;

/** The credentials argument. Nothing here reads it; a Jira binding is the project's. */
const credentials = { directory: "/nowhere", store: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(""), decryptString: () => "" } };

beforeEach(() => {
  handle = openMigratedTestDb();
  scratch = mkdtempSync(join(tmpdir(), "eo-repositories-"));
});

afterEach(() => {
  handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A real checkout, because attaching asks git rather than taking the path on trust. */
function checkout(name: string): string {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, encoding: "utf8" });
  return path;
}

function attach(name: string, extra: { projectId?: string; keyPrefix?: string } = {}) {
  return createRepositoryCommand(handle.db, credentials, { name, repoPath: checkout(name), baseBranch: "main", testCommand: null, lintCommand: null, buildCommand: null, ...extra });
}

/** A project somebody made, holding nothing yet, and the window showing it. */
function projectOnScreen(name: string, keyPrefix: string) {
  const project = createProject(handle.db, { name, keyPrefix });
  setSetting(handle.db, ACTIVE_PROJECT_KEY, project.id);
  return project;
}

/** The gallery's Preview: a project with no repository, on purpose, and the example item on it (EO-313). */
function previewProject(name = "Preview", keyPrefix = "PRV") {
  const project = createProject(handle.db, { name, keyPrefix });
  setSetting(handle.db, PREVIEW_PROJECT_KEY, project.id);
  createTestItem(handle.db, { type: "feature", title: "Example", stepId: null, projectId: project.id, workspaceId: null });
  return project;
}

const projectIds = () => listProjects(handle.db).map((project) => project.id);
const held = (projectId: string) => projectWorkspaceList(handle.db, projectId as Uuid).map((workspace) => workspace.id);

describe("the project a repository joins (EO-603)", () => {
  it("joins the project named, after what it already holds, and leaves the window where it was", async () => {
    const onScreen = projectOnScreen("Shop", "SHOP");
    const other = createProject(handle.db, { name: "Payments", keyPrefix: "PAY" });
    const held_ = (await attach("api", { projectId: other.id })).repository!.id;

    const created = await attach("web", { projectId: other.id });

    expect(created).toMatchObject({ ok: true, project: { id: other.id, name: "Payments", created: false } });
    expect(held(other.id)).toEqual([held_, created.repository!.id]);
    expect(projectIds()).toEqual([onScreen.id, other.id]);
    expect(activeProjectId(handle.db)).toBe(onScreen.id);
  });

  it("joins the project the window is showing when none is named", async () => {
    const onScreen = projectOnScreen("Shop", "SHOP");
    createProject(handle.db, { name: "Payments", keyPrefix: "PAY" });

    const created = await attach("api");

    expect(held(onScreen.id)).toEqual([created.repository!.id]);
    expect(activeProjectId(handle.db)).toBe(onScreen.id);
  });

  it("holds three repositories added one after another, with no new project", async () => {
    const project = projectOnScreen("Shop", "SHOP");

    const ids: string[] = [];
    for (const name of ["api", "web", "docs"]) ids.push((await attach(name, { projectId: project.id })).repository!.id);

    const listed = listProjectsCommand(handle.db);
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]?.repositoryIds).toEqual(ids);
  });

  it("marks only the gallery's Preview in the project list, so Settings can leave its Add a repository off (EO-604)", () => {
    const shop = projectOnScreen("Shop", "SHOP");
    const preview = previewProject();

    const flags = listProjectsCommand(handle.db).projects.map((project) => [project.id, project.preview]);
    expect(flags).toEqual(expect.arrayContaining([[shop.id, false], [preview.id, true]]));
  });

  it("places it after a gap a removed workspace left, not on top of the survivor", async () => {
    const project = projectOnScreen("Shop", "SHOP");
    const api = await attach("api");
    const web = await attach("web");
    removeRepositoryCommand(handle.db, { id: api.repository!.id });

    const docs = await attach("docs");

    expect(held(project.id)).toEqual([web.repository!.id, docs.repository!.id]);
  });

  it("makes a project for it only when there is none, named after it, and shows it", async () => {
    const created = await attach("the api");

    const project = listProjects(handle.db)[0]!;
    expect(project).toMatchObject({ name: "the api", keyPrefix: "THEA" });
    expect(created.project).toEqual({ id: project.id, name: "the api", created: true });
    expect(held(project.id)).toEqual([created.repository!.id]);
    expect(activeProjectId(handle.db)).toBe(project.id);
  });

  it.each([
    ["on screen", undefined],
    ["named", "preview"],
  ])("makes a project rather than join the gallery's Preview, %s", async (_case, named) => {
    const preview = previewProject();
    setSetting(handle.db, ACTIVE_PROJECT_KEY, preview.id);

    const created = await attach("api", named === "preview" ? { projectId: preview.id, keyPrefix: "API" } : { keyPrefix: "API" });

    expect(created.ok, created.problem ?? "").toBe(true);
    expect(created.project).toMatchObject({ name: "api", created: true });
    expect(held(preview.id)).toEqual([]);
    expect(activeProjectId(handle.db)).toBe(created.project!.id);
    expect(getProject(handle.db, created.project!.id as Uuid)?.keyPrefix).toBe("API");
  });

  it("joins a real project while Preview merely exists", async () => {
    previewProject();
    const shop = projectOnScreen("Shop", "SHOP");

    const created = await attach("api");

    expect(created.project).toMatchObject({ id: shop.id, created: false });
  });

  it("makes a project when the only one there is has been put away", async () => {
    const away = projectOnScreen("Shop", "SHOP");
    setProjectArchived(handle.db, away.id, Date.now());

    const created = await attach("api");

    expect(created.project).toMatchObject({ name: "api", created: true });
    expect(held(away.id)).toEqual([]);
  });

  it("refuses a key prefix for a repository joining a project, names that project's, and writes nothing", async () => {
    const project = projectOnScreen("Shop", "SHOP");

    // Its own prefix is refused too: a repository joining has none to choose.
    for (const keyPrefix of ["API", "SHOP"]) {
      const refused = await attach(`api-${keyPrefix}`, { keyPrefix });

      expect(refused.ok).toBe(false);
      expect(refused.problem).toContain("SHOP");
    }
    expect(listGitWorkspaces(handle.db)).toEqual([]);
    expect(projectIds()).toEqual([project.id]);
  });

  it("takes a blank key prefix for no key prefix, as it always has", async () => {
    projectOnScreen("Shop", "SHOP");

    expect((await attach("api", { keyPrefix: "  " })).ok).toBe(true);
  });

  it("still refuses a prefix another project holds when a project is being made, before writing anything", async () => {
    const preview = previewProject();
    setSetting(handle.db, ACTIVE_PROJECT_KEY, preview.id);
    createProject(handle.db, { name: "Acme", keyPrefix: "ACME" });

    const refused = await attach("acme", { keyPrefix: "acme" });

    expect(refused.ok).toBe(false);
    expect(refused.problem).toContain("already in use");
    expect(listGitWorkspaces(handle.db)).toEqual([]);
  });

  it("refuses a projectId that names no project, and writes nothing", async () => {
    projectOnScreen("Shop", "SHOP");

    const refused = await attach("api", { projectId: uuidv7() });

    expect(refused).toMatchObject({ ok: false, problem: "That project no longer exists." });
    expect(listGitWorkspaces(handle.db)).toEqual([]);
    expect(projectIds()).toHaveLength(1);
  });

  it("hands items that predate every repository to the first one, whichever project it joins", async () => {
    const early = createTestItem(handle.db, { type: "feature", title: "Written during onboarding", stepId: null });
    const project = projectOnScreen("Shop", "SHOP");

    const first = await attach("api");
    const later = await attach("web");

    expect(first.adoptedItems).toBe(1);
    expect(getItem(handle.db, early.id)).toMatchObject({ workspaceId: first.repository!.id, projectId: project.id });
    expect(later.adoptedItems).toBe(0);
  });
});

describe("a project mid-move to the organisation's record (EO-605)", () => {
  const REFUSAL = `"Shop" is being moved to your organisation's record. Wait for the move to finish, then change its repositories.`;

  it("refuses repositories:create on the project named, and attaches again once the move has ended", async () => {
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    beginAdoption(handle.db, shop.id);

    expect(await attach("api", { projectId: shop.id })).toEqual({ ok: false, problem: REFUSAL });
    expect(listGitWorkspaces(handle.db)).toEqual([]);
    expect(projectIds()).toEqual([shop.id]);

    abandonAdoption(handle.db, shop.id);
    rmSync(join(scratch, "api"), { recursive: true });

    expect(await attach("api", { projectId: shop.id })).toMatchObject({ ok: true, project: { id: shop.id, created: false } });
  });

  it("refuses repositories:create on the project the window shows when none is named", async () => {
    const shop = projectOnScreen("Shop", "SHOP");
    beginAdoption(handle.db, shop.id);

    expect(await attach("api")).toEqual({ ok: false, problem: REFUSAL });
    expect(listGitWorkspaces(handle.db)).toEqual([]);
  });

  it("refuses projects:addProject, leaving the repository on the project that holds it", async () => {
    const payments = createProject(handle.db, { name: "Payments", keyPrefix: "PAY" });
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const repositoryId = (await attach("api", { projectId: payments.id })).repository!.id;
    beginAdoption(handle.db, shop.id);

    expect(addRepositoryToProjectCommand(handle.db, { projectId: shop.id, repositoryId })).toEqual({ ok: false, problem: REFUSAL });
    expect(held(payments.id)).toEqual([repositoryId]);
    expect(held(shop.id)).toEqual([]);
  });

  describe("a repository leaving it (EO-607)", () => {
    /** A repository on Shop with nothing on it, Shop mid-move, and somewhere for it to go. */
    async function onMovingShop() {
      const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
      const payments = createProject(handle.db, { name: "Payments", keyPrefix: "PAY" });
      const repositoryId = (await attach("api", { projectId: shop.id })).repository!.id;
      beginAdoption(handle.db, shop.id);
      return { shop, payments, repositoryId };
    }

    it("refuses projects:addProject naming another project, and takes it once the move has ended", async () => {
      const { shop, payments, repositoryId } = await onMovingShop();

      expect(addRepositoryToProjectCommand(handle.db, { projectId: payments.id, repositoryId })).toEqual({ ok: false, problem: REFUSAL });
      expect(held(shop.id)).toEqual([repositoryId]);
      expect(held(payments.id)).toEqual([]);

      abandonAdoption(handle.db, shop.id);

      expect(addRepositoryToProjectCommand(handle.db, { projectId: payments.id, repositoryId }).ok).toBe(true);
      expect(held(payments.id)).toEqual([repositoryId]);
    });

    it("refuses projects:create naming it, and creates no project", async () => {
      const { shop, repositoryId } = await onMovingShop();
      const before = projectIds();

      const created = await createProjectCommand(handle.db, { name: "New", keyPrefix: "NEW", repositoryIds: [repositoryId] });

      expect(created).toEqual({ ok: false, problem: `${REFUSAL} Nothing was created.` });
      expect(projectIds()).toEqual(before);
      expect(held(shop.id)).toEqual([repositoryId]);
    });

    it("refuses projects:removeProject, and takes it off once the move has ended", async () => {
      const { shop, repositoryId } = await onMovingShop();

      expect(removeRepositoryFromProjectCommand(handle.db, { projectId: shop.id, repositoryId })).toEqual({ ok: false, problem: REFUSAL });
      expect(held(shop.id)).toEqual([repositoryId]);

      abandonAdoption(handle.db, shop.id);

      expect(removeRepositoryFromProjectCommand(handle.db, { projectId: shop.id, repositoryId }).ok).toBe(true);
      expect(held(shop.id)).toEqual([]);
    });

    it("refuses repositories:remove, and removes it once the move has ended", async () => {
      const { shop, repositoryId } = await onMovingShop();

      expect(removeRepositoryCommand(handle.db, { id: repositoryId })).toEqual({ ok: false, problem: REFUSAL });
      expect(held(shop.id)).toEqual([repositoryId]);

      abandonAdoption(handle.db, shop.id);

      expect(removeRepositoryCommand(handle.db, { id: repositoryId })).toEqual({ ok: true, problem: null });
      expect(held(shop.id)).toEqual([]);
    });
  });
});

describe("a repository is never added to the gallery's Preview project (EO-607)", () => {
  const REFUSAL = "Preview is EO's rehearsal, and a repository belongs on a real project. Add it to another project, or make one for it.";

  it("refuses projects:addProject, leaving the repository on the project that holds it", async () => {
    const preview = previewProject();
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const repositoryId = (await attach("api", { projectId: shop.id })).repository!.id;

    expect(addRepositoryToProjectCommand(handle.db, { projectId: preview.id, repositoryId })).toEqual({ ok: false, problem: REFUSAL });
    expect(held(shop.id)).toEqual([repositoryId]);
    expect(held(preview.id)).toEqual([]);
  });

  it("goes by the id it wrote down, so a project somebody named Preview takes one", () => {
    previewProject("Rehearsal", "RHS");
    const mine = createProject(handle.db, { name: "Preview", keyPrefix: "PREVIEW" });
    const workspace = createGitWorkspace(handle.db, { config: { name: "api", repoPath: checkout("api") } });

    expect(addRepositoryToProjectCommand(handle.db, { projectId: mine.id, repositoryId: workspace.id }).ok).toBe(true);
    expect(held(mine.id)).toEqual([workspace.id]);
  });

  it("still moves a repository off Preview onto a real project", async () => {
    const preview = previewProject();
    const shop = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP" });
    const workspace = createGitWorkspace(handle.db, { config: { name: "api", repoPath: checkout("api") } });
    addWorkspaceToProject(handle.db, preview.id, workspace.id);

    expect(addRepositoryToProjectCommand(handle.db, { projectId: shop.id, repositoryId: workspace.id }).ok).toBe(true);
    expect(held(shop.id)).toEqual([workspace.id]);
    expect(held(preview.id)).toEqual([]);
  });
});

describe("removing a project's last repository (EO-603)", () => {
  function repositoryWithProject(name: string, keyPrefix: string) {
    const workspace = createGitWorkspace(handle.db, { config: { name, repoPath: `/tmp/${name}` } });
    const project = createDefaultProject(handle.db, workspace, keyPrefix);
    return { workspace, project };
  }

  it("keeps the project, its pipelines, its tickets and its notes thread", () => {
    const api = repositoryWithProject("api", "API");
    const pipeline = createPipeline(handle.db, { name: "Delivery", projectId: api.project.id });
    const feature = createTestItem(handle.db, { type: "feature", title: "Spans repos", stepId: null, projectId: api.project.id, workspaceId: null });
    const thread = openProjectThread(handle.db, api.project.id);
    if (!thread.ok) throw new Error(thread.problem);
    postComment(handle.db, { itemId: thread.item.id, author: { type: "human" }, body: "The staging database is shared." });

    const removed = removeRepositoryCommand(handle.db, { id: api.workspace.id });

    expect(removed).toEqual({ ok: true, problem: null });
    expect(getGitWorkspace(handle.db, api.workspace.id)).toBeUndefined();
    expect(getProject(handle.db, api.project.id)).toMatchObject({ id: api.project.id, name: "api" });
    expect(listPipelines(handle.db, api.project.id).map((entry) => entry.id)).toContain(pipeline.id);
    expect(getItem(handle.db, feature.id)).toMatchObject({ projectId: api.project.id });
    expect(listCommentsForItem(handle.db, thread.item.id).map((comment) => comment.body)).toContain("The staging database is shared.");
  });

  it("keeps a project with nothing on it, the window on it, and takes a repository again", async () => {
    const api = repositoryWithProject("api", "API");
    setSetting(handle.db, ACTIVE_PROJECT_KEY, api.project.id);

    removeRepositoryCommand(handle.db, { id: api.workspace.id });

    expect(activeProjectId(handle.db)).toBe(api.project.id);
    expect(listProjectsCommand(handle.db).projects[0]).toMatchObject({ id: api.project.id, repositoryIds: [] });

    const again = await attach("web");

    expect(again.project).toMatchObject({ id: api.project.id, created: false });
    expect(held(api.project.id)).toEqual([again.repository!.id]);
  });

  it("leaves a project another of its repositories is still on as it was", () => {
    const api = repositoryWithProject("api", "API");
    const ui = createGitWorkspace(handle.db, { config: { name: "ui", repoPath: "/tmp/ui" } });
    addWorkspaceToProject(handle.db, api.project.id, ui.id);

    removeRepositoryCommand(handle.db, { id: api.workspace.id });

    expect(held(api.project.id)).toEqual([ui.id]);
  });
});
