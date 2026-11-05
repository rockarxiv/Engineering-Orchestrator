import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { uuidv7, type AttachmentDraft, type Uuid } from "@eo/core";
import type { CreateAttachmentRecord, AttachmentRecord } from "../db/repos/index.js";

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".log": "text/plain",
};

interface StagedMetadata extends AttachmentDraft {
  stagedAt: number;
}

function mimeTypeFor(name: string, data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function safeDisplayName(name: string): string {
  // Jira filenames are untrusted remote input. Treat Windows separators
  // as separators on every platform and remove control characters before
  // the name is ever persisted or shown.
  const leaf = basename(name.replace(/\\/g, "/"));
  return Array.from(leaf).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }).join("").trim() || "attachment";
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s/g, "");
  if (!isBase64(compact)) throw new Error("The attachment data is not valid base64.");
  return Buffer.from(compact, "base64");
}

/**
 * The same rule the regex here used to state, checked in one pass.
 *
 * It was `/^(?:[A-Za-z0-9+/]{4})*(?:..==|...=)?$/`, and it could not be
 * run on a real attachment: V8 recurses through `(?:X{4})*`, so anything
 * over about three megabytes threw `RangeError: Maximum call stack size
 * exceeded` — which `handleIpcRequest` turns into "Internal error",
 * because a thrown handler is a programmer error and a packaged build
 * does not send details. Dropping a 4 MB image into the composer has
 * therefore failed on the desktop with an unexplained sentence for as
 * long as this path has existed; every test of it used an eight-byte
 * PNG header.
 *
 * Found from the server, which is where a 20 MB `dataBase64` first had
 * to survive an end-to-end journey (EO-319). Fixed here rather than
 * worked around there, because the limit was never the transport's.
 *
 * The three conditions are the regex's, unchanged: a length that is a
 * multiple of four, up to two `=` of padding and only at the end, and
 * nothing outside the base64 alphabet before it. A negated character
 * class cannot backtrack, so this is linear in the length and recurses
 * not at all.
 */
function isBase64(compact: string): boolean {
  if (compact.length % 4 !== 0) return false;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return !/[^A-Za-z0-9+/]/.test(compact.slice(0, compact.length - padding));
}

/** Owns staging and final paths. Renderer submissions carry IDs only. */
export class AttachmentStorage {
  constructor(private readonly root: string) {}

  private stagingPath(id: string): string { return join(this.root, "staging", `${id}.bin`); }
  private metadataPath(id: string): string { return join(this.root, "staging", `${id}.json`); }
  private finalPath(id: string, name: string): string {
    const extension = extname(name).slice(0, 20).replace(/[^a-zA-Z0-9.]/g, "");
    return join(this.root, "files", `${id}${extension}`);
  }

  private assertId(id: string): asserts id is Uuid {
    if (!UUID_PATTERN.test(id)) throw new Error(`Unknown attachment ${id}.`);
  }

