import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { workspaces } from "../schema.js";
import {
  addWorkspaceToProject,
  projectWorkspaceList,
  projectForWorkspace,
  createProject,
  createDefaultProject,
  deleteProject,
  getProject,
  listProjects,
  removeWorkspaceFromProject,
  suggestKeyPrefix,
  takenKeyPrefixes,
  updateProject,
} from "./projectsRepo.js";
import { createWorkspace, deleteWorkspace, getWorkspace, workspaceLabel } from "./workspacesRepo.js";
import { getJiraBinding, isJiraConnected, saveJiraBinding } from "./connectorBindingsRepo.js";
import { createJiraConnection } from "./jiraConnectionsRepo.js";

/**
 * Projects, and the workspaces they span (KAN-17, KAN-130).
 *
 * A project used to be a repository. The point of separating them is that one
 * application is often several repositories — so what is worth asserting
 * is the span itself, which direction it points, and the one rule that
 * survives it: a story still belongs to exactly one workspace, and only
 * a *feature* on a multi-workspace project is project-owned.
 *
 * Which direction it points is the thing KAN-130 changed. Membership was
 * a join table, so a repository could sit on two projects; it is the
 * workspace's own `project_id` now, and a workspace belongs to the
 * project that holds it (ARCHITECTURE.md, "A workspace is a kind, attached to the project").
 */
let handle: DbHandle;

/**
 * A repository as the app attaches one with no project to join: a
 * `git-worktree` workspace on a project made for it, carrying the prefix
 * (KAN-128). Where a test
 * is about `createDefaultProject` itself it calls `createWorkspace`
 * instead, so that the project it makes is the only one there is.
 */
function repository(name: string, prefix: string) {
  return attachWorkspace(handle.db, { name, keyPrefix: prefix, repoPath: `/tmp/${name}` });
}

/** A workspace no project holds — what `createDefaultProject` is handed. */
function bareRepository(name: string) {
  return createWorkspace(handle.db, { config: { name, repoPath: `/tmp/${name}` } });
}

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

