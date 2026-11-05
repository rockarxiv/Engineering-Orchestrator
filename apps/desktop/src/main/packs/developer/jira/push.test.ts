import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraExtension, jiraStateOf, uuidv7, type Item, type Uuid } from "@eo/core";
import type { DbHandle } from "../../../db/client.js";
import {
  getItem,
  insertAttachments,
  listCommentsForItem,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  type Workspace,
} from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import type { FetchLike } from "./client.js";
import type { JiraContext } from "./connection.js";
import { storeToken } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";
import { pushFeature, pushStories } from "./push.js";

/**
 * Creating in Jira what EO creates (J-03).
 *
 * The rule every test here is really about: the EO item exists
 * whatever Jira does. Nothing in this module is allowed to cost someone
 * the feature they just described.
 */
let handle: DbHandle;
let directory: string;
let workspace: Workspace;
/** Where the Jira binding lives since KAN-130, and what `pushFeature` resolves an item through. */
let projectId: Uuid;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

interface Created {
  url: string;
  fields: Record<string, unknown>;
}

/** A Jira that accepts creates and records exactly what it was sent. */
function acceptingJira(): { fetchImpl: FetchLike; created: Created[] } {
  const created: Created[] = [];
  let next = 100;
  const fetchImpl: FetchLike = async (url, init) => {
    if (init?.method === "POST" && url.endsWith("/issue")) {
      const body = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
      created.push({ url, fields: body.fields });
      next += 1;
      return new Response(JSON.stringify({ id: String(next), key: `ACME-${next}` }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, created };
}

function refusingJira(body: unknown, status = 400): FetchLike {
  return async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function context(fetchImpl: FetchLike): JiraContext {
  return { credentials: { directory, store }, fetchImpl };
}

function connect(): void {
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  saveJiraBinding(handle.db, projectId, {
    connectionId: site.id,
    projectKey: "ACME",
    featureIssueType: "Epic",
    storyIssueType: "Story",
  });
  storeToken({ directory, store }, site.id, "pat");
}

function feature(overrides: Partial<Parameters<typeof createTestItem>[1]> = {}): Item {
  return createTestItem(handle.db, { type: "feature", workspaceId: workspace.id, projectId, title: "Rate limiting", stepId: null, ...overrides });
}

function story(parentId: Uuid, title: string, spec?: Record<string, unknown>): Item {
  return createTestItem(handle.db, {
    type: "story",
    parentId,
    workspaceId: workspace.id,
    projectId,
    title,
    body: "Do the thing.",
    stepId: "todo",
    ...(spec ? { spec } : {}),
  });
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo jira push "));
  workspace = attachWorkspace(handle.db, { name: "acme-api", keyPrefix: "ACME", repoPath: "/tmp/acme", baseBranch: "main" });
  projectId = projectForWorkspace(handle.db, workspace.id)!.id;
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("creating a feature in Jira", () => {
  it("records the key it got back", async () => {
    connect();
    const jira = acceptingJira();
    const item = feature();

    const result = await pushFeature(handle.db, context(jira.fetchImpl), item, "Throttle the public API.");

    expect(result).toEqual({ key: "ACME-101", problem: null });
    expect(jiraStateOf(getItem(handle.db, item.id)!)).toMatchObject({ key: "ACME-101", id: "101" });
    expect(jira.created[0]?.fields).toMatchObject({
      project: { key: "ACME" },
      issuetype: { name: "Epic" },
      summary: "Rate limiting",
      description: "Throttle the public API.",
    });
  });

  it("queues opening-comment attachments after Jira supplies the new key", async () => {
    connect();
    const item = feature();
    const opening = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Read this first." });
    const attachmentId = uuidv7();
    insertAttachments(handle.db, [{
      id: attachmentId,
      itemId: item.id,
      commentId: opening.id,
      storagePath: "/tmp/brief.txt",
      name: "brief.txt",
      mimeType: "text/plain",
      size: 5,
    }]);
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);

    await pushFeature(handle.db, context(acceptingJira().fetchImpl), item, "Read this first.");

    expect(pendingPushesForItem(handle.db, item.id)).toHaveLength(1);
    expect(pendingPushesForItem(handle.db, item.id)[0]).toMatchObject({ kind: "attachment_upload", payload: { attachmentId } });
  });

  it("sends the extra fields the project was configured with", async () => {
    // The createmeta-driven values from J-01. If Jira requires a Team,
    // every issue EO creates needs one or none of them get created.
    connect();
    saveJiraBinding(handle.db, projectId, { fields: { customfield_1: { id: "5" } } });
    const jira = acceptingJira();

    await pushFeature(handle.db, context(jira.fetchImpl), feature(), "Throttle it.");

    expect(jira.created[0]?.fields).toMatchObject({ customfield_1: { id: "5" } });
  });

  it("says so on the item, rather than only in a return value nobody reads", async () => {
    connect();

    const item = feature();
    await pushFeature(handle.db, context(acceptingJira().fetchImpl), item, "Throttle it.");

    expect(listCommentsForItem(handle.db, item.id).at(-1)?.body).toContain("Created ACME-101 in Jira");
  });

  it("keeps the feature when Jira refuses, and explains on the item", async () => {
    // The whole point. A required field nobody configured must not cost
    // someone the description they just wrote.
    connect();
    const item = feature();

    const result = await pushFeature(
      handle.db,
      context(refusingJira({ errors: { customfield_1: "Team is required." } })),
      item,
      "Throttle it.",
    );

    expect(result.key).toBeNull();
    expect(result.problem).toContain("Team is required");
    expect(getItem(handle.db, item.id)).toMatchObject({ title: "Rate limiting" });
    expect(jiraStateOf(getItem(handle.db, item.id)!).key).toBeNull();
    const note = listCommentsForItem(handle.db, item.id).at(-1)?.body ?? "";
    expect(note).toContain("was not created in Jira");
    expect(note).toContain("Team is required");
  });

  it("does nothing at all when the project is not connected", async () => {
    const jira = acceptingJira();
    const item = feature();

    const result = await pushFeature(handle.db, context(jira.fetchImpl), item, "Throttle it.");

    expect(jira.created).toEqual([]);
    expect(result.key).toBeNull();
    // Not connected is not a failure, so it does not clutter the thread.
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("does nothing for an item on no project, because that is what it has no binding through", async () => {
    // Since KAN-130 the binding is the project's, so the item's project
    // is the whole of the question — an item on none mirrors nowhere,
    // however connected the workspace it sits in happens to be.
    connect();
    const jira = acceptingJira();
    const item = feature({ projectId: null });

    const result = await pushFeature(handle.db, context(jira.fetchImpl), item, "Throttle it.");

    expect(result).toEqual({ key: null, problem: null });
    expect(jira.created).toEqual([]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("refuses to make a second issue for an item that already has one", async () => {
    // What an imported feature is (J-02), and what a retry would be.
    connect();
    const jira = acceptingJira();
    const item = feature({ jiraKey: "ACME-7", jiraId: "10001" });

    const result = await pushFeature(handle.db, context(jira.fetchImpl), item, "Throttle it.");

    expect(result.key).toBe("ACME-7");
    expect(jira.created).toEqual([]);
  });
});

describe("creating the approved stories as children", () => {
  it("makes one child per story, under the feature", async () => {
    connect();
    const jira = acceptingJira();
    const parent = feature({ jiraKey: "ACME-7", jiraId: "10001" });
    const stories = [story(parent.id, "Count requests"), story(parent.id, "Return 429")];

    const result = await pushStories(handle.db, context(jira.fetchImpl), parent, stories);

    expect(result).toEqual({ created: 2, problem: null });
    expect(jira.created.map((call) => call.fields["summary"])).toEqual(["Count requests", "Return 429"]);
    expect(jira.created.every((call) => JSON.stringify(call.fields["parent"]) === '{"key":"ACME-7"}')).toBe(true);
    expect(stories.map((entry) => jiraStateOf(getItem(handle.db, entry.id)!).key)).toEqual(["ACME-101", "ACME-102"]);
  });

  it("carries the acceptance criteria, since that is what makes it reviewable", async () => {
    connect();
    const jira = acceptingJira();
    const parent = feature({ jiraKey: "ACME-7" });

    await pushStories(handle.db, context(jira.fetchImpl), parent, [
      story(parent.id, "Count requests", { acceptance_criteria: ["Counts per key", "Resets each minute"] }),
    ]);

    const description = String(jira.created[0]?.fields["description"]);
    expect(description).toContain("Do the thing.");
    expect(description).toContain("- Counts per key");
    expect(description).toContain("- Resets each minute");
  });

  it("creates nothing when the feature itself is not in Jira", async () => {
    // Children of nothing would be loose issues nobody asked for.
    connect();
    const jira = acceptingJira();
    const parent = feature();

    const result = await pushStories(handle.db, context(jira.fetchImpl), parent, [story(parent.id, "Count requests")]);

    expect(result).toEqual({ created: 0, problem: null });
    expect(jira.created).toEqual([]);
  });

  it("keeps going after one story fails, and names the ones that did not land", async () => {
    // Six stories where the fourth trips a validation rule should leave
    // five issues and one legible complaint, not one issue and silence.
    connect();
    let call = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      if (init?.method === "POST" && url.endsWith("/issue")) {
        call += 1;
        if (call === 2) return new Response(JSON.stringify({ errorMessages: ["Summary must be less than 255 characters."] }), { status: 400 });
        return new Response(JSON.stringify({ id: `${call}`, key: `ACME-${call}` }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const parent = feature({ jiraKey: "ACME-7" });
    const stories = [story(parent.id, "First"), story(parent.id, "Second"), story(parent.id, "Third")];

    const result = await pushStories(handle.db, context(fetchImpl), parent, stories);

    expect(result.created).toBe(2);
    expect(result.problem).toContain("Summary must be less than 255");
    expect(jiraStateOf(getItem(handle.db, stories[0]!.id)!).key).toBe("ACME-1");
    expect(jiraStateOf(getItem(handle.db, stories[1]!.id)!).key).toBeNull();
    expect(jiraStateOf(getItem(handle.db, stories[2]!.id)!).key).toBe("ACME-3");

    const note = listCommentsForItem(handle.db, parent.id).at(-1)?.body ?? "";
    expect(note).toContain("Created 2 of 3");
    expect(note).toContain(stories[1]!.key);
  });

  it("skips a story that already has an issue", async () => {
    connect();
    const jira = acceptingJira();
    const parent = feature({ jiraKey: "ACME-7" });
    const already = story(parent.id, "Imported already");
    const fresh = story(parent.id, "New one");

    await pushStories(handle.db, context(jira.fetchImpl), parent, [{ ...already, extensions: jiraExtension({ key: "ACME-8" }) }, fresh]);

    expect(jira.created.map((entry) => entry.fields["summary"])).toEqual(["New one"]);
  });
});