  private async writeStage(name: string, data: Buffer): Promise<AttachmentDraft> {
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${safeDisplayName(name)} is larger than the 20 MB attachment limit.`);
    const id = uuidv7();
    const displayName = safeDisplayName(name);
    const mimeType = mimeTypeFor(displayName, data);
    const metadata: StagedMetadata = {
      id,
      name: displayName,
      mimeType,
      size: data.byteLength,
      kind: mimeType.startsWith("image/") ? "image" : "file",
      stagedAt: Date.now(),
    };
    await mkdir(join(this.root, "staging"), { recursive: true });
    await writeFile(this.stagingPath(id), data, { flag: "wx" });
    try {
      await writeFile(this.metadataPath(id), JSON.stringify(metadata), { flag: "wx" });
    } catch (error) {
      await rm(this.stagingPath(id), { force: true });
      throw error;
    }
    return metadata;
  }

  async stageData(input: { name: string; dataBase64: string }): Promise<AttachmentDraft> {
    return this.writeStage(input.name, decodeBase64(input.dataBase64));
  }

  async stagePaths(paths: string[]): Promise<AttachmentDraft[]> {
    if (paths.length > MAX_ATTACHMENT_COUNT) throw new Error("A submission can contain at most 8 attachments.");
    const staged: AttachmentDraft[] = [];
    try {
      for (const sourcePath of paths) {
        const info = await stat(sourcePath);
        const name = safeDisplayName(sourcePath);
        if (!info.isFile()) throw new Error(`${name} is not a file.`);
        if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than the 20 MB attachment limit.`);
        staged.push(await this.writeStage(name, await readFile(sourcePath)));
      }
      return staged;
    } catch (error) {
      await Promise.all(staged.map((attachment) => this.discard(attachment.id)));
      throw error;
    }
  }

  private async readMetadata(id: string): Promise<StagedMetadata> {
    this.assertId(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.metadataPath(id), "utf8"));
    } catch {
      throw new Error(`Attachment ${id} is no longer staged.`);
    }
    if (!parsed || typeof parsed !== "object") throw new Error(`Attachment ${id} has invalid staged metadata.`);
    const metadata = parsed as Partial<StagedMetadata>;
    if (metadata.id !== id || typeof metadata.name !== "string" || typeof metadata.mimeType !== "string" || typeof metadata.size !== "number") {
      throw new Error(`Attachment ${id} has invalid staged metadata.`);
    }
    return metadata as StagedMetadata;
  }

  async prepare(ids: string[]): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">[]> {
    if (ids.length > MAX_ATTACHMENT_COUNT) throw new Error("A submission can contain at most 8 attachments.");
    if (new Set(ids).size !== ids.length) throw new Error("The same attachment cannot be submitted twice.");
    await mkdir(join(this.root, "files"), { recursive: true });
    const prepared: Omit<CreateAttachmentRecord, "itemId" | "commentId">[] = [];
    try {
      for (const id of ids) {
        const metadata = await this.readMetadata(id);
        const info = await stat(this.stagingPath(id));
        if (!info.isFile() || info.size !== metadata.size || info.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(`${metadata.name} failed attachment validation.`);
        }
        const path = this.finalPath(id, metadata.name);
        await copyFile(this.stagingPath(id), path, constants.COPYFILE_EXCL);
        prepared.push({ id: id as Uuid, storagePath: path, name: metadata.name, mimeType: metadata.mimeType, size: info.size, managed: true, createdAt: Date.now() });
      }
      return prepared;
    } catch (error) {
      await this.rollback(prepared);
      throw error;
    }
  }

  async finish(records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): Promise<void> {
    await Promise.all(records.flatMap((record) => [rm(this.stagingPath(record.id), { force: true }), rm(this.metadataPath(record.id), { force: true })]));
  }

  async rollback(records: Omit<CreateAttachmentRecord, "itemId" | "commentId">[]): Promise<void> {
    await Promise.all(records.map((record) => rm(record.storagePath, { force: true })));
  }

  /**
   * Atomically promotes bytes downloaded from Jira into managed storage.
   * The database only receives the returned record after the final rename,
   * so an interrupted write can leave neither a readable row nor a partial
   * file at the path that row would expose.
   */
  /**
   * The bytes of a file this installation holds, or null (EO-324).
   *
   * Null rather than a throw for a file that is not there, because the
   * one caller is the record answering a device that asked for an
   * attachment it knows about — and "the row is here and the bytes are
   * not" is a real state (a desktop that queued the comment and was
   * updated before it sent the file). The honest answer is "there is
   * nothing here", so the asking stops.
   */
  async read(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path);
    } catch {
      return null;
    }
  }

  async storeImported(input: { name: string; mimeType?: string; data: Uint8Array }): Promise<Omit<CreateAttachmentRecord, "itemId" | "commentId">> {
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${safeDisplayName(input.name)} is larger than the 20 MB attachment limit.`);
    const id = uuidv7();
    const name = safeDisplayName(input.name);
    const data = Buffer.from(input.data);
    const mimeType = input.mimeType?.trim() || mimeTypeFor(name, data);
    const path = this.finalPath(id, name);
    const partial = `${path}.part`;
    await mkdir(join(this.root, "files"), { recursive: true });
    try {
      await writeFile(partial, data, { flag: "wx" });
      const info = await stat(partial);
      if (!info.isFile() || info.size !== data.byteLength || info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} failed attachment validation.`);
      await rename(partial, path);
      return { id, storagePath: path, name, mimeType, size: info.size, managed: true, createdAt: Date.now() };
    } catch (error) {
      await Promise.all([rm(partial, { force: true }), rm(path, { force: true })]);
      throw error;
    }
  }

  async discard(id: string): Promise<boolean> {
    this.assertId(id);
    const existed = await stat(this.metadataPath(id)).then(() => true, () => false);
    await Promise.all([rm(this.stagingPath(id), { force: true }), rm(this.metadataPath(id), { force: true })]);
    return existed;
  }

  async removeManaged(attachment: Pick<AttachmentRecord, "managed" | "path">): Promise<void> {
    if (attachment.managed) await rm(attachment.path, { force: true });
  }
}
