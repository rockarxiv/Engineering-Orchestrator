import { gitStateOf, type Item, type Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { getItem, pendingPushesForItem, projectForWorkspace, updateItem, type GitWorkspace } from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { renderItem } from "../mcpHost/render.js";
import { updateItemText } from "./domainCommands.js";
import { getItemDetail, getItemSections } from "./domainQueries.js";

/**
 * An item's Reference (EO-637) — the outside work it belongs to, as a
 * plain label — set, cleared and refused through `items:update`, the door
 * the item page and an agent's update tool both come in by, and read back
 * on the detail as its own or as its feature's.
 */
let handle: DbHandle;
let repository: GitWorkspace;
let projectId: Uuid;
let item: Item;

beforeEach(() => {
  handle = openMigratedTestDb();
  repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api", baseBranch: "main" });
  projectId = projectForWorkspace(handle.db, repository.id)!.id;
  item = createTestItem(handle.db, { type: "story", title: "A story", stepId: "todo", workspaceId: repository.id, projectId });
});

afterEach(() => {
  handle.close();
});

const own = (forItem: Item) => gitStateOf(getItem(handle.db, forItem.id)!).reference;
const shown = (forItem: Item) => getItemDetail(handle.db, { itemId: forItem.id })?.item.reference ?? null;

describe("setting a Reference", () => {
  it("stores it, trimmed, and the detail and the agent's item view both name it", () => {
    expect(updateItemText(handle.db, { itemId: item.id, reference: " PROJ-123 " })).toEqual({ updated: true, problem: null });

    expect(own(item)).toBe("PROJ-123");
    expect(shown(item)).toEqual({ value: "PROJ-123", inheritedFrom: null });
    const view = renderItem(getItemSections(handle.db, { itemId: item.id }));
    expect(view).toContain("- reference: PROJ-123");
    expect(view).not.toContain("inherited");
  });

  it("changes one already set", () => {
    updateItemText(handle.db, { itemId: item.id, reference: "PROJ-123" });

    expect(updateItemText(handle.db, { itemId: item.id, reference: "PROJ-124" }).updated).toBe(true);
    expect(own(item)).toBe("PROJ-124");
  });

  it.each([null, "", "   "])("clears it when sent %j", (sent) => {
    updateItemText(handle.db, { itemId: item.id, reference: "PROJ-123" });

    expect(updateItemText(handle.db, { itemId: item.id, reference: sent })).toEqual({ updated: true, problem: null });

    expect(own(item)).toBeNull();
    expect(shown(item)).toBeNull();
  });

  it("lets two items in the same project hold the same one", () => {
    const sibling = createTestItem(handle.db, { type: "bug", title: "A bug", stepId: "todo", workspaceId: repository.id, projectId });

    expect(updateItemText(handle.db, { itemId: item.id, reference: "PROJ-123" })).toEqual({ updated: true, problem: null });
    expect(updateItemText(handle.db, { itemId: sibling.id, reference: "PROJ-123" })).toEqual({ updated: true, problem: null });

    expect(own(item)).toBe("PROJ-123");
    expect(own(sibling)).toBe("PROJ-123");
  });

  it("leaves the git state it sits beside alone", () => {
    updateItem(handle.db, item.id, { git: { branch: "eo/API-1", baseBranch: "release/2.4" } });

    updateItemText(handle.db, { itemId: item.id, reference: "PROJ-123" });

    expect(gitStateOf(getItem(handle.db, item.id)!)).toMatchObject({ branch: "eo/API-1", baseBranch: "release/2.4", reference: "PROJ-123" });
  });
});

describe("refusing a Reference", () => {
  it.each([
    ["PROJ 123", "a space"],
    ["a..b", '".."'],
    ["-x", 'starts with "-"'],
    ["x.", 'ends with "."'],
    ["x/", 'ends with "/"'],
    ["a~b", '"~"'],
    ["a@{b", '"@{"'],
    [".foo", 'part ".foo" starts with "."'],
    ["a//b", '"//"'],
    ["a.lock/b", 'part "a.lock" ends with ".lock"'],
  ])("refuses %j, naming %s, and changes nothing else sent with it", (sent, named) => {
    updateItemText(handle.db, { itemId: item.id, reference: "PROJ-1" });

    const result = updateItemText(handle.db, { itemId: item.id, title: "Renamed", priority: 2, reference: sent });

    expect(result.updated).toBe(false);
    expect(result.problem).toContain(named);
    expect(own(item)).toBe("PROJ-1");
    const after = getItem(handle.db, item.id)!;
    expect(after.title).toBe("A story");
    expect(after.priority).toBe(0);
  });
});

describe("the Jira outbox", () => {
  it("queues nothing when one is set or cleared on an item mirroring a Jira issue, or on one that is not", () => {
    const mirrored = createTestItem(handle.db, { type: "story", title: "Mirrored", stepId: "todo", workspaceId: repository.id, projectId });
    updateItem(handle.db, mirrored.id, { jiraKey: "ACME-11" });

    for (const target of [item, mirrored]) {
      expect(updateItemText(handle.db, { itemId: target.id, reference: "PROJ-123" }).updated).toBe(true);
      expect(updateItemText(handle.db, { itemId: target.id, reference: null }).updated).toBe(true);
      expect(pendingPushesForItem(handle.db, target.id)).toEqual([]);
    }
  });
});

describe("a story under a feature", () => {
  let feature: Item;
  let story: Item;

  beforeEach(() => {
    feature = createTestItem(handle.db, { type: "feature", title: "Rate limiting", stepId: null, workspaceId: repository.id, projectId });
    story = createTestItem(handle.db, { type: "story", title: "The limiter", stepId: "todo", workspaceId: repository.id, projectId, parentId: feature.id });
    updateItemText(handle.db, { itemId: feature.id, reference: "PROJ-123" });
  });

  it("reads its feature's when it has none of its own, saying where it came from", () => {
    expect(own(story)).toBeNull();
    expect(shown(story)).toEqual({ value: "PROJ-123", inheritedFrom: feature.key });
    expect(renderItem(getItemSections(handle.db, { itemId: story.id }))).toContain(`- reference: PROJ-123 (inherited from ${feature.key})`);
  });

  it("follows the feature's when that changes, without the story being edited", () => {
    updateItemText(handle.db, { itemId: feature.id, reference: "PROJ-999" });

    expect(shown(story)).toEqual({ value: "PROJ-999", inheritedFrom: feature.key });
  });

  it("reads nothing once the feature's is cleared", () => {
    updateItemText(handle.db, { itemId: feature.id, reference: null });

    expect(shown(story)).toBeNull();
  });

  it("reads its own over the feature's, and the feature's again once its own is cleared", () => {
    updateItemText(handle.db, { itemId: story.id, reference: "PROJ-456" });
    expect(shown(story)).toEqual({ value: "PROJ-456", inheritedFrom: null });
    expect(shown(feature)).toEqual({ value: "PROJ-123", inheritedFrom: null });

    updateItemText(handle.db, { itemId: story.id, reference: "" });
    expect(shown(story)).toEqual({ value: "PROJ-123", inheritedFrom: feature.key });
  });
});
