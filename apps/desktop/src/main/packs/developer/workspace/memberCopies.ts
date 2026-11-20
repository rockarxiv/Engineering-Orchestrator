import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { listGitWorkspaces } from "../../../db/repos/index.js";
import type { MemberCopy, MemberCopyOutcome } from "../../../supervisor/teamEvidence.js";
import { codeSpan } from "../../../codeSpan.js";
import { git } from "./git.js";

/**
 * An isolated team member's own copy of an item's repository (EO-867): a
 * detached worktree of the tree the team's evidence baseline captured.
 *
 * **The captured tree, made a commit.** The baseline is the tree object of
 * the item's working tree — committed, modified and untracked files alike
 * (`gitEvidence.ts`). `git commit-tree` wraps it in a commit whose parent
 * is the HEAD it was captured on, which moves no ref: the commit is an
 * object and nothing else. The copy checks it out detached, so the member
 * stands on exactly what the team was given, and `git diff HEAD~1` in it
 * shows what the item's branch has on top of its last commit.
 *
 * **Detached, and its own.** A detached HEAD moves no branch: a commit, a
 * reset or a checkout in the copy changes the copy's HEAD and index and
 * nothing else — not the item's worktree, not its branch, not another
 * member's copy, each of which is a worktree of its own.
 *
 * **Inside the repository's git directory**, at
 * `<git common dir>/eo-team-copies/<KEY>/<attempt>`, for the reason a
 * reference checkout lives there (`referenceCheckouts.ts`): never among
 * the items' worktrees, where it would read as another item's work, and
 * invisible to the person's `git status`.
 *
 * **Changes are said, then discarded.** Members run unsandboxed, as the
 * step's own agent does, so nothing here stops a write. What EO made is
 * recorded beside the worktree's own metadata; before the copy goes, what
 * was done in it is read and handed back to be said on the member's
 * report. Nothing a member changed is merged anywhere.
 */

/** The directory, under a repository's git common dir, that holds every member copy of it. */
const COPIES_DIRECTORY = "eo-team-copies";
/** EO's record of the commit it checked out, beside the worktree's own metadata so `git worktree remove` takes it too. */
const RECORD_FILE = "eo-team-copy.json";
/** How many paths a sentence names before it says "and N more". */
const LISTED_PATHS = 10;
/** Who the commit wrapping a captured tree is by: EO, never the person. */
const EO_IDENTITY = { GIT_AUTHOR_NAME: "EO", GIT_AUTHOR_EMAIL: "eo@localhost", GIT_COMMITTER_NAME: "EO", GIT_COMMITTER_EMAIL: "eo@localhost" };
/** What an attempt's id may be, as a directory name: never anything that climbs out. */
const ATTEMPT = /^[A-Za-z0-9_-]+$/;

interface CopyRecord {
  commit: string;
  attemptId: string;
}

async function copiesRoot(repoPath: string): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
  return common.ok ? { ok: true, root: join(common.stdout, COPIES_DIRECTORY) } : { ok: false, error: common.error };
}

/**
 * A member's copy of `tree`, captured from the repository at `repoPath`
 * on `head`, made for `attemptId` alone. Nothing is created until the
 * commit is made, so a refusal leaves the disk as it was.
 */
export async function makeMemberCopy(repoPath: string, itemKey: string, source: { tree: string; head: string | null }, attemptId: string): Promise<MemberCopyOutcome> {
  if (!ATTEMPT.test(attemptId) || itemKey === "" || itemKey.includes("/") || itemKey.includes("..")) return { ok: false, problem: "EO could not name a copy for that attempt." };
  const root = await copiesRoot(repoPath);
  if (!root.ok) return { ok: false, problem: `EO could not find the repository's git directory to make the member a copy: ${codeSpan(root.error)}` };
  const committed = await git(
    ["commit-tree", source.tree, ...(source.head === null ? [] : ["-p", source.head]), "-m", `EO: what a team member of ${itemKey} works on (attempt ${attemptId})`],
    repoPath,
    { env: EO_IDENTITY },
  );
  if (!committed.ok || !/^[0-9a-f]{40,64}$/.test(committed.stdout)) {
    return { ok: false, problem: `EO could not make a commit of the captured tree for the member's copy: ${codeSpan(committed.ok ? "git named no commit" : committed.error)}` };
  }
  const commit = committed.stdout;
  const path = join(root.root, itemKey, attemptId);
  if (existsSync(path)) await removeCopy(repoPath, path);
  const added = await git(["worktree", "add", "--detach", path, commit], repoPath);
  if (!added.ok) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    await git(["worktree", "prune"], repoPath);
    await rmdir(join(path, "..")).catch(() => undefined);
    return { ok: false, problem: `EO could not check out the member's copy: ${codeSpan(added.error)}` };
  }
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  if (adminDir.ok) {
    const record: CopyRecord = { commit, attemptId };
    await writeFile(join(adminDir.stdout, RECORD_FILE), JSON.stringify(record)).catch(() => undefined);
  }
  return { ok: true, copy: copyAt(repoPath, path) };
}

