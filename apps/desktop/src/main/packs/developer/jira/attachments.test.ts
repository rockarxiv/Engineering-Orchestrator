import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7, type Uuid } from "@eo/core";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../../../attachments/storage.js";
import type { DbHandle } from "../../../db/client.js";
import {
  addItemAttachments,
  getAttachment,
  insertAttachments,
  removeItemAttachment,
  listAttachmentsForItem,
  listCommentsForItem,
  listItemAttachments,
  pendingPushesForItem,
  postComment,
  projectForWorkspace,
  queueUnsyncedAttachmentsForItem,
  saveJiraBinding,
  setJiraAttachmentId,
  setJiraSync,
} from "../../../db/repos/index.js";
import { createJiraConnection } from "../../../db/repos/jiraConnectionsRepo.js";
import { attachmentWasRemoved } from "../../../db/repos/attachmentsRepo.js";
import { attachWorkspace, createTestItem, openMigratedTestDb } from "../../../db/testHelpers.js";
import { deleteAttachmentCommand } from "../../../ipc/attachmentCommands.js";
import { addItemAttachmentsCommand, removeItemAttachmentCommand } from "../../../ipc/itemAttachmentCommands.js";
import { markReplica } from "../../../db/recordRole.js";
import { createPerson } from "../../../db/repos/peopleRepo.js";
import { issueDevice } from "../../../db/repos/devicesRepo.js";
import { createLocalRecord } from "../../../record/localRecord.js";
import { serveApply, type ServeRecordContext } from "../../../record/serveRecord.js";
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
    expect(listItemAttachments(handle.db, item.id), "pulled files are the item's own (EO-705)").toHaveLength(10);

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

/**
 * Jira's issue files are the item's own files (EO-705), both ways.
 */
