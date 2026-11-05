import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item, Uuid } from "@eo/core";
import type { Db } from "../../../db/client.js";
import { asGitWorkspace, getItemByKey, listGitWorkspaces, postComment, projectWorkspaceList, type GitWorkspace } from "../../../db/repos/index.js";
import type { ReferenceCheckout, ReferenceCheckoutOutcome, ReferenceCheckoutRequest } from "../../../supervisor/workspaceKind.js";
import { stillOnItsWay } from "./dispatchWorkspace.js";
import { git, NETWORK_TIMEOUT_MS, NON_INTERACTIVE_GIT_ENV, type NetworkGitOptions } from "./git.js";

/**
 * Temporary, detached checkouts of a branch of a repository on an item's
 * project, made for that item to read (EO-632).
 *
 * **Detached**, because git refuses to check a branch out twice: the
 * person's own checkout is on `main`, and another item's worktree is on
 * its `eo/` branch. A detached HEAD conflicts with neither, and a commit
 * made in one moves no branch.
 *
 * **Inside the repository's git directory**, at
 * `<git common dir>/eo-references/<KEY>/<branch>`, and not in the folder
 * that holds items' worktrees: `borrowedFromSiblings` treats every
 * folder there but the item's own as another item's work, and a
 * reference checkout is nobody's. Under `.git` it is also invisible to
 * the person's `git status`, so attaching one never makes the base
 * repository look dirty.
 *
 * **Read-only by inspection, not by permission.** Agents run unsandboxed
 * on both backends, so nothing here can stop a write. What EO checked
 * out is recorded beside the worktree's own git metadata, and removal
 * compares the checkout with it and says on the item what changed
 * (invariants 5 and 8) — then removes it anyway, because nothing in it
 * is anyone's work.
 */

/** The directory, under a repository's git common dir, that holds every reference checkout of it. */
const REFERENCES_DIRECTORY = "eo-references";
/** The record of what EO checked out, kept in the worktree's admin directory so `git worktree remove` takes it too. */
const RECORD_FILE = "eo-reference.json";
/** How many paths a comment names before it says "and N more". */
const LISTED_PATHS = 10;

/** What EO checked out, as written beside the worktree's own metadata. */
interface ReferenceRecord {
  branch: string;
  commit: string;
  source: ReferenceCheckout["source"];
}

/** Where a repository's reference checkouts live, or why that cannot be said. */
async function referencesRoot(repoPath: string): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  // The *common* dir, so a repository that is itself a linked worktree
  // still puts these in one place, and `--path-format=absolute` so the
  // answer does not depend on the directory git was asked from.
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath);
  if (!common.ok) return { ok: false, error: common.error };
  return { ok: true, root: join(common.stdout, REFERENCES_DIRECTORY) };
}

/**
 * One reference checkout's directory.
 *
 * The branch is encoded rather than nested, so `release/2.4` is one
 * directory and no branch name can climb out of the item's folder.
 */
function referencePath(root: string, itemKey: string, branch: string): string {
  return join(root, itemKey, encodeURIComponent(branch));
}

/** Is this a name git would accept for a branch? Asked before it is used in a path or on a command line. */
async function validBranchName(repoPath: string, branch: string): Promise<boolean> {
  if (branch === "" || branch.startsWith("-")) return false;
  return (await git(["check-ref-format", `refs/heads/${branch}`], repoPath)).ok;
}

/** The commit a ref names, or null. */
async function commitOf(cwd: string, ref: string): Promise<string | null> {
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  return resolved.ok && resolved.stdout !== "" ? resolved.stdout : null;
}

/**
 * The commit to check out, and where it came from — or why there is none.
 *
 * The remote is the authority: it is fetched first, and its branch wins
 * over a local one of the same name wherever the two differ. Only a
 * branch the remote does not have falls back to the local one. A fetch
 * that fails refuses outright rather than reading an old copy of the
 * remote branch, which is exactly what a branch deleted or force-pushed
 * upstream would leave behind.
 *
 * A repository with no such remote configured has nothing to fetch, and
 * its local branches are all there is — the same reading
 * `resolveRemoteRef` gives one.
 */
