import { constants, type BigIntStats } from "node:fs";
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
 * - **One consistent moment, or refused.** The folder is walked twice:
 *   once to copy it, then once more to check it, every directory listed
 *   again and every file read and hashed again. Each entry's identity
 *   (device and inode), size, modification and change times and content
 *   must be what the copy saw. A change time moves with every write,
 *   rename or link and cannot be set back, so an entry that matches was
 *   untouched from its copy to its check, and the copy is the folder as
 *   it stood between the two passes — not one file from before a writer
 *   and another from after it. A directory gaining or losing an entry
 *   after it was listed moves its own times and fails the check the same
 *   way. A capture that fails it starts again once; a folder still
 *   changing the second time is refused, saying so.
 * - **Never through a replaced directory.** Node opens nothing relative
 *   to a directory it already holds, so a directory can be swapped for a
 *   link between being looked at and being listed or read from. Every
 *   directory is checked after it is listed, and again after each file
 *   in it is read: still the directory first looked at, and still at its
 *   own real path inside the folder. One that is not makes the capture
 *   start again, discarding everything it copied; and a swap undone in
 *   between still moves the times of the directory that holds it, which
 *   the second pass sees.
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
/** Captures tried before a folder that keeps changing is refused. */
const CAPTURE_ATTEMPTS = 2;

interface ManifestEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  sha256: string | null;
}

/**
 * Where a capture is about to look, for tests that change the folder at
 * that moment: before each entry of a directory is looked at, and before
 * each directory is listed (the top one before it is looked at at all) —
 * on the copying pass and the checking one, of each attempt.
 */
export type FolderCaptureProbe = (step: { attempt: number; pass: "copy" | "check"; action: "entry" | "list"; path: string }) => Promise<void> | void;

