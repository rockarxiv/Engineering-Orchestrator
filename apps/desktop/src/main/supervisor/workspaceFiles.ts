import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import type { FileArtifact } from "./workspaceKind.js";

/**
 * A file a run left behind, as the kinds with a disk describe one
 * (EO-299).
 *
 * Shared by `folder` and `scratch` because they ask the same two
 * questions of a directory — what is in it, and what of that is this
 * run's doing — and answering them twice would be two answers to drift
 * apart. The git kind asks neither: what a branch produced is a diff,
 * which git already knows how to compute.
 */
export interface WorkspaceFile {
  /** Where it is, relative to the directory that was walked. Forward slashes on every platform, because it is shown to a person. */
  relativePath: string;
  absolutePath: string;
  /** Epoch milliseconds, as the filesystem has it. */
  modifiedAt: number;
  sizeBytes: number;
}

/**
 * Extension to media type, for the files a report is made of.
 *
 * Deliberately short and deliberately not sniffed. `attachments/storage.ts`
 * reads the first bytes of a file to tell a PNG from a JPEG, which is
 * right for an untrusted upload from Jira and wrong here: these are
 * files EO's own agent just wrote, there may be a great many of them,
 * and opening every one to label it would be a read of the whole
 * directory to decide what to call it.
 *
 * `application/octet-stream` for anything unlisted, which is what an
 * attachment with no better answer already carries.
 */
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".log": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

export function mediaTypeFor(name: string): string {
  return MEDIA_TYPE_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * How far a file's recorded time may lag the clock EO reads (EO-299).
 *
 * Not a fudge factor: file timestamps and `Date.now()` come from
 * different clocks. Linux stamps an inode from the *coarse* realtime
 * clock, which is updated once a tick — so a file written a
 * millisecond after EO recorded the run's start time can carry an
 * mtime a millisecond before it, and the check would fail a run that
 * had just done exactly what it was asked. Other filesystems are
 * coarser still: HFS+ keeps whole seconds and FAT keeps two.
 *
 * Two seconds costs nothing the check is for. What it exists to catch
 * is last quarter's report sitting in a shared folder, which is days or
 * months stale — never two seconds — and a run takes minutes, so a file
 * genuinely written by it is never near this edge.
 */
export const FILESYSTEM_CLOCK_GRACE_MS = 2_000;

/**
 * Every file under a directory, optionally only the ones touched since
 * a moment (EO-299).
 *
 * **Symbolic links are listed as nothing.** A shared drive is somebody
 * else's directory, and a link in one can point at a loop, at a home
 * directory or at `/etc`; following one would mean EO posting a file
 * nobody put in the workspace as though the run had produced it. A link
 * is therefore neither followed nor reported, which is the same
 * decision `borrowedFromSiblings` makes about a worktree.
 *
 * A directory it cannot read is skipped rather than fatal: half an
 * answer about what a run produced is worth more than none, and the
 * checks that matter — the outputs a step *declared* — are read by name
 * rather than from this list.
 */
export async function filesUnder(root: string, options: { since?: number } = {}): Promise<WorkspaceFile[]> {
  const found: WorkspaceFile[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let stats;
      try {
        stats = await stat(absolutePath);
      } catch {
        continue;
      }
      if (options.since !== undefined && stats.mtimeMs < options.since - FILESYSTEM_CLOCK_GRACE_MS) continue;
      found.push({
        relativePath: relative(root, absolutePath).split(sep).join("/"),
        absolutePath,
        modifiedAt: stats.mtimeMs,
        sizeBytes: stats.size,
      });
    }
  };

  await walk(root);
  return found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** Those files as the artifacts a run produced — what EO-298's output comment hangs its attachments off. */
export function fileArtifacts(files: readonly WorkspaceFile[]): FileArtifact[] {
  return files.map((file) => ({
    kind: "file",
    name: file.relativePath,
    mediaType: mediaTypeFor(file.relativePath),
    path: file.absolutePath,
  }));
}

/**
 * Where a relative path declared on a step actually lands, or null if it
 * lands outside the workspace (EO-299).
 *
 * A step's declared outputs are configuration a person typed, and
 * `../../../etc/passwd` is a path that exists, has changed recently and
 * would pass a check that only asked those two questions. What the
 * check is *for* is "did this run produce what this step says it
 * produces", and a file outside the directory the run worked in is not
 * something the run produced.
 *
 * Absolute paths are refused for the same reason and by the same rule:
 * `resolve` returns them unchanged, so they fail the containment test
 * unless they were already inside the workspace, which is a spelling of
 * the same declaration rather than an escape.
 */
export function resolveWithin(root: string, relativePath: string): string | null {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}