async function resolveCommit(
  repoPath: string,
  remote: string,
  repository: string,
  branch: string,
  options: NetworkGitOptions,
): Promise<{ ok: true; commit: string; source: ReferenceCheckout["source"] } | { ok: false; reason: string }> {
  const network = { env: NON_INTERACTIVE_GIT_ENV, timeoutMs: options.timeoutMs ?? NETWORK_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) };

  if ((await git(["remote", "get-url", remote], repoPath)).ok) {
    // Asked first, because a fetch of a branch the remote does not have
    // fails in the same way as a fetch that could not reach it, and the
    // two must not be confused: one falls back to the local branch, the
    // other refuses.
    const listed = await git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], repoPath, network);
    if (!listed.ok) return { ok: false, reason: `Could not fetch \`${branch}\` from ${repository}'s remote \`${remote}\`: ${listed.error}. Nothing was checked out.` };

    if (listed.stdout !== "") {
      // Into the remote-tracking ref rather than read off `FETCH_HEAD`,
      // which any other fetch in this repository overwrites.
      const tracking = `refs/remotes/${remote}/${branch}`;
      const fetched = await git(["fetch", "--no-tags", remote, `+refs/heads/${branch}:${tracking}`], repoPath, network);
      if (!fetched.ok) return { ok: false, reason: `Could not fetch \`${branch}\` from ${repository}'s remote \`${remote}\`: ${fetched.error}. Nothing was checked out.` };
      const commit = await commitOf(repoPath, tracking);
      if (commit !== null) return { ok: true, commit, source: "remote" };
    }
  }

  const local = await commitOf(repoPath, `refs/heads/${branch}`);
  if (local !== null) return { ok: true, commit: local, source: "local" };
  return { ok: false, reason: `${repository} has no branch \`${branch}\`, on its remote \`${remote}\` or locally. Nothing was checked out.` };
}

/** What one reference checkout's git plumbing needs to know about its repository. */
export interface ReferenceRepository {
  /** The repository's name, as a person and an agent call it. */
  name: string;
  repoPath: string;
  remote: string;
}

/**
 * A detached checkout of `branch` for `itemKey`, made fresh (EO-632).
 *
 * Asking again for the same branch returns the same path at the
 * branch's newest commit. The old checkout is removed first, through the
 * same inspection every removal makes, so anything written to it since
 * is handed to `report` before it is removed — and so reported even
 * when making the new one then fails.
 *
 * Nothing is created until the commit is known, so every refusal leaves
 * the disk as it was.
 */
export async function checkoutReference(
  repository: ReferenceRepository,
  itemKey: string,
  branch: string,
  report: (changed: string) => void,
  options: NetworkGitOptions = {},
): Promise<{ ok: true; checkout: ReferenceCheckout } | { ok: false; reason: string }> {
  if (!(await validBranchName(repository.repoPath, branch))) return { ok: false, reason: `\`${branch}\` is not a branch name git accepts. Nothing was checked out.` };

  const resolved = await resolveCommit(repository.repoPath, repository.remote, repository.name, branch, options);
  if (!resolved.ok) return resolved;

  const root = await referencesRoot(repository.repoPath);
  if (!root.ok) return { ok: false, reason: `Could not find ${repository.name}'s git directory: ${root.error}. Nothing was checked out.` };
  const path = referencePath(root.root, itemKey, branch);

  if (existsSync(path)) await removeReferenceCheckout(repository, path, branch, report);

  const added = await git(["worktree", "add", "--detach", path, resolved.commit], repository.repoPath);
  if (!added.ok) {
    // Git can fail after writing the checkout — a failing post-checkout
    // hook does — and a checkout with no record of its commit would be
    // reported as written to when it goes. Nothing is in it yet.
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    await git(["worktree", "prune"], repository.repoPath);
    await rmdir(join(path, "..")).catch(() => undefined);
    return { ok: false, reason: `Could not check out \`${branch}\` of ${repository.name}: ${added.error}` };
  }

  // Beside the worktree's own metadata rather than in the checkout, where
  // it would be an untracked file the removal check then reported.
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  if (adminDir.ok) {
    const record: ReferenceRecord = { branch, commit: resolved.commit, source: resolved.source };
    await writeFile(join(adminDir.stdout, RECORD_FILE), JSON.stringify(record));
  }

  return { ok: true, checkout: { path, commit: resolved.commit, source: resolved.source, repository: repository.name, branch } };
}

