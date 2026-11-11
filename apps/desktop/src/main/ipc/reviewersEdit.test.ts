import { gitStateOf, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, projectForWorkspace, updateItem, updateWorkspace, type GitWorkspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { renderItem } from "../mcpHost/render.js";
import { updateItemText } from "./domainCommands.js";
import { getItemDetail, getItemSections } from "./domainQueries.js";

/**
 * An item's own pull request reviewers (EO-742) — set, emptied, cleared
 * and refused through `items:update`, the door the item page and
 * `item_update` both come in by — and read back on the detail and in
 * `item_get` as its own, its feature's or the repository's.
 */
let handle: DbHandle;
let repository: GitWorkspace;
let projectId: Uuid;
let feature: Item;
let story: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api", baseBranch: "main" });
  updateWorkspace(handle.db, repository.id, { config: { forgeReviewers: ["alice", "bob"] } });
  projectId = projectForWorkspace(handle.db, repository.id)!.id;
  feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: repository.id, projectId });
  story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: repository.id, projectId, parentId: feature.id });
});

afterEach(() => {
  handle.close();
});

const own = (item: Item) => gitStateOf(getItem(handle.db, item.id)!).reviewers;
const shown = (item: Item) => getItemDetail(handle.db, { itemId: item.id })?.item.reviewers ?? null;
const itemGet = (item: Item) => renderItem(getItemSections(handle.db, { itemId: item.id }));

describe("setting an item's own reviewers", () => {
  it("stores the list, normalised as the repository's is, and reads it as the item's own", () => {
    expect(updateItemText(handle.db, { itemId: story.id, reviewers: [" carol ", "", "acme/backend", "carol"] })).toEqual({ updated: true, problem: null });

    expect(own(story)).toEqual(["carol", "acme/backend"]);
    expect(shown(story)).toEqual({ value: ["carol", "acme/backend"], inheritedFrom: null });
    expect(itemGet(story)).toContain("- pull request reviewers: carol, acme/backend (set here)");
  });

  it("stores [] as asking nobody, over the repository's default", () => {
    expect(updateItemText(handle.db, { itemId: story.id, reviewers: [] })).toEqual({ updated: true, problem: null });

    expect(own(story)).toEqual([]);
    expect(shown(story)).toEqual({ value: [], inheritedFrom: null });
    expect(itemGet(story)).toContain("- pull request reviewers: nobody (set here)");
  });

  it("goes back to inheriting with null: the feature's own list, else the repository's default", () => {
    updateItemText(handle.db, { itemId: feature.id, reviewers: ["dave"] });
    updateItemText(handle.db, { itemId: story.id, reviewers: ["carol"] });

    expect(updateItemText(handle.db, { itemId: story.id, reviewers: null })).toEqual({ updated: true, problem: null });
    expect(own(story)).toBeNull();
    expect(shown(story)).toEqual({ value: ["dave"], inheritedFrom: feature.key });

    updateItemText(handle.db, { itemId: feature.id, reviewers: null });
    expect(shown(story)).toEqual({ value: ["alice", "bob"], inheritedFrom: "repository" });
    expect(itemGet(story)).toContain("- pull request reviewers: alice, bob (the repository's default)");
  });

  it("answers a list the item already holds as done, as a Reference sent again is", () => {
    updateItemText(handle.db, { itemId: story.id, reviewers: ["carol"] });

    expect(updateItemText(handle.db, { itemId: story.id, reviewers: ["carol"] })).toEqual({ updated: true, problem: null });
    expect(own(story)).toEqual(["carol"]);
  });

  it("leaves the git state it sits beside alone, and leaves no row when cleared on an item with nothing else", () => {
    updateItem(handle.db, story.id, { git: { branch: "eo/API-2", reference: "PROJ-1" } });

    updateItemText(handle.db, { itemId: story.id, reviewers: ["carol"] });

    expect(gitStateOf(getItem(handle.db, story.id)!)).toMatchObject({ branch: "eo/API-2", reference: "PROJ-1", reviewers: ["carol"] });
    updateItemText(handle.db, { itemId: feature.id, reviewers: ["dave"] });
    updateItemText(handle.db, { itemId: feature.id, reviewers: null });
    expect(getItem(handle.db, feature.id)!.extensions.git).toBeUndefined();
  });
});

describe("a story under a feature with its own reviewers", () => {
  it("reports the feature's, inherited from the feature's key, in item_get and on the detail", () => {
    updateItemText(handle.db, { itemId: feature.id, reviewers: ["dave"] });

    expect(own(story)).toBeNull();
    expect(shown(story)).toEqual({ value: ["dave"], inheritedFrom: feature.key });
    expect(itemGet(story)).toContain(`- pull request reviewers: dave (inherited from ${feature.key})`);
  });
});

describe("refusing reviewers", () => {
  it.each([["carol smith"], ["carol,dave"], ["carol\tsmith"]])("refuses %j, naming it, and changes nothing else sent with it", (entry) => {
    updateItemText(handle.db, { itemId: story.id, reviewers: ["erin"] });

    const result = updateItemText(handle.db, { itemId: story.id, title: "Renamed", priority: 2, reference: "PROJ-9", reviewers: ["frank", entry] });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain(`"${entry}"`);
    expect(own(story)).toEqual(["erin"]);
    const after = getItem(handle.db, story.id)!;
    expect(after.title).toBe("The limiter");
    expect(after.priority).toBe(0);
    expect(gitStateOf(after).reference).toBeNull();
  });
});

describe("where nothing is set", () => {
  it("says nothing in item_get when the repository asks nobody either", () => {
    updateWorkspace(handle.db, repository.id, { config: { forgeReviewers: [] } });

    expect(shown(story)).toEqual({ value: [], inheritedFrom: "repository" });
    expect(itemGet(story)).not.toContain("reviewers");
  });
});
