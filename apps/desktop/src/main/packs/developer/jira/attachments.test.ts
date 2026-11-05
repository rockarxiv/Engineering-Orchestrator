import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../../../attachments/storage.js";
import type { DbHandle } from "../../../db/client.js";
import {
  getAttachment,
  listAttachmentsForItem,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  queueUnsyncedAttachmentsForItem,
  saveJiraBinding,
  setJiraAttachmentId,
  setJiraSync,
} from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { deleteAttachmentCommand } from "../../../ipc/attachmentCommands.js";
import { drainChannel } from "../../../outbox/drain.js";
import type { FetchLike, JiraAttachment } from "./client.js";
import { createJiraClient } from "./index.js";
import { storeToken } from "./credentials.js";
import type { SecretStore } from "../../../secrets/store.js";
import { syncJiraAttachments } from "./attachments.js";
import { createJiraSender } from "./sender.js";

let handle: DbHandle;
let directory: string;
let storage: AttachmentStorage;

const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain),
  decryptString: (encrypted) => encrypted.toString(),
};

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo jira attachments "));
  storage = new AttachmentStorage(join(directory, "files"));
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("outbound attachment durability", () => {
  it("queues once, retries failures, records the Jira id, and queues local deletion", async () => {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, workspace.id)!;
    const site = createJiraConnection(handle.db, { baseUrl: "https://jira.example", flavour: "datacenter" });
    // The binding is the project's since KAN-130; the drain finds it by
    // hopping from the workspace the outbox entry names.
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "API" });
    storeToken({ directory, store }, site.id, "pat");
    const item = createTestItem(handle.db, { type: "story", title: "Upload", stepId: "todo", workspaceId: workspace.id, projectId: project.id, jiraKey: "API-1" });

    const draft = await storage.stageData({ name: "report.txt", dataBase64: Buffer.from("hello").toString("base64") });
    const prepared = await storage.prepare([draft.id]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "See file.", attachmentRecords: prepared });
    await storage.finish(prepared);
    expect(pendingPushesForItem(handle.db, item.id).map((entry) => entry.kind)).toEqual(["comment", "attachment_upload"]);

    let rejectUpload = true;
    let uploads = 0;
    let deletes = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/attachments")) {
        uploads += 1;
        if (rejectUpload) return new Response("temporary outage", { status: 503 });
        return new Response(JSON.stringify([{ id: "remote-1", filename: "report.txt", mimeType: "text/plain", size: 5, content: "https://jira.example/content/remote-1" }]), { status: 200 });
      }
      if (path.endsWith("/attachment/remote-1") && init?.method === "DELETE") {
        deletes += 1;
        return rejectUpload ? new Response("temporary outage", { status: 503 }) : new Response(null, { status: 204 });
      }
      if (path.endsWith("/comment")) return new Response(JSON.stringify({ id: "comment-1" }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const sender = createJiraSender({ credentials: { directory, store }, fetchImpl });
    const now = Date.now();
    const failed = await drainChannel(handle.db, "jira", sender, now);
    expect(failed).toMatchObject({ sent: 1, deferred: 1 });
    expect(getAttachment(handle.db, draft.id as Uuid)?.jiraSyncError).toContain("503");

    rejectUpload = false;
    await drainChannel(handle.db, "jira", sender, now + 31_000);
    expect(getAttachment(handle.db, draft.id as Uuid)).toMatchObject({ jiraAttachmentId: "remote-1", jiraSyncError: null });
    await drainChannel(handle.db, "jira", sender, now + 62_000);
    expect(uploads, "a completed outbox entry must not upload twice").toBe(2);

    await deleteAttachmentCommand(handle.db, storage, { attachmentId: draft.id });
    expect(getAttachment(handle.db, draft.id as Uuid)).toBeUndefined();
    expect(pendingPushesForItem(handle.db, item.id).at(-1)).toMatchObject({ kind: "attachment_delete", payload: { jiraAttachmentId: "remote-1" } });
    await drainChannel(handle.db, "jira", sender, now + 62_000);
    await drainChannel(handle.db, "jira", sender, now + 93_000);
    expect(deletes).toBe(1);
    expect(pendingPushesForItem(handle.db, item.id)).toEqual([]);
  });
});

/**
 * Files, and the switch that stops them moving (EO-122).
 *
 * Both directions of the file traffic are gated, and they have to be
 * gated together: an upload that never happened leaves nothing in Jira
 * to delete, so a deletion that slipped past the switch would be a
 * request to remove a file EO never sent.
 */
