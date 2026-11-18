import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { uuidv7, type EvidenceSourceRef } from "@eo/core";
import { listedEvidence, sha256, type EvidenceCaptureOutcome, type EvidenceEntry, type EvidenceResult, type WorkspaceEvidenceCapability } from "./teamEvidence.js";

/**
 * A folder's evidence for a report-only team (EO-845): a copy EO keeps,
 * named by the SHA-256 of its manifest — every file's path, size and
 * SHA-256 — so what a participant reads is what was captured, whatever
 * happens in the folder meanwhile, and a baseline names content rather
 * than a place.
 *
 * - **Consistent, or refused.** A file that changes while it is copied
 *   (its size or modification time moved between the look before and the
 *   one after) makes the whole capture start again once; a folder that is
 *   still changing the second time is refused, saying so, rather than
 *   handed over half old and half new.
 * - **Bounded.** More files or bytes than a team should be copying is
 *   refused with the figures, not truncated.
 * - **No link followed.** A symbolic link is listed as one and its
 *   target is never read or copied; nor is anything that is not a
 *   regular file or a directory.
 * - **Read back by content.** Every read is opened without following a
 *   link, inside the copy's own real path, and its bytes checked against
 *   the manifest's hash, so a copy changed after capture is refused
 *   rather than read.
 */

export function defaultTeamEvidenceRoot(): string {
  return join(homedir(), ".eo", "team-evidence");
}

/** The most files one folder capture copies. */
export const FOLDER_EVIDENCE_MAX_FILES = 5000;
/** The most bytes one folder capture copies. */
export const FOLDER_EVIDENCE_MAX_BYTES = 200 * 1024 * 1024;

const MANIFEST = "manifest.json";
const FILES = "files";

interface ManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  sha256: string | null;
}

/** The capability the folder kind lends, keeping its copies under `root`. */
export function folderEvidenceCapability(root: string = defaultTeamEvidenceRoot(), limits = { files: FOLDER_EVIDENCE_MAX_FILES, bytes: FOLDER_EVIDENCE_MAX_BYTES }): WorkspaceEvidenceCapability {
  return {
    async capture(_item, workspace) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const captured = await captureOnce(root, workspace.cwd, limits);
        if (captured !== "changed") return captured;
      }
      return { ok: false, problem: `Files in \`${workspace.cwd}\` kept changing while EO copied them, so EO did not capture it for the team: a team is handed one consistent copy or none.` };
    },
    async open(_item, _workspace, source) {
      if (source.kind !== "folder") return { ok: false, problem: "That evidence was not captured from a folder." };
      return openCopy(root, source);
    },
  };
}

async function captureOnce(root: string, cwd: string, limits: { files: number; bytes: number }): Promise<EvidenceCaptureOutcome | "changed"> {
  const entries: ManifestEntry[] = [];
  const staging = join(root, `.partial-${uuidv7()}`);
  let bytes = 0;
  let files = 0;
  try {
    await mkdir(join(staging, FILES), { recursive: true });
    const walk = async (relative: string): Promise<EvidenceResult<"done"> | "changed"> => {
      let names: string[];
      try {
        names = (await readdir(join(cwd, relative))).sort();
      } catch (error) {
        return { ok: false, problem: `EO could not read \`${join(cwd, relative)}\`: ${message(error)}` };
      }
      for (const name of names) {
        const path = relative === "" ? name : `${relative}/${name}`;
        const absolute = join(cwd, path);
        const before = await lstat(absolute).catch(() => null);
        if (before === null) return "changed";
        if (before.isSymbolicLink()) {
          entries.push({ path, type: "symlink", size: 0, sha256: null });
          continue;
        }
        if (before.isDirectory()) {
          entries.push({ path, type: "directory", size: 0, sha256: null });
          await mkdir(join(staging, FILES, path), { recursive: true });
          const inner = await walk(path);
          if (inner !== "changed" && inner.ok) continue;
          return inner;
        }
        if (!before.isFile()) continue;
        files += 1;
        bytes += before.size;
        if (files > limits.files || bytes > limits.bytes) {
          return { ok: false, problem: `\`${cwd}\` holds more than ${String(limits.files)} files or ${String(Math.round(limits.bytes / 1024 / 1024))} MB, more than EO copies for a team; point the step at a smaller folder.` };
        }
        let content: Buffer;
        try {
          const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            content = await handle.readFile();
            const after = await handle.stat();
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || content.length !== before.size) return "changed";
          } finally {
            await handle.close();
          }
        } catch (error) {
          return { ok: false, problem: `EO could not read \`${absolute}\`: ${message(error)}` };
        }
        await writeFile(join(staging, FILES, path), content, { flag: "wx" });
        entries.push({ path, type: "file", size: content.length, sha256: sha256(content) });
      }
      return { ok: true, value: "done" };
    };
    const walked = await walk("");
    if (walked === "changed") return "changed";
    if (!walked.ok) return walked;
    const manifest = JSON.stringify(entries);
    const id = sha256(manifest);
    await writeFile(join(staging, MANIFEST), manifest, { flag: "wx" });
    const final = join(root, id);
    const existing = await lstat(final).catch(() => null);
    if (existing === null) await rename(staging, final);
    const source: EvidenceSourceRef = { kind: "folder", manifest: id, files, bytes };
    return openCopy(root, source);
  } catch (error) {
    return { ok: false, problem: `EO could not copy \`${cwd}\` for the team: ${message(error)}` };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * A kept copy, opened: refused unless the copy is still a real directory
 * at its own path whose manifest hashes to the name it was captured as.
 */
async function openCopy(root: string, source: Extract<EvidenceSourceRef, { kind: "folder" }>): Promise<EvidenceCaptureOutcome> {
  const directory = join(root, source.manifest);
  const gone = { ok: false as const, problem: "The copy EO kept of that folder is gone or no longer what it captured, so it cannot be read." };
  const stat = await lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory()) return gone;
  const real = await realpath(directory).catch(() => null);
  if (real === null) return gone;
  let manifest: string;
  try {
    manifest = await readFile(join(real, MANIFEST), "utf8");
  } catch {
    return gone;
  }
  if (sha256(manifest) !== source.manifest) return gone;
  let parsed: ManifestEntry[];
  try {
    parsed = JSON.parse(manifest) as ManifestEntry[];
  } catch {
    return gone;
  }
  const hashes = new Map(parsed.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.sha256]));
  const entries: EvidenceEntry[] = parsed.map((entry) => ({ path: entry.path, type: entry.type, size: entry.size }));
  const filesRoot = join(real, FILES);
  return {
    ok: true,
    evidence: listedEvidence(source, entries, async (entry) => {
      const unread = { ok: false as const, problem: `EO's copy of \`${entry.path}\` is no longer what it captured, so it is not read.` };
      const target = join(filesRoot, ...entry.path.split("/"));
      const parent = await realpath(dirname(target)).catch(() => null);
      if (parent === null || (parent !== filesRoot && !parent.startsWith(filesRoot + sep))) return unread;
      try {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const content = await handle.readFile();
          return sha256(content) === hashes.get(entry.path) ? { ok: true, value: content } : unread;
        } finally {
          await handle.close();
        }
      } catch {
        return unread;
      }
    }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
