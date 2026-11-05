import { sql } from "drizzle-orm";
import { gitStateOf, SCRATCH_KIND, type Item } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { addWorkspaceToProject, createRun, createWorkspace, getItem, projectForWorkspace, updateItem, updateStep, type GitWorkspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { updateItemText } from "./domainCommands.js";

/**
 * Setting or clearing an item's base branch after it exists (EO-364) —
 * the door the detail panel and `item_update` both come in by.
 *
 * Allowed while the item works on a branch of a git repository and has
 * not had one cut; refused, with nothing changed, once a branch exists
 * (naming it), and refused on an item whose work happens anywhere that
 * cuts no branch, which then stores no `git` row.
 */
let handle: DbHandle;
let repository: GitWorkspace;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api", baseBranch: "main" });
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId: projectForWorkspace(handle.db, repository.id)!.id });
});

afterEach(() => {
  handle.close();
});

const gitRows = (forItem: Item) => handle.db.all(sql`SELECT * FROM item_extensions WHERE item_id = ${forItem.id} AND extension = 'git'`);
const stored = (forItem: Item) => gitStateOf(getItem(handle.db, forItem.id)!);

describe("setting a base branch", () => {
  it("writes it onto the item while no branch has been cut", () => {
    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: " release/2.4 " })).toEqual({ updated: true, problem: null });

    expect(stored(item)).toEqual({ branch: null, pullRequest: null, baseBranch: "release/2.4", namedBranch: false, attachedAt: null, reference: null });
  });

  it("clears it with null, and takes the row away once it says nothing", () => {
    updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" });

    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: null })).toEqual({ updated: true, problem: null });

    expect(stored(item).baseBranch).toBeNull();
    expect(gitRows(item)).toEqual([]);
  });

  it("answers sending what it already holds as done, without writing", () => {
    updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" });

    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" })).toEqual({ updated: true, problem: null });
  });

  it("refuses once the branch is cut, naming it, and changes nothing — the title sent with it included", () => {
    updateItem(handle.db, item.id, { git: { branch: "eo/API-1", baseBranch: "release/2.4" } });

    const result = updateItemText(handle.db, { itemId: item.id, title: "Renamed", baseBranch: "release/2.5" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("`eo/API-1`");
    expect(stored(item)).toEqual({ branch: "eo/API-1", pullRequest: null, baseBranch: "release/2.4", namedBranch: false, attachedAt: null, reference: null });
    expect(getItem(handle.db, item.id)?.title).toBe("A story");
  });

  it("refuses clearing it once the branch is cut, too", () => {
    updateItem(handle.db, item.id, { git: { branch: "eo/API-1", baseBranch: "release/2.4" } });

    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: null }).problem).toContain("`eo/API-1`");
    expect(stored(item).baseBranch).toBe("release/2.4");
  });

  it("refuses while a run is in flight, which may be cutting the branch as it is asked", () => {
    createRun(handle.db, { itemId: item.id, agentId: null, action: "create_worktree" });

    const result = updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("being worked on");
    expect(gitRows(item)).toEqual([]);
  });

  it("refuses a name git would not take, saying why", () => {
    const result = updateItemText(handle.db, { itemId: item.id, baseBranch: "the release branch" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("space");
    expect(gitRows(item)).toEqual([]);
  });
});

describe("an item that does not work on a branch", () => {
  it("refuses one on an item whose work happens in scratch, and stores no git row", () => {
    const scratch = createWorkspace(handle.db, { kind: SCRATCH_KIND });
    addWorkspaceToProject(handle.db, item.projectId!, scratch.id);
    const elsewhere = createTestItem(handle.db, { type: "story", title: "Drafting", stepId: "todo", workspaceId: scratch.id, projectId: item.projectId });

    const result = updateItemText(handle.db, { itemId: elsewhere.id, baseBranch: "release/2.4" });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain("does not work on a branch");
    expect(gitRows(elsewhere)).toEqual([]);
  });

  it("refuses one on an item with no disk at all", () => {
    const nowhere = createTestItem(handle.db, { type: "story", title: "Nowhere", stepId: "todo" });

    expect(updateItemText(handle.db, { itemId: nowhere.id, baseBranch: "release/2.4" }).problem).toContain("does not work on a branch");
    expect(gitRows(nowhere)).toEqual([]);
  });

  it("refuses one on an item whose step only reads the repository", () => {
    updateStep(handle.db, "todo", { workspaceMode: "read" });

    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" }).problem).toContain("does not work on a branch");
    expect(gitRows(item)).toEqual([]);
  });
});

/**
 * Naming an existing branch to work on (EO-365): stored as the item's
 * `branch`, marked as the person's, under the same rule as the base.
 */
describe("naming an existing branch", () => {
  it("stores it as the item's branch, marked as named, while nothing is in git", () => {
    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: " feature/limits " })).toEqual({ updated: true, problem: null });

    expect(stored(item)).toEqual({ branch: "feature/limits", pullRequest: null, baseBranch: null, namedBranch: true, attachedAt: null, reference: null });
  });

  it("can be changed or cleared until Worktree attaches it, and clearing leaves no row", () => {
    updateItemText(handle.db, { itemId: item.id, existingBranch: "feature/limits" });
    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: "feature/other" }).updated).toBe(true);
    expect(stored(item).branch).toBe("feature/other");

    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: null })).toEqual({ updated: true, problem: null });
    expect(gitRows(item)).toEqual([]);
  });

  it("still lets a base branch be set beside it before it is attached", () => {
    updateItemText(handle.db, { itemId: item.id, existingBranch: "feature/limits" });

    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" })).toEqual({ updated: true, problem: null });
    expect(stored(item)).toMatchObject({ branch: "feature/limits", namedBranch: true, baseBranch: "release/2.4" });
  });

  it("refuses either edit once Worktree has attached it, naming the branch, and changes nothing", () => {
    updateItem(handle.db, item.id, { git: { branch: "feature/limits", namedBranch: true, attachedAt: "abc123" } });

    const swap = updateItemText(handle.db, { itemId: item.id, title: "Renamed", existingBranch: "feature/other" });
    expect(swap.updated).toBe(false);
    expect(swap.problem).toContain("`feature/limits`");
    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: null }).problem).toContain("`feature/limits`");
    expect(updateItemText(handle.db, { itemId: item.id, baseBranch: "release/2.4" }).problem).toContain("`feature/limits`");
    expect(getItem(handle.db, item.id)!.title).toBe("A story");
    expect(stored(item)).toMatchObject({ branch: "feature/limits", namedBranch: true, attachedAt: "abc123", baseBranch: null });
  });

  it("refuses one on an item EO has already cut a branch for", () => {
    updateItem(handle.db, item.id, { git: { branch: "eo/API-1" } });

    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: "feature/limits" }).problem).toContain("`eo/API-1`");
    expect(stored(item)).toMatchObject({ branch: "eo/API-1", namedBranch: false });
    // Nothing named, so nothing to clear: not a refusal.
    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: null })).toEqual({ updated: true, problem: null });
  });

  it("refuses a name git would not take, and one on an item that does not work on a branch", () => {
    expect(updateItemText(handle.db, { itemId: item.id, existingBranch: "my branch" }).problem).toContain("space");
    const nowhere = createTestItem(handle.db, { type: "story", title: "Nowhere", stepId: "todo" });
    expect(updateItemText(handle.db, { itemId: nowhere.id, existingBranch: "feature/limits" }).problem).toContain("does not work on a branch");
    expect(gitRows(item)).toEqual([]);
    expect(gitRows(nowhere)).toEqual([]);
  });
});
