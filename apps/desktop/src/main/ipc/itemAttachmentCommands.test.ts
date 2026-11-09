import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcContract, type Item, type Uuid } from "@eo/core";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "../attachments/storage.js";
import type { DbHandle } from "../db/client.js";
import { getAttachment, listAttachmentsForItem, listCommentsForItem, listItemAttachments, postComment } from "../db/repos/index.js";
import { attachmentWasRemoved } from "../db/repos/attachmentsRepo.js";
import { createTestItem, openMigratedTestDb } from "../db/testHelpers.js";
import { onItemAttachmentsChanged } from "../db/itemAttachmentEvents.js";
import { deleteAttachmentCommand, pickAttachmentsCommand } from "./attachmentCommands.js";
import { handleIpcRequest } from "./handleRequest.js";
import { getItemDetail } from "./domainQueries.js";
import { addItemAttachmentsCommand, removeItemAttachmentCommand } from "./itemAttachmentCommands.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An item's own files, put on it and taken off it (EO-702). */
describe("item attachments", () => {
  let directory: string;
  let handle: DbHandle;
  let storage: AttachmentStorage;
  let item: Item;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "eo item attachments "));
    storage = new AttachmentStorage(join(directory, "managed"));
    handle = openMigratedTestDb();
    item = createTestItem(handle.db, { type: "story", title: "Built against a mock", stepId: "todo" });
  });

  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function stage(name: string, data: Buffer = Buffer.from(name)): Promise<string> {
    return (await storage.stageData({ name, dataBase64: data.toString("base64") })).id;
  }

  it("puts staged files on the item, with main's MIME type and size, and on no comment", async () => {
    const said = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "A comment with nothing on it." });
    // Named .txt, but main reads the bytes: it is a PNG.
    const ids = [await stage("mock.txt", PNG), await stage("spec.md")];

    const result = await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: ids });

    expect(result.problem).toBeNull();
    expect(result.attachments.map((file) => [file.name, file.kind, file.mimeType, file.size, file.commentId])).toEqual([
      ["mock.txt", "image", "image/png", 8, null],
      ["spec.md", "file", "text/markdown", 7, null],
    ]);
    expect(listItemAttachments(handle.db, item.id).map((file) => file.id)).toEqual(ids);
    expect(listItemAttachments(handle.db, item.id).every((file) => existsSync(file.path))).toBe(true);
    // The item page draws them beside the description…
    expect(getItemDetail(handle.db, { itemId: item.id })?.item.attachments.map((file) => file.name)).toEqual(["mock.txt", "spec.md"]);
    // …and the thread does not: they are not anything anybody said.
    expect(listCommentsForItem(handle.db, item.id).map((comment) => [comment.id, comment.attachments])).toEqual([[said.id, []]]);
  });

  it("lists only the item's own files there, leaving a comment's on its comment", async () => {
    const draft = await stage("said.txt");
    const records = await storage.prepare([draft]);
    const comment = postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Here.", attachmentRecords: records });
    await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: [await stage("own.txt")] });

    expect(listItemAttachments(handle.db, item.id).map((file) => file.name)).toEqual(["own.txt"]);
    expect(listAttachmentsForItem(handle.db, item.id).map((file) => file.name).sort()).toEqual(["own.txt", "said.txt"]);
    expect(getItemDetail(handle.db, { itemId: item.id })?.item.attachments.map((file) => file.name)).toEqual(["own.txt"]);
    expect(listCommentsForItem(handle.db, item.id).find((entry) => entry.id === comment.id)?.attachments?.map((file) => file.name)).toEqual(["said.txt"]);
  });

  it("refuses more than eight in one go and a file over 20 MB, in a comment's sentences", async () => {
    const nine = await Promise.all(Array.from({ length: 9 }, (_unused, index) => stage(`f${index}.txt`)));
    // The contract refuses a ninth as it refuses one on a comment…
    expect(ipcContract["items:addAttachments"].request.safeParse({ itemId: item.id, attachmentIds: nine }).success).toBe(false);
    expect(ipcContract["items:addAttachments"].request.safeParse({ itemId: item.id, attachmentIds: nine.slice(0, 8) }).success).toBe(true);
    // …and so does main, whoever reaches it.
    const tooMany = await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: nine });
    expect(tooMany).toEqual({ attachments: [], problem: "A submission can contain at most 8 attachments." });

    await expect(storage.stageData({ name: "huge.bin", dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64") })).rejects.toThrow(
      "huge.bin is larger than the 20 MB attachment limit.",
    );
    expect(listItemAttachments(handle.db, item.id)).toEqual([]);
  });

  it("says which picked file is over 20 MB even where a thrown error would read 'Internal error'", async () => {
    const huge = join(directory, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_ATTACHMENT_BYTES + 1);
    const small = join(directory, "small.txt");
    writeFileSync(small, "fine");

    // Through the envelope every door uses, as a packaged build sets it.
    const answer = await handleIpcRequest("attachments:pick", undefined, () => pickAttachmentsCommand(async () => [small, huge], storage), {
      exposeErrorDetails: false,
    });

    expect(answer).toEqual({ ok: true, data: { attachments: [], omitted: 0, problem: "huge.bin is larger than the 20 MB attachment limit." } });
    // And it staged none of them, as a refused comment batch stages none.
    expect(existsSync(join(directory, "managed", "staging")) ? readdirSync(join(directory, "managed", "staging")) : []).toEqual([]);
  });

  it("says so rather than throwing when a draft is no longer staged", async () => {
    const id = await stage("gone.txt");
    await storage.discard(id);

    const result = await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: [id] });

    expect(result).toEqual({ attachments: [], problem: `Attachment ${id} is no longer staged.` });
  });

  it("removes one: its row and its stored bytes, noted for the record", async () => {
    const [added] = (await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: [await stage("mock.png", PNG)] })).attachments;
    const path = getAttachment(handle.db, added!.id as Uuid)!.path;
    const removed: string[] = [];
    const stop = onItemAttachmentsChanged(handle.db, { removed: (file) => void removed.push(file.id) });

    const result = await removeItemAttachmentCommand(handle.db, storage, { attachmentId: added!.id });
    stop();

    expect(result).toEqual({ removed: true, problem: null });
    expect(getAttachment(handle.db, added!.id as Uuid)).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(attachmentWasRemoved(handle.db, added!.id as Uuid)).toBe(true);
    expect(removed).toEqual([added!.id]);
    // Removing it twice is nothing, said as nothing.
    expect(await removeItemAttachmentCommand(handle.db, storage, { attachmentId: added!.id })).toEqual({ removed: false, problem: null });
  });

  it("will not remove a comment's file from here", async () => {
    const records = await storage.prepare([await stage("said.txt")]);
    postComment(handle.db, { itemId: item.id, author: { type: "human" }, body: "Here.", attachmentRecords: records });
    await storage.finish(records);
    const id = records[0]!.id;

    const result = await removeItemAttachmentCommand(handle.db, storage, { attachmentId: id });

    expect(result).toEqual({ removed: false, problem: "said.txt is on a comment, and goes only with that comment." });
    expect(getAttachment(handle.db, id)).toBeDefined();
    expect(existsSync(records[0]!.storagePath)).toBe(true);
  });

  it("removes an item file the record's way when it is deleted through the generic delete too", async () => {
    const [added] = (await addItemAttachmentsCommand(handle.db, storage, { itemId: item.id, attachmentIds: [await stage("spec.md")] })).attachments;

    expect(await deleteAttachmentCommand(handle.db, storage, { attachmentId: added!.id })).toEqual({ deleted: true, problem: null });
    expect(attachmentWasRemoved(handle.db, added!.id as Uuid)).toBe(true);
  });

  it("answers a missing item with a sentence", async () => {
    const result = await addItemAttachmentsCommand(handle.db, storage, { itemId: "019fb8c6-de92-7a41-9c33-4471f0c2b1ff", attachmentIds: [await stage("x.txt")] });
    expect(result).toEqual({ attachments: [], problem: "That item no longer exists." });
  });
});
