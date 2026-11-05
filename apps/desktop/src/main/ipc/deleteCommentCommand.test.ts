import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item, Uuid } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStorage } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import {
  createJiraConnection,
  listCommentsForItem,
  postComment,
  projectForWorkspace,
  saveJiraBinding,
  setJiraCommentId,
  setJiraSync,
  updateItem,
  type Workspace,
} from "../db/repos/index.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import type { FetchLike } from "../packs/developer/jira/client.js";
import type { JiraContext } from "../packs/developer/jira/connection.js";
import { storeToken } from "../packs/developer/jira/credentials.js";
import type { SecretStore } from "../secrets/store.js";
import { deleteCommentCommand } from "./deleteCommentCommand.js";

/**
 * Removing a comment, here and in Jira.
 *
 * The client is driven through its injected `fetchImpl`, the same seam
 * the rest of the Jira tests use, so the real request shapes are
 * exercised and nothing mocks a module.
 */
let handle: DbHandle;
let directory: string;
let repository: Workspace;
let projectId: Uuid;
let item: Item;
let attachmentStorage: AttachmentStorage;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`v1:${Buffer.from(plain).toString("base64")}`),
  decryptString: (encrypted) => Buffer.from(encrypted.toString().slice(3), "base64").toString(),
};

/** A Jira that records the deletes it is asked for, and can be told to refuse. */
function jiraRecording(refuse = false): { context: JiraContext; deleted: string[] } {
  const deleted: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (init?.method === "DELETE") {
      if (refuse) return new Response(JSON.stringify({ errorMessages: ["You do not have permission to delete this comment."] }), { status: 403 });
      deleted.push(new URL(url).pathname);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { context: { credentials: { directory, store }, fetchImpl }, deleted };
}

/** The binding is the project's since KAN-130, so that is where connecting writes. */
function connect(): void {
  const site = createJiraConnection(handle.db, { baseUrl: "https://jira.acme.internal", flavour: "datacenter" });
  saveJiraBinding(handle.db, projectId, { connectionId: site.id, projectKey: "ACME" });
  storeToken({ directory, store }, site.id, "pat");
}

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo delete comment "));
  attachmentStorage = new AttachmentStorage(join(directory, "attachments"));
  repository = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
  // The project too, not just the workspace: the issue behind a comment
  // is reached through the project's binding since KAN-130, so an item
  // given only the workspace would have a Jira key and no Jira.
  projectId = projectForWorkspace(handle.db, repository.id)!.id;
  item = createTestItem(handle.db, { type: "story", title: "Count requests", stepId: "todo", workspaceId: repository.id, projectId });
  updateItem(handle.db, item.id, { jiraKey: "ACME-8" });
  connect();
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("deleting a comment", () => {
  it("removes it here and in Jira, replies included", async () => {
    const question = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "which database?" });
    setJiraCommentId(handle.db, question.id, "10101");
    const reply = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Postgres", parentId: question.id });
    setJiraCommentId(handle.db, reply.id, "10102");

    const jira = jiraRecording();
    const result = await deleteCommentCommand(handle.db, jira.context, { commentId: question.id, deleteInJira: true }, attachmentStorage);

    expect(result).toMatchObject({ deleted: true, deletedCount: 2, problem: null });
    expect(result.jira).toMatchObject({ attempted: 2, deleted: 2, problem: null });
    expect(jira.deleted).toEqual(["/rest/api/2/issue/ACME-8/comment/10101", "/rest/api/2/issue/ACME-8/comment/10102"]);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("keeps the local delete when Jira refuses, and says what that costs", async () => {
    // A token can add comments without being allowed to delete somebody
    // else's. The person asked for it to be gone from here, and it is.
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "**Dana** in Jira:\n\nhello", jiraCommentId: "10101" });

    const result = await deleteCommentCommand(handle.db, jiraRecording(true).context, { commentId: comment.id, deleteInJira: true }, attachmentStorage);

    expect(result.deleted).toBe(true);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
    expect(result.jira?.deleted).toBe(0);
    expect(result.jira?.problem).toContain("permission");
    // The consequence, said rather than left to be discovered.
    expect(result.jira?.problem).toContain("come back on the next sync");
  });

  it("does not touch Jira when it was not asked to", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "local only" });
    setJiraCommentId(handle.db, comment.id, "10101");

    const jira = jiraRecording();
    const result = await deleteCommentCommand(handle.db, jira.context, { commentId: comment.id, deleteInJira: false }, attachmentStorage);

    expect(result.deleted).toBe(true);
    expect(result.jira).toBeNull();
    expect(jira.deleted).toEqual([]);
  });

  it("says so, rather than pretending, when the comment never reached Jira", async () => {
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "still queued" });

    const result = await deleteCommentCommand(handle.db, jiraRecording().context, { commentId: comment.id, deleteInJira: true }, attachmentStorage);

    expect(result.deleted).toBe(true);
    expect(result.jira).toMatchObject({ attempted: 0, deleted: 0 });
    expect(result.jira?.problem).toContain("had reached Jira");
  });

  it("refuses a comment that is already gone rather than throwing", async () => {
    const result = await deleteCommentCommand(handle.db, jiraRecording().context, { commentId: "no-such-comment", deleteInJira: true }, attachmentStorage);

    expect(result).toMatchObject({ deleted: false, deletedCount: 0, jira: null });
    expect(result.problem).toContain("no longer exists");
  });

  it("leaves Jira alone for an item that is not mirrored", async () => {
    const local = createTestItem(handle.db, { type: "story", title: "Local only", stepId: "todo", workspaceId: repository.id, projectId });
    const comment = postComment(handle.db, { itemId: local.id, author: { type: "human" }, body: "nothing to mirror" });

    const result = await deleteCommentCommand(handle.db, jiraRecording().context, { commentId: comment.id, deleteInJira: true }, attachmentStorage);

    expect(result.deleted).toBe(true);
    expect(result.jira).toBeNull();
  });

  it("does not reach into the issue for an item whose Jira sync is off, and says why", async () => {
    // The switch means invisible to Jira in both directions (EO-122),
    // and this is an immediate destructive call rather than a queued one
    // — nothing downstream would refuse it later. The comment really had
    // reached Jira, so the only thing standing between it and a remote
    // delete is the switch.
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "which database?" });
    setJiraCommentId(handle.db, comment.id, "10101");
    setJiraSync(handle.db, item.id, false);

    const jira = jiraRecording();
    const result = await deleteCommentCommand(handle.db, jira.context, { commentId: comment.id, deleteInJira: true }, attachmentStorage);

    // Not one request to Jira.
    expect(jira.deleted).toEqual([]);
    expect(result.jira).toMatchObject({ attempted: 0, deleted: 0 });
    expect(result.jira?.problem).toContain("switched off");
    // Named, because the person ticked a box asking for this and the
    // dialog offers that box off the key alone.
    expect(result.jira?.problem).toContain("ACME-8");
    // The local delete is untouched: the switch is about Jira, not EO.
    expect(result.deleted).toBe(true);
    expect(listCommentsForItem(handle.db, item.id)).toEqual([]);
  });

  it("removes managed files belonging to the comment and its replies", async () => {
    const parentDraft = await attachmentStorage.stageData({ name: "question.txt", dataBase64: Buffer.from("question").toString("base64") });
    const parentRecords = await attachmentStorage.prepare([parentDraft.id]);
    const question = postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "See attached",
      attachmentRecords: parentRecords,
    });
    await attachmentStorage.finish(parentRecords);

    const replyDraft = await attachmentStorage.stageData({ name: "answer.txt", dataBase64: Buffer.from("answer").toString("base64") });
    const replyRecords = await attachmentStorage.prepare([replyDraft.id]);
    postComment(handle.db, {
      itemId: item.id,
      author: { type: "human" },
      body: "",
      parentId: question.id,
      attachmentRecords: replyRecords,
    });
    await attachmentStorage.finish(replyRecords);

    expect(parentRecords.every((record) => existsSync(record.storagePath))).toBe(true);
    expect(replyRecords.every((record) => existsSync(record.storagePath))).toBe(true);

    const result = await deleteCommentCommand(
      handle.db,
      jiraRecording().context,
      { commentId: question.id, deleteInJira: false },
      attachmentStorage,
    );

    expect(result).toMatchObject({ deleted: true, deletedCount: 2 });
    expect(parentRecords.some((record) => existsSync(record.storagePath))).toBe(false);
    expect(replyRecords.some((record) => existsSync(record.storagePath))).toBe(false);
  });
});