function copyAt(repoPath: string, path: string): MemberCopy {
  return {
    cwd: path,
    changes: () => inspectCopy(path),
    remove: () => removeCopy(repoPath, path),
  };
}

/**
 * What was done in a copy since EO made it, as phrases: tracked files
 * changed, untracked files added, and a HEAD that is no longer the commit
 * EO checked out (a commit or a reset). Ignored files are not counted: a
 * build's output is not a change anyone reads.
 */
export async function inspectCopy(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const found: string[] = [];
  const tracked = await git(["diff", "--name-only", "HEAD"], path);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], path);
  if (!tracked.ok || !untracked.ok) {
    found.push(`its state could not be read (${[tracked.ok ? "" : codeSpan(tracked.error), untracked.ok ? "" : codeSpan(untracked.error)].filter((part) => part !== "").join("; ")})`);
  } else {
    const changed = lines(tracked.stdout);
    const added = lines(untracked.stdout);
    if (changed.length > 0) found.push(`${count(changed.length, "tracked file")} changed: ${listPaths(changed)}`);
    if (added.length > 0) found.push(`${count(added.length, "untracked file")} added: ${listPaths(added)}`);
  }
  const record = await readRecord(path);
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], path);
  const now = head.ok && head.stdout !== "" ? head.stdout : null;
  if (record === null) found.push("EO's record of the commit it checked out is missing, so whether HEAD moved cannot be said");
  else if (now !== record.commit) found.push(`HEAD moved from ${record.commit.slice(0, 12)} to ${now === null ? "nothing" : now.slice(0, 12)}`);
  return found;
}

async function readRecord(path: string): Promise<CopyRecord | null> {
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  if (!adminDir.ok) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(adminDir.stdout, RECORD_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { commit?: unknown }).commit === "string") return parsed as CopyRecord;
  } catch {
    // Missing or unreadable is the same answer.
  }
  return null;
}

/** Removes a copy, whatever is in it. Never throws. */
async function removeCopy(repoPath: string, path: string): Promise<void> {
  try {
    const removed = await git(["worktree", "remove", "--force", "--force", path], repoPath);
    if (!removed.ok || existsSync(path)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      await git(["worktree", "prune"], repoPath);
    }
    // The item's folder goes with its last copy; `rmdir` refuses one that is not empty.
    await rmdir(join(path, "..")).catch(() => undefined);
  } catch {
    // Said by what is left on disk, which the next sweep takes.
  }
}

/** One member copy found on disk. */
export interface FoundMemberCopy {
  itemKey: string;
  attemptId: string;
  path: string;
}

/** Every member copy of one repository, optionally only one item's. */
export async function listMemberCopies(repoPath: string, itemKey?: string): Promise<FoundMemberCopy[]> {
  const root = await copiesRoot(repoPath);
  if (!root.ok) return [];
  const keys = itemKey === undefined ? await directoriesIn(root.root) : existsSync(join(root.root, itemKey)) ? [itemKey] : [];
  const found: FoundMemberCopy[] = [];
  for (const key of keys) {
    for (const attemptId of await directoriesIn(join(root.root, key))) found.push({ itemKey: key, attemptId, path: join(root.root, key, attemptId) });
  }
  return found;
}

async function directoriesIn(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Removes the member copies left in every repository EO knows: one
 * item's, or — with no item — every one whose attempt `keep` does not
 * name. What was done in each is handed to `report` before it goes.
 * Every repository rather than the item's project's: one taken off the
 * project since still holds its copies.
 */
export async function releaseMemberCopies(
  db: Db,
  request: { item?: Pick<Item, "key">; keep?: (attemptId: string) => boolean; report: (attemptId: string, changed: string[]) => void },
): Promise<string[]> {
  const removed: string[] = [];
  for (const workspace of listGitWorkspaces(db)) {
    const repoPath = workspace.config.repoPath;
    for (const found of await listMemberCopies(repoPath, request.item?.key)) {
      if (request.keep?.(found.attemptId) === true) continue;
      const changed = await inspectCopy(found.path).catch(() => []);
      if (changed.length > 0) request.report(found.attemptId, changed);
      await removeCopy(repoPath, found.path);
      if (!existsSync(found.path)) removed.push(found.path);
      else console.error(`[eo] could not remove the team member's copy ${found.path} for ${found.itemKey}`);
    }
  }
  return removed;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_PATHS).map((path) => `\`${path}\``).join(", ");
  return paths.length > LISTED_PATHS ? `${shown} and ${paths.length - LISTED_PATHS} more` : shown;
}
