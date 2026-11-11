import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client.js";
import { listRetiredAttachmentFiles } from "../db/repos/index.js";
import { retiredAttachmentFiles } from "../db/schema.js";
import { openMigratedTestDb } from "../db/testHelpers.js";
import { removeRetiredAttachmentFiles } from "./retiredFiles.js";
import { AttachmentStorage } from "./storage.js";

/** The bytes of the files migration 0168 deleted with the threads, removed at launch (EO-730). */
let handle: DbHandle;
let directory: string;

beforeEach(() => {
  handle = openMigratedTestDb();
  directory = mkdtempSync(join(tmpdir(), "eo-retired-files-"));
});

afterEach(() => {
  handle.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("removing the files of the retired threads", () => {
  it("removes each file and forgets its path, and finds nothing on the next launch", async () => {
    const storage = new AttachmentStorage(join(directory, "managed"));
    mkdirSync(join(directory, "managed", "a"), { recursive: true });
    const file = join(directory, "managed", "a", "notes.txt");
    writeFileSync(file, "notes");
    const gone = join(directory, "managed", "b", "already-gone.txt");
    handle.db.insert(retiredAttachmentFiles).values([{ path: file }, { path: gone }]).run();

    await expect(removeRetiredAttachmentFiles(handle.db, storage)).resolves.toBe(2);

    expect(existsSync(file)).toBe(false);
    expect(listRetiredAttachmentFiles(handle.db)).toEqual([]);
    await expect(removeRetiredAttachmentFiles(handle.db, storage)).resolves.toBe(0);
  });
});