describe("attachments and the Jira sync switch", () => {
  function mirroredItem(jiraKey: string) {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, workspace.id)!;
    return createTestItem(handle.db, { type: "story", title: "Upload", stepId: "todo", workspaceId: workspace.id, projectId: project.id, jiraKey });
  }

  it("queues no upload for a sync-disabled item, and picks the file up when sync returns", async () => {
    const item = mirroredItem("API-9");
    setJiraSync(handle.db, item.id, false);

    const draft = await storage.stageData({ name: "report.txt", dataBase64: Buffer.from("hello").toString("base64") });
    const prepared = await storage.prepare([draft.id]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "See file.", attachmentRecords: prepared });
    await storage.finish(prepared);

    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    // Nothing was lost, only unsent: the file is stored locally either
    // way, and `queueUnsyncedAttachmentsForItem` is the door back in.
    expect(listAttachmentsForItem(handle.db, item.id)).toHaveLength(1);

    setJiraSync(handle.db, item.id, true);
    expect(queueUnsyncedAttachmentsForItem(handle.db, item.id)).toBe(1);
    expect(pendingPushesForItem(handle.db, item.id, "jira").map((entry) => entry.kind)).toEqual(["attachment_upload"]);
  });

  it("queues no deletion for a sync-disabled item, even for a file Jira already has", async () => {
    // The harder half: this attachment carries a remote id, so the only
    // thing stopping the deletion going out is the switch.
    const item = mirroredItem("API-10");
    const draft = await storage.stageData({ name: "report.txt", dataBase64: Buffer.from("hello").toString("base64") });
    const prepared = await storage.prepare([draft.id]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "See file.", attachmentRecords: prepared });
    await storage.finish(prepared);
    setJiraAttachmentId(handle.db, draft.id as Uuid, "remote-9");
    setJiraSync(handle.db, item.id, false);

    await deleteAttachmentCommand(handle.db, storage, { attachmentId: draft.id });

    expect(getAttachment(handle.db, draft.id as Uuid)).toBeUndefined();
    expect(pendingPushesForItem(handle.db, item.id, "jira").filter((entry) => entry.kind === "attachment_delete")).toEqual([]);
  });
});

describe("inbound reconciliation", () => {
  it("imports more than eight eligible files, sanitizes names, skips oversized files, deduplicates, and propagates deletion", async () => {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const item = createTestItem(handle.db, { type: "story", title: "Import", stepId: "todo", workspaceId: workspace.id, jiraKey: "API-2" });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Imported." });

    let remote: JiraAttachment[] = Array.from({ length: 10 }, (_, index) => ({
      id: `remote-${index}`,
      filename: index === 0 ? "../..\\unsafe.txt" : `file-${index}.txt`,
      mimeType: "text/plain",
      size: 6,
      contentUrl: `https://jira.example/content/remote-${index}`,
      created: "",
    }));
    remote.push({ id: "huge", filename: "huge.bin", mimeType: "application/octet-stream", size: MAX_ATTACHMENT_BYTES + 1, contentUrl: "https://jira.example/content/huge", created: "" });
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      if (path.includes("/issue/API-2")) {
        return new Response(JSON.stringify({ fields: { attachment: remote.map((entry) => ({ id: entry.id, filename: entry.filename, mimeType: entry.mimeType, size: entry.size, content: entry.contentUrl })) } }), { status: 200 });
      }
      return new Response(new TextEncoder().encode("bytes!"), { status: 200 });
    };
    const client = createJiraClient({ baseUrl: "https://jira.example", flavour: "datacenter", email: null, token: "pat" }, fetchImpl);

    const first = await syncJiraAttachments(handle.db, client, item, storage);
    expect(first).toMatchObject({ added: 10, removed: 0, skipped: 1, problems: [] });
    expect(listAttachmentsForItem(handle.db, item.id)).toHaveLength(10);
    expect(listAttachmentsForItem(handle.db, item.id)[0]?.name).toBe("unsafe.txt");

    const second = await syncJiraAttachments(handle.db, client, item, storage);
    expect(second.added).toBe(0);
    expect(listAttachmentsForItem(handle.db, item.id)).toHaveLength(10);

    const doomed = listAttachmentsForItem(handle.db, item.id).find((entry) => entry.jiraAttachmentId === "remote-3")!;
    remote = remote.filter((entry) => entry.id !== "remote-3");
    const third = await syncJiraAttachments(handle.db, client, item, storage);
    expect(third.removed).toBe(1);
    expect(getAttachment(handle.db, doomed.id)).toBeUndefined();
    expect(existsSync(doomed.path)).toBe(false);

    // A local delete remains a tombstone in the outbox until Jira
    // acknowledges it, so an intervening pull cannot resurrect it.
    const localDelete = listAttachmentsForItem(handle.db, item.id)[0]!;
    await deleteAttachmentCommand(handle.db, storage, { attachmentId: localDelete.id });
    const duringDelete = await syncJiraAttachments(handle.db, client, item, storage);
    expect(duringDelete.added).toBe(0);
    expect(listAttachmentsForItem(handle.db, item.id).some((entry) => entry.jiraAttachmentId === localDelete.jiraAttachmentId)).toBe(false);
  });

  it("does not publish a partial file or database row when a download is interrupted", async () => {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const item = createTestItem(handle.db, { type: "story", title: "Import", stepId: "todo", workspaceId: workspace.id, jiraKey: "API-3" });
    postComment(handle.db, { itemId: item.id, author: { type: "engine" }, body: "Imported." });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("connection reset"));
      },
    });
    const fetchImpl: FetchLike = async (url) => new URL(url).pathname.includes("/issue/")
      ? new Response(JSON.stringify({ fields: { attachment: [{ id: "broken", filename: "broken.txt", mimeType: "text/plain", size: 12, content: "https://jira.example/content/broken" }] } }), { status: 200 })
      : new Response(stream);
    const client = createJiraClient({ baseUrl: "https://jira.example", flavour: "datacenter", email: null, token: "pat" }, fetchImpl);

    const result = await syncJiraAttachments(handle.db, client, item, storage);
    expect(result.problems.join(" ")).toContain("connection reset");
    expect(listAttachmentsForItem(handle.db, item.id)).toEqual([]);
    const managedRoot = join(directory, "files", "files");
    expect(existsSync(managedRoot) ? readdirSync(managedRoot).filter((name) => name.includes("part")) : []).toEqual([]);
  });
});
