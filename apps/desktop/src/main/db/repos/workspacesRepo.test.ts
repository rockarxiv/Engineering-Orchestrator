import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_KIND, SCRATCH_KIND, type Uuid } from "@eo/core";
import type { DbHandle } from "../client.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../testHelpers.js";
import { projectForWorkspace } from "./projectsRepo.js";
import { createWorkspace, getWorkspace, listWorkspaces, updateWorkspace, workspaceLabel } from "./workspacesRepo.js";
import { adoptProjectlessItems, listItems } from "./itemsRepo.js";

let handle: DbHandle;

beforeEach(() => {
  handle = openMigratedTestDb();
});

afterEach(() => {
  handle.close();
});

/**
 * A repository as the app attaches one with no project to join: a
 * `git-worktree` workspace on a project made for it, carrying the prefix. The prefix is the
 * project's since KAN-128, so a workspace alone numbers nothing.
 */
function repository(name: string, keyPrefix: string, repoPath = `/tmp/${name}`) {
  return attachWorkspace(handle.db, { name, keyPrefix, repoPath, baseBranch: "main" });
}

/** The project a workspace was attached to. */
function projectOf(workspaceId: Uuid) {
  return projectForWorkspace(handle.db, workspaceId)!;
}

describe("item keys across projects", () => {
  it("numbers each project's items with its own prefix and its own counter", () => {
    const api = repository("api", "API");
    const web = repository("web", "WEB");

    const first = createTestItem(handle.db, { type: "story", title: "One", stepId: "todo", workspaceId: api.id });
    const second = createTestItem(handle.db, { type: "story", title: "Two", stepId: "todo", workspaceId: api.id });
    const other = createTestItem(handle.db, { type: "story", title: "Theirs", stepId: "todo", workspaceId: web.id });

    expect([first.key, second.key]).toEqual(["API-1", "API-2"]);
    // Its own counter, starting at 1 — not continuing API's sequence.
    expect(other.key).toBe("WEB-1");
  });

  it("keeps keys globally unique, which is what keeps worktree directories from colliding", () => {
    // ~/.eo/worktrees/<KEY> has no repository dimension, deliberately: a
    // unique key is the single rule that makes it safe (D-04).
    const api = repository("api", "API");
    const web = repository("web", "WEB");

    const keys = [
      createTestItem(handle.db, { type: "story", title: "a", stepId: "todo", workspaceId: api.id }).key,
      createTestItem(handle.db, { type: "story", title: "b", stepId: "todo", workspaceId: web.id }).key,
      createTestItem(handle.db, { type: "story", title: "c", stepId: "todo", workspaceId: api.id }).key,
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses two projects on the same prefix at the database level", () => {
    repository("api", "API");

    // Belt and braces: the create command checks first, but the unique
    // index is what actually makes duplicate keys impossible. On
    // `projects` since KAN-128 — attaching a repository is what tries to
    // claim the prefix a second time, and it is refused there.
    expect(() => repository("apiary", "API", "/tmp/apiary")).toThrow(/UNIQUE/);
  });

  it("falls back to the default prefix for an item with no workspace", () => {
    const loose = createTestItem(handle.db, { type: "feature", title: "Before any repo", stepId: null });
    expect(loose.key).toBe("EO-1");
  });
});

describe("listing items by workspace", () => {
  it("returns one workspace's items, all of them, or the unattached ones", () => {
    const api = repository("api", "API");
    const web = repository("web", "WEB");
    createTestItem(handle.db, { type: "story", title: "a", stepId: "todo", workspaceId: api.id });
    createTestItem(handle.db, { type: "story", title: "b", stepId: "todo", workspaceId: web.id });
    createTestItem(handle.db, { type: "story", title: "loose", stepId: "todo" });

    expect(listItems(handle.db, api.id).map((item) => item.title)).toEqual(["a"]);
    // No argument means every workspace — what the engine asks for, so it
    // advances work in repos nobody is looking at.
    expect(listItems(handle.db)).toHaveLength(3);
    expect(listItems(handle.db, null).map((item) => item.title)).toEqual(["loose"]);
  });
});

describe("adoptProjectlessItems", () => {
  it("moves items written before any workspace onto it, and leaves other workspaces' alone", () => {
    const early = createTestItem(handle.db, { type: "feature", title: "Written during onboarding", stepId: null });
    const web = repository("web", "WEB");
    const theirs = createTestItem(handle.db, { type: "story", title: "theirs", stepId: "todo", workspaceId: web.id });
    const api = repository("api", "API");

    const adopted = adoptProjectlessItems(handle.db, api.id, projectOf(api.id).id);

    expect(adopted).toBe(1);
    expect(listItems(handle.db, api.id).map((item) => item.id)).toEqual([early.id]);
    expect(listItems(handle.db, web.id).map((item) => item.id)).toEqual([theirs.id]);
  });

  it("keeps the item's original key, since it is already written down elsewhere", () => {
    // Its branch is eo/EO-1 and its worktree is ~/.eo/worktrees/EO-1.
    // Renumbering it on adoption would orphan both.
    const early = createTestItem(handle.db, { type: "feature", title: "Early", stepId: null });
    const api = repository("api", "API");

    adoptProjectlessItems(handle.db, api.id, projectOf(api.id).id);

    expect(listItems(handle.db, api.id)[0]?.key).toBe(early.key);
  });
});

describe("listWorkspaces", () => {
  it("returns them oldest first, so the first one is a stable fallback", () => {
    repository("api", "API");
    repository("web", "WEB");

    expect(listWorkspaces(handle.db).map(workspaceLabel)).toEqual(["api", "web"]);
  });

  it("attaches each one to the project it was created with", () => {
    // Membership is the workspace's own `project_id` since KAN-130, and
    // `attachWorkspace` writes it second — so a fixture that reported the
    // row as it was inserted would show every workspace attached to
    // nothing, and every test about routing would pass for the wrong
    // reason.
    const api = repository("api", "API");

    expect(listWorkspaces(handle.db).map((entry) => entry.projectId)).toEqual([projectOf(api.id).id]);
    expect(api.projectId).toBe(projectOf(api.id).id);
  });
});

describe("a config belongs to the kind that named it", () => {
  /**
   * The row was parsed with the git schema until EO-299, which was true
   * while `git-worktree` was the only kind and becomes a row that
   * cannot be *read* the moment there is a second: the git schema wants
   * a name and a repository path, and a folder has neither.
   */
  it("reads a folder workspace back as a folder, defaults and all", () => {
    const drive = mkdtempSync(join(tmpdir(), "eo-drive-"));
    try {
      const workspace = createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: drive } });

      const read = getWorkspace(handle.db, workspace.id);

      expect(read?.kind).toBe(FOLDER_KIND);
      expect(read?.config).toEqual({ path: drive, perItemSubfolder: false });
      // And it is called by its path, because that is what a person
      // calls a folder and it has no name field to disagree with one.
      expect(read && workspaceLabel(read)).toBe(drive);
    } finally {
      rmSync(drive, { recursive: true, force: true });
    }
  });

  it("refuses a folder workspace whose path is not a directory, rather than creating one", () => {
    const drive = mkdtempSync(join(tmpdir(), "eo-drive-"));
    const file = join(drive, "report.docx");
    writeFileSync(file, "not a folder");
    try {
      expect(() => createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: join(drive, "nowhere") } })).toThrow(/does not exist/);
      expect(() => createWorkspace(handle.db, { kind: FOLDER_KIND, config: { path: file } })).toThrow(/not a directory/);
      expect(existsSync(join(drive, "nowhere"))).toBe(false);
      expect(listWorkspaces(handle.db)).toEqual([]);
    } finally {
      rmSync(drive, { recursive: true, force: true });
    }
  });

  it("keeps the config of a kind it has no schema for, rather than emptying it on the next write", () => {
    // A pack may contribute a kind with settings of its own, and
    // `updateWorkspace` is a read-modify-write over one JSON value: a
    // parser that answered `{}` for anything it did not recognise would
    // wipe a pack kind's config the first time somebody reordered the
    // list.
    const workspace = createWorkspace(handle.db, { kind: "helpdesk", config: { queue: "support", site: "acme" } as never });

    const moved = updateWorkspace(handle.db, workspace.id, { position: 3 });

    expect(moved.config).toEqual({ queue: "support", site: "acme" });
    expect(getWorkspace(handle.db, workspace.id)?.config).toEqual({ queue: "support", site: "acme" });
  });

  it("keeps a scratch workspace, which configures nothing at all", () => {
    const workspace = createWorkspace(handle.db, { kind: SCRATCH_KIND });

    expect(getWorkspace(handle.db, workspace.id)?.config).toEqual({});
  });
});