/** A reference checkout found on disk. */
export interface FoundReferenceCheckout {
  itemKey: string;
  branch: string;
  path: string;
}

/** Every reference checkout of one repository, optionally only one item's. */
export async function listReferenceCheckouts(repoPath: string, itemKey?: string): Promise<FoundReferenceCheckout[]> {
  const root = await referencesRoot(repoPath);
  if (!root.ok) return [];

  const keys = itemKey === undefined ? await directoriesIn(root.root) : existsSync(join(root.root, itemKey)) ? [itemKey] : [];
  const found: FoundReferenceCheckout[] = [];
  for (const key of keys) {
    for (const encoded of await directoriesIn(join(root.root, key))) {
      found.push({ itemKey: key, branch: decodeBranch(encoded), path: join(root.root, key, encoded) });
    }
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

function decodeBranch(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * What was done to a reference checkout since EO made it, as a list of
 * phrases — empty when nothing was.
 *
 * Changed tracked files, untracked files, and a HEAD that is no longer
 * the commit EO checked out. Ignored files are not counted: a build
 * output is not a write to the code anyone reads there.
 */
async function inspect(path: string): Promise<string[]> {
  const found: string[] = [];

  // Two plain lists rather than `status --porcelain`, whose status
  // column `git()`'s trimming would eat off the first line. Staged and
  // unstaged alike, against whatever HEAD is now.
  const tracked = await git(["diff", "--name-only", "HEAD"], path);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"], path);
  if (!tracked.ok || !untracked.ok) {
    found.push(`its state could not be read (${tracked.ok ? "" : tracked.error}${!tracked.ok && !untracked.ok ? "; " : ""}${untracked.ok ? "" : untracked.error})`);
  } else {
    const changed = lines(tracked.stdout);
    const added = lines(untracked.stdout);
    if (changed.length > 0) found.push(`${count(changed.length, "tracked file")} changed: ${listPaths(changed)}`);
    if (added.length > 0) found.push(`${count(added.length, "untracked file")} added: ${listPaths(added)}`);
  }

  const record = await readRecord(path);
  const head = await commitOf(path, "HEAD");
  if (record === null) found.push("EO's record of the commit it checked out is missing, so whether HEAD moved cannot be said");
  else if (head !== record.commit) found.push(`HEAD moved from ${record.commit.slice(0, 12)} to ${head === null ? "nothing" : head.slice(0, 12)}`);

  return found;
}

async function readRecord(path: string): Promise<ReferenceRecord | null> {
  const adminDir = await git(["rev-parse", "--absolute-git-dir"], path);
  if (!adminDir.ok) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(adminDir.stdout, RECORD_FILE), "utf8"));
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { commit?: unknown }).commit === "string") return parsed as ReferenceRecord;
  } catch {
    // Missing or unreadable is the same answer.
  }
  return null;
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

/**
 * Removes one reference checkout, after looking at what was done to it.
 *
 * Always removes: a reference checkout is never kept because of
 * changes, because nothing in it is anyone's work. What was written to
 * it is handed to `report` first, as the sentence to post on the item,
 * and only then is anything removed: a report that waited for the
 * removal would be lost with any failure after it. Not called when
 * nothing was written. A directory git no longer knows as a worktree is deleted
 * all the same — it is under EO's own folder and nothing else made it.
 */
export async function removeReferenceCheckout(
  repository: Pick<ReferenceRepository, "name" | "repoPath">,
  path: string,
  branch: string,
  report: (changed: string) => void,
): Promise<{ removed: boolean; error?: string }> {
  const found = await inspect(path);
  if (found.length > 0) {
    report(
      `The reference checkout of ${repository.name}'s \`${branch}\` at \`${path}\` was written to, and EO is removing it anyway — ` +
        `it is a copy for reading, not anyone's work: ${found.join("; ")}.`,
    );
  }

  const removed = await git(["worktree", "remove", "--force", "--force", path], repository.repoPath);
  if (!removed.ok || existsSync(path)) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    await git(["worktree", "prune"], repository.repoPath);
  }
  // The item's folder goes with its last checkout. `rmdir` refuses a
  // directory that is not empty, which is the check.
  await rmdir(join(path, "..")).catch(() => undefined);

  const gone = !existsSync(path);
  return gone ? { removed: true } : { removed: false, ...(removed.ok ? {} : { error: removed.error }) };
}