/** The capability the folder kind lends, keeping its copies under `root`. */
export function folderEvidenceCapability(
  root: string = defaultTeamEvidenceRoot(),
  limits = { files: FOLDER_EVIDENCE_MAX_FILES, bytes: FOLDER_EVIDENCE_MAX_BYTES },
  probe?: FolderCaptureProbe,
): WorkspaceEvidenceCapability {
  return {
    async capture(_item, workspace) {
      for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
        const captured = await captureOnce(root, workspace.cwd, limits, (step) => probe?.({ attempt, ...step }));
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

type Walked = EvidenceResult<"done"> | "changed";

/** One walk's account of the folder: an entry's kind, identity, size, times and content, in walk order. */
type Fingerprints = string[];

function fingerprint(type: string, path: string, stat: BigIntStats, sha: string | null): string {
  return [type, path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, sha ?? ""].join("\u0000");
}

/** Errors meaning the folder moved under the walk, rather than that it cannot be read. */
function moved(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Walks the folder from its real path `top`, handing each regular file's
 * content to `take`. `changed` when anything moved under the walk.
 */
async function walkFolder(
  top: string,
  pass: "copy" | "check",
  probe: (step: { pass: "copy" | "check"; action: "entry" | "list"; path: string }) => Promise<void> | void,
  take: (entry: { path: string; type: ManifestEntry["type"]; content: Buffer | null }) => Promise<EvidenceResult<"taken">>,
): Promise<{ walked: Walked; prints: Fingerprints }> {
  const prints: Fingerprints = [];
  // Still the directory first looked at, still at its own real path.
  const unmoved = async (expected: string, looked: BigIntStats): Promise<boolean> => {
    const now = await lstat(expected, { bigint: true }).catch(() => null);
    if (now === null || !now.isDirectory() || now.dev !== looked.dev || now.ino !== looked.ino) return false;
    return (await realpath(expected).catch(() => null)) === expected;
  };
  const visit = async (relative: string, expected: string, seen: BigIntStats | null): Promise<Walked> => {
    await probe({ pass, action: "list", path: relative });
    // The top is looked at here; any other directory was looked at by its parent's walk.
    const looked = seen ?? (await lstat(expected, { bigint: true }).catch(() => null));
    if (looked === null || !looked.isDirectory()) return "changed";
    prints.push(fingerprint("directory", relative, looked, null));
    let names: string[];
    try {
      names = (await readdir(expected)).sort();
    } catch (error) {
      if (moved(error)) return "changed";
      return { ok: false, problem: `EO could not read \`${expected}\`: ${message(error)}` };
    }
    if (!(await unmoved(expected, looked))) return "changed";
    for (const name of names) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const absolute = join(expected, name);
      await probe({ pass, action: "entry", path });
      const before = await lstat(absolute, { bigint: true }).catch(() => null);
      if (before === null) return "changed";
      if (before.isSymbolicLink()) {
        prints.push(fingerprint("symlink", path, before, null));
        const taken = await take({ path, type: "symlink", content: null });
        if (!taken.ok) return taken;
        continue;
      }
      if (before.isDirectory()) {
        const taken = await take({ path, type: "directory", content: null });
        if (!taken.ok) return taken;
        const inner = await visit(path, absolute, before);
        if (inner === "changed" || !inner.ok) return inner;
        continue;
      }
      if (!before.isFile()) continue;
      let content: Buffer;
      try {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat({ bigint: true });
          if (opened.dev !== before.dev || opened.ino !== before.ino) return "changed";
          content = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(content.length) !== before.size) return "changed";
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (moved(error)) return "changed";
        return { ok: false, problem: `EO could not read \`${absolute}\`: ${message(error)}` };
      }
      // The file was read from this directory, not from wherever a link put in its place pointed.
      if (!(await unmoved(expected, looked))) return "changed";
      const sha = sha256(content);
      prints.push(fingerprint("file", path, before, sha));
      const taken = await take({ path, type: "file", content });
      if (!taken.ok) return taken;
    }
    return { ok: true, value: "done" };
  };
  return { walked: await visit("", top, null), prints };
}

async function captureOnce(
  root: string,
  cwd: string,
  limits: { files: number; bytes: number },
  probe: (step: { pass: "copy" | "check"; action: "entry" | "list"; path: string }) => Promise<void> | void,
): Promise<EvidenceCaptureOutcome | "changed"> {
  let top: string;
  try {
    top = await realpath(cwd);
  } catch (error) {
    return { ok: false, problem: `EO could not read \`${cwd}\`: ${message(error)}` };
  }
  const entries: ManifestEntry[] = [];
  const staging = join(root, `.partial-${uuidv7()}`);
  let bytes = 0;
  let files = 0;
  try {
    await mkdir(join(staging, FILES), { recursive: true });
    const copied = await walkFolder(top, "copy", probe, async ({ path, type, content }) => {
      if (type === "directory") {
        await mkdir(join(staging, FILES, ...path.split("/")), { recursive: true });
        entries.push({ path, type, size: 0, sha256: null });
        return { ok: true, value: "taken" };
      }
      if (type === "symlink" || content === null) {
        entries.push({ path, type: "symlink", size: 0, sha256: null });
        return { ok: true, value: "taken" };
      }
      files += 1;
      bytes += content.length;
      if (files > limits.files || bytes > limits.bytes) {
        return { ok: false, problem: `\`${cwd}\` holds more than ${String(limits.files)} files or ${String(Math.round(limits.bytes / 1024 / 1024))} MB, more than EO copies for a team; point the step at a smaller folder.` };
      }
      await writeFile(join(staging, FILES, ...path.split("/")), content, { flag: "wx" });
      entries.push({ path, type, size: content.length, sha256: sha256(content) });
      return { ok: true, value: "taken" };
    });
    if (copied.walked === "changed") return "changed";
    if (!copied.walked.ok) return copied.walked;
    // The second pass: the whole folder, listed and read again, must be
    // what the copy saw, entry for entry.
    const checked = await walkFolder(top, "check", probe, async () => ({ ok: true, value: "taken" }));
    if (checked.walked === "changed") return "changed";
    if (!checked.walked.ok) return checked.walked;
    if (checked.prints.length !== copied.prints.length || checked.prints.some((print, index) => print !== copied.prints[index])) return "changed";

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