describe("item attachments and Jira issue attachments", () => {
  interface FakeJira {
    remote: JiraAttachment[];
    uploads: string[];
    deletes: string[];
    fetchImpl: FetchLike;
  }

  function fakeJira(issueKey: string): FakeJira {
    const fake: FakeJira = { remote: [], uploads: [], deletes: [], fetchImpl: async () => new Response(null) };
    let next = 0;
    fake.fetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith(`/issue/${issueKey}/attachments`)) {
        next += 1;
        const id = `uploaded-${next}`;
        fake.uploads.push(id);
        const entry = { id, filename: `upload-${next}`, mimeType: "text/plain", size: 5, contentUrl: `https://jira.example/content/${id}`, created: "" };
        fake.remote.push(entry);
        return new Response(JSON.stringify([{ id, filename: entry.filename, mimeType: entry.mimeType, size: entry.size, content: entry.contentUrl }]), { status: 200 });
      }
      const deleted = /\/attachment\/([^/]+)$/.exec(path);
      if (deleted && init?.method === "DELETE") {
        fake.deletes.push(deleted[1]!);
        fake.remote = fake.remote.filter((entry) => entry.id !== deleted[1]);
        return new Response(null, { status: 204 });
      }
      if (path.includes(`/issue/${issueKey}`)) {
        return new Response(JSON.stringify({ fields: { attachment: fake.remote.map((entry) => ({ id: entry.id, filename: entry.filename, mimeType: entry.mimeType, size: entry.size, content: entry.contentUrl })) } }), { status: 200 });
      }
      return new Response(new TextEncoder().encode("bytes!"), { status: 200 });
    };
    return fake;
  }

  function mirrored(jiraKey: string) {
    const workspace = attachWorkspace(handle.db, { name: "api", keyPrefix: "API", repoPath: "/tmp/api" });
    const project = projectForWorkspace(handle.db, workspace.id)!;
    const site = createJiraConnection(handle.db, { baseUrl: "https://jira.example", flavour: "datacenter" });
    saveJiraBinding(handle.db, project.id, { connectionId: site.id, projectKey: "API" });
    storeToken({ directory, store }, site.id, "pat");
    const item = createTestItem(handle.db, { type: "story", title: "Files", stepId: "todo", workspaceId: workspace.id, projectId: project.id, jiraKey });
    const fake = fakeJira(jiraKey);
    const client = createJiraClient({ baseUrl: "https://jira.example", flavour: "datacenter", email: null, token: "pat" }, fake.fetchImpl);
    const sender = createJiraSender({ credentials: { directory, store }, fetchImpl: fake.fetchImpl });
    return { item, fake, client, drain: (at: number) => drainChannel(handle.db, "jira", sender, at) };
  }

  async function addItemFile(itemId: string, name: string) {
    const draft = await storage.stageData({ name, dataBase64: Buffer.from("hello").toString("base64") });
    const answer = await addItemAttachmentsCommand(handle.db, storage, { itemId, attachmentIds: [draft.id] });
    expect(answer.problem).toBeNull();
    return draft.id as Uuid;
  }

  it("pulls a Jira issue file onto the item, with no comment and nothing queued back", async () => {
    const { item, fake, client } = mirrored("API-20");
    fake.remote.push({ id: "spec", filename: "spec.pdf", mimeType: "application/pdf", size: 6, contentUrl: "https://jira.example/content/spec", created: "" });

    const result = await syncJiraAttachments(handle.db, client, item, storage);

    expect(result).toMatchObject({ added: 1, problems: [] });
    expect(listItemAttachments(handle.db, item.id)).toMatchObject([{ name: "spec.pdf", commentId: null, jiraAttachmentId: "spec" }]);
    expect(listCommentsForItem(handle.db, item.id), "no note is posted to own the file any more").toEqual([]);
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
  });

  it("uploads an item file added in EO, and removing it in EO removes it in Jira", async () => {
    const { item, fake, client, drain } = mirrored("API-21");
    const id = await addItemFile(item.id, "mock.png");
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toMatchObject([{ kind: "attachment_upload", payload: { attachmentId: id } }]);

    await drain(Date.now());
    expect(fake.uploads).toEqual(["uploaded-1"]);
    expect(getAttachment(handle.db, id)).toMatchObject({ commentId: null, jiraAttachmentId: "uploaded-1", jiraSyncError: null });
    // The uploaded file is now in Jira's listing; a pull must recognise
    // it as the item file it came from, not import it a second time.
    await syncJiraAttachments(handle.db, client, item, storage);
    expect(listAttachmentsForItem(handle.db, item.id)).toHaveLength(1);

    expect(await removeItemAttachmentCommand(handle.db, storage, { attachmentId: id })).toEqual({ removed: true, problem: null });
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toMatchObject([{ kind: "attachment_delete", payload: { jiraAttachmentId: "uploaded-1" } }]);

    // The tombstone: a pull landing before the outbox drains sees the
    // file still in Jira and must not bring it back.
    const during = await syncJiraAttachments(handle.db, client, item, storage);
    expect(during.added).toBe(0);
    expect(listAttachmentsForItem(handle.db, item.id)).toEqual([]);

    await drain(Date.now() + 1);
    expect(fake.deletes).toEqual(["uploaded-1"]);
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
    expect((await syncJiraAttachments(handle.db, client, item, storage)).added).toBe(0);
  });

  it("removes an item file in EO when it is removed in Jira, without echoing a deletion back", async () => {
    const { item, fake, client } = mirrored("API-22");
    fake.remote.push({ id: "shot", filename: "bug.png", mimeType: "image/png", size: 6, contentUrl: "https://jira.example/content/shot", created: "" });
    await syncJiraAttachments(handle.db, client, item, storage);
    const pulled = listItemAttachments(handle.db, item.id)[0]!;

    fake.remote = [];
    const result = await syncJiraAttachments(handle.db, client, item, storage);

    expect(result.removed).toBe(1);
    expect(getAttachment(handle.db, pulled.id)).toBeUndefined();
    expect(existsSync(pulled.path)).toBe(false);
    // Removed the way the item page removes one, so the organisation
    // record is told…
    expect(attachmentWasRemoved(handle.db, pulled.id)).toBe(true);
    // …and Jira is not: it is where the removal came from.
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
  });

  it("leaves a Jira file already on a comment where it is, and does not duplicate it on the item", async () => {
    const { item, fake, client } = mirrored("API-23");
    // What a pull before EO-705 left: the file on the engine's note.
    const note = postComment(handle.db, { itemId: item.id, author: { type: "engine" }, kind: "note", body: "Attachments synchronized from Jira.", jiraCommentId: "attachments:API-23" });
    const old = await storage.storeImported({ name: "old.txt", mimeType: "text/plain", data: new TextEncoder().encode("bytes!") });
    insertAttachments(handle.db, [{ ...old, itemId: item.id, commentId: note.id, jiraAttachmentId: "old" }]);
    fake.remote.push({ id: "old", filename: "old.txt", mimeType: "text/plain", size: 6, contentUrl: "https://jira.example/content/old", created: "" });
    fake.remote.push({ id: "new", filename: "new.txt", mimeType: "text/plain", size: 6, contentUrl: "https://jira.example/content/new", created: "" });

    const result = await syncJiraAttachments(handle.db, client, item, storage);

    expect(result.added).toBe(1);
    expect(getAttachment(handle.db, old.id)).toMatchObject({ commentId: note.id, jiraAttachmentId: "old" });
    expect(listItemAttachments(handle.db, item.id).map((file) => file.jiraAttachmentId)).toEqual(["new"]);
    expect(listCommentsForItem(handle.db, item.id)).toHaveLength(1);

    // A deletion in Jira still reaches it on its comment.
    fake.remote = fake.remote.filter((entry) => entry.id !== "old");
    expect((await syncJiraAttachments(handle.db, client, item, storage)).removed).toBe(1);
    expect(getAttachment(handle.db, old.id)).toBeUndefined();
    expect(listItemAttachments(handle.db, item.id)).toHaveLength(1);
  });

  /**
   * Organisation mode. The record owns the item's tracker (`recordRole.ts`),
   * so a file a desktop puts on or takes off reaches Jira from the record
   * when the record accepts the command — and from nowhere else.
   */
  function onTheRecord() {
    const serving: ServeRecordContext = { db: handle.db, record: createLocalRecord(handle.db), attachments: storage, offerWork: async () => [] };
    const person = createPerson(handle.db, { name: "Anna", email: "anna@example.com" });
    const deviceId = issueDevice(handle.db, { personId: person.id, name: "anna-laptop", tokenHash: "hash-of-anna", secretsKeyHash: null }).id;
    return {
      put: (itemId: string, attachmentId: string) =>
        serveApply(serving, {
          deviceId,
          commands: [{ kind: "attachment", id: uuidv7(), itemId, commentId: null, attachmentId, name: "mock.png", mimeType: "image/png", size: 5, dataBase64: Buffer.from("hello").toString("base64") }],
        }),
      take: (itemId: string, attachmentId: string) =>
        serveApply(serving, {
          deviceId,
          commands: [{ kind: "attachmentRemoval", id: uuidv7(), itemId, attachmentId, name: "mock.png", mimeType: "image/png" }],
        }),
    };
  }

  it("uploads an item file a desktop sends the record, and the record's pull does not import it again", async () => {
    const { item, fake, client, drain } = mirrored("API-25");
    const record = onTheRecord();
    const fileId = uuidv7();

    expect((await record.put(item.id, fileId)).results[0]).toMatchObject({ applied: true });
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toMatchObject([{ kind: "attachment_upload", payload: { attachmentId: fileId } }]);
    // A replayed queue is one file and one upload.
    await record.put(item.id, fileId);
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toHaveLength(1);

    await drain(Date.now());
    expect(fake.uploads).toEqual(["uploaded-1"]);
    expect(getAttachment(handle.db, fileId as Uuid)).toMatchObject({ commentId: null, jiraAttachmentId: "uploaded-1" });
    expect((await syncJiraAttachments(handle.db, client, item, storage)).added).toBe(0);
    expect(listItemAttachments(handle.db, item.id)).toHaveLength(1);
  });

  it("deletes in Jira an item file a desktop took off, with the pending deletion keeping the record's pull from bringing it back", async () => {
    const { item, fake, client, drain } = mirrored("API-26");
    const record = onTheRecord();
    const fileId = uuidv7();
    await record.put(item.id, fileId);
    await drain(Date.now());
    expect(getAttachment(handle.db, fileId as Uuid)?.jiraAttachmentId).toBe("uploaded-1");

    expect((await record.take(item.id, fileId)).results[0]).toMatchObject({ applied: true });
    expect(getAttachment(handle.db, fileId as Uuid)).toBeUndefined();
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toMatchObject([{ kind: "attachment_delete", payload: { jiraAttachmentId: "uploaded-1" } }]);

    // Jira still lists it until the outbox drains: the tombstone holds.
    expect(fake.remote.map((entry) => entry.id)).toEqual(["uploaded-1"]);
    expect((await syncJiraAttachments(handle.db, client, item, storage)).added).toBe(0);
    expect(listItemAttachments(handle.db, item.id)).toEqual([]);

    await drain(Date.now() + 1);
    expect(fake.deletes).toEqual(["uploaded-1"]);
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
  });

  it("leaves Jira to the record on a replica: no deletion queued, and no reconciliation of its own", async () => {
    const { item, fake, client } = mirrored("API-27");
    const stored = await storage.storeImported({ name: "spec.txt", mimeType: "text/plain", data: new TextEncoder().encode("hello") });
    insertAttachments(handle.db, [{ ...stored, itemId: item.id, commentId: null, jiraAttachmentId: "linked" }]);
    fake.remote.push({ id: "elsewhere", filename: "new.txt", mimeType: "text/plain", size: 6, contentUrl: "https://jira.example/content/elsewhere", created: "" });
    const release = markReplica(handle.db, () => true);
    try {
      // The record's own upload, seen from a replica that holds no link
      // for it, would otherwise come back as a new file and go up again.
      expect(await syncJiraAttachments(handle.db, client, item, storage)).toMatchObject({ added: 0, removed: 0 });
      expect(listItemAttachments(handle.db, item.id).map((file) => file.jiraAttachmentId)).toEqual(["linked"]);
      expect(removeItemAttachment(handle.db, stored.id)).toBeDefined();
    } finally {
      release();
    }
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
  });

  it("queues no upload for an item file added on a replica, whose files reach Jira from the record", async () => {
    const { item } = mirrored("API-24");
    const stored = await storage.storeImported({ name: "spec.txt", mimeType: "text/plain", data: new TextEncoder().encode("hello") });
    const release = markReplica(handle.db, () => true);
    try {
      expect(addItemAttachments(handle.db, item.id, [stored])).toHaveLength(1);
    } finally {
      release();
    }
    expect(pendingPushesForItem(handle.db, item.id, "jira")).toEqual([]);
  });
});