describe("a project and its repositories", () => {
  it("makes a default project wearing the repository's name and the prefix it was attached with", () => {
    const api = bareRepository("api");

    const project = createDefaultProject(handle.db, api, "API");

    expect(project).toMatchObject({ name: "api", keyPrefix: "API" });
    expect(projectWorkspaceList(handle.db, project.id).map((entry) => entry.id)).toEqual([api.id]);
  });

  it("does not reuse the repository's id, so the two can never be confused", () => {
    // The migration could have used the repository id and made its own
    // backfill trivial. That would work on every upgraded database and
    // fail only on a fresh one, which is the worst way for a mistake to
    // behave.
    const api = bareRepository("api");

    expect(createDefaultProject(handle.db, api, "API").id).not.toBe(api.id);
  });

  it("holds several repositories, in the order they were added", () => {
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id] });

    addWorkspaceToProject(handle.db, project.id, api.id);

    expect(projectWorkspaceList(handle.db, project.id).map(workspaceLabel)).toEqual(["ui", "api"]);
  });

  it("keeps the order unambiguous after a repository has been removed", () => {
    // Position used to be the row count, so detaching one left a gap and
    // the next repository added took a position something already held.
    // Nothing rejects that — position is a plain column — and the list
    // then orders the two arbitrarily. Which one comes first is not
    // cosmetic: it names the repository a discussion starts in and the
    // one a feature's worktree is cut from.
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const docs = repository("docs", "DOCS");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });

    removeWorkspaceFromProject(handle.db, project.id, ui.id);
    addWorkspaceToProject(handle.db, project.id, docs.id);

    // The order that comes back is only meaningful if the positions
    // behind it are distinct; two rows sharing one leaves SQLite to pick,
    // and it is under no obligation to pick the same way twice. The
    // position is the workspace's own column since KAN-130, so this asks
    // the members themselves rather than a membership table.
    const positions = handle.db
      .select({ position: workspaces.position })
      .from(workspaces)
      .where(eq(workspaces.projectId, project.id))
      .all()
      .map((row) => row.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(projectWorkspaceList(handle.db, project.id).map(workspaceLabel)).toEqual(["api", "docs"]);
  });

  it("orders a collision that predates the fix the same way twice", () => {
    // Fixing the insert rule does nothing for rows already written by the
    // old one, and an install that has ever removed a repository can be
    // carrying duplicates right now. Migration 0037 renumbered the
    // membership rows and 0072 carried their positions onto the
    // workspaces, so a database that predates the fix arrives here with
    // the duplicate intact — the reader still has to be a total order on
    // its own. This writes the collision directly, which is the state
    // such a database is in.
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });

    handle.db.update(workspaces).set({ position: 0 }).where(eq(workspaces.projectId, project.id)).run();

    const byId = [ui, api].sort((left, right) => left.id.localeCompare(right.id)).map(workspaceLabel);
    expect(projectWorkspaceList(handle.db, project.id).map(workspaceLabel)).toEqual(byId);
    // Same answer on a second read, which is the property that matters:
    // it names the repository a discussion starts in.
    expect(projectWorkspaceList(handle.db, project.id).map(workspaceLabel)).toEqual(byId);
  });

  it("moves a workspace rather than sharing it, because it belongs to the project that holds it", () => {
    // This asserted the many-to-many until KAN-130: a repository could
    // sit on two projects at once. A workspace belongs to one
    // (ARCHITECTURE.md, "A workspace is a kind, attached to the project"), so a project that takes
    // one
    // another project holds takes it *off* that one. What that costs is
    // spanning a checkout from two projects; what it buys is that "which
    // project's binding does this run mirror through" has exactly one
    // answer.
    //
    // Bare, so that the two projects below are the only two: a
    // repository attached the ordinary way arrives with a third.
    const shared = bareRepository("design-system");
    const one = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [shared.id] });
    const two = createProject(handle.db, { name: "Admin", keyPrefix: "ADM", workspaceIds: [shared.id] });

    expect(projectForWorkspace(handle.db, shared.id)?.id).toBe(two.id);
    expect(projectWorkspaceList(handle.db, one.id)).toEqual([]);
    expect(projectWorkspaceList(handle.db, two.id).map((entry) => entry.id)).toEqual([shared.id]);

    // And the same through the other door, which is the one the
    // Repositories screen uses.
    addWorkspaceToProject(handle.db, one.id, shared.id);

    expect(projectForWorkspace(handle.db, shared.id)?.id).toBe(one.id);
    expect(projectWorkspaceList(handle.db, two.id)).toEqual([]);
  });

  it("ignores adding a repository that is already on the project", () => {
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [api.id] });

    addWorkspaceToProject(handle.db, project.id, api.id);

    expect(projectWorkspaceList(handle.db, project.id)).toHaveLength(1);
  });

  it("detaches a removed repository instead of deleting it, and leaves another project's alone", () => {
    // Removing used to delete a membership row and the repository was
    // never in question. It is the workspace's own column now, so
    // "removed" has to mean *detached*: the checkout is still on disk
    // and items still name it, which is the state a deleted project
    // leaves its workspaces in too.
    const design = repository("design-system", "DS");
    const admin = repository("admin", "ADM");
    const one = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [design.id] });
    const two = createProject(handle.db, { name: "Admin", keyPrefix: "ADMIN", workspaceIds: [admin.id] });

    removeWorkspaceFromProject(handle.db, one.id, design.id);

    expect(projectWorkspaceList(handle.db, one.id)).toEqual([]);
    expect(getWorkspace(handle.db, design.id)).toMatchObject({ projectId: null });
    expect(projectWorkspaceList(handle.db, two.id).map((entry) => entry.id)).toEqual([admin.id]);
  });

  it("detaches its repositories when the project goes, and leaves them standing", () => {
    // `ON DELETE SET NULL`, not cascade: the disk outlives the project
    // and an item resolves its run's cwd through the workspace, so
    // deleting the project takes the membership and nothing else.
    const api = bareRepository("api");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [api.id] });

    deleteProject(handle.db, project.id);

    expect(listProjects(handle.db)).toEqual([]);
    expect(projectForWorkspace(handle.db, api.id)).toBeUndefined();
    expect(projectWorkspaceList(handle.db, project.id)).toEqual([]);
    expect(getWorkspace(handle.db, api.id)).toMatchObject({ id: api.id, projectId: null });
  });

  it("keeps mirroring when one of its repositories is deleted", () => {
    // `projects.jira_project_id` named which member's Jira received the
    // project's features, and the first version pinned it with a plain
    // foreign key — so deleting *any* repository failed outright, and
    // the fix was a project that survived and stopped mirroring. The
    // binding is the project's own since KAN-130, so a checkout going
    // away says nothing at all about where the project mirrors.
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "SHOP" });

    deleteWorkspace(handle.db, api.id);

    expect(isJiraConnected(getJiraBinding(handle.db, project.id))).toBe(true);
    expect(projectWorkspaceList(handle.db, project.id).map(workspaceLabel)).toEqual(["ui"]);
  });

  it("is left standing, and empty, when its last repository is deleted", () => {
    // Membership is one column, so deleting a workspace is one row. A
    // project is what a person made and it outlives its repositories
    // (EO-603).
    const api = bareRepository("api");
    const project = createDefaultProject(handle.db, api, "API");

    deleteWorkspace(handle.db, api.id);

    expect(getProject(handle.db, project.id)).toMatchObject({ id: project.id });
    expect(projectWorkspaceList(handle.db, project.id)).toEqual([]);
  });

  it("mirrors through one binding of its own, rather than nominating a member's Jira", () => {
    // The question `projects.jira_project_id` answered, and the reason
    // it stopped being a question: the Jira configuration was copied per
    // repository with nothing keeping the copies in step, so a project
    // had to nominate whose copy counted. There is one binding on the
    // project now — every member mirrors through it, and `updateProject`
    // lost the argument rather than keeping one that would do nothing
    // (invariant 12).
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });
    const site = createJiraConnection(handle.db, { baseUrl: "https://acme.atlassian.net", flavour: "cloud" });

    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "SHOP" });

    expect(getJiraBinding(handle.db, project.id)?.config).toMatchObject({ projectKey: "SHOP" });
    expect(projectForWorkspace(handle.db, ui.id)?.id).toBe(project.id);
    expect(projectForWorkspace(handle.db, api.id)?.id).toBe(project.id);
    // And renaming it is all an update does now.
    expect(updateProject(handle.db, project.id, { name: "Shopfront" })).toMatchObject({ name: "Shopfront" });
  });
});

