import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@eo/core";
import { openDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { getAttachment, getComment, postComment } from "../db/repos/index.js";
import { deleteAttachmentCommand } from "../ipc/attachmentCommands.js";
import { AttachmentStorage, MAX_ATTACHMENT_BYTES } from "./storage.js";

import { createTestItem } from "../db/testHelpers.js";
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

describe("durable attachment storage", () => {
  let directory = "";
  let handle: DbHandle | undefined;

  afterEach(() => {
    handle?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("stages a file far larger than a regex can be run over", async () => {
    directory = mkdtempSync(join(tmpdir(), "eo attachments "));
    const storage = new AttachmentStorage(join(directory, "managed"));
    // Every other test here stages eight bytes, which is why the
    // validator could recurse through four million repetitions of a
    // group and nobody knew. Four megabytes is past where V8's regex
    // engine ran out of stack; the limit itself is 20 MB, and what this
    // asserts is that the size somebody actually attaches goes through.
    const bytes = Buffer.alloc(4 * 1024 * 1024, 7);

    const draft = await storage.stageData({ name: "big.bin", dataBase64: bytes.toString("base64") });

    expect(draft).toMatchObject({ kind: "file", size: bytes.byteLength, name: "big.bin" });
  });

  it("still refuses data that is not base64, however long", async () => {
    directory = mkdtempSync(join(tmpdir(), "eo attachments "));
    const storage = new AttachmentStorage(join(directory, "managed"));

    // The conditions the old regex stated, each one still refused: a
    // length off a multiple of four, a character outside the alphabet,
    // padding that is not at the end, and more padding than base64 has.
    for (const invalid of ["AAAAA", "AAAA=", "AA*A", "=AAA", "AA=A", "A===", `${"A".repeat(4 * 1024 * 1024)}*`]) {
      await expect(storage.stageData({ name: "x.bin", dataBase64: invalid }), invalid).rejects.toThrow("not valid base64");
    }

    // And what it accepted is still accepted: both paddings, and none.
    for (const valid of ["", "AAAA", "AAA=", "AA=="]) {
      await expect(storage.stageData({ name: "x.bin", dataBase64: valid }), valid).resolves.toBeTruthy();
    }
  });

  it("persists a UUIDv7 and verified metadata across a database restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "eo attachments "));
    const database = join(directory, "eo.db");
    const storage = new AttachmentStorage(join(directory, "managed"));
    const draft = await storage.stageData({
      // Deliberately misleading: main derives image/png from the bytes,
      // not a renderer-provided MIME field or filename extension.
      name: "pasted.txt",
      dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
    });
    expect(draft).toMatchObject({ kind: "image", mimeType: "image/png", size: 8, name: "pasted.txt" });
    expect(draft.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    handle = openDb(database);
    runMigrations(handle.db, migrations);
    const item = createTestItem(handle.db, { type: "story", title: "Has a file", stepId: "todo" });
    const commentId = uuidv7();
    const prepared = await storage.prepare([draft.id]);
    postComment(handle.db, { id: commentId, itemId: item.id, author: { type: "human" }, body: "", attachmentRecords: prepared });
    await storage.finish(prepared);
    const managedPath = getAttachment(handle.db, prepared[0]!.id)?.path;
    expect(managedPath && existsSync(managedPath)).toBe(true);

    handle.close();
    handle = openDb(database);
    runMigrations(handle.db, migrations);
    expect(getComment(handle.db, commentId)?.attachments).toEqual([
      expect.objectContaining({ id: draft.id, itemId: item.id, commentId, name: "pasted.txt", mimeType: "image/png", size: 8 }),
    ]);

    expect((await deleteAttachmentCommand(handle.db, storage, { attachmentId: draft.id })).deleted).toBe(true);
    expect(getComment(handle.db, commentId)).toBeDefined();
    expect(getComment(handle.db, commentId)?.attachments).toEqual([]);
    expect(existsSync(managedPath!)).toBe(false);
  });

  it("rejects oversized files and more than eight IDs in main-process code", async () => {
    directory = mkdtempSync(join(tmpdir(), "eo attachment limits "));
    const storage = new AttachmentStorage(join(directory, "managed"));
    const oversized = join(directory, "too-big.bin");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_ATTACHMENT_BYTES + 1);

    await expect(storage.stagePaths([oversized])).rejects.toThrow("20 MB");
    await expect(storage.prepare(Array.from({ length: 9 }, () => uuidv7()))).rejects.toThrow("at most 8");
  });
});