// ---------------------------------------------------------------------------
// The item's side: which repositories it may ask for, and its release.
// ---------------------------------------------------------------------------

function repositoryOf(workspace: GitWorkspace): ReferenceRepository {
  return { name: workspace.config.name, repoPath: workspace.config.repoPath, remote: workspace.config.forgeRemote };
}

/**
 * A reference checkout for an item: the git kind's `referenceCheckout`.
 *
 * Any git repository on the item's project, its own included — another
 * branch of the repository a ticket works in is as good a thing to read
 * as a branch of a neighbour. A name not on the project refuses and
 * lists the names that are.
 */
export async function referenceCheckoutFor(db: Db, item: Item, request: ReferenceCheckoutRequest): Promise<ReferenceCheckoutOutcome> {
  const repositories = item.projectId === null ? [] : projectWorkspaceList(db, item.projectId as Uuid).flatMap((workspace) => asGitWorkspace(workspace) ?? []);
  const workspace = repositories.find((candidate) => candidate.config.name === request.repository);
  if (!workspace) {
    const names = repositories.map((candidate) => candidate.config.name);
    return {
      ok: false,
      reason:
        names.length === 0
          ? `${item.key}'s project has no repositories, so there is no \`${request.repository}\` to check out.`
          : `\`${request.repository}\` is not a repository on ${item.key}'s project. Its repositories are: ${names.join(", ")}.`,
    };
  }

  const made = await checkoutReference(repositoryOf(workspace), item.key, request.branch, (changed) => postNote(db, item.id, changed), request.signal ? { signal: request.signal } : {});
  return made.ok ? { ok: true, checkout: made.checkout } : made;
}

/**
 * Removes every reference checkout an item holds, in every repository,
 * posting on the item what was written to any of them.
 *
 * Every repository rather than only the project's: a repository taken
 * off the project after a checkout was made still has the checkout.
 * Said on the item even when it is about to be deleted: the report is
 * made before anything is removed, whatever happens next.
 */
export async function releaseReferenceCheckouts(db: Db, item: Pick<Item, "id" | "key">): Promise<string[]> {
  const removed: string[] = [];
  for (const workspace of listGitWorkspaces(db)) {
    for (const found of await listReferenceCheckouts(workspace.config.repoPath, item.key)) {
      const outcome = await removeReferenceCheckout(repositoryOf(workspace), found.path, found.branch, (changed) => postNote(db, item.id, changed));
      if (outcome.removed) removed.push(found.path);
      else console.error(`[eo] could not remove the reference checkout ${found.path} for ${item.key}: ${outcome.error ?? "it is still on disk"}`);
    }
  }
  return removed;
}

/**
 * The startup sweep: reference checkouts whose item is finished or gone.
 *
 * The same judgement the worktree sweep makes (EO-177): an item still on
 * a non-terminal step keeps what it was given, however quiet it is. A
 * checkout whose item no longer exists has nobody to tell what was
 * written to it, so that goes to the log.
 */
export async function releaseStaleReferenceCheckouts(db: Db): Promise<string[]> {
  const removed: string[] = [];
  for (const workspace of listGitWorkspaces(db)) {
    for (const found of await listReferenceCheckouts(workspace.config.repoPath)) {
      if (stillOnItsWay(db, found.itemKey)) continue;
      const item = getItemByKey(db, found.itemKey);
      const outcome = await removeReferenceCheckout(repositoryOf(workspace), found.path, found.branch, (changed) => {
        if (item) postNote(db, item.id, changed);
        else console.log(`[eo] ${changed}`);
      });
      if (outcome.removed) removed.push(found.path);
      else console.error(`[eo] could not remove the reference checkout ${found.path} for ${found.itemKey}: ${outcome.error ?? "it is still on disk"}`);
    }
  }
  return removed;
}

function postNote(db: Db, itemId: Uuid, body: string): void {
  postComment(db, { itemId, author: { type: "engine" }, kind: "note", body });
}