describe("what an item is called", () => {
  it("keys a story from its project, whichever repository it is routed to", () => {
    // The rule KAN-128 turned round. A story used to key from its
    // repository, and a project spanning a UI repo and a backend one
    // therefore numbered one project's work from two counters. The key
    // says which project the work belongs to; the branch and the
    // worktree still say which repository, because they are named after
    // the key and the key is unique.
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });

    const first = createTestItem(handle.db, { type: "story", title: "s", stepId: "todo", workspaceId: api.id, projectId: project.id });
    const second = createTestItem(handle.db, { type: "story", title: "t", stepId: "todo", workspaceId: ui.id, projectId: project.id });

    expect([first.key, second.key]).toEqual(["SHOP-1", "SHOP-2"]);
  });

  it("keys a repository-less feature from its project", () => {
    // The case projects exist for: a feature spanning several repos
    // belongs to none of them, so it takes the project's prefix rather
    // than falling back to the EO placeholder.
    const ui = repository("ui", "UI");
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [ui.id, api.id] });

    const feature = createTestItem(handle.db, { type: "feature", title: "f", stepId: null, projectId: project.id });

    expect(feature.key).toMatch(/^SHOP-\d+$/);
    expect(feature.workspaceId).toBeNull();
    expect(feature.projectId).toBe(project.id);
  });

  it("numbers a one-repo project exactly as it did before the prefix moved", () => {
    // The regression that would be easiest to ship and hardest to
    // notice. The default project carries the prefix the repository was
    // attached with, so the ordinary single-repository installation
    // draws from the same counter row it always did and the sequence
    // never restarts.
    const api = bareRepository("api");
    const project = createDefaultProject(handle.db, api, "API");

    const feature = createTestItem(handle.db, { type: "feature", title: "f", stepId: null, workspaceId: api.id, projectId: project.id });
    const story = createTestItem(handle.db, { type: "story", title: "s", stepId: "todo", workspaceId: api.id, projectId: project.id });

    expect([feature.key, story.key]).toEqual(["API-1", "API-2"]);
  });

  it("still falls back to EO for an item with neither", () => {
    // Onboarding: real work described before any repo is attached.
    expect(createTestItem(handle.db, { type: "feature", title: "early", stepId: null }).key).toMatch(/^EO-\d+$/);
  });

  it("takes the repository's own project for an item that names no project", () => {
    // `ticket_create` and the Jira import both write items that name a
    // repository and nothing else. Falling through to EO for those would
    // renumber an installation that had been minting API-14 for a year.
    const api = repository("api", "API");

    const story = createTestItem(handle.db, { type: "story", title: "s", stepId: "todo", workspaceId: api.id });

    expect(story.key).toBe("API-1");
  });

  it("cannot be given a repository that does not exist", () => {
    // `keyPrefixFor` has a fallback for a repository id that resolves to
    // nothing, and this is the test that went looking for it: the
    // foreign key refuses the row outright, so that branch is
    // unreachable from any normal insert. Kept as an assertion that the
    // constraint is on and doing the work, rather than deleting it and
    // leaving the next reader to wonder.
    const api = repository("api", "API");
    const project = createProject(handle.db, { name: "Shop", keyPrefix: "SHOP", workspaceIds: [api.id] });

    expect(() =>
      createTestItem(handle.db, {
        type: "feature",
        title: "f",
        stepId: null,
        workspaceId: "00000000-0000-7000-8000-000000000000" as Uuid,
        projectId: project.id,
      }),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe("the key prefix namespace", () => {
  it("counts a prefix as taken once a project holds it", () => {
    expect(takenKeyPrefixes(handle.db).has("API")).toBe(false);

    repository("api", "API");

    expect(takenKeyPrefixes(handle.db).has("API")).toBe(true);
  });

  it("does not count a repository, because a repository no longer has one", () => {
    // KAN-128: the prefix left `repositories.key_prefix` for the
    // project, so there is one table to ask rather than two to keep
    // agreeing with each other. A workspace's config never carried it.
    bareRepository("api");

    expect(takenKeyPrefixes(handle.db)).toEqual(new Set());
  });
});

describe("suggestKeyPrefix", () => {
  it("derives one from the name, and avoids the ones already taken", () => {
    expect(suggestKeyPrefix(handle.db, "my-api")).toBe("MYAP");

    repository("my-api", "MYAP");
    expect(suggestKeyPrefix(handle.db, "my-api")).toBe("MYAP2");
  });

  it("still produces something usable for a name with no letters", () => {
    expect(suggestKeyPrefix(handle.db, "123")).toBe("EO");
  });
});
